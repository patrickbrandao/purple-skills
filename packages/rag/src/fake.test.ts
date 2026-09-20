/**
 * O driver falso e o servidor falso (§6.3).
 *
 * Eles são ferramenta de teste, mas de teste de outras coisas — se o vetor
 * falso não for determinístico, ou se o servidor falso não remover o prefixo,
 * a suíte da busca começa a falhar por motivo errado. Daí testá-los também.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeDriver,
  MODELO_FALSO,
  semPrefixo,
  subirServidorFalso,
  vetorFalso,
  type ServidorFalso,
} from './fake.js';
import { GEMINI_EMBEDDING_2, GoogleDriver } from './google.js';
import { OpenAIDriver } from './openai.js';
import { VoyageDriver } from './voyage.js';
import {
  TEXT_EMBEDDING_3_LARGE,
  TEXT_EMBEDDING_3_SMALL,
  VOYAGE_4_LITE,
} from './models.js';
import {
  ragErrorKind,
  RagAuthError,
  RagConfigError,
  RagRateLimitError,
  type UsoDeTokens,
} from './driver.js';

let servidor: ServidorFalso | null = null;

afterEach(async () => {
  await servidor?.fechar();
  servidor = null;
});

describe('o vetor falso', () => {
  it('é determinístico e normalizado', () => {
    const a = vetorFalso('mensagem de commit', 32);
    const b = vetorFalso('mensagem de commit', 32);
    expect(a).toEqual(b);

    const norma = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0));
    expect(norma).toBeCloseTo(1, 10);
  });

  it('textos com palavras em comum ficam mais próximos que textos sem nada em comum', () => {
    const cosseno = (x: number[], y: number[]) => x.reduce((a, v, i) => a + v * y[i]!, 0);

    const consulta = vetorFalso('mensagem de commit', 128);
    const perto = vetorFalso('mensagem de commit padronizada', 128);
    const longe = vetorFalso('receita de bolo de fubá', 128);

    expect(cosseno(consulta, perto)).toBeGreaterThan(cosseno(consulta, longe));
  });

  it('o prefixo não soma ruído: o servidor falso o remove antes de calcular', () => {
    expect(semPrefixo(`${GEMINI_EMBEDDING_2.documentPrefix}oi`)).toBe('oi');
    expect(semPrefixo(`${GEMINI_EMBEDDING_2.queryPrefix}oi`)).toBe('oi');
    expect(semPrefixo('oi')).toBe('oi');

    expect(vetorFalso(`${GEMINI_EMBEDDING_2.documentPrefix}commits`, 32)).toEqual(
      vetorFalso('commits', 32),
    );
  });

  it('texto sem palavra nenhuma não vira vetor nulo', () => {
    // A distância do cosseno não é definida para o vetor de zeros.
    const v = vetorFalso('!!! ...', 16);
    expect(v.some((x) => x !== 0)).toBe(true);
  });
});

describe('o driver falso', () => {
  it('aplica o prefixo certo em cada método e guarda o que recebeu', async () => {
    const driver = new FakeDriver();
    await driver.embedDocuments(MODELO_FALSO, ['um', 'dois']);
    await driver.embedQuery(MODELO_FALSO, 'três');

    expect(driver.recebidos).toEqual([
      {
        metodo: 'documents',
        textos: [`${MODELO_FALSO.documentPrefix}um`, `${MODELO_FALSO.documentPrefix}dois`],
      },
      { metodo: 'query', textos: [`${MODELO_FALSO.queryPrefix}três`] },
    ]);
  });

  it('devolve um vetor por texto, no tamanho do modelo', async () => {
    const vetores = await new FakeDriver().embedDocuments(MODELO_FALSO, ['a', 'b', 'c']);
    expect(vetores).toHaveLength(3);
    for (const v of vetores) expect(v).toHaveLength(MODELO_FALSO.dimensions);
  });
});

describe('o servidor falso', () => {
  it('fala o protocolo do Google bem o bastante para o driver de verdade rodar', async () => {
    servidor = await subirServidorFalso();
    const driver = new GoogleDriver({ apiKey: 'qualquer', baseUrl: servidor.baseUrl });

    const consulta = await driver.embedQuery(GEMINI_EMBEDDING_2, 'commits');
    const documentos = await driver.embedDocuments(GEMINI_EMBEDDING_2, ['commits', 'bolo']);

    expect(consulta).toHaveLength(3072);
    expect(documentos).toHaveLength(2);
    // O fluxo inteiro sem chave e sem rede externa: é o que a §13.3 item 1 pede.
    expect(servidor.requisicoes).toHaveLength(2);
  });

  it('o documento e a consulta do mesmo texto dão o mesmo vetor, porque o prefixo é removido', async () => {
    servidor = await subirServidorFalso();
    const driver = new GoogleDriver({ apiKey: 'q', baseUrl: servidor.baseUrl });

    const [doc] = await driver.embedDocuments(GEMINI_EMBEDDING_2, ['commits']);
    const consulta = await driver.embedQuery(GEMINI_EMBEDDING_2, 'commits');
    expect(doc).toEqual(consulta);
  });

  it('a troca de falha no meio do teste vale para a requisição seguinte', async () => {
    servidor = await subirServidorFalso();
    const driver = new GoogleDriver({
      apiKey: 'q',
      baseUrl: servidor.baseUrl,
      maxRetries: 0,
    });

    await driver.embedQuery(GEMINI_EMBEDDING_2, 'x');
    servidor.simular('chave-invalida-401');
    await expect(driver.embedQuery(GEMINI_EMBEDDING_2, 'x')).rejects.toThrow(/recusou a chave/);
  });
});

/**
 * Os três drivers **de verdade**, contra o servidor falso.
 *
 * É o que os testes de `fetch` simulado não cobrem: ali o formato da resposta é
 * o que o teste escreveu, e um driver que lesse o campo errado passaria. Aqui
 * o servidor responde no formato de cada API, e nenhuma chamada sai da máquina.
 */
describe('o servidor falso fala os três protocolos', () => {
  it('google: batchEmbedContents, um item por texto e com o prefixo aplicado', async () => {
    servidor = await subirServidorFalso({ provedor: 'google', exigirChave: 'k' });
    const driver = new GoogleDriver({ apiKey: 'k', baseUrl: servidor.baseUrl, maxRetries: 0 });

    const vetores = await driver.embedDocuments(GEMINI_EMBEDDING_2, ['alfa', 'bravo']);
    expect(vetores).toHaveLength(2);
    expect(vetores[0]).toHaveLength(3072);

    const corpo = servidor.requisicoes[0]!.corpo as {
      requests: { content: { parts: { text: string }[] } }[];
    };
    // A armadilha da API: vários textos num `content` só viram um vetor
    // agregado. Um item por texto, sempre.
    expect(corpo.requests).toHaveLength(2);
    expect(corpo.requests[0]!.content.parts[0]!.text).toBe(
      `${GEMINI_EMBEDDING_2.documentPrefix}alfa`,
    );
  });

  it('openai: /embeddings, sem prefixo, sem dimensions e casado pelo index', async () => {
    servidor = await subirServidorFalso({ provedor: 'openai', exigirChave: 'sk-k' });
    const driver = new OpenAIDriver({ apiKey: 'sk-k', baseUrl: servidor.baseUrl, maxRetries: 0 });

    const vetores = await driver.embedDocuments(TEXT_EMBEDDING_3_SMALL, ['alfa', 'bravo']);
    expect(vetores).toHaveLength(2);
    expect(vetores[0]).toHaveLength(1536);
    // Cada texto tem o vetor dele, e não o do vizinho.
    expect(vetores[0]).toEqual(vetorFalso('alfa', 1536));
    expect(vetores[1]).toEqual(vetorFalso('bravo', 1536));

    const corpo = servidor.requisicoes[0]!.corpo as Record<string, unknown>;
    expect(corpo.input).toEqual(['alfa', 'bravo']);
    expect(corpo).not.toHaveProperty('dimensions');
    expect(servidor.requisicoes[0]!.caminho).toBe('/v1/embeddings');
  });

  it('google: a contagem de tokens do lote chega pelo onUsage', async () => {
    // Só `batchEmbedContents` traz `usageMetadata`; a consulta fica sem
    // contagem, e é assim que o indexador sabe quando está estimando.
    const usos: UsoDeTokens[] = [];
    servidor = await subirServidorFalso({ provedor: 'google' });
    const driver = new GoogleDriver({
      apiKey: 'k',
      baseUrl: servidor.baseUrl,
      maxRetries: 0,
      onUsage: (u) => usos.push(u),
    });

    await driver.embedDocuments(GEMINI_EMBEDDING_2, ['alfa', 'bravo']);
    expect(usos).toEqual([
      { model: 'gemini-embedding-2', tokens: 20, textos: 2, metodo: 'documents' },
    ]);

    await driver.embedQuery(GEMINI_EMBEDDING_2, 'x');
    expect(usos).toHaveLength(1);
  });

  it('openai: o modelo grande devolve 3072, como o pequeno devolve 1536', async () => {
    servidor = await subirServidorFalso({ provedor: 'openai' });
    const driver = new OpenAIDriver({ apiKey: 'k', baseUrl: servidor.baseUrl, maxRetries: 0 });

    expect(await driver.embedQuery(TEXT_EMBEDDING_3_LARGE, 'x')).toHaveLength(3072);
    expect(await driver.embedQuery(TEXT_EMBEDDING_3_SMALL, 'x')).toHaveLength(1536);
  });

  it('voyage: /embeddings com input_type e output_dimension', async () => {
    servidor = await subirServidorFalso({ provedor: 'voyage', exigirChave: 'pa-k' });
    const driver = new VoyageDriver({ apiKey: 'pa-k', baseUrl: servidor.baseUrl, maxRetries: 0 });

    await driver.embedDocuments(VOYAGE_4_LITE, ['alfa']);
    await driver.embedQuery(VOYAGE_4_LITE, 'alfa');

    const doc = servidor.requisicoes[0]!.corpo as Record<string, unknown>;
    const consulta = servidor.requisicoes[1]!.corpo as Record<string, unknown>;

    expect(doc.input_type).toBe('document');
    expect(consulta.input_type).toBe('query');
    expect(doc.output_dimension).toBe(1024);
    // O mesmo texto nos dois lados: o que muda é só o parâmetro.
    expect(doc.input).toEqual(['alfa']);
    expect(consulta.input).toEqual(['alfa']);
  });

  it('cada API recusa a chave no header dela', async () => {
    servidor = await subirServidorFalso({ provedor: 'voyage', exigirChave: 'a-certa' });
    const driver = new VoyageDriver({
      apiKey: 'a-errada',
      baseUrl: servidor.baseUrl,
      maxRetries: 0,
    });
    await expect(driver.embedQuery(VOYAGE_4_LITE, 'x')).rejects.toBeInstanceOf(RagAuthError);
    // A chave chegou no `Authorization: Bearer`, não no header do Google.
    expect(servidor.requisicoes[0]!.chave).toBe('a-errada');
  });

  it('os erros de cada API viram o erro certo do projeto', async () => {
    servidor = await subirServidorFalso({ provedor: 'openai' });
    const openai = new OpenAIDriver({ apiKey: 'k', baseUrl: servidor.baseUrl, maxRetries: 0 });

    // Este é o que só o formato de verdade pega: 429 com `insufficient_quota`
    // é conta sem crédito, e insistir não resolve.
    servidor.simular('sem-credito');
    await expect(openai.embedQuery(TEXT_EMBEDDING_3_SMALL, 'x')).rejects.toBeInstanceOf(
      RagConfigError,
    );

    servidor.simular('limite-de-taxa');
    await expect(openai.embedQuery(TEXT_EMBEDDING_3_SMALL, 'x')).rejects.toBeInstanceOf(
      RagRateLimitError,
    );

    await servidor.fechar();
    servidor = await subirServidorFalso({ provedor: 'voyage', falha: 'ip-recusado' });
    const voyage = new VoyageDriver({ apiKey: 'k', baseUrl: servidor.baseUrl, maxRetries: 0 });
    await expect(voyage.embedQuery(VOYAGE_4_LITE, 'x')).rejects.toThrow(/a origem da requisição/);
  });

  /**
   * O `kind` é o que o indexador publica e o painel lê para resumir a chave.
   * Conferido aqui, contra o **corpo de erro de verdade** de cada API, porque é
   * o formato que decide: o `insufficient_quota` e o 403 de região só existem no
   * corpo, e um driver que lesse o campo errado publicaria `rate-limit` e `auth`.
   */
  it.each([
    ['google', 'chave-invalida-400', 'auth'],
    ['google', 'chave-invalida-401', 'auth'],
    ['google', 'sem-permissao-403', 'auth'],
    ['google', 'pre-condicao', 'config'],
    ['google', 'modelo-inexistente', 'config'],
    ['google', 'conteudo-recusado', 'input-too-long'],
    ['google', 'limite-de-taxa', 'rate-limit'],
    ['google', 'indisponivel', 'unavailable'],
    ['openai', 'chave-invalida-401', 'auth'],
    // País ou região sem suporte: quem foi recusado é a origem, não a chave.
    ['openai', 'sem-permissao-403', 'origin'],
    ['openai', 'sem-credito', 'quota'],
    ['openai', 'modelo-inexistente', 'config'],
    ['openai', 'conteudo-recusado', 'input-too-long'],
    ['openai', 'limite-de-taxa', 'rate-limit'],
    ['openai', 'indisponivel', 'unavailable'],
    ['voyage', 'chave-invalida-401', 'auth'],
    ['voyage', 'ip-recusado', 'origin'],
    ['voyage', 'modelo-inexistente', 'config'],
    ['voyage', 'conteudo-recusado', 'input-too-long'],
    ['voyage', 'limite-de-taxa', 'rate-limit'],
    ['voyage', 'indisponivel', 'unavailable'],
  ] as const)('%s, "%s" → kind %s', async (provedor, falha, esperado) => {
    servidor = await subirServidorFalso({ provedor, falha });
    const opcoes = { apiKey: 'k', baseUrl: servidor.baseUrl, maxRetries: 0 };
    const pedido =
      provedor === 'google'
        ? new GoogleDriver(opcoes).embedQuery(GEMINI_EMBEDDING_2, 'x')
        : provedor === 'openai'
          ? new OpenAIDriver(opcoes).embedQuery(TEXT_EMBEDDING_3_SMALL, 'x')
          : new VoyageDriver(opcoes).embedQuery(VOYAGE_4_LITE, 'x');

    const erro = await pedido.catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(ragErrorKind(erro)).toBe(esperado);
  });

  it('uma falha que a API não tem falha alto, em vez de passar por engano', async () => {
    // `pre-condicao` é do Google. Pedi-la à Voyage é erro de teste, e um 200
    // aqui deixaria a asserção passar sem testar nada.
    servidor = await subirServidorFalso({ provedor: 'voyage', falha: 'pre-condicao' });
    const driver = new VoyageDriver({ apiKey: 'k', baseUrl: servidor.baseUrl, maxRetries: 0 });
    await expect(driver.embedQuery(VOYAGE_4_LITE, 'x')).rejects.toThrow(/não simula/);
  });

  it('o vetor de dimensão errada é recusado nos três', async () => {
    servidor = await subirServidorFalso({ provedor: 'openai', falha: 'dimensao-errada' });
    const openai = new OpenAIDriver({ apiKey: 'k', baseUrl: servidor.baseUrl, maxRetries: 0 });
    await expect(openai.embedQuery(TEXT_EMBEDDING_3_SMALL, 'x')).rejects.toThrow(
      /esperado vetor de 1536 dimensões, recebido 1535/,
    );

    await servidor.fechar();
    servidor = await subirServidorFalso({ provedor: 'voyage', falha: 'dimensao-errada' });
    const voyage = new VoyageDriver({ apiKey: 'k', baseUrl: servidor.baseUrl, maxRetries: 0 });
    await expect(voyage.embedQuery(VOYAGE_4_LITE, 'x')).rejects.toThrow(
      /esperado vetor de 1024 dimensões, recebido 1023/,
    );
  });
});
