import type { SkillFileMeta } from './api.js';

/* ============================================================
   ÁRVORE DE ARQUIVOS DA SKILL
   A API entrega uma lista plana de caminhos relativos; aqui ela
   vira a mesma árvore que o usuário vê ao descompactar o .zip.
   ============================================================ */

export type FileNode = {
  kind: 'file';
  name: string;
  /** Caminho relativo dentro da skill, como a API o expõe. */
  path: string;
  sizeBytes: number | null;
};

export type DirNode = {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
};

export type TreeNode = FileNode | DirNode;

export const SKILL_MD = 'skill.md';

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** O SKILL.md vem primeiro, depois as pastas e por fim os arquivos, em ordem alfabética. */
function compareNodes(a: TreeNode, b: TreeNode): number {
  const aRoot = a.kind === 'file' && a.name.toLowerCase() === SKILL_MD;
  const bRoot = b.kind === 'file' && b.name.toLowerCase() === SKILL_MD;
  if (aRoot !== bRoot) return aRoot ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  return collator.compare(a.name, b.name);
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  nodes.sort(compareNodes);
  for (const node of nodes) {
    if (node.kind === 'dir') sortTree(node.children);
  }
  return nodes;
}

/** Monta a árvore a partir dos caminhos relativos devolvidos pela API. */
export function buildTree(files: SkillFileMeta[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirs = new Map<string, DirNode>();

  const ensureDir = (path: string): DirNode => {
    const existing = dirs.get(path);
    if (existing) return existing;

    const slash = path.lastIndexOf('/');
    const dir: DirNode = {
      kind: 'dir',
      name: slash === -1 ? path : path.slice(slash + 1),
      path,
      children: [],
    };
    dirs.set(path, dir);
    (slash === -1 ? root : ensureDir(path.slice(0, slash)).children).push(dir);
    return dir;
  };

  for (const file of files) {
    const parts = file.relativePath.split('/').filter((part) => part && part !== '.');
    if (parts.length === 0) continue;

    const name = parts[parts.length - 1]!;
    const parent = parts.length === 1 ? root : ensureDir(parts.slice(0, -1).join('/')).children;
    parent.push({ kind: 'file', name, path: parts.join('/'), sizeBytes: file.sizeBytes });
  }

  // Toda skill tem um SKILL.md, mesmo quando ele não aparece na lista de arquivos.
  const hasSkillMd = root.some(
    (node) => node.kind === 'file' && node.name.toLowerCase() === SKILL_MD,
  );
  if (!hasSkillMd) {
    root.push({ kind: 'file', name: 'SKILL.md', path: 'SKILL.md', sizeBytes: null });
  }

  return sortTree(root);
}
