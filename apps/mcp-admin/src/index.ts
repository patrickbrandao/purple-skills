import { closeDb, getDb, waitForDatabase } from '@purple-skills/db';
import { readSizeEnv } from '@purple-skills/shared';
import { comCaller, requireBearer } from './auth.js';
import { adminToken, config } from './config.js';
import { createHttpApp, type McpApp } from './http.js';
import { createMcpServer } from './server.js';

async function main() {
  // Falha rápido se o token administrativo não estiver configurado.
  adminToken();

  const app = createHttpApp({
    createServer: (req) => createMcpServer(req.caller),
    auth: requireBearer,
    // A credencial que vale é a da requisição, não a do `initialize`.
    withRequest: comCaller,
    identityOf: (req) => req.caller?.identity,
    // `set_files_bulk` manda ~32 MB de base64; o resto é o envelope JSON-RPC.
    // Lido por `readSizeEnv`: o `bytes` do body-parser lê "48m" como 48 bytes,
    // sem erro, e o serviço subia respondendo 413 a tudo — formato inválido
    // agora derruba o boot. No compose o nome do `.env` é `MCP_ADMIN_JSON_LIMIT`.
    jsonLimit: readSizeEnv('MCP_JSON_LIMIT', '48mb'),
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
    console.log('[mcp-admin] autenticação: Bearer obrigatório (MCP_ADMIN_TOKEN ou chave psk_ de usuário)');
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
