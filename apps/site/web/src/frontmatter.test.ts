import { describe, expect, it } from 'vitest';
import * as shared from '@purple-skills/shared';
import { buildFrontmatter, composeSkillMd, parseTags, stripFrontmatter } from './frontmatter.js';

/**
 * `frontmatter.ts` do navegador espelha `packages/shared/src/frontmatter.ts`,
 * que é Node e não entra no bundle. A guia "SKILL.md" da visualização mostra o
 * arquivo montado por esse espelho, e o download materializa o mesmo arquivo
 * pelo pacote — se os dois divergirem, o usuário copia uma coisa e baixa
 * outra. Estes testes existem para que a divergência apareça aqui primeiro.
 *
 * O arquivo de `apps/admin/web/src` é cópia idêntica deste espelho.
 */

const CASOS: { titulo: string; meta: shared.SkillMeta; corpo: string }[] = [
  {
    titulo: 'metadados completos',
    meta: {
      slug: 'gerador-de-relatorios',
      name: 'Gerador de relatórios',
      description: 'Monta relatórios a partir de planilhas.',
      tags: ['relatorio', 'sql'],
    },
    corpo: '# Gerador\n\nCorpo do prompt.\n',
  },
  {
    titulo: 'só o obrigatório',
    meta: { slug: 'minima', description: 'Faz uma coisa só.' },
    corpo: 'Corpo.\n',
  },
  {
    titulo: 'valores que o YAML leria como outra coisa',
    meta: {
      slug: 'ambigua',
      name: 'true',
      description: 'Usa: dois pontos, # cerquilha e - traço no começo',
      tags: ['123', '- lista'],
    },
    corpo: 'Corpo.\n',
  },
  {
    titulo: 'corpo vazio',
    meta: { slug: 'vazia', description: 'Sem corpo ainda.' },
    corpo: '',
  },
  {
    titulo: 'corpo que ainda traz frontmatter antigo',
    meta: { slug: 'antiga', description: 'Gravada antes da regra.' },
    corpo: '---\nname: outro-nome\n---\n\n# Corpo de verdade\n',
  },
  {
    titulo: 'descrição vazia',
    meta: { slug: 'sem-descricao', name: 'Sem descrição', tags: [] },
    corpo: 'Corpo.\n',
  },
  {
    titulo: 'corpo que abre com uma régua horizontal',
    meta: { slug: 'com-regua', description: 'Abre com um preâmbulo entre réguas.' },
    corpo: '---\n\n# Preâmbulo\n\nTexto\n\n---\n\nResto\n',
  },
];

describe('espelho do frontmatter no navegador', () => {
  it.each(CASOS)('monta o mesmo SKILL.md que o pacote — $titulo', ({ meta, corpo }) => {
    expect(composeSkillMd(meta, corpo)).toBe(shared.composeSkillMd(meta, corpo));
    expect(buildFrontmatter(meta)).toBe(shared.buildFrontmatter(meta));
  });

  it.each([
    '---\nname: x\n---\n# Corpo\n',
    '﻿---\nname: x\n---\n\n\n# Corpo\n',
    '# Sem frontmatter\n',
    '---\nname: x\n---   \r\nCorpo\r\n',
    // Régua horizontal não é frontmatter, e fechamento malformado não fecha.
    '---\n\n# Título\n\nTexto\n\n---\n\nRodapé\n',
    '---\nIntrodução do prompt.\nNota: leia tudo antes.\n---\nResto\n',
    '---\nhttps://example.com/docs\n---\nResto\n',
    '---\n- passo um\n- passo dois\n---\nResto\n',
    '---\nname: x\n---abc\n# Corpo\n',
    '---\nname: x\n----------\n# Corpo\n',
    '---\nname: x\n---abc\n# Corpo\n\n---\n\nFim\n',
    // Frontmatter de verdade, nas formas que o parser do pacote lê.
    '---\r\nname: x\r\ndescription: y\r\n---\r\n# Corpo\r\n',
    '---\nname: x\ndescription: >-\n  Texto em\n  duas linhas.\nmetadata:\n  tags:\n    - a\n---\ncorpo',
    '---\nname: x\ntags:\n- a\n- b\n---\ncorpo',
    '---\n# comentário\n  name: x\n  description: y\n---\ncorpo',
    '--- \nname: x\n---\ncorpo',
    '---\nname: x\n---',
    // Idempotência: linha em branco antes do bloco e blocos empilhados.
    '\n\n---\nname: x\n---\ncorpo',
    '---\nname: x\n---\n---\nname: y\n---\n\nB\n',
    '---\nname: x\n---\n---\nA\n---\nB\n',
    '',
  ])('remove o frontmatter como o pacote — %j', (fonte) => {
    expect(stripFrontmatter(fonte)).toBe(shared.stripFrontmatter(fonte));
  });

  // Os casos acima só comparam o espelho com o pacote; estes fixam o resultado,
  // para os dois não errarem juntos. É o navegador que corta primeiro: o Salvar
  // do painel manda o texto já sem o "frontmatter".
  it('não apaga o trecho entre duas réguas horizontais', () => {
    const prompt = '---\n\n# Título\n\nTexto\n\n---\n\nRodapé\n';
    expect(stripFrontmatter(prompt)).toBe(prompt);
    expect(composeSkillMd({ slug: 'x', description: 'Faz X' }, prompt)).toBe(
      `---\nname: x\ndescription: Faz X\n---\n\n${prompt}`,
    );
  });

  it('é idempotente: o passe do Salvar não tira nada além do que o de abrir já tirou', () => {
    for (const fonte of [
      '---\nname: x\n---\n---\nA\n---\nB\n',
      '---\nname: x\n---\n---\nname: y\n---\nB\n',
      '\n---\nname: x\n---\nB\n',
    ]) {
      const uma = stripFrontmatter(fonte);
      expect(stripFrontmatter(uma)).toBe(uma);
    }
    expect(stripFrontmatter('---\nname: x\n---\n---\nA\n---\nB\n')).toBe('---\nA\n---\nB\n');
  });
});

describe('parseTags', () => {
  it('separa por vírgula, apara e descarta o que ficou vazio', () => {
    expect(parseTags(' relatorio , , sql ,')).toEqual(['relatorio', 'sql']);
  });

  it('devolve lista vazia quando não há nada', () => {
    expect(parseTags('   ')).toEqual([]);
  });
});
