import { describe, expect, it } from 'vitest';
import { paginaDaUrl, paginaPresa, totalDePaginas } from './pagina.js';

/**
 * O `?page=` da home do site (`PublicSkills`) — relatório 022 da auditoria de
 * 2026-11-07: valor inválido virava "NaN / N" no paginador, fração repetia meia
 * página e página além do fim dizia que o catálogo estava vazio.
 */
describe('paginaDaUrl', () => {
  it('sem o parâmetro é a primeira página', () => {
    expect(paginaDaUrl(null)).toBe(1);
  });

  it('o que não é número vira 1, e não NaN', () => {
    expect(paginaDaUrl('abc')).toBe(1);
    expect(paginaDaUrl('')).toBe(1);
    expect(paginaDaUrl('Infinity')).toBe(1);
  });

  it('fração é truncada: 1.5 é a página 1, e não o offset 6', () => {
    expect(paginaDaUrl('1.5')).toBe(1);
    expect(paginaDaUrl('3.9')).toBe(3);
  });

  it('zero e negativo são a primeira página', () => {
    expect(paginaDaUrl('0')).toBe(1);
    expect(paginaDaUrl('-4')).toBe(1);
  });

  it('inteiro válido passa como está', () => {
    expect(paginaDaUrl('7')).toBe(7);
  });
});

describe('paginaPresa', () => {
  it('além da última, leva à última', () => {
    // 30 skills em páginas de 12 são 3 páginas.
    expect(totalDePaginas(30, 12)).toBe(3);
    expect(paginaPresa(99, 30, 12)).toBe(3);
  });

  it('dentro do intervalo não leva a lugar nenhum', () => {
    expect(paginaPresa(1, 30, 12)).toBeNull();
    expect(paginaPresa(3, 30, 12)).toBeNull();
  });

  it('com o catálogo vazio, qualquer página além da 1 volta para a 1', () => {
    expect(paginaPresa(2, 0, 12)).toBe(1);
    expect(paginaPresa(1, 0, 12)).toBeNull();
  });
});
