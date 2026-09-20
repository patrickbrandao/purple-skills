import { describe, expect, it } from 'vitest';
import { readBoolEnv, readIntEnv, readPortEnv, readSizeEnv, readTextEnv } from './env.js';

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

describe('readBoolEnv', () => {
  const flag = (value?: string) => ({ FLAG: value } as NodeJS.ProcessEnv);

  it('trata ausente, vazio e só-espaços como não configurado', () => {
    // `undefined` é o "automático" de quem chama: `ADMIN_COOKIE_SECURE` vazia
    // acompanha o protocolo da requisição, e isso não pode virar `false`.
    expect(readBoolEnv('FLAG', {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(readBoolEnv('FLAG', flag(''))).toBeUndefined();
    expect(readBoolEnv('FLAG', flag('   '))).toBeUndefined();
  });

  it('aceita as grafias usuais, sem depender de caixa nem de espaço nas pontas', () => {
    for (const bruto of ['true', 'TRUE', ' True ', 'true ', '1', 'yes', 'YES', 'on']) {
      expect(readBoolEnv('FLAG', flag(bruto))).toBe(true);
    }
    for (const bruto of ['false', 'FALSE', ' False', '0', 'no', 'off', 'OFF']) {
      expect(readBoolEnv('FLAG', flag(bruto))).toBe(false);
    }
  });

  it('recusa o valor irreconhecível, em vez de virar false calado', () => {
    // Era o defeito: `ADMIN_COOKIE_SECURE=sim` destravava o cookie de sessão
    // que o operador quis travar, sem uma linha de log.
    for (const bruto of ['sim', 'verdadeiro', 'y', 't', '2', '"true"', 'true;', 'enabled']) {
      expect(() => readBoolEnv('FLAG', flag(bruto))).toThrow(/FLAG inválida/);
    }
  });

  it('a mensagem diz o que é aceito', () => {
    expect(() => readBoolEnv('FLAG', flag('sim'))).toThrow(/true ou false/);
  });
});

describe('readSizeEnv', () => {
  const teto = (value?: string) => ({ TETO: value } as NodeJS.ProcessEnv);

  it('usa o padrão quando a variável está ausente, vazia ou só com espaços', () => {
    expect(readSizeEnv('TETO', '1mb', {} as NodeJS.ProcessEnv)).toBe('1mb');
    expect(readSizeEnv('TETO', '1mb', teto(''))).toBe('1mb');
    expect(readSizeEnv('TETO', '1mb', teto('   '))).toBe('1mb');
  });

  it('devolve o próprio texto quando é um tamanho que o body-parser entende', () => {
    for (const bruto of ['48mb', '512KB', '1.5mb', '64 mb', '1gb', '1048576', '512b']) {
      expect(readSizeEnv('TETO', '1mb', teto(bruto))).toBe(bruto);
    }
    expect(readSizeEnv('TETO', '1mb', teto(' 64mb '))).toBe('64mb');
  });

  it('recusa o que o `bytes` leria como outra coisa', () => {
    // Medido com bytes 3.1.2: `48m`, `48 megas` e `48MiB` viram 48 BYTES, `1mbb`
    // e `1e3kb` viram 1 byte, `-1mb` vira teto negativo e `0mb` vira zero — o
    // serviço sobe e responde 413 a tudo. `abc` derruba o `express.json` com
    // uma mensagem que não diz de qual variável veio.
    for (const bruto of ['48m', '48 megas', '48MiB', '1mbb', '1e3kb', '-1mb', '0mb', '0', '1.5', 'mb', 'abc']) {
      expect(() => readSizeEnv('TETO', '1mb', teto(bruto))).toThrow(/TETO inválida/);
    }
  });
});
