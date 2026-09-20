import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

// Do pacote só entra a regra do rótulo, e entra **de verdade**: é ela que os
// testes de `clientInfoOf` conferem (teto, controle, cópia), e um dublê aqui
// testaria o dublê. As queries seguem de fora — o rastreador recebe o `store`
// falso — e nada no pacote abre conexão em tempo de import.
vi.mock('@purple-skills/db', async (original) => {
  const real = await original<typeof import('@purple-skills/db')>();
  return { normalizeSessionLabel: real.normalizeSessionLabel };
});

const { MCP_SESSION_LABEL_MAX } = await vi.importActual<typeof import('@purple-skills/db')>('@purple-skills/db');
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

  /**
   * O `clientInfo` é texto livre de quem chama e fica na memória do rastreador
   * por entrada. A regra que o limpa é a do banco (`normalizeSessionLabel`), e é
   * a de verdade que roda aqui — relatórios 047 e 038 da auditoria de 2026-09-19.
   */
  const initializeCom = (clientInfo: unknown) => ({ method: 'initialize', params: { clientInfo } });

  it('corta o rótulo no teto do banco: o nome de 1 MB não fica na memória', () => {
    const info = clientInfoOf(initializeCom({ name: 'n'.repeat(1024 * 1024), version: 'v'.repeat(10_000) }));

    expect(MCP_SESSION_LABEL_MAX).toBe(512);
    expect(info?.name).toBe('n'.repeat(MCP_SESSION_LABEL_MAX));
    expect(info?.version).toBe('v'.repeat(MCP_SESSION_LABEL_MAX));
  });

  it('caractere de controle vira espaço — o nulo inclusive, que o `text` do Postgres recusa', () => {
    // Montados com `fromCharCode`: o escape do nulo escrito no fonte vira byte
    // literal na ferramenta de edição, e o arquivo passa a ser binário para o git.
    const NUL = String.fromCharCode(0);
    const ESC = String.fromCharCode(0x1b);

    expect(clientInfoOf(initializeCom({ name: `claude${NUL}code`, version: `2.1${ESC}0\n` }))).toEqual({
      name: 'claude code',
      version: '2.1 0',
    });
  });

  it('nome só de controles ou de espaços vira null, e o que não é string também', () => {
    const NUL = String.fromCharCode(0);

    expect(clientInfoOf(initializeCom({ name: `${NUL}${NUL}`, version: '   ' }))).toEqual({ name: null, version: null });
    expect(clientInfoOf(initializeCom({ name: 42, version: { major: 2 } }))).toEqual({ name: null, version: null });
  });

  it('rótulo curto e limpo passa idêntico', () => {
    expect(clientInfoOf(initializeCom({ name: 'Claude Code — ação', version: '2.1.0-β' }))).toEqual({
      name: 'Claude Code — ação',
      version: '2.1.0-β',
    });
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

  // No SSE o `clientInfo` chega depois da abertura e fica guardado na entrada
  // até o toque seguinte: o que sai dela para o banco é o que estava na memória.
  it('o clientInfo guardado na entrada já é o rótulo limpo e cortado', async () => {
    const store = fakeStore();
    const t = tracker(store);
    const NUL = String.fromCharCode(0);
    const sujo = { ...INITIALIZE, params: { ...INITIALIZE.params, clientInfo: { name: `a${NUL}${'b'.repeat(1024 * 1024)}`, version: `1${NUL}0` } } };

    t.opened('sse', 'sse-1', request());
    t.seen('sse', 'sse-1', request({ body: sujo }));
    await t.flush();

    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-1', {
      requests: 1,
      clientName: `a ${'b'.repeat(510)}`,
      clientVersion: '1 0',
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

  // O caminho do relatório 047: cada `user-agent` novo é uma identidade nova, e
  // cada identidade guardava o `clientInfo.name` do tamanho que viesse.
  it('identidade nova com nome gigante abre a linha com o rótulo de 512 caracteres', async () => {
    const store = fakeStore();
    const t = tracker(store);
    const gigante = { ...INITIALIZE, params: { ...INITIALIZE.params, clientInfo: { name: 'x'.repeat(1024 * 1024), version: '1.0' } } };

    t.stateless(request({ body: gigante, agent: 'variavel/1' }));
    await flushMicrotasks();

    expect(store.calls.openMcpSession.mock.calls[0][0]).toMatchObject({ clientName: 'x'.repeat(512), clientVersion: '1.0' });
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

/**
 * `MCP_MAX_STATELESS_SESSIONS` não é limite de taxa e não tem "desligado": com
 * `0` o mapa nasceria cheio e nenhum cliente stateless seria contabilizado. A
 * variável é lida na carga do módulo — daí o `resetModules` e o `import()`.
 */
describe('MCP_MAX_STATELESS_SESSIONS', () => {
  const carregarCom = async (valor: string) => {
    vi.resetModules();
    vi.stubEnv('MCP_MAX_STATELESS_SESSIONS', valor);
    try {
      return await import('./sessions.js');
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it('`0` derruba o boot com a mensagem de faixa, em vez de virar "sem teto"', async () => {
    await expect(carregarCom('0')).rejects.toThrow(/MCP_MAX_STATELESS_SESSIONS inválida: esperado um inteiro entre 1 e/);
  });

  it('o mínimo aceito é `1`', async () => {
    await expect(carregarCom('1')).resolves.toHaveProperty('createSessionTracker');
  });
});
