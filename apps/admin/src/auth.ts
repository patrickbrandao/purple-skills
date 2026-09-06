import type { NextFunction, Request, Response } from 'express';
import { countUsers, getUserByUuid } from '@purple-skills/db';
import {
  type AuditActor,
  type Role,
  canDelete,
  canManageUsers,
  canWrite,
  isRole,
  safeEqual,
  signSession,
  verifySession,
} from '@purple-skills/shared';
import { SESSION_COOKIE, config, getAdminPassword, getSessionSecret } from './config.js';

/**
 * Quem está executando a requisição.
 *
 * `legacy` marca a sessão aberta com a `ADMIN_PASSWORD` antes de existir
 * qualquer conta: ela vale como admin, mas só enquanto a tabela `users` estiver
 * vazia (`docs/05-accounts-and-roles.md` §2.3).
 */
export type AuthUser = {
  uuid: string | null;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  legacy: boolean;
};

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export const LEGACY_ADMIN: AuthUser = {
  uuid: null,
  email: '',
  name: 'Administrador',
  role: 'admin',
  mustChangePassword: false,
  legacy: true,
};

export const actorOf = (user: AuthUser): AuditActor => ({
  userUuid: user.uuid,
  label: user.legacy ? 'bootstrap' : user.email,
});

/** Ator da requisição, mesmo em rotas onde a sessão é opcional. */
export function actorFrom(req: Request): AuditActor {
  return req.user ? actorOf(req.user) : { userUuid: null, label: 'desconhecido' };
}

/**
 * Confere a senha de bootstrap.
 *
 * Retorna `false` quando `ADMIN_PASSWORD` não está definida — sem senha
 * configurada não existe senha correta.
 */
export function checkBootstrapPassword(password: unknown): boolean {
  const expected = getAdminPassword();
  if (!expected) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  return safeEqual(password, expected);
}

export type SessionSubject = {
  uuid: string;
  role: Role;
  tokenVersion: number;
};

export function issueSession(req: Request, res: Response, subject: SessionSubject): void {
  setSessionCookie(
    req,
    res,
    signSession(
      { sub: subject.uuid, role: subject.role, ver: subject.tokenVersion, exp: expiry() },
      getSessionSecret(),
    ),
  );
}

/**
 * Sessão da senha única.
 *
 * O payload sai **sem** `role` e sem `ver` — é justamente essa ausência que a
 * marca como legada em `resolveUser`, que então a aceita apenas enquanto
 * `users` estiver vazia. Emiti-la pelo caminho normal, com `sub: 'admin'` e um
 * papel embutido, faria o middleware procurar um usuário chamado "admin".
 */
export function issueLegacySession(req: Request, res: Response): void {
  setSessionCookie(req, res, signSession({ sub: 'admin', exp: expiry() }, getSessionSecret()));
}

const expiry = () => Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;

function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // `Secure` só quando a requisição veio por HTTPS (respeitando o proxy),
    // senão o cookie seria descartado em um deploy HTTP interno.
    secure: config.cookieSecure ?? req.secure,
    maxAge: config.sessionTtlSeconds * 1000,
    path: '/',
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Resolve a sessão do cookie em um usuário.
 *
 * É aqui que a revogação acontece: o cookie continua stateless, mas cada
 * requisição autenticada relê a conta para conferir `is_active` e
 * `token_version`. Trocar senha, mudar papel ou desativar incrementa a versão
 * e derruba todo cookie emitido antes — sem tabela de sessões para limpar
 * (`docs/05-accounts-and-roles.md` §2.2).
 */
export async function resolveUser(req: Request): Promise<AuthUser | null> {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  const payload = verifySession(token, getSessionSecret());
  if (!payload) return null;

  // Sessão legada da senha única: sem papel nem versão no payload.
  if (!isRole(payload.role) || typeof payload.ver !== 'number') {
    return (await countUsers()) === 0 ? LEGACY_ADMIN : null;
  }

  const user = await getUserByUuid(payload.sub);
  if (!user || !user.isActive) return null;
  if (user.tokenVersion !== payload.ver) return null;

  return {
    uuid: user.uuid,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    legacy: false,
  };
}

const deny = (res: Response, status: number, code: string, message: string) => {
  res.status(status).json({ error: code, message });
};

/** Middleware que protege todas as rotas `/api/*` exceto login/estado. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  resolveUser(req)
    .then((user) => {
      if (!user) {
        deny(res, 401, 'unauthorized', 'Sessão expirada ou ausente');
        return;
      }
      req.user = user;
      next();
    })
    .catch((err) => next(err));
}

/**
 * Enquanto `must_change_password` estiver ligado, a sessão só serve para
 * trocar a senha. Sem isso, uma senha temporária ditada por telefone
 * continuaria valendo indefinidamente.
 */
/**
 * Caminhos **relativos ao ponto de montagem**: dentro de `api.use('/api', …)`
 * o Express já removeu o prefixo, e comparar com `/api/me/password` nunca
 * casaria — trancando quem entrou com senha temporária fora da única tela que
 * resolveria a situação.
 */
const PASSWORD_CHANGE_PATHS = new Set(['/me', '/me/password', '/session', '/logout']);

export function requirePasswordChanged(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.mustChangePassword && !PASSWORD_CHANGE_PATHS.has(req.path)) {
    deny(res, 403, 'password_change_required', 'Troque a senha temporária antes de continuar');
    return;
  }
  next();
}

type Check = (role: Role) => boolean;

function guard(check: Check, message: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = req.user?.role;
    if (role && check(role)) {
      next();
      return;
    }
    deny(res, 403, 'forbidden', message);
  };
}

/** Criar e editar skills, arquivos e visibilidade — admin e editor. */
export const requireWrite = guard(canWrite, 'Seu papel não permite alterar o catálogo');

/** Apagar skill — só admin. */
export const requireDelete = guard(canDelete, 'Só um administrador pode apagar uma skill');

/** Gerenciar contas — só admin. */
export const requireAdmin = guard(canManageUsers, 'Só um administrador pode gerenciar contas');
