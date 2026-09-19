import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNotPlaceholder,
  bearerToken,
  readSecret,
  requireSecret,
  safeEqual,
} from './secrets.js';

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

  it('apara linha em branco e espaço do arquivo', () => {
    // O `\n` que sobrava não aparece em erro nenhum: ele só faz o `safeEqual`
    // do `MCP_ADMIN_TOKEN` nunca casar com o token que o cliente manda.
    const dir = mkdtempSync(join(tmpdir(), 'ps-secret-'));
    const file = join(dir, 'secret');
    writeFileSync(file, '  do-arquivo\n\n');

    expect(readSecret('X', { X_FILE: file } as NodeJS.ProcessEnv)).toBe('do-arquivo');
  });

  it('arquivo só com espaço em branco é undefined, como a variável vazia', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-secret-'));
    const file = join(dir, 'secret');
    writeFileSync(file, '\n');

    expect(readSecret('X', { X_FILE: file } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(() => requireSecret('X', { X_FILE: file } as NodeJS.ProcessEnv)).toThrow(/ausente/);
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

  it('recusa o placeholder do .env.example', () => {
    const env = { MCP_ADMIN_TOKEN: 'CHANGE_ME' } as NodeJS.ProcessEnv;
    expect(() => requireSecret('MCP_ADMIN_TOKEN', env)).toThrow(/placeholder/);
  });
});

describe('assertNotPlaceholder', () => {
  it('recusa os placeholders, com espaço em volta e em qualquer caixa', () => {
    for (const valor of ['CHANGE_ME', ' change_me ', 'PLACEHOLDER', 'exemplo', 'xxxx']) {
      expect(() => assertNotPlaceholder('ADMIN_SESSION_SECRET', valor)).toThrow(
        /ADMIN_SESSION_SECRET/,
      );
    }
  });

  it('a mensagem diz como gerar um valor bom', () => {
    expect(() => assertNotPlaceholder('ADMIN_SESSION_SECRET', 'CHANGE_ME')).toThrow(
      /openssl rand -hex 32/,
    );
  });

  it('devolve o valor quando serve, sem aparar nada', () => {
    expect(assertNotPlaceholder('X', ' segredo ')).toBe(' segredo ');
  });

  it('o padrão é ancorado: placeholder no meio de uma URL não casa', () => {
    // A `DATABASE_URL` de exemplo carrega CHANGE_ME como senha embutida; ela
    // não é um placeholder inteiro e não pode derrubar ninguém.
    const url = 'postgres://postgres:CHANGE_ME@localhost:5432/purple_skills';
    expect(assertNotPlaceholder('DATABASE_URL', url)).toBe(url);
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
