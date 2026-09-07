import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@purple-skills/db', () => ({ healthCheck: vi.fn(async () => true) }));

const { createHttpApp } = await import('./http.js');

/**
 * O transporte SSE identifica a sessão por `?sessionId=` na query string — um
 * valor que viaja fora do canal autenticado. Estes testes cobrem o vínculo
 * entre a sessão e a credencial que a abriu.
 */

/** Identidade vem de um header simples: o teste não precisa do banco de chaves. */
const IDENTITY_HEADER = 'x-identidade';

let running: Server | undefined;
const abortControllers: AbortController[] = [];

function startApp() {
  const app = createHttpApp({
    createServer: () => new McpServer({ name: 'teste', version: '0.0.0' }),
    auth: (_req, _res, next) => next(),
    identityOf: (req) => req.header(IDENTITY_HEADER),
    jsonLimit: '1mb',
    openCors: false,
    info: { name: 'teste', version: '0.0.0', description: 'teste', requiresAuth: true },
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
    expect(await res.json()).toMatchObject({ error: { message: /outra credencial/i } });
  });

  it('responde 404 para sessão inexistente, sem revelar identidade', async () => {
    const base = await startApp();

    const res = await postMessage(base, 'sessao-que-nao-existe', 'chave-da-maria');

    expect(res.status).toBe(404);
  });
});
