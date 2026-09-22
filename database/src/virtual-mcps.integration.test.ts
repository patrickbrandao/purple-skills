/**
 * Teste de integração do MCP virtual — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/virtual-mcps.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import { VIRTUAL_MCP_PREVIEW_SIZE } from '@purple-skills/shared';
import { AppError } from './errors.js';
import {
  cloneVirtualMcp,
  createCatalog,
  createSkill,
  createUser,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteCatalog,
  deleteSkill,
  deleteVirtualMcp,
  getSkillDetail,
  getSkillSummary,
  getVirtualMcp,
  getVirtualMcpByUuid,
  getVirtualMcpKeyByPrefix,
  incrementDownloadCount,
  incrementViewCount,
  linkCatalog,
  linkSkill,
  listAudit,
  listAuditPage,
  listPublishedSkills,
  listSkills,
  listTags,
  listVirtualMcpKeys,
  listVirtualMcpKeysByCreator,
  listVirtualMcps,
  recordAccountAudit,
  resolveDefaultVirtualMcp,
  resolveVirtualMcp,
  revokeVirtualMcpKey,
  setDefaultVirtualMcp,
  setVirtualMcpCanvas,
  setVirtualMcpGrant,
  setVirtualMcpSkills,
  touchVirtualMcpKey,
  unlinkSkill,
  updateCatalog,
  updateSkill,
  updateSkillWithContent,
  updateVirtualMcp,
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
let privadaUuid = '';
let canvasUuid = '';

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

describe.skipIf(!url)('MCP virtual: recorte, vínculos e chaves', () => {
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

    anaUuid = (await createUser({ username: 'ana', email: 'ana@exemplo.dev', name: 'Ana', role: 'admin' })).uuid;
    brunoUuid = (await createUser({ username: 'bruno', email: 'bruno@exemplo.dev', name: 'Bruno', role: 'editor' }))
      .uuid;

    // Catálogo: três skills flutuantes — nenhuma está em servidor nenhum
    // até o vínculo. Os nomes vêm do desenho anterior e continuam úteis: a
    // "privada" é a que só existe dentro deste vMCP.
    await createSkill(
      { name: 'Publica', slug: 'publica', skillMd: '# publica', tags: ['comum', 'so-publica'] },
      SOURCE,
    );
    privadaUuid = (
      await createSkill(
        { name: 'Privada', slug: 'privada', skillMd: '# privada', tags: ['comum', 'so-privada'] },
        SOURCE,
      )
    ).uuid;
    await createSkill({ name: 'Fora', slug: 'fora', skillMd: '# fora', tags: ['comum'] }, SOURCE);
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  const ana = { userUuid: '', label: 'ana@exemplo.dev' };

  it('cria o MCP com slug gerado, dono e auditoria', async () => {
    ana.userUuid = anaUuid;

    const mcp = await createVirtualMcp(
      { name: 'Time de Dados', description: 'só o time', ownerUserUuid: brunoUuid },
      SOURCE,
      ana,
    );
    mcpUuid = mcp.uuid;

    expect(mcp.slug).toBe('time-de-dados');
    expect(mcp.isActive).toBe(true);
    expect(mcp.isOpen).toBe(false);
    expect(mcp.ownerUserUuid).toBe(brunoUuid);
    expect(mcp.ownerUsername).toBe('bruno');
    expect(mcp.skillCount).toBe(0);
    expect(mcp.activeKeyCount).toBe(0);
    // Sem `settings` preenchida, ninguém é o padrão.
    expect(mcp.isDefault).toBe(false);
    expect(mcp.skills).toEqual([]);

    // Segundo com o mesmo nome ganha sufixo; slug explícito em uso é conflito.
    const segundo = await createVirtualMcp(
      { name: 'Time de Dados', ownerUserUuid: null },
      SOURCE,
      ana,
    );
    expect(segundo.slug).toBe('time-de-dados-2');
    expect(segundo.ownerUserUuid).toBeNull();
    expect(segundo.ownerUsername).toBeNull();

    const conflito = await capture(
      createVirtualMcp({ name: 'Outro', slug: 'time-de-dados', ownerUserUuid: null }, SOURCE, ana),
    );
    expect(conflito.status).toBe(409);
    expect(conflito.message).toMatch(/Já existe um MCP virtual com o slug/);

    const invalido = await capture(
      createVirtualMcp({ name: 'Outro', slug: 'Com Espaço', ownerUserUuid: null }, SOURCE, ana),
    );
    expect(invalido.status).toBe(400);

    const semNome = await capture(createVirtualMcp({ name: '  ', ownerUserUuid: null }, SOURCE, ana));
    expect(semNome.status).toBe(400);

    const linha = (await listAudit(20)).find(
      (e) => e.action === 'mcp.create' && e.targetLabel === 'time-de-dados',
    );
    expect(linha?.skillUuid).toBeNull();
    expect(linha?.actorUserUuid).toBe(anaUuid);
    expect(linha?.actorLabel).toBe('ana@exemplo.dev');

    await deleteVirtualMcp(segundo.uuid, SOURCE, ana);
    expect(await getVirtualMcpByUuid(segundo.uuid)).toBeNull();
  });

  it('lista todos para o admin, só os do dono para o editor, nenhum para o bootstrap', async () => {
    expect((await listVirtualMcps()).map((m) => m.slug)).toEqual(['time-de-dados']);
    expect((await listVirtualMcps({ ownerUserUuid: brunoUuid })).map((m) => m.slug)).toEqual([
      'time-de-dados',
    ]);
    expect(await listVirtualMcps({ ownerUserUuid: anaUuid })).toEqual([]);
    expect(await listVirtualMcps({ ownerUserUuid: null })).toEqual([]);
  });

  it('define o recorte de forma declarativa, preservando contadores de quem ficou', async () => {
    const primeiro = await setVirtualMcpSkills(
      mcpUuid,
      [
        { slug: 'privada', asSkill: true, asPrompt: true, asResource: false },
        { slug: 'publica', asSkill: true, asPrompt: false, asResource: true },
      ],
      SOURCE,
      ana,
    );
    expect(primeiro.skills.map((s) => s.slug)).toEqual(['privada', 'publica']);
    expect(primeiro.skillCount).toBe(2);

    // Contador do vínculo E o global da skill.
    await incrementViewCount(privadaUuid, mcpUuid);
    await incrementViewCount(privadaUuid, mcpUuid);
    await incrementDownloadCount(privadaUuid, mcpUuid);

    const privadaNoMcp = (await getVirtualMcpByUuid(mcpUuid))!.skills.find(
      (s) => s.slug === 'privada',
    );
    expect(privadaNoMcp?.viewCount).toBe(2);
    expect(privadaNoMcp?.downloadCount).toBe(1);
    const privadaGlobal = await getSkillSummary('privada', { visibility: 'all' });
    expect(privadaGlobal?.viewCount).toBe(2);
    expect(privadaGlobal?.downloadCount).toBe(1);

    // Sem o MCP, soma só no global.
    await incrementViewCount(privadaUuid);
    expect((await getSkillSummary('privada', { visibility: 'all' }))?.viewCount).toBe(3);
    expect(
      (await getVirtualMcpByUuid(mcpUuid))!.skills.find((s) => s.slug === 'privada')?.viewCount,
    ).toBe(2);

    // Re-salvar: `publica` sai, `privada` fica com as flags trocadas e os
    // contadores intactos, `fora` entra.
    const segundo = await setVirtualMcpSkills(
      mcpUuid,
      [
        { slug: 'privada', asSkill: true, asPrompt: false, asResource: true },
        { slug: 'fora', asSkill: false, asPrompt: true, asResource: false },
      ],
      SOURCE,
      ana,
    );
    expect(segundo.skills.map((s) => s.slug)).toEqual(['fora', 'privada']);
    const privadaDepois = segundo.skills.find((s) => s.slug === 'privada');
    expect(privadaDepois?.asPrompt).toBe(false);
    expect(privadaDepois?.asResource).toBe(true);
    expect(privadaDepois?.viewCount).toBe(2);
    expect(privadaDepois?.downloadCount).toBe(1);
    expect(segundo.skills.find((s) => s.slug === 'fora')?.viewCount).toBe(0);

    // Slug desconhecido e slug repetido são erro do cliente; nada muda.
    const desconhecido = await capture(
      setVirtualMcpSkills(
        mcpUuid,
        [{ slug: 'nao-existe', asSkill: true, asPrompt: false, asResource: false }],
        SOURCE,
        ana,
      ),
    );
    expect(desconhecido.status).toBe(400);
    expect(desconhecido.message).toMatch(/nao-existe/);

    const repetido = await capture(
      setVirtualMcpSkills(
        mcpUuid,
        [
          { slug: 'privada', asSkill: true, asPrompt: false, asResource: false },
          { slug: 'privada', asSkill: false, asPrompt: false, asResource: false },
        ],
        SOURCE,
        ana,
      ),
    );
    expect(repetido.status).toBe(400);

    const semFlag = await capture(
      setVirtualMcpSkills(
        mcpUuid,
        [{ slug: 'privada', asSkill: true } as never],
        SOURCE,
        ana,
      ),
    );
    expect(semFlag.status).toBe(400);

    expect((await getVirtualMcpByUuid(mcpUuid))!.skills.map((s) => s.slug)).toEqual([
      'fora',
      'privada',
    ]);

    // A skill enxerga os próprios vínculos, com as flags e o estado do vMCP.
    // Vínculo direto: `direct` e nenhum catálogo no caminho; e a skill não
    // está em catálogo nenhum.
    const privadaLida = await getSkillSummary('privada', { visibility: 'all' });
    expect(privadaLida?.mcps).toEqual([
      {
        uuid: mcpUuid,
        slug: 'time-de-dados',
        name: 'Time de Dados',
        isOpen: false,
        isActive: true,
        isDefault: false,
        asSkill: true,
        asPrompt: false,
        asResource: true,
        direct: true,
        catalogs: [],
      },
    ]);
    expect(privadaLida?.catalogs).toEqual([]);
    expect(privadaLida?.isActive).toBe(true);
  });

  it('recorta as leituras pelo vínculo, e o site só enxerga vMCP aberto e ligado', async () => {
    // Estado: privada (as_skill, as_resource), fora (as_prompt). `publica` está de fora.
    const skill = { uuid: mcpUuid, surface: 'skill' as const };

    const lista = await listSkills({ virtualMcp: skill });
    expect(lista.total).toBe(1);
    expect(lista.items.map((s) => s.slug)).toEqual(['privada']);

    // `visibility` não tem efeito com o recorte.
    const forcado = await listSkills({ virtualMcp: skill, visibility: 'open' });
    expect(forcado.items.map((s) => s.slug)).toEqual(['privada']);

    expect((await getSkillSummary('privada', { virtualMcp: skill }))?.slug).toBe('privada');
    expect((await getSkillDetail('privada', { virtualMcp: skill }))?.skillMd).toBe('# privada');
    expect(await getSkillSummary('publica', { virtualMcp: skill })).toBeNull();
    expect(await getSkillSummary('fora', { virtualMcp: skill })).toBeNull();
    expect(
      await getSkillSummary('fora', { virtualMcp: { uuid: mcpUuid, surface: 'prompt' } }),
    ).not.toBeNull();

    // Tags contam só as vinculadas com `as_skill`.
    const tags = await listTags({ virtualMcp: skill });
    expect(tags).toEqual([
      { name: 'comum', count: 1 },
      { name: 'so-privada', count: 1 },
    ]);

    // Filtro por tag dentro do recorte.
    expect((await listSkills({ virtualMcp: skill, tag: 'so-publica' })).total).toBe(0);

    // UUID torto não estoura: é "nenhuma skill".
    expect((await listSkills({ virtualMcp: { uuid: 'torto', surface: 'skill' } })).total).toBe(0);
    expect(await listTags({ virtualMcp: { uuid: 'torto', surface: 'skill' } })).toEqual([]);

    // Sem o recorte: o vMCP está fechado, então o site (`'open'`) não vê
    // nenhuma das três; o painel (`'all'`) vê tudo, inclusive a flutuante.
    expect((await listSkills({ visibility: 'open' })).total).toBe(0);
    expect((await listSkills({})).total).toBe(0);
    expect((await listTags({ visibility: 'open' })).length).toBe(0);
    expect(
      (await listSkills({ visibility: 'all' })).items.map((s) => s.slug).sort(),
    ).toEqual(['fora', 'privada', 'publica']);
    expect(await getSkillSummary('privada')).toBeNull();
    expect((await getSkillSummary('privada', { visibility: 'all' }))?.slug).toBe('privada');
  });

  it('lista prompts e resources do MCP pela flag do vínculo', async () => {
    const prompts = await listPublishedSkills('prompt', mcpUuid);
    expect(prompts.map((s) => s.slug)).toEqual(['fora']);

    const resources = await listPublishedSkills('resource', mcpUuid);
    expect(resources.map((s) => s.slug)).toEqual(['privada']);

    expect(await listPublishedSkills('prompt', 'torto')).toEqual([]);
  });

  it('emite, resolve pelo prefixo e revoga uma chave restrita ao MCP', async () => {
    const chave = await createVirtualMcpKey({
      virtualMcpUuid: mcpUuid,
      name: 'agente-de-dados',
      prefix: 'vvv12345',
      keyHash: 'scrypt$hash-da-chave',
      createdByUserUuid: brunoUuid,
    });
    expect(chave.virtualMcpUuid).toBe(mcpUuid);
    expect(chave.createdByUserUuid).toBe(brunoUuid);
    expect(chave.revokedAt).toBeNull();
    expect((await getVirtualMcpByUuid(mcpUuid))?.activeKeyCount).toBe(1);

    const achada = await getVirtualMcpKeyByPrefix('vvv12345');
    expect(achada?.id).toBe(chave.id);
    expect(achada?.virtualMcpUuid).toBe(mcpUuid);
    expect(achada?.keyHash).toBe('scrypt$hash-da-chave');
    expect(await getVirtualMcpKeyByPrefix('nao-existe')).toBeNull();

    await touchVirtualMcpKey(chave.id);
    expect((await listVirtualMcpKeys(mcpUuid))[0]?.lastUsedAt).not.toBeNull();

    // Outro MCP não revoga a chave deste.
    const outro = await createVirtualMcp({ name: 'Outro', ownerUserUuid: null }, SOURCE, ana);
    expect(await revokeVirtualMcpKey(chave.id, outro.uuid)).toBeNull();
    expect((await listVirtualMcpKeys(mcpUuid))[0]?.revokedAt).toBeNull();

    // A revogação devolve o nome e o prefixo (`tasks/040`): é com eles que o app
    // rotula o `mcp.key.revoke` como rotulou a emissão. O uuid da chave não
    // aparece em tela nenhuma e some com o vMCP (`CASCADE`), então uma linha que
    // só o guardasse ficaria sem referente.
    expect(await revokeVirtualMcpKey(chave.id, mcpUuid)).toEqual({
      name: 'agente-de-dados',
      prefix: 'vvv12345',
    });
    const dataDaRevogacao = (await listVirtualMcpKeys(mcpUuid))[0]?.revokedAt;
    expect(dataDaRevogacao).not.toBeNull();
    // Idempotente: `null` na segunda vez, sem reescrever o `revoked_at` original.
    expect(await revokeVirtualMcpKey(chave.id, mcpUuid)).toBeNull();
    expect(await revokeVirtualMcpKey('nao-e-uuid', mcpUuid)).toBeNull();
    expect((await listVirtualMcpKeys(mcpUuid))[0]?.revokedAt).toBe(dataDaRevogacao);
    expect((await getVirtualMcpByUuid(mcpUuid))?.activeKeyCount).toBe(0);

    const inexistente = await capture(
      createVirtualMcpKey({
        virtualMcpUuid: '00000000-0000-0000-0000-000000000000',
        name: 'orfa',
        prefix: 'vvv99999',
        keyHash: 'x',
        createdByUserUuid: null,
      }),
    );
    expect(inexistente.status).toBe(404);

    // A auditoria da chave é do app, por `recordAccountAudit`.
    await recordAccountAudit({
      action: 'mcp.key.revoke',
      source: SOURCE,
      actor: ana,
      targetLabel: 'agente-de-dados',
    });
    const linha = (await listAudit(20)).find((e) => e.action === 'mcp.key.revoke');
    expect(linha?.targetLabel).toBe('agente-de-dados');

    await deleteVirtualMcp(outro.uuid, SOURCE, ana);
  });

  it('lista as chaves emitidas por uma conta, ativas primeiro, com o servidor', async () => {
    const emissor = await createVirtualMcp({ name: 'Emissor', ownerUserUuid: null }, SOURCE, ana);
    const emitir = (name: string, prefix: string, createdByUserUuid: string) =>
      createVirtualMcpKey({
        virtualMcpUuid: emissor.uuid,
        name,
        prefix,
        keyHash: 'scrypt$nao-deve-sair',
        createdByUserUuid,
      });
    await emitir('b-velha', 'vvvb0001', brunoUuid);
    const revogada = await emitir('b-revogada', 'vvvb0002', brunoUuid);
    await emitir('b-nova', 'vvvb0003', brunoUuid);
    await emitir('a-unica', 'vvva0001', anaUuid);
    expect(await revokeVirtualMcpKey(revogada.id, emissor.uuid)).toMatchObject({ name: 'b-revogada' });

    // A `agente-de-dados` do caso anterior é do Bruno, revogada e mais velha.
    const doBruno = await listVirtualMcpKeysByCreator(brunoUuid);
    expect(doBruno.map((k) => k.name)).toEqual([
      'b-nova',
      'b-velha',
      'b-revogada',
      'agente-de-dados',
    ]);
    expect(doBruno.every((k) => k.createdByUserUuid === brunoUuid)).toBe(true);
    expect(doBruno[0]).toMatchObject({
      virtualMcpUuid: emissor.uuid,
      virtualMcpSlug: emissor.slug,
      virtualMcpName: 'Emissor',
      revokedAt: null,
    });
    expect(doBruno[3]).toMatchObject({
      virtualMcpUuid: mcpUuid,
      virtualMcpSlug: 'time-de-dados',
      virtualMcpName: 'Time de Dados',
    });
    expect(doBruno[2]?.revokedAt).not.toBeNull();
    // Nunca o hash.
    expect(doBruno.some((k) => 'keyHash' in k)).toBe(false);

    expect((await listVirtualMcpKeysByCreator(anaUuid)).map((k) => k.name)).toEqual(['a-unica']);
    expect(await listVirtualMcpKeysByCreator('torto')).toEqual([]);
    expect(await listVirtualMcpKeysByCreator('00000000-0000-0000-0000-000000000000')).toEqual([]);

    // O índice do `021` existe.
    const { rows } = await raw.query(
      `SELECT 1 FROM pg_indexes WHERE indexname = 'virtual_mcp_keys_created_by_created_idx'`,
    );
    expect(rows).toHaveLength(1);

    // Servidor apagado leva as chaves junto (CASCADE).
    await deleteVirtualMcp(emissor.uuid, SOURCE, ana);
    expect((await listVirtualMcpKeysByCreator(brunoUuid)).map((k) => k.name)).toEqual([
      'agente-de-dados',
    ]);
    expect(await listVirtualMcpKeysByCreator(anaUuid)).toEqual([]);
  });

  it('atualiza parcialmente, renomeia e some do runtime quando inativo', async () => {
    expect((await resolveVirtualMcp('time-de-dados'))?.uuid).toBe(mcpUuid);

    const renomeado = await updateVirtualMcp(
      mcpUuid,
      { slug: 'dados', isOpen: true, ownerUserUuid: null },
      SOURCE,
      ana,
    );
    expect(renomeado.slug).toBe('dados');
    expect(renomeado.isOpen).toBe(true);
    expect(renomeado.ownerUserUuid).toBeNull();
    expect(renomeado.name).toBe('Time de Dados');
    expect(renomeado.description).toBe('só o time');

    expect(await resolveVirtualMcp('time-de-dados')).toBeNull();
    const runtime = await resolveVirtualMcp('dados');
    expect(runtime).toEqual({
      uuid: mcpUuid,
      slug: 'dados',
      name: 'Time de Dados',
      description: 'só o time',
      isOpen: true,
    });

    // Aberto: as vinculadas (qualquer flag) passam a existir para o site; a
    // sem vínculo (`publica`) continua flutuante. A leitura pública só vê os
    // vínculos abertos, e as tags contam só o que está lá.
    const noSite = await listSkills({ visibility: 'open' });
    expect(noSite.items.map((s) => s.slug).sort()).toEqual(['fora', 'privada']);
    expect((await getSkillSummary('fora'))?.mcps.map((m) => [m.slug, m.isOpen])).toEqual([
      ['dados', true],
    ]);
    expect(await getSkillSummary('publica')).toBeNull();
    expect((await listTags({})).map((t) => [t.name, t.count])).toEqual([
      ['comum', 2],
      ['so-privada', 1],
    ]);

    const auditoria = (await listAudit(20)).find(
      (e) => e.action === 'mcp.update' && e.targetLabel === 'dados',
    );
    expect(auditoria).toBeDefined();

    const desligado = await updateVirtualMcp(mcpUuid, { isActive: false }, SOURCE, ana);
    expect(desligado.isActive).toBe(false);
    expect(await resolveVirtualMcp('dados')).toBeNull();
    // Desligado, some do site mesmo aberto.
    expect((await listSkills({ visibility: 'open' })).total).toBe(0);
    // O painel continua enxergando, com os vínculos e as chaves.
    expect((await getVirtualMcp('dados'))?.skillCount).toBe(2);
    expect(await listVirtualMcpKeys(mcpUuid)).toHaveLength(1);

    const invalido = await capture(updateVirtualMcp(mcpUuid, { slug: 'Não!' }, SOURCE, ana));
    expect(invalido.status).toBe(400);
    const vazio = await capture(updateVirtualMcp(mcpUuid, { name: ' ' }, SOURCE, ana));
    expect(vazio.status).toBe(400);
    const fantasma = await capture(
      updateVirtualMcp('00000000-0000-0000-0000-000000000000', { name: 'x' }, SOURCE, ana),
    );
    expect(fantasma.status).toBe(404);
  });

  it('remove em cascata vínculos e chaves', async () => {
    await deleteVirtualMcp(mcpUuid, SOURCE, ana);
    expect(await getVirtualMcpByUuid(mcpUuid)).toBeNull();
    expect(await listVirtualMcpKeys(mcpUuid)).toEqual([]);
    expect((await getSkillSummary('privada', { visibility: 'all' }))?.mcps).toEqual([]);

    const { rows } = await raw.query<{ n: string }>(
      'SELECT count(*) AS n FROM virtual_mcp_skills WHERE virtual_mcp_uuid = $1',
      [mcpUuid],
    );
    expect(Number(rows[0]?.n)).toBe(0);

    const denovo = await capture(deleteVirtualMcp(mcpUuid, SOURCE, ana));
    expect(denovo.status).toBe(404);

    const linha = (await listAudit(20)).find((e) => e.action === 'mcp.delete');
    expect(linha?.targetLabel).toBe('dados');
  });

  // ------------------------------------------------- ícone e canvas (013/014) --

  it('grava o ícone pela regra de shared e o devolve no resumo; inválido é 400', async () => {
    const criada = await createSkill(
      { name: 'Com ícone', slug: 'com-icone', skillMd: '# icone', icon: ' 🐘 ' },
      SOURCE,
    );
    expect(criada.icon).toBe('🐘');
    expect((await getSkillSummary('com-icone', { visibility: 'all' }))?.icon).toBe('🐘');
    expect((await listSkills({ visibility: 'all', query: 'ícone' })).items[0]?.icon).toBe('🐘');
    // Quem nasceu sem ícone tem nulo — e cai no monograma.
    expect((await getSkillSummary('publica', { visibility: 'all' }))?.icon).toBeNull();

    const url = await updateSkill('com-icone', { icon: 'https://exemplo.dev/logo.png' }, SOURCE);
    expect(url.icon).toBe('https://exemplo.dev/logo.png');
    // `undefined` não mexe; vazio (ou `null`) apaga.
    expect((await updateSkill('com-icone', { name: 'Com ícone!' }, SOURCE)).icon).toBe(
      'https://exemplo.dev/logo.png',
    );
    expect((await updateSkillWithContent('com-icone', { icon: '' }, SOURCE)).icon).toBeNull();
    expect((await updateSkill('com-icone', { icon: '👩‍💻' }, SOURCE)).icon).toBe('👩‍💻');
    expect((await updateSkill('com-icone', { icon: null }, SOURCE)).icon).toBeNull();

    const criarInvalido = await capture(
      createSkill({ name: 'Sem chance', skillMd: '# x', icon: 'abc' }, SOURCE),
    );
    expect(criarInvalido.status).toBe(400);
    expect(criarInvalido.message).toMatch(/emoji/);
    expect(await getSkillSummary('sem-chance', { visibility: 'all' })).toBeNull();

    const doisEmojis = await capture(updateSkill('com-icone', { icon: '🐘🚀' }, SOURCE));
    expect(doisEmojis.status).toBe(400);
    const esquema = await capture(
      updateSkillWithContent('com-icone', { icon: 'ftp://x/y.png', skillMd: '# não' }, SOURCE),
    );
    expect(esquema.status).toBe(400);
    expect((await getSkillDetail('com-icone', { visibility: 'all' }))?.skillMd).toBe('# icone');
    const tipoErrado = await capture(updateSkill('com-icone', { icon: 42 as never }, SOURCE));
    expect(tipoErrado.status).toBe(400);

    // O CHECK do banco é a última linha de defesa contra uma URL sem fim.
    await expect(
      raw.query("UPDATE skills SET icon = repeat('a', 513) WHERE slug = 'com-icone'"),
    ).rejects.toThrow(/skills_icon_length_chk/);

    await updateSkill('com-icone', { icon: '🐘' }, SOURCE);
  });

  it('conta por porta, monta o preview e lê posições e layout do canvas', async () => {
    const canvas = await createVirtualMcp({ name: 'Canvas', ownerUserUuid: null }, SOURCE, ana);
    canvasUuid = canvas.uuid;
    expect(canvas).toMatchObject({
      toolCount: 0,
      promptCount: 0,
      resourceCount: 0,
      onlineSessions: 0,
      preview: [],
      layout: {},
    });

    const recorte = await setVirtualMcpSkills(
      canvasUuid,
      [
        { slug: 'com-icone', asSkill: true, asPrompt: true, asResource: false },
        { slug: 'privada', asSkill: true, asPrompt: false, asResource: true },
        { slug: 'fora', asSkill: false, asPrompt: false, asResource: false },
      ],
      SOURCE,
      ana,
    );
    expect(recorte.skillCount).toBe(3);
    expect(recorte.toolCount).toBe(2);
    expect(recorte.promptCount).toBe(1);
    expect(recorte.resourceCount).toBe(1);
    // O preview vem por nome, com o ícone de cada uma.
    expect(recorte.preview).toEqual([
      { slug: 'com-icone', name: 'Com ícone!', icon: '🐘' },
      { slug: 'fora', name: 'Fora', icon: null },
      { slug: 'privada', name: 'Privada', icon: null },
    ]);
    // Ícone na skill do vMCP; posições nascem nulas (auto-layout).
    expect(recorte.skills.find((s) => s.slug === 'com-icone')?.icon).toBe('🐘');
    expect(recorte.skills.map((s) => s.position)).toEqual([null, null, null]);

    // A listagem traz os mesmos contadores e o preview.
    const listado = (await listVirtualMcps()).find((m) => m.uuid === canvasUuid);
    expect(listado?.toolCount).toBe(2);
    expect(listado?.promptCount).toBe(1);
    expect(listado?.resourceCount).toBe(1);
    expect(listado?.preview.map((p) => p.slug)).toEqual(['com-icone', 'fora', 'privada']);

    // Teto de `VIRTUAL_MCP_PREVIEW_SIZE` (19, a colmeia do card) no preview:
    // o `skillCount` continua contando tudo.
    const zz = (i: number) => String(i).padStart(2, '0');
    for (let i = 1; i <= 18; i += 1) {
      await createSkill({ name: `Zz ${zz(i)}`, slug: `zz-${zz(i)}`, skillMd: '# z' }, SOURCE);
      await linkSkill(`zz-${zz(i)}`, canvasUuid, { asSkill: false, asPrompt: false, asResource: false }, SOURCE, ana);
    }
    const cheio = (await getVirtualMcpByUuid(canvasUuid))!;
    expect(cheio.skillCount).toBe(21);
    expect(cheio.preview).toHaveLength(VIRTUAL_MCP_PREVIEW_SIZE);
    expect(cheio.preview.map((p) => p.slug)).toEqual([
      'com-icone', 'fora', 'privada',
      ...Array.from({ length: 16 }, (_, i) => `zz-${zz(i + 1)}`),
    ]);
    for (let i = 1; i <= 18; i += 1) await deleteSkill(`zz-${zz(i)}`, SOURCE);
    expect((await getVirtualMcpByUuid(canvasUuid))?.skillCount).toBe(3);

    // Os catálogos vinculados entram na mesma colmeia: por nome, com o
    // `is_active` do catálogo, e com o mesmo teto. Um catálogo não vinculado
    // fica de fora; `catalogCount` acompanha.
    expect(cheio.previewCatalogs).toEqual([]);
    const catalogos: string[] = [];
    for (let i = 1; i <= 20; i += 1) {
      const catalogo = await createCatalog(
        { name: `Cat ${zz(i)}`, slug: `cat-${zz(i)}`, ownerUserUuid: null },
        SOURCE,
        ana,
      );
      catalogos.push(catalogo.uuid);
      if (i <= 19) await linkCatalog(canvasUuid, catalogo.uuid, { asSkill: true, asPrompt: false, asResource: false }, SOURCE, ana);
    }
    await updateCatalog(catalogos[1]!, { isActive: false }, SOURCE, ana);
    const comCatalogos = (await getVirtualMcpByUuid(canvasUuid))!;
    expect(comCatalogos.catalogCount).toBe(19);
    expect(comCatalogos.previewCatalogs).toHaveLength(VIRTUAL_MCP_PREVIEW_SIZE);
    expect(comCatalogos.previewCatalogs.slice(0, 3)).toEqual([
      { slug: 'cat-01', name: 'Cat 01', isActive: true },
      { slug: 'cat-02', name: 'Cat 02', isActive: false },
      { slug: 'cat-03', name: 'Cat 03', isActive: true },
    ]);
    expect(comCatalogos.previewCatalogs.map((c) => c.slug)).not.toContain('cat-20');
    // A listagem traz o mesmo.
    const listadoComCatalogos = (await listVirtualMcps()).find((m) => m.uuid === canvasUuid);
    expect(listadoComCatalogos?.previewCatalogs).toEqual(comCatalogos.previewCatalogs);
    for (const uuid of catalogos) await deleteCatalog(uuid, SOURCE, ana);
    expect((await getVirtualMcpByUuid(canvasUuid))?.previewCatalogs).toEqual([]);
  });

  it('grava o canvas: layout mesclado e posições por skill, sem auditar; slug não vinculado é 400', async () => {
    const antes = (await getVirtualMcpByUuid(canvasUuid))!;
    const auditadas = async () =>
      Number((await raw.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0]?.n);
    const linhasAntes = await auditadas();

    await setVirtualMcpCanvas(canvasUuid, {
      layout: { server: { x: 10.4, y: 20.6 } },
      positions: [{ slug: 'privada', x: 100, y: 200.5 }],
    });
    let detail = (await getVirtualMcpByUuid(canvasUuid))!;
    expect(detail.layout).toEqual({ server: { x: 10, y: 21 } });
    expect(detail.skills.find((s) => s.slug === 'privada')?.position).toEqual({ x: 100, y: 201 });
    expect(detail.skills.find((s) => s.slug === 'fora')?.position).toBeNull();

    // Mescla chave a chave: `internet` entra, `server` fica.
    await setVirtualMcpCanvas(canvasUuid, { layout: { internet: { x: -5, y: 0 } } });
    detail = (await getVirtualMcpByUuid(canvasUuid))!;
    expect(detail.layout).toEqual({ server: { x: 10, y: 21 }, internet: { x: -5, y: 0 } });

    // Estado de tela: nem auditoria nem `updated_at`.
    expect(await auditadas()).toBe(linhasAntes);
    expect(detail.updatedAt).toBe(antes.updatedAt);

    // Slug de skill que existe mas não está neste vMCP: 400 e **nada** gravado,
    // nem o layout nem a posição da que estava certa.
    const naoVinculado = await capture(
      setVirtualMcpCanvas(canvasUuid, {
        layout: { server: { x: 1, y: 1 } },
        positions: [
          { slug: 'privada', x: 1, y: 1 },
          { slug: 'publica', x: 2, y: 2 },
        ],
      }),
    );
    expect(naoVinculado.status).toBe(400);
    expect(naoVinculado.message).toMatch(/publica/);
    detail = (await getVirtualMcpByUuid(canvasUuid))!;
    expect(detail.layout.server).toEqual({ x: 10, y: 21 });
    expect(detail.skills.find((s) => s.slug === 'privada')?.position).toEqual({ x: 100, y: 201 });

    const inexistente = await capture(
      setVirtualMcpCanvas(canvasUuid, { positions: [{ slug: 'nao-existe', x: 0, y: 0 }] }),
    );
    expect(inexistente.status).toBe(400);
    const repetido = await capture(
      setVirtualMcpCanvas(canvasUuid, {
        positions: [
          { slug: 'privada', x: 0, y: 0 },
          { slug: 'privada', x: 1, y: 1 },
        ],
      }),
    );
    expect(repetido.status).toBe(400);

    // Coordenada torta, tipo errado, vMCP inexistente ou uuid torto.
    const nan = await capture(
      setVirtualMcpCanvas(canvasUuid, { layout: { server: { x: Number.NaN, y: 0 } } }),
    );
    expect(nan.status).toBe(400);
    const texto = await capture(
      setVirtualMcpCanvas(canvasUuid, { positions: [{ slug: 'privada', x: '1', y: 2 } as never] }),
    );
    expect(texto.status).toBe(400);
    const chaveTorta = await capture(
      setVirtualMcpCanvas(canvasUuid, { layout: { server: null } as never }),
    );
    expect(chaveTorta.status).toBe(400);
    const fantasma = await capture(
      setVirtualMcpCanvas('00000000-0000-0000-0000-000000000000', { layout: {} }),
    );
    expect(fantasma.status).toBe(404);
    expect((await capture(setVirtualMcpCanvas('torto', { layout: {} }))).status).toBe(404);

    // Lixo no JSON é ignorado na leitura: só `server`/`internet` com `x`/`y` numéricos.
    await raw.query(
      `UPDATE virtual_mcps SET layout = '{"server": {"x": 1, "y": "b"}, "internet": {"x": 3, "y": 4}, "outro": {"x": 1, "y": 1}, "lixo": 42}'::jsonb
        WHERE uuid = $1`,
      [canvasUuid],
    );
    expect((await getVirtualMcpByUuid(canvasUuid))!.layout).toEqual({ internet: { x: 3, y: 4 } });
    // A mescla preserva o que a leitura ignora — o app só grava o que conhece.
    await setVirtualMcpCanvas(canvasUuid, { layout: { server: { x: 9, y: 9 } } });
    const { rows } = await raw.query<{ layout: Record<string, unknown> }>(
      'SELECT layout FROM virtual_mcps WHERE uuid = $1',
      [canvasUuid],
    );
    expect(rows[0]?.layout).toEqual({
      server: { x: 9, y: 9 },
      internet: { x: 3, y: 4 },
      outro: { x: 1, y: 1 },
      lixo: 42,
    });

    // Os CHECKs: o layout precisa ser um objeto, e meio ponto não é ponto.
    await expect(
      raw.query("UPDATE virtual_mcps SET layout = '[]'::jsonb WHERE uuid = $1", [canvasUuid]),
    ).rejects.toThrow(/virtual_mcps_layout_object_chk/);
    await expect(
      raw.query(
        'UPDATE virtual_mcp_skills SET pos_x = 1, pos_y = NULL WHERE virtual_mcp_uuid = $1',
        [canvasUuid],
      ),
    ).rejects.toThrow(/virtual_mcp_skills_pos_pair_chk/);
  });

  it('setVirtualMcpSkills preserva a posição de quem ficou; linkSkill grava a posição só quando informada', async () => {
    // Re-salvar o recorte com flags novas mantém a posição de `privada`; `fora` sai.
    const salvo = await setVirtualMcpSkills(
      canvasUuid,
      [
        { slug: 'privada', asSkill: false, asPrompt: true, asResource: false },
        { slug: 'com-icone', asSkill: true, asPrompt: false, asResource: false },
      ],
      SOURCE,
      ana,
    );
    expect(salvo.skills.map((s) => s.slug)).toEqual(['com-icone', 'privada']);
    const privada = salvo.skills.find((s) => s.slug === 'privada');
    expect(privada?.asPrompt).toBe(true);
    expect(privada?.position).toEqual({ x: 100, y: 201 });

    // Quem saiu levou a posição junto: voltar é entrar sem posição.
    const voltou = await setVirtualMcpSkills(
      canvasUuid,
      [
        { slug: 'privada', asSkill: false, asPrompt: true, asResource: false },
        { slug: 'com-icone', asSkill: true, asPrompt: false, asResource: false },
        { slug: 'fora', asSkill: true, asPrompt: false, asResource: false },
      ],
      SOURCE,
      ana,
    );
    expect(voltou.skills.find((s) => s.slug === 'fora')?.position).toBeNull();
    expect(voltou.skills.find((s) => s.slug === 'privada')?.position).toEqual({ x: 100, y: 201 });

    const flags = { asSkill: true, asPrompt: false, asResource: false };
    const posicaoDe = async (slug: string) =>
      (await getVirtualMcpByUuid(canvasUuid))!.skills.find((s) => s.slug === slug)?.position;

    // Com posição, o INSERT já grava (`publica` entra pelo canvas)…
    await linkSkill('publica', canvasUuid, flags, SOURCE, ana, { position: { x: 7.2, y: 7.8 } });
    expect(await posicaoDe('publica')).toEqual({ x: 7, y: 8 });
    // …reescrever as flags sem posição não zera a existente…
    const reescrita = await linkSkill(
      'publica',
      canvasUuid,
      { ...flags, asPrompt: true },
      SOURCE,
      ana,
    );
    expect(reescrita.mcps.find((m) => m.uuid === canvasUuid)?.asPrompt).toBe(true);
    expect(await posicaoDe('publica')).toEqual({ x: 7, y: 8 });
    // …e com posição, substitui.
    await linkSkill('publica', canvasUuid, flags, SOURCE, ana, { position: { x: 70, y: 80 } });
    expect(await posicaoDe('publica')).toEqual({ x: 70, y: 80 });

    const torta = await capture(
      linkSkill('publica', canvasUuid, flags, SOURCE, ana, { position: { x: 1 } as never }),
    );
    expect(torta.status).toBe(400);
    expect(await posicaoDe('publica')).toEqual({ x: 70, y: 80 });

    // A posição cai junto com o vínculo: desvincular e vincular de novo é auto-layout.
    await unlinkSkill('publica', canvasUuid, SOURCE, ana);
    await linkSkill('publica', canvasUuid, flags, SOURCE, ana);
    expect(await posicaoDe('publica')).toBeNull();

    await deleteVirtualMcp(canvasUuid, SOURCE, ana);
    await deleteSkill('com-icone', SOURCE);
  });

  // --------------------------------------------------- clonagem (031) ------

  it('clona o vMCP: vínculos com portas e posições, concessões e layout; sem chave, sem contador e sem o posto de padrão', async () => {
    const clonadorUuid = (
      await createUser({ username: 'clonador', email: 'clonador@exemplo.dev', name: 'Clonador', role: 'editor' })
    ).uuid;

    // A fonte: aberta, com uma skill vinculada (com contadores), um catálogo
    // vinculado, posições no canvas, layout, duas concessões e uma chave —
    // e ainda por cima é o vMCP **padrão** da instalação.
    const fonte = await createVirtualMcp(
      { name: 'Fonte do Clone', description: 'a fonte', isOpen: true, ownerUserUuid: anaUuid },
      SOURCE,
      ana,
    );
    const skill = await createSkill(
      { name: 'Skill do Clone', slug: 'skill-do-clone', skillMd: '# c' },
      SOURCE,
      ana,
    );
    const catalogo = await createCatalog(
      { name: 'Catálogo do Clone', ownerUserUuid: anaUuid },
      SOURCE,
      ana,
    );
    await linkSkill(
      'skill-do-clone',
      fonte.uuid,
      { asSkill: true, asPrompt: false, asResource: true },
      SOURCE,
      ana,
    );
    await linkCatalog(
      fonte.uuid,
      catalogo.uuid,
      { asSkill: false, asPrompt: true, asResource: false },
      SOURCE,
      ana,
    );
    await setVirtualMcpCanvas(fonte.uuid, {
      layout: { server: { x: 11, y: 22 }, internet: { x: -3, y: 4 } },
      positions: [{ slug: 'skill-do-clone', x: 40, y: 50 }],
      catalogPositions: [{ slug: 'catalogo-do-clone', x: 60, y: 70 }],
    });
    await incrementViewCount(skill.uuid, fonte.uuid);
    await incrementDownloadCount(skill.uuid, fonte.uuid);
    // Uma concessão para outra conta e outra para quem vai clonar.
    await setVirtualMcpGrant(fonte.slug, brunoUuid, 'edit', SOURCE, ana);
    await setVirtualMcpGrant(fonte.slug, clonadorUuid, 'manage', SOURCE, ana);
    await createVirtualMcpKey({
      virtualMcpUuid: fonte.uuid,
      name: 'chave da fonte',
      prefix: 'ccc98765',
      keyHash: 'scrypt$hash-da-fonte',
      createdByUserUuid: anaUuid,
    });
    await setDefaultVirtualMcp(fonte.uuid, SOURCE, ana);

    const clonador = { userUuid: clonadorUuid, label: 'clonador@exemplo.dev' };
    const copia = await cloneVirtualMcp(fonte.uuid, { ownerUserUuid: clonadorUuid }, SOURCE, clonador);

    expect(copia).toMatchObject({
      // O desempate sai do slug do original.
      slug: 'fonte-do-clone-2',
      name: 'Fonte do Clone',
      description: 'a fonte',
      // Ligado como o original; **fechado**, mesmo com o original aberto.
      isActive: true,
      isOpen: false,
      ownerUserUuid: clonadorUuid,
      isDefault: false,
    });
    // O layout vai inteiro.
    expect(copia.layout).toEqual({ server: { x: 11, y: 22 }, internet: { x: -3, y: 4 } });
    // O vínculo com a skill: as três portas e a posição, com os contadores
    // zerados — eles contam leituras daquele servidor, e a cópia não teve
    // nenhuma.
    expect(copia.skills).toHaveLength(1);
    expect(copia.skills[0]).toMatchObject({
      slug: 'skill-do-clone',
      asSkill: true,
      asPrompt: false,
      asResource: true,
      viewCount: 0,
      downloadCount: 0,
      position: { x: 40, y: 50 },
    });
    // O vínculo com o catálogo: portas e posição.
    expect(copia.catalogs).toHaveLength(1);
    expect(copia.catalogs[0]).toMatchObject({
      slug: 'catalogo-do-clone',
      asSkill: false,
      asPrompt: true,
      asResource: false,
      position: { x: 60, y: 70 },
    });
    // As concessões vêm, menos a de quem clonou (ela é a dona da cópia), e
    // quem concede no objeto novo é quem clonou.
    expect(copia.grants.map((g) => [g.username, g.level, g.grantedByUsername])).toEqual([
      ['bruno', 'edit', 'clonador'],
    ]);
    // Chave nenhuma: o segredo não é guardado e `prefix` é UNIQUE.
    expect(await listVirtualMcpKeys(copia.uuid)).toEqual([]);
    // E o posto de padrão não se move.
    expect(await resolveDefaultVirtualMcp()).toMatchObject({
      status: 'ok',
      mcp: { uuid: fonte.uuid, slug: 'fonte-do-clone' },
    });

    // O original ficou como estava: aberto, padrão, com a chave e com os
    // contadores do vínculo.
    const original = (await getVirtualMcpByUuid(fonte.uuid))!;
    expect([original.isOpen, original.isDefault]).toEqual([true, true]);
    expect(await listVirtualMcpKeys(fonte.uuid)).toHaveLength(1);
    expect(original.skills[0]).toMatchObject({ viewCount: 1, downloadCount: 1 });
    expect(original.grants).toHaveLength(2);

    // Uma linha só na trilha, com os dois lados no alvo e sem `mcp.create`.
    const clonagem = (await listAuditPage({ action: 'mcp.clone' })).items;
    expect(clonagem).toHaveLength(1);
    expect(clonagem[0]).toMatchObject({
      skillUuid: null,
      skillSlug: null,
      targetLabel: 'fonte-do-clone -> fonte-do-clone-2',
      actorUserUuid: clonadorUuid,
      actorLabel: 'clonador@exemplo.dev',
    });
    expect((await listAuditPage({ action: 'mcp.create', q: 'fonte-do-clone-2' })).total).toBe(0);

    // O segundo clone é `-3`; sem conta, a cópia nasce órfã e sem concessão
    // nenhuma a menos (ninguém é dono).
    const terceiro = await cloneVirtualMcp(fonte.uuid, { name: 'Outro nome' }, SOURCE, {
      userUuid: null,
      label: 'token-global',
    });
    expect([terceiro.slug, terceiro.name, terceiro.ownerUserUuid]).toEqual([
      'fonte-do-clone-3',
      'Outro nome',
      null,
    ]);
    expect(terceiro.grants.map((g) => [g.username, g.grantedByUsername])).toEqual([
      ['bruno', null],
      ['clonador', null],
    ]);

    // Slug pedido: livre grava, ocupado é 409, inválido é 400; uuid torto ou
    // sumido é 404, e o dono inexistente também.
    expect((await cloneVirtualMcp(fonte.uuid, { slug: 'copia-do-servidor' }, SOURCE, ana)).slug).toBe(
      'copia-do-servidor',
    );
    const ocupado = await capture(
      cloneVirtualMcp(fonte.uuid, { slug: 'fonte-do-clone-2' }, SOURCE, ana),
    );
    expect([ocupado.status, ocupado.message]).toEqual([
      409,
      'Já existe um MCP virtual com o slug "fonte-do-clone-2"',
    ]);
    expect(
      (await capture(cloneVirtualMcp(fonte.uuid, { slug: 'Com Espaço' }, SOURCE, ana))).status,
    ).toBe(400);
    expect((await capture(cloneVirtualMcp('torto', {}, SOURCE, ana))).status).toBe(404);
    expect(
      (await capture(cloneVirtualMcp('00000000-0000-0000-0000-000000000000', {}, SOURCE, ana))).status,
    ).toBe(404);
    expect(
      (
        await capture(
          cloneVirtualMcp(
            fonte.uuid,
            { ownerUserUuid: '00000000-0000-0000-0000-000000000000' },
            SOURCE,
            ana,
          ),
        )
      ).status,
    ).toBe(404);

    // Nenhuma recusa deixou servidor pela metade nem linha na trilha.
    expect((await listAuditPage({ action: 'mcp.clone' })).total).toBe(3);
    expect((await listVirtualMcps()).filter((m) => m.slug.startsWith('fonte-do-clone'))).toHaveLength(3);
  });
});
