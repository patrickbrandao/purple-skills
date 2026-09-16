import { Router, type Request, type Response } from 'express';
import { logDaBusca } from '@purple-skills/rag';
import {
  AppError,
  getSkillSummary,
  listSkills,
  recordSkillAccess,
  listTags,
  readAllFiles,
  readFile,
  getPublicCatalog,
  getSkillDetail,
  healthCheck,
  listOpenVirtualMcps,
  listPublicCatalogs,
  resolveDefaultVirtualMcp,
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
import { buscaSemantica } from './rag.js';
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

/**
 * O MCP público é o vMCP padrão da instalação
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`): o site diz qual é, se exige
 * chave e, quando não há nenhum em pé, por quê — em vez de anunciar um
 * endereço que responde 404. Resolvido a cada chamada, como no mcp-public.
 */
async function mcpPublico() {
  const resolved = await resolveDefaultVirtualMcp();
  if (resolved.status === 'ok') {
    return {
      status: 'ok' as const,
      slug: resolved.mcp.slug,
      name: resolved.mcp.name,
      description: resolved.mcp.description,
      requiresKey: !resolved.mcp.isOpen,
    };
  }
  return { status: resolved.status, slug: resolved.slug, name: null, description: null, requiresKey: null };
}

api.get(
  '/api/meta',
  asyncRoute(async (_req, res) => {
    res.json({
      name: config.siteName,
      tagline: config.siteTagline,
      baseUrl: config.siteBaseUrl,
      mcpUrl: config.mcpPublicUrl || null,
      mcp: await mcpPublico(),
      mcpAdminUrl: config.mcpAdminUrl || null,
      adminUrl: config.adminUrl || null,
    });
  }),
);

/**
 * Os MCPs virtuais abertos e ligados (`docs/09-mcp-padrao-e-skills-flutuantes.md`
 * §4.2): o que o site lista, com o endereço de cada um. Sem `MCP_PUBLIC_URL`
 * o endereço fica nulo, como o do MCP público.
 */
api.get(
  '/api/mcps',
  asyncRoute(async (_req, res) => {
    const base = config.mcpPublicBaseUrl;
    const items = (await listOpenVirtualMcps()).map((mcp) => ({
      ...mcp,
      url: base ? `${base}/virtual/${encodeURIComponent(mcp.slug)}/mcp` : null,
    }));
    res.json({ items });
  }),
);

/**
 * Os catálogos públicos e ligados (`docs/12-acesso-granular.md` decisão 14):
 * a seção "Catálogos" do site. A página de um catálogo lista **todos** os
 * membros ativos, inclusive skills não marcadas públicas — um catálogo
 * público expõe o que está dentro, como um vMCP aberto (decisão 5).
 */
api.get(
  '/api/catalogs',
  asyncRoute(async (_req, res) => {
    res.json({ items: await listPublicCatalogs() });
  }),
);

api.get(
  '/api/catalogs/:slug',
  asyncRoute(async (req, res) => {
    const catalog = await getPublicCatalog(param(req, 'slug'));
    if (!catalog) {
      res.status(404).json({ error: 'not_found', message: 'Catálogo não encontrado' });
      return;
    }
    res.json(catalog);
  }),
);

/**
 * Lista/busca das skills exibidas: as vinculadas a ao menos um MCP virtual
 * aberto e ligado, as marcadas públicas e as de catálogos públicos (a
 * visibilidade `'open'` do `@purple-skills/db`, `docs/12` §7). Toda leitura
 * do site passa por essa regra — inclusive tags, arquivos e downloads.
 */
api.get(
  '/api/skills',
  asyncRoute(async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : null;
    // Falha ou prazo estourado devolvem `undefined`: a busca sai textual, e o
    // campo `mode` da resposta diz ao cliente o que ele leu.
    const { semantic } = await buscaSemantica.resolver(query);

    const result = await listSkills({
      query,
      tag: typeof req.query.tag === 'string' ? req.query.tag : null,
      limit: asInt(req.query.limit, 24),
      offset: asInt(req.query.offset, 0),
      sort: (req.query.sort as never) ?? undefined,
      visibility: 'open',
      ...(semantic ? { semantic } : {}),
    });

    if (result.mode === 'hybrid') console.log(logDaBusca(result.mode, result.neighbors));

    // `neighbors` é do servidor: as distâncias não vão para o cliente (§8.1).
    const { neighbors: _distancias, ...resposta } = result;
    res.json(resposta);
  }),
);

api.get(
  '/api/tags',
  asyncRoute(async (_req, res) => {
    res.json({ items: await listTags({ visibility: 'open' }) });
  }),
);

/**
 * O registro por leitura (`docs/13-fichas-e-acessos.md`): o site é anônimo,
 * então a linha leva só o IP e o agente. Melhor esforço, como os contadores
 * sempre foram — o banco soma `view_count`/`download_count` na mesma escrita.
 */
function registrarAcesso(req: Request, skillUuid: string, kind: 'view' | 'download', surface: 'page' | 'file' | 'download'): void {
  Promise.resolve()
    .then(() =>
      recordSkillAccess({
        skillUuid,
        kind,
        surface,
        origin: 'site',
        auth: 'anonymous',
        ip: req.ip,
        userAgent: req.get('user-agent') ?? undefined,
      }),
    )
    .catch((err: unknown) => {
      console.warn('[site] não foi possível registrar o acesso:', (err as Error).message);
    });
}

/** Detalhe da skill — registra um acesso (view_count). `mcps` traz só os abertos. */
api.get(
  '/api/skills/:slug',
  asyncRoute(async (req, res) => {
    const detail = await getSkillDetail(param(req, 'slug'), { visibility: 'open' });
    if (!detail) {
      res.status(404).json({ error: 'not_found', message: 'Skill não encontrada' });
      return;
    }

    registrarAcesso(req, detail.uuid, 'view', 'page');
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
  const skill = await getSkillSummary(param(req, 'slug'), { visibility: 'open' });
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
    registrarAcesso(req, skill.uuid, 'view', 'file');
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
    const skill = await getSkillSummary(param(req, 'slug'), { visibility: 'open' });
    if (!skill) {
      res.status(404).json({ error: 'not_found', message: 'Skill não encontrada' });
      return;
    }

    const files = await readAllFiles(skill.uuid);
    registrarAcesso(req, skill.uuid, 'download', 'download');
    streamSkillZip(res, skill.slug, files, skill, ext);
  });

api.get('/skills/:slug/download', serveZip('zip'));
api.get('/api/skills/:slug/download', serveZip('zip'));
api.get('/skills/:slug/download.skill', serveZip('skill'));
api.get('/api/skills/:slug/download.skill', serveZip('skill'));
