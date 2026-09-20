import { isUtf8 } from 'node:buffer';

export const SKILL_MD = 'SKILL.md';

/**
 * Normaliza um caminho relativo vindo de upload/MCP:
 * - troca `\` por `/`
 * - remove `./`, barras duplicadas e barras nas pontas
 * - rejeita travessia de diretório (`..`), caminhos absolutos e vazios
 * - canoniza o arquivo principal para `SKILL.md`
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

  // O arquivo principal tem uma grafia só. Sem isso, `skill.md` gravado numa
  // skill que já tem `SKILL.md` vira uma segunda linha "principal": a escrita
  // diferencia a caixa e a leitura não, então o conteúdo exibido, indexado e
  // empacotado passa a ser escolhido sem critério entre as duas.
  if (isSkillMd(cleaned)) return SKILL_MD;

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
  // Mais código e configuração: fora da tabela, o arquivo seria gravado como
  // binário e não abriria no leitor nem no editor do painel.
  //
  // ATENÇÃO — texto × binário é decidido na **gravação** e fica na linha de
  // `files`; a leitura usa o que está gravado e nunca reavalia. Acrescentar
  // extensão textual aqui só vale para envios NOVOS: o mesmo arquivo enviado
  // antes continua binário (não abre no leitor, o MCP responde "é binário", o
  // RAG não o vê) até uma migration de conversão passar por ele — peça ao dba,
  // na mesma mudança (`tasks/018`: o bloco abaixo saiu na beta.22 sem ela). E,
  // com o RAG ligado, todo tipo textual novo que não seja imagem passa a ser
  // enviado ao provedor de embeddings (`packages/rag/src/chunk.ts`).
  php: 'text/x-php',
  phtml: 'text/x-php',
  mts: 'text/x-typescript',
  cts: 'text/x-typescript',
  pyw: 'text/x-python',
  kt: 'text/x-kotlin',
  kts: 'text/x-kotlin',
  swift: 'text/x-swift',
  cs: 'text/x-csharp',
  cc: 'text/x-c++',
  cxx: 'text/x-c++',
  hpp: 'text/x-c++',
  hh: 'text/x-c++',
  scala: 'text/x-scala',
  dart: 'text/x-dart',
  ex: 'text/x-elixir',
  exs: 'text/x-elixir',
  hs: 'text/x-haskell',
  lua: 'text/x-lua',
  pl: 'text/x-perl',
  pm: 'text/x-perl',
  r: 'text/x-r',
  groovy: 'text/x-groovy',
  gradle: 'text/x-groovy',
  zsh: 'text/x-shellscript',
  ksh: 'text/x-shellscript',
  fish: 'text/x-shellscript',
  ps1: 'text/x-powershell',
  psm1: 'text/x-powershell',
  psd1: 'text/x-powershell',
  bat: 'text/x-msdos-batch',
  cmd: 'text/x-msdos-batch',
  scss: 'text/x-scss',
  sass: 'text/x-sass',
  less: 'text/x-less',
  vue: 'text/x-vue',
  svelte: 'text/x-svelte',
  graphql: 'text/x-graphql',
  gql: 'text/x-graphql',
  proto: 'text/x-protobuf',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  tex: 'text/x-tex',
  rst: 'text/x-rst',
  adoc: 'text/asciidoc',
  mdx: 'text/markdown',
  j2: 'text/x-jinja',
  jinja: 'text/x-jinja',
  jinja2: 'text/x-jinja',
  hbs: 'text/x-handlebars-template',
  mustache: 'text/x-handlebars-template',
  mk: 'text/x-makefile',
  cmake: 'text/x-cmake',
  json5: 'application/json',
  ipynb: 'application/json',
  jsonl: 'text/plain',
  ndjson: 'text/plain',
  ini: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  env: 'text/plain',
  properties: 'text/plain',
  tf: 'text/plain',
  hcl: 'text/plain',
  log: 'text/plain',
  text: 'text/plain',
  // `.env.example`, `config.yml.sample`, `mail.tpl`: sufixos de modelo de texto.
  example: 'text/plain',
  sample: 'text/plain',
  template: 'text/plain',
  tpl: 'text/plain',
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

/**
 * A régua de "estes bytes são texto": mime textual, nenhum byte nulo **e UTF-8
 * válido**. Só o que passa aqui pode ser decodificado com `toString('utf8')`.
 *
 * O mime sai do nome, e muito "arquivo de texto" do mundo real não é UTF-8 — o
 * `.csv` que o Excel exporta é Windows-1252. `toString('utf8')` não falha com
 * ele: troca cada byte inválido por U+FFFD, sem erro, e o original não volta
 * mais (`tasks/015`). Esse arquivo é guardado como binário, byte a byte, do
 * mesmo jeito que o que traz byte nulo. O BOM é UTF-8 válido e fica onde está.
 *
 * `isUtf8` só valida, sem alocar a string; um `TextDecoder` com `fatal` faria o
 * mesmo por exceção e, sem `ignoreBOM`, ainda comeria o BOM.
 */
export function isTextualContent(mimeType: string, data: Buffer): boolean {
  return isTextualMime(mimeType) && !data.includes(0) && isUtf8(data);
}

/**
 * Tipos que o navegador executa quando renderizados na origem do site.
 * Arquivos anexos a uma skill são conteúdo enviado por terceiros: servi-los
 * com esses `Content-Type` equivale a hospedar um script na própria origem.
 */
const EXECUTABLE_INLINE_MIME = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/xml',
  'text/xml',
]);

/**
 * A essência do tipo: sem parâmetros (`; charset=…`), sem espaços, em
 * minúsculas — é por ela que o navegador decide. Hoje o `mime_type` gravado sai
 * sempre de `mimeTypeFor` e já vem assim; a régua de segurança não depende disso.
 */
function mimeEssence(mimeType: string): string {
  return mimeType.split(';', 1)[0].trim().toLowerCase();
}

export function isExecutableInlineMime(mimeType: string): boolean {
  return EXECUTABLE_INLINE_MIME.has(mimeEssence(mimeType));
}

/**
 * Tipos que o navegador executa quando carregados como **sub-recurso** por uma
 * página da própria origem (`<script src>`, `<link rel="stylesheet">`). Nada do
 * que a resposta do arquivo manda vale nesse caso — nem a CSP com `sandbox`, nem
 * o `Content-Disposition`: quem decide é a CSP da página que carrega, e
 * `script-src 'self'` (`headers.ts`) aceita qualquer endereço da origem,
 * inclusive o de um `.js` anexado a uma skill (`tasks/014`). Como `text/plain`,
 * o `nosniff` que os três serviços já mandam faz o navegador recusá-los.
 *
 * Os de script são os "JavaScript MIME types" do padrão MIME Sniffing, que é a
 * lista que o `nosniff` deixa rodar; a tabela acima só produz `text/javascript`,
 * e os outros estão aqui para a régua não depender dela.
 */
const EXECUTABLE_SUBRESOURCE_MIME = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
  'text/css',
]);

/**
 * `Content-Type` seguro para entregar um arquivo de skill: tipos executáveis —
 * como documento ou como sub-recurso — viram `text/plain`, o resto é preservado.
 */
export function safeContentType(mimeType: string, isText: boolean): string {
  if (isExecutableInlineMime(mimeType) || EXECUTABLE_SUBRESOURCE_MIME.has(mimeEssence(mimeType))) {
    return 'text/plain; charset=utf-8';
  }
  return isText ? `${mimeType}; charset=utf-8` : mimeType;
}

/**
 * Monta um `Content-Disposition` com o nome saneado. Aspas e caracteres fora
 * do ASCII imprimível quebrariam o header; o `filename*` (RFC 5987) carrega o
 * nome original para os navegadores que o entendem.
 */
export function contentDisposition(relativePath: string, type: 'attachment' | 'inline'): string {
  const raw = relativePath.split('/').pop() || 'arquivo';
  const ascii = raw.replace(/[^\w.\-]+/g, '_') || 'arquivo';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}
