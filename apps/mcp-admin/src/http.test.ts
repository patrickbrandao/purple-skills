import { AsyncLocalStorage } from 'node:async_hooks';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@purple-skills/db', () => ({ healthCheck: vi.fn(async () => true) }));

const { createHttpApp } = await import('./http.js');

type Opcoes = Parameters<typeof createHttpApp>[0];

/**
 * O transporte SSE identifica a sessão por `?sessionId=` na query string — um
 * valor que viaja fora do canal autenticado. Estes testes cobrem o vínculo
 * entre a sessão e a credencial que a abriu.
 */

/** Identidade vem de um header simples: o teste não precisa do banco de chaves. */
const IDENTITY_HEADER = 'x-identidade';

let running: Server | undefined;
const abortControllers: AbortController[] = [];

function startApp(extras: Partial<Opcoes> = {}) {
  const app = createHttpApp({
    createServer: () => new McpServer({ name: 'teste', version: '0.0.0' }),
    auth: (_req, _res, next) => next(),
    identityOf: (req) => req.header(IDENTITY_HEADER),
    jsonLimit: '1mb',
    openCors: false,
    info: { name: 'teste', version: '0.0.0', description: 'teste', requiresAuth: true },
    ...extras,
  });

  return new Promise<string>((resolve) => {
    running = app.listen(0, '127.0.0.1', () => {
      const { port } = running!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Abre o `GET /sse` e devolve o `sessionId` anunciado no evento `endpoint`. */
async function openSseSession(base: string, identity: string): Promise<string> {
  const controller = new AbortController();
  abortControllers.push(controller);

  const res = await fetch(`${base}/sse`, {
    headers: { [IDENTITY_HEADER]: identity },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // O primeiro evento do transporte é o `endpoint`, com a URL das mensagens.
  while (!buffer.includes('sessionId=')) {
    const { done, value } = await reader.read();
    if (done) throw new Error('stream SSE encerrou sem anunciar o endpoint');
    buffer += decoder.decode(value, { stream: true });
  }

  return /sessionId=([^\s&]+)/.exec(buffer)![1]!;
}

const postMessage = (base: string, sessionId: string, identity: string) =>
  fetch(`${base}/messages?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [IDENTITY_HEADER]: identity },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

afterEach(() => {
  for (const controller of abortControllers.splice(0)) controller.abort();
  running?.close();
  running = undefined;
});

describe('sessão SSE presa à credencial', () => {
  it('aceita mensagem da mesma credencial que abriu a sessão', async () => {
    const base = await startApp();
    const sessionId = await openSseSession(base, 'chave-da-maria');

    const res = await postMessage(base, sessionId, 'chave-da-maria');

    expect(res.status).toBe(202);
  });

  it('recusa mensagem de outra credencial na sessão alheia', async () => {
    const base = await startApp();
    const sessionId = await openSseSession(base, 'chave-da-maria');

    const res = await postMessage(base, sessionId, 'chave-do-joao');

    expect(res.status).toBe(403);
    // `stringMatching`, não a regex crua: dentro de `toMatchObject` ela não é
    // conferida neste Vitest — passava com qualquer mensagem.
    expect(await res.json()).toMatchObject({ error: { message: expect.stringMatching(/outra credencial/i) } });
  });

  it('responde 404 para sessão inexistente, sem revelar identidade', async () => {
    const base = await startApp();

    const res = await postMessage(base, 'sessao-que-nao-existe', 'chave-da-maria');

    expect(res.status).toBe(404);
  });
});

/**
 * `withRequest` é o que faz a tool ler a credencial da requisição em curso, e
 * não a do `initialize` — o servidor da sessão é construído uma única vez. Aqui
 * o "papel" é um header e o contexto é um `AsyncLocalStorage` local, igual ao
 * que `auth.ts` usa com o `Caller`.
 */
const ROLE_HEADER = 'x-papel';
const papelDaRequisicao = new AsyncLocalStorage<string>();

/** App cujo `quem_sou` devolve o papel da requisição, ou o do initialize. */
function startAppComPapel(criados: { total: number }) {
  return startApp({
    withRequest: (req, run) => papelDaRequisicao.run(req.header(ROLE_HEADER) ?? '', run),
    createServer: (req) => {
      criados.total += 1;
      const doInitialize = req.header(ROLE_HEADER) ?? '';
      const server = new McpServer({ name: 'teste', version: '0.0.0' });
      server.registerTool('quem_sou', { title: 'Quem sou' }, () => ({
        content: [{ type: 'text' as const, text: papelDaRequisicao.getStore() || doInitialize }],
      }));
      return server;
    },
  });
}

const postMcp = (base: string, corpo: unknown, papel: string, sessionId?: string) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [IDENTITY_HEADER]: 'chave-da-maria',
      [ROLE_HEADER]: papel,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(corpo),
  });

/** A resposta de um POST /mcp chega como um evento SSE com um `data:`. */
async function respostaJsonRpc(res: Response): Promise<{ result?: { content?: { text: string }[] } }> {
  const corpo = await res.text();
  const linha = corpo.split('\n').find((texto) => texto.startsWith('data:'));
  if (!linha) throw new Error(`resposta sem evento data: ${corpo}`);
  return JSON.parse(linha.slice('data:'.length));
}

/**
 * O teto de sessões tem duas dimensões. A **global** é o orçamento de memória
 * do processo, somando os dois transportes. A **por credencial** existe porque
 * uma chave só — ou o `token-global`, que é a mesma identidade para todo mundo
 * que usa `MCP_ADMIN_TOKEN` — trancava as demais ao abrir sessão e ir embora. E
 * ela não recusa: recicla a sessão mais parada da própria credencial, porque
 * cliente MCP reconecta o tempo todo e a abandonada é sempre a mais parada.
 */
describe('teto de sessões', () => {
  it('recicla a sessão mais parada da própria credencial, sem tocar na de outra', async () => {
    const base = await startApp({ maxSessionsPerIdentity: 2 });
    const primeiraDaMaria = await openSseSession(base, 'chave-da-maria');
    const segundaDaMaria = await openSseSession(base, 'chave-da-maria');
    const doJoao = await openSseSession(base, 'chave-do-joao');

    // A terceira da maria estoura o teto dela: a mais parada é a primeira.
    const terceiraDaMaria = await openSseSession(base, 'chave-da-maria');

    expect((await postMessage(base, primeiraDaMaria, 'chave-da-maria')).status).toBe(404);
    expect((await postMessage(base, segundaDaMaria, 'chave-da-maria')).status).toBe(202);
    expect((await postMessage(base, terceiraDaMaria, 'chave-da-maria')).status).toBe(202);
    // O joao não paga pelo excesso da maria — é o ponto do teto por credencial.
    expect((await postMessage(base, doJoao, 'chave-do-joao')).status).toBe(202);
  });

  it('a varredura fecha a sessão SSE parada e poupa a que segue em uso', async () => {
    const base = await startApp({ sessionTtlMs: 100, sessionSweepMs: 20 });
    const parada = await openSseSession(base, 'chave-da-maria');
    const emUso = await openSseSession(base, 'chave-do-joao');

    // Uma continua conversando enquanto o TTL vence a outra.
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await postMessage(base, emUso, 'chave-do-joao');
    }

    expect((await postMessage(base, parada, 'chave-da-maria')).status).toBe(404);
    expect((await postMessage(base, emUso, 'chave-do-joao')).status).toBe(202);
  });

  it('o teto global soma os dois transportes e recusa dizendo o que fazer', async () => {
    const base = await startApp({ maxSessions: 1 });
    await openSseSession(base, 'chave-da-maria');

    // A única vaga está com o SSE: antes, cada transporte tinha um pool seu.
    const res = await postMcp(
      base,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '0.0.0' } },
      },
      'admin',
    );

    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(await res.json()).toMatchObject({ error: { message: expect.stringMatching(/mcp\/stateless/) } });
  });
});

describe('papel que muda no meio da sessão', () => {
  it('a tool lê a credencial da requisição, não a do initialize', async () => {
    const criados = { total: 0 };
    const base = await startAppComPapel(criados);

    const inicio = await postMcp(
      base,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '0.0.0' } },
      },
      'admin',
    );
    const sessionId = inicio.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await inicio.text();

    // Mesma sessão, mesma chave, papel rebaixado entre as duas chamadas.
    const chamada = await postMcp(
      base,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quem_sou', arguments: {} } },
      'membro',
      sessionId!,
    );
    const resposta = await respostaJsonRpc(chamada);

    expect(resposta.result?.content?.[0]?.text).toBe('membro');
    // O servidor não foi reconstruído: é a sessão do initialize que respondeu.
    expect(criados.total).toBe(1);
  });
});

/**
 * O gêmeo `apps/mcp-public/src/http.ts` ganhou a trava de sniffing e esta cópia
 * tinha ficado sem ela. Só JSON sai daqui, mas o cabeçalho é o que impede um
 * navegador de resolver interpretar uma dessas respostas como outra coisa.
 */
describe('cabeçalhos de segurança', () => {
  it('manda nosniff em toda resposta, inclusive na raiz e no /healthz', async () => {
    const base = await startApp();

    for (const rota of ['/', '/healthz']) {
      const res = await fetch(`${base}${rota}`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });
});
