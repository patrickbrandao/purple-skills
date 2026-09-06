import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import { closeDb, countUsers, getDb, waitForDatabase } from '@purple-skills/db';
import { trustProxySetting } from '@purple-skills/shared';
import { api } from './api.js';
import { config, getAdminPassword, getSessionSecret, oidcEnabled, smtpEnabled } from './config.js';
import { onError } from './errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..', 'dist-web');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', trustProxySetting());
app.use(compression());
app.use(cookieParser());
// `express.json` é montado dentro do roteador da API, depois da checagem de
// sessão: ler 32 MB antes de saber quem está chamando é memória de graça.

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

// Erros de middleware (multer, express.json) não passam pelo `route()` da API.
app.use(onError);

async function main() {
  // Falha rápido se não houver como assinar o cookie de sessão (segredo
  // próprio ou, na falta dele, a senha de bootstrap para derivar).
  getSessionSecret();

  const { pool } = getDb();
  await waitForDatabase(pool);

  // A ADMIN_PASSWORD deixou de ser obrigatória: ela só cria o primeiro
  // administrador. Sem conta nenhuma e sem senha, porém, não há como entrar —
  // isso é erro de configuração, não uma instalação vazia legítima.
  const users = await countUsers();
  if (users === 0 && !getAdminPassword()) {
    throw new Error(
      'Nenhuma conta cadastrada e ADMIN_PASSWORD ausente: não há como criar o ' +
        'primeiro administrador. Defina ADMIN_PASSWORD (ou ADMIN_PASSWORD_FILE) e suba de novo.',
    );
  }
  if (users === 0) {
    console.log('[admin] nenhuma conta ainda — abra o painel e crie o primeiro administrador');
  }
  console.log(`[admin] SSO: ${oidcEnabled() ? 'ligado' : 'desligado'}; ` +
    `redefinição de senha por e-mail: ${smtpEnabled() ? 'ligada' : 'desligada'}`);

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
