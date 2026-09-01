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
