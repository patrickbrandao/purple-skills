import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readIntEnv } from '@purple-skills/shared';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDb>['db'];

/** `bigint` (OID 20) chega como string no driver; convertemos para number. */
pg.types.setTypeParser(20, (value) => Number(value));

let cached: { pool: pg.Pool; db: ReturnType<typeof drizzle<typeof schema>> } | null = null;

/**
 * Parâmetros de conexão, a partir de `DATABASE_URL` **ou** das variáveis
 * `PG*` do próprio driver.
 *
 * A URL é um formato traiçoeiro para senha: `/`, `?` e `#` encerram a
 * autoridade e quebram o parse, e `%` seguido de dois hexadecimais é decodificado
 * em silêncio (a senha que chega ao Postgres não é a configurada). Como a senha
 * costuma ser gerada aleatoriamente, isso acontece com facilidade. `PGHOST`,
 * `PGUSER`, `PGPASSWORD` e `PGDATABASE` não passam por nenhum parse — é o que o
 * docker-compose usa. `DATABASE_URL` continua aceita e, quando presente, é
 * validada aqui para falhar com uma mensagem clara em vez de um erro do driver.
 */
export function databaseConfig(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const url = env.DATABASE_URL;

  if (url) {
    try {
      new URL(url);
    } catch {
      throw new Error(
        'DATABASE_URL inválida: percent-encode a senha (/ → %2F, ? → %3F, # → %23, % → %25) ' +
          'ou use PGHOST/PGUSER/PGPASSWORD/PGDATABASE, que dispensam escape.',
      );
    }
    return { connectionString: url };
  }

  // O driver lê PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE por conta própria.
  if (env.PGHOST || env.PGUSER || env.PGPASSWORD || env.PGDATABASE) return {};

  throw new Error('Defina DATABASE_URL ou PGHOST/PGUSER/PGPASSWORD/PGDATABASE');
}

export function createDb(connection: string | pg.PoolConfig = databaseConfig()) {
  const base: pg.PoolConfig =
    typeof connection === 'string' ? { connectionString: connection } : connection;

  const pool = new pg.Pool({
    ...base,
    max: readIntEnv('DB_POOL_MAX', 10),
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
