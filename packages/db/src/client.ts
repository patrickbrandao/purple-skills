import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>['db'];

/** `bigint` (OID 20) chega como string no driver; convertemos para number. */
pg.types.setTypeParser(20, (value) => Number(value));

let cached: { pool: pg.Pool; db: ReturnType<typeof drizzle<typeof schema>> } | null = null;

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não definida');
  return url;
}

export function createDb(connectionString: string = databaseUrl()) {
  const pool = new pg.Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    console.error('[db] erro no pool de conexões:', err.message);
  });

  const db = drizzle(pool, { schema });
  return { pool, db };
}

/** Conexão compartilhada por processo — usada pelos 4 serviços. */
export function getDb() {
  if (!cached) cached = createDb();
  return cached;
}

export async function closeDb(): Promise<void> {
  if (cached) {
    await cached.pool.end();
    cached = null;
  }
}

/** Espera o Postgres aceitar conexões (boot em docker-compose). */
export async function waitForDatabase(
  pool: pg.Pool,
  { attempts = 30, delayMs = 1000 }: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastError = err;
      console.log(`[db] aguardando Postgres (${i}/${attempts})…`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
