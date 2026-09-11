/**
 * Teste de integração das chaves gerenciadas do MCP público principal —
 * exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/public-mcp-keys.integration.test.ts
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
  createPublicMcpKey,
  createUser,
  getPublicMcpKeyByPrefix,
  listAudit,
  listPublicMcpKeys,
  recordAccountAudit,
  revokePublicMcpKey,
  touchPublicMcpKey,
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
let primeiraId = '';
let segundaId = '';

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

describe.skipIf(!url)('MCP público principal: chaves gerenciadas', () => {
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

  it('emite a chave sem servidor e com o emissor informativo', async () => {
    ana.userUuid = anaUuid;

    const chave = await createPublicMcpKey({
      name: 'agente-principal',
      prefix: 'ppp12345',
      keyHash: 'scrypt$hash-da-chave',
      createdByUserUuid: anaUuid,
    });
    primeiraId = chave.id;

    expect(chave).toEqual({
      id: expect.any(String),
      name: 'agente-principal',
      prefix: 'ppp12345',
      createdByUserUuid: anaUuid,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: expect.any(String),
    });

    // Emissor nulo (bootstrap) também entra.
    const semDono = await createPublicMcpKey({
      name: 'sem-dono',
      prefix: 'ppp67890',
      keyHash: 'scrypt$outro',
      createdByUserUuid: null,
    });
    segundaId = semDono.id;
    expect(semDono.createdByUserUuid).toBeNull();

    // Prefixo é único; nome e hash são obrigatórios.
    const repetido = await capture(
      createPublicMcpKey({
        name: 'outra',
        prefix: 'ppp12345',
        keyHash: 'x',
        createdByUserUuid: null,
      }),
    );
    expect(repetido.status).toBe(409);

    const semNome = await capture(
      createPublicMcpKey({ name: '  ', prefix: 'ppp00000', keyHash: 'x', createdByUserUuid: null }),
    );
    expect(semNome.status).toBe(400);

    const semHash = await capture(
      createPublicMcpKey({ name: 'x', prefix: 'ppp00000', keyHash: '', createdByUserUuid: null }),
    );
    expect(semHash.status).toBe(400);
  });

  it('acha pelo prefixo e marca o uso', async () => {
    const achada = await getPublicMcpKeyByPrefix('ppp12345');
    expect(achada).toEqual({
      id: primeiraId,
      name: 'agente-principal',
      prefix: 'ppp12345',
      keyHash: 'scrypt$hash-da-chave',
      revokedAt: null,
    });
    expect(await getPublicMcpKeyByPrefix('nao-existe')).toBeNull();
    expect(await getPublicMcpKeyByPrefix('   ')).toBeNull();

    await touchPublicMcpKey(primeiraId);
    // Id torto não estoura.
    await touchPublicMcpKey('torto');

    const lista = await listPublicMcpKeys();
    expect(lista.find((k) => k.id === primeiraId)?.lastUsedAt).not.toBeNull();
    expect(lista.find((k) => k.id === segundaId)?.lastUsedAt).toBeNull();
  });

  it('revoga uma vez só e continua listando a revogada', async () => {
    expect(await revokePublicMcpKey(primeiraId)).toBe(true);
    expect(await revokePublicMcpKey(primeiraId)).toBe(false);
    expect(await revokePublicMcpKey('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(await revokePublicMcpKey('torto')).toBe(false);

    // O `revoked_at` original não é reescrito pela segunda chamada.
    const primeira = (await listPublicMcpKeys()).find((k) => k.id === primeiraId);
    const revogadaEm = primeira?.revokedAt;
    expect(revogadaEm).not.toBeNull();
    await revokePublicMcpKey(primeiraId);
    expect((await listPublicMcpKeys()).find((k) => k.id === primeiraId)?.revokedAt).toBe(
      revogadaEm,
    );

    // A autenticação enxerga a revogação pelo prefixo.
    expect((await getPublicMcpKeyByPrefix('ppp12345'))?.revokedAt).not.toBeNull();

    // Lista inclui a revogada, mais recente primeiro.
    const lista = await listPublicMcpKeys();
    expect(lista.map((k) => k.id)).toEqual([segundaId, primeiraId]);
    expect(lista[1]?.revokedAt).not.toBeNull();
    expect(lista[0]?.revokedAt).toBeNull();
  });

  it('sobrevive à remoção de quem emitiu', async () => {
    const bruno = await createUser({ email: 'bruno@exemplo.dev', name: 'Bruno', role: 'admin' });
    const chave = await createPublicMcpKey({
      name: 'do-bruno',
      prefix: 'pppbruno',
      keyHash: 'x',
      createdByUserUuid: bruno.uuid,
    });
    await raw.query('DELETE FROM users WHERE uuid = $1', [bruno.uuid]);

    const depois = (await listPublicMcpKeys()).find((k) => k.id === chave.id);
    expect(depois?.createdByUserUuid).toBeNull();
    expect((await getPublicMcpKeyByPrefix('pppbruno'))?.id).toBe(chave.id);
  });

  it('audita como public.key.create / public.key.revoke passando no CHECK', async () => {
    await recordAccountAudit({
      action: 'public.key.create',
      source: SOURCE,
      actor: ana,
      targetLabel: 'agente-principal',
    });
    await recordAccountAudit({
      action: 'public.key.revoke',
      source: 'mcp-admin',
      actor: { userUuid: null, label: 'token-global' },
      targetLabel: 'agente-principal',
    });

    const linhas = await listAudit(20);
    const criada = linhas.find((e) => e.action === 'public.key.create');
    expect(criada?.targetLabel).toBe('agente-principal');
    expect(criada?.skillUuid).toBeNull();
    expect(criada?.actorUserUuid).toBe(anaUuid);

    const revogada = linhas.find((e) => e.action === 'public.key.revoke');
    expect(revogada?.actorUserUuid).toBeNull();
    expect(revogada?.actorLabel).toBe('token-global');

    // O CHECK continua recusando o que não está na lista.
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source, actor_label, target_label)
         VALUES ('public.key.inventada', 'web-admin', 'x', 'y')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);
  });
});
