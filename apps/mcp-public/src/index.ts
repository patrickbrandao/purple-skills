import type { Request } from 'express';
import { closeDb, getDb, waitForDatabase } from '@purple-skills/db';
import { readTextEnv } from '@purple-skills/shared';
import { optionalAuth, virtualAuth } from './auth.js';
import { config, publicKey } from './config.js';
import { registrarDownloads } from './downloads.js';
import { createHttpApp, type McpApp } from './http.js';
import { createMcpServer } from './server.js';
import type { VirtualScope } from './tools.js';

/**
 * O escopo do MCP virtual desta requisição — `virtualAuth` já o resolveu.
 *
 * A base das URLs de download vem de `MCP_PUBLIC_URL`; sem ela, da própria
 * requisição, respeitando o proxy (`trust proxy`).
 */
function escopoDe(req: Request): VirtualScope {
  const origem = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  const mcp = req.virtual!.mcp;
  return { mcp, baseUrl: `${origem}/virtual/${encodeURIComponent(mcp.slug)}` };
}

async function main() {
  const requiresAuth = Boolean(publicKey());

  const app = createHttpApp({
    mounts: [
      {
        basePath: '',
        auth: optionalAuth,
        createServer: () => createMcpServer(),
        // Com `MCP_PUBLIC_KEY` todo cliente é o mesmo cliente; sem ela, idem.
        identityOf: () => undefined,
      },
      {
        basePath: '/virtual/:slug',
        auth: virtualAuth,
        createServer: (req) => createMcpServer(escopoDe(req)),
        identityOf: (req) => req.virtual?.identity,
        routes: registrarDownloads,
      },
    ],
    // As ferramentas públicas recebem slug, termo de busca e paginação: alguns
    // bytes. 1 MB já é folga larga.
    jsonLimit: readTextEnv('MCP_JSON_LIMIT', '1mb'),
    openCors: true,
    info: {
      name: config.serverName,
      version: config.version,
      description: 'MCP público do Purple Skills — busca e download de skills.',
      requiresAuth,
    },
  }) as McpApp;

  const { pool } = getDb();
  await waitForDatabase(pool);

  const server = app.listen(config.port, config.host, () => {
    console.log(`[mcp-public] ouvindo em http://${config.host}:${config.port}`);
    console.log(`[mcp-public] autenticação: ${requiresAuth ? 'Bearer obrigatório' : 'aberta'}`);
    console.log('[mcp-public] transportes: /mcp, /mcp/stateless, /sse + /messages');
    console.log('[mcp-public] MCPs virtuais: /virtual/<slug>/mcp (chave psv_ ou aberto, por MCP)');
  });

  const shutdown = async (signal: string) => {
    console.log(`[mcp-public] recebido ${signal}, encerrando…`);
    await app.closeSessions();
    server.close(() => void 0);
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[mcp-public] falha ao iniciar:', err);
  process.exit(1);
});
