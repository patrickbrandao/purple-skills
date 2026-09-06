export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'Recurso não encontrado') =>
  new AppError(message, 404, 'not_found');

export const badRequest = (message: string) => new AppError(message, 400, 'bad_request');

export const conflict = (message: string) => new AppError(message, 409, 'conflict');

export const unauthorized = (message = 'Não autorizado') =>
  new AppError(message, 401, 'unauthorized');

type PgError = { code?: string; constraint?: string; cause?: unknown };

/**
 * Acha o erro do driver dentro do que veio.
 *
 * O Drizzle embrulha a falha num `DrizzleQueryError` com a mensagem
 * "Failed query: …" e guarda o erro do `pg` — o único que tem `code` e
 * `constraint` — em `cause`. Sem descer a cadeia, todo teste de SQLSTATE
 * falharia em silêncio e o 409 viraria 500. O limite de profundidade evita
 * laço infinito se alguém montar uma cadeia circular.
 */
function findPgError(err: unknown, depth = 5): PgError | null {
  let current = err as PgError | null | undefined;
  for (let i = 0; current && i <= depth; i += 1) {
    if (typeof current.code === 'string') return current;
    current = current.cause as PgError | null | undefined;
  }
  return null;
}

/**
 * Violação de `UNIQUE` do Postgres (SQLSTATE 23505).
 *
 * Sem esse teste, uma colisão de slug entre duas escritas concorrentes vira
 * HTTP 500 com a mensagem crua do driver, quando o certo é 409.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pgError = findPgError(err);
  if (!pgError || pgError.code !== '23505') return false;
  return constraint === undefined || pgError.constraint === constraint;
}

/**
 * Violação de chave estrangeira (SQLSTATE 23503) — a linha referenciada não
 * existe (mais).
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return findPgError(err)?.code === '23503';
}
