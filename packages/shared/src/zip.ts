import { Writable } from 'node:stream';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
import { readIntEnv } from './env.js';
import { isTextualMime, mimeTypeFor, normalizeRelativePath } from './paths.js';

export type ZipEntryInput = {
  relativePath: string;
  content: Buffer | string;
};

/**
 * Gera um ZIP com as entradas informadas e escreve no stream de saída.
 * Resolve quando o ZIP terminou de ser escrito.
 */
export function writeZip(entries: readonly ZipEntryInput[], out: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    out.on('close', () => resolve());
    out.on('error', reject);

    archive.pipe(out);
    for (const entry of entries) {
      const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
      archive.append(data, { name: entry.relativePath });
    }
    archive.finalize().catch(reject);
  });
}

/** Gera o ZIP inteiramente em memória — usado em testes e no MCP admin. */
export async function zipToBuffer(entries: readonly ZipEntryInput[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });

  await new Promise<void>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    sink.on('finish', () => resolve());
    archive.pipe(sink);
    for (const entry of entries) {
      const data = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
      archive.append(data, { name: entry.relativePath });
    }
    archive.finalize().catch(reject);
  });

  return Buffer.concat(chunks);
}

export type ExtractedFile = {
  relativePath: string;
  mimeType: string;
  textContent: string | null;
  binaryContent: Buffer | null;
  sizeBytes: number;
};

/**
 * Teto padrão do conteúdo descomprimido de um ZIP.
 *
 * Lido com `readIntEnv`: um valor inválido aqui viraria `NaN` e desligaria a
 * checagem de zip bomb sem avisar ninguém.
 */
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = readIntEnv(
  'ZIP_MAX_UNCOMPRESSED_BYTES',
  256 * 1024 * 1024,
  { min: 1024 },
);

/** Teto padrão de entradas por ZIP. */
export const DEFAULT_MAX_ZIP_ENTRIES = readIntEnv('ZIP_MAX_ENTRIES', 512);

export type ExtractZipOptions = {
  /**
   * Quando o ZIP tem uma única pasta raiz (padrão de `zip -r skill.zip skill/`),
   * essa pasta é removida dos caminhos. Ligado por padrão.
   */
  stripSingleRootDir?: boolean;
  /** Teto do total descomprimido. Acima disso, `extractZip` lança. */
  maxUncompressedBytes?: number;
  /** Teto do número de entradas do ZIP. */
  maxEntries?: number;
};

/** Base dos erros de ZIP causados pelo arquivo enviado — sempre 400, nunca 500. */
export class ZipError extends Error {
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}

/** ZIP recusado por exceder um limite (tamanho descomprimido ou nº de entradas). */
export class ZipLimitError extends ZipError {
  constructor(message: string) {
    super(message, 'ZipLimitError');
  }
}

/** ZIP ilegível: não é um ZIP, está truncado ou corrompido. */
export class ZipFormatError extends ZipError {
  constructor(message: string) {
    super(message, 'ZipFormatError');
  }
}

/**
 * Extrai um ZIP em memória para a representação usada na tabela `files`.
 * Ignora diretórios, arquivos de metadados de SO e caminhos inseguros.
 *
 * O conteúdo descomprimido é limitado: um ZIP de poucos KB pode expandir para
 * gigabytes ("zip bomb") e derrubar o processo por falta de memória. O tamanho
 * declarado no cabeçalho é checado antes de descomprimir (evita materializar a
 * entrada), e o tamanho real é somado depois, porque um ZIP malformado pode
 * declarar qualquer coisa.
 */
export function extractZip(buffer: Buffer, options: ExtractZipOptions = {}): ExtractedFile[] {
  const {
    stripSingleRootDir = true,
    maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
    maxEntries = DEFAULT_MAX_ZIP_ENTRIES,
  } = options;
  // `adm-zip` lança um Error genérico ("Invalid or unsupported zip format")
  // para qualquer coisa que não seja um ZIP; sem este `catch` isso viraria 500.
  let zip: AdmZip;
  let entries: ReturnType<AdmZip['getEntries']>;
  try {
    zip = new AdmZip(buffer);
    entries = zip.getEntries();
  } catch (err) {
    throw new ZipFormatError(`O arquivo não é um .zip válido: ${(err as Error).message}`);
  }

  if (entries.length > maxEntries) {
    throw new ZipLimitError(
      `O .zip tem entradas demais (${entries.length}); o limite é ${maxEntries}.`,
    );
  }

  const limitMb = Math.round(maxUncompressedBytes / (1024 * 1024));
  const tooBig = () =>
    new ZipLimitError(`O conteúdo descomprimido do .zip passa do limite de ${limitMb} MB.`);

  let total = 0;
  const raw: { path: string; data: Buffer }[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;

    // Checagem barata antes de descomprimir a entrada.
    if (total + (entry.header?.size ?? 0) > maxUncompressedBytes) throw tooBig();

    const path = normalizeRelativePath(entry.entryName);
    if (!path) continue;
    if (isJunkPath(path)) continue;

    let data: Buffer;
    try {
      data = entry.getData();
    } catch (err) {
      throw new ZipFormatError(
        `Não foi possível ler "${entry.entryName}" do .zip: ${(err as Error).message}`,
      );
    }
    total += data.byteLength;
    if (total > maxUncompressedBytes) throw tooBig();

    raw.push({ path, data });
  }

  const prefix = stripSingleRootDir ? commonRootDir(raw.map((e) => e.path)) : null;

  const files: ExtractedFile[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const path = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    files.push(toExtractedFile(path, entry.data));
  }

  return files;
}

/** Monta a linha de `files` a partir de um caminho + bytes crus. */
export function toExtractedFile(relativePath: string, data: Buffer): ExtractedFile {
  const mimeType = mimeTypeFor(relativePath);
  const textual = isTextualMime(mimeType) && !data.includes(0);

  return {
    relativePath,
    mimeType,
    textContent: textual ? data.toString('utf8') : null,
    binaryContent: textual ? null : data,
    sizeBytes: data.byteLength,
  };
}

function isJunkPath(path: string): boolean {
  const segments = path.split('/');
  return segments.some(
    (segment) => segment === '__MACOSX' || segment === '.DS_Store' || segment === 'Thumbs.db',
  );
}

/** Retorna a pasta raiz comum a todos os caminhos, ou `null` se não houver. */
function commonRootDir(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const first = paths[0].split('/');
  if (first.length < 2) return null;
  const root = first[0];
  return paths.every((p) => p.startsWith(`${root}/`)) ? root : null;
}
