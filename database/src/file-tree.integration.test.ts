/**
 * Teste de integração da forma da árvore de arquivos e do teto do envio, da
 * auditoria de 2026-11-07 — exige um PostgreSQL 18 real com pgvector, porque
 * aplica o schema inteiro:
 *
 * - arquivo × pasta (`tasks/017`): `setFile`, `setFiles`, `createSkill`,
 *   `setQuarantineFile`, `setQuarantineFiles`, `createQuarantine` e
 *   `promoteQuarantine` recusam com 409, como `createFile` sempre fez, o
 *   caminho novo que colide com arquivo ou pasta e o lote que colide consigo
 *   mesmo; sobrescrever o mesmo caminho segue livre;
 * - o teto de arquivos por envio (`tasks/016`): `createQuarantineFile` e
 *   `setQuarantineFile` com `maxFiles` contam com o envio travado, e dois
 *   pedidos simultâneos não passam do teto.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada.
 * Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/file-tree.integration.test.ts
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
  createQuarantine,
  createQuarantineFile,
  createSkill,
  getQuarantine,
  getSkillSummary,
  listFiles,
  promoteQuarantine,
  setFile,
  setFiles,
  setQuarantineFile,
  setQuarantineFiles,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;
const ATOR = { userUuid: null, label: 'teste' };

/** O mesmo número das outras suítes: ver `quarantine.integration.test.ts`. */
const SCHEMA_LOCK = 8_200_004;

let raw: pg.Client;

/** O erro da chamada, ou `null` se ela passou — nunca rejeita. */
function outcome(promise: Promise<unknown>): Promise<AppError | null> {
  return promise.then(
    () => null,
    (err: unknown) => err as AppError,
  );
}

/** Recusa esperada: o status e a mensagem, numa comparação só. */
async function recusa(promise: Promise<unknown>): Promise<{ status: number; message: string } | null> {
  const err = await outcome(promise);
  return err ? { status: err.status, message: err.message } : null;
}

async function conta(texto: string, params: unknown[] = []): Promise<number> {
  const { rows } = await raw.query<{ n: string }>(texto, params);
  return Number(rows[0]?.n ?? 0);
}

async function caminhos(slug: string): Promise<string[]> {
  const skill = (await getSkillSummary(slug, { visibility: 'all' }))!;
  // Ordenados no JS: a ordem de `listFiles` é a da coleção do banco.
  return (await listFiles(skill.uuid)).map((f) => f.relativePath).sort();
}

async function caminhosDoEnvio(uuid: string): Promise<string[]> {
  return (await getQuarantine(uuid))!.files.map((f) => f.relativePath);
}

const trilha = () => conta('SELECT count(*) AS n FROM audit_log');

describe.skipIf(!url)('árvore de arquivos: arquivo × pasta e o teto do envio', () => {
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

  // ------------------------------------------------------------- skill -----

  it('setFile: caminho novo sob arquivo, sobre pasta ou sob o SKILL.md é 409, sem gravar nem auditar', async () => {
    await createSkill({ slug: 'arvore', name: 'Árvore', skillMd: '# Árvore\n' }, SOURCE, ATOR);
    await setFile('arvore', 'docs', 'um arquivo chamado docs\n', SOURCE, ATOR);
    await setFile('arvore', 'Pasta/a.md', '# a\n', SOURCE, ATOR);
    const antes = await trilha();

    expect(await recusa(setFile('arvore', 'SKILL.md/x.md', 'x', SOURCE, ATOR))).toEqual({
      status: 409,
      message: 'SKILL.md é um arquivo, não uma pasta',
    });
    expect(await recusa(setFile('arvore', 'skill.md/x.md', 'x', SOURCE, ATOR))).toEqual({
      status: 409,
      message: 'SKILL.md é um arquivo, não uma pasta',
    });
    expect(await recusa(setFile('arvore', 'DOCS/a.md', 'x', SOURCE, ATOR))).toEqual({
      status: 409,
      message: 'docs é um arquivo, não uma pasta',
    });
    expect(await recusa(setFile('arvore', 'docs/fundo/a.md', 'x', SOURCE, ATOR))).toEqual({
      status: 409,
      message: 'docs é um arquivo, não uma pasta',
    });
    expect(await recusa(setFile('arvore', 'pasta', 'x', SOURCE, ATOR))).toEqual({
      status: 409,
      message: 'Já existe uma pasta Pasta',
    });

    expect(await caminhos('arvore')).toEqual(['Pasta/a.md', 'SKILL.md', 'docs']);
    expect(await trilha()).toBe(antes);
  });

  it('setFile: sobrescrever o mesmo caminho, em qualquer caixa, segue livre', async () => {
    expect(await outcome(setFile('arvore', 'DOCS', 'outro conteúdo\n', SOURCE, ATOR))).toBeNull();
    expect(await outcome(setFile('arvore', 'pasta/A.md', '# A\n', SOURCE, ATOR))).toBeNull();
    // Um vizinho que não colide: `docs2` não é `docs/`.
    expect(await outcome(setFile('arvore', 'docs2/a.md', '# a\n', SOURCE, ATOR))).toBeNull();
    expect(await caminhos('arvore')).toEqual(['DOCS', 'SKILL.md', 'docs2/a.md', 'pasta/A.md']);
  });

  it('setFile: a árvore torta de antes ainda aceita sobrescrever o que já existe', async () => {
    const skill = (await getSkillSummary('arvore', { visibility: 'all' }))!;
    await raw.query(
      `INSERT INTO files (skill_uuid, relative_path, text_content, mime_type, size_bytes)
       VALUES ($1, 'legado', 'x', 'text/plain', 1), ($1, 'legado/a.md', 'x', 'text/markdown', 1)`,
      [skill.uuid],
    );
    expect(await outcome(setFile('arvore', 'legado/a.md', 'y', SOURCE, ATOR))).toBeNull();
    expect(await outcome(setFile('arvore', 'legado', 'y', SOURCE, ATOR))).toBeNull();
    await raw.query(`DELETE FROM files WHERE skill_uuid = $1 AND relative_path LIKE 'legado%'`, [skill.uuid]);
  });

  it('setFiles sem replace: confere o lote contra a árvore e contra si mesmo, tudo ou nada', async () => {
    const antes = await caminhos('arvore');

    expect(
      await recusa(
        setFiles(
          'arvore',
          [
            { relativePath: 'novo.md', content: 'n' },
            { relativePath: 'DOCS/b.md', content: 'b' },
          ],
          SOURCE,
          { replace: false },
          ATOR,
        ),
      ),
    ).toEqual({ status: 409, message: 'DOCS é um arquivo, não uma pasta' });

    expect(
      await recusa(
        setFiles(
          'arvore',
          [
            { relativePath: 'x/y.md', content: 'y' },
            { relativePath: 'X', content: 'x' },
          ],
          SOURCE,
          { replace: false },
          ATOR,
        ),
      ),
    ).toEqual({ status: 409, message: 'X é um arquivo, não uma pasta: a mesma gravação traz x/y.md' });

    expect(
      await recusa(
        setFiles('arvore', [{ relativePath: 'SKILL.md/z', content: 'z' }], SOURCE, { replace: false }, ATOR),
      ),
    ).toEqual({ status: 409, message: 'SKILL.md é um arquivo, não uma pasta' });

    expect(await caminhos('arvore')).toEqual(antes);

    // Sobrescrita e caminho novo que não colide passam juntos.
    expect(
      await outcome(
        setFiles(
          'arvore',
          [
            { relativePath: 'docs', content: 'de novo' },
            { relativePath: 'pasta/b.md', content: 'b' },
          ],
          SOURCE,
          { replace: false },
          ATOR,
        ),
      ),
    ).toBeNull();
  });

  it('setFiles com replace: só o próprio lote conta, porque o resto vai sair', async () => {
    // `DOCS` é arquivo hoje, e vira pasta: o arquivo sai na mesma escrita.
    expect(
      await outcome(
        setFiles('arvore', [{ relativePath: 'docs/a.md', content: '# a\n' }], SOURCE, {}, ATOR),
      ),
    ).toBeNull();
    expect(await caminhos('arvore')).toEqual(['SKILL.md', 'docs/a.md']);

    expect(
      await recusa(
        setFiles(
          'arvore',
          [
            { relativePath: 'k', content: 'k' },
            { relativePath: 'k/l.md', content: 'l' },
          ],
          SOURCE,
          {},
          ATOR,
        ),
      ),
    ).toEqual({ status: 409, message: 'k é um arquivo, não uma pasta: a mesma gravação traz k/l.md' });
    expect(
      await recusa(setFiles('arvore', [{ relativePath: 'SKILL.md/x', content: 'x' }], SOURCE, {}, ATOR)),
    ).toEqual({ status: 409, message: 'SKILL.md é um arquivo, não uma pasta' });
    expect(await caminhos('arvore')).toEqual(['SKILL.md', 'docs/a.md']);
  });

  it('createSkill: o pacote que colide consigo mesmo é 409 e a skill não nasce', async () => {
    expect(
      await recusa(
        createSkill(
          {
            slug: 'torta',
            name: 'Torta',
            skillMd: '# Torta\n',
            files: [
              { relativePath: 'docs', content: 'd' },
              { relativePath: 'docs/a.md', content: 'a' },
            ],
          },
          SOURCE,
          ATOR,
        ),
      ),
    ).toEqual({ status: 409, message: 'docs é um arquivo, não uma pasta: a mesma gravação traz docs/a.md' });
    expect(
      await recusa(
        createSkill(
          {
            slug: 'torta',
            name: 'Torta',
            skillMd: '# Torta\n',
            files: [{ relativePath: 'SKILL.md/notas.md', content: 'n' }],
          },
          SOURCE,
          ATOR,
        ),
      ),
    ).toEqual({ status: 409, message: 'SKILL.md é um arquivo, não uma pasta' });
    expect(await getSkillSummary('torta', { visibility: 'all' })).toBeNull();
  });

  // -------------------------------------------------------- quarentena -----

  let envio = '';

  it('createQuarantine: o pacote que colide consigo mesmo é 409 e o envio não nasce', async () => {
    const antes = await conta('SELECT count(*) AS n FROM quarantine_skills');
    expect(
      await recusa(
        createQuarantine(
          {
            name: 'Torto',
            files: [
              { relativePath: 'SKILL.md', content: '# Torto\n' },
              { relativePath: 'img', content: 'i' },
              { relativePath: 'IMG/logo.png', content: Buffer.from([0x89, 0x00]) },
            ],
          },
          SOURCE,
          ATOR,
        ),
      ),
    ).toEqual({ status: 409, message: 'img é um arquivo, não uma pasta: a mesma gravação traz IMG/logo.png' });
    expect(await conta('SELECT count(*) AS n FROM quarantine_skills')).toBe(antes);

    envio = (
      await createQuarantine(
        {
          name: 'Certo',
          files: [
            { relativePath: 'SKILL.md', content: '# Certo\n' },
            { relativePath: 'docs/uso.md', content: '# Uso\n' },
          ],
        },
        SOURCE,
        ATOR,
      )
    ).uuid;
  });

  it('setQuarantineFile: caminho novo que colide é 409; sobrescrever segue livre', async () => {
    const antes = await trilha();
    expect(await recusa(setQuarantineFile(envio, 'Docs', 'x', SOURCE, ATOR))).toEqual({
      status: 409,
      message: 'Já existe uma pasta docs',
    });
    expect(await recusa(setQuarantineFile(envio, 'docs/uso.md/x', 'x', SOURCE, ATOR))).toEqual({
      status: 409,
      message: 'docs/uso.md é um arquivo, não uma pasta',
    });
    expect(await trilha()).toBe(antes);

    expect(await outcome(setQuarantineFile(envio, 'DOCS/USO.md', '# Uso 2\n', SOURCE, ATOR))).toBeNull();
    expect(await caminhosDoEnvio(envio)).toEqual(['SKILL.md', 'DOCS/USO.md']);
  });

  it('setQuarantineFiles: o lote é conferido contra o envio e contra si mesmo, tudo ou nada', async () => {
    expect(
      await recusa(
        setQuarantineFiles(
          envio,
          [
            { relativePath: 'a.md', content: 'a' },
            { relativePath: 'docs', content: 'd' },
          ],
          SOURCE,
          ATOR,
        ),
      ),
    ).toEqual({ status: 409, message: 'Já existe uma pasta DOCS' });
    expect(
      await recusa(
        setQuarantineFiles(
          envio,
          [
            { relativePath: 'b/c.md', content: 'c' },
            { relativePath: 'b', content: 'b' },
          ],
          SOURCE,
          ATOR,
        ),
      ),
    ).toEqual({ status: 409, message: 'b é um arquivo, não uma pasta: a mesma gravação traz b/c.md' });
    expect(await caminhosDoEnvio(envio)).toEqual(['SKILL.md', 'DOCS/USO.md']);
  });

  it('promoteQuarantine: o envio gravado torto antes da regra não vira skill', async () => {
    const torto = (
      await createQuarantine(
        { name: 'Antigo', files: [{ relativePath: 'SKILL.md', content: '---\nname: antigo-torto\n---\n# A\n' }] },
        SOURCE,
        ATOR,
      )
    ).uuid;
    await raw.query(
      `INSERT INTO quarantine_files (quarantine_uuid, relative_path, text_content, mime_type, size_bytes)
       VALUES ($1, 'ref', 'r', 'text/plain', 1), ($1, 'ref/a.md', 'a', 'text/markdown', 1)`,
      [torto],
    );
    expect(await recusa(promoteQuarantine(torto, SOURCE, ATOR))).toEqual({
      status: 409,
      message: 'ref é um arquivo, não uma pasta: a mesma gravação traz ref/a.md',
    });
    expect(await getQuarantine(torto)).not.toBeNull();
    expect(await getSkillSummary('antigo-torto', { visibility: 'all' })).toBeNull();
  });

  // ------------------------------------------------- o teto do envio -------

  it('setQuarantineFile com maxFiles: caminho novo no teto é 400; sobrescrever passa', async () => {
    // O envio tem 2 arquivos.
    expect(
      await recusa(setQuarantineFile(envio, 'novo.md', 'n', SOURCE, ATOR, { maxFiles: 2 })),
    ).toEqual({
      status: 400,
      message:
        'Este envio já tem 2 arquivos, o limite por envio. ' +
        'Remova algum, ou descarte o envio e importe o pacote de novo.',
    });
    expect(
      await outcome(setQuarantineFile(envio, 'skill.md', '# Certo 2\n', SOURCE, ATOR, { maxFiles: 2 })),
    ).toBeNull();
    // Abaixo do teto, ou sem ele, o caminho novo entra.
    expect(await outcome(setQuarantineFile(envio, 'novo.md', 'n', SOURCE, ATOR, { maxFiles: 3 }))).toBeNull();
    expect(await outcome(setQuarantineFile(envio, 'outro.md', 'o', SOURCE, ATOR))).toBeNull();
    expect(await caminhosDoEnvio(envio)).toHaveLength(4);
  });

  it('createQuarantineFile com maxFiles: o caminho ocupado continua 409, mesmo no teto', async () => {
    expect(
      await recusa(createQuarantineFile(envio, 'novo.md', 'n', SOURCE, ATOR, { maxFiles: 4 })),
    ).toEqual({ status: 409, message: 'Já existe um arquivo em novo.md' });
    expect(
      (await recusa(createQuarantineFile(envio, 'mais.md', 'm', SOURCE, ATOR, { maxFiles: 4 })))?.status,
    ).toBe(400);
  });

  it('pedidos simultâneos não passam do teto: um entra, os outros recebem 400', async () => {
    const pacote = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ relativePath: `f${i}.md`, content: `${i}` }));

    for (const escrever of [createQuarantineFile, setQuarantineFile]) {
      const uuid = (await createQuarantine({ name: 'Teto', files: pacote(9) }, SOURCE, ATOR)).uuid;
      const resultados = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          outcome(escrever(uuid, `corrida-${i}.md`, 'c', SOURCE, ATOR, { maxFiles: 10 })),
        ),
      );
      expect(resultados.filter((r) => r === null)).toHaveLength(1);
      expect(resultados.filter((r) => r?.status === 400)).toHaveLength(5);
      expect(await conta('SELECT count(*) AS n FROM quarantine_files WHERE quarantine_uuid = $1', [uuid])).toBe(10);
    }
  });
});
