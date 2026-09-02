import { readPortEnv, readSecret, readTextEnv } from '@purple-skills/shared';

export const config = {
  port: readPortEnv('PORT', 3002),
  host: readTextEnv('HOST', '0.0.0.0'),
  /** Base do site, usada para montar URLs de download e de arquivos. */
  siteBaseUrl: readTextEnv('SITE_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  serverName: readTextEnv('MCP_SERVER_NAME', 'purple-skills'),
  version: readTextEnv('APP_VERSION', '1.0.0-beta.1'),
};

let cachedKey: string | undefined;
let keyLoaded = false;

/**
 * Chave opcional do MCP público: se ausente/vazia, o servidor é totalmente
 * aberto; se definida, exige `Authorization: Bearer <chave>`.
 *
 * Lida uma única vez, como o token do MCP admin e a senha do painel. Reler a
 * cada requisição significava um `readFileSync` por chamada quando a chave vem
 * de `MCP_PUBLIC_KEY_FILE`, e um arquivo removido em runtime derrubava todas as
 * chamadas com 500. O cache também mantém o `requiresAuth` anunciado em `GET /`
 * coerente com o que o middleware exige.
 */
export function publicKey(): string | undefined {
  if (!keyLoaded) {
    cachedKey = readSecret('MCP_PUBLIC_KEY');
    keyLoaded = true;
  }
  return cachedKey;
}
