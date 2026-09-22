import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { getApiKeyByPrefix, getUserByUuid, touchApiKey } from '@purple-skills/db';
import {
  TOKEN_ACTOR,
  type AuditActor,
  type Role,
  bearerToken,
  parseApiKey,
  safeEqual,
  verifyApiKeySecret,
} from '@purple-skills/shared';
import { adminToken } from './config.js';

/**
 * Quem está do outro lado da conexão MCP.
 *
 * Duas credenciais valem (`docs/05-accounts-and-roles.md` §2.5):
 *
 * | Credencial              | Ator no audit  | Papel        |
 * |-------------------------|----------------|--------------|
 * | `MCP_ADMIN_TOKEN`       | `token-global` | `admin`      |
 * | `psk_<prefixo>_<segredo>` | o usuário dono | o papel dele |
 *
 * O token global continua valendo de propósito: torná-lo inerte ao criar o
 * primeiro usuário derrubaria todo agente já configurado.
 */
export type Caller = {
  actor: AuditActor;
  role: Role;
  /** Identidade estável — prende uma sessão MCP à credencial que a abriu. */
  identity: string;
  /** A chave `psk_` usada, para o registro de acessos; nula no token global. */
  apiKeyId?: string | null;
  /** De onde a conexão veio, para o registro de acessos. */
  ip?: string;
  userAgent?: string;
};

declare module 'express-serve-static-core' {
  interface Request {
    caller?: Caller;
  }
}

export const TOKEN_CALLER: Caller = {
  actor: TOKEN_ACTOR,
  role: 'admin',
  identity: 'token-global',
};

export async function resolveCaller(req: Request): Promise<Caller | null> {
  const provided = bearerToken(req.header('authorization'));
  if (!provided) return null;

  // Chave de usuário: achada pelo prefixo (indexado), conferida por hash.
  const parsed = parseApiKey(provided);
  if (parsed) {
    const record = await getApiKeyByPrefix(parsed.prefix);
    if (!record || record.revokedAt) return null;
    if (!verifyApiKeySecret(parsed.secret, record.keyHash)) return null;

    const user = await getUserByUuid(record.userUuid);
    if (!user || !user.isActive) return null;

    // `last_used_at` é informativo: uma falha aqui não pode negar o acesso.
    void touchApiKey(record.id).catch((err) => {
      console.warn('[mcp-admin] não foi possível marcar o uso da chave:', err.message);
    });

    return {
      actor: { userUuid: user.uuid, label: user.username },
      role: user.role,
      identity: `key:${record.id}`,
      apiKeyId: record.id,
      ip: req.ip,
      userAgent: req.get('user-agent') ?? undefined,
    };
  }

  return safeEqual(provided, adminToken()) ? { ...TOKEN_CALLER, ip: req.ip, userAgent: req.get('user-agent') ?? undefined } : null;
}

/** Autenticação obrigatória por Bearer token no MCP administrativo. */
export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  resolveCaller(req)
    .then((caller) => {
      if (!caller) {
        res.status(401).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message:
              'Não autorizado: informe Authorization: Bearer <MCP_ADMIN_TOKEN> ou uma chave psk_…',
          },
          id: null,
        });
        return;
      }
      req.caller = caller;
      next();
    })
    .catch((err) => next(err));
}

/**
 * A credencial da requisição em curso.
 *
 * Numa sessão MCP o servidor é construído **uma vez**, no `initialize`, e os
 * handlers fechariam sobre o `Caller` daquele instante: papel, ator, IP e
 * agente ficariam congelados até a sessão cair. `resolveCaller` já roda a cada
 * requisição e já relê a chave e a conta no banco — este contexto é o que leva
 * o resultado dessa releitura até as tools, em vez de descartá-lo. Sem ele,
 * rebaixar uma conta no painel não tirava o poder de quem já estava conectado
 * (e o audit registrava sempre o IP da primeira requisição).
 */
const contexto = new AsyncLocalStorage<Caller>();

/** Despacha a requisição com a credencial dela no contexto. */
export function comCaller(req: Request, run: () => Promise<void>): Promise<void> {
  return req.caller ? contexto.run(req.caller, run) : run();
}

/**
 * A credencial da requisição em curso; `padrao` fora de uma requisição — o
 * `Caller` do `initialize`, que é como era antes deste contexto existir.
 */
export function callerAtual(padrao: Caller): Caller {
  return contexto.getStore() ?? padrao;
}
