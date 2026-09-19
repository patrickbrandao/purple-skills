import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import express from 'express';
import {
  GOOGLE_FONTS_FILES,
  GOOGLE_FONTS_STYLE,
  securityHeaders,
  trustProxySetting,
} from '@purple-skills/shared';
import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Assets da página: `dist-web/` ao lado de `dist/` (build) ou de `src/` (dev). */
const webRoot = resolve(here, '..', 'dist-web');
/**
 * A página servida, lida uma vez no boot: dela sai o hash do `<script>` de tema
 * que entra na CSP. Em desenvolvimento quem serve é o Vite, então ausente é
 * normal.
 */
const indexHtml = existsSync(join(webRoot, 'index.html'))
  ? readFileSync(join(webRoot, 'index.html'), 'utf8')
  : undefined;

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', trustProxySetting());
app.use(compression());
// Sem CORS e sem parser de corpo: a homepage não expõe API nenhuma.

// Página estática, mas ainda assim um documento: sem CSP e sem defesa contra
// enquadramento ela é embutível por qualquer domínio, e um XSS futuro não teria
// nada limitando a exfiltração.
const pageHeaders = securityHeaders({
  html: indexHtml,
  styleSources: [GOOGLE_FONTS_STYLE],
  fontSources: [GOOGLE_FONTS_FILES],
});
app.use((_req, res, next) => {
  for (const [nome, valor] of Object.entries(pageHeaders)) res.setHeader(nome, valor);
  next();
});

// Sonda de saúde: como não há banco, estar de pé já é estar saudável.
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

if (existsSync(webRoot)) {
  app.use(
    express.static(webRoot, {
      index: false,
      maxAge: config.isProduction ? '1h' : 0,
      setHeaders: (res, path) => {
        // Bundles do Vite trazem hash no nome — podem ser eternos. Imagens e
        // fontes de `public/assets` mantêm o nome entre builds, então uma
        // troca de logo levaria um ano para chegar a quem já visitou.
        if (/\/assets\/(images|fonts)\//.test(path)) {
          res.setHeader('Cache-Control', 'public, max-age=604800');
        } else if (path.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  // Página única: qualquer caminho cai no index.html.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.sendFile(join(webRoot, 'index.html'));
  });
} else {
  console.warn(`[homepage] página não encontrada em ${webRoot} — rode "npm run build:web"`);
}

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `Rota não encontrada: ${req.path}` });
});

const server = app.listen(config.port, config.host, () => {
  console.log(`[homepage] ouvindo em http://${config.host}:${config.port}`);
});

const shutdown = (signal: string) => {
  console.log(`[homepage] recebido ${signal}, encerrando…`);
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
