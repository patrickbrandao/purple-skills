import { scryptSync } from 'node:crypto';
import {
  readIntEnv,
  readPortEnv,
  readSecret,
  readTextEnv,
  requireSecret,
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
};

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  return value === 'true' || value === '1';
}

export const SESSION_COOKIE = 'ps_admin';

let adminPassword: string | null = null;
let sessionSecret: string | null = null;

export function getAdminPassword(): string {
  adminPassword ??= requireSecret('ADMIN_PASSWORD');
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
 * produção — `openssl rand -hex 32`.
 */
export function getSessionSecret(): string {
  if (sessionSecret) return sessionSecret;

  const configured = readSecret('ADMIN_SESSION_SECRET');
  if (configured) {
    sessionSecret = configured;
    return sessionSecret;
  }

  if (config.isProduction) {
    console.warn(
      '[admin] ADMIN_SESSION_SECRET não definido: derivando da senha. ' +
        'Em produção, defina um segredo próprio (openssl rand -hex 32).',
    );
  }

  // N=2^15 com r=8 usa ~32 MB e ~100 ms — roda uma única vez por processo.
  sessionSecret = scryptSync(getAdminPassword(), 'purple-skills:admin-session:v1', 32, {
    N: 2 ** 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString('base64url');

  return sessionSecret;
}
