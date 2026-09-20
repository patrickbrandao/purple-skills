import { createHash, randomBytes } from 'node:crypto';
import {
  adoptOrphans,
  badRequest,
  conflict,
  countUsers,
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

/**
 * Campo de texto de um corpo JSON. Era `String(valor ?? '')`, que estourava
 * `TypeError` no objeto cujo `toString` não é função — `{"name":{"toString":1}}`
 * —, devolvido pela rota como 500 com linha de "erro inesperado" no log, e
 * aceitava o resto em silêncio: `{"name":{}}` criava a conta "[object Object]"
 * e `{"name":null}`, no PATCH, rebatizava a conta de "null" (achado do relatório
 * 007 da auditoria de 2026-09-19). Ausente ou nulo é `''`, e quem chama responde
 * com a validação que já tinha; presente e não-texto é 400, com a frase que as
 * rotas de skill usam para `skillMd` e `content` de tipo errado.
 */
function textOf(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw badRequest(`O campo "${field}" deve ser uma string`);
  return value;
}

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

/**
 * Cria o primeiro administrador. Só roda com a tabela `users` vazia — e quem
 * confere é também esta função, não apenas a rota que a chama.
 *
 * A corrida do `tasks/049` é fechada **no banco**: `createUser` recebe
 * `onlyIfTableEmpty: true` e conta as contas na mesma transação do INSERT,
 * atrás do advisory lock da população de administradores. Dois `POST /api/setup`
 * simultâneos com a `ADMIN_PASSWORD` correta se enfileiram e o segundo recebe
 * 409 — medido pelo dba: sem o campo, os dois criavam conta admin, o que além
 * do óbvio desliga a adoção de órfãos, que exige **uma** conta admin ativa
 * (`adoptOrphansFor`).
 *
 * O `countUsers()` daqui fica como recusa barata e antecipada. Ele não fecha
 * nada — a leitura e o INSERT são transações distintas, e o compose pode rodar
 * mais de um container do painel —, mas tira o scrypt da senha de dentro da
 * janela (~70 ms nesta máquina, ver `gastarTrabalhoDeSenha`) e poupa a
 * transação do caminho comum. As duas recusas usam o mesmo texto de propósito:
 * a resposta do `/api/setup` não muda de forma conforme quem recusou.
 */
export async function bootstrapAdmin(input: {
  email?: unknown;
  name?: unknown;
  password?: unknown;
}): Promise<UserSummary> {
  const email = normalizeEmail(input.email);
  if (!email) throw badRequest('Informe um e-mail válido');

  const name = textOf(input.name, 'name').trim();
  if (!name) throw badRequest('Informe o nome do administrador');

  const problem = passwordProblem(input.password);
  if (problem) throw badRequest(problem);

  // O hash vem antes da conferência de propósito: é ele que custa (scrypt), e
  // deixá-lo depois manteria a janela da corrida do tamanho de um scrypt.
  const passwordHash = hashPassword(input.password as string);

  if ((await countUsers()) > 0) {
    throw conflict('Este painel já tem contas: o primeiro administrador já foi criado');
  }

  const user = await createUser({
    email,
    name,
    role: 'admin',
    passwordHash,
    // Conta e INSERT na mesma transação: é isto que fecha a corrida do primeiro
    // administrador (ver o cabeçalho). Tabela cheia é 409, com este mesmo texto.
    onlyIfTableEmpty: true,
  });

  await recordAccountAudit({
    action: 'user.create',
    source: SOURCE,
    actor: { userUuid: null, label: 'bootstrap' },
    targetLabel: email,
  });

  // O que a sessão de bootstrap criou passa a ser do primeiro admin.
  await adoptOrphansFor(user, { userUuid: null, label: 'bootstrap' });

  return toPublicUser(user);
}

/**
 * O administrador solitário adota as skills e os catálogos sem dono
 * (`docs/05-accounts-and-roles.md` §2.3): o que a sessão de bootstrap ou o
 * token global criaram nasce órfão, e passa a ser da conta quando ela é a
 * única admin ativa — no `/api/setup` e a cada login. Quem confere a
 * condição é o banco (`adoptOrphans`); aqui só se evita a ida ao banco para
 * quem não é admin.
 *
 * Melhor esforço: uma falha vai para o log e não impede a entrada.
 */
export async function adoptOrphansFor(
  user: { uuid: string; email: string; role: Role },
  actor: AuditActor = { userUuid: user.uuid, label: user.email },
): Promise<void> {
  if (user.role !== 'admin') return;
  try {
    const { skills, catalogs } = await adoptOrphans(user.uuid, SOURCE, actor);
    if (skills + catalogs > 0) {
      console.log(`[admin] ${user.email} adotou ${skills} skill(s) e ${catalogs} catálogo(s) sem dono`);
    }
  } catch (err) {
    console.error('[admin] falha ao adotar skills e catálogos sem dono:', err);
  }
}

// ----------------------------------------------------------------- login ---

export type LoginOutcome = { user: UserRecord } | { error: string; status: number };

/**
 * Hash descartável, com o mesmo custo dos hashes de senha de verdade, para
 * gastar o mesmo scrypt quando não existe conta para conferir.
 *
 * Sem ele a resposta genérica do login é derrotada pelo relógio: medido nesta
 * máquina, e-mail sem conta responde em ~1 ms e e-mail com conta em ~70 ms, e as
 * faixas nem se tocam — uma única tentativa classifica o endereço.
 *
 * Nasce na primeira necessidade, não no import: quem nunca erra o login não paga
 * scrypt no boot. A primeira tentativa inválida do processo custa dois (gerar e
 * conferir), o que é uma vez por processo e desvia para **cima** — logo não
 * reabre o oráculo.
 */
let hashSentinela: string | null = null;

/** Gasta o trabalho do caminho com conta. Não confere nada: nunca bate. */
function gastarTrabalhoDeSenha(password: string): void {
  hashSentinela ??= hashPassword(randomBytes(32).toString('base64url'));
  verifyPassword(password, hashSentinela);
}

/**
 * Login por conta.
 *
 * A resposta é **a mesma** para e-mail inexistente e senha errada — no texto e
 * no tempo: distingui-las transforma o formulário num verificador de quem tem
 * conta aqui. O corpo igual não basta, porque conferir a senha custa scrypt e
 * quem não tem conta não teria nada a conferir; daí o `gastarTrabalhoDeSenha`.
 * A trava por `locked_until` é a única resposta diferente, e só depois de
 * acertar o e-mail.
 */
export async function loginWithPassword(input: {
  email?: unknown;
  password?: unknown;
}): Promise<LoginOutcome> {
  const genericError = { error: 'E-mail ou senha incorretos', status: 401 };

  const email = normalizeEmail(input.email);
  const password = input.password;
  // Este ramo não gasta scrypt de propósito: ele depende só do que o cliente
  // mandou, não de haver conta, então não vaza nada — e queimar CPU em pedido
  // vazio seria oferecer negação de serviço de graça.
  if (!email || typeof password !== 'string' || password.length === 0) return genericError;

  const user = await getUserByEmail(email);
  if (!user || !user.isActive || !user.passwordHash) {
    // O que vaza aqui é o tempo, não o texto. Vale também para conta desativada
    // e para conta só-OIDC: sem isto elas se separariam de um e-mail sem conta.
    gastarTrabalhoDeSenha(password);
    return genericError;
  }

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
  await adoptOrphansFor(user);
  return { user };
}

// ------------------------------------------------------------- gerência ----

export async function createAccount(
  actor: AuditActor,
  input: { email?: unknown; name?: unknown; role?: unknown; password?: unknown },
): Promise<{ user: UserSummary; temporaryPassword: string | null }> {
  const email = normalizeEmail(input.email);
  if (!email) throw badRequest('Informe um e-mail válido');

  const name = textOf(input.name, 'name').trim();
  if (!name) throw badRequest('Informe o nome');

  if (!isRole(input.role)) throw badRequest('Papel inválido: use admin, editor ou membro');

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
    /**
     * Liga a invariante "sempre sobra um administrador" **dentro** da transação
     * do UPDATE (`tasks/049`). Só entra quando a escrita tira a conta do grupo —
     * rebaixar ou desativar um admin —, porque a conferência do banco é "existe
     * **outra** admin ativa": informá-la numa escrita qualquer recusaria o PATCH
     * numa instalação que esteja com um admin só, ou com nenhum.
     */
    requireOtherActiveAdmin?: boolean;
  } = {};

  if (patch.name !== undefined) {
    const name = textOf(patch.name, 'name').trim();
    if (!name) throw badRequest('O nome não pode ficar vazio');
    changes.name = name;
  }

  if (patch.role !== undefined) {
    if (!isRole(patch.role)) throw badRequest('Papel inválido: use admin, editor ou membro');
    if (patch.role !== target.role) {
      // Um admin que se rebaixa perde o acesso à tela de contas na hora, e
      // pode ser o último — o caminho de volta seria mexer no banco à mão.
      if (target.uuid === actor.uuid) throw badRequest('Você não pode mudar o próprio papel');
      if (target.role === 'admin') {
        await assertNotLastAdmin(target.uuid);
        changes.requireOtherActiveAdmin = true;
      }
      changes.role = patch.role;
      changes.bumpTokenVersion = true;
    }
  }

  if (patch.isActive !== undefined) {
    // O `=== true` de antes transformava `"true"`, `1` ou `"sim"` em `false` e
    // **desativava** a conta em silêncio: as sessões caíam (`bumpTokenVersion`)
    // e a trilha registrava `user.deactivate` como se fosse o pedido. As rotas
    // de vMCP e de catálogo já cobram booleano (`mcps.ts`, `catalogs.ts`), e
    // aqui o campo só chega quando o cliente quis mexer nele — o que não é
    // booleano é erro dele, não uma desativação.
    if (typeof patch.isActive !== 'boolean') {
      throw badRequest('"isActive" precisa ser true ou false');
    }
    const isActive = patch.isActive;
    if (isActive !== target.isActive) {
      if (target.uuid === actor.uuid) throw badRequest('Você não pode desativar a própria conta');
      if (!isActive && target.role === 'admin') {
        await assertNotLastAdmin(target.uuid);
        changes.requireOtherActiveAdmin = true;
      }
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
  // O par do de cima, que faltava (relatório 003 da auditoria de 2026-09-19):
  // reativar devolve de uma vez o login, as concessões e as chaves `psk_` da
  // conta, e a trilha mostrava duas desativações seguidas sem dizer quem a
  // religou no meio. Só entra quando o estado mudou de fato — `isActive: true`
  // numa conta já ativa não chega a `changes`.
  if (changes.isActive === true) {
    await recordAccountAudit({
      action: 'user.activate',
      source: SOURCE,
      actor: { userUuid: actor.uuid, label: actor.legacy ? 'bootstrap' : actor.email },
      targetLabel: target.email,
    });
  }

  return toPublicUser(updated);
}

/**
 * A trilha da senha trocada por quem não é o dono logado: a redefinição pelo
 * admin e o link de e-mail consumido. Registra **quem** agiu e **em quem** —
 * nunca a senha temporária nem o token do link, que não têm por que sobreviver
 * ao pedido.
 *
 * O que a linha implica: a conta passa a exigir senha nova no próximo acesso,
 * **toda sessão dela cai** (`bumpTokenVersion`) e os links de redefinição dela
 * que ainda estavam vivos **são fechados** — um trigger em `users` carimba
 * `reset_tokens.superseded_at` quando `password_hash` muda
 * (`database/schema/023-links-de-reset-substituidos.sql`, `tasks/027`). Vale
 * para os três caminhos que trocam senha, porque os três passam por
 * `updateUser`. Exceção: o link recém-consumido não é tocado, já tem `used_at`
 * — e é esse carimbo que continua dizendo qual link redefiniu a senha.
 *
 * Melhor esforço, como a adoção de órfãos: a senha já mudou e as sessões já
 * caíram quando esta linha é escrita, e a resposta da redefinição pelo admin é
 * o único lugar onde a senha temporária existe — perdê-la por causa da trilha
 * deixaria a conta com uma senha que ninguém conhece. A falha vai para o log.
 *
 * `user.password` **vale no banco** desde
 * `database/schema/024-auditoria-de-troca-de-senha.sql`: a ação está no `CHECK`
 * de `audit_log.action`, no union de `recordAccountAudit` e em `AUDIT_ACTIONS`
 * (o espelho que faz `GET /api/audit?action=user.password` responder 200). A
 * linha grava de verdade; antes o `INSERT` era recusado e só o log registrava.
 *
 * O `try/catch` **fica**, e agora só apanha o que ele deve: o que ele escondia
 * era a ação fora do catálogo — erro de programação, que a migration eliminou —
 * e o que resta é falha de infraestrutura, exatamente o caso em que derrubar a
 * resposta perderia a senha temporária.
 */
async function registrarTrocaDeSenha(actor: AuditActor, email: string): Promise<void> {
  try {
    await recordAccountAudit({
      action: 'user.password',
      source: SOURCE,
      actor,
      targetLabel: email,
    });
  } catch (err) {
    console.error(`[admin] falha ao auditar a redefinição de senha de ${email}:`, err);
  }
}

/** Reset feito pelo admin — o caminho que existe quando não há SMTP (§2.6). */
export async function resetAccountPassword(
  actor: AuthUser,
  uuid: string,
): Promise<{ user: UserSummary; temporaryPassword: string }> {
  const target = await getUserByUuid(uuid);
  if (!target) throw notFound('Conta não encontrada');

  const password = generatePassword();
  const updated = await updateUser(uuid, {
    passwordHash: hashPassword(password),
    mustChangePassword: true,
    bumpTokenVersion: true,
    // A ficha da conta promete que gerar a senha temporária "destrava na hora"
    // (`UserAlerts`, em `web/src/pages/UserPage.tsx`). Sem isto a temporária
    // certa era recusada com 429 até `locked_until` vencer, porque o login
    // confere a trava **antes** da senha (relatório 005 da auditoria de
    // 2026-09-19). `changeOwnPassword` não passa o campo — quem está logado não
    // está trancado do lado de fora —, e no link de e-mail
    // (`confirmPasswordReset`) destravar é decisão do mantenedor, ainda aberta.
    clearLoginLock: true,
  });

  // Trocar a senha de outra conta é assumi-la: é a ação mais forte da tela de
  // contas, e era a única que não deixava rastro de quem a fez.
  await registrarTrocaDeSenha(
    { userUuid: actor.uuid, label: actor.legacy ? 'bootstrap' : actor.email },
    target.email,
  );

  return { user: toPublicUser(updated), temporaryPassword: password };
}

/** Troca de senha pelo próprio dono. Derruba as outras sessões dele. */
export async function changeOwnPassword(
  user: AuthUser,
  input: { currentPassword?: unknown; newPassword: unknown },
): Promise<void> {
  if (!user.uuid) throw badRequest('A sessão de bootstrap não tem senha para trocar');

  // Ausente vale `''` e cai no "Senha atual incorreta" de sempre.
  const currentPassword = textOf(input.currentPassword, 'currentPassword');

  const record = await getUserByUuid(user.uuid);
  if (!record) throw notFound('Conta não encontrada');

  const problem = passwordProblem(input.newPassword);
  if (problem) throw badRequest(problem);

  // Conta só-OIDC ainda não tem senha: definir a primeira não exige a anterior.
  if (record.passwordHash && !verifyPassword(currentPassword, record.passwordHash)) {
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

  const name = textOf(rawName, 'name').trim();
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

/** A ficha de uma conta no painel (`docs/13-fichas-e-acessos.md` §3.4): só admin chega aqui. */
export async function getAccount(uuid: string): Promise<UserSummary> {
  const target = await getUserByUuid(uuid);
  if (!target) throw notFound('Conta não encontrada');
  return toPublicUser(target);
}

/** As chaves `psk_` de uma conta, na guia Chaves da ficha — inclusive as revogadas, como histórico. */
export async function listAccountKeys(uuid: string): Promise<ApiKeySummary[]> {
  await getAccount(uuid);
  return listApiKeys(uuid);
}

/**
 * O rótulo de um `key.revoke` na trilha: `<e-mail do dono>: <nome> (<prefixo>)`.
 * A emissão já rotulava `<nome> (<prefixo>)`; a revogação gravava o **uuid** da
 * chave, que não aparece em tela nenhuma — a linha não se casava com a da
 * emissão, e quem lê a trilha não sabia que chave era (relatório 040 da
 * auditoria de 2026-09-19). O nome, o prefixo e o e-mail do dono vêm do próprio
 * `UPDATE` da revogação, sem leitura a mais nem corrida com ela. Linha antiga
 * não é reescrita: continua com o uuid.
 */
const revokedKeyLabel = (revoked: { name: string; prefix: string; userEmail: string }): string =>
  `${revoked.userEmail}: ${revoked.name} (${revoked.prefix})`;

/**
 * O admin revoga uma chave de outra conta pela ficha dela. O escopo pelo dono
 * garante que o id pertence àquela conta — uma chave de terceiro é 404.
 */
export async function revokeAccountKey(actor: AuthUser, uuid: string, id: string): Promise<void> {
  const target = await getAccount(uuid);
  const revoked = await revokeApiKey(id, target.uuid);
  if (!revoked) throw notFound('Chave não encontrada ou já revogada');

  await recordAccountAudit({
    action: 'key.revoke',
    source: SOURCE,
    actor: { userUuid: actor.uuid, label: actor.legacy ? 'bootstrap' : actor.email },
    targetLabel: revokedKeyLabel(revoked),
  });
}

export async function revokeKey(user: AuthUser, id: string): Promise<void> {
  // Admin revoga qualquer chave; os demais, só as próprias.
  const scope = user.role === 'admin' ? null : user.uuid;
  const revoked = await revokeApiKey(id, scope);
  if (!revoked) throw notFound('Chave não encontrada ou já revogada');

  // Com `scope` nulo o dono pode não ser quem revogou (um admin, pela API, com a
  // chave de outra conta): o rótulo diz de quem ela era, como o da ficha.
  await recordAccountAudit({
    action: 'key.revoke',
    source: SOURCE,
    actor: { userUuid: user.uuid, label: user.legacy ? 'bootstrap' : user.email },
    targetLabel: revokedKeyLabel(revoked),
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
 *
 * A rota **não espera** esta função (`POST /api/password-reset/request`): o
 * tempo daqui depende de haver conta — um SELECT contra gravação mais conversa
 * SMTP —, e esperar faria do relógio um verificador de cadastro. Quem chama só
 * registra a rejeição no log; por isso a falha de envio é tratada aqui, onde
 * ainda se sabe de qual conta era.
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
  try {
    await sendMail({ to: user.email, ...message });
  } catch (err) {
    // `createResetToken` já fechou o link anterior desta conta (um link vivo por
    // vez) e o novo não saiu: a pessoa ficou sem link nenhum. Quem pediu não
    // pode saber — o anônimo receberia um 500 só para e-mail com conta —, então
    // o log é o único lugar onde o administrador descobre que precisa agir.
    console.error(
      `[admin] o link de redefinição de ${user.email} foi gravado, mas o envio falhou; ` +
        'o link anterior da conta já não vale — redefina a senha pelo painel ou peça novo envio:',
      err,
    );
  }
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

  const updated = await updateUser(consumed.userUuid, {
    passwordHash: hashPassword(newPassword as string),
    mustChangePassword: false,
    bumpTokenVersion: true,
  });

  // Quem chegou aqui portava o link, e é só isso que se sabe: o ator é o
  // caminho, não a conta — atribuí-la ao dono afirmaria uma posse que um link
  // vazado desmente. Sem esta linha, senha trocada por link não aparece em
  // lugar nenhum.
  await registrarTrocaDeSenha({ userUuid: null, label: 'link-de-redefinicao' }, updated.email);
}

// -------------------------------------------------------------- OIDC -------

export type OidcClaims = {
  issuer: string;
  subject: string;
  email: unknown;
  /** `email_verified` do provedor; `undefined` = ele não informou. */
  emailVerified?: boolean | undefined;
  name?: unknown;
};

/**
 * A trilha do vínculo: uma identidade do provedor passou a abrir uma conta local
 * que já existia (relatório 003 da auditoria de 2026-09-19). Acontece uma vez
 * por conta — é evento de conta, não login, que segue fora da trilha (§2.8) —,
 * e por isso só o ramo de vinculação chama isto: a identidade já vinculada entra
 * sem deixar linha. O ator é o **caminho**, como no link de redefinição e no
 * `user.create` por SSO: quem chegou é uma identidade do provedor, e é o
 * `subject`, no alvo, que diz qual. Se o vínculo levou junto a senha temporária
 * (relatório 002), a linha diz — é a única pista de por que a conta ficou sem
 * senha local.
 *
 * Melhor esforço, como `registrarTrocaDeSenha`: quando a linha é escrita o
 * vínculo já foi gravado, e derrubar o login aqui deixaria a conta vinculada, a
 * pessoa com erro na tela e a trilha igualmente sem a linha. É também o que
 * mantém o SSO de pé se o painel novo subir contra um banco ainda sem a
 * migration `auditoria-de-vinculo-e-reativacao`, em que o `CHECK` recusa a ação.
 */
async function registrarVinculo(
  claims: OidcClaims,
  email: string,
  descartouTemporaria: boolean,
): Promise<void> {
  try {
    await recordAccountAudit({
      action: 'user.link',
      source: SOURCE,
      actor: { userUuid: null, label: `oidc:${claims.issuer}` },
      targetLabel: `${email} (sub ${claims.subject}${descartouTemporaria ? '; senha temporária descartada' : ''})`,
    });
  } catch (err) {
    console.error(`[admin] falha ao auditar o vínculo OIDC de ${email}:`, err);
  }
}

/**
 * Resolve um login OIDC em uma conta local.
 *
 * A allowlist vale nos **três** caminhos — autenticar, provisionar e vincular
 * (§2.4); vazia, recusa os três, inclusive a identidade já vinculada. O papel
 * nunca vem do provedor: conta nova nasce `membro`, conta existente mantém o
 * papel que já tem.
 *
 * `email_verified` pesa diferente em cada caminho, porque o que está em jogo é
 * diferente:
 *
 * - **identidade já vinculada** — não é consultado: a ligação veio de um ato
 *   anterior, e exigir o claim aqui derrubaria quem já entra por SSO;
 * - **vincular a uma conta local que já existe** — exige `true`. Vincular é
 *   assumir a conta, com o papel, o que ela possui e o que lhe foi concedido;
 * - **criar conta nova** — só recusa o `false` explícito. A conta nasce
 *   `membro`, que depois do `12` vê apenas o público, o seu e o concedido, e
 *   exigir o claim aqui trancaria instalação legítima cujo provedor não o
 *   emite.
 *
 * Criar conta nova exige ainda que **já exista conta**: a primeira é sempre o
 * admin do `/api/setup`, e com a tabela vazia o SSO não provisiona ninguém.
 * Vincular grava `user.link` na trilha (`registrarVinculo`) e, se a conta ainda
 * estava com senha temporária, leva a temporária junto. Os porquês estão no
 * ponto de cada um.
 */
export async function resolveOidcUser(claims: OidcClaims): Promise<UserRecord> {
  const email = normalizeEmail(claims.email);
  if (!email) throw unauthorized('O provedor não devolveu um e-mail utilizável');

  // Allowlist vazia recusa todo mundo, e não só o auto-provisionamento: a
  // conferência vem antes de procurar a conta, então nem quem já está vinculado
  // entra. É a falha fechada da §2.4 — sem allowlist, qualquer conta do provedor
  // viraria `membro` do catálogo. Mas merece mensagem própria: com a genérica o
  // operador procura o erro no domínio da pessoa, não na variável que esqueceu.
  if (config.oidcAllowedDomains.length === 0) {
    console.error('[admin] OIDC_ALLOWED_DOMAINS vazia: todo login por SSO é recusado');
    throw unauthorized(
      'OIDC_ALLOWED_DOMAINS está vazia e por isso o SSO recusa todo login, inclusive ' +
        'de contas que já existem. Entre pelo login local e preencha a variável com os ' +
        'domínios autorizados.',
    );
  }

  if (!emailInDomains(email, config.oidcAllowedDomains)) {
    throw unauthorized(
      'Este e-mail não está em um domínio autorizado para entrar por SSO neste catálogo',
    );
  }

  const byOidc = await getUserByOidc(claims.issuer, claims.subject);
  if (byOidc) {
    if (!byOidc.isActive) throw unauthorized('Conta desativada');
    await registerSuccessfulLogin(byOidc.uuid);
    await adoptOrphansFor(byOidc);
    return byOidc;
  }

  const byEmail = await getUserByEmail(email);
  if (byEmail) {
    if (!byEmail.isActive) throw unauthorized('Conta desativada');
    // Vinculação: a conta local passa a aceitar também este provedor.
    if (byEmail.oidcSubject && byEmail.oidcSubject !== claims.subject) {
      throw conflict('Esta conta já está vinculada a outra identidade do provedor');
    }
    // A allowlist diz de que domínio vem o endereço, não quem é o dono dele.
    // Só `email_verified` afirma a posse, e sem ela um provedor com
    // autocadastro entrega a conta do admin a quem digitar o e-mail dele —
    // é o risco residual da §2.4, fechado aqui, no caminho que o realiza.
    if (claims.emailVerified !== true) {
      throw unauthorized(
        'O provedor não confirmou a posse deste e-mail (email_verified), então esta ' +
          'identidade não pode assumir a conta que já existe com ele. Peça a um ' +
          'administrador uma senha para entrar por ela.',
      );
    }
    // Conta cuja senha temporária nunca foi trocada — a pré-criada em "Nova
    // conta", que é o "convite" de quem usa `OIDC_AUTO_PROVISION=false`. Quem
    // chegou aqui provou a posse do e-mail pelo provedor, a mesma força do link
    // de redefinição, e a tela de troca cobraria uma senha que só o administrador
    // viu (relatório 002 da auditoria de 2026-09-19). Desligar só a flag deixaria
    // a temporária valendo para sempre (ver `requirePasswordChanged`), então ela
    // morre junto: a conta vira só-SSO, as sessões abertas com a temporária caem
    // — o cookie novo sai com a versão que volta daqui — e a pessoa define uma
    // senha depois, em Minha conta, sem precisar da anterior
    // (`changeOwnPassword`). Senha escolhida pela própria pessoa
    // (`mustChangePassword` desligado) não é tocada.
    const descartarTemporaria = byEmail.mustChangePassword;
    const linked = await updateUser(byEmail.uuid, {
      oidcIssuer: claims.issuer,
      oidcSubject: claims.subject,
      ...(descartarTemporaria
        ? { passwordHash: null, mustChangePassword: false, bumpTokenVersion: true }
        : {}),
    });
    await registrarVinculo(claims, linked.email, descartarTemporaria);
    await registerSuccessfulLogin(linked.uuid);
    await adoptOrphansFor(linked);
    return linked;
  }

  // A primeira conta tem de ser o admin do `/api/setup` (§2.3). O setup (404) e
  // o login pela `ADMIN_PASSWORD` (401) fecham quando aparece **qualquer** conta:
  // um `membro` criado aqui com a tabela vazia deixava a instalação com conta,
  // sem administrador e sem caminho para criar um — a volta era SQL à mão
  // (relatório 001 da auditoria de 2026-09-19). Vem antes do
  // `OIDC_AUTO_PROVISION`: com a tabela vazia não existe administrador a quem
  // pedir convite. A leitura e o INSERT são transações distintas, mas conta
  // nenhuma é apagada pelo produto: se esta leitura viu uma, a tabela não volta a
  // ficar vazia — não há corrida a fechar, nem lock a pagar. Autenticar e
  // vincular, acima, exigem conta que já existe e não passam por aqui.
  if ((await countUsers()) === 0) {
    throw unauthorized(
      'Este painel ainda não tem administrador. Use "Criar o primeiro administrador", ' +
        'na tela de login, com a ADMIN_PASSWORD; o SSO passa a valer depois disso.',
    );
  }

  if (!config.oidcAutoProvision) {
    throw unauthorized('Auto-provisionamento desligado: peça um convite ao administrador');
  }

  // Aqui a ausência do claim passa (ver o cabeçalho da função), mas o `false`
  // explícito não: o provedor está dizendo que o endereço é de outra pessoa, e
  // gravá-lo queimaria o e-mail dela no catálogo.
  if (claims.emailVerified === false) {
    throw unauthorized(
      'O provedor informou que este e-mail não é verificado: confirme o endereço ' +
        'nele antes de entrar por SSO',
    );
  }

  const created = await createUser({
    email,
    // O claim vem do provedor, não de quem está entrando: o que não é texto vale
    // como ausente (o nome cai no e-mail) em vez de derrubar o login — `String()`
    // de um objeto sem `toString` lança.
    name: (typeof claims.name === 'string' ? claims.name.trim() : '') || email,
    role: 'membro',
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
  await adoptOrphansFor(created);
  return created;
}

/**
 * Recusa rebaixar ou desativar a última conta de administrador ativa.
 *
 * **Isto é uma leitura, e a escrita é outra transação** (`tasks/049`): dois
 * PATCH simultâneos rebaixando administradores **diferentes** passavam os dois
 * por aqui e deixavam a instalação sem nenhum — medido pelo dba: **4 de 5
 * rodadas** terminaram com zero admin ativo, estado cuja volta é mexer no banco
 * à mão. Serializar em memória não resolveria: o compose pode rodar mais de um
 * container do painel.
 *
 * Quem garante agora é o banco, na mesma transação do `UPDATE`: quem chama esta
 * função passa também `requireOtherActiveAdmin: true` ao `updateUser`, e aí um
 * dos dois PATCH vence e o outro é 400, em 5/5. O que fica aqui é a recusa
 * **cedo** — antes de escrever qualquer coisa e sem pagar transação nem lock —,
 * com o texto **idêntico** ao da recusa do banco: a operadora lê a mesma frase
 * seja quem recusar, e nos dois casos nada foi gravado.
 */
async function assertNotLastAdmin(uuid: string): Promise<void> {
  const admins = (await listUsers()).filter(
    (user) => user.role === 'admin' && user.isActive && user.uuid !== uuid,
  );
  if (admins.length === 0) {
    throw badRequest('Esta é a última conta de administrador ativa — promova outra antes');
  }
}
