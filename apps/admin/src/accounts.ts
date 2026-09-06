import { createHash, randomBytes } from 'node:crypto';
import {
  badRequest,
  conflict,
  createApiKey,
  createResetToken,
  createUser,
  consumeResetToken,
  getUserByEmail,
  getUserByOidc,
  getUserByUuid,
  listApiKeys,
  listUsers,
  notFound,
  recordAccountAudit,
  registerFailedLogin,
  registerSuccessfulLogin,
  revokeApiKey,
  unauthorized,
  updateUser,
  type UserRecord,
} from '@purple-skills/db';
import {
  type ApiKeySummary,
  type AuditActor,
  type Role,
  type UserSummary,
  emailInDomains,
  generateApiKey,
  generatePassword,
  hashPassword,
  isRole,
  normalizeEmail,
  passwordProblem,
  verifyPassword,
} from '@purple-skills/shared';
import { config } from './config.js';
import type { AuthUser } from './auth.js';

const SOURCE = 'web-admin' as const;

/** O que o painel mostra de uma conta. Nunca inclui hash nem token. */
export function toPublicUser(user: UserRecord | UserSummary): UserSummary {
  const {
    uuid,
    email,
    name,
    role,
    isActive,
    hasPassword,
    mustChangePassword,
    oidcIssuer,
    lockedUntil,
    lastLoginAt,
    createdAt,
    updatedAt,
  } = user;
  return {
    uuid,
    email,
    name,
    role,
    isActive,
    hasPassword,
    mustChangePassword,
    oidcIssuer,
    lockedUntil,
    lastLoginAt,
    createdAt,
    updatedAt,
  };
}

export const listAccounts = (): Promise<UserSummary[]> => listUsers();

// ------------------------------------------------------------- bootstrap ---

/** Cria o primeiro administrador. Só roda com a tabela `users` vazia. */
export async function bootstrapAdmin(input: {
  email?: unknown;
  name?: unknown;
  password?: unknown;
}): Promise<UserSummary> {
  const email = normalizeEmail(input.email);
  if (!email) throw badRequest('Informe um e-mail válido');

  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('Informe o nome do administrador');

  const problem = passwordProblem(input.password);
  if (problem) throw badRequest(problem);

  const user = await createUser({
    email,
    name,
    role: 'admin',
    passwordHash: hashPassword(input.password as string),
  });

  await recordAccountAudit({
    action: 'user.create',
    source: SOURCE,
    actor: { userUuid: null, label: 'bootstrap' },
    targetLabel: email,
  });

  return toPublicUser(user);
}

// ----------------------------------------------------------------- login ---

export type LoginOutcome = { user: UserRecord } | { error: string; status: number };

/**
 * Login por conta.
 *
 * A resposta é **a mesma** para e-mail inexistente e senha errada: distingui-las
 * transforma o formulário num verificador de quem tem conta aqui. A trava por
 * `locked_until` é a única resposta diferente, e só depois de acertar o e-mail.
 */
export async function loginWithPassword(input: {
  email?: unknown;
  password?: unknown;
}): Promise<LoginOutcome> {
  const genericError = { error: 'E-mail ou senha incorretos', status: 401 };

  const email = normalizeEmail(input.email);
  const password = input.password;
  if (!email || typeof password !== 'string' || password.length === 0) return genericError;

  const user = await getUserByEmail(email);
  if (!user || !user.isActive || !user.passwordHash) return genericError;

  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
    const seconds = Math.ceil((new Date(user.lockedUntil).getTime() - Date.now()) / 1000);
    return {
      error: `Conta temporariamente bloqueada por excesso de tentativas. Tente de novo em ${Math.ceil(seconds / 60)} min.`,
      status: 429,
    };
  }

  if (!verifyPassword(password, user.passwordHash)) {
    await registerFailedLogin(user.uuid, {
      maxAttempts: config.loginMaxAttempts,
      lockSeconds: config.loginLockSeconds,
    });
    return genericError;
  }

  await registerSuccessfulLogin(user.uuid);
  return { user };
}

// ------------------------------------------------------------- gerência ----

export async function createAccount(
  actor: AuditActor,
  input: { email?: unknown; name?: unknown; role?: unknown; password?: unknown },
): Promise<{ user: UserSummary; temporaryPassword: string | null }> {
  const email = normalizeEmail(input.email);
  if (!email) throw badRequest('Informe um e-mail válido');

  const name = String(input.name ?? '').trim();
  if (!name) throw badRequest('Informe o nome');

  if (!isRole(input.role)) throw badRequest('Papel inválido: use admin, editor ou leitor');

  // Senha em branco gera uma temporária: a conta nasce utilizável e a pessoa
  // troca no primeiro acesso, sem o admin precisar inventar uma.
  const explicit = typeof input.password === 'string' && input.password.length > 0;
  if (explicit) {
    const problem = passwordProblem(input.password);
    if (problem) throw badRequest(problem);
  }
  const password = explicit ? (input.password as string) : generatePassword();

  const user = await createUser({
    email,
    name,
    role: input.role,
    passwordHash: hashPassword(password),
    mustChangePassword: !explicit,
  });

  await recordAccountAudit({
    action: 'user.create',
    source: SOURCE,
    actor,
    targetLabel: email,
  });

  return { user: toPublicUser(user), temporaryPassword: explicit ? null : password };
}

export async function updateAccount(
  actor: AuthUser,
  uuid: string,
  patch: { name?: unknown; role?: unknown; isActive?: unknown },
): Promise<UserSummary> {
  const target = await getUserByUuid(uuid);
  if (!target) throw notFound('Conta não encontrada');

  const changes: {
    name?: string;
    role?: Role;
    isActive?: boolean;
    bumpTokenVersion?: boolean;
  } = {};

  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw badRequest('O nome não pode ficar vazio');
    changes.name = name;
  }

  if (patch.role !== undefined) {
    if (!isRole(patch.role)) throw badRequest('Papel inválido: use admin, editor ou leitor');
    if (patch.role !== target.role) {
      // Um admin que se rebaixa perde o acesso à tela de contas na hora, e
      // pode ser o último — o caminho de volta seria mexer no banco à mão.
      if (target.uuid === actor.uuid) throw badRequest('Você não pode mudar o próprio papel');
      if (target.role === 'admin') await assertNotLastAdmin(target.uuid);
      changes.role = patch.role;
      changes.bumpTokenVersion = true;
    }
  }

  if (patch.isActive !== undefined) {
    const isActive = patch.isActive === true;
    if (isActive !== target.isActive) {
      if (target.uuid === actor.uuid) throw badRequest('Você não pode desativar a própria conta');
      if (!isActive && target.role === 'admin') await assertNotLastAdmin(target.uuid);
      changes.isActive = isActive;
      changes.bumpTokenVersion = true;
    }
  }

  const updated = await updateUser(uuid, changes);

  if (changes.role !== undefined) {
    await recordAccountAudit({
      action: 'user.role',
      source: SOURCE,
      actor: { userUuid: actor.uuid, label: actor.legacy ? 'bootstrap' : actor.email },
      targetLabel: `${target.email} → ${changes.role}`,
    });
  }
  if (changes.isActive === false) {
    await recordAccountAudit({
      action: 'user.deactivate',
      source: SOURCE,
      actor: { userUuid: actor.uuid, label: actor.legacy ? 'bootstrap' : actor.email },
      targetLabel: target.email,
    });
  }

  return toPublicUser(updated);
}

/** Reset feito pelo admin — o caminho que existe quando não há SMTP (§2.6). */
export async function resetAccountPassword(
  uuid: string,
): Promise<{ user: UserSummary; temporaryPassword: string }> {
  const target = await getUserByUuid(uuid);
  if (!target) throw notFound('Conta não encontrada');

  const password = generatePassword();
  const updated = await updateUser(uuid, {
    passwordHash: hashPassword(password),
    mustChangePassword: true,
    bumpTokenVersion: true,
  });

  return { user: toPublicUser(updated), temporaryPassword: password };
}

/** Troca de senha pelo próprio dono. Derruba as outras sessões dele. */
export async function changeOwnPassword(
  user: AuthUser,
  input: { currentPassword?: unknown; newPassword: unknown },
): Promise<void> {
  if (!user.uuid) throw badRequest('A sessão de bootstrap não tem senha para trocar');

  const record = await getUserByUuid(user.uuid);
  if (!record) throw notFound('Conta não encontrada');

  const problem = passwordProblem(input.newPassword);
  if (problem) throw badRequest(problem);

  // Conta só-OIDC ainda não tem senha: definir a primeira não exige a anterior.
  if (record.passwordHash && !verifyPassword(String(input.currentPassword ?? ''), record.passwordHash)) {
    throw unauthorized('Senha atual incorreta');
  }

  await updateUser(user.uuid, {
    passwordHash: hashPassword(input.newPassword as string),
    mustChangePassword: false,
    bumpTokenVersion: true,
  });
}

// ------------------------------------------------------ chaves de API ------

export const listKeys = (user: AuthUser): Promise<ApiKeySummary[]> =>
  user.uuid ? listApiKeys(user.uuid) : Promise.resolve([]);

export async function issueKey(
  user: AuthUser,
  rawName: unknown,
): Promise<{ key: ApiKeySummary; token: string }> {
  if (!user.uuid) throw badRequest('A sessão de bootstrap não pode emitir chaves — crie sua conta');

  const name = String(rawName ?? '').trim();
  if (!name) throw badRequest('Dê um nome à chave (ex.: "notebook do trabalho")');
  if (name.length > 80) throw badRequest('O nome da chave é longo demais');

  const generated = generateApiKey();
  const key = await createApiKey({
    userUuid: user.uuid,
    name,
    prefix: generated.prefix,
    keyHash: generated.keyHash,
  });

  await recordAccountAudit({
    action: 'key.create',
    source: SOURCE,
    actor: { userUuid: user.uuid, label: user.email },
    targetLabel: `${name} (${generated.prefix})`,
  });

  // Única vez que o texto completo existe fora do cliente.
  return { key, token: generated.token };
}

export async function revokeKey(user: AuthUser, id: string): Promise<void> {
  // Admin revoga qualquer chave; os demais, só as próprias.
  const scope = user.role === 'admin' ? null : user.uuid;
  const revoked = await revokeApiKey(id, scope);
  if (!revoked) throw notFound('Chave não encontrada ou já revogada');

  await recordAccountAudit({
    action: 'key.revoke',
    source: SOURCE,
    actor: { userUuid: user.uuid, label: user.legacy ? 'bootstrap' : user.email },
    targetLabel: id,
  });
}

// --------------------------------------------------- redefinição de senha ---

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Pede um link de redefinição.
 *
 * O token vai por e-mail; o banco guarda só o SHA-256 dele. Não é scrypt de
 * propósito: são 32 bytes aleatórios, sem entropia a compensar, e a busca é
 * exatamente por igualdade do hash.
 */
export async function requestPasswordReset(
  rawEmail: unknown,
  linkFor: (token: string) => string,
): Promise<void> {
  const email = normalizeEmail(rawEmail);
  if (!email) return;

  const user = await getUserByEmail(email);
  if (!user || !user.isActive) return;

  const token = randomBytes(32).toString('base64url');
  await createResetToken({
    userUuid: user.uuid,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + config.resetTtlSeconds * 1000),
  });

  const { sendMail, passwordResetMessage } = await import('./mailer.js');
  const message = passwordResetMessage(user.name, linkFor(token), config.resetTtlSeconds);
  await sendMail({ to: user.email, ...message });
}

export async function confirmPasswordReset(
  token: unknown,
  newPassword: unknown,
): Promise<void> {
  if (typeof token !== 'string' || token.length < 16) {
    throw badRequest('Link de redefinição inválido ou já usado');
  }

  const problem = passwordProblem(newPassword);
  if (problem) throw badRequest(problem);

  const consumed = await consumeResetToken(hashToken(token));
  if (!consumed) throw badRequest('Link de redefinição inválido, expirado ou já usado');

  await updateUser(consumed.userUuid, {
    passwordHash: hashPassword(newPassword as string),
    mustChangePassword: false,
    bumpTokenVersion: true,
  });
}

// -------------------------------------------------------------- OIDC -------

export type OidcClaims = { issuer: string; subject: string; email: unknown; name?: unknown };

/**
 * Resolve um login OIDC em uma conta local.
 *
 * A allowlist vale nos **três** caminhos — autenticar, provisionar e vincular
 * (§2.4). O papel nunca vem do provedor: conta nova nasce `leitor`, conta
 * existente mantém o papel que já tem.
 */
export async function resolveOidcUser(claims: OidcClaims): Promise<UserRecord> {
  const email = normalizeEmail(claims.email);
  if (!email) throw unauthorized('O provedor não devolveu um e-mail utilizável');

  if (!emailInDomains(email, config.oidcAllowedDomains)) {
    throw unauthorized(
      'Este e-mail não está em um domínio autorizado para entrar por SSO neste catálogo',
    );
  }

  const byOidc = await getUserByOidc(claims.issuer, claims.subject);
  if (byOidc) {
    if (!byOidc.isActive) throw unauthorized('Conta desativada');
    await registerSuccessfulLogin(byOidc.uuid);
    return byOidc;
  }

  const byEmail = await getUserByEmail(email);
  if (byEmail) {
    if (!byEmail.isActive) throw unauthorized('Conta desativada');
    // Vinculação: a conta local passa a aceitar também este provedor.
    if (byEmail.oidcSubject && byEmail.oidcSubject !== claims.subject) {
      throw conflict('Esta conta já está vinculada a outra identidade do provedor');
    }
    const linked = await updateUser(byEmail.uuid, {
      oidcIssuer: claims.issuer,
      oidcSubject: claims.subject,
    });
    await registerSuccessfulLogin(linked.uuid);
    return linked;
  }

  if (!config.oidcAutoProvision) {
    throw unauthorized('Auto-provisionamento desligado: peça um convite ao administrador');
  }

  const created = await createUser({
    email,
    name: String(claims.name ?? '').trim() || email,
    role: 'leitor',
    passwordHash: null,
    oidcIssuer: claims.issuer,
    oidcSubject: claims.subject,
  });

  await recordAccountAudit({
    action: 'user.create',
    source: SOURCE,
    actor: { userUuid: null, label: `oidc:${claims.issuer}` },
    targetLabel: email,
  });

  await registerSuccessfulLogin(created.uuid);
  return created;
}

async function assertNotLastAdmin(uuid: string): Promise<void> {
  const admins = (await listUsers()).filter(
    (user) => user.role === 'admin' && user.isActive && user.uuid !== uuid,
  );
  if (admins.length === 0) {
    throw badRequest('Esta é a última conta de administrador ativa — promova outra antes');
  }
}
