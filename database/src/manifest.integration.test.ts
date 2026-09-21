/**
 * Teste de integração do manifesto da extensão de skills do MCP (SEP-2640,
 * `docs/17-skills-extension.md`) — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/manifest.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import {
  addCatalogSkill,
  createCatalog,
  createSkill,
  createVirtualMcp,
  linkCatalog,
  linkSkill,
  listSkillsManifest,
  readSkillMdBodies,
  setFile,
  updateSkill,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;
const ATOR = { userUuid: null, label: 'manifesto' };

/** O mesmo número das outras suítes de integração: elas recriam o mesmo banco. */
const SCHEMA_LOCK = 8_200_004;

const TOOLS = { asSkill: true, asPrompt: false, asResource: false };
const NAO_TOOLS = { asSkill: false, asPrompt: true, asResource: true };
const UUID_INEXISTENTE = '00000000-0000-0000-0000-000000000000';

/** O corpo do `SKILL.md` de `alfa` — gravado sem frontmatter, como toda skill. */
const CORPO_ALFA = '# Alfa\n\nO corpo gravado, sem frontmatter.\n';

/**
 * Os anexos de `alfa`. `AAA.md` vem antes de `SKILL.md` em qualquer coleção
 * (é o que prova a régua `lower(relative_path) = 'skill.md'` primeiro, e não
 * um acaso de ordenação); `referencias/` tem multibyte, para o tamanho ser de
 * **bytes** e não de caracteres; e `assets/` é binário, do outro ramo do CHECK
 * de `files` — o hash do trigger da `020` cobre os dois.
 */
const ANEXOS: Record<string, Buffer> = {
  'AAA.md': Buffer.from('# Primeiro na ordem\n', 'utf8'),
  'referencias/exemplos.md': Buffer.from('Acentuação, cedilha e um emoji: 🟣\n', 'utf8'),
  'assets/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff]),
};

const hex = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

let raw: pg.Client;
let mcpUuid = '';
let outroUuid = '';
let alfaUuid = '';
let epsilonUuid = '';
let zetaUuid = '';
let orfaUuid = '';

describe.skipIf(!url)('manifesto da extensão de skills: recorte, inventário e corpos', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    await runMigrations(url!);
    // As queries resolvem a conexão por `getDb()`, que lê o ambiente na
    // primeira chamada — ainda não houve nenhuma até aqui.
    process.env.DATABASE_URL = url;

    mcpUuid = (
      await createVirtualMcp(
        { name: 'Servidor', slug: 'servidor', isOpen: true, ownerUserUuid: null },
        SOURCE,
        ATOR,
      )
    ).uuid;
    outroUuid = (
      await createVirtualMcp({ name: 'Outro', slug: 'outro', ownerUserUuid: null }, SOURCE, ATOR)
    ).uuid;

    // `alfa` é a skill completa: vínculo direto como ferramenta, tags fora de
    // ordem de propósito e os três anexos além do `SKILL.md`.
    alfaUuid = (
      await createSkill(
        {
          name: 'Alfa',
          slug: 'alfa',
          description: 'a completa',
          tags: ['zebra', 'alpha', 'meio'],
          skillMd: CORPO_ALFA,
          files: Object.entries(ANEXOS).map(([relativePath, content]) => ({
            relativePath,
            content,
          })),
        },
        SOURCE,
        ATOR,
      )
    ).uuid;
    await linkSkill('alfa', mcpUuid, TOOLS, SOURCE, ATOR);

    // `beta` está no servidor, mas por outras portas; `gama` está desligada;
    // `delta` é de outro servidor. Nenhuma das três entra no manifesto.
    await createSkill({ name: 'Beta', slug: 'beta', skillMd: '# beta\n' }, SOURCE, ATOR);
    await linkSkill('beta', mcpUuid, NAO_TOOLS, SOURCE, ATOR);
    await createSkill({ name: 'Gama', slug: 'gama', skillMd: '# gama\n' }, SOURCE, ATOR);
    await linkSkill('gama', mcpUuid, TOOLS, SOURCE, ATOR);
    await updateSkill('gama', { isActive: false }, SOURCE, ATOR);
    await createSkill({ name: 'Delta', slug: 'delta', skillMd: '# delta\n' }, SOURCE, ATOR);
    await linkSkill('delta', outroUuid, TOOLS, SOURCE, ATOR);

    // O caminho do catálogo: `epsilon` chega por ele; `zeta` também é membro,
    // mas tem vínculo direto sem `as_skill` — a precedência de `exposedIn` a
    // esconde mesmo com o catálogo ligado.
    epsilonUuid = (
      await createSkill({ name: 'Epsilon', slug: 'epsilon', skillMd: '# epsilon\n' }, SOURCE, ATOR)
    ).uuid;
    zetaUuid = (await createSkill({ name: 'Zeta', slug: 'zeta', skillMd: '# zeta\n' }, SOURCE, ATOR))
      .uuid;
    const grupo = await createCatalog({ name: 'Grupo', slug: 'grupo', ownerUserUuid: null }, SOURCE, ATOR);
    await addCatalogSkill(grupo.uuid, 'epsilon', SOURCE, ATOR);
    await addCatalogSkill(grupo.uuid, 'zeta', SOURCE, ATOR);
    await linkCatalog(mcpUuid, grupo.uuid, TOOLS, SOURCE, ATOR);
    await linkSkill('zeta', mcpUuid, NAO_TOOLS, SOURCE, ATOR);

    // `orfa` perde a linha do `SKILL.md` **por fora da API** — `deleteFile` a
    // recusa, e é justamente o estado que o manifesto precisa tolerar.
    orfaUuid = (await createSkill({ name: 'Orfa', slug: 'orfa', skillMd: '# orfa\n' }, SOURCE, ATOR))
      .uuid;
    await linkSkill('orfa', mcpUuid, TOOLS, SOURCE, ATOR);
    await raw.query("DELETE FROM files WHERE skill_uuid = $1 AND lower(relative_path) = 'skill.md'", [
      orfaUuid,
    ]);
  }, 120_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('o recorte é o de `as_skill` naquele vMCP, com a precedência do vínculo direto', async () => {
    const manifesto = await listSkillsManifest(mcpUuid);
    expect(manifesto.map((s) => s.slug)).toEqual(['alfa', 'epsilon', 'orfa']);

    // `beta` (só prompt/resource), `gama` (desligada) e `zeta` (vínculo direto
    // sem `as_skill`, apesar do catálogo) ficam de fora; `delta` é do outro.
    expect((await listSkillsManifest(outroUuid)).map((s) => s.slug)).toEqual(['delta']);
    expect(await listSkillsManifest(UUID_INEXISTENTE)).toEqual([]);
    expect(await listSkillsManifest('torto')).toEqual([]);

    const alfa = manifesto[0]!;
    expect(alfa.uuid).toBe(alfaUuid);
    expect(alfa.name).toBe('Alfa');
    expect(alfa.description).toBe('a completa');
    expect(new Date(alfa.updatedAt).toISOString()).toBe(alfa.updatedAt);

    // A skill que chega por catálogo vem igual à direta — o manifesto não
    // distingue o caminho.
    const epsilon = manifesto[1]!;
    expect(epsilon.uuid).toBe(epsilonUuid);
    expect(epsilon.tags).toEqual([]);
    expect(epsilon.files.map((f) => f.relativePath)).toEqual(['SKILL.md']);
  });

  it('`options.slug` recorta para uma skill só — ou nenhuma', async () => {
    expect((await listSkillsManifest(mcpUuid, { slug: 'alfa' })).map((s) => s.slug)).toEqual(['alfa']);
    expect((await listSkillsManifest(mcpUuid, { slug: 'epsilon' })).map((s) => s.slug)).toEqual([
      'epsilon',
    ]);
    // Exposta em outra porta, desligada, de outro servidor, escondida pelo
    // vínculo direto, ou inexistente: nenhuma delas vira entrada aqui.
    for (const slug of ['beta', 'gama', 'delta', 'zeta', 'nao-existe', '']) {
      expect(await listSkillsManifest(mcpUuid, { slug })).toEqual([]);
    }
  });

  it('as tags saem ordenadas por nome, e não na ordem em que as linhas existem', async () => {
    // O frontmatter composto é hasheado pelo servidor, e tag fora de ordem
    // faria o digest divergir do conteúdo entre duas chamadas (`docs/17` §5.2).
    // Pedir tags fora de ordem numa skill só **não** prova nada: `replaceTagsTx`
    // ordena os nomes antes de gravar (é como ele evita deadlock), e as linhas
    // de `tags` acabam com `id` em ordem alfabética. Para o `array_agg` sem
    // `ORDER BY` divergir é preciso que os `id` estejam fora de ordem — três
    // skills semeando uma tag cada, em ordem inversa, fazem isso: `tags.id` é
    // uuidv7, monotônico, e o agregado sem ordem sai na ordem das linhas.
    for (const tag of ['zulu', 'mike', 'alfa-tag']) {
      await createSkill({ name: `Semente ${tag}`, skillMd: '# semente\n', tags: [tag] }, SOURCE, ATOR);
    }
    await createSkill(
      { name: 'Teta', slug: 'teta', skillMd: '# teta\n', tags: ['zulu', 'mike', 'alfa-tag'] },
      SOURCE,
      ATOR,
    );
    await linkSkill('teta', outroUuid, TOOLS, SOURCE, ATOR);

    const [teta] = await listSkillsManifest(outroUuid, { slug: 'teta' });
    expect(teta!.tags).toEqual(['alfa-tag', 'mike', 'zulu']);

    const [alfa] = await listSkillsManifest(mcpUuid, { slug: 'alfa' });
    expect(alfa!.tags).toEqual(['alpha', 'meio', 'zebra']);
  });

  it('o inventário traz o SKILL.md primeiro e o sha256 dos bytes gravados', async () => {
    const [alfa] = await listSkillsManifest(mcpUuid, { slug: 'alfa' });
    expect(alfa!.files.map((f) => f.relativePath)).toEqual([
      'SKILL.md',
      'AAA.md',
      'assets/logo.png',
      'referencias/exemplos.md',
    ]);

    // O contrato de integridade inteiro: o hex publicado é o SHA-256 dos mesmos
    // bytes, calculado aqui em Node. Vale para o texto (inclusive multibyte) e
    // para o binário.
    const esperado: Record<string, Buffer> = { 'SKILL.md': Buffer.from(CORPO_ALFA, 'utf8'), ...ANEXOS };
    for (const file of alfa!.files) {
      const bytes = esperado[file.relativePath]!;
      expect([file.relativePath, file.sha256]).toEqual([file.relativePath, hex(bytes)]);
      expect([file.relativePath, file.sizeBytes]).toEqual([file.relativePath, bytes.byteLength]);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    // A skill sem linha de `SKILL.md` continua no manifesto, com o que tem.
    const [orfa] = await listSkillsManifest(mcpUuid, { slug: 'orfa' });
    expect(orfa!.files).toEqual([]);
  });

  it('readSkillMdBodies: lote, uuid torto, uuid inexistente e skill sem SKILL.md', async () => {
    expect(await readSkillMdBodies([])).toEqual([]);
    expect(await readSkillMdBodies(['torto'])).toEqual([]);
    expect(await readSkillMdBodies([UUID_INEXISTENTE])).toEqual([]);

    // Várias de uma vez, com um torto e um inexistente no meio: o que não tem
    // corpo simplesmente não volta — `orfa` perdeu a linha, `zeta` existe mas
    // não foi pedida.
    const corpos = await readSkillMdBodies([
      alfaUuid,
      'torto',
      epsilonUuid,
      orfaUuid,
      UUID_INEXISTENTE,
    ]);
    expect(new Map(corpos.map((c) => [c.skillUuid, c.body]))).toEqual(
      new Map([
        [alfaUuid, CORPO_ALFA],
        [epsilonUuid, '# epsilon\n'],
      ]),
    );

    // O corpo é o gravado, sem frontmatter: quem o remonta é o servidor.
    expect(corpos.find((c) => c.skillUuid === alfaUuid)?.body).not.toContain('---');

    // Uuid repetido não devolve duas linhas — o corpo é a parte cara.
    expect(await readSkillMdBodies([zetaUuid, zetaUuid, zetaUuid])).toEqual([
      { skillUuid: zetaUuid, body: '# zeta\n' },
    ]);
  });

  it('readSkillMdBodies fatia o lote acima do teto sem perder nem repetir skill', async () => {
    // 55 corpos: dois lotes (50 + 5). É onde um erro de fatiamento se esconde.
    const uuids: string[] = [];
    const esperado = new Map<string, string>();
    for (let i = 0; i < 55; i += 1) {
      const corpo = `# lote ${i}\n`;
      const skill = await createSkill({ name: `Lote ${i}`, skillMd: corpo }, SOURCE, ATOR);
      uuids.push(skill.uuid);
      esperado.set(skill.uuid, corpo);
    }

    const corpos = await readSkillMdBodies(uuids);
    expect(corpos.length).toBe(55);
    expect(new Map(corpos.map((c) => [c.skillUuid, c.body]))).toEqual(esperado);
  }, 120_000);

  it('`updatedAt` acompanha o SKILL.md — é a chave de cache do texto composto', async () => {
    const antes = (await listSkillsManifest(mcpUuid, { slug: 'alfa' }))[0]!;

    const novo = '# Alfa\n\nOutro corpo.\n';
    await setFile('alfa', 'SKILL.md', novo, SOURCE, ATOR);

    const depois = (await listSkillsManifest(mcpUuid, { slug: 'alfa' }))[0]!;
    expect(new Date(depois.updatedAt).getTime()).toBeGreaterThan(new Date(antes.updatedAt).getTime());
    expect(depois.files[0]!.relativePath).toBe('SKILL.md');
    expect(depois.files[0]!.sha256).toBe(hex(Buffer.from(novo, 'utf8')));
    expect(await readSkillMdBodies([alfaUuid])).toEqual([{ skillUuid: alfaUuid, body: novo }]);
  });
});
