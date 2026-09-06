import { randomBytes } from 'node:crypto';
import { KEY_COST, hashSecret, verifySecret } from './password.js';

/**
 * Chaves de API do MCP administrativo.
 *
 *     psk_<prefixo>_<segredo>
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
export const API_KEY_PREFIX_LENGTH = 8;

export type GeneratedApiKey = {
  /** Texto completo, mostrado uma vez ao usuário. */
  token: string;
  prefix: string;
  keyHash: string;
};

export function generateApiKey(): GeneratedApiKey {
  // 6 bytes viram exatamente 8 caracteres em base64url — nada de padding.
  const prefix = randomBytes(6).toString('base64url');
  const secret = randomBytes(32).toString('base64url');
  return {
    token: `${API_KEY_SCHEME}_${prefix}_${secret}`,
    prefix,
    keyHash: hashSecret(secret, KEY_COST),
  };
}

const HEAD = `${API_KEY_SCHEME}_`;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Separa a chave em prefixo e segredo.
 *
 * A leitura é **posicional**, não por `split('_')`: o alfabeto base64url
 * inclui `_`, então o segredo costuma ter underscores e a divisão ingênua
 * recusaria uma chave legítima. O prefixo tem comprimento fixo, o que torna a
 * posição do separador determinística.
 */
export function parseApiKey(token: string | null | undefined): {
  prefix: string;
  secret: string;
} | null {
  if (!token || !token.startsWith(HEAD)) return null;

  const rest = token.slice(HEAD.length);
  if (rest[API_KEY_PREFIX_LENGTH] !== '_') return null;

  const prefix = rest.slice(0, API_KEY_PREFIX_LENGTH);
  const secret = rest.slice(API_KEY_PREFIX_LENGTH + 1);
  if (secret.length < 16) return null;
  if (!SEGMENT.test(prefix) || !SEGMENT.test(secret)) return null;

  return { prefix, secret };
}

/** `true` quando o texto tem a **forma** de uma chave — não que ela seja válida. */
export const looksLikeApiKey = (token: string | null | undefined): boolean =>
  parseApiKey(token) !== null;

export const verifyApiKeySecret = (secret: string, keyHash: string | null | undefined): boolean =>
  verifySecret(secret, keyHash);

/** Como a chave aparece numa listagem: só o prefixo, nunca o segredo. */
export const maskApiKey = (prefix: string): string => `${API_KEY_SCHEME}_${prefix}_…`;
