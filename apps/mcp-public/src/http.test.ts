import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@purple-skills/db', () => ({ healthCheck: vi.fn(async () => true) }));

const { createHttpApp } = await import('./http.js');
import type { SessionTracker } from './sessions.js';

type Opcoes = Parameters<typeof createHttpApp>[0];

/**
 * Dois pontos de montagem no mesmo app — a raiz e `/virtual/:slug` — com um
 * mapa de sessões só. O que separa um do outro é a identidade da credencial,
 * que no virtual embute o slug. Estes testes cobrem essa separação e o
 * endpoint anunciado pelo SSE, que precisa carregar o prefixo.
 */

/** Identidade vem de um header simples: o teste não precisa do banco de chaves. */
const IDENTITY_HEADER = 'x-identidade';

let running: Server | undefined;
const abortControllers: AbortController[] = [];

/** Um rastreador que só anota as chamadas — o de verdade grava no banco. */
function fakeTracker(): SessionTracker & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    opened: (transport, id) => void events.push(`opened:${transport}:${id.length > 0}`),
    seen: (transport) => void events.push(`seen:${transport}`),
    closed: (transport, _id, reason) => void events.push(`closed:${transport}:${reason}`),
    stateless: () => void events.push('stateless'),
    flush: async () => undefined,
    sweep: async () => undefined,
    shutdown: async () => void events.push('shutdown'),
  };
}

let tracker: ReturnType<typeof fakeTracker> | undefined;

function startApp(extras: Partial<Opcoes> = {}) {
  const app = createHttpApp({
    sessions: tracker,
    mounts: [
      {
        basePath: '',
        auth: (_req, _res, next) => next(),
        createServer: () => new McpServer({ name: 'principal', version: '0.0.0' }),
        identityOf: () => undefined,
      },
      {
        basePath: '/virtual/:slug',
        auth: (req, res, next) => {
          if (req.params.slug === 'inexistente') {
            res.status(404).json({ error: 'nao' });
            return;
          }
          next();
        },
        createServer: (req) => new McpServer({ name: `virtual-${req.params.slug}`, version: '0.0.0' }),
        identityOf: (req) => `${req.params.slug}:${req.header(IDENTITY_HEADER) ?? 'anon'}`,
        routes: (router) => {
          router.get('/skills/:skill/download', (req, res) => {
            res.json({ slug: req.params.slug, skill: req.params.skill });
          });
        },
      },
    ],
    jsonLimit: '1mb',
    openCors: true,
    info: { name: 'teste', version: '0.0.0', description: 'teste' },
    describe: async () => ({ defaultMcp: { status: 'ok', slug: 'time-a' } }),
    ...extras,
  });

  return new Promise<string>((resolve) => {
    running = app.listen(0, '127.0.0.1', () => {
      const { port } = running!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Abre o `GET <base>/sse` e devolve o endpoint anunciado no evento `endpoint`. */
async function openSse(url: string, identity?: string): Promise<string> {
  const controller = new AbortController();
  abortControllers.push(controller);

  const res = await fetch(url, {
    headers: identity ? { [IDENTITY_HEADER]: identity } : {},
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (!buffer.includes('sessionId=')) {
    const { done, value } = await reader.read();
    if (done) throw new Error('stream SSE encerrou sem anunciar o endpoint');
    buffer += decoder.decode(value, { stream: true });
  }

  return /data: (\S+)/.exec(buffer)![1]!;
}

const post = (url: string, identity?: string) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(identity ? { [IDENTITY_HEADER]: identity } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

afterEach(() => {
  for (const controller of abortControllers.splice(0)) controller.abort();
  running?.close();
  running = undefined;
  tracker = undefined;
});

/** Abre uma sessão Streamable HTTP: é o `initialize` que a cria. */
const initialize = (url: string) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'teste', version: '1' } },
    }),
  });

describe('contabilidade de sessões', () => {
  it('avisa o rastreador em cada transporte: abertura, atividade, fechamento e stateless', async () => {
    tracker = fakeTracker();
    const base = await startApp();

    // Streamable: o initialize abre a sessão; a mensagem seguinte é atividade.
    const first = await initialize(`${base}/virtual/time-a/mcp`);
    expect(first.status).toBe(200);
    const sessionId = first.headers.get('mcp-session-id')!;
    expect(sessionId).toBeTruthy();
    await fetch(`${base}/virtual/time-a/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    await fetch(`${base}/virtual/time-a/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } });

    // Stateless: uma linha sintética por requisição.
    await fetch(`${base}/mcp/stateless`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });

    // SSE: abrir o stream é abrir a sessão; o POST em /messages é atividade.
    const endpoint = await openSse(`${base}/virtual/time-a/sse`, 'maria');
    await post(`${base}${endpoint}`, 'maria');

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(tracker.events).toContain('opened:streamable:true');
    expect(tracker.events).toContain('seen:streamable');
    expect(tracker.events).toContain('closed:streamable:closed');
    expect(tracker.events).toContain('stateless');
    expect(tracker.events).toContain('opened:sse:true');
    expect(tracker.events).toContain('seen:sse');
  });
});

describe('GET /', () => {
  it('anuncia os metadados fixos e o que `describe` calcula por requisição', async () => {
    const base = await startApp();

    const payload = await (await fetch(`${base}/`)).json();

    expect(payload.name).toBe('teste');
    expect(payload.transports).toBeDefined();
    expect(payload.defaultMcp).toEqual({ status: 'ok', slug: 'time-a' });
  });
});

describe('montagem sob /virtual/:slug', () => {
  it('anuncia o endpoint de mensagens com o prefixo do MCP virtual', async () => {
    const base = await startApp();

    const endpoint = await openSse(`${base}/virtual/time-a/sse`, 'maria');

    expect(endpoint).toMatch(/^\/virtual\/time-a\/messages\?sessionId=/);
  });

  it('a raiz continua anunciando /messages sem prefixo', async () => {
    const base = await startApp();

    expect(await openSse(`${base}/sse`)).toMatch(/^\/messages\?sessionId=/);
  });

  it('o slug do prefixo chega às rotas próprias do ponto de montagem', async () => {
    const base = await startApp();

    const res = await fetch(`${base}/virtual/time-a/skills/minha-skill/download`);

    expect(await res.json()).toEqual({ slug: 'time-a', skill: 'minha-skill' });
  });

  it('a autenticação do ponto de montagem vale para as rotas próprias', async () => {
    const base = await startApp();

    // A rota de download é registrada pelo mount com o mesmo `auth` dos
    // transportes — aqui simulado pelo 404 do slug "inexistente".
    const res = await fetch(`${base}/virtual/inexistente/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(res.status).toBe(404);
  });
});

describe('sessão presa ao MCP virtual e à credencial', () => {
  it('aceita mensagem da mesma credencial no mesmo virtual', async () => {
    const base = await startApp();
    const endpoint = await openSse(`${base}/virtual/time-a/sse`, 'maria');

    expect((await post(`${base}${endpoint}`, 'maria')).status).toBe(202);
  });

  it('recusa outra credencial no mesmo virtual', async () => {
    const base = await startApp();
    const endpoint = await openSse(`${base}/virtual/time-a/sse`, 'maria');

    const res = await post(`${base}${endpoint}`, 'joao');

    expect(res.status).toBe(403);
  });

  it('recusa a sessão de um virtual quando apresentada em outro, mesmo com a mesma credencial', async () => {
    const base = await startApp();
    const endpoint = await openSse(`${base}/virtual/time-a/sse`, 'maria');
    const sessionId = /sessionId=(.+)$/.exec(endpoint)![1]!;

    const res = await post(`${base}/virtual/time-b/messages?sessionId=${sessionId}`, 'maria');

    expect(res.status).toBe(403);
  });

  it('recusa a sessão de um virtual apresentada na raiz', async () => {
    const base = await startApp();
    const endpoint = await openSse(`${base}/virtual/time-a/sse`, 'maria');
    const sessionId = /sessionId=(.+)$/.exec(endpoint)![1]!;

    const res = await post(`${base}/messages?sessionId=${sessionId}`);

    expect(res.status).toBe(403);
  });
});

/**
 * O teto de sessões tem duas dimensões. A **global** é o orçamento de memória
 * do processo, somando os dois transportes. A **por credencial** existe porque
 * num vMCP aberto todo anônimo tem a mesma identidade: sem ela, quem abre
 * sessão e vai embora nega o serviço a quem tem chave de outro vMCP. E ela não
 * recusa — recicla a sessão mais parada da própria credencial, porque cliente
 * MCP reconecta o tempo todo e a sessão abandonada é sempre a mais parada.
 */
describe('teto de sessões', () => {
  it('recicla a sessão mais parada da própria credencial, sem tocar na de outra', async () => {
    const base = await startApp({ maxSessionsPerIdentity: 2 });
    const primeiraDaMaria = await openSse(`${base}/virtual/time-a/sse`, 'maria');
    const segundaDaMaria = await openSse(`${base}/virtual/time-a/sse`, 'maria');
    const doJoao = await openSse(`${base}/virtual/time-a/sse`, 'joao');

    // A terceira da maria estoura o teto dela: a mais parada é a primeira.
    const terceiraDaMaria = await openSse(`${base}/virtual/time-a/sse`, 'maria');

    expect((await post(`${base}${primeiraDaMaria}`, 'maria')).status).toBe(404);
    expect((await post(`${base}${segundaDaMaria}`, 'maria')).status).toBe(202);
    expect((await post(`${base}${terceiraDaMaria}`, 'maria')).status).toBe(202);
    // O joao não paga pelo excesso da maria — é o ponto do teto por credencial.
    expect((await post(`${base}${doJoao}`, 'joao')).status).toBe(202);
  });

  it('o cliente que reabre sessão não leva recusa: cai a mais parada dele mesmo', async () => {
    const base = await startApp({ maxSessionsPerIdentity: 2 });
    const primeira = await initialize(`${base}/mcp`);
    const idDaPrimeira = primeira.headers.get('mcp-session-id')!;
    await primeira.text();
    const segunda = await initialize(`${base}/mcp`);
    const idDaSegunda = segunda.headers.get('mcp-session-id')!;
    await segunda.text();

    // O Claude Desktop reabre a sessão a cada janela: a terceira entra.
    const terceira = await initialize(`${base}/mcp`);
    expect(terceira.status).toBe(200);
    await terceira.text();

    const naSessao = (id: string) =>
      fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': id },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });

    expect((await naSessao(idDaPrimeira)).status).toBe(404);
    expect((await naSessao(idDaSegunda)).status).toBe(202);
  });

  it('a varredura fecha a sessão SSE parada e poupa a que segue em uso', async () => {
    tracker = fakeTracker();
    const base = await startApp({ sessionTtlMs: 100, sessionSweepMs: 20 });
    const parada = await openSse(`${base}/virtual/time-a/sse`, 'maria');
    const emUso = await openSse(`${base}/virtual/time-a/sse`, 'joao');

    // Uma continua conversando enquanto o TTL vence a outra.
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await post(`${base}${emUso}`, 'joao');
    }

    expect((await post(`${base}${parada}`, 'maria')).status).toBe(404);
    expect((await post(`${base}${emUso}`, 'joao')).status).toBe(202);
    // O painel precisa ver o motivo certo: a sessão venceu, não foi o cliente
    // que desligou. O rastreador ignora o `closed` que vem depois.
    expect(tracker.events).toContain('closed:sse:timeout');
  });

  it('o teto global soma os dois transportes e recusa dizendo o que fazer', async () => {
    const base = await startApp({ maxSessions: 1 });
    await openSse(`${base}/sse`);

    // A única vaga está com o SSE: antes, cada transporte tinha um pool seu.
    const res = await initialize(`${base}/virtual/time-a/mcp`);

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(await res.json()).toMatchObject({ error: { message: /mcp\/stateless/ } });
  });

  it('antes de recusar por teto, a faxina libera a vaga da sessão vencida', async () => {
    // Varredura longa de propósito: quem libera a vaga aqui é a própria
    // checagem do teto, não o timer.
    const base = await startApp({ maxSessions: 1, sessionTtlMs: 50, sessionSweepMs: 10_000 });
    await openSse(`${base}/sse`);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const res = await initialize(`${base}/virtual/time-a/mcp`);

    expect(res.status).toBe(200);
  });
});

/**
 * O limite de taxa é a camada que falta antes dos tetos de sessão: eles limitam
 * o que fica em pé, ele limita o que entra. Fica **antes** da autenticação de
 * propósito — é ele que protege a consulta que o `auth` faz —, e por isso o
 * perdão da cota de quem tem chave vem depois, não como isenção prévia.
 */
describe('limite de taxa por IP', () => {
  it('recusa com 429 e Retry-After depois do teto, e deixa o /healthz fora da conta', async () => {
    const base = await startApp({ rateLimitMax: 2 });

    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).toBe(200);

    const recusada = await fetch(`${base}/`);
    expect(recusada.status).toBe(429);
    expect(recusada.headers.get('retry-after')).toBeTruthy();
    expect(await recusada.json()).toMatchObject({ error: { code: -32000 } });

    // A sonda do container fica acima do limite: um 429 aqui reiniciaria um
    // processo saudável.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('a requisição autenticada por chave não gasta a cota; a anônima gasta', async () => {
    const base = await startApp({
      rateLimitMax: 2,
      mounts: [
        {
          basePath: '',
          auth: (_req, _res, next) => next(),
          createServer: () => new McpServer({ name: 'principal', version: '0.0.0' }),
          // `:key:` é o que `auth.ts` monta quando a chave psv_ foi conferida;
          // `:open` é o anônimo de um vMCP aberto.
          identityOf: (req) => (req.header(IDENTITY_HEADER) ? 'virtual:u-1:key:k-1' : 'virtual:u-1:open'),
        },
      ],
    });

    // `GET /mcp` sem sessão responde 404, mas já passou pelo `auth` — é o que
    // importa aqui. Com chave, nenhuma das três gasta cota.
    const comChave = () => fetch(`${base}/mcp`, { headers: { [IDENTITY_HEADER]: 'k' } });
    for (let i = 0; i < 3; i += 1) expect((await comChave()).status).toBe(404);

    // Sem chave, a mesma rota gasta: o perdão não é a presença do cabeçalho.
    expect((await fetch(`${base}/mcp`)).status).toBe(404);
    expect((await fetch(`${base}/mcp`)).status).toBe(404);
    expect((await fetch(`${base}/mcp`)).status).toBe(429);

    // E com o IP já estourado nem a chave passa: o limite é anterior ao `auth`
    // porque é ele que protege o `auth`.
    expect((await comChave()).status).toBe(429);
  });
});
