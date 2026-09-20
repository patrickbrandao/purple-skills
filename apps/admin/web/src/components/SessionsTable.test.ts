import { describe, expect, it } from 'vitest';
import { lastPageOffset } from './SessionsTable.js';

/**
 * A página órfã da tabela de sessões (`tasks/051`): o `offset` é estado da
 * tabela e o total muda por fora dela — outro servidor escolhido na Auditoria,
 * ou sessões que acabam em "Online agora". Pedir a faixa 101–150 de um total de
 * 20 devolvia página vazia, e a tela afirmava "Nenhuma sessão ainda" com o
 * rodapé em "101–20 de 20".
 */
describe('lastPageOffset', () => {
  it('sem linha nenhuma, ou com menos de uma página, é a primeira', () => {
    expect(lastPageOffset(0, 50)).toBe(0);
    expect(lastPageOffset(1, 50)).toBe(0);
    expect(lastPageOffset(20, 50)).toBe(0);
    expect(lastPageOffset(50, 50)).toBe(0);
  });

  it('é o começo da última página que ainda tem linha', () => {
    expect(lastPageOffset(51, 50)).toBe(50);
    expect(lastPageOffset(100, 50)).toBe(50);
    expect(lastPageOffset(101, 50)).toBe(100);
    expect(lastPageOffset(320, 50)).toBe(300);
  });

  it('sempre cai dentro do total — e antes de qualquer offset que tenha ficado órfão', () => {
    for (let total = 0; total <= 260; total += 1) {
      const offset = lastPageOffset(total, 50);
      expect(offset % 50).toBe(0);
      if (total > 0) expect(offset).toBeLessThan(total);
      // Órfão é o offset > 0 que não tem linha: `offset >= total`. O corrigido é sempre menor.
      for (const orfao of [50, 100, 150, 200, 250, 300].filter((o) => o >= total)) {
        expect(offset).toBeLessThan(orfao);
      }
    }
  });
});
