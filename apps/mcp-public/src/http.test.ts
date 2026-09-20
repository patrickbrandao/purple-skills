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
          // O `:slug` vem do ponto de montagem, não deste caminho: sem o tipo
          // explícito o Express deduz `params` só do literal da rota.
          router.get<{ slug: string; skill: string }>('/skills/:skill/download', (req, res) => {
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
async function openSse(url: string, identity?: string, extras: Record<string, string> = {}): Promise<string> {
  const controller = new AbortController();
  abortControllers.push(controller);

  const res = await fetch(url, {
    headers: { ...(identity ? { [IDENTITY_HEADER]: identity } : {}), ...extras },
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

const post = (url: string, identity?: string, extras: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(identity ? { [IDENTITY_HEADER]: identity } : {}),
      ...extras,
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

    const payload = (await (await fetch(`${base}/`)).json()) as {
      name: string;
      transports: unknown;
      defaultMcp: unknown;
    };

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
    // `stringMatching`, não a regex crua: dentro de `toMatchObject` ela casa
    // com qualquer coisa e a asserção não conferia nada.
    expect(await res.json()).toMatchObject({ error: { message: expect.stringMatching(/mcp\/stateless/) } });
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
 * Num vMCP aberto a identidade é uma só para todo cliente sem chave, então o
 * teto por credencial é **um balde comum** a todos eles: cai a sessão mais
 * parada, venha de onde vier (`docs/08` §4.1). É consequência aceita, agora
 * escrita; o primeiro teste a fixa, para que mudá-la seja decisão e não acidente.
 *
 * O segundo guarda o motivo de "reciclar primeiro a do próprio endereço" ter sido
 * recusado: medido, com o balde cheio de sessões abandonadas — o estado normal de
 * um servidor popular —, aquela regra fazia as duas janelas de um mesmo usuário
 * se derrubarem a cada chamada (10 reaberturas em 10 chamadas; hoje, nenhuma).
 */
describe('teto de sessões na identidade aberta', () => {
  // O teste fala com o app por loopback, que o `trust proxy` padrão aceita como
  // proxy: o `X-Forwarded-For` vira o `req.ip`, como atrás do Traefik.
  const de = (ip: string): Record<string, string> => ({ 'x-forwarded-for': ip });
  const ANA = de('203.0.113.1');
  const BIA = de('198.51.100.2');

  const startAberto = (maxSessionsPerIdentity: number) =>
    startApp({
      maxSessionsPerIdentity,
      mounts: [
        {
          basePath: '',
          auth: (_req, _res, next) => next(),
          createServer: () => new McpServer({ name: 'principal', version: '0.0.0' }),
          identityOf: () => 'virtual:u-1:open',
        },
      ],
    });

  it('o balde é um só para todos os endereços: cai a mais parada, venha de onde vier', async () => {
    const base = await startAberto(2);
    const daBia = await openSse(`${base}/sse`, undefined, BIA);
    const primeiraDaAna = await openSse(`${base}/sse`, undefined, ANA);

    // O anônimo nunca leva recusa (`02` §7.3): a terceira entra, e sai a mais parada.
    const segundaDaAna = await openSse(`${base}/sse`, undefined, ANA);

    expect((await post(`${base}${daBia}`, undefined, BIA)).status).toBe(404);
    expect((await post(`${base}${primeiraDaAna}`, undefined, ANA)).status).toBe(202);
    expect((await post(`${base}${segundaDaAna}`, undefined, ANA)).status).toBe(202);
  });

  it('com o balde cheio de sessões abandonadas, duas janelas do mesmo endereço convivem', async () => {
    const base = await startAberto(5);
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) await openSse(`${base}/sse`, undefined, de(ip));

    const janelas = [await openSse(`${base}/sse`, undefined, ANA), await openSse(`${base}/sse`, undefined, ANA)];

    // Uso alternado: quem cai são as abandonadas, nunca a janela ao lado.
    for (let i = 0; i < 6; i += 1) {
      expect((await post(`${base}${janelas[i % 2]!}`, undefined, ANA)).status).toBe(202);
    }
  });

  it('a sessão continua sendo de quem tem a credencial, não de um endereço', async () => {
    const base = await startAberto(2);
    const daAna = await openSse(`${base}/sse`, undefined, ANA);

    // Trocar de rede no meio da sessão não pode custar a sessão — vale para
    // qualquer desenho futuro que ponha o endereço na conta do teto.
    expect((await post(`${base}${daAna}`, undefined, BIA)).status).toBe(202);
  });

  it('o 404 da sessão que caiu diz o que fazer', async () => {
    const base = await startAberto(1);
    const primeira = await openSse(`${base}/sse`, undefined, ANA);
    await openSse(`${base}/sse`, undefined, ANA);

    const res = await post(`${base}${primeira}`, undefined, ANA);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: -32001, message: expect.stringMatching(/GET \/sse.*\/mcp\/stateless/) },
    });
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

/**
 * O limite de taxa conta requisição HTTP, e o corpo de um POST pode ser um
 * array: sem o guarda do lote, uma requisição aceita comprava milhares de
 * `tools/call` — medido antes da correção, 2 000 execuções por **uma** marca. O
 * guarda vem depois do `json` (antes disso não há corpo para contar) e faz duas
 * coisas: teto de mensagens por lote e uma marca por mensagem.
 */
describe('lote JSON-RPC', () => {
  /** App cuja tool `contar` anota cada execução: é o que diz quantas mensagens do lote rodaram. */
  function startAppComContador(execucoes: { total: number }, extras: Partial<Opcoes> = {}) {
    return startApp({
      mounts: [
        {
          basePath: '',
          auth: (_req, _res, next) => next(),
          createServer: () => {
            const server = new McpServer({ name: 'principal', version: '0.0.0' });
            server.registerTool('contar', { title: 'Contar' }, () => {
              execucoes.total += 1;
              return { content: [{ type: 'text' as const, text: 'ok' }] };
            });
            return server;
          },
          identityOf: (req) => (req.header(IDENTITY_HEADER) ? 'virtual:u-1:key:k-1' : 'virtual:u-1:open'),
        },
      ],
      ...extras,
    });
  }

  const chamadas = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      jsonrpc: '2.0',
      id: i + 1,
      method: 'tools/call',
      params: { name: 'contar', arguments: {} },
    }));

  const postar = (url: string, corpo: unknown, extras: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extras },
      body: JSON.stringify(corpo),
    });

  it('recusa o lote acima do teto com 400 JSON-RPC, sem executar nada; no teto, passa', async () => {
    const execucoes = { total: 0 };
    const base = await startAppComContador(execucoes, { maxBatch: 3 });

    const grande = await postar(`${base}/mcp/stateless`, chamadas(4));
    expect(grande.status).toBe(400);
    expect(await grande.json()).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: expect.stringMatching(/4 mensagens.*limite de 3/) },
    });
    expect(execucoes.total).toBe(0);

    const noTeto = await postar(`${base}/mcp/stateless`, chamadas(3));
    expect(noTeto.status).toBe(200);
    expect(await noTeto.json()).toHaveLength(3);
    expect(execucoes.total).toBe(3);
  });

  it('cada mensagem do lote gasta uma marca do limite por IP', async () => {
    const execucoes = { total: 0 };
    const base = await startAppComContador(execucoes, { rateLimitMax: 5 });

    // Três mensagens, três marcas: a da entrada mais duas do guarda.
    expect((await postar(`${base}/mcp/stateless`, chamadas(3))).status).toBe(200);
    expect(execucoes.total).toBe(3);

    // Sobram duas: o lote de três não cabe, e nenhuma mensagem dele roda.
    const recusado = await postar(`${base}/mcp/stateless`, chamadas(3));
    expect(recusado.status).toBe(429);
    expect(recusado.headers.get('retry-after')).toBeTruthy();
    expect(await recusado.json()).toMatchObject({
      error: { code: -32000, message: expect.stringMatching(/mensagem de um lote/) },
    });
    expect(execucoes.total).toBe(3);
  });

  it('o lote dentro de uma sessão paga igual ao do stateless', async () => {
    const execucoes = { total: 0 };
    const base = await startAppComContador(execucoes, { rateLimitMax: 4 });
    const inicio = await initialize(`${base}/mcp`);
    const sessionId = inicio.headers.get('mcp-session-id')!;
    await inicio.text();

    // Uma marca foi do `initialize`; o lote de quatro pediria mais quatro.
    const recusado = await postar(`${base}/mcp`, chamadas(4), { 'mcp-session-id': sessionId });
    expect(recusado.status).toBe(429);
    expect(execucoes.total).toBe(0);
  });

  it('a mensagem avulsa continua custando uma marca só', async () => {
    const execucoes = { total: 0 };
    const base = await startAppComContador(execucoes, { rateLimitMax: 2 });
    const [avulsa] = chamadas(1);

    expect((await postar(`${base}/mcp/stateless`, avulsa)).status).toBe(200);
    expect((await postar(`${base}/mcp/stateless`, avulsa)).status).toBe(200);
    expect((await postar(`${base}/mcp/stateless`, avulsa)).status).toBe(429);
    expect(execucoes.total).toBe(2);
  });

  it('a chave psv_ não paga o lote com a cota do endereço, mas obedece ao teto de mensagens', async () => {
    const execucoes = { total: 0 };
    const base = await startAppComContador(execucoes, { rateLimitMax: 2, maxBatch: 5 });
    const comChave = { [IDENTITY_HEADER]: 'k' };

    // Duas vezes cinco mensagens com a cota em 2: nada disso conta.
    expect((await postar(`${base}/mcp/stateless`, chamadas(5), comChave)).status).toBe(200);
    expect((await postar(`${base}/mcp/stateless`, chamadas(5), comChave)).status).toBe(200);
    expect(execucoes.total).toBe(10);

    // O teto de mensagens protege o banco, não a cota: vale com chave também.
    expect((await postar(`${base}/mcp/stateless`, chamadas(6), comChave)).status).toBe(400);
    expect(execucoes.total).toBe(10);

    // E a cota anônima do mesmo endereço seguiu intacta.
    expect((await postar(`${base}/mcp/stateless`, chamadas(2))).status).toBe(200);
  });

  it('com o limite de taxa desligado, o teto de mensagens continua valendo', async () => {
    const execucoes = { total: 0 };
    const base = await startAppComContador(execucoes, { rateLimitMax: 0, maxBatch: 2 });

    expect((await postar(`${base}/mcp/stateless`, chamadas(3))).status).toBe(400);
    expect((await postar(`${base}/mcp/stateless`, chamadas(2))).status).toBe(200);
    expect(execucoes.total).toBe(2);
  });
});

/**
 * O `text` do Postgres recusa U+0000 com 22021, e o slug da URL chega cru à
 * consulta: `/virtual/a%00b/mcp` e `/skills/a%00b/download` eram 500 com a SQL
 * no log, sem credencial nenhuma (achado do relatório 038 da auditoria de
 * 2026-09-19). A guarda é uma só, antes dos pontos de montagem — o `auth`, que
 * é quem consulta o banco pelo slug, nem chega a rodar.
 */
describe('caractere nulo na URL', () => {
  it.each([
    ['/virtual/a%00b/mcp', 'POST'],
    ['/virtual/a%00b/sse', 'GET'],
    ['/virtual/time-a/skills/x%00y/download', 'GET'],
    ['/virtual/time-a/skills/x/download?formato=%00', 'GET'],
    ['/mcp/stateless?x=%00', 'POST'],
  ])('%s responde 400 em JSON-RPC, antes do ponto de montagem', async (rota, method) => {
    const base = await startApp();

    const res = await fetch(`${base}${rota}`, {
      method,
      ...(method === 'POST'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }
        : {}),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Requisição inválida: o endereço não pode conter o caractere nulo (%00)' },
      id: null,
    });
  });

  it('a mesma rota sem o nulo segue atendida', async () => {
    const base = await startApp();

    const res = await fetch(`${base}/virtual/time-a/skills/x/download`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'time-a', skill: 'x' });
  });

  it('a sondagem com nulo gasta a cota do endereço, como qualquer requisição', async () => {
    const base = await startApp({ rateLimitMax: 2 });

    expect((await fetch(`${base}/virtual/a%00b/mcp`)).status).toBe(400);
    expect((await fetch(`${base}/virtual/a%00b/mcp`)).status).toBe(400);
    expect((await fetch(`${base}/virtual/a%00b/mcp`)).status).toBe(429);
  });
});
