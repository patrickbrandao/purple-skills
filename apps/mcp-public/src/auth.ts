import type { NextFunction, Request, Response } from 'express';
import { bearerToken, safeEqual } from '@purple-skills/shared';
import { publicKey } from './config.js';

/**
 * Autenticação opcional. Sem `MCP_PUBLIC_KEY` definida o servidor é aberto —
 * é o modo padrão, já que o objetivo é ser consumido por qualquer agente.
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

  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Não autorizado: informe Authorization: Bearer <MCP_PUBLIC_KEY>' },
    id: null,
  });
}
