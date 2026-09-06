import { scryptSync } from 'node:crypto';
import {
  parseDomainList,
  readIntEnv,
  readPortEnv,
  readSecret,
  readTextEnv,
} from '@purple-skills/shared';

/**
 * Configuração do painel admin. Os segredos seguem o padrão
 * `<NOME>` / `<NOME>_FILE` (o arquivo tem prioridade).
 */
export const config = {
  port: readPortEnv('PORT', 3001),
  host: readTextEnv('HOST', '0.0.0.0'),
  siteBaseUrl: readTextEnv('SITE_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  siteName: readTextEnv('SITE_NAME', 'Purple Skills'),
  isProduction: process.env.NODE_ENV === 'production',
  /** Duração da sessão do painel, em segundos (padrão: 12h). */
  sessionTtlSeconds: readIntEnv('ADMIN_SESSION_TTL', 12 * 3600, { min: 60 }),
  /** Tamanho máximo de upload de .zip. */
  maxUploadBytes: readIntEnv('ADMIN_MAX_UPLOAD_BYTES', 64 * 1024 * 1024, { min: 1024 }),
  /**
   * Flag `Secure` do cookie de sessão. Por padrão acompanha o protocolo da
   * requisição (funciona tanto atrás de HTTPS quanto em HTTP local); pode ser
   * forçada com `ADMIN_COOKIE_SECURE=true|false`.
   */
  cookieSecure: parseBoolean(process.env.ADMIN_COOKIE_SECURE),
  /**
   * Origens aceitas nas requisições de escrita do painel, além da própria
   * (comparada pelo `Host`). Lista separada por vírgula; normalmente vazia,
   * já que o painel é sempre same-origin.
   */
  extraAllowedOrigins: (process.env.ADMIN_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  /**
   * Endereço público do próprio painel — usado para montar o `redirect_uri` do
   * OIDC e o link de redefinição de senha. Sem ele, os dois caem no `Host` da
   * requisição, o que só funciona quando o proxy repassa o header correto.
   */
  publicUrl: readTextEnv('ADMIN_PUBLIC_URL', '').replace(/\/+$/, ''),

  // ------------------------------------------------------ rate limiting ----
  /** Tentativas erradas antes de travar a conta (`users.locked_until`). */
  loginMaxAttempts: readIntEnv('LOGIN_MAX_ATTEMPTS', 8, { min: 1, max: 1000 }),
  /** Duração da trava da conta, em segundos. */
  loginLockSeconds: readIntEnv('LOGIN_LOCK_SECONDS', 15 * 60, { min: 1 }),
  /** Teto de tentativas por IP na janela em memória (a camada de cima). */
  loginIpMaxAttempts: readIntEnv('LOGIN_IP_MAX_ATTEMPTS', 30, { min: 1 }),
  loginIpWindowSeconds: readIntEnv('LOGIN_IP_WINDOW_SECONDS', 5 * 60, { min: 1 }),

  // -------------------------------------------------------------- OIDC ----
  oidcIssuer: readTextEnv('OIDC_ISSUER', ''),
  oidcClientId: readTextEnv('OIDC_CLIENT_ID', ''),
  oidcProviderName: readTextEnv('OIDC_PROVIDER_NAME', 'SSO'),
  oidcScopes: readTextEnv('OIDC_SCOPES', 'openid email profile'),
  /**
   * Domínios de e-mail autorizados. **Vazia desliga o auto-provisionamento** —
   * é a falha fechada da §2.4: uma instalação mal configurada não entrega o
   * catálogo privado a qualquer conta do provedor.
   */
  oidcAllowedDomains: parseDomainList(process.env.OIDC_ALLOWED_DOMAINS),
  oidcAutoProvision: parseBoolean(process.env.OIDC_AUTO_PROVISION) ?? true,

  // -------------------------------------------------------------- SMTP ----
  smtpFrom: readTextEnv('SMTP_FROM', ''),
  /** Validade do link de redefinição de senha, em segundos (padrão: 1h). */
  resetTtlSeconds: readIntEnv('PASSWORD_RESET_TTL', 3600, { min: 60 }),
};

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true' || value === '1';
}

export const SESSION_COOKIE = 'ps_admin';
/** Cookie de estado do OIDC (nonce + PKCE + destino), curto e httpOnly. */
export const OIDC_COOKIE = 'ps_oidc';

/**
 * OIDC só liga com issuer, client id e client secret presentes.
 * Faltando qualquer um, o botão nem aparece no painel.
 */
export function oidcEnabled(): boolean {
  return Boolean(config.oidcIssuer && config.oidcClientId && readSecret('OIDC_CLIENT_SECRET'));
}

export function oidcClientSecret(): string {
  const value = readSecret('OIDC_CLIENT_SECRET');
  if (!value) throw new Error('OIDC_CLIENT_SECRET ausente');
  return value;
}

/** SMTP é opcional: sem ele, o reset de senha passa a ser feito pelo admin. */
export function smtpUrl(): string | undefined {
  return readSecret('SMTP_URL');
}

export const smtpEnabled = (): boolean => Boolean(smtpUrl() && config.smtpFrom);

let adminPassword: string | null | undefined;
let sessionSecret: string | null = null;

/**
 * Senha de bootstrap.
 *
 * Deixou de ser obrigatória: ela só serve para criar o **primeiro** admin em
 * `/api/setup`. Depois que existe uma conta, o painel recusa esse caminho e a
 * variável fica inerte (`docs/05-accounts-and-roles.md` §2.3).
 */
export function getAdminPassword(): string | null {
  if (adminPassword === undefined) adminPassword = readSecret('ADMIN_PASSWORD') ?? null;
  return adminPassword;
}

/**
 * Segredo de assinatura da sessão.
 *
 * Quando `ADMIN_SESSION_SECRET` não é informado, o segredo é derivado da senha
 * com **scrypt**, não por concatenação direta. A diferença importa: o cookie é
 * `payload.HMAC-SHA256(segredo, payload)` com payload conhecido, então um cookie
 * capturado vira um oráculo offline. Com o segredo sendo a senha crua, testar
 * candidatos custa um HMAC (bilhões por segundo em GPU) e a senha do painel cai
 * junto. Com scrypt, cada tentativa custa memória e dezenas de milissegundos.
 *
 * A propriedade útil da derivação é preservada: trocar a senha invalida as
 * sessões antigas. Ainda assim, prefira definir o segredo explicitamente em
 * produção — `openssl rand -hex 32`. Com contas, a derivação a partir da senha
 * de bootstrap perde sentido: defina o segredo.
 */
export function getSessionSecret(): string {
  if (sessionSecret) return sessionSecret;

  const configured = readSecret('ADMIN_SESSION_SECRET');
  if (configured) {
    sessionSecret = configured;
    return sessionSecret;
  }

  const password = getAdminPassword();
  if (!password) {
    throw new Error(
      'Defina ADMIN_SESSION_SECRET (openssl rand -hex 32). Sem ele o cookie de ' +
        'sessão só pode ser derivado de ADMIN_PASSWORD, que também está ausente.',
    );
  }

  if (config.isProduction) {
    console.warn(
      '[admin] ADMIN_SESSION_SECRET não definido: derivando da senha de bootstrap. ' +
        'Defina um segredo próprio (openssl rand -hex 32) — ele sobrevive à ' +
        'remoção da ADMIN_PASSWORD.',
    );
  }

  // N=2^15 com r=8 usa ~32 MB e ~100 ms — roda uma única vez por processo.
  sessionSecret = scryptSync(password, 'purple-skills:admin-session:v1', 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString('base64url');

  return sessionSecret;
}

/** Base pública do painel, com fallback no `Host` da requisição. */
export function panelBaseUrl(proto: string, host: string): string {
  return config.publicUrl || `${proto}://${host}`;
}
