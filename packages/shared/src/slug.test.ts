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
