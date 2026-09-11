import type { NextFunction, Request, Response } from 'express';
import {
  getPublicMcpKeyByPrefix,
  getVirtualMcpKeyByPrefix,
  resolveVirtualMcp,
  touchPublicMcpKey,
  touchVirtualMcpKey,
  type VirtualMcpRuntime,
} from '@purple-skills/db';
import {
  PUBLIC_KEY_SCHEME,
  VIRTUAL_KEY_SCHEME,
  bearerToken,
  parseApiKey,
  safeEqual,
  verifyApiKeySecret,
} from '@purple-skills/shared';
import { publicAuthMode, publicKey } from './config.js';

const unauthorized = (res: Response, message: string) => {
  res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
};

// ----------------------------------------------------------- principal ---

/**
 * Quem está falando com o MCP principal, e a identidade que prende a sessão.
 *
 * `identity` é `undefined` no modo aberto (todo anônimo é o mesmo anônimo),
 * `public:env` para a `MCP_PUBLIC_KEY` (todo portador dela é o mesmo cliente)
 * e `public:key:<id>` para uma chave `psp_` gerenciada.
 */
export type PublicCaller = { identity: string | undefined };

declare module 'express-serve-static-core' {
  interface Request {
    public?: PublicCaller;
  }
}

export async function resolvePublicCaller(req: Request): Promise<PublicCaller | null> {
  const mode = publicAuthMode();
  if (mode === 'open') return { identity: undefined };

  const provided = bearerToken(req.header('authorization'));
  if (provided === null) return null;

  // A chave da env vale nos modos `key` e `managed`. Mesma política do MCP
  // admin e do painel: comparação em tempo constante.
  const expected = publicKey();
  if (expected && safeEqual(provided, expected)) return { identity: 'public:env' };
  if (mode === 'key') return null;

  // `managed`: chave psp_ achada pelo prefixo (indexado), conferida por hash.
  const parsed = parseApiKey(provided, PUBLIC_KEY_SCHEME);
  if (!parsed) return null;

  const record = await getPublicMcpKeyByPrefix(parsed.prefix);
  if (!record || record.revokedAt) return null;
  if (!verifyApiKeySecret(parsed.secret, record.keyHash)) return null;

  // `last_used_at` é informativo: uma falha aqui não pode negar o acesso.
  void touchPublicMcpKey(record.id).catch((err) => {
    console.warn('[mcp-public] não foi possível marcar o uso da chave:', err.message);
  });

  return { identity: `public:key:${record.id}` };
}

/** Autenticação do MCP principal, conforme `MCP_PUBLIC_AUTH`. */
export function publicAuth(req: Request, res: Response, next: NextFunction): void {
  resolvePublicCaller(req)
    .then((caller) => {
      if (!caller) {
        unauthorized(
          res,
          publicAuthMode() === 'managed'
            ? 'Não autorizado: informe Authorization: Bearer <chave psp_… ou MCP_PUBLIC_KEY>'
            : 'Não autorizado: informe Authorization: Bearer <MCP_PUBLIC_KEY>',
        );
        return;
      }
      req.public = caller;
      next();
    })
    .catch((err) => next(err));
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
