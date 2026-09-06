import { Router, type Request, type Response } from 'express';
import {
  AppError,
  getSkillSummary,
  incrementDownloadCount,
  incrementViewCount,
  listSkills,
  listTags,
  readAllFiles,
  readFile,
  getSkillDetail,
  healthCheck,
} from '@purple-skills/db';
import {
  composeSkillMd,
  contentDisposition,
  isSkillMd,
  normalizeRelativePath,
  safeContentType,
  stripFrontmatter,
} from '@purple-skills/shared';
import { config } from './config.js';
import { streamSkillZip } from './zip.js';

/** Junta os segmentos capturados por um wildcard do Express 5. */
function splat(value: unknown): string {
  if (Array.isArray(value)) return value.join('/');
  return typeof value === 'string' ? value : '';
}

/** Parâmetro de rota como string (rotas com wildcard tipam como união). */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, unknown>)[name];
  return Array.isArray(value) ? value.join('/') : String(value ?? '');
}

function asInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function fail(res: Response, err: unknown) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }
  console.error('[api] erro inesperado:', err);
  res.status(500).json({ error: 'internal_error', message: 'Erro interno' });
}

const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response) => {
    handler(req, res).catch((err) => fail(res, err));
  };

export const api = Router();

api.get(
  '/healthz',
  asyncRoute(async (_req, res) => {
    const ok = await healthCheck();
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded' });
  }),
);

api.get(
  '/api/meta',
  asyncRoute(async (_req, res) => {
    res.json({
      name: config.siteName,
      tagline: config.siteTagline,
      baseUrl: config.siteBaseUrl,
      mcpUrl: config.mcpPublicUrl || null,
      mcpAdminUrl: config.mcpAdminUrl || null,
      adminUrl: config.adminUrl || null,
    });
  }),
);

/** Lista/busca de skills públicas. */
api.get(
  '/api/skills',
  asyncRoute(async (req, res) => {
    const result = await listSkills({
      query: typeof req.query.q === 'string' ? req.query.q : null,
      tag: typeof req.query.tag === 'string' ? req.query.tag : null,
      limit: asInt(req.query.limit, 24),
      offset: asInt(req.query.offset, 0),
      sort: (req.query.sort as never) ?? undefined,
      includePrivate: false,
    });
    res.json(result);
  }),
);

api.get(
  '/api/tags',
  asyncRoute(async (_req, res) => {
    res.json({ items: await listTags({ includePrivate: false }) });
  }),
);

/** Detalhe da skill — conta um acesso (view_count). */
api.get(
  '/api/skills/:slug',
  asyncRoute(async (req, res) => {
    const detail = await getSkillDetail(param(req, 'slug'), { includePrivate: false });
    if (!detail) {
      res.status(404).json({ error: 'not_found', message: 'Skill não encontrada' });
      return;
    }

    await incrementViewCount(detail.uuid);
    res.json({
      ...detail,
      // Os metadados estão nos campos do próprio JSON; `skillMd` traz só o
      // corpo do prompt. O SKILL.md completo sai em /files/SKILL.md e no zip.
      skillMd: stripFrontmatter(detail.skillMd),
      viewCount: detail.viewCount + 1,
      score: detail.score + 1,
    });
  }),
);

/**
 * Arquivo avulso da skill. Só o SKILL.md conta acesso — os demais arquivos
 * são servidos sem incrementar contador.
 */
const serveFile = asyncRoute(async (req, res) => {
  const skill = await getSkillSummary(param(req, 'slug'), { includePrivate: false });
  if (!skill) {
    res.status(404).json({ error: 'not_found', message: 'Skill não encontrada' });
    return;
  }

  const path = normalizeRelativePath(splat(req.params.path));
  if (!path) {
    res.status(400).json({ error: 'bad_request', message: 'Caminho inválido' });
    return;
  }

  const file = await readFile(skill.uuid, path);
  if (!file) {
    res.status(404).json({ error: 'not_found', message: 'Arquivo não encontrado' });
    return;
  }

  // O SKILL.md é montado na hora: metadados da skill nas primeiras linhas,
  // prompt gravado logo abaixo.
  let buffer = file.buffer;
  if (isSkillMd(file.relativePath)) {
    buffer = Buffer.from(composeSkillMd(skill, file.buffer.toString('utf8')), 'utf8');
    await incrementViewCount(skill.uuid);
  }

  // Arquivos de skill são conteúdo de terceiros. Servi-los como `text/html` ou
  // `image/svg+xml` na origem do catálogo permitiria rodar JS no domínio:
  // tipos executáveis descem como texto, e nada é renderizado inline.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Type', safeContentType(file.mimeType, file.isText));
  res.setHeader('Content-Length', String(buffer.byteLength));
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Content-Disposition', contentDisposition(file.relativePath, 'attachment'));
  res.send(buffer);
});

api.get('/api/skills/:slug/files/*path', serveFile);
api.get('/skills/:slug/files/*path', serveFile);

/**
 * Download do pacote — conta um download. O `.skill` é o mesmo ZIP servido com
 * outra extensão (o formato aberto de Agent Skills).
 */
const serveZip = (ext: 'zip' | 'skill') =>
  asyncRoute(async (req, res) => {
    const skill = await getSkillSummary(param(req, 'slug'), { includePrivate: false });
    if (!skill) {
      res.status(404).json({ error: 'not_found', message: 'Skill não encontrada' });
      return;
    }

    const files = await readAllFiles(skill.uuid);
    await incrementDownloadCount(skill.uuid);
    streamSkillZip(res, skill.slug, files, skill, ext);
  });

api.get('/skills/:slug/download', serveZip('zip'));
api.get('/api/skills/:slug/download', serveZip('zip'));
api.get('/skills/:slug/download.skill', serveZip('skill'));
api.get('/api/skills/:slug/download.skill', serveZip('skill'));
