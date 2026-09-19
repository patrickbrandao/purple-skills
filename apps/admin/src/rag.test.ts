/**
 * A busca semântica no painel (`docs/14-rag.md` §4.1 e §9).
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

const db = vi.hoisted(() => ({
  getRagSettings: vi.fn(),
  seedRagSetting: vi.fn(),
  setRagSetting: vi.fn(),
  ragSchemaReady: vi.fn(),
  ragCoverage: vi.fn(),
  findRagSpace: vi.fn(),
  markAllSkillsStale: vi.fn(),
  badRequest: (m: string) => Object.assign(new Error(m), { status: 400 }),
  conflict: (m: string) => Object.assign(new Error(m), { status: 409 }),
}));

vi.mock('@purple-skills/db', () => db);

const { AVISO_NIVEL_GRATUITO, gravarRag, lerPainelRag, reindexarRag, semearRag } = await import(
  './rag.js'
);

const ATOR = { userUuid: null, label: 'ana@exemplo' };
const COBERTURA = { texts: 10, withVector: 7, pendingTexts: 3, refusedTexts: 0, staleSkills: 1 };

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
});

describe('a semeadura no boot (§4.1)', () => {
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

    it('é "recusada" quando o Google devolveu chave inválida', async () => {
      comEstado({ keyPresent: true, lastError: 'o Google recusou a chave (401 UNAUTHENTICATED)' });
      expect((await lerPainelRag()).keyState).toBe('recusada');
    });

    it('é "cota-esgotada" no limite de taxa', async () => {
      comEstado({ keyPresent: true, lastError: 'limite de taxa do Google (429)' });
      expect((await lerPainelRag()).keyState).toBe('cota-esgotada');
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
