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
      actor: { userUuid: user.uuid, label: user.email },
      role: user.role,
      identity: `key:${record.id}`,
    };
  }

  return safeEqual(provided, adminToken()) ? TOKEN_CALLER : null;
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
