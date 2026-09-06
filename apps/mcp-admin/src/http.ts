import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import express, { type Express } from 'express';
import cors from 'cors';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { healthCheck } from '@purple-skills/db';
import { readIntEnv, trustProxySetting } from '@purple-skills/shared';

export type McpHttpOptions = {
  /**
   * Fábrica do servidor MCP — chamada uma vez por sessão/requisição, já com a
   * requisição autenticada, para que o servidor conheça quem está chamando.
   */
  createServer: (req: Request) => McpServer;
  /**
   * Identidade estável da credencial, quando o serviço tem mais de uma.
   *
   * Uma sessão Streamable HTTP guarda o servidor criado no `initialize`, com o
   * papel e o ator daquele momento. Sem esta amarração, quem descobrisse um
   * `mcp-session-id` alheio continuaria falando por ele — inclusive com um
   * papel maior que o da própria chave.
   */
  identityOf?: (req: Request) => string | undefined;
  /** Middleware de autenticação aplicado às rotas MCP. */
  auth: RequestHandler;
  /**
   * Tamanho máximo do corpo JSON aceito nas rotas POST.
   *
   * O parser roda **depois** de `auth`, para que um cliente sem credencial não
   * consiga fazer o processo bufferizar e desserializar megabytes. O teto é por
   * serviço: o MCP público troca argumentos de poucos bytes, enquanto o admin
   * recebe o `.zip` em base64 do `set_files_bulk`.
   */
  jsonLimit: string;
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
/**
 * Sessões vivem em memória e só saíam do mapa quando o cliente fechava a
 * conexão corretamente. Um cliente que inicializa e some deixava a entrada
 * para sempre — no MCP público, que roda sem autenticação por padrão, isso é
 * exaustão de memória trivial de provocar. Daí o TTL e o teto abaixo.
 */
const MAX_SESSIONS = readIntEnv('MCP_MAX_SESSIONS', 500);
const SESSION_TTL_MS = readIntEnv('MCP_SESSION_TTL_MS', 30 * 60_000, { min: 1000 });
const SESSION_SWEEP_MS = readIntEnv('MCP_SESSION_SWEEP_MS', 60_000, { min: 1000 });

type TrackedStreamable = {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  identity?: string;
};

export function createHttpApp(options: McpHttpOptions): Express {
  const app = express();
  const identity = (req: Request): string | undefined => options.identityOf?.(req);
  const streamableSessions = new Map<string, TrackedStreamable>();
  const sseSessions = new Map<string, SSEServerTransport>();

  // Varredura periódica: fecha o que passou do TTL sem atividade.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, tracked] of streamableSessions) {
      if (now - tracked.lastSeen > SESSION_TTL_MS) {
        streamableSessions.delete(id);
        void tracked.transport.close().catch(() => undefined);
      }
    }
  }, SESSION_SWEEP_MS);
  // Não segura o event loop no shutdown.
  sweep.unref?.();

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxySetting());

  app.use(
    cors({
      origin: options.openCors ? '*' : false,
      exposedHeaders: ['Mcp-Session-Id', 'mcp-session-id'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'mcp-protocol-version'],
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }),
  );
  // Registrado por rota, sempre DEPOIS de `options.auth`: ler o corpo antes de
  // saber quem está chamando entrega memória de graça a qualquer anônimo.
  const json = express.json({ limit: options.jsonLimit });

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

  app.post('/mcp', options.auth, json, async (req, res) => {
    try {
      const sessionId = req.header('mcp-session-id');
      const existing = sessionId ? streamableSessions.get(sessionId) : undefined;

      if (existing) {
        if (existing.identity !== identity(req)) {
          res.status(403).json(jsonRpcError(-32001, 'Sessão pertence a outra credencial'));
          return;
        }
        existing.lastSeen = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId) {
        res.status(404).json(jsonRpcError(-32001, 'Sessão desconhecida ou expirada'));
        return;
      }

      if (streamableSessions.size >= MAX_SESSIONS) {
        res.status(503).json(jsonRpcError(-32000, 'Limite de sessões atingido, tente mais tarde'));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          streamableSessions.set(id, { transport, lastSeen: Date.now(), identity: identity(req) });
        },
        onsessionclosed: (id) => {
          streamableSessions.delete(id);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) streamableSessions.delete(transport.sessionId);
      };

      const server = options.createServer(req);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] erro no POST /mcp:', err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Erro interno do servidor'));
    }
  });

  const streamableSession: RequestHandler = async (req, res) => {
    const sessionId = req.header('mcp-session-id');
    const tracked = sessionId ? streamableSessions.get(sessionId) : undefined;

    if (!tracked) {
      res.status(404).json(jsonRpcError(-32001, 'Sessão desconhecida ou expirada'));
      return;
    }
    if (tracked.identity !== identity(req)) {
      res.status(403).json(jsonRpcError(-32001, 'Sessão pertence a outra credencial'));
      return;
    }

    tracked.lastSeen = Date.now();
    await tracked.transport.handleRequest(req, res);
  };

  app.get('/mcp', options.auth, streamableSession);
  app.delete('/mcp', options.auth, streamableSession);

  // ------------------------------------------------ Streamable HTTP stateless ---

  app.post('/mcp/stateless', options.auth, json, async (req, res) => {
    const server = options.createServer(req);
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

  app.get('/sse', options.auth, async (req, res) => {
    if (sseSessions.size >= MAX_SESSIONS) {
      res.status(503).json(jsonRpcError(-32000, 'Limite de sessões atingido, tente mais tarde'));
      return;
    }

    const transport = new SSEServerTransport('/messages', res);
    sseSessions.set(transport.sessionId, transport);

    transport.onclose = () => {
      sseSessions.delete(transport.sessionId);
    };
    res.on('close', () => {
      sseSessions.delete(transport.sessionId);
    });

    const server = options.createServer(req);
    await server.connect(transport);
  });

  app.post('/messages', options.auth, json, async (req, res) => {
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

  // Sem este handler, um corpo malformado ou grande demais sai como HTML pelo
  // tratamento padrão do Express — e o cliente MCP espera JSON-RPC.
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (res.headersSent) return;

    const status = Number((err as { status?: number })?.status);
    const type = (err as { type?: string })?.type;

    if (type === 'entity.parse.failed') {
      res.status(400).json(jsonRpcError(-32700, 'Corpo JSON malformado'));
      return;
    }
    if (type === 'entity.too.large') {
      res.status(413).json(jsonRpcError(-32600, `Corpo maior que o limite de ${options.jsonLimit}`));
      return;
    }
    if (status >= 400 && status < 500) {
      res.status(status).json(jsonRpcError(-32600, 'Requisição inválida'));
      return;
    }

    console.error('[mcp] erro não tratado:', err);
    res.status(500).json(jsonRpcError(-32603, 'Erro interno do servidor'));
  };
  app.use(onError);

  /** Fecha todas as sessões abertas — usado no shutdown gracioso. */
  (app as Express & { closeSessions: () => Promise<void> }).closeSessions = async () => {
    clearInterval(sweep);
    await Promise.allSettled([
      ...[...streamableSessions.values()].map((tracked) => tracked.transport.close()),
      ...[...sseSessions.values()].map((transport) => transport.close()),
    ]);
    streamableSessions.clear();
    sseSessions.clear();
  };

  return app;
}

export type McpApp = Express & { closeSessions: () => Promise<void> };
