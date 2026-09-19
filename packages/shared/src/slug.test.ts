import { describe, expect, it } from 'vitest';
import { isValidSlug, slugify, uniqueSlug } from './slug.js';

describe('slugify', () => {
  it('normaliza espaços e caixa', () => {
    expect(slugify('Minha Skill Legal')).toBe('minha-skill-legal');
  });

  it('remove acentos', () => {
    expect(slugify('Configuração de Deploy Ágil')).toBe('configuracao-de-deploy-agil');
  });

  it('colapsa separadores repetidos e apara as pontas', () => {
    expect(slugify('  --Olá___mundo!!  ')).toBe('ola-mundo');
  });

  it('retorna string vazia quando não sobra nada', () => {
    expect(slugify('🎉🎉')).toBe('');
    expect(slugify('')).toBe('');
  });

  it('limita o tamanho sem deixar hífen no final', () => {
    const slug = slugify('a'.repeat(200));
    expect(slug.length).toBe(96);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('uniqueSlug', () => {
  it('usa o slug base quando está livre', () => {
    expect(uniqueSlug('Deploy Docker', [])).toBe('deploy-docker');
  });

  it('sufixa com número na colisão', () => {
    expect(uniqueSlug('Deploy Docker', ['deploy-docker'])).toBe('deploy-docker-2');
    expect(uniqueSlug('Deploy Docker', ['deploy-docker', 'deploy-docker-2'])).toBe(
      'deploy-docker-3',
    );
  });

  it('encurta a base para o sufixo caber no teto: o gerado passa em isValidSlug', () => {
    // O sufixo vinha depois do corte do `slugify` e escapava dele: 96 + '-2'
    // dava 98 caracteres, e o próprio `isValidSlug` recusava o que o sistema
    // acabara de gerar.
    const base = 'a'.repeat(96);
    const slug = uniqueSlug('a'.repeat(200), [base]);

    expect(slug).toBe(`${'a'.repeat(94)}-2`);
    expect(slug.length).toBe(96);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('segue numerando sobre a base encurtada', () => {
    const base = 'a'.repeat(96);
    const slug = uniqueSlug('a'.repeat(200), [base, `${'a'.repeat(94)}-2`]);

    expect(slug).toBe(`${'a'.repeat(94)}-3`);
    expect(isValidSlug(slug)).toBe(true);
  });

  it('não deixa hífen dobrado quando o corte cai sobre um', () => {
    const base = `${'a'.repeat(93)}-bb`;
    const slug = uniqueSlug(base, [base]);

    expect(slug).toBe(`${'a'.repeat(93)}-2`);
    expect(slug).not.toContain('--');
    expect(isValidSlug(slug)).toBe(true);
  });

  it('usa prefixo padrão quando o nome não gera slug', () => {
    expect(uniqueSlug('🚀', [])).toBe('skill');
    expect(uniqueSlug('🚀', ['skill'])).toBe('skill-2');
  });
});

describe('isValidSlug', () => {
  it('aceita slugs canônicos', () => {
    expect(isValidSlug('minha-skill')).toBe(true);
  });

  it('rejeita slugs não canônicos ou vazios', () => {
    expect(isValidSlug('Minha Skill')).toBe(false);
    expect(isValidSlug('../etc/passwd')).toBe(false);
    expect(isValidSlug('')).toBe(false);
  });
});
