import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import express, { Router, type Express } from 'express';
import cors from 'cors';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { healthCheck } from '@purple-skills/db';
import { createRateLimiter, rateLimitKey, readIntEnv, trustProxySetting, type RateLimiter } from '@purple-skills/shared';
import type { SessionTracker, StatefulTransport } from './sessions.js';

/**
 * Um ponto de montagem dos transportes MCP.
 *
 * O servidor público tem dois: o **principal**, na raiz (`/mcp`, `/sse`…), e o
 * dos **MCPs virtuais**, sob `/virtual/:slug` (`docs/08-mcp-virtual.md` §4).
 * Os dois compartilham o mesmo app, o mesmo mapa de sessões e o mesmo teto
 * global — um processo, um orçamento de memória —, mas **não** o orçamento por
 * credencial: cada identidade tem o seu, senão o consumo de um vMCP aberto
 * negaria serviço a quem tem chave de um fechado. O que impede uma sessão
 * aberta num deles de responder no outro é a mesma identidade (`identityOf`),
 * que embute o MCP virtual e a chave que a abriram.
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
   * Envolve o despacho da requisição ao transporte no contexto dela.
   *
   * O servidor de uma sessão é criado só no `initialize` (ou no `GET /sse`);
   * sem isto o registro de acessos leria para sempre a origem — IP e agente —
   * daquele momento. Ver `comOrigem` em `access.ts`. Ausente, despacha direto.
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
  /**
   * Contabilidade de sessões (`sessions.ts`): avisada a cada abertura,
   * requisição e fechamento nos três transportes. Ausente = não rastreia.
   */
  sessions?: SessionTracker;
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
  /**
   * Limite de taxa por IP: teto por janela e tamanho da janela, em segundos.
   *
   * Ausentes valem `MCP_RATE_LIMIT_MAX` e 60 s. Injetáveis pelo mesmo motivo
   * dos tetos de sessão: a variável é lida uma vez, na carga do módulo.
   */
  rateLimitMax?: number;
  rateLimitWindowSeconds?: number;
  /** Teto de mensagens num lote JSON-RPC. Ausente vale `MCP_MAX_BATCH`. */
  maxBatch?: number;
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
/**
 * Teto **por credencial**, além do global.
 *
 * Sem ele o teto global é um recurso comum: num vMCP aberto todo anônimo tem a
 * mesma identidade (`virtual:<uuid>:open`), então quem abre sessão e vai embora
 * enche as vagas e nega o serviço a quem tem chave `psv_` de um vMCP fechado —
 * que não compartilha risco nenhum com a superfície aberta.
 *
 * O padrão é um décimo do teto global (nunca menos de 10), para os dois
 * números subirem juntos quando o operador levanta `MCP_MAX_SESSIONS`.
 */
const MAX_SESSIONS_PER_IDENTITY = readIntEnv(
  'MCP_MAX_SESSIONS_PER_IDENTITY',
  Math.max(10, Math.floor(MAX_SESSIONS / 10)),
);
export const SESSION_TTL_MS = readIntEnv('MCP_SESSION_TTL_MS', 30 * 60_000, { min: 1000 });
const SESSION_SWEEP_MS = readIntEnv('MCP_SESSION_SWEEP_MS', 60_000, { min: 1000 });

/**
 * Limite de taxa por IP — a camada que falta antes dos tetos acima.
 *
 * Os tetos de sessão limitam o que fica **em pé**; nada limitava o que **entra**:
 * cada requisição pode abrir uma linha em `mcp_sessions` (a decisão do banco é
 * "nunca apagar") e cada leitura de skill grava em `skill_accesses`, sem
 * credencial nenhuma no caminho aberto.
 *
 * O teto é alto de propósito: aqui o cliente é **agente**, que trabalha em
 * rajada — um `initialize`, a lista de ferramentas e uma dezena de chamadas em
 * poucos segundos —, e vários agentes podem sair pelo mesmo IP de saída. 600 por
 * minuto (10 por segundo sustentados) fica uma ordem de grandeza acima do uso
 * normal de um cliente MCP e ainda assim bem abaixo do que um robô faria.
 * `MCP_RATE_LIMIT_MAX=0` desliga, para quem já limita no proxy.
 */
const RATE_LIMIT_MAX = readIntEnv('MCP_RATE_LIMIT_MAX', 600, { min: 0 });

/**
 * Teto de mensagens num lote JSON-RPC.
 *
 * O limite acima conta **uma** marca por requisição HTTP, antes de o corpo ser
 * lido — e o corpo de um POST pode ser um array (o `clientInfoOf` de
 * `sessions.ts` já conta com isso). O SDK despacha o array inteiro: o único
 * corte dele é o `initialize`, que tem de vir sozinho. Sem teto próprio, quem
 * limitava o lote era o tamanho do corpo: medido, 2 000 `tools/call` cabem em
 * 183 KB e custaram **uma** marca — cada uma grava em `skill_accesses`, e cada
 * busca com termo paga um embedding.
 *
 * 20 cabe no uso legítimo: o lote saiu da especificação na revisão 2025-06-18,
 * e quem ainda o usa (2025-03-26) agrupa a notificação de início com as
 * primeiras chamadas. `1` recusa todo lote de mais de uma mensagem. Vale também
 * com `MCP_RATE_LIMIT_MAX=0`: o proxy que limita na frente conta requisições, e
 * tampouco enxerga dentro do corpo.
 */
const MAX_BATCH = readIntEnv('MCP_MAX_BATCH', 20, { min: 1 });

/**
 * A identidade de quem chegou autenticado por chave própria: é o que `auth.ts`
 * monta (`virtual:<uuid>:key:<id>`), contra o `virtual:<uuid>:open` do vMCP
 * aberto. O acoplamento com aquele formato é deliberado e está documentado nos
 * dois lados — é o único sinal confiável de credencial que chega até aqui.
 */
const AUTENTICADA_POR_CHAVE = /:key:/;

/**
 * A identidade anônima de um vMCP aberto (`virtual:<uuid>:open`, de `auth.ts`):
 * **todo** cliente sem chave a compartilha, venha de onde vier — então o teto
 * por credencial é, ali, um balde só para todos eles (`enforcePerIdentity`).
 */
const ANONIMA = /:open$/;

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
  /**
   * Atividade do cliente, renovada a cada `POST /messages`. Sem este campo a
   * varredura não tinha o que comparar — e o SSE, de fato, não era varrido: a
   * vaga só saía do mapa quando o socket caía, então um stream aberto e parado
   * a ocupava até o processo reiniciar.
   */
  lastSeen: number;
};

/** Os transportes do MCP: `/mcp` (Streamable HTTP), `/mcp/stateless`, `/sse` + `/messages`. */
export const TRANSPORTS = {
  streamableHttp: '/mcp',
  streamableHttpStateless: '/mcp/stateless',
  sse: { stream: '/sse', messages: '/messages' },
};

/**
 * O 404 da sessão que o servidor não conhece mais: venceu o TTL, foi reciclada
 * pelo teto da credencial ou o processo reiniciou — o cliente não tem como saber
 * qual, e nos três casos o remédio é o mesmo. Como a recusa do teto global, a
 * resposta diz o que fazer em vez de só negar. `base` é o prefixo do ponto de
 * montagem já resolvido (`req.baseUrl`).
 */
const sessaoDesconhecida = (base: string, sse = false) =>
  jsonRpcError(
    -32001,
    `Sessão ${sse ? 'SSE ' : ''}desconhecida ou expirada: abra outra ` +
      `(${sse ? `GET ${base}${TRANSPORTS.sse.stream}` : `initialize em POST ${base}${TRANSPORTS.streamableHttp}`}), ` +
      `ou use POST ${base}${TRANSPORTS.streamableHttpStateless}, que não depende de sessão`,
  );

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
  const dispatch = options.withRequest ?? ((_req: Request, run: () => Promise<void>) => run());
  const streamableSessions = new Map<string, TrackedStreamable>();
  const sseSessions = new Map<string, TrackedSse>();
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  const maxPerIdentity = options.maxSessionsPerIdentity ?? MAX_SESSIONS_PER_IDENTITY;
  const sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  const sweepMs = options.sessionSweepMs ?? SESSION_SWEEP_MS;
  const sessions = options.sessions;
  const rateLimitMax = options.rateLimitMax ?? RATE_LIMIT_MAX;
  const rateLimitWindowS = options.rateLimitWindowSeconds ?? 60;
  const rateLimit =
    rateLimitMax > 0
      ? createRateLimiter({ max: rateLimitMax, windowSeconds: rateLimitWindowS })
      : undefined;
  const maxBatch = options.maxBatch ?? MAX_BATCH;

  /** Sessões vivas do processo: o teto global é um orçamento de memória só. */
  const liveSessions = () => streamableSessions.size + sseSessions.size;

  /** Tira a sessão do mapa, avisa o rastreador e fecha o transporte. */
  const drop = (transport: StatefulTransport, id: string, reason: 'timeout'): void => {
    const tracked = transport === 'streamable' ? streamableSessions.get(id) : sseSessions.get(id);
    if (!tracked) return;
    if (transport === 'streamable') streamableSessions.delete(id);
    else sseSessions.delete(id);
    sessions?.closed(transport, id, reason);
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
      if (now - tracked.lastSeen > sessionTtlMs) drop('streamable', id, 'timeout');
    }
    for (const [id, tracked] of sseSessions) {
      if (now - tracked.lastSeen > sessionTtlMs) drop('sse', id, 'timeout');
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
   *
   * Na identidade **aberta** a credencial é uma só para todos os clientes sem
   * chave, e o balde também: a mais parada que cai pode ser a de um estranho.
   * É consequência aceita — o balde existe para o anônimo não tomar a vaga de
   * quem tem chave, e o anônimo legítimo não pode levar recusa (`02` §7.3).
   * Escolher a vítima pelo endereço foi medido e **recusado** (`tasks/048`):
   * com o balde cheio de sessões abandonadas, que é o estado normal de um
   * servidor popular, "primeiro a do próprio endereço" reduz cada endereço — e
   * cada NAT — a uma sessão só, em pingue-pongue. O aviso abaixo diz ao operador
   * qual alavanca puxar.
   */
  const enforcePerIdentity = (identity: string | undefined, keep: { transport: StatefulTransport; id: string }): void => {
    const own: { transport: StatefulTransport; id: string; lastSeen: number }[] = [];
    for (const [id, tracked] of streamableSessions) {
      if (tracked.identity === identity && !(keep.transport === 'streamable' && keep.id === id)) {
        own.push({ transport: 'streamable', id, lastSeen: tracked.lastSeen });
      }
    }
    for (const [id, tracked] of sseSessions) {
      if (tracked.identity === identity && !(keep.transport === 'sse' && keep.id === id)) {
        own.push({ transport: 'sse', id, lastSeen: tracked.lastSeen });
      }
    }
    // `own` já exclui a sessão nova: com menos que o teto, ela cabe.
    if (own.length < maxPerIdentity) return;

    own.sort((a, b) => a.lastSeen - b.lastSeen);
    // Uma vaga para a que entrou — mais de uma se o teto foi baixado a quente.
    for (const stale of own.slice(0, own.length - maxPerIdentity + 1)) {
      drop(stale.transport, stale.id, 'timeout');
    }
    warnLimit(
      `teto de ${maxPerIdentity} sessões por credencial atingido (${identity ?? 'sem identidade'}): ` +
        'reciclada a sessão parada há mais tempo' +
        (ANONIMA.test(identity ?? '')
          ? ' — num vMCP aberto todos os clientes sem chave dividem este teto; MCP_MAX_SESSIONS sobe os dois'
          : ''),
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
          `${retryS} s, ou use o transporte sem sessão (POST ${TRANSPORTS.streamableHttpStateless}), ` +
          'que não ocupa vaga.',
      ),
    );
    return true;
  };

  /**
   * A recusa do limite de taxa: 429, `Retry-After` e corpo JSON-RPC. Uma só para
   * a entrada e para o lote (`lote`, mais abaixo), que cobram do mesmo limitador.
   */
  const recusarPorTaxa = (limiter: RateLimiter, res: Response, chave: string, mensagensDoLote?: number): void => {
    const retryS = limiter.retryAfter(chave);
    const noLote = mensagensDoLote === undefined ? '' : ` num lote de ${mensagensDoLote} mensagens`;
    warnLimit(`limite de ${rateLimitMax} requisições em ${rateLimitWindowS} s atingido${noLote} (${chave})`);
    res.setHeader('Retry-After', String(retryS));
    res.status(429).json(
      jsonRpcError(
        -32000,
        `Limite de ${rateLimitMax} requisições em ${rateLimitWindowS} s atingido para este endereço. ` +
          (mensagensDoLote === undefined ? '' : 'Cada mensagem de um lote conta como uma requisição. ') +
          `Tente de novo em ${retryS} s. Uma chave psv_ deste MCP virtual não gasta essa cota.`,
      ),
    );
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
  // Só JSON e arquivo de skill saem daqui, nunca documento: o que falta é a
  // trava de sniffing, para nenhum navegador que abra uma dessas respostas
  // resolver interpretá-la como outra coisa. A CSP de documento não cabe num
  // servidor MCP; as rotas de arquivo já mandam a sua.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // Registrado por rota, sempre DEPOIS de `auth`: ler o corpo antes de saber
  // quem está chamando entrega memória de graça a qualquer anônimo.
  const json = express.json({ limit: options.jsonLimit });

  app.get('/healthz', (_req, res) => {
    healthCheck()
      .then((ok) => res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded' }))
      .catch(() => res.status(503).json({ status: 'degraded' }));
  });

  // Registrado **depois** do `/healthz` de propósito: a sonda do container fica
  // acima do limite, porque um 429 ali faria o orquestrador reiniciar um
  // processo saudável. Daqui para baixo tudo entra na conta — inclusive o `GET /`
  // e a autenticação, que consultam o banco sem credencial nenhuma.
  if (rateLimit) {
    app.use((req, res, next) => {
      const chave = rateLimitKey(req.ip);
      if (rateLimit.hit(chave)) {
        next();
        return;
      }
      recusarPorTaxa(rateLimit, res, chave);
    });
  }

  // O caractere nulo não tem uso legítimo em URL nenhuma daqui, e o `text` do
  // Postgres o recusa com 22021: `/virtual/a%00b/mcp` e `/skills/a%00b/download`
  // chegavam à consulta do slug e voltavam 500, com a SQL no log a cada
  // tentativa — sem credencial, num vMCP aberto (achado do relatório 038 da
  // auditoria de 2026-09-19). Uma guarda só, antes dos pontos de montagem, cobre
  // o caminho e a query string de todas as rotas: `%00` é a única forma de o nulo
  // chegar pela URL (o parser HTTP do Node recusa o byte cru, e UTF-8 inválido já
  // é 400 do próprio Express). Depois do limite de taxa, para a sondagem gastar
  // a cota de quem sonda.
  app.use((req, res, next) => {
    if (!req.originalUrl.includes('%00')) {
      next();
      return;
    }
    res.status(400).json(jsonRpcError(-32600, 'Requisição inválida: o endereço não pode conter o caractere nulo (%00)'));
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

    /**
     * O `auth` do ponto de montagem, mais o perdão da cota por IP.
     *
     * Quem chega autenticado por chave própria não gasta a cota anônima do
     * endereço: uma instalação cliente sai por um IP só, com muitos agentes
     * atrás, e o que limita o que ela faz é o teto por credencial
     * (`enforcePerIdentity`) somado à revogação da chave — não a janela, que
     * existe para conter quem ninguém conhece.
     *
     * O perdão vem **depois** do `auth`, nunca antes: chave forjada não passa
     * por aqui, e num vMCP aberto o `Authorization` é ignorado, então bastaria
     * mandar um cabeçalho qualquer para escapar do limite se o sinal fosse a
     * presença dele.
     */
    const auth: RequestHandler = (req, res, next) => {
      mount.auth(req, res, (err?: unknown) => {
        if (err === undefined && rateLimit && AUTENTICADA_POR_CHAVE.test(identity(req) ?? '')) {
          rateLimit.forgive(rateLimitKey(req.ip));
        }
        next(err);
      });
    };

    /**
     * O lote JSON-RPC, que o limite por IP não enxerga.
     *
     * Registrado **depois** do `json` de propósito: no middleware do limite o
     * corpo ainda não foi lido, então a conta não tem como ser feita lá. Faz
     * duas coisas. Recusa o lote acima de `maxBatch` — para todo mundo, com ou
     * sem chave, porque o que esse teto protege é o banco, não a cota. E cobra
     * do limitador **uma marca por mensagem**; a primeira já foi cobrada na
     * entrada. Chave `psv_` não gasta a cota anônima do endereço, pela razão
     * escrita no `auth` acima. O que o lote recusado chegou a gastar fica gasto:
     * é a mesma conta de quem mandasse as mensagens uma a uma até o 429.
     *
     * Corpo que não é array passa direto: o cliente que manda uma mensagem por
     * POST — todos os atuais — não muda de comportamento. O SSE legado fica de
     * fora porque o `handlePostMessage` do SDK só aceita uma mensagem.
     */
    const lote: RequestHandler = (req, res, next) => {
      const body: unknown = req.body;
      if (!Array.isArray(body)) {
        next();
        return;
      }

      if (body.length > maxBatch) {
        res
          .status(400)
          .json(
            jsonRpcError(
              -32600,
              `Lote de ${body.length} mensagens acima do limite de ${maxBatch} por requisição. ` +
                'Mande as chamadas em requisições separadas.',
            ),
          );
        return;
      }

      if (!rateLimit || AUTENTICADA_POR_CHAVE.test(identity(req) ?? '')) {
        next();
        return;
      }

      const chave = rateLimitKey(req.ip);
      for (let i = 1; i < body.length; i += 1) {
        if (rateLimit.hit(chave)) continue;
        recusarPorTaxa(rateLimit, res, chave, body.length);
        return;
      }
      next();
    };

    mount.routes?.(router);

    // ----------------------------------------- Streamable HTTP com sessão ---

    router.post('/mcp', auth, json, lote, async (req, res) => {
      try {
        const sessionId = req.header('mcp-session-id');
        const existing = sessionId ? streamableSessions.get(sessionId) : undefined;

        if (existing) {
          if (existing.identity !== identity(req)) {
            res.status(403).json(jsonRpcError(-32001, 'Sessão pertence a outra credencial'));
            return;
          }
          existing.lastSeen = Date.now();
          sessions?.seen('streamable', sessionId!, req);
          await dispatch(req, () => existing.transport.handleRequest(req, res, req.body));
          return;
        }

        if (sessionId) {
          res.status(404).json(sessaoDesconhecida(req.baseUrl));
          return;
        }

        if (rejectWhenFull(res)) return;

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            streamableSessions.set(id, { transport, lastSeen: Date.now(), identity: identity(req) });
            sessions?.opened('streamable', id, req);
            enforcePerIdentity(identity(req), { transport: 'streamable', id });
          },
          onsessionclosed: (id) => {
            streamableSessions.delete(id);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            streamableSessions.delete(transport.sessionId);
            // O DELETE do cliente e o fechamento pelo SDK caem aqui; o TTL
            // já avisou `timeout` antes de fechar, e o rastreador ignora repetição.
            sessions?.closed('streamable', transport.sessionId, 'closed');
          }
        };

        const server = mount.createServer(req);
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
        res.status(404).json(sessaoDesconhecida(req.baseUrl));
        return;
      }
      if (tracked.identity !== identity(req)) {
        res.status(403).json(jsonRpcError(-32001, 'Sessão pertence a outra credencial'));
        return;
      }

      tracked.lastSeen = Date.now();
      sessions?.seen('streamable', sessionId!, req);
      await dispatch(req, () => tracked.transport.handleRequest(req, res));
    };

    router.get('/mcp', auth, streamableSession);
    router.delete('/mcp', auth, streamableSession);

    // ---------------------------------------------- Streamable HTTP stateless ---

    router.post('/mcp/stateless', auth, json, lote, async (req, res) => {
      sessions?.stateless(req);
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
        await dispatch(req, () => transport.handleRequest(req, res, req.body));
      } catch (err) {
        console.error('[mcp] erro no POST /mcp/stateless:', err);
        if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Erro interno do servidor'));
      }
    });

    // -------------------------------------------------------- SSE legado ---

    router.get('/sse', auth, async (req, res) => {
      if (rejectWhenFull(res)) return;

      // O endpoint anunciado ao cliente é relativo ao ponto de montagem: num
      // virtual, `/virtual/<slug>/messages`. `req.baseUrl` já é o prefixo
      // resolvido — com o slug real, não com `:slug`.
      const transport = new SSEServerTransport(`${req.baseUrl}${TRANSPORTS.sse.messages}`, res);
      sseSessions.set(transport.sessionId, { transport, identity: identity(req), lastSeen: Date.now() });
      sessions?.opened('sse', transport.sessionId, req);
      enforcePerIdentity(identity(req), { transport: 'sse', id: transport.sessionId });

      transport.onclose = () => {
        sseSessions.delete(transport.sessionId);
        sessions?.closed('sse', transport.sessionId, 'closed');
      };
      res.on('close', () => {
        sseSessions.delete(transport.sessionId);
        sessions?.closed('sse', transport.sessionId, 'closed');
      });

      const server = mount.createServer(req);
      await server.connect(transport);
    });

    router.post('/messages', auth, json, async (req, res) => {
      const sessionId = String(req.query.sessionId ?? '');
      const tracked = sseSessions.get(sessionId);

      if (!tracked) {
        res.status(404).json(sessaoDesconhecida(req.baseUrl, true));
        return;
      }
      if (tracked.identity !== identity(req)) {
        res.status(403).json(jsonRpcError(-32001, 'Sessão pertence a outra credencial'));
        return;
      }

      // Renova a atividade: sem isto a varredura fecharia sessão SSE em uso.
      tracked.lastSeen = Date.now();
      sessions?.seen('sse', sessionId, req);
      await dispatch(req, () => tracked.transport.handlePostMessage(req, res, req.body));
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
    // O rastreador fecha as linhas com `shutdown` antes de os transportes
    // dispararem `onclose` com `closed`: o primeiro motivo é o que fica.
    await sessions?.shutdown();
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
