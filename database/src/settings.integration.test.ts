/**
 * Teste de integração do MCP padrão (`settings`) — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/settings.integration.test.ts
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
  deleteVirtualMcp,
  getVirtualMcp,
  listAudit,
  listVirtualMcps,
  resolveDefaultVirtualMcp,
  setDefaultVirtualMcp,
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

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

describe.skipIf(!url)('MCP padrão: settings, resolução e backfill', () => {
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
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  const ana = { userUuid: '', label: 'ana@exemplo.dev' };

  it('numa instalação nova não há padrão: a raiz começa em 404', async () => {
    ana.userUuid = anaUuid;

    expect(await resolveDefaultVirtualMcp()).toEqual({ status: 'none', mcp: null, uuid: null, slug: null });
    // A tabela `public_mcp_keys` do antigo principal foi embora.
    const { rows } = await raw.query("SELECT to_regclass('public.public_mcp_keys') AS t");
    expect(rows[0]?.t).toBeNull();
  });

  it('escolhe, marca na listagem, audita e limpa', async () => {
    const mcp = await createVirtualMcp({ name: 'Time A', ownerUserUuid: null, isOpen: true }, SOURCE, ana);

    const escolhido = await setDefaultVirtualMcp(mcp.uuid, SOURCE, ana);
    expect(escolhido).toEqual({
      status: 'ok',
      mcp: { uuid: mcp.uuid, slug: 'time-a', name: 'Time A', description: '', isOpen: true },
    });
    expect((await listVirtualMcps()).find((m) => m.uuid === mcp.uuid)?.isDefault).toBe(true);
    expect((await getVirtualMcp('time-a'))?.isDefault).toBe(true);

    const linha = (await listAudit(10)).find((e) => e.action === 'mcp.default');
    expect(linha?.targetLabel).toBe('time-a');
    expect(linha?.actorUserUuid).toBe(anaUuid);

    // Escolher de novo é idempotente (upsert), e escolher um uuid inexistente é 404.
    expect((await setDefaultVirtualMcp(mcp.uuid, SOURCE, ana)).status).toBe('ok');
    const fantasma = await capture(
      setDefaultVirtualMcp('00000000-0000-0000-0000-000000000000', SOURCE, ana),
    );
    expect(fantasma.status).toBe(404);

    const limpo = await setDefaultVirtualMcp(null, SOURCE, ana);
    expect(limpo.status).toBe('none');
    expect((await listVirtualMcps()).find((m) => m.uuid === mcp.uuid)?.isDefault).toBe(false);
    expect((await listAudit(10)).find((e) => e.action === 'mcp.default' && e.targetLabel === 'nenhum')).toBeDefined();

    await setDefaultVirtualMcp(mcp.uuid, SOURCE, ana);
  });

  it('desligado e apagado são causas distintas, sem tratamento especial no vMCP', async () => {
    const mcp = (await listVirtualMcps()).find((m) => m.isDefault)!;

    // Desligar é permitido: a raiz passa a responder 404 dizendo o slug.
    await updateVirtualMcp(mcp.uuid, { isActive: false }, SOURCE, ana);
    expect(await resolveDefaultVirtualMcp()).toEqual({
      status: 'inactive',
      mcp: null,
      uuid: mcp.uuid,
      slug: 'time-a',
    });

    await updateVirtualMcp(mcp.uuid, { isActive: true }, SOURCE, ana);
    expect((await resolveDefaultVirtualMcp()).status).toBe('ok');

    // Apagar também: o valor fica pendurado em `settings` (sem FK, de propósito).
    await deleteVirtualMcp(mcp.uuid, SOURCE, ana);
    expect(await resolveDefaultVirtualMcp()).toEqual({ status: 'deleted', mcp: null, uuid: null, slug: null });
    const { rows } = await raw.query("SELECT value FROM settings WHERE key = 'default_virtual_mcp'");
    expect(rows[0]?.value).toBe(mcp.uuid);
  });

  it('o backfill do 011 cria o "public" aberto com as skills públicas e as flags copiadas', async () => {
    // Estado de uma instalação que sobe de versão: skills com `is_public` e
    // `use_as_*`, e nenhum padrão escolhido. Reaplicar o 011 é o que o runner
    // faria numa base parada no 010.
    await createSkill(
      { name: 'Publica', slug: 'publica', skillMd: '# p', isPublic: true, useAsSkill: true, useAsPrompt: true },
      SOURCE,
    );
    await createSkill(
      { name: 'Sem porta', slug: 'sem-porta', skillMd: '# s', isPublic: true, useAsSkill: false },
      SOURCE,
    );
    await createSkill({ name: 'Privada', slug: 'privada', skillMd: '# x', isPublic: false }, SOURCE);
    // Um vMCP `public` já existente força o sufixo.
    await createVirtualMcp({ name: 'Public', slug: 'public', ownerUserUuid: null }, SOURCE, ana);
    await raw.query("DELETE FROM settings WHERE key = 'default_virtual_mcp'");
    await raw.query("DELETE FROM schema_migrations WHERE name = '011-mcp-padrao.sql'");

    expect(await runMigrations(url!)).toEqual(['011-mcp-padrao.sql']);

    const resolved = await resolveDefaultVirtualMcp();
    expect(resolved.status).toBe('ok');
    expect(resolved.mcp).toMatchObject({ slug: 'public-2', name: 'Public', isOpen: true });

    const detail = await getVirtualMcp('public-2');
    expect(detail?.ownerUserUuid).toBeNull();
    expect(detail?.isActive).toBe(true);
    expect(detail?.skills.map((s) => [s.slug, s.asSkill, s.asPrompt, s.asResource])).toEqual([
      ['publica', true, true, false],
      ['sem-porta', false, false, false],
    ]);

    // Rodar de novo não faz nada: a chave já existe.
    await raw.query("DELETE FROM schema_migrations WHERE name = '011-mcp-padrao.sql'");
    expect(await runMigrations(url!)).toEqual(['011-mcp-padrao.sql']);
    expect((await listVirtualMcps()).filter((m) => m.slug.startsWith('public'))).toHaveLength(2);
    expect((await resolveDefaultVirtualMcp()).mcp?.slug).toBe('public-2');
  });

  it('o CHECK aceita mcp.default e continua recusando o que não está na lista', async () => {
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source, actor_label, target_label)
         VALUES ('mcp.inventada', 'web-admin', 'x', 'y')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);
  });
});
