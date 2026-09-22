import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { AVATAR_MAX_BYTES } from '@purple-skills/shared';
import { config } from './config.js';

/** Arquivos por requisição: o teto do `upload.array('files', …)` do envio avulso. */
export const MAX_FILES_PER_REQUEST = 50;

/** Campos de texto por requisição: o import manda cinco, o envio avulso, um. */
const MAX_FIELDS_PER_REQUEST = 20;

const inMegabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * A soma dos arquivos passou do teto por requisição **no meio do envio**. Sai
 * do storage, o multer aborta o upload e o `onError` responde 413.
 */
export class UploadTooLargeError extends Error {
  constructor() {
    super(`Envio maior que o limite de ${inMegabytes(config.maxUploadBytes)} MB por requisição`);
    this.name = 'UploadTooLargeError';
  }
}

/** Bytes de arquivo já recebidos em cada requisição — a soma que `fileSize` não vê. */
const receivedBytes = new WeakMap<Request, number>();

const memory = multer.memoryStorage();

/**
 * O `memoryStorage` do multer com a soma da requisição conferida **a cada
 * pedaço**, e não depois do upload.
 *
 * `limits.fileSize` corta cada arquivo isolado, e o `Content-Length` só segura
 * quem o declara: num envio `chunked` os 50 arquivos de `/files` eram
 * bufferizados inteiros (até 50 × o teto, mais que o `mem_limit` do container)
 * antes de `rejectOversizedBatch` somar. Aqui o erro sai no pedaço que estoura:
 * o multer desliga o parser da requisição, descarta o resto do corpo sem
 * guardar e só então responde — o cliente recebe o 413 em vez de um EPIPE.
 *
 * Recusar com 411 quem não declara tamanho seria mais simples, mas quebraria o
 * envio legítimo atrás de proxy que reempacota o corpo em `chunked`.
 */
export const budgetedMemoryStorage: multer.StorageEngine = {
  _handleFile(req, file, callback) {
    let settled = false;
    const settle: typeof callback = (error, info) => {
      if (settled) return;
      settled = true;
      callback(error, info);
    };

    // Registrado antes do `pipe` do storage: os dois recebem todo pedaço.
    file.stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      const total = (receivedBytes.get(req) ?? 0) + chunk.length;
      receivedBytes.set(req, total);
      if (total <= config.maxUploadBytes) return;

      // Solta o que já foi juntado deste arquivo e deixa o resto escoar.
      file.stream.unpipe();
      file.stream.resume();
      settle(new UploadTooLargeError());
    });

    memory._handleFile(req, file, settle);
  },

  _removeFile(req, file, callback) {
    memory._removeFile(req, file, callback);
  },
};

/**
 * Upload em memória: os arquivos vão direto para o `bytea` do Postgres, sem
 * passar por disco. `limits.fileSize` vale para **cada** arquivo isolado — o
 * teto por requisição é de `limitRequestBytes` (quando há `Content-Length`) e
 * de `budgetedMemoryStorage` (sempre, durante o stream).
 *
 * `files`, `fields` e `parts` têm padrão `Infinity` no busboy: sem eles, o
 * número de campos de texto (1 MB cada) de um envio `chunked` não tinha teto,
 * nas três rotas. O busboy dispara `partsLimit` ao **atingir** o número, não ao
 * passar dele — daí o `+ 1`.
 *
 * `defParamCharset: 'utf8'`: o navegador manda `filename="…"` em UTF-8 cru, e
 * o padrão do multer/busboy é `latin1` — `descrição.md` era gravado como
 * `descriÃ§Ã£o.md`, enquanto a pasta (`prefix`, campo de texto) saía certa. Com
 * o nome trocado, a guarda de colisão do painel deixava de reconhecer o arquivo
 * no envio seguinte.
 */
export const upload = multer({
  storage: budgetedMemoryStorage,
  limits: {
    fileSize: config.maxUploadBytes,
    files: MAX_FILES_PER_REQUEST,
    fields: MAX_FIELDS_PER_REQUEST,
    parts: MAX_FILES_PER_REQUEST + MAX_FIELDS_PER_REQUEST + 1,
  },
  defParamCharset: 'utf8',
});

/**
 * O multer do **avatar**: um arquivo só, e o corte no stream.
 *
 * O `upload` de cima corta pelo teto do painel (`ADMIN_MAX_UPLOAD_BYTES`, 64 MB
 * por padrão), que é o do .zip de uma skill. Um avatar cabe em 512 KB
 * (`AVATAR_MAX_BYTES`), e a conferência de `apps/admin/src/profile.ts` acontece
 * **depois** de receber os bytes: sem este limite, uma conta logada podia
 * empurrar 64 MB para a memória do processo a cada requisição e só então ouvir
 * "a foto precisa ter até 512 KB".
 *
 * A folga de 64 KB é para o envelope multipart — delimitadores, cabeçalho de
 * parte, o nome do campo. O `fileSize` do multer mede o **arquivo**, não a
 * requisição, então a folga é do `limitRequestBytes`; aqui ela só evita que um
 * arquivo de exatamente 512 KB seja cortado por um byte de contabilidade.
 *
 * A conferência de `profile.ts` **fica**: este limite responde com o erro do
 * multer, genérico; o de lá é a regra da rota, com a mensagem que explica o
 * formato e o SVG. E é o de lá que vale se alguém montar outro caminho.
 */
export const avatarUpload = multer({
  storage: memory,
  limits: {
    fileSize: AVATAR_MAX_BYTES + 64 * 1024,
    files: 1,
    fields: 0,
    parts: 2,
  },
  defParamCharset: 'utf8',
});

/**
 * Folga sobre o teto para o envelope multipart — delimitadores, cabeçalho de
 * cada parte e os campos de texto que viajam junto. Sem ela, um arquivo de
 * exatamente 64 MB seria recusado pelo `Content-Length`.
 */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

/**
 * Teto **por requisição**, não por arquivo.
 *
 * `limits.fileSize` do multer vale para cada arquivo isolado: com
 * `upload.array('files', 50)` uma única requisição bufferizava até 50 × 64 MB
 * em memória, contra o teto de 64 MB por requisição que o README documenta.
 *
 * A recusa acontece **antes** do multer, pelo `Content-Length`, para não
 * bufferizar nada — e o valor é confiável: o parser HTTP do Node entrega no
 * máximo os bytes declarados. Um cliente que envie sem `Content-Length`
 * (chunked) escapa daqui e é cortado **durante** o stream pelo
 * `budgetedMemoryStorage`; conferir a soma só depois do upload, como era, não
 * protegia a memória, porque os bytes já tinham sido bufferizados.
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
 * memória, mas a operação é recusada antes de virar escrita no banco. Com o
 * corte em fluxo do `budgetedMemoryStorage` ela ficou redundante, não errada.
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
