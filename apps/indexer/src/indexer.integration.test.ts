/**
 * O critério de aceite do PR 3 (`docs/14-rag.md` §12): o **modo único**
 * indexa a base de smoke contra o **servidor falso** e sai com código 0; sem a
 * migration, espera sem cair.
 *
 * O que roda aqui é o caminho de verdade, ponta a ponta: o `GoogleDriver` real
 * falando o protocolo da Gemini API com o servidor falso, as queries reais do
 * `@purple-skills/db` num PostgreSQL real com pgvector. Nenhuma chave é usada
 * e nada sai da máquina — é o item 1 da §13.3.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/purple_skills_test \
 *     npx vitest run apps/indexer/src/indexer.integration.test.ts
 *
 * O banco apontado é **recriado do zero** a cada execução: aponte para um
 * banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  claimStaleSkills,
  closeDb,
  createSkill,
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
  setFile,
  setRagSetting,
} from '@purple-skills/db';
import {
  GEMINI_EMBEDDING_2,
  GoogleDriver,
  subirServidorFalso,
  type ServidorFalso,
} from '@purple-skills/rag';
import { runOnce, type IndexerPorts } from './indexer.js';

const url = process.env.TEST_DATABASE_URL;
const descreve = url ? describe : describe.skip;

/** O mesmo número das suítes de `database/`: elas recriam o mesmo banco. */
const SCHEMA_LOCK = 8_200_004;

const SOURCE = 'web-admin' as const;
const ACTOR = { userUuid: null, label: 'teste' };

let raw: pg.Client;
let servidor: ServidorFalso;

/** Uma base de smoke pequena: três skills, com o SKILL.md de cada uma. */
const BASE = [
  {
    slug: 'commit-conventional',
    name: 'Conventional Commits',
    description: 'Padroniza mensagens de commit',
    tags: ['git'],
    skillMd: '# Conventional Commits\n\nUse `feat:`, `fix:` e `chore:` nas mensagens de commit.',
  },
  {
    slug: 'code-review',
    name: 'Code Review',
    description: 'Revisa mudanças antes do merge',
    tags: ['qualidade'],
    skillMd: '# Code Review\n\nLeia o diff inteiro antes de comentar.',
  },
  {
    slug: 'bolo-de-fuba',
    name: 'Bolo de fubá',
    description: 'Uma receita, para provar que nem tudo casa',
    tags: ['cozinha'],
    skillMd: '# Bolo de fubá\n\nFubá, ovos, leite e erva-doce.',
  },
];

descreve('o indexador ponta a ponta', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    await raw.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    process.env.DATABASE_URL = url;
    await runMigrations();

    for (const s of BASE) {
      await createSkill(
        {
          slug: s.slug,
          name: s.name,
          description: s.description,
          tags: s.tags,
          skillMd: s.skillMd,
        },
        SOURCE,
        ACTOR,
      );
    }

    await setRagSetting('rag.driver', 'google', SOURCE, ACTOR);
    await setRagSetting('rag.model', GEMINI_EMBEDDING_2.id, SOURCE, ACTOR);

    servidor = await subirServidorFalso();
  }, 120_000);

  afterAll(async () => {
    await servidor?.fechar();
    await closeDb();
    await raw?.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw?.end();
  });

  /** As portas reais, com o driver apontando para o servidor falso. */
  function portasReais(over: Partial<IndexerPorts> = {}): IndexerPorts {
    const logs: string[] = [];
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
      driver: new GoogleDriver({
        // Chave qualquer: o servidor falso não a confere, e nenhuma real é usada.
        apiKey: 'sem-custo',
        baseUrl: servidor.baseUrl,
      }),
      keyPresent: true,
      log: (m) => logs.push(m),
      ...over,
    };
  }

  it('o modo único indexa a base de smoke e sai com código 0', async () => {
    const { exitCode, result } = await runOnce(portasReais());

    expect(exitCode).toBe(0);
    expect(result.erros).toBe(0);

    // Toda skill foi refatiada e todo texto ganhou vetor.
    const cobertura = await ragCoverage(result.space?.uuid ?? null);
    expect(cobertura.staleSkills).toBe(0);
    expect(cobertura.texts).toBeGreaterThanOrEqual(BASE.length * 2);
    expect(cobertura.pendingTexts).toBe(0);
    expect(cobertura.withVector).toBe(cobertura.texts);
  }, 120_000);

  it('o espaço criado é o do gemini-embedding-2, com os dois prefixos', async () => {
    const { rows } = await raw.query(
      'SELECT driver, model, dimensions, document_prefix, query_prefix FROM rag_spaces',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      driver: 'google',
      model: GEMINI_EMBEDDING_2.id,
      dimensions: GEMINI_EMBEDDING_2.dimensions,
      document_prefix: GEMINI_EMBEDDING_2.documentPrefix,
      query_prefix: GEMINI_EMBEDDING_2.queryPrefix,
    });
  });

  it('o prefixo foi aplicado na chamada, e nunca gravado no banco', async () => {
    // O que saiu para o "provedor" leva o prefixo de documento...
    const enviados = servidor.requisicoes.flatMap((r) => {
      const corpo = r.corpo as { requests?: { content: { parts: { text: string }[] } }[] };
      return (corpo.requests ?? []).map((p) => p.content.parts[0]!.text);
    });
    expect(enviados.length).toBeGreaterThan(0);
    for (const texto of enviados) {
      expect(texto.startsWith(GEMINI_EMBEDDING_2.documentPrefix)).toBe(true);
    }

    // ...e o que ficou guardado, não.
    const { rows } = await raw.query('SELECT content FROM rag_texts');
    for (const row of rows) {
      expect(String(row.content).startsWith(GEMINI_EMBEDDING_2.documentPrefix)).toBe(false);
    }
  });

  it('cada texto virou um item de requests[] — nada de vetor agregado', async () => {
    for (const requisicao of servidor.requisicoes) {
      const corpo = requisicao.corpo as {
        requests?: { content: { parts: unknown[] } }[];
      };
      for (const pedido of corpo.requests ?? []) {
        expect(pedido.content.parts).toHaveLength(1);
      }
    }
  });

  it('a segunda passada não embute nada: o vetor é endereçado pelo hash', async () => {
    const antes = servidor.requisicoes.length;
    const { exitCode, result } = await runOnce(portasReais());

    expect(exitCode).toBe(0);
    expect(result.textosEmbutidos).toBe(0);
    // Nenhuma requisição nova ao provedor: é o item 4 da §13.3, reindexar sem custo.
    expect(servidor.requisicoes.length).toBe(antes);
  }, 120_000);

  it('reindexar refatia tudo e continua sem embutir nada', async () => {
    await raw.query('UPDATE skills SET rag_stale = true');
    const antes = servidor.requisicoes.length;

    const { exitCode, result } = await runOnce(portasReais());
    expect(exitCode).toBe(0);
    expect(result.erros).toBe(0);

    // As skills foram refatiadas de novo...
    const { rows } = await raw.query('SELECT count(*)::int AS n FROM skills WHERE rag_stale');
    expect(rows[0].n).toBe(0);
    // ...e nenhum texto precisou de embedding, porque nenhum mudou.
    expect(servidor.requisicoes.length).toBe(antes);
  }, 120_000);

  it('mudar o conteúdo de uma skill embute só o texto novo', async () => {
    const antes = servidor.requisicoes.length;
    await setFile(
      'commit-conventional',
      'SKILL.md',
      '# Conventional Commits\n\nTexto novo, que ainda não tem vetor nenhum.',
      SOURCE,
      ACTOR,
    );

    const { exitCode, result } = await runOnce(portasReais());
    expect(exitCode).toBe(0);
    expect(result.erros).toBe(0);
    // Houve chamada nova...
    expect(servidor.requisicoes.length).toBeGreaterThan(antes);

    const cobertura = await ragCoverage(result.space?.uuid ?? null);
    expect(cobertura.pendingTexts).toBe(0);
  }, 120_000);

  it('publica o estado do indexador no banco, sem auditar', async () => {
    const settings = await getRagSettings();
    const estado = settings['rag.indexer.status'];
    expect(estado?.value).toBeTruthy();

    const json = JSON.parse(estado!.value!) as Record<string, unknown>;
    expect(json).toMatchObject({ driver: 'google', keyPresent: true, pendingTexts: 0 });

    // O estado é regravado a cada ciclo: auditá-lo inundaria a trilha.
    const { rows } = await raw.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'rag.settings'",
    );
    // Só as duas gravações do beforeAll, nenhuma do indexador.
    expect(rows[0].n).toBe(2);
  });

  it('sem a migration, o modo único espera sem cair', async () => {
    await raw.query('DROP TABLE IF EXISTS rag_vectors, rag_skill_texts, rag_texts, rag_spaces CASCADE');

    const { exitCode, rodadas, result } = await runOnce(portasReais());
    expect(result.state).toBe('esperando-migration');
    expect(rodadas).toBe(1);
    expect(exitCode).toBe(0);
    expect(await ragSchemaReady()).toBe(false);
  }, 120_000);
});
