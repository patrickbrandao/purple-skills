/**
 * Teste de integração da versão do envio na aprovação (`tasks/023` da
 * auditoria de 2026-11-07) — exige um PostgreSQL 18 real com pgvector, porque
 * aplica o schema inteiro.
 *
 * `promoteQuarantine(…, { expectedUpdatedAt })` compara, com o envio travado,
 * o `updatedAt` que quem aprova viu com o gravado, em milissegundos: o
 * conteúdo publicado tem de ser o revisado. A suíte confere que toda escrita
 * no envio carimba `updated_at`, que o `updatedAt` exposto é esse carimbo em
 * ms, e a recusa.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada.
 * Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/quarantine-version.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import type { AppError } from './errors.js';
import { runMigrations } from './migrate.js';
import {
  createCatalog,
  createQuarantine,
  createQuarantineFile,
  deleteQuarantineFile,
  getQuarantine,
  getSkillSummary,
  listQuarantine,
  promoteQuarantine,
  setQuarantineFile,
  setQuarantineFiles,
  setQuarantineTargets,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;
const ATOR = { userUuid: null, label: 'teste' };

/** O mesmo número das outras suítes: ver `quarantine.integration.test.ts`. */
const SCHEMA_LOCK = 8_200_004;

let raw: pg.Client;

function outcome(promise: Promise<unknown>): Promise<AppError | null> {
  return promise.then(
    () => null,
    (err: unknown) => err as AppError,
  );
}

/** O carimbo gravado, truncado em ms pelo banco, como epoch em ms. */
async function carimboNoBanco(uuid: string): Promise<number> {
  const { rows } = await raw.query<{ ms: string }>(
    `SELECT (extract(epoch FROM date_trunc('milliseconds', updated_at)) * 1000)::bigint AS ms
       FROM quarantine_skills WHERE uuid = $1`,
    [uuid],
  );
  return Number(rows[0]!.ms);
}

async function versao(uuid: string): Promise<string> {
  return (await getQuarantine(uuid))!.updatedAt;
}

/** Garante que a próxima escrita caia noutro milissegundo. */
const passa = () => new Promise((resolve) => setTimeout(resolve, 5));

const pacote = (nome: string) => [
  { relativePath: 'SKILL.md', content: `---\nname: ${nome}\n---\n# ${nome}\n` },
  { relativePath: 'notas.md', content: '# Notas\n' },
];

describe.skipIf(!url)('quarentena: a aprovação confere a versão que foi revisada', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    await runMigrations(url!);
    process.env.DATABASE_URL = url;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('o updatedAt exposto é o carimbo do banco em ms, na ficha e na fila', async () => {
    const envio = await createQuarantine({ name: 'Ms', files: pacote('ms') }, SOURCE, ATOR);
    expect(Date.parse(envio.updatedAt)).toBe(await carimboNoBanco(envio.uuid));
    const fila = await listQuarantine();
    expect(fila.items.find((i) => i.uuid === envio.uuid)!.updatedAt).toBe(envio.updatedAt);
  });

  it('toda escrita no envio carimba updated_at; o destino sem mudança, não', async () => {
    const { uuid } = await createQuarantine({ name: 'Carimbo', files: pacote('carimbo') }, SOURCE, ATOR);
    const catalogo = await createCatalog({ name: 'Destino', ownerUserUuid: null }, SOURCE, ATOR);

    const escritas: [string, () => Promise<unknown>][] = [
      ['setQuarantineFile (mesmos bytes)', () => setQuarantineFile(uuid, 'notas.md', '# Notas\n', SOURCE, ATOR)],
      ['createQuarantineFile', () => createQuarantineFile(uuid, 'novo.md', 'n', SOURCE, ATOR)],
      ['setQuarantineFiles', () => setQuarantineFiles(uuid, [{ relativePath: 'lote.md', content: 'l' }], SOURCE, ATOR)],
      ['deleteQuarantineFile', () => deleteQuarantineFile(uuid, 'novo.md', SOURCE, ATOR)],
      ['setQuarantineTargets', () => setQuarantineTargets(uuid, { catalogs: [catalogo.uuid], mcps: [] }, SOURCE, ATOR)],
    ];
    for (const [nome, escrever] of escritas) {
      const antes = await versao(uuid);
      await passa();
      await escrever();
      expect({ nome, mudou: (await versao(uuid)) !== antes }).toEqual({ nome, mudou: true });
    }

    const antes = await versao(uuid);
    await passa();
    await setQuarantineTargets(uuid, { catalogs: [catalogo.uuid], mcps: [] }, SOURCE, ATOR);
    expect(await versao(uuid)).toBe(antes);
  });

  it('o envio alterado depois da leitura é 409 e nada é criado; com a versão atual, aprova', async () => {
    const { uuid, updatedAt: lida } = await createQuarantine(
      { name: 'Revisado', files: pacote('revisado') },
      SOURCE,
      ATOR,
    );
    await passa();
    await setQuarantineFile(uuid, 'SKILL.md', '---\nname: revisado\n---\n# Trocado\n', SOURCE, ATOR);

    const err = await outcome(promoteQuarantine(uuid, SOURCE, ATOR, { expectedUpdatedAt: lida }));
    expect({ status: err?.status, message: err?.message }).toEqual({
      status: 409,
      message: 'O envio "Revisado" mudou depois que você o abriu: confira e aprove de novo',
    });
    expect(await getQuarantine(uuid)).not.toBeNull();
    expect(await getSkillSummary('revisado', { visibility: 'all' })).toBeNull();

    // A mesma versão escrita com outro fuso é a mesma versão.
    const atual = await versao(uuid);
    const comFuso = new Date(Date.parse(atual))
      .toISOString()
      .replace('Z', '+00:00');
    const skill = await promoteQuarantine(uuid, SOURCE, ATOR, { expectedUpdatedAt: comFuso });
    expect(skill.slug).toBe('revisado');
    expect(skill.skillMd).toBe('# Trocado\n');
  });

  it('o destino mudado responde com a mensagem do destino, mesmo com a versão junto', async () => {
    const { uuid, updatedAt: lida } = await createQuarantine({ name: 'Dois', files: pacote('dois') }, SOURCE, ATOR);
    const catalogo = await createCatalog({ name: 'Outro destino', ownerUserUuid: null }, SOURCE, ATOR);
    await passa();
    await setQuarantineTargets(uuid, { catalogs: [catalogo.uuid], mcps: [] }, SOURCE, ATOR);

    const err = await outcome(
      promoteQuarantine(uuid, SOURCE, ATOR, {
        expectedTargets: { catalogs: [], mcps: [] },
        expectedUpdatedAt: lida,
      }),
    );
    expect(err?.status).toBe(409);
    expect(err?.message).toBe('O destino do envio "Dois" mudou enquanto você aprovava: confira e aprove de novo');

    // Só a versão: o destino trocado também a muda.
    const soVersao = await outcome(promoteQuarantine(uuid, SOURCE, ATOR, { expectedUpdatedAt: lida }));
    expect(soVersao?.message).toBe('O envio "Dois" mudou depois que você o abriu: confira e aprove de novo');
  });

  it('expectedUpdatedAt que não é data é 400, antes de tocar no envio; omitido, não compara', async () => {
    const { uuid, updatedAt: lida } = await createQuarantine({ name: 'Datas', files: pacote('datas') }, SOURCE, ATOR);
    for (const torto of ['ontem', '', '   ', 123 as unknown as string, null as unknown as string]) {
      const err = await outcome(promoteQuarantine(uuid, SOURCE, ATOR, { expectedUpdatedAt: torto }));
      expect({ torto, status: err?.status, message: err?.message }).toEqual({
        torto,
        status: 400,
        message: 'O campo "expectedUpdatedAt" precisa ser uma data ISO',
      });
    }
    expect(await versao(uuid)).toBe(lida);

    await passa();
    await setQuarantineFile(uuid, 'notas.md', 'mudou', SOURCE, ATOR);
    // Sem a opção, aprova o que estiver gravado, como antes.
    expect((await promoteQuarantine(uuid, SOURCE, ATOR)).slug).toBe('datas');
  });
});
