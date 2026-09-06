import { describe, expect, it } from 'vitest';
import {
  buildFrontmatter,
  composeSkillMd,
  parseFrontmatter,
  skillMetaFromMarkdown,
  stripFrontmatter,
} from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('extrai pares chave: valor e devolve o corpo', () => {
    const { data, body } = parseFrontmatter('---\nname: Minha Skill\ndescription: Faz X\n---\n# Título\n');
    expect(data).toEqual({ name: 'Minha Skill', description: 'Faz X' });
    expect(body).toBe('# Título\n');
  });

  it('remove aspas dos valores', () => {
    const { data } = parseFrontmatter('---\nname: "Com: dois pontos"\n---\ncorpo');
    expect(data.name).toBe('Com: dois pontos');
  });

  it('lê as chaves indentadas do bloco metadata', () => {
    const { data } = parseFrontmatter(
      '---\nname: minha-skill\nmetadata:\n  title: Minha Skill\n  tags: git, ci\n---\ncorpo',
    );
    expect(data.title).toBe('Minha Skill');
    expect(data.tags).toBe('git, ci');
  });

  it('devolve o texto inteiro quando não há frontmatter', () => {
    const source = '# Sem frontmatter\n';
    expect(parseFrontmatter(source)).toEqual({ data: {}, body: source });
  });
});

describe('stripFrontmatter', () => {
  it('remove o bloco de metadados e o espaço em branco à frente', () => {
    expect(stripFrontmatter('---\nname: x\n---\n\n# Corpo\n')).toBe('# Corpo\n');
  });

  it('não mexe em texto sem frontmatter', () => {
    expect(stripFrontmatter('# Corpo\n\nParágrafo.')).toBe('# Corpo\n\nParágrafo.');
  });

  it('é idempotente — o segundo bloco `---` do corpo fica', () => {
    const uma = stripFrontmatter('---\nname: x\n---\n# Corpo\n');
    expect(stripFrontmatter(uma)).toBe(uma);
  });

  it('remove o BOM antes de procurar o bloco', () => {
    expect(stripFrontmatter('﻿---\nname: x\n---\n# Corpo\n')).toBe('# Corpo\n');
  });
});

describe('buildFrontmatter', () => {
  it('usa o slug como nome oficial e joga título e tags em metadata', () => {
    expect(
      buildFrontmatter({
        slug: 'commit-conventional',
        name: 'Conventional Commits',
        description: 'Escreve mensagens de commit.',
        tags: ['git', 'workflow'],
      }),
    ).toBe(
      '---\n' +
        'name: commit-conventional\n' +
        'description: Escreve mensagens de commit.\n' +
        'metadata:\n' +
        '  title: Conventional Commits\n' +
        '  tags: git, workflow\n' +
        '---\n',
    );
  });

  it('cita valores que o YAML leria como outra coisa', () => {
    const yaml = buildFrontmatter({ slug: 'x', name: '', description: 'Faz X: e Y' });
    expect(yaml).toContain('description: "Faz X: e Y"');
  });

  it('escapa aspas e barras invertidas', () => {
    const yaml = buildFrontmatter({ slug: 'x', description: 'Diz "olá": \\ fim' });
    expect(yaml).toContain('description: "Diz \\"olá\\": \\\\ fim"');
    expect(parseFrontmatter(yaml).data.description).toBe('Diz "olá": \\ fim');
  });

  it('achata quebras de linha da descrição', () => {
    const yaml = buildFrontmatter({ slug: 'x', description: 'linha um\nlinha dois' });
    expect(yaml).toContain('description: linha um linha dois');
  });

  it('omite o bloco metadata quando não há título nem tags', () => {
    expect(buildFrontmatter({ slug: 'x', description: 'Faz X' })).toBe(
      '---\nname: x\ndescription: Faz X\n---\n',
    );
  });

  it('mantém a descrição vazia como escalar citado', () => {
    expect(buildFrontmatter({ slug: 'x' })).toContain('description: ""');
  });
});

describe('composeSkillMd', () => {
  const meta = { slug: 'minha-skill', name: 'Minha Skill', description: 'Faz X' };

  it('põe os metadados nas primeiras linhas, antes do corpo', () => {
    expect(composeSkillMd(meta, '# Título\n')).toBe(
      '---\nname: minha-skill\ndescription: Faz X\nmetadata:\n  title: Minha Skill\n---\n\n# Título\n',
    );
  });

  it('descarta o frontmatter que vier no corpo — o formulário é a fonte da verdade', () => {
    const composto = composeSkillMd(meta, '---\nname: outra-coisa\ndescription: mentira\n---\n# Título\n');
    expect(composto).not.toContain('outra-coisa');
    expect(composto).not.toContain('mentira');
    expect(composto).toContain('name: minha-skill');
  });

  it('é idempotente: recompor o resultado devolve o mesmo documento', () => {
    const uma = composeSkillMd(meta, '# Título\n');
    expect(composeSkillMd(meta, uma)).toBe(uma);
  });

  it('devolve só o frontmatter quando o corpo está vazio', () => {
    expect(composeSkillMd(meta, '   \n')).toBe(
      '---\nname: minha-skill\ndescription: Faz X\nmetadata:\n  title: Minha Skill\n---\n',
    );
  });
});

describe('skillMetaFromMarkdown', () => {
  it('prefere os campos do frontmatter', () => {
    const meta = skillMetaFromMarkdown('---\nname: A\ndescription: B\n---\n# Outro\n\nParágrafo.');
    expect(meta.name).toBe('A');
    expect(meta.description).toBe('B');
  });

  it('trata um `name` em forma de slug como slug e busca o título em metadata', () => {
    const meta = skillMetaFromMarkdown(
      '---\nname: minha-skill\ndescription: Faz X\nmetadata:\n  title: Minha Skill\n  tags: git, ci\n---\n# Outro\n',
    );
    expect(meta).toEqual({
      name: 'Minha Skill',
      description: 'Faz X',
      slug: 'minha-skill',
      tags: ['git', 'ci'],
    });
  });

  it('sem título em metadata, o nome legível vem do primeiro heading', () => {
    const meta = skillMetaFromMarkdown('---\nname: minha-skill\n---\n# Minha Skill\n\nFaz X.');
    expect(meta.name).toBe('Minha Skill');
    expect(meta.slug).toBe('minha-skill');
  });

  it('cai para o primeiro heading e o primeiro parágrafo', () => {
    const meta = skillMetaFromMarkdown('# Título da Skill\n\nEla faz coisas\nem várias linhas.\n\nOutro parágrafo.');
    expect(meta.name).toBe('Título da Skill');
    expect(meta.description).toBe('Ela faz coisas em várias linhas.');
    expect(meta.slug).toBeNull();
  });

  it('devolve null quando não há nada aproveitável', () => {
    expect(skillMetaFromMarkdown('')).toEqual({
      name: null,
      description: null,
      slug: null,
      tags: [],
    });
  });

  it('faz round-trip com buildFrontmatter', () => {
    const original = {
      slug: 'minha-skill',
      name: 'Minha Skill',
      description: 'Faz X, Y e Z.',
      tags: ['git', 'ci'],
    };
    const meta = skillMetaFromMarkdown(composeSkillMd(original, '# Corpo\n'));
    expect(meta).toEqual({
      name: original.name,
      description: original.description,
      slug: original.slug,
      tags: original.tags,
    });
  });
});
