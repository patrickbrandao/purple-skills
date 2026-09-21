/**
 * Teste de integração dos catálogos (`docs/11-catalogos.md`) — exige um
 * PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/catalogs.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import { AppError } from './errors.js';
import {
  addCatalogSkill,
  cloneCatalog,
  createCatalog,
  createSkill,
  createUser,
  createVirtualMcp,
  deleteCatalog,
  deleteSkill,
  deleteVirtualMcp,
  getCatalog,
  getCatalogByUuid,
  getSkillSummary,
  getVirtualMcp,
  getVirtualMcpByUuid,
  incrementDownloadCount,
  incrementViewCount,
  linkCatalog,
  linkSkill,
  listAudit,
  listAuditPage,
  listCatalogs,
  listOpenVirtualMcps,
  listPublishedSkills,
  listSkills,
  listTags,
  listVirtualMcps,
  removeCatalogSkill,
  setCatalogGrant,
  setCatalogSkillActive,
  setCatalogSkills,
  setVirtualMcpCanvas,
  setVirtualMcpCatalogs,
  stats,
  unlinkCatalog,
  unlinkSkill,
  updateCatalog,
  updateSkill,
  updateSkillWithContent,
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
let anaUuid = '';
let brunoUuid = '';
let mcpUuid = '';
let dadosUuid = '';
let extrasUuid = '';
let betaUuid = '';

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

/** Quantas linhas há na trilha — para provar que uma chamada não auditou. */
async function auditedRows(): Promise<number> {
  return Number((await raw.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0]?.n);
}

const NO_PORTS = { asSkill: false, asPrompt: false, asResource: false };
const TOOLS = { asSkill: true, asPrompt: false, asResource: false };

describe.skipIf(!url)('catálogos: grupos, precedência, desativações e contadores', () => {
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

    anaUuid = (await createUser({ email: 'ana@exemplo.dev', name: 'Ana', role: 'admin' })).uuid;
    brunoUuid = (await createUser({ email: 'bruno@exemplo.dev', name: 'Bruno', role: 'editor' }))
      .uuid;

    // Quatro skills flutuantes e um servidor aberto e ligado, ainda vazio.
    await createSkill({ name: 'Alfa', slug: 'alfa', skillMd: '# alfa', tags: ['comum', 'a'] }, SOURCE);
    betaUuid = (
      await createSkill({ name: 'Beta', slug: 'beta', skillMd: '# beta', tags: ['comum'] }, SOURCE)
    ).uuid;
    await createSkill({ name: 'Gama', slug: 'gama', skillMd: '# gama', tags: ['comum'] }, SOURCE);
    await createSkill({ name: 'Delta', slug: 'delta', skillMd: '# delta' }, SOURCE);
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  const ana = { userUuid: '', label: 'ana@exemplo.dev' };

  it('cria com slug gerado, dono e auditoria; lista por dono; atualiza e apaga', async () => {
    ana.userUuid = anaUuid;
    mcpUuid = (
      await createVirtualMcp({ name: 'Servidor', isOpen: true, ownerUserUuid: null }, SOURCE, ana)
    ).uuid;

    const dados = await createCatalog(
      { name: 'Time de Dados', description: 'do time', ownerUserUuid: brunoUuid },
      SOURCE,
      ana,
    );
    dadosUuid = dados.uuid;
    expect(dados).toMatchObject({
      slug: 'time-de-dados',
      name: 'Time de Dados',
      description: 'do time',
      isActive: true,
      ownerUserUuid: brunoUuid,
      ownerEmail: 'bruno@exemplo.dev',
      skillCount: 0,
      activeSkillCount: 0,
      mcpCount: 0,
      viewCount: 0,
      downloadCount: 0,
      skills: [],
      mcps: [],
    });

    // Segundo com o mesmo nome ganha sufixo; slug explícito em uso é conflito.
    const segundo = await createCatalog({ name: 'Time de Dados', ownerUserUuid: null }, SOURCE, ana);
    expect(segundo.slug).toBe('time-de-dados-2');
    expect(segundo.ownerUserUuid).toBeNull();
    expect(segundo.ownerEmail).toBeNull();

    expect(
      (await capture(createCatalog({ name: 'X', slug: 'time-de-dados', ownerUserUuid: null }, SOURCE, ana))).status,
    ).toBe(409);
    expect(
      (await capture(createCatalog({ name: 'X', slug: 'Com Espaço', ownerUserUuid: null }, SOURCE, ana))).status,
    ).toBe(400);
    expect((await capture(createCatalog({ name: '  ', ownerUserUuid: null }, SOURCE, ana))).status).toBe(400);
    expect(
      (await capture(createCatalog({ name: 'X', ownerUserUuid: 'torto' }, SOURCE, ana))).status,
    ).toBe(404);

    const criada = (await listAudit(20)).find(
      (e) => e.action === 'catalog.create' && e.targetLabel === 'time-de-dados',
    );
    expect(criada?.skillUuid).toBeNull();
    expect(criada?.actorUserUuid).toBe(anaUuid);
    expect(criada?.actorLabel).toBe('ana@exemplo.dev');
    // A trilha paginada aceita a ação nova como filtro.
    expect((await listAuditPage({ action: 'catalog.create' })).total).toBe(2);

    // Listagem: admin vê todos; o dono só os seus; bootstrap nenhum.
    expect((await listCatalogs()).map((c) => c.slug)).toEqual(['time-de-dados', 'time-de-dados-2']);
    expect((await listCatalogs({ ownerUserUuid: brunoUuid })).map((c) => c.slug)).toEqual(['time-de-dados']);
    expect(await listCatalogs({ ownerUserUuid: anaUuid })).toEqual([]);
    expect(await listCatalogs({ ownerUserUuid: null })).toEqual([]);
    expect(await listCatalogs({ ownerUserUuid: 'torto' })).toEqual([]);

    // Atualização parcial com rename e transferência de dono.
    const renomeado = await updateCatalog(
      dadosUuid,
      { slug: 'dados', description: 'novo', ownerUserUuid: null },
      SOURCE,
      ana,
    );
    expect(renomeado.slug).toBe('dados');
    expect(renomeado.name).toBe('Time de Dados');
    expect(renomeado.description).toBe('novo');
    expect(renomeado.ownerUserUuid).toBeNull();
    expect((await getCatalog('dados'))?.uuid).toBe(dadosUuid);
    expect(await getCatalog('time-de-dados')).toBeNull();
    expect(await getCatalog('  ')).toBeNull();
    expect(await getCatalogByUuid('torto')).toBeNull();
    expect(
      (await listAudit(20)).find((e) => e.action === 'catalog.update' && e.targetLabel === 'dados'),
    ).toBeDefined();

    expect((await capture(updateCatalog(dadosUuid, { slug: 'Não!' }, SOURCE, ana))).status).toBe(400);
    expect((await capture(updateCatalog(dadosUuid, { name: ' ' }, SOURCE, ana))).status).toBe(400);
    expect((await capture(updateCatalog(dadosUuid, { slug: 'time-de-dados-2' }, SOURCE, ana))).status).toBe(409);
    expect(
      (await capture(updateCatalog('00000000-0000-0000-0000-000000000000', { name: 'x' }, SOURCE, ana))).status,
    ).toBe(404);
    expect((await capture(updateCatalog(dadosUuid, { isActive: 'sim' as never }, SOURCE, ana))).status).toBe(400);

    await deleteCatalog(segundo.uuid, SOURCE, ana);
    expect(await getCatalogByUuid(segundo.uuid)).toBeNull();
    expect((await capture(deleteCatalog(segundo.uuid, SOURCE, ana))).status).toBe(404);
    expect((await listAudit(20)).find((e) => e.action === 'catalog.delete')?.targetLabel).toBe(
      'time-de-dados-2',
    );
  });

  it('define os membros de forma declarativa, preservando a participação de quem ficou', async () => {
    const primeiro = await setCatalogSkills(
      dadosUuid,
      [{ slug: 'alfa' }, { slug: 'beta', isActive: false }, { slug: 'gama' }],
      SOURCE,
      ana,
    );
    expect(primeiro.skills.map((s) => [s.slug, s.isActive, s.skillIsActive])).toEqual([
      ['alfa', true, true],
      ['beta', false, true],
      ['gama', true, true],
    ]);
    expect(primeiro.skillCount).toBe(3);
    expect(primeiro.activeSkillCount).toBe(2);
    expect(primeiro.skills[0]?.addedAt).toMatch(/^\d{4}-/);

    // A caixa da tela: desliga a participação de `alfa`.
    const alfaOff = await setCatalogSkillActive(dadosUuid, 'alfa', false, SOURCE, ana);
    expect(alfaOff.skills.find((s) => s.slug === 'alfa')?.isActive).toBe(false);
    expect(alfaOff.activeSkillCount).toBe(1);

    // Re-salvar: `gama` sai, `delta` entra ativa, `beta` é religada
    // explicitamente e `alfa` (sem `isActive` na lista) fica desligada.
    const segundo = await setCatalogSkills(
      dadosUuid,
      [{ slug: 'alfa' }, { slug: 'beta', isActive: true }, { slug: 'delta' }],
      SOURCE,
      ana,
    );
    expect(segundo.skills.map((s) => [s.slug, s.isActive])).toEqual([
      ['alfa', false],
      ['beta', true],
      ['delta', true],
    ]);

    // Slug desconhecido, repetido, vazio ou tipo errado: 400 e nada muda.
    const desconhecido = await capture(
      setCatalogSkills(dadosUuid, [{ slug: 'alfa' }, { slug: 'nao-existe' }], SOURCE, ana),
    );
    expect(desconhecido.status).toBe(400);
    expect(desconhecido.message).toMatch(/nao-existe/);
    expect((await capture(setCatalogSkills(dadosUuid, [{ slug: 'alfa' }, { slug: 'alfa' }], SOURCE, ana))).status).toBe(400);
    expect((await capture(setCatalogSkills(dadosUuid, [{ slug: ' ' }], SOURCE, ana))).status).toBe(400);
    expect(
      (await capture(setCatalogSkills(dadosUuid, [{ slug: 'alfa', isActive: 1 } as never], SOURCE, ana))).status,
    ).toBe(400);
    expect((await capture(setCatalogSkills(dadosUuid, 'alfa' as never, SOURCE, ana))).status).toBe(400);
    expect(
      (await capture(setCatalogSkills('00000000-0000-0000-0000-000000000000', [], SOURCE, ana))).status,
    ).toBe(404);
    expect((await getCatalogByUuid(dadosUuid))?.skills.map((s) => s.slug)).toEqual(['alfa', 'beta', 'delta']);

    // Um membro de cada vez: adicionar (idempotente, sem auditar de novo),
    // remover (404 se não é membro) e ligar/desligar a participação.
    const comGama = await addCatalogSkill(dadosUuid, 'gama', SOURCE, ana);
    expect(comGama.skills.find((s) => s.slug === 'gama')?.isActive).toBe(true);
    const antes = await auditedRows();
    await addCatalogSkill(dadosUuid, 'gama', SOURCE, ana);
    expect(await auditedRows()).toBe(antes);
    expect((await capture(addCatalogSkill(dadosUuid, 'nao-existe', SOURCE, ana))).status).toBe(404);
    expect((await capture(addCatalogSkill(dadosUuid, '', SOURCE, ana))).status).toBe(400);

    const semDelta = await removeCatalogSkill(dadosUuid, 'delta', SOURCE, ana);
    expect(semDelta.skills.map((s) => s.slug)).toEqual(['alfa', 'beta', 'gama']);
    expect((await capture(removeCatalogSkill(dadosUuid, 'delta', SOURCE, ana))).status).toBe(404);
    expect((await capture(setCatalogSkillActive(dadosUuid, 'delta', true, SOURCE, ana))).status).toBe(404);
    expect(
      (await capture(setCatalogSkillActive(dadosUuid, 'alfa', 'sim' as never, SOURCE, ana))).status,
    ).toBe(400);

    const alfaOn = await setCatalogSkillActive(dadosUuid, 'alfa', true, SOURCE, ana);
    expect(alfaOn.activeSkillCount).toBe(3);
    expect(
      (await listAudit(50)).filter((e) => e.action === 'catalog.update' && e.targetLabel === 'dados').length,
    ).toBeGreaterThanOrEqual(6);

    // Pelo lado da skill, só a leitura do painel traz os catálogos.
    const alfa = await getSkillSummary('alfa', { visibility: 'all' });
    expect(alfa?.catalogs).toEqual([
      { uuid: dadosUuid, slug: 'dados', name: 'Time de Dados', isActive: true, memberActive: true },
    ]);
    // Sem vínculo com servidor, o catálogo sozinho não publica nada.
    expect(alfa?.mcps).toEqual([]);
    expect(await getSkillSummary('alfa')).toBeNull();
    expect((await listSkills({})).total).toBe(0);
  });

  it('vincula o catálogo ao vMCP e o vínculo direto sobrescreve o catálogo', async () => {
    const vinculado = await linkCatalog(mcpUuid, dadosUuid, TOOLS, SOURCE, ana);
    expect(vinculado.catalogCount).toBe(1);
    expect(vinculado.skillCount).toBe(0);
    expect(vinculado.catalogs).toEqual([
      {
        uuid: dadosUuid,
        slug: 'dados',
        name: 'Time de Dados',
        description: 'novo',
        isActive: true,
        ownerUserUuid: null,
        asSkill: true,
        asPrompt: false,
        asResource: false,
        skillCount: 3,
        activeSkillCount: 3,
        position: null,
      },
    ]);
    expect((await listVirtualMcps()).find((m) => m.uuid === mcpUuid)?.catalogCount).toBe(1);
    expect((await getCatalog('dados'))?.mcps).toEqual([
      {
        uuid: mcpUuid,
        slug: 'servidor',
        name: 'Servidor',
        isOpen: true,
        isActive: true,
        isDefault: false,
        ownerUserUuid: null,
        asSkill: true,
        asPrompt: false,
        asResource: false,
      },
    ]);
    expect((await getCatalog('dados'))?.mcpCount).toBe(1);
    expect(
      (await listAudit(10)).find((e) => e.action === 'mcp.update' && e.targetLabel === 'servidor'),
    ).toBeDefined();

    // 404 nos dois lados, 400 sem uma flag.
    expect(
      (await capture(linkCatalog(mcpUuid, '00000000-0000-0000-0000-000000000000', TOOLS, SOURCE, ana))).status,
    ).toBe(404);
    expect(
      (await capture(linkCatalog('00000000-0000-0000-0000-000000000000', dadosUuid, TOOLS, SOURCE, ana))).status,
    ).toBe(404);
    expect((await capture(linkCatalog(mcpUuid, dadosUuid, { asSkill: true } as never, SOURCE, ana))).status).toBe(400);

    // O servidor entrega os três membros como ferramentas, e só como ferramentas.
    const skill = { uuid: mcpUuid, surface: 'skill' as const };
    const ferramentas = await listSkills({ virtualMcp: skill });
    expect(ferramentas.total).toBe(3);
    expect(ferramentas.items.map((s) => s.slug).sort()).toEqual(['alfa', 'beta', 'gama']);
    expect((await listSkills({ virtualMcp: { uuid: mcpUuid, surface: 'prompt' } })).total).toBe(0);
    expect(await listPublishedSkills('prompt', mcpUuid)).toEqual([]);
    expect(await listPublishedSkills('resource', mcpUuid)).toEqual([]);
    expect((await listTags({ virtualMcp: skill })).map((t) => [t.name, t.count])).toEqual([
      ['comum', 3],
      ['a', 1],
    ]);
    expect((await listSkills({ virtualMcp: skill, tag: 'a' })).items.map((s) => s.slug)).toEqual(['alfa']);

    // O site vê as três (o servidor é aberto e ligado); `delta` segue flutuante.
    expect((await listSkills({})).items.map((s) => s.slug).sort()).toEqual(['alfa', 'beta', 'gama']);
    expect(await getSkillSummary('delta')).toBeNull();
    expect((await listOpenVirtualMcps()).find((m) => m.uuid === mcpUuid)?.skillCount).toBe(3);
    const numeros = await stats();
    expect(numeros.openSkills).toBe(3);
    expect(numeros.unlinkedSkills).toBe(1);

    // A skill enxerga o servidor pelo caminho do catálogo, com as portas dele.
    // Na leitura `'all'` o caminho é nomeado; **no site, não**: `dados` é
    // privado, e nomeá-lo entregava o catálogo fechado ao anônimo (`tasks/002`).
    // O vínculo continua contando para a exposição — o que muda é só o nome.
    const alfaAdmin = await getSkillSummary('alfa', { visibility: 'all' });
    const noServidorPorCatalogo = {
      uuid: mcpUuid,
      slug: 'servidor',
      name: 'Servidor',
      isOpen: true,
      isActive: true,
      isDefault: false,
      asSkill: true,
      asPrompt: false,
      asResource: false,
      direct: false,
    };
    expect(alfaAdmin?.mcps).toEqual([
      { ...noServidorPorCatalogo, catalogs: [{ uuid: dadosUuid, slug: 'dados', name: 'Time de Dados' }] },
    ]);
    const alfa = await getSkillSummary('alfa');
    expect(alfa?.mcps).toEqual([{ ...noServidorPorCatalogo, catalogs: [] }]);
    // Fora da leitura `'all'`, os catálogos da skill não vêm.
    expect(alfa?.catalogs).toEqual([]);
    // E o dono também não: no site as duas colunas vêm nulas (`tasks/002`).
    // Aqui as skills são órfãs, então o que a leitura `'all'` traz é nulo do
    // mesmo jeito — quem prova o outro lado é `access.integration.test.ts`.
    expect([alfa?.ownerUserUuid, alfa?.ownerEmail]).toEqual([null, null]);
    expect((await getSkillSummary('alfa', { virtualMcp: skill }))?.catalogs).toEqual([]);

    // Vínculo direto só com Prompts: `alfa` some das ferramentas e aparece
    // nos prompts — o direto sobrescreve, não soma.
    await linkSkill('alfa', mcpUuid, { asSkill: false, asPrompt: true, asResource: false }, SOURCE, ana);
    expect((await listSkills({ virtualMcp: skill })).items.map((s) => s.slug).sort()).toEqual(['beta', 'gama']);
    expect(
      (await listSkills({ virtualMcp: { uuid: mcpUuid, surface: 'prompt' } })).items.map((s) => s.slug),
    ).toEqual(['alfa']);
    expect((await listPublishedSkills('prompt', mcpUuid)).map((s) => s.slug)).toEqual(['alfa']);
    expect((await listTags({ virtualMcp: skill })).map((t) => [t.name, t.count])).toEqual([['comum', 2]]);

    const alfaDireta = await getSkillSummary('alfa', { visibility: 'all' });
    expect(alfaDireta?.mcps).toHaveLength(1);
    expect(alfaDireta?.mcps[0]).toMatchObject({
      uuid: mcpUuid,
      asSkill: false,
      asPrompt: true,
      asResource: false,
      direct: true,
      catalogs: [],
    });
    // Continua no catálogo, e o site continua a vê-la (está no servidor por algum caminho).
    expect(alfaDireta?.catalogs.map((c) => c.slug)).toEqual(['dados']);
    expect((await listSkills({})).total).toBe(3);

    // O nó do catálogo não conta quem já é nó próprio; o servidor conta o direto.
    const detail = (await getVirtualMcp('servidor'))!;
    expect(detail.skillCount).toBe(1);
    expect(detail.catalogs[0]?.skillCount).toBe(3);
    expect(detail.catalogs[0]?.activeSkillCount).toBe(2);

    // Direto com as três portas desligadas: some do servidor MCP, mas o site
    // ainda a vê — é o vínculo, com qualquer porta, que publica.
    await linkSkill('alfa', mcpUuid, NO_PORTS, SOURCE, ana);
    expect((await listSkills({ virtualMcp: { uuid: mcpUuid, surface: 'prompt' } })).total).toBe(0);
    expect((await listSkills({})).total).toBe(3);

    await unlinkSkill('alfa', mcpUuid, SOURCE, ana);
    expect((await listSkills({ virtualMcp: skill })).items.map((s) => s.slug).sort()).toEqual(['alfa', 'beta', 'gama']);
    expect((await getVirtualMcp('servidor'))?.catalogs[0]?.activeSkillCount).toBe(3);
  });

  it('soma as portas entre catálogos e define os catálogos do vMCP de forma declarativa', async () => {
    const extras = await createCatalog({ name: 'Extras', ownerUserUuid: null }, SOURCE, ana);
    extrasUuid = extras.uuid;
    await setCatalogSkills(extrasUuid, [{ slug: 'beta' }], SOURCE, ana);
    await linkCatalog(mcpUuid, extrasUuid, { asSkill: false, asPrompt: true, asResource: true }, SOURCE, ana);

    // `beta` chega pelos dois: Tools de um, Prompts e Resources do outro.
    const beta = await getSkillSummary('beta', { visibility: 'all' });
    expect(beta?.mcps).toEqual([
      expect.objectContaining({
        uuid: mcpUuid,
        asSkill: true,
        asPrompt: true,
        asResource: true,
        direct: false,
        catalogs: [
          { uuid: extrasUuid, slug: 'extras', name: 'Extras' },
          { uuid: dadosUuid, slug: 'dados', name: 'Time de Dados' },
        ],
      }),
    ]);
    expect(beta?.catalogs.map((c) => c.slug)).toEqual(['extras', 'dados']);
    expect((await listPublishedSkills('prompt', mcpUuid)).map((s) => s.slug)).toEqual(['beta']);
    expect(
      (await listSkills({ virtualMcp: { uuid: mcpUuid, surface: 'resource' } })).items.map((s) => s.slug),
    ).toEqual(['beta']);
    expect((await getVirtualMcp('servidor'))?.catalogs.map((c) => c.slug)).toEqual(['extras', 'dados']);

    // Declarativa: `extras` sai, `dados` fica com as portas trocadas.
    const so = await setVirtualMcpCatalogs(
      mcpUuid,
      [{ slug: 'dados', asSkill: true, asPrompt: true, asResource: false }],
      SOURCE,
      ana,
    );
    expect(so.catalogCount).toBe(1);
    expect(so.catalogs.map((c) => [c.slug, c.asPrompt])).toEqual([['dados', true]]);
    expect((await listPublishedSkills('resource', mcpUuid)).map((s) => s.slug)).toEqual([]);
    expect((await listPublishedSkills('prompt', mcpUuid)).map((s) => s.slug)).toEqual(['alfa', 'beta', 'gama']);

    expect(
      (await capture(setVirtualMcpCatalogs(mcpUuid, [{ slug: 'nao-existe', ...TOOLS }], SOURCE, ana))).message,
    ).toMatch(/nao-existe/);
    expect(
      (await capture(setVirtualMcpCatalogs(mcpUuid, [{ slug: 'dados', ...TOOLS }, { slug: 'dados', ...TOOLS }], SOURCE, ana))).status,
    ).toBe(400);
    expect(
      (await capture(setVirtualMcpCatalogs(mcpUuid, [{ slug: 'dados', asSkill: true } as never], SOURCE, ana))).status,
    ).toBe(400);
    expect(
      (await capture(setVirtualMcpCatalogs('00000000-0000-0000-0000-000000000000', [], SOURCE, ana))).status,
    ).toBe(404);
    expect((await getVirtualMcp('servidor'))?.catalogs.map((c) => c.slug)).toEqual(['dados']);

    // Volta aos dois, com as portas de antes, para os testes seguintes.
    await setVirtualMcpCatalogs(
      mcpUuid,
      [
        { slug: 'dados', ...TOOLS },
        { slug: 'extras', asSkill: false, asPrompt: true, asResource: true },
      ],
      SOURCE,
      ana,
    );
  });

  it('as três desativações tiram a skill do servidor e do site, sem perder vínculo', async () => {
    const skill = { uuid: mcpUuid, surface: 'skill' as const };
    const noServidor = async () =>
      (await listSkills({ virtualMcp: skill })).items.map((s) => s.slug).sort();
    const noSite = async () => (await listSkills({})).items.map((s) => s.slug).sort();

    // 1. A skill, globalmente.
    const desligada = await updateSkill('gama', { isActive: false }, SOURCE);
    expect(desligada.isActive).toBe(false);
    expect(await noServidor()).toEqual(['alfa', 'beta']);
    expect(await noSite()).toEqual(['alfa', 'beta']);
    expect(await getSkillSummary('gama')).toBeNull();
    // O painel continua a vê-la, com o caminho que ela *teria*.
    const gama = await getSkillSummary('gama', { visibility: 'all' });
    expect(gama?.isActive).toBe(false);
    expect(gama?.mcps.map((m) => m.slug)).toEqual(['servidor']);
    expect((await listOpenVirtualMcps()).find((m) => m.uuid === mcpUuid)?.skillCount).toBe(2);
    expect((await stats()).openSkills).toBe(2);
    expect((await getCatalog('dados'))?.activeSkillCount).toBe(2);
    expect((await getCatalog('dados'))?.skills.find((s) => s.slug === 'gama')?.skillIsActive).toBe(false);
    expect((await getVirtualMcp('servidor'))?.catalogs.find((c) => c.slug === 'dados')?.activeSkillCount).toBe(2);
    // Nem o vínculo direto religa uma skill desligada.
    await linkSkill('gama', mcpUuid, TOOLS, SOURCE, ana);
    expect(await noServidor()).toEqual(['alfa', 'beta']);
    expect(await noSite()).toEqual(['alfa', 'beta']);
    expect((await stats()).openSkills).toBe(2);
    await unlinkSkill('gama', mcpUuid, SOURCE, ana);
    // Tipo errado é 400; `undefined` não mexe.
    expect((await capture(updateSkill('gama', { isActive: 'sim' as never }, SOURCE))).status).toBe(400);
    expect((await updateSkill('gama', { name: 'Gama' }, SOURCE)).isActive).toBe(false);
    expect((await updateSkillWithContent('gama', { isActive: true, skillMd: '# gama!' }, SOURCE)).isActive).toBe(true);
    expect(await noServidor()).toEqual(['alfa', 'beta', 'gama']);

    // 2. A participação, só naquele catálogo.
    await setCatalogSkillActive(dadosUuid, 'gama', false, SOURCE, ana);
    expect(await noServidor()).toEqual(['alfa', 'beta']);
    expect(await noSite()).toEqual(['alfa', 'beta']);
    const membro = await getSkillSummary('gama', { visibility: 'all' });
    expect(membro?.isActive).toBe(true);
    expect(membro?.mcps).toEqual([]);
    expect(membro?.catalogs).toEqual([
      { uuid: dadosUuid, slug: 'dados', name: 'Time de Dados', isActive: true, memberActive: false },
    ]);
    await setCatalogSkillActive(dadosUuid, 'gama', true, SOURCE, ana);
    expect(await noServidor()).toEqual(['alfa', 'beta', 'gama']);

    // 3. O catálogo inteiro: `beta` continua pelo `extras` (Prompts e Resources), sem Tools.
    const off = await updateCatalog(dadosUuid, { isActive: false }, SOURCE, ana);
    expect(off.isActive).toBe(false);
    expect(await noServidor()).toEqual([]);
    expect(await noSite()).toEqual(['beta']);
    expect((await listPublishedSkills('prompt', mcpUuid)).map((s) => s.slug)).toEqual(['beta']);
    expect((await getSkillSummary('beta', { visibility: 'all' }))?.mcps[0]).toMatchObject({
      asSkill: false,
      asPrompt: true,
      asResource: true,
      catalogs: [{ slug: 'extras' }],
    });
    // `extras` também é privado: o site recebe as portas, não o nome do caminho.
    expect((await getSkillSummary('beta'))?.mcps[0]).toMatchObject({
      asPrompt: true,
      catalogs: [],
    });
    expect((await getSkillSummary('alfa', { visibility: 'all' }))?.catalogs[0]?.isActive).toBe(false);
    // O vínculo e os membros continuam lá para quando religar.
    expect((await getVirtualMcp('servidor'))?.catalogs.map((c) => [c.slug, c.isActive])).toEqual([
      ['extras', true],
      ['dados', false],
    ]);
    expect((await getCatalog('dados'))?.skillCount).toBe(3);
    await updateCatalog(dadosUuid, { isActive: true }, SOURCE, ana);
    expect(await noServidor()).toEqual(['alfa', 'beta', 'gama']);

    // Uma skill que nasce desligada.
    const nascida = await createSkill(
      { name: 'Nascida', slug: 'nascida', skillMd: '# n', isActive: false, mcps: [{ virtualMcpUuid: mcpUuid, ...TOOLS }] },
      SOURCE,
      ana,
    );
    expect(nascida.isActive).toBe(false);
    expect(nascida.mcps.map((m) => m.slug)).toEqual(['servidor']);
    expect(await noServidor()).toEqual(['alfa', 'beta', 'gama']);
    await deleteSkill('nascida', SOURCE, ana);
  });

  it('conta no catálogo que foi o caminho, ou no vínculo direto — nunca nos dois', async () => {
    const contadores = async () => {
      const [dados, extras, beta] = await Promise.all([
        getCatalogByUuid(dadosUuid),
        getCatalogByUuid(extrasUuid),
        getSkillSummary('beta', { visibility: 'all' }),
      ]);
      return {
        dados: [dados!.viewCount, dados!.downloadCount],
        extras: [extras!.viewCount, extras!.downloadCount],
        beta: [beta!.viewCount, beta!.downloadCount],
      };
    };

    // `beta` chega por dois catálogos: soma nos dois e no global.
    await incrementViewCount(betaUuid, mcpUuid);
    await incrementViewCount(betaUuid, mcpUuid);
    await incrementDownloadCount(betaUuid, mcpUuid);
    expect(await contadores()).toEqual({ dados: [2, 1], extras: [2, 1], beta: [2, 1] });

    // Sem o servidor, só o global.
    await incrementViewCount(betaUuid);
    expect(await contadores()).toEqual({ dados: [2, 1], extras: [2, 1], beta: [3, 1] });

    // Com vínculo direto, o caminho é o vínculo: soma nele e no global, e os
    // catálogos ficam como estavam.
    await linkSkill('beta', mcpUuid, TOOLS, SOURCE, ana);
    await incrementViewCount(betaUuid, mcpUuid);
    await incrementDownloadCount(betaUuid, mcpUuid);
    expect(await contadores()).toEqual({ dados: [2, 1], extras: [2, 1], beta: [4, 2] });
    const vinculo = (await getVirtualMcpByUuid(mcpUuid))!.skills.find((s) => s.slug === 'beta');
    expect([vinculo?.viewCount, vinculo?.downloadCount]).toEqual([1, 1]);
    await unlinkSkill('beta', mcpUuid, SOURCE, ana);

    // Participação desativada num dos catálogos: só o outro soma.
    await setCatalogSkillActive(extrasUuid, 'beta', false, SOURCE, ana);
    await incrementViewCount(betaUuid, mcpUuid);
    expect(await contadores()).toEqual({ dados: [3, 1], extras: [2, 1], beta: [5, 2] });
    await setCatalogSkillActive(extrasUuid, 'beta', true, SOURCE, ana);

    // Um servidor onde a skill não está, ou uuid torto: só o global.
    await incrementViewCount(betaUuid, '00000000-0000-0000-0000-000000000000');
    await incrementViewCount(betaUuid, 'torto');
    expect(await contadores()).toEqual({ dados: [3, 1], extras: [2, 1], beta: [7, 2] });
  });

  it('grava a posição do nó do catálogo no canvas, sem auditar; não vinculado é 400', async () => {
    const antes = (await getVirtualMcpByUuid(mcpUuid))!;
    const linhasAntes = await auditedRows();
    const posicaoDe = async (slug: string) =>
      (await getVirtualMcpByUuid(mcpUuid))!.catalogs.find((c) => c.slug === slug)?.position;

    await setVirtualMcpCanvas(mcpUuid, { catalogPositions: [{ slug: 'dados', x: 10.4, y: 20.6 }] });
    expect(await posicaoDe('dados')).toEqual({ x: 10, y: 21 });
    expect(await posicaoDe('extras')).toBeNull();
    expect(await auditedRows()).toBe(linhasAntes);
    expect((await getVirtualMcpByUuid(mcpUuid))?.updatedAt).toBe(antes.updatedAt);

    // Catálogo que existe mas não está neste vMCP: 400 e nada gravado.
    const solto = await createCatalog({ name: 'Solto', ownerUserUuid: null }, SOURCE, ana);
    const naoVinculado = await capture(
      setVirtualMcpCanvas(mcpUuid, {
        catalogPositions: [
          { slug: 'dados', x: 1, y: 1 },
          { slug: 'solto', x: 2, y: 2 },
        ],
      }),
    );
    expect(naoVinculado.status).toBe(400);
    expect(naoVinculado.message).toMatch(/solto/);
    expect(await posicaoDe('dados')).toEqual({ x: 10, y: 21 });
    expect((await capture(setVirtualMcpCanvas(mcpUuid, { catalogPositions: [{ slug: 'nao-existe', x: 0, y: 0 }] }))).status).toBe(400);
    expect(
      (await capture(setVirtualMcpCanvas(mcpUuid, { catalogPositions: [{ slug: 'dados', x: 0, y: 0 }, { slug: 'dados', x: 1, y: 1 }] }))).status,
    ).toBe(400);
    expect((await capture(setVirtualMcpCanvas(mcpUuid, { catalogPositions: 'x' as never }))).status).toBe(400);
    expect((await capture(setVirtualMcpCanvas(mcpUuid, { catalogPositions: [{ slug: 'dados', x: Number.NaN, y: 0 }] }))).status).toBe(400);
    await deleteCatalog(solto.uuid, SOURCE, ana);

    // `linkCatalog` grava a posição no INSERT e, num vínculo existente, só quando informada.
    await linkCatalog(mcpUuid, dadosUuid, { ...TOOLS, asPrompt: true }, SOURCE, ana);
    expect(await posicaoDe('dados')).toEqual({ x: 10, y: 21 });
    await linkCatalog(mcpUuid, dadosUuid, TOOLS, SOURCE, ana, { position: { x: 70, y: 80 } });
    expect(await posicaoDe('dados')).toEqual({ x: 70, y: 80 });
    expect((await capture(linkCatalog(mcpUuid, dadosUuid, TOOLS, SOURCE, ana, { position: { x: 1 } as never }))).status).toBe(400);
    expect(await posicaoDe('dados')).toEqual({ x: 70, y: 80 });

    // A declarativa preserva a posição de quem ficou.
    await setVirtualMcpCatalogs(
      mcpUuid,
      [
        { slug: 'dados', ...TOOLS },
        { slug: 'extras', asSkill: false, asPrompt: true, asResource: true },
      ],
      SOURCE,
      ana,
    );
    expect(await posicaoDe('dados')).toEqual({ x: 70, y: 80 });

    // A posição cai junto com o vínculo: desvincular e vincular de novo é auto-layout.
    await unlinkCatalog(mcpUuid, dadosUuid, SOURCE, ana);
    expect((await capture(unlinkCatalog(mcpUuid, dadosUuid, SOURCE, ana))).status).toBe(404);
    await linkCatalog(mcpUuid, dadosUuid, TOOLS, SOURCE, ana);
    expect(await posicaoDe('dados')).toBeNull();

    // O CHECK: meio ponto não é ponto.
    await expect(
      raw.query('UPDATE virtual_mcp_catalogs SET pos_x = 1, pos_y = NULL WHERE virtual_mcp_uuid = $1', [mcpUuid]),
    ).rejects.toThrow(/virtual_mcp_catalogs_pos_pair_chk/);
  });

  it('a cascata leva membros e vínculos; a skill e o vMCP levam a própria linha', async () => {
    await deleteCatalog(dadosUuid, SOURCE, ana);
    expect(await getCatalogByUuid(dadosUuid)).toBeNull();
    const { rows } = await raw.query<{ a: string; b: string }>(
      `SELECT (SELECT count(*) FROM catalog_skills WHERE catalog_uuid = $1) AS a,
              (SELECT count(*) FROM virtual_mcp_catalogs WHERE catalog_uuid = $1) AS b`,
      [dadosUuid],
    );
    expect([Number(rows[0]?.a), Number(rows[0]?.b)]).toEqual([0, 0]);
    expect((await getSkillSummary('alfa', { visibility: 'all' }))?.catalogs).toEqual([]);
    expect((await getVirtualMcp('servidor'))?.catalogs.map((c) => c.slug)).toEqual(['extras']);
    expect((await listSkills({ virtualMcp: { uuid: mcpUuid, surface: 'skill' } })).total).toBe(0);
    expect((await listSkills({})).items.map((s) => s.slug)).toEqual(['beta']);

    // Apagar a skill tira o membro; apagar o vMCP tira o vínculo, e o catálogo fica.
    await deleteSkill('beta', SOURCE, ana);
    expect((await getCatalogByUuid(extrasUuid))?.skills).toEqual([]);
    await deleteVirtualMcp(mcpUuid, SOURCE, ana);
    const extras = await getCatalogByUuid(extrasUuid);
    expect(extras?.mcps).toEqual([]);
    expect(extras?.mcpCount).toBe(0);
    expect((await stats()).unlinkedSkills).toBe(3);

    // O CHECK aceita as três ações novas e continua recusando o que não está na lista.
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source, actor_label, target_label)
         VALUES ('catalog.inventada', 'web-admin', 'x', 'y')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);
  });

  it('re-executar o 016 sobre o resultado não faz nada', async () => {
    // Apagar do histórico é o que força o runner a rodar o arquivo de novo;
    // nada do que já existe muda com a segunda passada.
    const catalogoAntes = await getCatalogByUuid(extrasUuid);
    const skillsAntes = await listSkills({ visibility: 'all' });
    await raw.query("DELETE FROM schema_migrations WHERE name = '016-catalogos.sql'");
    expect(await runMigrations(url!)).toEqual(['016-catalogos.sql']);
    expect(await getCatalogByUuid(extrasUuid)).toEqual(catalogoAntes);
    expect(await listSkills({ visibility: 'all' })).toEqual(skillsAntes);
    const { rows } = await raw.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM pg_constraint WHERE conname = 'virtual_mcp_catalogs_pos_pair_chk')::int
            + (SELECT count(*) FROM pg_constraint WHERE conname = 'audit_log_action_check')::int AS n`,
    );
    expect(rows[0]?.n).toBe(2);
  });

  // --------------------------------------------------- clonagem (031) ------

  it('clona o catálogo: membros com o is_active de cada participação, cópia privada e sem vínculo', async () => {
    // **Depois** da re-execução do `016`, de propósito: ela reescreveu o CHECK
    // de `audit_log.action` com a lista da época dela, e as três ações de
    // clonagem (`031`) saíram junto — é o efeito que o README descreve em
    // "Reaplicar migration antiga". Reaplicar a `031` as devolve, e de quebra
    // prova que ela é idempotente.
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source, actor_label, target_label)
         VALUES ('catalog.clone', 'web-admin', 'x', 'a -> b')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);
    await raw.query("DELETE FROM schema_migrations WHERE name = '031-clonagem.sql'");
    expect(await runMigrations(url!)).toEqual(['031-clonagem.sql']);

    // A fonte: pública, com três membros — um deles com a participação
    // desativada — e vinculada a um servidor, com uma concessão.
    const fonte = await createCatalog(
      { name: 'Fonte do Clone', description: 'a fonte', isPublic: true, ownerUserUuid: anaUuid },
      SOURCE,
      ana,
    );
    const servidor = await createVirtualMcp(
      { name: 'Servidor do Clone', isOpen: true, ownerUserUuid: anaUuid },
      SOURCE,
      ana,
    );
    await setCatalogSkills(
      fonte.uuid,
      [{ slug: 'alfa' }, { slug: 'gama' }, { slug: 'delta', isActive: false }],
      SOURCE,
      ana,
    );
    await linkCatalog(servidor.uuid, fonte.uuid, TOOLS, SOURCE, ana);
    await setCatalogGrant('fonte-do-clone', brunoUuid, 'view', SOURCE, ana);

    const antes = await auditedRows();
    const copia = await cloneCatalog(fonte.uuid, { ownerUserUuid: brunoUuid }, SOURCE, {
      userUuid: brunoUuid,
      label: 'bruno@exemplo.dev',
    });

    expect(copia).toMatchObject({
      // O desempate sai do slug do original.
      slug: 'fonte-do-clone-2',
      name: 'Fonte do Clone',
      description: 'a fonte',
      // Ligado como o original; fechado, mesmo com o original público.
      isActive: true,
      isPublic: false,
      ownerUserUuid: brunoUuid,
      ownerEmail: 'bruno@exemplo.dev',
      viewCount: 0,
      downloadCount: 0,
      skillCount: 3,
      activeSkillCount: 2,
      mcpCount: 0,
    });
    // Os mesmos membros, apontando para as mesmas skills, com o `is_active`
    // da participação preservado um a um.
    expect(copia.skills.map((s) => [s.slug, s.isActive])).toEqual([
      ['alfa', true],
      ['delta', false],
      ['gama', true],
    ]);
    // Nada de vínculo com vMCP nem de concessão herdada.
    expect(copia.mcps).toEqual([]);
    expect(copia.grants).toEqual([]);
    // E o original ficou como estava.
    const original = await getCatalogByUuid(fonte.uuid);
    expect(original?.isPublic).toBe(true);
    expect(original?.mcps.map((m) => m.slug)).toEqual(['servidor-do-clone']);
    expect(original?.grants.map((g) => g.email)).toEqual(['bruno@exemplo.dev']);

    // Uma linha só na trilha, com os dois lados no alvo e sem `catalog.create`.
    expect(await auditedRows()).toBe(antes + 1);
    const clonagem = (await listAuditPage({ action: 'catalog.clone' })).items;
    expect(clonagem).toHaveLength(1);
    expect(clonagem[0]).toMatchObject({
      skillUuid: null,
      skillSlug: null,
      targetLabel: 'fonte-do-clone -> fonte-do-clone-2',
      actorUserUuid: brunoUuid,
      actorLabel: 'bruno@exemplo.dev',
    });

    // O segundo clone é `-3`; o nome pedido não mexe no desempate.
    const terceiro = await cloneCatalog(fonte.uuid, { name: 'Outro rótulo' }, SOURCE, ana);
    expect([terceiro.slug, terceiro.name, terceiro.ownerUserUuid]).toEqual([
      'fonte-do-clone-3',
      'Outro rótulo',
      null,
    ]);

    // Slug pedido: livre grava, ocupado é 409, inválido é 400.
    expect((await cloneCatalog(fonte.uuid, { slug: 'copia-do-grupo' }, SOURCE, ana)).slug).toBe(
      'copia-do-grupo',
    );
    const ocupado = await capture(
      cloneCatalog(fonte.uuid, { slug: 'fonte-do-clone-2' }, SOURCE, ana),
    );
    expect([ocupado.status, ocupado.message]).toEqual([
      409,
      'Já existe um catálogo com o slug "fonte-do-clone-2"',
    ]);
    expect((await capture(cloneCatalog(fonte.uuid, { slug: 'Com Espaço' }, SOURCE, ana))).status).toBe(400);
    expect((await capture(cloneCatalog('torto', {}, SOURCE, ana))).status).toBe(404);
    expect(
      (await capture(cloneCatalog('00000000-0000-0000-0000-000000000000', {}, SOURCE, ana))).status,
    ).toBe(404);
    expect(
      (await capture(cloneCatalog(fonte.uuid, { ownerUserUuid: 'torto' }, SOURCE, ana))).status,
    ).toBe(404);
  });
});
