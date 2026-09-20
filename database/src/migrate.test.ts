/**
 * O que o runner decide **sem** banco: o número de uma migration e a pergunta
 * "fui eu que o Node mandou executar?".
 *
 * A segunda é a que importa. O `migrate.ts` é entrypoint e é importado pelas
 * suítes de integração, então ele se pergunta se é o módulo principal — e a
 * comparação antiga (`import.meta.url === \`file://${process.argv[1]}\``) dava
 * falso numa cópia de trabalho com espaço, com acento ou atrás de um symlink. O
 * comando não fazia nada e saía com 0. Os caminhos daqui são de verdade, num
 * diretório temporário: `realpathSync` não tem o que resolver num caminho
 * inventado.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isEntrypoint, migrationNumber } from './migrate.js';

describe('migrationNumber', () => {
  it('lê os dígitos do começo, no formato de hoje e no legado', () => {
    expect(migrationNumber('012-skills-flutuantes.sql')).toBe(12);
    expect(migrationNumber('027-rag-stale-na-troca-de-tipo.sql')).toBe(27);
    expect(migrationNumber('0003_case_insensitive_file_paths.sql')).toBe(3);
  });

  it('nome sem número fica fora da marca d’água', () => {
    expect(migrationNumber('rascunho.sql')).toBeNull();
    expect(migrationNumber('12.sql')).toBeNull();
    expect(migrationNumber('')).toBeNull();
  });
});

describe('isEntrypoint', () => {
  let raiz = '';
  let real = '';
  let outro = '';
  let peloAtalho = '';

  beforeAll(() => {
    // `realpathSync` na raiz: o `tmpdir()` do macOS já vem atrás de um symlink
    // (`/var` → `/private/var`), e o teste precisa saber qual é o caminho real.
    raiz = realpathSync(mkdtempSync(join(tmpdir(), 'ps-migrate-')));
    const pasta = join(raiz, 'cópia de trabalho');
    mkdirSync(pasta);
    real = join(pasta, 'migrate.js');
    outro = join(pasta, 'seed.js');
    writeFileSync(real, '');
    writeFileSync(outro, '');
    symlinkSync(pasta, join(raiz, 'atalho'), 'dir');
    peloAtalho = join(raiz, 'atalho', 'migrate.js');
  });

  afterAll(() => {
    rmSync(raiz, { recursive: true, force: true });
  });

  it('caminho com espaço e acento: a URL vem percent-encodada, o argv não', () => {
    const url = pathToFileURL(real).href;
    // O que a guarda antiga comparava — e por que ela dava falso.
    expect(url).toContain('c%C3%B3pia%20de%20trabalho');
    expect(url === `file://${real}`).toBe(false);

    expect(isEntrypoint(real, url)).toBe(true);
  });

  it('atrás de um symlink: o Node resolve a URL do módulo, e o argv fica como foi digitado', () => {
    expect(isEntrypoint(peloAtalho, pathToFileURL(real).href)).toBe(true);
  });

  it('com --preserve-symlinks-main é a URL que fica sem resolver: os dois lados viram caminho real', () => {
    expect(isEntrypoint(peloAtalho, pathToFileURL(peloAtalho).href)).toBe(true);
    expect(isEntrypoint(real, pathToFileURL(peloAtalho).href)).toBe(true);
  });

  it('outro arquivo não é o entrypoint — é o caso de quem importa o runner', () => {
    expect(isEntrypoint(outro, pathToFileURL(real).href)).toBe(false);
  });

  it('sem argv[1], ou com um que não é arquivo, responde falso em vez de lançar', () => {
    expect(isEntrypoint(undefined, pathToFileURL(real).href)).toBe(false);
    expect(isEntrypoint('', pathToFileURL(real).href)).toBe(false);
    expect(isEntrypoint(join(raiz, 'não-existe.js'), pathToFileURL(real).href)).toBe(false);
    expect(isEntrypoint('-', pathToFileURL(real).href)).toBe(false);
  });
});
