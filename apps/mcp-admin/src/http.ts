import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
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
   * Uma sessão MCP guarda o servidor criado no `initialize`, com o papel e o
   * ator daquele momento. Sem esta amarração, quem descobrisse um
   * `mcp-session-id` (ou o `sessionId` do SSE) alheio continuaria falando por
   * ele — inclusive com um papel maior que o da própria chave. Vale para os
   * dois transportes com sessão: Streamable HTTP e SSE legado.
   */
  identityOf?: (req: Request) => string | undefined;
  /** Middleware de autenticação aplicado às rotas MCP. */
  auth: RequestHandler;
  /**
   * Envolve o despacho da requisição no contexto dela.
   *
   * O servidor de uma sessão é criado só no `initialize`; sem isto as tools
   * leriam para sempre a credencial daquele momento, e não a que `auth`
   * acabou de revalidar — ver `comCaller` em `auth.ts`. Ausente, despacha
   * direto.
   */
  withRequest?: (req: Request, run: () => Promise<void>) => Promise<void>;
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
  /**
   * Capacidade de sessões: os dois tetos (do processo e **por credencial**) e
   * os dois prazos da faxina.
   *
   * Ausentes — e é assim em produção — valem `MCP_MAX_SESSIONS`,
   * `MCP_MAX_SESSIONS_PER_IDENTITY`, `MCP_SESSION_TTL_MS` e
   * `MCP_SESSION_SWEEP_MS`. Estão aqui porque as variáveis são lidas uma vez,
   * na carga do módulo: sem injeção, um teste de expiração precisaria mexer no
   * ambiente antes do `import` e contaminaria os outros testes do arquivo.
   */
  maxSessions?: number;
  maxSessionsPerIdentity?: number;
  sessionTtlMs?: number;
  sessionSweepMs?: number;
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
/**
 * Teto **por credencial**, além do global.
 *
 * Sem ele o teto global é um recurso comum: aqui todo acesso exige Bearer, mas
 * uma chave só — ou o `token-global`, que é a mesma identidade para todo mundo
 * que usa `MCP_ADMIN_TOKEN` — ainda tranca as demais ao abrir sessão e ir
 * embora. O padrão é um décimo do teto global (nunca menos de 10), para os dois
 * números subirem juntos quando o operador levanta `MCP_MAX_SESSIONS`.
 */
const MAX_SESSIONS_PER_IDENTITY = readIntEnv(
  'MCP_MAX_SESSIONS_PER_IDENTITY',
  Math.max(10, Math.floor(MAX_SESSIONS / 10)),
);
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
 * qualquer credencial válida falar por uma sessão alheia — inclusive com papel
 * maior que o da própria chave.
 */
type TrackedSse = {
  transport: SSEServerTransport;
  identity?: string;
  /**
   * Atividade do cliente, renovada a cada `POST /messages`. Sem este campo a
   * varredura não tinha o que comparar — e o SSE, de fato, não era varrido: a
   * vaga só saía do mapa quando o socket caía, então um stream aberto e parado
   * a ocupava até o processo reiniciar.
   */
  lastSeen: number;
};

/** Os dois transportes com sessão; o stateless não ocupa vaga. */
type StatefulTransport = 'streamable' | 'sse';

export function createHttpApp(options: McpHttpOptions): Express {
  const app = express();
  const identity = (req: Request): string | undefined => options.identityOf?.(req);
  const dispatch = options.withRequest ?? ((_req: Request, run: () => Promise<void>) => run());
  const streamableSessions = new Map<string, TrackedStreamable>();
  const sseSessions = new Map<string, TrackedSse>();
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const maxPerIdentity = options.maxSessionsPerIdentity ?? MAX_SESSIONS_PER_IDENTITY;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const sweepMs = options.sessionSweepMs ?? SESSION_SWEEP_MS;

  /** Sessões vivas do processo: o teto global é um orçamento de memória só. */
  const liveSessions = () => streamableSessions.size + sseSessions.size;

  /** Tira a sessão do mapa e fecha o transporte. */
  const drop = (transport: StatefulTransport, id: string): void => {
    const tracked = transport === 'streamable' ? streamableSessions.get(id) : sseSessions.get(id);
    if (!tracked) return;
    if (transport === 'streamable') streamableSessions.delete(id);
    else sseSessions.delete(id);
    void tracked.transport.close().catch(() => undefined);
  };

  // Sob abuso a reciclagem acontece a cada requisição: o aviso sai no máximo
  // uma vez por varredura, senão o log vira o próximo problema de capacidade.
  let lastLimitWarn = 0;
  const warnLimit = (message: string): void => {
    const now = Date.now();
    if (now - lastLimitWarn < sweepMs) return;
    lastLimitWarn = now;
    console.warn(`[mcp] ${message}`);
  };

  /**
   * Fecha o que passou do TTL sem atividade, nos **dois** transportes com
   * sessão. Roda no timer e também antes de recusar por teto: liberar vaga
   * parada é sempre melhor que recusar sessão nova.
   */
  const expireIdle = (): void => {
    const now = Date.now();
    for (const [id, tracked] of streamableSessions) {
      if (now - tracked.lastSeen > sessionTtlMs) drop('streamable', id);
    }
    for (const [id, tracked] of sseSessions) {
      if (now - tracked.lastSeen > sessionTtlMs) drop('sse', id);
    }
  };

  // Varredura periódica: fecha o que passou do TTL sem atividade.
  const sweep = setInterval(expireIdle, sweepMs);
  // Não segura o event loop no shutdown.
  sweep.unref?.();

  /**
   * Aplica o teto por credencial, chamado **depois** de a sessão nova entrar no
   * mapa (é ali que ela passa a existir; um POST que não é `initialize` não
   * abre sessão e não pode custar a vaga de ninguém).
   *
   * Não recusa: fecha as sessões **da própria credencial** paradas há mais
   * tempo, poupando a que acabou de abrir. Cliente MCP abre e fecha sessão com
   * frequência — o Claude Desktop reabre a cada janela — e a sessão abandonada
   * é justamente a mais parada; recusar o `initialize` derrubaria o cliente
   * legítimo no momento em que ele reconecta. Assim o prejuízo fica dentro da
   * credencial que estourou o teto, que é o ponto de o teto ser por credencial.
   */
  const enforcePerIdentity = (id: string | undefined, keep: { transport: StatefulTransport; id: string }): void => {
    const own: { transport: StatefulTransport; id: string; lastSeen: number }[] = [];
    for (const [sessionId, tracked] of streamableSessions) {
      if (tracked.identity === id && !(keep.transport === 'streamable' && keep.id === sessionId)) {
        own.push({ transport: 'streamable', id: sessionId, lastSeen: tracked.lastSeen });
      }
    }
    for (const [sessionId, tracked] of sseSessions) {
      if (tracked.identity === id && !(keep.transport === 'sse' && keep.id === sessionId)) {
        own.push({ transport: 'sse', id: sessionId, lastSeen: tracked.lastSeen });
      }
    }
    // `own` já exclui a sessão nova: com menos que o teto, ela cabe.
    if (own.length < maxPerIdentity) return;

    own.sort((a, b) => a.lastSeen - b.lastSeen);
    // Uma vaga para a que entrou — mais de uma se o teto foi baixado a quente.
    for (const stale of own.slice(0, own.length - maxPerIdentity + 1)) drop(stale.transport, stale.id);
    warnLimit(
      `teto de ${maxPerIdentity} sessões por credencial atingido (${id ?? 'sem identidade'}): ` +
        'reciclada a sessão parada há mais tempo',
    );
  };

  /**
   * Teto global — o orçamento de memória do processo, somando os dois
   * transportes com sessão. Devolve `true` quando recusou.
   *
   * A faxina roda antes da recusa, e a recusa sai com `Retry-After` e aponta o
   * transporte sem sessão: um 503 seco não diz ao cliente o que fazer.
   */
  const rejectWhenFull = (res: Response): boolean => {
    if (liveSessions() < maxSessions) return false;
    expireIdle();
    if (liveSessions() < maxSessions) return false;

    const retryS = Math.ceil(sweepMs / 1000);
    warnLimit(`teto global de ${maxSessions} sessões atingido: sessão nova recusada`);
    res.setHeader('Retry-After', String(retryS));
    res.status(503).json(
      jsonRpcError(
        -32000,
        `Limite de ${maxSessions} sessões simultâneas do servidor atingido. Tente de novo em ` +
          `${retryS} s, ou use o transporte sem sessão (POST /mcp/stateless), que não ocupa vaga.`,
      ),
    );
    return true;
  };

  app.disable('x-powered-by');
  app.set('trust proxy', trustProxySetting());

  app.use(
    cors({
      origin: options.openCors ? '*' : false,
      // `Retry-After` vem na recusa por teto: sem expor, um cliente de browser
      // lê a mensagem mas não o prazo.
      exposedHeaders: ['Mcp-Session-Id', 'mcp-session-id', 'Retry-After'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'mcp-protocol-version'],
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }),
  );
  // Só JSON sai daqui, nunca documento: o que falta é a trava de sniffing, para
  // nenhum navegador que abra uma dessas respostas resolver interpretá-la como
  // outra coisa. A CSP de documento não cabe num servidor MCP. O gêmeo
  // `apps/mcp-public/src/http.ts` tem o mesmo bloco — os dois andam juntos.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

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
        await dispatch(req, () => existing.transport.handleRequest(req, res, req.body));
        return;
      }

      if (sessionId) {
        res.status(404).json(jsonRpcError(-32001, 'Sessão desconhecida ou expirada'));
        return;
      }

      if (rejectWhenFull(res)) return;

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          streamableSessions.set(id, { transport, lastSeen: Date.now(), identity: identity(req) });
          enforcePerIdentity(identity(req), { transport: 'streamable', id });
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
      await dispatch(req, () => transport.handleRequest(req, res, req.body));
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
    await dispatch(req, () => tracked.transport.handleRequest(req, res));
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
      await dispatch(req, () => transport.handleRequest(req, res, req.body));
    } catch (err) {
      console.error('[mcp] erro no POST /mcp/stateless:', err);
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Erro interno do servidor'));
    }
  });

  // ---------------------------------------------------------- SSE legado ---

  app.get('/sse', options.auth, async (req, res) => {
    if (rejectWhenFull(res)) return;

    const transport = new SSEServerTransport('/messages', res);
    sseSessions.set(transport.sessionId, { transport, identity: identity(req), lastSeen: Date.now() });
    enforcePerIdentity(identity(req), { transport: 'sse', id: transport.sessionId });

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
    const tracked = sseSessions.get(sessionId);

    if (!tracked) {
      res.status(404).json(jsonRpcError(-32001, 'Sessão SSE desconhecida ou expirada'));
      return;
    }
    if (tracked.identity !== identity(req)) {
      res.status(403).json(jsonRpcError(-32001, 'Sessão pertence a outra credencial'));
      return;
    }

    // Renova a atividade: sem isto a varredura fecharia sessão SSE em uso.
    tracked.lastSeen = Date.now();
    await dispatch(req, () => tracked.transport.handlePostMessage(req, res, req.body));
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
      ...[...sseSessions.values()].map((tracked) => tracked.transport.close()),
    ]);
    streamableSessions.clear();
    sseSessions.clear();
  };

  return app;
}

export type McpApp = Express & { closeSessions: () => Promise<void> };
