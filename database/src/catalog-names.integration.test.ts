/**
 * Teste de integração do nome do catálogo no caminho da skill até o vMCP
 * (`tasks/027` da auditoria de 2026-11-07) — exige um PostgreSQL 18 real com
 * pgvector, porque aplica o schema inteiro.
 *
 * Em `mcps[].catalogs` da ficha da skill, lida com `viewer`, sai só o catálogo
 * público ou visto pela conta (`catalogSeenBy`) — a mesma régua da lista
 * `catalogs` da mesma ficha. O vínculo continua contando: o servidor aparece,
 * só o nome do catálogo fechado não. Em `'all'` (e admin) todos; no site, só
 * o público, como já era.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada.
 * Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/catalog-names.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import {
  createCatalog,
  createSkill,
  createUser,
  createVirtualMcp,
  getSkillDetail,
  getVirtualMcp,
  linkCatalog,
  setCatalogGrant,
  setCatalogSkills,
} from './queries.js';

type ReadOptions = NonNullable<Parameters<typeof getSkillDetail>[1]>;

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;

/** O mesmo número das outras suítes: ver `quarantine.integration.test.ts`. */
const SCHEMA_LOCK = 8_200_004;

const PORTAS = { asSkill: true, asPrompt: false, asResource: false };

let raw: pg.Client;

const ana = { userUuid: '', label: 'ana' };
const bruno = { userUuid: '', label: 'bruno' };

/** Os slugs nomeados em `mcps[].catalogs` do servidor `aberto`, para quem lê. */
async function nomeados(options: ReadOptions): Promise<{ direct: boolean; catalogs: string[] } | null> {
  const ficha = await getSkillDetail('roteiro', options);
  const mcp = ficha?.mcps.find((m) => m.slug === 'aberto');
  return mcp ? { direct: mcp.direct, catalogs: mcp.catalogs.map((c) => c.slug) } : null;
}

describe.skipIf(!url)('catálogo nomeado no caminho até o vMCP', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    await runMigrations(url!);
    process.env.DATABASE_URL = url;

    ana.userUuid = (await createUser({ username: 'ana', email: 'ana@exemplo.dev', name: 'Ana', role: 'editor' })).uuid;
    bruno.userUuid = (
      await createUser({ username: 'bruno', email: 'bruno@exemplo.dev', name: 'Bruno', role: 'membro' })
    ).uuid;

    // A skill é da Ana e privada; chega ao vMCP aberto por dois catálogos dela,
    // um privado e um público.
    await createSkill({ slug: 'roteiro', name: 'Roteiro', skillMd: '# Roteiro\n' }, SOURCE, ana);
    const privado = await createCatalog(
      { slug: 'privado-da-ana', name: 'Privado da Ana', ownerUserUuid: ana.userUuid },
      SOURCE,
      ana,
    );
    const publico = await createCatalog(
      { slug: 'publico-da-ana', name: 'Público da Ana', ownerUserUuid: ana.userUuid, isPublic: true },
      SOURCE,
      ana,
    );
    for (const catalogo of [privado, publico]) {
      await setCatalogSkills(catalogo.uuid, [{ slug: 'roteiro' }], SOURCE, ana);
    }
    const aberto = await createVirtualMcp(
      { slug: 'aberto', name: 'Aberto', isOpen: true, ownerUserUuid: ana.userUuid },
      SOURCE,
      ana,
    );
    await linkCatalog(aberto.uuid, privado.uuid, PORTAS, SOURCE, ana);
    await linkCatalog(aberto.uuid, publico.uuid, PORTAS, SOURCE, ana);
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('o viewer que não vê o catálogo privado não o lê nomeado; o vínculo continua contando', async () => {
    const viewer = { viewer: { role: 'membro' as const, userUuid: bruno.userUuid } };
    expect(await nomeados(viewer)).toEqual({ direct: false, catalogs: ['publico-da-ana'] });
    // A lista `catalogs` da mesma ficha usa a mesma régua.
    const ficha = (await getSkillDetail('roteiro', viewer))!;
    expect(ficha.catalogs.map((c) => c.slug)).toEqual(['publico-da-ana']);
  });

  it('a dona, o admin e a leitura all nomeiam os dois; o site, só o público', async () => {
    const ambos = { direct: false, catalogs: ['privado-da-ana', 'publico-da-ana'] };
    expect(await nomeados({ viewer: { role: 'editor', userUuid: ana.userUuid } })).toEqual(ambos);
    expect(await nomeados({ viewer: { role: 'admin', userUuid: null } })).toEqual(ambos);
    expect(await nomeados({ visibility: 'all' })).toEqual(ambos);
    expect(await nomeados({})).toEqual({ direct: false, catalogs: ['publico-da-ana'] });
  });

  it('com a concessão no catálogo privado, o viewer passa a lê-lo nomeado', async () => {
    await setCatalogGrant('privado-da-ana', bruno.userUuid, 'view', SOURCE, ana);
    expect(await nomeados({ viewer: { role: 'membro', userUuid: bruno.userUuid } })).toEqual({
      direct: false,
      catalogs: ['privado-da-ana', 'publico-da-ana'],
    });
  });

  it('a ficha do vMCP segue declarativa: lista os catálogos vinculados a quem vê o servidor', async () => {
    // Decisão registrada no database/README.md (Catálogos): o canvas salva a
    // lista inteira, e recortá-la apagaria o vínculo que a conta não vê.
    const carla = await createUser({ username: 'carla', email: 'carla@exemplo.dev', name: 'Carla', role: 'membro' });
    const ficha = (await getVirtualMcp('aberto', { viewer: { role: 'membro', userUuid: carla.uuid } }))!;
    expect(ficha.catalogs.map((c) => c.slug).sort()).toEqual(['privado-da-ana', 'publico-da-ana']);
  });
});
