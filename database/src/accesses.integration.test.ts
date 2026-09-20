/**
 * Teste de integração dos acessos por skill (`skill_accesses`,
 * `schema/018-acessos-por-skill.sql`) — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/accesses.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { SkillAccessInput } from '@purple-skills/shared';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import { AppError } from './errors.js';
import {
  createApiKey,
  createCatalog,
  createSkill,
  createUser,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteCatalog,
  deleteSkill,
  deleteVirtualMcp,
  getCatalogByUuid,
  getSkillSummary,
  getVirtualMcpByUuid,
  linkCatalog,
  linkSkill,
  listAuditPage,
  listSkillAccesses,
  listSkills,
  lookupUsers,
  MCP_SESSION_LABEL_MAX,
  normalizeSessionLabel,
  recordSkillAccess,
  setCatalogSkillActive,
  setCatalogSkills,
  unlinkSkill,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;
/** Quem assina o que a suíte cria — não é uma conta, como o bootstrap. */
const ACTOR = { userUuid: null, label: 'teste' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NENHUM = '00000000-0000-0000-0000-000000000000';
/**
 * U+0000 e ESC montados por código, e não por escape: uma ferramenta que
 * resolva o escape deixaria o byte literal neste arquivo.
 */
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

const TOOLS = { asSkill: true, asPrompt: false, asResource: false };

let raw: pg.Client;
let brunoUuid = '';
let apiKeyId = '';
let mcpUuid = '';
let vazioUuid = '';
let keyId = '';
let alfaUuid = '';
let betaUuid = '';
let gamaUuid = '';
let dadosUuid = '';
let extrasUuid = '';

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

/** Quantas linhas há na tabela — para provar que nada foi podado nem gravado. */
async function linhas(): Promise<number> {
  return Number(
    (await raw.query<{ n: string }>('SELECT count(*) AS n FROM skill_accesses')).rows[0]?.n,
  );
}

/** Os contadores de skill, catálogos e vínculo direto, para provar o caminho. */
async function contadores(slug: string) {
  const [skill, dados, extras, mcp] = await Promise.all([
    getSkillSummary(slug, { visibility: 'all' }),
    getCatalogByUuid(dadosUuid),
    getCatalogByUuid(extrasUuid),
    getVirtualMcpByUuid(mcpUuid),
  ]);
  const vinculo = mcp?.skills.find((s) => s.slug === slug);
  return {
    skill: [skill!.viewCount, skill!.downloadCount],
    dados: [dados!.viewCount, dados!.downloadCount],
    extras: [extras!.viewCount, extras!.downloadCount],
    vinculo: vinculo ? [vinculo.viewCount, vinculo.downloadCount] : null,
  };
}

/** Uma leitura no site — o caso mais simples; os testes sobrescrevem o que querem. */
function leitura(overrides: Partial<SkillAccessInput> = {}): SkillAccessInput {
  return {
    skillUuid: alfaUuid,
    kind: 'view',
    surface: 'page',
    origin: 'site',
    auth: 'anonymous',
    ip: '203.0.113.9',
    ...overrides,
  };
}

describe.skipIf(!url)('acessos por skill: gravar com o caminho, sobreviver à remoção e listar', () => {
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

    brunoUuid = (await createUser({ email: 'bruno@exemplo.dev', name: 'Bruno', role: 'editor' }))
      .uuid;
    apiKeyId = (
      await createApiKey({ userUuid: brunoUuid, name: 'cli do bruno', prefix: 'psk12345', keyHash: 'x' })
    ).id;

    mcpUuid = (
      await createVirtualMcp({ name: 'Servidor', isOpen: true, ownerUserUuid: null }, SOURCE, ACTOR)
    ).uuid;
    keyId = (
      await createVirtualMcpKey({
        virtualMcpUuid: mcpUuid,
        name: 'agente',
        prefix: 'psv12345',
        keyHash: 'x',
        createdByUserUuid: null,
      })
    ).id;

    alfaUuid = (await createSkill({ name: 'Alfa', slug: 'alfa', skillMd: '# alfa' }, SOURCE)).uuid;
    betaUuid = (await createSkill({ name: 'Beta', slug: 'beta', skillMd: '# beta' }, SOURCE)).uuid;
    gamaUuid = (await createSkill({ name: 'Gama', slug: 'gama', skillMd: '# gama' }, SOURCE)).uuid;

    // `beta` chega ao servidor por dois catálogos; `gama` por vínculo direto;
    // `alfa` está num catálogo mas não chega a servidor nenhum por ele.
    dadosUuid = (await createCatalog({ name: 'Time de Dados', slug: 'dados', ownerUserUuid: null }, SOURCE, ACTOR)).uuid;
    extrasUuid = (await createCatalog({ name: 'Extras', slug: 'extras', ownerUserUuid: null }, SOURCE, ACTOR)).uuid;
    await setCatalogSkills(dadosUuid, [{ slug: 'alfa' }, { slug: 'beta' }], SOURCE, ACTOR);
    await setCatalogSkills(extrasUuid, [{ slug: 'beta' }], SOURCE, ACTOR);
    await linkCatalog(mcpUuid, dadosUuid, TOOLS, SOURCE, ACTOR);
    await linkCatalog(mcpUuid, extrasUuid, TOOLS, SOURCE, ACTOR);
    await linkSkill('gama', mcpUuid, TOOLS, SOURCE, ACTOR);
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('grava a leitura do site com as cópias da skill e soma só no global', async () => {
    await recordSkillAccess(leitura({ userAgent: '  Mozilla/5.0  ' }));

    const page = await listSkillAccesses({ skillUuid: alfaUuid });
    expect(page).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(page.items).toHaveLength(1);
    const [item] = page.items;
    expect(item!.id).toMatch(UUID_RE);
    expect(item).toMatchObject({
      skillUuid: alfaUuid,
      skillSlug: 'alfa',
      skillName: 'Alfa',
      kind: 'view',
      surface: 'page',
      origin: 'site',
      auth: 'anonymous',
      virtualMcpUuid: null,
      virtualMcpSlug: null,
      virtualMcpName: null,
      catalogs: [],
      keyId: null,
      keyName: null,
      apiKeyId: null,
      apiKeyName: null,
      userUuid: null,
      userEmail: null,
      sessionId: null,
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0',
      clientName: null,
      clientVersion: null,
    });
    expect(new Date(item!.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // `alfa` está no catálogo `dados`, mas o site não é caminho por catálogo.
    expect(await contadores('alfa')).toEqual({ skill: [1, 0], dados: [0, 0], extras: [0, 0], vinculo: null });
  });

  it('pelo MCP público por catálogo: grava os catálogos do caminho, por nome, e soma em cada um', async () => {
    await recordSkillAccess({
      skillUuid: betaUuid,
      kind: 'download',
      surface: 'download',
      origin: 'mcp',
      auth: 'key',
      virtualMcpUuid: mcpUuid,
      keyId,
      sessionId: 'sess-beta-1',
      ip: '10.0.0.1',
      clientName: 'Claude Code',
      clientVersion: '1.2.3',
    });

    const [item] = (await listSkillAccesses({ skillUuid: betaUuid })).items;
    expect(item).toMatchObject({
      skillSlug: 'beta',
      kind: 'download',
      surface: 'download',
      origin: 'mcp',
      auth: 'key',
      virtualMcpUuid: mcpUuid,
      virtualMcpSlug: 'servidor',
      virtualMcpName: 'Servidor',
      keyId,
      keyName: 'agente',
      sessionId: 'sess-beta-1',
      ip: '10.0.0.1',
      clientName: 'Claude Code',
      clientVersion: '1.2.3',
    });
    // Por nome: "Extras" antes de "Time de Dados".
    expect(item!.catalogs).toEqual([
      { uuid: extrasUuid, slug: 'extras', name: 'Extras' },
      { uuid: dadosUuid, slug: 'dados', name: 'Time de Dados' },
    ]);
    expect(await contadores('beta')).toEqual({ skill: [0, 1], dados: [0, 1], extras: [0, 1], vinculo: null });

    // Participação desativada num dos catálogos: só o outro é caminho, e só ele soma.
    await setCatalogSkillActive(extrasUuid, 'beta', false, SOURCE, ACTOR);
    await recordSkillAccess({
      skillUuid: betaUuid, kind: 'view', surface: 'tool', origin: 'mcp', auth: 'open', virtualMcpUuid: mcpUuid,
    });
    const [ultimo] = (await listSkillAccesses({ skillUuid: betaUuid })).items;
    expect(ultimo!.catalogs.map((c) => c.slug)).toEqual(['dados']);
    expect(ultimo!.keyId).toBeNull();
    expect(await contadores('beta')).toEqual({ skill: [1, 1], dados: [1, 1], extras: [0, 1], vinculo: null });
    await setCatalogSkillActive(extrasUuid, 'beta', true, SOURCE, ACTOR);
  });

  it('com vínculo direto o caminho é o vínculo: catálogos vazios e o contador é o do vínculo', async () => {
    await recordSkillAccess({
      skillUuid: gamaUuid, kind: 'view', surface: 'resource', origin: 'mcp', auth: 'open', virtualMcpUuid: mcpUuid,
    });
    const [item] = (await listSkillAccesses({ skillUuid: gamaUuid })).items;
    expect(item).toMatchObject({ virtualMcpSlug: 'servidor', surface: 'resource', catalogs: [] });
    // Os contadores de catálogo são do catálogo: o que `beta` somou fica.
    expect(await contadores('gama')).toEqual({ skill: [1, 0], dados: [1, 1], extras: [0, 1], vinculo: [1, 0] });

    // `beta` ganha vínculo direto: os catálogos deixam de ser caminho mesmo
    // com a skill neles — não entram na linha nem somam.
    await linkSkill('beta', mcpUuid, TOOLS, SOURCE, ACTOR);
    await recordSkillAccess({
      skillUuid: betaUuid, kind: 'download', surface: 'file', origin: 'mcp', auth: 'open', virtualMcpUuid: mcpUuid,
    });
    const [direto] = (await listSkillAccesses({ skillUuid: betaUuid })).items;
    expect(direto!.catalogs).toEqual([]);
    expect(await contadores('beta')).toEqual({ skill: [1, 2], dados: [1, 1], extras: [0, 1], vinculo: [0, 1] });
    await unlinkSkill('beta', mcpUuid, SOURCE, ACTOR);
  });

  it('pelo mcp-admin: copia o nome da chave psk_ e o e-mail da conta, e não soma contador nenhum', async () => {
    const antes = await contadores('alfa');
    await recordSkillAccess({
      skillUuid: alfaUuid,
      kind: 'view',
      surface: 'admin-tool',
      origin: 'mcp-admin',
      auth: 'user',
      apiKeyId,
      userUuid: brunoUuid,
      ip: '192.0.2.7',
    });
    const [item] = (await listSkillAccesses({ skillUuid: alfaUuid })).items;
    expect(item).toMatchObject({
      surface: 'admin-tool',
      origin: 'mcp-admin',
      auth: 'user',
      apiKeyId,
      apiKeyName: 'cli do bruno',
      userUuid: brunoUuid,
      userEmail: 'bruno@exemplo.dev',
      virtualMcpUuid: null,
      catalogs: [],
    });
    // O get_skill do mcp-admin nunca contou: a linha entra, a pontuação do
    // acervo não muda — nem a skill, nem catálogo, nem vínculo.
    expect(antes).toEqual({ skill: [1, 0], dados: [1, 1], extras: [0, 1], vinculo: null });
    expect(await contadores('alfa')).toEqual(antes);
  });

  it('filtra por conta e por chave psk_: só as leituras daquela conta; uuid torto é 400', async () => {
    const carlaUuid = (await createUser({ email: 'carla@exemplo.dev', name: 'Carla', role: 'membro' })).uuid;
    const carlaKeyId = (
      await createApiKey({ userUuid: carlaUuid, name: 'cli da carla', prefix: 'psk67890', keyHash: 'x' })
    ).id;
    await recordSkillAccess({
      skillUuid: gamaUuid, kind: 'view', surface: 'admin-tool', origin: 'mcp-admin', auth: 'user',
      apiKeyId: carlaKeyId, userUuid: carlaUuid, ip: '192.0.2.8',
    });

    const de = async (options: Parameters<typeof listSkillAccesses>[0]) =>
      (await listSkillAccesses(options)).items.map((a) => `${a.skillSlug}:${a.userEmail}`);
    expect(await de({ userUuid: brunoUuid })).toEqual(['alfa:bruno@exemplo.dev']);
    expect(await de({ userUuid: carlaUuid })).toEqual(['gama:carla@exemplo.dev']);
    expect(await de({ apiKeyId })).toEqual(['alfa:bruno@exemplo.dev']);
    expect(await de({ apiKeyId: carlaKeyId })).toEqual(['gama:carla@exemplo.dev']);
    expect((await listSkillAccesses({ userUuid: carlaUuid })).total).toBe(1);
    // Os filtros somam (AND): a conta de uma com a chave da outra não acha nada.
    expect(await de({ userUuid: carlaUuid, apiKeyId })).toEqual([]);
    // Uma conta sem leitura; e as leituras sem conta (site, MCP público) não
    // entram na guia de ninguém.
    expect(await de({ userUuid: NENHUM })).toEqual([]);
    for (const options of [{ userUuid: 'torto' }, { apiKeyId: 'torto' }]) {
      expect((await capture(listSkillAccesses(options))).status).toBe(400);
    }
  });

  it('skill inexistente não grava nem lança; opcionais tortos ou sumidos são ignorados; o resto é 400', async () => {
    const antes = await linhas();
    await recordSkillAccess(leitura({ skillUuid: NENHUM }));
    expect(await linhas()).toBe(antes);

    // O que não existe (mais) ou veio torto num campo opcional vira nulo; a
    // linha e o contador global valem mesmo assim, e `auth` fica como veio.
    await recordSkillAccess(
      leitura({
        origin: 'mcp',
        auth: 'key',
        surface: 'tool',
        virtualMcpUuid: NENHUM,
        keyId: 'torta',
        apiKeyId: NENHUM,
        userUuid: 'torto',
      }),
    );
    expect(await linhas()).toBe(antes + 1);
    const [item] = (await listSkillAccesses({ skillUuid: alfaUuid })).items;
    expect(item).toMatchObject({
      origin: 'mcp',
      auth: 'key',
      virtualMcpUuid: null,
      virtualMcpSlug: null,
      keyId: null,
      keyName: null,
      apiKeyId: null,
      userUuid: null,
      catalogs: [],
    });
    expect(await contadores('alfa')).toEqual({ skill: [2, 0], dados: [1, 1], extras: [0, 1], vinculo: null });

    // Um vMCP onde a skill não está (nem direto nem por catálogo): a linha
    // guarda o servidor, mas não há caminho — nada soma nos catálogos nem em
    // vínculo nenhum.
    vazioUuid = (await createVirtualMcp({ name: 'Vazio', isOpen: true, ownerUserUuid: null }, SOURCE, ACTOR)).uuid;
    await recordSkillAccess(leitura({ origin: 'mcp', auth: 'open', surface: 'tool', virtualMcpUuid: vazioUuid }));
    const [noServidor] = (await listSkillAccesses({ skillUuid: alfaUuid })).items;
    expect(noServidor).toMatchObject({ virtualMcpUuid: vazioUuid, virtualMcpSlug: 'vazio', catalogs: [] });
    expect(await contadores('alfa')).toEqual({ skill: [3, 0], dados: [1, 1], extras: [0, 1], vinculo: null });

    // O obrigatório torto e os valores fora dos CHECKs são bug de quem chama.
    for (const input of [
      leitura({ skillUuid: 'torta' }),
      leitura({ kind: 'read' as never }),
      leitura({ surface: 'widget' as never }),
      leitura({ origin: 'admin' as never }),
      leitura({ auth: 'token' as never }),
      leitura({ ip: 7 as never }),
    ]) {
      expect((await capture(recordSkillAccess(input))).status).toBe(400);
    }
    expect(await linhas()).toBe(antes + 2);
  });

  it('lista com cada filtro, o `q`, a ordem e a paginação; filtro torto é 400', async () => {
    // Um vMCP à parte, para o filtro por servidor ter um negativo.
    const outro = await createVirtualMcp({ name: 'Outro', isOpen: true, ownerUserUuid: null }, SOURCE, ACTOR);
    await linkSkill('gama', outro.uuid, TOOLS, SOURCE, ACTOR);
    await recordSkillAccess({
      skillUuid: gamaUuid, kind: 'view', surface: 'prompt', origin: 'mcp', auth: 'open',
      virtualMcpUuid: outro.uuid, sessionId: 'sess-outro', ip: '198.51.100.4', clientName: 'Cursor',
    });

    const tudo = await listSkillAccesses({ limit: 200 });
    expect(tudo.total).toBe(await linhas());
    expect(tudo.items.map((a) => a.id)).toEqual(
      [...tudo.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((a) => a.id),
    );
    expect(tudo.items[0]).toMatchObject({ skillSlug: 'gama', virtualMcpSlug: 'outro' });

    const slugs = async (options: Parameters<typeof listSkillAccesses>[0]) =>
      (await listSkillAccesses({ ...options, limit: 200 })).items.map((a) => `${a.skillSlug}:${a.surface}`);

    expect(await slugs({ virtualMcpUuid: outro.uuid })).toEqual(['gama:prompt']);
    expect(await slugs({ virtualMcpUuid: vazioUuid })).toEqual(['alfa:tool']);
    expect(await slugs({ virtualMcpUuid: mcpUuid })).toEqual([
      'beta:file', 'gama:resource', 'beta:tool', 'beta:download',
    ]);
    // Por catálogo: só as leituras em que ele foi caminho — o vínculo direto
    // de `beta` fica fora, e `alfa` (membro de `dados`) nunca foi lida por ele.
    expect(await slugs({ catalogUuid: dadosUuid })).toEqual(['beta:tool', 'beta:download']);
    expect(await slugs({ catalogUuid: extrasUuid })).toEqual(['beta:download']);
    expect(await slugs({ skillUuid: betaUuid, catalogUuid: extrasUuid })).toEqual(['beta:download']);
    expect(await slugs({ origin: 'site' })).toEqual(['alfa:page']);
    expect(await slugs({ origin: 'mcp-admin' })).toEqual(['gama:admin-tool', 'alfa:admin-tool']);
    expect(await slugs({ kind: 'download' })).toEqual(['beta:file', 'beta:download']);
    expect(await slugs({ kind: 'download', origin: 'site' })).toEqual([]);

    // `q` em cada uma das seis colunas, sem diferenciar caixa; vazio é ignorado.
    expect(await slugs({ q: 'BRUNO@' })).toEqual(['alfa:admin-tool']);
    expect(await slugs({ q: 'cli do' })).toEqual(['alfa:admin-tool']);
    expect(await slugs({ q: 'agente' })).toEqual(['beta:download']);
    expect(await slugs({ q: '203.0.113' })).toEqual(['alfa:tool', 'alfa:tool', 'alfa:page']);
    expect(await slugs({ q: '192.0.2.7' })).toEqual(['alfa:admin-tool']);
    expect(await slugs({ q: 'cursor' })).toEqual(['gama:prompt']);
    expect(await slugs({ q: 'sess-' })).toEqual(['gama:prompt', 'beta:download']);
    expect(await slugs({ q: 'ninguém' })).toEqual([]);
    expect((await listSkillAccesses({ q: '   ' })).total).toBe(tudo.total);

    // O `q` é **literal**: `%` casava tudo e `_` casava qualquer caractere.
    expect((await listSkillAccesses({ q: '%' })).total).toBe(0);
    expect((await listSkillAccesses({ q: '_' })).total).toBe(0);
    expect(await slugs({ q: '203.0_113' })).toEqual([]);
    expect(await slugs({ q: '203.0.113' })).toEqual(['alfa:tool', 'alfa:tool', 'alfa:page']);
    // O pior caso de LIKE deixa de casar o histórico inteiro.
    expect((await listSkillAccesses({ q: '%_'.repeat(60) })).total).toBe(0);

    // Paginação: clamp do limite, offset como nas outras listas, total constante.
    const primeira = await listSkillAccesses({ limit: 0 });
    expect(primeira).toMatchObject({ limit: 1, offset: 0, total: tudo.total });
    expect(primeira.items).toHaveLength(1);
    expect((await listSkillAccesses({ limit: 999 })).limit).toBe(200);
    const segunda = await listSkillAccesses({ limit: 2, offset: 2 });
    expect(segunda.items.map((a) => a.id)).toEqual(tudo.items.slice(2, 4).map((a) => a.id));
    expect((await listSkillAccesses({ offset: -3 })).offset).toBe(0);
    expect((await listSkillAccesses({ offset: Number.NaN })).offset).toBe(0);
    // Além da faixa do `bigint` o offset satura, e a página sai vazia com o
    // total certo: `?offset=99999999999999999999` chega aqui como 1e20 e era
    // 22003 no driver; de 1e21 em diante o texto é "1e+21", e era 22P02.
    for (const offset of [1e20, 1e21, 2 ** 63, Number.MAX_VALUE]) {
      const alem = await listSkillAccesses({ offset });
      expect(alem).toMatchObject({ items: [], total: tudo.total, offset: Number.MAX_SAFE_INTEGER });
    }
    expect((await listSkillAccesses({ offset: Number.POSITIVE_INFINITY })).offset).toBe(0);

    for (const options of [
      { skillUuid: 'torto' },
      { catalogUuid: 'torto' },
      { virtualMcpUuid: 'torto' },
      { origin: 'painel' as never },
      { kind: 'read' as never },
      { q: 12 as never },
    ]) {
      expect((await capture(listSkillAccesses(options))).status).toBe(400);
    }

    await deleteVirtualMcp(outro.uuid, SOURCE, ACTOR);
  });

  it('a linha sobrevive à remoção da skill, do catálogo, do vMCP, das chaves e da conta — e nunca é podada', async () => {
    const antes = await linhas();

    // A skill: o uuid vai a nulo, slug e nome ficam; o filtro pela skill
    // apagada não a acha mais, a lista global sim.
    await deleteSkill('alfa', SOURCE);
    expect((await listSkillAccesses({ skillUuid: alfaUuid })).total).toBe(0);
    const deAlfa = (await listSkillAccesses({ origin: 'site' })).items;
    expect(deAlfa).toHaveLength(1);
    expect(deAlfa[0]).toMatchObject({ skillUuid: null, skillSlug: 'alfa', skillName: 'Alfa' });

    // O catálogo: o uuid sai nulo na listagem, slug e nome ficam na posição;
    // o outro catálogo da mesma linha continua inteiro.
    await deleteCatalog(extrasUuid, SOURCE, ACTOR);
    const [porDois] = (await listSkillAccesses({ skillUuid: betaUuid, kind: 'download', origin: 'mcp' })).items.slice(-1);
    expect(porDois!.catalogs).toEqual([
      { uuid: null, slug: 'extras', name: 'Extras' },
      { uuid: dadosUuid, slug: 'dados', name: 'Time de Dados' },
    ]);
    // O array guarda o uuid (não há SET NULL em array): o filtro pelo
    // catálogo apagado continua achando o histórico dele — diferente da
    // skill e do vMCP, cujo uuid vai a nulo na coluna.
    expect((await listSkillAccesses({ catalogUuid: extrasUuid })).total).toBe(1);
    expect((await listSkillAccesses({ catalogUuid: dadosUuid })).total).toBe(2);

    // O vMCP (e, pela cascata, a chave `psv_`): uuids nulos, cópias ficam,
    // `auth` continua dizendo que houve chave.
    await deleteVirtualMcp(mcpUuid, SOURCE, ACTOR);
    expect((await listSkillAccesses({ virtualMcpUuid: mcpUuid })).total).toBe(0);
    const [comChave] = (await listSkillAccesses({ q: 'agente' })).items;
    expect(comChave).toMatchObject({
      virtualMcpUuid: null,
      virtualMcpSlug: 'servidor',
      virtualMcpName: 'Servidor',
      auth: 'key',
      keyId: null,
      keyName: 'agente',
    });

    // A conta (e, pela cascata, a chave `psk_`): o filtro pela conta apagada
    // não acha mais nada; a cópia do e-mail acha.
    await raw.query('DELETE FROM users WHERE uuid = $1', [brunoUuid]);
    expect((await listSkillAccesses({ userUuid: brunoUuid })).total).toBe(0);
    const [doBruno] = (await listSkillAccesses({ q: 'bruno@' })).items;
    expect(doBruno).toMatchObject({
      userUuid: null,
      userEmail: 'bruno@exemplo.dev',
      apiKeyId: null,
      apiKeyName: 'cli do bruno',
    });

    expect(await linhas()).toBe(antes);
  });

  it('re-executar o 018, o 019 e o 022 sobre o resultado não faz nada', async () => {
    const antes = await linhas();
    const indices = async () =>
      (await raw.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'skill_accesses' ORDER BY indexname",
      )).rows.map((r) => r.indexname);
    const ESPERADOS = [
      'skill_accesses_api_key_id_idx',
      'skill_accesses_api_key_name_trgm_idx',
      'skill_accesses_catalog_uuids_idx',
      'skill_accesses_client_name_trgm_idx',
      'skill_accesses_created_idx',
      'skill_accesses_ip_trgm_idx',
      'skill_accesses_key_id_idx',
      'skill_accesses_key_name_trgm_idx',
      'skill_accesses_pkey',
      'skill_accesses_session_id_trgm_idx',
      'skill_accesses_skill_created_idx',
      'skill_accesses_user_created_idx',
      'skill_accesses_user_email_trgm_idx',
      'skill_accesses_virtual_mcp_created_idx',
    ];
    // O `019` trocou o índice simples de `user_uuid` pelo composto; os seis
    // GIN de trigrama são do `022`, um por coluna do `q`.
    expect(await indices()).toEqual(ESPERADOS);

    // Apagar do histórico é o que força o runner a rodar os arquivos de novo
    // — uma segunda chamada normal só os pularia. Os três juntos: o `018`
    // recria o índice simples, o `019` o derruba outra vez e o `022` acha os
    // seus doze índices já no lugar.
    const NOVAS = [
      '018-acessos-por-skill.sql',
      '019-acessos-por-conta.sql',
      '022-busca-por-substring.sql',
    ];
    await raw.query('DELETE FROM schema_migrations WHERE name = ANY($1)', [NOVAS]);
    expect(await runMigrations(url!)).toEqual(NOVAS);
    expect(await linhas()).toBe(antes);
    expect(await indices()).toEqual(ESPERADOS);

    const { rows } = await raw.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'skill_accesses'::regclass AND contype IN ('c', 'f')`,
    );
    // 5 CHECKs + 5 FKs.
    expect(rows[0]?.n).toBe(10);

    // Os arrays têm de andar juntos.
    await expect(
      raw.query(`INSERT INTO skill_accesses (skill_slug, skill_name, kind, surface, origin, auth, catalog_uuids)
                 VALUES ('x', 'X', 'view', 'page', 'site', 'anonymous', ARRAY[$1]::uuid[])`, [NENHUM]),
    ).rejects.toThrow(/skill_accesses_catalogs_parallel_chk/);
  });

  // Os quatro testes abaixo criam os próprios objetos (os de cima já foram
  // apagados) e só gravam com `origin: 'mcp'`/`'mcp-admin'`.

  it('o caminho olha a porta: só o catálogo que serve a superfície lida entra na linha e soma', async () => {
    const portas = await createVirtualMcp({ name: 'Portas', isOpen: true, ownerUserUuid: null }, SOURCE, ACTOR);
    const delta = await createSkill({ name: 'Delta', slug: 'delta', skillMd: '# delta' }, SOURCE);
    const soTools = await createCatalog({ name: 'So Tools', slug: 'so-tools', ownerUserUuid: null }, SOURCE, ACTOR);
    const soPrompts = await createCatalog({ name: 'So Prompts', slug: 'so-prompts', ownerUserUuid: null }, SOURCE, ACTOR);
    await setCatalogSkills(soTools.uuid, [{ slug: 'delta' }], SOURCE, ACTOR);
    await setCatalogSkills(soPrompts.uuid, [{ slug: 'delta' }], SOURCE, ACTOR);
    await linkCatalog(portas.uuid, soTools.uuid, TOOLS, SOURCE, ACTOR);
    await linkCatalog(portas.uuid, soPrompts.uuid, { asSkill: false, asPrompt: true, asResource: false }, SOURCE, ACTOR);

    /** Grava uma leitura de `delta` e devolve os catálogos que entraram na linha. */
    const ler = async (surface: SkillAccessInput['surface'], kind: SkillAccessInput['kind'] = 'view') => {
      await recordSkillAccess({
        skillUuid: delta.uuid, kind, surface, origin: 'mcp', auth: 'open', virtualMcpUuid: portas.uuid, ip: '10.41.0.1',
      });
      const [item] = (await listSkillAccesses({ skillUuid: delta.uuid })).items;
      return item!.catalogs.map((c) => c.slug);
    };
    const somas = async () => {
      const [tools, prompts] = await Promise.all([getCatalogByUuid(soTools.uuid), getCatalogByUuid(soPrompts.uuid)]);
      return { tools: [tools!.viewCount, tools!.downloadCount], prompts: [prompts!.viewCount, prompts!.downloadCount] };
    };

    // `get_skill`, o SKILL.md avulso e o pacote entram pela porta de skill:
    // o catálogo vinculado só com Prompts não os entregou.
    expect(await ler('tool')).toEqual(['so-tools']);
    expect(await somas()).toEqual({ tools: [1, 0], prompts: [0, 0] });
    expect(await ler('prompt')).toEqual(['so-prompts']);
    expect(await somas()).toEqual({ tools: [1, 0], prompts: [1, 0] });
    // Ninguém serve Resources ali: a linha entra sem caminho e só o global soma.
    expect(await ler('resource')).toEqual([]);
    expect(await ler('download', 'download')).toEqual(['so-tools']);
    expect(await ler('file')).toEqual(['so-tools']);
    expect(await somas()).toEqual({ tools: [2, 1], prompts: [1, 0] });
    const resumo = await getSkillSummary('delta', { visibility: 'all' });
    expect([resumo!.viewCount, resumo!.downloadCount]).toEqual([4, 1]);

    // A guia "Acessos" de cada catálogo só mostra o que passou por ele.
    const guia = async (catalogUuid: string) =>
      (await listSkillAccesses({ catalogUuid })).items.map((a) => a.surface);
    expect(await guia(soPrompts.uuid)).toEqual(['prompt']);
    expect(await guia(soTools.uuid)).toEqual(['file', 'download', 'tool']);

    // Com a mesma porta nos dois, os dois são caminho — por nome, como sempre.
    await linkCatalog(portas.uuid, soPrompts.uuid, { asSkill: true, asPrompt: true, asResource: false }, SOURCE, ACTOR);
    expect(await ler('tool')).toEqual(['so-prompts', 'so-tools']);
    expect(await somas()).toEqual({ tools: [3, 1], prompts: [2, 0] });

    // A precedência continua sem porta, como em `exposedIn`: havendo vínculo
    // direto, nenhum catálogo é caminho — mesmo que o vínculo não tenha a porta.
    await linkSkill('delta', portas.uuid, { asSkill: false, asPrompt: true, asResource: false }, SOURCE, ACTOR);
    expect(await ler('tool')).toEqual([]);
    expect(await somas()).toEqual({ tools: [3, 1], prompts: [2, 0] });
  });

  it('byte nulo e caractere de controle no rótulo são limpos: a linha entra e os contadores sobem', async () => {
    const mcp = await createVirtualMcp({ name: 'Rotulos', isOpen: true, ownerUserUuid: null }, SOURCE, ACTOR);
    const skill = await createSkill({ name: 'Epsilon', slug: 'epsilon', skillMd: '# epsilon' }, SOURCE);
    await linkSkill('epsilon', mcp.uuid, TOOLS, SOURCE, ACTOR);
    const antes = await linhas();

    // O `text` do Postgres recusa U+0000 (22021): antes, esta leitura não
    // deixava linha **nem** somava contador — os UPDATEs vão na mesma instrução.
    await recordSkillAccess({
      skillUuid: skill.uuid, kind: 'view', surface: 'tool', origin: 'mcp', auth: 'open', virtualMcpUuid: mcp.uuid,
      sessionId: `s${NUL}1`,
      ip: `10.38.0.1${NUL}`,
      userAgent: `node${NUL}\tfetch\n${ESC}[31m`,
      clientName: `Cla${NUL}ude`,
      clientVersion: `${NUL}${NUL}`,
    });
    expect(await linhas()).toBe(antes + 1);
    const [item] = (await listSkillAccesses({ skillUuid: skill.uuid })).items;
    expect(item).toMatchObject({
      sessionId: 's 1',
      ip: '10.38.0.1',
      userAgent: 'node  fetch  [31m',
      clientName: 'Cla ude',
      clientVersion: null,
    });
    const resumo = await getSkillSummary('epsilon', { visibility: 'all' });
    expect(resumo!.viewCount).toBe(1);
    const vinculo = (await getVirtualMcpByUuid(mcp.uuid))!.skills.find((s) => s.slug === 'epsilon');
    expect(vinculo!.viewCount).toBe(1);

    // A regra, que o mcp-public usa para cortar na memória: controle e
    // separador de linha viram espaço, vazio é nulo, o teto é o do banco e
    // aplicar de novo não muda nada.
    expect(normalizeSessionLabel(`a${NUL}b`)).toBe('a b');
    expect(normalizeSessionLabel(` ${NUL}\r\n${String.fromCharCode(0x85)}${String.fromCharCode(0x2028)} `)).toBeNull();
    expect(normalizeSessionLabel('  Claude Code  ')).toBe('Claude Code');
    expect(normalizeSessionLabel('x'.repeat(2000))).toBe('x'.repeat(MCP_SESSION_LABEL_MAX));
    const naBorda = normalizeSessionLabel(`${'y'.repeat(MCP_SESSION_LABEL_MAX - 1)} cauda`);
    expect(naBorda).toBe('y'.repeat(MCP_SESSION_LABEL_MAX - 1));
    expect(normalizeSessionLabel(naBorda!)).toBe(naBorda);
    // Um par substituto cortado ao meio não chega ao driver pela metade.
    const emoji = String.fromCodePoint(0x1f600);
    const cortado = normalizeSessionLabel(`${'z'.repeat(MCP_SESSION_LABEL_MAX - 1)}${emoji}`);
    expect(cortado).toBe(`${'z'.repeat(MCP_SESSION_LABEL_MAX - 1)}${String.fromCharCode(0xfffd)}`);

    // Fora dos rótulos o nulo é erro de quem chama (400), não 500 do driver.
    for (const chamada of [
      () => listSkillAccesses({ q: `ab${NUL}cd` }),
      () => listAuditPage({ q: `ab${NUL}cd` }),
      () => lookupUsers(`ab${NUL}cd`),
      () => listSkills({ query: `ab${NUL}cd`, visibility: 'all' }),
      () => createCatalog({ name: `Nu${NUL}lo`, ownerUserUuid: null }, SOURCE, ACTOR),
    ]) {
      const erro = await capture(chamada());
      expect(erro).toBeInstanceOf(AppError);
      expect(erro.status).toBe(400);
    }
  });

  it('as cópias de nome são cortadas no teto dos rótulos, com os arrays de catálogo alinhados', async () => {
    const MAX = MCP_SESSION_LABEL_MAX;
    const longo = (letra: string) => letra.repeat(MAX + 88);
    const mcp = await createVirtualMcp(
      { name: longo('M'), slug: 'nomes-longos', isOpen: true, ownerUserUuid: null }, SOURCE, ACTOR,
    );
    const chave = await createVirtualMcpKey({
      virtualMcpUuid: mcp.uuid, name: longo('K'), prefix: 'psvlongo', keyHash: 'x', createdByUserUuid: null,
    });
    const skill = await createSkill({ name: longo('S'), slug: 'nome-longo', skillMd: '# s' }, SOURCE);
    const comprido = await createCatalog({ name: longo('C'), slug: 'comprido', ownerUserUuid: null }, SOURCE, ACTOR);
    const curto = await createCatalog({ name: 'Zeta', slug: 'zeta', ownerUserUuid: null }, SOURCE, ACTOR);
    for (const catalogo of [comprido, curto]) {
      await setCatalogSkills(catalogo.uuid, [{ slug: 'nome-longo' }], SOURCE, ACTOR);
      await linkCatalog(mcp.uuid, catalogo.uuid, TOOLS, SOURCE, ACTOR);
    }

    await recordSkillAccess({
      skillUuid: skill.uuid, kind: 'view', surface: 'tool', origin: 'mcp', auth: 'key',
      virtualMcpUuid: mcp.uuid, keyId: chave.id, ip: '10.42.0.1',
    });
    const [item] = (await listSkillAccesses({ skillUuid: skill.uuid })).items;
    expect(item!.skillName).toBe('S'.repeat(MAX));
    expect(item!.virtualMcpName).toBe('M'.repeat(MAX));
    expect(item!.keyName).toBe('K'.repeat(MAX));
    // Cortado **dentro** do `array_agg`: uuid, slug e nome seguem na mesma posição.
    expect(item!.catalogs).toEqual([
      { uuid: comprido.uuid, slug: 'comprido', name: 'C'.repeat(MAX) },
      { uuid: curto.uuid, slug: 'zeta', name: 'Zeta' },
    ]);
    // O objeto continua com o nome inteiro — o corte é só na cópia.
    expect((await getCatalogByUuid(comprido.uuid))!.name).toHaveLength(MAX + 88);

    const conta = await createUser({ email: 'dora@exemplo.dev', name: 'Dora', role: 'editor' });
    const psk = await createApiKey({ userUuid: conta.uuid, name: longo('P'), prefix: 'psklongo', keyHash: 'x' });
    await recordSkillAccess({
      skillUuid: skill.uuid, kind: 'view', surface: 'admin-tool', origin: 'mcp-admin', auth: 'user',
      apiKeyId: psk.id, userUuid: conta.uuid, ip: '10.42.0.2',
    });
    const [doAdmin] = (await listSkillAccesses({ skillUuid: skill.uuid })).items;
    expect(doAdmin!.apiKeyName).toBe('P'.repeat(MAX));
  });

  it('offset além da faixa do bigint satura também na lista de skills e na auditoria', async () => {
    const skills = await listSkills({ visibility: 'all' });
    const auditoria = await listAuditPage();
    expect(skills.total).toBeGreaterThan(0);
    expect(auditoria.total).toBeGreaterThan(0);
    for (const offset of [1e20, 1e21]) {
      expect(await listSkills({ visibility: 'all', offset })).toMatchObject({
        items: [], total: skills.total, offset: Number.MAX_SAFE_INTEGER,
      });
      expect(await listAuditPage({ offset })).toMatchObject({
        items: [], total: auditoria.total, offset: Number.MAX_SAFE_INTEGER,
      });
    }
    // O maior offset exato continua sendo aceito como veio.
    expect((await listSkills({ visibility: 'all', offset: Number.MAX_SAFE_INTEGER })).offset).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
