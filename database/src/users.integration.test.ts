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
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations, schemaDir } from './migrate.js';
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
  getUserByLogin,
  getUserByUsername,
  getUserByUuid,
  listApiKeys,
  listAudit,
  listAuditPage,
  listUsers,
  nextFreeUsername,
  recordAccountAudit,
  reserveUsername,
  registerFailedLogin,
  registerSuccessfulLogin,
  revokeApiKey,
  setAvatar,
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

/** Os dois carimbos de `reset_tokens` (`023`), lidos fora das queries. */
async function estadoDoLink(tokenHash: string): Promise<{ usado: boolean; fechado: boolean }> {
  const { rows } = await raw.query<{ used_at: Date | null; superseded_at: Date | null }>(
    'SELECT used_at, superseded_at FROM reset_tokens WHERE token_hash = $1',
    [tokenHash],
  );
  const linha = rows[0];
  if (!linha) throw new Error(`token de reset não encontrado: ${tokenHash}`);
  return { usado: linha.used_at !== null, fechado: linha.superseded_at !== null };
}

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

  it('o primeiro admin nasce uma vez só: dois setups simultâneos, um 409', async () => {
    // `onlyIfTableEmpty` (`tasks/049`). Com a contagem fora da transação — como
    // o app fazia sozinho — as duas chamadas leem a tabela vazia e as duas
    // gravam; duas contas admin ativas **desligam** a adoção de órfãos, e a
    // instalação fica com skills e catálogos sem dono.
    const primeiro = { name: 'Primeiro', role: 'admin' as const, onlyIfTableEmpty: true };
    const resultados = await Promise.allSettled([
      createUser({ ...primeiro, username: 'conta-um', email: 'um@exemplo.dev' }),
      createUser({ ...primeiro, username: 'dois', email: 'dois@exemplo.dev' }),
    ]);

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const recusada = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(recusada.reason).toMatchObject({ status: 409 });
    expect((recusada.reason as AppError).message).toMatch(/já tem contas/);
    expect(await countUsers()).toBe(1);

    // Com a tabela cheia é 409 sem gravar — o `/api/setup` fechado para sempre.
    const cheia = await capture(
      createUser({ ...primeiro, username: 'tres', email: 'tres@exemplo.dev' }),
    );
    expect(cheia.status).toBe(409);
    expect(await countUsers()).toBe(1);

    // Sem o campo, a criação comum continua funcionando com a tabela cheia.
    const comum = await createUser({ username: 'quatro', email: 'quatro@exemplo.dev', name: 'Quatro', role: 'membro' });
    expect(comum.role).toBe('membro');

    // A tabela volta ao zero: os casos seguintes partem de uma base limpa.
    await raw.query('DELETE FROM users');
  });

  it('sem o campo, a primeira conta pode nascer membro — e a receita do README devolve o admin', async () => {
    // `tasks/001`. A invariante "a primeira conta é o admin do setup" **não** é
    // de `createUser`: sem `onlyIfTableEmpty` ele grava em qualquer estado da
    // tabela, com qualquer papel, e quem confere é o chamador. O resultado é o
    // estado do relatório: há conta, e ninguém que possa promover ninguém.
    expect(await countUsers()).toBe(0);
    const pessoa = await createUser({ username: 'pessoa', email: 'Pessoa@Exemplo.dev', name: 'Pessoa', role: 'membro' });
    expect((await listUsers()).filter((u) => u.role === 'admin' && u.isActive)).toHaveLength(0);

    // A saída é "Instalação sem administrador" do `README.md`; o SQL é o de lá,
    // com o e-mail trocado. Se o `CHECK` de `action`/`source` ou as colunas de
    // `audit_log` mudarem, é aqui que a receita deixa de valer.
    const receita = (email: string): string => `
      WITH promovida AS (
        UPDATE users
        SET role = 'admin', is_active = true, token_version = token_version + 1, updated_at = now()
        WHERE lower(email) = lower('${email}')
          AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND is_active)
        RETURNING username
      )
      INSERT INTO audit_log (action, source, actor_label, target_label)
      SELECT 'user.role', 'web-admin', 'sql-manual', username || ' → admin' FROM promovida
      RETURNING target_label
    `;

    const primeira = await raw.query<{ target_label: string }>(receita('pessoa@exemplo.dev'));
    // A conta é **procurada** pelo e-mail (é o que quem opera tem na mão) e o
    // rótulo gravado é o **username**, como toda linha da trilha desde o `033`.
    expect(primeira.rows).toEqual([{ target_label: 'pessoa → admin' }]);

    const promovida = await getUserByUuid(pessoa.uuid);
    expect(promovida?.role).toBe('admin');
    // A sessão aberta como `membro` cai: o papel viaja no cookie.
    expect(promovida?.tokenVersion).toBe(pessoa.tokenVersion + 1);

    const daReceita = async () => (await listAudit(20)).filter((e) => e.actorLabel === 'sql-manual');
    expect(await daReceita()).toMatchObject([
      { action: 'user.role', source: 'web-admin', actorUserUuid: null, targetLabel: 'pessoa → admin' },
    ]);

    // Segura ao repetir: com um admin ativo ela não promove nem audita — nem a
    // mesma conta de novo, nem uma segunda.
    const outra = await createUser({ username: 'outra', email: 'outra@exemplo.dev', name: 'Outra', role: 'membro' });
    expect((await raw.query(receita('pessoa@exemplo.dev'))).rows).toHaveLength(0);
    expect((await raw.query(receita('outra@exemplo.dev'))).rows).toHaveLength(0);
    expect((await getUserByUuid(pessoa.uuid))?.tokenVersion).toBe(pessoa.tokenVersion + 1);
    expect((await getUserByUuid(outra.uuid))?.role).toBe('membro');
    expect(await daReceita()).toHaveLength(1);

    await raw.query("DELETE FROM audit_log WHERE actor_label = 'sql-manual'");
    await raw.query('DELETE FROM users');
  });

  it('cria a conta e a encontra por e-mail sem diferenciar caixa', async () => {
    expect(await countUsers()).toBe(0);

    const ana = await createUser({
      username: 'ana',
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
      createUser({ username: 'outra-ana', email: 'ana@exemplo.dev', name: 'Outra Ana', role: 'membro' }),
    );

    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Já existe uma conta com o e-mail/);
    expect(await countUsers()).toBe(1);
  });

  it('acha a conta pelo username e pelo identificador único do login', async () => {
    // A unicidade do username é por `lower(username)`, como a do e-mail; a
    // busca cai no mesmo índice.
    expect((await getUserByUsername('ANA'))?.uuid).toBe(anaUuid);
    // Texto que não é um username válido é "não existe", não erro de servidor
    // — o mesmo que um uuid torto recebe em `getUserByUuid`.
    expect(await getUserByUsername('a')).toBeNull();
    expect(await getUserByUsername('ana@exemplo.dev')).toBeNull();
    expect(await getUserByUsername('admin')).toBeNull();

    // O campo único do login (`docs/19` decisão 3): tem `@`, é e-mail; não
    // tem, é username. É a recusa do `@` em `normalizeUsername` que torna a
    // regra decidível — os dois conjuntos não se tocam.
    expect((await getUserByLogin('ana'))?.uuid).toBe(anaUuid);
    expect((await getUserByLogin('ANA@exemplo.DEV'))?.uuid).toBe(anaUuid);
    expect(await getUserByLogin('ninguem')).toBeNull();
    expect(await getUserByLogin('ninguem@exemplo.dev')).toBeNull();
    expect(await getUserByLogin('   ')).toBeNull();
  });

  it('recusa username torto e o que já é de uma conta viva; o abandonado nunca volta', async () => {
    // Validado aqui dentro mesmo com o painel já validando antes: o mcp-admin,
    // o seed e qualquer script passam pelo mesmo caminho.
    for (const torto of ['ab', 'ana@exemplo', '-ana', 'ana..souza', 'admin', '']) {
      const err = await capture(
        createUser({ username: torto, email: `t${torto}@exemplo.dev`, name: 'T', role: 'membro' }),
      );
      expect(err.status).toBe(400);
    }

    // Conta **viva** com o nome: 409 dizendo isso.
    const emUso = await capture(
      createUser({ username: 'ANA', email: 'nova@exemplo.dev', name: 'Nova', role: 'membro' }),
    );
    expect(emUso.status).toBe(409);
    expect(emUso.message).toBe('Já existe uma conta com o username "ana"');

    // Conta que passou por aqui e foi embora: a reserva fica no livro, sem
    // dono, e a mensagem é **outra** — quem administra precisa saber se o nome
    // está ocupado agora ou queimado para sempre (`docs/19` decisão 6).
    const efemera = await createUser({
      username: 'efemera',
      email: 'efemera@exemplo.dev',
      name: 'Efêmera',
      role: 'membro',
    });
    await raw.query('DELETE FROM users WHERE uuid = $1', [efemera.uuid]);
    expect(
      (await raw.query('SELECT user_uuid, released_at FROM usernames WHERE username_lower = $1', [
        'efemera',
      ])).rows,
    ).toEqual([{ user_uuid: null, released_at: null }]);

    const gasto = await capture(
      createUser({ username: 'efemera', email: 'outra@exemplo.dev', name: 'Outra', role: 'membro' }),
    );
    expect(gasto.status).toBe(409);
    expect(gasto.message).toBe('O username "efemera" já foi usado nesta instalação');
    expect(await countUsers()).toBe(1);
  });

  it('trocar o username libera o antigo sem apagá-lo, e o antigo não volta a circular', async () => {
    const nova = await createUser({
      username: 'primeiro-nome',
      email: 'troca@exemplo.dev',
      name: 'Troca',
      role: 'membro',
    });

    const depois = await updateUser(nova.uuid, { username: 'SEGUNDO-NOME' });
    expect(depois.username).toBe('segundo-nome');
    expect((await getUserByUsername('segundo-nome'))?.uuid).toBe(nova.uuid);
    expect(await getUserByUsername('primeiro-nome')).toBeNull();

    // O antigo continua no livro, liberado e com o uuid de quem era: é o que
    // mantém legível a trilha congelada com ele.
    const { rows } = await raw.query<{ username_lower: string; user_uuid: string | null; liberado: boolean }>(
      `SELECT username_lower, user_uuid, released_at IS NOT NULL AS liberado
         FROM usernames WHERE user_uuid = $1 ORDER BY username_lower`,
      [nova.uuid],
    );
    expect(rows).toEqual([
      { username_lower: 'primeiro-nome', user_uuid: nova.uuid, liberado: true },
      { username_lower: 'segundo-nome', user_uuid: nova.uuid, liberado: false },
    ]);

    // E ninguém o toma de volta — nem a própria conta.
    const volta = await capture(updateUser(nova.uuid, { username: 'primeiro-nome' }));
    expect(volta.status).toBe(409);
    expect(volta.message).toBe('O username "primeiro-nome" já foi usado nesta instalação');

    // Regravar o nome que a conta já tem é no-op no livro: não gasta nome nem
    // deixa linha nova.
    const antes = (
      await raw.query<{ n: number }>('SELECT count(*)::int AS n FROM usernames')
    ).rows[0]?.n;
    await updateUser(nova.uuid, { username: 'Segundo-Nome' });
    expect(
      (await raw.query<{ n: number }>('SELECT count(*)::int AS n FROM usernames')).rows[0]?.n,
    ).toBe(antes);

    // O nome de uma conta viva recusa com a outra mensagem.
    const daAna = await capture(updateUser(nova.uuid, { username: 'ana' }));
    expect(daAna.status).toBe(409);
    expect(daAna.message).toBe('Já existe uma conta com o username "ana"');

    // E o torto nem chega ao banco.
    expect((await capture(updateUser(nova.uuid, { username: 'ab' }))).status).toBe(400);

    await raw.query('DELETE FROM users WHERE uuid = $1', [nova.uuid]);
  });

  it('nextFreeUsername sugere e reserveUsername toma, consultando as duas fontes', async () => {
    // "Livre" é livre em `users` **e** em `usernames`: `ana` é de conta viva e
    // `efemera` está queimado pela conta apagada do caso acima.
    expect(await nextFreeUsername('ana')).toBe('ana-2');
    expect(await nextFreeUsername('efemera')).toBe('efemera-2');
    expect(await nextFreeUsername('ninguem-usou')).toBe('ninguem-usou');
    // É leitura: sugerir não gasta o nome, e a segunda chamada repete a
    // primeira — quem fecha a corrida é o 409 de `createUser`.
    expect(await nextFreeUsername('ninguem-usou')).toBe('ninguem-usou');
    // Base inutilizável é 400 — a função não inventa base, quem chama decide o
    // fallback (`usernameFromUuid`).
    expect((await capture(nextFreeUsername('ab'))).status).toBe(400);

    // O caminho do auto-provisionamento OIDC: sugerir e criar.
    const sugerido = await nextFreeUsername('vinda-do-oidc');
    const conta = await createUser({
      username: sugerido,
      email: 'oidc@exemplo.dev',
      name: 'Vinda do OIDC',
      role: 'membro',
      oidcIssuer: 'https://exemplo.dev',
      oidcSubject: 'sub-1',
    });
    expect(conta.username).toBe('vinda-do-oidc');
    expect(
      (await raw.query('SELECT user_uuid FROM usernames WHERE username_lower = $1', [sugerido]))
        .rows,
    ).toEqual([{ user_uuid: conta.uuid }]);

    // `reserveUsername` **grava**, para uma conta que já existe: na colisão
    // ele numera em vez de recusar, que é a diferença para
    // `updateUser({ username })`.
    expect(await reserveUsername('ana', conta.uuid)).toBe('ana-2');
    expect((await getUserByUuid(conta.uuid))?.username).toBe('ana-2');
    // O nome que a conta já tem é no-op, sem numerar de novo.
    expect(await reserveUsername('ana-2', conta.uuid)).toBe('ana-2');
    // E o anterior ficou liberado, sem sair do livro.
    expect(
      (await raw.query('SELECT released_at IS NOT NULL AS liberado FROM usernames WHERE username_lower = $1', [
        'vinda-do-oidc',
      ])).rows,
    ).toEqual([{ liberado: true }]);
    // Agora `ana-2` está em uso e a próxima sugestão pula para `ana-3`.
    expect(await nextFreeUsername('ana')).toBe('ana-3');
    // Conta que não existe é 404, e uuid torto também.
    expect((await capture(reserveUsername('x-y-z', 'nao-e-uuid'))).status).toBe(404);

    await raw.query('DELETE FROM users WHERE uuid = $1', [conta.uuid]);
  });

  it('atualiza só o que foi informado e incrementa a versão do token', async () => {
    const bruno = await createUser({
      username: 'bruno',
      email: 'bruno@exemplo.dev',
      name: 'Bruno',
      role: 'membro',
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

  it('revogar a sessão, sozinho, não carimba updated_at; com campo da conta, carimba', async () => {
    // `tasks/034`. `updated_at` é "última alteração administrativa da conta" —
    // a razão de `registerFailedLogin`/`registerSuccessfulLogin` não o tocarem.
    // O "Sair" do painel é `updateUser(uuid, { bumpTokenVersion: true })`:
    // movimento de sessão, sem linha na trilha que explique uma data nova.
    const pausa = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));
    const antes = (await getUserByUuid(brunoUuid))!;

    await pausa();
    const logout = await updateUser(brunoUuid, { bumpTokenVersion: true });
    expect(logout.tokenVersion).toBe(antes.tokenVersion + 1);
    expect(logout.updatedAt).toBe(antes.updatedAt);

    // Qualquer campo da conta junto volta a carimbar — é o reset de senha, a
    // troca de papel e a desativação, que também derrubam as sessões.
    await pausa();
    const editado = await updateUser(brunoUuid, { name: 'Bruno', bumpTokenVersion: true });
    expect(editado.tokenVersion).toBe(antes.tokenVersion + 2);
    expect(new Date(editado.updatedAt).getTime()).toBeGreaterThan(new Date(antes.updatedAt).getTime());

    // `{}` é o PATCH do painel que não mudou nada (`updateAccount`): continua
    // sendo um UPDATE válido — o `SET` não fica vazio — e continua carimbando.
    await pausa();
    const vazio = await updateUser(brunoUuid, {});
    expect(vazio.tokenVersion).toBe(editado.tokenVersion);
    expect(new Date(vazio.updatedAt).getTime()).toBeGreaterThan(new Date(editado.updatedAt).getTime());
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

  it('clearLoginLock destrava no mesmo UPDATE da senha nova; sem o campo a trava fica', async () => {
    // `tasks/005`. O login confere `locked_until` **antes** da senha, então a
    // senha temporária certa é recusada com 429 até a trava vencer — e o único
    // outro código que a limpa (`registerSuccessfulLogin`) fica inalcançável.
    const travar = async (): Promise<void> => {
      for (let i = 0; i < 3; i++) await registerFailedLogin(anaUuid, { maxAttempts: 3, lockSeconds: 60 });
      // Mais um erro depois de travada: o contador também precisa voltar a zero.
      await registerFailedLogin(anaUuid, { maxAttempts: 3, lockSeconds: 60 });
    };

    await travar();
    // Sem o campo — e com `false`, que é "não mexe" — a senha muda e a trava fica.
    const semCampo = await updateUser(anaUuid, { passwordHash: 'scrypt$temporaria-1', bumpTokenVersion: true });
    expect(semCampo.lockedUntil).not.toBeNull();
    expect(semCampo.failedAttempts).toBe(1);
    const comFalse = await updateUser(anaUuid, { passwordHash: 'scrypt$temporaria-2', clearLoginLock: false });
    expect(comFalse.lockedUntil).not.toBeNull();
    expect(comFalse.failedAttempts).toBe(1);

    const destravada = await updateUser(anaUuid, {
      passwordHash: 'scrypt$temporaria-3',
      mustChangePassword: true,
      bumpTokenVersion: true,
      clearLoginLock: true,
    });
    expect(destravada.lockedUntil).toBeNull();
    expect(destravada.failedAttempts).toBe(0);
    expect(destravada.passwordHash).toBe('scrypt$temporaria-3');
    expect(destravada.tokenVersion).toBe(semCampo.tokenVersion + 1);
    // Não é login: `last_login_at` fica como estava.
    expect(destravada.lastLoginAt).toBe(semCampo.lastLoginAt);

    // Sozinho também vale (um "destravar" sem trocar a senha), e a contagem
    // recomeça do zero para quem errar depois.
    await travar();
    expect((await updateUser(anaUuid, { clearLoginLock: true })).lockedUntil).toBeNull();
    expect(await registerFailedLogin(anaUuid, { maxAttempts: 3, lockSeconds: 60 })).toEqual({
      failedAttempts: 1,
      lockedUntil: null,
    });
    await registerSuccessfulLogin(anaUuid);
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

    // O dono revoga a própria chave. A revogação devolve o que identifica a
    // chave numa linha de auditoria — nome, prefixo e de quem era (`tasks/040`):
    // o app rotula o `key.revoke` como rotulou o `key.create`, sem uma leitura a
    // mais e sem o uuid, que não aparece em tela nenhuma.
    expect(await revokeApiKey(chave.id, anaUuid)).toEqual({
      name: 'agente-do-ci',
      prefix: 'abc12345',
      userUuid: anaUuid,
      userUsername: 'ana',
    });
    const revogada = (await listApiKeys(anaUuid)).find((k) => k.id === chave.id);
    expect(revogada?.revokedAt).not.toBeNull();

    // A segunda tentativa não faz nada: `null`, e o `revoked_at` que datou a
    // revogação não é reescrito.
    expect(await revokeApiKey(chave.id, anaUuid)).toBeNull();
    expect((await listApiKeys(anaUuid)).find((k) => k.id === chave.id)?.revokedAt).toBe(
      revogada?.revokedAt,
    );
  });

  it('só deixa o dono revogar quando o dono é informado; admin revoga qualquer uma', async () => {
    const chave = await createApiKey({
      userUuid: brunoUuid,
      name: 'agente-do-bruno',
      prefix: 'def67890',
      keyHash: 'scrypt$hash-do-bruno',
    });

    // Ana pedindo a chave do Bruno: não é dela, não revoga.
    expect(await revokeApiKey(chave.id, anaUuid)).toBeNull();
    expect((await listApiKeys(brunoUuid))[0]?.revokedAt).toBeNull();

    // Sem dono = admin. Quem revogou não é o dono da chave, e é por isso que o
    // retorno diz de quem ela era: o rótulo da auditoria é `<username>: <nome>`
    // — username desde o `033`, porque ele vai congelado para `audit_log`.
    expect(await revokeApiKey(chave.id)).toEqual({
      name: 'agente-do-bruno',
      prefix: 'def67890',
      userUuid: brunoUuid,
      userUsername: 'bruno',
    });
    expect(await revokeApiKey(chave.id)).toBeNull();
    expect(await revokeApiKey('nao-e-uuid')).toBeNull();
    expect(await revokeApiKey(chave.id, 'nao-e-uuid')).toBeNull();

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

  it('fecha os links vivos ao emitir outro e ao trocar a senha (023)', async () => {
    const daqui = (ms: number): Date => new Date(Date.now() + ms);

    // Dois pedidos seguidos da mesma conta: o primeiro morre na emissão do
    // segundo, sem virar "usado" — ninguém clicou nele.
    await createResetToken({ userUuid: anaUuid, tokenHash: 'ana-1', expiresAt: daqui(3_600_000) });
    await createResetToken({ userUuid: anaUuid, tokenHash: 'ana-2', expiresAt: daqui(3_600_000) });

    expect(await estadoDoLink('ana-1')).toEqual({ usado: false, fechado: true });
    expect(await estadoDoLink('ana-2')).toEqual({ usado: false, fechado: false });
    expect(await consumeResetToken('ana-1')).toBeNull();
    expect(await consumeResetToken('ana-2')).toEqual({ userUuid: anaUuid });
    // Consumido é `used_at`, não `superseded_at`: é o que a auditoria conta.
    expect(await estadoDoLink('ana-2')).toEqual({ usado: true, fechado: false });

    // O vencido em aberto não é reetiquetado: "morto por prazo" continua
    // contável, e é por isso que o fechamento só toca link vivo.
    await createResetToken({
      userUuid: brunoUuid,
      tokenHash: 'bruno-vencido',
      expiresAt: daqui(-1_000),
    });
    await createResetToken({ userUuid: brunoUuid, tokenHash: 'bruno-1', expiresAt: daqui(3_600_000) });
    expect(await estadoDoLink('bruno-vencido')).toEqual({ usado: false, fechado: false });

    // Logout (só `token_version`) não fecha link nenhum.
    await updateUser(brunoUuid, { bumpTokenVersion: true });
    expect(await estadoDoLink('bruno-1')).toEqual({ usado: false, fechado: false });

    // Senha nova por qualquer caminho — aqui sem link nenhum, como no reset do
    // admin — fecha o que estava vivo. É o trigger em `users`.
    await updateUser(brunoUuid, { passwordHash: 'scrypt$hash-novo-do-bruno' });
    expect(await estadoDoLink('bruno-1')).toEqual({ usado: false, fechado: true });
    expect(await consumeResetToken('bruno-1')).toBeNull();
    // Quem já tinha sido usado fica como estava: uma linha diz uma coisa só.
    expect(await estadoDoLink('ana-2')).toEqual({ usado: true, fechado: false });

    // Regravar o mesmo hash não é troca de senha: o `WHEN` do trigger segura.
    await createResetToken({ userUuid: brunoUuid, tokenHash: 'bruno-2', expiresAt: daqui(3_600_000) });
    await updateUser(brunoUuid, { passwordHash: 'scrypt$hash-novo-do-bruno' });
    expect(await estadoDoLink('bruno-2')).toEqual({ usado: false, fechado: false });
    expect(await estadoDoLink('bruno-vencido')).toEqual({ usado: false, fechado: false });

    // `reset_tokens_estado_chk`: usado e substituído são exclusivos.
    await expect(
      raw.query("UPDATE reset_tokens SET superseded_at = now() WHERE token_hash = 'ana-2'"),
    ).rejects.toThrow(/reset_tokens_estado_chk/);
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

  it('a reativação e o vínculo OIDC cabem na trilha (026), e o CHECK segue fechado', async () => {
    // `tasks/003`. Os dois eventos mudam quem consegue entrar na conta e não
    // tinham **ação**: o INSERT era recusado pelo `CHECK` de `audit_log.action`.
    await recordAccountAudit({
      action: 'user.activate',
      source: 'web-admin',
      actor: { userUuid: anaUuid, label: 'ana@exemplo.dev' },
      targetLabel: 'bruno@exemplo.dev',
    });
    // O ator do vínculo é o caminho, sem conta — como `link-de-redefinicao`.
    await recordAccountAudit({
      action: 'user.link',
      source: 'web-admin',
      actor: { userUuid: null, label: 'oidc:https://idp.exemplo.dev' },
      targetLabel: 'bruno@exemplo.dev (sub 0a1b2c)',
    });

    // As duas são filtro válido da tela da trilha (o espelho `AUDIT_ACTIONS`).
    const reativacao = await listAuditPage({ action: 'user.activate' });
    expect(reativacao.total).toBe(1);
    expect(reativacao.items[0]).toMatchObject({
      actorUserUuid: anaUuid,
      actorLabel: 'ana@exemplo.dev',
      targetLabel: 'bruno@exemplo.dev',
      skillUuid: null,
    });
    const vinculo = await listAuditPage({ action: 'user.link' });
    expect(vinculo.total).toBe(1);
    expect(vinculo.items[0]).toMatchObject({
      actorUserUuid: null,
      actorLabel: 'oidc:https://idp.exemplo.dev',
      targetLabel: 'bruno@exemplo.dev (sub 0a1b2c)',
    });
    // Dá para achar o vínculo pelo `subject`, que é o dado que faltava.
    expect((await listAuditPage({ q: 'sub 0a1b2c' })).total).toBe(1);

    // O que não está na lista continua 400 no filtro e recusado pelo banco.
    expect((await capture(listAuditPage({ action: 'user.inventada' as never }))).status).toBe(400);
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source, actor_label, target_label)
         VALUES ('user.inventada', 'web-admin', 'x', 'y')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);

    // Re-executar a migration recria a mesma constraint, com as linhas novas já
    // na tabela. O arquivo é achado pelo nome, não pelo número.
    const arquivo = readdirSync(schemaDir()).find((f) => f.endsWith('-auditoria-de-vinculo-e-reativacao.sql'));
    expect(arquivo).toBeDefined();
    await raw.query('DELETE FROM schema_migrations WHERE name = $1', [arquivo]);
    expect(await runMigrations(url!)).toEqual([arquivo]);
    expect((await listAuditPage({ action: 'user.link' })).total).toBe(1);
    await recordAccountAudit({
      action: 'user.activate',
      source: 'web-admin',
      actor: { userUuid: null, label: 'bootstrap' },
      targetLabel: 'ana@exemplo.dev',
    });
    expect((await listAuditPage({ action: 'user.activate' })).total).toBe(2);
  });

  it('conta usuários totais e ativos no stats', async () => {
    await updateUser(brunoUuid, { isActive: false });

    const resumo = await stats();
    expect(resumo.totalUsers).toBe(2);
    expect(resumo.activeUsers).toBe(1);

    await updateUser(brunoUuid, { isActive: true });
  });

  it('o carimbo do avatar acompanha a conta em toda leitura, inclusive nos RETURNING', async () => {
    // `034`: `UserSummary.avatarUpdatedAt` existe para que uma lista de contas
    // saiba se há foto sem uma requisição por linha. A coluna vem por
    // subconsulta correlacionada dentro de `USER_COLUMNS`, e é isso que a faz
    // valer também em `RETURNING` — onde não há `FROM` para juntar nada. Uma
    // junção ali seria erro de sintaxe, e a conta criada voltaria sem o campo.
    const nova = await createUser({
      username: 'com-foto',
      email: 'com-foto@exemplo.dev',
      name: 'Com Foto',
      role: 'membro',
    });
    expect(nova.avatarUpdatedAt).toBeNull();

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('users.integration'),
    ]);
    const { updatedAt } = await setAvatar(nova.uuid, png);

    expect((await getUserByUuid(nova.uuid))?.avatarUpdatedAt).toBe(updatedAt);
    expect((await getUserByEmail('com-foto@exemplo.dev'))?.avatarUpdatedAt).toBe(updatedAt);
    expect((await getUserByUsername('com-foto'))?.avatarUpdatedAt).toBe(updatedAt);
    expect((await listUsers()).find((u) => u.uuid === nova.uuid)?.avatarUpdatedAt).toBe(updatedAt);
    // O RETURNING do UPDATE: é aqui que a subconsulta prova que vale.
    expect((await updateUser(nova.uuid, { name: 'Com Foto 2' })).avatarUpdatedAt).toBe(updatedAt);

    // Apagar a conta leva a foto (`ON DELETE CASCADE`) — sem ela, a linha
    // ficaria órfã com os bytes dentro.
    await raw.query('DELETE FROM users WHERE uuid = $1', [nova.uuid]);
    const { rows } = await raw.query('SELECT count(*)::int AS n FROM user_avatars WHERE user_uuid = $1', [
      nova.uuid,
    ]);
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('requireOtherActiveAdmin: sempre sobra um admin, mesmo com dois rebaixamentos juntos', async () => {
    // `tasks/049`. A checagem do app lê o estado **anterior** ao UPDATE do
    // vizinho; a invariante só se fecha com o UPDATE e a conferência na mesma
    // transação, atrás do advisory lock da população de administradores.
    const adminsAtivas = async () => (await listUsers()).filter((u) => u.role === 'admin' && u.isActive);
    expect(await adminsAtivas()).toHaveLength(1);

    // Ana é a única admin ativa: rebaixá-la é 400, e nada é gravado.
    const sozinha = await capture(
      updateUser(anaUuid, { role: 'editor', requireOtherActiveAdmin: true }),
    );
    expect(sozinha.status).toBe(400);
    expect(sozinha.message).toBe(
      'Esta é a última conta de administrador ativa — promova outra antes',
    );
    expect((await getUserByUuid(anaUuid))?.role).toBe('admin');

    // Com duas admins ativas, os dois rebaixamentos simultâneos não passam os
    // dois: um vence e o outro é 400. Cinco rodadas porque a corrida só aparece
    // quando as duas transações de fato se sobrepõem — sem a trava, medido: 4 em
    // 5 rodadas terminaram com **zero** conta admin ativa.
    await updateUser(anaUuid, { isActive: false });
    for (let i = 0; i < 5; i++) {
      const uma = await createUser({ username: `dupla-a${i}`, email: `dupla-a${i}@exemplo.dev`, name: 'Dupla A', role: 'admin' });
      const outra = await createUser({ username: `dupla-b${i}`, email: `dupla-b${i}@exemplo.dev`, name: 'Dupla B', role: 'admin' });

      const disputa = await Promise.allSettled([
        updateUser(uma.uuid, { role: 'editor', requireOtherActiveAdmin: true }),
        updateUser(outra.uuid, { isActive: false, requireOtherActiveAdmin: true }),
      ]);
      expect(disputa.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        (disputa.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
      ).toMatchObject({ status: 400 });
      expect(await adminsAtivas()).toHaveLength(1);

      // Sem o campo, o mesmo UPDATE passa: a invariante é do app que a pede.
      const restante = (await adminsAtivas())[0]!;
      expect((await updateUser(restante.uuid, { isActive: false })).isActive).toBe(false);
    }

    await updateUser(anaUuid, { isActive: true });
  });
});
