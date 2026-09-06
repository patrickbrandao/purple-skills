import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from './ratelimit.js';

describe('janela em memória por IP', () => {
  it('libera até o teto e barra depois', () => {
    const limiter = createRateLimiter({ max: 3, windowSeconds: 60 });

    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a')]).toEqual([true, true, true]);
    expect(limiter.hit('a')).toBe(false);
    expect(limiter.retryAfter('a')).toBeGreaterThan(0);
  });

  it('conta cada chave separadamente', () => {
    const limiter = createRateLimiter({ max: 1, windowSeconds: 60 });

    expect(limiter.hit('10.0.0.1')).toBe(true);
    expect(limiter.hit('10.0.0.1')).toBe(false);
    expect(limiter.hit('10.0.0.2')).toBe(true);
  });

  it('reset limpa o contador — é o que o login bem-sucedido faz', () => {
    const limiter = createRateLimiter({ max: 2, windowSeconds: 60 });

    limiter.hit('a');
    limiter.hit('a');
    expect(limiter.hit('a')).toBe(false);

    limiter.reset('a');
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.retryAfter('a')).toBe(0);
  });

  it('a janela desliza: passado o tempo, libera de novo', () => {
    vi.useFakeTimers();
    try {
      const limiter = createRateLimiter({ max: 2, windowSeconds: 60 });

      limiter.hit('a');
      limiter.hit('a');
      expect(limiter.hit('a')).toBe(false);

      vi.advanceTimersByTime(61_000);
      expect(limiter.hit('a')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('não cresce sem limite: o teto de chaves é respeitado', () => {
    const limiter = createRateLimiter({ max: 5, windowSeconds: 60, maxKeys: 10 });

    for (let i = 0; i < 500; i += 1) limiter.hit(`ip-${i}`);

    // Sem teto, um atacante forjando IPs guardaria 500 entradas.
    expect(limiter.hit('ip-novo')).toBe(true);
  });
});
