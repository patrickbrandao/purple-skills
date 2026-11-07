/**
 * Teste de integração das duas guardas de conta da auditoria de 2026-11-07 —
 * exige um PostgreSQL 18 real com pgvector, porque aplica o schema inteiro:
 *
 * - `reserveLoginAttempt` (`tasks/026`): a tentativa de login contada **antes**
 *   da senha, num UPDATE condicional — de uma rajada simultânea, no máximo
 *   `maxAttempts` pedidos recebem `true`;
 * - a `038` (`tasks/014`): desativar a conta fecha os links de redefinição
 *   vivos, com `superseded_at`, e o backfill fecha os de quem já estava
 *   desativado.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada.
 * Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/login-guards.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import {
  consumeResetToken,
  createResetToken,
  createUser,
  getUserByUuid,
  registerFailedLogin,
  registerSuccessfulLogin,
  reserveLoginAttempt,
  updateUser,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;

/** O mesmo número das outras suítes: ver `quarantine.integration.test.ts`. */
const SCHEMA_LOCK = 8_200_004;

const MIGRATION = '038-desativar-fecha-links-de-reset.sql';

let raw: pg.Client;
let contador = 0;

async function novaConta(isActive = true): Promise<string> {
  contador += 1;
  const user = await createUser({
    username: `conta-${contador}`,
    email: `conta-${contador}@exemplo.dev`,
    name: `Conta ${contador}`,
    role: 'editor',
    passwordHash: 'scrypt$teste',
    isActive,
  });
  return user.uuid;
}

/** Os três carimbos de cada link da conta, pelo hash. */
async function links(userUuid: string): Promise<Record<string, { usado: boolean; fechado: boolean }>> {
  const { rows } = await raw.query<{ token_hash: string; usado: boolean; fechado: boolean }>(
    `SELECT token_hash, used_at IS NOT NULL AS usado, superseded_at IS NOT NULL AS fechado
       FROM reset_tokens WHERE user_uuid = $1 ORDER BY token_hash`,
    [userUuid],
  );
  return Object.fromEntries(rows.map((r) => [r.token_hash, { usado: r.usado, fechado: r.fechado }]));
}

const daquiAUmaHora = () => new Date(Date.now() + 3_600_000);

describe.skipIf(!url)('guardas de conta: reserva de login e links na desativação', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    await runMigrations(url!);
    process.env.DATABASE_URL = url;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  // ------------------------------------------------ reserveLoginAttempt ----

  it('conta cada tentativa e trava na de número maxAttempts, que ainda passa', async () => {
    const uuid = await novaConta();
    const regra = { maxAttempts: 3, lockSeconds: 60 };

    expect(await reserveLoginAttempt(uuid, regra)).toBe(true);
    expect((await getUserByUuid(uuid))!.failedAttempts).toBe(1);
    expect(await reserveLoginAttempt(uuid, regra)).toBe(true);

    // A terceira trava a conta, e a conta não estava travada quando ela chegou.
    expect(await reserveLoginAttempt(uuid, regra)).toBe(true);
    const travada = (await getUserByUuid(uuid))!;
    expect(travada.failedAttempts).toBe(0);
    expect(new Date(travada.lockedUntil!).getTime()).toBeGreaterThan(Date.now() + 50_000);

    // Travada: recusa e não conta nada, nem empurra o prazo.
    expect(await reserveLoginAttempt(uuid, regra)).toBe(false);
    const depois = (await getUserByUuid(uuid))!;
    expect(depois.failedAttempts).toBe(0);
    expect(depois.lockedUntil).toBe(travada.lockedUntil);

    // Prazo vencido: a contagem recomeça do zero.
    await raw.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE uuid = $1`, [uuid]);
    expect(await reserveLoginAttempt(uuid, regra)).toBe(true);
    expect((await getUserByUuid(uuid))!.failedAttempts).toBe(1);

    // O acerto zera, como sempre.
    await registerSuccessfulLogin(uuid);
    const limpa = (await getUserByUuid(uuid))!;
    expect(limpa.failedAttempts).toBe(0);
    expect(limpa.lockedUntil).toBeNull();
  });

  it('numa rajada simultânea, só maxAttempts pedidos passam', async () => {
    const uuid = await novaConta();
    const regra = { maxAttempts: 8, lockSeconds: 300 };

    const respostas = await Promise.all(
      Array.from({ length: 30 }, () => reserveLoginAttempt(uuid, regra)),
    );
    expect(respostas.filter(Boolean)).toHaveLength(8);

    const conta = (await getUserByUuid(uuid))!;
    expect(conta.failedAttempts).toBe(0);
    expect(new Date(conta.lockedUntil!).getTime()).toBeGreaterThan(Date.now() + 250_000);
  });

  it('uuid torto ou conta inexistente é false, sem erro; não toca updated_at', async () => {
    expect(await reserveLoginAttempt('nao-e-uuid', { maxAttempts: 3, lockSeconds: 60 })).toBe(false);
    expect(
      await reserveLoginAttempt('01890000-0000-7000-8000-000000000000', { maxAttempts: 3, lockSeconds: 60 }),
    ).toBe(false);

    const uuid = await novaConta();
    const antes = (await getUserByUuid(uuid))!.updatedAt;
    await reserveLoginAttempt(uuid, { maxAttempts: 3, lockSeconds: 60 });
    expect((await getUserByUuid(uuid))!.updatedAt).toBe(antes);
  });

  it('registerFailedLogin segue com o mesmo contrato e a mesma régua', async () => {
    const uuid = await novaConta();
    const regra = { maxAttempts: 2, lockSeconds: 60 };
    expect(await reserveLoginAttempt(uuid, regra)).toBe(true);
    // As duas contam no mesmo contador: a segunda falha trava.
    const segunda = await registerFailedLogin(uuid, regra);
    expect(segunda.failedAttempts).toBe(0);
    expect(segunda.lockedUntil).not.toBeNull();
    expect(await reserveLoginAttempt(uuid, regra)).toBe(false);
  });

  // ------------------------------------------- 038: desativar fecha links ---

  it('desativar fecha os links vivos; o usado e o vencido ficam como estavam', async () => {
    const uuid = await novaConta();
    await createResetToken({ userUuid: uuid, tokenHash: 'h-usado', expiresAt: daquiAUmaHora() });
    expect(await consumeResetToken('h-usado')).toEqual({ userUuid: uuid });
    // O vencido entra cru: `createResetToken` fecharia o vivo que veio antes.
    await raw.query(
      `INSERT INTO reset_tokens (user_uuid, token_hash, expires_at)
       VALUES ($1, 'h-vencido', now() - interval '1 minute')`,
      [uuid],
    );
    await createResetToken({ userUuid: uuid, tokenHash: 'h-vivo', expiresAt: daquiAUmaHora() });

    // Mexer em outra coisa da conta não fecha nada.
    await updateUser(uuid, { role: 'membro' });
    await updateUser(uuid, { isActive: true });
    expect((await links(uuid))['h-vivo']).toEqual({ usado: false, fechado: false });

    await updateUser(uuid, { isActive: false });
    expect(await links(uuid)).toEqual({
      'h-usado': { usado: true, fechado: false },
      'h-vencido': { usado: false, fechado: false },
      'h-vivo': { usado: false, fechado: true },
    });
    expect(await consumeResetToken('h-vivo')).toBeNull();

    // Reativar não reabre o link.
    await updateUser(uuid, { isActive: true });
    expect((await links(uuid))['h-vivo']).toEqual({ usado: false, fechado: true });
    expect(await consumeResetToken('h-vivo')).toBeNull();

    // O link pedido depois da reativação vale.
    await createResetToken({ userUuid: uuid, tokenHash: 'h-novo', expiresAt: daquiAUmaHora() });
    expect(await consumeResetToken('h-novo')).toEqual({ userUuid: uuid });
  });

  it('a conta de outra pessoa não é tocada', async () => {
    const ana = await novaConta();
    const bruno = await novaConta();
    await createResetToken({ userUuid: ana, tokenHash: 'h-ana', expiresAt: daquiAUmaHora() });
    await createResetToken({ userUuid: bruno, tokenHash: 'h-bruno', expiresAt: daquiAUmaHora() });

    await updateUser(ana, { isActive: false });
    expect((await links(ana))['h-ana']!.fechado).toBe(true);
    expect((await links(bruno))['h-bruno']!.fechado).toBe(false);
  });

  it('o backfill fecha os links vivos de quem já estava desativado, e a segunda passada não faz nada', async () => {
    // O link vivo de uma conta desativada é o estado de antes da `038`: entra cru.
    const desativada = await novaConta(false);
    const ativa = await novaConta();
    await raw.query(
      `INSERT INTO reset_tokens (user_uuid, token_hash, expires_at)
       VALUES ($1, 'h-antigo', now() + interval '1 hour'),
              ($1, 'h-antigo-vencido', now() - interval '1 hour'),
              ($2, 'h-da-ativa', now() + interval '1 hour')`,
      [desativada, ativa],
    );

    await raw.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION]);
    expect(await runMigrations(url!)).toEqual([MIGRATION]);
    expect(await links(desativada)).toEqual({
      'h-antigo': { usado: false, fechado: true },
      'h-antigo-vencido': { usado: false, fechado: false },
    });
    expect((await links(ativa))['h-da-ativa']!.fechado).toBe(false);

    const carimbo = async () =>
      (
        await raw.query<{ superseded_at: Date }>(
          `SELECT superseded_at FROM reset_tokens WHERE token_hash = 'h-antigo'`,
        )
      ).rows[0]!.superseded_at.toISOString();
    const primeiro = await carimbo();

    await raw.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION]);
    expect(await runMigrations(url!)).toEqual([MIGRATION]);
    expect(await carimbo()).toBe(primeiro);
    expect((await links(ativa))['h-da-ativa']!.fechado).toBe(false);

    // E o trigger continua lá, uma vez só.
    const { rows } = await raw.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'users_deactivation_reset_tokens_trg'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
