import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bearerToken, readSecret, requireSecret, safeEqual } from './secrets.js';

describe('readSecret', () => {
  it('lê da env var direta', () => {
    expect(readSecret('X', { X: 'valor' } as NodeJS.ProcessEnv)).toBe('valor');
  });

  it('prioriza <NOME>_FILE sobre <NOME> e apara a quebra de linha final', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-secret-'));
    const file = join(dir, 'secret');
    writeFileSync(file, 'do-arquivo\n');

    const env = { X: 'da-env', X_FILE: file } as NodeJS.ProcessEnv;
    expect(readSecret('X', env)).toBe('do-arquivo');
  });

  it('devolve undefined quando não há nada definido ou está vazio', () => {
    expect(readSecret('X', {} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(readSecret('X', { X: '' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('requireSecret', () => {
  it('lança quando o segredo obrigatório falta', () => {
    expect(() => requireSecret('ADMIN_PASSWORD', {} as NodeJS.ProcessEnv)).toThrow(
      /ADMIN_PASSWORD/,
    );
  });
});

describe('safeEqual', () => {
  it('compara strings iguais e diferentes', () => {
    expect(safeEqual('segredo', 'segredo')).toBe(true);
    expect(safeEqual('segredo', 'segred0')).toBe(false);
  });

  it('não estoura com tamanhos diferentes', () => {
    expect(safeEqual('a', 'abcdef')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});

describe('bearerToken', () => {
  it('extrai o token do header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer  abc123 ')).toBe('abc123');
  });

  it('devolve null para headers ausentes ou de outro esquema', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('Basic abc')).toBeNull();
  });
});
