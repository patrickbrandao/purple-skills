import { common, createLowlight } from 'lowlight';
import cmake from 'highlight.js/lib/languages/cmake';
import django from 'highlight.js/lib/languages/django';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import latex from 'highlight.js/lib/languages/latex';
import nginx from 'highlight.js/lib/languages/nginx';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';

/* ============================================================
   CORES DE SINTAXE DO VISUALIZADOR DE ARQUIVOS
   Descobre a linguagem pelo nome do arquivo (ou pelo shebang) e
   quebra o código colorido em linhas de pedaços simples, que o
   React escreve sem `innerHTML`.

   Usa o `lowlight` — o highlight.js que o markdown já carrega pelo
   rehype-highlight —, com as linguagens comuns e mais algumas de
   configuração e script. As classes saem com o prefixo `sx-`,
   para não herdar o tema do markdown: as cores são tokens do
   painel (`--syn-*`), nos dois temas.
   ============================================================ */

/** A classe de cada pedaço colorido: `sx-keyword`, `sx-title function_`… */
export const SYNTAX_PREFIX = 'sx-';

/** Acima disto (em caracteres do trecho mostrado) o arquivo aparece sem cores. */
export const HIGHLIGHT_MAX_CHARS = 250_000;

/** Linhas mostradas de uma vez; o resto fica para o "Abrir cru". */
export const VIEW_MAX_LINES = 10_000;

const GRAMMARS = { ...common, cmake, django, dockerfile, dos, latex, nginx, powershell, properties, protobuf };

type Lowlight = ReturnType<typeof createLowlight>;
let instance: Lowlight | null = null;

/** Registrar as gramáticas custa pouco, mas só acontece quando alguém abre um arquivo. */
function lowlight(): Lowlight {
  instance ??= createLowlight(GRAMMARS);
  return instance;
}

/** O nome que aparece no rodapé; a chave é o nome da gramática. */
const LABELS: Record<string, string> = {
  arduino: 'Arduino',
  bash: 'Shell',
  c: 'C',
  cmake: 'CMake',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  django: 'Jinja',
  dockerfile: 'Dockerfile',
  dos: 'Batch',
  go: 'Go',
  graphql: 'GraphQL',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  kotlin: 'Kotlin',
  latex: 'LaTeX',
  less: 'Less',
  lua: 'Lua',
  makefile: 'Makefile',
  markdown: 'Markdown',
  nginx: 'Nginx',
  objectivec: 'Objective-C',
  perl: 'Perl',
  php: 'PHP',
  powershell: 'PowerShell',
  properties: 'Properties',
  protobuf: 'Protocol Buffers',
  python: 'Python',
  'python-repl': 'Python (sessão)',
  r: 'R',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  shell: 'Sessão de terminal',
  sql: 'SQL',
  swift: 'Swift',
  typescript: 'TypeScript',
  vbnet: 'Visual Basic',
  wasm: 'WebAssembly',
  xml: 'HTML/XML',
  yaml: 'YAML',
};

/**
 * Extensão → gramática. A lista é explícita, em vez dos apelidos do
 * highlight.js: um apelido inesperado coloriria um arquivo com a linguagem
 * errada, e texto sem cor é melhor que cor errada.
 */
const BY_EXTENSION: Record<string, string> = {
  // documentação
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  mkd: 'markdown',
  tex: 'latex',
  ltx: 'latex',
  // web
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  html: 'xml',
  htm: 'xml',
  xhtml: 'xml',
  xml: 'xml',
  svg: 'xml',
  xsd: 'xml',
  xsl: 'xml',
  plist: 'xml',
  vue: 'xml',
  svelte: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  graphql: 'graphql',
  gql: 'graphql',
  wat: 'wasm',
  wast: 'wasm',
  // dados e configuração
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  ipynb: 'json',
  webmanifest: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'properties',
  proto: 'protobuf',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  // templates
  j2: 'django',
  jinja: 'django',
  jinja2: 'django',
  // scripts
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ksh: 'bash',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  bat: 'dos',
  cmd: 'dos',
  py: 'python',
  pyw: 'python',
  pyi: 'python',
  php: 'php',
  phtml: 'php',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  pl: 'perl',
  pm: 'perl',
  lua: 'lua',
  r: 'r',
  // compiladas
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hh: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  // `.m` fica de fora: é Objective-C, mas também MATLAB.
  mm: 'objectivec',
  rs: 'rust',
  swift: 'swift',
  vb: 'vbnet',
  ino: 'arduino',
  mk: 'makefile',
  cmake: 'cmake',
};

/** Arquivos que o nome inteiro identifica (em minúsculas). */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  'nginx.conf': 'nginx',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.zshrc': 'bash',
  '.profile': 'bash',
  '.editorconfig': 'ini',
  '.gitconfig': 'ini',
  '.npmrc': 'ini',
};

/** O programa do shebang → gramática. */
const INTERPRETERS: Record<string, string> = {
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ksh: 'bash',
  dash: 'bash',
  node: 'javascript',
  bun: 'javascript',
  deno: 'typescript',
  tsx: 'typescript',
  'ts-node': 'typescript',
  php: 'php',
  ruby: 'ruby',
  perl: 'perl',
  lua: 'lua',
  rscript: 'r',
  pwsh: 'powershell',
  // `#!/usr/bin/env -S uv run --script`: scripts Python com dependências inline.
  uv: 'python',
};

/** O programa que o shebang chama, sem caminho, versão nem opções do `env`. */
function interpreterOf(content: string): string | null {
  if (!content.startsWith('#!')) return null;
  const end = content.indexOf('\n');
  const words = content.slice(2, end === -1 ? undefined : end).trim().split(/\s+/);
  let program = words.shift()?.split('/').pop() ?? '';
  if (program === 'env') program = words.find((word) => !word.startsWith('-') && !word.includes('=')) ?? '';
  const name = program.toLowerCase();
  if (/^python[\d.]*$/.test(name)) return 'python';
  return INTERPRETERS[name] ?? null;
}

/**
 * A gramática de um arquivo, pelo nome e, sem nome que diga, pela primeira
 * linha. `null` é texto puro — `.txt`, `.csv`, `LICENSE` e o que não se
 * reconhece.
 */
export function languageFor(fileName: string, content = ''): string | null {
  const name = (fileName.split('/').pop() ?? fileName).toLowerCase();
  const byName = BY_NAME[name] ?? (name === '.env' || name.startsWith('.env.') ? 'ini' : undefined);
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  const byExtension = dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined;
  return byExtension ?? interpreterOf(content);
}

/** Como a linguagem aparece para quem lê. */
export function languageLabel(language: string | null): string {
  if (!language) return 'Texto';
  return LABELS[language] ?? language;
}

/** As linhas que o leitor mostra: como `toCodeLines`, a quebra do fim não conta. */
export function readLineCount(content: string): number {
  let lines = 1;
  for (let at = content.indexOf('\n'); at !== -1; at = content.indexOf('\n', at + 1)) lines += 1;
  return content.endsWith('\n') ? lines - 1 : lines;
}

/** Um pedaço de linha; sem `className`, sai na cor do texto. */
export type CodeToken = { text: string; className?: string };
export type CodeLine = CodeToken[];

export type CodeLines = {
  /** As linhas mostradas, no máximo `maxLines`. */
  lines: CodeLine[];
  /** Quantas linhas o arquivo tem (sem contar a quebra do fim). */
  total: number;
  /** A gramática pedida; `colored` diz se ela foi aplicada. */
  language: string | null;
  colored: boolean;
};

/** O pedaço da árvore do lowlight que interessa: texto e `span` com classe. */
type HastNode = {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

function classOf(node: HastNode): string | undefined {
  const value = node.properties?.className;
  if (Array.isArray(value) && value.length > 0) return value.join(' ');
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Achata a árvore em linhas. Cada pedaço leva a classe do `span` mais
 * interno — é ele que decide a cor —, e um `span` que atravessa linhas (um
 * comentário de bloco, uma string longa) é repetido em cada uma.
 */
function flatten(nodes: readonly HastNode[]): CodeLine[] {
  const lines: CodeLine[] = [[]];

  const push = (text: string, className: string | undefined) => {
    const parts = text.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1]!;
      const last = line[line.length - 1];
      if (last && last.className === className) last.text += part;
      else line.push(className ? { text: part, className } : { text: part });
    });
  };

  const walk = (children: readonly HastNode[], className: string | undefined) => {
    for (const node of children) {
      if (node.type === 'text') push(node.value ?? '', className);
      else if (node.children) walk(node.children, classOf(node) ?? className);
    }
  };

  walk(nodes, undefined);
  return lines;
}

const plainLines = (lines: readonly string[]): CodeLine[] => lines.map((line) => (line ? [{ text: line }] : []));

const WORD = `${SYNTAX_PREFIX}string`;
const SCALARS = new Set([`${SYNTAX_PREFIX}literal`, `${SYNTAX_PREFIX}number`]);
const isBlank = (token: CodeToken | undefined) => token !== undefined && !token.className && token.text.trim() === '';

/**
 * O YAML do highlight.js colore cada palavra de um texto sem aspas, e pinta
 * `no`, `yes`, `true` e números até no meio de uma frase ("commit no
 * padrão"). Um literal cercado de palavras vira palavra, e as palavras de uma
 * frase viram um pedaço só.
 */
function tidyYaml(lines: readonly CodeLine[]): CodeLine[] {
  return lines.map((line) => {
    const beside = (at: number, step: 1 | -1) => {
      let index = at + step;
      while (isBlank(line[index])) index += step;
      return line[index]?.className;
    };
    const tokens = line.map((token, at) =>
      token.className && SCALARS.has(token.className) && (beside(at, -1) === WORD || beside(at, 1) === WORD)
        ? { text: token.text, className: WORD }
        : token,
    );

    const merged: CodeLine = [];
    tokens.forEach((token, at) => {
      const last = merged[merged.length - 1];
      const joins = token.className === WORD || (isBlank(token) && tokens[at + 1]?.className === WORD);
      if (last?.className === WORD && joins) last.text += token.text;
      else merged.push({ ...token });
    });
    return merged;
  });
}

function highlight(language: string, text: string): CodeLine[] {
  const root = lowlight().highlight(language, text, { prefix: SYNTAX_PREFIX }) as unknown as HastNode;
  const lines = flatten(root.children ?? []);
  return language === 'yaml' ? tidyYaml(lines) : lines;
}

/**
 * A gramática de markdown não conhece o frontmatter — e todo SKILL.md tem um.
 * As linhas entre os dois `---` saem como YAML; o resto, como markdown.
 */
function highlightMarkdown(lines: readonly string[]): CodeLine[] {
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (close === -1) return highlight('markdown', lines.join('\n'));
  const head = highlight('yaml', lines.slice(0, close + 1).join('\n'));
  const body = lines.slice(close + 1);
  return body.length === 0 ? head : [...head, ...highlight('markdown', body.join('\n'))];
}

/**
 * O conteúdo em linhas prontas para desenhar. A quebra do fim não vira uma
 * linha vazia a mais, e CRLF vira LF. Um trecho grande demais, ou uma
 * gramática que falhe, sai em texto puro.
 */
export function toCodeLines(
  content: string,
  language: string | null,
  { maxLines = VIEW_MAX_LINES, maxChars = HIGHLIGHT_MAX_CHARS }: { maxLines?: number; maxChars?: number } = {},
): CodeLines {
  const normalized = content.replace(/\r\n?/g, '\n');
  const all = (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n');
  const shown = all.length > maxLines ? all.slice(0, maxLines) : all;
  const base = { total: all.length, language };

  if (language) {
    // O tamanho do trecho juntado com `\n`, sem montar a string.
    const size = shown.reduce((sum, line) => sum + line.length + 1, -1);
    if (size <= maxChars) {
      try {
        const lines = language === 'markdown' ? highlightMarkdown(shown) : highlight(language, shown.join('\n'));
        return { ...base, lines, colored: true };
      } catch {
        // Gramática desconhecida ou que quebrou: o arquivo continua legível.
      }
    }
  }
  return { ...base, lines: plainLines(shown), colored: false };
}
