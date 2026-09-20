import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  AppError,
  badRequest,
  countUsers,
  createFile,
  createQuarantine,
  createQuarantineFile,
  createSkill,
  deleteFile,
  deleteQuarantine,
  deleteQuarantineFile,
  deleteSkill,
  getQuarantineApprovers,
  getUserByUuid,
  healthCheck,
  listAuditPage,
  listSkills,
  listTags,
  promoteQuarantine,
  readAllFiles,
  readAllQuarantineFiles,
  readFile,
  readQuarantineFile,
  setFile,
  setFiles,
  setQuarantineApprovers,
  setQuarantineFile,
  stats,
  updateSkillWithContent,
} from '@purple-skills/db';
import {
  QUARANTINE_APPROVERS,
  ZipError,
  composeSkillMd,
  createRateLimiter,
  isAccessScope,
  contentDisposition,
  extractZip,
  isSkillMd,
  isTextualContent,
  isTextualMime,
  mimeTypeFor,
  normalizeRelativePath,
  rateLimitKey,
  safeContentType,
  skillMetaFromMarkdown,
  stripFrontmatter,
  type QuarantineSheet,
} from '@purple-skills/shared';
import {
  actorFrom,
  type AuthUser,
  checkBootstrapPassword,
  endSession,
  issueLegacySession,
  issueSession,
  requireAdmin,
  requireAuth,
  requireCreate,
  requirePasswordChanged,
  requireSettingsAdmin,
  resolveUser,
  viewerOf,
} from './auth.js';
import * as access from './access.js';
import { gravarRag, lerPainelRag, limparRecusasRag, reindexarRag } from './rag.js';
import * as accesses from './accesses.js';
import * as quarantine from './quarantine.js';
import * as mcps from './mcps.js';
import * as catalogs from './catalogs.js';
import {
  bootstrapAdmin,
  changeOwnPassword,
  confirmPasswordReset,
  createAccount,
  getAccount,
  issueKey,
  listAccountKeys,
  listAccounts,
  listKeys,
  loginWithPassword,
  requestPasswordReset,
  resetAccountPassword,
  resolveOidcUser,
  revokeAccountKey,
  revokeKey,
  updateAccount,
} from './accounts.js';
import { config, oidcEnabled, resetLinkBaseUrl, smtpEnabled } from './config.js';
import { MAX_FILES_PER_REQUEST, limitRequestBytes, rejectOversizedBatch, upload } from './uploads.js';
import { streamSkillZip } from './zip.js';

const SOURCE = 'web-admin' as const;

/** Corpo pequeno das rotas de credencial — lido antes de haver sessão. */
const smallJson = express.json({ limit: '4kb' });

/**
 * Primeira camada do rate limiting: janela em memória por IP (§2.7). É o mesmo
 * limitador do site e do MCP público (`@purple-skills/shared`) — o painel tinha
 * ficado numa cópia local, anterior à chave por /64 e à faxina amortizada.
 */
const loginLimiter = createRateLimiter({
  max: config.loginIpMaxAttempts,
  windowSeconds: config.loginIpWindowSeconds,
});

/**
 * O balde de quem chama. `rateLimitKey` conta IPv6 por /64: por endereço, quem
 * tem um prefixo roteado troca de origem a cada tentativa e nunca é barrado —
 * justamente nas rotas de credencial. `::ffff:a.b.c.d` volta a contar como IPv4.
 */
const limiterKey = (req: Request): string => rateLimitKey(req.ip);

function param(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  return Array.isArray(value) ? value.join('/') : String(value ?? '');
}

/**
 * Um inteiro da query string, com padrão. Gêmeo do `asInt` de
 * `apps/site/src/api.ts`, e pela mesma razão: `Number(req.query.offset ?? 0)`
 * cru devolve `NaN` quando o valor não é numérico ou vem repetido
 * (`?offset=1&offset=2` chega como array), e um `NaN` no `OFFSET` é erro do
 * driver — 500 onde o certo é seguir com o padrão. A tolerância é a dos
 * helpers do banco (`clamp` e `pageOffset`): lixo e fração valem o padrão ou o
 * inteiro, nunca uma exceção. O **teto** continua sendo do banco.
 */
function asInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * O corpo JSON da requisição, para as rotas que não existem sem ele.
 *
 * No Express 5 `req.body` é `undefined` quando a requisição não tem corpo ou o
 * `Content-Type` não é `application/json` (um `curl -d` sem cabeçalho manda
 * `x-www-form-urlencoded`) — no Express 4 era `{}`. Ler `body.campo` direto
 * estourava `TypeError`, que o `fail()` devolvia como 500 e gravava no log como
 * erro inesperado, quando o erro é de quem chamou; três dessas rotas são
 * anônimas. Array também é recusado: o parser estrito o aceita, e nenhuma rota
 * daqui recebe lista solta.
 *
 * Responde 400 em vez de seguir com `{}`: "informe e-mail e senha" para quem
 * mandou os dois e esqueceu o cabeçalho esconde a causa. As rotas em que o corpo
 * é opcional de verdade continuam com `req.body ?? {}` ou `?.campo`.
 */
function jsonBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Corpo ausente ou inválido: envie um objeto JSON com Content-Type: application/json');
  }
  return body as Record<string, unknown>;
}

/**
 * Campo de texto de um multipart. O `append-field` do multer transforma campo
 * repetido em array e `campo[x]` em objeto **sem protótipo**: `.trim()` e
 * `.split()` estouram neles, e `String()` de objeto sem `toString` também — 500
 * onde o erro é de quem montou o formulário. Ausente é `undefined`; presente e
 * não-texto é 400, como o `skillMd` e o `content` de tipo errado nas rotas JSON.
 */
function textField(fields: unknown, name: string): string | undefined {
  const value = (fields as Record<string, unknown> | undefined)?.[name];
  if (value === undefined || typeof value === 'string') return value;
  throw badRequest(`O campo "${name}" deve ser um texto simples, enviado uma única vez`);
}

/**
 * As rotas de arquivo por JSON carregam **texto** — o corpo é um `content:
 * string`. O caminho, porém, é quem decide texto × binário na gravação:
 * `fileColumns` (e o `toExtractedFile` do shared) tiram o mime da extensão.
 *
 * Sem esta guarda, `PUT …/files/foto.png` com `{"content":"oi"}` era gravado
 * como **binário** com os bytes do texto: a escrita respondia 200, e toda
 * leitura devolvia `content: null`. Pior no `PUT` sobre um binário que já
 * existe — a imagem vinda do pacote era sobrescrita por um punhado de bytes de
 * texto, sem aviso. Binário entra pelo pacote, na importação.
 */
function assertTextPath(path: string): void {
  if (isTextualMime(mimeTypeFor(path))) return;
  throw badRequest(
    `"${path}" tem extensão de arquivo binário, e esta rota grava texto. ` +
      'Escolha outra extensão, ou traga o arquivo pelo pacote .zip/.skill na importação.',
  );
}

function fail(res: Response, err: unknown) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  // ZIP ilegível ou acima de um limite é erro do cliente, não do servidor.
  if (err instanceof ZipError) {
    res.status(400).json({ error: 'bad_request', message: err.message });
    return;
  }
  // A mensagem interna fica no log; o cliente recebe só o código.
  console.error('[admin] erro inesperado:', err);
  res.status(500).json({ error: 'internal_error', message: 'Erro interno' });
}

const route =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => {
    handler(req, res).catch((err) => fail(res, err));
  };

/**
 * `true` quando a tentativa passou pela janela por IP. A chave só vale o que
 * `req.ip` valer: o padrão do `trustProxySetting` aceita um salto de peer
 * interno, então quem chega pelo proxy reverso não escolhe mais o próprio balde.
 */
function throttled(req: Request, res: Response): boolean {
  const key = limiterKey(req);
  if (loginLimiter.hit(key)) return false;

  const retry = loginLimiter.retryAfter(key);
  res.setHeader('Retry-After', String(retry));
  res.status(429).json({
    error: 'too_many_requests',
    message: `Tentativas demais. Espere ${Math.ceil(retry / 60)} min e tente de novo.`,
  });
  return true;
}

export const api = Router();

api.get(
  '/healthz',
  route(async (_req, res) => {
    const ok = await healthCheck();
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded' });
  }),
);

// ----------------------------------------------------------------- CSRF ---

/** A origem de um endereço configurado; `null` se ele não é uma URL http(s). */
function originOf(address: string): string | null {
  try {
    const url = new URL(address);
    // Esquema fora de http(s) tem origem opaca, serializada como "null": dois
    // deles "bateriam" um com o outro na comparação de texto.
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * `true` quando `source` (o `Origin` do pedido) é a origem do próprio painel.
 *
 * Compara nome **e porta**: `URL.host` vem em minúsculas e sem a porta padrão
 * do esquema, que é como o navegador escreve o `Host`. O `Host` recebido passa
 * pela mesma normalização, com o esquema do `Origin`, porque há proxy que o
 * repassa com `:443` explícito. `req.host` já é o `X-Forwarded-Host` quando o
 * peer é proxy confiável (`TRUST_PROXY`).
 *
 * Quando o proxy publica o painel numa porta que **não** repassa no `Host`
 * (nginx com `proxy_set_header Host $host` em `:8443`), a comparação falha de
 * propósito — aceitar "mesmo nome, qualquer porta" é o buraco que isto fecha.
 * A saída é `ADMIN_PUBLIC_URL`, o endereço público declarado do painel, que
 * vale como origem própria do mesmo jeito que já vale para o link de
 * redefinição e o `redirect_uri` do OIDC.
 */
function isOwnOrigin(source: URL, host: string | undefined): boolean {
  if (source.protocol !== 'http:' && source.protocol !== 'https:') return false;

  let own: string | null = null;
  try {
    own = host ? new URL(`${source.protocol}//${host}`).host : null;
  } catch {
    own = null;
  }
  if (own !== null && own === source.host) return true;

  return config.publicUrl !== '' && originOf(config.publicUrl) === source.origin;
}

/**
 * O painel é same-origin: uma escrita com `Origin` de outra **origem** é CSRF.
 *
 * O cookie de sessão é `SameSite=Lax`, mas "site" não inclui porta, e cookie
 * não é isolado por porta: o site na 3000, o Inspector na 6274 ou o servidor de
 * desenvolvimento de outro projeto no mesmo host são same-site, e o cookie
 * viaja no POST deles. As rotas de upload aceitam `multipart/form-data`, que
 * não dispara preflight — nelas, e nas escritas sem corpo (logout, reindexar),
 * **esta checagem é a barreira**, não a reserva. Era comparação só de nome;
 * por isso passou a ser de nome e porta (`isOwnOrigin`), e as origens de
 * `ADMIN_ALLOWED_ORIGINS` contam pela origem inteira.
 *
 * O esquema fica com o `Sec-Fetch-Site`, que o navegador calcula sozinho:
 * `http://painel` → `https://painel` passa pela comparação de host (as duas
 * portas padrão somem) e só é `same-origin` com esquema igual. Comparar
 * `req.protocol` dependeria do `X-Forwarded-Proto` e daria 403 espúrio atrás de
 * proxy TLS que não o envia. Ausente (HTTP por IP de LAN, navegador antigo) não
 * reprova ninguém; origem extra cadastrada é cross-origin por definição e não
 * passa por ele.
 */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    next();
    return;
  }

  const origin = req.get('origin');
  // Ausente em clientes não-navegador (curl, scripts) — nada a verificar.
  if (!origin) {
    next();
    return;
  }

  let source: URL;
  try {
    // `Origin: null` (página em sandbox, `file://`) cai aqui.
    source = new URL(origin);
  } catch {
    res.status(403).json({ error: 'forbidden', message: 'Origem inválida' });
    return;
  }

  const fetchSite = req.get('sec-fetch-site');
  const sameOrigin = fetchSite === undefined || fetchSite === 'same-origin' || fetchSite === 'none';

  const allowed =
    (sameOrigin && isOwnOrigin(source, req.host)) ||
    config.extraAllowedOrigins.some((entry) => {
      const extra = originOf(entry);
      return extra !== null && extra === source.origin;
    });

  if (!allowed) {
    res.status(403).json({
      error: 'forbidden',
      message:
        'Origem não permitida: o painel só aceita escritas da própria origem (nome e porta). ' +
        'Atrás de proxy em porta que não chega no Host, defina ADMIN_PUBLIC_URL',
    });
    return;
  }

  next();
}

api.use('/api', csrfGuard);

// ------------------------------------------------------- caractere nulo ----

/**
 * Recusa, uma vez só e na entrada, o endereço com o caractere nulo (`%00`).
 *
 * O Postgres não guarda U+0000 em `text`: um slug, um caminho ou um filtro com
 * ele chegava ao driver e voltava como o erro 22021 cru — 500, com o SQL no log
 * (achado do relatório 038 da auditoria de 2026-09-19). O banco já responde 400
 * no que passa pelos seus validadores de texto e no termo de busca, mas as
 * leituras por identificador (skill, catálogo, vMCP, conta, tag) são vinte
 * pontos; nenhum endereço do painel tem uso legítimo para o caractere, então a
 * recusa é uma só, aqui.
 *
 * Olha o endereço **cru**: neste ponto o roteador ainda não casou rota nenhuma
 * e `req.params` está vazio, e todo U+0000 que a decodificação do caminho ou da
 * query string pode produzir vem escrito `%00` — em UTF-8 ele só tem essa
 * forma, e `%2500` é o texto "%00", que passa. O nulo literal nem chega aqui: o
 * parser HTTP do Node recusa a linha da requisição. O corpo JSON fica de fora,
 * porque o banco o confere campo a campo.
 */
export function nulGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.originalUrl.includes('%00')) {
    res.status(400).json({
      error: 'bad_request',
      message: 'O endereço não pode conter o caractere nulo (%00)',
    });
    return;
  }
  next();
}

api.use('/api', nulGuard);

// --------------------------------------------------------------- sessão ----

/**
 * O corpo de `GET /api/session`, numa função pura para o teste poder cobrar o
 * recorte sem banco.
 *
 * A rota fica **antes** do `requireAuth`: a tela de login precisa saber se há
 * setup pendente, se o SSO está ligado e qual é a marca. Por isso o que só as
 * telas de dentro mostram — endereços da instalação, janela de online, driver
 * do RAG e versão — sai apenas **com sessão**: era a única trava de papel do
 * painel que ficava só no cliente (a tela "Ambiente" não faz chamada própria),
 * e um visitante anônimo lia a versão exata do software e os endereços
 * configurados com um `curl`.
 */
export function sessionPayload(user: AuthUser | null, totalUsers: number) {
  return {
    authenticated: user !== null,
    user: user
      ? {
          uuid: user.uuid,
          email: user.email,
          name: user.name,
          role: user.role,
          mustChangePassword: user.mustChangePassword,
          legacy: user.legacy,
        }
      : null,
    // Com a tabela vazia o painel oferece a criação do primeiro admin; a
    // senha única continua entrando até alguém passar pelo setup (§4.1).
    needsSetup: totalUsers === 0,
    legacyLogin: totalUsers === 0,
    oidc: oidcEnabled() ? { enabled: true, name: config.oidcProviderName } : { enabled: false },
    passwordResetByEmail: smtpEnabled(),
    siteName: config.siteName,
    brand: { name: config.brandName, iconUrl: config.brandIconUrl },
    // Daqui para baixo, só com sessão.
    ...(user
      ? {
          siteBaseUrl: config.siteBaseUrl,
          mcpPublicUrl: config.mcpPublicUrl,
          links: {
            docs: config.docsUrl || null,
            support: config.supportUrl || null,
            chat: config.chatUrl || null,
          },
          onlineWindowMs: config.onlineWindowMs,
          // O que o `.env` deste container define para a busca semântica. Quem
          // decide é o banco (§4.1); isto é só o que o operador escreveu.
          rag: {
            driver: (process.env.RAG_DRIVER ?? '').trim() || null,
            model: (process.env.RAG_MODEL ?? '').trim() || null,
          },
          version: config.version,
        }
      : {}),
  };
}

api.get(
  '/api/session',
  route(async (req, res) => {
    const user = await resolveUser(req);
    const total = await countUsers();

    res.json(sessionPayload(user, total));
  }),
);

/** Cria o primeiro administrador. Fechado assim que existe qualquer conta. */
api.post(
  '/api/setup',
  smallJson,
  route(async (req, res) => {
    if ((await countUsers()) > 0) {
      res.status(404).json({ error: 'not_found', message: 'Rota não encontrada: /api/setup' });
      return;
    }
    if (throttled(req, res)) return;

    const body = jsonBody(req) as { password?: unknown; email?: unknown; name?: unknown; adminPassword?: unknown };
    if (!checkBootstrapPassword(body.adminPassword)) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'ADMIN_PASSWORD incorreta — ela é a credencial que autoriza criar o primeiro admin',
      });
      return;
    }

    const user = await bootstrapAdmin({ email: body.email, name: body.name, password: body.password });
    loginLimiter.reset(limiterKey(req));
    issueSession(req, res, { uuid: user.uuid, role: user.role, tokenVersion: 0 });
    res.status(201).json({ authenticated: true, user });
  }),
);

api.post(
  '/api/login',
  smallJson,
  route(async (req, res) => {
    if (throttled(req, res)) return;

    const body = jsonBody(req) as { email?: unknown; password?: unknown };

    // Login legado, sem e-mail: só enquanto não existe conta nenhuma. Depois
    // do primeiro usuário a ADMIN_PASSWORD fica inerte (§2.3).
    if (body.email === undefined || body.email === '') {
      if ((await countUsers()) > 0) {
        res.status(401).json({
          error: 'unauthorized',
          message: 'Este painel usa contas: informe e-mail e senha',
        });
        return;
      }
      if (!checkBootstrapPassword(body.password)) {
        res.status(401).json({ error: 'unauthorized', message: 'Senha incorreta' });
        return;
      }
      loginLimiter.reset(limiterKey(req));
      // Sessão legada: sem papel nem versão, vale enquanto `users` estiver vazia.
      issueLegacySession(req, res);
      res.json({ authenticated: true, legacy: true });
      return;
    }

    const outcome = await loginWithPassword(body);
    if ('error' in outcome) {
      res.status(outcome.status).json({ error: 'unauthorized', message: outcome.error });
      return;
    }

    loginLimiter.reset(limiterKey(req));
    issueSession(req, res, {
      uuid: outcome.user.uuid,
      role: outcome.user.role,
      tokenVersion: outcome.user.tokenVersion,
    });
    res.json({
      authenticated: true,
      user: {
        uuid: outcome.user.uuid,
        email: outcome.user.email,
        name: outcome.user.name,
        role: outcome.user.role,
        mustChangePassword: outcome.user.mustChangePassword,
        legacy: false,
      },
    });
  }),
);

/**
 * Sair **revoga**: `endSession` incrementa o `token_version` da conta, senão o
 * cookie apagado aqui continuaria valendo em qualquer cópia até `exp` (12 h).
 * O preço é assumido — cai também a sessão dos outros dispositivos da pessoa,
 * como na troca da própria senha (`docs/05-accounts-and-roles.md` §2.2). O
 * `revoked` diz ao painel se foi isso que aconteceu.
 */
api.post(
  '/api/logout',
  route(async (req, res) => {
    const revoked = await endSession(req, res);
    res.json({ authenticated: false, revoked });
  }),
);

// ----------------------------------------------------------------- OIDC ----

api.get(
  '/api/auth/oidc/start',
  route(async (req, res) => {
    if (!oidcEnabled()) {
      res.status(404).json({ error: 'not_found', message: 'SSO não configurado' });
      return;
    }
    const { beginLogin } = await import('./oidc.js');
    res.redirect(await beginLogin(req, res));
  }),
);

api.get(
  '/api/auth/oidc/callback',
  route(async (req, res) => {
    if (!oidcEnabled()) {
      res.status(404).json({ error: 'not_found', message: 'SSO não configurado' });
      return;
    }

    const { completeLogin } = await import('./oidc.js');
    try {
      const identity = await completeLogin(req, res);
      const user = await resolveOidcUser(identity);
      issueSession(req, res, {
        uuid: user.uuid,
        role: user.role,
        tokenVersion: user.tokenVersion,
      });
      res.redirect('/');
    } catch (err) {
      // O usuário chega aqui por navegação: devolver JSON deixaria a tela
      // branca. A mensagem volta pela querystring, para a tela de login.
      const message = err instanceof AppError ? err.message : 'Falha no login por SSO';
      if (!(err instanceof AppError)) console.error('[admin] falha no callback OIDC:', err);
      res.redirect(`/?sso_error=${encodeURIComponent(message)}`);
    }
  }),
);

// ------------------------------------------------ redefinição de senha ------

api.post(
  '/api/password-reset/request',
  smallJson,
  route(async (req, res) => {
    if (throttled(req, res)) return;

    if (!smtpEnabled()) {
      res.status(503).json({
        error: 'smtp_disabled',
        message: 'Este catálogo não envia e-mail: peça a um administrador para redefinir sua senha',
      });
      return;
    }

    // O link sai por e-mail para a caixa de OUTRA pessoa e quem pede é qualquer
    // visitante: a base não pode ser deduzida do `Host`, que o próprio pedido
    // escolhe (ver `resetLinkBaseUrl`).
    const base = resetLinkBaseUrl(req.protocol, req.get('host'), req.ip);
    if (!base) {
      console.warn(
        '[admin] pedido de redefinição de senha recusado: defina ADMIN_PUBLIC_URL. ' +
          'Sem ela o link só é montado para pedidos vindos de rede interna.',
      );
      res.status(503).json({
        error: 'public_url_required',
        message:
          'Este painel ainda não conhece o próprio endereço público: peça a um ' +
          'administrador para redefinir sua senha',
      });
      return;
    }

    // Resposta idêntica para e-mail existente e inexistente — no corpo, no status
    // **e no tempo**: o formulário não pode virar um verificador de quem tem
    // conta aqui. Por isso o pedido NÃO é esperado: com conta ele grava o link e
    // conversa com o SMTP (centenas de ms a segundos), sem conta volta depois de
    // um SELECT — esperar entregava a diferença a quem cronometra, e uma falha do
    // SMTP virava 500 só para e-mail com conta. É o gêmeo, nesta rota, do
    // `gastarTrabalhoDeSenha` do login, sem custo extra: nada é simulado para
    // quem não tem conta, só se deixa de esperar por quem tem. O `throttled()` lá
    // em cima segue sendo o teto de quantos pedidos (e envios) um IP dispara.
    // O `.catch` é obrigatório: promessa solta sem ele vira `unhandledRejection`.
    void requestPasswordReset((req.body as { email?: unknown } | undefined)?.email, (token) =>
      `${base}/?reset=${encodeURIComponent(token)}`,
    ).catch((err) => {
      console.error('[admin] falha ao processar o pedido de redefinição de senha:', err);
    });

    res.json({ requested: true });
  }),
);

api.post(
  '/api/password-reset/confirm',
  smallJson,
  route(async (req, res) => {
    if (throttled(req, res)) return;
    const body = jsonBody(req) as { token?: unknown; password?: unknown };
    await confirmPasswordReset(body.token, body.password);
    res.json({ reset: true });
  }),
);

// ------------------------------------------------------------ a partir daqui,
// tudo exige sessão.
api.use('/api', requireAuth);

// Corpos grandes (SKILL.md, arquivos de texto) só são lidos depois que a sessão
// foi validada.
api.use('/api', express.json({ limit: '32mb' }));

// Senha temporária: a sessão só serve para trocá-la.
api.use('/api', requirePasswordChanged);

// ------------------------------------------------------------- minha conta ---

api.get('/api/me', (req, res) => {
  res.json({
    uuid: req.user?.uuid ?? null,
    email: req.user?.email ?? '',
    name: req.user?.name ?? '',
    role: req.user?.role ?? 'membro',
    mustChangePassword: req.user?.mustChangePassword ?? false,
    legacy: req.user?.legacy ?? false,
  });
});

api.post(
  '/api/me/password',
  route(async (req, res) => {
    const body = jsonBody(req) as { currentPassword?: unknown; newPassword?: unknown };
    await changeOwnPassword(req.user!, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
    });
    // A troca incrementa `token_version` e derruba o próprio cookie: reemitir
    // aqui evita expulsar quem acabou de trocar a senha.
    const fresh = await getUserByUuid(req.user!.uuid!);
    if (fresh) {
      issueSession(req, res, {
        uuid: fresh.uuid,
        role: fresh.role,
        tokenVersion: fresh.tokenVersion,
      });
    }
    res.json({ changed: true });
  }),
);

api.get(
  '/api/me/keys',
  route(async (req, res) => {
    res.json({ items: await listKeys(req.user!) });
  }),
);

api.post(
  '/api/me/keys',
  route(async (req, res) => {
    const issued = await issueKey(req.user!, (req.body as { name?: unknown })?.name);
    // `token` aparece uma única vez, aqui.
    res.status(201).json(issued);
  }),
);

// As `psv_` que a conta emitiu, em qualquer servidor que ela ainda enxerga.
api.get(
  '/api/me/mcp-keys',
  route(async (req, res) => {
    res.json({ items: await mcps.listIssuedKeys(req.user!) });
  }),
);

api.delete(
  '/api/me/keys/:id',
  route(async (req, res) => {
    await revokeKey(req.user!, param(req, 'id'));
    res.json({ revoked: true });
  }),
);

// ------------------------------------------------------------------ contas ---

api.get(
  '/api/users',
  requireAdmin,
  route(async (_req, res) => {
    res.json({ items: await listAccounts() });
  }),
);

api.post(
  '/api/users',
  requireAdmin,
  route(async (req, res) => {
    // A sessão de bootstrap só existe com `users` vazia: a conta criada por ela
    // seria a primeira, e a primeira tem de ser o admin do `/api/setup` (§2.3 do
    // `docs/05`). Um `membro` criado aqui fechava o setup e o login pela
    // `ADMIN_PASSWORD` sem existir administrador, e a volta era SQL à mão
    // (relatório 001 da auditoria de 2026-09-19). Nem como `admin`: nasceria sem
    // o `onlyIfTableEmpty` do setup e sem adotar o que a sessão criou. O painel já
    // esconde a tela de contas nessa sessão; o servidor acompanha. Vem antes do
    // corpo — não há corpo que torne o pedido válido.
    if (req.user?.legacy) {
      throw badRequest(
        'A sessão de bootstrap não cria contas: saia e crie o primeiro administrador na tela de login (/?setup=1)',
      );
    }
    const body = jsonBody(req) as { email?: unknown; name?: unknown; role?: unknown; password?: unknown };
    const created = await createAccount(actorFrom(req), body);
    res.status(201).json(created);
  }),
);

api.patch(
  '/api/users/:uuid',
  requireAdmin,
  route(async (req, res) => {
    const body = jsonBody(req) as { name?: unknown; role?: unknown; isActive?: unknown };
    res.json(await updateAccount(req.user!, param(req, 'uuid'), body));
  }),
);

api.post(
  '/api/users/:uuid/reset-password',
  requireAdmin,
  route(async (req, res) => {
    // O ator vai junto: a redefinição é auditada com quem a fez (`tasks/030`).
    res.json(await resetAccountPassword(req.user!, param(req, 'uuid')));
  }),
);

// A busca de contas para compartilhar (`docs/12-acesso-granular.md` decisão
// 13): qualquer sessão, só contas ativas, e só nome, e-mail e papel — o `uuid`
// da conta **não** sai daqui, porque ele é o `sub` do cookie de sessão e esta
// rota é aberta a qualquer membro; quem recorta o payload é o `withoutUuid` do
// `access.ts`, e quem transfere dono manda o e-mail. Fica antes de
// `/api/users/:uuid`, senão o Express a engole como um uuid.
api.get(
  '/api/users/lookup',
  route(async (req, res) => {
    res.json({ items: await access.lookup(req.query.q) });
  }),
);

// A ficha de uma conta (`docs/13-fichas-e-acessos.md` §3.4): a conta, as
// chaves `psk_` dela e as leituras de skill feitas por elas. Só admin, como a
// lista — a guia de acessos traz IPs e clientes.
api.get(
  '/api/users/:uuid',
  requireAdmin,
  route(async (req, res) => {
    res.json(await getAccount(param(req, 'uuid')));
  }),
);

api.get(
  '/api/users/:uuid/keys',
  requireAdmin,
  route(async (req, res) => {
    res.json({ items: await listAccountKeys(param(req, 'uuid')) });
  }),
);

api.delete(
  '/api/users/:uuid/keys/:id',
  requireAdmin,
  route(async (req, res) => {
    await revokeAccountKey(req.user!, param(req, 'uuid'), param(req, 'id'));
    res.json({ revoked: true });
  }),
);

api.get(
  '/api/users/:uuid/accesses',
  requireAdmin,
  route(async (req, res) => {
    res.json(await accesses.ofUser(param(req, 'uuid'), req.query as Record<string, unknown>));
  }),
);

// ----------------------------------------------------------- MCPs virtuais ---

/**
 * Criar exige papel (`requireCreate`); tudo depois é decidido pelo acesso ao
 * objeto (`docs/12-acesso-granular.md` §3.2), dentro de `mcps.load` — por
 * isso as rotas abaixo não levam guarda de papel: um membro administra o
 * que é seu ou lhe foi concedido.
 */
api.get(
  '/api/mcps',
  route(async (req, res) => {
    res.json({ items: await mcps.listMine(req.user!, req.query.scope) });
  }),
);

api.post(
  '/api/mcps',
  requireCreate,
  route(async (req, res) => {
    res.status(201).json(await mcps.create(req.user!, req.body ?? {}));
  }),
);

api.get(
  '/api/mcps/:slug',
  route(async (req, res) => {
    res.json(await mcps.detail(req.user!, param(req, 'slug')));
  }),
);

api.put(
  '/api/mcps/:slug/access/:email',
  route(async (req, res) => {
    const level = (req.body as { level?: unknown } | undefined)?.level;
    res.json(await mcps.share(req.user!, param(req, 'slug'), param(req, 'email'), level));
  }),
);

api.delete(
  '/api/mcps/:slug/access/:email',
  route(async (req, res) => {
    await mcps.unshare(req.user!, param(req, 'slug'), param(req, 'email'));
    res.json({ revoked: true });
  }),
);

api.patch(
  '/api/mcps/:slug',
  route(async (req, res) => {
    res.json(await mcps.update(req.user!, param(req, 'slug'), req.body ?? {}));
  }),
);

api.delete(
  '/api/mcps/:slug',
  route(async (req, res) => {
    await mcps.remove(req.user!, param(req, 'slug'));
    res.json({ deleted: true });
  }),
);

api.put(
  '/api/mcps/:slug/skills',
  route(async (req, res) => {
    res.json(await mcps.setSkills(req.user!, param(req, 'slug'), req.body ?? {}));
  }),
);

// Catálogos no vMCP (`docs/11-catalogos.md` §6.2): `edit` no servidor e
// `view` no catálogo que entra (`docs/12` decisão 7), decidido em `catalogs`.
api.put(
  '/api/mcps/:slug/catalogs',
  route(async (req, res) => {
    res.json(await catalogs.setMcpCatalogs(req.user!, param(req, 'slug'), req.body ?? {}));
  }),
);

api.put(
  '/api/mcps/:slug/catalogs/:catalog',
  route(async (req, res) => {
    res.json(await catalogs.linkToMcp(req.user!, param(req, 'slug'), param(req, 'catalog'), req.body));
  }),
);

api.delete(
  '/api/mcps/:slug/catalogs/:catalog',
  route(async (req, res) => {
    res.json(await catalogs.unlinkFromMcp(req.user!, param(req, 'slug'), param(req, 'catalog')));
  }),
);

// O canvas: posições dos nós, estado de tela compartilhado — sem auditoria.
api.put(
  '/api/mcps/:slug/canvas',
  route(async (req, res) => {
    await mcps.setCanvas(req.user!, param(req, 'slug'), req.body ?? {});
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------- catálogos ---

/** Como o vMCP: criar exige papel; o resto é o acesso ao catálogo, em `catalogs.load`. */
api.get(
  '/api/catalogs',
  route(async (req, res) => {
    res.json({ items: await catalogs.listMine(req.user!, req.query.scope) });
  }),
);

api.post(
  '/api/catalogs',
  requireCreate,
  route(async (req, res) => {
    res.status(201).json(await catalogs.create(req.user!, req.body ?? {}));
  }),
);

api.get(
  '/api/catalogs/:slug',
  route(async (req, res) => {
    res.json(await catalogs.detail(req.user!, param(req, 'slug')));
  }),
);

// As leituras de skills entregues por este catálogo — `manage`, como na skill.
api.get(
  '/api/catalogs/:slug/accesses',
  route(async (req, res) => {
    res.json(await accesses.ofCatalog(req.user!, param(req, 'slug'), req.query as Record<string, unknown>));
  }),
);

api.put(
  '/api/catalogs/:slug/access/:email',
  route(async (req, res) => {
    const level = (req.body as { level?: unknown } | undefined)?.level;
    res.json(await catalogs.share(req.user!, param(req, 'slug'), param(req, 'email'), level));
  }),
);

api.delete(
  '/api/catalogs/:slug/access/:email',
  route(async (req, res) => {
    await catalogs.unshare(req.user!, param(req, 'slug'), param(req, 'email'));
    res.json({ revoked: true });
  }),
);

api.patch(
  '/api/catalogs/:slug',
  route(async (req, res) => {
    res.json(await catalogs.update(req.user!, param(req, 'slug'), req.body ?? {}));
  }),
);

api.delete(
  '/api/catalogs/:slug',
  route(async (req, res) => {
    await catalogs.remove(req.user!, param(req, 'slug'));
    res.json({ deleted: true });
  }),
);

api.put(
  '/api/catalogs/:slug/skills',
  route(async (req, res) => {
    res.json(await catalogs.setSkills(req.user!, param(req, 'slug'), req.body ?? {}));
  }),
);

api.put(
  '/api/catalogs/:slug/skills/:skill',
  route(async (req, res) => {
    res.json(await catalogs.putSkill(req.user!, param(req, 'slug'), param(req, 'skill'), req.body));
  }),
);

api.delete(
  '/api/catalogs/:slug/skills/:skill',
  route(async (req, res) => {
    res.json(await catalogs.removeSkill(req.user!, param(req, 'slug'), param(req, 'skill')));
  }),
);

// Sessões do MCP público (`docs/10-admin-canvas-e-sessoes.md`): o contador do
// globo (`view`) e a lista por servidor (`manage`, como as chaves).
api.get(
  '/api/mcps/:slug/online',
  route(async (req, res) => {
    res.json(await mcps.online(req.user!, param(req, 'slug')));
  }),
);

api.get(
  '/api/mcps/:slug/sessions',
  route(async (req, res) => {
    res.json(await mcps.sessionsOf(req.user!, param(req, 'slug'), req.query as Record<string, unknown>));
  }),
);

// A lista global: admin vê tudo, os demais só os vMCPs que administram — o
// recorte é de `listSessions`, não de um guarda de papel.
api.get(
  '/api/sessions',
  route(async (req, res) => {
    res.json(await mcps.listSessions(req.user!, req.query as Record<string, unknown>));
  }),
);

api.get(
  '/api/mcps/:slug/keys',
  route(async (req, res) => {
    res.json({ items: await mcps.listKeys(req.user!, param(req, 'slug')) });
  }),
);

api.post(
  '/api/mcps/:slug/keys',
  route(async (req, res) => {
    // `token` aparece uma única vez, aqui.
    res.status(201).json(
      await mcps.issueKey(req.user!, param(req, 'slug'), (req.body as { name?: unknown })?.name),
    );
  }),
);

api.delete(
  '/api/mcps/:slug/keys/:id',
  route(async (req, res) => {
    await mcps.revokeKey(req.user!, param(req, 'slug'), param(req, 'id'));
    res.json({ revoked: true });
  }),
);

// ------------------------------------------------------- configuração ---

// Só admin: o vMCP padrão é o que responde em /mcp para toda a instalação.
api.get(
  '/api/settings',
  requireSettingsAdmin,
  route(async (_req, res) => {
    res.json(await mcps.getSettings());
  }),
);

api.put(
  '/api/settings/default-mcp',
  requireSettingsAdmin,
  route(async (req, res) => {
    res.json(await mcps.setDefaultMcp(req.user!, (req.body as { uuid?: unknown })?.uuid));
  }),
);

/**
 * Quem aprova um envio da quarentena (`docs/15-quarentena.md`). Ajuste da
 * instalação inteira, como as demais rotas de configuração: só admin.
 */
api.get(
  '/api/settings/quarantine',
  requireSettingsAdmin,
  route(async (_req, res) => {
    res.json({ approvers: await getQuarantineApprovers(), options: QUARANTINE_APPROVERS });
  }),
);

api.put(
  '/api/settings/quarantine',
  requireSettingsAdmin,
  route(async (req, res) => {
    const approvers = await setQuarantineApprovers(
      (req.body as { approvers?: unknown } | undefined)?.approvers,
      SOURCE,
      actorFrom(req),
    );
    res.json({ approvers, options: QUARANTINE_APPROVERS });
  }),
);

/**
 * Busca semântica (`docs/14-rag.md` §9). Mesmo papel das
 * demais rotas de configuração: é ajuste da instalação inteira.
 */
api.get(
  '/api/settings/rag',
  requireSettingsAdmin,
  route(async (_req, res) => {
    res.json(await lerPainelRag());
  }),
);

api.put(
  '/api/settings/rag',
  requireSettingsAdmin,
  route(async (req, res) => {
    res.json(await gravarRag(actorFrom(req), (req.body ?? {}) as Record<string, unknown>));
  }),
);

// Não apaga vetor nenhum: só marca o acervo para refatiar (§9).
api.post(
  '/api/settings/rag/reindex',
  requireSettingsAdmin,
  route(async (req, res) => {
    res.json(await reindexarRag(actorFrom(req)));
  }),
);

// O reparo da recusa gravada por engano: devolve à fila os textos que o provedor
// recusou no espaço em uso. Rota à parte do "Reindexar" de propósito — aquele é
// de graça, este custa requisições (§9).
api.post(
  '/api/settings/rag/refusals/clear',
  requireSettingsAdmin,
  route(async (req, res) => {
    res.json(await limparRecusasRag(actorFrom(req)));
  }),
);

// ------------------------------------------------------------- dashboard ---

/**
 * Os números do painel, recortados pelo que a sessão enxerga (`docs/12` §3.1).
 *
 * `stats()` conta a instalação inteira — skills que a sessão não vê, os
 * arquivos delas e as contas — e não aceita `viewer`: contagem agregada mora
 * no SQL e é camada do dba. Até ela recortar, quem não é admin recebe só o que
 * dá para recortar com as funções que já recebem `viewer` (o total de skills e
 * as tags de skill visível), mais `openSkills`, que é exatamente o que o site
 * mostra a um visitante anônimo e por isso não revela nada.
 *
 * Os outros saem do corpo em vez de sair globais: `unlinkedSkills`,
 * `totalFiles`, `totalViews` e `totalDownloads` dimensionam o acervo privado,
 * e as contagens de contas são dado da instalação, como `/api/audit`. Número
 * ausente desaparece da tela; número global responderia "quantas skills
 * privadas existem aqui". Aproximar `unlinkedSkills` fora do banco seria pior
 * que omitir: a lista `mcps` de uma leitura com `viewer` só traz os servidores
 * que a conta vê, então uma skill publicada num servidor alheio pareceria
 * flutuante.
 */
api.get(
  '/api/stats',
  route(async (req, res) => {
    const viewer = viewerOf(req.user!);
    if (viewer.role === 'admin') {
      res.json(await stats());
      return;
    }
    const [instalacao, skills, tags] = await Promise.all([
      stats(),
      listSkills({ viewer, limit: 1 }),
      listTags({ viewer }),
    ]);
    res.json({ totalSkills: skills.total, openSkills: instalacao.openSkills, totalTags: tags.length });
  }),
);

// A trilha carrega e-mail de quem agiu e de quem sofreu a ação (`actor_label`
// e `target_label`), incluindo eventos de conta. É a mesma classe de dado de
// `/api/users*` — logo, o mesmo papel: admin.
api.get(
  '/api/audit',
  requireAdmin,
  route(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const text = (key: string) => (typeof q[key] === 'string' && (q[key] as string).trim() ? (q[key] as string).trim() : undefined);
    const date = (key: string) => {
      const raw = text(key);
      if (!raw) return undefined;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw badRequest(`"${key}" precisa ser uma data válida`);
      return parsed;
    };
    res.json(
      await listAuditPage({
        // `asInt`, como em `/api/skills`: com `Number(...)` cru, `?limit=abc`
        // virava `NaN`, que o `clamp` do banco lê como o **mínimo** — a trilha
        // voltava uma linha em vez de 50 —, e `?offset=1e30` passava inteiro
        // (relatório 086 da auditoria de 2026-09-19).
        limit: asInt(q.limit, 50),
        offset: asInt(q.offset, 0),
        action: text('action') as never,
        actor: text('actor'),
        q: text('q'),
        since: date('since'),
        until: date('until'),
      }),
    );
  }),
);

api.get(
  '/api/tags',
  route(async (req, res) => {
    res.json({ items: await listTags({ viewer: viewerOf(req.user!) }) });
  }),
);

// ---------------------------------------------------------------- skills ---

/**
 * O SKILL.md guardado é só o corpo do prompt: os metadados moram em colunas do
 * banco e são a fonte da verdade. Skills gravadas antes desta regra ainda têm
 * o frontmatter no arquivo — tirá-lo na saída evita que ele volte para o
 * editor e seja salvo de novo.
 */
const bodyOnly = <T extends { skillMd: string }>(detail: T): T => ({
  ...detail,
  skillMd: stripFrontmatter(detail.skillMd),
});

// O que a sessão enxerga (`docs/12` §3.1); `scope` é o filtro meus /
// compartilhados / públicos das listas do painel.
api.get(
  '/api/skills',
  route(async (req, res) => {
    const page = await listSkills({
      query: typeof req.query.q === 'string' ? req.query.q : null,
      tag: typeof req.query.tag === 'string' ? req.query.tag : null,
      limit: asInt(req.query.limit, 50),
      offset: asInt(req.query.offset, 0),
      sort: (req.query.sort as never) ?? undefined,
      viewer: viewerOf(req.user!),
      ...(isAccessScope(req.query.scope) ? { scope: req.query.scope } : {}),
    });
    // O dono sai pelo e-mail, nunca pelo uuid da conta (`access.ownerByEmail`).
    res.json({ ...page, items: page.items.map(access.ownerByEmail) });
  }),
);

api.post(
  '/api/skills',
  requireCreate,
  route(async (req, res) => {
    const body = jsonBody(req) as {
      name?: string;
      slug?: string;
      description?: string;
      // Cru de propósito: o corpo não passa por schema e o `stripFrontmatter`
      // abaixo é o primeiro a tocar o valor.
      skillMd?: unknown;
      tags?: string[];
      /** Emoji ou URL de imagem; nulo ou vazio limpa. A forma é validada no banco. */
      icon?: unknown;
      /** Onde publicar já na criação: `[{ slug, asSkill, asPrompt, asResource }]`. */
      mcps?: unknown;
      /** Legível por qualquer conta e pelo site (`docs/12` decisão 4). */
      isPublic?: unknown;
    };

    // `stripFrontmatter` roda antes da validação da `@purple-skills/db`, então
    // um `skillMd` de outro tipo estouraria aqui como 500. Os demais campos
    // são conferidos lá, que é onde todos os chamadores passam.
    if (body.skillMd !== undefined && typeof body.skillMd !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'O campo "skillMd" deve ser uma string' });
      return;
    }

    const detail = await createSkill(
      {
        name: body.name ?? '',
        slug: body.slug,
        description: body.description,
        // Os metadados vêm do formulário; o frontmatter é gerado na leitura.
        // Um bloco `---` colado no início do prompt é descartado aqui.
        skillMd: stripFrontmatter(body.skillMd ?? ''),
        tags: body.tags,
        icon: body.icon as string | null | undefined,
        isPublic: body.isPublic === true,
        // Só nos vMCPs que a sessão edita; um que não seja é 403 antes de
        // criar qualquer coisa.
        mcps: await mcps.resolveLinks(req.user!, body.mcps),
      },
      SOURCE,
      actorFrom(req),
    );
    // Quem cria é o dono (`access: 'owner'`); sai como toda ficha, sem uuid de conta.
    res.status(201).json(bodyOnly(access.withGrants(detail)));
  }),
);

/**
 * Cria uma skill inteira a partir de um pacote (`.zip` ou `.skill` — é o mesmo
 * ZIP, ver `streamSkillZip`).
 *
 * `destination` escolhe onde o pacote cai (`docs/15-quarentena.md`):
 * `production` (o padrão) cria a skill direto, como sempre; `quarantine`
 * guarda os arquivos **crus** num envio à espera de aprovação. Importar é o
 * único caminho para a quarentena — o formulário de nova skill vai sempre para
 * produção.
 */
api.post(
  '/api/skills/import',
  requireCreate,
  limitRequestBytes,
  upload.single('file'),
  route(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'bad_request', message: 'Envie um arquivo .zip ou .skill no campo "file"' });
      return;
    }

    // Campo repetido chega como array e `campo[x]` como objeto: `textField`
    // recusa os dois com 400 antes de qualquer `.trim()`.
    const body = {
      name: textField(req.body, 'name'),
      description: textField(req.body, 'description'),
      tags: textField(req.body, 'tags'),
      icon: textField(req.body, 'icon'),
      /** JSON: `[{ slug, asSkill, asPrompt, asResource }]`. */
      mcps: textField(req.body, 'mcps'),
      /** `production` (padrão) ou `quarantine`. */
      destination: textField(req.body, 'destination'),
    };
    if (body.destination !== undefined && body.destination !== 'production' && body.destination !== 'quarantine') {
      res.status(400).json({
        error: 'bad_request',
        message: 'O campo "destination" aceita "production" ou "quarantine"',
      });
      return;
    }

    const paraQuarentena = body.destination === 'quarantine';
    // `allowBinarySkillMd` só na quarentena: lá o arquivo é bytes crus que
    // ninguém decodifica, e recusar o pacote seria recusar justamente o que o
    // espaço existe para consertar — o SKILL.md em Windows-1252 ou UTF-16 que
    // sai de um editor Windows. Quem cobra a codificação é a aprovação.
    const files = extractZip(req.file.buffer, paraQuarentena ? { allowBinarySkillMd: true } : {});
    // `.zip` e `.skill` carregam o mesmo ZIP; os dois saem do nome de reserva.
    const fallbackName = req.file.originalname.replace(/\.(zip|skill)$/i, '');
    const skillMd = files.find((file) => file.relativePath.toLowerCase() === 'skill.md');

    if (paraQuarentena) {
      if (files.length === 0) {
        res.status(400).json({ error: 'bad_request', message: 'O pacote está vazio' });
        return;
      }

      // Sem SKILL.md o pacote **entra** na quarentena: é justamente o lugar de
      // consertar o que veio torto. Quem cobra o arquivo é a promoção, que sem
      // ele não sabe que skill criar.
      const meta = skillMd?.textContent ? skillMetaFromMarkdown(skillMd.textContent) : null;
      const detail = await createQuarantine(
        {
          // O nome do envio é só rótulo, mas não pode ser vazio: sem
          // SKILL.md e com um arquivo chamado ".zip", os dois candidatos saem
          // em branco.
          name: meta?.name?.trim() || fallbackName.trim() || 'pacote sem nome',
          description: meta?.description?.trim() ?? '',
          sourceFilename: req.file.originalname,
          // Crus, como chegaram: na quarentena o SKILL.md guarda o próprio
          // frontmatter, e não há metadado em coluna para contradizê-lo.
          files: files.map((file) => ({
            relativePath: file.relativePath,
            content: file.binaryContent ?? Buffer.from(file.textContent ?? '', 'utf8'),
          })),
        },
        SOURCE,
        actorFrom(req),
      );
      res.status(201).json(access.ownerByEmail(detail));
      return;
    }

    if (!skillMd?.textContent) {
      res.status(400).json({ error: 'bad_request', message: 'O pacote precisa conter um SKILL.md' });
      return;
    }

    const meta = skillMetaFromMarkdown(skillMd.textContent);
    const tags = parseTags(body.tags);
    const attachments = files.filter((file) => file.relativePath.toLowerCase() !== 'skill.md');

    // Skill, SKILL.md e anexos numa transação só: gravar os anexos depois
    // deixava uma skill pela metade quando o segundo passo falhava, e a nova
    // tentativa criava uma duplicata com slug "-2".
    const detail = await createSkill(
      {
        name: body.name?.trim() || meta.name || fallbackName,
        // O `name:` do frontmatter é o nome oficial da skill: vira o slug
        // quando já vem em forma de slug.
        slug: meta.slug ?? undefined,
        description: body.description?.trim() || meta.description || '',
        skillMd: stripFrontmatter(skillMd.textContent),
        tags: tags.length > 0 ? tags : meta.tags,
        icon: body.icon?.trim() || undefined,
        // Onde publicar vem só do formulário: nada no .zip de terceiro decide
        // em que servidor a skill aparece.
        mcps: await mcps.resolveLinks(req.user!, parseJsonList(body.mcps)),
        files: attachments.map((file) => ({
          relativePath: file.relativePath,
          content: file.binaryContent ?? Buffer.from(file.textContent ?? '', 'utf8'),
        })),
      },
      SOURCE,
      actorFrom(req),
    );

    // Quem cria é o dono (`access: 'owner'`); sai como toda ficha, sem uuid de conta.
    res.status(201).json(bodyOnly(access.withGrants(detail)));
  }),
);

api.get(
  '/api/skills/:slug',
  route(async (req, res) => {
    // `view` basta para ler; a lista de concessões só vai para `manage`.
    res.json(bodyOnly(access.withGrants(await access.loadSkill(req.user!, param(req, 'slug'), 'view'))));
  }),
);

// A guia "Acessos" (`docs/13-fichas-e-acessos.md`): IPs, clientes e nomes de
// chave são operação, como as sessões de um vMCP — só `manage`.
api.get(
  '/api/skills/:slug/accesses',
  route(async (req, res) => {
    res.json(await accesses.ofSkill(req.user!, param(req, 'slug'), req.query as Record<string, unknown>));
  }),
);

api.put(
  '/api/skills/:slug/access/:email',
  route(async (req, res) => {
    const level = (req.body as { level?: unknown } | undefined)?.level;
    res.json(await access.shareSkill(req.user!, param(req, 'slug'), param(req, 'email'), level));
  }),
);

api.delete(
  '/api/skills/:slug/access/:email',
  route(async (req, res) => {
    await access.unshareSkill(req.user!, param(req, 'slug'), param(req, 'email'));
    res.json({ revoked: true });
  }),
);

// Vínculo pelo lado da skill (`docs/09-mcp-padrao-e-skills-flutuantes.md`
// §4.3). Sem guarda de papel de propósito, como nas rotas do MCP: quem
// decide é `mcps.load` — `edit` no vMCP alvo e `view` na skill.
//
// O corpo é a ficha da skill **como quem chamou a vê** (`skillSeenBy`, em
// `mcps.ts`), nunca a que a escrita devolve. Nulo é "deu certo e você não a vê": desfazer
// o vínculo pode tirar do alcance da sessão a skill privada que só chegava por
// aquele servidor — 200 com corpo mínimo, não 404.
api.put(
  '/api/skills/:slug/mcps/:mcp',
  route(async (req, res) => {
    const detail = await mcps.linkSkill(req.user!, param(req, 'mcp'), param(req, 'slug'), req.body);
    res.json(detail ? bodyOnly(detail) : { linked: true });
  }),
);

api.delete(
  '/api/skills/:slug/mcps/:mcp',
  route(async (req, res) => {
    const detail = await mcps.unlinkSkill(req.user!, param(req, 'mcp'), param(req, 'slug'));
    res.json(detail ? bodyOnly(detail) : { unlinked: true });
  }),
);

api.patch(
  '/api/skills/:slug',
  route(async (req, res) => {
    const body = jsonBody(req) as {
      name?: string;
      slug?: string;
      description?: string;
      tags?: string[];
      skillMd?: string;
      /** `undefined` não mexe; `null` ou vazio limpa. */
      icon?: string | null;
      /** Desligada some de todo servidor e do site (`docs/11-catalogos.md` decisão 10). */
      isActive?: boolean;
      /** Legível por qualquer conta e pelo site (`docs/12` decisão 4). */
      isPublic?: boolean;
      /** Transferir o dono: só dono e admin. */
      ownerUserUuid?: string | null;
    };

    // Conteúdo, nome, descrição, ícone e tags são `edit`; slug, estado e
    // público são `manage`; o dono, `owner` (`docs/12` §3.2).
    const touchesProperties =
      body.slug !== undefined || body.isActive !== undefined || body.isPublic !== undefined;
    const current = await access.loadSkillSummary(
      req.user!,
      param(req, 'slug'),
      touchesProperties ? 'manage' : 'edit',
    );
    const owner = await access.ownerFrom(req.user!, current.access, body.ownerUserUuid, 'skill');

    // Conteúdo e metadados numa transação só: se o slug colidir ou o nome vier
    // vazio, o SKILL.md também não é gravado.
    const detail = await updateSkillWithContent(
      current.slug,
      {
        name: body.name,
        slug: body.slug,
        description: body.description,
        tags: body.tags,
        icon: body.icon,
        isActive: body.isActive,
        isPublic: body.isPublic,
        ...(owner !== undefined ? { ownerUserUuid: owner } : {}),
        skillMd: typeof body.skillMd === 'string' ? stripFrontmatter(body.skillMd) : undefined,
      },
      SOURCE,
      actorFrom(req),
    );
    // A escrita não conhece o leitor — relê na visão do admin: devolve o acesso
    // de quem chamou, e as concessões só a quem as administra. O PATCH não mexe
    // em vínculo, então `mcps` e `catalogs` são os da leitura prévia, já
    // recortados pelo `viewer`; os da escrita trariam o servidor fechado e o
    // catálogo privado de terceiros que o `GET` da mesma skill esconde.
    const seen = { ...detail, access: current.access, mcps: current.mcps, catalogs: current.catalogs };
    res.json(bodyOnly(access.withGrants(seen)));
  }),
);

api.delete(
  '/api/skills/:slug',
  route(async (req, res) => {
    // Apagar é do dono e do admin: nenhum nível de concessão chega lá.
    const current = await access.loadSkillSummary(req.user!, param(req, 'slug'), 'owner');
    await deleteSkill(current.slug, SOURCE, actorFrom(req));
    res.json({ deleted: true });
  }),
);

// --------------------------------------------------------------- arquivos ---

/**
 * Download do pacote da skill. `.zip` e `.skill` são o mesmo ZIP — só muda a
 * extensão do arquivo baixado (o `.skill` é o formato aberto de Agent Skills).
 * Serve skills privadas a quem as vê (`view`).
 */
const serveSkillPackage = (ext: 'zip' | 'skill') =>
  route(async (req, res) => {
    const skill = await access.loadSkillSummary(req.user!, param(req, 'slug'), 'view');

    const files = await readAllFiles(skill.uuid);
    await streamSkillZip(res, skill.slug, files, skill, ext);
  });

api.get('/api/skills/:slug/download', serveSkillPackage('zip'));
api.get('/api/skills/:slug/download.skill', serveSkillPackage('skill'));

api.get(
  '/api/skills/:slug/files/*path',
  route(async (req, res) => {
    const skill = await access.loadSkillSummary(req.user!, param(req, 'slug'), 'view');

    const path = normalizeRelativePath(param(req, 'path'));
    const file = path ? await readFile(skill.uuid, path) : null;
    if (!file) {
      res.status(404).json({ error: 'not_found', message: 'Arquivo não encontrado' });
      return;
    }

    // O SKILL.md é montado na hora: metadados do formulário nas primeiras
    // linhas, prompt gravado logo abaixo.
    const buffer = isSkillMd(file.relativePath)
      ? Buffer.from(composeSkillMd(skill, file.buffer.toString('utf8')), 'utf8')
      : file.buffer;

    if (req.query.raw !== undefined) {
      // "Abrir cru" na origem do painel: um .html/.svg anexado rodaria JS
      // autenticado como o operador. Tipos executáveis descem como texto —
      // inclusive .js/.css: carregados como sub-recurso por uma página do
      // painel eles satisfariam o `'self'` da CSP **dela**, e nem o `sandbox`
      // nem o `Content-Disposition` daqui valem nesse caso. O que barra é o
      // par `text/plain` + `nosniff` (relatório 014 da auditoria de 2026-09-19).
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Type', safeContentType(file.mimeType, file.isText));
      res.setHeader('Content-Disposition', contentDisposition(file.relativePath, 'inline'));
      // Conteúdo de skill privada: nenhum cache compartilhado guarda, e o
      // navegador revalida pelo `ETag` a cada uso — a pré-visualização de
      // imagem usa esta rota e continua recebendo 304 enquanto nada mudar.
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(buffer);
      return;
    }

    res.json({
      relativePath: file.relativePath,
      mimeType: file.mimeType,
      sizeBytes: buffer.byteLength,
      isText: file.isText,
      content: file.isText ? buffer.toString('utf8') : null,
    });
  }),
);

api.put(
  '/api/skills/:slug/files/*path',
  route(async (req, res) => {
    await access.loadSkillSummary(req.user!, param(req, 'slug'), 'edit');
    const content = (req.body as { content?: unknown })?.content;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'O campo "content" é obrigatório' });
      return;
    }

    // Gravar o SKILL.md por aqui não redefine os metadados da skill: eles
    // continuam vindo do formulário, e o frontmatter enviado é descartado.
    //
    // Normaliza **antes** de decidir, como o GET acima e o `set_file` do
    // mcp-admin: `isSkillMd` compara o texto exato e `setFile` canoniza o
    // caminho na hora de gravar. Decidir com o caminho cru deixava uma grafia
    // torta do arquivo principal (`.%5CSKILL.md`, `./SKILL.md`) gravar o bloco
    // enviado na linha do SKILL.md — fora da vista, dentro da busca e do RAG
    // (relatório 016 da auditoria de 2026-09-19).
    const raw = param(req, 'path');
    const path = normalizeRelativePath(raw);
    if (!path) {
      res.status(400).json({ error: 'bad_request', message: `Caminho inválido: ${raw}` });
      return;
    }
    assertTextPath(path);
    const stored = isSkillMd(path) ? stripFrontmatter(content) : content;
    res.json(await setFile(param(req, 'slug'), path, stored, SOURCE, actorFrom(req)));
  }),
);

/**
 * Cria o arquivo só se o caminho está livre — o "Novo arquivo" da guia
 * Arquivos. Nunca sobrescreve: caminho ocupado (em qualquer caixa), prefixo
 * que é arquivo, pasta com o mesmo nome e o SKILL.md são 409. `content` é
 * opcional; sem ele, o arquivo nasce vazio.
 */
api.post(
  '/api/skills/:slug/files/*path',
  route(async (req, res) => {
    // O corpo é conferido antes do acesso: um 400 não diz nada sobre a skill.
    const raw = (req.body as { content?: unknown } | undefined)?.content;
    const content = raw === undefined ? '' : raw;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'O campo "content" deve ser uma string' });
      return;
    }
    assertTextPath(normalizeRelativePath(param(req, 'path')) ?? param(req, 'path'));
    await access.loadSkillSummary(req.user!, param(req, 'slug'), 'edit');
    res.status(201).json(await createFile(param(req, 'slug'), param(req, 'path'), content, SOURCE, actorFrom(req)));
  }),
);

api.delete(
  '/api/skills/:slug/files/*path',
  route(async (req, res) => {
    await access.loadSkillSummary(req.user!, param(req, 'slug'), 'edit');
    await deleteFile(param(req, 'slug'), param(req, 'path'), SOURCE, actorFrom(req));
    res.json({ deleted: true });
  }),
);

/*
 * `POST /api/skills/:slug/upload` — o .zip numa skill já cadastrada — **saiu**
 * (`docs/15-quarentena.md`). O pacote passou a ter um caminho só, a importação,
 * que decide entre produção e quarentena; dentro da edição de uma skill entra
 * arquivo de texto, um a um, pela rota abaixo.
 *
 * O que a rota fazia e que **não tem substituto no painel** é trocar a árvore
 * de uma skill que já existe — inclusive trazer binário para ela. Reimportar o
 * pacote não serve, e a primeira versão deste comentário dizia que servia:
 * importar para produção bate no slug ocupado (409, porque o import manda o
 * slug do frontmatter explicitamente), e importar para a quarentena e aprovar
 * cria uma **segunda** skill, deixando a original com a árvore velha, o uuid,
 * as concessões e os vínculos. Quem precisa disso hoje usa o `set_files_bulk`
 * do MCP administrativo, que continua aceitando ZIP com binário e `replace`.
 */

/**
 * Envio de arquivos avulsos para uma skill existente — **só texto**
 * (`docs/15-quarentena.md`).
 *
 * A régua é a mesma do banco e do `extractZip` (`isTextualContent`): mime
 * textual pelo nome, sem byte nulo e UTF-8 válido. Um `.png`, um `.pdf` ou um
 * `.csv` em Windows-1252 é recusado aqui, com o nome do arquivo na mensagem.
 *
 * Era, até esta versão: qualquer arquivo entrava, e o binário ia para o
 * `bytea`. A edição de uma skill ficou sendo o lugar de escrever texto; pacote
 * com binário entra pela importação, que decide entre produção e quarentena.
 */
api.post(
  '/api/skills/:slug/files',
  access.requireSkillAccess('edit'),
  limitRequestBytes,
  upload.array('files', MAX_FILES_PER_REQUEST),
  route(async (req, res) => {
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (uploaded.length === 0) {
      res.status(400).json({ error: 'bad_request', message: 'Nenhum arquivo enviado' });
      return;
    }

    // Quem não mandou `Content-Length` escapa da pré-checagem e é cortado
    // durante o stream pelo storage do `upload`; a soma conferida aqui é só a
    // rede de segurança antes de virar escrita no banco.
    if (rejectOversizedBatch(uploaded, res)) return;

    // `prefix[a]=x` chega como objeto sem protótipo, e `String()` dele estoura.
    const prefix = normalizeRelativePath(textField(req.body, 'prefix') ?? '') ?? '';
    const files = await setFiles(
      param(req, 'slug'),
      uploaded.map((file) => {
        const relativePath = prefix ? `${prefix}/${file.originalname}` : file.originalname;
        const path = normalizeRelativePath(relativePath) ?? relativePath;

        // A recusa acontece enquanto a lista é montada, antes de o lote chegar
        // a `setFiles`: meio lote gravado é pior que lote nenhum. E vem antes
        // de qualquer `toString('utf8')`, que não falha com byte inválido —
        // troca cada um por U+FFFD, sem erro e sem volta (relatório 015 da
        // auditoria de 2026-09-19).
        if (!isTextualContent(mimeTypeFor(path), file.buffer)) {
          throw badRequest(
            `"${file.originalname}" não é um arquivo de texto UTF-8. Na edição de uma skill entra ` +
              'só texto; para trazer imagens e outros binários, importe o pacote .zip ou .skill da skill.',
          );
        }

        if (!isSkillMd(path)) return { relativePath, content: file.buffer };
        return {
          relativePath,
          // Um SKILL.md avulso entra só com o corpo: os metadados da skill já
          // cadastrada mandam.
          content: Buffer.from(stripFrontmatter(file.buffer.toString('utf8')), 'utf8'),
        };
      }),
      SOURCE,
      { replace: false },
      actorFrom(req),
    );

    res.json({ files });
  }),
);

// ------------------------------------------------------------ quarentena ---

/**
 * A quarentena (`docs/15-quarentena.md`): envios esperando aprovação.
 *
 * O espaço é pobre de propósito — arquivos crus com dono, sem slug, tag,
 * vínculo, busca nem RAG. Não há concessão por objeto: quem enxerga um envio
 * (dono, admin e editor) também o edita e o descarta. Só promover passa pela
 * política da instalação.
 *
 * O endereço é o `uuid` porque não há slug, e **não há colisão de nome**: dois
 * envios do mesmo pacote convivem.
 */
api.get(
  '/api/quarantine',
  route(async (req, res) => {
    const page = await quarantine.list(req.user!, {
      limit: asInt(req.query.limit, 50),
      offset: asInt(req.query.offset, 0),
      search: typeof req.query.q === 'string' ? req.query.q : null,
    });
    // O dono sai pelo e-mail, nunca pelo uuid da conta (`access.ownerByEmail`).
    res.json({ ...page, items: page.items.map(access.ownerByEmail) });
  }),
);

/**
 * Quem pode promover, segundo a política da instalação e o que esta sessão é.
 * O painel usa o campo para decidir se mostra o botão; a rota de promover
 * confere de novo, que é onde a decisão vale.
 */
api.get(
  '/api/quarantine/:uuid',
  route(async (req, res) => {
    const found = await quarantine.load(req.user!, param(req, 'uuid'));
    // `QuarantineSheet` é o contrato do painel: a ficha mais o `canPromote`.
    const sheet: QuarantineSheet = {
      ...access.ownerByEmail(found),
      canPromote: await quarantine.mayPromote(req.user!, found),
    };
    res.json(sheet);
  }),
);

api.delete(
  '/api/quarantine/:uuid',
  route(async (req, res) => {
    const found = await quarantine.load(req.user!, param(req, 'uuid'));
    await deleteQuarantine(found.uuid, SOURCE, actorFrom(req));
    res.json({ deleted: true });
  }),
);

/** O pacote do envio, como ele está — nada é remontado (ver `quarantine.streamZip`). */
api.get(
  '/api/quarantine/:uuid/download',
  route(async (req, res) => {
    const found = await quarantine.load(req.user!, param(req, 'uuid'));
    await quarantine.streamZip(res, found, await readAllQuarantineFiles(found.uuid));
  }),
);

/**
 * Aprova o envio: cria a skill em produção e **apaga** a linha da quarentena.
 *
 * A skill nasce flutuante e com o dono do envio — quem aprova não toma para si
 * o que outro trouxe. Slug ocupado ganha sufixo (`-2`), e sem SKILL.md a
 * promoção é recusada sem apagar nada; as duas coisas são do banco.
 */
api.post(
  '/api/quarantine/:uuid/promote',
  route(async (req, res) => {
    const found = await quarantine.load(req.user!, param(req, 'uuid'));
    await quarantine.assertCanPromote(req.user!, found);
    const detail = await promoteQuarantine(found.uuid, SOURCE, actorFrom(req));
    res.status(201).json(bodyOnly(access.withGrants(detail)));
  }),
);

/**
 * Um arquivo do envio, **cru**: o SKILL.md daqui não passa por `composeSkillMd`
 * nem por `stripFrontmatter`. Na quarentena não existe metadado em coluna, logo
 * não existe nada a remontar — o que foi enviado é o que se lê e o que se edita.
 *
 * Com `?raw`, os mesmos cuidados da rota da skill: conteúdo de terceiro servido
 * na origem do painel desce como texto, sob CSP de `sandbox`, para que um
 * `.html` ou `.svg` anexado não rode JavaScript autenticado como o operador.
 */
api.get(
  '/api/quarantine/:uuid/files/*path',
  route(async (req, res) => {
    const found = await quarantine.load(req.user!, param(req, 'uuid'));

    const path = normalizeRelativePath(param(req, 'path'));
    const file = path ? await readQuarantineFile(found.uuid, path) : null;
    if (!file) {
      res.status(404).json({ error: 'not_found', message: 'Arquivo não encontrado' });
      return;
    }

    if (req.query.raw !== undefined) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Type', safeContentType(file.mimeType, file.isText));
      res.setHeader('Content-Disposition', contentDisposition(file.relativePath, 'inline'));
      res.setHeader('Cache-Control', 'private, no-cache');
      res.send(file.buffer);
      return;
    }

    res.json({
      relativePath: file.relativePath,
      mimeType: file.mimeType,
      sizeBytes: file.buffer.byteLength,
      isText: file.isText,
      content: file.isText ? file.buffer.toString('utf8') : null,
    });
  }),
);

/** Grava o arquivo do envio como veio, frontmatter incluído. */
api.put(
  '/api/quarantine/:uuid/files/*path',
  route(async (req, res) => {
    const content = (req.body as { content?: unknown })?.content;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'O campo "content" é obrigatório' });
      return;
    }
    const found = await quarantine.load(req.user!, param(req, 'uuid'));
    const raw = param(req, 'path');
    const path = normalizeRelativePath(raw);
    if (!path) {
      res.status(400).json({ error: 'bad_request', message: `Caminho inválido: ${raw}` });
      return;
    }
    assertTextPath(path);
    res.json(await setQuarantineFile(found.uuid, path, content, SOURCE, actorFrom(req)));
  }),
);

/** Cria o arquivo só se o caminho está livre; ocupado é 409, como na skill. */
api.post(
  '/api/quarantine/:uuid/files/*path',
  route(async (req, res) => {
    const raw = (req.body as { content?: unknown } | undefined)?.content;
    const content = raw === undefined ? '' : raw;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'O campo "content" deve ser uma string' });
      return;
    }
    const path = normalizeRelativePath(param(req, 'path')) ?? param(req, 'path');
    assertTextPath(path);
    const found = await quarantine.load(req.user!, param(req, 'uuid'));
    quarantine.assertHasRoom(found);
    res.status(201).json(
      await createQuarantineFile(found.uuid, param(req, 'path'), content, SOURCE, actorFrom(req)),
    );
  }),
);

api.delete(
  '/api/quarantine/:uuid/files/*path',
  route(async (req, res) => {
    const found = await quarantine.load(req.user!, param(req, 'uuid'));
    await deleteQuarantineFile(found.uuid, param(req, 'path'), SOURCE, actorFrom(req));
    res.json({ deleted: true });
  }),
);

/** Campo multipart com JSON; ausente ou inválido é "nada", e a lista é conferida depois. */
function parseJsonList(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Aceita também uma lista separada por vírgulas.
  }
  return raw.split(',').map((tag) => tag.trim()).filter(Boolean);
}
