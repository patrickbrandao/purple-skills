import { describe, expect, it } from 'vitest';
import { rankSkills, scoreToStars, skillScore } from './rating.js';

describe('skillScore', () => {
  it('soma views e downloads sem pesos', () => {
    expect(skillScore(10, 5)).toBe(15);
  });

  it('aceita bigint vindo do driver do Postgres', () => {
    expect(skillScore(10n, 5n)).toBe(15);
  });

  it('trata ausência de contadores como zero', () => {
    expect(skillScore(0, 0)).toBe(0);
  });
});

describe('rankSkills', () => {
  const skills = [
    { slug: 'a', viewCount: 1, downloadCount: 1 },
    { slug: 'b', viewCount: 10, downloadCount: 0 },
    { slug: 'c', viewCount: 3, downloadCount: 4 },
  ];

  it('ordena pelo score decrescente', () => {
    expect(rankSkills(skills).map((s) => s.slug)).toEqual(['b', 'c', 'a']);
  });

  it('não muta o array de entrada', () => {
    const copy = [...skills];
    rankSkills(skills);
    expect(skills).toEqual(copy);
  });
});

describe('scoreToStars', () => {
  it('vai de 0 a 5', () => {
    expect(scoreToStars(0)).toBe(0);
    expect(scoreToStars(-5)).toBe(0);
    expect(scoreToStars(10_000_000)).toBe(5);
  });

  it('cresce de forma monotônica', () => {
    expect(scoreToStars(10)).toBeGreaterThan(scoreToStars(1));
    expect(scoreToStars(100)).toBeGreaterThan(scoreToStars(10));
  });
});
