import { Writable } from 'node:stream';
import AdmZip from 'adm-zip';
import archiver from 'archiver';
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

export type ExtractZipOptions = {
  /**
   * Quando o ZIP tem uma única pasta raiz (padrão de `zip -r skill.zip skill/`),
   * essa pasta é removida dos caminhos. Ligado por padrão.
   */
  stripSingleRootDir?: boolean;
};

/**
 * Extrai um ZIP em memória para a representação usada na tabela `files`.
 * Ignora diretórios, arquivos de metadados de SO e caminhos inseguros.
 */
export function extractZip(buffer: Buffer, options: ExtractZipOptions = {}): ExtractedFile[] {
  const { stripSingleRootDir = true } = options;
  const zip = new AdmZip(buffer);

  const raw: { path: string; data: Buffer }[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const path = normalizeRelativePath(entry.entryName);
    if (!path) continue;
    if (isJunkPath(path)) continue;
    raw.push({ path, data: entry.getData() });
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
