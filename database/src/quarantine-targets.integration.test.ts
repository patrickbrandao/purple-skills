/**
 * Teste de integração do **destino da quarentena** (`035`) — exige um
 * PostgreSQL 18 real com pgvector, porque aplica o schema inteiro.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/quarantine-targets.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 *
 * O envio em si (arquivos, fila, promoção sem destino) está em
 * `quarantine.integration.test.ts`; aqui ficam o destino gravado, a promoção
 * que o cumpre e a **ordem de travas** dela contra as escritas que tocam os
 * mesmos catálogos e servidores.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { QuarantineTargetsInput } from '@purple-skills/shared';
import { closeDb } from './client.js';
import type { AppError } from './errors.js';
import { runMigrations } from './migrate.js';
import {
  addCatalogSkill,
  createCatalog,
  createQuarantine,
  createSkill,
  createUser,
  createVirtualMcp,
  deleteCatalog,
  deleteVirtualMcp,
  getCatalogByUuid,
  getQuarantine,
  getSkillDetail,
  linkCatalog,
  linkSkill,
  listAuditPage,
  promoteQuarantine,
  setCatalogSkills,
  setQuarantineTargets,
  setVirtualMcpCatalogs,
  updateCatalog,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;

/** O mesmo número das outras suítes de integração: elas recriam o mesmo banco. */
const SCHEMA_LOCK = 8_200_004;

/** O erro da chamada, ou `null` se ela passou — nunca rejeita. */
function outcome(promise: Promise<unknown>): Promise<AppError | null> {
  return promise.then(
    () => null,
    (err: unknown) => err as AppError,
  );
}

/** O SQLSTATE do erro, descendo o `cause` do Drizzle — `40P01` é o deadlock. */
function sqlState(err: unknown): string | null {
  let atual = err as { code?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; atual && i < 5; i += 1) {
    if (typeof atual.code === 'string') return atual.code;
    atual = atual.cause as typeof atual;
  }
  return null;
}

/** Espera uma condição do banco virar verdadeira, sem `sleep` fixo. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('a condição esperada não aconteceu a tempo');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let raw: pg.Client;

// O `label` do ator é o **username** desde o `033`.
const ana = { userUuid: '', label: 'ana' };
const bruno = { userUuid: '', label: 'bruno' };

async function conta(texto: string, params: unknown[] = []): Promise<number> {
  const { rows } = await raw.query<{ n: string }>(texto, params);
  return Number(rows[0]?.n ?? 0);
}

const SKILL_MD = `---
name: destinada
description: Uma skill com destino
---

# Destinada
`;

let serie = 0;

/** Um envio promovível, com um nome único por chamada. */
async function envio(targets?: QuarantineTargetsInput, nome?: string) {
  serie += 1;
  return createQuarantine(
    {
      name: nome ?? `Envio ${serie}`,
      files: [{ relativePath: 'SKILL.md', content: SKILL_MD.replace('destinada', nome ?? `destinada-${serie}`) }],
      targets,
    },
    SOURCE,
    bruno,
  );
}

const vazio = (): QuarantineTargetsInput => ({ catalogs: [], mcps: [] });

describe.skipIf(!url)('quarentena: o destino gravado no envio', () => {
  /** Catálogos e servidores do cenário. Os nomes estão fora da ordem dos uuids de propósito. */
  const cat = { zeta: '', alfa: '', beta: '' };
  const mcp = { omega: '', gama: '' };

  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    await runMigrations(url!);
    process.env.DATABASE_URL = url;

    ana.userUuid = (await createUser({ username: ana.label, email: 'ana@exemplo.dev', name: 'Ana', role: 'admin' })).uuid;
    bruno.userUuid = (await createUser({ username: bruno.label, email: 'bruno@exemplo.dev', name: 'Bruno', role: 'editor' })).uuid;

    // Criados nesta ordem, os uuids (`uuidv7`) crescem: zeta < alfa < beta.
    cat.zeta = (await createCatalog({ name: 'Zeta', ownerUserUuid: null }, SOURCE, ana)).uuid;
    cat.alfa = (await createCatalog({ name: 'Alfa', ownerUserUuid: null }, SOURCE, ana)).uuid;
    cat.beta = (await createCatalog({ name: 'Beta', ownerUserUuid: null }, SOURCE, ana)).uuid;
    mcp.omega = (await createVirtualMcp({ name: 'Omega', ownerUserUuid: null }, SOURCE, ana)).uuid;
    mcp.gama = (await createVirtualMcp({ name: 'Gama', ownerUserUuid: null }, SOURCE, ana)).uuid;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  // ------------------------------------------------------ gravar o destino ---

  it('sem destino, a ficha traz as duas listas vazias', async () => {
    const e = await envio();
    expect(e.targets).toEqual({ catalogs: [], mcps: [] });
    expect((await getQuarantine(e.uuid))?.targets).toEqual({ catalogs: [], mcps: [] });
  });

  it('criar com destino grava na mesma transação e a ficha lê nome, slug e estado atuais, por nome', async () => {
    const catalogosAntes = await conta('SELECT count(*) AS n FROM catalog_skills');
    const vinculosAntes = await conta('SELECT count(*) AS n FROM virtual_mcp_skills');

    const e = await envio({
      catalogs: [cat.zeta, cat.alfa],
      mcps: [
        { virtualMcpUuid: mcp.omega, asSkill: true, asPrompt: false, asResource: true },
        { virtualMcpUuid: mcp.gama, asSkill: false, asPrompt: true, asResource: false },
      ],
    });

    expect(e.targets.catalogs).toEqual([
      { uuid: cat.alfa, slug: 'alfa', name: 'Alfa', isActive: true },
      { uuid: cat.zeta, slug: 'zeta', name: 'Zeta', isActive: true },
    ]);
    expect(e.targets.mcps).toEqual([
      { uuid: mcp.gama, slug: 'gama', name: 'Gama', isActive: true, asSkill: false, asPrompt: true, asResource: false },
      { uuid: mcp.omega, slug: 'omega', name: 'Omega', isActive: true, asSkill: true, asPrompt: false, asResource: true },
    ]);

    // Destino não é vínculo: nada mudou em catálogo nem em servidor.
    expect(await conta('SELECT count(*) AS n FROM catalog_skills')).toBe(catalogosAntes);
    expect(await conta('SELECT count(*) AS n FROM virtual_mcp_skills')).toBe(vinculosAntes);
    expect((await getCatalogByUuid(cat.alfa))?.skills).toEqual([]);

    // O estado lido é o atual: desligar o catálogo aparece na ficha.
    await updateCatalog(cat.zeta, { isActive: false }, SOURCE, ana);
    const depois = (await getQuarantine(e.uuid))!;
    expect(depois.targets.catalogs.find((c) => c.uuid === cat.zeta)?.isActive).toBe(false);
    await updateCatalog(cat.zeta, { isActive: true }, SOURCE, ana);

    // Uma linha só na trilha: o destino é parte do envio que apareceu.
    const trilha = await listAuditPage({ action: 'quarantine.create', q: e.name });
    expect(trilha.total).toBe(1);
  });

  it('destino inválido é 400 e nada é gravado', async () => {
    const antes = await conta('SELECT count(*) AS n FROM quarantine_skills');
    const naoExiste = '01900000-0000-7000-8000-000000000000';
    const porta = { asSkill: true, asPrompt: false, asResource: false };

    const casos: [unknown, string][] = [
      [{ catalogs: ['torto'], mcps: [] }, 'targets.catalogs[0]: precisa ser o uuid de um catálogo'],
      [{ catalogs: [naoExiste], mcps: [] }, `Catálogo não encontrado: ${naoExiste}`],
      [{ catalogs: [cat.alfa, cat.alfa.toUpperCase()], mcps: [] }, `Catálogo repetido no destino: ${cat.alfa}`],
      [{ catalogs: [], mcps: [{ virtualMcpUuid: 'x', ...porta }] }, 'targets.mcps[0]: "virtualMcpUuid" precisa ser um uuid'],
      [{ catalogs: [], mcps: [{ virtualMcpUuid: naoExiste, ...porta }] }, `MCP virtual não encontrado: ${naoExiste}`],
      [
        { catalogs: [], mcps: [{ virtualMcpUuid: mcp.gama, ...porta }, { virtualMcpUuid: mcp.gama, ...porta }] },
        `MCP virtual repetido no destino: ${mcp.gama}`,
      ],
      [
        { catalogs: [], mcps: [{ virtualMcpUuid: mcp.gama, asSkill: false, asPrompt: false, asResource: false }] },
        'ligue pelo menos uma das portas',
      ],
      [
        { catalogs: [], mcps: [{ virtualMcpUuid: mcp.gama, asSkill: true, asPrompt: 'sim', asResource: false }] },
        'o campo "asPrompt" é obrigatório e deve ser booleano',
      ],
      [{ catalogs: [] }, 'O campo "targets.mcps" deve ser uma lista'],
      [[], 'O campo "targets" deve ser um objeto'],
    ];

    for (const [targets, mensagem] of casos) {
      const erro = await outcome(envio(targets as QuarantineTargetsInput));
      expect(erro?.status, mensagem).toBe(400);
      expect(erro?.message).toContain(mensagem);
    }
    expect(await conta('SELECT count(*) AS n FROM quarantine_skills')).toBe(antes);

    // O CHECK recusa as três portas desligadas mesmo por fora das queries.
    const e = await envio();
    await expect(
      raw.query(
        'INSERT INTO quarantine_mcps (quarantine_uuid, virtual_mcp_uuid, as_skill, as_prompt, as_resource) VALUES ($1, $2, false, false, false)',
        [e.uuid, mcp.gama],
      ),
    ).rejects.toThrow(/quarantine_mcps_some_port_chk/);
  });

  it('setQuarantineTargets é declarativa: substitui, carimba e audita — e não faz nada quando nada mudou', async () => {
    const e = await envio({
      catalogs: [cat.alfa],
      mcps: [{ virtualMcpUuid: mcp.gama, asSkill: true, asPrompt: false, asResource: false }],
    });
    const trilha = async () => (await listAuditPage({ action: 'quarantine.update', q: e.name })).total;
    const { rows: criado } = await raw.query<{ created_at: Date }>(
      'SELECT created_at FROM quarantine_mcps WHERE quarantine_uuid = $1',
      [e.uuid],
    );

    const depois = await setQuarantineTargets(
      e.uuid,
      {
        catalogs: [cat.beta, cat.zeta],
        mcps: [
          { virtualMcpUuid: mcp.gama, asSkill: true, asPrompt: true, asResource: false },
          { virtualMcpUuid: mcp.omega, asSkill: false, asPrompt: false, asResource: true },
        ],
      },
      SOURCE,
      ana,
    );

    // O que saiu (alfa) saiu; o que entrou entrou; o que ficou teve as portas reescritas.
    expect(depois.targets.catalogs.map((c) => c.slug)).toEqual(['beta', 'zeta']);
    expect(depois.targets.mcps.map((m) => [m.slug, m.asSkill, m.asPrompt, m.asResource])).toEqual([
      ['gama', true, true, false],
      ['omega', false, false, true],
    ]);
    const { rows: mantido } = await raw.query<{ created_at: Date }>(
      'SELECT created_at FROM quarantine_mcps WHERE quarantine_uuid = $1 AND virtual_mcp_uuid = $2',
      [e.uuid, mcp.gama],
    );
    expect(mantido[0]?.created_at).toEqual(criado[0]?.created_at);

    expect(Date.parse(depois.updatedAt)).toBeGreaterThan(Date.parse(e.updatedAt));
    expect(await trilha()).toBe(1);
    const linha = (await listAuditPage({ action: 'quarantine.update', q: e.name })).items[0];
    expect(linha).toMatchObject({ targetLabel: e.name, actorLabel: ana.label, filePath: null, skillSlug: null });

    // O mesmo destino, em outra ordem e em maiúsculas: nada muda, nada é auditado.
    const igual = await setQuarantineTargets(
      e.uuid,
      {
        catalogs: [cat.zeta.toUpperCase(), cat.beta],
        mcps: [
          { virtualMcpUuid: mcp.omega, asSkill: false, asPrompt: false, asResource: true },
          { virtualMcpUuid: mcp.gama.toUpperCase(), asSkill: true, asPrompt: true, asResource: false },
        ],
      },
      SOURCE,
      ana,
    );
    expect(igual.updatedAt).toBe(depois.updatedAt);
    expect(await trilha()).toBe(1);

    // Vazio é um destino: tira tudo.
    const limpo = await setQuarantineTargets(e.uuid, vazio(), SOURCE, ana);
    expect(limpo.targets).toEqual({ catalogs: [], mcps: [] });
    expect(await trilha()).toBe(2);
  });

  it('setQuarantineTargets: 404 no envio que não existe, 400 no destino inválido, e nada muda', async () => {
    const e = await envio({ catalogs: [cat.alfa], mcps: [] });

    expect((await outcome(setQuarantineTargets('torto', vazio(), SOURCE, ana)))?.status).toBe(404);
    expect(
      (await outcome(setQuarantineTargets('01900000-0000-7000-8000-000000000000', vazio(), SOURCE, ana)))?.status,
    ).toBe(404);

    const erro = await outcome(
      setQuarantineTargets(e.uuid, { catalogs: [cat.beta, '01900000-0000-7000-8000-000000000000'], mcps: [] }, SOURCE, ana),
    );
    expect(erro?.status).toBe(400);
    expect(erro?.message).toContain('Catálogo não encontrado');
    expect((await getQuarantine(e.uuid))?.targets.catalogs.map((c) => c.uuid)).toEqual([cat.alfa]);
  });

  it('apagar o catálogo ou o vMCP tira o destino em silêncio', async () => {
    const extra = (await createCatalog({ name: 'Efêmero', ownerUserUuid: null }, SOURCE, ana)).uuid;
    const extraMcp = (await createVirtualMcp({ name: 'Efêmero', ownerUserUuid: null }, SOURCE, ana)).uuid;
    const e = await envio({
      catalogs: [cat.alfa, extra],
      mcps: [{ virtualMcpUuid: extraMcp, asSkill: true, asPrompt: false, asResource: false }],
    });

    await deleteCatalog(extra, SOURCE, ana);
    await deleteVirtualMcp(extraMcp, SOURCE, ana);

    const depois = (await getQuarantine(e.uuid))!;
    expect(depois.targets.catalogs.map((c) => c.uuid)).toEqual([cat.alfa]);
    expect(depois.targets.mcps).toEqual([]);
    // Em silêncio: o envio não foi tocado e a trilha dele não mudou.
    expect(depois.updatedAt).toBe(e.updatedAt);
    expect((await listAuditPage({ action: 'quarantine.update', q: e.name })).total).toBe(0);
  });

  // ---------------------------------------------------- cumprir o destino ---

  it('promover com destino: participação ativa em cada catálogo, vínculo com as portas e a trilha', async () => {
    const e = await envio(
      {
        catalogs: [cat.zeta, cat.beta],
        mcps: [{ virtualMcpUuid: mcp.omega, asSkill: false, asPrompt: true, asResource: true }],
      },
      'Com destino',
    );
    const lido = (await getQuarantine(e.uuid))!;
    const antes = {
      catalogo: await conta("SELECT count(*) AS n FROM audit_log WHERE action = 'catalog.update'"),
      mcp: await conta("SELECT count(*) AS n FROM audit_log WHERE action = 'mcp.update'"),
    };

    const skill = await promoteQuarantine(e.uuid, SOURCE, ana, {
      expectedTargets: {
        catalogs: lido.targets.catalogs.map((c) => c.uuid),
        mcps: lido.targets.mcps.map((m) => ({
          virtualMcpUuid: m.uuid,
          asSkill: m.asSkill,
          asPrompt: m.asPrompt,
          asResource: m.asResource,
        })),
      },
    });

    // A skill não é mais flutuante, e o resto da regra não mudou.
    expect(skill.ownerUserUuid).toBe(ana.userUuid);
    expect(skill.isPublic).toBe(false);
    expect(skill.catalogs.map((c) => [c.slug, c.memberActive])).toEqual([
      ['beta', true],
      ['zeta', true],
    ]);
    expect(skill.mcps.map((m) => [m.slug, m.asSkill, m.asPrompt, m.asResource])).toEqual([
      ['omega', false, true, true],
    ]);
    expect((await getCatalogByUuid(cat.beta))?.skills.map((s) => s.slug)).toContain(skill.slug);

    // Uma linha por catálogo, uma por servidor, com o slug do alvo.
    expect(await conta("SELECT count(*) AS n FROM audit_log WHERE action = 'catalog.update'")).toBe(antes.catalogo + 2);
    expect(await conta("SELECT count(*) AS n FROM audit_log WHERE action = 'mcp.update'")).toBe(antes.mcp + 1);
    const { rows } = await raw.query<{ action: string; target_label: string; actor_label: string }>(
      `SELECT action, target_label, actor_label FROM audit_log
        WHERE id >= (SELECT id FROM audit_log WHERE action = 'create' AND skill_slug = $1)
        ORDER BY id`,
      [skill.slug],
    );
    expect(rows.map((r) => [r.action, r.target_label])).toEqual([
      ['create', null],
      ['mcp.update', 'omega'],
      ['catalog.update', 'zeta'],
      ['catalog.update', 'beta'],
      ['quarantine.promote', `Com destino -> ${skill.slug}`],
    ]);
    expect(new Set(rows.map((r) => r.actor_label))).toEqual(new Set([ana.label]));

    // O destino foi junto com o envio.
    expect(await getQuarantine(e.uuid)).toBeNull();
    expect(await conta('SELECT count(*) AS n FROM quarantine_catalogs WHERE quarantine_uuid = $1', [e.uuid])).toBe(0);
    expect(await conta('SELECT count(*) AS n FROM quarantine_mcps WHERE quarantine_uuid = $1', [e.uuid])).toBe(0);
  });

  it('expectedTargets diferente do gravado é 409 e nada é criado; omitido, vale o gravado', async () => {
    const e = await envio(
      {
        catalogs: [cat.alfa],
        mcps: [{ virtualMcpUuid: mcp.gama, asSkill: true, asPrompt: false, asResource: false }],
      },
      'Disputado',
    );
    const contagem = async () => ({
      skills: await conta('SELECT count(*) AS n FROM skills'),
      membros: await conta('SELECT count(*) AS n FROM catalog_skills'),
      vinculos: await conta('SELECT count(*) AS n FROM virtual_mcp_skills'),
      trilha: await conta('SELECT count(*) AS n FROM audit_log'),
    });
    const antes = await contagem();

    const divergentes: QuarantineTargetsInput[] = [
      // Um catálogo a mais.
      { catalogs: [cat.alfa, cat.beta], mcps: [{ virtualMcpUuid: mcp.gama, asSkill: true, asPrompt: false, asResource: false }] },
      // Outro catálogo.
      { catalogs: [cat.beta], mcps: [{ virtualMcpUuid: mcp.gama, asSkill: true, asPrompt: false, asResource: false }] },
      // A mesma lista de servidores, outra porta.
      { catalogs: [cat.alfa], mcps: [{ virtualMcpUuid: mcp.gama, asSkill: true, asPrompt: true, asResource: false }] },
      // Sem destino nenhum.
      vazio(),
    ];
    for (const expectedTargets of divergentes) {
      const erro = await outcome(promoteQuarantine(e.uuid, SOURCE, ana, { expectedTargets }));
      expect(erro?.status).toBe(409);
      expect(erro?.code).toBe('conflict');
      expect(erro?.message).toBe(
        'O destino do envio "Disputado" mudou enquanto você aprovava: confira e aprove de novo',
      );
    }
    expect(await contagem()).toEqual(antes);
    expect(await getQuarantine(e.uuid)).not.toBeNull();

    // O esperado malformado é 400, antes de abrir a transação.
    const torto = await outcome(
      promoteQuarantine(e.uuid, SOURCE, ana, { expectedTargets: { catalogs: ['x'], mcps: [] } }),
    );
    expect(torto?.status).toBe(400);
    expect(torto?.message).toContain('expectedTargets.catalogs[0]');

    // Omitido: cumpre o gravado sem comparar.
    const skill = await promoteQuarantine(e.uuid, SOURCE, ana);
    expect(skill.catalogs.map((c) => c.slug)).toEqual(['alfa']);
    expect(skill.mcps.map((m) => m.slug)).toEqual(['gama']);
  });

  it('o catálogo apagado antes da aprovação some do destino: a ficha velha dá 409, a nova aprova sem ele', async () => {
    const extra = (await createCatalog({ name: 'Passageiro', ownerUserUuid: null }, SOURCE, ana)).uuid;
    const e = await envio({ catalogs: [cat.alfa, extra], mcps: [] }, 'Passageiro');
    const velho = { catalogs: [cat.alfa, extra], mcps: [] };

    await deleteCatalog(extra, SOURCE, ana);

    expect((await outcome(promoteQuarantine(e.uuid, SOURCE, ana, { expectedTargets: velho })))?.status).toBe(409);
    const skill = await promoteQuarantine(e.uuid, SOURCE, ana, {
      expectedTargets: { catalogs: [cat.alfa], mcps: [] },
    });
    expect(skill.catalogs.map((c) => c.slug)).toEqual(['alfa']);
  });

  it('o retry do slug continua valendo com destino: dois homônimos aprovados juntos, os dois cumpridos', async () => {
    const destino = {
      catalogs: [cat.alfa, cat.beta],
      mcps: [
        { virtualMcpUuid: mcp.gama, asSkill: true, asPrompt: false, asResource: false },
        { virtualMcpUuid: mcp.omega, asSkill: true, asPrompt: false, asResource: false },
      ],
    };
    for (let rodada = 0; rodada < 5; rodada += 1) {
      const nome = `gemeo-${rodada}`;
      const [um, dois] = [await envio(destino, nome), await envio(destino, nome)];
      const [a, b] = await Promise.all([
        promoteQuarantine(um.uuid, SOURCE, ana, { expectedTargets: destino }),
        promoteQuarantine(dois.uuid, SOURCE, ana, { expectedTargets: destino }),
      ]);
      expect(new Set([a.slug, b.slug])).toEqual(new Set([nome, `${nome}-2`]));
      for (const skill of [a, b]) {
        expect(skill.catalogs.map((c) => c.slug)).toEqual(['alfa', 'beta']);
        expect(skill.mcps.map((m) => m.slug)).toEqual(['gama', 'omega']);
      }
    }
  }, 60_000);

  // ------------------------------------------------------ ordem de travas ---

  describe('ordem de travas', () => {
    let lock: pg.Client;

    beforeAll(async () => {
      lock = new pg.Client({ connectionString: url });
      await lock.connect();
    });
    afterAll(async () => {
      await lock.end();
    });

    /** Há um backend deste banco parado em trava, rodando uma query que casa o padrão. */
    async function paradoEm(padrao: string): Promise<boolean> {
      const { rows } = await lock.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query LIKE $1`,
        [padrao],
      );
      return rows.length > 0;
    }

    /** Um catálogo e um vMCP novos, para que cada cena comece sem fila. */
    async function alvos(n = 2) {
      serie += 1;
      const catalogs: string[] = [];
      const mcps: string[] = [];
      for (let i = 0; i < n; i += 1) {
        catalogs.push((await createCatalog({ name: `Trava ${serie}-${i}`, ownerUserUuid: null }, SOURCE, ana)).uuid);
        mcps.push((await createVirtualMcp({ name: `Trava ${serie}-${i}`, ownerUserUuid: null }, SOURCE, ana)).uuid);
      }
      return { catalogs, mcps };
    }

    const porta = { asSkill: true, asPrompt: false, asResource: false };
    const destinoDe = (t: { catalogs: string[]; mcps: string[] }): QuarantineTargetsInput => ({
      catalogs: [...t.catalogs].reverse(),
      mcps: [...t.mcps].reverse().map((virtualMcpUuid) => ({ virtualMcpUuid, ...porta })),
    });

    /** Nenhuma falha, e em particular nenhum 40P01 — a mensagem diz qual veio. */
    function semFalha(resultados: (AppError | null)[]): void {
      const falhas = resultados
        .filter((r): r is AppError => r !== null)
        .map((r) => `${sqlState(r) ?? r.status}: ${r.message}`);
      expect(falhas).toEqual([]);
    }

    it('a promoção trava o vMCP antes do catálogo: não cruza com quem segura o vMCP e pede o catálogo', async () => {
      const t = await alvos(1);
      const e = await envio(destinoDe(t));
      const outro = await cliente();
      try {
        // O que `linkCatalog`/`setVirtualMcpCatalogs` fazem: travar o vMCP…
        await outro.query('BEGIN');
        await outro.query('SELECT slug FROM virtual_mcps WHERE uuid = $1 FOR NO KEY UPDATE', [t.mcps[0]]);

        const promocao = outcome(promoteQuarantine(e.uuid, SOURCE, ana));
        await waitFor(() => paradoEm('%FROM virtual_mcps%FOR NO KEY UPDATE%'));

        // …e só então pedir o catálogo pela FK. Com o catálogo travado primeiro
        // pela promoção, este INSERT fecharia o ciclo (40P01).
        await outro.query(
          'INSERT INTO virtual_mcp_catalogs (virtual_mcp_uuid, catalog_uuid, as_skill, as_prompt, as_resource) VALUES ($1, $2, true, false, false)',
          [t.mcps[0], t.catalogs[0]],
        );
        await outro.query('UPDATE virtual_mcps SET updated_at = now() WHERE uuid = $1', [t.mcps[0]]);
        await outro.query('COMMIT');
        expect(await promocao).toBeNull();
      } finally {
        await outro.end();
      }
    });

    async function cliente(): Promise<pg.Client> {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      return c;
    }

    const PARES = 30;

    it('promoções com os mesmos alvos, pedidos em ordens opostas, não travam em cruz', async () => {
      const t = await alvos();
      const resultados: (AppError | null)[] = [];
      for (let i = 0; i < PARES; i += 1) {
        const a = await envio(destinoDe(t));
        const b = await envio({ catalogs: t.catalogs, mcps: t.mcps.map((virtualMcpUuid) => ({ virtualMcpUuid, ...porta })) });
        resultados.push(
          ...(await Promise.all([
            outcome(promoteQuarantine(a.uuid, SOURCE, ana)),
            outcome(promoteQuarantine(b.uuid, SOURCE, ana)),
          ])),
        );
      }
      semFalha(resultados);
    }, 120_000);

    it('promoção × setQuarantineTargets de outro envio com os mesmos alvos', async () => {
      const t = await alvos();
      const alvo = await envio();
      const resultados: (AppError | null)[] = [];
      for (let i = 0; i < PARES; i += 1) {
        const a = await envio(destinoDe(t));
        resultados.push(
          ...(await Promise.all([
            outcome(promoteQuarantine(a.uuid, SOURCE, ana)),
            outcome(setQuarantineTargets(alvo.uuid, i % 2 === 0 ? destinoDe(t) : vazio(), SOURCE, ana)),
          ])),
        );
      }
      semFalha(resultados);
    }, 120_000);

    it('promoção × linkCatalog e setVirtualMcpCatalogs nos mesmos alvos', async () => {
      const t = await alvos();
      const catalogoSlugs = await Promise.all(t.catalogs.map(async (c) => (await getCatalogByUuid(c))!.slug));
      const resultados: (AppError | null)[] = [];
      for (let i = 0; i < PARES; i += 1) {
        const a = await envio(destinoDe(t));
        const b = await envio(destinoDe(t));
        resultados.push(
          ...(await Promise.all([
            outcome(promoteQuarantine(a.uuid, SOURCE, ana)),
            outcome(linkCatalog(t.mcps[1]!, t.catalogs[0]!, porta, SOURCE, ana)),
            outcome(promoteQuarantine(b.uuid, SOURCE, ana)),
            outcome(
              setVirtualMcpCatalogs(
                t.mcps[0]!,
                catalogoSlugs.map((slug) => ({ slug, ...porta })),
                SOURCE,
                ana,
              ),
            ),
          ])),
        );
      }
      semFalha(resultados);
    }, 120_000);

    it('promoção × setCatalogSkills, addCatalogSkill, linkSkill e createSkill nos mesmos alvos', async () => {
      const t = await alvos();
      const resultados: (AppError | null)[] = [];
      for (let i = 0; i < PARES; i += 1) {
        const a = await envio(destinoDe(t));
        const avulsa = await createSkill({ name: `Avulsa ${serie}-${i}`, skillMd: '# x' }, SOURCE, ana);
        resultados.push(
          ...(await Promise.all([
            outcome(promoteQuarantine(a.uuid, SOURCE, ana)),
            outcome(setCatalogSkills(t.catalogs[1]!, [{ slug: avulsa.slug }], SOURCE, ana)),
            outcome(addCatalogSkill(t.catalogs[0]!, avulsa.slug, SOURCE, ana)),
            outcome(linkSkill(avulsa.slug, t.mcps[1]!, porta, SOURCE, ana)),
            outcome(
              createSkill(
                {
                  name: `Publicada ${serie}-${i}`,
                  skillMd: '# x',
                  mcps: [...t.mcps].reverse().map((virtualMcpUuid) => ({ virtualMcpUuid, ...porta })),
                },
                SOURCE,
                ana,
              ),
            ),
          ])),
        );
      }
      semFalha(resultados);
    }, 120_000);

    it('promoção × remoção do catálogo e do vMCP: os dois passam, e o alvo apagado fica de fora', async () => {
      const resultados: (AppError | null)[] = [];
      for (let i = 0; i < PARES; i += 1) {
        const t = await alvos(1);
        const a = await envio(destinoDe(t));
        const [promocao, ...remocoes] = await Promise.all([
          promoteQuarantine(a.uuid, SOURCE, ana).then(
            (skill) => skill,
            (err: unknown) => err as AppError,
          ),
          outcome(deleteCatalog(t.catalogs[0]!, SOURCE, ana)),
          outcome(deleteVirtualMcp(t.mcps[0]!, SOURCE, ana)),
        ]);
        resultados.push(...remocoes);
        if (promocao instanceof Error) {
          resultados.push(promocao as AppError);
          continue;
        }
        // Qualquer que tenha sido a ordem, o estado final é o de a remoção ter vindo depois.
        const skill = (await getSkillDetail(promocao.slug, { visibility: 'all' }))!;
        expect(skill.catalogs).toEqual([]);
        expect(skill.mcps).toEqual([]);
      }
      semFalha(resultados);
    }, 120_000);
  });

  // ------------------------------------------------- a migration, de novo ---

  it('35 — reaplicar a 035 sobre o resultado não muda nada', async () => {
    const e = await envio({ catalogs: [cat.alfa], mcps: [{ virtualMcpUuid: mcp.gama, asSkill: true, asPrompt: false, asResource: false }] });
    const antes = {
      catalogos: await conta('SELECT count(*) AS n FROM quarantine_catalogs'),
      mcps: await conta('SELECT count(*) AS n FROM quarantine_mcps'),
    };

    await raw.query("DELETE FROM schema_migrations WHERE name = '035-destino-da-quarentena.sql'");
    expect(await runMigrations(url!)).toEqual(['035-destino-da-quarentena.sql']);

    expect({
      catalogos: await conta('SELECT count(*) AS n FROM quarantine_catalogs'),
      mcps: await conta('SELECT count(*) AS n FROM quarantine_mcps'),
    }).toEqual(antes);
    expect((await getQuarantine(e.uuid))?.targets.catalogs.map((c) => c.uuid)).toEqual([cat.alfa]);
  }, 60_000);
});
