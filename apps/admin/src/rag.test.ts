/**
 * A busca semântica no painel (`docs/14-rag.md` §5 e §9).
 *
 * Os dois comportamentos que mais custariam caro se quebrassem:
 *
 * 1. **a semeadura não desfaz o que o painel gravou.** Um `.env` esquecido num
 *    container que reinicia não pode religar uma busca que alguém desligou de
 *    propósito — nem o contrário;
 * 2. **o aviso do nível gratuito é sempre exibido.** O painel não sabe o nível
 *    da chave, e não avisar manda conteúdo privado para treinamento sem
 *    ninguém ver.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ragErrorKind,
  GoogleDriver,
  OpenAIDriver,
  VoyageDriver,
  GEMINI_EMBEDDING_2,
  TEXT_EMBEDDING_3_SMALL,
  VOYAGE_4_LITE,
} from '@purple-skills/rag';

const db = vi.hoisted(() => ({
  getRagSettings: vi.fn(),
  seedRagSetting: vi.fn(),
  setRagSetting: vi.fn(),
  ragSchemaReady: vi.fn(),
  ragCoverage: vi.fn(),
  findRagSpace: vi.fn(),
  markAllSkillsStale: vi.fn(),
  clearRagRefusals: vi.fn(),
  badRequest: (m: string) => Object.assign(new Error(m), { status: 400 }),
  conflict: (m: string) => Object.assign(new Error(m), { status: 409 }),
}));

vi.mock('@purple-skills/db', () => db);

const { AVISO_NIVEL_GRATUITO, gravarRag, lerPainelRag, limparRecusasRag, reindexarRag, semearRag } =
  await import('./rag.js');

const ATOR = { userUuid: null, label: 'ana@exemplo' };
const COBERTURA = { texts: 10, withVector: 7, pendingTexts: 3, refusedTexts: 0, staleSkills: 1 };

/**
 * Os três drivers **de verdade**, com o `fetch` trocado por uma resposta fixa:
 * nada sai para a rede, e o erro que volta é o que o pacote lança em produção —
 * a mensagem e a classe. O painel é testado contra eles, e não contra frases
 * copiadas para cá, para que mexer no pacote volte a aparecer nesta suíte.
 */
const CHAVE_DE_TESTE = 'chave-de-teste-que-nunca-vai-para-a-tela';

const respondendo = (status: number, corpo: unknown) =>
  (async () =>
    new Response(JSON.stringify(corpo), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

const semRede = (status: number, corpo: unknown) => ({
  apiKey: CHAVE_DE_TESTE,
  baseUrl: 'https://exemplo.test/v1',
  fetchImpl: respondendo(status, corpo),
  maxRetries: 0,
  sleep: async () => {},
});

/** Um prazo já estourado: o driver devolve `RagTimeoutError` sem tentar de novo. */
const ABORTADO = AbortSignal.abort();

const google = (status: number, corpo: unknown, signal?: AbortSignal) =>
  new GoogleDriver(semRede(status, corpo)).embedQuery(GEMINI_EMBEDDING_2, 'x', signal);
const openai = (status: number, corpo: unknown, signal?: AbortSignal) =>
  new OpenAIDriver(semRede(status, corpo)).embedQuery(TEXT_EMBEDDING_3_SMALL, 'x', signal);
const voyage = (status: number, corpo: unknown, signal?: AbortSignal) =>
  new VoyageDriver(semRede(status, corpo)).embedQuery(VOYAGE_4_LITE, 'x', signal);

/** O erro com que o pedido falhou. Pedido que passa é erro do teste. */
async function erroDe(pedido: Promise<unknown>): Promise<Error> {
  const erro = await pedido.catch((e: unknown) => e);
  if (!(erro instanceof Error)) throw new Error('o pedido deveria ter falhado');
  return erro;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.RAG_DRIVER;
  delete process.env.RAG_MODEL;

  db.getRagSettings.mockResolvedValue({});
  db.ragSchemaReady.mockResolvedValue(true);
  db.ragCoverage.mockResolvedValue(COBERTURA);
  db.findRagSpace.mockResolvedValue({ uuid: 'espaco-1' });
  db.seedRagSetting.mockResolvedValue({ written: true, value: 'google' });
  db.setRagSetting.mockResolvedValue({});
  db.markAllSkillsStale.mockResolvedValue(12);
  db.clearRagRefusals.mockResolvedValue(0);
});

describe('a semeadura no boot (§5)', () => {
  it('banco vazio e ambiente definido: grava as duas', async () => {
    process.env.RAG_DRIVER = 'google';
    process.env.RAG_MODEL = 'gemini-embedding-2';

    const avisos = await semearRag();

    expect(avisos).toEqual([]);
    expect(db.seedRagSetting).toHaveBeenCalledWith('rag.driver', 'google', 'web-admin');
    expect(db.seedRagSetting).toHaveBeenCalledWith('rag.model', 'gemini-embedding-2', 'web-admin');
  });

  it('banco vazio e ambiente ausente: não grava nada', async () => {
    const avisos = await semearRag();

    expect(avisos).toEqual([]);
    expect(db.seedRagSetting).not.toHaveBeenCalled();
  });

  it('o banco já tem valor e o ambiente concorda: não regrava', async () => {
    process.env.RAG_DRIVER = 'google';
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'google', updatedAt: 'x' } });

    expect(await semearRag()).toEqual([]);
    expect(db.seedRagSetting).not.toHaveBeenCalled();
  });

  it('o banco diz off e o ambiente diz google: o banco manda, e sai o aviso', async () => {
    process.env.RAG_DRIVER = 'google';
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'off', updatedAt: 'x' } });

    const avisos = await semearRag();

    // Não regravou: quem desligou no painel continua com a busca desligada.
    expect(db.seedRagSetting).not.toHaveBeenCalled();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('RAG_DRIVER=google ignorada');
    expect(avisos[0]).toContain('rag.driver=off');
  });

  it('ambiente inválido derruba o boot em vez de virar linha no banco', async () => {
    process.env.RAG_DRIVER = 'cohere';
    await expect(semearRag()).rejects.toThrow(/ainda não foi implementado/);
    expect(db.seedRagSetting).not.toHaveBeenCalled();
  });

  it('o modelo é semeado validado contra o driver que o ambiente escolheu', async () => {
    process.env.RAG_DRIVER = 'openai';
    process.env.RAG_MODEL = 'gemini-embedding-2';
    await expect(semearRag()).rejects.toThrow(/o driver "openai" não tem/);
    expect(db.seedRagSetting).not.toHaveBeenCalled();
  });

  // O primeiro boot com `RAG_MODEL` vazio (é o que o `.env.example` sugere)
  // deixa no banco só `rag.driver`. É o estado em que o modelo do ambiente
  // ainda pode virar linha — e só pode se for do driver que o banco decidiu.
  describe('o banco já decidiu o driver e ainda não tem modelo', () => {
    it('modelo de OUTRO driver no ambiente vira aviso, não linha', async () => {
      process.env.RAG_DRIVER = 'openai';
      process.env.RAG_MODEL = 'text-embedding-3-large';
      db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'google', updatedAt: 'x' } });

      const avisos = await semearRag();

      // Gravar daria google + text-embedding-3-large: o indexador recusa a
      // configuração a cada ciclo e a busca cai para o modo textual.
      expect(db.seedRagSetting).not.toHaveBeenCalled();
      expect(avisos).toHaveLength(2);
      expect(avisos[0]).toContain('RAG_DRIVER=openai ignorada');
      expect(avisos[1]).toContain('RAG_MODEL=text-embedding-3-large ignorada');
      expect(avisos[1]).toContain('rag.driver=google');
      // O aviso diz o que continua valendo, para o operador não precisar adivinhar.
      expect(avisos[1]).toContain('gemini-embedding-2');
    });

    it('modelo DESSE driver no ambiente ainda é semeado', async () => {
      process.env.RAG_DRIVER = 'openai';
      process.env.RAG_MODEL = 'text-embedding-3-large';
      db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'openai', updatedAt: 'x' } });

      expect(await semearRag()).toEqual([]);
      expect(db.seedRagSetting).toHaveBeenCalledTimes(1);
      expect(db.seedRagSetting).toHaveBeenCalledWith(
        'rag.model',
        'text-embedding-3-large',
        'web-admin',
      );
    });

    it('sem RAG_DRIVER no ambiente, o modelo de outro driver também é só aviso', async () => {
      // O `.env` sozinho é coerente (sem driver, vale qualquer modelo conhecido);
      // quem não combina é o banco. Isso é divergência, não valor inválido: não
      // derruba o boot.
      process.env.RAG_MODEL = 'voyage-4';
      db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'google', updatedAt: 'x' } });

      const avisos = await semearRag();

      expect(db.seedRagSetting).not.toHaveBeenCalled();
      expect(avisos).toHaveLength(1);
      expect(avisos[0]).toContain('RAG_MODEL=voyage-4 ignorada');
    });

    it('com o banco em off, o modelo do ambiente fica guardado à espera de alguém ligar', async () => {
      process.env.RAG_DRIVER = 'openai';
      process.env.RAG_MODEL = 'text-embedding-3-large';
      db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'off', updatedAt: 'x' } });

      const avisos = await semearRag();

      // Desligado, o modelo não tem efeito nenhum; ligar outro driver no painel
      // troca o modelo junto (`gravarRag`).
      expect(avisos).toHaveLength(1);
      expect(avisos[0]).toContain('RAG_DRIVER=openai ignorada');
      expect(db.seedRagSetting).toHaveBeenCalledTimes(1);
      expect(db.seedRagSetting).toHaveBeenCalledWith(
        'rag.model',
        'text-embedding-3-large',
        'web-admin',
      );
    });
  });

  it('o painel trocou driver e modelo: o .env antigo gera dois avisos e o boot segue', async () => {
    // É a divergência mais comum. Validar o modelo do ambiente contra o driver
    // do banco **lançaria** aqui, e o painel deixaria de subir por causa de um
    // `.env` que a §5 manda ignorar com aviso.
    process.env.RAG_DRIVER = 'google';
    process.env.RAG_MODEL = 'gemini-embedding-2';
    db.getRagSettings.mockResolvedValue({
      'rag.driver': { value: 'voyage', updatedAt: 'x' },
      'rag.model': { value: 'voyage-4', updatedAt: 'x' },
    });

    const avisos = await semearRag();

    expect(db.seedRagSetting).not.toHaveBeenCalled();
    expect(avisos).toHaveLength(2);
    expect(avisos[0]).toContain('RAG_DRIVER=google ignorada');
    expect(avisos[1]).toContain('RAG_MODEL=gemini-embedding-2 ignorada');
    expect(avisos[1]).toContain('rag.model=voyage-4');
  });

  it('driver desconhecido gravado à mão no banco não derruba o boot', async () => {
    process.env.RAG_MODEL = 'voyage-4';
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'pinecone', updatedAt: 'x' } });

    // Sem driver de verdade o modelo não tem efeito: vale a regra frouxa.
    expect(await semearRag()).toEqual([]);
    expect(db.seedRagSetting).toHaveBeenCalledWith('rag.model', 'voyage-4', 'web-admin');
  });

  it('par já inválido no banco: avisa no boot, e não corrige sozinho', async () => {
    // Quem passou pelo defeito antes da correção ficou com google + modelo da
    // OpenAI gravados. Semeadura nunca sobrescreve linha; o que dá para fazer é
    // dizer onde se conserta.
    db.getRagSettings.mockResolvedValue({
      'rag.driver': { value: 'google', updatedAt: 'x' },
      'rag.model': { value: 'text-embedding-3-large', updatedAt: 'x' },
    });

    const avisos = await semearRag();

    expect(db.seedRagSetting).not.toHaveBeenCalled();
    expect(db.setRagSetting).not.toHaveBeenCalled();
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('rag.model=text-embedding-3-large');
    expect(avisos[0]).toContain('rag.driver=google');
    expect(avisos[0]).toContain('Busca semântica');
  });
});

describe('o que a tela mostra (§9)', () => {
  it('a origem é "banco" quando há linha gravada', async () => {
    db.getRagSettings.mockResolvedValue({
      'rag.driver': { value: 'google', updatedAt: '2026-09-15T00:00:00.000Z' },
    });

    const painel = await lerPainelRag();
    expect(painel.driver).toMatchObject({
      value: 'google',
      origem: 'banco',
      updatedAt: '2026-09-15T00:00:00.000Z',
      ambienteIgnorado: null,
    });
  });

  it('a origem é "ambiente" enquanto o valor não foi gravado', async () => {
    process.env.RAG_DRIVER = 'google';
    const painel = await lerPainelRag();
    expect(painel.driver).toMatchObject({ value: 'google', origem: 'ambiente' });
  });

  it('sem banco e sem ambiente, o padrão do código é "off"', async () => {
    const painel = await lerPainelRag();
    expect(painel.driver).toMatchObject({ value: 'off', origem: 'padrão' });
  });

  it('o ambiente que diverge aparece como ignorado, para o operador entender o log', async () => {
    process.env.RAG_DRIVER = 'google';
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'off', updatedAt: 'x' } });

    const painel = await lerPainelRag();
    expect(painel.driver.value).toBe('off');
    expect(painel.driver.ambienteIgnorado).toBe('google');
  });

  it('RAG_MODEL que não é do driver gravado não aparece como valor em uso', async () => {
    // A semeadura não grava esse modelo, e o indexador segue no padrão do
    // driver. A tela tem de mostrar o que vale — e o espaço que de fato enche.
    process.env.RAG_DRIVER = 'openai';
    process.env.RAG_MODEL = 'text-embedding-3-large';
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'google', updatedAt: 'x' } });

    const painel = await lerPainelRag();

    expect(painel.model).toMatchObject({
      value: 'gemini-embedding-2',
      origem: 'padrão',
      ambienteIgnorado: 'text-embedding-3-large',
    });
    expect(db.findRagSpace).toHaveBeenCalledWith(
      expect.objectContaining({ driver: 'google', model: 'gemini-embedding-2' }),
    );
  });

  it('RAG_MODEL do driver em uso, ainda sem linha, segue com origem "ambiente"', async () => {
    process.env.RAG_MODEL = 'text-embedding-3-large';
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'openai', updatedAt: 'x' } });

    expect((await lerPainelRag()).model).toMatchObject({
      value: 'text-embedding-3-large',
      origem: 'ambiente',
      ambienteIgnorado: null,
    });
  });

  it('o aviso do nível gratuito é do Google, e só dele', async () => {
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'google', updatedAt: 'x' } });
    const comGoogle = await lerPainelRag();
    expect(comGoogle.freeTierWarning).toBe(AVISO_NIVEL_GRATUITO);
    expect(comGoogle.freeTierWarning).toContain('skills privadas');

    // OpenAI e Voyage não treinam sobre o tráfego da API: repetir o aviso ali
    // só ensinaria o operador a ignorá-lo. Desligado, também não há o que avisar.
    for (const driver of ['off', 'openai', 'voyage']) {
      db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: driver, updatedAt: 'x' } });
      expect((await lerPainelRag()).freeTierWarning).toBeNull();
    }
  });

  it('as opções do select saem do registro, com os modelos de cada driver', async () => {
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'openai', updatedAt: 'x' } });
    const painel = await lerPainelRag();

    expect(painel.drivers).toEqual(['off', 'google', 'openai', 'voyage']);
    expect(painel.models).toEqual(['text-embedding-3-small', 'text-embedding-3-large']);
    expect(painel.driverOptions.map((d) => d.id)).toEqual(['google', 'openai', 'voyage']);
    expect(painel.driverOptions.find((d) => d.id === 'voyage')?.models).toEqual([
      'voyage-4-lite',
      'voyage-4',
      'voyage-4-large',
    ]);
  });

  it('sem a migration, não procura espaço nem cobertura', async () => {
    db.ragSchemaReady.mockResolvedValue(false);
    const painel = await lerPainelRag();

    expect(painel.schemaReady).toBe(false);
    expect(painel.spaceUuid).toBeNull();
    expect(painel.coverage).toBeNull();
    expect(db.findRagSpace).not.toHaveBeenCalled();
  });

  it('com o driver off, não procura espaço — mas ainda conta o acervo', async () => {
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'off', updatedAt: 'x' } });
    const painel = await lerPainelRag();

    expect(db.findRagSpace).not.toHaveBeenCalled();
    expect(painel.coverage).toEqual(COBERTURA);
  });

  describe('o estado da chave', () => {
    const comEstado = (estado: Record<string, unknown>) =>
      db.getRagSettings.mockResolvedValue({
        'rag.driver': { value: 'google', updatedAt: 'x' },
        'rag.indexer.status': { value: JSON.stringify(estado), updatedAt: 'x' },
      });

    it('é "desconhecido" enquanto o indexador não publicou nada', async () => {
      // O painel não recebe a chave: não tem como saber sozinho.
      expect((await lerPainelRag()).keyState).toBe('desconhecido');
    });

    it('é "ausente" quando o indexador diz que não tem chave', async () => {
      comEstado({ keyPresent: false });
      expect((await lerPainelRag()).keyState).toBe('ausente');
    });

    it('é "presente" quando o último ciclo passou', async () => {
      comEstado({ keyPresent: true, lastError: null });
      expect((await lerPainelRag()).keyState).toBe('presente');
    });

    /**
     * Os erros abaixo **não são escritos à mão**: saem do driver de verdade, com
     * o `fetch` trocado — sem rede —, no corpo de erro que cada API manda. É o
     * que prende este teste ao pacote: a classe vem de `ragErrorKind`, como o
     * indexador a publica, e a mensagem é a que o operador lê no "Último erro".
     *
     * Cada linha tem dois estados esperados: o do estado **novo**, decidido pela
     * classe, e o do **recuo**, para a linha que um indexador anterior ao campo
     * deixou gravada — ali só há a mensagem.
     */
    const falhasReais: [string, () => Promise<unknown>, string, string, string][] = [
      [
        'google: 401',
        () => google(401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'invalid credentials' } }),
        'auth',
        'recusada',
        'recusada',
      ],
      [
        'google: 400 com API_KEY_INVALID',
        () =>
          google(400, {
            error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid', details: [{ reason: 'API_KEY_INVALID' }] },
          }),
        'auth',
        'recusada',
        'recusada',
      ],
      [
        'openai: 401',
        () => openai(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }),
        'auth',
        'recusada',
        'recusada',
      ],
      ['voyage: 401', () => voyage(401, { detail: 'Provided API key is invalid.' }), 'auth', 'recusada', 'recusada'],
      // Os dois casos do relatório: nenhum deles tem "cota" nem "recusou a
      // chave" na mensagem, e os dois apareciam como "aceita pelo provedor".
      [
        'openai: conta sem crédito (429 insufficient_quota)',
        () =>
          openai(429, {
            error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' },
          }),
        'quota',
        'sem-credito',
        'nao-confirmada',
      ],
      [
        'voyage: 403 é o IP, não a chave',
        () => voyage(403, { detail: 'Forbidden IP address.' }),
        'origin',
        'nao-confirmada',
        'nao-confirmada',
      ],
      [
        'openai: 403 de país sem suporte',
        () =>
          openai(403, {
            error: {
              message: 'Country, region, or territory not supported',
              type: 'invalid_request_error',
              code: 'unsupported_country_region_territory',
            },
          }),
        'origin',
        'nao-confirmada',
        'nao-confirmada',
      ],
      [
        'google: 429',
        () => google(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } }),
        'rate-limit',
        'cota-esgotada',
        'cota-esgotada',
      ],
      [
        'openai: 429 de taxa',
        () => openai(429, { error: { message: 'Rate limit reached', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }),
        'rate-limit',
        'cota-esgotada',
        'cota-esgotada',
      ],
      ['voyage: 429', () => voyage(429, { detail: 'Rate limit exceeded.' }), 'rate-limit', 'cota-esgotada', 'cota-esgotada'],
      [
        'google: modelo inexistente',
        () => google(404, { error: { code: 404, status: 'NOT_FOUND', message: 'model not found' } }),
        'config',
        'nao-confirmada',
        'nao-confirmada',
      ],
      [
        'google: pré-condição',
        () => google(400, { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'free tier unavailable' } }),
        'config',
        'nao-confirmada',
        'nao-confirmada',
      ],
      [
        'openai: 503',
        () => openai(503, { error: { message: 'The server is overloaded', type: 'server_error', code: null } }),
        'unavailable',
        'nao-confirmada',
        'nao-confirmada',
      ],
      ['voyage: prazo estourado', () => voyage(503, { detail: 'x' }, ABORTADO), 'timeout', 'nao-confirmada', 'nao-confirmada'],
    ];

    it.each(falhasReais)('%s', async (_nome, pedir, classe, estadoNovo, estadoAntigo) => {
      const erro = await erroDe(pedir());
      expect(ragErrorKind(erro)).toBe(classe);

      // Como o indexador de hoje publica: mensagem e classe, lado a lado.
      comEstado({ keyPresent: true, lastError: erro.message, lastErrorKind: ragErrorKind(erro) });
      const painel = await lerPainelRag();
      expect(painel.keyState).toBe(estadoNovo);
      // A mensagem continua chegando inteira à tela: é ela que o operador lê.
      expect(painel.indexer?.lastError).toBe(erro.message);

      // Como o indexador anterior ao campo deixou gravado: só a mensagem.
      comEstado({ keyPresent: true, lastError: erro.message });
      expect((await lerPainelRag()).keyState).toBe(estadoAntigo);
    });

    it('nenhum erro, em formato nenhum, vira "presente"', async () => {
      // Era o defeito: o que as buscas por pedaço de texto não reconheciam caía
      // em "aceita pelo provedor no último ciclo", logo acima do erro.
      for (const [, pedir] of falhasReais) {
        const erro = await erroDe(pedir());
        for (const estado of [
          { keyPresent: true, lastError: erro.message, lastErrorKind: ragErrorKind(erro) },
          { keyPresent: true, lastError: erro.message },
        ]) {
          comEstado(estado);
          expect((await lerPainelRag()).keyState).not.toBe('presente');
        }
      }
    });

    it('decide pela classe, não pela redação: a mensagem pode mudar à vontade', async () => {
      comEstado({ keyPresent: true, lastError: 'texto que ninguém previu', lastErrorKind: 'auth' });
      expect((await lerPainelRag()).keyState).toBe('recusada');

      // E o contrário: mensagem que casaria com o recuo, mas com classe
      // publicada — quem manda é a classe.
      comEstado({
        keyPresent: true,
        lastError: 'o provedor recusou a chave e a cota acabou',
        lastErrorKind: 'unavailable',
      });
      expect((await lerPainelRag()).keyState).toBe('nao-confirmada');
    });

    it('erro sem classe não veio do provedor: a chave fica "nao-confirmada"', async () => {
      // Falha ao refatiar ou ao gravar o vetor. O ciclo não confirmou nada.
      comEstado({ keyPresent: true, lastError: 'constraint violada', lastErrorKind: null });
      expect((await lerPainelRag()).keyState).toBe('nao-confirmada');

      comEstado({ keyPresent: true, lastError: null, lastErrorKind: null });
      expect((await lerPainelRag()).keyState).toBe('presente');
    });

    it('classe que este painel não conhece não derruba a tela nem vira "presente"', async () => {
      // O indexador pode ser mais novo que o painel.
      comEstado({ keyPresent: true, lastError: 'algo novo', lastErrorKind: 'classe-do-futuro' });
      expect((await lerPainelRag()).keyState).toBe('nao-confirmada');

      // Nome de propriedade herdada não pode passar por classe conhecida.
      comEstado({ keyPresent: true, lastError: 'algo novo', lastErrorKind: 'toString' });
      expect((await lerPainelRag()).keyState).toBe('nao-confirmada');
    });

    it('sem chave, a classe do erro não importa', async () => {
      comEstado({ keyPresent: false, lastError: 'x', lastErrorKind: 'config' });
      expect((await lerPainelRag()).keyState).toBe('ausente');
    });

    it('o que vai para a tela é a classificação, nunca a chave', async () => {
      const erro = await erroDe(openai(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }));
      comEstado({ keyPresent: true, lastError: erro.message, lastErrorKind: ragErrorKind(erro) });

      const painel = await lerPainelRag();
      expect(painel.keyState).toBe('recusada');
      expect(JSON.stringify(painel)).not.toContain(CHAVE_DE_TESTE);
    });

    it('estado com JSON quebrado não derruba a tela', async () => {
      db.getRagSettings.mockResolvedValue({
        'rag.indexer.status': { value: '{isso não é json', updatedAt: 'x' },
      });
      const painel = await lerPainelRag();
      expect(painel.indexer).toBeNull();
      expect(painel.keyState).toBe('desconhecido');
    });
  });
});

describe('gravar pelo painel', () => {
  it('liga e desliga o driver', async () => {
    await gravarRag(ATOR, { driver: 'off' });
    expect(db.setRagSetting).toHaveBeenCalledWith('rag.driver', 'off', 'web-admin', ATOR);

    await gravarRag(ATOR, { driver: 'google' });
    expect(db.setRagSetting).toHaveBeenCalledWith('rag.driver', 'google', 'web-admin', ATOR);
  });

  it('recusa driver que não existe', async () => {
    await expect(gravarRag(ATOR, { driver: 'pinecone' })).rejects.toThrow(/Driver inválido/);
    expect(db.setRagSetting).not.toHaveBeenCalled();
  });

  it('recusa driver ainda não implementado', async () => {
    await expect(gravarRag(ATOR, { driver: 'cohere' })).rejects.toThrow(/Driver inválido/);
  });

  it('recusa modelo que o driver em uso não tem', async () => {
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'google', updatedAt: 'x' } });
    await expect(gravarRag(ATOR, { model: 'gemini-embedding-1' })).rejects.toThrow(
      /Modelo inválido/,
    );
    await expect(gravarRag(ATOR, { driver: 'openai', model: 'gemini-embedding-2' })).rejects.toThrow(
      /O driver "openai" aceita/,
    );
    expect(db.setRagSetting).not.toHaveBeenCalled();
  });

  it('trocar de driver sem dizer o modelo grava o padrão do driver novo', async () => {
    db.getRagSettings.mockResolvedValue({
      'rag.driver': { value: 'google', updatedAt: 'x' },
      'rag.model': { value: 'gemini-embedding-2', updatedAt: 'x' },
    });

    await gravarRag(ATOR, { driver: 'voyage' });

    // Sem isto o banco ficaria com voyage + gemini-embedding-2, e o indexador
    // recusaria a configuração no ciclo seguinte.
    expect(db.setRagSetting).toHaveBeenCalledWith('rag.driver', 'voyage', 'web-admin', ATOR);
    expect(db.setRagSetting).toHaveBeenCalledWith('rag.model', 'voyage-4-lite', 'web-admin', ATOR);
  });

  it('corpo vazio é 400, não uma gravação silenciosa', async () => {
    await expect(gravarRag(ATOR, {})).rejects.toThrow(/Nada a alterar/);
  });

  it('devolve o painel já atualizado, para a tela não precisar de outro pedido', async () => {
    const painel = await gravarRag(ATOR, { driver: 'google' });
    expect(painel).toHaveProperty('coverage');
    expect(painel).toHaveProperty('keyState');
  });
});

describe('reindexar', () => {
  it('marca o acervo e diz quantas skills entraram', async () => {
    expect(await reindexarRag(ATOR)).toEqual({ skills: 12 });
    expect(db.markAllSkillsStale).toHaveBeenCalledWith('web-admin', ATOR);
  });

  it('sem a migration, recusa em vez de estourar no SQL', async () => {
    db.ragSchemaReady.mockResolvedValue(false);
    await expect(reindexarRag(ATOR)).rejects.toThrow(/migration do RAG ainda não foi aplicada/);
    expect(db.markAllSkillsStale).not.toHaveBeenCalled();
  });
});

/**
 * O reparo da recusa gravada por engano (relatório 025 da auditoria de
 * 2026-09-19): a marca é permanente, e "Reindexar" não a desfaz — o texto volta
 * sob o mesmo hash e reencontra a mesma linha. Quem a desfaz é um gesto à parte
 * do administrador, no espaço **em uso**.
 */
describe('tentar de novo os textos recusados', () => {
  const comOpenaiLarge = () =>
    db.getRagSettings.mockResolvedValue({
      'rag.driver': { value: 'openai', updatedAt: 'x' },
      'rag.model': { value: 'text-embedding-3-large', updatedAt: 'x' },
    });

  it('limpa as recusas do espaço em uso e diz quantas saíram', async () => {
    comOpenaiLarge();
    db.findRagSpace.mockResolvedValue({ uuid: 'espaco-openai-large' });
    db.clearRagRefusals.mockResolvedValue(7);

    expect(await limparRecusasRag(ATOR)).toEqual({ refusals: 7 });

    // O espaço é o do par driver+modelo que a tela mostra — o mesmo de onde sai a
    // contagem ao lado do botão.
    expect(db.findRagSpace).toHaveBeenCalledWith({
      driver: 'openai',
      model: 'text-embedding-3-large',
      dimensions: 3072,
      documentPrefix: '',
      queryPrefix: '',
    });
    expect(db.clearRagRefusals).toHaveBeenCalledWith('espaco-openai-large', 'web-admin', ATOR);
  });

  it('não é o "Reindexar": não marca o acervo para refatiar', async () => {
    // Reindexar é de graça por contrato; limpar recusas custa requisições.
    comOpenaiLarge();
    await limparRecusasRag(ATOR);
    expect(db.markAllSkillsStale).not.toHaveBeenCalled();
  });

  it('sem a migration, recusa em vez de estourar no SQL', async () => {
    db.ragSchemaReady.mockResolvedValue(false);
    await expect(limparRecusasRag(ATOR)).rejects.toMatchObject({ status: 409 });
    expect(db.clearRagRefusals).not.toHaveBeenCalled();
  });

  it('com a busca desligada não há espaço em uso: recusa sem apagar nada', async () => {
    db.getRagSettings.mockResolvedValue({ 'rag.driver': { value: 'off', updatedAt: 'x' } });
    await expect(limparRecusasRag(ATOR)).rejects.toMatchObject({ status: 409 });
    expect(db.findRagSpace).not.toHaveBeenCalled();
    expect(db.clearRagRefusals).not.toHaveBeenCalled();
  });

  it('espaço que o indexador ainda não criou: recusa sem apagar nada', async () => {
    comOpenaiLarge();
    db.findRagSpace.mockResolvedValue(null);
    await expect(limparRecusasRag(ATOR)).rejects.toThrow(/indexador ainda não/);
    expect(db.clearRagRefusals).not.toHaveBeenCalled();
  });

  it('falha ao procurar o espaço é erro, não "nada a limpar"', async () => {
    // A tela engole esta falha para não quebrar; o gesto do administrador não
    // pode: responder "não há espaço em uso" com o banco fora do ar seria mentir.
    comOpenaiLarge();
    db.findRagSpace.mockRejectedValue(new Error('sem conexão com o banco'));
    await expect(limparRecusasRag(ATOR)).rejects.toThrow('sem conexão com o banco');
    expect(db.clearRagRefusals).not.toHaveBeenCalled();
  });
});
