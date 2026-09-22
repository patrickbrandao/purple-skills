/**
 * Teste de integração da adoção de órfãos pelo administrador solitário
 * (`adoptOrphans`) — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/orphans.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { BOOTSTRAP_ACTOR, TOKEN_ACTOR, type AuditActor } from '@purple-skills/shared';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import {
  adoptOrphans,
  createCatalog,
  createSkill,
  createUser,
  createVirtualMcp,
  getCatalog,
  getSkillSummary,
  listAuditPage,
  listCatalogGrants,
  listSkillGrants,
  listVirtualMcpGrants,
  setCatalogGrant,
  setDefaultVirtualMcp,
  setSkillGrant,
  setVirtualMcpGrant,
  updateUser,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

/** A resposta de quem não é elegível: nada adotado, nada gravado. */
const NOT_ADOPTED = { adopted: false, skills: 0, catalogs: 0 };

let raw: pg.Client;
let eduUuid = '';
let melUuid = '';
let anaUuid = '';
let biaUuid = '';
let inaUuid = '';
let publicMcpUuid = '';
let eduMcpUuid = '';

const edu: AuditActor = { userUuid: null, label: 'edu' };
const ana: AuditActor = { userUuid: null, label: 'ana' };

const ORPHAN_SKILLS = ['orfa-bootstrap', 'orfa-sem-ator', 'orfa-token'];

async function auditCount(): Promise<number> {
  const { rows } = await raw.query<{ total: number }>('SELECT count(*)::int AS total FROM audit_log');
  return rows[0]!.total;
}

async function ownerOf(table: 'skills' | 'catalogs' | 'virtual_mcps', slug: string): Promise<string | null> {
  const { rows } = await raw.query<{ owner_user_uuid: string | null }>(
    `SELECT owner_user_uuid FROM ${table} WHERE slug = $1`,
    [slug],
  );
  if (rows.length === 0) throw new Error(`${table}: ${slug} não existe`);
  return rows[0]!.owner_user_uuid;
}

async function skillUuid(slug: string): Promise<string> {
  const { rows } = await raw.query<{ uuid: string }>('SELECT uuid FROM skills WHERE slug = $1', [slug]);
  return rows[0]!.uuid;
}

/** O que adotar não pode mudar: `updated_at`, `rag_stale` e o `search_vector`. */
async function untouchable(): Promise<unknown[]> {
  const skills = await raw.query(
    `SELECT slug, updated_at, rag_stale, search_vector::text AS search_vector
     FROM skills ORDER BY slug`,
  );
  const catalogs = await raw.query('SELECT slug, updated_at FROM catalogs ORDER BY slug');
  const mcps = await raw.query('SELECT slug, updated_at FROM virtual_mcps ORDER BY slug');
  return [skills.rows, catalogs.rows, mcps.rows];
}

/** As últimas `n` linhas da trilha, na ordem em que entraram (o `id` é uuidv7). */
async function lastAudit(n: number) {
  const { rows } = await raw.query(
    `SELECT skill_uuid, skill_slug, file_path, action, source, previous_content,
            actor_user_uuid, actor_label, target_label
     FROM audit_log ORDER BY id DESC LIMIT $1`,
    [n],
  );
  return rows.reverse();
}

describe.skipIf(!url)('adoção de órfãos pelo administrador solitário', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    await runMigrations(url!);
    // As queries resolvem a conexão por `getDb()`, que lê o ambiente na
    // primeira chamada — ainda não houve nenhuma até aqui.
    process.env.DATABASE_URL = url;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('monta o cenário: órfãos do token e do bootstrap, objetos com dono e o vMCP público órfão', async () => {
    eduUuid = (await createUser({ username: 'edu', email: 'edu@exemplo.dev', name: 'Edu', role: 'editor' })).uuid;
    melUuid = (await createUser({ username: 'mel', email: 'mel@exemplo.dev', name: 'Mel', role: 'membro' })).uuid;
    // Ana começa editora: é assim que uma conta chega a admin com concessões.
    anaUuid = (await createUser({ username: 'ana', email: 'ana@exemplo.dev', name: 'Ana', role: 'editor' })).uuid;
    edu.userUuid = eduUuid;
    ana.userUuid = anaUuid;

    await createSkill({ name: 'Órfã do token', slug: 'orfa-token', skillMd: '# token', tags: ['x'] }, SOURCE, TOKEN_ACTOR);
    await createSkill({ name: 'Órfã do bootstrap', slug: 'orfa-bootstrap', skillMd: '# boot' }, SOURCE, BOOTSTRAP_ACTOR);
    await createSkill({ name: 'Órfã sem ator', slug: 'orfa-sem-ator', skillMd: '# nada' }, SOURCE);
    await createSkill({ name: 'Do Edu', slug: 'do-edu', skillMd: '# edu' }, SOURCE, edu);

    await createCatalog({ name: 'Órfão', slug: 'orfao', ownerUserUuid: null }, SOURCE, TOKEN_ACTOR);
    await createCatalog({ name: 'Do Edu', slug: 'catalogo-do-edu', ownerUserUuid: eduUuid }, SOURCE, edu);

    // O vMCP padrão nasce órfão de propósito (`docs/09`, decisão 6).
    publicMcpUuid = (
      await createVirtualMcp({ name: 'Public', slug: 'public', isOpen: true, ownerUserUuid: null }, SOURCE, BOOTSTRAP_ACTOR)
    ).uuid;
    await setDefaultVirtualMcp(publicMcpUuid, SOURCE, BOOTSTRAP_ACTOR);
    eduMcpUuid = (
      await createVirtualMcp({ name: 'Do Edu', slug: 'mcp-do-edu', ownerUserUuid: eduUuid }, SOURCE, edu)
    ).uuid;

    // Concessões de Ana num órfão de cada tipo e numa skill com dono; a de
    // Mel num órfão fica até o fim.
    await setSkillGrant('orfa-token', anaUuid, 'edit', SOURCE, TOKEN_ACTOR);
    await setSkillGrant('orfa-token', melUuid, 'view', SOURCE, TOKEN_ACTOR);
    await setSkillGrant('do-edu', anaUuid, 'view', SOURCE, edu);
    await setCatalogGrant('orfao', anaUuid, 'manage', SOURCE, TOKEN_ACTOR);
    await setVirtualMcpGrant('public', anaUuid, 'manage', SOURCE, TOKEN_ACTOR);

    for (const slug of ORPHAN_SKILLS) expect(await ownerOf('skills', slug)).toBeNull();
    expect(await ownerOf('skills', 'do-edu')).toBe(eduUuid);
    expect(await ownerOf('catalogs', 'orfao')).toBeNull();
    expect(await ownerOf('virtual_mcps', 'public')).toBeNull();
  });

  it('sem admin nenhum: membro, editor, uuid torto e conta inexistente não agem nem gravam', async () => {
    const before = await auditCount();

    expect(await adoptOrphans(melUuid, SOURCE, { userUuid: melUuid, label: 'mel' })).toEqual(NOT_ADOPTED);
    expect(await adoptOrphans(eduUuid, SOURCE, edu)).toEqual(NOT_ADOPTED);
    expect(await adoptOrphans(anaUuid, SOURCE, ana)).toEqual(NOT_ADOPTED);
    for (const torto of ['torto', '', '00000000-0000-0000-0000-000000000000', 42, null, undefined]) {
      await expect(adoptOrphans(torto as never, SOURCE, ana)).resolves.toEqual(NOT_ADOPTED);
    }

    expect(await auditCount()).toBe(before);
    for (const slug of ORPHAN_SKILLS) expect(await ownerOf('skills', slug)).toBeNull();
    expect(await ownerOf('catalogs', 'orfao')).toBeNull();
    expect((await listSkillGrants(await skillUuid('orfa-token'))).map((g) => g.username)).toEqual([
      'ana',
      'mel',
    ]);
  });

  it('uma conta admin desativada não age, nem sendo a única admin', async () => {
    inaUuid = (await createUser({ username: 'ina', email: 'ina@exemplo.dev', name: 'Ina', role: 'admin' })).uuid;
    await updateUser(inaUuid, { isActive: false });
    const before = await auditCount();

    expect(await adoptOrphans(inaUuid, SOURCE, { userUuid: inaUuid, label: 'ina' })).toEqual(NOT_ADOPTED);

    expect(await auditCount()).toBe(before);
    expect(await ownerOf('skills', 'orfa-token')).toBeNull();
  });

  it('com duas contas admin ativas, nenhuma das duas age', async () => {
    await updateUser(anaUuid, { role: 'admin' });
    biaUuid = (await createUser({ username: 'bia', email: 'bia@exemplo.dev', name: 'Bia', role: 'admin' })).uuid;
    const before = await auditCount();

    expect(await adoptOrphans(anaUuid, SOURCE, ana)).toEqual(NOT_ADOPTED);
    expect(await adoptOrphans(biaUuid, SOURCE, { userUuid: biaUuid, label: 'bia' })).toEqual(NOT_ADOPTED);

    expect(await auditCount()).toBe(before);
    for (const slug of ORPHAN_SKILLS) expect(await ownerOf('skills', slug)).toBeNull();
    expect(await ownerOf('catalogs', 'orfao')).toBeNull();
  });

  it('a única admin ativa (a outra desativada) adota skills e catálogos órfãos, e só eles', async () => {
    await updateUser(biaUuid, { isActive: false });
    // Membro continua sem agir, mesmo havendo uma admin solitária.
    expect(await adoptOrphans(melUuid, SOURCE, { userUuid: melUuid, label: 'mel' })).toEqual(NOT_ADOPTED);

    // Um passado fixo e a pendência de RAG limpa: qualquer toque aparece.
    await raw.query(`UPDATE skills SET updated_at = '2020-01-01T00:00:00Z', rag_stale = false`);
    await raw.query(`UPDATE catalogs SET updated_at = '2020-01-01T00:00:00Z'`);
    await raw.query(`UPDATE virtual_mcps SET updated_at = '2020-01-01T00:00:00Z'`);
    const snapshot = await untouchable();
    const before = await auditCount();

    expect(await adoptOrphans(anaUuid, SOURCE, ana)).toEqual({ adopted: true, skills: 3, catalogs: 1 });

    // Os órfãos são de Ana; quem tinha dono continua com ele; os vMCPs ficam.
    for (const slug of ORPHAN_SKILLS) expect(await ownerOf('skills', slug)).toBe(anaUuid);
    expect(await ownerOf('skills', 'do-edu')).toBe(eduUuid);
    expect(await ownerOf('catalogs', 'orfao')).toBe(anaUuid);
    expect(await ownerOf('catalogs', 'catalogo-do-edu')).toBe(eduUuid);
    expect(await ownerOf('virtual_mcps', 'public')).toBeNull();
    expect(await ownerOf('virtual_mcps', 'mcp-do-edu')).toBe(eduUuid);

    // Adotar não muda o objeto: nem `updated_at`, nem a pendência de RAG, nem o vetor de busca.
    expect(await untouchable()).toEqual(snapshot);

    // A concessão de Ana some só onde ela virou dona; a de Mel fica, e a do vMCP também.
    expect((await listSkillGrants(await skillUuid('orfa-token'))).map((g) => g.username)).toEqual(['mel']);
    expect((await listSkillGrants(await skillUuid('do-edu'))).map((g) => `${g.username}:${g.level}`)).toEqual([
      'ana:view',
    ]);
    const orfao = await getCatalog('orfao');
    expect(await listCatalogGrants(orfao!.uuid)).toEqual([]);
    expect((await listVirtualMcpGrants(publicMcpUuid)).map((g) => g.username)).toEqual(['ana']);
    expect(await listVirtualMcpGrants(eduMcpUuid)).toEqual([]);

    // A leitura já mostra a dona.
    const summary = await getSkillSummary('orfa-token', { viewer: { role: 'admin', userUuid: anaUuid } });
    expect(summary?.ownerUsername).toBe('ana');
    expect(summary?.access).toBe('owner');
    expect(orfao?.ownerUsername).toBe('ana');

    // Uma linha por objeto, no formato de uma transferência: skills por slug, depois o catálogo.
    expect(await auditCount()).toBe(before + 4);
    const skillLine = (slug: string, uuid: string) => ({
      skill_uuid: uuid,
      skill_slug: slug,
      file_path: null,
      action: 'update',
      source: 'web-admin',
      previous_content: null,
      actor_user_uuid: anaUuid,
      actor_label: 'ana',
      target_label: 'ana',
    });
    expect(await lastAudit(4)).toEqual([
      skillLine('orfa-bootstrap', await skillUuid('orfa-bootstrap')),
      skillLine('orfa-sem-ator', await skillUuid('orfa-sem-ator')),
      skillLine('orfa-token', await skillUuid('orfa-token')),
      {
        skill_uuid: null,
        skill_slug: null,
        file_path: null,
        action: 'catalog.update',
        source: 'web-admin',
        previous_content: null,
        actor_user_uuid: anaUuid,
        actor_label: 'ana',
        target_label: 'orfao ana',
      },
    ]);
    // E a trilha paginada acha as mesmas linhas pelos filtros de sempre.
    expect((await listAuditPage({ actor: 'ana' })).total).toBe(4);
    expect((await listAuditPage({ action: 'catalog.update', q: 'orfao ana' })).total).toBe(1);

    // O `q` é **literal**: `%` casava a trilha inteira e `_` qualquer
    // caractere. O pior caso de LIKE também deixa de casar tudo.
    expect((await listAuditPage({ q: '%' })).total).toBe(0);
    expect((await listAuditPage({ q: 'orfao_ana' })).total).toBe(0);
    expect((await listAuditPage({ q: '%_'.repeat(60) })).total).toBe(0);
  });

  it('a segunda chamada não adota nem audita nada', async () => {
    const snapshot = await untouchable();
    const before = await auditCount();

    expect(await adoptOrphans(anaUuid, SOURCE, ana)).toEqual({ adopted: true, skills: 0, catalogs: 0 });

    expect(await auditCount()).toBe(before);
    expect(await untouchable()).toEqual(snapshot);
    for (const slug of ORPHAN_SKILLS) expect(await ownerOf('skills', slug)).toBe(anaUuid);
  });

  it('um órfão novo é adotado na chamada seguinte, e chamadas simultâneas não auditam em dobro', async () => {
    await createSkill({ name: 'Órfã nova', slug: 'orfa-nova', skillMd: '# nova' }, SOURCE, TOKEN_ACTOR);
    await createCatalog({ name: 'Órfão novo', slug: 'orfao-novo', ownerUserUuid: null }, SOURCE, TOKEN_ACTOR);
    const before = await auditCount();

    // Três logins ao mesmo tempo: o advisory lock enfileira, e só um acha os órfãos.
    const results = await Promise.all([
      adoptOrphans(anaUuid, SOURCE, ana),
      adoptOrphans(anaUuid, 'mcp-admin', ana),
      adoptOrphans(anaUuid, SOURCE, ana),
    ]);
    expect(results.every((r) => r.adopted)).toBe(true);
    expect(results.reduce((sum, r) => sum + r.skills, 0)).toBe(1);
    expect(results.reduce((sum, r) => sum + r.catalogs, 0)).toBe(1);

    expect(await auditCount()).toBe(before + 2);
    expect(await ownerOf('skills', 'orfa-nova')).toBe(anaUuid);
    expect(await ownerOf('catalogs', 'orfao-novo')).toBe(anaUuid);
  });

  it('outra admin reativada trava a adoção; rebaixada, destrava — com o ator que o app passar', async () => {
    await updateUser(biaUuid, { isActive: true });
    await createSkill({ name: 'Órfã tardia', slug: 'orfa-tardia', skillMd: '# tardia' }, SOURCE, TOKEN_ACTOR);
    const before = await auditCount();

    expect(await adoptOrphans(anaUuid, SOURCE, ana)).toEqual(NOT_ADOPTED);
    expect(await adoptOrphans(biaUuid, SOURCE, { userUuid: biaUuid, label: 'bia' })).toEqual(NOT_ADOPTED);
    expect(await auditCount()).toBe(before);
    expect(await ownerOf('skills', 'orfa-tardia')).toBeNull();

    // Bia vira editora: Ana volta a ser a única admin ativa. O ator aqui é o
    // do bootstrap — é o que o `/api/setup` pode passar.
    await updateUser(biaUuid, { role: 'editor' });
    expect(await adoptOrphans(anaUuid, SOURCE, BOOTSTRAP_ACTOR)).toEqual({ adopted: true, skills: 1, catalogs: 0 });
    expect(await ownerOf('skills', 'orfa-tardia')).toBe(anaUuid);
    expect(await lastAudit(1)).toEqual([
      {
        skill_uuid: await skillUuid('orfa-tardia'),
        skill_slug: 'orfa-tardia',
        file_path: null,
        action: 'update',
        source: 'web-admin',
        previous_content: null,
        actor_user_uuid: null,
        actor_label: 'bootstrap',
        target_label: 'ana',
      },
    ]);

    // A própria Ana desativada: não há admin ativa, nada acontece.
    await createSkill({ name: 'Órfã final', slug: 'orfa-final', skillMd: '# final' }, SOURCE, TOKEN_ACTOR);
    await updateUser(anaUuid, { isActive: false });
    expect(await adoptOrphans(anaUuid, SOURCE, ana)).toEqual(NOT_ADOPTED);
    expect(await ownerOf('skills', 'orfa-final')).toBeNull();
  });
});
