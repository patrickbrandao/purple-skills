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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations, schemaDir } from './migrate.js';
import { AppError } from './errors.js';
import {
  createUser,
  createVirtualMcp,
  deleteVirtualMcp,
  getVirtualMcp,
  listAudit,
  listSkills,
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

  it('o CHECK aceita mcp.default e continua recusando o que não está na lista', async () => {
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source, actor_label, target_label)
         VALUES ('mcp.inventada', 'web-admin', 'x', 'y')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);
  });
  /**
   * O caminho de quem sobe de versão: uma base parada no `010`, com skills no
   * formato antigo (`is_public` e `use_as_*`), recebe o `011` e o `012` de uma
   * vez. As migrations até o `010` são aplicadas à mão porque o runner aplica
   * tudo o que houver — e o `012` apaga as colunas que o `011` lê.
   */
  it('o backfill do 011 cria o "public" aberto com as skills públicas e as flags copiadas, e o 012 apaga as colunas', async () => {
    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');
    await applyUpTo(raw, '010');

    await raw.query(`
      INSERT INTO skills (slug, name, is_public, use_as_skill, use_as_prompt, use_as_resource) VALUES
        ('publica', 'Publica', true, true, true, false),
        ('sem-porta', 'Sem porta', true, false, false, false),
        ('privada', 'Privada', false, true, false, false)
    `);
    // Um vMCP `public` já existente força o sufixo.
    await raw.query("INSERT INTO virtual_mcps (slug, name) VALUES ('public', 'Public')");

    const NOVAS = [
      '011-mcp-padrao.sql',
      '012-skills-flutuantes.sql',
      '013-skill-icon.sql',
      '014-canvas-do-vmcp.sql',
      '015-mcp-sessions.sql',
      '016-catalogos.sql',
      '017-acesso-granular.sql',
      '018-acessos-por-skill.sql',
      '019-acessos-por-conta.sql',
      '020-rag.sql',
      '021-chaves-por-emissor.sql',
      '022-busca-por-substring.sql',
      '023-links-de-reset-substituidos.sql',
      '024-auditoria-de-troca-de-senha.sql',
      '025-fila-de-textos-do-rag.sql',
    ];
    expect(await runMigrations(url!)).toEqual(NOVAS);

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

    // A que era privada ficou flutuante: existe, e não está em servidor nenhum.
    expect((await listSkills({ visibility: 'all' })).total).toBe(3);
    expect((await listSkills({ visibility: 'open' })).items.map((s) => s.slug).sort()).toEqual([
      'publica',
      'sem-porta',
    ]);

    // As três `use_as_*` foram embora, e os índices que dependiam delas
    // também. `is_public` foi embora no `012` e **voltou** no `017` com outro
    // sentido (quem pode ler, não o que o MCP principal publicava): a que
    // era pública antes não nasce pública agora — a exposição dela é o
    // vínculo com o `public-2`.
    const { rows: colunas } = await raw.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'skills'
          AND column_name IN ('is_public', 'use_as_skill', 'use_as_prompt', 'use_as_resource')`,
    );
    expect(colunas).toEqual([{ column_name: 'is_public' }]);
    expect((await listSkills({ visibility: 'all' })).items.every((s) => !s.isPublic)).toBe(true);
    const { rows: indices } = await raw.query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'skills' ORDER BY indexname",
    );
    expect(indices.map((r) => r.indexname)).not.toContain('skills_public_score_idx');
    expect(indices.map((r) => r.indexname)).toContain('skills_score_idx');

    // Toda skill que já existia nasce ligada no `016`.
    expect((await listSkills({ visibility: 'all' })).items.every((s) => s.isActive)).toBe(true);

    // Re-executar o SQL de todas não faz nada: o backfill vê a chave e sai
    // antes de tocar nas colunas que já não existem, o 012 é todo `IF EXISTS`
    // e 013–016 são `IF NOT EXISTS` (com os CHECKs inline, pulados junto, e
    // os nomeados em DROP + ADD). Apagar do histórico é o que força o runner
    // a rodar o arquivo de novo — uma segunda chamada normal só o pularia.
    await raw.query('DELETE FROM schema_migrations WHERE name = ANY($1)', [NOVAS]);
    expect(await runMigrations(url!)).toEqual(NOVAS);
    expect((await listVirtualMcps()).filter((m) => m.slug.startsWith('public'))).toHaveLength(2);
    expect((await resolveDefaultVirtualMcp()).mcp?.slug).toBe('public-2');
    const { rows: objetos } = await raw.query<{ n: number }>(
      `SELECT (
         (SELECT count(*) FROM information_schema.columns
           WHERE (table_name, column_name) IN (('skills', 'icon'), ('virtual_mcps', 'layout'),
                                               ('virtual_mcp_skills', 'pos_x'), ('virtual_mcp_skills', 'pos_y'),
                                               ('skills', 'is_active')))
         + (SELECT count(*) FROM pg_constraint
             WHERE conname IN ('skills_icon_length_chk', 'virtual_mcps_layout_object_chk',
                               'virtual_mcp_skills_pos_pair_chk', 'virtual_mcp_catalogs_pos_pair_chk'))
         + (SELECT count(*) FROM pg_indexes
             WHERE tablename IN ('mcp_sessions', 'catalogs', 'catalog_skills', 'virtual_mcp_catalogs'))
       )::int AS n`,
    );
    // 5 colunas + 4 CHECKs + 13 índices (6 de `015`: pkey e os cinco; 7 de
    // `016`: pkey, slug único e dono em `catalogs`, pkey e skill em
    // `catalog_skills`, pkey e catálogo em `virtual_mcp_catalogs`), sem duplicata.
    expect(objetos[0]?.n).toBe(22);
  });
});
