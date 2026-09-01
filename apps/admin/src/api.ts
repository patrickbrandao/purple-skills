import { Router, type Request, type Response } from 'express';
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
  updateSkill,
} from '@purple-skills/db';
import { extractZip, normalizeRelativePath, skillMetaFromMarkdown } from '@purple-skills/shared';
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
  console.error('[admin] erro inesperado:', err);
  res.status(500).json({ error: 'internal_error', message: (err as Error)?.message ?? 'Erro interno' });
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

// --------------------------------------------------------------- sessão ----

api.get('/api/session', (req, res) => {
  res.json({
    authenticated: isAuthenticated(req),
    siteName: config.siteName,
    siteBaseUrl: config.siteBaseUrl,
  });
});

api.post('/api/login', (req, res) => {
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

    const detail = await createSkill(
      {
        name: body.name?.trim() || meta.name || fallbackName,
        description: body.description?.trim() || meta.description || '',
        skillMd: skillMd.textContent,
        tags: parseTags(body.tags),
        isPublic: body.isPublic === 'true',
      },
      SOURCE,
    );

    const attachments = files.filter((file) => file.relativePath.toLowerCase() !== 'skill.md');
    if (attachments.length > 0) {
      await setFiles(
        detail.slug,
        attachments.map((file) => ({
          relativePath: file.relativePath,
          content: file.binaryContent ?? Buffer.from(file.textContent ?? '', 'utf8'),
        })),
        SOURCE,
        { replace: false },
      );
    }

    res.status(201).json(await getSkillDetail(detail.slug, { includePrivate: true }));
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

    const slug = param(req, 'slug');
    if (typeof body.skillMd === 'string') {
      await setFile(slug, 'SKILL.md', body.skillMd, SOURCE);
    }

    const detail = await updateSkill(
      slug,
      {
        name: body.name,
        slug: body.slug,
        description: body.description,
        tags: body.tags,
        isPublic: body.isPublic,
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
      res.setHeader('Content-Type', file.isText ? `${file.mimeType}; charset=utf-8` : file.mimeType);
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
