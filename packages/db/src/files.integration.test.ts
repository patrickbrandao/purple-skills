/**
 * Teste de integração das queries de arquivo — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run packages/db/src/files.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import {
  createSkill,
  deleteFile,
  getSkillDetail,
  listFiles,
  readAllFiles,
  setFile,
  setFiles,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'mcp-admin' as const;

describe.skipIf(!url)('arquivos: unicidade de caminho sem diferenciar caixa', () => {
  let uuid = '';

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url });
    try {
      await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
      await admin.query('CREATE SCHEMA public');
    } finally {
      await admin.end();
    }

    await runMigrations(url!);
    // As queries resolvem a conexão por `getDb()`, que lê o ambiente na
    // primeira chamada — ainda não houve nenhuma até aqui.
    process.env.DATABASE_URL = url;

    const skill = await createSkill(
      { name: 'Caso 003', slug: 'caso-003', skillMd: '# original', isPublic: true },
      SOURCE,
    );
    uuid = skill.uuid;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  it('grava "skill.md" sobre o SKILL.md existente em vez de duplicar', async () => {
    await setFile('caso-003', 'skill.md', '# sobrescrito', SOURCE);

    const principais = (await listFiles(uuid)).filter(
      (file) => file.relativePath.toLowerCase() === 'skill.md',
    );
    expect(principais.map((file) => file.relativePath)).toEqual(['SKILL.md']);

    const detail = await getSkillDetail('caso-003', { includePrivate: true });
    expect(detail?.skillMd).toBe('# sobrescrito');
  });

  it('colapsa anexos que diferem só na caixa, mantendo a última grafia', async () => {
    await setFiles(
      'caso-003',
      [
        { relativePath: 'skill.md', content: '# vindo do zip' },
        { relativePath: 'notas.md', content: 'v1' },
        { relativePath: 'Notas.MD', content: 'v2' },
      ],
      SOURCE,
    );

    const paths = (await listFiles(uuid)).map((file) => file.relativePath);
    expect(paths).toEqual(['SKILL.md', 'Notas.MD']);
  });

  it('gera pacote .zip sem entradas que colidem em FS insensível a caixa', async () => {
    const lowered = (await readAllFiles(uuid)).map((file) => file.relativePath.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });

  it('recusa remover o SKILL.md em qualquer caixa', async () => {
    for (const variant of ['SKILL.md', 'skill.md', 'Skill.MD']) {
      await expect(deleteFile('caso-003', variant, SOURCE)).rejects.toThrow(
        /não pode ser removido/,
      );
    }
  });

  it('remove exatamente a linha pedida, sem levar outras variantes junto', async () => {
    await setFile('caso-003', 'a.md', 'minusculo', SOURCE);
    await deleteFile('caso-003', 'A.md', SOURCE); // mesma linha, outra caixa

    const paths = (await listFiles(uuid)).map((file) => file.relativePath);
    expect(paths).toEqual(['SKILL.md', 'Notas.MD']);
  });
});
