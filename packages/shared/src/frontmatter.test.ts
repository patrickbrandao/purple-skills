import { describe, expect, it } from 'vitest';
import { parseFrontmatter, skillMetaFromMarkdown } from './frontmatter.js';

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

  it('devolve o texto inteiro quando não há frontmatter', () => {
    const source = '# Sem frontmatter\n';
    expect(parseFrontmatter(source)).toEqual({ data: {}, body: source });
  });
});

describe('skillMetaFromMarkdown', () => {
  it('prefere os campos do frontmatter', () => {
    const meta = skillMetaFromMarkdown('---\nname: A\ndescription: B\n---\n# Outro\n\nParágrafo.');
    expect(meta).toEqual({ name: 'A', description: 'B' });
  });

  it('cai para o primeiro heading e o primeiro parágrafo', () => {
    const meta = skillMetaFromMarkdown('# Título da Skill\n\nEla faz coisas\nem várias linhas.\n\nOutro parágrafo.');
    expect(meta.name).toBe('Título da Skill');
    expect(meta.description).toBe('Ela faz coisas em várias linhas.');
  });

  it('devolve null quando não há nada aproveitável', () => {
    expect(skillMetaFromMarkdown('')).toEqual({ name: null, description: null });
  });
});
