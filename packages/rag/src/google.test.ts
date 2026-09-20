/**
 * O driver `google` (§13.1 de `docs/14-rag.md`).
 *
 * Os testes rodam contra o **servidor falso**, que fala o mesmo protocolo da
 * Gemini API: nenhuma chamada sai da máquina e nenhuma chave é usada.
 *
 * O que mais importa aqui é a armadilha do lote — vários textos numa só
 * chamada viram um vetor agregado, silenciosamente errado. Por isso há um
 * teste que confere `requests[]` item a item.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  GoogleDriver,
  GEMINI_EMBEDDING_2,
} from './google.js';
import {
  RagAuthError,
  RagConfigError,
  RagRateLimitError,
  RagTimeoutError,
  RagUnavailableError,
} from './driver.js';
import { subirServidorFalso, type ServidorFalso } from './fake.js';

const CHAVE = 'chave-de-teste';
let servidor: ServidorFalso | null = null;

afterEach(async () => {
  await servidor?.fechar();
  servidor = null;
});

async function comServidor(options: Parameters<typeof subirServidorFalso>[0] = {}) {
  servidor = await subirServidorFalso(options);
  const driver = new GoogleDriver({
    apiKey: CHAVE,
    baseUrl: servidor.baseUrl,
    // Testes não dormem.
    sleep: async () => {},
    maxRetries: 2,
  });
  return { servidor, driver };
}

describe('a construção', () => {
  it('sem chave, o driver nem se monta', () => {
    expect(() => new GoogleDriver({ apiKey: '' })).toThrow(RagAuthError);
    expect(() => new GoogleDriver({ apiKey: '   ' })).toThrow(/RAG_GOOGLE_API_KEY ausente/);
  });

  it('o modelo declara o que a especificação fixou', () => {
    expect(GEMINI_EMBEDDING_2).toMatchObject({
      id: 'gemini-embedding-2',
      dimensions: 3072,
      documentPrefix: 'title: none | text: ',
      queryPrefix: 'task: search result | query: ',
      maxInputTokens: 8192,
    });
  });
});

describe('a URL e a chave', () => {
  it('a chave vai no header x-goog-api-key, e nunca na URL', async () => {
    const { servidor: s, driver } = await comServidor();
    await driver.embedQuery(GEMINI_EMBEDDING_2, 'commits');

    const req = s.requisicoes[0]!;
    expect(req.chave).toBe(CHAVE);
    expect(req.caminho).not.toContain(CHAVE);
    expect(req.caminho).not.toContain('key=');
  });

  it('a barra final some e a versão nunca é acrescentada', async () => {
    servidor = await subirServidorFalso();
    const driver = new GoogleDriver({ apiKey: CHAVE, baseUrl: `${servidor.baseUrl}/` });
    await driver.embedQuery(GEMINI_EMBEDDING_2, 'oi');

    // O caminho pedido é exatamente <base>/models/<modelo>:<método>.
    expect(servidor.requisicoes[0]!.caminho).toBe(
      '/v1beta/models/gemini-embedding-2:embedContent',
    );
  });
});

describe('a consulta', () => {
  it('leva o prefixo de consulta, e o vetor volta com as dimensões do modelo', async () => {
    const { servidor: s, driver } = await comServidor();
    const vetor = await driver.embedQuery(GEMINI_EMBEDDING_2, 'mensagem de commit');

    expect(vetor).toHaveLength(3072);
    const corpo = s.requisicoes[0]!.corpo as { content: { parts: { text: string }[] } };
    expect(corpo.content.parts[0]!.text).toBe(
      'task: search result | query: mensagem de commit',
    );
    // Uma parte só: nada de agregar textos.
    expect(corpo.content.parts).toHaveLength(1);
  });

  it('usa embedContent, não o batch', async () => {
    const { servidor: s, driver } = await comServidor();
    await driver.embedQuery(GEMINI_EMBEDDING_2, 'x');
    expect(s.requisicoes[0]!.caminho).toContain(':embedContent');
    expect(s.requisicoes[0]!.caminho).not.toContain(':batchEmbedContents');
  });
});

describe('os documentos', () => {
  it('um item de requests[] por texto — nunca vários textos num content', async () => {
    const { servidor: s, driver } = await comServidor();
    const textos = ['primeiro', 'segundo', 'terceiro'];
    const vetores = await driver.embedDocuments(GEMINI_EMBEDDING_2, textos);

    expect(vetores).toHaveLength(3);
    const corpo = s.requisicoes[0]!.corpo as {
      requests: { model: string; content: { parts: { text: string }[] } }[];
    };
    expect(corpo.requests).toHaveLength(3);
    for (const [i, pedido] of corpo.requests.entries()) {
      expect(pedido.model).toBe('models/gemini-embedding-2');
      // A armadilha: uma parte por item, sempre.
      expect(pedido.content.parts).toHaveLength(1);
      expect(pedido.content.parts[0]!.text).toBe(`title: none | text: ${textos[i]}`);
    }
  });

  it('a resposta é casada com o pedido pela ordem', async () => {
    const { driver } = await comServidor();
    const [a, b] = await driver.embedDocuments(GEMINI_EMBEDDING_2, ['alfa', 'bravo']);
    const soA = await driver.embedDocuments(GEMINI_EMBEDDING_2, ['alfa']);
    const soB = await driver.embedDocuments(GEMINI_EMBEDDING_2, ['bravo']);

    expect(a).toEqual(soA[0]);
    expect(b).toEqual(soB[0]);
  });

  it('lista vazia não vira requisição nenhuma', async () => {
    const { servidor: s, driver } = await comServidor();
    expect(await driver.embedDocuments(GEMINI_EMBEDDING_2, [])).toEqual([]);
    expect(s.requisicoes).toHaveLength(0);
  });

  it('respeita o teto de textos por requisição', async () => {
    const { servidor: s, driver } = await comServidor();
    const modelo = { ...GEMINI_EMBEDDING_2, maxBatch: 2 };
    await driver.embedDocuments(modelo, ['a', 'b', 'c', 'd', 'e']);

    expect(s.requisicoes).toHaveLength(3);
    const tamanhos = s.requisicoes.map(
      (r) => (r.corpo as { requests: unknown[] }).requests.length,
    );
    expect(tamanhos).toEqual([2, 2, 1]);
  });

  it('respeita o teto de caracteres somados por requisição', async () => {
    const { servidor: s, driver } = await comServidor();
    const modelo = { ...GEMINI_EMBEDDING_2, maxBatch: 100, maxBatchChars: 120 };
    // Cada texto conta com o prefixo junto (20 caracteres).
    await driver.embedDocuments(modelo, ['x'.repeat(50), 'y'.repeat(50), 'z'.repeat(50)]);

    expect(s.requisicoes.length).toBeGreaterThan(1);
    for (const r of s.requisicoes) {
      const somados = (r.corpo as { requests: { content: { parts: { text: string }[] } }[] }).requests
        .map((p) => p.content.parts[0]!.text.length)
        .reduce((a, b) => a + b, 0);
      expect(somados).toBeLessThanOrEqual(120);
    }
  });

  it('um texto sozinho que estoura o limite vai numa requisição só assim mesmo', async () => {
    const { servidor: s, driver } = await comServidor();
    const modelo = { ...GEMINI_EMBEDDING_2, maxBatchChars: 10 };
    await driver.embedDocuments(modelo, ['x'.repeat(100)]);
    expect(s.requisicoes).toHaveLength(1);
  });
});

describe('o mapeamento dos erros', () => {
  it.each([
    ['chave-invalida-400', RagAuthError],
    ['chave-invalida-401', RagAuthError],
    ['sem-permissao-403', RagAuthError],
    ['pre-condicao', RagConfigError],
    ['modelo-inexistente', RagConfigError],
  ] as const)('%s vira %s', async (falha, esperado) => {
    const { driver } = await comServidor({ falha });
    await expect(driver.embedQuery(GEMINI_EMBEDDING_2, 'x')).rejects.toBeInstanceOf(esperado);
  });

  it('erro de chave e de configuração não são tentados de novo', async () => {
    const { servidor: s, driver } = await comServidor({ falha: 'chave-invalida-401' });
    await expect(driver.embedQuery(GEMINI_EMBEDDING_2, 'x')).rejects.toBeInstanceOf(RagAuthError);
    expect(s.requisicoes).toHaveLength(1);
  });

  it('429 vira RagRateLimitError e é tentado de novo', async () => {
    const { servidor: s, driver } = await comServidor({ falha: 'limite-de-taxa' });
    await expect(driver.embedQuery(GEMINI_EMBEDDING_2, 'x')).rejects.toBeInstanceOf(
      RagRateLimitError,
    );
    // A tentativa original mais as duas de `maxRetries`.
    expect(s.requisicoes).toHaveLength(3);
  });

  it('503 vira RagUnavailableError e é tentado de novo', async () => {
    const { servidor: s, driver } = await comServidor({ falha: 'indisponivel' });
    await expect(driver.embedQuery(GEMINI_EMBEDDING_2, 'x')).rejects.toBeInstanceOf(
      RagUnavailableError,
    );
    expect(s.requisicoes).toHaveLength(3);
  });

  it('a tentativa seguinte funciona quando a falha passa', async () => {
    const { servidor: s, driver } = await comServidor({ falha: 'indisponivel' });
    setTimeout(() => s.simular(undefined), 0);
    const vetor = await driver.embedQuery(GEMINI_EMBEDDING_2, 'x');
    expect(vetor).toHaveLength(3072);
  });

  it('vetor com dimensão errada é recusado, mesmo com 200', async () => {
    const { driver } = await comServidor({ falha: 'dimensao-errada' });
    await expect(driver.embedQuery(GEMINI_EMBEDDING_2, 'x')).rejects.toThrow(
      /esperado vetor de 3072 dimensões, recebido 3071/,
    );
  });

  it('a chave errada é recusada pelo servidor falso como pelo real', async () => {
    servidor = await subirServidorFalso({ exigirChave: 'a-certa' });
    const driver = new GoogleDriver({ apiKey: 'a-errada', baseUrl: servidor.baseUrl });
    await expect(driver.embedQuery(GEMINI_EMBEDDING_2, 'x')).rejects.toBeInstanceOf(RagAuthError);
  });

  it('chave que o provedor ecoar não sai na mensagem do erro', async () => {
    // A mensagem vai para o log do indexador e para o "Último erro" do painel.
    // Hoje o Google não ecoa a chave; o corte é o mesmo nos três drivers para
    // não depender disso.
    const apiKey = 'AIzaSy-chave-que-nao-pode-ir-para-o-log';
    const driver = new GoogleDriver({
      apiKey,
      baseUrl: 'https://exemplo.test/v1beta',
      maxRetries: 0,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: 'PERMISSION_DENIED',
              message: `API key ${apiKey} is not authorized for this project`,
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });

    const falha = (await driver.embedQuery(GEMINI_EMBEDDING_2, 'x').catch((e: unknown) => e)) as Error;

    expect(falha).toBeInstanceOf(RagAuthError);
    expect(falha.message).not.toContain(apiKey);
    expect(falha.message).toContain('API key [chave omitida] is not authorized');
  });
});

describe('o prazo', () => {
  it('o AbortSignal de quem chamou vira RagTimeoutError', async () => {
    const { driver } = await comServidor();
    const controle = new AbortController();
    controle.abort();

    await expect(
      driver.embedQuery(GEMINI_EMBEDDING_2, 'x', controle.signal),
    ).rejects.toBeInstanceOf(RagTimeoutError);
  });

  it('o timeout não vira tentativa nova', async () => {
    const { servidor: s, driver } = await comServidor({ falha: 'indisponivel' });
    const controle = new AbortController();
    controle.abort();

    await expect(
      driver.embedQuery(GEMINI_EMBEDDING_2, 'x', controle.signal),
    ).rejects.toBeInstanceOf(RagTimeoutError);
    expect(s.requisicoes).toHaveLength(0);
  });
});
