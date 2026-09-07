import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

const MAX = 64 * 1024 * 1024;

vi.mock('./config.js', () => ({ config: { maxUploadBytes: MAX } }));

const { limitRequestBytes, rejectOversizedBatch } = await import('./uploads.js');

function fakeRes() {
  const res = {
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

/** Requisição mínima: o middleware só lê o `Content-Length`. */
const request = (contentLength?: string) =>
  ({
    header: (name: string) => (name.toLowerCase() === 'content-length' ? contentLength : undefined),
  }) as unknown as Request;

function run(contentLength?: string) {
  const res = fakeRes();
  const next = vi.fn() as unknown as NextFunction;
  limitRequestBytes(request(contentLength), res, next);
  return { res, next: next as unknown as ReturnType<typeof vi.fn> };
}

const file = (size: number) => ({ size }) as Express.Multer.File;

describe('limitRequestBytes', () => {
  it('deixa passar um envio dentro do teto', () => {
    const { res, next } = run(String(MAX - 1));

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('deixa passar um arquivo de exatamente o teto, com o envelope multipart', () => {
    const { next } = run(String(MAX + 4096));

    expect(next).toHaveBeenCalled();
  });

  it('recusa com 413 o envio que soma mais que o teto por requisição', () => {
    // Era o buraco: 50 arquivos de 64 MB passavam pelo limite por arquivo.
    const { res, next } = run(String(50 * MAX));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
  });

  it('segue adiante sem Content-Length: a soma é conferida depois do upload', () => {
    const { next } = run(undefined);

    expect(next).toHaveBeenCalled();
  });
});

describe('rejectOversizedBatch', () => {
  it('aceita a soma dentro do teto', () => {
    const res = fakeRes();

    expect(rejectOversizedBatch([file(MAX / 2), file(MAX / 2)], res)).toBe(false);
    expect(res.statusCode).toBe(0);
  });

  it('recusa com 413 a soma acima do teto', () => {
    const res = fakeRes();

    expect(rejectOversizedBatch([file(MAX), file(1)], res)).toBe(true);
    expect(res.statusCode).toBe(413);
    expect(res.body.message).toMatch(/soma dos arquivos/i);
  });
});
