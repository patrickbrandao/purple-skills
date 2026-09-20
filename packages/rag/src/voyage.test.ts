/**
 * O driver `voyage` (§13.1 de `docs/14-rag.md`).
 *
 * O que estes testes protegem, e que nenhum outro driver tem: o `input_type`.
 * Ele é a única coisa que separa "isto é acervo" de "isto é busca" — trocá-lo
 * não dá erro nenhum, só resultado pior, e um resultado pior não aparece em
 * teste que não o procure de propósito.
 */
import { describe, expect, it, vi } from 'vitest';
import { VoyageDriver } from './voyage.js';
import { VOYAGE_4, VOYAGE_4_LARGE, VOYAGE_4_LITE } from './models.js';
import {
  ragErrorKind,
  RagAuthError,
  RagConfigError,
  RagInputTooLongError,
  RagOriginError,
  RagRateLimitError,
  RagTimeoutError,
  RagUnavailableError,
  type UsoDeTokens,
} from './driver.js';

const CHAVE = 'pa-de-teste';
const MODELO = VOYAGE_4_LITE;

const vetor = (marca: number, dims = MODELO.dimensions) =>
  Array.from({ length: dims }, (_, i) => (i === 0 ? marca : 0.001));

type Chamada = { url: string; init: RequestInit };

function comFetch(respostas: (chamada: Chamada) => Response) {
  const chamadas: Chamada[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const chamada = { url: String(url), init: init ?? {} };
    chamadas.push(chamada);
    return respostas(chamada);
  }) as unknown as typeof fetch;
  return { chamadas, fetchImpl };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
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
  const driver = new VoyageDriver({
    apiKey: CHAVE,
    baseUrl: 'https://exemplo.test/v1',
    fetchImpl,
    sleep: async () => {},
    maxRetries: 2,
    ...extra,
  });
  return { chamadas, driver };
}

const corpoDe = (c: Chamada) => JSON.parse(String(c.init.body)) as Record<string, unknown>;

/** Responde um vetor por entrada, com o índice de cada uma. */
const espelho = (chamada: Chamada) => {
  const entradas = corpoDe(chamada).input as string[];
  return ok({
    data: entradas.map((_, i) => ({ embedding: vetor(i), index: i })),
    usage: { total_tokens: entradas.length * 3 },
  });
};

describe('a construção', () => {
  it('sem chave, o driver nem se monta', () => {
    expect(() => new VoyageDriver({ apiKey: '' })).toThrow(RagAuthError);
    expect(() => new VoyageDriver({ apiKey: '  ' })).toThrow(/RAG_VOYAGE_API_KEY ausente/);
  });

  it('declara os três modelos, em 1024 dimensões e sem prefixo', () => {
    const driver = new VoyageDriver({ apiKey: CHAVE });
    expect(driver.id).toBe('voyage');
    expect(driver.models.map((m) => m.id)).toEqual(['voyage-4-lite', 'voyage-4', 'voyage-4-large']);

    for (const m of driver.models) {
      expect(m.dimensions).toBe(1024);
      // A distinção vem do `input_type`, então não há prefixo nenhum — e os
      // prefixos vazios entram assim na identidade do espaço.
      expect(m.documentPrefix).toBe('');
      expect(m.queryPrefix).toBe('');
    }
  });

  it('o teto de tokens por requisição é por modelo, como a API documenta', () => {
    // 1 M, 320 mil e 120 mil tokens; a conta conservadora é 1 token por caractere.
    expect(VOYAGE_4_LITE.maxBatchChars).toBe(1_000_000);
    expect(VOYAGE_4.maxBatchChars).toBe(320_000);
    expect(VOYAGE_4_LARGE.maxBatchChars).toBe(120_000);
    // E o lote máximo da API é 1.000 textos, igual nos três.
    expect([VOYAGE_4_LITE, VOYAGE_4, VOYAGE_4_LARGE].map((m) => m.maxBatch)).toEqual([
      1000, 1000, 1000,
    ]);
  });
});

describe('o input_type', () => {
  it('documento vai com input_type=document', async () => {
    const { chamadas, driver } = driverCom(espelho);
    await driver.embedDocuments(MODELO, ['alfa', 'bravo']);

    expect(corpoDe(chamadas[0]!).input_type).toBe('document');
    expect(corpoDe(chamadas[0]!).input).toEqual(['alfa', 'bravo']);
  });

  it('consulta vai com input_type=query', async () => {
    const { chamadas, driver } = driverCom(espelho);
    await driver.embedQuery(MODELO, 'commits');

    expect(corpoDe(chamadas[0]!).input_type).toBe('query');
    expect(corpoDe(chamadas[0]!).input).toEqual(['commits']);
  });

  it('o texto enviado é o canônico, sem prefixo colado', async () => {
    // O prefixo é vazio aqui; o que confere é que nada foi acrescentado, porque
    // o texto guardado no banco é exatamente este.
    const { chamadas, driver } = driverCom(espelho);
    await driver.embedDocuments(MODELO, ['mensagem de commit']);
    expect(corpoDe(chamadas[0]!).input).toEqual(['mensagem de commit']);
  });
});

describe('a chamada', () => {
  it('vai em POST para {base}/embeddings, com Bearer e a dimensão escrita', async () => {
    const { chamadas, driver } = driverCom(espelho);
    await driver.embedQuery(MODELO, 'x');

    expect(chamadas[0]!.url).toBe('https://exemplo.test/v1/embeddings');
    expect(chamadas[0]!.init.method).toBe('POST');
    expect((chamadas[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${CHAVE}`,
    );
    // 1024 é a padrão entre quatro, não a nativa: escrevê-la pina o espaço.
    expect(corpoDe(chamadas[0]!).output_dimension).toBe(1024);
    expect(corpoDe(chamadas[0]!).model).toBe('voyage-4-lite');
  });

  it('casa os vetores pelo `index`, não pela ordem de chegada', async () => {
    const { driver } = driverCom(() =>
      ok({
        data: [
          { embedding: vetor(2), index: 2 },
          { embedding: vetor(0), index: 0 },
          { embedding: vetor(1), index: 1 },
        ],
        usage: { total_tokens: 9 },
      }),
    );

    const vetores = await driver.embedDocuments(MODELO, ['a', 'b', 'c']);
    expect(vetores.map((v) => v[0])).toEqual([0, 1, 2]);
  });

  it('corta o lote em 1.000 textos, o máximo da API', async () => {
    const { chamadas, driver } = driverCom(espelho);
    await driver.embedDocuments(MODELO, Array.from({ length: 1500 }, (_, i) => `t${i}`));

    expect(chamadas.map((c) => (corpoDe(c).input as string[]).length)).toEqual([1000, 500]);
  });

  it('corta também pelo teto de caracteres do modelo', async () => {
    const { chamadas, driver } = driverCom(espelho);
    const modelo = { ...VOYAGE_4_LARGE, maxBatchChars: 10 };
    await driver.embedDocuments(modelo, ['12345', '12345', '12345']);

    expect(chamadas).toHaveLength(2);
  });

  it('vetor de dimensão errada é recusado, mesmo com 200', async () => {
    const { driver } = driverCom(() =>
      ok({ data: [{ embedding: vetor(1, 1023), index: 0 }], usage: { total_tokens: 1 } }),
    );
    await expect(driver.embedQuery(MODELO, 'x')).rejects.toThrow(
      /esperado vetor de 1024 dimensões, recebido 1023/,
    );
  });

  it('a contagem de tokens vem do provedor', async () => {
    const usos: UsoDeTokens[] = [];
    const { driver } = driverCom(espelho, { onUsage: (u) => usos.push(u) });

    await driver.embedDocuments(MODELO, ['a', 'b']);
    expect(usos).toEqual([
      { model: 'voyage-4-lite', tokens: 6, textos: 2, metodo: 'documents' },
    ]);
  });
});

describe('o mapeamento dos erros', () => {
  const detalhe = (mensagem: string) => ({ detail: mensagem });

  it.each([
    [401, RagAuthError],
    [403, RagAuthError],
    [404, RagConfigError],
    [400, RagInputTooLongError],
    [500, RagUnavailableError],
    [503, RagUnavailableError],
  ] as const)('%s vira o erro que diz o que fazer', async (status, esperado) => {
    const { driver } = driverCom(() => erro(status, detalhe('recusado')));
    await expect(driver.embedQuery(MODELO, 'x')).rejects.toBeInstanceOf(esperado);
  });

  it('403 diz que é a origem, não a chave', async () => {
    // Quem lê "chave recusada" num 403 troca a chave à toa: na Voyage o 403 é
    // o IP que não passa.
    const { driver } = driverCom(() => erro(403, detalhe('Forbidden IP address')));
    await expect(driver.embedQuery(MODELO, 'x')).rejects.toThrow(/a origem da requisição, não a chave/);
  });

  it('403 sai como RagOriginError: a política é a do erro de chave, o kind não', async () => {
    // O painel resume a chave pelo `kind`. Com `auth` ele diria "recusada pelo
    // provedor" — justamente o que a mensagem acima existe para não dizer.
    const { chamadas, driver } = driverCom(() => erro(403, detalhe('Forbidden IP address')));

    const falha = await driver.embedQuery(MODELO, 'x').catch((e: unknown) => e);
    expect(falha).toBeInstanceOf(RagOriginError);
    expect(falha).toBeInstanceOf(RagAuthError);
    expect(ragErrorKind(falha)).toBe('origin');
    // Não insiste: trocar de tentativa não muda o IP de onde o pedido sai.
    expect(chamadas).toHaveLength(1);
  });

  it('401 continua sendo chave recusada', async () => {
    const { driver } = driverCom(() => erro(401, detalhe('Invalid authentication')));
    const falha = await driver.embedQuery(MODELO, 'x').catch((e: unknown) => e);
    expect(falha).not.toBeInstanceOf(RagOriginError);
    expect(ragErrorKind(falha)).toBe('auth');
  });

  it('chave que o provedor ecoar não sai na mensagem do erro', async () => {
    // A mensagem vai para o log do indexador e para o "Último erro" do painel. O
    // corte é o mesmo nos três drivers, para não depender de quem ecoa hoje.
    const { driver } = driverCom(() => erro(401, detalhe(`Provided API key ${CHAVE} is invalid.`)));
    const falha = (await driver.embedQuery(MODELO, 'x').catch((e: unknown) => e)) as Error;

    expect(falha.message).not.toContain(CHAVE);
    expect(falha.message).toContain('Provided API key [chave omitida] is invalid.');
  });

  it('erro de chave não é tentado de novo', async () => {
    const { chamadas, driver } = driverCom(() => erro(401, detalhe('Invalid authentication')));
    await expect(driver.embedQuery(MODELO, 'x')).rejects.toBeInstanceOf(RagAuthError);
    expect(chamadas).toHaveLength(1);
  });

  it('429 é tentado de novo, respeitando o Retry-After', async () => {
    const esperas: number[] = [];
    const { chamadas, fetchImpl } = comFetch(() =>
      erro(429, detalhe('Rate limit exceeded'), { 'retry-after': '2' }),
    );
    const driver = new VoyageDriver({
      apiKey: CHAVE,
      fetchImpl,
      maxRetries: 2,
      sleep: async (ms) => void esperas.push(ms),
    });

    await expect(driver.embedQuery(MODELO, 'x')).rejects.toBeInstanceOf(RagRateLimitError);
    expect(chamadas).toHaveLength(3);
    expect(esperas).toEqual([2000, 2000]);
  });

  it('um texto longo demais é isolado pela divisão do lote', async () => {
    // O 400 do lote inteiro não diz qual texto estourou; dividir ao meio chega
    // até ele. A chamada inteira é rejeitada assim mesmo — `embedDocuments` é tudo
    // ou nada —, e quem embute os outros é o indexador, um texto por vez.
    const { chamadas, driver } = driverCom((chamada) => {
      const entradas = corpoDe(chamada).input as string[];
      if (entradas.includes('grande')) {
        return erro(400, detalhe('context length exceeded'));
      }
      return espelho(chamada);
    });

    await expect(driver.embedDocuments(MODELO, ['a', 'b', 'grande', 'd'])).rejects.toBeInstanceOf(
      RagInputTooLongError,
    );
    // A última requisição foi com o texto culpado sozinho.
    expect(corpoDe(chamadas.at(-1)!).input).toEqual(['grande']);
  });

  it('o AbortSignal de quem chamou vira RagTimeoutError, sem tentativa nova', async () => {
    const { chamadas, driver } = driverCom(() => erro(503, detalhe('indisponível')));
    const controle = new AbortController();
    controle.abort();

    await expect(driver.embedQuery(MODELO, 'x', controle.signal)).rejects.toBeInstanceOf(
      RagTimeoutError,
    );
    expect(chamadas).toHaveLength(1);
  });
});
