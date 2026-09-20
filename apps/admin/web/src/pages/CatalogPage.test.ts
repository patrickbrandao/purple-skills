import { describe, expect, it } from 'vitest';
import { hiddenRowLabel } from './CatalogPage.js';

/**
 * A ficha do catálogo lista só os servidores (e os membros) que a conta vê, mas
 * os contadores são globais de propósito — é o número da confirmação de
 * exclusão. A diferença é dita na última linha, em vez de a ficha anunciar 3 e
 * listar 1 (relatório 010 da auditoria de 2026-09-19).
 */
describe('hiddenRowLabel', () => {
  it('nada a dizer quando a lista está inteira', () => {
    expect(hiddenRowLabel(2, 2, 'servidor', 'servidores')).toBeNull();
    expect(hiddenRowLabel(0, 0, 'servidor', 'servidores')).toBeNull();
  });

  it('"e mais N" quando há linhas acima; só o número quando não há nenhuma', () => {
    expect(hiddenRowLabel(3, 1, 'servidor', 'servidores')).toBe('e mais 2 servidores que você não vê');
    expect(hiddenRowLabel(2, 1, 'servidor', 'servidores')).toBe('e mais 1 servidor que você não vê');
    expect(hiddenRowLabel(1, 0, 'skill', 'skills')).toBe('1 skill que você não vê');
  });

  // Entre a contagem e a lista são duas consultas: um vínculo criado no meio
  // pode deixar a lista maior que o contador. Não vira "e mais -1".
  it('lista maior que o contador não produz número negativo', () => {
    expect(hiddenRowLabel(1, 2, 'servidor', 'servidores')).toBeNull();
  });
});
