/**
 * A busca híbrida ponta a ponta (`docs/14-rag.md` §8).
 *
 * Aqui não há mock: o handler real do `search_skills`, o `listSkills` real do
 * `@purple-skills/db` sobre um PostgreSQL com pgvector, e o `GoogleDriver` real
 * falando com o servidor falso. É o que prova que as peças dos PRs 1 a 4
 * encaixam — o resto da suíte testa cada uma isolada.
 *
 * O que **não** dá para provar aqui é a qualidade semântica: o servidor falso
 * gera vetores por palavras, não por significado, então as três consultas da
 * §13.3 (singular/plural, palavra a mais, idioma diferente) só têm resposta com
 * a chave real, no deploy. O que se prova aqui é o mecanismo: a fusão acontece,
 * o recorte vale nas duas pernas, o modo é informado e nada disso quebra quando
 * o provedor some.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada.
 *
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/purple_skills_test \
 *     npx vitest run apps/mcp-public/src/search.integration.test.ts
 *
 * O banco apontado é **recriado do zero**: aponte para um banco descartável.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { GEMINI_EMBEDDING_2, subirServidorFalso, type ServidorFalso } from '@purple-skills/rag';

const url = process.env.TEST_DATABASE_URL;
const descreve = url ? describe : describe.skip;

/** O mesmo número das suítes de `database/`: elas recriam o mesmo banco. */
const SCHEMA_LOCK = 8_200_004;

const SOURCE = 'web-admin' as const;
const ACTOR = { userUuid: null, label: 'teste' };

let raw: pg.Client;
let servidor: ServidorFalso;
let handlers: { search_skills: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }> };
let db: typeof import('@purple-skills/db');
let indexar: () => Promise<void>;

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
    description: 'Uma receita que não tem nada a ver com código',
    tags: ['cozinha'],
    skillMd: '# Bolo de fubá\n\nFubá, ovos, leite e erva-doce.',
  },
];

descreve('a busca híbrida do mcp-public', () => {
  beforeAll(async () => {
    servidor = await subirServidorFalso();

    // O driver do `rag.ts` é montado no carregamento do módulo: o ambiente
    // precisa estar pronto ANTES do import.
    process.env.DATABASE_URL = url;
    process.env.RAG_GOOGLE_API_KEY = 'sem-custo';
    process.env.RAG_GOOGLE_BASE_URL = servidor.baseUrl;

    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    await raw.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    db = await import('@purple-skills/db');
    await db.runMigrations();

    const mcp = await db.createVirtualMcp(
      { slug: 'public', name: 'Public', isOpen: true, ownerUserUuid: null },
      SOURCE,
      ACTOR,
    );

    for (const s of BASE) {
      await db.createSkill(
        { slug: s.slug, name: s.name, description: s.description, tags: s.tags, skillMd: s.skillMd },
        SOURCE,
        ACTOR,
      );
      await db.linkSkill(
        s.slug,
        mcp.uuid,
        { asSkill: true, asPrompt: false, asResource: false },
        SOURCE,
        ACTOR,
      );
    }

    await db.setRagSetting('rag.driver', 'google', SOURCE, ACTOR);
    await db.setRagSetting('rag.model', 'gemini-embedding-2', SOURCE, ACTOR);

    const { createHandlers } = await import('./tools.js');
    handlers = createHandlers({
      mcp: { uuid: mcp.uuid, slug: mcp.slug, name: mcp.name, description: '', isOpen: true },
      baseUrl: 'https://mcp.exemplo.dev',
    } as never);

    // Um ciclo do indexador de verdade, para haver vetor a consultar.
    const { runOnce } = await import('../../indexer/src/indexer.js');
    const { GoogleDriver } = await import('@purple-skills/rag');
    indexar = async () => {
      await runOnce({
        ragSchemaReady: db.ragSchemaReady,
        getRagSettings: db.getRagSettings,
        resolveRagSpace: db.resolveRagSpace,
        claimStaleSkills: db.claimStaleSkills,
        releaseStaleSkill: db.releaseStaleSkill,
        readSkillForRag: db.readSkillForRag,
        replaceSkillTexts: db.replaceSkillTexts,
        listPendingRagTexts: db.listPendingRagTexts,
        insertRagVectors: db.insertRagVectors,
        ragCoverage: db.ragCoverage,
        setRagIndexerStatus: db.setRagIndexerStatus,
        driver: new GoogleDriver({ apiKey: 'sem-custo', baseUrl: servidor.baseUrl }),
        keyPresent: true,
        log: () => {},
      });
    };
    await indexar();
  }, 180_000);

  afterAll(async () => {
    await servidor?.fechar();
    await db?.closeDb();
    await raw?.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw?.end();
  });

  const buscar = async (query: string) =>
    JSON.parse((await handlers.search_skills({ query })).content[0]!.text) as {
      mode: string;
      total: number;
      results: { slug: string }[];
    };

  it('com tudo no lugar, a busca sai em modo híbrido', async () => {
    const r = await buscar('mensagens de commit');
    expect(r.mode).toBe('hybrid');
    expect(r.results.length).toBeGreaterThan(0);
  }, 60_000);

  it('a fusão traz quem casa nas duas pernas à frente', async () => {
    // "commit" casa no texto e no vetor da skill de commits.
    const r = await buscar('commit');
    expect(r.results[0]!.slug).toBe('commit-conventional');
  }, 60_000);

  it('a perna vetorial traz skill que a textual não traria', async () => {
    // "fubá" não aparece em nenhuma skill de código, mas o vetor da receita
    // aponta para lá — e sem corte por distância ela vem de qualquer forma.
    const r = await buscar('fubá');
    expect(r.results.map((s) => s.slug)).toContain('bolo-de-fuba');
  }, 60_000);

  it('a distância nunca vai para o cliente', async () => {
    const bruto = (await handlers.search_skills({ query: 'commit' })).content[0]!.text;
    expect(bruto).not.toContain('distance');
    expect(bruto).not.toContain('neighbors');
  }, 60_000);

  /**
   * O corte da consulta (`consultaDaBusca`, em `tools.ts`) vale **antes** das
   * duas pernas: o provedor recebe o recorte, e não o que o cliente mandou.
   * Aqui isso é conferido no corpo que chegou ao servidor falso — é a única
   * prova de que a consulta inteira não sai daqui.
   */
  it('a consulta longa chega ao provedor já cortada', async () => {
    const antes = servidor.requisicoes.length;
    const longa = `mensagens de commit ${'padronizar a mensagem '.repeat(40)}`;

    expect((await buscar(longa)).mode).toBe('hybrid');

    const enviados = servidor.requisicoes
      .slice(antes)
      .map(
        (req) =>
          (req.corpo as { content?: { parts?: { text?: string }[] } }).content?.parts?.[0]?.text ?? '',
      )
      .filter((texto) => texto.startsWith(GEMINI_EMBEDDING_2.queryPrefix));

    expect(enviados).toHaveLength(1);
    const consulta = enviados[0]!.slice(GEMINI_EMBEDDING_2.queryPrefix.length);
    expect(consulta.length).toBeLessThanOrEqual(200);
    expect(longa.startsWith(consulta)).toBe(true);
  }, 60_000);

  /**
   * O critério de aceite do PR 4: com o driver desligado, os resultados são
   * **idênticos aos de hoje** — mesma ordem, mesmo total, mesmo tudo, e só o
   * campo `mode` muda.
   */
  it('desligar o driver volta a busca ao modo textual, com o mesmo resultado de antes', async () => {
    const hibrido = await buscar('commit');

    await db.setRagSetting('rag.driver', 'off', SOURCE, ACTOR);
    const { buscaSemantica } = await import('./rag.js');
    buscaSemantica.invalidar();

    const textual = await buscar('commit');
    expect(textual.mode).toBe('text');

    // A skill que a busca textual acha continua no mesmo lugar.
    expect(textual.results[0]!.slug).toBe(hibrido.results[0]!.slug);

    await db.setRagSetting('rag.driver', 'google', SOURCE, ACTOR);
    buscaSemantica.invalidar();
    expect((await buscar('commit')).mode).toBe('hybrid');
  }, 60_000);

  /**
   * A exclusão com hífen (`-termo`) é da perna **textual**: `websearch_to_tsquery`
   * a traduz em `!'termo'`, e a CTE `semantica` do `listSkills` filtra só por
   * visibilidade e tag. Na híbrida a skill excluída volta pelo vetor — sempre,
   * num acervo de até 20 skills com vetor, porque não há corte por distância — e
   * o termo excluído ainda vai inteiro ao provedor, puxando por ela (relatório
   * 062 da auditoria de 2026-09-19).
   *
   * Este teste fixa a limitação **como ela é descrita** ao cliente, na descrição
   * de `search_skills` (`server.ts`) e nos riscos aceitos do `docs/14-rag.md`. No
   * dia em que o banco aplicar a parte negativa da consulta à perna vetorial, a
   * segunda metade daqui falha — e é a hora de corrigir os dois textos junto.
   */
  it('a exclusão com hífen vale na perna textual; na híbrida o vizinho excluído volta pelo vetor', async () => {
    const { buscaSemantica } = await import('./rag.js');
    // "de" está nas três skills; "-commit" tira a de commits.
    const consulta = 'de -commit';

    await db.setRagSetting('rag.driver', 'off', SOURCE, ACTOR);
    buscaSemantica.invalidar();
    const textual = await buscar(consulta);
    expect(textual.mode).toBe('text');
    expect(textual.results.map((s) => s.slug).sort()).toEqual(['bolo-de-fuba', 'code-review']);

    await db.setRagSetting('rag.driver', 'google', SOURCE, ACTOR);
    buscaSemantica.invalidar();
    const hibrida = await buscar(consulta);
    expect(hibrida.mode).toBe('hybrid');
    expect(hibrida.results.map((s) => s.slug)).toContain('commit-conventional');
  }, 60_000);

  it('com o provedor fora do ar, a busca responde em texto sem erro para o cliente', async () => {
    servidor.simular('indisponivel');
    const r = await buscar('commit');

    expect(r.mode).toBe('text');
    expect(r.results.length).toBeGreaterThan(0);
    servidor.simular(undefined);
  }, 60_000);

  it('com a chave recusada, idem — a busca não quebra', async () => {
    servidor.simular('chave-invalida-401');
    const r = await buscar('commit');

    expect(r.mode).toBe('text');
    expect(r.results.length).toBeGreaterThan(0);
    servidor.simular(undefined);
  }, 60_000);

  it('sem a migration do RAG, a busca responde em texto sem bater em tabela inexistente', async () => {
    const { buscaSemantica } = await import('./rag.js');
    await raw.query('DROP TABLE IF EXISTS rag_vectors, rag_skill_texts, rag_texts, rag_spaces CASCADE');
    buscaSemantica.invalidar();

    const r = await buscar('commit');
    expect(r.mode).toBe('text');
    expect(r.results.length).toBeGreaterThan(0);
  }, 60_000);
});
