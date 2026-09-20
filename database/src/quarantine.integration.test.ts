/**
 * Teste de integração da quarentena (`030`) — exige um PostgreSQL 18 real com
 * pgvector, porque aplica o schema inteiro.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/quarantine.integration.test.ts
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
  claimStaleSkills,
  createQuarantine,
  createQuarantineFile,
  createSkill,
  createUser,
  deleteQuarantine,
  deleteQuarantineFile,
  getQuarantine,
  getQuarantineApprovers,
  getSkillDetail,
  getSkillSummary,
  listAuditPage,
  listQuarantine,
  promoteQuarantine,
  readAllQuarantineFiles,
  readQuarantineFile,
  setFile,
  setQuarantineApprovers,
  setQuarantineFile,
  setQuarantineFiles,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

/** O erro da chamada, ou `null` se ela passou — nunca rejeita. */
function outcome(promise: Promise<unknown>): Promise<AppError | null> {
  return promise.then(
    () => null,
    (err: unknown) => err as AppError,
  );
}

let raw: pg.Client;

/** Contas do cenário: Ana administra, Bruno submete, Carla edita. */
const ana = { userUuid: '', label: 'ana@exemplo.dev' };
const bruno = { userUuid: '', label: 'bruno@exemplo.dev' };

async function conta(texto: string, params: unknown[] = []): Promise<number> {
  const { rows } = await raw.query<{ n: string }>(texto, params);
  return Number(rows[0]?.n ?? 0);
}

/** Um `.zip` de exemplo: o SKILL.md **cru**, com o frontmatter dentro. */
const PACOTE = `---
name: relatorios
description: Relatórios mensais
tags: vendas, financeiro
---

# Relatórios

Corpo do prompt.
`;

/** Bytes que não são UTF-8 válido: um `.csv` em Windows-1252. */
const CSV_LATIN1 = Buffer.from([0x70, 0x72, 0x65, 0xe7, 0x6f, 0x0a]); // "preço\n"

/** Um PNG mínimo — binário de verdade, com byte nulo. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/**
 * O `SKILL.md` que o Bloco de Notas salvou como "Unicode": UTF-16LE, com um
 * byte nulo a cada caractere ASCII. É o pacote torto que a quarentena recebe
 * para consertar — e que `files` recusa.
 */
const SKILL_MD_UTF16 = Buffer.from('# Relatórios\n\nCorpo do prompt.\n', 'utf16le');

describe.skipIf(!url)('quarentena: o envio que espera aprovação', () => {
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

    ana.userUuid = (await createUser({ email: ana.label, name: 'Ana', role: 'admin' })).uuid;
    bruno.userUuid = (await createUser({ email: bruno.label, name: 'Bruno', role: 'editor' })).uuid;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  // ------------------------------------------------- a fila e os envios ----

  it('a chave quarantine.approvers nasce semeada com o padrão da instalação', async () => {
    const { rows } = await raw.query<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'quarantine.approvers'",
    );
    expect(rows[0]?.value).toBe('admin+owner');
    expect(await getQuarantineApprovers()).toBe('admin+owner');
  });

  /** Os dois envios do cenário; o segundo é homônimo do primeiro de propósito. */
  let primeiro = '';
  let segundo = '';

  it('dois envios com o mesmo nome convivem: quem os distingue é o uuid', async () => {
    const um = await createQuarantine(
      {
        name: 'Relatórios',
        description: 'Relatórios mensais',
        sourceFilename: 'relatorios.zip',
        files: [
          { relativePath: 'SKILL.md', content: PACOTE },
          { relativePath: 'docs/uso.md', content: '# Uso\n' },
          { relativePath: 'img/logo.png', content: PNG },
        ],
      },
      SOURCE,
      bruno,
    );
    const dois = await createQuarantine(
      {
        name: 'Relatórios',
        sourceFilename: 'relatorios (1).zip',
        files: [{ relativePath: 'SKILL.md', content: PACOTE }],
      },
      SOURCE,
      bruno,
    );

    primeiro = um.uuid;
    segundo = dois.uuid;
    expect(primeiro).not.toBe(segundo);
    expect(um.name).toBe(dois.name);

    // Nenhum índice único sobre `name`: a tabela aceita os dois.
    expect(await conta("SELECT count(*) AS n FROM quarantine_skills WHERE name = 'Relatórios'")).toBe(2);

    expect(um.ownerUserUuid).toBe(bruno.userUuid);
    expect(um.ownerEmail).toBe(bruno.label);
    expect(um.fileCount).toBe(3);
    expect(um.sizeBytes).toBe(
      Buffer.byteLength(PACOTE) + Buffer.byteLength('# Uso\n') + PNG.byteLength,
    );
    expect(um.files.map((f) => f.relativePath)).toEqual(['SKILL.md', 'docs/uso.md', 'img/logo.png']);

    const pagina = await listQuarantine();
    expect(pagina.total).toBe(2);
    // Mais recentes primeiro.
    expect(pagina.items.map((item) => item.uuid)).toEqual([segundo, primeiro]);
  });

  it('o SKILL.md fica cru, com o frontmatter dentro', async () => {
    const arquivo = await readQuarantineFile(primeiro, 'SKILL.md');
    expect(arquivo?.buffer.toString('utf8')).toBe(PACOTE);
    expect(arquivo?.isText).toBe(true);

    // A quarentena não separa metadados de corpo: o que foi enviado é o que
    // está gravado, e é o que se edita.
    expect(arquivo?.buffer.toString('utf8')).toContain('name: relatorios');
  });

  it('texto ou binário, nunca os dois — o CHECK e a régua de `fileColumns`', async () => {
    const arquivos = await setQuarantineFiles(
      primeiro,
      [
        { relativePath: 'dados.csv', content: CSV_LATIN1 },
        { relativePath: 'notas.md', content: 'acentuação é texto' },
      ],
      SOURCE,
      bruno,
    );

    const csv = arquivos.find((f) => f.relativePath === 'dados.csv');
    // Mime textual, mas os bytes não são UTF-8: vai como binário, byte a byte.
    expect(csv).toEqual({
      relativePath: 'dados.csv',
      mimeType: 'text/csv',
      sizeBytes: CSV_LATIN1.byteLength,
      isText: false,
    });
    expect((await readQuarantineFile(primeiro, 'dados.csv'))?.buffer).toEqual(CSV_LATIN1);
    expect((await readQuarantineFile(primeiro, 'img/logo.png'))?.buffer).toEqual(PNG);
    expect(arquivos.find((f) => f.relativePath === 'notas.md')?.isText).toBe(true);

    // Cada linha tem exatamente uma das duas colunas preenchida.
    expect(
      await conta(`SELECT count(*) AS n FROM quarantine_files
                    WHERE (text_content IS NULL) = (binary_content IS NULL)`),
    ).toBe(0);

    for (const valores of [
      "'texto', '\\x00'::bytea", // os dois
      'NULL, NULL', // nenhum
    ]) {
      await expect(
        raw.query(
          `INSERT INTO quarantine_files (quarantine_uuid, relative_path, text_content, binary_content)
           VALUES ($1, 'torto.md', ${valores})`,
          [primeiro],
        ),
      ).rejects.toThrow(/quarantine_files_one_content_chk/);
    }
  });

  it('caminho duplicado em caixa diferente: recusado no envio, livre entre envios', async () => {
    const erro = await outcome(createQuarantineFile(primeiro, 'NOTAS.MD', 'outro', SOURCE, bruno));
    expect(erro?.status).toBe(409);
    expect(erro?.message).toBe('Já existe um arquivo em notas.md');
    // A recusa não mexeu no conteúdo.
    expect((await readQuarantineFile(primeiro, 'notas.md'))?.buffer.toString('utf8')).toBe(
      'acentuação é texto',
    );

    // O índice é sobre `lower(relative_path)`: o INSERT cru também é recusado.
    await expect(
      raw.query(
        `INSERT INTO quarantine_files (quarantine_uuid, relative_path, text_content)
         VALUES ($1, 'Notas.Md', 'copia')`,
        [primeiro],
      ),
    ).rejects.toThrow(/quarantine_files_path_lower_uniq/);

    // `setQuarantineFile` é upsert: a caixa recebida vira a definitiva.
    await setQuarantineFile(primeiro, 'Notas.MD', 'v2', SOURCE, bruno);
    const depois = (await getQuarantine(primeiro))!.files.map((f) => f.relativePath);
    expect(depois.filter((path) => path.toLowerCase() === 'notas.md')).toEqual(['Notas.MD']);

    // Entre envios diferentes o mesmo caminho é livre — é o caso esperado.
    const meta = await createQuarantineFile(segundo, 'notas.md', 'do outro envio', SOURCE, bruno);
    expect(meta.relativePath).toBe('notas.md');
    expect((await readQuarantineFile(segundo, 'notas.md'))?.buffer.toString('utf8')).toBe(
      'do outro envio',
    );
    expect((await readQuarantineFile(primeiro, 'notas.md'))?.buffer.toString('utf8')).toBe('v2');
  });

  it('o SKILL.md é um caminho como outro qualquer: criável quando falta', async () => {
    const vazio = await createQuarantine({ name: 'Sem principal' }, SOURCE, bruno);
    expect(vazio.files).toEqual([]);

    const meta = await createQuarantineFile(vazio.uuid, 'skill.md', '# agora tem', SOURCE, bruno);
    // `normalizeRelativePath` canoniza a caixa do arquivo principal.
    expect(meta.relativePath).toBe('SKILL.md');

    // A segunda vez é 409, como em qualquer caminho ocupado.
    const erro = await outcome(createQuarantineFile(vazio.uuid, 'SKILL.md', 'x', SOURCE, bruno));
    expect(erro?.status).toBe(409);

    // Pasta × arquivo, as mesmas mensagens de `createFile`.
    expect(
      (await outcome(createQuarantineFile(vazio.uuid, 'SKILL.md/x.md', 'x', SOURCE, bruno)))
        ?.message,
    ).toBe('SKILL.md é um arquivo, não uma pasta');
    await createQuarantineFile(vazio.uuid, 'docs/a.md', 'a', SOURCE, bruno);
    expect(
      (await outcome(createQuarantineFile(vazio.uuid, 'docs', 'x', SOURCE, bruno)))?.message,
    ).toBe('Já existe uma pasta docs');

    // E sai como entrou: o SKILL.md pode ser removido de um envio.
    await deleteQuarantineFile(vazio.uuid, 'SKILL.md', SOURCE, bruno);
    expect((await getQuarantine(vazio.uuid))!.files.map((f) => f.relativePath)).toEqual(['docs/a.md']);
    expect((await outcome(deleteQuarantineFile(vazio.uuid, 'SKILL.md', SOURCE, bruno)))?.status).toBe(404);

    await deleteQuarantine(vazio.uuid, SOURCE, bruno);
  });

  it('escrever um arquivo carimba o `updated_at` do envio', async () => {
    const antes = (await getQuarantine(segundo))!;
    await setQuarantineFile(segundo, 'docs/extra.md', 'conteúdo', SOURCE, bruno);
    const depois = (await getQuarantine(segundo))!;
    expect(Date.parse(depois.updatedAt)).toBeGreaterThan(Date.parse(antes.updatedAt));
    expect(depois.createdAt).toBe(antes.createdAt);

    // Apagar também é mexer no envio.
    await deleteQuarantineFile(segundo, 'docs/extra.md', SOURCE, bruno);
    const final = (await getQuarantine(segundo))!;
    expect(Date.parse(final.updatedAt)).toBeGreaterThan(Date.parse(depois.updatedAt));
  });

  it('escritas simultâneas no mesmo envio se enfileiram, sem deadlock', async () => {
    const envio = await createQuarantine(
      { name: 'Concorrido', files: [{ relativePath: 'SKILL.md', content: '# base\n' }] },
      SOURCE,
      bruno,
    );

    // A fila é a trava da linha do envio (`FOR UPDATE`, a primeira statement):
    // toda escrita pede o envio e só então `quarantine_files`, nessa ordem.
    // Sem ordem única, pares assim é que morreriam com 40P01 (500).
    const resultados = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        outcome(setQuarantineFile(envio.uuid, `f${i % 2}.md`, `v${i}`, SOURCE, bruno)),
      ),
    );
    expect(resultados).toEqual(Array.from({ length: 8 }, () => null));

    const depois = (await getQuarantine(envio.uuid))!;
    expect(depois.files.map((f) => f.relativePath)).toEqual(['SKILL.md', 'f0.md', 'f1.md']);

    // E a remoção do envio espera as escritas em andamento, em vez de deixar
    // uma delas com 23503 no meio.
    const [apagou, ...escritas] = await Promise.all([
      outcome(deleteQuarantine(envio.uuid, SOURCE, ana)),
      outcome(setQuarantineFile(envio.uuid, 'tarde.md', 'x', SOURCE, bruno)),
      outcome(setQuarantineFile(envio.uuid, 'tarde2.md', 'x', SOURCE, bruno)),
    ]);
    expect(apagou).toBeNull();
    // Quem chegou depois recebe o 404 do envio que sumiu — nunca erro interno.
    for (const escrita of escritas) expect(escrita === null || escrita.status === 404).toBe(true);
    expect(await getQuarantine(envio.uuid)).toBeNull();
  });

  it('a listagem recorta por dono, busca com termo literal e pagina', async () => {
    expect((await listQuarantine({ ownerUserUuid: bruno.userUuid })).total).toBe(2);
    // `null` é "nenhum dono possível" — a sessão de bootstrap, que não é conta.
    expect(await listQuarantine({ ownerUserUuid: null })).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    expect((await listQuarantine({ ownerUserUuid: 'não-é-uuid' })).total).toBe(0);
    expect((await listQuarantine({ ownerUserUuid: ana.userUuid })).total).toBe(0);

    // O termo casa nome e descrição, e `%` é caractere, não curinga.
    expect((await listQuarantine({ search: 'relat' })).total).toBe(2);
    expect((await listQuarantine({ search: 'mensais' })).total).toBe(1);
    expect((await listQuarantine({ search: '%' })).total).toBe(0);
    expect((await listQuarantine({ search: '   ' })).total).toBe(2);

    const pagina = await listQuarantine({ limit: 1, offset: 1 });
    expect(pagina).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(pagina.items.map((item) => item.uuid)).toEqual([primeiro]);
    // Além do fim: página vazia com o total certo, nunca erro.
    expect((await listQuarantine({ offset: 9_999 })).items).toEqual([]);
  });

  it('uuid torto é `null` na leitura e 404 na escrita', async () => {
    expect(await getQuarantine('não-é-uuid')).toBeNull();
    expect(await getQuarantine('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await readQuarantineFile('não-é-uuid', 'SKILL.md')).toBeNull();
    expect(await readAllQuarantineFiles('não-é-uuid')).toEqual([]);

    expect((await outcome(deleteQuarantine('não-é-uuid', SOURCE, ana)))?.status).toBe(404);
    expect(
      (await outcome(setQuarantineFile('não-é-uuid', 'a.md', 'x', SOURCE, ana)))?.status,
    ).toBe(404);
    expect((await outcome(promoteQuarantine('não-é-uuid', SOURCE, ana)))?.status).toBe(404);
    expect(
      (await outcome(
        deleteQuarantine('00000000-0000-0000-0000-000000000000', SOURCE, ana),
      ))?.status,
    ).toBe(404);
  });

  it('a cascata: apagar o envio leva os arquivos junto', async () => {
    const envio = await createQuarantine(
      {
        name: 'Descartável',
        files: [
          { relativePath: 'SKILL.md', content: '# nada\n' },
          { relativePath: 'a.md', content: 'a' },
        ],
      },
      SOURCE,
      bruno,
    );
    expect(await conta('SELECT count(*) AS n FROM quarantine_files WHERE quarantine_uuid = $1', [envio.uuid])).toBe(2);

    await deleteQuarantine(envio.uuid, SOURCE, ana);

    expect(await getQuarantine(envio.uuid)).toBeNull();
    expect(await conta('SELECT count(*) AS n FROM quarantine_files WHERE quarantine_uuid = $1', [envio.uuid])).toBe(0);

    const trilha = await listAuditPage({ action: 'quarantine.delete' });
    expect(trilha.items[0]).toMatchObject({
      action: 'quarantine.delete',
      targetLabel: 'Descartável',
      actorLabel: ana.label,
      skillSlug: null,
    });
  });

  it('ON DELETE SET NULL: a conta removida deixa o envio órfão, não o apaga', async () => {
    const dono = await createUser({ email: 'dodo@exemplo.dev', name: 'Dodô', role: 'editor' });
    const ator = { userUuid: dono.uuid, label: dono.email };
    const envio = await createQuarantine(
      { name: 'Do Dodô', files: [{ relativePath: 'SKILL.md', content: '# oi\n' }] },
      SOURCE,
      ator,
    );
    expect(envio.ownerUserUuid).toBe(dono.uuid);

    await raw.query('DELETE FROM users WHERE uuid = $1', [dono.uuid]);

    const depois = (await getQuarantine(envio.uuid))!;
    expect(depois.ownerUserUuid).toBeNull();
    expect(depois.ownerEmail).toBeNull();
    expect(depois.files.map((f) => f.relativePath)).toEqual(['SKILL.md']);
    // `created_by_user_uuid` tem a mesma FK: nenhum uuid pendurado.
    expect(
      await conta('SELECT count(*) AS n FROM quarantine_skills WHERE created_by_user_uuid IS NOT NULL AND uuid = $1', [envio.uuid]),
    ).toBe(0);

    await deleteQuarantine(envio.uuid, SOURCE, ana);
  });

  // ------------------------------------------------------- a promoção -----

  it('promoção sem SKILL.md é recusada — e nada é apagado', async () => {
    const envio = await createQuarantine(
      {
        name: 'Pacote incompleto',
        files: [{ relativePath: 'notas.md', content: 'só isto' }],
      },
      SOURCE,
      bruno,
    );

    const erro = await outcome(promoteQuarantine(envio.uuid, SOURCE, ana));
    expect(erro?.status).toBe(400);
    expect(erro?.message).toContain('não tem SKILL.md');
    expect(erro?.message).toContain('Pacote incompleto');

    // O envio continua inteiro, e nenhuma skill nasceu.
    const depois = (await getQuarantine(envio.uuid))!;
    expect(depois.files.map((f) => f.relativePath)).toEqual(['notas.md']);
    expect(await conta("SELECT count(*) AS n FROM skills WHERE name = 'Pacote incompleto'")).toBe(0);
    expect((await listAuditPage({ action: 'quarantine.promote' })).total).toBe(0);

    // Acrescentar o arquivo que falta é o conserto.
    await createQuarantineFile(envio.uuid, 'SKILL.md', '# Agora vai\n', SOURCE, bruno);
    const skill = await promoteQuarantine(envio.uuid, SOURCE, ana);
    expect(skill.name).toBe('Agora vai');
    expect(await getQuarantine(envio.uuid)).toBeNull();
  });

  /** A skill que ocupa o slug `relatorios` antes da promoção. */
  let promovida = '';

  it('a promoção cria a skill com quem aprovou nas duas colunas de conta', async () => {
    // O slug derivado do frontmatter já está ocupado: a colisão resolve
    // sozinha, com sufixo, em vez de devolver 409 a quem aprova.
    await createSkill({ name: 'Relatórios', slug: 'relatorios', skillMd: '# outra\n' }, SOURCE, ana);

    const skill = await promoteQuarantine(primeiro, SOURCE, ana);
    promovida = skill.slug;

    expect(skill.slug).toBe('relatorios-2');
    expect(skill.name).toBe('Relatórios');
    expect(skill.description).toBe('Relatórios mensais');
    expect(skill.tags).toEqual(['financeiro', 'vendas']);
    // O corpo gravado é o SKILL.md **sem** o frontmatter.
    expect(skill.skillMd).toBe('# Relatórios\n\nCorpo do prompt.\n');
    expect(skill.skillMd).not.toContain('name: relatorios');

    // Quem aprovou é o dono **e** o criador: promover é criar a skill. O envio
    // é de Bruno e não deixa rastro de conta na linha de `skills`.
    expect(skill.ownerUserUuid).toBe(ana.userUuid);
    expect(skill.ownerEmail).toBe(ana.label);
    const { rows } = await raw.query<{ created_by_user_uuid: string }>(
      'SELECT created_by_user_uuid FROM skills WHERE slug = $1',
      [skill.slug],
    );
    expect(rows[0]?.created_by_user_uuid).toBe(ana.userUuid);

    // Nasce flutuante: sem vMCP, sem catálogo e privada.
    expect(skill.mcps).toEqual([]);
    expect(skill.catalogs).toEqual([]);
    expect(skill.isPublic).toBe(false);
    expect(skill.isActive).toBe(true);
    expect(skill.icon).toBeNull();

    // Os anexos vieram com o caminho intacto, e o binário byte a byte.
    expect(skill.files.map((f) => f.relativePath)).toEqual([
      'SKILL.md',
      'dados.csv',
      'docs/uso.md',
      'img/logo.png',
      'Notas.MD',
    ]);
    expect(skill.files.find((f) => f.relativePath === 'img/logo.png')?.isText).toBe(false);
    expect(skill.files.find((f) => f.relativePath === 'dados.csv')?.sizeBytes).toBe(
      CSV_LATIN1.byteLength,
    );

    // E o envio sumiu, com os arquivos dele.
    expect(await getQuarantine(primeiro)).toBeNull();
    expect(await conta('SELECT count(*) AS n FROM quarantine_files WHERE quarantine_uuid = $1', [primeiro])).toBe(0);
    expect((await listQuarantine()).items.map((item) => item.uuid)).toEqual([segundo]);
  });

  it('a promoção audita `quarantine.promote` com o nome do envio e o slug criado', async () => {
    const trilha = await listAuditPage({ action: 'quarantine.promote' });
    expect(trilha.items[0]).toMatchObject({
      action: 'quarantine.promote',
      targetLabel: `Relatórios -> ${promovida}`,
      actorLabel: ana.label,
      // O envio não tem slug: quem nomeia o alvo é o `target_label`.
      skillUuid: null,
      skillSlug: null,
    });

    // A criação da skill audita o que já auditaria.
    const criacao = await listAuditPage({ action: 'create', q: promovida });
    expect(criacao.items.some((item) => item.skillSlug === promovida)).toBe(true);
  });

  it('a skill promovida entra na fila do RAG; a quarentena não é vista pelo indexador', async () => {
    const { rows } = await raw.query<{ rag_stale: boolean }>(
      'SELECT rag_stale FROM skills WHERE slug = $1',
      [promovida],
    );
    expect(rows[0]?.rag_stale).toBe(true);

    const reservadas = await claimStaleSkills(50);
    const alvo = (await getSkillDetail(promovida, { visibility: 'all' }))!;
    expect(reservadas).toContain(alvo.uuid);

    // Tudo o que o indexador reserva é skill: nenhum uuid de envio entra.
    expect(
      await conta(
        'SELECT count(*) AS n FROM rag_skill_claims c LEFT JOIN skills s ON s.uuid = c.skill_uuid WHERE s.uuid IS NULL',
      ),
    ).toBe(0);

    // Nenhum trigger de RAG alcança as tabelas novas: só o carimbo de
    // `updated_at` está pendurado nelas.
    const { rows: triggers } = await raw.query<{ tabela: string; tgname: string }>(
      `SELECT c.relname AS tabela, t.tgname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname IN ('quarantine_skills', 'quarantine_files') AND NOT t.tgisinternal
        ORDER BY t.tgname`,
    );
    expect(triggers).toEqual([
      { tabela: 'quarantine_files', tgname: 'quarantine_files_touch_trg' },
    ]);

    // E nenhuma coluna de RAG: sem `rag_stale`, sem `content_sha256`.
    const { rows: colunas } = await raw.query<{ attname: string }>(
      `SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relname IN ('quarantine_skills', 'quarantine_files')
          AND a.attname IN ('rag_stale', 'content_sha256', 'search_vector')`,
    );
    expect(colunas).toEqual([]);
  });

  it('envio de uma conta promovido por outra: a skill sai com quem aprovou', async () => {
    // O caso que reverteu a regra: com a política `admin+editor`, quem aprovava
    // o envio alheio criava uma skill privada, flutuante e sem concessão
    // nenhuma — e deixava de enxergá-la no mesmo instante.
    const envio = await createQuarantine(
      {
        name: 'Enviado pelo Bruno',
        files: [{ relativePath: 'SKILL.md', content: '# Enviado pelo Bruno\n' }],
      },
      SOURCE,
      bruno,
    );

    const skill = await promoteQuarantine(envio.uuid, SOURCE, ana);
    expect(skill.ownerUserUuid).toBe(ana.userUuid);
    expect(skill.ownerEmail).toBe(ana.label);
    // Sem concessão nenhuma: o acesso de quem aprovou vem de ser dono.
    expect(skill.grants).toEqual([]);

    const { rows } = await raw.query<{ created_by_user_uuid: string }>(
      'SELECT created_by_user_uuid FROM skills WHERE slug = $1',
      [skill.slug],
    );
    expect(rows[0]?.created_by_user_uuid).toBe(ana.userUuid);

    // É o que o defeito quebrava: quem aprovou enxerga o que acabou de criar.
    // A leitura passa `role: 'editor'` de propósito — com `admin` tudo é
    // visível e o caso do editor que aprova não apareceria.
    const deQuemAprovou = await getSkillSummary(skill.slug, {
      viewer: { role: 'editor', userUuid: ana.userUuid },
    });
    expect(deQuemAprovou?.access).toBe('owner');

    // Quem submeteu não enxerga mais: devolver o acesso é transferir ou
    // conceder, que são atos com trilha.
    expect(
      await getSkillSummary(skill.slug, { viewer: { role: 'editor', userUuid: bruno.userUuid } }),
    ).toBeNull();
  });

  // ----------------------------------------- o SKILL.md que não é UTF-8 ----

  /** O envio cujo SKILL.md veio em UTF-16: o pacote torto que a quarentena aceita. */
  let torto = '';

  it('o SKILL.md que não é UTF-8 entra no envio e volta byte a byte', async () => {
    const envio = await createQuarantine(
      {
        name: 'Pacote em UTF-16',
        files: [
          { relativePath: 'SKILL.md', content: SKILL_MD_UTF16 },
          { relativePath: 'notas.md', content: 'anexo em UTF-8' },
        ],
      },
      SOURCE,
      bruno,
    );
    torto = envio.uuid;

    // Mime textual, bytes que não são UTF-8: entra como binário, como qualquer
    // anexo. Em `files` este mesmo arquivo é 400.
    expect(envio.files.find((f) => f.relativePath === 'SKILL.md')).toEqual({
      relativePath: 'SKILL.md',
      mimeType: 'text/markdown',
      sizeBytes: SKILL_MD_UTF16.byteLength,
      isText: false,
    });

    const lido = await readQuarantineFile(torto, 'SKILL.md');
    expect(lido?.isText).toBe(false);
    expect(lido?.buffer.equals(SKILL_MD_UTF16)).toBe(true);
    expect(lido?.sizeBytes).toBe(SKILL_MD_UTF16.byteLength);

    // Os outros dois caminhos de gravação seguem a mesma régua: o upsert de um
    // arquivo só e a criação de um caminho livre.
    expect(await setQuarantineFile(torto, 'SKILL.md', SKILL_MD_UTF16, SOURCE, bruno)).toEqual({
      relativePath: 'SKILL.md',
      mimeType: 'text/markdown',
      sizeBytes: SKILL_MD_UTF16.byteLength,
      isText: false,
    });
    const outro = await createQuarantine({ name: 'Outro torto' }, SOURCE, bruno);
    expect(
      await createQuarantineFile(outro.uuid, 'SKILL.md', SKILL_MD_UTF16, SOURCE, bruno),
    ).toMatchObject({ relativePath: 'SKILL.md', isText: false });
    await deleteQuarantine(outro.uuid, SOURCE, bruno);
  });

  it('promover o SKILL.md binário é recusado — e nada é apagado', async () => {
    const antes = (await getQuarantine(torto))!;

    const erro = await outcome(promoteQuarantine(torto, SOURCE, ana));
    expect(erro?.status).toBe(400);
    expect(erro?.message).toContain('não é um texto UTF-8 válido');
    expect(erro?.message).toContain('Pacote em UTF-16');
    // A mensagem diz o que fazer, e onde.
    expect(erro?.message).toContain('converta o arquivo para UTF-8');
    expect(erro?.message).toContain('quarentena');

    // O envio continua inteiro — arquivos, bytes e datas —, e nenhuma skill
    // nasceu: a mesma garantia do envio sem SKILL.md.
    const depois = (await getQuarantine(torto))!;
    expect(depois).toEqual(antes);
    expect((await readQuarantineFile(torto, 'SKILL.md'))?.buffer.equals(SKILL_MD_UTF16)).toBe(true);
    expect((await readQuarantineFile(torto, 'notas.md'))?.buffer.toString('utf8')).toBe(
      'anexo em UTF-8',
    );
    expect(await conta("SELECT count(*) AS n FROM skills WHERE name = 'Pacote em UTF-16'")).toBe(0);

    // O conserto é dentro do próprio envio: salvar o arquivo em UTF-8.
    await setQuarantineFile(torto, 'SKILL.md', '# Pacote em UTF-16\n\nCorpo.\n', SOURCE, bruno);
    const skill = await promoteQuarantine(torto, SOURCE, ana);
    expect(skill.skillMd).toBe('# Pacote em UTF-16\n\nCorpo.\n');
    expect(skill.files.find((f) => f.relativePath === 'SKILL.md')?.isText).toBe(true);
    expect(await getQuarantine(torto)).toBeNull();
  });

  it('em `files` o mesmo SKILL.md continua recusado: a regra de lá não mudou', async () => {
    const skill = await createSkill(
      { name: 'Régua de files', slug: 'regua-de-files', skillMd: '# corpo original\n' },
      SOURCE,
      ana,
    );

    const erro = await outcome(setFile('regua-de-files', 'SKILL.md', SKILL_MD_UTF16, SOURCE, ana));
    expect(erro?.status).toBe(400);
    expect(erro?.message).toBe('O SKILL.md precisa ser um texto UTF-8 válido, sem byte nulo');

    // Nada foi gravado: o corpo da skill é o de antes.
    expect((await getSkillDetail('regua-de-files', { visibility: 'all' }))?.skillMd).toBe(
      '# corpo original\n',
    );
    // E o arquivo torto continua sendo binário comum em qualquer outro caminho.
    expect(await setFile('regua-de-files', 'docs/leia.md', SKILL_MD_UTF16, SOURCE, ana)).toMatchObject({
      isText: false,
      sizeBytes: SKILL_MD_UTF16.byteLength,
    });
    expect(skill.slug).toBe('regua-de-files');
  });

  // ------------------------------------------------------- a política -----

  it('quem aprova: o valor inválido é 400 e a troca é auditada', async () => {
    expect(await setQuarantineApprovers('admin', SOURCE, ana)).toBe('admin');
    expect(await getQuarantineApprovers()).toBe('admin');

    for (const torto of ['admin+todos', '', 'ADMIN', 42, null, undefined, {}]) {
      const erro = await outcome(setQuarantineApprovers(torto, SOURCE, ana));
      expect(erro?.status).toBe(400);
      expect(erro?.message).toContain('admin+owner');
    }
    // A recusa não gravou nada.
    expect(await getQuarantineApprovers()).toBe('admin');

    const trilha = await listAuditPage({ action: 'quarantine.settings' });
    expect(trilha.total).toBe(1);
    expect(trilha.items[0]).toMatchObject({
      targetLabel: 'quarantine.approvers=admin',
      actorLabel: ana.label,
    });
  });

  it('o CHECK de audit_log aceita as cinco ações novas e recusa o que não conhece', async () => {
    await expect(
      raw.query(`INSERT INTO audit_log (action, source) VALUES ('quarantine.zzz', 'web-admin')`),
    ).rejects.toThrow(/audit_log_action_check/);

    for (const acao of [
      'quarantine.create',
      'quarantine.update',
      'quarantine.delete',
      'quarantine.promote',
      'quarantine.settings',
    ]) {
      await raw.query(
        `INSERT INTO audit_log (action, source, target_label) VALUES ($1, 'mcp-admin', 'teste')`,
        [acao],
      );
    }
    await raw.query("DELETE FROM audit_log WHERE target_label = 'teste'");

    // As ações antigas continuam na lista: o CHECK é sempre o superconjunto.
    await raw.query(
      `INSERT INTO audit_log (action, source, target_label) VALUES ('rag.reindex', 'web-admin', '0 skills')`,
    );
    await raw.query("DELETE FROM audit_log WHERE target_label = '0 skills'");
  });

  // --------------------------------------------- a migration, de novo -----

  it('30 — reaplicar a 030 sobre o resultado não muda nada', async () => {
    const antes = {
      envios: await conta('SELECT count(*) AS n FROM quarantine_skills'),
      arquivos: await conta('SELECT count(*) AS n FROM quarantine_files'),
      skills: await conta('SELECT count(*) AS n FROM skills'),
      trilha: await conta('SELECT count(*) AS n FROM audit_log'),
    };
    const estrutura = async () => {
      const { rows } = await raw.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename LIKE 'quarantine_%' ORDER BY indexname`,
      );
      return rows.map((r) => r.indexname);
    };
    const indices = await estrutura();

    // Apagar do histórico é o que força o runner a rodar o arquivo de novo —
    // uma segunda chamada normal só o pularia. Aqui é de propósito, sem a
    // recusa de retroativa: a `030` é a última da pasta.
    await raw.query("DELETE FROM schema_migrations WHERE name = '030-quarentena.sql'");
    expect(await runMigrations(url!)).toEqual(['030-quarentena.sql']);

    expect({
      envios: await conta('SELECT count(*) AS n FROM quarantine_skills'),
      arquivos: await conta('SELECT count(*) AS n FROM quarantine_files'),
      skills: await conta('SELECT count(*) AS n FROM skills'),
      trilha: await conta('SELECT count(*) AS n FROM audit_log'),
    }).toEqual(antes);
    expect(await estrutura()).toEqual(indices);

    // A semeadura é `ON CONFLICT DO NOTHING`: a política escolhida fica.
    expect(await getQuarantineApprovers()).toBe('admin');

    // O envio que sobrou continua legível, com os arquivos dele.
    const restante = (await getQuarantine(segundo))!;
    expect(restante.files.map((f) => f.relativePath)).toEqual(['SKILL.md', 'notas.md']);
  }, 60_000);
});
