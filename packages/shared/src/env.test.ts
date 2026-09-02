import { describe, expect, it } from 'vitest';
import { readIntEnv, readPortEnv, readTextEnv } from './env.js';

const env = (value?: string) => ({ LIMITE: value } as NodeJS.ProcessEnv);

describe('readIntEnv', () => {
  it('usa o padrão quando a variável está ausente, vazia ou só com espaços', () => {
    expect(readIntEnv('LIMITE', 2000, { env: {} as NodeJS.ProcessEnv })).toBe(2000);
    expect(readIntEnv('LIMITE', 2000, { env: env('') })).toBe(2000);
    expect(readIntEnv('LIMITE', 2000, { env: env('   ') })).toBe(2000);
  });

  it('lê um inteiro válido', () => {
    expect(readIntEnv('LIMITE', 2000, { env: env('50') })).toBe(50);
    expect(readIntEnv('LIMITE', 2000, { env: env(' 50 ') })).toBe(50);
  });

  it('recusa valores que virariam NaN e desligariam o limite', () => {
    for (const bruto of ['25MB', '1800s', 'abc', '1e3x', 'Infinity', '1,5']) {
      expect(() => readIntEnv('LIMITE', 2000, { env: env(bruto) })).toThrow(/LIMITE/);
    }
  });

  it('recusa não-inteiros e valores fora da faixa', () => {
    expect(() => readIntEnv('LIMITE', 2000, { env: env('1.5') })).toThrow(/LIMITE/);
    expect(() => readIntEnv('LIMITE', 2000, { env: env('0') })).toThrow(/LIMITE/);
    expect(() => readIntEnv('LIMITE', 2000, { env: env('-1') })).toThrow(/LIMITE/);
    expect(() => readIntEnv('LIMITE', 2000, { env: env('5'), min: 10 })).toThrow(/LIMITE/);
    expect(() => readIntEnv('LIMITE', 2000, { env: env('99'), max: 10 })).toThrow(/LIMITE/);
  });

  it('aceita zero quando min permite', () => {
    expect(readIntEnv('LIMITE', 2000, { env: env('0'), min: 0 })).toBe(0);
  });
});

describe('readPortEnv', () => {
  it('aceita portas válidas e recusa fora da faixa', () => {
    expect(readPortEnv('LIMITE', 3000, env('8080'))).toBe(8080);
    expect(readPortEnv('LIMITE', 3000, {} as NodeJS.ProcessEnv)).toBe(3000);
    expect(() => readPortEnv('LIMITE', 3000, env('70000'))).toThrow(/LIMITE/);
    expect(() => readPortEnv('LIMITE', 3000, env('abc'))).toThrow(/LIMITE/);
  });
});

describe('readTextEnv', () => {
  it('trata vazio e só-espaços como ausente', () => {
    expect(readTextEnv('TXT', 'padrão', {} as NodeJS.ProcessEnv)).toBe('padrão');
    expect(readTextEnv('TXT', 'padrão', { TXT: '' } as NodeJS.ProcessEnv)).toBe('padrão');
    expect(readTextEnv('TXT', 'padrão', { TXT: '  ' } as NodeJS.ProcessEnv)).toBe('padrão');
  });

  it('devolve o valor definido, sem espaços nas pontas', () => {
    expect(readTextEnv('TXT', 'padrão', { TXT: ' oi ' } as NodeJS.ProcessEnv)).toBe('oi');
  });
});
