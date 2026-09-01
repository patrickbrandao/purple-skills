export const SKILL_MD = 'SKILL.md';

/**
 * Normaliza um caminho relativo vindo de upload/MCP:
 * - troca `\` por `/`
 * - remove `./`, barras duplicadas e barras nas pontas
 * - rejeita travessia de diretório (`..`), caminhos absolutos e vazios
 *
 * Retorna `null` quando o caminho não é aceitável.
 */
export function normalizeRelativePath(input: string): string | null {
  if (typeof input !== 'string') return null;

  const cleaned = input
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');

  if (!cleaned) return null;
  if (cleaned.startsWith('/')) return null;
  if (cleaned.split('/').some((segment) => segment === '..')) return null;
  if (cleaned.includes('\0')) return null;
  if (/^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.length > 512) return null;

  return cleaned;
}

/** `SKILL.md` é comparado sem diferenciar maiúsculas/minúsculas. */
export function isSkillMd(relativePath: string): boolean {
  return relativePath.toLowerCase() === SKILL_MD.toLowerCase();
}

const MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  jsonc: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  sql: 'application/sql',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wasm: 'application/wasm',
};

/** Detecta o mime-type pela extensão do arquivo (fallback binário genérico). */
export function mimeTypeFor(relativePath: string): string {
  const name = relativePath.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'text/plain';
  const ext = name.slice(dot + 1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** Conteúdos textuais são guardados em `text_content`; o resto vira `bytea`. */
export function isTextualMime(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/yaml' ||
    mimeType === 'application/toml' ||
    mimeType === 'application/sql' ||
    mimeType === 'application/xml' ||
    mimeType === 'image/svg+xml'
  );
}
