import { describe, expect, it } from 'vitest';
import { buildTree, type DirNode, type TreeNode } from './fileTree.js';
import type { SkillFileMeta } from './api.js';

const file = (relativePath: string, sizeBytes = 100): SkillFileMeta => ({
  relativePath,
  mimeType: 'text/plain',
  sizeBytes,
  isText: true,
});

/** Achata a árvore em `caminho` por nível, para comparar a ordem sem ruído. */
function names(nodes: TreeNode[]): string[] {
  return nodes.map((node) => (node.kind === 'dir' ? `${node.name}/` : node.name));
}

function dir(nodes: TreeNode[], name: string): DirNode {
  const found = nodes.find((node) => node.kind === 'dir' && node.name === name);
  if (!found || found.kind !== 'dir') throw new Error(`pasta ${name} não encontrada`);
  return found;
}

describe('buildTree', () => {
  it('põe o SKILL.md primeiro, depois as pastas e por fim os arquivos', () => {
    const tree = buildTree([
      file('referencias.md'),
      file('scripts/roda.py'),
      file('SKILL.md'),
      file('assets/logo.png'),
    ]);

    expect(names(tree)).toEqual(['SKILL.md', 'assets/', 'scripts/', 'referencias.md']);
  });

  it('aninha subpastas em qualquer profundidade', () => {
    const tree = buildTree([file('SKILL.md'), file('scripts/lib/util/parse.py', 42)]);

    const lib = dir(dir(dir(tree, 'scripts').children, 'lib').children, 'util');
    expect(lib.path).toBe('scripts/lib/util');
    expect(lib.children).toEqual([
      {
        kind: 'file',
        name: 'parse.py',
        path: 'scripts/lib/util/parse.py',
        sizeBytes: 42,
        isText: true,
      },
    ]);
  });

  it('reaproveita a mesma pasta para arquivos irmãos', () => {
    const tree = buildTree([
      file('SKILL.md'),
      file('scripts/b.py'),
      file('scripts/a.py'),
      file('scripts/nested/c.py'),
    ]);

    const scripts = dir(tree, 'scripts');
    expect(tree.filter((node) => node.kind === 'dir')).toHaveLength(1);
    expect(names(scripts.children)).toEqual(['nested/', 'a.py', 'b.py']);
  });

  it('ordena números como número, não como texto', () => {
    const tree = buildTree([file('SKILL.md'), file('p10.md'), file('p2.md'), file('p1.md')]);

    expect(names(tree)).toEqual(['SKILL.md', 'p1.md', 'p2.md', 'p10.md']);
  });

  it('inventa o SKILL.md quando ele não vem na lista de arquivos', () => {
    const tree = buildTree([file('scripts/roda.py')]);

    expect(tree[0]).toEqual({
      kind: 'file',
      name: 'SKILL.md',
      path: 'SKILL.md',
      sizeBytes: null,
      isText: true,
    });
  });

  it('não duplica o SKILL.md quando ele vem com outra caixa', () => {
    const tree = buildTree([file('skill.md')]);

    expect(names(tree)).toEqual(['skill.md']);
  });

  it('ignora caminhos vazios e segmentos "." ', () => {
    const tree = buildTree([file('SKILL.md'), file(''), file('./scripts/roda.py')]);

    expect(names(tree)).toEqual(['SKILL.md', 'scripts/']);
    expect(dir(tree, 'scripts').children[0]).toMatchObject({ path: 'scripts/roda.py' });
  });
});
