/**
 * Teste de integração das queries de arquivo — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/files.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import type { AppError } from './errors.js';
import { runMigrations, schemaDir } from './migrate.js';
import {
  createFile,
  createSkill,
  createUser,
  deleteFile,
  deleteSkill,
  getSkillDetail,
  getSkillSummary,
  listFiles,
  previewSetFilesDeletions,
  readAllFiles,
  readFile,
  readTextFile,
  setFile,
  setFiles,
  updateSkillWithContent,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'mcp-admin' as const;

/** O erro da chamada, ou `null` se ela passou — nunca rejeita. */
function outcome(promise: Promise<unknown>): Promise<AppError | null> {
  return promise.then(
    () => null,
    (err: unknown) => err as AppError,
  );
}

/** Espera uma condição do banco virar verdadeira, sem `sleep` fixo. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('a condição esperada não aconteceu a tempo');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * O Vitest roda arquivos de teste em paralelo e as duas suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz a segunda esperar a primeira terminar, em vez de derrubar o
 * schema no meio da execução dela. O lock é de sessão: se o processo morrer, a
 * conexão cai e o lock é liberado pelo próprio Postgres. O número precisa ser
 * o mesmo em `users.integration.test.ts`.
 */
const SCHEMA_LOCK = 8_200_004;

describe.skipIf(!url)('arquivos: unicidade de caminho sem diferenciar caixa', () => {
  let uuid = '';
  let lock: pg.Client;

  beforeAll(async () => {
    lock = new pg.Client({ connectionString: url });
    await lock.connect();
    await lock.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK]);

    await lock.query('DROP SCHEMA IF EXISTS public CASCADE');
    await lock.query('CREATE SCHEMA public');

    await runMigrations(url!);
    // As queries resolvem a conexão por `getDb()`, que lê o ambiente na
    // primeira chamada — ainda não houve nenhuma até aqui.
    process.env.DATABASE_URL = url;

    const skill = await createSkill(
      { name: 'Caso 003', slug: 'caso-003', skillMd: '# original' },
      SOURCE,
    );
    uuid = skill.uuid;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await lock.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await lock.end();
  });

  it('grava "skill.md" sobre o SKILL.md existente em vez de duplicar', async () => {
    await setFile('caso-003', 'skill.md', '# sobrescrito', SOURCE);

    const principais = (await listFiles(uuid)).filter(
      (file) => file.relativePath.toLowerCase() === 'skill.md',
    );
    expect(principais.map((file) => file.relativePath)).toEqual(['SKILL.md']);

    const detail = await getSkillDetail('caso-003', { visibility: 'all' });
    expect(detail?.skillMd).toBe('# sobrescrito');
  });

  it('colapsa anexos que diferem só na caixa, mantendo a última grafia', async () => {
    await setFiles(
      'caso-003',
      [
        { relativePath: 'skill.md', content: '# vindo do zip' },
        { relativePath: 'notas.md', content: 'v1' },
        { relativePath: 'Notas.MD', content: 'v2' },
      ],
      SOURCE,
    );

    const paths = (await listFiles(uuid)).map((file) => file.relativePath);
    expect(paths).toEqual(['SKILL.md', 'Notas.MD']);
  });

  it('gera pacote .zip sem entradas que colidem em FS insensível a caixa', async () => {
    const lowered = (await readAllFiles(uuid)).map((file) => file.relativePath.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });

  it('recusa remover o SKILL.md em qualquer caixa', async () => {
    for (const variant of ['SKILL.md', 'skill.md', 'Skill.MD']) {
      await expect(deleteFile('caso-003', variant, SOURCE)).rejects.toThrow(
        /não pode ser removido/,
      );
    }
  });

  it('remove exatamente a linha pedida, sem levar outras variantes junto', async () => {
    await setFile('caso-003', 'a.md', 'minusculo', SOURCE);
    await deleteFile('caso-003', 'A.md', SOURCE); // mesma linha, outra caixa

    const paths = (await listFiles(uuid)).map((file) => file.relativePath);
    expect(paths).toEqual(['SKILL.md', 'Notas.MD']);
  });

  describe('createFile: cria só se o caminho está livre', () => {
    const SLUG = 'caso-novo-arquivo';
    let skillUuid = '';

    const conflito = (message: string) => ({ status: 409, code: 'conflict', message });

    /** Linhas de auditoria da skill — uma recusa não pode acrescentar nenhuma. */
    async function auditRows(): Promise<number> {
      const { rows } = await lock.query(
        'SELECT count(*)::int AS n FROM audit_log WHERE skill_uuid = $1',
        [skillUuid],
      );
      return rows[0].n as number;
    }

    beforeAll(async () => {
      const skill = await createSkill(
        { name: 'Caso novo arquivo', slug: SLUG, skillMd: '# principal' },
        SOURCE,
      );
      skillUuid = skill.uuid;
    });

    it('cria arquivo vazio na raiz e numa pasta, texto e binário', async () => {
      expect(await createFile(SLUG, 'notas.md', '', SOURCE)).toEqual({
        relativePath: 'notas.md',
        mimeType: 'text/markdown',
        sizeBytes: 0,
        isText: true,
      });
      expect(await createFile(SLUG, './docs//guia.md', '', SOURCE)).toEqual({
        relativePath: 'docs/guia.md',
        mimeType: 'text/markdown',
        sizeBytes: 0,
        isText: true,
      });
      // Sem extensão é texto, como no `setFile`.
      expect(await createFile(SLUG, 'docs/LICENSE', '', SOURCE)).toMatchObject({
        mimeType: 'text/plain',
        isText: true,
      });
      // Binário vazio é `bytea` vazio, não `NULL` — o CHECK de `files` aceita.
      expect(await createFile(SLUG, 'img/vazio.png', Buffer.alloc(0), SOURCE)).toEqual({
        relativePath: 'img/vazio.png',
        mimeType: 'image/png',
        sizeBytes: 0,
        isText: false,
      });
      // Com conteúdo: o mesmo cálculo do `setFile` (byte nulo vira binário).
      expect(await createFile(SLUG, 'dados/bruto.txt', Buffer.from([0x61, 0, 0x62]), SOURCE)).toEqual({
        relativePath: 'dados/bruto.txt',
        mimeType: 'text/plain',
        sizeBytes: 3,
        isText: false,
      });
      expect(await createFile(SLUG, 'dados/olá.md', 'olá', SOURCE)).toMatchObject({ sizeBytes: 4 });

      expect(await readTextFile(skillUuid, 'notas.md')).toBe('');
      expect(await readTextFile(skillUuid, 'docs/guia.md')).toBe('');
      const png = await readFile(skillUuid, 'img/vazio.png');
      expect(png).toMatchObject({ isText: false, sizeBytes: 0 });
      expect(png?.buffer.byteLength).toBe(0);

      // O que a criação devolve é o que a listagem mostra.
      const listed = await listFiles(skillUuid);
      expect(listed.find((file) => file.relativePath === 'notas.md')).toEqual({
        relativePath: 'notas.md',
        mimeType: 'text/markdown',
        sizeBytes: 0,
        isText: true,
      });
      expect(listed.find((file) => file.relativePath === 'img/vazio.png')?.isText).toBe(false);
    });

    it('recusa arquivo existente em outra caixa sem tocar no conteúdo', async () => {
      await setFile(SLUG, 'Leia-me.md', 'conteúdo original', SOURCE);
      const before = await auditRows();

      for (const variant of ['leia-me.md', 'LEIA-ME.MD', 'Leia-me.md', './Leia-me.md']) {
        expect(await outcome(createFile(SLUG, variant, '', SOURCE))).toMatchObject(
          conflito('Já existe um arquivo em Leia-me.md'),
        );
      }

      const file = await readFile(skillUuid, 'leia-me.md');
      expect(file?.relativePath).toBe('Leia-me.md');
      expect(file?.buffer.toString('utf8')).toBe('conteúdo original');
      expect(await auditRows()).toBe(before);
    });

    it('recusa o SKILL.md da raiz em qualquer caixa, mesmo sem linha na tabela', async () => {
      const before = await auditRows();
      for (const variant of ['SKILL.md', 'skill.md', './Skill.MD']) {
        expect(await outcome(createFile(SLUG, variant, '', SOURCE))).toMatchObject(
          conflito('O SKILL.md já existe em toda skill'),
        );
      }
      expect(await readTextFile(skillUuid, 'SKILL.md')).toBe('# principal');
      // Debaixo dele também não: com a linha, é o prefixo-arquivo comum.
      expect(await outcome(createFile(SLUG, 'skill.md/extra.md', '', SOURCE))).toMatchObject(
        conflito('SKILL.md é um arquivo, não uma pasta'),
      );

      // Sem a linha (nenhuma escrita da API chega a esse estado), a regra vale igual.
      await lock.query("DELETE FROM files WHERE skill_uuid = $1 AND relative_path = 'SKILL.md'", [
        skillUuid,
      ]);
      try {
        expect(await outcome(createFile(SLUG, 'skill.md', '', SOURCE))).toMatchObject(
          conflito('O SKILL.md já existe em toda skill'),
        );
        expect(await outcome(createFile(SLUG, 'SKILL.md/extra.md', '', SOURCE))).toMatchObject(
          conflito('SKILL.md é um arquivo, não uma pasta'),
        );
        expect(await readFile(skillUuid, 'SKILL.md')).toBeNull();
      } finally {
        await setFile(SLUG, 'SKILL.md', '# principal', SOURCE);
      }
      expect(await auditRows()).toBe(before + 1); // só o `setFile` que devolveu a linha

      // Só o da raiz: um `skill.md` dentro de uma pasta é um arquivo comum.
      expect(await createFile(SLUG, 'exemplos/skill.md', '', SOURCE)).toMatchObject({
        relativePath: 'exemplos/skill.md',
      });
    });

    it('recusa caminho cujo prefixo é um arquivo', async () => {
      await createFile(SLUG, 'Anexo', 'sou um arquivo', SOURCE);
      const before = await auditRows();

      for (const variant of ['Anexo/a.md', 'anexo/a.md', 'ANEXO/sub/b.md']) {
        expect(await outcome(createFile(SLUG, variant, '', SOURCE))).toMatchObject(
          conflito('Anexo é um arquivo, não uma pasta'),
        );
      }

      const paths = (await listFiles(skillUuid)).map((file) => file.relativePath.toLowerCase());
      expect(paths.filter((path) => path.startsWith('anexo'))).toEqual(['anexo']);
      expect(await auditRows()).toBe(before);
    });

    it('recusa caminho que já é uma pasta', async () => {
      await createFile(SLUG, 'Referencia/api/v1.md', '', SOURCE);
      const before = await auditRows();

      expect(await outcome(createFile(SLUG, 'referencia', '', SOURCE))).toMatchObject(
        conflito('Já existe uma pasta Referencia'),
      );
      expect(await outcome(createFile(SLUG, 'REFERENCIA/API', '', SOURCE))).toMatchObject(
        conflito('Já existe uma pasta Referencia/api'),
      );
      expect(await auditRows()).toBe(before);

      // Mesmo começo sem ser a pasta não é conflito.
      await createFile(SLUG, 'Referencia/ap', '', SOURCE);
      await createFile(SLUG, 'Referencia-extra.md', '', SOURCE);
      await createFile(SLUG, 'Referencia/api/v2.md', '', SOURCE);
    });

    it('não trata "_" nem "%" como curinga', async () => {
      // A pasta pedida: `LIKE 'rel_2024/%'` casaria `relx2024/a.md`.
      await createFile(SLUG, 'relx2024/a.md', '', SOURCE);
      expect(await createFile(SLUG, 'rel_2024', '', SOURCE)).toMatchObject({
        relativePath: 'rel_2024',
      });
      // `LIKE '%/%'` casaria qualquer arquivo dentro de uma pasta.
      expect(await createFile(SLUG, '%', '', SOURCE)).toMatchObject({ relativePath: '%' });

      // O prefixo gravado: `'capx1/a.md' LIKE 'cap_1/%'` e `LIKE '%/%'` são verdadeiros.
      await createFile(SLUG, 'cap_1', '', SOURCE);
      expect(await createFile(SLUG, 'capx1/a.md', '', SOURCE)).toMatchObject({
        relativePath: 'capx1/a.md',
      });
      expect(await createFile(SLUG, 'qualquer/a.md', '', SOURCE)).toMatchObject({
        relativePath: 'qualquer/a.md',
      });

      // O mesmo caminho.
      await createFile(SLUG, 'nota_1.md', '', SOURCE);
      expect(await createFile(SLUG, 'notax1.md', '', SOURCE)).toMatchObject({
        relativePath: 'notax1.md',
      });

      // E os conflitos de verdade continuam recusados.
      expect(await outcome(createFile(SLUG, 'REL_2024/b.md', '', SOURCE))).toMatchObject(
        conflito('rel_2024 é um arquivo, não uma pasta'),
      );
      expect(await outcome(createFile(SLUG, '%/b.md', '', SOURCE))).toMatchObject(
        conflito('% é um arquivo, não uma pasta'),
      );
      expect(await outcome(createFile(SLUG, 'CAP_1', '', SOURCE))).toMatchObject(
        conflito('Já existe um arquivo em cap_1'),
      );
      expect(await outcome(createFile(SLUG, 'RELX2024', '', SOURCE))).toMatchObject(
        conflito('Já existe uma pasta relx2024'),
      );
    });

    it('audita create com o caminho normalizado e sem conteúdo anterior', async () => {
      const ana = await createUser({ email: 'ana@exemplo.dev', name: 'Ana', role: 'editor' });
      const actor = { userUuid: ana.uuid, label: ana.email };

      await createFile(SLUG, './auditoria//novo.md', 'primeira versão', 'web-admin', actor);
      const before = await auditRows();
      expect(await outcome(createFile(SLUG, 'Auditoria/Novo.md', 'outra', 'web-admin', actor)))
        .toMatchObject(conflito('Já existe um arquivo em auditoria/novo.md'));
      expect(await auditRows()).toBe(before);

      const { rows } = await lock.query(
        `SELECT skill_uuid, skill_slug, file_path, action, source, previous_content,
                actor_user_uuid, actor_label, target_label
           FROM audit_log
          WHERE skill_uuid = $1 AND lower(file_path) = 'auditoria/novo.md'`,
        [skillUuid],
      );
      expect(rows).toEqual([
        {
          skill_uuid: skillUuid,
          skill_slug: SLUG,
          file_path: 'auditoria/novo.md',
          action: 'create',
          source: 'web-admin',
          previous_content: null,
          actor_user_uuid: ana.uuid,
          actor_label: 'ana@exemplo.dev',
          target_label: null,
        },
      ]);
    });

    it('devolve 404 para skill desconhecida e 400 para caminho ou conteúdo inválido', async () => {
      expect(await outcome(createFile('nao-existe', 'a.md', '', SOURCE))).toMatchObject({
        status: 404,
        code: 'not_found',
        message: 'Skill não encontrada: nao-existe',
      });
      for (const path of ['../fora.md', '/', '', 'C:/x.md']) {
        expect(await outcome(createFile(SLUG, path, '', SOURCE))).toMatchObject({
          status: 400,
          code: 'bad_request',
          message: `Caminho inválido: ${path}`,
        });
      }
      expect(await outcome(createFile(SLUG, 'a.md', undefined as never, SOURCE))).toMatchObject({
        status: 400,
        code: 'bad_request',
        message: 'O conteúdo do arquivo precisa ser texto ou bytes',
      });
    });

    it('serializa criações concorrentes do mesmo caminho: uma vence, as outras são 409', async () => {
      const results = await Promise.all(
        ['corrida.md', 'CORRIDA.md', 'Corrida.md', 'corrida.MD'].map((path, i) =>
          outcome(createFile(SLUG, path, `versão ${i}`, SOURCE)),
        ),
      );
      expect(results.filter((err) => err === null)).toHaveLength(1);

      const winner = await readFile(skillUuid, 'corrida.md');
      const errors = results.filter((err): err is AppError => err !== null);
      expect(errors).toHaveLength(3);
      for (const err of errors) {
        expect(err).toMatchObject(conflito(`Já existe um arquivo em ${winner?.relativePath}`));
      }

      const { rows } = await lock.query(
        `SELECT
           (SELECT count(*)::int FROM files
             WHERE skill_uuid = $1 AND lower(relative_path) = 'corrida.md') AS arquivos,
           (SELECT count(*)::int FROM audit_log
             WHERE skill_uuid = $1 AND lower(file_path) = 'corrida.md') AS auditorias`,
        [skillUuid],
      );
      expect(rows[0]).toEqual({ arquivos: 1, auditorias: 1 });
    });

    it('serializa arquivo × pasta concorrentes: nunca os dois', async () => {
      // O mesmo caminho o índice único já segura; `x` contra `x/a.md` só a
      // trava. Sem ela, as duas conferências passam antes dos dois INSERTs.
      const names = Array.from({ length: 10 }, (_, i) => `disputa-${i}`);
      const results = await Promise.all(
        names.flatMap((name) => [
          outcome(createFile(SLUG, name, '', SOURCE)),
          outcome(createFile(SLUG, `${name}/a.md`, '', SOURCE)),
        ]),
      );

      names.forEach((name, i) => {
        const [asFile, asFolder] = [results[2 * i], results[2 * i + 1]];
        expect([asFile, asFolder].filter((err) => err === null)).toHaveLength(1);
        if (asFile === null) {
          expect(asFolder).toMatchObject(conflito(`${name} é um arquivo, não uma pasta`));
        } else {
          expect(asFile).toMatchObject(conflito(`Já existe uma pasta ${name}`));
        }
      });
    });

    it('um INSERT alheio em andamento no mesmo caminho vira 409, sem deadlock', async () => {
      // Skill já indexada: é quando o trigger da `020` faz UPDATE na skill a
      // cada arquivo de texto gravado — a trava de `createFile` não pode
      // barrar isso nem a checagem da FK de quem grava sem ela.
      await lock.query('UPDATE skills SET rag_stale = false WHERE uuid = $1', [skillUuid]);

      const other = new pg.Client({ connectionString: url });
      await other.connect();
      try {
        // O que um `setFile` faz, parado antes do COMMIT.
        await other.query('BEGIN');
        await other.query(
          `INSERT INTO files (skill_uuid, relative_path, text_content, mime_type, size_bytes)
           VALUES ($1, 'disputa.md', 'do outro', 'text/markdown', 8)`,
          [skillUuid],
        );

        const pending = outcome(createFile(SLUG, 'Disputa.md', 'meu', SOURCE));

        // `createFile` passou pela trava e pela conferência e está parado no
        // INSERT … DO NOTHING, esperando a transação do outro terminar.
        await waitFor(async () => {
          const { rows } = await lock.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND wait_event = 'transactionid'
                AND query LIKE '%DO NOTHING%'`,
          );
          return rows.length > 0;
        });

        await other.query('COMMIT');
        expect(await pending).toMatchObject(conflito('Já existe um arquivo em disputa.md'));
      } finally {
        await other.end();
      }

      expect(await readTextFile(skillUuid, 'disputa.md')).toBe('do outro');
      const { rows } = await lock.query(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE skill_uuid = $1 AND lower(file_path) = 'disputa.md'`,
        [skillUuid],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('setFiles: a remoção em lote deixa trilha e aceita confirmação', () => {
    const SLUG = 'caso-011';
    let uuid = '';

    beforeAll(async () => {
      const skill = await createSkill(
        { name: 'Caso 011', slug: SLUG, skillMd: '# principal' },
        SOURCE,
      );
      uuid = skill.uuid;
    });

    /** As linhas de auditoria da skill, da mais recente para a mais antiga. */
    async function trilha(): Promise<{ action: string; file_path: string | null; previous_content: string | null }[]> {
      const { rows } = await lock.query(
        `SELECT action, file_path, previous_content FROM audit_log
          WHERE skill_uuid = $1 ORDER BY created_at DESC, action, file_path`,
        [uuid],
      );
      return rows;
    }

    async function caminhos(): Promise<string[]> {
      return (await listFiles(uuid)).map((file) => file.relativePath);
    }

    it('audita um delete por caminho removido, com o conteúdo dos textuais', async () => {
      await setFiles(
        SLUG,
        [
          { relativePath: 'nota.md', content: 'texto da nota' },
          { relativePath: 'logo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) },
        ],
        SOURCE,
        { replace: false },
      );
      expect(await caminhos()).toEqual(['SKILL.md', 'logo.png', 'nota.md']);

      // O lote seguinte não traz nenhum dos dois: os dois saem.
      await setFiles(SLUG, [{ relativePath: 'outra.md', content: 'nova' }], SOURCE, {}, {
        userUuid: null,
        label: 'ana@exemplo.dev',
      });
      expect(await caminhos()).toEqual(['SKILL.md', 'outra.md']);

      const linhas = await trilha();
      const remocoes = linhas.filter((linha) => linha.action === 'delete');
      expect(remocoes).toEqual([
        // O binário entra na trilha sem conteúdo, como em `deleteFile`.
        { action: 'delete', file_path: 'logo.png', previous_content: null },
        { action: 'delete', file_path: 'nota.md', previous_content: 'texto da nota' },
      ]);
      // A linha da escrita em lote continua existindo, sem caminho.
      expect(linhas.some((linha) => linha.action === 'update' && linha.file_path === null)).toBe(true);
    });

    it('confere expectedDeletions dentro da transação: número errado é 409 e nada sai', async () => {
      await setFiles(SLUG, [{ relativePath: 'a.md', content: 'a' }, { relativePath: 'b.md', content: 'b' }], SOURCE, {
        replace: false,
      });
      const antes = await caminhos();
      expect(antes).toEqual(['SKILL.md', 'a.md', 'b.md', 'outra.md']);

      // Confirmando uma remoção quando sairiam três: recusa e nada muda.
      const erro = await outcome(
        setFiles(SLUG, [{ relativePath: 'a.md', content: 'a2' }], SOURCE, { expectedDeletions: 1 }),
      );
      expect(erro).toMatchObject({ status: 409, code: 'conflict' });
      expect(erro?.message).toContain('confirmou 1');
      expect(await caminhos()).toEqual(antes);
      // Nem a gravação de `a.md` valeu — a transação inteira voltou.
      expect(await readTextFile(uuid, 'a.md')).toBe('a');

      // O número certo passa, e a trilha ganha as três remoções.
      const restam = await setFiles(
        SLUG,
        [{ relativePath: 'a.md', content: 'a2' }],
        SOURCE,
        { expectedDeletions: 2 },
      );
      expect(restam.map((file) => file.relativePath)).toEqual(['SKILL.md', 'a.md']);
      expect((await trilha()).filter((linha) => linha.action === 'delete').map((l) => l.file_path)).toContain(
        'b.md',
      );

      // `expectedDeletions` torto é 400, antes de abrir transação.
      expect(
        await outcome(setFiles(SLUG, [{ relativePath: 'a.md', content: 'a' }], SOURCE, { expectedDeletions: -1 })),
      ).toMatchObject({ status: 400 });
    });

    it('duas escritas em lote na mesma skill indexada se enfileiram', async () => {
      // As duas listas vêm em ordens opostas: sem a trava é disputa linha por
      // linha, com o trigger `files_rag_stale_trg` da `020` no meio (ele faz
      // `UPDATE` na skill a cada arquivo de texto). Com ela, a segunda espera.
      await lock.query('UPDATE skills SET rag_stale = false WHERE uuid = $1', [uuid]);
      const arquivos = Array.from({ length: 12 }, (_, i) => ({
        relativePath: `lote-${i}.md`,
        content: `v${i}`,
      }));

      const resultados = await Promise.all([
        outcome(setFiles(SLUG, arquivos, SOURCE, { replace: false })),
        outcome(setFiles(SLUG, [...arquivos].reverse(), SOURCE, { replace: false })),
      ]);
      expect(resultados).toEqual([null, null]);
      expect(await caminhos()).toHaveLength(2 + arquivos.length);
    });
  });

  describe('texto × binário: só é texto o que é UTF-8 válido (tasks/015)', () => {
    const SLUG = 'caso-015';
    let uuid = '';

    // `preço;ação\n` em Windows-1252: `ç` e `ã` são um byte só, inválido em UTF-8.
    const CP1252 = Buffer.from([0x70, 0x72, 0x65, 0xe7, 0x6f, 0x3b, 0x61, 0xe7, 0xe3, 0x6f, 0x0a]);
    const RECUSA = { status: 400, message: 'O SKILL.md precisa ser um texto UTF-8 válido, sem byte nulo' };

    beforeAll(async () => {
      const skill = await createSkill({ name: 'Caso 015', slug: SLUG, skillMd: '# corpo original' }, SOURCE);
      uuid = skill.uuid;
    });

    it('guarda byte a byte o arquivo de extensão textual que não é UTF-8', async () => {
      // Antes: `toString('utf8')` trocava cada byte inválido por U+FFFD, sem erro —
      // 11 bytes anunciados em `size_bytes`, 17 servidos, e o original perdido.
      expect(await setFile(SLUG, 'dados.csv', CP1252, SOURCE)).toEqual({
        relativePath: 'dados.csv',
        mimeType: 'text/csv',
        sizeBytes: 11,
        isText: false,
      });

      const lido = await readFile(uuid, 'dados.csv');
      expect(lido?.isText).toBe(false);
      expect(lido?.buffer.equals(CP1252)).toBe(true);
      expect(lido?.sizeBytes).toBe(lido?.buffer.byteLength);
      expect(await readTextFile(uuid, 'dados.csv')).toBeNull();
      expect((await listFiles(uuid)).find((file) => file.relativePath === 'dados.csv')?.isText).toBe(false);
      expect((await readAllFiles(uuid)).find((file) => file.relativePath === 'dados.csv')?.buffer.equals(CP1252)).toBe(
        true,
      );
    });

    it('o lote, o anexo da criação e o createFile seguem a mesma régua', async () => {
      await setFiles(SLUG, [{ relativePath: 'lote/legado.sql', content: CP1252 }], SOURCE, { replace: false });
      expect((await readFile(uuid, 'lote/legado.sql'))?.buffer.equals(CP1252)).toBe(true);

      const criada = await createSkill(
        { name: 'Caso 015 anexo', slug: 'caso-015-anexo', skillMd: '# x', files: [{ relativePath: 'a.txt', content: CP1252 }] },
        SOURCE,
      );
      expect(criada.files.find((file) => file.relativePath === 'a.txt')).toMatchObject({ isText: false, sizeBytes: 11 });
      expect((await readFile(criada.uuid, 'a.txt'))?.buffer.equals(CP1252)).toBe(true);

      expect(await createFile(SLUG, 'novo.ini', CP1252, SOURCE)).toMatchObject({ mimeType: 'text/plain', isText: false });
    });

    it('UTF-8 válido continua texto: acento, vazio e BOM voltam com os mesmos bytes', async () => {
      const comBom = Buffer.from([0xef, 0xbb, 0xbf, 0x70, 0x72, 0x65, 0xc3, 0xa7, 0x6f]);
      expect(await setFile(SLUG, 'bom.csv', comBom, SOURCE)).toMatchObject({ isText: true, sizeBytes: 9 });
      expect((await readFile(uuid, 'bom.csv'))?.buffer.equals(comBom)).toBe(true);

      expect(await setFile(SLUG, 'acento.txt', 'preço;ação', SOURCE)).toMatchObject({ isText: true, sizeBytes: 13 });
      expect(await readTextFile(uuid, 'acento.txt')).toBe('preço;ação');

      expect(await setFile(SLUG, 'vazio.txt', Buffer.alloc(0), SOURCE)).toMatchObject({ isText: true, sizeBytes: 0 });
      expect(await readTextFile(uuid, 'vazio.txt')).toBe('');
    });

    it('o SKILL.md que não é texto é 400, e o corpo gravado não muda', async () => {
      // Gravado como binário, o `SKILL.md` deixaria a skill de corpo vazio para
      // todo leitor (`readTextFile`, `search_vector`, RAG), sem erro nenhum.
      expect(await outcome(setFile(SLUG, 'SKILL.md', CP1252, SOURCE))).toMatchObject(RECUSA);
      expect(await outcome(setFile(SLUG, 'skill.md', 'a\u0000b', SOURCE))).toMatchObject(RECUSA);
      expect(
        await outcome(
          setFiles(
            SLUG,
            [
              { relativePath: 'junto.md', content: 'não pode entrar' },
              { relativePath: 'SKILL.md', content: CP1252 },
            ],
            SOURCE,
            { replace: false },
          ),
        ),
      ).toMatchObject(RECUSA);
      expect(await readFile(uuid, 'junto.md')).toBeNull();

      expect(
        await outcome(updateSkillWithContent(SLUG, { name: 'Não pode valer', skillMd: 'a\u0000b' }, SOURCE)),
      ).toMatchObject(RECUSA);
      const depois = await getSkillDetail(SLUG, { visibility: 'all' });
      expect(depois?.name).toBe('Caso 015');
      expect(depois?.skillMd).toBe('# corpo original');

      expect(
        await outcome(createSkill({ name: 'Nula', slug: 'caso-015-nula', skillMd: 'a\u0000b' }, SOURCE)),
      ).toMatchObject(RECUSA);
      expect(await getSkillSummary('caso-015-nula', { visibility: 'all' })).toBeNull();

      // Um `skill.md` dentro de uma pasta é um arquivo comum: binário, sem recusa.
      expect(await setFile(SLUG, 'docs/skill.md', CP1252, SOURCE)).toMatchObject({ isText: false });
    });
  });

  describe('caixa do caminho: quem dobra é sempre o Postgres (tasks/017)', () => {
    const SLUG = 'caso-017';
    let uuid = '';

    beforeAll(async () => {
      const skill = await createSkill({ name: 'Caso 017', slug: SLUG, skillMd: '# principal' }, SOURCE);
      uuid = skill.uuid;
    });

    async function caminhos(): Promise<string[]> {
      return (await listFiles(uuid)).map((file) => file.relativePath);
    }

    it('o replace não apaga o İndice.md que acabou de gravar', async () => {
      // `'İ'.toLowerCase()` são dois code points e o `lower()` da libc é 1:1: com
      // a lista de "o que fica" dobrada no JS, o DELETE não achava o arquivo nela.
      const arvore = await setFiles(
        SLUG,
        [
          { relativePath: 'İndice.md', content: 'sumário' },
          { relativePath: 'comum.md', content: 'ok' },
        ],
        SOURCE,
      );
      expect(arvore.map((file) => file.relativePath)).toEqual(['SKILL.md', 'comum.md', 'İndice.md']);

      const { rows } = await lock.query(
        `SELECT count(*)::int AS n FROM audit_log WHERE skill_uuid = $1 AND action = 'delete'`,
        [uuid],
      );
      expect(rows[0].n).toBe(0);

      // A confirmação do mcp-admin deixa de virar 409 permanente: nada sai.
      expect(
        await outcome(
          setFiles(
            SLUG,
            [
              { relativePath: 'İndice.md', content: 'sumário 2' },
              { relativePath: 'comum.md', content: 'ok' },
            ],
            SOURCE,
            { expectedDeletions: 0 },
          ),
        ),
      ).toBeNull();
      expect(await readTextFile(uuid, 'İndice.md')).toBe('sumário 2');
    });

    it('İ.md e I.md no mesmo lote não derrubam a statement (21000)', async () => {
      // A resposta certa depende de como ESTE cluster dobra a caixa — libc leva
      // `İ` a `i`; ICU e `builtin` fazem o mapeamento completo. O teste pergunta
      // ao banco, que é o que o código passou a fazer.
      const { rows } = await lock.query(`SELECT lower('İ.md') = lower('I.md') AS mesma`);
      const mesmaChave = rows[0].mesma as boolean;

      const lote = [
        { relativePath: 'caixa/İ.md', content: 'com ponto' },
        { relativePath: 'caixa/I.md', content: 'sem ponto' },
      ];
      expect(await outcome(setFiles(SLUG, lote, SOURCE, { replace: false }))).toBeNull();
      const naPasta = (await caminhos()).filter((path) => path.startsWith('caixa/'));
      if (mesmaChave) {
        // Uma linha, com a última grafia e o último conteúdo — como `Notas.md` × `notas.md`.
        expect(naPasta).toEqual(['caixa/I.md']);
        expect(await readTextFile(uuid, 'caixa/İ.md')).toBe('sem ponto');
      } else {
        expect(naPasta).toEqual(['caixa/I.md', 'caixa/İ.md']);
      }

      // O mesmo `upsertFilesTx` serve os anexos da criação.
      const criada = await createSkill(
        { name: 'Caso 017 anexos', slug: 'caso-017-anexos', skillMd: '# x', files: lote },
        SOURCE,
      );
      expect(criada.files.filter((file) => file.relativePath.startsWith('caixa/'))).toHaveLength(mesmaChave ? 1 : 2);
    });

    it('previewSetFilesDeletions anuncia exatamente o que o replace remove, inclusive na borda do İ', async () => {
      await setFiles(
        SLUG,
        [
          { relativePath: 'İndice.md', content: 'gravado com ponto' },
          { relativePath: 'fica.md', content: 'fica' },
          { relativePath: 'sai.md', content: 'sai' },
        ],
        SOURCE,
      );

      // O pacote traz `Indice.md`, sem o ponto. Uma prévia feita no JS compara
      // `i̇ndice.md` com `indice.md`, anuncia a remoção do `İndice.md` — e o banco,
      // que (na libc) vê a mesma chave, sobrescreve a linha e não remove nada: o
      // número confirmado nunca batia. Aqui a prévia é o predicado do DELETE.
      const pacote = ['Indice.md', 'fica.md'];
      const previa = await previewSetFilesDeletions(uuid, pacote);
      expect(previa).toContain('sai.md');
      expect(previa).not.toContain('SKILL.md');
      const { rows } = await lock.query(`SELECT lower('İ') = lower('I') AS mesma`);
      if (rows[0].mesma) expect(previa).toEqual(['sai.md']);

      const arvore = await setFiles(
        SLUG,
        pacote.map((relativePath) => ({ relativePath, content: 'do pacote' })),
        SOURCE,
        { expectedDeletions: previa.length },
      );
      expect(arvore.map((file) => file.relativePath)).not.toContain('sai.md');

      // Caminho inválido é o 400 de `setFiles`; uuid torto é lista vazia.
      expect(await outcome(previewSetFilesDeletions(uuid, ['../fora.md']))).toMatchObject({ status: 400 });
      expect(await previewSetFilesDeletions('nao-e-uuid', ['a.md'])).toEqual([]);
    });

    it('o caso comum não muda: outra caixa renomeia em vez de remover, e o SKILL.md nunca sai', async () => {
      await setFiles(SLUG, [{ relativePath: 'readme.md', content: 'v1' }], SOURCE, { replace: false });
      const arvore = await setFiles(SLUG, [{ relativePath: 'README.MD', content: 'v2' }], SOURCE, {
        expectedDeletions: (await caminhos()).length - 2, // tudo menos o SKILL.md e o próprio readme
      });
      expect(arvore.map((file) => file.relativePath)).toEqual(['SKILL.md', 'README.MD']);
      expect(await readTextFile(uuid, 'readme.md')).toBe('v2');
    });
  });

  describe('a fila das escritas de arquivo (tasks/022)', () => {
    const SLUG = 'caso-022';
    let uuid = '';

    /** A chave de `lockSkillFilesTx`, tomada por um cliente cru. */
    const FILA = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`;
    const chave = () => `purple-skills:files:${uuid}`;

    /** Alguém deste banco está parado na fila (advisory lock), e não numa linha. */
    async function naFila(): Promise<boolean> {
      const { rows } = await lock.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
      );
      return rows.length > 0;
    }

    beforeAll(async () => {
      const skill = await createSkill({ name: 'Caso 022', slug: SLUG, skillMd: '# original' }, SOURCE);
      uuid = skill.uuid;
      // Indexada: é quando `files_rag_stale_trg` também faz UPDATE na skill.
      await lock.query('UPDATE skills SET rag_stale = false WHERE uuid = $1', [uuid]);
    });

    it('setFile entra na fila antes de tocar em linha: o salvamento da skill em andamento não vira deadlock', async () => {
      const formulario = new pg.Client({ connectionString: url });
      await formulario.connect();
      try {
        // O que `updateSkillWithContent` faz até o `UPDATE skills`, parado aí.
        await formulario.query('BEGIN');
        await formulario.query(FILA, [chave()]);
        await formulario.query('UPDATE skills SET updated_at = now() WHERE uuid = $1', [uuid]);

        const pendente = outcome(setFile(SLUG, 'SKILL.md', '# do arquivo', SOURCE));
        await waitFor(naFila);

        // Sem a fila, o `setFile` já seguraria esta linha, esperando a skill pelo
        // trigger — e este upsert fecharia o ciclo (40P01, medido em 59 de 150 pares).
        await formulario.query(
          `INSERT INTO files (skill_uuid, relative_path, text_content, mime_type, size_bytes)
           VALUES ($1, 'SKILL.md', '# do formulário', 'text/markdown', 15)
           ON CONFLICT (skill_uuid, lower(relative_path)) DO UPDATE SET
             text_content = EXCLUDED.text_content, updated_at = now()`,
          [uuid],
        );
        await formulario.query('COMMIT');
        expect(await pendente).toBeNull();
      } finally {
        await formulario.end();
      }

      // Enfileirado, o `setFile` gravou depois — e auditou o que de fato substituiu.
      expect(await readTextFile(uuid, 'SKILL.md')).toBe('# do arquivo');
      const { rows } = await lock.query(
        `SELECT previous_content FROM audit_log
          WHERE skill_uuid = $1 AND file_path = 'SKILL.md' ORDER BY created_at DESC, id DESC LIMIT 1`,
        [uuid],
      );
      expect(rows[0].previous_content).toBe('# do formulário');
    });

    it('updateSkillWithContent com skillMd espera a escrita de arquivo na fila, sem segurar a skill', async () => {
      const arquivo = new pg.Client({ connectionString: url });
      await arquivo.connect();
      try {
        // O que um `setFile('SKILL.md')` faz: a linha de `files` e, pelo trigger, a de `skills`.
        await arquivo.query('BEGIN');
        await arquivo.query(FILA, [chave()]);
        await arquivo.query(
          `UPDATE files SET text_content = '# do outro', updated_at = now()
            WHERE skill_uuid = $1 AND relative_path = 'SKILL.md'`,
          [uuid],
        );

        const pendente = outcome(
          updateSkillWithContent(SLUG, { description: 'salva junto', skillMd: '# do formulário' }, SOURCE),
        );
        await waitFor(naFila);
        await arquivo.query('COMMIT');
        expect(await pendente).toBeNull();
      } finally {
        await arquivo.end();
      }

      const detail = await getSkillDetail(SLUG, { visibility: 'all' });
      expect(detail).toMatchObject({ description: 'salva junto', skillMd: '# do formulário' });
    });

    it('sem skillMd o salvamento fica fora da fila: não espera um envio de arquivos em andamento', async () => {
      const envio = new pg.Client({ connectionString: url });
      await envio.connect();
      try {
        await envio.query('BEGIN');
        await envio.query(FILA, [chave()]);
        // Resolve com a fila ocupada — se esperasse por ela, ficaria preso aqui.
        expect(await outcome(updateSkillWithContent(SLUG, { description: 'só metadados' }, SOURCE))).toBeNull();
        await envio.query('COMMIT');
      } finally {
        await envio.end();
      }
    });

    it('pares concorrentes formulário × arquivo no SKILL.md: ninguém morre', async () => {
      // Antes da fila, ~40% dos pares perdiam um dos lados por 40P01 (500): a
      // chance de 20 pares passarem ilesos era de 1 em 27 mil.
      for (let i = 0; i < 20; i += 1) {
        await lock.query('UPDATE skills SET rag_stale = false WHERE uuid = $1', [uuid]);
        const par = await Promise.all([
          outcome(updateSkillWithContent(SLUG, { skillMd: `# A ${i}`, tags: [`t${i % 3}`, 'fixa'] }, SOURCE)),
          outcome(
            i % 2
              ? setFile(SLUG, 'SKILL.md', `# B ${i}`, SOURCE)
              : setFiles(SLUG, [{ relativePath: 'SKILL.md', content: `# B ${i}` }], SOURCE, { replace: false }),
          ),
        ]);
        expect(par).toEqual([null, null]);
      }
    });

    it('setFiles com replace × setFile/deleteFile num arquivo que sai: sem deadlock', async () => {
      // O "limite conhecido" que o README registrava: o lote já tem a skill (pelo
      // trigger) e quer apagar a linha que o outro segura, que por sua vez quer a skill.
      for (let i = 0; i < 12; i += 1) {
        await setFile(SLUG, 'sai.md', 'vai sair', SOURCE);
        await lock.query('UPDATE skills SET rag_stale = false WHERE uuid = $1', [uuid]);
        const [lote, avulso] = await Promise.all([
          outcome(setFiles(SLUG, [{ relativePath: 'fica.md', content: `f${i}` }], SOURCE)),
          outcome(i % 2 ? setFile(SLUG, 'sai.md', `s${i}`, SOURCE) : deleteFile(SLUG, 'sai.md', SOURCE)),
        ]);
        expect(lote).toBeNull();
        // O avulso passa, ou chega depois do lote e não acha mais o arquivo.
        if (avulso !== null) expect(avulso).toMatchObject({ status: 404 });
      }
    });

    it('duas remoções simultâneas do mesmo arquivo: uma remove, a outra é 404, e só uma audita', async () => {
      await setFile(SLUG, 'duplo.md', 'x', SOURCE);
      const resultados = await Promise.all([
        outcome(deleteFile(SLUG, 'duplo.md', SOURCE)),
        outcome(deleteFile(SLUG, 'Duplo.md', SOURCE)),
      ]);
      expect(resultados.filter((err) => err === null)).toHaveLength(1);
      expect(resultados.find((err) => err !== null)).toMatchObject({ status: 404 });

      const { rows } = await lock.query(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE skill_uuid = $1 AND lower(file_path) = 'duplo.md' AND action = 'delete'`,
        [uuid],
      );
      expect(rows[0].n).toBe(1);
    });

    it('deleteSkill × escrita de arquivo: sucesso ou 404, nunca erro interno', async () => {
      // Sem a tradução, a FK de `files` (23503) subia crua: 29 a 34 de 100 pares
      // respondiam 500 no lugar do 404 da skill que sumiu.
      for (let i = 0; i < 10; i += 1) {
        const slug = `caso-022-some-${i}`;
        await createSkill({ name: 'Some', slug, skillMd: '# x' }, SOURCE);
        const [remocao, escrita] = await Promise.all([
          outcome(deleteSkill(slug, SOURCE)),
          outcome(
            i % 2
              ? setFile(slug, `novo-${i}.md`, 'x', SOURCE)
              : setFiles(slug, [{ relativePath: `novo-${i}.md`, content: 'x' }], SOURCE, { replace: false }),
          ),
        ]);
        expect(remocao).toBeNull();
        if (escrita !== null) {
          expect(escrita).toMatchObject({ status: 404, message: `Skill não encontrada: ${slug}` });
        }
      }
    });
  });

  describe('arquivos de texto antigos gravados como binário (tasks/018)', () => {
    const SLUG = 'caso-018';
    let uuid = '';

    /**
     * O SQL de uma migration, achada pelo nome sem o número — que pode ser
     * renumerado. Ancorado: `025-fila-de-textos-do-rag.sql` também termina em
     * `-rag.sql`.
     */
    function migration(nome: string): string {
      const file = readdirSync(schemaDir()).find((name) => new RegExp(`^\\d+-${nome}\\.sql$`).test(name));
      if (!file) throw new Error(`migration não encontrada: nnn-${nome}.sql`);
      return readFileSync(join(schemaDir(), file), 'utf8');
    }

    /** Só a função do trigger de pendência, como a migration indicada a define. */
    function funcaoDoTrigger(nome: string): string {
      const found = /CREATE OR REPLACE FUNCTION files_rag_stale_tg\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/.exec(
        migration(nome),
      );
      if (!found) throw new Error(`files_rag_stale_tg não encontrada em nnn-${nome}.sql`);
      return found[0];
    }

    /** Aplica o arquivo como o runner: numa transação. */
    async function aplicar(sqlText: string): Promise<void> {
      await lock.query('BEGIN');
      try {
        await lock.query(sqlText);
        await lock.query('COMMIT');
      } catch (err) {
        await lock.query('ROLLBACK');
        throw err;
      }
    }

    /** Linhas como as de antes da beta.22: binário, `application/octet-stream`. */
    async function gravarComoAntes(arquivos: Record<string, Buffer>): Promise<void> {
      for (const [caminho, bytes] of Object.entries(arquivos)) {
        await lock.query(
          `INSERT INTO files (skill_uuid, relative_path, binary_content, mime_type, size_bytes)
           VALUES ($1, $2, $3, 'application/octet-stream', $4)`,
          [uuid, caminho, bytes, bytes.byteLength],
        );
      }
    }

    async function foto(): Promise<Record<string, { texto: boolean; mime: string; hash: string; tam: number; quando: string }>> {
      const { rows } = await lock.query(
        `SELECT relative_path, text_content IS NOT NULL AS texto, mime_type,
                encode(content_sha256, 'hex') AS hash, size_bytes, updated_at::text AS quando
           FROM files WHERE skill_uuid = $1`,
        [uuid],
      );
      return Object.fromEntries(
        rows.map((row) => [
          row.relative_path as string,
          { texto: row.texto, mime: row.mime_type, hash: row.hash, tam: Number(row.size_bytes), quando: row.quando },
        ]),
      );
    }

    const LEGADO = {
      'app.ini': Buffer.from('[core]\nnome = ação\n', 'utf8'),
      'a.INI': Buffer.from('x=1', 'utf8'),
      'dir.v2/run.ps1': Buffer.from('Write-Host "olá"', 'utf8'),
      '.env.example': Buffer.from('CHAVE=CHANGE_ME', 'utf8'),
      'arquivo.tar.conf': Buffer.from('listen 80;', 'utf8'),
      'vazio.ini': Buffer.alloc(0),
      'bom.ini': Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x3d, 0x31]),
      // Ficam binários: fora de UTF-8, com byte nulo, binário de verdade, sem
      // extensão (`mimeTypeFor` os chama de `text/plain` desde sempre) e fora da lista.
      'latin1.conf': Buffer.from([0x70, 0x72, 0x65, 0xe7, 0x6f]),
      'utf16.ps1': Buffer.from([0xff, 0xfe, 0x57, 0x00, 0x72, 0x00]),
      'nulo.log': Buffer.from([0x61, 0x62, 0x00, 0x63]),
      'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      '.env': Buffer.from('A=1', 'utf8'),
      Makefile: Buffer.from('all:', 'utf8'),
      'x.': Buffer.from('nada', 'utf8'),
      'notas.xyz': Buffer.from('extensão fora da lista', 'utf8'),
    };
    const CONVERTIDOS = ['app.ini', 'a.INI', 'dir.v2/run.ps1', '.env.example', 'arquivo.tar.conf', 'vazio.ini', 'bom.ini'];

    beforeAll(async () => {
      const skill = await createSkill({ name: 'Caso 018', slug: SLUG, skillMd: '# corpo' }, SOURCE);
      uuid = skill.uuid;
    });

    it('converte só o UTF-8 sem byte nulo das extensões novas, sem mexer em hash, tamanho nem datas', async () => {
      await gravarComoAntes(LEGADO);
      await lock.query('UPDATE skills SET rag_stale = false WHERE uuid = $1', [uuid]);
      const antes = await foto();
      const skillAntes = await lock.query('SELECT updated_at::text AS quando FROM skills WHERE uuid = $1', [uuid]);

      await aplicar(migration('arquivos-de-texto-antigos'));

      const depois = await foto();
      for (const [caminho, linha] of Object.entries(depois)) {
        if (caminho === 'SKILL.md') continue;
        expect(linha.texto, caminho).toBe(CONVERTIDOS.includes(caminho));
        // Hash, tamanho e data: iguais em toda linha, convertida ou não.
        expect({ hash: linha.hash, tam: linha.tam, quando: linha.quando }, caminho).toEqual({
          hash: antes[caminho]!.hash,
          tam: antes[caminho]!.tam,
          quando: antes[caminho]!.quando,
        });
        // Quem não passou na régua fica exatamente como estava, o mime inclusive.
        if (!linha.texto) expect(linha.mime, caminho).toBe('application/octet-stream');
      }
      expect(depois['app.ini']!.mime).toBe('text/plain');
      expect(depois['dir.v2/run.ps1']!.mime).toBe('text/x-powershell');

      // O que a leitura passa a entregar — e o BOM continua onde estava.
      expect(await readTextFile(uuid, 'app.ini')).toBe('[core]\nnome = ação\n');
      expect((await readFile(uuid, 'bom.ini'))?.buffer.equals(LEGADO['bom.ini'])).toBe(true);
      expect((await readFile(uuid, 'latin1.conf'))?.buffer.equals(LEGADO['latin1.conf'])).toBe(true);
      expect((await listFiles(uuid)).find((file) => file.relativePath === 'a.INI')).toMatchObject({
        isText: true,
        mimeType: 'text/plain',
      });

      // A skill fica pendente no RAG e **não** sobe nos "recentes".
      const skillDepois = await lock.query(
        'SELECT rag_stale, updated_at::text AS quando FROM skills WHERE uuid = $1',
        [uuid],
      );
      expect(skillDepois.rows[0]).toEqual({ rag_stale: true, quando: skillAntes.rows[0].quando });

      // A auxiliar não sobra em schema nenhum.
      const sobra = await lock.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'texto_utf8_ou_nulo'`);
      expect(sobra.rows[0].n).toBe(0);
    });

    it('a segunda passada não reescreve linha nenhuma nem volta a marcar a skill', async () => {
      await lock.query('UPDATE skills SET rag_stale = false WHERE uuid = $1', [uuid]);
      const versoes = await lock.query('SELECT id, xmin::text AS versao FROM files ORDER BY id');

      await aplicar(migration('arquivos-de-texto-antigos'));

      const depois = await lock.query('SELECT id, xmin::text AS versao FROM files ORDER BY id');
      expect(depois.rows).toEqual(versoes.rows);
      const skill = await lock.query('SELECT rag_stale FROM skills WHERE uuid = $1', [uuid]);
      expect(skill.rows[0].rag_stale).toBe(false);
    });

    it('marca a pendência sozinha: vale também antes da correção do trigger (renumeração)', async () => {
      // Este `UPDATE` não muda hash nem caminho, e a função da `020` saía cedo
      // nesse caso. Com ela de volta no banco, só a marcação explícita salva.
      await lock.query(funcaoDoTrigger('rag'));
      try {
        await gravarComoAntes({ 'antes-da-troca-de-tipo.conf': Buffer.from('porta = 80', 'utf8') });
        await lock.query('UPDATE skills SET rag_stale = false WHERE uuid = $1', [uuid]);

        await aplicar(migration('arquivos-de-texto-antigos'));

        expect(await readTextFile(uuid, 'antes-da-troca-de-tipo.conf')).toBe('porta = 80');
        const skill = await lock.query('SELECT rag_stale FROM skills WHERE uuid = $1', [uuid]);
        expect(skill.rows[0].rag_stale).toBe(true);
      } finally {
        await lock.query(funcaoDoTrigger('rag-stale-na-troca-de-tipo'));
      }
    });
  });
});
