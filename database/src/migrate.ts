#!/usr/bin/env node
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
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

/** Opções de `runMigrations`. */
export type RunMigrationsOptions = {
  /**
   * Recusa a **reaplicação retroativa**: aplicar um arquivo que está fora do
   * histórico quando o banco já passou dele. Ver `assertNotRetroactive`.
   *
   * O CLI (`npm run migrate`, o container `migrate`) liga; quem chama a função
   * direto fica com o padrão, desligado. Os únicos chamadores diretos são as
   * suítes de integração, que apagam uma linha do histórico **de propósito**
   * para provar que o SQL não falha na segunda passada — num banco descartável,
   * onde o dado perdido não é de ninguém.
   */
  refuseRetroactive?: boolean;
};

/**
 * O número da migration: os dígitos do começo do nome, no formato de hoje
 * (`012-nome.sql`) e no legado (`0012_nome.sql`). Nome sem número devolve nulo
 * e fica fora da conta da marca d'água.
 */
export function migrationNumber(name: string): number | null {
  const match = /^(\d+)[-_]/.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Migration antiga sobre schema novo **não é segura**, por mais idempotente que
 * o arquivo seja na época dele: `IF EXISTS` garante que a segunda passada não
 * falha, não que ela não faz nada. O caso medido é o `012`, que derruba
 * `skills.is_public` — e o `017` recriou a coluna, com outro sentido e com dado
 * dentro. Reaplicado, o `012` apaga o flag de leitura de toda skill pública, sem
 * erro e sem linha em `audit_log`. Vale o mesmo para toda função redefinida
 * depois (a `020` reaplicada desfaz a `027`) e para o `CHECK` de
 * `audit_log.action`, que cada migration reescreve inteiro.
 *
 * O runner só chega a isso com o histórico **truncado**, e são dois os casos:
 *
 *   * falta uma linha no meio — alguém a apagou à mão, ou a restauração trouxe
 *     um `schema_migrations` mais velho que o schema. O arquivo pendente tem
 *     número **menor** que o maior já aplicado;
 *   * falta o histórico inteiro — restauração sem `schema_migrations`, ou a
 *     tabela derrubada. A marca d'água é zero e não acusa nada; o que acusa é o
 *     schema já existir (`skills` é do `001`). Sem esta conferência o runner
 *     reaplicava a pasta inteira em silêncio sobre a base viva.
 *
 * Arquivo legitimamente novo com número menor existe (renumeração entre cópias
 * de trabalho), e é para ele a saída `MIGRATE_ALLOW_RETRO=1` do CLI. Arquivo
 * **renomeado** depois de aplicado não é esse caso: o caminho é `RENAMED`.
 */
async function assertNotRetroactive(
  pool: pg.Pool,
  applied: ReadonlySet<string>,
  pending: readonly string[],
): Promise<void> {
  if (pending.length === 0) return;

  const saida =
    'Se o histórico foi truncado (restauração sem schema_migrations, linha apagada à mão), ' +
    'recomponha-o antes de migrar — database/README.md, "Reaplicar migration antiga". ' +
    'Se o arquivo é mesmo novo e só recebeu um número menor, rode com MIGRATE_ALLOW_RETRO=1; ' +
    'se foi renomeado depois de aplicado, o caminho é a tabela RENAMED de database/src/migrate.ts.';

  if (applied.size === 0) {
    const { rows } = await pool.query<{ existe: boolean }>(
      "SELECT to_regclass('skills') IS NOT NULL AS existe",
    );
    if (!rows[0]?.existe) return; // banco novo: é a primeira aplicação
    throw new Error(
      `Reaplicação recusada: schema_migrations está vazia, mas o schema já existe neste banco. ` +
        `Aplicar os ${pending.length} arquivos de novo sobre ele perde dado — o 012 derruba o ` +
        `skills.is_public que o 017 recriou. ${saida}`,
    );
  }

  let marca = 0;
  let ultima = '';
  for (const name of applied) {
    const numero = migrationNumber(name);
    if (numero !== null && numero > marca) {
      marca = numero;
      ultima = name;
    }
  }

  const retroativas = pending.filter((file) => {
    const numero = migrationNumber(file);
    return numero !== null && numero < marca;
  });
  if (retroativas.length === 0) return;

  throw new Error(
    `Migration retroativa recusada: ${retroativas.join(', ')} não está em schema_migrations, ` +
      `mas este banco já aplicou a ${ultima}. Migration antiga sobre schema novo não é segura ` +
      `(o 012 reaplicado derruba o skills.is_public que o 017 recriou, com o dado dentro). ${saida}`,
  );
}

export async function runMigrations(
  connection: string | pg.PoolConfig = databaseConfig(),
  options: RunMigrationsOptions = {},
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

    // Antes do laço, e não dentro dele: recusar no meio deixaria aplicado o que
    // veio antes do arquivo recusado. Aqui ou passa tudo, ou não passa nada.
    if (options.refuseRetroactive) {
      const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
      const historico = new Set(rows.map((row) => row.name));
      await assertNotRetroactive(
        pool,
        historico,
        files.filter((file) => !historico.has(file)),
      );
    }

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

/**
 * Este módulo é o entrypoint (`npm run migrate`, `node database/dist/migrate.js`)
 * e também é **importado** pelas suítes de integração, que chamam
 * `runMigrations()` por conta própria — daí a pergunta "fui eu que o Node mandou
 * executar?".
 *
 * A comparação de antes, `import.meta.url === \`file://${process.argv[1]}\``,
 * confrontava dois formatos do mesmo endereço. Medido no Node e no `tsx`: a URL
 * do módulo vem **percent-encodada** (espaço vira `%20`, acento vira UTF-8
 * escapado) e com os **symlinks resolvidos**; `argv[1]` é o caminho cru, como
 * foi digitado. Numa cópia de trabalho com espaço ou acento no caminho, ou
 * atrás de um symlink (`/tmp` e `/var` no macOS), a guarda dava falso e o
 * comando **não fazia nada e saía com 0**, sem uma linha `[migrate]` — o pior
 * modo de falhar de uma ferramenta que se roda "duas vezes para conferir que a
 * segunda não faz nada".
 *
 * Os **dois** lados viram caminho nativo real. Resolver só o `argv[1]` bastaria
 * hoje, mas volta a falhar sob `--preserve-symlinks-main`, em que o Node deixa
 * de resolver a URL do módulo (medido). Caminho que não existe (`node -e`,
 * `node -`) não é este arquivo.
 */
export function isEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  // O CLI é o caminho do operador, e é nele que a reaplicação retroativa é
  // recusada (ver `assertNotRetroactive`). A variável é a saída para o arquivo
  // novo que recebeu número menor — de uso pontual, na linha de comando, e não
  // configuração para deixar no `.env`.
  runMigrations(databaseConfig(), { refuseRetroactive: process.env.MIGRATE_ALLOW_RETRO !== '1' })
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
