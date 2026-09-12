import { randomBytes } from 'node:crypto';
import { KEY_COST, hashSecret, verifySecret } from './password.js';

/**
 * Chaves de API dos servidores MCP.
 *
 *     psk_<prefixo>_<segredo>   — MCP administrativo, por usuário
 *     psv_<prefixo>_<segredo>   — MCP virtual, por servidor (`docs/08-mcp-virtual.md`)
 *     psp_<prefixo>_<segredo>   — MCP público principal, gerenciada (`08` §7)
 *
 * O **esquema** (os três caracteres antes do primeiro `_`) diz em que tabela a
 * chave vive: `psk_` em `api_keys`, `psv_` em `virtual_mcp_keys`, `psp_` em
 * `public_mcp_keys`. É ele que
 * permite a cada servidor consultar uma tabela só — e que torna uma chave
 * vazada identificável de cara.
 *
 * O **prefixo** é público e indexado: é por ele que a linha é encontrada, sem
 * varrer a tabela nem comparar hash por hash. O **segredo** tem 32 bytes
 * aleatórios e nunca é guardado — o banco tem apenas o hash scrypt.
 *
 * O texto completo aparece uma única vez, no momento da emissão
 * (`docs/05-accounts-and-roles.md` §2.5). O prefixo permite ao painel mostrar
 * "psk_a1b2c3d4…" numa listagem sem guardar nada sensível.
 */
export const API_KEY_SCHEME = 'psk';
/**
 * Chave de leitura de um MCP virtual — pertence ao servidor, não a um usuário.
 * Vale também na raiz (`/mcp`), que é o vMCP padrão da instalação. O esquema
 * `psp_` do antigo MCP principal deixou de existir no `011`.
 */
export const VIRTUAL_KEY_SCHEME = 'psv';
export const API_KEY_PREFIX_LENGTH = 8;

export type ApiKeyScheme = typeof API_KEY_SCHEME | typeof VIRTUAL_KEY_SCHEME;

export type GeneratedApiKey = {
  /** Texto completo, mostrado uma vez ao usuário. */
  token: string;
  prefix: string;
  keyHash: string;
};

export function generateApiKey(scheme: ApiKeyScheme = API_KEY_SCHEME): GeneratedApiKey {
  // 6 bytes viram exatamente 8 caracteres em base64url — nada de padding.
  const prefix = randomBytes(6).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return {
    token: `${scheme}_${prefix}_${secret}`,
    prefix,
    keyHash: hashSecret(secret, KEY_COST),
  };
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Separa a chave em prefixo e segredo.
 *
 * A leitura é **posicional**, não por `split('_')`: o alfabeto base64url
 * inclui `_`, então o segredo costuma ter underscores e a divisão ingênua
 * recusaria uma chave legítima. O prefixo tem comprimento fixo, o que torna a
 * posição do separador determinística.
 */
export function parseApiKey(
  token: string | null | undefined,
  scheme: ApiKeyScheme = API_KEY_SCHEME,
): {
  prefix: string;
  secret: string;
} | null {
  const head = `${scheme}_`;
  if (!token || !token.startsWith(head)) return null;

  const rest = token.slice(head.length);
  if (rest[API_KEY_PREFIX_LENGTH] !== '_') return null;

  const prefix = rest.slice(0, API_KEY_PREFIX_LENGTH);
  const secret = rest.slice(API_KEY_PREFIX_LENGTH + 1);
  if (secret.length < 16) return null;
  if (!SEGMENT.test(prefix) || !SEGMENT.test(secret)) return null;

  return { prefix, secret };
}

/** `true` quando o texto tem a **forma** de uma chave — não que ela seja válida. */
export const looksLikeApiKey = (
  token: string | null | undefined,
  scheme: ApiKeyScheme = API_KEY_SCHEME,
): boolean => parseApiKey(token, scheme) !== null;

export const verifyApiKeySecret = (secret: string, keyHash: string | null | undefined): boolean =>
  verifySecret(secret, keyHash);

/** Como a chave aparece numa listagem: só o prefixo, nunca o segredo. */
export const maskApiKey = (prefix: string, scheme: ApiKeyScheme = API_KEY_SCHEME): string =>
  `${scheme}_${prefix}_…`;
