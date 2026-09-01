import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import express, { type Express } from 'express';
import cors from 'cors';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { healthCheck } from '@purple-skills/db';

export type McpHttpOptions = {
  /** Fábrica do servidor MCP — chamada uma vez por sessão/requisição. */
  createServer: () => McpServer;
  /** Middleware de autenticação aplicado às rotas MCP. */
  auth: RequestHandler;
  /** Metadados expostos em `GET /`. */
  info: {
    name: string;
    version: string;
    description: string;
    /** `true` quando o servidor exige Bearer token. */
    requiresAuth: boolean;
  };
  /** CORS aberto (MCP público) ou restrito (MCP admin). */
  openCors: boolean;
};

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  error: { code, message },
  id: null,
});

/**
 * Monta o app Express com as três formas de transporte do MCP:
 *
 * - `POST/GET/DELETE /mcp` — Streamable HTTP **com sessão** (`mcp-session-id`);
 * - `POST /mcp/stateless`  — Streamable HTTP **stateless** (um servidor por request);
 * - `GET /sse` + `POST /messages` — transporte SSE legado.
 */
export function createHttpApp(options: McpHttpOptions): Express {
  const app = express();
  const streamableSessions = new Map<string, StreamableHTTPServerTransport>();
  const sseSessions = new Map<string, SSEServerTransport>();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(
    cors({
      origin: options.openCors ? '*' : false,
      exposedHeaders: ['Mcp-Session-Id', 'mcp-session-id'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'mcp-protocol-version'],
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }),
  );
  app.use(express.json({ limit: '64mb' }));

  app.get('/healthz', (_req, res) => {
    healthCheck()
      .then((ok) => res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded' }))
      .catch(() => res.status(503).json({ status: 'degraded' }));
  });

  app.get('/', (_req, res) => {
    res.json({
      ...options.info,
      transports: {
        streamableHttp: '/mcp',
        streamableHttpStateless: '/mcp/stateless',
        sse: { stream: '/sse', messages: '/messages' },
      },
    });
  });

  // ------------------------------------------- Streamable HTTP com sessão ---

  app.post('/mcp', options.auth, async (req, res) => {
    try {
      const sessionId = req.header('mcp-session-id');
      const existing = sessionId ? streamableSessions.get(sessionId) : undefined;

      if (existing) {
        await existing.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId) {
        res.status(404).json(jsonRpcError(-32001, 'Sessão desconhecida ou expirada'));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          streamableSessions.set(id, transport);
        },
        onsessionclosed: (id) => {
          streamableSessions.delete(id);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) streamableSessions.delete(transport.sessionId);
      };

      const server = options.createServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] erro no POST /mcp:', err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Erro interno do servidor'));
    }
  });

  const streamableSession: RequestHandler = async (req, res) => {
    const sessionId = req.header('mcp-session-id');
    const transport = sessionId ? streamableSessions.get(sessionId) : undefined;

    if (!transport) {
      res.status(404).json(jsonRpcError(-32001, 'Sessão desconhecida ou expirada'));
      return;
    }

    await transport.handleRequest(req, res);
  };

  app.get('/mcp', options.auth, streamableSession);
  app.delete('/mcp', options.auth, streamableSession);

  // ------------------------------------------------ Streamable HTTP stateless ---

  app.post('/mcp/stateless', options.auth, async (req, res) => {
    const server = options.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] erro no POST /mcp/stateless:', err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Erro interno do servidor'));
    }
  });

  // ---------------------------------------------------------- SSE legado ---

  app.get('/sse', options.auth, async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    sseSessions.set(transport.sessionId, transport);

    transport.onclose = () => {
      sseSessions.delete(transport.sessionId);
    };
    res.on('close', () => {
      sseSessions.delete(transport.sessionId);
    });

    const server = options.createServer();
    await server.connect(transport);
  });

  app.post('/messages', options.auth, async (req, res) => {
    const sessionId = String(req.query.sessionId ?? '');
    const transport = sseSessions.get(sessionId);

    if (!transport) {
      res.status(404).json(jsonRpcError(-32001, 'Sessão SSE desconhecida ou expirada'));
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  });

  app.use((req, res) => {
    res.status(404).json(jsonRpcError(-32601, `Rota não encontrada: ${req.path}`));
  });

  /** Fecha todas as sessões abertas — usado no shutdown gracioso. */
  (app as Express & { closeSessions: () => Promise<void> }).closeSessions = async () => {
    await Promise.allSettled([
      ...[...streamableSessions.values()].map((transport) => transport.close()),
      ...[...sseSessions.values()].map((transport) => transport.close()),
    ]);
    streamableSessions.clear();
    sseSessions.clear();
  };

  return app;
}

export type McpApp = Express & { closeSessions: () => Promise<void> };
