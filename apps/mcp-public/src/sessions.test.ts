import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@purple-skills/db', () => ({}));

const { clientInfoOf, createSessionTracker, statelessSessionId } = await import('./sessions.js');
type Store = NonNullable<Parameters<typeof createSessionTracker>[0]['store']>;

/**
 * O rastreador é chamado no caminho quente de cada requisição: estes testes
 * conferem que ele grava o que a tabela `mcp_sessions` precisa — e só quando
 * precisa — sem tocar num banco de verdade.
 */

const SCOPE = { virtualMcpUuid: 'u-1', virtualMcpSlug: 'time-a', auth: 'open' as const, keyId: null };

function fakeStore(): Store & { calls: Record<keyof Store, ReturnType<typeof vi.fn>> } {
  let seq = 0;
  const calls = {
    openMcpSession: vi.fn(async () => `row-${++seq}`),
    touchMcpSession: vi.fn(async () => undefined),
    closeMcpSession: vi.fn(async () => undefined),
    closeMcpSessions: vi.fn(async (ids: readonly string[]) => ids.length),
    findOpenMcpSession: vi.fn(async () => null),
    expireMcpSessions: vi.fn(async () => 0),
  };
  return { ...calls, calls } as never;
}

function request(overrides: { body?: unknown; ip?: string; agent?: string; baseUrl?: string; virtual?: boolean } = {}): Request {
  const headers: Record<string, string> = { 'user-agent': overrides.agent ?? 'claude-code/1.0' };
  return {
    ip: overrides.ip ?? '203.0.113.7',
    body: overrides.body ?? {},
    baseUrl: overrides.baseUrl ?? '',
    get: (name: string) => headers[name.toLowerCase()],
    virtual: overrides.virtual === false ? undefined : {},
  } as unknown as Request;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } },
};

function tracker(store: Store, extra: Partial<Parameters<typeof createSessionTracker>[0]> = {}, clock = { now: 1_000_000 }) {
  return createSessionTracker({
    scopeOf: (req) => ((req as unknown as { virtual?: unknown }).virtual ? SCOPE : undefined),
    onlineWindowMs: 120_000,
    sessionTtlMs: 1_800_000,
    touchIntervalMs: 10_000,
    sweepMs: 0,
    store,
    now: () => clock.now,
    log: () => undefined,
    ...extra,
  });
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

describe('clientInfoOf', () => {
  it('lê o clientInfo do initialize, inclusive num lote', () => {
    expect(clientInfoOf(INITIALIZE)).toEqual({ name: 'claude-code', version: '2.1.0' });
    expect(clientInfoOf([{ method: 'ping' }, INITIALIZE])).toEqual({ name: 'claude-code', version: '2.1.0' });
  });

  it('ignora o que não é initialize ou não tem a forma esperada', () => {
    expect(clientInfoOf({ method: 'tools/call' })).toBeNull();
    expect(clientInfoOf('lixo')).toBeNull();
    expect(clientInfoOf({ method: 'initialize', params: {} })).toBeNull();
  });
});

describe('sessões com id', () => {
  it('abre a linha com o escopo, o IP, o agente e o clientInfo do initialize', async () => {
    const store = fakeStore();
    const t = tracker(store);

    t.opened('streamable', 'sess-1', request({ body: INITIALIZE, baseUrl: '/virtual/time-a' }));
    await flushMicrotasks();

    expect(store.calls.openMcpSession).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      transport: 'streamable',
      mount: 'virtual',
      virtualMcpUuid: 'u-1',
      virtualMcpSlug: 'time-a',
      auth: 'open',
      keyId: null,
      ip: '203.0.113.7',
      userAgent: 'claude-code/1.0',
      clientName: 'claude-code',
      clientVersion: '2.1.0',
      requests: 1,
    });
  });

  it('agrupa as requisições: um UPDATE por intervalo, com a contagem acumulada', async () => {
    const store = fakeStore();
    const clock = { now: 1_000_000 };
    const t = tracker(store, {}, clock);
    const req = request();

    t.opened('streamable', 'sess-1', req);
    t.seen('streamable', 'sess-1', req);
    t.seen('streamable', 'sess-1', req);
    t.seen('streamable', 'sess-1', req);
    await flushMicrotasks();
    expect(store.calls.touchMcpSession).not.toHaveBeenCalled();

    clock.now += 10_000;
    t.seen('streamable', 'sess-1', req);
    await flushMicrotasks();
    expect(store.calls.touchMcpSession).toHaveBeenCalledTimes(1);
    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-1', { requests: 4 });
  });

  it('o clientInfo que chega depois da abertura vai no toque seguinte', async () => {
    const store = fakeStore();
    const t = tracker(store);

    t.opened('sse', 'sse-1', request());
    t.seen('sse', 'sse-1', request({ body: INITIALIZE }));
    await t.flush();

    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-1', {
      requests: 1,
      clientName: 'claude-code',
      clientVersion: '2.1.0',
    });
  });

  it('fechar leva os toques pendentes e grava o motivo; repetir o fechamento não faz nada', async () => {
    const store = fakeStore();
    const t = tracker(store);
    const req = request();

    t.opened('streamable', 'sess-1', req);
    t.seen('streamable', 'sess-1', req);
    t.closed('streamable', 'sess-1', 'timeout');
    t.closed('streamable', 'sess-1', 'closed');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-1', { requests: 1 });
    expect(store.calls.closeMcpSession).toHaveBeenCalledTimes(1);
    expect(store.calls.closeMcpSession).toHaveBeenCalledWith('row-1', 'timeout');
  });

  it('sem escopo (requisição sem vMCP) não grava nada', async () => {
    const store = fakeStore();
    const t = tracker(store);
    t.opened('streamable', 'x', request({ virtual: false }));
    t.stateless(request({ virtual: false }));
    await flushMicrotasks();
    expect(store.calls.openMcpSession).not.toHaveBeenCalled();
  });

  it('uma falha do banco vira log, nunca erro na requisição', async () => {
    const store = fakeStore();
    store.calls.openMcpSession.mockRejectedValueOnce(new Error('sem banco'));
    const log = vi.fn();
    const t = tracker(store, { log });
    const req = request();

    t.opened('streamable', 'sess-1', req);
    t.seen('streamable', 'sess-1', req);
    t.closed('streamable', 'sess-1', 'closed');
    await flushMicrotasks();
    await flushMicrotasks();

    expect(log).toHaveBeenCalledWith(expect.stringContaining('sem banco'));
    expect(store.calls.touchMcpSession).not.toHaveBeenCalled();
    expect(store.calls.closeMcpSession).not.toHaveBeenCalled();
  });
});

describe('stateless', () => {
  it('a chave sintética junta IP, agente, credencial e vMCP', () => {
    const a = statelessSessionId(request(), SCOPE);
    expect(a).toMatch(/^sl_[0-9a-f]{32}$/);
    expect(statelessSessionId(request(), SCOPE)).toBe(a);
    expect(statelessSessionId(request({ ip: '198.51.100.1' }), SCOPE)).not.toBe(a);
    expect(statelessSessionId(request({ agent: 'outro' }), SCOPE)).not.toBe(a);
    expect(statelessSessionId(request(), { ...SCOPE, auth: 'key', keyId: 'k-1' })).not.toBe(a);
    expect(statelessSessionId(request(), { ...SCOPE, virtualMcpUuid: 'u-2' })).not.toBe(a);
  });

  it('o mesmo cliente dentro da janela cai na mesma linha; outro cliente abre outra', async () => {
    const store = fakeStore();
    const clock = { now: 1_000_000 };
    const t = tracker(store, {}, clock);

    t.stateless(request({ body: INITIALIZE }));
    t.stateless(request());
    t.stateless(request({ agent: 'cursor/0.5' }));
    await flushMicrotasks();
    await t.flush();

    expect(store.calls.openMcpSession).toHaveBeenCalledTimes(2);
    expect(store.calls.openMcpSession.mock.calls[0][0]).toMatchObject({ transport: 'stateless', mount: 'root', clientName: 'claude-code' });
    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-1', { requests: 1 });
  });

  it('passada a janela, a próxima requisição abre outra linha', async () => {
    const store = fakeStore();
    const clock = { now: 1_000_000 };
    const t = tracker(store, {}, clock);

    t.stateless(request());
    clock.now += 120_001;
    t.stateless(request());
    await flushMicrotasks();

    expect(store.calls.openMcpSession).toHaveBeenCalledTimes(2);
  });

  it('com o mapa cheio, identidade nova não vira linha; a que já estava segue contando', async () => {
    const store = fakeStore();
    const clock = { now: 1_000_000 };
    const log = vi.fn();
    const t = tracker(store, { maxStatelessEntries: 2, log }, clock);

    // O `user-agent` entra na chave sintética: variá-lo é criar identidade nova.
    t.stateless(request({ agent: 'a' }));
    t.stateless(request({ agent: 'b' }));
    t.stateless(request({ agent: 'c' }));
    await flushMicrotasks();

    expect(store.calls.openMcpSession).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('teto de 2 identidades stateless'));

    // A enxurrada não apaga da tela quem já estava sendo contado.
    t.stateless(request({ agent: 'a' }));
    await t.flush();
    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-1', { requests: 1 });

    // Passada a janela, a varredura devolve o espaço.
    clock.now += 200_000;
    await t.sweep();
    t.stateless(request({ agent: 'c' }));
    await flushMicrotasks();
    expect(store.calls.openMcpSession).toHaveBeenCalledTimes(3);
  });

  it('depois de um restart, reusa a linha aberta que ainda está na janela', async () => {
    const store = fakeStore();
    store.calls.findOpenMcpSession.mockResolvedValueOnce('row-antiga');
    const t = tracker(store);

    t.stateless(request({ body: INITIALIZE }));
    await flushMicrotasks();

    expect(store.calls.openMcpSession).not.toHaveBeenCalled();
    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-antiga', {
      requests: 1,
      clientName: 'claude-code',
      clientVersion: '2.1.0',
    });
  });
});

describe('varredura e desligamento', () => {
  it('a varredura leva os toques ao banco, esquece o stateless parado e expira o que passou do prazo', async () => {
    const store = fakeStore();
    const clock = { now: 1_000_000 };
    const t = tracker(store, {}, clock);

    t.stateless(request());
    t.stateless(request());
    clock.now += 200_000;
    await t.sweep();

    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-1', { requests: 1 });
    expect(store.calls.expireMcpSessions).toHaveBeenCalledWith({ statelessWindowMs: 120_000, sessionTtlMs: 1_800_000 });

    // Esquecida: a próxima requisição do mesmo cliente abre linha nova.
    t.stateless(request());
    await flushMicrotasks();
    expect(store.calls.openMcpSession).toHaveBeenCalledTimes(2);
  });

  it('o desligamento encerra as sessões com id em lote, com motivo shutdown', async () => {
    const store = fakeStore();
    const t = tracker(store);

    t.opened('streamable', 'a', request());
    t.opened('sse', 'b', request());
    t.stateless(request());
    await flushMicrotasks();
    await t.shutdown();

    expect(store.calls.closeMcpSessions).toHaveBeenCalledWith(['row-1', 'row-2'], 'shutdown');
    // Fechar de novo depois do desligamento não encontra nada.
    t.closed('streamable', 'a', 'closed');
    await flushMicrotasks();
    expect(store.calls.closeMcpSession).not.toHaveBeenCalled();
  });
});
