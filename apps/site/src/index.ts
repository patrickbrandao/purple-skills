import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { closeDb, getDb, waitForDatabase } from '@purple-skills/db';
import { trustProxySetting } from '@purple-skills/shared';
import { api } from './api.js';
import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Assets da SPA: `dist-web/` ao lado de `dist/` (build) ou de `src/` (dev). */
const webRoot = resolve(here, '..', 'dist-web');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', trustProxySetting());
app.use(compression());
// API pública: qualquer origem pode consumir como alternativa ao MCP.
app.use(cors({ origin: '*', methods: ['GET', 'HEAD', 'OPTIONS'] }));
// Sem `express.json`: todas as rotas do site são GET. Um parser de corpo aberto
// a qualquer anônimo seria memória oferecida sem nenhum consumidor.

// Nada servido pelo site deve ser interpretado por sniffing de conteúdo.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(api);

if (existsSync(webRoot)) {
  app.use(
    express.static(webRoot, {
      index: false,
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders: (res, path) => {
        if (path.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  // Fallback da SPA — rotas do React Router caem no index.html.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(webRoot, 'index.html'));
  });
} else {
  console.warn(`[site] SPA não encontrada em ${webRoot} — rode "npm run build:web"`);
}

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `Rota não encontrada: ${req.path}` });
});

async function main() {
  const { pool } = getDb();
  await waitForDatabase(pool);

  const server = app.listen(config.port, config.host, () => {
    console.log(`[site] ${config.siteName} ouvindo em http://${config.host}:${config.port}`);
    console.log(`[site] URL pública: ${config.siteBaseUrl}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[site] recebido ${signal}, encerrando…`);
    server.close(() => void 0);
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[site] falha ao iniciar:', err);
  process.exit(1);
});
