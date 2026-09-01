import type { NextFunction, Request, Response } from 'express';
import { safeEqual, signSession, verifySession } from '@purple-skills/shared';
import { SESSION_COOKIE, config, getAdminPassword, getSessionSecret } from './config.js';

/** Confere a senha do painel com comparação resistente a timing attacks. */
export function checkPassword(password: unknown): boolean {
  if (typeof password !== 'string' || password.length === 0) return false;
  return safeEqual(password, getAdminPassword());
}

export function issueSession(req: Request, res: Response): void {
  const exp = Math.floor(Date.now() / 1000) + config.sessionTtlSeconds;
  const token = signSession({ sub: 'admin', exp }, getSessionSecret());

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

export function isAuthenticated(req: Request): boolean {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  return verifySession(token, getSessionSecret()) !== null;
}

/** Middleware que protege todas as rotas `/api/*` exceto login/estado. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized', message: 'Sessão expirada ou ausente' });
}
