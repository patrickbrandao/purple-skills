/**
 * Teste de integração do **runner** (`migrate.ts`) — exige um PostgreSQL 18 real
 * com pgvector, porque aplica o schema inteiro.
 *
 * Cobre a recusa da reaplicação retroativa e o próprio CLI, que nenhuma outra
 * suíte exercita: todas importam `runMigrations()` e passam ao largo do bloco
 * de entrypoint — foi assim que ele passou meses saindo com 0 sem fazer nada
 * numa cópia de trabalho com espaço no caminho.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/migrate.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { runMigrations, schemaDir } from './migrate.js';

const url = process.env.TEST_DATABASE_URL;

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

/** A raiz do repositório: `database/schema/` → `database/` → raiz. */
const RAIZ = join(schemaDir(), '..', '..');

/** Tudo o que a pasta traz, na ordem do runner — a lista não é fixa de propósito. */
const ARQUIVOS = readdirSync(schemaDir())
  .filter((file) => file.endsWith('.sql'))
  .sort();

let raw: pg.Client;
let temporario = '';

async function conta(texto: string): Promise<number> {
  const { rows } = await raw.query<{ n: string }>(texto);
  return Number(rows[0]?.n ?? 0);
}

async function publica(): Promise<boolean | null> {
  const { rows } = await raw.query<{ is_public: boolean }>(
    "SELECT is_public FROM skills WHERE slug = 'publica'",
  );
  return rows[0]?.is_public ?? null;
}

/**
 * Roda o CLI de verdade, num processo filho: `node --import tsx <caminho>`, que
 * é o que `npm run migrate` faz. Devolve o código de saída e o que ele escreveu.
 */
function cli(
  caminho: string,
  ambiente: Record<string, string> = {},
): Promise<{ codigo: number; saida: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', caminho],
      {
        cwd: RAIZ,
        // Só a URL: as `PG*` de quem roda a suíte não podem decidir o banco.
        env: { PATH: process.env.PATH ?? '', DATABASE_URL: url!, ...ambiente },
      },
      (erro, stdout, stderr) => {
        const codigo = erro === null ? 0 : typeof erro.code === 'number' ? erro.code : 1;
        resolve({ codigo, saida: `${stdout}${stderr}` });
      },
    );
  });
}

describe.skipIf(!url)('runner: a reaplicação retroativa e o CLI', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    // Uma cópia de trabalho com espaço e acento no caminho, atrás de um
    // symlink: os três casos que a guarda antiga de entrypoint não reconhecia.
    temporario = realpathSync(mkdtempSync(join(tmpdir(), 'ps-runner-')));
    mkdirSync(join(temporario, 'área de trabalho'));
    symlinkSync(RAIZ, join(temporario, 'área de trabalho', 'purple skills'), 'dir');
  }, 60_000);

  afterAll(async () => {
    rmSync(temporario, { recursive: true, force: true });
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('banco novo: a recusa ligada não atrapalha a primeira aplicação, e a segunda passada não faz nada', async () => {
    expect(await runMigrations(url!, { refuseRetroactive: true })).toEqual(ARQUIVOS);
    expect(await runMigrations(url!, { refuseRetroactive: true })).toEqual([]);
    expect(await conta('SELECT count(*) AS n FROM schema_migrations')).toBe(ARQUIVOS.length);

    // A skill pública é o dado que a reaplicação do `012` destrói.
    await raw.query("INSERT INTO skills (slug, name, is_public) VALUES ('publica', 'Publica', true)");
  }, 60_000);

  it('o CLI roda de um caminho com espaço, acento e symlink — e diz o que fez', async () => {
    const caminho = join(temporario, 'área de trabalho', 'purple skills', 'database', 'src', 'migrate.ts');
    const { codigo, saida } = await cli(caminho);
    // Antes: código 0 e **nenhuma** linha `[migrate]`. Era esse silêncio que
    // fazia "rodei duas vezes e a segunda não fez nada" passar sem rodar nada.
    expect(saida).toContain('[migrate] nada a fazer');
    expect(codigo).toBe(0);
  }, 60_000);

  it('falta uma linha no meio do histórico: recusa, nomeia os arquivos e não aplica nenhum', async () => {
    await raw.query(
      "DELETE FROM schema_migrations WHERE name IN ('012-skills-flutuantes.sql', '020-rag.sql')",
    );

    const ultima = ARQUIVOS[ARQUIVOS.length - 1]!;
    await expect(runMigrations(url!, { refuseRetroactive: true })).rejects.toThrow(
      `Migration retroativa recusada: 012-skills-flutuantes.sql, 020-rag.sql não está em ` +
        `schema_migrations, mas este banco já aplicou a ${ultima}`,
    );

    // Nada rodou: o histórico ficou como estava e o flag continua lá.
    expect(await conta('SELECT count(*) AS n FROM schema_migrations')).toBe(ARQUIVOS.length - 2);
    expect(await publica()).toBe(true);
  }, 60_000);

  it('o CLI recusa por padrão e sai com 1; MIGRATE_ALLOW_RETRO=1 é a saída explícita', async () => {
    // Só a `021` fica de fora: é um índice com `IF NOT EXISTS`, o exemplo de
    // arquivo que pode entrar atrasado sem destruir nada.
    await raw.query(
      `INSERT INTO schema_migrations (name) VALUES ('012-skills-flutuantes.sql'), ('020-rag.sql')`,
    );
    await raw.query("DELETE FROM schema_migrations WHERE name = '021-chaves-por-emissor.sql'");

    const recusado = await cli(join(RAIZ, 'database', 'src', 'migrate.ts'));
    expect(recusado.codigo).toBe(1);
    expect(recusado.saida).toContain('Migration retroativa recusada: 021-chaves-por-emissor.sql');
    expect(recusado.saida).toContain('MIGRATE_ALLOW_RETRO=1');
    expect(await conta('SELECT count(*) AS n FROM schema_migrations')).toBe(ARQUIVOS.length - 1);

    const liberado = await cli(join(RAIZ, 'database', 'src', 'migrate.ts'), {
      MIGRATE_ALLOW_RETRO: '1',
    });
    expect(liberado.saida).toContain('[migrate] aplicada: 021-chaves-por-emissor.sql');
    expect(liberado.codigo).toBe(0);
    expect(await conta('SELECT count(*) AS n FROM schema_migrations')).toBe(ARQUIVOS.length);
  }, 60_000);

  it('falta o histórico inteiro: a marca d’água é zero, quem acusa é o schema que já existe', async () => {
    // Restauração sem `schema_migrations`: o runner recria a tabela, vazia.
    await raw.query('DROP TABLE schema_migrations');

    await expect(runMigrations(url!, { refuseRetroactive: true })).rejects.toThrow(
      /Reaplicação recusada: schema_migrations está vazia, mas o schema já existe/,
    );
    expect(await conta('SELECT count(*) AS n FROM schema_migrations')).toBe(0);
    expect(await publica()).toBe(true);

    // A saída documentada: uma linha por arquivo que o banco já tem.
    await raw.query('INSERT INTO schema_migrations (name) SELECT unnest($1::text[])', [ARQUIVOS]);
    expect(await runMigrations(url!, { refuseRetroactive: true })).toEqual([]);
    expect(await publica()).toBe(true);
  }, 60_000);

  /**
   * O porquê da recusa, medido — e o que as suítes de idempotência fazem de
   * propósito, sem a opção, num banco descartável. Fica por último porque deixa
   * o schema estragado.
   */
  it('sem a recusa, o 012 reaplicado derruba o is_public do 017 — e o 017 reaplicado estreita o CHECK da auditoria', async () => {
    await raw.query("DELETE FROM schema_migrations WHERE name = '012-skills-flutuantes.sql'");
    expect(await runMigrations(url!)).toEqual(['012-skills-flutuantes.sql']);
    // `DROP COLUMN IF EXISTS` não falha: a coluna some, com o dado dentro, e
    // toda listagem de skill passa a bater em "column s.is_public does not exist".
    await expect(publica()).rejects.toThrow(/is_public/);

    // A recuperação devolve a coluna **zerada** — e não há linha de auditoria
    // que diga quais skills eram públicas.
    await raw.query("DELETE FROM schema_migrations WHERE name = '017-acesso-granular.sql'");
    expect(await runMigrations(url!)).toEqual(['017-acesso-granular.sql']);
    expect(await publica()).toBe(false);
    expect(await conta('SELECT count(*) AS n FROM audit_log')).toBe(0);

    // E o `CHECK` de `audit_log.action` voltou à lista da época do `017`: o
    // "Reindexar" do painel (`rag.reindex`, da `020`) deixaria de gravar.
    await expect(
      raw.query(
        `INSERT INTO audit_log (action, source, actor_label, target_label)
         VALUES ('rag.reindex', 'web-admin', 'teste', '0 skills')`,
      ),
    ).rejects.toThrow(/audit_log_action_check/);
  }, 60_000);
});
