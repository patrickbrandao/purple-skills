import { readSecret } from '@purple-skills/shared';

export const config = {
  port: Number(process.env.PORT ?? 3002),
  host: process.env.HOST ?? '0.0.0.0',
  /** Base do site, usada para montar URLs de download e de arquivos. */
  siteBaseUrl: (process.env.SITE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  serverName: process.env.MCP_SERVER_NAME ?? 'purple-skills',
  version: process.env.APP_VERSION ?? '1.0.0-beta.1',
};

/**
 * Chave opcional do MCP público: se ausente/vazia, o servidor é totalmente
 * aberto; se definida, exige `Authorization: Bearer <chave>`.
 */
export function publicKey(): string | undefined {
  return readSecret('MCP_PUBLIC_KEY');
}
