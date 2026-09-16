/**
 * A troca de driver, ponta a ponta, num PostgreSQL de verdade
 * (`docs/14-rag.md` §3 e §10).
 *
 * É a promessa que nenhum teste unitário consegue provar: **trocar de driver
 * cria outro espaço e não apaga nada**, e o texto canônico é compartilhado
 * entre os dois. Só o banco sabe dizer isso — é ele que guarda `rag_spaces`,
 * `rag_texts` e `rag_vectors`, com o `CHECK` de dimensão e a FK composta.
 *
 * Os drivers são os **de verdade**, falando o protocolo de cada provedor com o
 * servidor falso: nenhuma chave é usada e nada sai da máquina.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55440/purple_skills_test \
 *     npx vitest run apps/indexer/src/drivers.integration.test.ts
 *
 * O banco apontado é **recriado do zero**: aponte para um banco descartável.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  claimStaleSkills,
  closeDb,
  createSkill,
  findRagSpace,
  getRagSettings,
  insertRagVectors,
  listPendingRagTexts,
  ragCoverage,
  ragSchemaReady,
  readSkillForRag,
  releaseStaleSkill,
  replaceSkillTexts,
  resolveRagSpace,
  runMigrations,
  setRagIndexerStatus,
  setRagSetting,
} from '@purple-skills/db';
import {
  criarBuscaSemantica,
  subirServidorFalso,
  OpenAIDriver,
  VoyageDriver,
  TEXT_EMBEDDING_3_SMALL,
  VOYAGE_4_LITE,
  type EmbeddingDriver,
  type RagProviderId,
  type ServidorFalso,
} from '@purple-skills/rag';
import { runOnce, type IndexerPorts } from './indexer.js';

const url = process.env.TEST_DATABASE_URL;
const descreve = url ? describe : describe.skip;

/** O mesmo número das demais suítes: elas recriam o mesmo banco. */
const SCHEMA_LOCK = 8_200_004;

const SOURCE = 'web-admin' as const;
const ACTOR = { userUuid: null, label: 'teste' };

let raw: pg.Client;
let servidores: Record<'openai' | 'voyage', ServidorFalso>;
let drivers: Record<RagProviderId, EmbeddingDriver | null>;

const BASE = [
  {
    slug: 'commit-conventional',
    name: 'Conventional Commits',
    description: 'Padroniza mensagens de commit',
    tags: ['git'],
    skillMd: '# Conventional Commits\n\nUse `feat:`, `fix:` e `chore:` nas mensagens de commit.',
  },
  {
    slug: 'bolo-de-fuba',
    name: 'Bolo de fubá',
    description: 'Uma receita, para provar que nem tudo casa',
    tags: ['cozinha'],
    skillMd: '# Bolo de fubá\n\nFubá, ovos, leite e erva-doce.',
  },
];

descreve('trocar de driver, com o banco de verdade', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    await raw.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    process.env.DATABASE_URL = url;
    await runMigrations();

    for (const s of BASE) {
      await createSkill(
        { slug: s.slug, name: s.name, description: s.description, tags: s.tags, skillMd: s.skillMd },
        SOURCE,
        ACTOR,
      );
    }

    servidores = {
      openai: await subirServidorFalso({ provedor: 'openai' }),
      voyage: await subirServidorFalso({ provedor: 'voyage' }),
    };

    // O que o container monta no boot: um driver por chave presente. Qual
    // deles vale é o `rag.driver` do banco, resolvido a cada ciclo.
    drivers = {
      google: null,
      openai: new OpenAIDriver({ apiKey: 'sem-custo', baseUrl: servidores.openai.baseUrl }),
      voyage: new VoyageDriver({ apiKey: 'sem-custo', baseUrl: servidores.voyage.baseUrl }),
    };
  }, 120_000);

  afterAll(async () => {
    await servidores?.openai?.fechar();
    await servidores?.voyage?.fechar();
    await closeDb();
    await raw?.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw?.end();
  });

  function portas(): IndexerPorts {
    return {
      ragSchemaReady,
      getRagSettings,
      resolveRagSpace,
      claimStaleSkills,
      releaseStaleSkill,
      readSkillForRag,
      replaceSkillTexts,
      listPendingRagTexts,
      insertRagVectors,
      ragCoverage,
      setRagIndexerStatus,
      driver: (id) => drivers[id],
      keyPresent: (id) => drivers[id] !== null,
      log: () => {},
    };
  }

  /** Troca o par driver+modelo no banco, como o painel faria. */
  async function configurar(driver: RagProviderId, model: string) {
    await setRagSetting('rag.driver', driver, SOURCE, ACTOR);
    await setRagSetting('rag.model', model, SOURCE, ACTOR);
  }

  const espacos = async () =>
    (
      await raw.query(
        'SELECT driver, model, dimensions, document_prefix, query_prefix FROM rag_spaces ORDER BY created_at',
      )
    ).rows;

  const contar = async (tabela: string) =>
    Number((await raw.query(`SELECT count(*)::int AS n FROM ${tabela}`)).rows[0].n);

  it('openai: indexa num espaço de 1536 dimensões, sem prefixo nenhum', async () => {
    await configurar('openai', TEXT_EMBEDDING_3_SMALL.id);

    const { exitCode, result } = await runOnce(portas());
    expect(exitCode).toBe(0);
    expect(result.erros).toBe(0);

    expect(await espacos()).toEqual([
      {
        driver: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        // Vazios porque documento e consulta são a mesma chamada — e é uma
        // escolha registrada, não um campo esquecido.
        document_prefix: '',
        query_prefix: '',
      },
    ]);

    const cobertura = await ragCoverage(result.space?.uuid ?? null);
    expect(cobertura.staleSkills).toBe(0);
    expect(cobertura.pendingTexts).toBe(0);
    expect(cobertura.withVector).toBe(cobertura.texts);
    expect(cobertura.texts).toBeGreaterThanOrEqual(BASE.length * 2);
  }, 120_000);

  it('o texto guardado é o que saiu na requisição: nenhum prefixo dos dois lados', async () => {
    const enviados = servidores.openai.requisicoes.flatMap(
      (r) => (r.corpo as { input?: string[] }).input ?? [],
    );
    const { rows } = await raw.query('SELECT content FROM rag_texts');
    const guardados = rows.map((r) => String(r.content));

    expect(enviados.length).toBeGreaterThan(0);
    for (const texto of enviados) expect(guardados).toContain(texto);
  });

  it('voyage: a troca cria OUTRO espaço, e o primeiro fica inteiro', async () => {
    const textosAntes = await contar('rag_texts');
    const vetoresAntes = await contar('rag_vectors');

    await configurar('voyage', VOYAGE_4_LITE.id);
    const { exitCode, result } = await runOnce(portas());
    expect(exitCode).toBe(0);
    expect(result.erros).toBe(0);

    // Dois espaços, e o do openai intacto.
    const lista = await espacos();
    expect(lista).toHaveLength(2);
    expect(lista[0]).toMatchObject({ driver: 'openai', dimensions: 1536 });
    expect(lista[1]).toMatchObject({ driver: 'voyage', model: 'voyage-4-lite', dimensions: 1024 });

    // **O texto é compartilhado**: nenhum texto novo precisou existir. É o que
    // faz `maxPartChars` ser igual nos três drivers.
    expect(await contar('rag_texts')).toBe(textosAntes);
    // E os vetores dobraram: os do openai continuam lá, mais os do voyage.
    expect(await contar('rag_vectors')).toBe(vetoresAntes * 2);
  }, 120_000);

  it('o CHECK de dimensão prende cada vetor ao espaço dele', async () => {
    const { rows } = await raw.query(
      `SELECT s.driver, s.dimensions, vector_dims(v.embedding) AS dims
         FROM rag_vectors v JOIN rag_spaces s ON s.uuid = v.space_uuid`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.dims).toBe(row.dimensions);
  });

  it('voltar para o openai não gasta embedding nenhum', async () => {
    await configurar('openai', TEXT_EMBEDDING_3_SMALL.id);
    const antes = servidores.openai.requisicoes.length;

    const { exitCode, result } = await runOnce(portas());
    expect(exitCode).toBe(0);
    expect(result.textosEmbutidos).toBe(0);
    // Nenhuma requisição nova: os vetores do espaço anterior estavam guardados.
    expect(servidores.openai.requisicoes.length).toBe(antes);
  }, 120_000);

  it('a busca resolve o espaço do driver que o BANCO escolheu', async () => {
    const busca = criarBuscaSemantica({
      ports: { ragSchemaReady, getRagSettings, findRagSpace },
      // O mesmo resolvedor do container: todos os drivers com chave.
      driver: (id) => drivers[id],
      timeoutMs: 5000,
      cacheMs: 0,
    });

    await configurar('voyage', VOYAGE_4_LITE.id);
    const comVoyage = await busca.resolver('mensagem de commit');
    expect(comVoyage.mode).toBe('hybrid');
    expect(comVoyage.semantic?.vector).toHaveLength(1024);

    await configurar('openai', TEXT_EMBEDDING_3_SMALL.id);
    const comOpenai = await busca.resolver('mensagem de commit');
    expect(comOpenai.mode).toBe('hybrid');
    expect(comOpenai.semantic?.vector).toHaveLength(1536);

    // Espaços diferentes: é o que prova que a busca não ficou presa ao driver
    // montado no boot.
    expect(comOpenai.semantic?.spaceUuid).not.toBe(comVoyage.semantic?.spaceUuid);
  }, 120_000);

  it('a consulta vai com input_type=query na voyage, e o documento com document', async () => {
    const tipos = servidores.voyage.requisicoes.map(
      (r) => (r.corpo as { input_type?: string }).input_type,
    );
    expect(tipos).toContain('document');
    expect(tipos).toContain('query');
  });

  it('um driver sem chave neste container devolve modo textual, não erro', async () => {
    // `google` está no banco, mas este container não montou driver para ele.
    await configurar('google', 'gemini-embedding-2');
    const busca = criarBuscaSemantica({
      ports: { ragSchemaReady, getRagSettings, findRagSpace },
      driver: (id) => drivers[id],
      timeoutMs: 5000,
      cacheMs: 0,
    });

    const r = await busca.resolver('mensagem de commit');
    expect(r).toMatchObject({ mode: 'text', reason: 'sem-driver' });

    // E o indexador diz o mesmo, sem cair e sem apagar nada.
    const { result } = await runOnce(portas());
    expect(result.state).toBe('sem-chave');
    expect(await contar('rag_spaces')).toBe(2);
  }, 120_000);
});
