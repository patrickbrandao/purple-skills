import { SKILL_MD, type DirNode, type TreeNode } from './fileTree.js';

/* ============================================================
   EXPLORADOR DA GUIA ARQUIVOS
   As regras puras do editor de arquivos: caminhos, pastas novas
   e a validação do nome digitado na árvore.

   O banco só guarda arquivos — uma pasta existe porque há um
   arquivo dentro dela. A pasta criada no painel fica na página
   até receber o primeiro arquivo; se a página fechar antes,
   ela some, e o pacote nunca a teria levado vazia.

   `fileTree.ts` é cópia idêntica do site e fica intocado: o que
   só o editor precisa mora aqui.
   ============================================================ */

type HasPath = { relativePath: string };

export type EntryKind = 'file' | 'dir';

/** Teto de caminho do servidor (`normalizeRelativePath`). */
export const MAX_PATH = 512;

const key = (path: string) => path.toLowerCase();

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** A pasta que contém `path`; `''` é a raiz da skill. */
export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** O nome depois da última barra. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function isSkillMdPath(path: string): boolean {
  return key(path) === SKILL_MD;
}

/** `dir` é a própria `path` ou uma pasta acima dela, sem diferenciar caixa. */
export function isInside(path: string, dir: string): boolean {
  if (!dir) return true;
  const p = key(path);
  const d = key(dir);
  return p === d || p.startsWith(`${d}/`);
}

/**
 * As pastas conhecidas — as dos arquivos e as novas da página —, em
 * minúsculas, apontando para a primeira grafia vista. O banco não diferencia
 * caixa: `References/x.md` vai para a pasta `references` que já existe.
 */
function knownDirs(files: readonly HasPath[], virtualDirs: Iterable<string> = []): Map<string, string> {
  const dirs = new Map<string, string>();
  const add = (dir: string) => {
    let real = '';
    for (const segment of dir.split('/').filter(Boolean)) {
      const candidate = joinPath(real, segment);
      const known = dirs.get(key(candidate));
      if (known === undefined) dirs.set(key(candidate), candidate);
      real = known ?? candidate;
    }
  };
  for (const file of files) add(parentDir(file.relativePath));
  for (const dir of virtualDirs) add(dir);
  return dirs;
}

/** O caminho com cada pasta na grafia que ela já tem. */
function canonical(path: string, dirs: ReadonlyMap<string, string>): string {
  let real = '';
  for (const segment of path.split('/')) {
    const candidate = joinPath(real, segment);
    real = dirs.get(key(candidate)) ?? candidate;
  }
  return real;
}

/** As pastas que os arquivos definem, em minúsculas. */
export function dirsOf(files: readonly HasPath[]): Set<string> {
  return new Set(knownDirs(files).keys());
}

/**
 * Os caminhos de arquivo em minúsculas, apontando para a grafia gravada. O
 * `SKILL.md` está sempre: toda skill tem um, mesmo sem linha na tabela.
 */
function fileKeys(files: readonly HasPath[]): Map<string, string> {
  const keys = new Map(files.map((file) => [key(file.relativePath), file.relativePath]));
  if (!keys.has(SKILL_MD)) keys.set(SKILL_MD, 'SKILL.md');
  return keys;
}

// Quebram a descompactação em algum sistema, além dos caracteres de controle.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\\:*?"<>|\x00-\x1f\x7f]/;

/** `error: null` é o campo ainda vazio: nada a reclamar e nada a criar. */
export type NameCheck = { ok: true; path: string } | { ok: false; error: string | null };

/**
 * Confere o nome digitado para um arquivo ou uma pasta nova dentro de
 * `parent` e devolve o caminho completo. Um nome com `/` cria as pastas do
 * caminho de uma vez; a comparação com o que existe ignora a caixa, porque é
 * assim que o banco decide o que é o mesmo arquivo.
 */
export function checkNewName(
  input: string,
  kind: EntryKind,
  parent: string,
  files: readonly HasPath[],
  virtualDirs: Iterable<string> = [],
): NameCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: null };
  if (FORBIDDEN.test(raw)) {
    return { ok: false, error: 'Evite \\ : * ? " < > | — o pacote é descompactado em qualquer sistema.' };
  }
  if (raw.startsWith('/')) return { ok: false, error: 'O caminho é relativo à pasta escolhida: tire a / do começo.' };

  // A barra final é hábito de quem cria pasta; num arquivo, é engano.
  const name = kind === 'dir' ? raw.replace(/\/+$/, '') : raw;
  if (name.endsWith('/')) return { ok: false, error: 'O nome do arquivo não pode terminar em /.' };

  const segments = name.split('/');
  if (segments.some((segment) => segment === '')) return { ok: false, error: 'Há um trecho vazio no caminho (//).' };
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return { ok: false, error: '"." e ".." não são nomes de arquivo nem de pasta.' };
  }
  if (segments.some((segment) => segment !== segment.trim())) {
    return { ok: false, error: 'Tire os espaços do começo e do fim de cada nome.' };
  }

  const dirs = knownDirs(files, virtualDirs);
  const path = canonical(joinPath(parent, name), dirs);
  if (path.length > MAX_PATH) return { ok: false, error: `Caminho longo demais: o limite é de ${MAX_PATH} caracteres.` };
  if (isSkillMdPath(path)) return { ok: false, error: 'Toda skill já tem o SKILL.md.' };

  const existing = fileKeys(files);
  if (existing.has(key(path))) return { ok: false, error: `Já existe o arquivo ${existing.get(key(path))}.` };

  for (let dir = parentDir(path); dir; dir = parentDir(dir)) {
    const file = existing.get(key(dir));
    if (file) return { ok: false, error: `${file} é um arquivo, não uma pasta.` };
  }

  if (dirs.has(key(path))) return { ok: false, error: `Já existe a pasta ${dirs.get(key(path))}.` };

  // Arquivo criado aqui nasce **vazio e de texto**: o que se digita na árvore
  // vira `content: ''` numa rota JSON. Com extensão de binário o servidor
  // recusa (ele decide texto × binário pelo nome), e antes desta guarda a
  // linha era gravada como binária — a árvore mostrava o arquivo e o editor
  // dizia "não abre no editor de texto", sem saída a não ser removê-lo.
  if (kind === 'file' && isBinaryName(path)) {
    return {
      ok: false,
      error: 'Aqui só entra arquivo de texto. Imagem e outros binários vêm pelo pacote .zip/.skill, na importação.',
    };
  }

  return { ok: true, path };
}

/**
 * As extensões que o servidor guarda como **binário** por natureza.
 *
 * É uma cópia curta e estável de `MIME_BY_EXTENSION` (`@purple-skills/shared`,
 * `paths.ts`) — só o lado binário, que são 17 formatos de imagem, fonte,
 * arquivo compactado e mídia. Este bundle não importa o pacote, e copiar as
 * **102** extensões textuais seria uma lista que apodrece a cada formato novo.
 *
 * A regra que vale é a do servidor (`isTextualMime`), e ela é mais estreita
 * que esta: extensão desconhecida também é recusada lá. Aqui só está o caso
 * comum, para o erro aparecer enquanto se digita em vez de depois da ida e
 * volta; o resto chega como mensagem da rota.
 */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'pdf',
  'zip', 'gz', 'tar', 'woff', 'woff2', 'ttf', 'mp3', 'mp4', 'wasm',
]);

function isBinaryName(path: string): boolean {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** Insere a pasta na posição da ordem da árvore: SKILL.md, pastas, arquivos. */
function insertDir(children: TreeNode[], dir: DirNode) {
  const at = children.findIndex((node) =>
    node.kind === 'file' ? node.name.toLowerCase() !== SKILL_MD : collator.compare(node.name, dir.name) > 0,
  );
  children.splice(at === -1 ? children.length : at, 0, dir);
}

/**
 * Acrescenta à árvore as pastas criadas na página que ainda não têm arquivo.
 * **Altera** a árvore recebida: passe uma recém-montada por `buildTree`. Uma
 * pasta que já existe com outra caixa é reaproveitada, com a grafia gravada.
 */
export function addVirtualDirs(tree: TreeNode[], virtualDirs: Iterable<string>): TreeNode[] {
  for (const path of virtualDirs) {
    let children = tree;
    let current = '';
    for (const name of path.split('/').filter(Boolean)) {
      let dir = children.find((node): node is DirNode => node.kind === 'dir' && key(node.name) === key(name));
      if (!dir) {
        dir = { kind: 'dir', name, path: joinPath(current, name), children: [] };
        insertDir(children, dir);
      }
      current = dir.path;
      children = dir.children;
    }
  }
  return tree;
}

/** Quantos arquivos há na pasta, em qualquer nível. */
export function fileCountIn(dir: DirNode): number {
  return dir.children.reduce((sum, node) => sum + (node.kind === 'file' ? 1 : fileCountIn(node)), 0);
}

/** As pastas de `tree` e de todas as subpastas, na ordem da árvore. */
export function allDirs(tree: readonly TreeNode[]): string[] {
  return tree.flatMap((node) => (node.kind === 'dir' ? [node.path, ...allDirs(node.children)] : []));
}

/** Tira a pasta (e as de dentro dela) do conjunto das pastas novas. */
export function withoutDir(dirs: ReadonlySet<string>, path: string): Set<string> {
  return new Set([...dirs].filter((dir) => !isInside(dir, path)));
}

/**
 * Depois de remover `removed`, a pasta dele continua na árvore se ficou vazia:
 * quem apagou o último arquivo de uma pasta costuma querer pôr outro lá.
 * `files` é a lista já sem o arquivo.
 */
export function keepParent(dirs: ReadonlySet<string>, removed: string, files: readonly HasPath[]): ReadonlySet<string> {
  const parent = parentDir(removed);
  if (!parent || dirsOf(files).has(key(parent))) return dirs;
  if ([...dirs].some((dir) => key(dir) === key(parent))) return dirs;
  return new Set([...dirs, parent]);
}

/**
 * Os arquivos que um envio para `dir` sobrescreve, com a grafia gravada. Um
 * `SKILL.md` na raiz sempre conta: ele existe em toda skill.
 */
export function uploadCollisions(dir: string, names: readonly string[], files: readonly HasPath[]): string[] {
  const existing = fileKeys(files);
  const hits = names
    .map((name) => existing.get(key(joinPath(dir, name))))
    .filter((path): path is string => path !== undefined);
  return [...new Set(hits)];
}

/** Quantas linhas o texto tem — o editor numera por aqui. */
export function lineCount(text: string): number {
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines += 1;
  return lines;
}
