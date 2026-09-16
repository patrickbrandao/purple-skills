import express, { Router, type Request, type Response } from 'express';
import {
  AppError,
  badRequest,
  countUsers,
  createSkill,
  deleteFile,
  deleteSkill,
  getUserByUuid,
  healthCheck,
  listAuditPage,
  listSkills,
  listTags,
  readAllFiles,
  readFile,
  setFile,
  setFiles,
  stats,
  updateSkillWithContent,
} from '@purple-skills/db';
import {
  ZipError,
  canManage,
  composeSkillMd,
  isAccessScope,
  contentDisposition,
  extractZip,
  isSkillMd,
  normalizeRelativePath,
  safeContentType,
  skillMetaFromMarkdown,
  stripFrontmatter,
} from '@purple-skills/shared';
import {
  actorFrom,
  checkBootstrapPassword,
  clearSession,
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
import { gravarRag, lerPainelRag, reindexarRag } from './rag.js';
import * as accesses from './accesses.js';
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
import { config, oidcEnabled, panelBaseUrl, smtpEnabled } from './config.js';
import { createRateLimiter } from './ratelimit.js';
import { limitRequestBytes, rejectOversizedBatch, upload } from './uploads.js';
import { streamSkillZip } from './zip.js';

const SOURCE = 'web-admin' as const;

/** Corpo pequeno das rotas de credencial — lido antes de haver sessão. */
const smallJson = express.json({ limit: '4kb' });

/** Primeira camada do rate limiting: janela em memória por IP (§2.7). */
const loginLimiter = createRateLimiter({
  max: config.loginIpMaxAttempts,
  windowSeconds: config.loginIpWindowSeconds,
});

function param(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  return Array.isArray(value) ? value.join('/') : String(value ?? '');
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

/** `true` quando a tentativa passou pela janela por IP. */
function throttled(req: Request, res: Response): boolean {
  if (loginLimiter.hit(req.ip ?? 'sem-ip')) return false;

  const retry = loginLimiter.retryAfter(req.ip ?? 'sem-ip');
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

/**
 * O painel é same-origin: uma escrita com `Origin` de outro site é CSRF.
 *
 * O cookie de sessão é `SameSite=Lax`, o que já barra o ataque nos navegadores
 * atuais — mas as rotas de upload aceitam `multipart/form-data`, que não
 * dispara preflight, então a única barreira hoje é o `Lax`. Esta checagem é a
 * segunda camada, para o dia em que essa premissa mudar.
 */
api.use('/api', (req, res, next) => {
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

  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    res.status(403).json({ error: 'forbidden', message: 'Origem inválida' });
    return;
  }

  const allowed =
    hostname === req.hostname ||
    config.extraAllowedOrigins.some((entry) => {
      try {
        return new URL(entry).hostname === hostname;
      } catch {
        return false;
      }
    });

  if (!allowed) {
    res.status(403).json({ error: 'forbidden', message: 'Origem não permitida' });
    return;
  }

  next();
});

// --------------------------------------------------------------- sessão ----

api.get(
  '/api/session',
  route(async (req, res) => {
    const user = await resolveUser(req);
    const total = await countUsers();

    res.json({
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
      needsSetup: total === 0,
      legacyLogin: total === 0,
      oidc: oidcEnabled() ? { enabled: true, name: config.oidcProviderName } : { enabled: false },
      passwordResetByEmail: smtpEnabled(),
      siteName: config.siteName,
      brand: { name: config.brandName, iconUrl: config.brandIconUrl },
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
    });
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

    const body = req.body as { password?: unknown; email?: unknown; name?: unknown; adminPassword?: unknown };
    if (!checkBootstrapPassword(body.adminPassword)) {
      res.status(401).json({
        error: 'unauthorized',
        message: 'ADMIN_PASSWORD incorreta — ela é a credencial que autoriza criar o primeiro admin',
      });
      return;
    }

    const user = await bootstrapAdmin({ email: body.email, name: body.name, password: body.password });
    loginLimiter.reset(req.ip ?? 'sem-ip');
    issueSession(req, res, { uuid: user.uuid, role: user.role, tokenVersion: 0 });
    res.status(201).json({ authenticated: true, user });
  }),
);

api.post(
  '/api/login',
  smallJson,
  route(async (req, res) => {
    if (throttled(req, res)) return;

    const body = req.body as { email?: unknown; password?: unknown };

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
      loginLimiter.reset(req.ip ?? 'sem-ip');
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

    loginLimiter.reset(req.ip ?? 'sem-ip');
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

api.post('/api/logout', (_req, res) => {
  clearSession(res);
  res.json({ authenticated: false });
});

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

    const base = panelBaseUrl(req.protocol, req.get('host') ?? `localhost:${config.port}`);
    await requestPasswordReset((req.body as { email?: unknown })?.email, (token) =>
      `${base}/?reset=${encodeURIComponent(token)}`,
    );

    // Resposta idêntica para e-mail existente e inexistente: o formulário não
    // pode virar um verificador de quem tem conta aqui.
    res.json({ requested: true });
  }),
);

api.post(
  '/api/password-reset/confirm',
  smallJson,
  route(async (req, res) => {
    if (throttled(req, res)) return;
    const body = req.body as { token?: unknown; password?: unknown };
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
    const body = req.body as { currentPassword?: unknown; newPassword?: unknown };
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
    const body = req.body as { email?: unknown; name?: unknown; role?: unknown; password?: unknown };
    const created = await createAccount(actorFrom(req), body);
    res.status(201).json(created);
  }),
);

api.patch(
  '/api/users/:uuid',
  requireAdmin,
  route(async (req, res) => {
    const body = req.body as { name?: unknown; role?: unknown; isActive?: unknown };
    res.json(await updateAccount(req.user!, param(req, 'uuid'), body));
  }),
);

api.post(
  '/api/users/:uuid/reset-password',
  requireAdmin,
  route(async (req, res) => {
    res.json(await resetAccountPassword(param(req, 'uuid')));
  }),
);

// A busca de contas para compartilhar (`docs/12-acesso-granular.md` decisão
// 13): qualquer sessão, só contas ativas, e só nome, e-mail e papel. Fica
// antes de `/api/users/:uuid`, senão o Express a engole como um uuid.
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

// ------------------------------------------------------------- dashboard ---

api.get(
  '/api/stats',
  route(async (_req, res) => {
    res.json(await stats());
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
        limit: Number(q.limit ?? 50),
        offset: Number(q.offset ?? 0),
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
    res.json(
      await listSkills({
        query: typeof req.query.q === 'string' ? req.query.q : null,
        tag: typeof req.query.tag === 'string' ? req.query.tag : null,
        limit: Number(req.query.limit ?? 50),
        offset: Number(req.query.offset ?? 0),
        sort: (req.query.sort as never) ?? undefined,
        viewer: viewerOf(req.user!),
        ...(isAccessScope(req.query.scope) ? { scope: req.query.scope } : {}),
      }),
    );
  }),
);

api.post(
  '/api/skills',
  requireCreate,
  route(async (req, res) => {
    const body = req.body as {
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
    res.status(201).json(bodyOnly(detail));
  }),
);

/** Cria uma skill inteira a partir de um .zip contendo SKILL.md. */
api.post(
  '/api/skills/import',
  requireCreate,
  limitRequestBytes,
  upload.single('file'),
  route(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'bad_request', message: 'Envie um arquivo .zip no campo "file"' });
      return;
    }

    const files = extractZip(req.file.buffer);
    const skillMd = files.find((file) => file.relativePath.toLowerCase() === 'skill.md');
    if (!skillMd?.textContent) {
      res.status(400).json({ error: 'bad_request', message: 'O .zip precisa conter um SKILL.md' });
      return;
    }

    const body = req.body as {
      name?: string;
      description?: string;
      tags?: string;
      icon?: string;
      /** JSON: `[{ slug, asSkill, asPrompt, asResource }]`. */
      mcps?: string;
    };
    const meta = skillMetaFromMarkdown(skillMd.textContent);
    const fallbackName = req.file.originalname.replace(/\.zip$/i, '');
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

    res.status(201).json(bodyOnly(detail));
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
api.put(
  '/api/skills/:slug/mcps/:mcp',
  route(async (req, res) => {
    res.json(
      bodyOnly(await mcps.linkSkill(req.user!, param(req, 'mcp'), param(req, 'slug'), req.body)),
    );
  }),
);

api.delete(
  '/api/skills/:slug/mcps/:mcp',
  route(async (req, res) => {
    res.json(bodyOnly(await mcps.unlinkSkill(req.user!, param(req, 'mcp'), param(req, 'slug'))));
  }),
);

api.patch(
  '/api/skills/:slug',
  route(async (req, res) => {
    const body = req.body as {
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
    // A escrita não conhece o leitor: devolve o acesso de quem chamou, e as
    // concessões só a quem as administra.
    const seen = { ...detail, access: current.access };
    res.json(bodyOnly(canManage(seen.access) ? seen : { ...seen, grants: [] }));
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
      // autenticado como o operador. Tipos executáveis descem como texto.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Type', safeContentType(file.mimeType, file.isText));
      res.setHeader('Content-Disposition', contentDisposition(file.relativePath, 'inline'));
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
    const path = param(req, 'path');
    const stored = isSkillMd(path) ? stripFrontmatter(content) : content;
    res.json(await setFile(param(req, 'slug'), path, stored, SOURCE, actorFrom(req)));
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

/** Upload de .zip para uma skill existente. `replace=1` remove os omitidos. */
api.post(
  '/api/skills/:slug/upload',
  access.requireSkillAccess('edit'),
  limitRequestBytes,
  upload.single('file'),
  route(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'bad_request', message: 'Envie um arquivo .zip no campo "file"' });
      return;
    }

    const extracted = extractZip(req.file.buffer);
    if (extracted.length === 0) {
      res.status(400).json({ error: 'bad_request', message: 'O .zip está vazio' });
      return;
    }

    const files = await setFiles(
      param(req, 'slug'),
      extracted.map((file) => ({
        relativePath: file.relativePath,
        // Um SKILL.md vindo do .zip entra só com o corpo: os metadados da
        // skill já cadastrada mandam.
        content: isSkillMd(file.relativePath)
          ? Buffer.from(stripFrontmatter(file.textContent ?? ''), 'utf8')
          : (file.binaryContent ?? Buffer.from(file.textContent ?? '', 'utf8')),
      })),
      SOURCE,
      { replace: req.query.replace === '1' },
      actorFrom(req),
    );

    res.json({ files });
  }),
);

/** Upload de arquivos avulsos (não-zip) para uma skill existente. */
api.post(
  '/api/skills/:slug/files',
  access.requireSkillAccess('edit'),
  limitRequestBytes,
  upload.array('files', 50),
  route(async (req, res) => {
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (uploaded.length === 0) {
      res.status(400).json({ error: 'bad_request', message: 'Nenhum arquivo enviado' });
      return;
    }

    // Quem não mandou `Content-Length` escapa da pré-checagem: a soma dos
    // arquivos ainda é conferida aqui, antes de virar escrita no banco.
    if (rejectOversizedBatch(uploaded, res)) return;

    const prefix = normalizeRelativePath(String((req.body as { prefix?: string })?.prefix ?? '')) ?? '';
    const files = await setFiles(
      param(req, 'slug'),
      uploaded.map((file) => ({
        relativePath: prefix ? `${prefix}/${file.originalname}` : file.originalname,
        content: file.buffer,
      })),
      SOURCE,
      { replace: false },
      actorFrom(req),
    );

    res.json({ files });
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
