import { describe, expect, it } from 'vitest';
import { sepOverflow } from './SkillFiles.js';

/**
 * Os tetos que a extensão de skills do MCP (SEP-2640) fixa por skill — 512
 * arquivos e 16 MiB somados — não são teto deste servidor: a skill que estoura
 * continua sendo servida inteira, e o painel só avisa, na guia Arquivos, que
 * um cliente conformante pode recusá-la (`docs/17-skills-extension.md` §5.5 e
 * §11.2). Quem decide o que o aviso diz é este cálculo.
 */

const MiB = 1024 * 1024;

/** Uma árvore com `count` arquivos, `bytes` no total (o resto vai no primeiro). */
const tree = (count: number, bytes = count) =>
  Array.from({ length: count }, (_, i) => ({
    relativePath: i === 0 ? 'SKILL.md' : `references/${i}.md`,
    mimeType: 'text/markdown',
    sizeBytes: i === 0 ? bytes - (count - 1) : 1,
    isText: true,
  }));

describe('sepOverflow', () => {
  it('a skill que cabe nos dois tetos não tem o que avisar', () => {
    expect(sepOverflow([])).toBeNull();
    expect(sepOverflow(tree(12, 4 * MiB))).toBeNull();
  });

  // O teto é "acima de", não "a partir de": a skill que bate no número exato
  // ainda está dentro do que a SEP manda o host aguentar.
  it('a fronteira exata — 512 arquivos, 16 MiB — está dentro', () => {
    expect(sepOverflow(tree(512, 16 * MiB))).toBeNull();
  });

  it('só a contagem estourada conta os arquivos a mais, e o tamanho fica em zero', () => {
    expect(sepOverflow(tree(530, 4 * MiB))).toEqual({ fileCount: 530, extraFiles: 18, totalBytes: 4 * MiB, extraBytes: 0 });
  });

  it('só o tamanho estourado conta os bytes a mais, e a contagem fica em zero', () => {
    const over = sepOverflow(tree(9, 18 * MiB));
    expect(over).toEqual({ fileCount: 9, extraFiles: 0, totalBytes: 18 * MiB, extraBytes: 2 * MiB });
  });

  // É o caso em que o aviso cita os dois tetos.
  it('os dois estourados vêm juntos', () => {
    expect(sepOverflow(tree(600, 20 * MiB))).toEqual({
      fileCount: 600,
      extraFiles: 88,
      totalBytes: 20 * MiB,
      extraBytes: 4 * MiB,
    });
  });

  // Um byte passado já é estouro — a medida é aproximada por baixo (o
  // `sizeBytes` do SKILL.md não inclui o frontmatter), então arredondar aqui
  // esconderia estouro de verdade.
  it('um único byte acima do teto de tamanho já avisa', () => {
    expect(sepOverflow(tree(3, 16 * MiB + 1))?.extraBytes).toBe(1);
  });
});
