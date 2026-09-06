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
    '',
  ])('remove o frontmatter como o pacote — %j', (fonte) => {
    expect(stripFrontmatter(fonte)).toBe(shared.stripFrontmatter(fonte));
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
