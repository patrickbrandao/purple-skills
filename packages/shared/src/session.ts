import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from './roles.js';

export type SessionPayload = {
  /** Epoch em segundos de quando a sessão expira. */
  exp: number;
  /** UUID do usuário. `'admin'` numa sessão legada de `ADMIN_PASSWORD`. */
  sub: string;
  /**
   * Papel e versão do token são **opcionais no formato** porque a sessão da
   * senha única não os tem. Quem decide se uma sessão sem eles ainda vale é o
   * middleware do painel — este pacote não fala com o banco, e essa fronteira
   * é o que mantém `shared` livre de `@purple-skills/db`
   * (`docs/05-accounts-and-roles.md` §2.2).
   */
  role?: Role;
  /** Cópia de `users.token_version` no momento da emissão. */
  ver?: number;
};

/**
 * Sessão stateless: `base64url(payload).base64url(hmac)`.
 * Não há session store — o cookie assinado é a única fonte de verdade.
 */
export function signSession(payload: SessionPayload, secret: string): string {
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(
  token: string | undefined,
  secret: string,
  now: number = Date.now(),
): SessionPayload | null {
  if (!token) return null;

  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = sign(body, secret);
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload?.exp !== 'number' || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function sign(body: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(body).digest());
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}
