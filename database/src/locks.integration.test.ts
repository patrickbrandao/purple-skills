/**
 * Teste de integração da **ordem de travas** no recorte de um MCP virtual —
 * exige um PostgreSQL 18 real (`tasks/023`).
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/locks.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 *
 * A fila das escritas de **arquivo** (`tasks/022`) está em
 * `files.integration.test.ts`; aqui ficam o vínculo skill ↔ vMCP, o canvas, o
 * recorte declarativo e o registro de acesso. Os laços de pares concorrentes
 * são curtos de propósito: o que eles pegam é a volta de um deadlock que, antes,
 * matava de 1 em 6 a 1 em 1 dos pares — não uma corrida rara.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import type { AppError } from './errors.js';
import { runMigrations } from './migrate.js';
import {
  createCatalog,
  createSkill,
  createVirtualMcp,
  deleteVirtualMcp,
  getVirtualMcpByUuid,
  linkCatalog,
  linkSkill,
  recordSkillAccess,
  setVirtualMcpCanvas,
  setVirtualMcpSkills,
  unlinkCatalog,
  unlinkSkill,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;
const ATOR = { userUuid: null, label: 'travas' };

/** O mesmo número das outras suítes de integração: elas recriam o mesmo banco. */
const SCHEMA_LOCK = 8_200_004;

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

const PORTAS = { asSkill: true, asPrompt: false, asResource: false };
const portas = (i: number) => ({ asSkill: true, asPrompt: i % 2 === 0, asResource: i % 3 === 0 });

describe.skipIf(!url)('ordem de travas no recorte do vMCP', () => {
  let lock: pg.Client;
  let serie = 0;

  /** Uma skill vinculada a um vMCP, os dois novos. */
  async function cena(): Promise<{ slug: string; skill: string; mcp: string }> {
    serie += 1;
    const skill = await createSkill({ name: 'Travas', slug: `travas-${serie}`, skillMd: '# x' }, SOURCE, ATOR);
    const mcp = await createVirtualMcp(
      { name: 'Travas', slug: `travas-mcp-${serie}`, isOpen: true, ownerUserUuid: null },
      SOURCE,
      ATOR,
    );
    await linkSkill(skill.slug, mcp.uuid, PORTAS, SOURCE, ATOR);
    return { slug: skill.slug, skill: skill.uuid, mcp: mcp.uuid };
  }

  /** Há um backend deste banco parado em trava, rodando uma query que casa o padrão. */
  async function paradoEm(padrao: string): Promise<boolean> {
    const { rows } = await lock.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query LIKE $1`,
      [padrao],
    );
    return rows.length > 0;
  }

  async function cliente(): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    return c;
  }

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

  it('linkSkill e unlinkSkill esperam o canvas no vMCP, sem segurar o vínculo', async () => {
    const c = await cena();
    const canvas = await cliente();
    try {
      // O que `setVirtualMcpCanvas` faz primeiro.
      await canvas.query('BEGIN');
      await canvas.query('SELECT uuid FROM virtual_mcps WHERE uuid = $1 FOR NO KEY UPDATE', [c.mcp]);

      const troca = outcome(linkSkill(c.slug, c.mcp, { asSkill: true, asPrompt: true, asResource: true }, SOURCE, ATOR));
      await waitFor(() => paradoEm('%FROM virtual_mcps%FOR NO KEY UPDATE%'));

      // Na ordem antiga o `linkSkill` já seguraria este vínculo, esperando o
      // vMCP — e este UPDATE fecharia o ciclo (40P01, 28 de 150 pares).
      await canvas.query(
        'UPDATE virtual_mcp_skills SET pos_x = 10, pos_y = 20 WHERE virtual_mcp_uuid = $1 AND skill_uuid = $2',
        [c.mcp, c.skill],
      );
      await canvas.query('COMMIT');
      expect(await troca).toBeNull();

      // Enfileirada, a troca de porta valeu por cima da posição que o canvas gravou.
      expect((await getVirtualMcpByUuid(c.mcp))?.skills[0]).toMatchObject({
        asPrompt: true,
        asResource: true,
        position: { x: 10, y: 20 },
      });

      await canvas.query('BEGIN');
      await canvas.query('SELECT uuid FROM virtual_mcps WHERE uuid = $1 FOR NO KEY UPDATE', [c.mcp]);
      const saida = outcome(unlinkSkill(c.slug, c.mcp, SOURCE, ATOR));
      await waitFor(() => paradoEm('%FROM virtual_mcps%FOR NO KEY UPDATE%'));
      await canvas.query(
        'UPDATE virtual_mcp_skills SET pos_x = 30, pos_y = 40 WHERE virtual_mcp_uuid = $1 AND skill_uuid = $2',
        [c.mcp, c.skill],
      );
      await canvas.query('COMMIT');
      expect(await saida).toBeNull();
    } finally {
      await canvas.end();
    }

    expect((await getVirtualMcpByUuid(c.mcp))?.skills).toEqual([]);
  });

  it('as travas do recorte são FOR NO KEY UPDATE: não barram a FK de quem insere filho do vMCP', async () => {
    const c = await cena();
    const catalogo = await createCatalog({ name: 'Travas', slug: 'travas-catalogo', ownerUserUuid: null }, SOURCE, ATOR);
    await linkCatalog(c.mcp, catalogo.uuid, PORTAS, SOURCE, ATOR);

    const segura = await cliente();
    const fk = await cliente();
    try {
      // Cada função real é pausada DEPOIS de travar o vMCP (segurando uma linha
      // que ela pede em seguida), e um terceiro cliente pede o que a FK de
      // `skill_accesses` / `mcp_sessions` pede. Com `FOR UPDATE` no vMCP, o
      // NOWAIT abaixo falharia com 55P03 — e `recordSkillAccess` esperaria ali
      // segurando o vínculo: o par adjacente do `tasks/023`.
      const pausas: [nome: string, linha: string, chamada: () => Promise<unknown>, parada: string][] = [
        [
          'setVirtualMcpCanvas',
          'UPDATE virtual_mcp_skills SET pos_x = 1, pos_y = 1 WHERE virtual_mcp_uuid = $1',
          () => setVirtualMcpCanvas(c.mcp, { positions: [{ slug: c.slug, x: 5, y: 5 }] }),
          '%UPDATE virtual_mcp_skills v SET pos_x%',
        ],
        [
          'setVirtualMcpSkills',
          'UPDATE virtual_mcp_skills SET pos_x = 2, pos_y = 2 WHERE virtual_mcp_uuid = $1',
          () => setVirtualMcpSkills(c.mcp, [{ slug: c.slug, ...PORTAS }], SOURCE, ATOR),
          '%INSERT INTO virtual_mcp_skills%',
        ],
        [
          'linkSkill',
          'UPDATE virtual_mcp_skills SET pos_x = 3, pos_y = 3 WHERE virtual_mcp_uuid = $1',
          () => linkSkill(c.slug, c.mcp, portas(1), SOURCE, ATOR),
          '%INSERT INTO virtual_mcp_skills%',
        ],
        [
          'unlinkCatalog (lockVirtualMcpTx)',
          'UPDATE virtual_mcp_catalogs SET pos_x = 4, pos_y = 4 WHERE virtual_mcp_uuid = $1',
          () => unlinkCatalog(c.mcp, catalogo.uuid, SOURCE, ATOR),
          '%DELETE FROM virtual_mcp_catalogs%',
        ],
      ];

      for (const [nome, linha, chamada, parada] of pausas) {
        await segura.query('BEGIN');
        await segura.query(linha, [c.mcp]);
        const pendente = outcome(chamada());
        await waitFor(() => paradoEm(parada));

        const chave = await fk.query('SELECT 1 FROM virtual_mcps WHERE uuid = $1 FOR KEY SHARE NOWAIT', [c.mcp]).then(
          () => 'passou',
          (err: { code?: string }) => err.code,
        );
        expect(chave, nome).toBe('passou');

        await segura.query('COMMIT');
        expect(await pendente, nome).toBeNull();
      }
    } finally {
      await segura.end();
      await fk.end();
    }
  });

  it('quem escreve no recorte só GRAVA no vMCP depois de ter os vínculos: até lá a linha fica travada, não atualizada', async (ctx) => {
    // A segunda metade da regra de `linkTx`. Uma checagem de FK (`FOR KEY SHARE`)
    // não espera um `FOR NO KEY UPDATE` — salvo quando segue a cadeia de versões
    // de uma linha e esbarra numa versão **ainda não commitada**: aí ela espera o
    // UPDATE em andamento. Com o `UPDATE virtual_mcps` adiantado para o começo,
    // `recordSkillAccess` (que segura o vínculo e depois confere a FK com o vMCP)
    // fechava ciclo com quem atualizou o vMCP e esperava o vínculo: 3 mortes por
    // 40P01 em 34 mil operações mistas, "while rechecking updated tuple" no log;
    // com trava pura no começo e o UPDATE no fim, nenhuma em 58 mil. A corrida em
    // si não é reproduzível a pedido, então o que se confere aqui é a forma: com
    // a função pausada no vínculo, o `pgrowlocks` mostra `For No Key Update`
    // (trava) e não `No Key Update` (linha já atualizada) no vMCP.
    const disponivel = await lock.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'pgrowlocks'`);
    if (disponivel.rows.length === 0) {
      console.warn('[locks] pgrowlocks (contrib) não está disponível neste servidor — conferência pulada');
      ctx.skip();
      return;
    }
    await lock.query('CREATE EXTENSION IF NOT EXISTS pgrowlocks');

    const c = await cena();
    const segura = await cliente();
    try {
      const pausas: [nome: string, chamada: () => Promise<unknown>, parada: string][] = [
        ['linkSkill', () => linkSkill(c.slug, c.mcp, portas(2), SOURCE, ATOR), '%INSERT INTO virtual_mcp_skills%'],
        [
          'setVirtualMcpCanvas com layout',
          () => setVirtualMcpCanvas(c.mcp, { layout: { server: { x: 7, y: 7 } }, positions: [{ slug: c.slug, x: 8, y: 8 }] }),
          '%UPDATE virtual_mcp_skills v SET pos_x%',
        ],
        ['setVirtualMcpSkills', () => setVirtualMcpSkills(c.mcp, [{ slug: c.slug, ...PORTAS }], SOURCE, ATOR), '%INSERT INTO virtual_mcp_skills%'],
        ['unlinkSkill', () => unlinkSkill(c.slug, c.mcp, SOURCE, ATOR), '%DELETE FROM virtual_mcp_skills%'],
      ];

      for (const [nome, chamada, parada] of pausas) {
        await segura.query('BEGIN');
        await segura.query('UPDATE virtual_mcp_skills SET pos_x = 1, pos_y = 1 WHERE virtual_mcp_uuid = $1', [c.mcp]);
        const pendente = outcome(chamada());
        await waitFor(() => paradoEm(parada));

        const { rows } = await lock.query(
          `SELECT p.modes::text AS modos
             FROM virtual_mcps m JOIN pgrowlocks('virtual_mcps') p ON p.locked_row = m.ctid
            WHERE m.uuid = $1`,
          [c.mcp],
        );
        expect(rows.map((row) => row.modos), nome).toEqual(['{"For No Key Update"}']);

        await segura.query('COMMIT');
        expect(await pendente, nome).toBeNull();
      }
    } finally {
      await segura.end();
      await lock.query('DROP EXTENSION IF EXISTS pgrowlocks');
    }
  });

  it('pares concorrentes no mesmo vínculo: ninguém morre por deadlock', async () => {
    const c = await cena();
    const acesso = () =>
      recordSkillAccess({
        skillUuid: c.skill,
        kind: 'view',
        surface: 'tool',
        origin: 'mcp',
        auth: 'open',
        virtualMcpUuid: c.mcp,
        ip: '127.0.0.1',
      });
    const canvas = (i: number) => setVirtualMcpCanvas(c.mcp, { layout: { server: { x: i, y: i } }, positions: [{ slug: c.slug, x: i, y: i }] });
    const recorte = (i: number) => setVirtualMcpSkills(c.mcp, [{ slug: c.slug, ...portas(i) }], SOURCE, ATOR);

    // Antes: 28, 59 e 26 mortes (40P01 → 500) em 150 pares de cada tipo.
    for (let i = 0; i < 20; i += 1) {
      expect(await Promise.all([outcome(linkSkill(c.slug, c.mcp, portas(i), SOURCE, ATOR)), outcome(canvas(i))])).toEqual([null, null]);
      expect(await Promise.all([outcome(linkSkill(c.slug, c.mcp, portas(i), SOURCE, ATOR)), outcome(recorte(i))])).toEqual([null, null]);
      expect(await Promise.all([outcome(acesso()), outcome(recorte(i))])).toEqual([null, null]);
      expect(await Promise.all([outcome(acesso()), outcome(canvas(i))])).toEqual([null, null]);
    }

    // Com o desvínculo no par, o outro lado pode chegar depois e não achar o
    // vínculo: é 400 de negócio, nunca erro interno. Antes: 57 mortes em 150.
    for (let i = 0; i < 12; i += 1) {
      await linkSkill(c.slug, c.mcp, PORTAS, SOURCE, ATOR);
      const [saida, posicao] = await Promise.all([outcome(unlinkSkill(c.slug, c.mcp, SOURCE, ATOR)), outcome(canvas(i))]);
      expect(saida).toBeNull();
      if (posicao !== null) expect(posicao).toMatchObject({ status: 400 });
    }
  });

  it('createSkill publicando nos mesmos servidores em ordens opostas não trava em cruz', async () => {
    const um = await createVirtualMcp({ name: 'Um', slug: 'travas-um', isOpen: true, ownerUserUuid: null }, SOURCE, ATOR);
    const dois = await createVirtualMcp({ name: 'Dois', slug: 'travas-dois', isOpen: true, ownerUserUuid: null }, SOURCE, ATOR);
    const vinculo = (uuid: string) => ({ virtualMcpUuid: uuid, ...PORTAS });

    // Antes: 149 de 150 pares perdiam uma das duas criações por 40P01.
    for (let i = 0; i < 6; i += 1) {
      const par = await Promise.all([
        outcome(createSkill({ name: 'Par A', slug: `par-a-${i}`, skillMd: '# a', mcps: [vinculo(um.uuid), vinculo(dois.uuid)] }, SOURCE, ATOR)),
        outcome(createSkill({ name: 'Par B', slug: `par-b-${i}`, skillMd: '# b', mcps: [vinculo(dois.uuid), vinculo(um.uuid)] }, SOURCE, ATOR)),
      ]);
      expect(par).toEqual([null, null]);
    }

    // A ordem fixa não muda o que é gravado: os dois servidores, uma linha de auditoria cada.
    expect((await getVirtualMcpByUuid(um.uuid))?.skills).toHaveLength(12);
    expect((await getVirtualMcpByUuid(dois.uuid))?.skills).toHaveLength(12);
    const { rows } = await lock.query(
      `SELECT target_label, count(*)::int AS n FROM audit_log
        WHERE action = 'mcp.update' AND target_label IN ('travas-um', 'travas-dois')
        GROUP BY target_label ORDER BY target_label`,
    );
    expect(rows).toEqual([
      { target_label: 'travas-dois', n: 12 },
      { target_label: 'travas-um', n: 12 },
    ]);
  });

  it('o vMCP apagado no meio de um linkSkill é o 400 de sempre, não erro interno', async () => {
    // A FK do INSERT (23503) subia crua: 44 de 100 pares respondiam 500.
    for (let i = 0; i < 10; i += 1) {
      const c = await cena();
      const [remocao, vinculo] = await Promise.all([
        outcome(deleteVirtualMcp(c.mcp, SOURCE, ATOR)),
        outcome(linkSkill(c.slug, c.mcp, portas(i), SOURCE, ATOR)),
      ]);
      expect(remocao).toBeNull();
      if (vinculo !== null) {
        expect(vinculo).toMatchObject({ status: 400, message: `MCP virtual não encontrado: ${c.mcp}` });
      }
    }
  });

  it('o canvas continua tudo ou nada com o layout gravado por último', async () => {
    const c = await cena();
    await setVirtualMcpCanvas(c.mcp, { layout: { server: { x: 1, y: 2 } }, positions: [{ slug: c.slug, x: 3, y: 4 }] });

    const recusa = await outcome(
      setVirtualMcpCanvas(c.mcp, {
        layout: { server: { x: 100, y: 200 } },
        positions: [
          { slug: c.slug, x: 300, y: 400 },
          { slug: 'nao-vinculada', x: 0, y: 0 },
        ],
      }),
    );
    expect(recusa).toMatchObject({ status: 400 });

    const detail = await getVirtualMcpByUuid(c.mcp);
    expect(detail?.layout).toEqual({ server: { x: 1, y: 2 } });
    expect(detail?.skills[0]?.position).toEqual({ x: 3, y: 4 });
  });
});
