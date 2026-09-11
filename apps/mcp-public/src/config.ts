import { readPortEnv, readSecret, readTextEnv } from '@purple-skills/shared';

export const config = {
  port: readPortEnv('PORT', 3002),
  host: readTextEnv('HOST', '0.0.0.0'),
  /** Base do site, usada para montar URLs de download e de arquivos. */
  siteBaseUrl: readTextEnv('SITE_BASE_URL', 'http://localhost:3000').replace(/\/+$/, ''),
  /**
   * Endereço público deste servidor, base das URLs de download dos MCPs
   * virtuais (`/virtual/<slug>/skills/<skill>/download`). Vazio = deduzido de
   * cada requisição (`proto://host`), o que só acerta quando o proxy repassa
   * os headers — atrás do Traefik do compose, ele repassa.
   */
  publicUrl: readTextEnv('MCP_PUBLIC_URL', '').replace(/\/+$/, ''),
  serverName: readTextEnv('MCP_SERVER_NAME', 'purple-skills'),
  version: readTextEnv('APP_VERSION', '1.0.0-beta.1'),
};

/**
 * Como o MCP **principal** autentica (`docs/08-mcp-virtual.md` §7):
 *
 * | `MCP_PUBLIC_AUTH` | Aceita                                              |
 * |-------------------|-----------------------------------------------------|
 * | `open`            | qualquer um; `MCP_PUBLIC_KEY` é ignorada            |
 * | `key`             | só `MCP_PUBLIC_KEY` (obrigatória neste modo)        |
 * | `managed`         | chaves `psp_` do banco **e** `MCP_PUBLIC_KEY`, se definida |
 *
 * Sem a variável, o modo é deduzido do que já existia — `key` quando há
 * `MCP_PUBLIC_KEY`, `open` quando não há — para uma instalação que sobe de
 * versão sem mexer no `.env` continuar exatamente como estava: um padrão
 * fixo em `open` abriria, em silêncio, um servidor que estava protegido.
 * Os MCPs virtuais não olham para isto: cada um tem a própria regra.
 */
export type PublicAuthMode = 'open' | 'key' | 'managed';

let cachedMode: PublicAuthMode | undefined;

export function publicAuthMode(): PublicAuthMode {
  if (cachedMode) return cachedMode;

  const raw = readTextEnv('MCP_PUBLIC_AUTH', '').trim().toLowerCase();
  if (raw === '') {
    cachedMode = publicKey() ? 'key' : 'open';
  } else if (raw === 'open' || raw === 'key' || raw === 'managed') {
    cachedMode = raw;
  } else {
    throw new Error(`MCP_PUBLIC_AUTH inválida: "${raw}" (use open, key ou managed)`);
  }

  if (cachedMode === 'key' && !publicKey()) {
    throw new Error('MCP_PUBLIC_AUTH=key exige MCP_PUBLIC_KEY (ou MCP_PUBLIC_KEY_FILE)');
  }
  if (cachedMode === 'open' && publicKey()) {
    console.warn('[mcp-public] MCP_PUBLIC_AUTH=open: a MCP_PUBLIC_KEY definida está sendo ignorada');
  }
  return cachedMode;
}

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
