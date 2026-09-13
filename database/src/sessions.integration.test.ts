/**
 * Teste de integração das sessões do MCP público (`mcp_sessions`) — exige um
 * PostgreSQL 18 real.
 *
 * Fica desligado por padrão: sem `TEST_DATABASE_URL` a suíte inteira é pulada,
 * então `npm test` continua rodando sem banco. Para rodar:
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/purple_skills_test \
 *     npx vitest run database/src/sessions.integration.test.ts
 *
 * O banco apontado é **recriado do zero** (DROP SCHEMA public CASCADE) a cada
 * execução: aponte para um banco descartável, nunca para o de desenvolvimento.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';
import { AppError } from './errors.js';
import {
  closeMcpSession,
  closeMcpSessions,
  countOnlineMcpSessions,
  createVirtualMcp,
  createVirtualMcpKey,
  deleteVirtualMcp,
  expireMcpSessions,
  findOpenMcpSession,
  getVirtualMcp,
  getVirtualMcpByUuid,
  listMcpSessions,
  listVirtualMcps,
  openMcpSession,
  touchMcpSession,
} from './queries.js';

const url = process.env.TEST_DATABASE_URL;
const SOURCE = 'web-admin' as const;
/** Quem assina o que a suíte cria — não é uma conta, como o bootstrap. */
const ACTOR = { userUuid: null, label: 'teste' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MINUTO = 60_000;

/**
 * O Vitest roda arquivos de teste em paralelo e as suítes de integração
 * recriam o **mesmo** banco. Um advisory lock segurado por toda a duração do
 * arquivo faz uma esperar a outra terminar, em vez de derrubar o schema no
 * meio da execução dela. O número precisa ser o mesmo das outras suítes.
 */
const SCHEMA_LOCK = 8_200_004;

let raw: pg.Client;
let alphaUuid = '';
let betaUuid = '';
let keyId = '';

async function capture(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    return err as AppError;
  }
  throw new Error('a chamada deveria ter falhado');
}

/** Envelhece uma sessão: a última atividade passa a ser há `minutes` minutos. */
async function envelhecer(id: string, minutes: number): Promise<void> {
  await raw.query(
    `UPDATE mcp_sessions
        SET last_seen_at = now() - make_interval(mins => $2),
            started_at = now() - make_interval(mins => $2 + 1)
      WHERE id = $1`,
    [id, minutes],
  );
}

async function sessao(id: string, onlineWindowMs = MINUTO) {
  const page = await listMcpSessions({ onlineWindowMs, limit: 200 });
  const found = page.items.find((s) => s.id === id);
  if (!found) throw new Error(`sessão não listada: ${id}`);
  return found;
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

describe.skipIf(!url)('sessões do MCP público: abrir, tocar, fechar, expirar e listar', () => {
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

  it('abre, toca e fecha; o touch preenche o clientInfo uma vez e não mexe em linha encerrada', async () => {
    const id = await openMcpSession(
      abertura({ sessionId: 'sess-1', auth: 'key', keyId, userAgent: ' agente/1.0 ' }),
    );
    expect(id).toMatch(UUID_RE);

    let s = await sessao(id);
    expect(s).toMatchObject({
      id,
      sessionId: 'sess-1',
      transport: 'streamable',
      mount: 'root',
      virtualMcpUuid: alphaUuid,
      virtualMcpSlug: 'alpha',
      auth: 'key',
      keyId,
      keyName: 'agente',
      ip: '10.0.0.1',
      userAgent: 'agente/1.0',
      clientName: null,
      clientVersion: null,
      endedAt: null,
      endReason: null,
      requestCount: 1,
      isOnline: true,
    });
    expect(s.startedAt).toBe(s.lastSeenAt);

    await touchMcpSession(id, { requests: 2, clientName: 'Claude', clientVersion: '1.2' });
    // O segundo `initialize` não reescreve o primeiro.
    await touchMcpSession(id, { requests: 1, clientName: 'Outro', clientVersion: '9' });
    s = await sessao(id);
    expect(s.requestCount).toBe(4);
    expect(s.clientName).toBe('Claude');
    expect(s.clientVersion).toBe('1.2');
    expect(Date.parse(s.lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(s.startedAt));

    await closeMcpSession(id, 'closed');
    s = await sessao(id);
    expect(s.endedAt).not.toBeNull();
    expect(s.endReason).toBe('closed');
    expect(s.isOnline).toBe(false);

    // Encerrada: nem o touch nem um segundo close mexem em nada.
    const fim = s.endedAt;
    await touchMcpSession(id, { requests: 5, clientName: 'Tarde' });
    await closeMcpSession(id, 'shutdown');
    s = await sessao(id);
    expect(s.requestCount).toBe(4);
    expect(s.endReason).toBe('closed');
    expect(s.endedAt).toBe(fim);
    expect(s.clientName).toBe('Claude');

    // Id torto é ignorado, como em `touchApiKey`; razão inválida é 400.
    await touchMcpSession('torto', { requests: 1 });
    await closeMcpSession('torto', 'closed');
    expect((await capture(closeMcpSession(id, 'explodiu' as never))).status).toBe(400);
    expect((await capture(touchMcpSession(id, { requests: -1 }))).status).toBe(400);

    // `requests` já contadas na abertura.
    const tres = await openMcpSession(abertura({ sessionId: 'sess-3', requests: 3 }));
    expect((await sessao(tres)).requestCount).toBe(3);
    await closeMcpSession(tres, 'closed');

    // Entradas inválidas são erro do cliente, e nada é gravado.
    const casos: [string, Partial<Parameters<typeof openMcpSession>[0]>][] = [
      ['sessionId vazio', { sessionId: '  ' }],
      ['ip vazio', { ip: '' }],
      ['slug vazio', { virtualMcpSlug: '' }],
      ['uuid torto', { virtualMcpUuid: 'torto' }],
      ['transporte inventado', { transport: 'websocket' as never }],
      ['mount inventado', { mount: 'raiz' as never }],
      ['auth inventada', { auth: 'senha' as never }],
      ['keyId torto', { keyId: 'torto' }],
      ['requests negativo', { requests: -1 }],
    ];
    for (const [rotulo, override] of casos) {
      const erro = await capture(openMcpSession(abertura(override)));
      expect(erro.status, rotulo).toBe(400);
    }
    // vMCP que sumiu entre a resolução e a abertura: 404.
    const sumiu = await capture(
      openMcpSession(abertura({ virtualMcpUuid: '00000000-0000-0000-0000-000000000000' })),
    );
    expect(sumiu.status).toBe(404);
    expect((await listMcpSessions({ onlineWindowMs: MINUTO })).total).toBe(2);
  });

  it('findOpenMcpSession reencontra a linha aberta do stateless dentro da janela', async () => {
    const chave = { sessionId: 'hash-abc', transport: 'stateless' as const };
    const id = await openMcpSession(
      abertura({ ...chave, mount: 'virtual', ip: '10.0.0.2' }),
    );
    expect(await findOpenMcpSession({ ...chave, withinMs: MINUTO })).toBe(id);
    // Outro transporte ou outro id não casam.
    expect(await findOpenMcpSession({ sessionId: 'hash-abc', transport: 'sse', withinMs: MINUTO })).toBeNull();
    expect(await findOpenMcpSession({ ...chave, sessionId: 'hash-xyz', withinMs: MINUTO })).toBeNull();

    // Fora da janela não casa; com uma janela maior, casa.
    await envelhecer(id, 10);
    expect(await findOpenMcpSession({ ...chave, withinMs: MINUTO })).toBeNull();
    expect(await findOpenMcpSession({ ...chave, withinMs: 60 * MINUTO })).toBe(id);

    // Duas abertas (dois processos abriram ao mesmo tempo): vale a mais recente.
    const id2 = await openMcpSession(abertura({ ...chave, mount: 'virtual', ip: '10.0.0.2' }));
    expect(await findOpenMcpSession({ ...chave, withinMs: 60 * MINUTO })).toBe(id2);

    // Encerradas não casam; o lote diz quantas fechou de fato.
    expect(await closeMcpSessions([id, id2, 'torto'], 'shutdown')).toBe(2);
    expect(await closeMcpSessions([id, id2], 'shutdown')).toBe(0);
    expect(await closeMcpSessions([], 'shutdown')).toBe(0);
    expect(await findOpenMcpSession({ ...chave, withinMs: 60 * MINUTO })).toBeNull();
    expect((await sessao(id2)).endReason).toBe('shutdown');

    expect((await capture(findOpenMcpSession({ ...chave, withinMs: 0 }))).status).toBe(400);
    expect((await capture(findOpenMcpSession({ ...chave, sessionId: '', withinMs: 1 }))).status).toBe(400);
    expect((await capture(closeMcpSessions([id], 'nunca' as never))).status).toBe(400);
  });

  it('expireMcpSessions fecha por timeout com o fim presumido, cada transporte pelo seu prazo', async () => {
    const beta = { virtualMcpUuid: betaUuid, virtualMcpSlug: 'beta', mount: 'virtual' as const };
    const velhaStateless = await openMcpSession(
      abertura({ ...beta, sessionId: 'velha-stateless', transport: 'stateless' }),
    );
    const velhaSse = await openMcpSession(abertura({ ...beta, sessionId: 'velha-sse', transport: 'sse' }));
    const novaStreamable = await openMcpSession(
      abertura({ ...beta, sessionId: 'nova-streamable', transport: 'streamable' }),
    );
    const novaStateless = await openMcpSession(
      abertura({ ...beta, sessionId: 'nova-stateless', transport: 'stateless' }),
    );
    await envelhecer(velhaStateless, 10);
    await envelhecer(velhaSse, 10);
    await envelhecer(novaStreamable, 2);
    await envelhecer(novaStateless, 2);

    // Janela do stateless 5 min, TTL de sessão 30 min: só a stateless de 10
    // min vence. A SSE de 10 min ainda está dentro do TTL.
    expect(await expireMcpSessions({ statelessWindowMs: 5 * MINUTO, sessionTtlMs: 30 * MINUTO })).toBe(1);
    const presumido = async (id: string, minutes: number) =>
      (
        await raw.query<{ ok: boolean; end_reason: string }>(
          `SELECT ended_at = last_seen_at + make_interval(mins => $2) AS ok, end_reason
             FROM mcp_sessions WHERE id = $1`,
          [id, minutes],
        )
      ).rows[0];
    expect(await presumido(velhaStateless, 5)).toEqual({ ok: true, end_reason: 'timeout' });
    expect((await sessao(velhaSse)).endedAt).toBeNull();
    expect((await sessao(novaStateless)).endedAt).toBeNull();

    // TTL de 5 min: agora a SSE vence, com o fim presumido pelo TTL dela.
    expect(await expireMcpSessions({ statelessWindowMs: 5 * MINUTO, sessionTtlMs: 5 * MINUTO })).toBe(1);
    expect(await presumido(velhaSse, 5)).toEqual({ ok: true, end_reason: 'timeout' });
    expect((await sessao(novaStreamable)).endedAt).toBeNull();

    // Rodar de novo não acha nada; prazo inválido é 400.
    expect(await expireMcpSessions({ statelessWindowMs: 5 * MINUTO, sessionTtlMs: 5 * MINUTO })).toBe(0);
    expect((await capture(expireMcpSessions({ statelessWindowMs: 0, sessionTtlMs: MINUTO }))).status).toBe(400);
    expect(
      (await capture(expireMcpSessions({ statelessWindowMs: MINUTO, sessionTtlMs: Number.NaN }))).status,
    ).toBe(400);
  });

  it('lista com filtros, recorte e isOnline pela janela; conta os online por transporte', async () => {
    // Estado até aqui: alpha tem 4 encerradas; beta tem 2 encerradas por
    // timeout e 2 abertas com atividade há 2 min. Entram três online agora.
    const a1 = await openMcpSession(abertura({ sessionId: 'A1', auth: 'key', keyId }));
    const a2 = await openMcpSession(abertura({ sessionId: 'A2', transport: 'stateless', ip: '10.0.0.9' }));
    const b1 = await openMcpSession(
      abertura({ sessionId: 'B1', transport: 'sse', mount: 'virtual', virtualMcpUuid: betaUuid, virtualMcpSlug: 'beta' }),
    );

    const tudo = await listMcpSessions({ onlineWindowMs: MINUTO, limit: 200 });
    expect(tudo.total).toBe(11);
    expect(tudo.items).toHaveLength(11);
    // Mais recente atividade primeiro; `isOnline` pela janela de 1 min.
    expect(tudo.items.slice(0, 3).map((s) => s.id)).toEqual([b1, a2, a1]);
    expect(tudo.items.map((s) => s.isOnline)).toEqual([
      true, true, true, false, false, false, false, false, false, false, false,
    ]);
    expect(tudo.items.find((s) => s.id === a1)?.keyName).toBe('agente');

    // Com 5 min de janela, as duas de beta com atividade há 2 min também estão online.
    const larga = await listMcpSessions({ onlineWindowMs: 5 * MINUTO, onlineOnly: true });
    expect(larga.total).toBe(5);
    expect(larga.items.map((s) => s.sessionId).sort()).toEqual(
      ['A1', 'A2', 'B1', 'nova-stateless', 'nova-streamable'],
    );
    expect((await listMcpSessions({ onlineWindowMs: MINUTO, onlineOnly: true })).total).toBe(3);

    // Filtro por vMCP e o recorte de quem não é admin: alpha acumulou 6 linhas
    // (4 encerradas + A1 e A2), beta 5 (4 do teste anterior + B1).
    expect((await listMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuid: betaUuid })).total).toBe(5);
    expect((await listMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuids: [alphaUuid] })).total).toBe(6);
    expect(
      (await listMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuids: [alphaUuid, betaUuid] })).total,
    ).toBe(11);
    expect(await listMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuids: [] })).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
    expect(
      (await listMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuids: [betaUuid], virtualMcpUuid: alphaUuid }))
        .total,
    ).toBe(0);

    // Paginação: `total` não depende da página; limit com clamp 1..200.
    const pagina = await listMcpSessions({ onlineWindowMs: MINUTO, limit: 2, offset: 9 });
    expect(pagina).toMatchObject({ total: 11, limit: 2, offset: 9 });
    expect(pagina.items).toHaveLength(2);
    expect((await listMcpSessions({ onlineWindowMs: MINUTO, limit: 0 })).limit).toBe(1);
    expect((await listMcpSessions({ onlineWindowMs: MINUTO, limit: 999 })).limit).toBe(200);
    expect((await listMcpSessions({ onlineWindowMs: MINUTO, offset: -3 })).offset).toBe(0);

    expect((await capture(listMcpSessions({ onlineWindowMs: 0 }))).status).toBe(400);
    expect((await capture(listMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuid: 'torto' }))).status).toBe(400);
    expect(
      (await capture(listMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuids: ['torto'] }))).status,
    ).toBe(400);

    // O contador do globo.
    expect(await countOnlineMcpSessions({ onlineWindowMs: MINUTO })).toEqual({
      total: 3,
      byTransport: { streamable: 1, sse: 1, stateless: 1 },
    });
    expect(await countOnlineMcpSessions({ onlineWindowMs: 5 * MINUTO })).toEqual({
      total: 5,
      byTransport: { streamable: 2, sse: 1, stateless: 2 },
    });
    expect(await countOnlineMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuid: alphaUuid })).toEqual({
      total: 2,
      byTransport: { streamable: 1, sse: 0, stateless: 1 },
    });
    expect((await capture(countOnlineMcpSessions({ onlineWindowMs: -1 }))).status).toBe(400);
    expect(
      (await capture(countOnlineMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuid: 'torto' }))).status,
    ).toBe(400);
  });

  it('o resumo do vMCP conta os online com a janela, e devolve 0 sem ela', async () => {
    expect((await getVirtualMcpByUuid(alphaUuid))?.onlineSessions).toBe(0);
    expect((await getVirtualMcpByUuid(alphaUuid, { onlineWindowMs: MINUTO }))?.onlineSessions).toBe(2);
    expect((await getVirtualMcp('beta', { onlineWindowMs: MINUTO }))?.onlineSessions).toBe(1);
    expect((await getVirtualMcp('beta', { onlineWindowMs: 5 * MINUTO }))?.onlineSessions).toBe(3);

    const lista = await listVirtualMcps({ onlineWindowMs: MINUTO });
    expect(lista.map((m) => [m.slug, m.onlineSessions])).toEqual([
      ['alpha', 2],
      ['beta', 1],
    ]);
    expect((await listVirtualMcps()).map((m) => m.onlineSessions)).toEqual([0, 0]);

    expect((await capture(listVirtualMcps({ onlineWindowMs: 0 }))).status).toBe(400);
    expect((await capture(getVirtualMcp('beta', { onlineWindowMs: Number.NaN }))).status).toBe(400);
  });

  it('apagar o vMCP (e a chave, em cascata) mantém a linha com uuid nulo e o slug; nada é podado', async () => {
    await deleteVirtualMcp(alphaUuid, SOURCE, ACTOR);

    const tudo = await listMcpSessions({ onlineWindowMs: MINUTO, limit: 200 });
    expect(tudo.total).toBe(11);
    const deAlpha = tudo.items.filter((s) => s.virtualMcpSlug === 'alpha');
    expect(deAlpha).toHaveLength(6);
    expect(deAlpha.every((s) => s.virtualMcpUuid === null)).toBe(true);

    // A chave foi na cascata: `keyId`/`keyName` nulos, mas `auth` continua dizendo que houve chave.
    const a1 = deAlpha.find((s) => s.sessionId === 'A1');
    expect(a1).toMatchObject({ auth: 'key', keyId: null, keyName: null, isOnline: true });

    // Fora do recorte de quem não é admin; ainda online para o admin.
    expect((await listMcpSessions({ onlineWindowMs: MINUTO, virtualMcpUuids: [alphaUuid] })).total).toBe(0);
    expect((await countOnlineMcpSessions({ onlineWindowMs: MINUTO })).total).toBe(3);

    // Sem poda automática: a varredura só encerra, nunca apaga.
    await expireMcpSessions({ statelessWindowMs: 1, sessionTtlMs: 1 });
    const { rows } = await raw.query<{ n: number }>('SELECT count(*)::int AS n FROM mcp_sessions');
    expect(rows[0]?.n).toBe(11);
    expect((await countOnlineMcpSessions({ onlineWindowMs: MINUTO })).total).toBe(0);
  });
});
