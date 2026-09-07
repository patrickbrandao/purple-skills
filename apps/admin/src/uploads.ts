import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { config } from './config.js';

/**
 * Upload em memória: os arquivos vão direto para o `bytea` do Postgres, sem
 * passar por disco. `limits.fileSize` vale para **cada** arquivo isolado — o
 * teto por requisição é assunto de `limitRequestBytes`.
 */
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

/**
 * Folga sobre o teto para o envelope multipart — delimitadores, cabeçalho de
 * cada parte e os campos de texto que viajam junto. Sem ela, um arquivo de
 * exatamente 64 MB seria recusado pelo `Content-Length`.
 */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

const inMegabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * Teto **por requisição**, não por arquivo.
 *
 * `limits.fileSize` do multer vale para cada arquivo isolado: com
 * `upload.array('files', 50)` uma única requisição bufferizava até 50 × 64 MB
 * em memória, contra o teto de 64 MB por requisição que o README documenta.
 *
 * A recusa acontece **antes** do multer, pelo `Content-Length`, para não
 * bufferizar nada. Um cliente que envie sem `Content-Length` (chunked) escapa
 * daqui — para esse caso a soma dos arquivos é conferida depois do upload por
 * `rejectOversizedBatch`, e os limites por arquivo e por quantidade continuam
 * valendo.
 */
export function limitRequestBytes(req: Request, res: Response, next: NextFunction): void {
  const declared = Number(req.header('content-length'));

  if (Number.isFinite(declared) && declared > config.maxUploadBytes + MULTIPART_OVERHEAD_BYTES) {
    res.status(413).json({
      error: 'payload_too_large',
      message: `Envio maior que o limite de ${inMegabytes(config.maxUploadBytes)} MB por requisição`,
    });
    return;
  }

  next();
}

/**
 * Rede de segurança do envio de vários arquivos: aqui os bytes já estão em
 * memória, mas a operação é recusada antes de virar escrita no banco.
 *
 * Devolve `true` quando já respondeu 413 — a rota deve parar.
 */
export function rejectOversizedBatch(files: readonly Express.Multer.File[], res: Response): boolean {
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes <= config.maxUploadBytes) return false;

  res.status(413).json({
    error: 'payload_too_large',
    message: `Soma dos arquivos (${inMegabytes(totalBytes)} MB) acima do limite de ${inMegabytes(config.maxUploadBytes)} MB por requisição`,
  });
  return true;
}
