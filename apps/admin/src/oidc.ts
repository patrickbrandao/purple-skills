import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import * as client from 'openid-client';
import { OIDC_COOKIE, config, getSessionSecret, oidcClientSecret, panelBaseUrl } from './config.js';

/**
 * Login por OIDC — authorization code + PKCE, via `openid-client`.
 *
 * O discovery e o fluxo ficam com a biblioteca de propósito: escrever
 * validação de `id_token` à mão é como o projeto ganharia uma vulnerabilidade
 * sutil (`docs/05-accounts-and-roles.md` §2.4).
 */
let configuration: client.Configuration | null = null;

async function getConfiguration(): Promise<client.Configuration> {
  configuration ??= await client.discovery(
    new URL(config.oidcIssuer),
    config.oidcClientId,
    oidcClientSecret(),
  );
  return configuration;
}

export const redirectUri = (req: Request): string =>
  `${panelBaseUrl(req.protocol, req.get('host') ?? `localhost:${config.port}`)}/api/auth/oidc/callback`;

type FlowState = { verifier: string; nonce: string; state: string };

/**
 * O estado do fluxo viaja num cookie próprio, assinado com o segredo da
 * sessão e válido por 10 minutos. Assinado porque um cookie plantado por um
 * atacante de rede faria o painel aceitar um `code` que ele escolheu.
 */
export function beginLogin(req: Request, res: Response): Promise<string> {
  return (async () => {
    const cfg = await getConfiguration();

    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const flow: FlowState = {
      verifier,
      nonce: client.randomNonce(),
      state: client.randomState(),
    };

    res.cookie(OIDC_COOKIE, seal(flow), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure ?? req.secure,
      maxAge: 10 * 60 * 1000,
      path: '/api/auth/oidc',
    });

    return client.buildAuthorizationUrl(cfg, {
      redirect_uri: redirectUri(req),
      scope: config.oidcScopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    }).href;
  })();
}

export type OidcIdentity = { issuer: string; subject: string; email: unknown; name?: unknown };

export async function completeLogin(req: Request, res: Response): Promise<OidcIdentity> {
  const flow = unseal((req.cookies as Record<string, string> | undefined)?.[OIDC_COOKIE]);
  res.clearCookie(OIDC_COOKIE, { path: '/api/auth/oidc' });
  if (!flow) throw new Error('Fluxo de login expirado — comece de novo');

  const cfg = await getConfiguration();
  const currentUrl = new URL(`${redirectUri(req)}${req.url.slice(req.path.length)}`);

  const tokens = await client.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: flow.verifier,
    expectedNonce: flow.nonce,
    expectedState: flow.state,
    idTokenExpected: true,
  });

  const claims = tokens.claims();
  if (!claims) throw new Error('O provedor não devolveu um id_token válido');

  let email = claims.email;
  let name = claims.name;

  // Nem todo provedor coloca e-mail no id_token; o userinfo é o plano B.
  if (!email) {
    const info = await client.fetchUserInfo(cfg, tokens.access_token, claims.sub);
    email = info.email;
    name ??= info.name;
  }

  return {
    issuer: cfg.serverMetadata().issuer,
    subject: claims.sub,
    email,
    name,
  };
}

function seal(flow: FlowState): string {
  const body = Buffer.from(JSON.stringify(flow), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

function unseal(raw: string | undefined): FlowState | null {
  if (!raw) return null;

  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = raw.slice(0, dot);
  const a = Buffer.from(raw.slice(dot + 1), 'utf8');
  const b = Buffer.from(sign(body), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const flow = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as FlowState;
    return flow.verifier && flow.nonce && flow.state ? flow : null;
  } catch {
    return null;
  }
}

const sign = (body: string): string =>
  createHmac('sha256', getSessionSecret()).update(`oidc:${body}`).digest('base64url');
