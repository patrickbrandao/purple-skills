import type { Request, Response } from 'express';
import multer from 'multer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const { onError } = await import('./errors.js');

function fakeRes() {
  const res = {
    headersSent: false,
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: { error: string; message: string } };
}

const run = (err: unknown) => {
  const res = fakeRes();
  onError(err, {} as Request, res, vi.fn());
  return res;
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('onError', () => {
  it('traduz arquivo acima do limite em 413 JSON', () => {
    const res = run(new multer.MulterError('LIMIT_FILE_SIZE', 'file'));

    expect(res.statusCode).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
    expect(res.body.message).toMatch(/limite/i);
  });

  it('traduz outros erros de upload em 400 JSON', () => {
    const res = run(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('bad_request');
  });

  it('traduz JSON malformado em 400 JSON, não em HTML', () => {
    const res = run(Object.assign(new SyntaxError('Unexpected end of JSON input'), {
      type: 'entity.parse.failed',
      status: 400,
    }));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_json', message: 'Corpo JSON malformado' });
  });

  it('traduz corpo grande demais em 413 JSON', () => {
    const res = run(Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
    }));

    expect(res.statusCode).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
  });

  it('não vaza a mensagem interna numa falha do servidor', () => {
    const res = run(new Error('conexão com o banco caiu em /var/lib/segredo'));

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'internal_error', message: 'Erro interno' });
  });

  it('não escreve depois que a resposta já começou', () => {
    const res = fakeRes();
    (res as unknown as { headersSent: boolean }).headersSent = true;

    onError(new Error('tarde demais'), {} as Request, res, vi.fn());

    expect(res.statusCode).toBe(0);
  });
});
