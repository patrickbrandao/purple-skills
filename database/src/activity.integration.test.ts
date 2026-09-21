/**
 * Teste de integração da tela de Atividade (`mcp_call_counters`,
 * `schema/032-atividade.sql`) — exige um PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/activity.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 *
 * As quatro fontes da tela são datadas **no passado**, em dias distintos por
 * teste: cada asserção pergunta por uma faixa que só contém o que aquele teste
 * fabricou, e o que as outras suítes (e o `beforeAll` daqui) gravam com
 * `now()` fica de fora por construção.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { McpCallBucketInput } from '@purple-skills/shared';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import { AppError } from './errors.js';
import {
  activityOfDay,
  bumpMcpCallCounters,
  closeMcpSession,
  createSkill,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteVirtualMcp,
  listActivityDays,
  MCP_CALL_METHOD_MAX,
  openMcpSession,
  recordSkillAccess,
  updateSkill,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;
/** Quem assina o que a suíte cria — não é uma conta, como o bootstrap. */
const ACTOR = { userUuid: null, label: 'teste' };
/** O segundo ator da trilha, para `catalog.actors` contar dois sem identificar ninguém. */
const OUTRO = { userUuid: null, label: 'outro-teste' };
/**
 * U+0000 e ESC montados por código, e não por escape: uma ferramenta que
 * resolva o escape deixaria o byte literal neste arquivo.
 */
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
/**
 * Os formatadores invisíveis da categoria `Cf`, também montados por código: um
 * U+202E literal neste arquivo inverteria a leitura do código à volta dele na
 * tela de quem revisa — que é exatamente o estrago que o saneamento evita.
 */
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

const DIA_MS = 86_400_000;

/** O dia dos contadores: nenhuma outra fonte é datada nele. */
const BALDE = '2026-01-05T10:00:00.000Z';
const BALDE_INICIO = '2026-01-05T00:00:00.000Z';
const BALDE_FIM = '2026-01-05T23:59:59.999Z';

/**
 * O instante que **muda de dia** conforme o fuso: 02:30 UTC de 10/03 são 23:30
 * de **09/03** em São Paulo (UTC-3). É o caso que a série tem de provar.
 */
const VIRADA = '2026-03-10T02:30:00.000Z';
/** O mesmo dia nos dois fusos: 15:00 UTC = 12:00 em São Paulo. */
const MEIO_DIA = '2026-03-10T15:00:00.000Z';
const MARCO_INICIO = '2026-03-01T00:00:00.000Z';
const MARCO_FIM = '2026-03-31T23:59:59.999Z';

/** O dia do relatório completo. */
const RELATORIO_INICIO = '2026-05-20T00:00:00.000Z';
const RELATORIO_FIM = '2026-05-20T23:59:59.999Z';

let raw: pg.Client;
let alphaUuid = '';
let betaUuid = '';
let keyId = '';
let umUuid = '';
let doisUuid = '';

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

/** O relógio **do servidor**: a marca d'água não pode depender do relógio do cliente. */
async function agora(): Promise<Date> {
  return (await raw.query<{ t: Date }>('SELECT now() AS t')).rows[0]!.t;
}

/**
 * Recua para `instante` a trilha e os acessos gravados depois de `marca`. É
 * como a suíte data o que as queries reais escrevem com `now()`.
 */
async function recuar(marca: Date, instante: string): Promise<void> {
  await raw.query('UPDATE audit_log SET created_at = $1 WHERE created_at >= $2', [instante, marca]);
  await raw.query('UPDATE skill_accesses SET created_at = $1 WHERE created_at >= $2', [instante, marca]);
}

function abertura(overrides: Partial<Parameters<typeof openMcpSession>[0]> = {}) {
  return {
    sessionId: 'sess',
    transport: 'streamable' as const,
    mount: 'root' as const,
    virtualMcpUuid: alphaUuid,
    virtualMcpSlug: 'alpha',
    auth: 'open' as const,
    ip: '10.0.0.1',
    ...overrides,
  };
}

/** Abre uma sessão e a data no passado. */
async function sessaoEm(
  instante: string,
  overrides: Partial<Parameters<typeof openMcpSession>[0]> = {},
): Promise<string> {
  const id = await openMcpSession(abertura(overrides));
  await raw.query('UPDATE mcp_sessions SET started_at = $1, last_seen_at = $1 WHERE id = $2', [instante, id]);
  return id;
}

/** Encerra uma sessão e data o fim no passado. */
async function encerrarEm(id: string, reason: 'closed' | 'timeout' | 'shutdown', instante: string): Promise<void> {
  await closeMcpSession(id, reason);
  await raw.query('UPDATE mcp_sessions SET ended_at = $1 WHERE id = $2', [instante, id]);
}

function chamada(overrides: Partial<McpCallBucketInput> = {}): McpCallBucketInput {
  return {
    bucket: BALDE,
    virtualMcpUuid: alphaUuid,
    virtualMcpSlug: 'alpha',
    transport: 'streamable',
    method: 'tools/call',
    calls: 1,
    ...overrides,
  };
}

/** As linhas de contador de um balde, como estão no banco. */
async function contadores(bucket: string) {
  const result = await raw.query<{ method: string; family: string; calls: string; slug: string; uuid: string | null }>(
    `SELECT method, family, calls::text AS calls, virtual_mcp_slug AS slug, virtual_mcp_uuid AS uuid
       FROM mcp_call_counters WHERE bucket = $1 ORDER BY method`,
    [bucket],
  );
  return result.rows.map((row) => ({ ...row, calls: Number(row.calls) }));
}

/** As fatias como um objeto chave → contagem, que é o que as asserções comparam. */
function porChave(slices: readonly { key: string; count: number }[]): Record<string, number> {
  return Object.fromEntries(slices.map((slice) => [slice.key, slice.count]));
}

describe.skipIf(!url)('atividade: contadores de chamada, série por dia e relatório do dia', () => {
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

    alphaUuid = (
      await createVirtualMcp({ name: 'Alpha', isOpen: true, ownerUserUuid: null }, SOURCE, ACTOR)
    ).uuid;
    betaUuid = (await createVirtualMcp({ name: 'Beta', ownerUserUuid: null }, SOURCE, ACTOR)).uuid;
    keyId = (
      await createVirtualMcpKey({
        virtualMcpUuid: alphaUuid,
        name: 'agente',
        prefix: 'sss12345',
        keyHash: 'scrypt$x',
        createdByUserUuid: null,
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await closeDb();
    await raw.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK]);
    await raw.end();
  });

  it('soma no mesmo balde, achata o instante e não consulta com a lista vazia', async () => {
    await bumpMcpCallCounters([chamada({ calls: 4 }), chamada({ method: 'tools/list', calls: 2 })]);
    // Segundo despejo do mesmo balde: o UPSERT soma, não cria linha nova.
    await bumpMcpCallCounters([chamada({ calls: 6 })]);
    // Instante fora do passo de 15 min: cai no balde das 10:00, com os demais.
    await bumpMcpCallCounters([chamada({ bucket: '2026-01-05T10:07:33.123Z', method: 'ping', calls: 1 })]);

    expect(await contadores(BALDE)).toEqual([
      { method: 'ping', family: 'session', calls: 1, slug: 'alpha', uuid: alphaUuid },
      { method: 'tools/call', family: 'tools', calls: 10, slug: 'alpha', uuid: alphaUuid },
      { method: 'tools/list', family: 'tools', calls: 2, slug: 'alpha', uuid: alphaUuid },
    ]);

    // Lista vazia: devolve sem consultar e sem mexer em nada.
    await expect(bumpMcpCallCounters([])).resolves.toBeUndefined();
    expect((await contadores(BALDE)).length).toBe(3);

    const relatorio = await activityOfDay({ since: new Date(BALDE_INICIO), until: new Date(BALDE_FIM) });
    expect(relatorio.calls.total).toBe(13);
    expect(porChave(relatorio.calls.byFamily)).toEqual({ tools: 12, session: 1 });
    expect(relatorio.calls.topMethods[0]).toEqual({ key: 'tools/call', label: 'tools', count: 10 });
    expect(porChave(relatorio.calls.byServer)).toEqual({ alpha: 13 });
    expect(relatorio.calls.byServer[0]!.label).toBe('Alpha');
  });

  it('saneia o método: controle some, o gigante é cortado, o vazio é descartado e o lote deduplica', async () => {
    const bucket = '2026-01-05T12:00:00.000Z';
    await bumpMcpCallCounters([
      // Os dois viram `tools/call` depois da limpeza: sem o dedupe do lote, a
      // statement inteira morreria com 21000 ("cannot affect row a second time").
      chamada({ bucket, method: `tools/${NUL}call`, calls: 1 }),
      chamada({ bucket, method: `tools/ca${ESC}ll`, calls: 2 }),
      chamada({ bucket, method: `  prompts/get${NUL}`, calls: 3 }),
      chamada({ bucket, method: 'z'.repeat(300), calls: 4 }),
      // Só controle: não sobra método nenhum, e o item é descartado sem
      // derrubar o lote. `calls` zero também não é chamada.
      chamada({ bucket, method: `${NUL}${ESC}`, calls: 9 }),
      chamada({ bucket, method: 'resources/read', calls: 0 }),
    ]);

    expect(await contadores(bucket)).toEqual([
      { method: 'prompts/get', family: 'prompts', calls: 3, slug: 'alpha', uuid: alphaUuid },
      { method: 'tools/call', family: 'tools', calls: 3, slug: 'alpha', uuid: alphaUuid },
      { method: 'z'.repeat(MCP_CALL_METHOD_MAX), family: 'other', calls: 4, slug: 'alpha', uuid: alphaUuid },
    ]);
  });

  it('tira do método os formatadores invisíveis: bidi, largura zero e BOM', async () => {
    const bucket = '2026-01-05T16:00:00.000Z';
    await bumpMcpCallCounters([
      // O override bidi passava intacto para a coluna `method` e subia para
      // "Métodos mais chamados", onde inverte a leitura do que está ao redor.
      chamada({ bucket, method: `tools/call${RLO}evil`, calls: 1 }),
      // Largura zero e BOM: sem o saneamento seriam dois `tools/list`
      // visualmente idênticos na tela, que nunca somam — o agrupamento é por
      // igualdade de bytes, e nenhum humano veria a diferença entre as linhas.
      chamada({ bucket, method: `tools/list${ZWSP}`, calls: 2 }),
      chamada({ bucket, method: `${BOM}tools/list`, calls: 3 }),
      // Só formatador: não sobra método nenhum e o item é descartado, como o
      // que é só controle — sem derrubar o lote.
      chamada({ bucket, method: `${BOM}${ZWSP}${RLO}`, calls: 9 }),
    ]);

    expect(await contadores(bucket)).toEqual([
      { method: 'tools/callevil', family: 'tools', calls: 1, slug: 'alpha', uuid: alphaUuid },
      { method: 'tools/list', family: 'tools', calls: 5, slug: 'alpha', uuid: alphaUuid },
    ]);
  });

  it('manda as linhas ao INSERT sempre na mesma ordem, seja qual for a de entrada', async () => {
    const metodos = ['tools/list', 'initialize', 'resources/read', 'ping', 'prompts/get', 'tools/call'];
    const bucket = '2026-02-02T09:00:00.000Z';

    // Um trigger `BEFORE INSERT` de mentira, criado só aqui: ele dispara uma
    // vez por linha **proposta**, na ordem em que a statement as processa —
    // inclusive nas que vão terminar em `DO UPDATE`. É o que torna visível de
    // fora a ordem em que o UPSERT trava as linhas, que é o que decide se dois
    // despejos simultâneos travam em cruz (40P01) ou se enfileiram.
    await raw.query('CREATE TABLE ordem_do_insert (n bigserial PRIMARY KEY, method text NOT NULL)');
    await raw.query(
      "CREATE FUNCTION ordem_do_insert_tg() RETURNS trigger LANGUAGE plpgsql AS " +
        "'BEGIN INSERT INTO ordem_do_insert (method) VALUES (NEW.method); RETURN NEW; END'",
    );
    await raw.query(
      'CREATE TRIGGER zz_ordem_do_insert BEFORE INSERT ON mcp_call_counters ' +
        'FOR EACH ROW EXECUTE FUNCTION ordem_do_insert_tg()',
    );

    try {
      const observar = async (entrada: readonly string[]): Promise<string[]> => {
        await raw.query('TRUNCATE ordem_do_insert');
        await bumpMcpCallCounters(entrada.map((method) => chamada({ bucket, method, calls: 1 })));
        const result = await raw.query<{ method: string }>('SELECT method FROM ordem_do_insert ORDER BY n');
        return result.rows.map((row) => row.method);
      };

      const esperada = [...metodos].sort();
      // Primeira passada: as linhas nascem aqui (o INSERT trava o que cria).
      expect(await observar(metodos)).toEqual(esperada);
      // Segunda: todas já existem, e o caminho é o `DO UPDATE` — o de onde o
      // deadlock vinha. A entrada é a ordem inversa; a saída, a mesma.
      expect(await observar([...metodos].reverse())).toEqual(esperada);
      // E uma ordem embaralhada qualquer dá a mesma sequência.
      expect(await observar(['ping', 'tools/list', 'tools/call', 'initialize', 'prompts/get', 'resources/read'])).toEqual(
        esperada,
      );

      // Nada se perdeu no caminho: três despejos de uma chamada por método.
      expect((await contadores(bucket)).map((linha) => linha.calls)).toEqual(metodos.map(() => 3));
    } finally {
      await raw.query('DROP TRIGGER zz_ordem_do_insert ON mcp_call_counters');
      await raw.query('DROP FUNCTION ordem_do_insert_tg()');
      await raw.query('DROP TABLE ordem_do_insert');
    }
  });

  it('não perde chamada quando várias sessões do mesmo vMCP despejam juntas', async () => {
    // O caminho real do mcp-public: a varredura despeja **todas** as sessões
    // num `Promise.all`, e duas sessões do mesmo vMCP, mesmo transporte e
    // mesmo balde trazem os mesmos métodos em ordens diferentes — a ordem em
    // que cada uma viu cada método pela primeira vez. Sem a ordenação, isso
    // matava um dos despejos com 40P01 em 41% das vezes com 6 sessões (medido
    // contra este mesmo Postgres), e as chamadas do despejo morto sumiam sem
    // rastro: o rastreador limpa o balde antes do `await` e engole o erro.
    const metodos = ['initialize', 'tools/list', 'tools/call', 'prompts/list', 'prompts/get', 'resources/read', 'ping'];
    const SESSOES = 6;
    const RODADAS = 6;

    for (let rodada = 0; rodada < RODADAS; rodada++) {
      const bucket = new Date(Date.UTC(2026, 1, 3, 0, 15 * rodada)).toISOString();
      const ordens = Array.from({ length: SESSOES }, (_, sessao) => {
        const girada = [...metodos.slice(sessao % metodos.length), ...metodos.slice(0, sessao % metodos.length)];
        return sessao % 2 === 0 ? girada : girada.reverse();
      });
      // Sem `allSettled`: um 40P01 aqui **tem** de derrubar o teste.
      await Promise.all(
        ordens.map((ordem) =>
          bumpMcpCallCounters(ordem.map((method) => chamada({ bucket, method, calls: 1 }))),
        ),
      );
    }

    const result = await raw.query<{ soma: string }>(
      `SELECT COALESCE(sum(calls), 0)::text AS soma FROM mcp_call_counters
        WHERE bucket >= '2026-02-03T00:00:00Z' AND bucket < '2026-02-04T00:00:00Z'`,
    );
    expect(Number(result.rows[0]!.soma)).toBe(SESSOES * RODADAS * metodos.length);
  }, 30_000);

  it('guarda o que aconteceu num vMCP apagado e recusa o que é bug de quem chama', async () => {
    const efemero = await createVirtualMcp({ name: 'Efêmero', ownerUserUuid: null }, SOURCE, ACTOR);
    await deleteVirtualMcp(efemero.uuid, SOURCE, ACTOR);

    const bucket = '2026-01-05T14:00:00.000Z';
    // A FK recusaria o INSERT (23503) e o lote inteiro se perderia; o LEFT JOIN
    // deixa o uuid nulo e o slug segura o histórico, como em `015`/`018`.
    await bumpMcpCallCounters([
      chamada({ bucket, virtualMcpUuid: efemero.uuid, virtualMcpSlug: efemero.slug, method: 'tools/list' }),
    ]);
    expect(await contadores(bucket)).toEqual([
      { method: 'tools/list', family: 'tools', calls: 1, slug: efemero.slug, uuid: null },
    ]);

    for (const torto of [
      chamada({ virtualMcpUuid: 'nao-e-uuid' }),
      chamada({ virtualMcpSlug: '   ' }),
      chamada({ transport: 'carta-pombo' as McpCallBucketInput['transport'] }),
      chamada({ bucket: 'ontem' }),
      chamada({ calls: -3 }),
    ]) {
      const erro = await capture(bumpMcpCallCounters([torto]));
      expect(erro).toBeInstanceOf(AppError);
      expect(erro.status).toBe(400);
    }
  });

  it('recorta a série pelo fuso: o mesmo instante cai em dias diferentes em UTC e em São Paulo', async () => {
    const marca = await agora();
    const skill = await createSkill({ name: 'Virada', slug: 'virada', skillMd: '# virada' }, SOURCE, ACTOR);
    await recordSkillAccess({
      skillUuid: skill.uuid,
      kind: 'view',
      surface: 'page',
      origin: 'site',
      auth: 'anonymous',
    });
    await recuar(marca, VIRADA);
    await sessaoEm(VIRADA, { sessionId: 'virada-1' });
    await bumpMcpCallCounters([
      chamada({ bucket: VIRADA, method: 'tools/call', calls: 3 }),
      chamada({ bucket: MEIO_DIA, method: 'tools/list', calls: 2 }),
    ]);

    const faixa = { since: new Date(MARCO_INICIO), until: new Date(MARCO_FIM) };

    // Em UTC as duas pontas são o mesmo dia 10.
    expect(await listActivityDays(faixa)).toEqual([
      { day: '2026-03-10', sessions: 1, calls: 5, reads: 1, events: 1, total: 8 },
    ]);

    // Em São Paulo (UTC-3) a virada das 02:30 UTC é o dia 9, e o meio-dia
    // continua no 10: os mesmos instantes, dois dias.
    expect(await listActivityDays({ ...faixa, timezone: 'America/Sao_Paulo' })).toEqual([
      { day: '2026-03-09', sessions: 1, calls: 3, reads: 1, events: 1, total: 6 },
      { day: '2026-03-10', sessions: 0, calls: 2, reads: 0, events: 0, total: 2 },
    ]);

    // O fuso explícito `UTC` é o padrão, e não um caminho diferente.
    expect(await listActivityDays({ ...faixa, timezone: 'UTC' })).toEqual(await listActivityDays(faixa));
  });

  it('recusa fuso desconhecido com 400 em vez de deixar o Postgres estourar', async () => {
    const faixa = { since: new Date(MARCO_INICIO), until: new Date(MARCO_FIM) };
    for (const timezone of ['Marte/Olympus', '+05:45', 'America/Sao Paulo', 'x'.repeat(80), '']) {
      const erro = await capture(listActivityDays({ ...faixa, timezone }));
      expect(erro).toBeInstanceOf(AppError);
      expect(erro.status).toBe(400);
      expect(erro.message).toContain('Fuso horário desconhecido');
    }
    // A faixa invertida é bug de quem chama, nas duas leituras.
    const invertida = { since: new Date(MARCO_FIM), until: new Date(MARCO_INICIO) };
    expect((await capture(listActivityDays(invertida))).status).toBe(400);
    expect((await capture(activityOfDay(invertida))).status).toBe(400);
  });

  it('satura a faixa em ACTIVITY_RANGE_MAX_DAYS em vez de agrupar o histórico inteiro', async () => {
    // `until` antes de janeiro de 2026: a janela de 400 dias não alcança
    // nenhum dos outros dias fabricados pela suíte.
    const until = new Date('2025-12-01T12:00:00.000Z');
    const dentro = new Date(until.getTime() - 300 * DIA_MS).toISOString();
    const fora = new Date(until.getTime() - 450 * DIA_MS).toISOString();
    await bumpMcpCallCounters([
      chamada({ bucket: dentro, method: 'tools/call', calls: 7 }),
      chamada({ bucket: fora, method: 'tools/call', calls: 9 }),
    ]);

    // Dez anos pedidos, 400 dias entregues: o balde de 450 dias atrás fica fora.
    const dias = await listActivityDays({ since: new Date(until.getTime() - 3650 * DIA_MS), until });
    expect(dias.map((dia) => dia.calls)).toEqual([7]);
    expect(dias[0]!.day).toBe(dentro.slice(0, 10));
  });

  it('descreve o dia inteiro pelas quatro fontes, sem identificar nenhuma operação', async () => {
    const marca = await agora();
    const um = await createSkill({ name: 'Relatório Um', slug: 'relatorio-um', skillMd: '# um' }, SOURCE, ACTOR);
    const dois = await createSkill({ name: 'Relatório Dois', slug: 'relatorio-dois', skillMd: '# dois' }, 'mcp-admin', OUTRO);
    await updateSkill('relatorio-um', { description: 'o primeiro' }, SOURCE, ACTOR);
    umUuid = um.uuid;
    doisUuid = dois.uuid;

    await recordSkillAccess({
      skillUuid: umUuid,
      kind: 'view',
      surface: 'tool',
      origin: 'mcp',
      auth: 'open',
      virtualMcpUuid: alphaUuid,
    });
    await recordSkillAccess({ skillUuid: umUuid, kind: 'download', surface: 'download', origin: 'site', auth: 'anonymous' });
    await recordSkillAccess({ skillUuid: doisUuid, kind: 'view', surface: 'page', origin: 'site', auth: 'anonymous' });
    await recuar(marca, '2026-05-20T09:00:00.000Z');

    const primeira = await sessaoEm('2026-05-20T09:00:00.000Z', { sessionId: 'rep-1', clientName: 'Claude' });
    await sessaoEm('2026-05-20T10:00:00.000Z', {
      sessionId: 'rep-2',
      transport: 'sse',
      auth: 'key',
      keyId,
      clientName: 'Claude',
    });
    // Mesmo `session_id` da primeira: três sessões, duas identidades.
    await sessaoEm('2026-05-20T11:00:00.000Z', { sessionId: 'rep-1', clientName: 'Cursor' });
    // Começou na véspera e terminou no dia: conta em `ended`, não em `sessions`.
    const vespera = await sessaoEm('2026-05-19T20:00:00.000Z', { sessionId: 'rep-0' });
    await encerrarEm(vespera, 'closed', '2026-05-20T08:00:00.000Z');
    await encerrarEm(primeira, 'shutdown', '2026-05-20T12:00:00.000Z');

    await bumpMcpCallCounters([
      chamada({ bucket: '2026-05-20T09:00:00.000Z', method: 'tools/call', calls: 5 }),
      chamada({ bucket: '2026-05-20T09:15:00.000Z', method: 'tools/list', calls: 3 }),
      chamada({ bucket: '2026-05-20T10:00:00.000Z', method: 'prompts/get', transport: 'sse', calls: 2 }),
      chamada({ bucket: '2026-05-20T10:00:00.000Z', method: 'initialize', calls: 1 }),
      chamada({
        bucket: '2026-05-20T11:00:00.000Z',
        method: 'skills/list',
        transport: 'stateless',
        virtualMcpUuid: betaUuid,
        virtualMcpSlug: 'beta',
        calls: 1,
      }),
    ]);

    const dia = { since: new Date(RELATORIO_INICIO), until: new Date(RELATORIO_FIM) };
    const relatorio = await activityOfDay(dia);

    expect(relatorio.clients).toMatchObject({ sessions: 3, distinct: 2, agents: 2, ended: 2 });
    expect(porChave(relatorio.clients.byTransport)).toEqual({ streamable: 2, sse: 1 });
    expect(porChave(relatorio.clients.byAuth)).toEqual({ open: 2, key: 1 });
    expect(porChave(relatorio.clients.byEndReason)).toEqual({ closed: 1, shutdown: 1 });
    expect(relatorio.clients.topAgents).toEqual([
      { key: 'Claude', label: null, count: 2 },
      { key: 'Cursor', label: null, count: 1 },
    ]);

    expect(relatorio.calls.total).toBe(12);
    expect(porChave(relatorio.calls.byFamily)).toEqual({ tools: 8, prompts: 2, skills: 1, session: 1 });
    expect(porChave(relatorio.calls.byTransport)).toEqual({ streamable: 9, sse: 2, stateless: 1 });
    expect(porChave(relatorio.calls.byServer)).toEqual({ alpha: 11, beta: 1 });
    expect(relatorio.calls.topMethods.slice(0, 3)).toEqual([
      { key: 'tools/call', label: 'tools', count: 5 },
      { key: 'tools/list', label: 'tools', count: 3 },
      { key: 'prompts/get', label: 'prompts', count: 2 },
    ]);

    expect(relatorio.reads).toMatchObject({ total: 3, downloads: 1, skills: 2 });
    expect(porChave(relatorio.reads.bySurface)).toEqual({ tool: 1, download: 1, page: 1 });
    expect(porChave(relatorio.reads.byOrigin)).toEqual({ site: 2, mcp: 1 });
    expect(porChave(relatorio.reads.byAuth)).toEqual({ anonymous: 2, open: 1 });
    expect(relatorio.reads.topSkills[0]).toEqual({ key: 'relatorio-um', label: 'Relatório Um', count: 2 });

    expect(relatorio.catalog).toMatchObject({ total: 3, actors: 2 });
    expect(porChave(relatorio.catalog.byAction)).toEqual({ create: 2, update: 1 });
    expect(porChave(relatorio.catalog.bySource)).toEqual({ 'web-admin': 2, 'mcp-admin': 1 });

    // `top` recorta os top-N e nada mais; o clamp derruba o absurdo no mínimo.
    const curto = await activityOfDay({ ...dia, top: 2 });
    expect(curto.calls.topMethods.map((slice) => slice.key)).toEqual(['tools/call', 'tools/list']);
    expect(curto.calls.total).toBe(12);
    expect((await activityOfDay({ ...dia, top: 0 })).calls.topMethods.length).toBe(1);

    // O dia inteiro também aparece na série, com o total das quatro fontes.
    expect(await listActivityDays(dia)).toEqual([
      { day: '2026-05-20', sessions: 3, calls: 12, reads: 3, events: 3, total: 21 },
    ]);
  });

  it('devolve zeros e listas vazias num dia sem nada, e a série pula o dia', async () => {
    const vazio = { since: new Date('2026-06-01T00:00:00.000Z'), until: new Date('2026-06-01T23:59:59.999Z') };

    expect(await listActivityDays(vazio)).toEqual([]);
    expect(await activityOfDay(vazio)).toEqual({
      clients: {
        sessions: 0,
        distinct: 0,
        agents: 0,
        ended: 0,
        byTransport: [],
        byAuth: [],
        byEndReason: [],
        topAgents: [],
      },
      calls: { total: 0, byFamily: [], topMethods: [], byTransport: [], byServer: [] },
      reads: { total: 0, downloads: 0, skills: 0, bySurface: [], byOrigin: [], byAuth: [], topSkills: [] },
      catalog: { total: 0, actors: 0, byAction: [], bySource: [] },
    });
  });
});
