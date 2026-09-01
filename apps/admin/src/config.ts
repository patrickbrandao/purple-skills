import { readSecret, requireSecret } from '@purple-skills/shared';

/**
 * Configuração do painel admin. Os segredos seguem o padrão
 * `<NOME>` / `<NOME>_FILE` (o arquivo tem prioridade).
 */
export const config = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? '0.0.0.0',
  siteBaseUrl: (process.env.SITE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  siteName: process.env.SITE_NAME ?? 'Purple Skills',
  isProduction: process.env.NODE_ENV === 'production',
  /** Duração da sessão do painel, em segundos (padrão: 12h). */
  sessionTtlSeconds: Number(process.env.ADMIN_SESSION_TTL ?? 12 * 3600),
  /** Tamanho máximo de upload de .zip. */
  maxUploadBytes: Number(process.env.ADMIN_MAX_UPLOAD_BYTES ?? 64 * 1024 * 1024),
  /**
   * Flag `Secure` do cookie de sessão. Por padrão acompanha o protocolo da
   * requisição (funciona tanto atrás de HTTPS quanto em HTTP local); pode ser
   * forçada com `ADMIN_COOKIE_SECURE=true|false`.
   */
  cookieSecure: parseBoolean(process.env.ADMIN_COOKIE_SECURE),
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
 * Segredo de assinatura da sessão. Se não for informado, deriva-se da senha —
 * assim o serviço sobe sem configuração extra em desenvolvimento (trocar a
 * senha invalida as sessões antigas, o que é o comportamento desejado).
 */
export function getSessionSecret(): string {
  sessionSecret ??= readSecret('ADMIN_SESSION_SECRET') ?? `derived:${getAdminPassword()}`;
  return sessionSecret;
}
