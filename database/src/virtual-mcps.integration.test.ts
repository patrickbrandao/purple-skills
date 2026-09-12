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
import { AppError } from './errors.js';
import {
  createSkill,
  createUser,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteVirtualMcp,
  getSkillDetail,
  getSkillSummary,
  getVirtualMcp,
  getVirtualMcpByUuid,
  getVirtualMcpKeyByPrefix,
  incrementDownloadCount,
  incrementViewCount,
  listAudit,
  listPublishedSkills,
  listSkills,
  listTags,
  listVirtualMcpKeys,
  listVirtualMcps,
  recordAccountAudit,
  resolveVirtualMcp,
  revokeVirtualMcpKey,
  setVirtualMcpSkills,
  touchVirtualMcpKey,
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

    anaUuid = (await createUser({ email: 'ana@exemplo.dev', name: 'Ana', role: 'admin' })).uuid;
    brunoUuid = (await createUser({ email: 'bruno@exemplo.dev', name: 'Bruno', role: 'editor' }))
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
    expect(mcp.ownerEmail).toBe('bruno@exemplo.dev');
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
    expect(segundo.ownerEmail).toBeNull();

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
      },
    ]);
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
    expect(await revokeVirtualMcpKey(chave.id, outro.uuid)).toBe(false);
    expect((await listVirtualMcpKeys(mcpUuid))[0]?.revokedAt).toBeNull();

    expect(await revokeVirtualMcpKey(chave.id, mcpUuid)).toBe(true);
    expect(await revokeVirtualMcpKey(chave.id, mcpUuid)).toBe(false);
    expect((await listVirtualMcpKeys(mcpUuid))[0]?.revokedAt).not.toBeNull();
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
});
