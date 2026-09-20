import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Request } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@purple-skills/db', () => ({
  healthCheck: vi.fn(async () => true),
  recordSkillAccess: vi.fn(async () => undefined),
}));

const { recordSkillAccess } = await import('@purple-skills/db');
const { accessContextOf, comOrigem, registrarAcesso } = await import('./access.js');
const { createHttpApp } = await import('./http.js');

/**
 * `skill_accesses` é uma linha **por leitura**, com coluna própria de IP e de
 * agente. Numa sessão o servidor MCP é construído uma vez, e o escopo dele é a
 * foto de quem a abriu: estes testes conferem que a linha leva a origem da
 * requisição que leu — o mesmo que o mcp-admin já faz com o `comCaller`.
 */

const gravados = vi.mocked(recordSkillAccess);

/** Quem abre a sessão e quem lê: endereços de documentação (RFC 5737). */
const ABRIU = { ip: '203.0.113.10', agente: 'cliente-que-abriu/1.0' };
const LEU = { ip: '198.51.100.20', agente: 'cliente-que-leu/2.0' };

function requisicao(origem: { ip?: string; agente?: string }): Request {
  const headers: Record<string, string | undefined> = { 'user-agent': origem.agente };
  return { ip: origem.ip, get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

beforeEach(() => {
  gravados.mockClear();
});

describe('registrarAcesso', () => {
  it('dentro de `comOrigem` grava a origem da requisição em curso, não a do escopo', async () => {
    const scope = { mcp: { uuid: 'u-1' }, access: accessContextOf(requisicao(ABRIU)) };

    await comOrigem(requisicao(LEU), async () => registrarAcesso(scope, 'skill-1', 'view', 'tool'));
    await vi.waitFor(() => expect(gravados).toHaveBeenCalledTimes(1));

    expect(gravados.mock.calls[0]![0]).toMatchObject({ ip: LEU.ip, userAgent: LEU.agente, auth: 'open' });
  });

  it('fora de uma requisição vale a origem do escopo, como antes', async () => {
    const scope = { mcp: { uuid: 'u-1' }, access: accessContextOf(requisicao(ABRIU)) };

    registrarAcesso(scope, 'skill-1', 'view', 'tool');
    await vi.waitFor(() => expect(gravados).toHaveBeenCalledTimes(1));

    expect(gravados.mock.calls[0]![0]).toMatchObject({ ip: ABRIU.ip, userAgent: ABRIU.agente });
  });

  it('requisição sem agente não herda o de quem abriu a sessão', async () => {
    const scope = { mcp: { uuid: 'u-1' }, access: accessContextOf(requisicao(ABRIU)) };

    await comOrigem(requisicao({ ip: LEU.ip }), async () => registrarAcesso(scope, 'skill-1', 'view', 'tool'));
    await vi.waitFor(() => expect(gravados).toHaveBeenCalledTimes(1));

    const input = gravados.mock.calls[0]![0];
    expect(input.ip).toBe(LEU.ip);
    expect(input.userAgent).toBeUndefined();
  });
});

// ------------------------------------------------------ pelos transportes ---

let running: Server | undefined;
const abortControllers: AbortController[] = [];

afterEach(() => {
  for (const controller of abortControllers.splice(0)) controller.abort();
  running?.close();
  running = undefined;
});

/**
 * O app de verdade, com o `comOrigem` de verdade; a tool `ler` registra o
 * acesso depois de um `await`, como o `get_skill` faz depois de consultar o
 * banco. O escopo é montado na fábrica — ou seja, no `initialize`.
 */
function startApp(criados: { total: number }) {
  const app = createHttpApp({
    withRequest: comOrigem,
    mounts: [
      {
        basePath: '',
        auth: (_req, _res, next) => next(),
        createServer: (req) => {
          criados.total += 1;
          const scope = { mcp: { uuid: 'u-1' }, access: accessContextOf(req) };
          const server = new McpServer({ name: 'teste', version: '0.0.0' });
          server.registerTool('ler', { title: 'Ler' }, async () => {
            await new Promise((resolve) => setImmediate(resolve));
            registrarAcesso(scope, 'skill-1', 'view', 'tool');
            return { content: [{ type: 'text' as const, text: 'ok' }] };
          });
          return server;
        },
        identityOf: () => 'virtual:u-1:open',
      },
    ],
    jsonLimit: '1mb',
    openCors: true,
    info: { name: 'teste', version: '0.0.0', description: 'teste' },
  });

  return new Promise<string>((resolve) => {
    running = app.listen(0, '127.0.0.1', () => {
      const { port } = running!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * O teste fala com o app por loopback, que o `trust proxy` padrão aceita como
 * proxy: o `X-Forwarded-For` vira o `req.ip`, como atrás do Traefik.
 */
const cabecalhos = (origem: { ip: string; agente: string }, extras: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'x-forwarded-for': origem.ip,
  'user-agent': origem.agente,
  ...extras,
});

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teste', version: '1' } },
};
const LER = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ler', arguments: {} } };

describe('a origem gravada é a da requisição que leu', () => {
  it('Streamable HTTP: sessão aberta de um endereço e lida de outro', async () => {
    const criados = { total: 0 };
    const base = await startApp(criados);

    const inicio = await fetch(`${base}/mcp`, { method: 'POST', headers: cabecalhos(ABRIU), body: JSON.stringify(INITIALIZE) });
    const sessionId = inicio.headers.get('mcp-session-id')!;
    expect(sessionId).toBeTruthy();
    await inicio.text();

    const leitura = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: cabecalhos(LEU, { 'mcp-session-id': sessionId }),
      body: JSON.stringify(LER),
    });
    expect(leitura.status).toBe(200);
    await leitura.text();

    await vi.waitFor(() => expect(gravados).toHaveBeenCalledTimes(1));
    expect(gravados.mock.calls[0]![0]).toMatchObject({ ip: LEU.ip, userAgent: LEU.agente });
    // O servidor não foi reconstruído: é o escopo do `initialize` que respondeu.
    expect(criados.total).toBe(1);
  });

  it('SSE legado: stream aberto de um endereço, mensagem postada de outro', async () => {
    const criados = { total: 0 };
    const base = await startApp(criados);
    const controller = new AbortController();
    abortControllers.push(controller);

    const stream = await fetch(`${base}/sse`, { headers: cabecalhos(ABRIU), signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('sessionId=')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('stream SSE encerrou sem anunciar o endpoint');
      buffer += decoder.decode(value, { stream: true });
    }
    const endpoint = /data: (\S+)/.exec(buffer)![1]!;

    const leitura = await fetch(`${base}${endpoint}`, { method: 'POST', headers: cabecalhos(LEU), body: JSON.stringify(LER) });
    expect(leitura.status).toBe(202);

    await vi.waitFor(() => expect(gravados).toHaveBeenCalledTimes(1));
    expect(gravados.mock.calls[0]![0]).toMatchObject({ ip: LEU.ip, userAgent: LEU.agente });
    expect(criados.total).toBe(1);
  });

  it('stateless segue gravando a origem da própria requisição', async () => {
    const base = await startApp({ total: 0 });

    const leitura = await fetch(`${base}/mcp/stateless`, { method: 'POST', headers: cabecalhos(LEU), body: JSON.stringify(LER) });
    expect(leitura.status).toBe(200);
    await leitura.text();

    await vi.waitFor(() => expect(gravados).toHaveBeenCalledTimes(1));
    expect(gravados.mock.calls[0]![0]).toMatchObject({ ip: LEU.ip, userAgent: LEU.agente });
  });
});
