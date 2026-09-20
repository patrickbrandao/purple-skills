/**
 * Teste de integração do RAG (`schema/020-rag.sql`, `docs/14-rag.md` §5 e
 * §8) — exige um PostgreSQL 18 real **com pgvector**.
 *
 * Cobre os 29 cenários da §5.5, cada um marcado pelo número no nome do teste,
 * mais o que a §5.5 registra como *não verificado*: o recorte de visibilidade
 * **real** (`visibilityClause`) dentro da consulta híbrida — uma skill de um
 * vMCP fechado não pode aparecer na busca de outro servidor nem no site.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/rag.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations, schemaDir } from './migrate.js';
import { AppError } from './errors.js';
import {
  RAG_CLAIM_MAX_ATTEMPTS,
  claimStaleSkills,
  clearRagRefusals,
  collectOrphanRagTexts,
  createSkill,
  createVirtualMcp,
  deleteFile,
  deleteSkill,
  findRagSpace,
  getRagSettings,
  insertRagVectors,
  linkSkill,
  listAuditPage,
  listPendingRagTexts,
  listSkills,
  markAllSkillsStale,
  markRagTextRefused,
  ragCoverage,
  ragSchemaReady,
  readSkillForRag,
  releaseRagTextReservations,
  releaseStaleSkill,
  replaceSkillTexts,
  resolveRagSpace,
  seedRagSetting,
  setFile,
  setRagIndexerStatus,
  setRagSetting,
  updateSkill,
  type RagSpace,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;
/** Quem assina o que a suíte cria — não é uma conta, como o bootstrap. */
const ACTOR = { userUuid: null, label: 'teste' };

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

/** O espaço da v1: `gemini-embedding-2` em 3072 dimensões, com os dois prefixos. */
const DIMS = 3072;
const GOOGLE = {
  driver: 'google',
  model: 'gemini-embedding-2',
  dimensions: DIMS,
  documentPrefix: 'title: none | text: ',
  queryPrefix: 'task: search result | query: ',
};

const TOOLS = { asSkill: true, asPrompt: false, asResource: false };

let raw: pg.Client;
let espaco: RagSpace;
let legadaUuid = '';
let legadaUpdatedAt = '';

/**
 * Aplica `schema/*.sql` até o número dado, como o runner faria numa base
 * daquela época — inclusive registrando em `schema_migrations`.
 */
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

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

/**
 * O nome da constraint violada. O Drizzle embrulha a falha do `pg` num
 * `DrizzleQueryError` cuja mensagem é só "Failed query: …": quem carrega
 * `constraint` é o erro do driver, lá embaixo em `cause`.
 */
async function constraintDe(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    let atual = err as { constraint?: string; cause?: unknown } | undefined;
    for (let i = 0; atual && i < 5; i += 1) {
      if (typeof atual.constraint === 'string') return atual.constraint;
      atual = atual.cause as { constraint?: string; cause?: unknown } | undefined;
    }
    return (err as Error).message;
  }
  throw new Error('a chamada deveria ter falhado');
}

/** O SHA-256 do texto canônico, como o indexador o calcula em TypeScript. */
function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/**
 * Um vetor de 3072 dimensões com peso nas posições escolhidas — a distância
 * do cosseno entre eles é previsível: `{0:1}` contra `{0:1}` é 0, contra
 * `{0:0.8, 1:0.6}` é 0.2 e contra `{1:1}` é 1.
 */
function vetor(pesos: Record<number, number>, dims = DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const [i, peso] of Object.entries(pesos)) v[Number(i)] = peso;
  return v;
}

async function pendente(slug: string): Promise<boolean> {
  const { rows } = await raw.query<{ rag_stale: boolean }>(
    'SELECT rag_stale FROM skills WHERE slug = $1',
    [slug],
  );
  return rows[0]!.rag_stale;
}

/** Marca a skill como limpa por fora, como o indexador faria ao reservá-la. */
async function limpar(slug: string): Promise<void> {
  await raw.query('UPDATE skills SET rag_stale = false WHERE slug = $1', [slug]);
}

async function conta(texto: string, params: unknown[] = []): Promise<number> {
  const { rows } = await raw.query<{ n: string }>(texto, params);
  return Number(rows[0]?.n ?? 0);
}

async function uuidDe(slug: string): Promise<string> {
  const { rows } = await raw.query<{ uuid: string }>('SELECT uuid FROM skills WHERE slug = $1', [
    slug,
  ]);
  return rows[0]!.uuid;
}

describe.skipIf(!url)('RAG: pendência, textos canônicos, espaços, vetores e busca híbrida', () => {
  beforeAll(async () => {
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await raw.query('DROP SCHEMA IF EXISTS public CASCADE');
    await raw.query('CREATE SCHEMA public');

    // Uma base parada no `019`, com uma skill que tem texto e binário: é o que
    // o backfill da `020` precisa migrar sem tocar em `updated_at` (cenário 02).
    await applyUpTo(raw, '019');
    legadaUuid = (
      await raw.query<{ uuid: string }>(
        `INSERT INTO skills (slug, name, description)
         VALUES ('legada', 'Legada', 'criada antes do RAG') RETURNING uuid`,
      )
    ).rows[0]!.uuid;
    await raw.query(
      `INSERT INTO files (skill_uuid, relative_path, text_content, mime_type, size_bytes)
       VALUES ($1, 'SKILL.md', '# legada', 'text/markdown', 8)`,
      [legadaUuid],
    );
    await raw.query(
      `INSERT INTO files (skill_uuid, relative_path, binary_content, mime_type, size_bytes)
       VALUES ($1, 'logo.png', '\\x89504e470d0a1a0a'::bytea, 'image/png', 8)`,
      [legadaUuid],
    );
    legadaUpdatedAt = (
      await raw.query<{ updated_at: Date }>('SELECT updated_at FROM skills WHERE uuid = $1', [
        legadaUuid,
      ])
    ).rows[0]!.updated_at.toISOString();

    // Cenário 01, primeira metade: a `020` aplicada pelo runner, numa base com
    // dados — ela e tudo o que a pasta traz depois, lido da pasta: uma lista
    // escrita à mão quebra a cada migration nova, de quem quer que seja.
    const depoisDo019 = readdirSync(schemaDir())
      .filter((file) => file.endsWith('.sql') && file.slice(0, 3) > '019')
      .sort();
    expect(depoisDo019[0]).toBe('020-rag.sql');
    expect(await runMigrations(url!)).toEqual(depoisDo019);
    // As queries resolvem a conexão por `getDb()`, que lê o ambiente na
    // primeira chamada — ainda não houve nenhuma até aqui.
    process.env.DATABASE_URL = url;

    espaco = await resolveRagSpace(GOOGLE);
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  // ------------------------------------------------- hash e pendência ------

  describe('o hash do arquivo e os triggers de pendência', () => {
    it('02 — o backfill dá hash a todo arquivo, deixa a skill pendente e não toca updated_at', async () => {
      const { rows } = await raw.query<{
        relative_path: string;
        content_sha256: Buffer;
        updated_at: Date;
      }>(
        `SELECT f.relative_path, f.content_sha256, s.updated_at
           FROM files f JOIN skills s ON s.uuid = f.skill_uuid
          WHERE f.skill_uuid = $1 ORDER BY f.relative_path`,
        [legadaUuid],
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.content_sha256).toHaveLength(32);
      // A ordenação "recentes" do site não pode mudar por causa do backfill.
      expect(rows[0]!.updated_at.toISOString()).toBe(legadaUpdatedAt);

      // Toda skill nasce pendente — inclusive a que já existia.
      expect(await pendente('legada')).toBe(true);

      // O hash do banco é o mesmo de `node:crypto` (o do indexador).
      const md = rows.find((r) => r.relative_path === 'SKILL.md')!;
      expect(md.content_sha256.equals(sha256('# legada'))).toBe(true);
      // E o binário é hasheado pelos bytes, não por texto.
      const png = rows.find((r) => r.relative_path === 'logo.png')!;
      expect(png.content_sha256.equals(createHash('sha256').update(Buffer.from('89504e470d0a1a0a', 'hex')).digest())).toBe(true);
    });

    it('03 — o hash do arquivo não pode ser coluna gerada: o Postgres recusa a expressão', async () => {
      await expect(
        raw.query(
          `ALTER TABLE files ADD COLUMN gerado BYTEA
             GENERATED ALWAYS AS (sha256(convert_to(text_content, 'UTF8'))) STORED`,
        ),
      ).rejects.toThrow(/not immutable/);
    });

    it('04 e 05 — skill nova nasce pendente; incremento de contador não marca', async () => {
      await createSkill({ name: 'Trigger', slug: 'trigger', skillMd: '# trigger' }, SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(true);

      await limpar('trigger');
      await raw.query(
        'UPDATE skills SET view_count = view_count + 1, download_count = download_count + 2 WHERE slug = $1',
        ['trigger'],
      );
      expect(await pendente('trigger')).toBe(false);
    });

    it('06 — mudar a descrição (que entra no texto de metadados) marca', async () => {
      await updateSkill('trigger', { description: 'uma descrição nova' }, SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(true);

      // Mudar só o ícone não mexe em nada que o RAG leia.
      await limpar('trigger');
      await updateSkill('trigger', { icon: '🧪' }, SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(false);
    });

    it('07, 08 e 09 — arquivo de texto marca; binário não; UPDATE sem mudança não marca', async () => {
      await limpar('trigger');
      await setFile('trigger', 'guia.md', 'conteúdo', SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(true);

      await limpar('trigger');
      await setFile('trigger', 'logo.png', Buffer.from('89504e470d0a1a0a', 'hex'), SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(false);

      // O `setFile` grava o mesmo conteúdo de novo: o trigger enxerga hash e
      // caminho iguais e não marca.
      await setFile('trigger', 'guia.md', 'conteúdo', SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(false);
    });

    it('09b — o mesmo conteúdo trocando de binário para texto (e de volta) marca (027)', async () => {
      // Uma linha de antes da beta.22, quando `.ini` não estava na tabela de
      // mime e ia para `binary_content`. A tabela de hoje já não produz esse
      // estado, por isso o SQL cru.
      const conteudo = '[a]\nb=1\n';
      await raw.query(
        `INSERT INTO files (skill_uuid, relative_path, binary_content, mime_type, size_bytes)
         SELECT uuid, 'app.ini', convert_to($2::text, 'UTF8'), 'application/octet-stream',
                octet_length(convert_to($2::text, 'UTF8'))
           FROM skills WHERE slug = $1`,
        ['trigger', conteudo],
      );
      const hash = async () =>
        (
          await raw.query<{ h: string }>(
            `SELECT encode(f.content_sha256, 'hex') AS h
               FROM files f JOIN skills s ON s.uuid = f.skill_uuid
              WHERE s.slug = 'trigger' AND f.relative_path = 'app.ini'`,
          )
        ).rows[0]!.h;
      const comoBinario = await hash();
      await limpar('trigger');

      // O operador reenvia o mesmo arquivo, e hoje o upsert o grava como texto.
      // Hash dos bytes e caminho são os mesmos — era o atalho que saía antes de
      // olhar o tipo, e o arquivo nunca entrava na busca semântica.
      await setFile('trigger', 'app.ini', conteudo, SOURCE, ACTOR);
      expect(await hash()).toBe(comoBinario);
      expect(await pendente('trigger')).toBe(true);
      expect((await readSkillForRag(await uuidDe('trigger')))?.files.map((f) => f.relativePath)).toContain(
        'app.ini',
      );

      // O sentido contrário: deixou de ser texto sem mudar de conteúdo. A linha é
      // atualizada, não apagada, então a cascata das ocorrências não dispara — só
      // a pendência tira as partes do arquivo do índice.
      await limpar('trigger');
      await raw.query(
        `UPDATE files SET binary_content = convert_to(text_content, 'UTF8'), text_content = NULL
          WHERE relative_path = 'app.ini'
            AND skill_uuid = (SELECT uuid FROM skills WHERE slug = $1)`,
        ['trigger'],
      );
      expect(await hash()).toBe(comoBinario);
      expect(await pendente('trigger')).toBe(true);

      // Binário regravado igual continua sem marcar: o atalho segue valendo
      // quando o tipo **não** muda.
      await limpar('trigger');
      await raw.query(
        `UPDATE files SET mime_type = 'application/x-ini'
          WHERE relative_path = 'app.ini'
            AND skill_uuid = (SELECT uuid FROM skills WHERE slug = $1)`,
        ['trigger'],
      );
      expect(await pendente('trigger')).toBe(false);

      await raw.query(
        `DELETE FROM files WHERE relative_path = 'app.ini'
          AND skill_uuid = (SELECT uuid FROM skills WHERE slug = $1)`,
        ['trigger'],
      );
    });

    it('10 — mudar o conteúdo do SKILL.md marca', async () => {
      await limpar('trigger');
      await setFile('trigger', 'SKILL.md', '# trigger v2', SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(true);
    });

    it('11 — incluir e remover tag marcam, porque as tags entram nos metadados', async () => {
      await limpar('trigger');
      await updateSkill('trigger', { tags: ['git'] }, SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(true);

      await limpar('trigger');
      await updateSkill('trigger', { tags: [] }, SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(true);
    });

    it('apagar um arquivo de texto marca; apagar o binário não', async () => {
      await limpar('trigger');
      await deleteFile('trigger', 'logo.png', SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(false);

      await deleteFile('trigger', 'guia.md', SOURCE, ACTOR);
      expect(await pendente('trigger')).toBe(true);
    });
  });

  // ------------------------------------------- textos canônicos e hash -----

  describe('os textos canônicos', () => {
    it('12 e 29a — o banco recusa um texto guardado sob o hash de outro conteúdo', async () => {
      await expect(
        raw.query(
          `INSERT INTO rag_texts (sha256, content)
           VALUES (sha256(convert_to('outro texto', 'UTF8')), 'texto')`,
        ),
      ).rejects.toThrow(/rag_texts_sha256_chk/);

      // O prefixo do driver nunca é gravado: o texto com prefixo não bate com
      // o hash do canônico.
      await expect(
        raw.query(`INSERT INTO rag_texts (sha256, content) VALUES ($1, $2)`, [
          sha256('versionar commits'),
          `${GOOGLE.documentPrefix}versionar commits`,
        ]),
      ).rejects.toThrow(/rag_texts_sha256_chk/);
    });

    it('13 e 29b — duas skills com o mesmo SKILL.md dão um hash só, igual ao do arquivo', async () => {
      const texto = '# igual\n\nO mesmo conteúdo nas duas.';
      await createSkill({ name: 'Gêmea A', slug: 'gemea-a', skillMd: texto }, SOURCE, ACTOR);
      await createSkill({ name: 'Gêmea B', slug: 'gemea-b', skillMd: texto }, SOURCE, ACTOR);

      const a = (await readSkillForRag(await uuidDe('gemea-a')))!;
      const b = (await readSkillForRag(await uuidDe('gemea-b')))!;
      const md = (s: typeof a) => s.files.find((f) => f.relativePath === 'SKILL.md')!;
      // O arquivo curto vai inteiro: o hash do arquivo é o do texto canônico.
      expect(md(a).sha256.equals(sha256(texto))).toBe(true);
      expect(md(b).sha256.equals(md(a).sha256)).toBe(true);

      expect(
        await replaceSkillTexts(a.uuid, [
          { source: 'file', relativePath: 'SKILL.md', part: 0, fileId: md(a).id, content: texto },
        ]),
      ).toBe(1);
      expect(
        await replaceSkillTexts(b.uuid, [
          { source: 'file', relativePath: 'SKILL.md', part: 0, fileId: md(b).id, content: texto },
        ]),
      ).toBe(1);

      // Uma linha em `rag_texts` para as duas ocorrências.
      expect(
        await conta('SELECT count(*) AS n FROM rag_texts WHERE sha256 = $1', [sha256(texto)]),
      ).toBe(1);
      expect(
        await conta('SELECT count(*) AS n FROM rag_skill_texts WHERE text_sha256 = $1', [
          sha256(texto),
        ]),
      ).toBe(2);
    });

    it('replaceSkillTexts é declarativa: reescreve a lista inteira e recusa entrada torta', async () => {
      const uuid = await uuidDe('gemea-a');
      expect(await replaceSkillTexts(uuid, [{ source: 'meta', content: 'Gêmea A' }])).toBe(1);
      expect(
        await conta('SELECT count(*) AS n FROM rag_skill_texts WHERE skill_uuid = $1', [uuid]),
      ).toBe(1);
      const { rows } = await raw.query<{ source: string; relative_path: string; part: number }>(
        'SELECT source, relative_path, part FROM rag_skill_texts WHERE skill_uuid = $1',
        [uuid],
      );
      expect(rows[0]).toMatchObject({ source: 'meta', relative_path: '', part: 0 });

      expect((await capture(replaceSkillTexts(uuid, [{ source: 'meta', content: '   ' }]))).status).toBe(400);
      expect(
        (await capture(replaceSkillTexts(uuid, [{ source: 'file', content: 'x' }]))).status,
      ).toBe(400);
      expect(
        (
          await capture(
            replaceSkillTexts(uuid, [
              { source: 'meta', content: 'a' },
              { source: 'meta', content: 'b' },
            ]),
          )
        ).status,
      ).toBe(400);
      expect((await capture(replaceSkillTexts('nao-e-uuid', []))).status).toBe(400);
      expect(
        (await capture(replaceSkillTexts('00000000-0000-0000-0000-000000000000', []))).status,
      ).toBe(404);

      // A recusa não apagou o que já estava lá.
      expect(
        await conta('SELECT count(*) AS n FROM rag_skill_texts WHERE skill_uuid = $1', [uuid]),
      ).toBe(1);
    });
  });

  // -------------------------------------------------------- os espaços -----

  describe('os espaços de embedding', () => {
    it('25 — resolver a mesma identidade duas vezes devolve o mesmo uuid', async () => {
      const outra = await resolveRagSpace({ ...GOOGLE });
      expect(outra.uuid).toBe(espaco.uuid);
      expect(await conta('SELECT count(*) AS n FROM rag_spaces WHERE driver = $1', ['google'])).toBe(1);
      expect((await findRagSpace(GOOGLE))!.uuid).toBe(espaco.uuid);
      expect(await findRagSpace({ ...GOOGLE, model: 'outro-modelo' })).toBeNull();
    });

    it('24 — trocar o prefixo de documento ou o de consulta cria outro espaço', async () => {
      const outroDoc = await resolveRagSpace({ ...GOOGLE, documentPrefix: 'title: none | texto: ' });
      const outraQuery = await resolveRagSpace({ ...GOOGLE, queryPrefix: 'task: retrieval | query: ' });
      expect(outroDoc.uuid).not.toBe(espaco.uuid);
      expect(outraQuery.uuid).not.toBe(espaco.uuid);
      expect(outroDoc.uuid).not.toBe(outraQuery.uuid);
      // O espaço antigo continua inteiro: trocar o prefixo não apaga nada.
      expect((await findRagSpace(GOOGLE))!.uuid).toBe(espaco.uuid);

      await raw.query('DELETE FROM rag_spaces WHERE uuid = ANY($1)', [
        [outroDoc.uuid, outraQuery.uuid],
      ]);
    });

    it('26 e 27 — prefixo é obrigatório, cabe em 200 caracteres e pode ser vazio', async () => {
      await expect(
        raw.query(
          `INSERT INTO rag_spaces (driver, model, dimensions) VALUES ('x', 'y', 8)`,
        ),
      ).rejects.toThrow(/document_prefix/);
      expect(
        (await capture(resolveRagSpace({ ...GOOGLE, documentPrefix: undefined as never }))).status,
      ).toBe(400);

      await expect(
        raw.query(
          `INSERT INTO rag_spaces (driver, model, dimensions, document_prefix, query_prefix)
           VALUES ('x', 'y', 8, repeat('a', 201), '')`,
        ),
      ).rejects.toThrow(/rag_spaces_prefix_length_chk/);
      expect(
        (await capture(resolveRagSpace({ ...GOOGLE, queryPrefix: 'q'.repeat(201) }))).status,
      ).toBe(400);

      // Driver que não escreve a tarefa no texto: os dois prefixos vazios.
      const semPrefixo = await resolveRagSpace({
        driver: 'fake',
        model: 'fake-8',
        dimensions: 8,
        documentPrefix: '',
        queryPrefix: '',
      });
      expect(semPrefixo.documentPrefix).toBe('');
      await raw.query('DELETE FROM rag_spaces WHERE uuid = $1', [semPrefixo.uuid]);

      // Dimensão precisa ser inteiro positivo.
      expect((await capture(resolveRagSpace({ ...GOOGLE, dimensions: 0 }))).status).toBe(400);
      await expect(
        raw.query(
          `INSERT INTO rag_spaces (driver, model, dimensions, document_prefix, query_prefix)
           VALUES ('x', 'y', 0, '', '')`,
        ),
      ).rejects.toThrow(/dimensions/);
    });
  });

  // -------------------------------------------------------- os vetores -----

  describe('os vetores', () => {
    const texto = 'texto com vetor';

    beforeAll(async () => {
      const uuid = await uuidDe('trigger');
      await replaceSkillTexts(uuid, [{ source: 'meta', content: texto }]);
    });

    it('14 — vetor com dimensão diferente da do espaço é recusado pelo CHECK', async () => {
      expect(
        await constraintDe(
          insertRagVectors(espaco.uuid, [
            { sha256: sha256(texto), embedding: vetor({ 0: 1 }, 1536) },
          ]),
        ),
      ).toBe('rag_vectors_dimensions_chk');
      expect(
        await conta('SELECT count(*) AS n FROM rag_vectors WHERE text_sha256 = $1', [sha256(texto)]),
      ).toBe(0);
    });

    it('15 — a dimensão não pode divergir do espaço; o vetor certo entra', async () => {
      // Só o SQL cru chega aqui: `insertRagVectors` copia `dimensions` do espaço.
      await expect(
        raw.query(
          `INSERT INTO rag_vectors (space_uuid, dimensions, text_sha256, embedding)
           VALUES ($1, 1536, $2, $3::vector)`,
          [espaco.uuid, sha256(texto), JSON.stringify(vetor({ 0: 1 }, 1536))],
        ),
      ).rejects.toThrow(/rag_vectors_space_fk/);

      expect(
        await insertRagVectors(espaco.uuid, [{ sha256: sha256(texto), embedding: vetor({ 0: 1 }) }]),
      ).toBe(1);
      const { rows } = await raw.query<{ dimensions: number }>(
        'SELECT dimensions FROM rag_vectors WHERE text_sha256 = $1',
        [sha256(texto)],
      );
      expect(rows[0]!.dimensions).toBe(DIMS);

      // Regravar o mesmo vetor é inofensivo, e espaço inexistente não grava nada.
      expect(
        await insertRagVectors(espaco.uuid, [{ sha256: sha256(texto), embedding: vetor({ 0: 1 }) }]),
      ).toBe(0);
      expect(
        await insertRagVectors('00000000-0000-0000-0000-000000000000', [
          { sha256: sha256(texto), embedding: vetor({ 0: 1 }) },
        ]),
      ).toBe(0);
      expect((await capture(insertRagVectors('torto', []))).status).toBe(400);
      expect(
        (await capture(insertRagVectors(espaco.uuid, [{ sha256: sha256(texto), embedding: [] }])))
          .status,
      ).toBe(400);
    });

    it('28 — o mesmo texto em dois espaços que só diferem no prefixo: um texto, dois vetores', async () => {
      const outro = await resolveRagSpace({ ...GOOGLE, queryPrefix: 'task: clustering | query: ' });
      expect(
        await insertRagVectors(outro.uuid, [{ sha256: sha256(texto), embedding: vetor({ 1: 1 }) }]),
      ).toBe(1);

      expect(
        await conta('SELECT count(*) AS n FROM rag_texts WHERE sha256 = $1', [sha256(texto)]),
      ).toBe(1);
      expect(
        await conta('SELECT count(*) AS n FROM rag_vectors WHERE text_sha256 = $1', [sha256(texto)]),
      ).toBe(2);

      // 18 — apagar um espaço leva só os vetores dele.
      await raw.query('DELETE FROM rag_spaces WHERE uuid = $1', [outro.uuid]);
      expect(
        await conta('SELECT count(*) AS n FROM rag_vectors WHERE text_sha256 = $1', [sha256(texto)]),
      ).toBe(1);
      expect(
        await conta('SELECT count(*) AS n FROM rag_texts WHERE sha256 = $1', [sha256(texto)]),
      ).toBe(1);
    });

    it('23 — HNSW não aceita 3072 dimensões; a busca exata funciona sem índice', async () => {
      await expect(
        raw.query(
          `CREATE INDEX rag_vectors_hnsw_idx ON rag_vectors
             USING hnsw ((embedding::vector(3072)) vector_cosine_ops)`,
        ),
      ).rejects.toThrow(/2000 dimensions/);

      // A saída, se um dia o volume pedir índice: `halfvec` cabe em 4000.
      await raw.query(
        `CREATE INDEX rag_vectors_halfvec_idx ON rag_vectors
           USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops) WHERE dimensions = 3072`,
      );
      await raw.query('DROP INDEX rag_vectors_halfvec_idx');

      const { rows } = await raw.query<{ dist: number }>(
        'SELECT (embedding <=> $1::vector) AS dist FROM rag_vectors WHERE text_sha256 = $2',
        [JSON.stringify(vetor({ 0: 1 })), sha256(texto)],
      );
      expect(Number(rows[0]!.dist)).toBeCloseTo(0, 6);
    });
  });

  // ---------------------------------------- cobertura e busca híbrida ------

  describe('a cobertura e a busca híbrida', () => {
    let abertoUuid = '';
    let fechadoUuid = '';

    beforeAll(async () => {
      // Quatro skills públicas e uma fechada, todas com "commits" no texto —
      // menos a que só a perna vetorial acha.
      await createSkill(
        {
          name: 'Commits convencionais',
          slug: 'busca-dupla',
          skillMd: '# commits convencionais',
          isPublic: true,
        },
        SOURCE,
        ACTOR,
      );
      await createSkill(
        { name: 'Commits semânticos', slug: 'busca-texto', skillMd: '# commits', isPublic: true },
        SOURCE,
        ACTOR,
      );
      await createSkill(
        {
          name: 'Versionamento de mensagens',
          slug: 'busca-vetor',
          skillMd: '# versionamento',
          isPublic: true,
        },
        SOURCE,
        ACTOR,
      );
      await createSkill(
        {
          name: 'Commits desligados',
          slug: 'busca-desligada',
          skillMd: '# commits',
          isPublic: true,
          isActive: false,
        },
        SOURCE,
        ACTOR,
      );
      await createSkill(
        { name: 'Commits privados', slug: 'busca-fechada', skillMd: '# commits' },
        SOURCE,
        ACTOR,
      );

      abertoUuid = (
        await createVirtualMcp({ name: 'Aberto', isOpen: true, ownerUserUuid: null }, SOURCE, ACTOR)
      ).uuid;
      fechadoUuid = (
        await createVirtualMcp({ name: 'Fechado', isOpen: false, ownerUserUuid: null }, SOURCE, ACTOR)
      ).uuid;
      await linkSkill('busca-dupla', abertoUuid, TOOLS, SOURCE, ACTOR);
      await linkSkill('busca-fechada', fechadoUuid, TOOLS, SOURCE, ACTOR);

      // Os textos e os vetores: a consulta é `{0:1}`.
      const comVetor: [string, string, Record<number, number>][] = [
        ['busca-dupla', 'como padronizar mensagens de commit', { 0: 1 }],
        ['busca-vetor', 'como versionar o histórico do repositório', { 0: 0.8, 1: 0.6 }],
        ['busca-desligada', 'mensagens de commit desligadas', { 0: 1 }],
        ['busca-fechada', 'mensagens de commit privadas', { 0: 1 }],
      ];
      for (const [slug, conteudo, pesos] of comVetor) {
        await replaceSkillTexts(await uuidDe(slug), [{ source: 'meta', content: conteudo }]);
        await insertRagVectors(espaco.uuid, [
          { sha256: sha256(conteudo), embedding: vetor(pesos) },
        ]);
      }
      // `busca-texto` tem ocorrência e nenhum vetor: é o texto pendente.
      await replaceSkillTexts(await uuidDe('busca-texto'), [
        { source: 'meta', content: 'commits semânticos sem vetor' },
      ]);
    });

    it('16 e 18 — cobertura parcial e completa, texto órfão de fora, e apagar o espaço', async () => {
      const parcial = await ragCoverage(espaco.uuid);
      expect(parcial.texts).toBe(parcial.withVector + parcial.pendingTexts);
      expect(parcial.pendingTexts).toBeGreaterThan(0);
      expect(parcial.staleSkills).toBeGreaterThan(0);

      const pendentes = await listPendingRagTexts(espaco.uuid, 100);
      expect(pendentes).toHaveLength(parcial.pendingTexts);
      // `busca-texto` tem ocorrência e nenhum vetor: é o que falta embutir.
      const semVetor = pendentes.find((t) => t.content === 'commits semânticos sem vetor')!;
      expect(semVetor.sha256.equals(sha256('commits semânticos sem vetor'))).toBe(true);

      // Texto sem ocorrência nenhuma: não é buscável e não entra na conta.
      await raw.query(
        `INSERT INTO rag_texts (sha256, content) VALUES (sha256(convert_to($1, 'UTF8')), $1)`,
        ['texto órfão'],
      );
      expect(await ragCoverage(espaco.uuid)).toMatchObject({ texts: parcial.texts });
      expect((await listPendingRagTexts(espaco.uuid, 100)).map((t) => t.content)).not.toContain(
        'texto órfão',
      );

      // Um espaço novo começa vazio — é também o caso do driver desligado.
      const novo = await resolveRagSpace({ ...GOOGLE, model: 'gemini-embedding-3' });
      expect(await ragCoverage(novo.uuid)).toMatchObject({
        texts: parcial.texts,
        withVector: 0,
        pendingTexts: parcial.texts,
      });
      expect(await ragCoverage(null)).toMatchObject({ withVector: 0 });

      // Embutir tudo nele fecha a cobertura: 100%, 0 pendentes.
      const lote = await listPendingRagTexts(novo.uuid, 500);
      expect(
        await insertRagVectors(
          novo.uuid,
          lote.map((texto) => ({ sha256: texto.sha256, embedding: vetor({ 5: 1 }) })),
        ),
      ).toBe(lote.length);
      expect(await ragCoverage(novo.uuid)).toMatchObject({
        texts: parcial.texts,
        withVector: parcial.texts,
        pendingTexts: 0,
      });
      expect(await listPendingRagTexts(novo.uuid, 100)).toEqual([]);

      // 18 — apagar o espaço leva só os vetores dele; textos e ocorrências ficam.
      await raw.query('DELETE FROM rag_spaces WHERE uuid = $1', [novo.uuid]);
      expect(await conta('SELECT count(*) AS n FROM rag_vectors WHERE space_uuid = $1', [novo.uuid])).toBe(0);
      expect(await ragCoverage(espaco.uuid)).toMatchObject({
        texts: parcial.texts,
        withVector: parcial.withVector,
      });
    });

    it('17 — a fusão põe em primeiro quem vem das duas pernas, e o total é o conjunto fundido', async () => {
      const semantic = { spaceUuid: espaco.uuid, vector: vetor({ 0: 1 }) };
      const texto = await listSkills({ query: 'commits', visibility: 'open' });
      expect(texto.mode).toBe('text');
      expect(texto.neighbors).toEqual([]);
      expect(texto.items.map((s) => s.slug).sort()).toEqual(['busca-dupla', 'busca-texto']);

      const hibrida = await listSkills({ query: 'commits', visibility: 'open', semantic });
      expect(hibrida.mode).toBe('hybrid');
      // A skill das duas pernas vem primeiro.
      expect(hibrida.items[0]!.slug).toBe('busca-dupla');
      // A que só a perna vetorial acha entra; a desligada fica fora das duas.
      expect(hibrida.items.map((s) => s.slug).sort()).toEqual([
        'busca-dupla',
        'busca-texto',
        'busca-vetor',
      ]);
      // O total é o tamanho do conjunto fundido, não o da perna textual.
      expect(hibrida.total).toBe(3);

      // As distâncias saem fora de `items`: elas vão para o log, não para o cliente.
      const porSlug = Object.fromEntries(hibrida.neighbors.map((n) => [n.slug, n.distance]));
      expect(porSlug['busca-dupla']).toBeCloseTo(0, 6);
      expect(porSlug['busca-vetor']).toBeCloseTo(0.2, 6);
      expect(porSlug['busca-texto']).toBeUndefined();
      expect(hibrida.items[0]).not.toHaveProperty('distance');
    });

    it('17 — a paginação e o total continuam de pé sobre o conjunto fundido', async () => {
      const semantic = { spaceUuid: espaco.uuid, vector: vetor({ 0: 1 }) };
      const primeira = await listSkills({ query: 'commits', visibility: 'open', semantic, limit: 1 });
      expect(primeira).toMatchObject({ total: 3, limit: 1, offset: 0, mode: 'hybrid' });
      expect(primeira.items).toHaveLength(1);

      const ultima = await listSkills({
        query: 'commits',
        visibility: 'open',
        semantic,
        limit: 1,
        offset: 2,
      });
      expect(ultima).toMatchObject({ total: 3, offset: 2 });
      expect(ultima.items).toHaveLength(1);
      expect(ultima.items[0]!.slug).not.toBe(primeira.items[0]!.slug);

      // Paginar além do fim não zera o total: a página não traz linha nenhuma,
      // e é só nesse caso que a contagem volta a ser uma consulta à parte.
      const vazia = await listSkills({
        query: 'commits',
        visibility: 'open',
        semantic,
        limit: 1,
        offset: 9,
      });
      expect(vazia).toMatchObject({ total: 3 });
      expect(vazia.items).toEqual([]);

      // Conjunto fundido vazio (termo que não casa e espaço sem vetor nenhum):
      // o mesmo caminho da página vazia, e o total é 0, não `undefined`.
      const vazio = await resolveRagSpace({ ...GOOGLE, model: 'gemini-embedding-4' });
      const nada = await listSkills({
        query: 'zzznaoexiste',
        visibility: 'open',
        semantic: { spaceUuid: vazio.uuid, vector: vetor({ 0: 1 }) },
      });
      expect(nada).toMatchObject({ total: 0, mode: 'hybrid' });
      expect(nada.items).toEqual([]);
      expect(nada.neighbors).toEqual([]);
      await raw.query('DELETE FROM rag_spaces WHERE uuid = $1', [vazio.uuid]);

      // Sem termo não há o que fundir: a opção é ignorada e o modo é textual.
      const listagem = await listSkills({ visibility: 'open', semantic });
      expect(listagem.mode).toBe('text');

      // Ordenar por nome reordena o conjunto fundido, sem mudar quem entrou.
      const porNome = await listSkills({
        query: 'commits',
        visibility: 'open',
        semantic,
        sort: 'name',
      });
      expect(porNome.items.map((s) => s.name)).toEqual([
        'Commits convencionais',
        'Commits semânticos',
        'Versionamento de mensagens',
      ]);

      // Espaço torto ou vetor que não é lista de números é bug do chamador.
      expect(
        (await capture(listSkills({ query: 'commits', semantic: { spaceUuid: 'x', vector: [1] } })))
          .status,
      ).toBe(400);
      expect(
        (
          await capture(
            listSkills({
              query: 'commits',
              semantic: { spaceUuid: espaco.uuid, vector: ['a'] as never },
            }),
          )
        ).status,
      ).toBe(400);
    });

    it('o recorte de visibilidade real vale nas duas pernas: o vMCP fechado não vaza', async () => {
      const semantic = { spaceUuid: espaco.uuid, vector: vetor({ 0: 1 }) };
      // `busca-fechada` tem o vetor idêntico ao da consulta e casa no texto:
      // se o recorte falhasse numa das pernas, ela viria em primeiro.
      const site = await listSkills({ query: 'commits', visibility: 'open', semantic });
      expect(site.items.map((s) => s.slug)).not.toContain('busca-fechada');
      expect(site.neighbors.map((n) => n.slug)).not.toContain('busca-fechada');

      const noAberto = await listSkills({
        query: 'commits',
        semantic,
        virtualMcp: { uuid: abertoUuid, surface: 'skill' },
      });
      expect(noAberto.items.map((s) => s.slug)).toEqual(['busca-dupla']);
      expect(noAberto.total).toBe(1);

      // No servidor dela, a mesma skill aparece — o recorte não é censura.
      const noFechado = await listSkills({
        query: 'commits',
        semantic,
        virtualMcp: { uuid: fechadoUuid, surface: 'skill' },
      });
      expect(noFechado.items.map((s) => s.slug)).toEqual(['busca-fechada']);

      // E o admin vê tudo, inclusive a desligada e a privada. (Sem corte por
      // distância, a perna vetorial também traz as skills de teste que têm
      // vetor — por isso a conferência é por inclusão.)
      const admin = await listSkills({ query: 'commits', visibility: 'all', semantic, limit: 100 });
      expect(admin.items.map((s) => s.slug)).toEqual(
        expect.arrayContaining([
          'busca-desligada',
          'busca-dupla',
          'busca-fechada',
          'busca-texto',
          'busca-vetor',
        ]),
      );

      // O filtro de tag também vale nas duas pernas.
      await updateSkill('busca-vetor', { tags: ['git'] }, SOURCE, ACTOR);
      const porTag = await listSkills({ query: 'commits', visibility: 'open', semantic, tag: 'git' });
      expect(porTag.items.map((s) => s.slug)).toEqual(['busca-vetor']);
      expect(porTag.total).toBe(1);
    });

    it('a perna textual entra inteira: o total e a paginação passam de 100', async () => {
      // 120 skills com o mesmo termo — mais do que o teto de 100 que a perna
      // textual tinha. Insert direto porque aqui só interessa o volume.
      await raw.query(
        `INSERT INTO skills (slug, name, description, is_public, is_active, view_count)
         SELECT 'muitas-' || n, 'Rebase interativo ' || n, 'reescreve o histórico', true, true, n
           FROM generate_series(1, 120) n`,
      );
      const semantic = { spaceUuid: espaco.uuid, vector: vetor({ 0: 1 }) };
      const texto = await listSkills({ query: 'rebase', visibility: 'open', limit: 1 });
      expect(texto.total).toBe(120);

      // Nenhum vizinho casa em "rebase": o conjunto fundido é a perna textual
      // **inteira** mais os vizinhos visíveis, e não 100 + `neighbors`.
      const soVizinhos = await listSkills({ query: 'zzznaoexiste', visibility: 'open', semantic });
      const hibrida = await listSkills({ query: 'rebase', visibility: 'open', semantic, limit: 1 });
      expect(hibrida.total).toBe(texto.total + soVizinhos.total);
      expect(hibrida.total).toBeGreaterThan(100);

      // A página que o teto deixava vazia traz linha, e a última fecha no total.
      const funda = await listSkills({
        query: 'rebase',
        visibility: 'open',
        semantic,
        limit: 10,
        offset: 110,
      });
      expect(funda.items).toHaveLength(10);
      expect(funda.total).toBe(hibrida.total);
      const ultima = await listSkills({
        query: 'rebase',
        visibility: 'open',
        semantic,
        limit: 10,
        offset: hibrida.total - 2,
      });
      expect(ultima.items).toHaveLength(2);

      // Duas páginas cobrem o conjunto sem repetir nem pular ninguém.
      const p1 = await listSkills({ query: 'rebase', visibility: 'open', semantic, limit: 100 });
      const p2 = await listSkills({
        query: 'rebase',
        visibility: 'open',
        semantic,
        limit: 100,
        offset: 100,
      });
      const slugs = new Set([...p1.items, ...p2.items].map((s) => s.slug));
      expect(slugs.size).toBe(hibrida.total);

      await raw.query(`DELETE FROM skills WHERE slug LIKE 'muitas-%'`);
    });

    it('o termo é literal: `%`, `_` e `\\` não são curinga no ILIKE das duas buscas', async () => {
      // Três skills com os caracteres no texto e três de controle, que só
      // apareceriam se o curinga valesse.
      await raw.query(
        `INSERT INTO skills (slug, name, description, is_public, is_active) VALUES
           ('curinga-pct',  'Desconto de 50% à vista', 'teto do limite',      true, true),
           ('curinga-sub',  'Guia de snake_case',      'nomes de coluna',     true, true),
           ('curinga-barra','Escape de barra',         'grava a' || chr(92) || 'b', true, true),
           ('controle-tudo','Pauta da reunião',        'nada de especial',    true, true),
           ('controle-x',   'Guia de snakeXcase',      'nomes de coluna',     true, true),
           ('controle-ab',  'Escape de nada',          'grava ab',            true, true)`,
      );
      const semantic = { spaceUuid: espaco.uuid, vector: vetor({ 0: 1 }) };
      const busca = async (query: string) =>
        (await listSkills({ query, visibility: 'open', limit: 200 })).items.map((s) => s.slug);

      // `%` sozinho casava o acervo inteiro; agora casa o caractere `%`.
      const acervo = await listSkills({ visibility: 'open', limit: 200 });
      expect(acervo.total).toBeGreaterThan(6);
      expect(await busca('%')).toEqual(['curinga-pct']);
      expect(await busca('50%')).toEqual(['curinga-pct']);

      // `_` é um caractere, não "qualquer um": `snakeXcase` fica fora.
      expect(await busca('snake_case')).toEqual(['curinga-sub']);

      // `\` é um caractere, não o escape: sem escapar, `%a\b%` procuraria
      // "ab" e traria `controle-ab`.
      expect(await busca('a\\b')).toEqual(['curinga-barra']);

      // A perna textual da híbrida é a mesma: só os vizinhos entram além dela.
      const soVizinhos = await listSkills({ query: 'zzznaoexiste', visibility: 'open', semantic });
      const hibrida = await listSkills({ query: '50%', visibility: 'open', semantic, limit: 200 });
      expect(hibrida.mode).toBe('hybrid');
      expect(hibrida.total).toBe(1 + soVizinhos.total);
      expect(hibrida.items.map((s) => s.slug)).toContain('curinga-pct');
      expect(hibrida.items.map((s) => s.slug)).not.toContain('controle-tudo');

      // Termo legítimo não muda: caixa, acento e palavra parcial seguem casando.
      expect(await busca('DESCONTO')).toEqual(['curinga-pct']);
      expect(await busca('reunião')).toEqual(['controle-tudo']);
      expect(await busca('sconto de 50')).toEqual(['curinga-pct']);

      await raw.query(
        `DELETE FROM skills WHERE slug LIKE 'curinga-%' OR slug LIKE 'controle-%'`,
      );
    });
  });

  // ------------------------------------------------------- as cascatas -----

  describe('as cascatas e o que é protegido', () => {
    it('19 — apagar skill que compartilha texto leva só as ocorrências dela', async () => {
      const compartilhado = sha256('# igual\n\nO mesmo conteúdo nas duas.');
      const uuidB = await uuidDe('gemea-b');
      await insertRagVectors(espaco.uuid, [{ sha256: compartilhado, embedding: vetor({ 2: 1 }) }]);

      await deleteSkill('gemea-b', SOURCE, ACTOR);
      expect(
        await conta('SELECT count(*) AS n FROM rag_skill_texts WHERE skill_uuid = $1', [uuidB]),
      ).toBe(0);
      // O texto e o vetor ficam: outra skill ainda os usa, e a limpeza de
      // órfãos é assunto de outra migration.
      expect(
        await conta('SELECT count(*) AS n FROM rag_texts WHERE sha256 = $1', [compartilhado]),
      ).toBe(1);
      expect(
        await conta('SELECT count(*) AS n FROM rag_vectors WHERE text_sha256 = $1', [compartilhado]),
      ).toBe(1);
    });

    it('19 — texto em uso não pode ser apagado', async () => {
      const uuid = await uuidDe('busca-dupla');
      await replaceSkillTexts(uuid, [
        { source: 'meta', content: 'como padronizar mensagens de commit' },
      ]);
      await expect(
        raw.query('DELETE FROM rag_texts WHERE sha256 = $1', [
          sha256('como padronizar mensagens de commit'),
        ]),
      ).rejects.toThrow(/rag_skill_texts/);
    });

    it('20 — apagar um arquivo leva as ocorrências dele na hora', async () => {
      await createSkill(
        { name: 'Com anexo', slug: 'com-anexo', skillMd: '# com anexo' },
        SOURCE,
        ACTOR,
      );
      await setFile('com-anexo', 'guia.md', 'o guia', SOURCE, ACTOR);
      const skill = (await readSkillForRag(await uuidDe('com-anexo')))!;
      const guia = skill.files.find((f) => f.relativePath === 'guia.md')!;
      await replaceSkillTexts(skill.uuid, [
        { source: 'meta', content: 'Com anexo' },
        { source: 'file', relativePath: 'guia.md', part: 0, fileId: guia.id, content: 'o guia' },
      ]);
      expect(
        await conta('SELECT count(*) AS n FROM rag_skill_texts WHERE skill_uuid = $1', [skill.uuid]),
      ).toBe(2);

      await deleteFile('com-anexo', 'guia.md', SOURCE, ACTOR);
      const { rows } = await raw.query<{ source: string }>(
        'SELECT source FROM rag_skill_texts WHERE skill_uuid = $1',
        [skill.uuid],
      );
      expect(rows.map((r) => r.source)).toEqual(['meta']);
    });
  });

  // -------------------------------------------- a fila do indexador --------

  describe('a fila do indexador', () => {
    const fila = ['fila-1', 'fila-2', 'fila-3', 'fila-4'];

    beforeAll(async () => {
      for (const slug of fila) {
        await createSkill({ name: slug, slug, skillMd: `# ${slug}` }, SOURCE, ACTOR);
      }
    });

    it('21 — a reserva entrega o lote pedido e a rodada seguinte pega os próximos', async () => {
      // Só as quatro da fila ficam pendentes, na ordem de `updated_at`.
      await raw.query('UPDATE skills SET rag_stale = false WHERE rag_stale');
      await raw.query('UPDATE skills SET rag_stale = true WHERE slug = ANY($1)', [fila]);

      const primeira = await claimStaleSkills(2);
      expect(primeira).toHaveLength(2);
      const segunda = await claimStaleSkills(2);
      expect(segunda).toHaveLength(2);
      expect(new Set([...primeira, ...segunda]).size).toBe(4);
      expect(await claimStaleSkills(2)).toEqual([]);

      // Reservar marca como limpa **antes** de o indexador ler; a falha devolve.
      await releaseStaleSkill(primeira[0]!);
      expect(await claimStaleSkills(5)).toEqual([primeira[0]]);
      await releaseStaleSkill('nao-e-uuid');
      expect(await claimStaleSkills(5)).toEqual([]);
    });

    it('22 — dois indexadores em transações paralelas pegam lotes diferentes', async () => {
      await raw.query('UPDATE skills SET rag_stale = true WHERE slug = ANY($1)', [fila]);

      // O mesmo SQL de `claimStaleSkills`, em duas transações abertas ao mesmo
      // tempo: é o `SKIP LOCKED` que impede a segunda de esperar (ou de pegar
      // as mesmas linhas). A forma com `IN (… LIMIT …)` sem CTE materializada
      // reservou mais do que o lote numa validação anterior — por isso a CTE.
      const RESERVA = `
        WITH reservadas AS MATERIALIZED (
          SELECT uuid FROM skills WHERE rag_stale ORDER BY updated_at, uuid LIMIT 2
            FOR UPDATE SKIP LOCKED
        )
        UPDATE skills s SET rag_stale = false FROM reservadas r
         WHERE s.uuid = r.uuid RETURNING s.uuid`;

      const a = new pg.Client({ connectionString: url });
      const b = new pg.Client({ connectionString: url });
      await a.connect();
      await b.connect();
      try {
        await a.query('BEGIN');
        await b.query('BEGIN');
        const loteA = (await a.query<{ uuid: string }>(RESERVA)).rows.map((r) => r.uuid);
        const loteB = (await b.query<{ uuid: string }>(RESERVA)).rows.map((r) => r.uuid);
        await a.query('COMMIT');
        await b.query('COMMIT');

        expect(loteA).toHaveLength(2);
        expect(loteB).toHaveLength(2);
        expect(new Set([...loteA, ...loteB]).size).toBe(4);
      } finally {
        await a.end();
        await b.end();
      }
      expect(await claimStaleSkills(10)).toEqual([]);
    });

    // ------------------------------------- a reserva com prazo (028) -------

    /** A reserva gravada da skill, ou `null`. */
    async function reserva(uuid: string): Promise<{ attempts: number; viva: boolean } | null> {
      const { rows } = await raw.query<{ attempts: number; viva: boolean }>(
        'SELECT attempts, until > now() AS viva FROM rag_skill_claims WHERE skill_uuid = $1',
        [uuid],
      );
      return rows[0] ?? null;
    }

    /** O indexador morreu: as reservas dele ficam para trás e o prazo passa. */
    async function vencer(uuids: string[]): Promise<void> {
      await raw.query(
        `UPDATE rag_skill_claims SET until = now() - interval '1 second' WHERE skill_uuid = ANY($1)`,
        [uuids],
      );
    }

    /** Só as skills dadas ficam pendentes, e ninguém tem reserva. */
    async function partida(slugs: string[]): Promise<void> {
      await raw.query('DELETE FROM rag_skill_claims');
      await raw.query('UPDATE skills SET rag_stale = false WHERE rag_stale');
      await raw.query('UPDATE skills SET rag_stale = true WHERE slug = ANY($1)', [slugs]);
    }

    it('a reserva é gravada com prazo; terminar e devolver a baixam', async () => {
      await partida(['fila-1', 'fila-2']);
      const [a, b] = await claimStaleSkills(5);
      expect(await claimStaleSkills(5)).toEqual([]);

      // Dez minutos por padrão, e `claimMs` passa pelo mesmo clamp de `reserveMs`.
      const { rows } = await raw.query<{ padrao: boolean }>(
        `SELECT bool_and(until BETWEEN now() + interval '9 minutes' AND now() + interval '10 minutes')
                AS padrao FROM rag_skill_claims`,
      );
      expect(rows[0]!.padrao).toBe(true);
      expect(await reserva(a!)).toEqual({ attempts: 0, viva: true });

      // `rag_stale` já é falso nas duas — era aqui que o lote de um indexador
      // morto virava "0 skills a refatiar" no painel.
      expect(await conta('SELECT count(*) AS n FROM skills WHERE rag_stale')).toBe(0);
      expect((await ragCoverage(null)).staleSkills).toBe(2);

      // Ler é começar (soma a tentativa); gravar é terminar (baixa a reserva).
      await readSkillForRag(a!);
      expect(await reserva(a!)).toEqual({ attempts: 1, viva: true });
      await replaceSkillTexts(a!, []);
      expect(await reserva(a!)).toBeNull();
      expect((await ragCoverage(null)).staleSkills).toBe(1);

      // Devolver baixa a reserva **e** remarca: a rodada seguinte pega, sem
      // esperar o prazo.
      await readSkillForRag(b!);
      await releaseStaleSkill(b!);
      expect(await reserva(b!)).toBeNull();
      expect(await claimStaleSkills(5)).toEqual([b]);
      expect(await reserva(b!)).toEqual({ attempts: 0, viva: true });

      // Ler sem reserva (um relatório, um teste) não escreve nada.
      await readSkillForRag(a!);
      expect(await reserva(a!)).toBeNull();

      expect((await capture(claimStaleSkills(5, { claimMs: -1 }))).status).toBe(400);
    });

    it('indexador morto não estaciona a fila: a reserva vencida volta, a viva não', async () => {
      await partida(['fila-1', 'fila-2', 'fila-3']);
      const lote = await claimStaleSkills(5);
      expect(lote).toHaveLength(3);

      // kill -9 depois da primeira: uma terminada, uma lida pela metade, uma
      // que nem foi aberta. Nenhuma devolução rodou.
      await readSkillForRag(lote[0]!);
      await replaceSkillTexts(lote[0]!, []);
      await readSkillForRag(lote[1]!);

      // Dentro do prazo ninguém as retoma: pode haver um indexador vivo nelas.
      expect(await claimStaleSkills(5)).toEqual([]);
      expect((await ragCoverage(null)).staleSkills).toBe(2);

      // Vencido o prazo elas voltam, mesmo com `rag_stale = false` — e a que
      // nunca foi aberta vem **antes** da que já derrubou alguém uma vez.
      await vencer(lote);
      await raw.query("UPDATE skills SET rag_stale = true WHERE slug = 'fila-4'");
      const retomadas = await claimStaleSkills(5);
      expect(retomadas).toEqual([await uuidDe('fila-4'), lote[2], lote[1]]);
      expect(await reserva(lote[1]!)).toEqual({ attempts: 1, viva: true });
      expect(await reserva(lote[2]!)).toEqual({ attempts: 0, viva: true });
    });

    it('a skill que derruba o indexador para de voltar no teto de tentativas, e aparece como travada', async () => {
      await partida(['fila-1']);
      const [venenosa] = await claimStaleSkills(5);

      for (let vez = 1; vez <= RAG_CLAIM_MAX_ATTEMPTS; vez += 1) {
        // Lê, o processo morre, o prazo passa.
        await readSkillForRag(venenosa!);
        await vencer([venenosa!]);
        if (vez < RAG_CLAIM_MAX_ATTEMPTS) {
          expect((await ragCoverage(null)).stuckSkills).toBe(0);
          expect(await claimStaleSkills(5)).toEqual([venenosa]);
        }
      }

      // No teto ela deixa de ser retomada — e **aparece**, em vez de sumir.
      expect(await reserva(venenosa!)).toEqual({ attempts: RAG_CLAIM_MAX_ATTEMPTS, viva: false });
      expect(await claimStaleSkills(5)).toEqual([]);
      expect(await ragCoverage(null)).toMatchObject({ staleSkills: 1, stuckSkills: 1 });

      // Conteúdo novo (o trigger) é uma chance nova, e a conta recomeça.
      await setFile('fila-1', 'notas.md', 'agora cabe', SOURCE, ACTOR);
      expect(await claimStaleSkills(5)).toEqual([venenosa]);
      expect(await reserva(venenosa!)).toEqual({ attempts: 0, viva: true });
      expect((await ragCoverage(null)).stuckSkills).toBe(0);
      await replaceSkillTexts(venenosa!, []);
      await deleteFile('fila-1', 'notas.md', SOURCE, ACTOR);
    });

    it('reserva viva segura a skill que o trigger remarcou: um indexador por skill', async () => {
      await partida(['fila-2']);
      const [emCurso] = await claimStaleSkills(5);

      // Alguém edita a skill enquanto ela é refatiada. Sem a reserva, a réplica
      // vizinha a pegava aqui, lia a versão nova, e a mais lenta das duas
      // gravava a antiga por cima.
      await setFile('fila-2', 'notas.md', 'editada no meio do caminho', SOURCE, ACTOR);
      expect(await pendente('fila-2')).toBe(true);
      expect(await claimStaleSkills(5)).toEqual([]);

      // Terminou: a baixa libera, e a pendência que o trigger deixou a traz de
      // volta na rodada seguinte.
      await replaceSkillTexts(emCurso!, []);
      expect(await claimStaleSkills(5)).toEqual([emCurso]);
      await replaceSkillTexts(emCurso!, []);
      await deleteFile('fila-2', 'notas.md', SOURCE, ACTOR);
    });

    it('duas réplicas não retomam a mesma reserva vencida, e a statement não espera por linha travada', async () => {
      await partida(fila);
      const lote = await claimStaleSkills(10);
      expect(lote).toHaveLength(4);
      await vencer(lote);

      // Em paralelo, as duas chamadas repartem as vencidas sem repetir.
      const [a, b] = await Promise.all([claimStaleSkills(2), claimStaleSkills(2)]);
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(2);
      expect(new Set([...a, ...b]).size).toBe(4);

      // Uma transação alheia segura a linha de uma skill (é o que `setFiles` faz
      // pelo trigger): a reserva pula a linha em vez de esperar — esperar por
      // linha de `skills` é como se fecha ciclo com quem grava arquivo.
      await vencer(lote);
      const alheia = new pg.Client({ connectionString: url });
      await alheia.connect();
      try {
        await alheia.query('BEGIN');
        await alheia.query('SELECT 1 FROM skills WHERE uuid = $1 FOR UPDATE', [lote[0]]);
        const semEspera = await claimStaleSkills(10);
        expect(semEspera).toHaveLength(3);
        expect(semEspera).not.toContain(lote[0]);
        await alheia.query('COMMIT');
      } finally {
        await alheia.end();
      }
      expect(await claimStaleSkills(10)).toEqual([lote[0]]);

      // Apagar a skill leva a reserva junto: não sobra nada para retomar.
      await createSkill({ name: 'fila-5', slug: 'fila-5', skillMd: '# fila-5' }, SOURCE, ACTOR);
      const [efemera] = await claimStaleSkills(10);
      await deleteSkill('fila-5', SOURCE, ACTOR);
      expect(await reserva(efemera!)).toBeNull();

      await partida([]);
    });
  });

  // ------------------------- a fila de textos: recusa, reserva e órfãos ----

  describe('a fila de textos do indexador (025)', () => {
    /** Um espaço só desta parte: a fila é por (espaço, texto). */
    let espacoFila: RagSpace;
    const textos = ['fila de texto 1', 'fila de texto 2', 'fila de texto 3'];
    let skillUuid = '';

    beforeAll(async () => {
      espacoFila = await resolveRagSpace({ ...GOOGLE, model: 'gemini-embedding-fila' });
      const skill = await createSkill(
        { name: 'fila de textos', slug: 'fila-de-textos', skillMd: '# fila' },
        SOURCE,
        ACTOR,
      );
      skillUuid = skill.uuid;
      const fileId = (
        await raw.query<{ id: string }>(
          `SELECT id FROM files WHERE skill_uuid = $1 AND relative_path = 'SKILL.md'`,
          [skillUuid],
        )
      ).rows[0]!.id;
      // Três partes do mesmo arquivo: três textos canônicos na fila, na ordem
      // em que entraram.
      await replaceSkillTexts(
        skillUuid,
        textos.map((content, part) => ({
          source: 'file' as const,
          content,
          relativePath: 'SKILL.md',
          part,
          fileId,
        })),
      );
    });

    /** O estado gravado do par (espaço, texto), ou `null`. */
    async function estado(conteudo: string): Promise<{
      state: string;
      until: Date | null;
      reason: string | null;
      updated_at: Date;
    } | null> {
      const { rows } = await raw.query<{
        state: string;
        until: Date | null;
        reason: string | null;
        updated_at: Date;
      }>(
        `SELECT state, until, reason, updated_at FROM rag_text_status
          WHERE space_uuid = $1 AND text_sha256 = $2`,
        [espacoFila.uuid, sha256(conteudo)],
      );
      return rows[0] ?? null;
    }

    /** A parte da fila deste espaço que é desta suíte, na ordem em que entrou. */
    async function minhaFila(reserveMs?: number): Promise<string[]> {
      const pendentes = await listPendingRagTexts(
        espacoFila.uuid,
        500,
        reserveMs === undefined ? {} : { reserveMs },
      );
      return pendentes.map((t) => t.content).filter((c) => textos.includes(c));
    }

    it('a recusa do provedor é gravada e o texto sai da fila — no reinício também', async () => {
      // O espaço é novo, então a fila dele traz todo texto do acervo; o filtro
      // deixa só os três desta parte.
      expect(await minhaFila()).toEqual(textos);

      // O motivo é cortado em 500 caracteres: mensagem de provedor pode vir com
      // o corpo inteiro da resposta dentro, e a linha de estado não é um log.
      await markRagTextRefused(espacoFila.uuid, sha256(textos[1]!), 'x'.repeat(900));

      expect(await minhaFila()).toEqual([textos[0], textos[2]]);
      const gravado = (await estado(textos[1]!))!;
      expect(gravado.state).toBe('recusado');
      expect(gravado.until).toBeNull();
      expect(gravado.reason).toHaveLength(500);

      // A recusa é do par: outro modelo ainda pode aceitar o mesmo texto.
      expect(await listPendingRagTexts(espaco.uuid, 100)).not.toHaveLength(0);
      expect(
        (await listPendingRagTexts(espaco.uuid, 100)).some((t) => t.content === textos[1]),
      ).toBe(true);

      // `ragCoverage` explica a cobertura que não fecha: o recusado está
      // **dentro** de `pendingTexts`.
      const cobertura = await ragCoverage(espacoFila.uuid);
      expect(cobertura.refusedTexts).toBe(1);
      expect(cobertura.pendingTexts).toBeGreaterThanOrEqual(cobertura.refusedTexts);

      // Idempotente: a segunda recusa não reescreve motivo nem carimbo — a
      // linha descreve a recusa que tirou o texto da fila.
      await markRagTextRefused(espacoFila.uuid, sha256(textos[1]!), 'outro motivo');
      expect(await estado(textos[1]!)).toEqual(gravado);

      // Espaço ou texto que já não existe não grava nem lança: isto roda no
      // tratamento de erro do indexador.
      await markRagTextRefused('00000000-0000-7000-8000-000000000000', sha256(textos[0]!), 'x');
      await markRagTextRefused(espacoFila.uuid, sha256('nunca existiu'), 'x');
      expect(await estado(textos[0]!)).toBeNull();

      // Erro de chamada continua sendo 400.
      expect((await capture(markRagTextRefused('nao-e-uuid', sha256(textos[0]!), 'x'))).status).toBe(
        400,
      );
      expect(
        (await capture(markRagTextRefused(espacoFila.uuid, Buffer.alloc(8), 'x'))).status,
      ).toBe(400);
    });

    it('o lote que falha devolve a reserva: o texto volta no ciclo seguinte, não em dez minutos', async () => {
      const vivas = () =>
        conta(
          `SELECT count(*) AS n FROM rag_text_status WHERE space_uuid = $1 AND state = 'reservado'`,
          [espacoFila.uuid],
        );

      // O ciclo lê a fila reservando, e o provedor cai (chave, cota, 5xx, prazo).
      const reservados = await listPendingRagTexts(espacoFila.uuid, 500, { reserveMs: 600_000 });
      const meus = reservados.filter((t) => textos.includes(t.content));
      expect(meus.map((t) => t.content)).toEqual([textos[0], textos[2]]);
      // A fila exclui toda reserva viva — inclusive a de quem a criou e já
      // desistiu do lote. Era assim que o ciclo seguinte via "fila vazia".
      expect(await minhaFila()).toEqual([]);

      // Devolver um só: o outro continua reservado.
      expect(await releaseRagTextReservations(espacoFila.uuid, [meus[0]!.sha256])).toBe(1);
      expect(await minhaFila()).toEqual([textos[0]]);

      // A recusa não é tocada; hash sem reserva e espaço que não existe são
      // ignorados; a contagem é só do que saiu.
      expect(
        await releaseRagTextReservations(espacoFila.uuid, [
          sha256(textos[1]!),
          sha256('nunca existiu'),
          meus[0]!.sha256,
        ]),
      ).toBe(0);
      expect((await estado(textos[1]!))!.state).toBe('recusado');
      expect(
        await releaseRagTextReservations('00000000-0000-7000-8000-000000000000', [meus[1]!.sha256]),
      ).toBe(0);
      expect(await releaseRagTextReservations(espacoFila.uuid, [])).toBe(0);

      // Adiar em vez de devolver: a reserva fica, com o prazo novo — é a saída
      // do 400 sem prova de que o problema é o conteúdo, e do `Retry-After`.
      expect(
        await releaseRagTextReservations(espacoFila.uuid, [meus[1]!.sha256], {
          retryAfterMs: 3_600_000,
        }),
      ).toBe(1);
      const adiado = (await estado(textos[2]!))!;
      expect(adiado.state).toBe('reservado');
      expect(adiado.reason).toBeNull();
      const { rows } = await raw.query<{ uma_hora: boolean }>(
        `SELECT until BETWEEN now() + interval '59 minutes' AND now() + interval '60 minutes' AS uma_hora
           FROM rag_text_status WHERE space_uuid = $1 AND text_sha256 = $2`,
        [espacoFila.uuid, sha256(textos[2]!)],
      );
      expect(rows[0]!.uma_hora).toBe(true);
      expect(await minhaFila()).toEqual([textos[0]]);

      // O resto do lote volta de uma vez, e o espaço fica sem reserva nenhuma.
      await releaseRagTextReservations(
        espacoFila.uuid,
        reservados.map((t) => t.sha256),
      );
      expect(await vivas()).toBe(0);
      expect(await minhaFila()).toEqual([textos[0], textos[2]]);

      // Erro de chamada continua sendo 400.
      expect((await capture(releaseRagTextReservations('nao-e-uuid', []))).status).toBe(400);
      expect(
        (await capture(releaseRagTextReservations(espacoFila.uuid, [Buffer.alloc(8)]))).status,
      ).toBe(400);
      expect(
        (await capture(releaseRagTextReservations(espacoFila.uuid, [], { retryAfterMs: -1 }))).status,
      ).toBe(400);
    });

    it('clearRagRefusals desfaz as recusas de um espaço — e só dele — com auditoria', async () => {
      // Um espaço à parte: o 400 sistêmico (URL base num proxy, contrato da API)
      // marcou tudo o que o indexador tentou.
      const reparo = await resolveRagSpace({ ...GOOGLE, model: 'gemini-embedding-reparo' });
      const meusPendentes = async () =>
        (await listPendingRagTexts(reparo.uuid, 500))
          .map((t) => t.content)
          .filter((c) => textos.includes(c));
      for (const texto of textos) {
        await markRagTextRefused(reparo.uuid, sha256(texto), 'o provedor recusou o conteúdo (400)');
      }
      // E uma reserva viva no mesmo espaço, que o reparo não pode tocar.
      const reservados = await listPendingRagTexts(reparo.uuid, 1, { reserveMs: 600_000 });
      expect(reservados).toHaveLength(1);

      expect((await ragCoverage(reparo.uuid)).refusedTexts).toBe(3);
      expect(await meusPendentes()).toEqual([]);
      const antes = (await listAuditPage({ action: 'rag.reindex' })).total;

      expect(await clearRagRefusals(reparo.uuid, SOURCE, ACTOR)).toBe(3);

      expect((await ragCoverage(reparo.uuid)).refusedTexts).toBe(0);
      expect(await meusPendentes()).toEqual(textos);
      // A reserva ficou, e a recusa do outro espaço também.
      expect(
        await conta(
          `SELECT count(*) AS n FROM rag_text_status WHERE space_uuid = $1 AND state = 'reservado'`,
          [reparo.uuid],
        ),
      ).toBe(1);
      expect((await estado(textos[1]!))!.state).toBe('recusado');

      const trilha = await listAuditPage({ action: 'rag.reindex' });
      expect(trilha.total).toBe(antes + 1);
      expect(trilha.items[0]).toMatchObject({
        action: 'rag.reindex',
        actorLabel: 'teste',
        targetLabel: '3 recusas',
        skillSlug: null,
      });

      // Nada a limpar é zero — e o gesto do admin continua na trilha.
      expect(await clearRagRefusals(reparo.uuid, SOURCE, ACTOR)).toBe(0);
      expect((await listAuditPage({ action: 'rag.reindex' })).items[0]!.targetLabel).toBe('0 recusas');
      expect((await capture(clearRagRefusals('nao-e-uuid', SOURCE, ACTOR))).status).toBe(400);

      await releaseRagTextReservations(
        reparo.uuid,
        reservados.map((t) => t.sha256),
      );
    });

    it('a reserva gravada impede duas réplicas de pagar pelo mesmo texto', async () => {
      const reservas = () =>
        conta(
          `SELECT count(*) AS n FROM rag_text_status
            WHERE space_uuid = $1 AND state = 'reservado' AND until > now()`,
          [espacoFila.uuid],
        );

      // Sem `reserveMs` a leitura não escreve nada: dois leitores veem a mesma
      // lista, que é o comportamento de antes do `025`.
      const [semA, semB] = await Promise.all([minhaFila(), minhaFila()]);
      expect(semA).toEqual(semB);
      expect(semA.length).toBeGreaterThan(0);
      expect(await reservas()).toBe(0);

      // Com prazo, as duas chamadas em paralelo **não se cruzam**: cada texto
      // sai para uma só. Quem perde a corrida tenta uma segunda vez por dentro.
      const [a, b] = await Promise.all([minhaFila(600_000), minhaFila(600_000)]);
      const pagos = [...a, ...b];
      expect(new Set(pagos).size).toBe(pagos.length);
      expect(pagos.sort()).toEqual([...semA].sort());

      // Reservado não volta à fila enquanto o prazo vale — nem para quem lê sem
      // reservar.
      expect(await reservas()).toBe(await conta(
        `SELECT count(*) AS n FROM rag_text_status WHERE space_uuid = $1 AND state = 'reservado'`,
        [espacoFila.uuid],
      ));
      expect(await minhaFila()).toEqual([]);

      // Indexador morto não estaciona a fila: vencido o prazo, o texto volta.
      await raw.query(
        `UPDATE rag_text_status SET until = now() - interval '1 minute'
          WHERE space_uuid = $1 AND state = 'reservado'`,
        [espacoFila.uuid],
      );
      expect((await minhaFila()).sort()).toEqual([...semA].sort());

      // Gravar o vetor encerra a reserva: quem exclui o texto da fila daí em
      // diante é `rag_vectors`.
      const retomados = await listPendingRagTexts(espacoFila.uuid, 500, { reserveMs: 600_000 });
      expect(retomados.length).toBeGreaterThan(0);
      await insertRagVectors(
        espacoFila.uuid,
        retomados.map((t) => ({ sha256: t.sha256, embedding: vetor({ 0: 1 }) })),
      );
      expect(await reservas()).toBe(0);
      // A recusa não é tocada pela gravação.
      expect((await estado(textos[1]!))!.state).toBe('recusado');
      expect(await minhaFila()).toEqual([]);
    });

    it('insertRagVectors ignora o hash cujo texto sumiu, em vez de perder o lote', async () => {
      const vivo = 'hash vivo na gravação';
      await replaceSkillTexts(skillUuid, [{ source: 'meta', content: vivo }]);

      const gravados = await insertRagVectors(espacoFila.uuid, [
        { sha256: sha256(vivo), embedding: vetor({ 0: 1 }) },
        // O texto deste hash foi coletado entre a leitura da fila e a volta do
        // provedor: sem o `JOIN rag_texts`, a FK derrubaria o lote inteiro e o
        // vetor bom (pago) iria com ele.
        { sha256: sha256('texto que já foi coletado'), embedding: vetor({ 0: 1 }) },
      ]);
      expect(gravados).toBe(1);
    });

    it('collectOrphanRagTexts apaga o texto sem ocorrência e leva o vetor dele', async () => {
      // O texto de `meta` da skill fica órfão quando a lista é reescrita.
      const orfao = 'texto que vai virar órfão';
      await replaceSkillTexts(skillUuid, [{ source: 'meta', content: orfao }]);
      await insertRagVectors(espacoFila.uuid, [
        { sha256: sha256(orfao), embedding: vetor({ 0: 1 }) },
      ]);
      const emUso = 'texto que continua em uso';
      await replaceSkillTexts(skillUuid, [{ source: 'meta', content: emUso }]);

      const antes = await conta('SELECT count(*) AS n FROM rag_texts');
      const vetoresAntes = await conta('SELECT count(*) AS n FROM rag_vectors');
      const apagados = await collectOrphanRagTexts(500);
      expect(apagados).toBeGreaterThan(0);
      expect(await conta('SELECT count(*) AS n FROM rag_texts')).toBe(antes - apagados);
      // O vetor do órfão vai pela cascata de `rag_vectors.text_sha256`…
      expect(await conta('SELECT count(*) AS n FROM rag_vectors')).toBeLessThan(vetoresAntes);
      // …e o estado de fila dele, pela de `rag_text_status`.
      expect(
        await conta('SELECT count(*) AS n FROM rag_text_status WHERE text_sha256 = $1', [
          sha256(orfao),
        ]),
      ).toBe(0);

      // O texto em uso fica, e a segunda coleta não acha mais nada.
      expect(
        await conta('SELECT count(*) AS n FROM rag_texts WHERE sha256 = $1', [sha256(emUso)]),
      ).toBe(1);
      expect(await collectOrphanRagTexts(500)).toBe(0);
    });
  });

  // ------------------------------------ configuração, auditoria e schema ---

  describe('a configuração, a auditoria e o estado do schema', () => {
    it('ragSchemaReady enxerga as seis tabelas — e espera a migration quando falta uma', async () => {
      expect(await ragSchemaReady()).toBe(true);

      // Código novo sobre banco parado antes da `028`: sem `rag_skill_claims` a
      // reserva falharia a cada ciclo. Com a tabela na conta, o indexador espera
      // a migration e quem busca cai na busca textual enquanto isso.
      // Pelo nome, e não pelo número: uma renumeração não pode quebrar isto.
      const arquivo = readdirSync(schemaDir()).find((file) =>
        file.endsWith('-reserva-de-skills-com-prazo.sql'),
      )!;
      await raw.query('DROP TABLE rag_skill_claims');
      try {
        expect(await ragSchemaReady()).toBe(false);
      } finally {
        await raw.query(readFileSync(join(schemaDir(), arquivo), 'utf8'));
      }
      expect(await ragSchemaReady()).toBe(true);
    });

    it('o ambiente semeia uma vez; o painel manda depois, e os dois são auditados', async () => {
      expect(await getRagSettings()).toEqual({});

      expect(await seedRagSetting('rag.driver', 'google')).toEqual({
        written: true,
        value: 'google',
      });
      // Segundo boot com outro valor no ambiente: o banco decide, nada é gravado.
      expect(await seedRagSetting('rag.driver', 'off')).toEqual({
        written: false,
        value: 'google',
      });
      expect(await seedRagSetting('rag.model', 'gemini-embedding-2')).toMatchObject({
        written: true,
      });

      const semeadas = await getRagSettings();
      expect(semeadas['rag.driver']).toMatchObject({ key: 'rag.driver', value: 'google' });
      expect(semeadas['rag.model']).toMatchObject({ value: 'gemini-embedding-2' });
      expect(semeadas['rag.indexer.status']).toBeUndefined();

      await setRagSetting('rag.driver', 'off', SOURCE, { userUuid: null, label: 'ana@exemplo.dev' });
      expect((await getRagSettings())['rag.driver']!.value).toBe('off');

      const trilha = await listAuditPage({ action: 'rag.settings' });
      expect(trilha.total).toBe(3);
      expect(trilha.items[0]).toMatchObject({
        action: 'rag.settings',
        actorLabel: 'ana@exemplo.dev',
        targetLabel: 'rag.driver=off',
      });
      // A semeadura assina como `ambiente`.
      expect(trilha.items.map((i) => i.targetLabel)).toContain('rag.driver=google');
      expect(trilha.items.filter((i) => i.actorLabel === 'ambiente')).toHaveLength(2);

      expect((await capture(setRagSetting('rag.indexer.status' as never, 'x', SOURCE, ACTOR))).status).toBe(400);
      expect((await capture(setRagSetting('rag.driver', '  ', SOURCE, ACTOR))).status).toBe(400);
    });

    it('o estado do indexador é gravado sem auditoria — ele é regravado a cada ciclo', async () => {
      const antes = (await listAuditPage({ action: 'rag.settings' })).total;
      await setRagIndexerStatus({ at: new Date().toISOString(), keyPresent: true, lastError: null });
      await setRagIndexerStatus({ at: new Date().toISOString(), keyPresent: false });

      const estado = (await getRagSettings())['rag.indexer.status']!;
      expect(JSON.parse(estado.value!)).toMatchObject({ keyPresent: false });
      expect((await listAuditPage({ action: 'rag.settings' })).total).toBe(antes);

      expect((await capture(setRagIndexerStatus([] as never))).status).toBe(400);
      expect((await capture(setRagIndexerStatus({ x: 'a'.repeat(9000) }))).status).toBe(400);
    });

    it('reindexar marca todo o acervo, não apaga vetor e não toca updated_at', async () => {
      // `clearRagRefusals` audita na mesma ação, com `"<n> recusas"`: a conta é
      // relativa ao que já havia na trilha.
      const reindexAntes = (await listAuditPage({ action: 'rag.reindex' })).total;
      const vetores = await conta('SELECT count(*) AS n FROM rag_vectors');
      const { rows: antes } = await raw.query<{ uuid: string; updated_at: Date }>(
        'SELECT uuid, updated_at FROM skills ORDER BY uuid',
      );

      const marcadas = await markAllSkillsStale(SOURCE, { userUuid: null, label: 'ana@exemplo.dev' });
      expect(marcadas).toBeGreaterThan(0);
      expect(await conta('SELECT count(*) AS n FROM skills WHERE NOT rag_stale')).toBe(0);
      expect(await conta('SELECT count(*) AS n FROM rag_vectors')).toBe(vetores);

      const { rows: depois } = await raw.query<{ uuid: string; updated_at: Date }>(
        'SELECT uuid, updated_at FROM skills ORDER BY uuid',
      );
      expect(depois.map((r) => r.updated_at.toISOString())).toEqual(
        antes.map((r) => r.updated_at.toISOString()),
      );

      const trilha = await listAuditPage({ action: 'rag.reindex' });
      expect(trilha.total).toBe(reindexAntes + 1);
      expect(trilha.items[0]).toMatchObject({
        action: 'rag.reindex',
        targetLabel: `${marcadas} skills`,
        skillSlug: null,
      });

      // Nada a marcar de novo: a segunda chamada não mexe em ninguém.
      expect(await markAllSkillsStale(SOURCE, ACTOR)).toBe(0);
    });

    it('o CHECK de audit_log aceita as duas ações novas e recusa o que não conhece', async () => {
      await expect(
        raw.query(`INSERT INTO audit_log (action, source) VALUES ('rag.inexistente', 'web-admin')`),
      ).rejects.toThrow(/audit_log_action_check/);
      await raw.query(
        `INSERT INTO audit_log (action, source, target_label) VALUES ('rag.settings', 'mcp-admin', 'rag.model=x')`,
      );
      await raw.query('DELETE FROM audit_log WHERE target_label = $1', ['rag.model=x']);
    });
  });

  // --------------------------------------------- a migration, de novo ------

  it('01 — reaplicar a 020 sobre o resultado não muda nada', async () => {
    const antes = {
      textos: await conta('SELECT count(*) AS n FROM rag_texts'),
      ocorrencias: await conta('SELECT count(*) AS n FROM rag_skill_texts'),
      vetores: await conta('SELECT count(*) AS n FROM rag_vectors'),
      espacos: await conta('SELECT count(*) AS n FROM rag_spaces'),
      arquivos: await conta('SELECT count(*) AS n FROM files WHERE content_sha256 IS NOT NULL'),
    };
    const { rows: skillsAntes } = await raw.query<{ uuid: string; updated_at: Date }>(
      'SELECT uuid, updated_at FROM skills ORDER BY uuid',
    );

    // Apagar do histórico é o que força o runner a rodar o arquivo de novo —
    // uma segunda chamada normal só o pularia. A `020` volta **junto com a
    // `027`**, que redefine `files_rag_stale_tg`: sozinha, a `020` recria a
    // função antiga e desfaz a correção — migration antiga sobre schema novo, o
    // que o CLI recusa (`refuseRetroactive`; aqui é de propósito, sem a opção).
    const trocaDeTipo = readdirSync(schemaDir()).find((file) =>
      file.endsWith('-rag-stale-na-troca-de-tipo.sql'),
    )!;
    const corpoDaFuncao = async () =>
      (
        await raw.query<{ prosrc: string }>(
          "SELECT prosrc FROM pg_proc WHERE proname = 'files_rag_stale_tg'",
        )
      ).rows[0]!.prosrc;
    const TIPO = '(NEW.text_content IS NULL) = (OLD.text_content IS NULL)';
    expect(await corpoDaFuncao()).toContain(TIPO);

    await raw.query('DELETE FROM schema_migrations WHERE name = ANY($1)', [
      ['020-rag.sql', trocaDeTipo],
    ]);
    expect(await runMigrations(url!)).toEqual(['020-rag.sql', trocaDeTipo]);
    expect(await corpoDaFuncao()).toContain(TIPO);

    expect({
      textos: await conta('SELECT count(*) AS n FROM rag_texts'),
      ocorrencias: await conta('SELECT count(*) AS n FROM rag_skill_texts'),
      vetores: await conta('SELECT count(*) AS n FROM rag_vectors'),
      espacos: await conta('SELECT count(*) AS n FROM rag_spaces'),
      arquivos: await conta('SELECT count(*) AS n FROM files WHERE content_sha256 IS NOT NULL'),
    }).toEqual(antes);

    const { rows: skillsDepois } = await raw.query<{ uuid: string; updated_at: Date }>(
      'SELECT uuid, updated_at FROM skills ORDER BY uuid',
    );
    expect(skillsDepois.map((r) => r.updated_at.toISOString())).toEqual(
      skillsAntes.map((r) => r.updated_at.toISOString()),
    );

    // Os triggers voltaram ligados: `files_reindex_skill_trg` é desligado só
    // durante o backfill.
    const { rows: triggers } = await raw.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid = 'files'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(triggers.map((t) => `${t.tgname}:${t.tgenabled}`)).toEqual([
      'files_content_sha256_trg:O',
      'files_rag_stale_trg:O',
      'files_reindex_skill_trg:O',
    ]);

    const { rows: indices } = await raw.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename LIKE 'rag_%' ORDER BY indexname`,
    );
    expect(indices.map((i) => i.indexname)).toEqual([
      'rag_skill_claims_pkey',
      'rag_skill_texts_file_idx',
      'rag_skill_texts_pkey',
      'rag_skill_texts_sha256_idx',
      'rag_spaces_identity_uniq',
      'rag_spaces_pkey',
      'rag_spaces_uuid_dimensions_uniq',
      'rag_text_status_pkey',
      'rag_text_status_text_idx',
      'rag_texts_created_at_idx',
      'rag_texts_pkey',
      'rag_vectors_pkey',
      'rag_vectors_text_idx',
    ]);
  }, 60_000);
});
