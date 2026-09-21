import type { Request } from 'express';
import type { McpCallBucketInput } from '@purple-skills/shared';
import { describe, expect, it, vi } from 'vitest';

// Do pacote só entram as regras de saneamento, e entram **de verdade**: são
// elas que os testes de `clientInfoOf` e da contagem conferem (teto, controle,
// cópia), e um dublê aqui testaria o dublê. As queries seguem de fora — o
// rastreador recebe o `store` falso — e nada no pacote abre conexão em tempo de
// import.
vi.mock('@purple-skills/db', async (original) => {
  const real = await original<typeof import('@purple-skills/db')>();
  return {
    normalizeSessionLabel: real.normalizeSessionLabel,
    MCP_CALL_METHOD_MAX: real.MCP_CALL_METHOD_MAX,
    // Só existe para o `store` padrão poder apontar para alguma coisa: todo
    // teste injeta o dublê, e chegar aqui é defeito do teste.
    bumpMcpCallCounters: async () => {
      throw new Error('o teste precisa injetar o store');
    },
  };
});

const { MCP_CALL_METHOD_MAX, MCP_SESSION_LABEL_MAX } = await vi.importActual<typeof import('@purple-skills/db')>('@purple-skills/db');
const { MCP_CALL_BUCKET_MS } = await vi.importActual<typeof import('@purple-skills/shared')>('@purple-skills/shared');
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
    bumpMcpCallCounters: vi.fn(async () => undefined),
  };
  return { ...calls, calls } as never;
}

function request(overrides: { body?: unknown; ip?: string; agent?: string; baseUrl?: string; virtual?: boolean } = {}): Request {
  const headers: Record<string, string> = { 'user-agent': overrides.agent ?? 'claude-code/1.0' };
  return {
    ip: overrides.ip ?? '203.0.113.7',
    // `'body' in overrides` distingue "não passei corpo" de "passei
    // `undefined`": é o segundo que o `GET /mcp`, o `DELETE /mcp` e o `GET /sse`
    // entregam, onde o `express.json` nem roda.
    body: 'body' in overrides ? overrides.body : {},
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

/**
 * A contagem por método da tela de Atividade (`docs/18-atividade.md`). O que
 * ela mede não é o que `request_count` mede: aqui a unidade é a **mensagem**
 * JSON-RPC, e um lote de 20 num POST soma 20 chamadas contra uma requisição.
 */
describe('contagem de chamadas por método', () => {
  const chamada = (method: string, calls: number, extra: Partial<McpCallBucketInput> = {}): McpCallBucketInput => ({
    bucket: '1970-01-01T00:15:00.000Z',
    virtualMcpUuid: 'u-1',
    virtualMcpSlug: 'time-a',
    transport: 'streamable',
    method,
    calls,
    ...extra,
  });

  const chamadasDe = (store: ReturnType<typeof fakeStore>, i = 0) =>
    store.calls.bumpMcpCallCounters.mock.calls[i][0] as McpCallBucketInput[];

  /**
   * As **linhas** que `mcp_call_counters` teria no fim, e não o que cada
   * despejo levou: a gravação é um UPSERT que soma, então o mesmo (balde,
   * transporte, método) que aparece em dois despejos é uma linha só. É essa a
   * medida dos testes de teto — o que ele protege é a tabela, que não tem poda.
   */
  const linhasDe = (store: ReturnType<typeof fakeStore>): McpCallBucketInput[] => {
    const linhas = new Map<string, McpCallBucketInput>();
    for (const [itens] of store.calls.bumpMcpCallCounters.mock.calls as [McpCallBucketInput[]][]) {
      for (const item of itens) {
        const chave = `${item.bucket}|${item.transport}|${item.method}`;
        const atual = linhas.get(chave);
        if (atual) atual.calls += item.calls;
        else linhas.set(chave, { ...item });
      }
    }
    return [...linhas.values()];
  };

  it('conta uma chamada por mensagem: o lote de 20 soma 20, e a requisição continua sendo uma', async () => {
    const store = fakeStore();
    const t = tracker(store);
    const lote = Array.from({ length: 20 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call' }));

    t.opened('streamable', 'sess-1', request({ body: INITIALIZE }));
    t.seen('streamable', 'sess-1', request({ body: lote }));
    await t.flush();

    expect(store.calls.bumpMcpCallCounters).toHaveBeenCalledTimes(1);
    expect(chamadasDe(store)).toEqual([chamada('initialize', 1), chamada('tools/call', 20)]);
    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-1', { requests: 1 });
  });

  it('requisição sem corpo não conta nada e não quebra (GET /mcp, DELETE /mcp, GET /sse)', async () => {
    const store = fakeStore();
    const t = tracker(store);

    t.opened('sse', 'sse-1', request({ body: undefined }));
    t.seen('sse', 'sse-1', request({ body: undefined }));
    await t.flush();

    expect(store.calls.bumpMcpCallCounters).not.toHaveBeenCalled();
    expect(store.calls.openMcpSession).toHaveBeenCalledTimes(1);
  });

  it('mensagem sem method que seja texto é ignorada: resposta, lixo, nulo e method que não é string', async () => {
    const store = fakeStore();
    const t = tracker(store);
    const corpo = [{ jsonrpc: '2.0', id: 1, result: {} }, 'lixo', null, { method: 42 }, { method: 'ping' }];

    t.stateless(request({ body: corpo }));
    await t.flush();

    expect(chamadasDe(store)).toEqual([chamada('ping', 1, { transport: 'stateless' })]);
  });

  // O método é texto de quem chama, como o `clientInfo`: o nulo derrubaria o
  // INSERT (relatório 038) e o método de 1 MB ficaria no mapa da entrada por um
  // intervalo inteiro (relatório 047). O corte é o do banco, não o do rótulo.
  it('o método é limpo e cortado com a regra do banco antes de virar chave', async () => {
    const store = fakeStore();
    const t = tracker(store);
    const NUL = String.fromCharCode(0);

    t.stateless(request({ body: [{ method: `tools/${NUL}call` }, { method: 'm'.repeat(1024 * 1024) }, { method: `${NUL}${NUL}` }] }));
    await t.flush();

    expect(MCP_CALL_METHOD_MAX).toBe(128);
    expect(chamadasDe(store)).toEqual([
      chamada('tools/ call', 1, { transport: 'stateless' }),
      chamada('m'.repeat(MCP_CALL_METHOD_MAX), 1, { transport: 'stateless' }),
    ]);
  });

  it('passado o teto de métodos distintos, o excedente é contado em "other"', async () => {
    const store = fakeStore();
    const log = vi.fn();
    const t = tracker(store, { maxMethodsPerEntry: 2, log });
    const corpo = [{ method: 'a/1' }, { method: 'b/2' }, { method: 'c/3' }, { method: 'd/4' }, { method: 'c/3' }];

    t.stateless(request({ body: corpo }));
    await t.flush();

    expect(chamadasDe(store)).toEqual([
      chamada('a/1', 1, { transport: 'stateless' }),
      chamada('b/2', 1, { transport: 'stateless' }),
      chamada('other', 3, { transport: 'stateless' }),
    ]);
    // O aviso é um por janela de "online", como o do teto de identidades.
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('teto de 2 métodos distintos'));
  });

  /**
   * O despejo agrupado pode atravessar a virada dos 15 minutos — aqui com o
   * intervalo largo, para as duas chamadas ainda estarem na memória quando ele
   * acontece. O que foi chamado antes não pode aparecer no balde novo: é dele
   * que sai o dia do relatório.
   */
  it('o que foi chamado antes da virada do balde não vai para o balde novo', async () => {
    const store = fakeStore();
    const clock = { now: 900_000 };
    const t = tracker(store, { touchIntervalMs: 3_600_000 }, clock);

    t.opened('streamable', 'sess-1', request({ body: { method: 'tools/call' } }));
    clock.now += MCP_CALL_BUCKET_MS;
    t.seen('streamable', 'sess-1', request({ body: { method: 'tools/call' } }));
    await t.flush();

    expect(MCP_CALL_BUCKET_MS).toBe(900_000);
    expect(chamadasDe(store)).toEqual([
      chamada('tools/call', 1, { bucket: '1970-01-01T00:15:00.000Z' }),
      chamada('tools/call', 1, { bucket: '1970-01-01T00:30:00.000Z' }),
    ]);
  });

  /**
   * O teto de métodos distintos protege `mcp_call_counters`, que nunca é
   * podada: o que ele limita é quantas **linhas** uma entrada chega a criar.
   * Medido em `calls.size`, ele reiniciava a cada despejo — e o despejo é a
   * cada `touchIntervalMs` (10 s na produção), enquanto a linha é por balde de
   * 15 minutos. Aqui o intervalo é de 1 ms para o despejo cair entre uma
   * requisição e a outra, que é como ele cai sob carga.
   */
  it('o teto vale por balde: um despejo no meio não dá direito a métodos novos', async () => {
    const store = fakeStore();
    const clock = { now: 900_000 };
    const t = tracker(store, { maxMethodsPerEntry: 2, touchIntervalMs: 1 }, clock);

    for (const metodo of ['a/1', 'b/2', 'c/3', 'd/4']) {
      clock.now += 10;
      const req = request({ body: { method: metodo } });
      if (metodo === 'a/1') t.opened('streamable', 'sess-1', req);
      else t.seen('streamable', 'sess-1', req);
      await flushMicrotasks();
    }
    await t.flush();

    // Três despejos no caminho e ainda assim duas linhas de método mais a do
    // excedente: sem o conserto, cada despejo esvaziava o mapa e os quatro
    // métodos inventados viravam quatro linhas.
    expect(store.calls.bumpMcpCallCounters.mock.calls.length).toBeGreaterThan(1);
    expect(linhasDe(store)).toEqual([chamada('a/1', 1), chamada('b/2', 1), chamada('other', 2)]);
  });

  /**
   * O outro lado do mesmo teto: ele é **por balde**, então o balde novo começa
   * do zero. Sem isto, uma sessão longa que já tivesse estourado o teto às 10h
   * contaria todo o resto do dia em `other` — e o relatório perderia o método
   * de cada chamada sem que nada estivesse sendo abusado.
   */
  it('balde novo recomeça o teto: o método visto no anterior não conta contra ele', async () => {
    const store = fakeStore();
    const clock = { now: 900_000 };
    const t = tracker(store, { maxMethodsPerEntry: 2, touchIntervalMs: 3_600_000 }, clock);
    const BALDE_2 = '1970-01-01T00:30:00.000Z';

    t.opened('streamable', 'sess-1', request({ body: [{ method: 'a/1' }, { method: 'b/2' }, { method: 'c/3' }] }));
    clock.now += MCP_CALL_BUCKET_MS;
    t.seen('streamable', 'sess-1', request({ body: [{ method: 'd/4' }, { method: 'e/5' }, { method: 'f/6' }] }));
    await t.flush();

    // A ordem é a do mapa da entrada (método → balde): `other` já existia como
    // chave do balde anterior, e por isso vem antes de `d/4`.
    expect(linhasDe(store)).toEqual([
      chamada('a/1', 1),
      chamada('b/2', 1),
      chamada('other', 1),
      chamada('other', 1, { bucket: BALDE_2 }),
      chamada('d/4', 1, { bucket: BALDE_2 }),
      chamada('e/5', 1, { bucket: BALDE_2 }),
    ]);
  });

  /**
   * O despejo sai do caminho quente e a soma das chamadas é um `INSERT`
   * multilinha: sob contenção ela espera o timeout do banco inteiro. Com
   * `lastFlush` marcado só no fim, ele seguia velho durante toda a espera e
   * **cada** requisição que chegasse disparava outro despejo da mesma entrada —
   * a tempestade de `INSERT` concorrentes que alimenta o deadlock em
   * `mcp_call_counters`. Aqui o primeiro `INSERT` fica preso até o teste soltar.
   */
  it('requisição que chega com o INSERT em voo não dispara um segundo despejo', async () => {
    const store = fakeStore();
    const clock = { now: 1_000_000 };
    let soltar: () => void = () => undefined;
    const preso = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    store.calls.bumpMcpCallCounters.mockImplementationOnce(async () => {
      await preso;
    });
    const t = tracker(store, {}, clock);
    const req = () => request({ body: { method: 'tools/call' } });

    t.opened('streamable', 'sess-1', req());
    clock.now += 10_000;
    t.seen('streamable', 'sess-1', req());
    await flushMicrotasks();
    expect(store.calls.bumpMcpCallCounters).toHaveBeenCalledTimes(1);

    // Três requisições com o primeiro INSERT ainda preso: nenhuma delas pode
    // disparar outro. Sem a marca antecipada, a primeira já disparava.
    for (let i = 0; i < 3; i += 1) {
      clock.now += 1_000;
      t.seen('streamable', 'sess-1', req());
      await flushMicrotasks();
    }
    expect(store.calls.bumpMcpCallCounters).toHaveBeenCalledTimes(1);

    soltar();
    await flushMicrotasks();
    clock.now += 10_000;
    t.seen('streamable', 'sess-1', req());
    await flushMicrotasks();

    // O que chegou durante a espera vai no despejo seguinte, no mesmo balde, e
    // `request_count` não muda: as cinco requisições continuam somando cinco.
    expect(store.calls.bumpMcpCallCounters).toHaveBeenCalledTimes(2);
    expect(chamadasDe(store, 1)).toEqual([chamada('tools/call', 4)]);
    expect(store.calls.touchMcpSession.mock.calls).toEqual([
      ['row-1', { requests: 4 }],
      ['row-1', { requests: 1 }],
    ]);
  });

  /**
   * O `POST /messages` do SSE legado não passa pelo middleware `lote` do
   * `http.ts` — não tem teto nenhum — e o `handlePostMessage` do SDK recusa um
   * array com 400, sem processar mensagem alguma. Contar o lote inteiro punha
   * 5 000 chamadas que nunca aconteceram na tela de Atividade.
   */
  it('no SSE legado o lote não vira N chamadas; no Streamable ele continua valendo', async () => {
    const store = fakeStore();
    const t = tracker(store);
    const lote = Array.from({ length: 5_000 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call' }));

    t.opened('sse', 'sse-1', request({ body: undefined }));
    t.seen('sse', 'sse-1', request({ body: lote }));
    // O corpo de um cliente de verdade — objeto solto — conta como sempre.
    t.seen('sse', 'sse-1', request({ body: { method: 'ping' } }));
    t.opened('streamable', 'sess-1', request({ body: lote }));
    await t.flush();

    expect(linhasDe(store)).toEqual([
      chamada('tools/call', 1, { transport: 'sse' }),
      chamada('ping', 1, { transport: 'sse' }),
      chamada('tools/call', 5_000),
    ]);
    // A requisição segue sendo uma: o lote recusado não some da contagem de
    // requisições, só deixa de virar chamada.
    expect(store.calls.touchMcpSession).toHaveBeenCalledWith('row-1', { requests: 2 });
  });

  it('sem escopo (requisição sem vMCP) não conta chamada nenhuma', async () => {
    const store = fakeStore();
    const t = tracker(store);
    const corpo = { method: 'tools/call' };

    t.stateless(request({ body: corpo, virtual: false }));
    t.opened('streamable', 'sess-1', request({ body: corpo, virtual: false }));
    // A sessão nunca entrou no mapa: o toque dela também não acha nada.
    t.seen('streamable', 'sess-1', request({ body: corpo }));
    await t.flush();

    expect(store.calls.bumpMcpCallCounters).not.toHaveBeenCalled();
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
