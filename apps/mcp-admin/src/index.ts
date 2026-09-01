import { closeDb, getDb, waitForDatabase } from '@purple-skills/db';
import { requireBearer } from './auth.js';
import { adminToken, config } from './config.js';
import { createHttpApp, type McpApp } from './http.js';
import { createMcpServer } from './server.js';

async function main() {
  // Falha rápido se o token administrativo não estiver configurado.
  adminToken();

  const app = createHttpApp({
    createServer: createMcpServer,
    auth: requireBearer,
    openCors: false,
    info: {
      name: config.serverName,
      version: config.version,
      description: 'MCP administrativo do Purple Skills — CRUD completo do catálogo.',
      requiresAuth: true,
    },
  }) as McpApp;

  const { pool } = getDb();
  await waitForDatabase(pool);

  const server = app.listen(config.port, config.host, () => {
    console.log(`[mcp-admin] ouvindo em http://${config.host}:${config.port}`);
    console.log('[mcp-admin] autenticação: Bearer obrigatório (MCP_ADMIN_TOKEN)');
    console.log('[mcp-admin] transportes: /mcp, /mcp/stateless, /sse + /messages');
  });

  const shutdown = async (signal: string) => {
    console.log(`[mcp-admin] recebido ${signal}, encerrando…`);
    await app.closeSessions();
    server.close(() => void 0);
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[mcp-admin] falha ao iniciar:', err.message);
  process.exit(1);
});
