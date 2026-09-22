import type { NextFunction, Request, Response } from 'express';
import { countUsers, getUserByUuid, updateUser } from '@purple-skills/db';
import {
  type AuditActor,
  type Role,
  canCreate,
  canManageUsers,
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
  /**
   * O identificador público da conta (`docs/19-username.md` decisão 1). É ele
   * que vai para o `actor_label` da trilha e para toda superfície que nomeia
   * uma conta. Vazio na sessão de bootstrap, que não é conta.
   */
  username: string;
  /** O carimbo da foto para o avatar da sidebar; `null` cai no monograma. */
  avatarUpdatedAt: string | null;
  /**
   * O endereço da própria pessoa, e **só dela**: a sessão o usa para a tela
   * Conta e para o menu do usuário (decisão 8). Ele não entra em rótulo de
   * auditoria, em ACL nem em nada que outra conta leia — quem precisa nomear
   * esta conta para outra pessoa usa `username`.
   */
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
  username: '',
  avatarUpdatedAt: null,
  email: '',
  name: 'Administrador',
  role: 'admin',
  mustChangePassword: false,
  legacy: true,
};

export const actorOf = (user: AuthUser): AuditActor => ({
  userUuid: user.uuid,
  label: user.legacy ? 'bootstrap' : user.username,
});

/**
 * Quem está lendo, para as consultas de `@purple-skills/db` recortarem o que
 * a conta enxerga (`docs/12-acesso-granular.md` §3.1). Admin — inclusive a
 * sessão de bootstrap, que é admin sem conta — vê tudo.
 */
export const viewerOf = (user: AuthUser): { role: Role; userUuid: string | null } => ({
  role: user.role,
  userUuid: user.uuid,
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
    // senão o cookie seria descartado em um deploy HTTP interno. `req.secure`
    // sai do `X-Forwarded-Proto` quando o peer é confiável (ver
    // `trustProxySetting`, em `@purple-skills/shared`): quem alcança a porta
    // direto, já de dentro de uma faixa privada, escolhe esse cabeçalho. Atrás
    // de HTTPS, `ADMIN_COOKIE_SECURE=true` tira o palpite da jogada.
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
    username: user.username,
    avatarUpdatedAt: user.avatarUpdatedAt,
    email: user.email,
    name: user.name,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    legacy: false,
  };
}

/**
 * Encerra a sessão: apaga o cookie deste navegador **e** revoga o que já foi
 * emitido para a conta.
 *
 * Apagar o cookie sozinho não revoga nada — o token é stateless e vale até
 * `exp` (12 h por padrão), então uma cópia feita antes continuaria entrando
 * depois do "Sair". A única alavanca do desenho é `token_version`
 * (`docs/05-accounts-and-roles.md` §2.2) e ela é **por conta**: sair derruba
 * todas as sessões da pessoa, como já acontece quando ela troca a própria
 * senha. Revogar só este dispositivo exigiria identificador de sessão no
 * cookie e estado no servidor — a tabela de sessões que a decisão 7 recusa.
 *
 * O `boolean` diz se houve o que revogar, para a resposta poder avisar que as
 * outras sessões também caíram.
 */
export async function endSession(req: Request, res: Response): Promise<boolean> {
  // A sessão é lida antes de apagar o cookie, mas o cookie vai embora mesmo
  // que o banco esteja fora: sair do painel não pode depender dele.
  const user = await resolveUser(req).catch((err) => {
    console.error('[admin] falha ao ler a sessão no logout:', err);
    return null;
  });
  clearSession(res);

  // Sessão de bootstrap (`ADMIN_PASSWORD`) não tem conta: nada para versionar.
  if (!user?.uuid) return false;

  try {
    await updateUser(user.uuid, { bumpTokenVersion: true });
    return true;
  } catch (err) {
    // Melhor esforço, como a adoção de órfãos no login: o cookie já foi
    // apagado e a pessoa precisa sair da tela; a falha fica no log do operador.
    console.error('[admin] falha ao revogar as sessões no logout:', err);
    return false;
  }
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

/**
 * Criar skill, catálogo ou MCP virtual — admin e editor
 * (`docs/12-acesso-granular.md` decisão 12). É o único guarda de papel fora
 * da administração da instalação: tudo o mais é decidido pelo acesso ao
 * objeto (`access.ts`), e um membro administra o que é seu.
 */
export const requireCreate = guard(canCreate, 'Seu papel não permite criar no acervo');

/** Gerenciar contas — só admin. */
export const requireAdmin = guard(canManageUsers, 'Só um administrador pode gerenciar contas');

/** Alterar a configuração da instalação (o MCP padrão) — só admin. */
export const requireSettingsAdmin = guard(
  canManageUsers,
  'Só um administrador altera a configuração da instalação',
);
