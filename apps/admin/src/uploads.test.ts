import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const MAX = 64 * 1024 * 1024;

/**
 * Mutável de propósito: o teto **por arquivo** (`limits.fileSize`) é lido no
 * import e fica em 64 MB; o da **soma** é lido a cada pedaço, então um teste
 * pode baixá-lo e estourá-lo com alguns KB.
 */
const cfg = vi.hoisted(() => ({ maxUploadBytes: 64 * 1024 * 1024 }));

vi.mock('./config.js', () => ({ config: cfg }));

const {
  MAX_FILES_PER_REQUEST,
  UploadTooLargeError,
  budgetedMemoryStorage,
  limitRequestBytes,
  rejectOversizedBatch,
  upload,
} = await import('./uploads.js');
const { onError } = await import('./errors.js');

afterEach(() => {
  cfg.maxUploadBytes = MAX;
  vi.restoreAllMocks();
});

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

  // Não é 411: proxy que reempacota o corpo em chunked é envio legítimo. Quem
  // segura esse caso é o storage, durante o stream (testes abaixo).
  it('segue adiante sem Content-Length: o corte do chunked é durante o stream', () => {
    const { next } = run(undefined);

    expect(next).toHaveBeenCalled();
  });
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** O mínimo que o storage usa de um arquivo do multer: o stream da parte. */
const parte = (stream: PassThrough) => ({ stream }) as unknown as Express.Multer.File;

describe('budgetedMemoryStorage: a soma da requisição é conferida a cada pedaço', () => {
  it('junta o arquivo inteiro quando a soma cabe no teto', async () => {
    cfg.maxUploadBytes = 10;
    const stream = new PassThrough();
    const callback = vi.fn();

    budgetedMemoryStorage._handleFile({} as Request, parte(stream), callback);
    stream.write(Buffer.from('abcd'));
    stream.end(Buffer.from('efgh'));
    await tick();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toBeNull();
    expect(callback.mock.calls[0]![1]).toMatchObject({ size: 8 });
    expect((callback.mock.calls[0]![1] as { buffer: Buffer }).buffer.toString()).toBe('abcdefgh');
  });

  it('devolve o erro no pedaço que estoura, antes de o stream terminar', async () => {
    // Era o defeito: a soma só era feita com tudo já em memória.
    cfg.maxUploadBytes = 10;
    const stream = new PassThrough();
    const callback = vi.fn();

    budgetedMemoryStorage._handleFile({} as Request, parte(stream), callback);
    stream.write(Buffer.alloc(6));
    stream.write(Buffer.alloc(6));
    await tick();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toBeInstanceOf(UploadTooLargeError);
    expect(stream.writableEnded).toBe(false);

    // O resto do envio escoa sem segunda resposta do storage.
    stream.end(Buffer.alloc(1024));
    await tick();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('soma os arquivos da mesma requisição — e só os dela', async () => {
    cfg.maxUploadBytes = 10;
    const req = {} as Request;
    const [a, b, deOutra] = [new PassThrough(), new PassThrough(), new PassThrough()];
    const [okA, erroB, okOutra] = [vi.fn(), vi.fn(), vi.fn()];

    budgetedMemoryStorage._handleFile(req, parte(a), okA);
    a.end(Buffer.alloc(6));
    await tick();
    budgetedMemoryStorage._handleFile(req, parte(b), erroB);
    b.end(Buffer.alloc(6));
    budgetedMemoryStorage._handleFile({} as Request, parte(deOutra), okOutra);
    deOutra.end(Buffer.alloc(6));
    await tick();

    expect(okA.mock.calls[0]![0]).toBeNull();
    expect(erroB.mock.calls[0]![0]).toBeInstanceOf(UploadTooLargeError);
    expect(okOutra.mock.calls[0]![0]).toBeNull();
  });
});

/**
 * Multipart de verdade, por HTTP: o que o multer faz com o nome do arquivo e
 * com um corpo sem `Content-Length` não aparece chamando o handler direto.
 */
describe('envio multipart por HTTP', () => {
  const LIMITE = 'limiteDoTeste';
  let running: Server | undefined;

  afterEach(() => {
    running?.close();
    running = undefined;
  });

  const campo = (name: string, value: string) =>
    Buffer.from(`--${LIMITE}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8');

  const arquivo = (filename: string, content: Buffer | string) =>
    Buffer.concat([
      Buffer.from(
        `--${LIMITE}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
      ),
      Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      Buffer.from('\r\n'),
    ]);

  /** A pilha da rota `/api/skills/:slug/files`, sem sessão nem banco. */
  function subir(handler: (req: Request, res: Response) => void): Promise<string> {
    const app = express();
    app.post('/files', limitRequestBytes, upload.array('files', MAX_FILES_PER_REQUEST), handler);
    app.use(onError);

    return new Promise((resolve) => {
      running = app.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(running!.address() as AddressInfo).port}`);
      });
    });
  }

  /** Sem `Content-Length`: o Node manda `Transfer-Encoding: chunked` sozinho. */
  function enviar(base: string, partes: Buffer[]): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/files`,
        { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${LIMITE}` } },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
        },
      );
      req.on('error', reject);
      for (const pedaco of partes) req.write(pedaco);
      req.end(Buffer.from(`--${LIMITE}--\r\n`));
    });
  }

  const ecoa = (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    res.json({
      nomes: files.map((file) => file.originalname),
      prefix: (req.body as { prefix?: unknown }).prefix,
      total: files.reduce((sum, file) => sum + file.size, 0),
    });
  };

  it('nome de arquivo acentuado chega em UTF-8, como o campo de texto ao lado', async () => {
    // Com o `latin1` padrão do multer saía `descriÃ§Ã£o.md` dentro de `referências`.
    const base = await subir(ecoa);

    const { status, body } = await enviar(base, [campo('prefix', 'referências'), arquivo('descrição.md', 'oi')]);

    expect(status).toBe(200);
    expect(body).toMatchObject({ nomes: ['descrição.md'], prefix: 'referências' });
  });

  it('nomes ASCII, com espaço, com % e com aspas continuam iguais', async () => {
    const base = await subir(ecoa);

    // O navegador escapa as aspas do nome como `%22`; o multer as devolve.
    const { body } = await enviar(base, [
      arquivo('notas de campo.md', 'a'),
      arquivo('50%.txt', 'b'),
      arquivo('nota %22final%22.md', 'c'),
    ]);

    expect(body.nomes).toEqual(['notas de campo.md', '50%.txt', 'nota "final".md']);
  });

  it('chunked dentro do teto continua aceito: não há 411', async () => {
    cfg.maxUploadBytes = 64 * 1024;
    const base = await subir(ecoa);

    const { status, body } = await enviar(base, [arquivo('a.bin', Buffer.alloc(30 * 1024)), arquivo('b.bin', Buffer.alloc(30 * 1024))]);

    expect(status).toBe(200);
    expect(body.total).toBe(60 * 1024);
  });

  it('chunked acima do teto é cortado no arquivo que estoura: 413, e os seguintes nem chegam ao storage', async () => {
    // Era o buraco: sem `Content-Length` os dez arquivos eram bufferizados
    // inteiros e a soma só era conferida depois, já dentro do handler.
    cfg.maxUploadBytes = 64 * 1024;
    const guardados = vi.spyOn(budgetedMemoryStorage, '_handleFile');
    const handler = vi.fn(ecoa);
    const base = await subir(handler);

    const dez = Array.from({ length: 10 }, (_, i) => arquivo(`f${i}.bin`, Buffer.alloc(40 * 1024)));
    const { status, body } = await enviar(base, dez);

    expect(status).toBe(413);
    expect(body.error).toBe('payload_too_large');
    expect(body.message).toMatch(/por requisição/);
    expect(handler).not.toHaveBeenCalled();
    // 40 KB cabem, 80 KB estouram: o terceiro arquivo em diante não é guardado.
    expect(guardados).toHaveBeenCalledTimes(2);
  });

  it('o máximo legítimo de partes passa: 50 arquivos e 20 campos', async () => {
    // O busboy dispara `partsLimit` ao ATINGIR o número: o teto é 50 + 20 + 1.
    const base = await subir(ecoa);
    const campos = Array.from({ length: 20 }, (_, i) => campo(`c${i}`, 'x'));
    const arquivos = Array.from({ length: MAX_FILES_PER_REQUEST }, (_, i) => arquivo(`f${i}.txt`, 'x'));

    const { status, body } = await enviar(base, [...campos, ...arquivos]);

    expect(status).toBe(200);
    expect(body.nomes).toHaveLength(MAX_FILES_PER_REQUEST);
  });

  it('campos de texto demais são 400: sem teto, cada um guardava até 1 MB em memória', async () => {
    const handler = vi.fn(ecoa);
    const base = await subir(handler);
    const campos = Array.from({ length: 21 }, (_, i) => campo(`c${i}`, 'x'));

    const { status, body } = await enviar(base, [...campos, arquivo('a.md', 'oi')]);

    expect(status).toBe(400);
    expect(body.error).toBe('bad_request');
    expect(handler).not.toHaveBeenCalled();
  });

  it('arquivos demais são 400', async () => {
    const handler = vi.fn(ecoa);
    const base = await subir(handler);
    const arquivos = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, i) => arquivo(`f${i}.txt`, 'x'));

    const { status } = await enviar(base, arquivos);

    expect(status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
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
