/**
 * Teste de integração de contas, chaves de API e tokens de reset — exige um
 * PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/users.integration.test.ts
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
  consumeResetToken,
  countUsers,
  createApiKey,
  createResetToken,
  createSkill,
  createUser,
  getApiKeyByPrefix,
  getUserByEmail,
  getUserByUuid,
  listApiKeys,
  listAudit,
  listUsers,
  recordAccountAudit,
  registerFailedLogin,
  registerSuccessfulLogin,
  revokeApiKey,
  stats,
  touchApiKey,
  updateUser,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;

/**
 * O Vitest roda arquivos de teste em paralelo e as duas suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz a segunda esperar a primeira terminar, em vez de derrubar o
 * schema no meio da execução dela. O lock é de sessão: se o processo morrer, a
 * conexão cai e o lock é liberado pelo próprio Postgres.
 */
const SCHEMA_LOCK = 8_200_004;

let raw: pg.Client;
let anaUuid = '';
let brunoUuid = '';

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

describe.skipIf(!url)('contas, chaves de API e tokens de reset', () => {
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
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('cria a conta e a encontra por e-mail sem diferenciar caixa', async () => {
    expect(await countUsers()).toBe(0);

    const ana = await createUser({
      email: 'Ana@Exemplo.dev',
      name: 'Ana',
      role: 'admin',
      passwordHash: 'scrypt$hash-da-ana',
      mustChangePassword: true,
    });
    anaUuid = ana.uuid;

    expect(ana.role).toBe('admin');
    expect(ana.isActive).toBe(true);
    expect(ana.hasPassword).toBe(true);
    expect(ana.mustChangePassword).toBe(true);
    expect(ana.tokenVersion).toBe(0);

    const encontrada = await getUserByEmail('ANA@exemplo.DEV');
    expect(encontrada?.uuid).toBe(ana.uuid);
    expect(encontrada?.passwordHash).toBe('scrypt$hash-da-ana');

    expect((await getUserByUuid(ana.uuid))?.email).toBe('Ana@Exemplo.dev');
    // UUID torto é "não existe", não erro de servidor.
    expect(await getUserByUuid('isso-nao-e-uuid')).toBeNull();
    expect(await getUserByEmail('ninguem@exemplo.dev')).toBeNull();
    expect(await countUsers()).toBe(1);
  });

  it('recusa um segundo cadastro com o mesmo e-mail, em qualquer caixa', async () => {
    const err = await capture(
      createUser({ email: 'ana@exemplo.dev', name: 'Outra Ana', role: 'leitor' }),
    );

    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Já existe uma conta com o e-mail/);
    expect(await countUsers()).toBe(1);
  });

  it('atualiza só o que foi informado e incrementa a versão do token', async () => {
    const bruno = await createUser({
      email: 'bruno@exemplo.dev',
      name: 'Bruno',
      role: 'leitor',
    });
    brunoUuid = bruno.uuid;
    expect(bruno.hasPassword).toBe(false);

    const depois = await updateUser(brunoUuid, { role: 'editor', bumpTokenVersion: true });
    expect(depois.role).toBe('editor');
    expect(depois.tokenVersion).toBe(bruno.tokenVersion + 1);
    // Campos ausentes ficam como estavam.
    expect(depois.name).toBe('Bruno');
    expect(depois.isActive).toBe(true);
    expect(new Date(depois.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(bruno.updatedAt).getTime(),
    );

    // Sem `bumpTokenVersion` a versão não se mexe.
    const desativado = await updateUser(brunoUuid, { isActive: false });
    expect(desativado.isActive).toBe(false);
    expect(desativado.tokenVersion).toBe(depois.tokenVersion);

    const err = await capture(
      updateUser('00000000-0000-0000-0000-000000000000', { name: 'Fantasma' }),
    );
    expect(err.status).toBe(404);

    await updateUser(brunoUuid, { isActive: true });
    expect((await listUsers()).map((u) => u.name)).toEqual(['Ana', 'Bruno']);
  });

  it('trava a conta ao atingir o teto de tentativas e libera no login aceito', async () => {
    const primeira = await registerFailedLogin(anaUuid, { maxAttempts: 3, lockSeconds: 60 });
    expect(primeira).toEqual({ failedAttempts: 1, lockedUntil: null });

    const segunda = await registerFailedLogin(anaUuid, { maxAttempts: 3, lockSeconds: 60 });
    expect(segunda.failedAttempts).toBe(2);
    expect(segunda.lockedUntil).toBeNull();

    // No teto: bloqueia e zera o contador, para que quem errar depois do
    // bloqueio vencer recomece a contagem em vez de ser travado de imediato.
    const terceira = await registerFailedLogin(anaUuid, { maxAttempts: 3, lockSeconds: 60 });
    expect(terceira.failedAttempts).toBe(0);
    expect(terceira.lockedUntil).not.toBeNull();
    expect(new Date(terceira.lockedUntil!).getTime()).toBeGreaterThan(Date.now());

    await registerSuccessfulLogin(anaUuid);

    const ana = await getUserByUuid(anaUuid);
    expect(ana?.failedAttempts).toBe(0);
    expect(ana?.lockedUntil).toBeNull();
    expect(ana?.lastLoginAt).not.toBeNull();
  });

  it('emite, resolve pelo prefixo e revoga uma chave de API', async () => {
    const chave = await createApiKey({
      userUuid: anaUuid,
      name: 'agente-do-ci',
      prefix: 'abc12345',
      keyHash: 'scrypt$hash-da-chave',
    });
    expect(chave.userUuid).toBe(anaUuid);
    expect(chave.revokedAt).toBeNull();
    expect(chave.lastUsedAt).toBeNull();

    const achada = await getApiKeyByPrefix('abc12345');
    expect(achada?.id).toBe(chave.id);
    expect(achada?.keyHash).toBe('scrypt$hash-da-chave');
    expect(await getApiKeyByPrefix('nao-existe')).toBeNull();

    await touchApiKey(chave.id);
    expect((await listApiKeys(anaUuid))[0]?.lastUsedAt).not.toBeNull();

    // O dono revoga a própria chave; a segunda tentativa não faz nada.
    expect(await revokeApiKey(chave.id, anaUuid)).toBe(true);
    expect(await revokeApiKey(chave.id, anaUuid)).toBe(false);

    const revogada = (await listApiKeys(anaUuid)).find((k) => k.id === chave.id);
    expect(revogada?.revokedAt).not.toBeNull();
  });

  it('só deixa o dono revogar quando o dono é informado; admin revoga qualquer uma', async () => {
    const chave = await createApiKey({
      userUuid: brunoUuid,
      name: 'agente-do-bruno',
      prefix: 'def67890',
      keyHash: 'scrypt$hash-do-bruno',
    });

    // Ana pedindo a chave do Bruno: não é dela, não revoga.
    expect(await revokeApiKey(chave.id, anaUuid)).toBe(false);
    expect((await listApiKeys(brunoUuid))[0]?.revokedAt).toBeNull();

    // Sem dono = admin.
    expect(await revokeApiKey(chave.id)).toBe(true);
    expect(await revokeApiKey(chave.id)).toBe(false);
    expect(await revokeApiKey('nao-e-uuid')).toBe(false);

    // A listagem inclui as revogadas, mais novas primeiro.
    const doBruno = await listApiKeys(brunoUuid);
    expect(doBruno).toHaveLength(1);
    expect(doBruno[0]?.revokedAt).not.toBeNull();
  });

  it('consome o token de reset uma única vez e ignora o expirado', async () => {
    await createResetToken({
      userUuid: anaUuid,
      tokenHash: 'hash-do-link',
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(await consumeResetToken('hash-do-link')).toEqual({ userUuid: anaUuid });
    // Segundo clique no mesmo link.
    expect(await consumeResetToken('hash-do-link')).toBeNull();

    await createResetToken({
      userUuid: anaUuid,
      tokenHash: 'hash-vencido',
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(await consumeResetToken('hash-vencido')).toBeNull();
    expect(await consumeResetToken('nunca-emitido')).toBeNull();
  });

  it('grava o ator na skill criada e na linha de auditoria', async () => {
    const ator = { userUuid: anaUuid, label: 'ana@exemplo.dev' };
    const skill = await createSkill(
      { name: 'Skill com ator', slug: 'skill-com-ator', skillMd: '# com ator' },
      'web-admin',
      ator,
    );

    const { rows } = await raw.query<{ created_by_user_uuid: string | null }>(
      'SELECT created_by_user_uuid FROM skills WHERE slug = $1',
      [skill.slug],
    );
    expect(rows[0]?.created_by_user_uuid).toBe(anaUuid);

    const linha = (await listAudit(20)).find((e) => e.skillSlug === skill.slug);
    expect(linha?.action).toBe('create');
    expect(linha?.actorUserUuid).toBe(anaUuid);
    expect(linha?.actorLabel).toBe('ana@exemplo.dev');
    expect(linha?.targetLabel).toBeNull();
  });

  it('audita evento de conta sem skill, com o alvo no target_label', async () => {
    await recordAccountAudit({
      action: 'user.role',
      source: 'web-admin',
      actor: { userUuid: anaUuid, label: 'ana@exemplo.dev' },
      targetLabel: 'bruno@exemplo.dev',
    });
    // Ator que não é conta: o `MCP_ADMIN_TOKEN` grava UUID nulo e label fixo.
    await recordAccountAudit({
      action: 'key.revoke',
      source: 'mcp-admin',
      actor: { userUuid: null, label: 'token-global' },
      targetLabel: 'agente-do-bruno',
    });

    const entradas = await listAudit(20);

    const papel = entradas.find((e) => e.action === 'user.role');
    expect(papel?.skillUuid).toBeNull();
    expect(papel?.skillSlug).toBeNull();
    expect(papel?.actorLabel).toBe('ana@exemplo.dev');
    expect(papel?.targetLabel).toBe('bruno@exemplo.dev');

    const revogacao = entradas.find((e) => e.action === 'key.revoke');
    expect(revogacao?.actorUserUuid).toBeNull();
    expect(revogacao?.actorLabel).toBe('token-global');
    expect(revogacao?.source).toBe('mcp-admin');
  });

  it('conta usuários totais e ativos no stats', async () => {
    await updateUser(brunoUuid, { isActive: false });

    const resumo = await stats();
    expect(resumo.totalUsers).toBe(2);
    expect(resumo.activeUsers).toBe(1);

    await updateUser(brunoUuid, { isActive: true });
  });
});
