import { requireSecret } from '@purple-skills/shared';

export const config = {
  port: Number(process.env.PORT ?? 3003),
  host: process.env.HOST ?? '0.0.0.0',
  siteBaseUrl: (process.env.SITE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  serverName: process.env.MCP_SERVER_NAME ?? 'purple-skills-admin',
  version: process.env.APP_VERSION ?? '1.0.0-beta.1',
};

let token: string | null = null;

/** Token administrativo — obrigatório, via `MCP_ADMIN_TOKEN` ou `_FILE`. */
export function adminToken(): string {
  token ??= requireSecret('MCP_ADMIN_TOKEN');
  return token;
}
