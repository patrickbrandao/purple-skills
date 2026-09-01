import type { NextFunction, Request, Response } from 'express';
import { bearerToken, safeEqual } from '@purple-skills/shared';
import { adminToken } from './config.js';

/** Autenticação obrigatória por Bearer token no MCP administrativo. */
export function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const provided = bearerToken(req.header('authorization'));

  if (provided && safeEqual(provided, adminToken())) {
    next();
    return;
  }

  res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: 'Não autorizado: informe Authorization: Bearer <MCP_ADMIN_TOKEN>',
    },
    id: null,
  });
}
