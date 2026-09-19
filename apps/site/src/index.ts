import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { closeDb, getDb, waitForDatabase } from '@purple-skills/db';
import {
  GOOGLE_FONTS_FILES,
  GOOGLE_FONTS_STYLE,
  createRateLimiter,
  rateLimitKey,
  readIntEnv,
  readTextEnv,
  securityHeaders,
  trustProxySetting,
} from '@purple-skills/shared';
import { api } from './api.js';
import { config } from './config.js';
import { avisoDeBoot } from './rag.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Assets da SPA: `dist-web/` ao lado de `dist/` (build) ou de `src/` (dev). */
const webRoot = resolve(here, '..', 'dist-web');
/**
 * O `index.html` servido, lido uma vez no boot: dele sai o hash do `<script>`
 * de tema que entra na CSP. Em desenvolvimento a página vem do Vite, e nenhuma
 * resposta daqui é documento — por isso ausente é normal.
 */
const indexHtml = existsSync(join(webRoot, 'index.html'))
  ? readFileSync(join(webRoot, 'index.html'), 'utf8')
  : undefined;

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', trustProxySetting());
app.use(compression());
// API pública: qualquer origem pode consumir como alternativa ao MCP — é o
// padrão. Uma instalação alcançável só pela rede interna fecha com
// `SITE_CORS_ORIGIN` (uma origem, ou uma lista separada por vírgula), porque
// com `*` a rede deixa de proteger: um site externo aberto por quem trabalha
// lá lê o catálogo usando o navegador da vítima como ponte. Lido aqui, e não
// no `config.ts`, porque é a única coisa que essa variável configura.
const corsOrigin = readTextEnv('SITE_CORS_ORIGIN', '*');
app.use(
  cors({
    origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((origem) => origem.trim()),
    methods: ['GET', 'HEAD', 'OPTIONS'],
  }),
);
// Sem `express.json`: todas as rotas do site são GET. Um parser de corpo aberto
// a qualquer anônimo seria memória oferecida sem nenhum consumidor.

// Nada servido pelo site deve ser interpretado por sniffing de conteúdo — e a
// página que renderiza SKILL.md de terceiros merece a mesma defesa que os
// arquivos avulsos já tinham: a CSP vale para o documento, não só para o que
// desce dele. As rotas de arquivo de skill sobrescrevem a CSP com a sua, mais
// fechada.
const pageHeaders = securityHeaders({
  html: indexHtml,
  styleSources: [GOOGLE_FONTS_STYLE],
  fontSources: [GOOGLE_FONTS_FILES],
});
app.use((_req, res, next) => {
  for (const [nome, valor] of Object.entries(pageHeaders)) res.setHeader(nome, valor);
  next();
});

/**
 * Limite de taxa por IP da superfície anônima.
 *
 * Sem ele, cada leitura de ficha grava uma linha permanente em `skill_accesses`
 * (a decisão do banco é "nunca apagar") e cada busca pode mandar a consulta ao
 * provedor de embeddings, que é pago — quem escolhia o volume das duas coisas
 * era o visitante anônimo, de graça.
 *
 * O teto é generoso de propósito: quem navega o site é **pessoa**, muitas vezes
 * atrás de um NAT que concentra o escritório inteiro num IP só. 240 por minuto
 * (4 por segundo sustentados) sobra para uma sala cheia navegando junto e ainda
 * corta três ordens de grandeza de um robô. `SITE_RATE_LIMIT_MAX=0` desliga,
 * para quem já limita no proxy.
 *
 * Fora da conta: `/healthz`, porque um 429 ali faria o orquestrador reiniciar um
 * container saudável, e `/assets/`, que é arquivo em disco com cache longo — é
 * o grosso de um carregamento de página e não toca o banco. O que sobra na
 * conta é justamente o que custa: as rotas `/api/*`, os arquivos de skill e os
 * downloads.
 */
const limiteMax = readIntEnv('SITE_RATE_LIMIT_MAX', 240, { min: 0 });
const foraDoLimite = /^\/(?:healthz$|assets\/)/;
if (limiteMax > 0) {
  const limite = createRateLimiter({ max: limiteMax, windowSeconds: 60 });
  app.use((req, res, next) => {
    if (foraDoLimite.test(req.path)) {
      next();
      return;
    }
    const chave = rateLimitKey(req.ip);
    if (limite.hit(chave)) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(limite.retryAfter(chave)));
    res.status(429).json({
      error: 'too_many_requests',
      message: 'Muitas requisições deste endereço; tente de novo em alguns segundos.',
    });
  });
}

app.use(api);

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

  const aviso = avisoDeBoot();
  if (aviso) console.log(aviso);

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
