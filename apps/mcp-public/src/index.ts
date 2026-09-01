import { closeDb, getDb, waitForDatabase } from '@purple-skills/db';
import { optionalAuth } from './auth.js';
import { config, publicKey } from './config.js';
import { createHttpApp, type McpApp } from './http.js';
import { createMcpServer } from './server.js';

async function main() {
  const requiresAuth = Boolean(publicKey());

  const app = createHttpApp({
    createServer: createMcpServer,
    auth: optionalAuth,
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
