import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  getVirtualMcpKeyByPrefix,
  resolveDefaultVirtualMcp,
  resolveVirtualMcp,
  touchVirtualMcpKey,
  type DefaultMcpResolution,
  type VirtualMcpRuntime,
} from '@purple-skills/db';
import {
  VIRTUAL_KEY_SCHEME,
  bearerToken,
  parseApiKey,
  verifyApiKeySecret,
} from '@purple-skills/shared';

const jsonRpcRefusal = (res: Response, status: number, code: number, message: string) => {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
};

const unauthorized = (res: Response, message: string) => jsonRpcRefusal(res, 401, -32001, message);
const notFound = (res: Response, message: string) => jsonRpcRefusal(res, 404, -32601, message);

/**
 * O MCP virtual resolvido para esta requisição, e a identidade que prende a
 * sessão a ele (`docs/08-mcp-virtual.md` §5).
 *
 * `identity` embute o MCP **e** a chave: uma sessão aberta com a chave A do
 * virtual X não responde à chave B do mesmo X, nem a qualquer chave de Y.
 * Num virtual aberto a identidade é só o MCP — todo anônimo é o mesmo
 * anônimo. A raiz (`/mcp`) é o vMCP padrão e usa a mesma identidade que ele
 * tem em `/virtual/<slug>`: é o mesmo servidor em dois caminhos.
 */
export type VirtualCaller = {
  mcp: VirtualMcpRuntime;
  identity: string;
};

declare module 'express-serve-static-core' {
  interface Request {
    virtual?: VirtualCaller;
  }
}

/**
 * Autentica a requisição contra um vMCP já resolvido: aberto entra sem nada;
 * fechado exige uma chave `psv_` **deste** servidor.
 *
 * A chave é achada pelo prefixo (indexado), conferida por hash e amarrada ao
 * MCP: a chave de um virtual não abre outro (decisão 8 de `08`). Sem cache,
 * como toda leitura do MCP público: revogar a chave vale na chamada seguinte.
 */
export async function authenticateAgainst(
  mcp: VirtualMcpRuntime,
  req: Request,
): Promise<VirtualCaller | null> {
  if (mcp.isOpen) return { mcp, identity: `virtual:${mcp.uuid}:open` };

  const provided = bearerToken(req.header('authorization'));
  const parsed = parseApiKey(provided, VIRTUAL_KEY_SCHEME);
  if (!parsed) return null;

  const record = await getVirtualMcpKeyByPrefix(parsed.prefix);
  if (!record || record.revokedAt || record.virtualMcpUuid !== mcp.uuid) return null;
  if (!verifyApiKeySecret(parsed.secret, record.keyHash)) return null;

  // `last_used_at` é informativo: uma falha aqui não pode negar o acesso.
  void touchVirtualMcpKey(record.id).catch((err) => {
    console.warn('[mcp-public] não foi possível marcar o uso da chave:', err.message);
  });

  return { mcp, identity: `virtual:${mcp.uuid}:key:${record.id}` };
}

// ---------------------------------------------------------- /virtual/:slug ---

/**
 * Resolve `/virtual/:slug/*` em um MCP virtual autenticado.
 *
 * As recusas são **distintas** de propósito (decisão 17 de `08`): slug que
 * não existe ou MCP desligado respondem 404; MCP que exige chave e não a
 * recebeu, chave revogada ou chave de **outro** virtual respondem 401. O
 * diagnóstico para quem configura o `mcp.json` valeu mais que esconder quais
 * slugs existem.
 */
export async function resolveVirtualCaller(req: Request): Promise<VirtualCaller | 'not-found' | null> {
  const slug = String((req.params as Record<string, unknown>).slug ?? '');
  const mcp = slug ? await resolveVirtualMcp(slug) : null;
  if (!mcp) return 'not-found';
  return authenticateAgainst(mcp, req);
}

export const virtualAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  resolveVirtualCaller(req)
    .then((caller) => {
      if (caller === 'not-found') {
        notFound(res, 'MCP virtual não encontrado');
        return;
      }
      if (!caller) {
        unauthorized(res, 'Não autorizado: informe Authorization: Bearer <chave psv_… deste MCP virtual>');
        return;
      }
      req.virtual = caller;
      next();
    })
    .catch((err) => next(err));
};

// -------------------------------------------------------------------- raiz ---

/** Por que a raiz não tem servidor: sem padrão, padrão apagado ou desligado. */
export type RootRefusal = Exclude<DefaultMcpResolution, { status: 'ok' }>;

/**
 * Mensagens da recusa da raiz, uma por causa
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`). Distintas de propósito: quem
 * configura um cliente precisa saber se falta escolher o padrão, se ele foi
 * apagado ou se está desligado — e onde resolver.
 */
export const ROOT_REFUSAL_MESSAGE: Record<RootRefusal['status'], string> = {
  none: 'Nenhum MCP padrão configurado: escolha um MCP virtual em Configurações, no painel',
  deleted: 'O MCP padrão foi removido: escolha outro MCP virtual em Configurações, no painel',
  inactive: 'O MCP padrão está desligado: religue-o ou escolha outro em Configurações, no painel',
};

/**
 * Resolve a raiz (`/mcp`, `/sse`, downloads) no vMCP padrão e autentica
 * contra ele. O padrão é consultado a cada requisição: trocá-lo no painel vale
 * na chamada seguinte, e uma sessão aberta antes da troca deixa de casar com a
 * identidade nova e é recusada até o cliente reconectar.
 */
export async function resolveRootCaller(req: Request): Promise<VirtualCaller | RootRefusal | null> {
  const resolved = await resolveDefaultVirtualMcp();
  if (resolved.status !== 'ok') return resolved;
  return authenticateAgainst(resolved.mcp, req);
}

const isRefusal = (value: VirtualCaller | RootRefusal): value is RootRefusal => 'status' in value;

export const rootAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  resolveRootCaller(req)
    .then((caller) => {
      if (!caller) {
        unauthorized(res, 'Não autorizado: informe Authorization: Bearer <chave psv_… do MCP padrão>');
        return;
      }
      if (isRefusal(caller)) {
        notFound(res, ROOT_REFUSAL_MESSAGE[caller.status]);
        return;
      }
      req.virtual = caller;
      next();
    })
    .catch((err) => next(err));
};
