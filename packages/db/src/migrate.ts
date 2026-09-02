#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createDb, databaseConfig, waitForDatabase } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Resolve o diretório `migrations/` tanto rodando de `src/` quanto de `dist/`. */
export function migrationsDir(): string {
  return join(here, '..', 'migrations');
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

    const dir = migrationsDir();
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
