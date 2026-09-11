import type { NextFunction, Request, Response } from 'express';
import {
  getVirtualMcpKeyByPrefix,
  resolveVirtualMcp,
  touchVirtualMcpKey,
  type VirtualMcpRuntime,
} from '@purple-skills/db';
import {
  VIRTUAL_KEY_SCHEME,
  bearerToken,
  parseApiKey,
  safeEqual,
  verifyApiKeySecret,
} from '@purple-skills/shared';
import { publicKey } from './config.js';

const unauthorized = (res: Response, message: string) => {
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
};

/**
 * Autenticação opcional do MCP principal. Sem `MCP_PUBLIC_KEY` definida o
 * servidor é aberto — é o modo padrão, já que o objetivo é ser consumido por
 * qualquer agente.
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = publicKey();
  if (!expected) {
    next();
    return;
  }

  const provided = bearerToken(req.header('authorization'));
  // Mesma política do MCP admin e do painel: comparação em tempo constante.
  if (provided !== null && safeEqual(provided, expected)) {
    next();
    return;
  }

  unauthorized(res, 'Não autorizado: informe Authorization: Bearer <MCP_PUBLIC_KEY>');
}

// ------------------------------------------------------------ MCP virtual ---

/**
 * O MCP virtual resolvido para esta requisição, e a identidade que prende a
 * sessão a ele (`docs/08-mcp-virtual.md` §5).
 *
 * `identity` embute o MCP **e** a chave: uma sessão aberta com a chave A do
 * virtual X não responde à chave B do mesmo X, nem a qualquer chave de Y.
 * Num virtual aberto a identidade é só o MCP — todo anônimo é o mesmo
 * anônimo, como no principal.
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
 * Resolve `/virtual/:slug/*` em um MCP virtual autenticado.
 *
 * As recusas são **distintas** de propósito (decisão 17 de `08`): slug que
 * não existe ou MCP desligado respondem 404; MCP que exige chave e não a
 * recebeu, chave revogada ou chave de **outro** virtual respondem 401. O
 * diagnóstico para quem configura o `mcp.json` valeu mais que esconder quais
 * slugs existem.
 *
 * A consulta é por requisição, sem cache, como toda leitura do MCP público:
 * desligar o MCP ou revogar a chave vale na chamada seguinte.
 */
export async function resolveVirtualCaller(req: Request): Promise<VirtualCaller | 'not-found' | null> {
  const slug = String((req.params as Record<string, unknown>).slug ?? '');
  const mcp = slug ? await resolveVirtualMcp(slug) : null;
  if (!mcp) return 'not-found';

  if (mcp.isOpen) return { mcp, identity: `virtual:${mcp.uuid}:open` };

  const provided = bearerToken(req.header('authorization'));
  const parsed = parseApiKey(provided, VIRTUAL_KEY_SCHEME);
  if (!parsed) return null;

  // Chave achada pelo prefixo (indexado), conferida por hash — e amarrada ao
  // MCP da URL: a chave de um virtual não abre outro (decisão 8 de `08`).
  const record = await getVirtualMcpKeyByPrefix(parsed.prefix);
  if (!record || record.revokedAt || record.virtualMcpUuid !== mcp.uuid) return null;
  if (!verifyApiKeySecret(parsed.secret, record.keyHash)) return null;

  // `last_used_at` é informativo: uma falha aqui não pode negar o acesso.
  void touchVirtualMcpKey(record.id).catch((err) => {
    console.warn('[mcp-public] não foi possível marcar o uso da chave:', err.message);
  });

  return { mcp, identity: `virtual:${mcp.uuid}:key:${record.id}` };
}

export function virtualAuth(req: Request, res: Response, next: NextFunction): void {
  resolveVirtualCaller(req)
    .then((caller) => {
      if (caller === 'not-found') {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32601, message: 'MCP virtual não encontrado' },
          id: null,
        });
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
}
