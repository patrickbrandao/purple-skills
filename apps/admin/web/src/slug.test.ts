import { describe, expect, it } from 'vitest';
import { slugDaCopia, slugEmDigitacao, slugify } from './slug.js';

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

/**
 * A sugestão de slug do diálogo de clonagem. É **só** uma sugestão: o campo
 * intocado não é enviado, e aí quem desempata é o `uniqueSlug` do servidor. O
 * que ela não pode é sair inválida — o campo já vem preenchido com ela, e
 * quem tocar em qualquer letra passa a mandá-la para um servidor que recusa
 * slug explícito inválido com 400.
 */
describe('slugDaCopia', () => {
  it('a decisão da entrevista: minha-skill vira minha-skill-2', () => {
    expect(slugDaCopia('minha-skill')).toBe('minha-skill-2');
    expect(slugDaCopia('skill')).toBe('skill-2');
  });

  it('a cópia da cópia empilha o sufixo, como o servidor faz', () => {
    // O banco deriva o slug do **slug do original** (`cloneSlugTx`), então a
    // base de `minha-skill-2` é ela mesma e a vaga livre é `-2-2`. Andar o
    // número daria `-3`, um palpite diferente do endereço que ia nascer.
    expect(slugDaCopia('minha-skill-2')).toBe('minha-skill-2-2');
  });

  it('número que é do nome, e não desempate, fica onde está', () => {
    // A armadilha de andar o número: `python-3` é a linguagem, não a terceira
    // cópia de `python`.
    expect(slugDaCopia('python-3')).toBe('python-3-2');
    expect(slugDaCopia('erro-12345')).toBe('erro-12345-2');
  });

  it('o sufixo cabe dentro do teto de 96, encurtando a base', () => {
    expect(slugDaCopia('a'.repeat(96))).toBe(`${'a'.repeat(94)}-2`);
    expect(slugDaCopia('a'.repeat(96))).toHaveLength(96);
    // O corte não pode deixar o hífen encostado no sufixo (`…--10`).
    expect(slugDaCopia(`${'a'.repeat(93)}-bb`)).toBe(`${'a'.repeat(93)}-2`);
    expect(slugDaCopia(`${'a'.repeat(94)}-9`)).toBe(`${'a'.repeat(94)}-2`);
  });

  it('a sugestão é sempre um slug válido — o servidor recusa o que não é', () => {
    for (const slug of ['minha-skill', 'minha-skill-2', 'a'.repeat(96), `${'a'.repeat(93)}-bb`, `${'a'.repeat(94)}-9`, 'x']) {
      const copia = slugDaCopia(slug);
      expect(slugify(copia), slug).toBe(copia);
      expect(copia.length, slug).toBeLessThanOrEqual(96);
    }
  });

  it('slug vazio não vira "-2": não há objeto sem slug, e o palpite não inventa um', () => {
    expect(slugDaCopia('')).toBe('');
  });
});
