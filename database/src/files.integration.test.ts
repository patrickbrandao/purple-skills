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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import type { AppError } from './errors.js';
import { runMigrations } from './migrate.js';
import {
  createFile,
  createSkill,
  createUser,
  deleteFile,
  getSkillDetail,
  listFiles,
  readAllFiles,
  readFile,
  readTextFile,
  setFile,
  setFiles,
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
});
