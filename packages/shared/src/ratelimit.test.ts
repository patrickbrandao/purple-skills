import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter, rateLimitKey } from './ratelimit.js';

describe('janela em memória por chave', () => {
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

  it('forgive devolve uma marca: a requisição isenta não gasta cota', () => {
    const limiter = createRateLimiter({ max: 2, windowSeconds: 60 });

    // Duas requisições autenticadas por chave, perdoadas uma a uma, deixam a
    // cota anônima do IP intacta.
    limiter.hit('ip');
    limiter.forgive('ip');
    limiter.hit('ip');
    limiter.forgive('ip');

    expect([limiter.hit('ip'), limiter.hit('ip')]).toEqual([true, true]);
    expect(limiter.hit('ip')).toBe(false);
  });

  it('forgive em chave sem marca não estoura', () => {
    const limiter = createRateLimiter({ max: 1, windowSeconds: 60 });

    expect(() => limiter.forgive('nunca-vista')).not.toThrow();
    expect(limiter.hit('nunca-vista')).toBe(true);
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

    // Sem teto, um atacante com muitos IPs guardaria 500 entradas.
    expect(limiter.hit('ip-novo')).toBe(true);
  });

  it('quem estourou o teto é o primeiro a sair quando falta espaço', () => {
    const limiter = createRateLimiter({ max: 1, windowSeconds: 60, maxKeys: 3 });

    limiter.hit('flood');
    expect(limiter.hit('flood')).toBe(false);
    // Chaves novas empurram o mapa: a bloqueada não renovou a posição.
    for (let i = 0; i < 6; i += 1) limiter.hit(`outro-${i}`);

    expect(limiter.hit('flood')).toBe(true);
  });
});

describe('rateLimitKey', () => {
  it('IPv4 conta por endereço, inclusive o disfarçado em IPv6', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('203.0.113.7')).not.toBe(rateLimitKey('203.0.113.8'));
  });

  it('IPv6 conta por /64: trocar de endereço no mesmo prefixo não dá cota nova', () => {
    const casa = rateLimitKey('2001:db8:abcd:1234::1');

    expect(casa).toBe('2001:db8:abcd:1234::/64');
    expect(rateLimitKey('2001:db8:abcd:1234:dead:beef:0:9')).toBe(casa);
    // Prefixo diferente, cota diferente.
    expect(rateLimitKey('2001:db8:abcd:9999::1')).not.toBe(casa);
  });

  it('expande o `::` antes de cortar, e ignora a zona da interface', () => {
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('sem IP, todos caem na mesma chave — contar junto é melhor que não contar', () => {
    expect(rateLimitKey(undefined)).toBe('desconhecido');
    expect(rateLimitKey('  ')).toBe('desconhecido');
  });
});
