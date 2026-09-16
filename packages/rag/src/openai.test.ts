/**
 * O driver `openai` (§13.1 de `docs/14-rag.md`).
 *
 * Aqui o `fetch` é simulado: o que importa é o **contrato** com a API —
 * endereço, header, corpo, e como a resposta é casada com o pedido — e não a
 * rede. O servidor falso, que fala o protocolo inteiro, entra nos testes de
 * ponta a ponta.
 */
import { describe, expect, it, vi } from 'vitest';
import { OpenAIDriver } from './openai.js';
import { TEXT_EMBEDDING_3_LARGE, TEXT_EMBEDDING_3_SMALL } from './models.js';
import {
  RagAuthError,
  RagConfigError,
  RagInputTooLongError,
  RagRateLimitError,
  RagTimeoutError,
  RagUnavailableError,
  type UsoDeTokens,
} from './driver.js';

const CHAVE = 'sk-de-teste';
const MODELO = TEXT_EMBEDDING_3_SMALL;

/** Um vetor da dimensão certa, com o primeiro valor marcando quem é. */
const vetor = (marca: number, dims = MODELO.dimensions) =>
  Array.from({ length: dims }, (_, i) => (i === 0 ? marca : 0.001));

type Chamada = { url: string; init: RequestInit };

/** `fetch` simulado: guarda o que foi pedido e responde o que o teste mandar. */
function comFetch(respostas: (chamada: Chamada) => Response) {
  const chamadas: Chamada[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const chamada = { url: String(url), init: init ?? {} };
    chamadas.push(chamada);
    return respostas(chamada);
  }) as unknown as typeof fetch;

  return { chamadas, fetchImpl };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

const erro = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function driverCom(
  respostas: (chamada: Chamada) => Response,
  extra: { onUsage?: (u: UsoDeTokens) => void } = {},
) {
  const { chamadas, fetchImpl } = comFetch(respostas);
  const driver = new OpenAIDriver({
    apiKey: CHAVE,
    baseUrl: 'https://exemplo.test/v1',
    fetchImpl,
    sleep: async () => {},
    maxRetries: 2,
    ...extra,
  });
  return { chamadas, driver };
}

const corpoDe = (chamada: Chamada) => JSON.parse(String(chamada.init.body)) as Record<string, unknown>;

describe('a construção', () => {
  it('sem chave, o driver nem se monta', () => {
    expect(() => new OpenAIDriver({ apiKey: '' })).toThrow(RagAuthError);
    expect(() => new OpenAIDriver({ apiKey: '   ' })).toThrow(/RAG_OPENAI_API_KEY ausente/);
  });

  it('declara os dois modelos, em dimensão nativa e sem prefixo', () => {
    const driver = new OpenAIDriver({ apiKey: CHAVE });
    expect(driver.id).toBe('openai');
    expect(driver.models.map((m) => m.id)).toEqual([
      'text-embedding-3-small',
      'text-embedding-3-large',
    ]);
    expect(TEXT_EMBEDDING_3_SMALL.dimensions).toBe(1536);
    expect(TEXT_EMBEDDING_3_LARGE.dimensions).toBe(3072);
    // Documento e consulta são a mesma chamada: não há prefixo que os separe.
    for (const m of driver.models) {
      expect(m.documentPrefix).toBe('');
      expect(m.queryPrefix).toBe('');
    }
  });
});

describe('a chamada', () => {
  it('vai em POST para {base}/embeddings, com Bearer e sem dimensions', async () => {
    const { chamadas, driver } = driverCom(() =>
      ok({ data: [{ embedding: vetor(1), index: 0 }], usage: { total_tokens: 4 } }),
    );

    await driver.embedQuery(MODELO, 'commits');

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe('https://exemplo.test/v1/embeddings');
    expect(chamadas[0]!.init.method).toBe('POST');
    expect((chamadas[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${CHAVE}`,
    );

    const corpo = corpoDe(chamadas[0]!);
    expect(corpo.model).toBe('text-embedding-3-small');
    expect(corpo.input).toEqual(['commits']);
    expect(corpo.encoding_format).toBe('float');
    // Dimensão nativa: pedir outra seria decidir qualidade para poupar espaço.
    expect(corpo).not.toHaveProperty('dimensions');
  });

  it('manda um item de `input` por texto, na ordem, e devolve na ordem', async () => {
    const { chamadas, driver } = driverCom(() =>
      ok({
        data: [
          { embedding: vetor(10), index: 0 },
          { embedding: vetor(20), index: 1 },
          { embedding: vetor(30), index: 2 },
        ],
        usage: { total_tokens: 9 },
      }),
    );

    const vetores = await driver.embedDocuments(MODELO, ['alfa', 'bravo', 'charlie']);

    expect(corpoDe(chamadas[0]!).input).toEqual(['alfa', 'bravo', 'charlie']);
    expect(vetores.map((v) => v[0])).toEqual([10, 20, 30]);
  });

  it('casa os vetores pelo `index`, não pela ordem de chegada', async () => {
    // A API manda `index` justamente porque a ordem não é promessa. Confiar
    // nela gravaria o vetor de um texto sob o hash de outro.
    const { driver } = driverCom(() =>
      ok({
        data: [
          { embedding: vetor(30), index: 2 },
          { embedding: vetor(10), index: 0 },
          { embedding: vetor(20), index: 1 },
        ],
        usage: { total_tokens: 9 },
      }),
    );

    const vetores = await driver.embedDocuments(MODELO, ['alfa', 'bravo', 'charlie']);
    expect(vetores.map((v) => v[0])).toEqual([10, 20, 30]);
  });

  it('índice repetido ou fora do pedido é recusado', async () => {
    const { driver } = driverCom(() =>
      ok({ data: [{ embedding: vetor(1), index: 0 }, { embedding: vetor(2), index: 0 }] }),
    );
    await expect(driver.embedDocuments(MODELO, ['a', 'b'])).rejects.toThrow(/repetido/);
  });

  it('lista vazia não vira requisição nenhuma', async () => {
    const { chamadas, driver } = driverCom(() => ok({ data: [] }));
    expect(await driver.embedDocuments(MODELO, [])).toEqual([]);
    expect(chamadas).toHaveLength(0);
  });

  it('respeita maxBatch e maxBatchChars ao cortar os lotes', async () => {
    const { chamadas, driver } = driverCom((chamada) => {
      const entradas = corpoDe(chamada).input as string[];
      return ok({
        data: entradas.map((_, i) => ({ embedding: vetor(i), index: i })),
        usage: { total_tokens: entradas.length },
      });
    });

    const modelo = { ...MODELO, maxBatch: 2 };
    await driver.embedDocuments(modelo, ['a', 'b', 'c', 'd', 'e']);
    expect(chamadas.map((c) => (corpoDe(c).input as string[]).length)).toEqual([2, 2, 1]);
  });

  it('vetor de dimensão errada é recusado, mesmo com 200', async () => {
    const { driver } = driverCom(() =>
      ok({ data: [{ embedding: vetor(1, 1535), index: 0 }], usage: { total_tokens: 1 } }),
    );
    await expect(driver.embedQuery(MODELO, 'x')).rejects.toThrow(
      /esperado vetor de 1536 dimensões, recebido 1535/,
    );
  });

  it('a contagem de tokens vem do provedor, e não da estimativa por caractere', async () => {
    const usos: UsoDeTokens[] = [];
    const { driver } = driverCom(
      () => ok({ data: [{ embedding: vetor(1), index: 0 }], usage: { total_tokens: 42 } }),
      { onUsage: (u) => usos.push(u) },
    );

    await driver.embedQuery(MODELO, 'commits');
    expect(usos).toEqual([
      { model: 'text-embedding-3-small', tokens: 42, textos: 1, metodo: 'query' },
    ]);
  });
});

describe('o mapeamento dos erros', () => {
  const corpoErro = (type: string, code: string | null = null, message = 'erro') => ({
    error: { message, type, param: null, code },
  });

  it.each([
    [401, corpoErro('invalid_request_error', 'invalid_api_key'), RagAuthError],
    [403, corpoErro('invalid_request_error', 'unsupported_country_region_territory'), RagAuthError],
    [404, corpoErro('invalid_request_error', 'model_not_found'), RagConfigError],
    // Um 400 qualquer é tratado como "o texto não cabe": quem chamou divide o
    // lote, que é o que acha o texto culpado sem perder os outros.
    [400, corpoErro('invalid_request_error', 'context_length_exceeded'), RagInputTooLongError],
    [500, corpoErro('server_error'), RagUnavailableError],
    [503, corpoErro('server_error'), RagUnavailableError],
  ] as const)('%s vira o erro que diz o que fazer', async (status, body, esperado) => {
    const { driver } = driverCom(() => erro(status, body));
    await expect(driver.embedQuery(MODELO, 'x')).rejects.toBeInstanceOf(esperado);
  });

  it('erro de chave não é tentado de novo', async () => {
    const { chamadas, driver } = driverCom(() =>
      erro(401, corpoErro('invalid_request_error', 'invalid_api_key')),
    );
    await expect(driver.embedQuery(MODELO, 'x')).rejects.toBeInstanceOf(RagAuthError);
    expect(chamadas).toHaveLength(1);
  });

  it('429 de taxa é tentado de novo, respeitando o Retry-After', async () => {
    const esperas: number[] = [];
    const { chamadas, fetchImpl } = comFetch(() =>
      erro(429, corpoErro('rate_limit_error', 'rate_limit_exceeded'), { 'retry-after': '3' }),
    );
    const driver = new OpenAIDriver({
      apiKey: CHAVE,
      fetchImpl,
      maxRetries: 2,
      sleep: async (ms) => void esperas.push(ms),
    });

    await expect(driver.embedQuery(MODELO, 'x')).rejects.toBeInstanceOf(RagRateLimitError);
    expect(chamadas).toHaveLength(3);
    expect(esperas).toEqual([3000, 3000]);
  });

  it('insufficient_quota é falta de crédito, não limite de taxa: não insiste', async () => {
    // O status é 429, mas esperar não resolve — e o recuo queimaria o ciclo
    // inteiro tentando de novo o que nunca vai passar.
    const { chamadas, driver } = driverCom(() =>
      erro(429, corpoErro('insufficient_quota', 'insufficient_quota', 'You exceeded your quota')),
    );

    await expect(driver.embedQuery(MODELO, 'x')).rejects.toBeInstanceOf(RagConfigError);
    await expect(driver.embedQuery(MODELO, 'x')).rejects.toThrow(/sem crédito/);
    expect(chamadas).toHaveLength(2);
  });

  it('503 é tentado de novo, e a tentativa seguinte funciona quando a falha passa', async () => {
    let n = 0;
    const { chamadas, driver } = driverCom(() => {
      n += 1;
      return n === 1
        ? erro(503, corpoErro('server_error'))
        : ok({ data: [{ embedding: vetor(7), index: 0 }], usage: { total_tokens: 1 } });
    });

    expect((await driver.embedQuery(MODELO, 'x'))[0]).toBe(7);
    expect(chamadas).toHaveLength(2);
  });

  it('o AbortSignal de quem chamou vira RagTimeoutError, sem tentativa nova', async () => {
    const { chamadas, driver } = driverCom(() => erro(503, corpoErro('server_error')));
    const controle = new AbortController();
    controle.abort();

    await expect(driver.embedQuery(MODELO, 'x', controle.signal)).rejects.toBeInstanceOf(
      RagTimeoutError,
    );
    expect(chamadas).toHaveLength(1);
  });
});
