import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import { closeDb, getDb, waitForDatabase } from '@purple-skills/db';
import { api } from './api.js';
import { config, getAdminPassword } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..', 'dist-web');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: '32mb' }));

// Painel é sempre same-origin: nada de CORS aberto aqui.
app.use((_req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(api);

if (existsSync(webRoot)) {
  app.use(express.static(webRoot, { index: false, maxAge: config.isProduction ? '1h' : 0 }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(webRoot, 'index.html'));
  });
} else {
  console.warn(`[admin] SPA não encontrada em ${webRoot} — rode "npm run build:web"`);
}

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `Rota não encontrada: ${req.path}` });
});

async function main() {
  // Falha rápido se a senha do admin não estiver configurada.
  getAdminPassword();

  const { pool } = getDb();
  await waitForDatabase(pool);

  const server = app.listen(config.port, config.host, () => {
    console.log(`[admin] painel ouvindo em http://${config.host}:${config.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[admin] recebido ${signal}, encerrando…`);
    server.close(() => void 0);
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[admin] falha ao iniciar:', err.message);
  process.exit(1);
});
