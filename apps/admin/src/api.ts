import express, { Router, type Request, type Response } from 'express';
import multer from 'multer';
import {
  AppError,
  countUsers,
  createSkill,
  deleteFile,
  deleteSkill,
  getSkillDetail,
  getSkillSummary,
  getUserByUuid,
  healthCheck,
  listAudit,
  listSkills,
  listTags,
  readAllFiles,
  readFile,
  setFile,
  setFiles,
  setVisibility,
  stats,
  updateSkillWithContent,
} from '@purple-skills/db';
import {
  ZipError,
  composeSkillMd,
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
  requireDelete,
  requirePasswordChanged,
  requireWrite,
  resolveUser,
} from './auth.js';
import {
  bootstrapAdmin,
  changeOwnPassword,
  confirmPasswordReset,
  createAccount,
  issueKey,
  listAccounts,
  listKeys,
  loginWithPassword,
  requestPasswordReset,
  resetAccountPassword,
  resolveOidcUser,
  revokeKey,
  updateAccount,
} from './accounts.js';
import { config, oidcEnabled, panelBaseUrl, smtpEnabled } from './config.js';
import { createRateLimiter } from './ratelimit.js';
import { streamSkillZip } from './zip.js';

const SOURCE = 'web-admin' as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

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
      siteBaseUrl: config.siteBaseUrl,
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
    role: req.user?.role ?? 'leitor',
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

// ------------------------------------------------------------- dashboard ---

api.get(
  '/api/stats',
  route(async (_req, res) => {
    res.json(await stats());
  }),
);

api.get(
  '/api/audit',
  route(async (req, res) => {
    res.json({ items: await listAudit(Number(req.query.limit ?? 60)) });
  }),
);

api.get(
  '/api/tags',
  route(async (_req, res) => {
    res.json({ items: await listTags({ includePrivate: true }) });
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
        includePrivate: true,
      }),
    );
  }),
);

api.post(
  '/api/skills',
  requireWrite,
  route(async (req, res) => {
    const body = req.body as {
      name?: string;
      slug?: string;
      description?: string;
      skillMd?: string;
      tags?: string[];
      isPublic?: boolean;
    };

    const detail = await createSkill(
      {
        name: body.name ?? '',
        slug: body.slug,
        description: body.description,
        // Os metadados vêm do formulário; o frontmatter é gerado na leitura.
        // Um bloco `---` colado no início do prompt é descartado aqui.
        skillMd: stripFrontmatter(body.skillMd ?? ''),
        tags: body.tags,
        isPublic: body.isPublic,
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
  requireWrite,
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

    const body = req.body as { name?: string; description?: string; tags?: string; isPublic?: string };
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
        isPublic: body.isPublic === 'true',
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
    const detail = await getSkillDetail(param(req, 'slug'), { includePrivate: true });
    if (!detail) {
      res.status(404).json({ error: 'not_found', message: 'Skill não encontrada' });
      return;
    }
    res.json(bodyOnly(detail));
  }),
);

api.patch(
  '/api/skills/:slug',
  requireWrite,
  route(async (req, res) => {
    const body = req.body as {
      name?: string;
      slug?: string;
      description?: string;
      tags?: string[];
      isPublic?: boolean;
      skillMd?: string;
    };

    // Conteúdo e metadados numa transação só: se o slug colidir ou o nome vier
    // vazio, o SKILL.md também não é gravado.
    const detail = await updateSkillWithContent(
      param(req, 'slug'),
      {
        name: body.name,
        slug: body.slug,
        description: body.description,
        tags: body.tags,
        isPublic: body.isPublic,
        skillMd: typeof body.skillMd === 'string' ? stripFrontmatter(body.skillMd) : undefined,
      },
      SOURCE,
      actorFrom(req),
    );
    res.json(bodyOnly(detail));
  }),
);

api.post(
  '/api/skills/:slug/visibility',
  requireWrite,
  route(async (req, res) => {
    const isPublic = (req.body as { isPublic?: unknown })?.isPublic === true;
    res.json(await setVisibility(param(req, 'slug'), isPublic, SOURCE, actorFrom(req)));
  }),
);

api.delete(
  '/api/skills/:slug',
  requireDelete,
  route(async (req, res) => {
    await deleteSkill(param(req, 'slug'), SOURCE, actorFrom(req));
    res.json({ deleted: true });
  }),
);

// --------------------------------------------------------------- arquivos ---

/**
 * Download do pacote da skill. `.zip` e `.skill` são o mesmo ZIP — só muda a
 * extensão do arquivo baixado (o `.skill` é o formato aberto de Agent Skills).
 * Serve skills privadas: a rota já está atrás de `requireAuth`.
 */
const serveSkillPackage = (ext: 'zip' | 'skill') =>
  route(async (req, res) => {
    const skill = await getSkillSummary(param(req, 'slug'), { includePrivate: true });
    if (!skill) {
      res.status(404).json({ error: 'not_found', message: 'Skill não encontrada' });
      return;
    }

    const files = await readAllFiles(skill.uuid);
    await streamSkillZip(res, skill.slug, files, skill, ext);
  });

api.get('/api/skills/:slug/download', serveSkillPackage('zip'));
api.get('/api/skills/:slug/download.skill', serveSkillPackage('skill'));

api.get(
  '/api/skills/:slug/files/*path',
  route(async (req, res) => {
    const skill = await getSkillSummary(param(req, 'slug'), { includePrivate: true });
    if (!skill) {
      res.status(404).json({ error: 'not_found', message: 'Skill não encontrada' });
      return;
    }

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
  requireWrite,
  route(async (req, res) => {
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
  requireWrite,
  route(async (req, res) => {
    await deleteFile(param(req, 'slug'), param(req, 'path'), SOURCE, actorFrom(req));
    res.json({ deleted: true });
  }),
);

/** Upload de .zip para uma skill existente. `replace=1` remove os omitidos. */
api.post(
  '/api/skills/:slug/upload',
  requireWrite,
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
  requireWrite,
  upload.array('files', 50),
  route(async (req, res) => {
    const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (uploaded.length === 0) {
      res.status(400).json({ error: 'bad_request', message: 'Nenhum arquivo enviado' });
      return;
    }

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
