/**
 * Teste de integração do **slug gerado**, da **paginação de skills** e da
 * **clonagem de skill** — exige um PostgreSQL 18 real, com pgvector (a busca
 * híbrida entra na conta).
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/skills.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { isValidSlug, slugify } from '@purple-skills/shared';
import { closeDb } from './client.js';
import type { AppError } from './errors.js';
import { runMigrations } from './migrate.js';
import {
  addCatalogSkill,
  cloneSkill,
  createCatalog,
  createSkill,
  createUser,
  createVirtualMcp,
  getSkillDetail,
  getSkillSummary,
  insertRagVectors,
  linkSkill,
  listAuditPage,
  listPendingRagTexts,
  listSkills,
  readAllFiles,
  replaceSkillTexts,
  resolveRagSpace,
  setSkillGrant,
  type ListOptions,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;
const ATOR = { userUuid: null, label: 'skills' };

/** O mesmo número das outras suítes de integração: elas recriam o mesmo banco. */
const SCHEMA_LOCK = 8_200_004;

/** O erro da chamada, ou `null` se ela passou — nunca rejeita. */
function outcome(promise: Promise<unknown>): Promise<AppError | null> {
  return promise.then(
    () => null,
    (err: unknown) => err as AppError,
  );
}

describe.skipIf(!url)('skills: slug gerado no teto, paginação com desempate e clonagem', () => {
  let lock: pg.Client;

  beforeAll(async () => {
    lock = new pg.Client({ connectionString: url });
    await lock.connect();
    await lock.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await lock.query('DROP SCHEMA IF EXISTS public CASCADE');
    await lock.query('CREATE SCHEMA public');

    await runMigrations(url!);
    process.env.DATABASE_URL = url;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await lock.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await lock.end();
  });

  describe('slug gerado perto do teto de 96 caracteres (tasks/035)', () => {
    // Perto do teto o desempate `-N` não cabe: `uniqueSlug` encurta a base, e o
    // candidato deixa de começar pelo slug desejado. A consulta de ocupados só
    // procurava `desejado-%`: não via o `…-2`, propunha-o de novo ao 3º homônimo,
    // e as três tentativas idênticas terminavam em 409 — para sempre.
    const criarSkill = (name: string) => createSkill({ name, skillMd: '# x' }, SOURCE, ATOR).then((s) => s.slug);

    it('três homônimos de nome longo: o terceiro recebe o próximo número, não 409', async () => {
      const nome = 'a'.repeat(200);
      const slugs = [await criarSkill(nome), await criarSkill(nome), await criarSkill(nome), await criarSkill(nome)];
      expect(slugs).toEqual(['a'.repeat(96), `${'a'.repeat(94)}-2`, `${'a'.repeat(94)}-3`, `${'a'.repeat(94)}-4`]);
      for (const slug of slugs) expect(isValidSlug(slug), slug).toBe(true);
    });

    it('base de 94 caracteres: a virada de -9 para -10, que é quando ela passa a ser encurtada', async () => {
      const nome = 'b'.repeat(94);
      const slugs: string[] = [];
      for (let i = 0; i < 12; i += 1) slugs.push(await criarSkill(nome));
      expect(new Set(slugs).size).toBe(12);
      expect(slugs.slice(8)).toEqual([`${nome}-9`, `${'b'.repeat(93)}-10`, `${'b'.repeat(93)}-11`, `${'b'.repeat(93)}-12`]);
      for (const slug of slugs) expect(isValidSlug(slug), slug).toBe(true);
    });

    it('dois nomes diferentes com os mesmos 94 primeiros caracteres dividem os desempates encurtados', async () => {
      const comum = 'c'.repeat(94);
      const slugs = [
        await criarSkill(`${comum}xx`),
        await criarSkill(`${comum}xx`), // ocupa o encurtado `…-2`
        await criarSkill(`${comum}yy`),
        await criarSkill(`${comum}yy`), // propunha o mesmo `…-2`, que já é do outro nome
      ];
      expect(new Set(slugs).size).toBe(4);
      for (const slug of slugs) expect(isValidSlug(slug), slug).toBe(true);
    });

    it('vale igual para MCP virtual e catálogo', async () => {
      const nome = 'd'.repeat(150);
      const mcps: string[] = [];
      const catalogos: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        mcps.push((await createVirtualMcp({ name: nome, ownerUserUuid: null }, SOURCE, ATOR)).slug);
        catalogos.push((await createCatalog({ name: nome, ownerUserUuid: null }, SOURCE, ATOR)).slug);
      }
      const esperado = ['d'.repeat(96), `${'d'.repeat(94)}-2`, `${'d'.repeat(94)}-3`];
      expect(mcps).toEqual(esperado);
      expect(catalogos).toEqual(esperado);
    });

    it('o caso comum não muda, e o slug pedido em uso continua sendo 409 com o próprio slug', async () => {
      expect([await criarSkill('Deploy Docker'), await criarSkill('Deploy Docker'), await criarSkill('Deploy Docker')]).toEqual([
        'deploy-docker',
        'deploy-docker-2',
        'deploy-docker-3',
      ]);
      // `deploy-docker-compose` começa por `deploy-docker-`: linha a mais na
      // consulta, e inofensiva — `uniqueSlug` só testa pertinência.
      expect(await criarSkill('Deploy Docker Compose')).toBe('deploy-docker-compose');
      expect(await criarSkill('Deploy Docker')).toBe('deploy-docker-4');

      expect(
        await outcome(createSkill({ name: 'Outra', slug: 'deploy-docker', skillMd: '# x' }, SOURCE, ATOR)),
      ).toMatchObject({ status: 409, message: 'Já existe uma skill com o slug "deploy-docker"' });
      const noTeto = 'a'.repeat(96);
      expect(await outcome(createSkill({ name: 'Outra', slug: noTeto, skillMd: '# x' }, SOURCE, ATOR))).toMatchObject({
        status: 409,
        message: `Já existe uma skill com o slug "${noTeto}"`,
      });
      expect(slugify('a'.repeat(200))).toBe(noTeto);
    });
  });

  describe('paginação: toda ordem termina em chave única (tasks/036)', () => {
    /** Percorre todas as páginas e devolve o que foi lido, na ordem, e o total anunciado. */
    async function folhear(options: ListOptions, limit: number): Promise<{ lidos: string[]; total: number }> {
      const lidos: string[] = [];
      let total = 0;
      for (let offset = 0; ; offset += limit) {
        const page = await listSkills({ ...options, visibility: 'all', limit, offset });
        total = page.total;
        lidos.push(...page.items.map((item) => item.slug));
        if (page.items.length < limit) break;
      }
      return { lidos, total };
    }

    beforeAll(async () => {
      // Um INSERT só: mesmo `updated_at` (o `now()` da transação), contadores em
      // zero e o mesmo nome em todas — empate em TODA ordenação. É o que um seed
      // ou uma importação em lote produz.
      await lock.query(
        `INSERT INTO skills (slug, name, description)
         SELECT 'empate-' || n, 'Orquídea empatada', 'a mesma descrição' FROM generate_series(1, 90) n`,
      );
    });

    it.each(['score', 'recent', 'name'] as const)('sort=%s: as páginas são uma partição do conjunto', async (sort) => {
      // Antes: em 60 páginas de 12 sobre linhas empatadas, só 481 de 720 slugs
      // eram distintos em `score`, 334 em `recent` e 371 em `name`.
      const { lidos, total } = await folhear({ sort }, 7);
      expect(lidos.length).toBe(total);
      expect(new Set(lidos).size).toBe(total);
    });

    it('relevance com ts_rank empatado: idem', async () => {
      const { lidos, total } = await folhear({ query: 'orquídea' }, 7);
      expect(total).toBe(90);
      expect(new Set(lidos).size).toBe(90);
    });

    it('busca híbrida: o rrf empata entre as pernas, e quem fecha a ordem é o uuid', async () => {
      // Um resultado só-texto na posição N e um só-vetor na posição N recebem o
      // mesmo `1/(60 + N)`. O teste que já existia (rag) dava `view_count`
      // distinto a cada linha e nunca chegava aqui. Ao contrário das quatro ordens
      // acima, aqui a repetição **não foi observada** antes do `s.uuid` — os
      // empates são só pares, e o top-N não os inverteu nesta massa; o que o
      // teste fixa é que o empate existe e que a partição vale com ele.
      await lock.query(
        `INSERT INTO skills (slug, name, description)
         SELECT 'vetor-' || n, 'Bromélia ' || n, 'sem o termo' FROM generate_series(1, 30) n`,
      );
      const space = await resolveRagSpace({
        driver: 'teste',
        model: 'desempate',
        dimensions: 3,
        documentPrefix: '',
        queryPrefix: '',
      });
      const vetoriais = await lock.query(`SELECT uuid, slug FROM skills WHERE slug LIKE 'vetor-%' ORDER BY slug`);
      for (const row of vetoriais.rows) {
        await replaceSkillTexts(row.uuid as string, [{ source: 'meta', content: `texto da ${row.slug as string}` }]);
      }
      const pendentes = await listPendingRagTexts(space.uuid, 100);
      expect(pendentes).toHaveLength(30);
      // Ângulos distintos: a perna vetorial tem 30 posições bem definidas.
      await insertRagVectors(
        space.uuid,
        pendentes.map((texto, i) => ({ sha256: texto.sha256, embedding: [1, (i + 1) / 40, 0] })),
      );

      const semantic = { spaceUuid: space.uuid, vector: [1, 0, 0], neighbors: 30 };
      // Página de 1: todo par empatado (posições 2k−1 e 2k) cai numa fronteira.
      const lidos: string[] = [];
      let total = 0;
      for (let offset = 0; offset < 60; offset += 1) {
        const page = await listSkills({ query: 'orquídea', semantic, visibility: 'all', limit: 1, offset });
        expect(page.mode).toBe('hybrid');
        total = page.total;
        lidos.push(...page.items.map((item) => item.slug));
      }
      // 90 que casam o texto + 30 vizinhos que não casam.
      expect(total).toBe(120);
      expect(new Set(lidos).size).toBe(60);
      // E os 30 vizinhos estão mesmo intercalados, empatados um a um com a perna
      // textual: as 60 primeiras posições são 30 de cada.
      expect(lidos.filter((slug) => slug.startsWith('vetor-'))).toHaveLength(30);
    });
  });

  // --------------------------------------------------- clonagem de skill ----

  describe('clonagem: a cópia nasce fechada, flutuante e com os arquivos', () => {
    /** Um PNG curto de verdade: bytes que não são UTF-8 válido. */
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    let donaUuid = '';
    let clonadorUuid = '';
    let fonteUuid = '';
    let copiaSlug = '';

    const dona = { userUuid: '', label: 'dona@exemplo.dev' };

    beforeAll(async () => {
      donaUuid = (await createUser({ email: 'dona@exemplo.dev', name: 'Dona', role: 'admin' })).uuid;
      clonadorUuid = (
        await createUser({ email: 'clonador@exemplo.dev', name: 'Clonador', role: 'editor' })
      ).uuid;
      dona.userUuid = donaUuid;

      // A fonte: pública, **desligada**, com ícone, tags, um anexo de texto e um
      // binário — e publicada num vMCP, num catálogo e compartilhada.
      const fonte = await createSkill(
        {
          name: 'Fonte da Cópia',
          slug: 'fonte-da-copia',
          skillMd: '# fonte\n\nCorpo da fonte.',
          icon: '🐘',
          isActive: false,
          isPublic: true,
          tags: ['zeta', 'alfa'],
          files: [
            { relativePath: 'docs/nota.md', content: 'olá' },
            { relativePath: 'img/logo.png', content: PNG },
          ],
        },
        SOURCE,
        dona,
      );
      fonteUuid = fonte.uuid;

      const servidor = await createVirtualMcp(
        { name: 'Servidor da Fonte', isOpen: true, ownerUserUuid: donaUuid },
        SOURCE,
        dona,
      );
      await linkSkill(
        'fonte-da-copia',
        servidor.uuid,
        { asSkill: true, asPrompt: false, asResource: true },
        SOURCE,
        dona,
      );
      const grupo = await createCatalog(
        { name: 'Grupo da Fonte', ownerUserUuid: donaUuid },
        SOURCE,
        dona,
      );
      await addCatalogSkill(grupo.uuid, 'fonte-da-copia', SOURCE, dona);
      await setSkillGrant('fonte-da-copia', clonadorUuid, 'edit', SOURCE, dona);
    }, 60_000);

    it('copia propriedades, arquivos e tags; nasce privada, flutuante, sem concessão e pendente de RAG', async () => {
      const original = await getSkillDetail('fonte-da-copia', { visibility: 'all' });
      expect(original?.mcps).toHaveLength(1);
      expect(original?.catalogs).toHaveLength(1);
      expect(original?.grants).toHaveLength(1);

      const copia = await cloneSkill(fonteUuid, { ownerUserUuid: clonadorUuid }, SOURCE, {
        userUuid: clonadorUuid,
        label: 'clonador@exemplo.dev',
      });
      copiaSlug = copia.slug;

      expect(copia).toMatchObject({
        // O desempate sai do slug do **original**, não do nome.
        slug: 'fonte-da-copia-2',
        name: 'Fonte da Cópia',
        description: '',
        icon: '🐘',
        // `is_active` vem como está; `is_public` **nunca** vem.
        isActive: false,
        isPublic: false,
        ownerUserUuid: clonadorUuid,
        ownerEmail: 'clonador@exemplo.dev',
        viewCount: 0,
        downloadCount: 0,
        tags: ['alfa', 'zeta'],
        skillMd: '# fonte\n\nCorpo da fonte.',
      });
      // Flutuante e sem concessão: o clone não entra em vMCP nem em catálogo,
      // e quem clonou é o dono — não há a quem conceder.
      expect(copia.mcps).toEqual([]);
      expect(copia.catalogs).toEqual([]);
      expect(copia.grants).toEqual([]);

      // Os arquivos vêm todos, com os bytes intactos e o hash recalculado.
      const arquivos = await readAllFiles(copia.uuid);
      expect(arquivos.map((f) => f.relativePath)).toEqual(['SKILL.md', 'docs/nota.md', 'img/logo.png']);
      expect(arquivos.find((f) => f.relativePath === 'img/logo.png')?.isText).toBe(false);
      expect(arquivos.find((f) => f.relativePath === 'img/logo.png')?.buffer.equals(PNG)).toBe(true);
      expect(arquivos.find((f) => f.relativePath === 'docs/nota.md')?.buffer.toString('utf8')).toBe('olá');

      const { rows } = await lock.query<{ hash: string; iguais: string; pendente: boolean }>(
        `SELECT encode(f.content_sha256, 'hex') AS hash,
                (SELECT count(*) FROM files o
                  WHERE o.skill_uuid = $2 AND o.relative_path = f.relative_path
                    AND o.content_sha256 = f.content_sha256)::text AS iguais,
                s.rag_stale AS pendente
           FROM files f JOIN skills s ON s.uuid = f.skill_uuid
          WHERE f.skill_uuid = $1 ORDER BY f.relative_path`,
        [copia.uuid, fonteUuid],
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.hash.length === 64 && r.iguais === '1')).toBe(true);
      expect(rows.every((r) => r.pendente)).toBe(true);

      // O criador acompanha o dono (a coluna não sai na ficha).
      const criador = await lock.query<{ c: string | null }>(
        'SELECT created_by_user_uuid AS c FROM skills WHERE uuid = $1',
        [copia.uuid],
      );
      expect(criador.rows[0]?.c).toBe(clonadorUuid);

      // Uma linha só na trilha, no objeto novo, com os dois lados no alvo.
      const trilha = await listAuditPage({ action: 'skill.clone' });
      expect(trilha.total).toBe(1);
      expect(trilha.items[0]).toMatchObject({
        skillSlug: 'fonte-da-copia-2',
        skillUuid: copia.uuid,
        targetLabel: 'fonte-da-copia -> fonte-da-copia-2',
        actorUserUuid: clonadorUuid,
        actorLabel: 'clonador@exemplo.dev',
        filePath: null,
      });
      // E nenhuma `create` da cópia: a clonagem não aparece duas vezes.
      expect(
        (await listAuditPage({ action: 'create', q: 'fonte-da-copia-2' })).total,
      ).toBe(0);
    });

    it('o segundo clone é -3; nome pedido não muda o desempate; sem conta a cópia nasce órfã', async () => {
      const terceira = await cloneSkill(fonteUuid, { name: '  Outro nome  ' }, SOURCE, {
        userUuid: null,
        label: 'token-global',
      });
      expect(terceira.slug).toBe('fonte-da-copia-3');
      expect(terceira.name).toBe('Outro nome');
      expect(terceira.ownerUserUuid).toBeNull();
      expect(terceira.ownerEmail).toBeNull();

      // Nome vazio é "o mesmo nome do original".
      const quarta = await cloneSkill(fonteUuid, { name: '   ' }, SOURCE, dona);
      expect(quarta.slug).toBe('fonte-da-copia-4');
      expect(quarta.name).toBe('Fonte da Cópia');
    });

    it('slug pedido: livre grava, ocupado é 409 e inválido é 400; uuid torto ou sumido é 404', async () => {
      const pedida = await cloneSkill(fonteUuid, { slug: 'copia-escolhida' }, SOURCE, dona);
      expect(pedida.slug).toBe('copia-escolhida');

      expect(await outcome(cloneSkill(fonteUuid, { slug: copiaSlug }, SOURCE, dona))).toMatchObject({
        status: 409,
        message: `Já existe uma skill com o slug "${copiaSlug}"`,
      });
      expect(await outcome(cloneSkill(fonteUuid, { slug: 'Com Espaço' }, SOURCE, dona))).toMatchObject({
        status: 400,
      });
      expect(await outcome(cloneSkill('torto', {}, SOURCE, dona))).toMatchObject({ status: 404 });
      expect(
        await outcome(cloneSkill('00000000-0000-0000-0000-000000000000', {}, SOURCE, dona)),
      ).toMatchObject({ status: 404 });
      // Dono que não existe é o mesmo 404 da criação.
      expect(
        await outcome(
          cloneSkill(fonteUuid, { ownerUserUuid: '00000000-0000-0000-0000-000000000000' }, SOURCE, dona),
        ),
      ).toMatchObject({ status: 404 });
      expect(await outcome(cloneSkill(fonteUuid, { ownerUserUuid: 'torto' }, SOURCE, dona))).toMatchObject({
        status: 404,
      });

      // Nenhuma recusa deixou linha na trilha nem skill pela metade.
      expect((await listAuditPage({ action: 'skill.clone' })).total).toBe(4);
      expect(await getSkillSummary('com-espaco', { visibility: 'all' })).toBeNull();
    });
  });
});
