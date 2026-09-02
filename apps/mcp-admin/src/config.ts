import { readPortEnv, readTextEnv, requireSecret } from '@purple-skills/shared';

export const config = {
  port: readPortEnv('PORT', 3003),
  host: readTextEnv('HOST', '0.0.0.0'),
  siteBaseUrl: readTextEnv('SITE_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  serverName: readTextEnv('MCP_SERVER_NAME', 'purple-skills-admin'),
  version: readTextEnv('APP_VERSION', '1.0.0-beta.1'),
};

let token: string | null = null;

/** Token administrativo — obrigatório, via `MCP_ADMIN_TOKEN` ou `_FILE`. */
export function adminToken(): string {
  token ??= requireSecret('MCP_ADMIN_TOKEN');
  return token;
}
