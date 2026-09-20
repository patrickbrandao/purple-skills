import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';
import { recordSkillAccess } from '@purple-skills/db';
import type { SkillAccessInput, SkillAccessKind, SkillAccessSurface } from '@purple-skills/shared';

/**
 * O registro por leitura (`docs/13-fichas-e-acessos.md`): cada `get_skill`,
 * resource, prompt, SKILL.md avulso e pacote servido por um vMCP vira uma
 * linha em `skill_accesses`, com quem leu — a chave `psv_` ou "aberto" —,
 * de onde e com que cliente. O banco soma os contadores na mesma escrita.
 *
 * O contexto nasce com a requisição autenticada (`req.virtual`) e viaja no
 * escopo do servidor MCP; o que só se conhece depois do `initialize` — o
 * `clientInfo` e o id da sessão do transporte — chega por getters que o
 * `server.ts` liga ao `McpServer`. A **origem** (IP e agente) é a exceção: vem
 * da requisição em curso, por `comOrigem`, porque numa sessão o escopo é a foto
 * de quem a abriu.
 */
export type AccessContext = {
  auth: 'open' | 'key';
  keyId: string | null;
  ip?: string;
  userAgent?: string;
  /** Conhecida na criação: a chave sintética do stateless. Nos transportes com sessão, vem de `transportSessionId`. */
  sessionId?: string;
  /** O `clientInfo` do cliente, depois do `initialize`. */
  client?: () => { name?: string; version?: string } | undefined;
  /** O `mcp-session-id` (Streamable) ou o `sessionId` do SSE, depois do `initialize`. */
  transportSessionId?: () => string | undefined;
};

/** A credencial e a origem de uma requisição já autenticada por `rootAuth`/`virtualAuth`. */
export function accessContextOf(req: Request): AccessContext {
  const keyMatch = /:key:([^:]+)$/.exec(req.virtual?.identity ?? '');
  return {
    auth: keyMatch ? 'key' : 'open',
    keyId: keyMatch?.[1] ?? null,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? undefined,
  };
}

/**
 * De onde veio a requisição **em curso**.
 *
 * Numa sessão MCP o servidor é construído uma vez — no `initialize`, ou no
 * `GET /sse` — e o `AccessContext` é a foto daquele instante: sem isto, toda
 * leitura da sessão sairia com o IP e o agente de quem a abriu, mesmo chegando
 * de outro endereço. É o par do `comCaller` do mcp-admin. Aqui só a origem
 * precisa viajar: a credencial não muda dentro da sessão, porque o `http.ts`
 * responde 403 a qualquer outra.
 */
const origem = new AsyncLocalStorage<Pick<AccessContext, 'ip' | 'userAgent'>>();

/** Despacha a requisição com a origem dela no contexto. */
export function comOrigem(req: Request, run: () => Promise<void>): Promise<void> {
  return origem.run({ ip: req.ip, userAgent: req.get('user-agent') ?? undefined }, run);
}

/**
 * Grava o acesso sem segurar a resposta: o registro é melhor esforço, como
 * os contadores sempre foram — um INSERT lento ou recusado vai para o log e
 * não nega nem atrasa a leitura.
 */
export function registrarAcesso(
  scope: { mcp: { uuid: string }; access?: AccessContext },
  skillUuid: string,
  kind: SkillAccessKind,
  surface: SkillAccessSurface,
): void {
  const access = scope.access;
  const client = access?.client?.();
  // Lida **aqui**, de forma síncrona, e não dentro do `.then` abaixo: é o que
  // garante que a leitura acontece dentro do despacho. Fora de um despacho de
  // transporte — as rotas de download, que montam o escopo com a própria
  // requisição, ou um teste — vale a origem do escopo, que é como era antes.
  const de = origem.getStore() ?? access;
  const input: SkillAccessInput = {
    skillUuid,
    kind,
    surface,
    origin: 'mcp',
    auth: access?.auth ?? 'open',
    virtualMcpUuid: scope.mcp.uuid,
    keyId: access?.keyId ?? undefined,
    sessionId: access?.sessionId ?? access?.transportSessionId?.(),
    ip: de?.ip,
    userAgent: de?.userAgent,
    clientName: client?.name,
    clientVersion: client?.version,
  };
  Promise.resolve()
    .then(() => recordSkillAccess(input))
    .catch((err: unknown) => {
      console.warn('[mcp-public] não foi possível registrar o acesso:', (err as Error).message);
    });
}
