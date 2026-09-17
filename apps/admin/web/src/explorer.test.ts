import { describe, expect, it } from 'vitest';
import { buildTree, type DirNode, type TreeNode } from './fileTree.js';
import {
  addVirtualDirs,
  allDirs,
  checkNewName,
  dirsOf,
  fileCountIn,
  isInside,
  keepParent,
  lineCount,
  parentDir,
  uploadCollisions,
  withoutDir,
} from './explorer.js';

const file = (relativePath: string, sizeBytes = 1) => ({ relativePath, mimeType: 'text/plain', sizeBytes, isText: true });

const FILES = [
  file('SKILL.md'),
  file('Notas.md'),
  file('references/guia.md'),
  file('references/api/rotas.md'),
  file('scripts/run.sh'),
  file('dados'),
];

const names = (nodes: TreeNode[]) => nodes.map((node) => `${node.kind === 'dir' ? 'd' : 'f'}:${node.name}`);
const dir = (nodes: TreeNode[], name: string) => nodes.find((node): node is DirNode => node.kind === 'dir' && node.name === name)!;

describe('checkNewName', () => {
  const check = (input: string, kind: 'file' | 'dir' = 'file', parent = '', virtual: string[] = []) =>
    checkNewName(input, kind, parent, FILES, virtual);

  it('campo vazio não é erro nem caminho', () => {
    expect(check('   ')).toEqual({ ok: false, error: null });
  });

  it('monta o caminho a partir da pasta escolhida, aparando as pontas', () => {
    expect(check('  novo.md ', 'file', 'references')).toEqual({ ok: true, path: 'references/novo.md' });
    expect(check('assets', 'dir')).toEqual({ ok: true, path: 'assets' });
  });

  it('aceita um caminho com barras, que cria as pastas de uma vez', () => {
    expect(check('a/b/c.md', 'file', 'references')).toEqual({ ok: true, path: 'references/a/b/c.md' });
  });

  it('pasta aceita a barra final; arquivo não', () => {
    expect(check('assets/', 'dir')).toEqual({ ok: true, path: 'assets' });
    expect(check('assets/', 'file')).toMatchObject({ ok: false, error: expect.stringContaining('terminar em /') });
  });

  it.each([
    ['/raiz.md', 'relativo'],
    ['a//b.md', 'vazio'],
    ['../fora.md', '".."'],
    ['./aqui.md', '".."'],
    ['a\\b.md', 'Evite'],
    ['dois:pontos.md', 'Evite'],
    ['tab\there.md', 'Evite'],
    ['pasta /x.md', 'espaços'],
  ])('recusa %s', (input, trecho) => {
    expect(check(input)).toMatchObject({ ok: false, error: expect.stringContaining(trecho) });
  });

  it('recusa o SKILL.md da raiz em qualquer caixa, mas não o de uma subpasta', () => {
    expect(check('skill.MD')).toMatchObject({ ok: false, error: expect.stringContaining('SKILL.md') });
    expect(check('SKILL.md', 'dir')).toMatchObject({ ok: false });
    expect(check('SKILL.md', 'file', 'references')).toEqual({ ok: true, path: 'references/SKILL.md' });
  });

  it('recusa arquivo que já existe sem diferenciar caixa, e diz a grafia gravada', () => {
    expect(check('notas.MD')).toEqual({ ok: false, error: 'Já existe o arquivo Notas.md.' });
    expect(check('GUIA.md', 'file', 'references')).toEqual({ ok: false, error: 'Já existe o arquivo references/guia.md.' });
  });

  it('usa a grafia das pastas que já existem, em vez de criar uma irmã com outra caixa', () => {
    expect(check('References/novo.md')).toEqual({ ok: true, path: 'references/novo.md' });
    expect(check('novo.md', 'file', 'REFERENCES/Api')).toEqual({ ok: true, path: 'references/api/novo.md' });
    expect(check('x.md', 'file', 'rascunhos', ['Rascunhos'])).toEqual({ ok: true, path: 'Rascunhos/x.md' });
    expect(check('SCRIPTS/novos', 'dir')).toEqual({ ok: true, path: 'scripts/novos' });
  });

  it('recusa pasta que já existe, inclusive como arquivo com o mesmo nome', () => {
    expect(check('References', 'dir')).toEqual({ ok: false, error: 'Já existe a pasta references.' });
    expect(check('references', 'file')).toMatchObject({ ok: false, error: expect.stringContaining('pasta') });
    expect(check('dados', 'dir')).toEqual({ ok: false, error: 'Já existe o arquivo dados.' });
  });

  it('recusa caminho que atravessa um arquivo', () => {
    expect(check('dados/x.csv')).toEqual({ ok: false, error: 'dados é um arquivo, não uma pasta.' });
    expect(check('skill.md/x.md')).toMatchObject({ ok: false, error: expect.stringContaining('não uma pasta') });
  });

  it('conta as pastas novas da página', () => {
    expect(check('Rascunhos', 'dir', '', ['rascunhos'])).toMatchObject({ ok: false });
    expect(check('rascunhos', 'file', '', ['rascunhos'])).toMatchObject({ ok: false });
    expect(check('nota.md', 'file', 'rascunhos', ['rascunhos'])).toEqual({ ok: true, path: 'rascunhos/nota.md' });
  });

  it('respeita o teto de 512 caracteres do servidor', () => {
    expect(check(`${'a'.repeat(510)}.md`)).toMatchObject({ ok: false, error: expect.stringContaining('512') });
    expect(check(`${'a'.repeat(509)}.md`)).toMatchObject({ ok: true });
  });
});

describe('addVirtualDirs', () => {
  it('põe a pasta nova entre as pastas, em ordem, depois do SKILL.md', () => {
    const tree = addVirtualDirs(buildTree(FILES), ['assets', 'zeta']);
    expect(names(tree)).toEqual(['f:SKILL.md', 'd:assets', 'd:references', 'd:scripts', 'd:zeta', 'f:dados', 'f:Notas.md']);
  });

  it('cria as pastas intermediárias e reaproveita a existente com outra caixa', () => {
    const tree = addVirtualDirs(buildTree(FILES), ['REFERENCES/novos/fundo']);
    const references = dir(tree, 'references');
    expect(names(references.children)).toEqual(['d:api', 'd:novos', 'f:guia.md']);
    const fundo = dir(dir(references.children, 'novos').children, 'fundo');
    expect(fundo.path).toBe('references/novos/fundo');
    expect(fileCountIn(fundo)).toBe(0);
    expect(fileCountIn(references)).toBe(2);
  });

  it('não muda nada sem pastas novas', () => {
    expect(names(addVirtualDirs(buildTree(FILES), []))).toEqual(names(buildTree(FILES)));
  });

  it('lista todas as pastas na ordem da árvore', () => {
    expect(allDirs(addVirtualDirs(buildTree(FILES), ['assets']))).toEqual(['assets', 'references', 'references/api', 'scripts']);
  });
});

describe('caminhos', () => {
  it('parentDir e isInside', () => {
    expect(parentDir('a/b/c.md')).toBe('a/b');
    expect(parentDir('c.md')).toBe('');
    expect(isInside('References/x.md', 'references')).toBe(true);
    expect(isInside('references-2/x.md', 'references')).toBe(false);
    expect(isInside('qualquer', '')).toBe(true);
  });

  it('dirsOf devolve as pastas em minúsculas', () => {
    expect([...dirsOf(FILES)].sort()).toEqual(['references', 'references/api', 'scripts']);
  });

  it('withoutDir tira a pasta e as de dentro', () => {
    expect([...withoutDir(new Set(['a', 'a/b', 'ab', 'c']), 'A')]).toEqual(['ab', 'c']);
  });

  it('keepParent segura a pasta que ficou vazia, e só ela', () => {
    const semRun = FILES.filter((f) => f.relativePath !== 'scripts/run.sh');
    expect([...keepParent(new Set(), 'scripts/run.sh', semRun)]).toEqual(['scripts']);
    const semGuia = FILES.filter((f) => f.relativePath !== 'references/guia.md');
    const intacto = new Set<string>();
    expect(keepParent(intacto, 'references/guia.md', semGuia)).toBe(intacto);
    expect(keepParent(intacto, 'Notas.md', FILES)).toBe(intacto);
  });

  it('uploadCollisions acha o que o envio sobrescreve, com a grafia gravada', () => {
    expect(uploadCollisions('', ['notas.md', 'skill.md', 'novo.md'], FILES)).toEqual(['Notas.md', 'SKILL.md']);
    expect(uploadCollisions('references', ['GUIA.md'], FILES)).toEqual(['references/guia.md']);
    expect(uploadCollisions('references', ['skill.md'], FILES)).toEqual([]);
  });

  it('lineCount conta as quebras', () => {
    expect(lineCount('')).toBe(1);
    expect(lineCount('a\nb')).toBe(2);
    expect(lineCount('a\n')).toBe(2);
  });
});
