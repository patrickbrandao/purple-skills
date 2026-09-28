/**
 * Teste de integração da migration `036-instrucoes-do-mcp-virtual.sql` — exige
 * um PostgreSQL 18 real.
 *
 * O que as outras suítes não cobrem: o **backfill**. As demais partem de um
 * schema completo e criam vMCPs com `instructions` desde o nascimento; aqui a
 * base para no `035`, recebe servidores do "mundo antigo" — em que a
 * `description` era o que o agente recebia no `initialize` — e só então a `036`
 * roda. O que se mede é que nenhum desses servidores muda o que entrega ao
 * agente no dia da atualização, que a `description` fica intacta e que a cópia
 * acontece **uma vez**.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/virtual-mcp-instructions.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { VIRTUAL_MCP_INSTRUCTIONS_MAX } from '@purple-skills/shared';
import { closeDb } from './client.js';
import { runMigrations, schemaDir } from './migrate.js';
import { getVirtualMcp, resolveVirtualMcp } from './queries.js';

const url = process.env.TEST_DATABASE_URL;

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

const MIGRATION = '036-instrucoes-do-mcp-virtual.sql';

/** Um carimbo antigo, para provar que o backfill não mexe em `updated_at`. */
const CARIMBO = '2025-03-04T05:06:07.000Z';

let raw: pg.Client;

async function applyUpTo(client: pg.Client, last: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = readdirSync(schemaDir())
    .filter((file) => file.endsWith('.sql') && file.slice(0, 3) <= last)
    .sort();
  for (const file of files) {
    await client.query('BEGIN');
    await client.query(readFileSync(join(schemaDir(), file), 'utf8'));
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
  }
}

async function linha(slug: string): Promise<{ description: string; instructions: string; updated_at: Date }> {
  const { rows } = await raw.query(
    'SELECT description, instructions, updated_at FROM virtual_mcps WHERE slug = $1',
    [slug],
  );
  return rows[0];
}

describe.skipIf(!url)('036: instruções do MCP virtual e o backfill a partir da description', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    // Uma base parada no `035`: a `description` ainda é o que vai ao agente.
    await applyUpTo(raw, '035');

    // Com legenda, sem legenda, com uma legenda maior que o teto das
    // instruções (a `description` não tem teto) e uma de emojis, em que
    // caractere e unidade UTF-16 divergem.
    await raw.query(
      `INSERT INTO virtual_mcps (slug, name, description, is_active, is_open, updated_at) VALUES
         ('com-legenda', 'Com legenda', 'Servidor do time de dados; comece pelo SQL.', true,  true,  $1),
         ('sem-legenda', 'Sem legenda', '',                                             true,  false, $1),
         ('enorme',      'Enorme',      repeat('b', 5000),                               false, false, $1),
         ('emoji',       'Emoji',       repeat($2, 4001),                                true,  false, $1)`,
      [CARIMBO, String.fromCodePoint(0x1f600)],
    );

    // E então o `036` — e o que a pasta trouxer depois dele, lido dela como a
    // suíte de `settings` faz: uma lista escrita à mão quebraria a cada
    // migration nova, de quem quer que seja.
    const doTrintaESeisEmDiante = readdirSync(schemaDir())
      .filter((file) => file.endsWith('.sql') && file.slice(0, 3) >= '036')
      .sort();
    expect(doTrintaESeisEmDiante[0]).toBe(MIGRATION);
    expect(await runMigrations(url!)).toEqual(doTrintaESeisEmDiante);
    process.env.DATABASE_URL = url;
  }, 120_000);

  afterAll(async () => {
    await closeDb();
    if (!raw) return;
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('copia a description para instructions, e o agente recebe o mesmo texto de antes', async () => {
    const com = await linha('com-legenda');
    expect(com.instructions).toBe('Servidor do time de dados; comece pelo SQL.');
    // A `description` fica: agora ela é só legenda, mas é a mesma legenda.
    expect(com.description).toBe('Servidor do time de dados; comece pelo SQL.');

    // É o que o mcp-public lê por requisição.
    expect(await resolveVirtualMcp('com-legenda')).toMatchObject({
      description: 'Servidor do time de dados; comece pelo SQL.',
      instructions: 'Servidor do time de dados; comece pelo SQL.',
    });

    // Sem description, nada a copiar: só o texto-base, como já era.
    expect((await linha('sem-legenda')).instructions).toBe('');
    expect((await getVirtualMcp('sem-legenda'))?.instructions).toBe('');
  });

  it('corta no teto por caractere, sem mexer na description nem no updated_at', async () => {
    const teto = VIRTUAL_MCP_INSTRUCTIONS_MAX;
    const { rows } = await raw.query<{ slug: string; d: number; i: number }>(
      `SELECT slug, char_length(description)::int AS d, char_length(instructions)::int AS i
         FROM virtual_mcps WHERE slug IN ('enorme', 'emoji') ORDER BY slug`,
    );
    expect(rows).toEqual([
      { slug: 'emoji', d: teto + 1, i: teto },
      { slug: 'enorme', d: 5000, i: teto },
    ]);
    // Desligado também recebe a cópia: religá-lo não pode mudar o que ele diz.
    expect((await linha('enorme')).instructions).toBe('b'.repeat(teto));
    expect((await linha('emoji')).instructions).toBe(String.fromCodePoint(0x1f600).repeat(teto));

    // A cópia não é edição de ninguém: o carimbo é o de antes, em todas.
    const { rows: carimbos } = await raw.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM virtual_mcps WHERE updated_at <> $1',
      [CARIMBO],
    );
    expect(carimbos[0]?.n).toBe(0);
  });

  it('o CHECK tem o número do shared e recusa acima dele', async () => {
    const { rows } = await raw.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'virtual_mcps_instructions_len_chk'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.def).toContain(`<= ${VIRTUAL_MCP_INSTRUCTIONS_MAX}`);

    await expect(
      raw.query("UPDATE virtual_mcps SET instructions = repeat('a', $1) WHERE slug = 'sem-legenda'", [
        VIRTUAL_MCP_INSTRUCTIONS_MAX + 1,
      ]),
    ).rejects.toThrow(/virtual_mcps_instructions_len_chk/);
  });

  it('reaplicar não devolve as instruções que o dono apagou: o backfill roda uma vez', async () => {
    // Depois da atualização, o dono limpa as instruções e escreve outras.
    await raw.query("UPDATE virtual_mcps SET instructions = '' WHERE slug = 'com-legenda'");
    await raw.query("UPDATE virtual_mcps SET instructions = 'Novo texto.' WHERE slug = 'enorme'");

    // Apagar do histórico é o que força o runner a rodar o arquivo de novo.
    await raw.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION]);
    expect(await runMigrations(url!)).toEqual([MIGRATION]);

    expect((await linha('com-legenda')).instructions).toBe('');
    expect((await linha('enorme')).instructions).toBe('Novo texto.');
    const { rows } = await raw.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'virtual_mcps_instructions_len_chk'",
    );
    expect(rows[0]?.n).toBe(1);

    // E uma segunda chamada normal não aplica nada.
    expect(await runMigrations(url!)).toEqual([]);
  });
});
