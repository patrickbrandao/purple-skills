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

/**
 * Violação de `UNIQUE` do Postgres (SQLSTATE 23505).
 *
 * Sem esse teste, uma colisão de slug entre duas escritas concorrentes vira
 * HTTP 500 com a mensagem crua do driver, quando o certo é 409.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const candidate = err as { code?: string; constraint?: string } | null | undefined;
  if (!candidate || candidate.code !== '23505') return false;
  return constraint === undefined || candidate.constraint === constraint;
}
