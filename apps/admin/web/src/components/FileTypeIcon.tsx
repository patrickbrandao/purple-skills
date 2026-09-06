import type { ReactNode } from 'react';

/* ============================================================
   ÍCONES POR TIPO DE ARQUIVO
   Um glifo por família de extensão, no mesmo peso de traço dos
   demais ícones do site. A cor não vem daqui: cada ícone recebe
   a classe `ft-<tipo>` e o `app.css` define `color`, que os
   traços herdam por `currentColor`.
   ============================================================ */

type Props = { className?: string };

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Metade superior do logotipo do Python; a inferior é a mesma girada 180°. */
const PYTHON_HALF =
  'M10.5 1.5h4.5a3.5 3.5 0 0 1 3.5 3.5v5.5a3.5 3.5 0 0 1-3.5 3.5h-4.5v1' +
  'a3 3 0 0 1-3 3h-3a3 3 0 0 1-3-3v-1.5a3 3 0 0 1 3-3h2.5V5a3.5 3.5 0 0 1 3.5-3.5z' +
  'M9.9 4.05a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 1 0 0-2.3z';

/** Retângulo arredondado com uma sigla dentro — usado por JS, TS e afins. */
function Badge({ label }: { label: string }) {
  return (
    <>
      <rect x="3" y="3.5" width="18" height="17" rx="4" {...stroke} />
      <text
        x="12"
        y="12.6"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="currentColor"
        stroke="none"
        fontFamily="var(--font-mono)"
        fontWeight={700}
        fontSize={label.length > 2 ? 6.4 : 8.2}
        letterSpacing={label.length > 2 ? -0.2 : 0}
      >
        {label}
      </text>
    </>
  );
}

const GLYPHS: Record<string, ReactNode> = {
  python: (
    <>
      <path fill="currentColor" fillRule="evenodd" d={PYTHON_HALF} />
      <path
        className="alt"
        fill="currentColor"
        fillRule="evenodd"
        d={PYTHON_HALF}
        transform="rotate(180 12 12)"
      />
    </>
  ),

  js: <Badge label="JS" />,
  ts: <Badge label="TS" />,

  json: (
    <>
      <path d="M10 3.5c-2 0-2.8.9-2.8 2.6v2.3c0 1.5-.8 2.4-2.2 2.6v2c1.4.2 2.2 1.1 2.2 2.6v2.3c0 1.7.8 2.6 2.8 2.6" {...stroke} />
      <path d="M14 3.5c2 0 2.8.9 2.8 2.6v2.3c0 1.5.8 2.4 2.2 2.6v2c-1.4.2-2.2 1.1-2.2 2.6v2.3c0 1.7-.8 2.6-2.8 2.6" {...stroke} />
    </>
  ),

  markdown: (
    <>
      <rect x="1.5" y="4.5" width="21" height="15" rx="2.6" {...stroke} />
      <path d="M4.8 16V8l3 3.8L10.8 8v8" {...stroke} />
      <path d="M16.4 8v6.6m0 0 2-2.2m-2 2.2-2-2.2" {...stroke} />
    </>
  ),

  html: (
    <>
      <path d="m8.5 8.5-4 3.5 4 3.5" {...stroke} />
      <path d="m15.5 8.5 4 3.5-4 3.5" {...stroke} />
      <path d="m13.4 5.5-2.8 13" {...stroke} />
    </>
  ),

  css: (
    <>
      <path d="M9.6 3.5 7.4 20.5M16.6 3.5l-2.2 17" {...stroke} />
      <path d="M4.6 9h15M3.9 15h15" {...stroke} />
    </>
  ),

  shell: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2.6" {...stroke} />
      <path d="m6.8 9.5 3 2.5-3 2.5" {...stroke} />
      <path d="M13 15h4.4" {...stroke} />
    </>
  ),

  config: (
    <>
      <path d="M4 6.5h4.5M13.5 6.5h6.5M4 12h9.5M18.5 12H20M4 17.5h2.5M11.5 17.5H20" {...stroke} />
      <circle cx="11" cy="6.5" r="2" {...stroke} />
      <circle cx="16" cy="12" r="2" {...stroke} />
      <circle cx="9" cy="17.5" r="2" {...stroke} />
    </>
  ),

  image: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2.6" {...stroke} />
      <circle cx="8.5" cy="9.5" r="1.9" {...stroke} />
      <path d="m3.5 17.5 4.8-4.4a2 2 0 0 1 2.7 0l3 2.8m0 0 2-1.8a2 2 0 0 1 2.7 0l1.8 1.6m-6.5.2 3 2.9" {...stroke} />
    </>
  ),

  pdf: (
    <>
      <path d="M14 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8z" {...stroke} />
      <path d="M14 2.5V8h5.5" {...stroke} />
      <path d="M8.2 18v-4h1.4a1.3 1.3 0 0 1 0 2.6H8.2M12.6 18v-4h1a2 2 0 0 1 0 4zM18.8 14h-2v4m0-2h1.6" {...stroke} strokeWidth={1.4} />
    </>
  ),

  archive: (
    <>
      <path d="M2.5 7.5 5 3.5h14l2.5 4" {...stroke} />
      <path d="M2.5 7.5h19V19a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" {...stroke} />
      <path d="M10 11h4M10 14.5h4" {...stroke} />
    </>
  ),

  table: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2.6" {...stroke} />
      <path d="M2.5 9.5h19M9 9.5V20M15.5 9.5V20" {...stroke} />
    </>
  ),

  database: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" {...stroke} />
      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" {...stroke} />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" {...stroke} />
    </>
  ),

  text: (
    <>
      <path d="M14 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8z" {...stroke} />
      <path d="M14 2.5V8h5.5" {...stroke} />
      <path d="M8 12.5h8M8 16h5.5" {...stroke} />
    </>
  ),

  container: (
    <>
      <path d="M2.5 12h14V8.5H13V5.5H9.5v3H6v3.5" {...stroke} />
      <path d="M2.5 12c0 4.5 2.8 7 7.5 7 5.5 0 9-2.6 10.3-7 1.2 0 1.7-.7 1.7-1.5" {...stroke} />
    </>
  ),

  file: (
    <>
      <path d="M14 2.5H7A2.5 2.5 0 0 0 4.5 5v14A2.5 2.5 0 0 0 7 21.5h10a2.5 2.5 0 0 0 2.5-2.5V8z" {...stroke} />
      <path d="M14 2.5V8h5.5" {...stroke} />
    </>
  ),
};

/** Extensão → família de ícone. */
const BY_EXTENSION: Record<string, string> = {
  py: 'python',
  pyw: 'python',
  pyi: 'python',

  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'js',

  ts: 'ts',
  tsx: 'ts',
  mts: 'ts',
  cts: 'ts',

  json: 'json',
  jsonc: 'json',
  json5: 'json',

  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',

  html: 'html',
  htm: 'html',
  xhtml: 'html',
  xml: 'html',
  svg: 'html',

  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',

  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  ps1: 'shell',
  bat: 'shell',
  cmd: 'shell',

  yml: 'config',
  yaml: 'config',
  toml: 'config',
  ini: 'config',
  cfg: 'config',
  conf: 'config',
  env: 'config',
  properties: 'config',

  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',

  pdf: 'pdf',

  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  '7z': 'archive',
  rar: 'archive',

  csv: 'table',
  tsv: 'table',
  xlsx: 'table',
  xls: 'table',
  ods: 'table',

  sql: 'database',
  db: 'database',
  sqlite: 'database',

  txt: 'text',
  log: 'text',
  text: 'text',
  rst: 'text',
  adoc: 'text',
};

/** Arquivos sem extensão que ainda assim têm cara própria. */
const BY_NAME: Record<string, string> = {
  dockerfile: 'container',
  containerfile: 'container',
  makefile: 'config',
  license: 'text',
  licence: 'text',
  notice: 'text',
  procfile: 'config',
  gitignore: 'config',
  dockerignore: 'config',
  npmrc: 'config',
  editorconfig: 'config',
};

/** Sigla de no máximo três letras para extensões sem ícone próprio. */
function badgeLabel(extension: string): string {
  return extension.slice(0, 3).toUpperCase();
}

/** Descobre a família de ícone (e a sigla, quando for o caso) de um arquivo. */
export function fileIconKind(fileName: string): { kind: string; label?: string } {
  const name = fileName.toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  const bare = name.startsWith('.') ? name.slice(1) : name;

  if (BY_NAME[bare]) return { kind: BY_NAME[bare] };
  if (!extension) return { kind: 'file' };
  if (BY_EXTENSION[extension]) return { kind: BY_EXTENSION[extension] };
  return { kind: 'badge', label: badgeLabel(extension) };
}

/** Ícone que representa a extensão do arquivo. */
export function FileTypeIcon({ fileName, className = '' }: Props & { fileName: string }) {
  const { kind, label } = fileIconKind(fileName);
  const glyph = kind === 'badge' ? <Badge label={label ?? '?'} /> : GLYPHS[kind] ?? GLYPHS.file;

  return (
    <svg className={`ft-icon ft-${kind} ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true">
      {glyph}
    </svg>
  );
}

/** Pasta do explorador de arquivos, aberta ou fechada. */
export function FolderIcon({ open = false, className = '' }: Props & { open?: boolean }) {
  return (
    <svg className={`ft-icon ft-folder ${className}`.trim()} viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M2.5 19V6a2 2 0 0 1 2-2h4.2a2 2 0 0 1 1.5.7l1.3 1.5h8a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z"
        {...stroke}
      />
      {open && <path d="M2.9 19.4 5.4 12h16.2l-2.5 7.4" {...stroke} />}
    </svg>
  );
}
