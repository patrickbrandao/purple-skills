import type { Request } from 'express';
import { closeDb, getDb, resolveDefaultVirtualMcp, waitForDatabase } from '@purple-skills/db';
import { readTextEnv } from '@purple-skills/shared';
import { rootAuth, virtualAuth } from './auth.js';
import { assertNoLegacyAuthEnv, config } from './config.js';
import { registrarDownloads } from './downloads.js';
import { SESSION_TTL_MS, createHttpApp, type McpApp } from './http.js';
import { createMcpServer } from './server.js';
import { createSessionTracker, type SessionScope } from './sessions.js';
import type { VirtualScope } from './tools.js';

/**
 * O escopo do vMCP desta requisição — `rootAuth` ou `virtualAuth` já o
 * resolveu em `req.virtual`.
 *
 * A base das URLs de download vem de `MCP_PUBLIC_URL`; sem ela, da própria
 * requisição, respeitando o proxy (`trust proxy`). `req.baseUrl` é o prefixo
 * do ponto de montagem já resolvido: vazio na raiz, `/virtual/<slug>` no
 * outro — o mesmo vMCP ganha URLs sob o caminho por onde foi chamado.
 */
function escopoDe(req: Request): VirtualScope {
  const origem = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return { mcp: req.virtual!.mcp, baseUrl: `${origem}${req.baseUrl}` };
}

/**
 * O que a contabilidade de sessões precisa saber da requisição: o vMCP e a
 * credencial, lidos da identidade que `auth.ts` montou (`virtual:<uuid>:open`
 * ou `virtual:<uuid>:key:<id>`).
 */
function escopoDaSessao(req: Request): SessionScope | undefined {
  const caller = req.virtual;
  if (!caller) return undefined;
  const keyMatch = /:key:([^:]+)$/.exec(caller.identity);
  return {
    virtualMcpUuid: caller.mcp.uuid,
    virtualMcpSlug: caller.mcp.slug,
    auth: keyMatch ? 'key' : 'open',
    keyId: keyMatch?.[1] ?? null,
  };
}

/** O que `GET /` anuncia sobre a raiz: qual vMCP responde nela, ou por que nenhum. */
async function descreverRaiz(): Promise<Record<string, unknown>> {
  const resolved = await resolveDefaultVirtualMcp();
  if (resolved.status === 'ok') {
    return {
      defaultMcp: {
        status: 'ok',
        slug: resolved.mcp.slug,
        name: resolved.mcp.name,
        auth: resolved.mcp.isOpen ? 'open' : 'key',
      },
    };
  }
  return { defaultMcp: { status: resolved.status, slug: resolved.slug, auth: null } };
}

async function main() {
  // Falha rápido com as variáveis do antigo MCP principal ainda definidas.
  assertNoLegacyAuthEnv();

  const sessions = createSessionTracker({
    scopeOf: escopoDaSessao,
    onlineWindowMs: config.onlineWindowMs,
    sessionTtlMs: SESSION_TTL_MS,
  });

  const app = createHttpApp({
    sessions,
    mounts: [
      {
        basePath: '',
        auth: rootAuth,
        createServer: (req) => createMcpServer(escopoDe(req)),
        identityOf: (req) => req.virtual?.identity,
        routes: registrarDownloads(rootAuth),
      },
      {
        basePath: '/virtual/:slug',
        auth: virtualAuth,
        createServer: (req) => createMcpServer(escopoDe(req)),
        identityOf: (req) => req.virtual?.identity,
        routes: registrarDownloads(virtualAuth),
      },
    ],
    // As ferramentas públicas recebem slug, termo de busca e paginação: alguns
    // bytes. 1 MB já é folga larga.
    jsonLimit: readTextEnv('MCP_JSON_LIMIT', '1mb'),
    openCors: true,
    info: {
      name: config.serverName,
      version: config.version,
      description:
        'MCP público do Purple Skills — o MCP virtual padrão desta instalação em /mcp, ' +
        'e os demais em /virtual/<slug>/mcp.',
    },
    describe: descreverRaiz,
  }) as McpApp;

  const { pool } = getDb();
  await waitForDatabase(pool);

  const server = app.listen(config.port, config.host, async () => {
    console.log(`[mcp-public] ouvindo em http://${config.host}:${config.port}`);
    console.log('[mcp-public] transportes: /mcp, /mcp/stateless, /sse + /messages');
    console.log('[mcp-public] MCPs virtuais: /virtual/<slug>/mcp (chave psv_ ou aberto, por MCP)');
    console.log(`[mcp-public] sessões: gravadas em mcp_sessions; online = atividade nos últimos ${Math.round(config.onlineWindowMs / 1000)} s`);

    const resolved = await resolveDefaultVirtualMcp().catch(() => null);
    if (resolved?.status === 'ok') {
      console.log(
        `[mcp-public] raiz (/mcp): MCP virtual "${resolved.mcp.slug}" (${
          resolved.mcp.isOpen ? 'aberto' : 'exige chave psv_'
        })`,
      );
    } else {
      console.warn(
        `[mcp-public] raiz (/mcp) responde 404: ${
          resolved?.status === 'inactive'
            ? `o MCP padrão "${resolved.slug}" está desligado`
            : resolved?.status === 'deleted'
              ? 'o MCP padrão foi removido'
              : 'nenhum MCP padrão configurado'
        } — escolha um em Configurações, no painel`,
      );
    }
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
