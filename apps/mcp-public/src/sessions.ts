import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  closeMcpSession as dbCloseMcpSession,
  closeMcpSessions as dbCloseMcpSessions,
  expireMcpSessions as dbExpireMcpSessions,
  findOpenMcpSession as dbFindOpenMcpSession,
  openMcpSession as dbOpenMcpSession,
  touchMcpSession as dbTouchMcpSession,
} from '@purple-skills/db';
import {
  readIntEnv,
  type McpSessionAuth,
  type McpSessionEndReason,
  type McpSessionMount,
  type McpSessionTransport,
} from '@purple-skills/shared';

/**
 * Contabilidade de sessões do MCP público (`docs/10-admin-canvas-e-sessoes.md`).
 *
 * O `http.ts` avisa o rastreador a cada evento de transporte — sessão aberta,
 * requisição atendida, sessão fechada, requisição stateless — e o rastreador
 * grava em `mcp_sessions` pelo `@purple-skills/db`. O caminho quente não
 * espera o banco: as escritas são disparadas e o erro vai para o log, porque
 * um `INSERT` lento ou recusado não pode atrasar nem negar uma resposta MCP.
 *
 * Duas decisões de custo:
 *
 * - **toques agrupados.** Cada requisição conta, mas `last_seen_at` e
 *   `request_count` só vão ao banco a cada `touchIntervalMs` por sessão (ou
 *   no fechamento). Um agente que chama dez tools por segundo custa um
 *   `UPDATE` a cada dez segundos, não dez por segundo;
 * - **stateless vira sessão sintética.** Não há id: o cliente é reconhecido
 *   por IP, agente, credencial e vMCP, e as requisições dele dentro da janela
 *   de "online" caem na mesma linha. Passada a janela, a próxima abre outra —
 *   e a varredura marca a antiga com o fim presumido.
 */

/**
 * Teto de identidades stateless contabilizadas ao mesmo tempo.
 *
 * O `user-agent` entra na chave sintética e é texto escolhido por quem chama:
 * variá-lo a cada requisição cria uma identidade nova, e cada identidade nova
 * é uma entrada no mapa **e** um `INSERT` em `mcp_sessions` — tabela sem poda
 * automática. O limite de taxa por IP (`http.ts`) contém a origem única; este
 * teto contém o resto, inclusive rajada distribuída e quem tem chave válida.
 *
 * Atingido, a requisição é atendida **sem** contabilidade: perder a estatística
 * é prejuízo pequeno perto de encher o disco do banco. Só identidade **nova** é
 * recusada — quem já está no mapa continua sendo contado, então uma enxurrada
 * não apaga da tela os clientes de verdade.
 */
const MAX_STATELESS_ENTRIES = readIntEnv('MCP_MAX_STATELESS_SESSIONS', 5_000);

export type SessionScope = {
  virtualMcpUuid: string;
  virtualMcpSlug: string;
  auth: McpSessionAuth;
  keyId: string | null;
};

export type StatefulTransport = Exclude<McpSessionTransport, 'stateless'>;

export type SessionTracker = {
  /** Uma sessão com id acabou de ser criada (Streamable `initialize` ou `GET /sse`). */
  opened(transport: StatefulTransport, sessionId: string, req: Request): void;
  /** Uma requisição chegou numa sessão existente. */
  seen(transport: StatefulTransport, sessionId: string, req: Request): void;
  /** A sessão acabou: o cliente fechou, o TTL venceu ou o servidor parou. */
  closed(transport: StatefulTransport, sessionId: string, reason: McpSessionEndReason): void;
  /** Uma requisição sem sessão (`POST /mcp/stateless`). */
  stateless(req: Request): void;
  /** Leva ao banco os toques acumulados. */
  flush(): Promise<void>;
  /** Flush + expiração das sessões paradas (roda sozinho a cada `sweepMs`). */
  sweep(): Promise<void>;
  /** Encerra tudo o que este processo abriu, com motivo `shutdown`. */
  shutdown(): Promise<void>;
};

/** O que o rastreador precisa do banco — injetável nos testes. */
export type SessionStore = {
  openMcpSession: typeof dbOpenMcpSession;
  touchMcpSession: typeof dbTouchMcpSession;
  closeMcpSession: typeof dbCloseMcpSession;
  closeMcpSessions: typeof dbCloseMcpSessions;
  findOpenMcpSession: typeof dbFindOpenMcpSession;
  expireMcpSessions: typeof dbExpireMcpSessions;
};

export type SessionTrackerOptions = {
  /** O vMCP e a credencial da requisição já autenticada; `undefined` = não rastrear. */
  scopeOf: (req: Request) => SessionScope | undefined;
  /** Janela de "online": agrupa o stateless e presume o fim dele. */
  onlineWindowMs: number;
  /** TTL das sessões com id (o mesmo do mapa em memória do `http.ts`). */
  sessionTtlMs: number;
  /** Intervalo mínimo entre dois `UPDATE` da mesma sessão. Padrão: 10 s. */
  touchIntervalMs?: number;
  /** Intervalo da varredura automática. Padrão: 60 s; `0` desliga (testes). */
  sweepMs?: number;
  /** Teto de identidades stateless em memória. Padrão: `MAX_STATELESS_ENTRIES`. */
  maxStatelessEntries?: number;
  store?: SessionStore;
  now?: () => number;
  log?: (message: string) => void;
};

type ClientInfo = { name: string | null; version: string | null };

type Entry = {
  transport: McpSessionTransport;
  /** O id da linha, quando o INSERT (ou o reuso) terminar; `null` se falhou. */
  id: Promise<string | null>;
  /** Requisições ainda não levadas ao banco. */
  pending: number;
  lastFlush: number;
  lastSeen: number;
  client: ClientInfo;
  /** `clientInfo` que chegou depois da abertura e ainda não foi gravado. */
  clientDirty: boolean;
};

const key = (transport: McpSessionTransport, sessionId: string) => `${transport}:${sessionId}`;

/** Por onde o cliente chegou: `req.baseUrl` é o prefixo do ponto de montagem, vazio na raiz. */
const mountOf = (req: Request): McpSessionMount => (req.baseUrl ? 'virtual' : 'root');

/**
 * O `clientInfo` do `initialize`, quando esta requisição o carrega. O corpo
 * pode ser uma mensagem ou um lote; qualquer coisa fora do formato é ignorada.
 */
export function clientInfoOf(body: unknown): ClientInfo | null {
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const { method, params } = message as { method?: unknown; params?: { clientInfo?: unknown } };
    if (method !== 'initialize') continue;
    const info = params?.clientInfo as { name?: unknown; version?: unknown } | undefined;
    if (!info || typeof info !== 'object') return null;
    return {
      name: typeof info.name === 'string' ? info.name : null,
      version: typeof info.version === 'string' ? info.version : null,
    };
  }
  return null;
}

/** A chave sintética do stateless: o mesmo cliente, no mesmo vMCP, com a mesma credencial. */
export function statelessSessionId(req: Request, scope: SessionScope): string {
  const material = [req.ip ?? '', req.get('user-agent') ?? '', scope.auth, scope.keyId ?? '', scope.virtualMcpUuid].join('|');
  return `sl_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

export function createSessionTracker(options: SessionTrackerOptions): SessionTracker {
  const store: SessionStore = options.store ?? {
    openMcpSession: dbOpenMcpSession,
    touchMcpSession: dbTouchMcpSession,
    closeMcpSession: dbCloseMcpSession,
    closeMcpSessions: dbCloseMcpSessions,
    findOpenMcpSession: dbFindOpenMcpSession,
    expireMcpSessions: dbExpireMcpSessions,
  };
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(`[mcp-public] sessões: ${message}`));
  const touchIntervalMs = options.touchIntervalMs ?? 10_000;
  const maxStatelessEntries = options.maxStatelessEntries ?? MAX_STATELESS_ENTRIES;
  const entries = new Map<string, Entry>();
  /** Quantas entradas de `entries` são stateless — contadas, e não varridas, porque o mapa é do caminho quente. */
  let statelessEntries = 0;
  /** Último aviso de teto: sob enxurrada, o log não pode virar o próximo problema. */
  let lastLimitWarn = 0;

  const warn = (what: string) => (err: unknown) => {
    log(`${what}: ${(err as Error)?.message ?? String(err)}`);
    return null;
  };

  /** Aviso do teto, no máximo um por janela de "online". */
  const avisarTeto = (): void => {
    if (now() - lastLimitWarn < options.onlineWindowMs) return;
    lastLimitWarn = now();
    log(
      `teto de ${maxStatelessEntries} identidades stateless atingido: as requisições seguem atendidas, ` +
        'sem contabilidade, até a varredura liberar espaço',
    );
  };

  function baseInput(req: Request, scope: SessionScope, transport: McpSessionTransport, sessionId: string, client: ClientInfo | null) {
    return {
      sessionId,
      transport,
      mount: mountOf(req),
      virtualMcpUuid: scope.virtualMcpUuid,
      virtualMcpSlug: scope.virtualMcpSlug,
      auth: scope.auth,
      keyId: scope.keyId,
      ip: req.ip || 'desconhecido',
      userAgent: req.get('user-agent') ?? null,
      clientName: client?.name ?? null,
      clientVersion: client?.version ?? null,
      requests: 1,
    };
  }

  async function flushEntry(entry: Entry): Promise<void> {
    if (entry.pending === 0 && !entry.clientDirty) return;
    const id = await entry.id;
    if (!id) {
      entry.pending = 0;
      entry.clientDirty = false;
      return;
    }
    const requests = entry.pending;
    const client = entry.clientDirty ? entry.client : null;
    entry.pending = 0;
    entry.clientDirty = false;
    entry.lastFlush = now();
    await store
      .touchMcpSession(id, {
        requests,
        ...(client ? { clientName: client.name, clientVersion: client.version } : {}),
      })
      .catch(warn('não foi possível marcar a atividade'));
  }

  function touch(entry: Entry, req: Request): void {
    entry.pending += 1;
    entry.lastSeen = now();
    const client = clientInfoOf(req.body);
    if (client && (client.name || client.version) && !entry.client.name && !entry.client.version) {
      entry.client = client;
      entry.clientDirty = true;
    }
    if (now() - entry.lastFlush >= touchIntervalMs) void flushEntry(entry);
  }

  function opened(transport: StatefulTransport, sessionId: string, req: Request): void {
    const scope = options.scopeOf(req);
    if (!scope) return;
    const client = clientInfoOf(req.body);
    const entry: Entry = {
      transport,
      id: store.openMcpSession(baseInput(req, scope, transport, sessionId, client)).catch(warn('não foi possível abrir a sessão')),
      pending: 0,
      lastFlush: now(),
      lastSeen: now(),
      client: client ?? { name: null, version: null },
      clientDirty: false,
    };
    entries.set(key(transport, sessionId), entry);
  }

  function seen(transport: StatefulTransport, sessionId: string, req: Request): void {
    const entry = entries.get(key(transport, sessionId));
    if (!entry) return;
    touch(entry, req);
  }

  function closed(transport: StatefulTransport, sessionId: string, reason: McpSessionEndReason): void {
    const k = key(transport, sessionId);
    const entry = entries.get(k);
    if (!entry) return;
    entries.delete(k);
    void (async () => {
      await flushEntry(entry);
      const id = await entry.id;
      if (id) await store.closeMcpSession(id, reason);
    })().catch(warn('não foi possível encerrar a sessão'));
  }

  function stateless(req: Request): void {
    const scope = options.scopeOf(req);
    if (!scope) return;
    const sessionId = statelessSessionId(req, scope);
    const k = key('stateless', sessionId);
    const existing = entries.get(k);

    if (existing && now() - existing.lastSeen <= options.onlineWindowMs) {
      touch(existing, req);
      return;
    }
    // Passou da janela (ou é a primeira vez): a antiga fica para a varredura
    // presumir o fim; esta abre outra — reusando a linha aberta que um
    // restart do processo tenha deixado, se ela ainda está na janela.
    if (existing) {
      entries.delete(k);
      statelessEntries -= 1;
    }
    // Identidade nova não entra com o mapa cheio: é o que impede um
    // `user-agent` variável de virar uma linha permanente por requisição.
    if (statelessEntries >= maxStatelessEntries) {
      avisarTeto();
      return;
    }
    const client = clientInfoOf(req.body);
    const input = baseInput(req, scope, 'stateless', sessionId, client);
    const entry: Entry = {
      transport: 'stateless',
      id: (async () => {
        const reused = await store.findOpenMcpSession({ sessionId, transport: 'stateless', withinMs: options.onlineWindowMs });
        if (reused) {
          await store.touchMcpSession(reused, { requests: 1, clientName: client?.name ?? null, clientVersion: client?.version ?? null });
          return reused;
        }
        return store.openMcpSession(input);
      })().catch(warn('não foi possível registrar a requisição stateless')),
      pending: 0,
      lastFlush: now(),
      lastSeen: now(),
      client: client ?? { name: null, version: null },
      clientDirty: false,
    };
    entries.set(k, entry);
    statelessEntries += 1;
  }

  async function flush(): Promise<void> {
    await Promise.all([...entries.values()].map((entry) => flushEntry(entry)));
  }

  async function sweep(): Promise<void> {
    await flush();
    // Entradas stateless paradas saem da memória; a linha delas é fechada
    // pela expiração abaixo, com o fim presumido.
    for (const [k, entry] of entries) {
      if (entry.transport === 'stateless' && now() - entry.lastSeen > options.onlineWindowMs) {
        entries.delete(k);
        statelessEntries -= 1;
      }
    }
    await store
      .expireMcpSessions({ statelessWindowMs: options.onlineWindowMs, sessionTtlMs: options.sessionTtlMs })
      .catch(warn('não foi possível expirar sessões paradas'));
  }

  const sweepMs = options.sweepMs ?? 60_000;
  const timer = sweepMs > 0 ? setInterval(() => void sweep(), sweepMs) : null;
  timer?.unref?.();

  async function shutdown(): Promise<void> {
    if (timer) clearInterval(timer);
    await flush();
    const stateful = [...entries.values()].filter((entry) => entry.transport !== 'stateless');
    entries.clear();
    statelessEntries = 0;
    const ids = (await Promise.all(stateful.map((entry) => entry.id))).filter((id): id is string => Boolean(id));
    if (ids.length > 0) await store.closeMcpSessions(ids, 'shutdown').catch(warn('não foi possível encerrar as sessões no desligamento'));
  }

  return { opened, seen, closed, stateless, flush, sweep, shutdown };
}
