/**
 * Teste de integração do seed (`tasks/013` da auditoria de 2026-11-07) — exige
 * um PostgreSQL 18 real com pgvector, porque aplica o schema inteiro.
 *
 * O seed é para instalação nova e não mexe no que já existe: só as skills que
 * ele **criou** entram no `public` e no catálogo `exemplos`, e só o `public`
 * que ele criou vira padrão. Antes, a skill privada de outra conta com o slug
 * de um exemplo ia parar no `public` aberto — legível por qualquer visitante.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada.
 * Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/seed.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) — mais
 * de uma vez nesta suíte: aponte para um banco descartável.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import {
  createSkill,
  createUser,
  createVirtualMcp,
  getCatalog,
  getSkillDetail,
  getSkillSummary,
  getVirtualMcp,
  resolveDefaultVirtualMcp,
  setDefaultVirtualMcp,
} from './queries.js';
import { runSeed } from './seed.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;

/** O mesmo número das outras suítes: ver `quarantine.integration.test.ts`. */
const SCHEMA_LOCK = 8_200_004;

/** Os cinco exemplos; o `rascunho-interno` é o que fica fora do `public`. */
const EXEMPLOS = [
  'commit-conventional',
  'code-review-checklist',
  'postgres-full-text-search',
  'dockerfile-node-multi-stage',
  'mcp-server-typescript',
  'rascunho-interno',
];

let raw: pg.Client;

/** Zera o schema e migra de novo: cada cenário parte de uma instalação vazia. */
async function bancoNovo(): Promise<void> {
  await closeDb();
  await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
  await raw.query('CREATE SCHEMA public');
  await runMigrations(url!);
}

/** Os slugs das skills que o vMCP vincula, em ordem. */
async function slugsDoMcp(slug: string): Promise<string[]> {
  const { rows } = await raw.query<{ slug: string }>(
    `SELECT s.slug FROM virtual_mcp_skills v
       JOIN virtual_mcps m ON m.uuid = v.virtual_mcp_uuid
       JOIN skills s ON s.uuid = v.skill_uuid
      WHERE m.slug = $1 ORDER BY s.slug`,
    [slug],
  );
  return rows.map((r) => r.slug);
}

async function slugsDoCatalogo(slug: string): Promise<string[]> {
  const { rows } = await raw.query<{ slug: string }>(
    `SELECT s.slug FROM catalog_skills cs
       JOIN catalogs c ON c.uuid = cs.catalog_uuid
       JOIN skills s ON s.uuid = cs.skill_uuid
      WHERE c.slug = $1 ORDER BY s.slug`,
    [slug],
  );
  return rows.map((r) => r.slug);
}

describe.skipIf(!url)('seed: só o que esta execução criou ganha vínculo', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);
    process.env.DATABASE_URL = url;
  }, 60_000);

  beforeEach(async () => {
    // O seed fala no console a cada passo; o teste não precisa ouvir.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await bancoNovo();
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('instalação vazia: cria tudo, vincula os exemplos e promove o public; a segunda passada não faz nada', async () => {
    const primeira = await runSeed();
    expect(primeira).toEqual({
      created: EXEMPLOS,
      createdPublicMcp: true,
      createdCatalog: true,
      madeDefault: true,
    });

    expect(await slugsDoMcp('public')).toEqual(
      EXEMPLOS.filter((s) => s !== 'rascunho-interno').sort(),
    );
    expect(await slugsDoCatalogo('exemplos')).toEqual([...EXEMPLOS].sort());
    const padrao = await resolveDefaultVirtualMcp();
    expect(padrao.status).toBe('ok');
    // A skill de exemplo sai no site; o rascunho, não.
    expect(await getSkillSummary('commit-conventional')).not.toBeNull();
    expect(await getSkillSummary('rascunho-interno')).toBeNull();

    const trilha = async () =>
      Number((await raw.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0]!.n);
    const antes = await trilha();

    expect(await runSeed()).toEqual({
      created: [],
      createdPublicMcp: false,
      createdCatalog: false,
      madeDefault: false,
    });
    expect(await trilha()).toBe(antes);
    expect(await slugsDoMcp('public')).toEqual(
      EXEMPLOS.filter((s) => s !== 'rascunho-interno').sort(),
    );
  }, 60_000);

  it('a skill privada de outra conta com o slug de um exemplo não entra no public nem no catálogo', async () => {
    const bruno = await createUser({
      username: 'bruno',
      email: 'bruno@exemplo.dev',
      name: 'Bruno',
      role: 'editor',
    });
    await createSkill(
      {
        slug: 'commit-conventional',
        name: 'Meu commit',
        skillMd: '# Segredo da equipe\n',
      },
      SOURCE,
      { userUuid: bruno.uuid, label: 'bruno' },
    );
    expect(await getSkillSummary('commit-conventional')).toBeNull();

    const resultado = await runSeed();
    expect(resultado.created).not.toContain('commit-conventional');
    expect(resultado.created).toHaveLength(EXEMPLOS.length - 1);
    expect(resultado.createdPublicMcp).toBe(true);

    // Continua invisível para o site, e sem vínculo nenhum.
    expect(await getSkillSummary('commit-conventional')).toBeNull();
    const ficha = (await getSkillDetail('commit-conventional', { visibility: 'all' }))!;
    expect(ficha.ownerUserUuid).toBe(bruno.uuid);
    expect(ficha.mcps).toEqual([]);
    expect(ficha.catalogs).toEqual([]);
    expect(ficha.skillMd).toBe('# Segredo da equipe\n');

    // Os outros exemplos entraram como sempre.
    expect(await slugsDoMcp('public')).toEqual(
      EXEMPLOS.filter((s) => s !== 'rascunho-interno' && s !== 'commit-conventional').sort(),
    );
    expect(await slugsDoCatalogo('exemplos')).toEqual(
      EXEMPLOS.filter((s) => s !== 'commit-conventional').sort(),
    );
  }, 60_000);

  it('um public que já existia não é tocado nem promovido a padrão', async () => {
    const bruno = await createUser({
      username: 'bruno',
      email: 'bruno@exemplo.dev',
      name: 'Bruno',
      role: 'editor',
    });
    const alheio = await createVirtualMcp(
      { slug: 'public', name: 'Do Bruno', isOpen: true, ownerUserUuid: bruno.uuid },
      SOURCE,
      { userUuid: bruno.uuid, label: 'bruno' },
    );
    // Uma instalação sem padrão escolhido: era aqui que o seed promovia o alheio.
    await setDefaultVirtualMcp(null, SOURCE, { userUuid: null, label: 'teste' });
    expect((await resolveDefaultVirtualMcp()).status).toBe('none');

    const resultado = await runSeed();
    expect(resultado.createdPublicMcp).toBe(false);
    expect(resultado.madeDefault).toBe(false);
    expect(resultado.created).toHaveLength(EXEMPLOS.length);

    expect((await resolveDefaultVirtualMcp()).status).toBe('none');
    expect(await slugsDoMcp('public')).toEqual([]);
    const depois = (await getVirtualMcp('public'))!;
    expect(depois.uuid).toBe(alheio.uuid);
    expect(depois.name).toBe('Do Bruno');
    expect(depois.updatedAt).toBe(alheio.updatedAt);

    // O catálogo nasce, com os exemplos que o seed criou — ele é privado e sem
    // vMCP, então não publica nada.
    expect((await getCatalog('exemplos'))?.isPublic).toBe(false);
    expect(await slugsDoCatalogo('exemplos')).toEqual([...EXEMPLOS].sort());
    expect(await getSkillSummary('commit-conventional')).toBeNull();
  }, 60_000);
});
