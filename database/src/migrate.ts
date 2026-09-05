#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createDb, databaseConfig, waitForDatabase } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve o diretório `schema/` tanto rodando de `src/` quanto de `dist/`. */
export function schemaDir(): string {
  return join(here, '..', 'schema');
}

/**
 * Nomes antigos (`packages/db/migrations/nnnn_nome.sql`) de arquivos que hoje
 * vivem em `database/schema/nnn-nome.sql`. O runner identifica cada migration
 * pelo **nome do arquivo**, então sem esta tabela um banco já migrado veria os
 * arquivos renomeados como novos e aplicaria tudo de novo. A renomeação em
 * `schema_migrations` acontece uma vez, antes do laço.
 */
const RENAMED: Record<string, string> = {
  '001-init.sql': '0001_init.sql',
  '002-fix-search-vector-on-create.sql': '0002_fix_search_vector_on_create.sql',
  '003-case-insensitive-file-paths.sql': '0003_case_insensitive_file_paths.sql',
};

async function applyRenames(pool: pg.Pool): Promise<void> {
  for (const [current, legacy] of Object.entries(RENAMED)) {
    const { rowCount } = await pool.query(
      `UPDATE schema_migrations SET name = $1
        WHERE name = $2
          AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = $1)`,
      [current, legacy],
    );
    if (rowCount) console.log(`[migrate] renomeada no histórico: ${legacy} → ${current}`);
  }
  // Se ambos os nomes existirem (banco migrado nas duas épocas), o UPDATE acima
  // não roda e a linha antiga fica órfã — remover evita confundir auditoria.
  await pool.query('DELETE FROM schema_migrations WHERE name = ANY($1)', [Object.values(RENAMED)]);
}

export async function runMigrations(
  connection: string | pg.PoolConfig = databaseConfig(),
): Promise<string[]> {
  const { pool } = createDb(connection);
  const applied: string[] = [];

  try {
    await waitForDatabase(pool);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await applyRenames(pool);

    const dir = schemaDir();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (rowCount) {
        console.log(`[migrate] já aplicada: ${file}`);
        continue;
      }

      const sql = readFileSync(join(dir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] aplicada: ${file}`);
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falha na migration ${file}: ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }

  return applied;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrations()
    .then((applied) => {
      console.log(
        applied.length ? `[migrate] concluído (${applied.length} nova(s))` : '[migrate] nada a fazer',
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrate] erro:', err.message);
      process.exit(1);
    });
}
