import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Hash de segredo com **scrypt** do `node:crypto`.
 *
 * scrypt em vez de argon2 porque o projeto não tem dependência nativa e já usa
 * `scryptSync` para derivar o segredo de sessão (`apps/admin/src/config.ts`).
 * O formato guardado carrega os parâmetros, então aumentar o custo no futuro
 * não invalida os hashes antigos:
 *
 *     scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
 *
 * Dois custos, porque as duas entradas são muito diferentes:
 *
 * - **senha de pessoa** (`PASSWORD_COST`, N=2^15, ~32 MB, ~100 ms) — entropia
 *   baixa, precisa de trabalho para inviabilizar busca offline;
 * - **segredo de chave de API** (`KEY_COST`, N=2^12) — 32 bytes aleatórios,
 *   fora do alcance de qualquer busca; o custo alto só somaria latência a cada
 *   requisição do MCP sem tirar nada do atacante.
 */
export type ScryptCost = { N: number; r: number; p: number };

export const PASSWORD_COST: ScryptCost = { N: 2 ** 15, r: 8, p: 1 };
export const KEY_COST: ScryptCost = { N: 2 ** 12, r: 8, p: 1 };

const KEY_LENGTH = 32;
const SALT_BYTES = 16;

export function hashSecret(secret: string, cost: ScryptCost = PASSWORD_COST): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = derive(secret, salt, cost);
  return [
    'scrypt',
    cost.N,
    cost.r,
    cost.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Confere um segredo contra o hash guardado.
 *
 * Nunca lança: hash malformado (linha corrompida, formato de outra versão)
 * é tratado como "não confere". Um `throw` aqui viraria 500 numa rota de
 * login, o que é pior e ainda informa o atacante.
 */
export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!isCost(N) || !isCost(r) || !isCost(p)) return false;

  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    if (salt.length === 0 || expected.length === 0) return false;

    const derived = derive(secret, salt, { N, r, p }, expected.length);
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export const hashPassword = (password: string): string => hashSecret(password, PASSWORD_COST);
export const verifyPassword = (password: string, stored: string | null | undefined): boolean =>
  verifySecret(password, stored);

/**
 * Senha temporária para o reset feito pelo admin — legível o bastante para ser
 * ditada, aleatória o bastante para não ser adivinhada (~124 bits).
 */
export function generatePassword(groups = 4): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789ACDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(groups * 5);
  const out: string[] = [];
  for (let g = 0; g < groups; g += 1) {
    let chunk = '';
    for (let i = 0; i < 5; i += 1) chunk += alphabet[bytes[g * 5 + i] % alphabet.length];
    out.push(chunk);
  }
  return out.join('-');
}

/**
 * Regra mínima de senha: comprimento, e só.
 *
 * Exigir símbolo e maiúscula produz `Senha@123` e nada mais; comprimento é a
 * única regra que aumenta o custo de fato. Retorna `null` quando está boa.
 */
export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Informe uma senha';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `A senha precisa ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`;
  }
  if (password.length > 512) {
    return 'A senha é longa demais (máximo de 512 caracteres)';
  }
  return null;
}

function derive(secret: string, salt: Buffer, cost: ScryptCost, length = KEY_LENGTH): Buffer {
  return scryptSync(secret, salt, length, {
    ...cost,
    // O padrão do Node (32 MB) não cabe N=2^15 com r=8 — daí o teto explícito.
    maxmem: 256 * 1024 * 1024,
  });
}

function isCost(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2 ** 20;
}
