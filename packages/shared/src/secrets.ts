import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

/**
 * Padrão de secrets do projeto: `<NOME>_FILE` tem prioridade sobre `<NOME>`.
 * Retorna `undefined` quando nenhum dos dois está definido (ou está vazio).
 */
export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const filePath = env[`${name}_FILE`];
  if (filePath && filePath.trim()) {
    return readFileSync(filePath.trim(), 'utf8').replace(/\r?\n$/, '');
  }

  const value = env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Igual a `readSecret`, mas lança quando o segredo é obrigatório e falta. */
export function requireSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = readSecret(name, env);
  if (!value) {
    throw new Error(`Segredo obrigatório ausente: defina ${name} ou ${name}_FILE`);
  }
  return value;
}

/** Comparação de strings resistente a timing attacks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a ?? '', 'utf8');
  const bufB = Buffer.from(b ?? '', 'utf8');
  if (bufA.length !== bufB.length) {
    // Compara mesmo assim para manter o tempo constante em relação a `a`.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Extrai o token de um header `Authorization: Bearer <token>`. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
