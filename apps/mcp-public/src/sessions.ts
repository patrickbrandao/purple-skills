import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  bumpMcpCallCounters as dbBumpMcpCallCounters,
  closeMcpSession as dbCloseMcpSession,
  closeMcpSessions as dbCloseMcpSessions,
  expireMcpSessions as dbExpireMcpSessions,
  findOpenMcpSession as dbFindOpenMcpSession,
  MCP_CALL_METHOD_MAX,
  normalizeSessionLabel,
  openMcpSession as dbOpenMcpSession,
  touchMcpSession as dbTouchMcpSession,
} from '@purple-skills/db';
import {
  MCP_CALL_BUCKET_MS,
  readIntEnv,
  type McpCallBucketInput,
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
 * Três decisões de custo:
 *
 * - **toques agrupados.** Cada requisição conta, mas `last_seen_at` e
 *   `request_count` só vão ao banco a cada `touchIntervalMs` por sessão (ou
 *   no fechamento). Um agente que chama dez tools por segundo custa um
 *   `UPDATE` a cada dez segundos, não dez por segundo;
 * - **stateless vira sessão sintética.** Não há id: o cliente é reconhecido
 *   por IP, agente, credencial e vMCP, e as requisições dele dentro da janela
 *   de "online" caem na mesma linha. Passada a janela, a próxima abre outra —
 *   e a varredura marca a antiga com o fim presumido;
 * - **chamada é mensagem; requisição é requisição.** A tela de Atividade
 *   (`docs/18-atividade.md`) quer quantas vezes cada método JSON-RPC foi
 *   chamado, e o corpo de um POST pode ser um lote: as mesmas 20 mensagens
 *   somam 1 em `request_count` e 20 na contagem nova. São duas medidas
 *   diferentes de propósito. Ela é acumulada por (balde de
 *   `MCP_CALL_BUCKET_MS`, método) dentro da própria entrada e vai ao banco no
 *   mesmo despejo agrupado, por `bumpMcpCallCounters`.
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
 *
 * Mínimo `1` (o padrão do `readIntEnv`), ao contrário de `MCP_RATE_LIMIT_MAX`:
 * aqui `0` não tem como significar "desligado". Com `statelessEntries >= 0`
 * sempre verdadeiro, nada mais seria contabilizado — o oposto de "sem teto" —,
 * e sem teto de verdade volta o problema que ele fecha. `0` derruba o boot com
 * a mensagem de faixa, e é o comportamento desejado.
 */
const MAX_STATELESS_ENTRIES = readIntEnv('MCP_MAX_STATELESS_SESSIONS', 5_000);

/**
 * Teto de métodos distintos contabilizados por entrada **em cada balde**.
 *
 * É o análogo do teto acima para a contagem nova: `method` é texto escolhido
 * por quem chama, e variá-lo a cada mensagem cria uma chave nova no mapa da
 * entrada **e** uma linha nova por balde em `mcp_call_counters` — tabela que,
 * como `mcp_sessions`, nunca é podada. O protocolo inteiro não chega a duas
 * dezenas de métodos (contando os três da extensão SEP-2640), então 64 é folga
 * larga para o que existe e ainda assim um mapa pequeno por sessão.
 *
 * O balde é a unidade certa porque é ele que vira a linha. Medido no mapa
 * `calls` — que `colherChamadas` esvazia a cada despejo, isto é, a cada
 * `touchIntervalMs` (10 s) —, o teto reiniciava junto com ele: um cliente que
 * variasse o `method` sem parar criava 64 métodos novos **por despejo**, 384
 * por minuto, e cada um virava uma linha nova em `mcp_call_counters`. Ele
 * segurava a memória (o mapa) e deixava passar o banco, que é o lado sem poda.
 * Contado por balde, a entrada gera no máximo `maxMethodsPerEntry` linhas por
 * quarto de hora, aconteçam quantos despejos acontecerem.
 *
 * Atingido, o excedente **continua contado**, na chave `OVERFLOW_METHOD`: o
 * total do dia e a fatia por família ficam certos, e o que se perde é só qual
 * método inventado cada chamada era. É por isso que aqui não há variável de
 * ambiente — ao contrário do teto de identidades, nada deixa de ser
 * contabilizado, e não há o que um operador precise afrouxar.
 */
const MAX_METHODS_PER_ENTRY = 64;

/**
 * A chave que recolhe o que passou do teto. O método literal `other` é a
 * escolha natural: `mcpCallFamily('other')` já é `'other'`, então o excedente
 * cai na família que o relatório reserva para o que está fora do protocolo.
 */
const OVERFLOW_METHOD = 'other';

/**
 * Quantas mensagens do corpo de uma requisição podem virar chamada, por
 * transporte.
 *
 * No Streamable — com sessão ou stateless — o lote é legítimo: o SDK processa
 * as N mensagens, e quem o limita é o middleware `lote` do `http.ts`, com o
 * teto de `MCP_MAX_BATCH`, antes de o rastreador ver a requisição. Ali o corpo
 * passa inteiro, de propósito.
 *
 * No SSE legado, não. O `POST /messages` não passa pelo `lote` — essa rota não
 * tem teto nenhum — e o `handlePostMessage` do SDK entrega o corpo ao
 * `JSONRPCMessageSchema`, que só aceita **uma** mensagem: um array é recusado
 * com 400 sem nada ser processado. Sem este limite, um cliente mandava 5 000
 * mensagens num array, o SDK recusava a requisição inteira, e a tela de
 * Atividade registrava 5 000 chamadas que nunca aconteceram.
 *
 * Uma, e não zero, de propósito: uma é o que o corpo de um cliente de verdade
 * tem — objeto solto, o único formato que essa rota aceita — e é o teto do que
 * a requisição pode ter feito acontecer. Contar zero no array amarraria a
 * conta ao SDK continuar recusando lote aqui; o teto de 1 vale nos dois casos,
 * e o erro que sobra é de uma chamada, não de cinco mil.
 */
const MAX_MESSAGES_PER_REQUEST: Record<McpSessionTransport, number> = {
  streamable: Number.POSITIVE_INFINITY,
  stateless: Number.POSITIVE_INFINITY,
  sse: 1,
};

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
  /** A contagem por método da tela de Atividade (`docs/18-atividade.md`). */
  bumpMcpCallCounters: typeof dbBumpMcpCallCounters;
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
  /** Teto de métodos distintos por entrada. Padrão: `MAX_METHODS_PER_ENTRY`. */
  maxMethodsPerEntry?: number;
  store?: SessionStore;
  now?: () => number;
  log?: (message: string) => void;
};

type ClientInfo = { name: string | null; version: string | null };

type Entry = {
  transport: McpSessionTransport;
  /** O vMCP e a credencial da entrada: é o que leva as chamadas ao banco sem precisar do `req`. */
  scope: SessionScope;
  /** O id da linha, quando o INSERT (ou o reuso) terminar; `null` se falhou. */
  id: Promise<string | null>;
  /** Requisições ainda não levadas ao banco. */
  pending: number;
  lastFlush: number;
  lastSeen: number;
  client: ClientInfo;
  /** `clientInfo` que chegou depois da abertura e ainda não foi gravado. */
  clientDirty: boolean;
  /**
   * Chamadas ainda não somadas no banco: método → balde → quantas.
   *
   * Nesta ordem, e não (balde → método): o mapa de baldes de um método tem uma
   * entrada, duas quando o despejo atravessa a virada dos 15 minutos.
   */
  calls: Map<string, Map<number, number>>;
  /** O balde da última chamada contada; a virada dele zera `metodosDoBalde`. `-1` = nenhuma ainda. */
  balde: number;
  /**
   * Métodos distintos já vistos **no balde corrente** — é o que o teto conta.
   *
   * Não dá para medir isso em `calls.size`: aquele mapa é esvaziado a cada
   * despejo, e o teto medido nele reiniciava junto (ver
   * `MAX_METHODS_PER_ENTRY`). Este conjunto só é esvaziado quando o balde vira,
   * que é exatamente quando a linha do banco também muda.
   */
  metodosDoBalde: Set<string>;
};

const key = (transport: McpSessionTransport, sessionId: string) => `${transport}:${sessionId}`;

/** Por onde o cliente chegou: `req.baseUrl` é o prefixo do ponto de montagem, vazio na raiz. */
const mountOf = (req: Request): McpSessionMount => (req.baseUrl ? 'virtual' : 'root');

/**
 * Um rótulo do `clientInfo` como ele pode ficar **na memória** do rastreador:
 * a regra é a do banco (`normalizeSessionLabel`), para a linha de
 * `mcp_sessions` e a entrada do mapa terem o mesmo valor.
 *
 * O `clientInfo` é texto livre de quem chama, e chegava aqui cru — limitado só
 * pelo corpo JSON (`MCP_JSON_LIMIT`, 1 MB). Duas consequências, uma função:
 *
 * - **o corte, com cópia** (relatório 047 da auditoria de 2026-09-19). A entrada
 *   vive no mapa por até uma janela de "online" mais uma varredura, e o
 *   `user-agent` variável cria identidade nova a cada requisição: medido, 400
 *   identidades stateless com nome de 1 MB seguravam +400 MB de heap. Um `slice`
 *   não resolve — no V8 o recorte guarda a string-mãe inteira —, e é por isso
 *   que a função do banco devolve uma **cópia**. O teto de identidades conta
 *   entradas, não bytes; com o rótulo em 512 caracteres ele volta a bastar;
 * - **o saneamento** (relatório 038). O `text` do Postgres recusa U+0000: um
 *   byte nulo no nome derrubava o INSERT da sessão em silêncio (a escrita é
 *   melhor esforço) e o cliente sumia da tela de sessões. Caractere de controle
 *   vira espaço; nome só de controles ou de espaços vira `null`.
 */
const rotuloDoCliente = (value: unknown): string | null =>
  typeof value === 'string' ? normalizeSessionLabel(value) : null;

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
      name: rotuloDoCliente(info.name),
      version: rotuloDoCliente(info.version),
    };
  }
  return null;
}

/**
 * O método JSON-RPC como ele pode ficar **na memória** e como ele vai virar
 * linha: a regra do rótulo (`normalizeSessionLabel`) com o teto do banco
 * (`MCP_CALL_METHOD_MAX`, 128).
 *
 * Os dois motivos são os do `clientInfo` logo acima — o corte com cópia do
 * relatório 047 e o saneamento do 038 — e aqui eles pesam igual: `method` é
 * texto livre, chega pelo mesmo corpo de 1 MB e a chave do mapa vive por até um
 * intervalo de despejo. O teto, porém, é o **do banco**, e não o do rótulo: lá
 * a linha é chaveada pelo método já cortado em 128, de modo que duas chaves
 * distintas aqui viram uma linha só lá — e a conta em memória deixaria de bater
 * com a gravada. Não é uma terceira política de saneamento: é a do banco,
 * aplicada antes.
 */
const metodoDaChamada = (value: unknown): string | null => {
  const rotulo = typeof value === 'string' ? normalizeSessionLabel(value) : null;
  return rotulo ? rotulo.slice(0, MCP_CALL_METHOD_MAX).trimEnd() : null;
};

/**
 * Os métodos JSON-RPC desta requisição, já limpos e na ordem em que chegaram,
 * até o limite de mensagens do transporte (`MAX_MESSAGES_PER_REQUEST`).
 *
 * O corpo pode ser um lote (o `clientInfoOf` acima já conta com isso) e aqui,
 * ao contrário de `request_count`, **cada mensagem conta**: um POST com 20
 * `tools/call` soma 20 chamadas e uma requisição. Quem comparar os dois números
 * na tela vai achar que é defeito; é medida diferente, de propósito.
 *
 * Corpo ausente é o caso normal do `GET /mcp`, do `DELETE /mcp` e do `GET /sse`
 * — o `express.json` nem roda neles e `req.body` é `undefined`. Resposta
 * JSON-RPC, objeto solto e lixo não têm `method` que seja texto e ficam de fora.
 */
function metodosDoCorpo(body: unknown, maxMensagens: number): string[] {
  const todas = Array.isArray(body) ? body : [body];
  // O corte é nas **mensagens**, e não nos métodos colhidos: o que o limite diz
  // é quantas mensagens do corpo o transporte chega a processar. Com o teto
  // infinito (Streamable) não há cópia nenhuma no caminho quente.
  const messages = todas.length > maxMensagens ? todas.slice(0, maxMensagens) : todas;
  const methods: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const method = metodoDaChamada((message as { method?: unknown }).method);
    if (method) methods.push(method);
  }
  return methods;
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
    bumpMcpCallCounters: dbBumpMcpCallCounters,
  };
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(`[mcp-public] sessões: ${message}`));
  const touchIntervalMs = options.touchIntervalMs ?? 10_000;
  const maxStatelessEntries = options.maxStatelessEntries ?? MAX_STATELESS_ENTRIES;
  const maxMethodsPerEntry = options.maxMethodsPerEntry ?? MAX_METHODS_PER_ENTRY;
  const entries = new Map<string, Entry>();
  /** Quantas entradas de `entries` são stateless — contadas, e não varridas, porque o mapa é do caminho quente. */
  let statelessEntries = 0;
  /** Último aviso de teto: sob enxurrada, o log não pode virar o próximo problema. */
  let lastLimitWarn = 0;
  /** O mesmo, para o teto de métodos distintos. */
  let lastMethodWarn = 0;

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

  /** Aviso do teto de métodos, também no máximo um por janela de "online". */
  const avisarTetoDeMetodos = (): void => {
    if (now() - lastMethodWarn < options.onlineWindowMs) return;
    lastMethodWarn = now();
    log(
      `teto de ${maxMethodsPerEntry} métodos distintos numa sessão atingido: as chamadas seguem contadas, ` +
        `somadas em "${OVERFLOW_METHOD}", até o balde de 15 minutos virar`,
    );
  };

  /**
   * Soma as mensagens desta requisição no balde em que elas **aconteceram**.
   *
   * O balde é calculado aqui, no atendimento, e não no despejo: o despejo pode
   * atravessar a virada dos 15 minutos, e o que foi chamado antes dela iria
   * para o balde novo — um dia ganharia chamadas do outro na virada da
   * meia-noite de algum fuso. O relógio é o injetável do módulo, nunca
   * `Date.now()`.
   *
   * O teto de métodos distintos é medido no **balde**, e não no mapa `calls`,
   * porque é o balde que corresponde à linha do banco — ver
   * `MAX_METHODS_PER_ENTRY`. Daí o `metodosDoBalde` ser zerado na virada do
   * balde, e não no despejo.
   */
  function contarChamadas(entry: Entry, req: Request): void {
    const metodos = metodosDoCorpo(req.body, MAX_MESSAGES_PER_REQUEST[entry.transport]);
    if (metodos.length === 0) return;
    const balde = Math.floor(now() / MCP_CALL_BUCKET_MS) * MCP_CALL_BUCKET_MS;
    if (balde !== entry.balde) {
      entry.balde = balde;
      entry.metodosDoBalde.clear();
    }
    for (const metodo of metodos) {
      let chave = metodo;
      if (!entry.metodosDoBalde.has(chave) && entry.metodosDoBalde.size >= maxMethodsPerEntry) {
        avisarTetoDeMetodos();
        chave = OVERFLOW_METHOD;
      }
      entry.metodosDoBalde.add(chave);
      let baldes = entry.calls.get(chave);
      if (!baldes) {
        baldes = new Map<number, number>();
        entry.calls.set(chave, baldes);
      }
      baldes.set(balde, (baldes.get(balde) ?? 0) + 1);
    }
  }

  /**
   * Tira da entrada tudo o que ela acumulou, cada linha com o instante do balde
   * em que a chamada caiu. A família não é decidida aqui: quem a deriva do
   * método é `bumpMcpCallCounters`, com o `mcpCallFamily` do `shared`, e uma
   * segunda regra de classificação neste lado seria a que diverge.
   *
   * Sai tudo, inclusive o balde ainda aberto: a gravação é um UPSERT que
   * **soma**, então o mesmo balde cresce a cada despejo — segurá-lo até fechar
   * atrasaria a tela em até 15 minutos sem ganhar exatidão nenhuma.
   *
   * Esvaziar o mapa antes de gravar é de propósito: a gravação é disparada do
   * caminho quente e o que chegar durante ela entra no despejo seguinte, em vez
   * de ir duas vezes. Perder um lote numa falha do banco é o mesmo prejuízo já
   * aceito para `request_count`.
   *
   * O `metodosDoBalde` da entrada **não** é esvaziado aqui: ele acompanha o
   * balde, não o despejo, e é disso que o teto depende (`MAX_METHODS_PER_ENTRY`).
   */
  function colherChamadas(entry: Entry): McpCallBucketInput[] {
    if (entry.calls.size === 0) return [];
    const items: McpCallBucketInput[] = [];
    for (const [method, baldes] of entry.calls) {
      for (const [balde, calls] of baldes) {
        items.push({
          bucket: new Date(balde).toISOString(),
          virtualMcpUuid: entry.scope.virtualMcpUuid,
          virtualMcpSlug: entry.scope.virtualMcpSlug,
          transport: entry.transport,
          method,
          calls,
        });
      }
    }
    entry.calls.clear();
    return items;
  }

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
    // O intervalo anda **antes** do primeiro `await`, e não depois do último.
    // O despejo sai do caminho quente (`touch`) e a soma das chamadas é um
    // `INSERT` multilinha: sob contenção ela espera o timeout do banco inteiro.
    // Com a marca só no fim, `entry.lastFlush` seguia velho durante toda a
    // espera e **cada** requisição que chegasse via o intervalo vencido e
    // disparava outro despejo da mesma entrada — a tempestade de `INSERT`
    // concorrentes que alimenta o deadlock em `mcp_call_counters`.
    // `request_count` não muda: `entry.pending` continua sendo lido depois do
    // `await entry.id`, então o que chegar durante o despejo vai neste mesmo
    // toque, como antes.
    entry.lastFlush = now();
    // As chamadas não dependem da linha da sessão — elas vão ao banco mesmo
    // quando o `INSERT` dela falhou —, então são colhidas antes de qualquer
    // `await`: o que chegar enquanto a soma está em voo fica para o despejo
    // seguinte, no balde certo.
    const chamadas = colherChamadas(entry);
    if (chamadas.length > 0) await store.bumpMcpCallCounters(chamadas).catch(warn('não foi possível somar as chamadas'));
    if (entry.pending === 0 && !entry.clientDirty) return;
    const id = await entry.id;
    if (!id) {
      // Sem linha não há toque; o intervalo já andou lá em cima, que é o que
      // impede cada requisição seguinte de despejar as chamadas uma a uma, com
      // um `INSERT` por mensagem.
      entry.pending = 0;
      entry.clientDirty = false;
      return;
    }
    const requests = entry.pending;
    const client = entry.clientDirty ? entry.client : null;
    entry.pending = 0;
    entry.clientDirty = false;
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
    contarChamadas(entry, req);
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
      scope,
      id: store.openMcpSession(baseInput(req, scope, transport, sessionId, client)).catch(warn('não foi possível abrir a sessão')),
      pending: 0,
      lastFlush: now(),
      lastSeen: now(),
      client: client ?? { name: null, version: null },
      clientDirty: false,
      calls: new Map(),
      balde: -1,
      metodosDoBalde: new Set(),
    };
    entries.set(key(transport, sessionId), entry);
    // A requisição que abriu a sessão também traz mensagem — o `initialize`, ou
    // o lote que o trouxe — e ela conta como qualquer outra. No `GET /sse` não
    // há corpo, e aí não há o que contar.
    contarChamadas(entry, req);
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
      // O que ela acumulou vai ao banco antes de ela sumir do mapa: sem isto,
      // as chamadas contadas depois do último despejo morreriam com a entrada
      // (a varredura só as salva quando roda antes desta requisição).
      void flushEntry(existing);
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
      scope,
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
      calls: new Map(),
      balde: -1,
      metodosDoBalde: new Set(),
    };
    entries.set(k, entry);
    statelessEntries += 1;
    contarChamadas(entry, req);
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
