import { describe, expect, it } from 'vitest';
import { slugEmDigitacao, slugify } from './slug.js';

/**
 * O campo do slug passou a slugificar enquanto se digita, porque o servidor
 * **recusa** com 400 o slug explícito inválido em vez de corrigi-lo em silêncio
 * (`tasks/049`). O que estes casos guardam é a única diferença entre as duas
 * funções — o hífen do fim, que o `slugify` apara e a digitação precisa manter,
 * senão ninguém consegue escrever um slug com hífen.
 */
describe('slugEmDigitacao', () => {
  it('mantém o hífen do fim, que o slugify apara', () => {
    expect(slugEmDigitacao('minha-')).toBe('minha-');
    expect(slugify('minha-')).toBe('minha');
  });

  it('baixa a caixa, tira o acento e troca o que não é a-z0-9 por hífen', () => {
    expect(slugEmDigitacao('Minha Skill!')).toBe('minha-skill-');
    expect(slugEmDigitacao('Ação Rápida')).toBe('acao-rapida');
  });

  it('colapsa hífen repetido e não deixa hífen no começo', () => {
    expect(slugEmDigitacao('--minha--skill')).toBe('minha-skill');
  });

  it('respeita o teto de 96, e o que sai daqui é aceito pelo slugify', () => {
    const longo = slugEmDigitacao('a'.repeat(120));

    expect(longo).toHaveLength(96);
    expect(slugify(longo)).toBe(longo);
  });
});
