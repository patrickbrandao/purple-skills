import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import express, { Router, type Express } from 'express';
import cors from 'cors';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { healthCheck } from '@purple-skills/db';
import { readIntEnv, trustProxySetting } from '@purple-skills/shared';

/**
 * Um ponto de montagem dos transportes MCP.
 *
 * O servidor público tem dois: o **principal**, na raiz (`/mcp`, `/sse`…), e o
 * dos **MCPs virtuais**, sob `/virtual/:slug` (`docs/08-mcp-virtual.md` §4).
 * Os dois compartilham o mesmo app, o mesmo mapa de sessões e o mesmo teto —
 * um processo, um orçamento de memória — e o que impede uma sessão aberta num
 * deles de responder no outro é a identidade (`identityOf`), que embute o
 * MCP virtual e a chave que a abriram.
 */
export type McpMount = {
  /** Prefixo Express — `''` para a raiz, `'/virtual/:slug'` para os virtuais. */
  basePath: string;
  /** Autenticação aplicada a todas as rotas do ponto de montagem. */
  auth: RequestHandler;
  /**
   * Fábrica do servidor MCP — chamada uma vez por sessão/requisição, já com a
   * requisição autenticada, para que o servidor conheça o escopo em que está.
   */
  createServer: (req: Request) => McpServer;
  /**
   * Identidade estável da credencial.
   *
   * Uma sessão MCP guarda o servidor criado no `initialize`, com o escopo
   * daquele momento. Sem esta amarração, quem descobrisse um `mcp-session-id`
   * (ou o `sessionId` do SSE) alheio continuaria falando por ele — inclusive
   * num MCP virtual cuja chave nunca teve. Vale para os dois transportes com
   * sessão: Streamable HTTP e SSE legado.
   */
  identityOf: (req: Request) => string | undefined;
  /**
   * Rotas próprias do ponto de montagem, registradas **depois** de `auth` e
   * antes dos transportes — os downloads do MCP virtual entram por aqui.
   */
  routes?: (router: Router) => void;
};

export type McpHttpOptions = {
  mounts: McpMount[];
  /**
   * Tamanho máximo do corpo JSON aceito nas rotas POST.
   *
   * O parser roda **depois** de `auth`, para que um cliente sem credencial não
   * consiga fazer o processo bufferizar e desserializar megabytes. O teto é por
   * serviço: o MCP público troca argumentos de poucos bytes, enquanto o admin
   * recebe o `.zip` em base64 do `set_files_bulk`.
   */
  jsonLimit: string;
  /** Metadados fixos expostos em `GET /`. */
  info: {
    name: string;
    version: string;
    description: string;
  };
  /**
   * Metadados **por requisição** de `GET /`, mesclados aos fixos: é por aqui
   * que a raiz anuncia qual vMCP responde nela — ou por que nenhum. Uma falha
   * aqui devolve só os fixos.
   */
  describe?: () => Promise<Record<string, unknown>>;
  /** CORS aberto (MCP público) ou restrito (MCP admin). */
  openCors: boolean;
};

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  error: { code, message },
  id: null,
});

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

/**
 * O SSE legado precisa da mesma amarração do Streamable HTTP: o `sessionId`
 * viaja na query string do `POST /messages`, então validar só o Bearer deixaria
 * qualquer credencial válida falar por uma sessão alheia.
 */
type TrackedSse = {
  transport: SSEServerTransport;
  identity?: string;
};

/** Os transportes do MCP: `/mcp` (Streamable HTTP), `/mcp/stateless`, `/sse` + `/messages`. */
export const TRANSPORTS = {
  streamableHttp: '/mcp',
  streamableHttpStateless: '/mcp/stateless',
  sse: { stream: '/sse', messages: '/messages' },
};

/**
 * Monta o app Express com as três formas de transporte do MCP em cada ponto
 * de montagem:
 *
 * - `POST/GET/DELETE <base>/mcp` — Streamable HTTP **com sessão** (`mcp-session-id`);
 * - `POST <base>/mcp/stateless`  — Streamable HTTP **stateless** (um servidor por request);
 * - `GET <base>/sse` + `POST <base>/messages` — transporte SSE legado.
 */
export function createHttpApp(options: McpHttpOptions): Express {
  const app = express();
  const streamableSessions = new Map<string, TrackedStreamable>();
  const sseSessions = new Map<string, TrackedSse>();

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
  // Registrado por rota, sempre DEPOIS de `auth`: ler o corpo antes de saber
  // quem está chamando entrega memória de graça a qualquer anônimo.
  const json = express.json({ limit: options.jsonLimit });

  app.get('/healthz', (_req, res) => {
    healthCheck()
      .then((ok) => res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded' }))
      .catch(() => res.status(503).json({ status: 'degraded' }));
  });

  app.get('/', (_req, res) => {
    const fixed = { ...options.info, transports: TRANSPORTS };
    if (!options.describe) {
      res.json(fixed);
      return;
    }
    options
      .describe()
      .then((extra) => res.json({ ...fixed, ...extra }))
      .catch(() => res.json(fixed));
  });

  for (const mount of options.mounts) {
    // `mergeParams`: o `:slug` do prefixo precisa chegar às rotas de dentro.
    const router = Router({ mergeParams: true });
    const identity = mount.identityOf;

    mount.routes?.(router);

    // ----------------------------------------- Streamable HTTP com sessão ---

    router.post('/mcp', mount.auth, json, async (req, res) => {
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

        const server = mount.createServer(req);
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

    router.get('/mcp', mount.auth, streamableSession);
    router.delete('/mcp', mount.auth, streamableSession);

    // ---------------------------------------------- Streamable HTTP stateless ---

    router.post('/mcp/stateless', mount.auth, json, async (req, res) => {
      const server = mount.createServer(req);
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

    // -------------------------------------------------------- SSE legado ---

    router.get('/sse', mount.auth, async (req, res) => {
      if (sseSessions.size >= MAX_SESSIONS) {
        res.status(503).json(jsonRpcError(-32000, 'Limite de sessões atingido, tente mais tarde'));
        return;
      }

      // O endpoint anunciado ao cliente é relativo ao ponto de montagem: num
      // virtual, `/virtual/<slug>/messages`. `req.baseUrl` já é o prefixo
      // resolvido — com o slug real, não com `:slug`.
      const transport = new SSEServerTransport(`${req.baseUrl}${TRANSPORTS.sse.messages}`, res);
      sseSessions.set(transport.sessionId, { transport, identity: identity(req) });

      transport.onclose = () => {
        sseSessions.delete(transport.sessionId);
      };
      res.on('close', () => {
        sseSessions.delete(transport.sessionId);
      });

      const server = mount.createServer(req);
      await server.connect(transport);
    });

    router.post('/messages', mount.auth, json, async (req, res) => {
      const sessionId = String(req.query.sessionId ?? '');
      const tracked = sseSessions.get(sessionId);

      if (!tracked) {
        res.status(404).json(jsonRpcError(-32001, 'Sessão SSE desconhecida ou expirada'));
        return;
      }
      if (tracked.identity !== identity(req)) {
        res.status(403).json(jsonRpcError(-32001, 'Sessão pertence a outra credencial'));
        return;
      }

      await tracked.transport.handlePostMessage(req, res, req.body);
    });

    if (mount.basePath) app.use(mount.basePath, router);
    else app.use(router);
  }

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
      ...[...sseSessions.values()].map((tracked) => tracked.transport.close()),
    ]);
    streamableSessions.clear();
    sseSessions.clear();
  };

  return app;
}

export type McpApp = Express & { closeSessions: () => Promise<void> };
