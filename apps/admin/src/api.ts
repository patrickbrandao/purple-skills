import express, { Router, type Request, type Response } from 'express';
import multer from 'multer';
import {
  AppError,
  createSkill,
  deleteFile,
  deleteSkill,
  getSkillDetail,
  getSkillSummary,
  healthCheck,
  listAudit,
  listSkills,
  listTags,
  readFile,
  setFile,
  setFiles,
  setVisibility,
  stats,
  updateSkillWithContent,
} from '@purple-skills/db';
import {
  ZipError,
  contentDisposition,
  extractZip,
  normalizeRelativePath,
  safeContentType,
  skillMetaFromMarkdown,
} from '@purple-skills/shared';
import { checkPassword, clearSession, isAuthenticated, issueSession, requireAuth } from './auth.js';
import { config } from './config.js';

const SOURCE = 'web-admin' as const;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
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

api.get('/api/session', (req, res) => {
  res.json({
    authenticated: isAuthenticated(req),
    siteName: config.siteName,
    siteBaseUrl: config.siteBaseUrl,
  });
});

api.post('/api/login', express.json({ limit: '4kb' }), (req, res) => {
  if (!checkPassword((req.body as { password?: unknown })?.password)) {
    res.status(401).json({ error: 'unauthorized', message: 'Senha incorreta' });
    return;
  }
  issueSession(req, res);
  res.json({ authenticated: true });
});

api.post('/api/logout', (_req, res) => {
  clearSession(res);
  res.json({ authenticated: false });
});

api.use('/api', requireAuth);

// Corpos grandes (SKILL.md, arquivos de texto) só são lidos depois que a sessão
// foi validada.
api.use('/api', express.json({ limit: '32mb' }));

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
        skillMd: body.skillMd ?? '',
        tags: body.tags,
        isPublic: body.isPublic,
      },
      SOURCE,
    );
    res.status(201).json(detail);
  }),
);

/** Cria uma skill inteira a partir de um .zip contendo SKILL.md. */
api.post(
  '/api/skills/import',
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
    const attachments = files.filter((file) => file.relativePath.toLowerCase() !== 'skill.md');

    // Skill, SKILL.md e anexos numa transação só: gravar os anexos depois
    // deixava uma skill pela metade quando o segundo passo falhava, e a nova
    // tentativa criava uma duplicata com slug "-2".
    const detail = await createSkill(
      {
        name: body.name?.trim() || meta.name || fallbackName,
        description: body.description?.trim() || meta.description || '',
        skillMd: skillMd.textContent,
        tags: parseTags(body.tags),
        isPublic: body.isPublic === 'true',
        files: attachments.map((file) => ({
          relativePath: file.relativePath,
          content: file.binaryContent ?? Buffer.from(file.textContent ?? '', 'utf8'),
        })),
      },
      SOURCE,
    );

    res.status(201).json(detail);
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
    res.json(detail);
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
        skillMd: body.skillMd,
      },
      SOURCE,
    );
    res.json(detail);
  }),
);

api.post(
  '/api/skills/:slug/visibility',
  route(async (req, res) => {
    const isPublic = (req.body as { isPublic?: unknown })?.isPublic === true;
    res.json(await setVisibility(param(req, 'slug'), isPublic, SOURCE));
  }),
);

api.delete(
  '/api/skills/:slug',
  route(async (req, res) => {
    await deleteSkill(param(req, 'slug'), SOURCE);
    res.json({ deleted: true });
  }),
);

// --------------------------------------------------------------- arquivos ---

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

    if (req.query.raw !== undefined) {
      // "Abrir cru" na origem do painel: um .html/.svg anexado rodaria JS
      // autenticado como o operador. Tipos executáveis descem como texto.
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Type', safeContentType(file.mimeType, file.isText));
      res.setHeader('Content-Disposition', contentDisposition(file.relativePath, 'inline'));
      res.send(file.buffer);
      return;
    }

    res.json({
      relativePath: file.relativePath,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      isText: file.isText,
      content: file.isText ? file.buffer.toString('utf8') : null,
    });
  }),
);

api.put(
  '/api/skills/:slug/files/*path',
  route(async (req, res) => {
    const content = (req.body as { content?: unknown })?.content;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'bad_request', message: 'O campo "content" é obrigatório' });
      return;
    }
    res.json(await setFile(param(req, 'slug'), param(req, 'path'), content, SOURCE));
  }),
);

api.delete(
  '/api/skills/:slug/files/*path',
  route(async (req, res) => {
    await deleteFile(param(req, 'slug'), param(req, 'path'), SOURCE);
    res.json({ deleted: true });
  }),
);

/** Upload de .zip para uma skill existente. `replace=1` remove os omitidos. */
api.post(
  '/api/skills/:slug/upload',
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
        content: file.binaryContent ?? Buffer.from(file.textContent ?? '', 'utf8'),
      })),
      SOURCE,
      { replace: req.query.replace === '1' },
    );

    res.json({ files });
  }),
);

/** Upload de arquivos avulsos (não-zip) para uma skill existente. */
api.post(
  '/api/skills/:slug/files',
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
