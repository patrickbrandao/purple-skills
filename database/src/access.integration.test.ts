/**
 * Teste de integração do acesso granular (`docs/12-acesso-granular.md`,
 * `schema/017-acesso-granular.sql`) — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/access.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations, schemaDir } from './migrate.js';
import { AppError } from './errors.js';
import {
  createCatalog,
  createSkill,
  createUser,
  createVirtualMcp,
  deleteSkill,
  deleteVirtualMcp,
  getCatalog,
  getCatalogByUuid,
  getPublicCatalog,
  getSkillDetail,
  getSkillSummary,
  getUserByUuid,
  getVirtualMcp,
  linkCatalog,
  linkSkill,
  listAudit,
  listAuditPage,
  listCatalogGrants,
  listCatalogs,
  listPublicCatalogs,
  listSkillGrants,
  listSkills,
  listTags,
  listVirtualMcpGrants,
  listVirtualMcps,
  lookupUsers,
  removeCatalogGrant,
  removeSkillGrant,
  removeVirtualMcpGrant,
  saveProfile,
  setCatalogGrant,
  setCatalogSkills,
  setSkillGrant,
  setVirtualMcpGrant,
  stats,
  unlinkCatalog,
  updateCatalog,
  updateSkill,
  updateSkillWithContent,
  updateUser,
  updateVirtualMcp,
  type Viewer,
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

let raw: pg.Client;
let legadoUuid = '';
let anaUuid = '';
let brunoUuid = '';
let carlaUuid = '';
let doraUuid = '';
let evaUuid = '';
let abertoUuid = '';
let fechadoUuid = '';
let pubUuid = '';
let privUuid = '';

/** Os viewers do cenário: preenchidos depois das contas existirem. */
const viewer = {
  ana: { role: 'admin', userUuid: '' } as Viewer,
  bruno: { role: 'editor', userUuid: '' } as Viewer,
  carla: { role: 'membro', userUuid: '' } as Viewer,
  eva: { role: 'editor', userUuid: '' } as Viewer,
};
// O `label` do ator é o **username** desde o `033` (`docs/19` decisão 7): é o
// que o painel passa (`actorOf`, em `apps/admin/src/auth.ts`) e é o que fica
// congelado em `audit_log.actor_label`, que nunca é podada.
const ana = { userUuid: '', label: 'ana' };
const bruno = { userUuid: '', label: 'bruno' };
const eva = { userUuid: '', label: 'eva' };

/**
 * Aplica `schema/*.sql` até o número dado, como o runner faria numa base
 * daquela época — inclusive registrando em `schema_migrations`.
 */
async function applyUpTo(client: pg.Client, last: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = readdirSync(schemaDir())
    .filter((file) => file.endsWith('.sql') && file.slice(0, 3) <= last)
    .sort();
  for (const file of files) {
    await client.query('BEGIN');
    await client.query(readFileSync(join(schemaDir(), file), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
  }
}

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

/** Os slugs que uma leitura devolve, em ordem alfabética — a ordem da lista não importa aqui. */
async function slugsSeenBy(options: Parameters<typeof listSkills>[0]): Promise<string[]> {
  const page = await listSkills({ ...options, limit: 100 });
  expect(page.total).toBe(page.items.length);
  return page.items.map((s) => s.slug).sort();
}

async function skillOwner(slug: string): Promise<string | null> {
  const { rows } = await raw.query<{ owner_user_uuid: string | null }>(
    'SELECT owner_user_uuid FROM skills WHERE slug = $1',
    [slug],
  );
  return rows[0]?.owner_user_uuid ?? null;
}

/**
 * Espera o UPDATE de uma skill parar na trava da linha. É assim que o teste de
 * concorrência envelhece a foto que a chamada já leu, sem `sleep` fixo: a outra
 * sessão segura a linha, e só depois de a escrita estar de fato esperando é que
 * o COMMIT acontece.
 */
async function esperaUpdateDeSkillTravado(timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await raw.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND wait_event = 'transactionid'
          AND query LIKE '%UPDATE skills SET%'`,
    );
    if (rows.length > 0) return;
    if (Date.now() > deadline) throw new Error('o UPDATE da skill não chegou a esperar a trava');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const TOOLS = { asSkill: true, asPrompt: false, asResource: false };

describe.skipIf(!url)('acesso granular: dono, concessões, público e o que cada conta vê', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    // Uma base parada no `016`: um leitor e duas skills, uma criada por ele
    // e outra por ninguém (bootstrap). É o que o `017` precisa migrar.
    await applyUpTo(raw, '016');
    legadoUuid = (
      await raw.query<{ uuid: string }>(
        `INSERT INTO users (email, name, role) VALUES ('legado@exemplo.dev', 'Legado', 'leitor')
         RETURNING uuid`,
      )
    ).rows[0]!.uuid;
    await raw.query(
      `INSERT INTO skills (slug, name, created_by_user_uuid)
       VALUES ('herdada', 'Herdada', $1), ('sem-criador', 'Sem criador', NULL)`,
      [legadoUuid],
    );

    // Tudo o que a pasta traz do `017` em diante, lido dela — como a suíte de
    // `settings` faz: uma lista escrita à mão quebra a cada migration nova, de
    // quem quer que seja.
    const doDezesseteEmDiante = readdirSync(schemaDir())
      .filter((file) => file.endsWith('.sql') && file.slice(0, 3) >= '017')
      .sort();
    expect(doDezesseteEmDiante.slice(0, 2)).toEqual(['017-acesso-granular.sql', '018-acessos-por-skill.sql']);
    expect(await runMigrations(url!)).toEqual(doDezesseteEmDiante);
    // As queries resolvem a conexão por `getDb()`, que lê o ambiente na
    // primeira chamada — ainda não houve nenhuma até aqui.
    process.env.DATABASE_URL = url;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('o 017 dá dono a quem criou, deixa órfã a que não tem criador e renomeia o papel', async () => {
    expect(await skillOwner('herdada')).toBe(legadoUuid);
    expect(await skillOwner('sem-criador')).toBeNull();

    const { rows } = await raw.query<{ role: string }>('SELECT role FROM users WHERE uuid = $1', [
      legadoUuid,
    ]);
    expect(rows[0]?.role).toBe('membro');

    // O `033` derivou o username do **nome** da conta legada, não da parte
    // antes do `@` do e-mail: `Legado` → `legado`, e `legado@exemplo.dev`
    // continua só no e-mail. O livro de usernames nasceu com a mesma linha.
    const legada = await getUserByUuid(legadoUuid);
    expect(legada?.username).toBe('legado');
    expect(
      (await raw.query('SELECT user_uuid, released_at FROM usernames WHERE username_lower = $1', ['legado'])).rows,
    ).toEqual([{ user_uuid: legadoUuid, released_at: null }]);

    // O CHECK novo recusa o nome antigo e aceita o novo.
    await expect(
      raw.query(
        `INSERT INTO users (username, email, name, role) VALUES ('x', 'x@exemplo.dev', 'X', 'leitor')`,
      ),
    ).rejects.toThrow(/users_role_check/);
    expect((await capture(createUser({ username: 'conta-y', email: 'y@exemplo.dev', name: 'Y', role: 'leitor' as never }))).status).toBe(400);

    // Nada nasce público; a skill migrada continua invisível no site.
    expect((await listSkills({ visibility: 'all' })).items.every((s) => !s.isPublic)).toBe(true);
    expect((await listSkills({})).total).toBe(0);
  });

  it('monta o cenário: cinco contas, um servidor aberto e um fechado, um catálogo público e um privado', async () => {
    anaUuid = (await createUser({ username: 'ana', email: 'ana@exemplo.dev', name: 'Ana', role: 'admin' })).uuid;
    brunoUuid = (await createUser({ username: 'bruno', email: 'bruno@exemplo.dev', name: 'Bruno', role: 'editor' })).uuid;
    carlaUuid = (await createUser({ username: 'carla', email: 'carla@exemplo.dev', name: 'Carla', role: 'membro' })).uuid;
    doraUuid = (await createUser({ username: 'dora', email: 'dora@exemplo.dev', name: 'Dora', role: 'membro' })).uuid;
    evaUuid = (await createUser({ username: 'eva', email: 'eva@exemplo.dev', name: 'Eva', role: 'editor' })).uuid;
    await updateUser(doraUuid, { isActive: false });

    viewer.ana.userUuid = anaUuid;
    viewer.bruno.userUuid = brunoUuid;
    viewer.carla.userUuid = carlaUuid;
    viewer.eva.userUuid = evaUuid;
    ana.userUuid = anaUuid;
    bruno.userUuid = brunoUuid;
    eva.userUuid = evaUuid;

    // Quem cria vira dono; sem ator, órfã.
    const minha = await createSkill(
      { name: 'Minha', slug: 'minha', skillMd: '# minha', tags: ['t-bruno'] },
      SOURCE,
      bruno,
    );
    expect(minha.ownerUserUuid).toBe(brunoUuid);
    expect(minha.ownerUsername).toBe('bruno');
    expect(minha.isPublic).toBe(false);
    expect(minha.access).toBe('owner');
    expect(minha.grants).toEqual([]);

    for (const slug of [
      'da-eva',
      'no-aberto',
      'no-catalogo-publico',
      'no-mcp-concedido',
      'no-catalogo-concedido',
      'escondida',
    ]) {
      await createSkill(
        { name: slug.replace(/-/g, ' '), slug, skillMd: `# ${slug}`, tags: ['t-eva'] },
        SOURCE,
        eva,
      );
    }
    const publica = await createSkill(
      { name: 'Publica', slug: 'publica', skillMd: '# publica', isPublic: true, tags: ['comum'] },
      SOURCE,
      eva,
    );
    expect(publica.isPublic).toBe(true);
    expect((await capture(createSkill({ name: 'X', skillMd: '# x', isPublic: 'sim' as never }, SOURCE))).status).toBe(400);

    abertoUuid = (
      await createVirtualMcp({ name: 'Aberto', slug: 'aberto', isOpen: true, ownerUserUuid: evaUuid }, SOURCE, eva)
    ).uuid;
    fechadoUuid = (
      await createVirtualMcp({ name: 'Fechado', slug: 'fechado', ownerUserUuid: evaUuid }, SOURCE, eva)
    ).uuid;
    await linkSkill('no-aberto', abertoUuid, TOOLS, SOURCE, eva);
    await linkSkill('publica', abertoUuid, TOOLS, SOURCE, eva);
    await linkSkill('publica', fechadoUuid, TOOLS, SOURCE, eva);
    await linkSkill('no-mcp-concedido', fechadoUuid, TOOLS, SOURCE, eva);

    const pub = await createCatalog(
      { name: 'Catálogo público', slug: 'pub', isPublic: true, ownerUserUuid: evaUuid },
      SOURCE,
      eva,
    );
    pubUuid = pub.uuid;
    expect(pub.isPublic).toBe(true);
    expect(pub.access).toBe('owner');
    expect(pub.grants).toEqual([]);
    privUuid = (
      await createCatalog({ name: 'Catálogo privado', slug: 'priv', ownerUserUuid: evaUuid }, SOURCE, eva)
    ).uuid;
    expect((await getCatalog('priv'))?.isPublic).toBe(false);
    await setCatalogSkills(pubUuid, [{ slug: 'no-catalogo-publico' }], SOURCE, eva);
    await setCatalogSkills(privUuid, [{ slug: 'no-catalogo-concedido' }], SOURCE, eva);

    // As três concessões do cenário: `view` na skill, `view` no vMCP fechado
    // e `edit` no catálogo privado.
    const naSkill = await setSkillGrant('da-eva', carlaUuid, 'view', SOURCE, eva);
    expect(naSkill).toMatchObject({
      userUuid: carlaUuid,
      username: 'carla',
      name: 'Carla',
      role: 'membro',
      isActive: true,
      level: 'view',
      grantedByUserUuid: evaUuid,
      grantedByUsername: 'eva',
    });
    expect(naSkill.createdAt).toMatch(/^\d{4}-/);
    await setVirtualMcpGrant('fechado', brunoUuid, 'view', SOURCE, eva);
    await setCatalogGrant('priv', brunoUuid, 'edit', SOURCE, eva);
  });

  it('cada conta enxerga o que é dela, o que lhe foi concedido e o público — e nada mais', async () => {
    // Bruno: a dele, as públicas (flag, vMCP aberto, catálogo público) e as
    // que chegam pelos contêineres concedidos.
    expect(await slugsSeenBy({ viewer: viewer.bruno })).toEqual([
      'minha',
      'no-aberto',
      'no-catalogo-concedido',
      'no-catalogo-publico',
      'no-mcp-concedido',
      'publica',
    ]);
    // Carla: só a concessão direta e o público.
    expect(await slugsSeenBy({ viewer: viewer.carla })).toEqual([
      'da-eva',
      'no-aberto',
      'no-catalogo-publico',
      'publica',
    ]);
    // Eva: tudo o que é dela, e mais nada — nem a do Bruno, nem as migradas.
    expect(await slugsSeenBy({ viewer: viewer.eva })).toEqual([
      'da-eva',
      'escondida',
      'no-aberto',
      'no-catalogo-concedido',
      'no-catalogo-publico',
      'no-mcp-concedido',
      'publica',
    ]);
    // Admin por papel = `'all'`: inclusive a órfã.
    const tudo = await slugsSeenBy({ viewer: viewer.ana });
    expect(tudo).toHaveLength(10);
    expect(tudo).toEqual(await slugsSeenBy({ visibility: 'all' }));
    // Conta sem uuid que não é admin (não é um caso do painel) vê só o público.
    expect(await slugsSeenBy({ viewer: { role: 'membro', userUuid: null } })).toEqual([
      'no-aberto',
      'no-catalogo-publico',
      'publica',
    ]);
    // O site: ligada e (pública, ou em vMCP aberto, ou em catálogo público).
    expect(await slugsSeenBy({})).toEqual(['no-aberto', 'no-catalogo-publico', 'publica']);
    expect((await stats()).openSkills).toBe(3);

    // Desligada continua visível a quem a vê; some do site.
    await updateSkill('publica', { isActive: false }, SOURCE, eva);
    expect(await slugsSeenBy({})).toEqual(['no-aberto', 'no-catalogo-publico']);
    expect(await slugsSeenBy({ viewer: viewer.carla })).toContain('publica');
    await updateSkill('publica', { isActive: true }, SOURCE, eva);

    // O detalhe e as tags seguem a mesma cláusula.
    expect(await getSkillSummary('escondida', { viewer: viewer.bruno })).toBeNull();
    expect(await getSkillDetail('escondida', { viewer: viewer.eva })).not.toBeNull();
    expect((await listTags({ viewer: viewer.carla })).map((t) => t.name)).toEqual(['t-eva', 'comum']);
    expect((await listTags({ viewer: viewer.bruno })).find((t) => t.name === 't-eva')?.count).toBe(4);
    // `viewer` com papel inválido é 400, não 500.
    expect((await capture(listSkills({ viewer: { role: 'root' as never, userUuid: null } }))).status).toBe(400);
  });

  it('access por linha: dono, nível da concessão, view por público ou contêiner, nulo no site', async () => {
    const porSlug = async (v: Viewer) =>
      new Map((await listSkills({ viewer: v, limit: 100 })).items.map((s) => [s.slug, s.access]));

    const doBruno = await porSlug(viewer.bruno);
    expect(doBruno.get('minha')).toBe('owner');
    expect(doBruno.get('publica')).toBe('view');
    expect(doBruno.get('no-mcp-concedido')).toBe('view');
    expect(doBruno.get('no-catalogo-concedido')).toBe('view');

    expect((await porSlug(viewer.carla)).get('da-eva')).toBe('view');
    expect([...(await porSlug(viewer.ana)).values()].every((a) => a === 'owner')).toBe(true);
    expect([...(await porSlug(viewer.eva)).values()].every((a) => a === 'owner')).toBe(true);

    // Sem conta: `'all'` é o token global (dono de tudo); o site não tem acesso.
    expect((await getSkillSummary('publica', { visibility: 'all' }))?.access).toBe('owner');
    expect((await getSkillSummary('publica'))?.access).toBeNull();

    // O nível da concessão direta prevalece sobre o `view` do contêiner.
    await setSkillGrant('no-mcp-concedido', brunoUuid, 'edit', SOURCE, eva);
    expect((await getSkillSummary('no-mcp-concedido', { viewer: viewer.bruno }))?.access).toBe('edit');
  });

  it('mcps e catalogs da skill mostram só os contêineres que a conta vê', async () => {
    // `publica` está no aberto e no fechado: Carla vê só o aberto, Bruno (com
    // concessão no fechado) vê os dois, o site só o aberto, o admin todos.
    const mcpsDe = async (slug: string, options: Parameters<typeof getSkillSummary>[1]) =>
      (await getSkillSummary(slug, options))?.mcps.map((m) => m.slug).sort();
    expect(await mcpsDe('publica', { viewer: viewer.carla })).toEqual(['aberto']);
    expect(await mcpsDe('publica', { viewer: viewer.bruno })).toEqual(['aberto', 'fechado']);
    expect(await mcpsDe('publica', {})).toEqual(['aberto']);
    expect(await mcpsDe('publica', { viewer: viewer.ana })).toEqual(['aberto', 'fechado']);
    expect(await mcpsDe('no-mcp-concedido', { viewer: viewer.bruno })).toEqual(['fechado']);

    const catalogsDe = async (slug: string, options: Parameters<typeof getSkillSummary>[1]) =>
      (await getSkillSummary(slug, options))?.catalogs.map((c) => c.slug);
    expect(await catalogsDe('no-catalogo-concedido', { viewer: viewer.bruno })).toEqual(['priv']);
    expect(await catalogsDe('no-catalogo-publico', { viewer: viewer.carla })).toEqual(['pub']);
    // O site não recebe a lista de catálogos, mesmo sendo público.
    expect(await catalogsDe('no-catalogo-publico', {})).toEqual([]);
    // Um catálogo público desligado deixa de ser visto por quem só o vê por
    // ser público — e, com ele, a skill que só chegava por ali.
    await updateCatalog(pubUuid, { isActive: false }, SOURCE, eva);
    expect(await getSkillSummary('no-catalogo-publico', { viewer: viewer.carla })).toBeNull();
    expect(await catalogsDe('no-catalogo-publico', { viewer: viewer.eva })).toEqual(['pub']);
    await updateCatalog(pubUuid, { isActive: true }, SOURCE, eva);
  });

  it('scope filtra entre meus, compartilhados comigo e públicos, também para o admin', async () => {
    expect(await slugsSeenBy({ viewer: viewer.bruno, scope: 'mine' })).toEqual(['minha']);
    // `publica` está no vMCP fechado concedido ao Bruno: chega por contêiner
    // concedido, então é "compartilhada" além de pública — os filtros se
    // sobrepõem de propósito.
    expect(await slugsSeenBy({ viewer: viewer.bruno, scope: 'shared' })).toEqual([
      'no-catalogo-concedido',
      'no-mcp-concedido',
      'publica',
    ]);
    expect(await slugsSeenBy({ viewer: viewer.bruno, scope: 'public' })).toEqual([
      'no-aberto',
      'no-catalogo-publico',
      'publica',
    ]);
    // Uma skill pública que também é minha aparece nos dois filtros.
    expect(await slugsSeenBy({ viewer: viewer.eva, scope: 'mine' })).toContain('publica');
    expect(await slugsSeenBy({ viewer: viewer.eva, scope: 'public' })).toContain('publica');
    expect(await slugsSeenBy({ viewer: viewer.eva, scope: 'shared' })).toEqual([]);
    // O admin também tem "meus": Ana não é dona de nada.
    expect(await slugsSeenBy({ viewer: viewer.ana, scope: 'mine' })).toEqual([]);
    expect((await slugsSeenBy({ viewer: viewer.ana, scope: 'public' })).length).toBe(3);
    // Sem `viewer`, ou com valor fora da lista, é 400.
    expect((await capture(listSkills({ scope: 'mine' }))).status).toBe(400);
    expect((await capture(listSkills({ viewer: viewer.ana, scope: 'tudo' as never }))).status).toBe(400);
  });

  it('catálogos e vMCPs: visibilidade, access e scope por viewer, detalhe nulo fora disso', async () => {
    const catalogosDe = async (v: Viewer, scope?: 'mine' | 'shared' | 'public') =>
      (await listCatalogs({ viewer: v, scope })).map((c) => [c.slug, c.access]);
    expect(await catalogosDe(viewer.bruno)).toEqual([
      ['priv', 'edit'],
      ['pub', 'view'],
    ]);
    expect(await catalogosDe(viewer.carla)).toEqual([['pub', 'view']]);
    expect(await catalogosDe(viewer.eva)).toEqual([
      ['priv', 'owner'],
      ['pub', 'owner'],
    ]);
    expect(await catalogosDe(viewer.ana)).toEqual([
      ['priv', 'owner'],
      ['pub', 'owner'],
    ]);
    expect(await catalogosDe(viewer.bruno, 'mine')).toEqual([]);
    expect(await catalogosDe(viewer.bruno, 'shared')).toEqual([['priv', 'edit']]);
    expect(await catalogosDe(viewer.bruno, 'public')).toEqual([['pub', 'view']]);
    // Sem `viewer` é a visão do admin, e o filtro por dono continua valendo.
    expect((await listCatalogs()).every((c) => c.access === 'owner')).toBe(true);
    expect((await listCatalogs({ ownerUserUuid: evaUuid })).map((c) => c.slug)).toEqual(['priv', 'pub']);
    expect(await getCatalog('priv', { viewer: viewer.carla })).toBeNull();
    expect((await getCatalog('priv', { viewer: viewer.bruno }))?.access).toBe('edit');
    expect((await getCatalog('priv'))?.grants.map((g) => [g.username, g.level])).toEqual([
      ['bruno', 'edit'],
    ]);

    const mcpsDe = async (v: Viewer, scope?: 'mine' | 'shared' | 'public') =>
      (await listVirtualMcps({ viewer: v, scope })).map((m) => [m.slug, m.access]);
    expect(await mcpsDe(viewer.bruno)).toEqual([
      ['aberto', 'view'],
      ['fechado', 'view'],
    ]);
    expect(await mcpsDe(viewer.carla)).toEqual([['aberto', 'view']]);
    expect(await mcpsDe(viewer.eva)).toEqual([
      ['aberto', 'owner'],
      ['fechado', 'owner'],
    ]);
    expect(await mcpsDe(viewer.bruno, 'shared')).toEqual([['fechado', 'view']]);
    expect(await mcpsDe(viewer.bruno, 'public')).toEqual([['aberto', 'view']]);
    expect(await mcpsDe(viewer.ana, 'mine')).toEqual([]);
    expect(await getVirtualMcp('fechado', { viewer: viewer.carla })).toBeNull();
    expect((await getVirtualMcp('fechado', { viewer: viewer.bruno }))?.access).toBe('view');
    expect((await getVirtualMcp('fechado'))?.grants.map((g) => g.username)).toEqual(['bruno']);
    // Um vMCP aberto mas desligado só continua visível a quem o vê por dono ou concessão.
    await updateVirtualMcp(abertoUuid, { isActive: false }, SOURCE, eva);
    expect(await mcpsDe(viewer.carla)).toEqual([]);
    expect(await mcpsDe(viewer.eva)).toHaveLength(2);
    await updateVirtualMcp(abertoUuid, { isActive: true }, SOURCE, eva);
  });

  it('conceder é upsert e recusa nível torto, conta torta/inativa, o dono e o admin', async () => {
    const primeira = await setSkillGrant('escondida', brunoUuid, 'view', SOURCE, eva);
    expect(primeira.level).toBe('view');
    expect((await getSkillSummary('escondida', { viewer: viewer.bruno }))?.access).toBe('view');

    // Mudar o nível reescreve a linha — inclusive quem concedeu.
    const segunda = await setSkillGrant('escondida', brunoUuid, 'manage', SOURCE, ana);
    expect(segunda.level).toBe('manage');
    expect(segunda.grantedByUserUuid).toBe(anaUuid);
    expect(await listSkillGrants((await getSkillSummary('escondida', { visibility: 'all' }))!.uuid)).toHaveLength(1);
    expect((await getSkillSummary('escondida', { viewer: viewer.bruno }))?.access).toBe('manage');
    expect(await slugsSeenBy({ viewer: viewer.bruno, scope: 'shared' })).toContain('escondida');

    // Cada chamada nasce dentro do `capture`, para uma rejeição não ficar
    // pendurada enquanto a anterior é conferida.
    const recusas: [() => Promise<unknown>, number][] = [
      [() => setSkillGrant('escondida', carlaUuid, 'root' as never, SOURCE, eva), 400],
      [() => setSkillGrant('escondida', 'torto', 'view', SOURCE, eva), 400],
      [() => setSkillGrant('escondida', '00000000-0000-0000-0000-000000000000', 'view', SOURCE, eva), 400],
      [() => setSkillGrant('escondida', doraUuid, 'view', SOURCE, eva), 400],
      [() => setSkillGrant('escondida', anaUuid, 'view', SOURCE, eva), 400],
      [() => setSkillGrant('escondida', evaUuid, 'view', SOURCE, eva), 400],
      [() => setSkillGrant('nao-existe', carlaUuid, 'view', SOURCE, eva), 404],
      [() => setSkillGrant(' ', carlaUuid, 'view', SOURCE, eva), 400],
      [() => setCatalogGrant('priv', evaUuid, 'view', SOURCE, eva), 400],
      [() => setCatalogGrant('nao-existe', carlaUuid, 'view', SOURCE, eva), 404],
      [() => setVirtualMcpGrant('fechado', anaUuid, 'view', SOURCE, eva), 400],
      [() => setVirtualMcpGrant('nao-existe', carlaUuid, 'view', SOURCE, eva), 404],
    ];
    for (const [chamada, status] of recusas) {
      expect((await capture(chamada())).status).toBe(status);
    }
    const inativa = await capture(setSkillGrant('escondida', doraUuid, 'view', SOURCE, eva));
    expect(inativa.message).toMatch(/desativada/);
    expect((await capture(setSkillGrant('escondida', evaUuid, 'view', SOURCE, eva))).message).toMatch(/dono/);
    expect((await capture(setSkillGrant('escondida', anaUuid, 'view', SOURCE, eva))).message).toMatch(/administrador/);

    // Uma conta desativada mantém a linha, inerte; reativar devolve o acesso.
    await setSkillGrant('escondida', carlaUuid, 'view', SOURCE, eva);
    await updateUser(carlaUuid, { isActive: false });
    expect(await listSkillGrants((await getSkillSummary('escondida', { visibility: 'all' }))!.uuid)).toHaveLength(2);
    await updateUser(carlaUuid, { isActive: true });
    expect((await getSkillSummary('escondida', { viewer: viewer.carla }))?.access).toBe('view');
  });

  it('revogar apaga a linha e audita; concessão inexistente é 404', async () => {
    await removeSkillGrant('escondida', carlaUuid, SOURCE, eva);
    expect(await getSkillSummary('escondida', { viewer: viewer.carla })).toBeNull();
    expect((await capture(removeSkillGrant('escondida', carlaUuid, SOURCE, eva))).status).toBe(404);
    expect((await capture(removeSkillGrant('escondida', 'torto', SOURCE, eva))).status).toBe(404);
    expect((await capture(removeSkillGrant('nao-existe', carlaUuid, SOURCE, eva))).status).toBe(404);
    expect((await capture(removeCatalogGrant('priv', carlaUuid, SOURCE, eva))).status).toBe(404);
    expect((await capture(removeVirtualMcpGrant('fechado', carlaUuid, SOURCE, eva))).status).toBe(404);

    // Carla perde `da-eva`; o admin revogando também vale.
    await removeSkillGrant('da-eva', carlaUuid, SOURCE, ana);
    expect(await slugsSeenBy({ viewer: viewer.carla })).not.toContain('da-eva');
  });

  it('as seis ações de auditoria, com o formato do label de cada tipo', async () => {
    const trilha = await listAudit(200);

    const share = trilha.find((e) => e.action === 'skill.share' && e.targetLabel === 'carla:view' && e.skillSlug === 'da-eva');
    expect(share).toBeDefined();
    expect(share?.skillUuid).not.toBeNull();
    expect(share?.actorLabel).toBe('eva');
    expect(trilha.find((e) => e.action === 'skill.share' && e.targetLabel === 'bruno:manage')?.actorLabel).toBe('ana');

    const unshare = trilha.find((e) => e.action === 'skill.unshare' && e.skillSlug === 'da-eva');
    expect(unshare?.targetLabel).toBe('carla');
    expect(unshare?.actorLabel).toBe('ana');

    const catalogShare = trilha.find((e) => e.action === 'catalog.share');
    expect(catalogShare?.targetLabel).toBe('priv bruno:edit');
    expect(catalogShare?.skillUuid).toBeNull();
    expect(trilha.find((e) => e.action === 'mcp.share')?.targetLabel).toBe('fechado bruno:view');

    await removeCatalogGrant('priv', brunoUuid, SOURCE, eva);
    await removeVirtualMcpGrant('fechado', brunoUuid, SOURCE, eva);
    const depois = await listAudit(20);
    expect(depois.find((e) => e.action === 'catalog.unshare')?.targetLabel).toBe('priv bruno');
    expect(depois.find((e) => e.action === 'mcp.unshare')?.targetLabel).toBe('fechado bruno');
    // Sem as concessões nos contêineres, Bruno deixa de ver o que chegava por
    // elas; ficam as concessões diretas (`escondida`, `no-mcp-concedido`).
    expect(await slugsSeenBy({ viewer: viewer.bruno, scope: 'shared' })).toEqual([
      'escondida',
      'no-mcp-concedido',
    ]);
    expect(await slugsSeenBy({ viewer: viewer.bruno })).not.toContain('no-catalogo-concedido');

    // A trilha paginada aceita as seis como filtro; o CHECK recusa o que não está na lista.
    for (const action of ['skill.share', 'skill.unshare', 'catalog.share', 'catalog.unshare', 'mcp.share', 'mcp.unshare'] as const) {
      expect((await listAuditPage({ action })).total).toBeGreaterThanOrEqual(1);
    }
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source, actor_label, target_label)
         VALUES ('skill.inventada', 'web-admin', 'x', 'y')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);
  });

  it('a concessão de conta desativada aparece marcada e é revogável nos três tipos', async () => {
    // `tasks/039`. A conta desativada mantém as linhas, inertes, e reativar
    // devolve o acesso — por isso quem administra a ACL precisa **ver** que a
    // conta está desativada (`Grant.isActive`) e conseguir **revogar** antes de
    // uma reativação. O banco nunca recusou a revogação; quem a recusava era o
    // funil de e-mail dos apps, e este caso fixa o que eles passam a usar.
    await setSkillGrant('da-eva', carlaUuid, 'view', SOURCE, eva);
    await setCatalogGrant('priv', carlaUuid, 'edit', SOURCE, eva);
    await setVirtualMcpGrant('fechado', carlaUuid, 'manage', SOURCE, eva);
    const daEva = (await getSkillSummary('da-eva', { visibility: 'all' }))!.uuid;
    const marcas = async (): Promise<[string, boolean][][]> =>
      (await Promise.all([listSkillGrants(daEva), listCatalogGrants(privUuid), listVirtualMcpGrants(fechadoUuid)])).map(
        (grants) => grants.map((g): [string, boolean] => [g.username, g.isActive]),
      );
    expect(await marcas()).toEqual([
      [['carla', true]],
      [['carla', true]],
      [['carla', true]],
    ]);

    await updateUser(carlaUuid, { isActive: false });
    expect(await marcas()).toEqual([
      [['carla', false]],
      [['carla', false]],
      [['carla', false]],
    ]);
    // O detalhe, que é o que o painel lê, traz a mesma marca.
    expect((await getCatalog('priv'))?.grants.map((g) => g.isActive)).toEqual([false]);
    expect((await getVirtualMcp('fechado'))?.grants.map((g) => g.isActive)).toEqual([false]);

    // Mudar o nível é a mesma chamada de conceder (upsert), e continua recusada
    // para conta desativada: só a revogação precisa valer.
    const mudarNivel = await capture(setSkillGrant('da-eva', carlaUuid, 'edit', SOURCE, eva));
    expect(mudarNivel.status).toBe(400);
    expect(mudarNivel.message).toMatch(/desativada/);

    await removeSkillGrant('da-eva', carlaUuid, SOURCE, eva);
    await removeCatalogGrant('priv', carlaUuid, SOURCE, eva);
    await removeVirtualMcpGrant('fechado', carlaUuid, SOURCE, eva);
    expect(await marcas()).toEqual([[], [], []]);
    const trilha = await listAudit(10);
    expect(trilha.find((e) => e.action === 'skill.unshare')?.targetLabel).toBe('carla');
    expect(trilha.find((e) => e.action === 'catalog.unshare')?.targetLabel).toBe('priv carla');
    expect(trilha.find((e) => e.action === 'mcp.unshare')?.targetLabel).toBe('fechado carla');

    // Reativada, a conta não recebe de volta o que foi revogado enquanto estava fora.
    await updateUser(carlaUuid, { isActive: true });
    expect(await getSkillSummary('da-eva', { viewer: viewer.carla })).toBeNull();
    expect(await getCatalog('priv', { viewer: viewer.carla })).toBeNull();
    expect(await getVirtualMcp('fechado', { viewer: viewer.carla })).toBeNull();
  });

  it('a ficha do catálogo lista só os vMCPs que a conta vê e os membros que ela consegue abrir', async () => {
    // `tasks/010`. `getVirtualMcp('fechado', { viewer })` é `null` para quem não
    // vê o servidor, e a lista `mcps` da **skill** já era recortada; a ficha do
    // **catálogo** entregava nome, slug, uuid, estado e dono de todo servidor
    // vinculado — e um catálogo público é legível por qualquer conta logada.
    const doBruno = await createVirtualMcp({ name: 'Do Bruno', slug: 'do-bruno', ownerUserUuid: brunoUuid }, SOURCE, bruno);
    await linkCatalog(abertoUuid, pubUuid, TOOLS, SOURCE, eva);
    await linkCatalog(fechadoUuid, pubUuid, TOOLS, SOURCE, eva);
    await linkCatalog(doBruno.uuid, pubUuid, TOOLS, SOURCE, bruno);
    try {
      await fichaRecortada(doBruno.uuid);
    } finally {
      // O cenário volta ao que era mesmo se uma asserção falhar: os casos
      // seguintes contam com `pub` sem vínculo e com um membro só.
      await setCatalogSkills(pubUuid, [{ slug: 'no-catalogo-publico' }], SOURCE, eva);
      await unlinkCatalog(abertoUuid, pubUuid, SOURCE, eva);
      await unlinkCatalog(fechadoUuid, pubUuid, SOURCE, eva);
      await deleteVirtualMcp(doBruno.uuid, SOURCE, bruno);
    }
  });

  /** As asserções do caso acima, separadas para a limpeza dele ficar num `finally`. */
  async function fichaRecortada(doBrunoUuid: string): Promise<void> {
    expect((await getVirtualMcp('do-bruno', { viewer: viewer.carla }))).toBeNull();
    expect((await getVirtualMcp('do-bruno'))?.uuid).toBe(doBrunoUuid);

    const mcpsDe = async (options: Parameters<typeof getCatalog>[1]) =>
      (await getCatalog('pub', options))?.mcps.map((m) => m.slug);
    // Carla só chega ao catálogo por ele ser público: vê o servidor aberto.
    expect(await mcpsDe({ viewer: viewer.carla })).toEqual(['aberto']);
    // Bruno é dono de um dos fechados; o da Eva ele não vê…
    expect(await mcpsDe({ viewer: viewer.bruno })).toEqual(['aberto', 'do-bruno']);
    // …até receber concessão nele.
    await setVirtualMcpGrant('fechado', brunoUuid, 'view', SOURCE, eva);
    expect(await mcpsDe({ viewer: viewer.bruno })).toEqual(['aberto', 'do-bruno', 'fechado']);
    await removeVirtualMcpGrant('fechado', brunoUuid, SOURCE, eva);
    // A regra é a da lista `mcps` da skill e vale para todo `viewer` que não é
    // admin, **inclusive a dona do catálogo**: o fechado do Bruno não é dela.
    expect(await mcpsDe({ viewer: viewer.eva })).toEqual(['aberto', 'fechado']);
    // Admin e a leitura sem `viewer` (o `'all'` das escritas) veem todos.
    expect(await mcpsDe({ viewer: viewer.ana })).toEqual(['aberto', 'do-bruno', 'fechado']);
    expect(await mcpsDe({})).toEqual(['aberto', 'do-bruno', 'fechado']);
    expect((await getCatalogByUuid(pubUuid, { viewer: viewer.carla }))?.mcps.map((m) => m.slug)).toEqual(['aberto']);
    // O contador **não** é recortado: é ele que a confirmação de exclusão do
    // painel mostra ("os N servidores vinculados deixam de receber…"), e ali
    // subestimar é pior. `mcpCount - mcps.length` é o "e mais N que você não vê".
    expect((await getCatalog('pub', { viewer: viewer.carla }))?.mcpCount).toBe(3);

    // Os membros: `escondida` é privada e entra com a participação desativada.
    await setCatalogSkills(pubUuid, [{ slug: 'no-catalogo-publico' }, { slug: 'escondida', isActive: false }], SOURCE, eva);
    const membrosDe = async (options: Parameters<typeof getCatalog>[1]) =>
      (await getCatalog('pub', options))?.skills.map((s) => [s.slug, s.isActive]);
    const inteira = [
      ['escondida', false],
      ['no-catalogo-publico', true],
    ];
    // Pelo "público" só chega a participação **ativa** (`docs/12` §3.1): Carla
    // não abre `escondida`, e a ficha não lhe entrega nome, slug e descrição.
    expect(await getSkillSummary('escondida', { viewer: viewer.carla })).toBeNull();
    expect(await membrosDe({ viewer: viewer.carla })).toEqual([['no-catalogo-publico', true]]);
    // Bruno a abre por outra rota (o `manage` direto): para ele a linha aparece.
    expect((await getSkillSummary('escondida', { viewer: viewer.bruno }))?.access).toBe('manage');
    expect(await membrosDe({ viewer: viewer.bruno })).toEqual(inteira);
    // Dona, admin e a leitura sem `viewer`: a lista inteira, como sempre.
    expect(await membrosDe({ viewer: viewer.eva })).toEqual(inteira);
    expect(await membrosDe({ viewer: viewer.ana })).toEqual(inteira);
    expect(await membrosDe({})).toEqual(inteira);
    // Com concessão no catálogo, todo membro é legível (decisão 5) — e listado.
    await setCatalogGrant('pub', carlaUuid, 'view', SOURCE, eva);
    expect((await getSkillSummary('escondida', { viewer: viewer.carla }))?.access).toBe('view');
    expect(await membrosDe({ viewer: viewer.carla })).toEqual(inteira);
    await removeCatalogGrant('pub', carlaUuid, SOURCE, eva);
    expect(await membrosDe({ viewer: viewer.carla })).toEqual([['no-catalogo-publico', true]]);
    // `skillCount` também fica global, pelo mesmo motivo de `mcpCount`.
    expect((await getCatalog('pub', { viewer: viewer.carla }))?.skillCount).toBe(2);
  }

  it('transferir apaga a concessão do novo dono, recusa conta inativa ou inexistente, audita o e-mail', async () => {
    // Bruno tinha `manage` em `escondida`; vira dono e a linha some.
    const transferida = await updateSkill('escondida', { ownerUserUuid: brunoUuid }, SOURCE, eva);
    expect(transferida.ownerUserUuid).toBe(brunoUuid);
    expect(transferida.ownerUsername).toBe('bruno');
    expect(transferida.grants).toEqual([]);
    expect((await getSkillSummary('escondida', { viewer: viewer.bruno }))?.access).toBe('owner');
    expect(await getSkillSummary('escondida', { viewer: viewer.eva })).toBeNull();
    const linha = (await listAudit(10)).find((e) => e.action === 'update' && e.skillSlug === 'escondida');
    expect(linha?.targetLabel).toBe('bruno');

    expect((await capture(updateSkill('escondida', { ownerUserUuid: doraUuid }, SOURCE, bruno))).status).toBe(400);
    expect((await capture(updateSkill('escondida', { ownerUserUuid: '00000000-0000-0000-0000-000000000000' }, SOURCE, bruno))).status).toBe(400);
    expect((await capture(updateSkill('escondida', { ownerUserUuid: 'torto' }, SOURCE, bruno))).status).toBe(400);
    expect((await capture(updateSkillWithContent('escondida', { ownerUserUuid: doraUuid, skillMd: '# x' }, SOURCE, bruno))).status).toBe(400);
    // Nada mudou com as recusas — nem o dono, nem o conteúdo.
    expect(await skillOwner('escondida')).toBe(brunoUuid);
    expect((await getSkillDetail('escondida', { visibility: 'all' }))?.skillMd).toBe('# escondida');

    // `updateSkillWithContent` transfere do mesmo jeito; `null` deixa órfã sem label.
    const semDono = await updateSkillWithContent('escondida', { ownerUserUuid: null, skillMd: '# orfa' }, SOURCE, bruno);
    expect(semDono.ownerUserUuid).toBeNull();
    expect(semDono.skillMd).toBe('# orfa');
    expect(await getSkillSummary('escondida', { viewer: viewer.bruno })).toBeNull();
    expect((await listAudit(5)).find((e) => e.action === 'update' && e.filePath === null)?.targetLabel).toBeNull();

    // Catálogo e vMCP: a concessão do novo dono some, o label leva slug e e-mail.
    await setCatalogGrant('priv', brunoUuid, 'manage', SOURCE, eva);
    const catalogo = await updateCatalog(privUuid, { ownerUserUuid: brunoUuid }, SOURCE, eva);
    expect(catalogo.ownerUserUuid).toBe(brunoUuid);
    expect(catalogo.grants).toEqual([]);
    expect((await listAudit(5)).find((e) => e.action === 'catalog.update')?.targetLabel).toBe('priv bruno');
    expect((await capture(updateCatalog(privUuid, { ownerUserUuid: doraUuid }, SOURCE, bruno))).status).toBe(400);
    expect((await capture(updateCatalog(privUuid, { ownerUserUuid: 'torto' }, SOURCE, bruno))).status).toBe(400);
    expect((await getCatalog('priv'))?.ownerUserUuid).toBe(brunoUuid);

    await setVirtualMcpGrant('fechado', brunoUuid, 'edit', SOURCE, eva);
    const mcp = await updateVirtualMcp(fechadoUuid, { ownerUserUuid: brunoUuid }, SOURCE, eva);
    expect(mcp.ownerUserUuid).toBe(brunoUuid);
    expect(mcp.grants).toEqual([]);
    expect((await listAudit(5)).find((e) => e.action === 'mcp.update')?.targetLabel).toBe('fechado bruno');
    expect((await capture(updateVirtualMcp(fechadoUuid, { ownerUserUuid: doraUuid }, SOURCE, bruno))).status).toBe(400);
    expect((await getVirtualMcp('fechado'))?.ownerUserUuid).toBe(brunoUuid);
    // Devolve os dois à Eva para o resto do cenário.
    await updateCatalog(privUuid, { ownerUserUuid: evaUuid }, SOURCE, ana);
    await updateVirtualMcp(fechadoUuid, { ownerUserUuid: evaUuid }, SOURCE, ana);
  });

  it('o flag público: liga e desliga na skill e no catálogo, e o site acompanha', async () => {
    const ligada = await updateSkill('da-eva', { isPublic: true }, SOURCE, eva);
    expect(ligada.isPublic).toBe(true);
    expect(await slugsSeenBy({})).toContain('da-eva');
    expect((await getSkillSummary('da-eva', { viewer: viewer.carla }))?.access).toBe('view');
    expect(await slugsSeenBy({ viewer: viewer.carla, scope: 'public' })).toContain('da-eva');

    const desligada = await updateSkillWithContent('da-eva', { isPublic: false }, SOURCE, eva);
    expect(desligada.isPublic).toBe(false);
    expect(await slugsSeenBy({})).not.toContain('da-eva');
    expect(await getSkillSummary('da-eva', { viewer: viewer.carla })).toBeNull();
    expect((await capture(updateSkill('da-eva', { isPublic: 'sim' as never }, SOURCE, eva))).status).toBe(400);

    // Catálogo privado que vira público expõe os membros ativos ao site.
    expect(await slugsSeenBy({})).not.toContain('no-catalogo-concedido');
    await updateCatalog(privUuid, { isPublic: true }, SOURCE, eva);
    expect(await slugsSeenBy({})).toContain('no-catalogo-concedido');
    expect((await listCatalogs({ viewer: viewer.carla })).map((c) => c.slug)).toEqual(['priv', 'pub']);
    await updateCatalog(privUuid, { isPublic: false }, SOURCE, eva);
    expect(await slugsSeenBy({})).not.toContain('no-catalogo-concedido');
    expect((await capture(updateCatalog(privUuid, { isPublic: 1 as never }, SOURCE, eva))).status).toBe(400);
  });

  it('lookupUsers: contas ativas, por nome ou username, mínimo de dois caracteres', async () => {
    expect(await lookupUsers('a')).toEqual([]);
    expect(await lookupUsers('  e ')).toEqual([]);
    expect(await lookupUsers('')).toEqual([]);

    // Uma homônima só para medir a ordem e o `limit`: nenhum fragmento de dois
    // caracteres casa duas das contas do cenário.
    const paula = await createUser({
      username: 'ana-paula',
      email: 'paula@exemplo.dev',
      name: 'Ana Paula',
      role: 'membro',
    });

    // Casa por **nome**; Dora está desativada e fica de fora, e a ordem é por nome.
    expect((await lookupUsers('an')).map((u) => u.name)).toEqual(['Ana', 'Ana Paula']);
    expect((await lookupUsers('arl')).map((u) => u.name)).toEqual(['Carla']);
    expect(await lookupUsers('Dora')).toEqual([]);
    // Casa por **username** — e é o username que sai, no lugar do e-mail.
    expect(await lookupUsers('BRU')).toEqual([
      { uuid: brunoUuid, username: 'bruno', name: 'Bruno', role: 'editor' },
    ]);
    expect((await lookupUsers('an', 1)).map((u) => u.name)).toEqual(['Ana']);
    expect((await lookupUsers('an', 0)).length).toBe(1);
    expect(await lookupUsers('ninguem')).toEqual([]);

    // **O e-mail saiu dos dois lados** (`docs/19` decisão 10). Devolver só o
    // username mas continuar casando por endereço deixaria qualquer conta
    // logada descobrir a qual username um e-mail corresponde, bastando
    // digitá-lo: a sondagem anula o sigilo mesmo com o campo fora da resposta.
    expect(await lookupUsers('exemplo')).toEqual([]);
    expect(await lookupUsers('bruno@exemplo.dev')).toEqual([]);
    expect(await lookupUsers('paula@')).toEqual([]);

    // O termo é **literal**: `%%` casava toda conta ativa e `_` qualquer
    // caractere (o mínimo de dois caracteres deixa `%` sozinho de fora).
    expect(await lookupUsers('%%')).toEqual([]);
    expect(await lookupUsers('bruno_exemplo')).toEqual([]);
    expect((await capture(lookupUsers(123 as never))).status).toBe(400);

    await raw.query('DELETE FROM users WHERE uuid = $1', [paula.uuid]);
    // A conta foi embora e a reserva ficou, sem dono: o nome não volta a
    // circular (`docs/19` decisão 6) e a trilha que o cite continua honesta.
    expect(
      (await raw.query('SELECT user_uuid FROM usernames WHERE username_lower = $1', ['ana-paula']))
        .rows,
    ).toEqual([{ user_uuid: null }]);
  });

  it('o site lista os catálogos públicos e ligados, com todos os membros ativos', async () => {
    // Um membro com participação desativada não conta nem aparece.
    await setCatalogSkills(pubUuid, [{ slug: 'no-catalogo-publico' }, { slug: 'escondida', isActive: false }], SOURCE, eva);

    // O dono sai por **username** (`docs/19` decisão 11): a ficha pública
    // credita quem publicou. `ownerUserUuid` continua fora daqui — é o `sub`
    // do cookie de sessão do painel e não tem uso numa página anônima. Ao lado
    // dele, `ownerHasProfile` (`034`): se esse crédito vira link para
    // `/u/<username>` ou fica no texto. Eva nunca abriu o perfil, e um link
    // levaria ao 404 que a página do perfil devolve.
    expect(await listPublicCatalogs()).toEqual([
      {
        uuid: pubUuid,
        slug: 'pub',
        name: 'Catálogo público',
        description: '',
        ownerUsername: 'eva',
        ownerHasProfile: false,
        skillCount: 1,
      },
    ]);

    // Com o perfil dela público, o crédito do catálogo **e** o da skill viram
    // link. Salvar sem ligar não basta: o opt-in é o consentimento.
    await saveProfile(eva.userUuid, { bio: 'Publico catálogos.' });
    expect((await listPublicCatalogs())[0]?.ownerHasProfile).toBe(false);
    await saveProfile(eva.userUuid, { isPublic: true });
    expect((await listPublicCatalogs())[0]?.ownerHasProfile).toBe(true);
    expect((await getPublicCatalog('pub'))?.ownerHasProfile).toBe(true);
    expect((await getSkillSummary('no-catalogo-publico'))?.ownerHasProfile).toBe(true);
    await saveProfile(eva.userUuid, { isPublic: false });
    expect((await getSkillSummary('no-catalogo-publico'))?.ownerHasProfile).toBe(false);

    const pagina = await getPublicCatalog('pub');
    expect(pagina?.skillCount).toBe(1);
    expect(pagina?.ownerUsername).toBe('eva');
    expect(pagina?.skills.map((s) => s.slug)).toEqual(['no-catalogo-publico']);
    // Na visibilidade do site: sem acesso, sem lista de catálogos, só vMCPs
    // abertos — e **com** o dono, que desde o `033` sai em toda visibilidade.
    expect(pagina?.skills[0]).toMatchObject({
      access: null,
      catalogs: [],
      mcps: [],
      isPublic: false,
      ownerUsername: 'eva',
      ownerHasProfile: false,
    });

    // Um membro privado que não está em vMCP aberto nenhum aparece mesmo
    // assim — decisão 5. (`isActive` explícito: quem já era membro não é
    // religado por omissão.)
    await setCatalogSkills(pubUuid, [{ slug: 'no-catalogo-publico' }, { slug: 'escondida', isActive: true }], SOURCE, eva);
    expect((await getPublicCatalog('pub'))?.skills.map((s) => s.slug)).toEqual(['escondida', 'no-catalogo-publico']);
    // Desligada globalmente, a skill some da página; desligado o catálogo, some a página.
    await updateSkill('escondida', { isActive: false }, SOURCE, ana);
    expect((await getPublicCatalog('pub'))?.skills.map((s) => s.slug)).toEqual(['no-catalogo-publico']);
    await updateSkill('escondida', { isActive: true }, SOURCE, ana);
    await updateCatalog(pubUuid, { isActive: false }, SOURCE, eva);
    expect(await listPublicCatalogs()).toEqual([]);
    expect(await getPublicCatalog('pub')).toBeNull();
    await updateCatalog(pubUuid, { isActive: true }, SOURCE, eva);

    expect(await getPublicCatalog('priv')).toBeNull();
    expect(await getPublicCatalog('nao-existe')).toBeNull();
    expect(await getPublicCatalog('  ')).toBeNull();
  });

  it('as cascatas: apagar a skill ou a conta leva as concessões; a conta removida deixa a skill órfã', async () => {
    await setSkillGrant('minha', legadoUuid, 'view', SOURCE, bruno);
    await setCatalogGrant('priv', legadoUuid, 'view', SOURCE, eva);
    await setVirtualMcpGrant('fechado', legadoUuid, 'view', SOURCE, eva);
    await setSkillGrant('da-eva', legadoUuid, 'edit', SOURCE, eva);

    await deleteSkill('da-eva', SOURCE, eva);
    const { rows: apos } = await raw.query<{ n: string }>(
      'SELECT count(*) AS n FROM skill_grants WHERE user_uuid = $1',
      [legadoUuid],
    );
    expect(Number(apos[0]?.n)).toBe(1);

    await raw.query('DELETE FROM users WHERE uuid = $1', [legadoUuid]);
    const { rows: restantes } = await raw.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM skill_grants WHERE user_uuid = $1)
            + (SELECT count(*) FROM catalog_grants WHERE user_uuid = $1)
            + (SELECT count(*) FROM virtual_mcp_grants WHERE user_uuid = $1) AS n`,
      [legadoUuid],
    );
    expect(Number(restantes[0]?.n)).toBe(0);
    expect(await skillOwner('herdada')).toBeNull();
    // Quem concedeu foi embora: a concessão fica, sem `grantedBy`.
    await setSkillGrant('minha', carlaUuid, 'view', SOURCE, { userUuid: evaUuid, label: 'eva' });
    await raw.query('DELETE FROM users WHERE uuid = $1', [evaUuid]);
    const daMinha = await listSkillGrants((await getSkillSummary('minha', { visibility: 'all' }))!.uuid);
    expect(daMinha.map((g) => [g.username, g.grantedByUserUuid, g.grantedByUsername])).toEqual([
      ['carla', null, null],
    ]);
    expect(await listCatalogGrants('torto')).toEqual([]);
    expect(await listVirtualMcpGrants('torto')).toEqual([]);
  });

  it('re-executar o 017 sobre o resultado não faz nada — inclusive o backfill', async () => {
    // `sem-criador` e `herdada` estão órfãs; `escondida` tem `created_by` (a
    // Eva, já removida → nulo) e dono nulo por escolha. Uma segunda passada
    // não pode devolver dono a ninguém.
    await raw.query(
      `UPDATE skills SET created_by_user_uuid = $1 WHERE slug = 'escondida'`,
      [brunoUuid],
    );
    const antes = await listSkills({ visibility: 'all', limit: 100 });
    const { rows: concessoesAntes } = await raw.query<{ n: string }>(
      'SELECT count(*) AS n FROM skill_grants',
    );

    await raw.query("DELETE FROM schema_migrations WHERE name = '017-acesso-granular.sql'");
    expect(await runMigrations(url!)).toEqual(['017-acesso-granular.sql']);

    expect(await listSkills({ visibility: 'all', limit: 100 })).toEqual(antes);
    expect(await skillOwner('escondida')).toBeNull();
    const { rows: concessoesDepois } = await raw.query<{ n: string }>(
      'SELECT count(*) AS n FROM skill_grants',
    );
    expect(concessoesDepois[0]?.n).toBe(concessoesAntes[0]?.n);
    const { rows: objetos } = await raw.query<{ n: number }>(
      `SELECT (
         (SELECT count(*) FROM pg_constraint WHERE conname IN ('users_role_check', 'audit_log_action_check'))
         + (SELECT count(*) FROM pg_indexes
             WHERE tablename IN ('skill_grants', 'catalog_grants', 'virtual_mcp_grants'))
         + (SELECT count(*) FROM pg_indexes WHERE indexname = 'skills_owner_user_uuid_idx')
       )::int AS n`,
    );
    // 2 CHECKs + 6 índices (pkey e reverso em cada uma das três) + 1, sem duplicata.
    expect(objetos[0]?.n).toBe(9);
  });

  it('o UPDATE da skill leva só o que veio: escrita concorrente não é desfeita', async () => {
    // As duas escritas leem a skill **antes** de abrir a transação. Aqui a foto
    // é envelhecida de propósito: outra sessão renomeia e publica a skill
    // enquanto o UPDATE espera a trava da linha. Quem grava depois não pode
    // devolver `is_public`, o nome e o slug ao que eram — era esse o bug.
    await createSkill(
      { name: 'Corrida', slug: 'corrida', description: 'antes', skillMd: '# antes' },
      SOURCE,
    );

    const outra = new pg.Client({ connectionString: url });
    await outra.connect();
    try {
      await outra.query('BEGIN');
      await outra.query(
        `UPDATE skills SET is_public = true, name = 'Renomeada', slug = 'corrida-2'
          WHERE slug = 'corrida'`,
      );

      const pendente = updateSkill('corrida', { description: 'depois' }, SOURCE, ana);
      await esperaUpdateDeSkillTravado();
      await outra.query('COMMIT');

      // O slug devolvido é o **gravado**: a releitura do fim acha a skill.
      expect(await pendente).toMatchObject({
        slug: 'corrida-2',
        name: 'Renomeada',
        description: 'depois',
        isPublic: true,
      });
    } finally {
      await outra.end();
    }

    // `updateSkillWithContent` faz o mesmo: o SKILL.md e as tags entram e o
    // desligamento concorrente fica de pé.
    const terceira = new pg.Client({ connectionString: url });
    await terceira.connect();
    try {
      await terceira.query('BEGIN');
      await terceira.query(`UPDATE skills SET is_active = false WHERE slug = 'corrida-2'`);

      const pendente = updateSkillWithContent(
        'corrida-2',
        { skillMd: '# depois', tags: ['corrida'] },
        SOURCE,
        ana,
      );
      await esperaUpdateDeSkillTravado();
      await terceira.query('COMMIT');

      expect(await pendente).toMatchObject({
        isActive: false,
        skillMd: '# depois',
        tags: ['corrida'],
      });
    } finally {
      await terceira.end();
    }
  }, 20_000);

  it('duas skills com as mesmas tags inéditas, salvas juntas: ninguém perde tag nem morre', async () => {
    // `tasks/038`. A auditoria supôs tag perdida (um `ON CONFLICT DO NOTHING`
    // que não esperaria a transação vizinha); o que existia era o oposto — o
    // INSERT **espera**, e dois salvamentos com as mesmas tags novas em ordens
    // diferentes travavam em cruz: deadlock (40P01), que a rota devolve como
    // 500. `replaceTagsTx` ordena a lista para todo mundo travar na mesma
    // ordem; sem isso, este laço morria em ~15% dos pares.
    for (let i = 0; i < 8; i++) {
      const tags = [`t038-${i}-aa`, `t038-${i}-bb`, `t038-${i}-cc`, `t038-${i}-dd`];
      const [a, b] = await Promise.all([
        createSkill(
          { name: `Tag 038 ${i} A`, slug: `tag-038-${i}-a`, skillMd: '# a', tags },
          SOURCE,
        ),
        createSkill(
          {
            name: `Tag 038 ${i} B`,
            slug: `tag-038-${i}-b`,
            skillMd: '# b',
            tags: [...tags].reverse(),
          },
          SOURCE,
        ),
      ]);

      for (const criada of [a, b]) {
        const detalhe = await getSkillDetail(criada.slug, { visibility: 'all' });
        expect(detalhe?.tags).toEqual(tags);
      }
    }
  }, 30_000);

  it('slug pedido explicitamente precisa ser válido, como no vMCP e no catálogo', async () => {
    // `tasks/049`. Antes, `slug: "Com Espaço"` respondia 201 com `com-espaco`:
    // um endereço que o cliente não pediu e que ele não consegue reenviar na
    // edição, porque a própria validação dele recusa o que mandou.
    const torto = await capture(
      createSkill({ name: 'Torta', slug: 'Com Espaço', skillMd: '# x' }, SOURCE, ana),
    );
    expect(torto).toMatchObject({ status: 400, message: 'Slug inválido: "Com Espaço"' });

    // Sem slug, o nome continua sendo slugificado — é o caminho do painel.
    const gerada = await createSkill({ name: 'Nome Com Espaço', skillMd: '# x' }, SOURCE, ana);
    expect(gerada.slug).toBe('nome-com-espaco');

    // Renomear para um slug torto também é 400, e a skill fica como estava.
    expect((await capture(updateSkill(gerada.slug, { slug: 'Não!' }, SOURCE, ana))).status).toBe(400);
    expect((await getSkillDetail('nome-com-espaco', { visibility: 'all' }))?.slug).toBe(
      'nome-com-espaco',
    );
  });
});
