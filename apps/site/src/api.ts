import { Router, type Request, type Response } from 'express';
import { logDaBusca } from '@purple-skills/rag';
import {
  AppError,
  getSkillSummary,
  listSkills,
  recordSkillAccess,
  listTags,
  listFiles,
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
  type SkillDetail,
  type SkillSummary,
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

/**
 * O teto da consulta de busca, em caracteres. É o mesmo do `normalizeQuery` do
 * `@purple-skills/db`, que corta a perna textual; enquanto o `db` não exportar
 * o número, ele vive aqui e em `apps/mcp-public/src/tools.ts`.
 */
const MAX_QUERY_CHARS = 200;

/**
 * A consulta como as **duas** pernas da busca vão lê-la.
 *
 * `listSkills` já cortava em 200 caracteres, mas o embedding era resolvido
 * antes, com o texto cru: a perna vetorial embutia uma pergunta que a textual
 * nunca leu, e quem escolhia o tamanho do que ia ao provedor — pago, e que no
 * nível gratuito do Google é lido por revisores humanos — era o visitante
 * anônimo. Normalizar aqui, uma vez, resolve as duas coisas.
 *
 * Conta caractere e não byte, pelo mesmo motivo de ser um número só: contar
 * byte encurtaria a consulta a cada acento, e uma frase em português perderia
 * palavras que a mesma frase em inglês manteria.
 *
 * E corta na fronteira de palavra: termo partido é pior que termo ausente —
 * `websearch_to_tsquery` junta os termos com AND, então uma palavra que ninguém
 * escreveu zera a perna textual, além de embutir no vetor um pedaço de palavra.
 */
function consultaDaBusca(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const texto = raw.trim();
  if (texto === '') return null;
  if (texto.length <= MAX_QUERY_CHARS) return texto;

  // O caractere a mais revela se o limite cai dentro de uma palavra; `\S*$`
  // tira a palavra partida e o `trimEnd`, o espaço que sobra.
  const naFronteira = texto.slice(0, MAX_QUERY_CHARS + 1).replace(/\S*$/, '').trimEnd();
  if (naFronteira !== '') return naFronteira;

  // Consulta sem espaço nenhum (um blob colado): corta no limite, sem deixar
  // sozinha a metade alta de um par surrogate — ela viraria U+FFFD no JSON do
  // provedor.
  const duro = texto.slice(0, MAX_QUERY_CHARS);
  const ultimo = duro.charCodeAt(duro.length - 1);
  return ultimo >= 0xd800 && ultimo <= 0xdbff ? duro.slice(0, -1) : duro;
}

/**
 * O que uma skill entrega ao visitante **anônimo**.
 *
 * É lista de permissão, não de negação: campo novo em `SkillSummary` nasce
 * fora do site até alguém decidir o contrário. Foi por espalhar o objeto do
 * banco inteiro (`...detail`) que o e-mail do dono e a lista de concessões
 * saíram para quem não tem login.
 *
 * Ficam de fora, campo por campo:
 *
 * - `ownerUserUuid`/`ownerEmail` — dado pessoal. O `docs/12` decisão 11 dá o
 *   dono a quem tem `view`, e o §10 aceita e-mail exposto a **conta logada**
 *   ("instalação de colaboradores"); o anônimo não é nenhum dos dois. O UUID
 *   é ainda o `sub` do cookie do painel.
 * - `grants` (no detalhe) — a ACL é de `manage`, dono e admin (decisão 11),
 *   como o painel e o mcp-admin já fazem.
 * - `isActive`/`isPublic`/`access` — estado interno. Nesta superfície são
 *   constantes ou nulos (a visibilidade `'open'` já exige skill ligada e
 *   legível), então não informam o site e revelam a política de cada skill.
 * - `catalogs` da skill — vazio nesta visibilidade.
 * - `direct`/`catalogs` de cada vMCP — dizem por qual catálogo a skill chega
 *   ao servidor, e esse catálogo pode ser privado (basta estar ligado).
 *
 * O resto é o que a página usa. `icon` fica: é metadado público da skill, como
 * nome e descrição, e o cartão pode passar a exibi-lo.
 */
function skillPublica(skill: SkillSummary) {
  return {
    uuid: skill.uuid,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    icon: skill.icon,
    mcps: skill.mcps.map((mcp) => ({
      uuid: mcp.uuid,
      slug: mcp.slug,
      name: mcp.name,
      isOpen: mcp.isOpen,
      isActive: mcp.isActive,
      isDefault: mcp.isDefault,
      asSkill: mcp.asSkill,
      asPrompt: mcp.asPrompt,
      asResource: mcp.asResource,
    })),
    viewCount: skill.viewCount,
    downloadCount: skill.downloadCount,
    score: skill.score,
    tags: skill.tags,
    fileCount: skill.fileCount,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

/**
 * O detalhe pela mesma regra: o SKILL.md e a lista de arquivos, sem `grants`.
 *
 * `files` passa direto porque já nasce recortado no banco (`listFiles` traz
 * quatro colunas), como os campos do catálogo público — o objeto largo, e o
 * único que carrega gente, é a skill.
 */
function detalhePublico(detail: SkillDetail) {
  return { ...skillPublica(detail), skillMd: detail.skillMd, files: detail.files };
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
 *
 * **Sem `description`.** `resolveDefaultVirtualMcp` não filtra visibilidade — e
 * não deve: o padrão pode ser fechado e continua respondendo em `/mcp` com
 * chave. Então o que sai daqui sai para o anônimo qualquer que seja o estado do
 * servidor, e a descrição é texto livre, onde cabe nome de cliente, de projeto
 * ou de time. Quando o padrão é **aberto** a descrição já sai em `/api/mcps`
 * (`listOpenVirtualMcps`); quando é **fechado**, saía só por aqui, e a página
 * não a usa em lugar nenhum.
 *
 * `slug` e `name` ficam: são o que o `GET /` do próprio mcp-public anuncia ao
 * anônimo (`docs/09-mcp-padrao-e-skills-flutuantes.md` §3.2,
 * `defaultMcp: { status, slug, name, auth }`), e sem o nome o cartão de
 * endereços diria que "algum servidor" exige chave.
 */
async function mcpPublico() {
  const resolved = await resolveDefaultVirtualMcp();
  if (resolved.status === 'ok') {
    return {
      status: 'ok' as const,
      slug: resolved.mcp.slug,
      name: resolved.mcp.name,
      requiresKey: !resolved.mcp.isOpen,
    };
  }
  return { status: resolved.status, slug: resolved.slug, name: null, requiresKey: null };
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
    // Os membros são `SkillSummary` do banco: passam pela mesma projeção da
    // lista — um catálogo público multiplica o vazamento pelos membros dele.
    res.json({ ...catalog, skills: catalog.skills.map(skillPublica) });
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
    // Uma normalização só, antes das duas pernas: o vetor e o texto precisam
    // ler a mesma pergunta (ver `consultaDaBusca`).
    const query = consultaDaBusca(req.query.q);
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
    // Os itens saem projetados — a lista é a superfície mais fácil de varrer.
    const { neighbors: _distancias, items, ...resposta } = result;
    res.json({ ...resposta, items: items.map(skillPublica) });
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
      ...detalhePublico(detail),
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
  // `image/svg+xml` na origem do site permitiria rodar JS no domínio:
  // tipos executáveis descem como texto, e nada é renderizado inline.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Type', safeContentType(file.mimeType, file.isText));
  res.setHeader('Content-Length', String(buffer.byteLength));
  // `private`: um cache compartilhado no caminho continuaria servindo o arquivo
  // por até um minuto depois de a skill ser despublicada, e o conteúdo pode ser
  // de skill privada aberta por vMCP ou catálogo público. O ganho no navegador
  // de quem já abriu a página fica de pé; o mcp-public serve o equivalente com
  // `no-store`.
  res.setHeader('Cache-Control', 'private, max-age=60');
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

    // A lista, não o conteúdo: cada arquivo é lido dentro do `streamSkillZip`,
    // na vez de entrar no pacote. Ler a skill inteira aqui punha até centenas de
    // MB na memória antes do primeiro byte, e o download é anônimo.
    const files = await listFiles(skill.uuid);
    registrarAcesso(req, skill.uuid, 'download', 'download');
    await streamSkillZip(res, skill.slug, files, (path) => readFile(skill.uuid, path), skill, ext);
  });

api.get('/skills/:slug/download', serveZip('zip'));
api.get('/api/skills/:slug/download', serveZip('zip'));
api.get('/skills/:slug/download.skill', serveZip('skill'));
api.get('/api/skills/:slug/download.skill', serveZip('skill'));
