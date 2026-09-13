import { sql, type SQL } from 'drizzle-orm';
import {
  SKILL_MD,
  isRole,
  isSkillMd,
  isTextualMime,
  isValidSlug,
  mimeTypeFor,
  normalizeRelativePath,
  normalizeSkillIcon,
  skillScore,
  slugify,
  uniqueSlug,
  type ApiKeySummary,
  type AuditAction,
  type AuditActor,
  type AuditEntry,
  type AuditPage,
  type AuditSource,
  type CanvasPoint,
  type McpSessionAuth,
  type McpSessionEndReason,
  type McpSessionMount,
  type McpSessionPage,
  type McpSessionSummary,
  type McpSessionTransport,
  type PublicVirtualMcp,
  type Role,
  type SkillDetail,
  type SkillFileMeta,
  type SkillLinkInput,
  type SkillMcpRef,
  type SkillSummary,
  type SearchResult,
  type UserSummary,
  type VirtualMcpDetail,
  type VirtualMcpKeySummary,
  type VirtualMcpLayout,
  type VirtualMcpPreviewSkill,
  type VirtualMcpSkill,
  type VirtualMcpSkillInput,
  type VirtualMcpSummary,
  type VirtualSurface,
} from '@purple-skills/shared';
import { getDb, type Database } from './client.js';
import {
  badRequest,
  conflict,
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
} from './errors.js';

type Row = Record<string, any>;

const db = () => getDb().db;

export type SortOrder = 'score' | 'recent' | 'name' | 'relevance';

/**
 * Recorte de um MCP virtual (`docs/08-mcp-virtual.md` §3.2): a leitura passa
 * a enxergar só as skills **vinculadas** a ele e ligadas na superfície pedida
 * (`as_skill`, `as_prompt` ou `as_resource` do vínculo). Quando presente,
 * `visibility` é ignorada: quem decide é o vínculo.
 */
export type VirtualScope = { uuid: string; surface: VirtualSurface };

/**
 * O que uma leitura enxerga (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4.2).
 *
 * `'open'` — o padrão, e o que o site e a API REST mostram: só skills
 * vinculadas a ao menos um vMCP **aberto e ligado**. `'all'` — o catálogo
 * inteiro, inclusive skills flutuantes (sem vínculo): painel e mcp-admin.
 * O padrão é o restritivo de propósito: um chamador que esquece a opção
 * mostra de menos, nunca de mais.
 */
export type SkillVisibility = 'open' | 'all';

export type ListOptions = {
  query?: string | null;
  tag?: string | null;
  limit?: number;
  offset?: number;
  /**
   * Mora no SQL, e não no app, porque duas das respostas não têm conserto
   * depois da consulta: o `total` de `listSkills` é um `count(*)` sobre o
   * mesmo `WHERE` da página — descartar linhas em JavaScript deixaria a
   * paginação mentindo — e a contagem por tag de `listTags` é um `GROUP BY`.
   */
  visibility?: SkillVisibility;
  /** Recorte de um MCP virtual — ver `VirtualScope`. Sobrepõe `visibility`. */
  virtualMcp?: VirtualScope;
  sort?: SortOrder;
};

/** As chaves de `ListOptions` que também valem ao ler uma skill só, ou as tags. */
type ReadOptions = Pick<ListOptions, 'visibility' | 'virtualMcp'>;

/** Vínculo com um vMCP aberto e ligado — a regra do site, em SQL. */
const OPEN_LINK_EXISTS = sql`EXISTS (
  SELECT 1 FROM virtual_mcp_skills v
  JOIN virtual_mcps m ON m.uuid = v.virtual_mcp_uuid
  WHERE v.skill_uuid = s.uuid AND m.is_open AND m.is_active
)`;

/**
 * A cláusula de visibilidade que `listSkills`, `getSkillSummary` e `listTags`
 * compartilham. Com `virtualMcp`, vira um `EXISTS` sobre o vínculo daquele
 * servidor e **só** ele; sem, é `'open'` (vínculo com vMCP aberto e ligado)
 * ou `'all'` (tudo).
 */
function visibilityClause({ visibility = 'open', virtualMcp }: ReadOptions): SQL {
  if (virtualMcp) {
    // UUID torto é "nenhuma skill", não erro do driver virando HTTP 500.
    if (!isUuid(virtualMcp.uuid)) return sql`false`;
    return sql`EXISTS (
      SELECT 1 FROM virtual_mcp_skills v
      WHERE v.skill_uuid = s.uuid
        AND v.virtual_mcp_uuid = ${virtualMcp.uuid}
        AND ${virtualSurfaceFlag(virtualMcp.surface)}
    )`;
  }
  return visibility === 'all' ? sql`true` : OPEN_LINK_EXISTS;
}

/** A coluna do vínculo (`v`) que corresponde à superfície — nunca texto do chamador. */
function virtualSurfaceFlag(surface: VirtualSurface): SQL {
  switch (surface) {
    case 'prompt':
      return sql`v.as_prompt`;
    case 'resource':
      return sql`v.as_resource`;
    default:
      return sql`v.as_skill`;
  }
}

/**
 * As colunas de `SkillSummary`. Além dos metadados, cada linha traz `mcps`: os
 * vínculos da skill, como JSON. Numa leitura `'all'` vêm todos os vínculos;
 * nas demais só os com vMCP aberto e ligado — o site não pode revelar em qual
 * servidor fechado uma skill está, e é por essa lista que o mcp-public sabe se
 * a skill tem página no site.
 */
function skillColumns({ visibility = 'open' }: ReadOptions): SQL {
  const everyLink = visibility === 'all';
  return sql`
  s.uuid, s.slug, s.name, s.description, s.icon,
  s.view_count, s.download_count,
  s.created_at, s.updated_at,
  COALESCE((
    SELECT array_agg(t.name ORDER BY t.name)
    FROM skill_tags st JOIN tags t ON t.id = st.tag_id
    WHERE st.skill_uuid = s.uuid
  ), '{}') AS tags,
  (SELECT count(*) FROM files f WHERE f.skill_uuid = s.uuid) AS file_count,
  COALESCE((
    SELECT json_agg(json_build_object(
      'uuid', m.uuid, 'slug', m.slug, 'name', m.name,
      'isOpen', m.is_open, 'isActive', m.is_active,
      'isDefault', (m.uuid::text = (SELECT st.value FROM settings st WHERE st.key = ${DEFAULT_MCP_SETTING})),
      'asSkill', v.as_skill, 'asPrompt', v.as_prompt, 'asResource', v.as_resource
    ) ORDER BY m.name, m.slug)
    FROM virtual_mcp_skills v JOIN virtual_mcps m ON m.uuid = v.virtual_mcp_uuid
    WHERE v.skill_uuid = s.uuid AND (${everyLink} OR (m.is_open AND m.is_active))
  ), '[]'::json) AS mcps
`;
}

/** O JSON do vínculo, com o `isDefault` nulo (sem padrão) normalizado. */
function toSkillMcpRefs(value: unknown): SkillMcpRef[] {
  const rows = (typeof value === 'string' ? JSON.parse(value) : value) as Row[] | null;
  return (rows ?? []).map((m) => ({
    uuid: m.uuid,
    slug: m.slug,
    name: m.name,
    isOpen: Boolean(m.isOpen),
    isActive: Boolean(m.isActive),
    isDefault: Boolean(m.isDefault),
    asSkill: Boolean(m.asSkill),
    asPrompt: Boolean(m.asPrompt),
    asResource: Boolean(m.asResource),
  }));
}

function toSummary(row: Row): SkillSummary {
  const viewCount = Number(row.view_count ?? 0);
  const downloadCount = Number(row.download_count ?? 0);

  return {
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    icon: row.icon ?? null,
    mcps: toSkillMcpRefs(row.mcps),
    viewCount,
    downloadCount,
    score: skillScore(viewCount, downloadCount),
    tags: (row.tags ?? []) as string[],
    fileCount: Number(row.file_count ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Busca paginada de skills, com full-text + fallback por substring. */
export async function listSkills(options: ListOptions = {}): Promise<SearchResult> {
  const limit = clamp(options.limit ?? 24, 1, 100);
  const offset = Math.max(0, options.offset ?? 0);
  const query = normalizeQuery(options.query);
  const tag = options.tag?.trim() || null;
  const sort = options.sort ?? (query ? 'relevance' : 'score');

  const rank = query
    ? sql`ts_rank(s.search_vector, websearch_to_tsquery('simple', ${query}))`
    : sql`0::float4`;

  const order =
    sort === 'recent'
      ? sql`s.updated_at DESC`
      : sort === 'name'
        ? sql`s.name ASC`
        : sort === 'relevance' && query
          ? sql`rank DESC, (s.view_count + s.download_count) DESC, s.updated_at DESC`
          : sql`(s.view_count + s.download_count) DESC, s.updated_at DESC`;

  // Filtro compartilhado entre a contagem e a página de resultados.
  const where = sql`
    WHERE ${visibilityClause(options)}
      ${
        query
          ? sql`AND (
              s.search_vector @@ websearch_to_tsquery('simple', ${query})
              OR s.name ILIKE ${'%' + query + '%'}
              OR s.description ILIKE ${'%' + query + '%'}
              OR s.slug ILIKE ${'%' + query + '%'}
            )`
          : sql``
      }
      ${
        tag
          ? sql`AND EXISTS (
              SELECT 1 FROM skill_tags st JOIN tags t ON t.id = st.tag_id
              WHERE st.skill_uuid = s.uuid AND lower(t.name) = lower(${tag})
            )`
          : sql``
      }
  `;

  // `count(*) OVER ()` só chega nas linhas retornadas: paginar além do fim
  // devolvia total 0. A contagem precisa ser independente de LIMIT/OFFSET.
  const counted = await db().execute(sql`
    SELECT count(*)::int AS total FROM skills s ${where}
  `);
  const total = Number((counted.rows as Row[])[0]?.total ?? 0);

  const result = await db().execute(sql`
    SELECT ${skillColumns(options)}, ${rank} AS rank
    FROM skills s
    ${where}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    items: (result.rows as Row[]).map(toSummary),
    total,
    limit,
    offset,
  };
}

/**
 * Superfície de um vMCP em que a skill é oferecida além das ferramentas.
 *
 * `'skill'` não entra aqui de propósito: a superfície de ferramentas não tem
 * listagem enxuta equivalente. Quem a serve é `listSkills`, que é paginada,
 * ordenável e devolve `SkillSummary` inteiro — nada do que `PublishedSkill`
 * existe para evitar se aplica a ela; o recorte dela é `virtualMcp` com
 * `surface: 'skill'`.
 */
export type PublicationSurface = 'prompt' | 'resource';

/** O que `prompts/list` e `resources/list` precisam de cada skill, e nada mais. */
export type PublishedSkill = {
  slug: string;
  name: string;
  description: string;
};

/**
 * As skills de um vMCP vinculadas com a flag da superfície (`as_prompt` /
 * `as_resource`), para `prompts/list` e `resources/list`.
 *
 * Não reusa `listSkills` por dois motivos: aquela limita o resultado a 100, o
 * que esconderia skills em silêncio numa listagem que o protocolo entrega
 * inteira, sem cursor nem teto; e carrega por linha agregações que as duas
 * listagens descartam. Como não há teto, a linha precisa ser barata — daí só
 * três colunas. A ordem por slug é estável entre chamadas: a lista é
 * recomputada a cada requisição, e um catálogo embaralhado seria ruído.
 */
export async function listPublishedSkills(
  surface: PublicationSurface,
  virtualMcpUuid: string,
): Promise<PublishedSkill[]> {
  if (!isUuid(virtualMcpUuid)) return [];
  const flag = surface === 'prompt' ? sql`v.as_prompt` : sql`v.as_resource`;

  const result = await db().execute(sql`
    SELECT s.slug, s.name, s.description
    FROM virtual_mcp_skills v
    JOIN skills s ON s.uuid = v.skill_uuid
    WHERE v.virtual_mcp_uuid = ${virtualMcpUuid} AND ${flag}
    ORDER BY s.slug ASC
  `);
  return (result.rows as Row[]).map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
  }));
}

export async function getSkillSummary(
  slug: string,
  options: ReadOptions = {},
): Promise<SkillSummary | null> {
  const result = await db().execute(sql`
    SELECT ${skillColumns(options)} FROM skills s
    WHERE s.slug = ${slug} AND ${visibilityClause(options)}
    LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? toSummary(row) : null;
}

/** Skill completa: metadados + SKILL.md + lista de arquivos anexados. */
export async function getSkillDetail(
  slug: string,
  options: ReadOptions = {},
): Promise<SkillDetail | null> {
  const summary = await getSkillSummary(slug, options);
  if (!summary) return null;

  const files = await listFiles(summary.uuid);
  const skillMd = await readTextFile(summary.uuid, SKILL_MD);

  return { ...summary, skillMd: skillMd ?? '', files };
}

export async function listFiles(skillUuid: string): Promise<SkillFileMeta[]> {
  const result = await db().execute(sql`
    SELECT relative_path, mime_type, size_bytes, (text_content IS NOT NULL) AS is_text
    FROM files WHERE skill_uuid = ${skillUuid}
    ORDER BY (lower(relative_path) = 'skill.md') DESC, relative_path ASC
  `);

  return (result.rows as Row[]).map((row) => ({
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    isText: Boolean(row.is_text),
  }));
}

export type FileContent = {
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
  isText: boolean;
};

export async function readFile(
  skillUuid: string,
  relativePath: string,
): Promise<FileContent | null> {
  const result = await db().execute(sql`
    SELECT relative_path, mime_type, size_bytes, text_content, binary_content
    FROM files
    WHERE skill_uuid = ${skillUuid} AND lower(relative_path) = lower(${relativePath})
    ORDER BY relative_path
    LIMIT 1
  `);

  const row = (result.rows as Row[])[0];
  if (!row) return null;

  const isText = row.text_content !== null;
  return {
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    isText,
    buffer: isText ? Buffer.from(row.text_content, 'utf8') : Buffer.from(row.binary_content),
  };
}

export async function readTextFile(skillUuid: string, relativePath: string): Promise<string | null> {
  const file = await readFile(skillUuid, relativePath);
  if (!file) return null;
  return file.isText ? file.buffer.toString('utf8') : null;
}

/** Todos os arquivos da skill, com bytes — usado na geração do ZIP. */
export async function readAllFiles(skillUuid: string): Promise<FileContent[]> {
  const result = await db().execute(sql`
    SELECT relative_path, mime_type, size_bytes, text_content, binary_content
    FROM files WHERE skill_uuid = ${skillUuid}
    ORDER BY (lower(relative_path) = 'skill.md') DESC, relative_path ASC
  `);

  return (result.rows as Row[]).map((row) => {
    const isText = row.text_content !== null;
    return {
      relativePath: row.relative_path,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      isText,
      buffer: isText ? Buffer.from(row.text_content, 'utf8') : Buffer.from(row.binary_content),
    };
  });
}

// ------------------------------------------------------------- contadores ---

/**
 * Com `virtualMcpUuid`, soma **nos dois lugares**: no vínculo (o contador
 * "por este MCP") e no global da skill. Dois UPDATEs sem transação: são
 * contadores best-effort, e perder um incremento numa falha no meio é
 * preferível a segurar a leitura por um lock a mais.
 */
export async function incrementViewCount(skillUuid: string, virtualMcpUuid?: string): Promise<void> {
  await db().execute(sql`UPDATE skills SET view_count = view_count + 1 WHERE uuid = ${skillUuid}`);
  if (virtualMcpUuid !== undefined && isUuid(virtualMcpUuid)) {
    await db().execute(sql`
      UPDATE virtual_mcp_skills SET view_count = view_count + 1
      WHERE virtual_mcp_uuid = ${virtualMcpUuid} AND skill_uuid = ${skillUuid}
    `);
  }
}

export async function incrementDownloadCount(
  skillUuid: string,
  virtualMcpUuid?: string,
): Promise<void> {
  await db().execute(
    sql`UPDATE skills SET download_count = download_count + 1 WHERE uuid = ${skillUuid}`,
  );
  if (virtualMcpUuid !== undefined && isUuid(virtualMcpUuid)) {
    await db().execute(sql`
      UPDATE virtual_mcp_skills SET download_count = download_count + 1
      WHERE virtual_mcp_uuid = ${virtualMcpUuid} AND skill_uuid = ${skillUuid}
    `);
  }
}

// ------------------------------------------------------------------ tags ---

export async function listTags(
  options: ReadOptions = {},
): Promise<{ name: string; count: number }[]> {
  const result = await db().execute(sql`
    SELECT t.name, count(*)::int AS count
    FROM tags t
    JOIN skill_tags st ON st.tag_id = t.id
    JOIN skills s ON s.uuid = st.skill_uuid
    WHERE ${visibilityClause(options)}
    GROUP BY t.name
    ORDER BY count DESC, t.name ASC
  `);

  return (result.rows as Row[]).map((row) => ({ name: row.name, count: Number(row.count) }));
}

// -------------------------------------------------------------- escrita ----

/**
 * Texto vindo de JSON que ninguém validou.
 *
 * O MCP valida a entrada com zod antes de chegar aqui, mas a rota REST do
 * painel entrega o corpo cru: `{"slug": 123}` fazia `(123).trim()` estourar
 * `TypeError` e virar HTTP 500, quando tipo errado é erro do cliente (400).
 * `null` é tratado como ausente — cada chamador decide o que fazer com isso,
 * como já fazia com `undefined`.
 */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`O campo "${field}" deve ser uma string`);
  return value;
}

/**
 * Mesma história de `optionalText`, para a lista de tags: `{"tags": "abc"}`
 * fazia `.map` estourar. Só o container é conferido — os itens seguem
 * tolerantes em `replaceTagsTx`, que já normaliza qualquer coisa com
 * `String(tag ?? '')`.
 */
function optionalTextList(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw badRequest(`O campo "${field}" deve ser uma lista`);
  return value as readonly string[];
}

export type CreateSkillInput = {
  name: string;
  description?: string;
  /**
   * Um emoji ou a URL http(s) de uma imagem (`normalizeSkillIcon` de shared
   * é a regra). Omitido, `null` ou vazio nasce sem ícone; inválido é 400.
   */
  icon?: string | null;
  skillMd: string;
  tags?: string[];
  /**
   * Vínculos criados na mesma transação — a skill já nasce publicada onde o
   * chamador escolheu (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4.3). A
   * checagem de que o chamador administra cada vMCP é do app, antes de chamar.
   * Omitido ou vazio, a skill nasce flutuante: existe e não é exibida em
   * lugar nenhum.
   */
  mcps?: readonly SkillLinkInput[];
  slug?: string;
  /**
   * Anexos gravados na mesma transação da criação (importação de `.zip`).
   * Gravá-los depois deixaria a skill existindo sem os arquivos quando o
   * segundo passo falhasse. `SKILL.md` vem sempre por `skillMd`.
   */
  files?: readonly FileInput[];
};

/** Quantas vezes reescolher um slug gerado automaticamente após uma colisão. */
const SLUG_ATTEMPTS = 3;

export async function createSkill(
  input: CreateSkillInput,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillDetail> {
  const name = (optionalText(input.name, 'name') ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');
  if (typeof input.skillMd !== 'string' || !input.skillMd.trim()) {
    throw badRequest('O conteúdo do SKILL.md é obrigatório');
  }

  const requestedSlug = optionalText(input.slug, 'slug');
  const description = optionalText(input.description, 'description')?.trim() ?? '';
  const tags = optionalTextList(input.tags, 'tags') ?? [];
  const icon = optionalIcon(input.icon) ?? null;
  const links = await resolveLinks(input.mcps ?? []);

  // Validado antes de abrir a transação: um caminho recusado no meio da
  // gravação deixaria a skill criada sem parte dos anexos.
  const attachments = (input.files ?? [])
    .map((file) => {
      const path = normalizeRelativePath(file.relativePath);
      if (!path) throw badRequest(`Caminho inválido: ${file.relativePath}`);
      const buffer = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(file.content, 'utf8');
      return { path, buffer };
    })
    // O SKILL.md vem por `skillMd`; um homônimo entre os anexos é ignorado.
    .filter((file) => !isSkillMd(file.path));

  const explicitSlug = Boolean(requestedSlug?.trim());
  let slug = '';

  // `resolveSlug` consulta os slugs ocupados e o INSERT acontece depois: duas
  // criações simultâneas podem escolher o mesmo. Com slug gerado a partir do
  // nome, a intenção é "qualquer slug livre" e vale tentar de novo; com slug
  // pedido explicitamente, o conflito é a resposta correta.
  for (let attempt = 1; ; attempt += 1) {
    slug = await resolveSlug(requestedSlug, name);

    try {
      await db().transaction(async (tx) => {
        const inserted = await tx.execute(sql`
          INSERT INTO skills (slug, name, description, icon, created_by_user_uuid)
          VALUES (${slug}, ${name}, ${description}, ${icon}, ${actor?.userUuid ?? null})
          RETURNING uuid
        `);
        const uuid = (inserted.rows as Row[])[0].uuid as string;

        await upsertFileTx(tx, uuid, SKILL_MD, Buffer.from(input.skillMd, 'utf8'));
        for (const file of attachments) {
          await upsertFileTx(tx, uuid, file.path, file.buffer);
        }
        await replaceTagsTx(tx, uuid, tags);
        await auditTx(tx, {
          skillUuid: uuid,
          skillSlug: slug,
          filePath: null,
          action: 'create',
          source,
          actor,
          previousContent: null,
        });
        for (const link of links) {
          await linkTx(tx, uuid, link, source, actor);
        }
      });
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (explicitSlug || attempt >= SLUG_ATTEMPTS) {
        throw conflict(`Já existe uma skill com o slug "${slug}"`);
      }
    }
  }

  const detail = await getSkillDetail(slug, { visibility: 'all' });
  if (!detail) throw new Error('Skill criada mas não encontrada');
  return detail;
}

export type UpdateSkillInput = {
  name?: string;
  description?: string;
  /** `undefined` não mexe; `null` ou vazio apaga; inválido é 400 (ver `CreateSkillInput`). */
  icon?: string | null;
  tags?: string[];
  slug?: string;
};

export async function updateSkill(
  slug: string,
  input: UpdateSkillInput,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillDetail> {
  const existing = await requireSkill(slug);

  const name = optionalText(input.name, 'name')?.trim();
  if (input.name !== undefined && !name) throw badRequest('O campo "name" não pode ficar vazio');

  const description = optionalText(input.description, 'description')?.trim() ?? '';
  const tags = optionalTextList(input.tags, 'tags') ?? [];
  const icon = optionalIcon(input.icon);

  // Slug vazio continua significando "mantém o atual", como antes de haver
  // checagem de tipo — só a troca por um slug diferente vai ao `resolveSlug`.
  const requestedSlug = optionalText(input.slug, 'slug')?.trim();
  const newSlug =
    requestedSlug && requestedSlug !== existing.slug
      ? await resolveSlug(requestedSlug, requestedSlug)
      : existing.slug;

  try {
    await db().transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE skills SET
          name = ${name ?? existing.name},
          description = ${input.description !== undefined ? description : existing.description},
          icon = ${icon === undefined ? existing.icon : icon},
          slug = ${newSlug},
          updated_at = now()
        WHERE uuid = ${existing.uuid}
      `);

      if (input.tags !== undefined) {
        await replaceTagsTx(tx, existing.uuid, tags);
      }

      await auditTx(tx, {
        skillUuid: existing.uuid,
        skillSlug: newSlug,
        filePath: null,
        action: 'update',
        source,
        actor,
        previousContent: null,
      });
    });
  } catch (err) {
    // Outra escrita concorrente pode ter levado o slug entre a checagem e o
    // UPDATE: isso é conflito (409), não falha interna.
    if (isUniqueViolation(err)) throw conflict(`Já existe uma skill com o slug "${newSlug}"`);
    throw err;
  }

  const detail = await getSkillDetail(newSlug, { visibility: 'all' });
  if (!detail) throw new Error('Skill atualizada mas não encontrada');
  return detail;
}

/**
 * Atualiza metadados **e** o SKILL.md numa transação só.
 *
 * O painel envia conteúdo e metadados numa única chamada; gravar o arquivo
 * antes (em transação própria) e depois validar o slug deixava a skill num
 * estado meio-salvo quando a validação falhava — conteúdo novo, metadados
 * antigos. Aqui é tudo ou nada.
 */
export async function updateSkillWithContent(
  slug: string,
  input: UpdateSkillInput & { skillMd?: string },
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillDetail> {
  const existing = await requireSkill(slug);

  const name = optionalText(input.name, 'name')?.trim();
  if (input.name !== undefined && !name) throw badRequest('O campo "name" não pode ficar vazio');

  const description = optionalText(input.description, 'description')?.trim() ?? '';
  const tags = optionalTextList(input.tags, 'tags') ?? [];
  const icon = optionalIcon(input.icon);

  // Slug vazio continua significando "mantém o atual", como antes de haver
  // checagem de tipo — só a troca por um slug diferente vai ao `resolveSlug`.
  const requestedSlug = optionalText(input.slug, 'slug')?.trim();
  const newSlug =
    requestedSlug && requestedSlug !== existing.slug
      ? await resolveSlug(requestedSlug, requestedSlug)
      : existing.slug;

  const previousSkillMd =
    typeof input.skillMd === 'string' ? await readTextFile(existing.uuid, SKILL_MD) : null;

  try {
    await db().transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE skills SET
          name = ${name ?? existing.name},
          description = ${input.description !== undefined ? description : existing.description},
          icon = ${icon === undefined ? existing.icon : icon},
          slug = ${newSlug},
          updated_at = now()
        WHERE uuid = ${existing.uuid}
      `);

      if (input.tags !== undefined) {
        await replaceTagsTx(tx, existing.uuid, tags);
      }

      if (typeof input.skillMd === 'string') {
        await upsertFileTx(tx, existing.uuid, SKILL_MD, Buffer.from(input.skillMd, 'utf8'));
        await auditTx(tx, {
          skillUuid: existing.uuid,
          skillSlug: newSlug,
          filePath: SKILL_MD,
          action: 'update',
          source,
          actor,
          previousContent: previousSkillMd,
        });
      }

      await auditTx(tx, {
        skillUuid: existing.uuid,
        skillSlug: newSlug,
        filePath: null,
        action: 'update',
        source,
        actor,
        previousContent: null,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`Já existe uma skill com o slug "${newSlug}"`);
    throw err;
  }

  const detail = await getSkillDetail(newSlug, { visibility: 'all' });
  if (!detail) throw new Error('Skill atualizada mas não encontrada');
  return detail;
}

// ------------------------------------------------- vínculo pelo lado da skill ---

/** Um vínculo já resolvido: o vMCP existe e as três flags são booleanas. */
type ResolvedLink = SkillLinkInput & { mcpSlug: string };

/**
 * Valida a lista de vínculos de `createSkill` antes da transação: uuid torto
 * ou desconhecido, flag ausente ou vMCP repetido são erro do cliente (400), e
 * nada é gravado.
 */
async function resolveLinks(inputs: readonly SkillLinkInput[]): Promise<ResolvedLink[]> {
  if (!Array.isArray(inputs)) throw badRequest('O campo "mcps" deve ser uma lista');
  if (inputs.length === 0) return [];

  const seen = new Set<string>();
  const wanted = inputs.map((item, index) => {
    const uuid = String(item?.virtualMcpUuid ?? '');
    if (!isUuid(uuid)) throw badRequest(`mcps[${index}]: "virtualMcpUuid" precisa ser um uuid`);
    if (seen.has(uuid)) throw badRequest(`MCP virtual repetido na lista: ${uuid}`);
    seen.add(uuid);
    return {
      virtualMcpUuid: uuid,
      asSkill: requireBoolean(item.asSkill, 'asSkill', uuid),
      asPrompt: requireBoolean(item.asPrompt, 'asPrompt', uuid),
      asResource: requireBoolean(item.asResource, 'asResource', uuid),
    };
  });

  const found = await db().execute(sql`
    SELECT uuid, slug FROM virtual_mcps
    WHERE uuid = ANY(${sql.param(wanted.map((w) => w.virtualMcpUuid))}::uuid[])
  `);
  const slugs = new Map((found.rows as Row[]).map((row) => [row.uuid as string, row.slug as string]));

  return wanted.map((link) => {
    const mcpSlug = slugs.get(link.virtualMcpUuid);
    if (!mcpSlug) throw badRequest(`MCP virtual não encontrado: ${link.virtualMcpUuid}`);
    return { ...link, mcpSlug };
  });
}

/**
 * Grava (ou reescreve) um vínculo e audita no vMCP, como `setVirtualMcpSkills`.
 *
 * A posição no canvas entra no INSERT e, num vínculo que já existe, só
 * substitui a gravada quando foi informada: reescrever as flags pelo
 * formulário da skill não pode devolver o nó ao auto-layout.
 */
async function linkTx(
  tx: Tx,
  skillUuid: string,
  link: ResolvedLink,
  source: AuditSource,
  actor: AuditActor | null | undefined,
  position: CanvasPoint | null = null,
) {
  await tx.execute(sql`
    INSERT INTO virtual_mcp_skills
      (virtual_mcp_uuid, skill_uuid, as_skill, as_prompt, as_resource, pos_x, pos_y)
    VALUES (${link.virtualMcpUuid}, ${skillUuid},
            ${link.asSkill}, ${link.asPrompt}, ${link.asResource},
            ${position?.x ?? null}, ${position?.y ?? null})
    ON CONFLICT (virtual_mcp_uuid, skill_uuid) DO UPDATE SET
      as_skill = EXCLUDED.as_skill,
      as_prompt = EXCLUDED.as_prompt,
      as_resource = EXCLUDED.as_resource,
      pos_x = COALESCE(EXCLUDED.pos_x, virtual_mcp_skills.pos_x),
      pos_y = COALESCE(EXCLUDED.pos_y, virtual_mcp_skills.pos_y)
  `);
  await tx.execute(
    sql`UPDATE virtual_mcps SET updated_at = now() WHERE uuid = ${link.virtualMcpUuid}`,
  );
  await auditTx(tx, {
    skillUuid: null,
    skillSlug: null,
    filePath: null,
    action: 'mcp.update',
    source,
    actor,
    previousContent: null,
    targetLabel: link.mcpSlug,
  });
}

export type SkillLinkFlags = Pick<SkillLinkInput, 'asSkill' | 'asPrompt' | 'asResource'>;

/**
 * Publica uma skill num vMCP a partir do lado da skill
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4.3). Cria ou reescreve o
 * vínculo — os contadores de um vínculo existente ficam, e a posição no
 * canvas também, a menos que `options.position` venha (é o que o canvas
 * manda ao soltar uma skill sobre o servidor). Audita como `mcp.update` no
 * vMCP, como `setVirtualMcpSkills`. A checagem de que o chamador administra
 * o vMCP é do app.
 */
export async function linkSkill(
  slug: string,
  virtualMcpUuid: string,
  flags: SkillLinkFlags,
  source: AuditSource,
  actor?: AuditActor | null,
  options: { position?: CanvasPoint } = {},
): Promise<SkillDetail> {
  const existing = await requireSkill(slug);
  const [link] = await resolveLinks([{ virtualMcpUuid, ...flags }]);
  const position =
    options.position === undefined ? null : requirePoint(options.position, 'position');

  await db().transaction(async (tx) => {
    await linkTx(tx, existing.uuid, link!, source, actor, position);
  });

  const detail = await getSkillDetail(existing.slug, { visibility: 'all' });
  if (!detail) throw new Error('Skill vinculada mas não encontrada');
  return detail;
}

/** Desfaz o vínculo. Vínculo inexistente é 404: nada muda e nada é auditado. */
export async function unlinkSkill(
  slug: string,
  virtualMcpUuid: string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillDetail> {
  const existing = await requireSkill(slug);
  if (!isUuid(virtualMcpUuid)) throw notFound(`MCP virtual não encontrado: ${virtualMcpUuid}`);

  await db().transaction(async (tx) => {
    const removed = await tx.execute(sql`
      DELETE FROM virtual_mcp_skills
      WHERE virtual_mcp_uuid = ${virtualMcpUuid} AND skill_uuid = ${existing.uuid}
      RETURNING virtual_mcp_uuid
    `);
    if ((removed.rows as Row[]).length === 0) {
      throw notFound(`A skill "${slug}" não está vinculada a este MCP virtual`);
    }
    const mcp = await tx.execute(sql`
      UPDATE virtual_mcps SET updated_at = now() WHERE uuid = ${virtualMcpUuid} RETURNING slug
    `);
    await auditTx(tx, {
      skillUuid: null,
      skillSlug: null,
      filePath: null,
      action: 'mcp.update',
      source,
      actor,
      previousContent: null,
      targetLabel: ((mcp.rows as Row[])[0]?.slug as string | undefined) ?? virtualMcpUuid,
    });
  });

  const detail = await getSkillDetail(existing.slug, { visibility: 'all' });
  if (!detail) throw new Error('Skill desvinculada mas não encontrada');
  return detail;
}

export async function deleteSkill(
  slug: string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<void> {
  const existing = await requireSkill(slug);

  await db().transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM skills WHERE uuid = ${existing.uuid}`);
    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: slug,
      filePath: null,
      action: 'delete',
      source,
      actor,
      previousContent: null,
    });
  });
}

export type FileInput = { relativePath: string; content: Buffer | string };

/** Cria ou sobrescreve um arquivo da skill. */
export async function setFile(
  slug: string,
  relativePath: string,
  content: Buffer | string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillFileMeta> {
  const existing = await requireSkill(slug);
  const path = normalizeRelativePath(relativePath);
  if (!path) throw badRequest(`Caminho inválido: ${relativePath}`);

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const previous = await readFile(existing.uuid, path);

  await db().transaction(async (tx) => {
    await upsertFileTx(tx, existing.uuid, path, buffer);
    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: slug,
      filePath: path,
      action: previous ? 'update' : 'create',
      source,
      actor,
      previousContent: previous?.isText ? previous.buffer.toString('utf8') : null,
    });
  });

  const mimeType = mimeTypeFor(path);
  return {
    relativePath: path,
    mimeType,
    sizeBytes: buffer.byteLength,
    isText: isTextualMime(mimeType) && !buffer.includes(0),
  };
}

export async function deleteFile(
  slug: string,
  relativePath: string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<void> {
  const existing = await requireSkill(slug);
  const path = normalizeRelativePath(relativePath);
  if (!path) throw badRequest(`Caminho inválido: ${relativePath}`);
  if (isSkillMd(path)) throw badRequest('O arquivo SKILL.md não pode ser removido');

  const previous = await readFile(existing.uuid, path);
  if (!previous) throw notFound(`Arquivo não encontrado: ${path}`);

  await db().transaction(async (tx) => {
    // Pelo caminho exato da linha lida, não por `lower(...)`: um filtro
    // insensível a caixa apagaria de uma vez todas as variantes do nome.
    await tx.execute(
      sql`DELETE FROM files WHERE skill_uuid = ${existing.uuid} AND relative_path = ${previous.relativePath}`,
    );
    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: slug,
      filePath: path,
      action: 'delete',
      source,
      actor,
      previousContent: previous.isText ? previous.buffer.toString('utf8') : null,
    });
  });
}

export type SetFilesOptions = {
  /**
   * `true` (padrão): o payload representa o estado desejado completo — caminhos
   * omitidos são removidos (exceto SKILL.md, sempre preservado).
   */
  replace?: boolean;
};

export async function setFiles(
  slug: string,
  inputs: readonly FileInput[],
  source: AuditSource,
  options: SetFilesOptions = {},
  actor?: AuditActor | null,
): Promise<SkillFileMeta[]> {
  const existing = await requireSkill(slug);
  const replace = options.replace !== false;

  const normalized = inputs.map((input) => {
    const path = normalizeRelativePath(input.relativePath);
    if (!path) throw badRequest(`Caminho inválido: ${input.relativePath}`);
    const buffer = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, 'utf8');
    return { path, buffer };
  });

  if (normalized.length === 0 && replace) {
    throw badRequest('Nenhum arquivo informado');
  }

  await db().transaction(async (tx) => {
    for (const file of normalized) {
      await upsertFileTx(tx, existing.uuid, file.path, file.buffer);
    }

    if (replace) {
      const keep = normalized.map((f) => f.path.toLowerCase());
      keep.push(SKILL_MD.toLowerCase());
      await tx.execute(sql`
        DELETE FROM files
        WHERE skill_uuid = ${existing.uuid}
          AND lower(relative_path) <> ALL(${sql.param(keep)}::text[])
      `);
    }

    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: slug,
      filePath: null,
      action: 'update',
      source,
      actor,
      previousContent: null,
    });
  });

  return listFiles(existing.uuid);
}

// ----------------------------------------------------------------- contas ---

/**
 * Conta com os campos que nunca saem do servidor.
 *
 * `UserSummary` é o que a API devolve ao navegador; `UserRecord` acrescenta o
 * hash da senha, a versão do token, o contador de falhas e o subject OIDC —
 * material de autenticação, que fica entre o banco e o middleware.
 */
export type UserRecord = UserSummary & {
  passwordHash: string | null;
  tokenVersion: number;
  failedAttempts: number;
  oidcSubject: string | null;
};

const USER_COLUMNS = sql`
  uuid, email, name, password_hash, role, is_active, token_version,
  must_change_password, oidc_issuer, oidc_subject, locked_until, failed_attempts,
  last_login_at, created_at, updated_at
`;

function toUserRecord(row: Row): UserRecord {
  return {
    uuid: row.uuid,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    isActive: Boolean(row.is_active),
    hasPassword: row.password_hash !== null && row.password_hash !== undefined,
    mustChangePassword: Boolean(row.must_change_password),
    oidcIssuer: row.oidc_issuer ?? null,
    lockedUntil: iso(row.locked_until),
    lastLoginAt: iso(row.last_login_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    passwordHash: row.password_hash ?? null,
    tokenVersion: Number(row.token_version ?? 0),
    failedAttempts: Number(row.failed_attempts ?? 0),
    oidcSubject: row.oidc_subject ?? null,
  };
}

// Derivado do record por remoção: acrescentar um campo sensível a `UserRecord`
// não o faz vazar para a listagem por esquecimento.
function toUserSummary(row: Row): UserSummary {
  const {
    passwordHash: _passwordHash,
    tokenVersion: _tokenVersion,
    failedAttempts: _failedAttempts,
    oidcSubject: _oidcSubject,
    ...summary
  } = toUserRecord(row);
  return summary;
}

/** Zero libera a rota `/setup` do painel (`docs/05-accounts-and-roles.md` §2.3). */
export async function countUsers(): Promise<number> {
  const result = await db().execute(sql`SELECT count(*)::int AS total FROM users`);
  return Number((result.rows as Row[])[0]?.total ?? 0);
}

export async function listUsers(): Promise<UserSummary[]> {
  const result = await db().execute(sql`
    SELECT ${USER_COLUMNS} FROM users ORDER BY created_at
  `);
  return (result.rows as Row[]).map(toUserSummary);
}

/** UUID malformado devolve `null` — é "não existe", não erro de servidor. */
export async function getUserByUuid(uuid: string): Promise<UserRecord | null> {
  if (!isUuid(uuid)) return null;

  const result = await db().execute(sql`
    SELECT ${USER_COLUMNS} FROM users WHERE uuid = ${uuid} LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? toUserRecord(row) : null;
}

/** Busca por `lower(email)`, que é como a unicidade é garantida no banco. */
export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const wanted = (email ?? '').trim();
  if (!wanted) return null;

  const result = await db().execute(sql`
    SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower(${wanted}) LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? toUserRecord(row) : null;
}

export async function getUserByOidc(issuer: string, subject: string): Promise<UserRecord | null> {
  if (!issuer?.trim() || !subject?.trim()) return null;

  const result = await db().execute(sql`
    SELECT ${USER_COLUMNS} FROM users
    WHERE oidc_issuer = ${issuer.trim()} AND oidc_subject = ${subject.trim()}
    LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? toUserRecord(row) : null;
}

export type CreateUserInput = {
  email: string;
  name: string;
  role: Role;
  /** Ausente ou `null` cria conta sem senha local — só entra por OIDC. */
  passwordHash?: string | null;
  mustChangePassword?: boolean;
  oidcIssuer?: string | null;
  oidcSubject?: string | null;
  isActive?: boolean;
};

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  // O e-mail é gravado como veio (apenas aparado): a unicidade é por
  // `lower(email)` no índice, então preservar a caixa não duplica ninguém e
  // mantém a grafia que a pessoa usa.
  const email = (input.email ?? '').trim();
  if (!email) throw badRequest('O campo "email" é obrigatório');

  const name = (input.name ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');

  if (!isRole(input.role)) throw badRequest(`Papel inválido: ${String(input.role)}`);

  try {
    const result = await db().execute(sql`
      INSERT INTO users (
        email, name, password_hash, role, is_active, must_change_password,
        oidc_issuer, oidc_subject
      )
      VALUES (
        ${email}, ${name}, ${input.passwordHash ?? null}, ${input.role},
        ${input.isActive !== false}, ${input.mustChangePassword === true},
        ${input.oidcIssuer ?? null}, ${input.oidcSubject ?? null}
      )
      RETURNING ${USER_COLUMNS}
    `);
    return toUserRecord((result.rows as Row[])[0]);
  } catch (err) {
    if (isUniqueViolation(err, 'users_oidc_uniq')) {
      throw conflict('Já existe uma conta vinculada a essa identidade OIDC');
    }
    if (isUniqueViolation(err)) {
      throw conflict(`Já existe uma conta com o e-mail "${email}"`);
    }
    throw err;
  }
}

export type UpdateUserInput = {
  name?: string;
  role?: Role;
  isActive?: boolean;
  passwordHash?: string | null;
  mustChangePassword?: boolean;
  oidcIssuer?: string | null;
  oidcSubject?: string | null;
  /** true incrementa token_version — derruba todo cookie já emitido. */
  bumpTokenVersion?: boolean;
};

/**
 * Atualização parcial: campo ausente fica como está.
 *
 * `undefined` significa "não mexe" e `null` significa "apaga" — é o que separa
 * "não estou trocando a senha" de "esta conta passa a ser só-OIDC".
 */
export async function updateUser(uuid: string, input: UpdateUserInput): Promise<UserRecord> {
  if (!isUuid(uuid)) throw notFound(`Conta não encontrada: ${uuid}`);

  const sets: SQL[] = [];

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw badRequest('O campo "name" não pode ficar vazio');
    sets.push(sql`name = ${name}`);
  }
  if (input.role !== undefined) {
    if (!isRole(input.role)) throw badRequest(`Papel inválido: ${String(input.role)}`);
    sets.push(sql`role = ${input.role}`);
  }
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
  if (input.passwordHash !== undefined) sets.push(sql`password_hash = ${input.passwordHash}`);
  if (input.mustChangePassword !== undefined) {
    sets.push(sql`must_change_password = ${input.mustChangePassword}`);
  }
  if (input.oidcIssuer !== undefined) sets.push(sql`oidc_issuer = ${input.oidcIssuer}`);
  if (input.oidcSubject !== undefined) sets.push(sql`oidc_subject = ${input.oidcSubject}`);
  // Incremento no próprio UPDATE: ler-e-somar no app perderia uma revogação
  // concorrente, que é justamente o que não pode falhar aqui.
  if (input.bumpTokenVersion === true) sets.push(sql`token_version = token_version + 1`);

  sets.push(sql`updated_at = now()`);

  try {
    const result = await db().execute(sql`
      UPDATE users SET ${sql.join(sets, sql`, `)}
      WHERE uuid = ${uuid}
      RETURNING ${USER_COLUMNS}
    `);
    const row = (result.rows as Row[])[0];
    if (!row) throw notFound(`Conta não encontrada: ${uuid}`);
    return toUserRecord(row);
  } catch (err) {
    if (isUniqueViolation(err, 'users_oidc_uniq')) {
      throw conflict('Já existe uma conta vinculada a essa identidade OIDC');
    }
    throw err;
  }
}

/**
 * Contabiliza uma tentativa de login falha (§2.7).
 *
 * Tudo num UPDATE só: duas tentativas simultâneas não podem ler o mesmo
 * contador e gravar o mesmo valor. Ao atingir o teto, o contador **volta a
 * zero** e o bloqueio passa a ser `locked_until` — quem errar de novo depois
 * que o bloqueio vencer recomeça a contagem em vez de ser travado de imediato.
 *
 * `updated_at` não é tocado de propósito: ele descreve alteração
 * administrativa da conta, não movimento de login.
 */
export async function registerFailedLogin(
  uuid: string,
  options: { maxAttempts: number; lockSeconds: number },
): Promise<{ failedAttempts: number; lockedUntil: string | null }> {
  if (!isUuid(uuid)) throw notFound(`Conta não encontrada: ${uuid}`);

  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
  const lockSeconds = Math.max(1, Math.trunc(options.lockSeconds));

  const result = await db().execute(sql`
    UPDATE users SET
      failed_attempts = CASE
        WHEN failed_attempts + 1 >= ${maxAttempts} THEN 0
        ELSE failed_attempts + 1
      END,
      locked_until = CASE
        WHEN failed_attempts + 1 >= ${maxAttempts}
          THEN now() + make_interval(secs => ${lockSeconds})
        ELSE locked_until
      END
    WHERE uuid = ${uuid}
    RETURNING failed_attempts, locked_until
  `);

  const row = (result.rows as Row[])[0];
  if (!row) throw notFound(`Conta não encontrada: ${uuid}`);

  return {
    failedAttempts: Number(row.failed_attempts ?? 0),
    lockedUntil: iso(row.locked_until),
  };
}

/** Login aceito: zera o contador, libera o bloqueio e marca o acesso. */
export async function registerSuccessfulLogin(uuid: string): Promise<void> {
  if (!isUuid(uuid)) return;

  await db().execute(sql`
    UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
    WHERE uuid = ${uuid}
  `);
}

// ------------------------------------------------------------ chaves de API --

function toApiKeySummary(row: Row): ApiKeySummary {
  return {
    id: row.id,
    userUuid: row.user_uuid,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Inclui as revogadas: elas explicam as linhas de auditoria que produziram. */
export async function listApiKeys(userUuid: string): Promise<ApiKeySummary[]> {
  if (!isUuid(userUuid)) return [];

  const result = await db().execute(sql`
    SELECT id, user_uuid, name, prefix, last_used_at, revoked_at, created_at
    FROM api_keys WHERE user_uuid = ${userUuid}
    ORDER BY created_at DESC
  `);
  return (result.rows as Row[]).map(toApiKeySummary);
}

/**
 * Grava a chave emitida. O segredo em texto **não** passa por aqui: quem o
 * gera e o mostra uma única vez é o app, com `generateApiKey()` de shared.
 */
export async function createApiKey(input: {
  userUuid: string;
  name: string;
  prefix: string;
  keyHash: string;
}): Promise<ApiKeySummary> {
  if (!isUuid(input.userUuid)) throw notFound(`Conta não encontrada: ${input.userUuid}`);

  const name = (input.name ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');
  if (!input.prefix?.trim() || !input.keyHash?.trim()) {
    throw badRequest('Prefixo e hash da chave são obrigatórios');
  }

  try {
    const result = await db().execute(sql`
      INSERT INTO api_keys (user_uuid, name, prefix, key_hash)
      VALUES (${input.userUuid}, ${name}, ${input.prefix.trim()}, ${input.keyHash})
      RETURNING id, user_uuid, name, prefix, last_used_at, revoked_at, created_at
    `);
    return toApiKeySummary((result.rows as Row[])[0]);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Prefixo de chave já em uso; tente novamente');
    // A conta sumiu entre a sessão e a emissão.
    if (isForeignKeyViolation(err)) throw notFound(`Conta não encontrada: ${input.userUuid}`);
    throw err;
  }
}

/**
 * Revoga. `userUuid` presente restringe ao dono (usuário revogando a própria
 * chave); ausente é o admin revogando qualquer uma.
 *
 * `false` quando não achou **ou** já estava revogada — a operação é
 * idempotente e nunca reescreve o `revoked_at` original, que é o que datou a
 * revogação na auditoria.
 */
export async function revokeApiKey(id: string, userUuid?: string | null): Promise<boolean> {
  if (!isUuid(id)) return false;

  const owner = userUuid ?? null;
  if (owner !== null && !isUuid(owner)) return false;

  const result = await db().execute(sql`
    UPDATE api_keys SET revoked_at = now()
    WHERE id = ${id}
      AND revoked_at IS NULL
      AND (${owner}::uuid IS NULL OR user_uuid = ${owner}::uuid)
    RETURNING id
  `);
  return (result.rows as Row[]).length > 0;
}

export type ApiKeyRecord = {
  id: string;
  userUuid: string;
  name: string;
  prefix: string;
  keyHash: string;
  revokedAt: string | null;
};

/**
 * Primeiro passo da autenticação por chave: acha a linha pelo prefixo público.
 * A conferência do segredo contra `keyHash` é do app — comparação de hash não
 * é trabalho do banco.
 */
export async function getApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
  const wanted = (prefix ?? '').trim();
  if (!wanted) return null;

  const result = await db().execute(sql`
    SELECT id, user_uuid, name, prefix, key_hash, revoked_at
    FROM api_keys WHERE prefix = ${wanted} LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  return {
    id: row.id,
    userUuid: row.user_uuid,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.key_hash,
    revokedAt: iso(row.revoked_at),
  };
}

/** Marca o uso. Falha silenciosa de propósito: não é para derrubar a chamada. */
export async function touchApiKey(id: string): Promise<void> {
  if (!isUuid(id)) return;
  await db().execute(sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`);
}

// ------------------------------------------------------ tokens de reset -----

export async function createResetToken(input: {
  userUuid: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  if (!isUuid(input.userUuid)) throw notFound(`Conta não encontrada: ${input.userUuid}`);
  if (!input.tokenHash?.trim()) throw badRequest('O hash do token é obrigatório');

  await db().execute(sql`
    INSERT INTO reset_tokens (user_uuid, token_hash, expires_at)
    VALUES (${input.userUuid}, ${input.tokenHash}, ${input.expiresAt})
  `);
}

/**
 * Queima o token e devolve o dono, ou `null` se não existe, já foi usado ou
 * expirou.
 *
 * Um único UPDATE condicional: é ele que garante que dois cliques no mesmo
 * link não redefinam a senha duas vezes. Ler e depois marcar abriria a janela
 * entre as duas consultas.
 */
export async function consumeResetToken(tokenHash: string): Promise<{ userUuid: string } | null> {
  const wanted = (tokenHash ?? '').trim();
  if (!wanted) return null;

  const result = await db().execute(sql`
    UPDATE reset_tokens SET used_at = now()
    WHERE token_hash = ${wanted} AND used_at IS NULL AND expires_at > now()
    RETURNING user_uuid
  `);
  const row = (result.rows as Row[])[0];
  return row ? { userUuid: row.user_uuid } : null;
}

// -------------------------------------------------------------- auditoria ---

/**
 * Auditoria de eventos de conta — linhas sem skill.
 *
 * `targetLabel` é quem sofreu a ação (e-mail da conta, nome da chave),
 * congelado no momento do evento: sem ele a linha não diz sobre quem foi, já
 * que `skill_slug`/`file_path` são nulos e a conta pode nem existir mais.
 *
 * As chaves de MCP virtual (`mcp.key.*`) entram aqui pelo mesmo motivo: a
 * emissão e a revogação são do app, e o alvo é o nome da chave.
 */
export async function recordAccountAudit(entry: {
  action:
    | 'user.create'
    | 'user.role'
    | 'user.deactivate'
    | 'key.create'
    | 'key.revoke'
    | 'mcp.key.create'
    | 'mcp.key.revoke';
  source: AuditSource;
  actor: AuditActor;
  targetLabel: string | null;
}): Promise<void> {
  await db().execute(
    auditInsert({
      skillUuid: null,
      skillSlug: null,
      filePath: null,
      action: entry.action,
      source: entry.source,
      previousContent: null,
      actor: entry.actor,
      targetLabel: entry.targetLabel,
    }),
  );
}

const AUDIT_COLUMNS = sql`
  id, skill_uuid, skill_slug, file_path, action, source,
  actor_user_uuid, actor_label, target_label, created_at
`;

function toAuditEntry(row: Row): AuditEntry {
  return {
    id: row.id,
    skillUuid: row.skill_uuid,
    skillSlug: row.skill_slug,
    filePath: row.file_path,
    action: row.action,
    source: row.source,
    actorUserUuid: row.actor_user_uuid ?? null,
    actorLabel: row.actor_label ?? null,
    targetLabel: row.target_label ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** As últimas linhas, sem filtro — o widget do dashboard. Ver `listAuditPage` para a tela. */
export async function listAudit(limit = 100): Promise<AuditEntry[]> {
  const result = await db().execute(sql`
    SELECT ${AUDIT_COLUMNS}
    FROM audit_log ORDER BY created_at DESC LIMIT ${clamp(limit, 1, 500)}
  `);
  return (result.rows as Row[]).map(toAuditEntry);
}

/**
 * Espelho do `CHECK` de `audit_log.action` (`schema/011-mcp-padrao.sql`), para
 * recusar um filtro inválido com 400 em vez de devolver uma página vazia.
 */
const AUDIT_ACTIONS: readonly AuditAction[] = [
  'create',
  'update',
  'delete',
  'user.create',
  'user.role',
  'user.deactivate',
  'key.create',
  'key.revoke',
  'mcp.create',
  'mcp.update',
  'mcp.delete',
  'mcp.default',
  'mcp.key.create',
  'mcp.key.revoke',
  'public.key.create',
  'public.key.revoke',
];

export type ListAuditOptions = {
  /** Clamp 1..200; padrão 50. */
  limit?: number;
  offset?: number;
  /** Uma ação exata; fora da lista é 400. */
  action?: AuditAction;
  /** Igualdade com `actor_label` (o e-mail, `token-global`, `bootstrap`, `seed`). */
  actor?: string;
  /** `ILIKE %q%` em `skill_slug`, `target_label`, `file_path` e `actor_label`. */
  q?: string;
  since?: Date;
  until?: Date;
};

/**
 * A trilha de auditoria paginada e filtrável, para a tela do painel. `total`
 * respeita os mesmos filtros da página — é o que permite paginar. A ordem é
 * a de `listAudit`: mais recente primeiro.
 */
export async function listAuditPage(options: ListAuditOptions = {}): Promise<AuditPage> {
  const limit = clamp(options.limit ?? 50, 1, 200);
  const offset = pageOffset(options.offset);
  const conditions: SQL[] = [];

  if (options.action !== undefined) {
    if (!AUDIT_ACTIONS.includes(options.action)) {
      throw badRequest(`Ação de auditoria inválida: ${String(options.action)}`);
    }
    conditions.push(sql`action = ${options.action}`);
  }
  const actor = optionalText(options.actor, 'actor')?.trim();
  if (actor) conditions.push(sql`actor_label = ${actor}`);

  const q = normalizeQuery(optionalText(options.q, 'q'));
  if (q) {
    const pattern = '%' + q + '%';
    conditions.push(sql`(
      skill_slug ILIKE ${pattern}
      OR target_label ILIKE ${pattern}
      OR file_path ILIKE ${pattern}
      OR actor_label ILIKE ${pattern}
    )`);
  }
  const since = optionalDate(options.since, 'since');
  if (since) conditions.push(sql`created_at >= ${since}`);
  const until = optionalDate(options.until, 'until');
  if (until) conditions.push(sql`created_at <= ${until}`);

  const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const counted = await db().execute(sql`SELECT count(*)::int AS total FROM audit_log ${where}`);
  const total = Number((counted.rows as Row[])[0]?.total ?? 0);

  const result = await db().execute(sql`
    SELECT ${AUDIT_COLUMNS}
    FROM audit_log ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return { items: (result.rows as Row[]).map(toAuditEntry), total, limit, offset };
}

export type Stats = {
  totalSkills: number;
  /** Em ao menos um vMCP aberto e ligado — o que o site mostra. */
  openSkills: number;
  /** Flutuantes: sem vínculo com servidor nenhum. */
  unlinkedSkills: number;
  totalFiles: number;
  totalViews: number;
  totalDownloads: number;
  totalTags: number;
  totalUsers: number;
  activeUsers: number;
};

export async function stats(): Promise<Stats> {
  const result = await db().execute(sql`
    SELECT
      (SELECT count(*) FROM skills)::int AS total_skills,
      (SELECT count(DISTINCT v.skill_uuid) FROM virtual_mcp_skills v
        JOIN virtual_mcps m ON m.uuid = v.virtual_mcp_uuid
        WHERE m.is_open AND m.is_active)::int AS open_skills,
      (SELECT count(*) FROM skills s
        WHERE NOT EXISTS (SELECT 1 FROM virtual_mcp_skills v WHERE v.skill_uuid = s.uuid))::int
        AS unlinked_skills,
      (SELECT count(*) FROM files)::int AS total_files,
      (SELECT COALESCE(sum(view_count), 0) FROM skills)::bigint AS total_views,
      (SELECT COALESCE(sum(download_count), 0) FROM skills)::bigint AS total_downloads,
      (SELECT count(*) FROM tags)::int AS total_tags,
      (SELECT count(*) FROM users)::int AS total_users,
      (SELECT count(*) FROM users WHERE is_active)::int AS active_users
  `);

  const row = (result.rows as Row[])[0];

  return {
    totalSkills: Number(row.total_skills),
    openSkills: Number(row.open_skills),
    unlinkedSkills: Number(row.unlinked_skills),
    totalFiles: Number(row.total_files),
    totalViews: Number(row.total_views),
    totalDownloads: Number(row.total_downloads),
    totalTags: Number(row.total_tags),
    totalUsers: Number(row.total_users),
    activeUsers: Number(row.active_users),
  };
}

export async function healthCheck(): Promise<boolean> {
  try {
    await db().execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- settings ---

/**
 * Chave de `settings` que guarda o uuid do vMCP padrão — o que responde em
 * `/mcp` (`docs/09-mcp-padrao-e-skills-flutuantes.md`). Só o admin a altera.
 */
export const DEFAULT_MCP_SETTING = 'default_virtual_mcp';

/**
 * O que o mcp-public precisa saber para responder na raiz.
 *
 * As três recusas são distintas de propósito: quem configura um cliente
 * precisa saber se falta escolher o padrão (`none`), se o vMCP escolhido foi
 * apagado (`deleted`) ou se está desligado (`inactive`). `slug` acompanha só
 * quando a linha ainda existe.
 */
export type DefaultMcpResolution =
  | { status: 'ok'; mcp: VirtualMcpRuntime }
  | { status: 'none' | 'deleted'; mcp: null; uuid: null; slug: null }
  | { status: 'inactive'; mcp: null; uuid: string; slug: string };

/**
 * Resolve o vMCP padrão a cada requisição, sem cache, como `resolveVirtualMcp`:
 * trocar o padrão, desligá-lo ou apagá-lo vale na chamada seguinte.
 *
 * O JOIN é por `uuid::text` porque o valor é texto sem FK: um valor torto ou
 * pendurado é "removido", não erro do driver.
 */
export async function resolveDefaultVirtualMcp(): Promise<DefaultMcpResolution> {
  const result = await db().execute(sql`
    SELECT st.value, m.uuid, m.slug, m.name, m.description, m.is_open, m.is_active
    FROM settings st
    LEFT JOIN virtual_mcps m ON m.uuid::text = st.value
    WHERE st.key = ${DEFAULT_MCP_SETTING}
    LIMIT 1
  `);
  const row = (result.rows as Row[])[0];

  if (!row || row.value === null || row.value === undefined) {
    return { status: 'none', mcp: null, uuid: null, slug: null };
  }
  if (!row.uuid) return { status: 'deleted', mcp: null, uuid: null, slug: null };
  if (!row.is_active) {
    return { status: 'inactive', mcp: null, uuid: row.uuid as string, slug: row.slug as string };
  }

  return {
    status: 'ok',
    mcp: {
      uuid: row.uuid,
      slug: row.slug,
      name: row.name,
      description: row.description ?? '',
      isOpen: Boolean(row.is_open),
    },
  };
}

/**
 * Escolhe (ou limpa, com `null`) o vMCP padrão. Audita como `mcp.default`,
 * com o slug novo — ou "nenhum" — em `target_label`. A checagem de papel é do
 * app: só admin chega aqui.
 *
 * Aceita um vMCP desligado de propósito: o padrão não tem tratamento
 * especial, e escolher um desligado só faz a raiz responder 404 até religar.
 */
export async function setDefaultVirtualMcp(
  uuid: string | null,
  source: AuditSource,
  actor: AuditActor,
): Promise<DefaultMcpResolution> {
  let slug: string | null = null;
  if (uuid !== null) {
    const mcp = await getVirtualMcpByUuid(uuid);
    if (!mcp) throw notFound(`MCP virtual não encontrado: ${uuid}`);
    slug = mcp.slug;
  }

  await db().transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO settings (key, value) VALUES (${DEFAULT_MCP_SETTING}, ${uuid})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
    await auditTx(tx, {
      skillUuid: null,
      skillSlug: null,
      filePath: null,
      action: 'mcp.default',
      source,
      previousContent: null,
      actor,
      targetLabel: slug ?? 'nenhum',
    });
  });

  return resolveDefaultVirtualMcp();
}

// ------------------------------------------------------------ MCP virtual ---

/**
 * Janela de "online" das leituras de vMCP (`docs/10-admin-canvas-e-sessoes.md`).
 *
 * `onlineSessions` conta as linhas de `mcp_sessions` sem fim e com atividade
 * dentro de `onlineWindowMs`. A janela é do app (`MCP_SESSION_ONLINE_WINDOW_MS`)
 * e vem por chamada; sem ela o contador é 0 **sem consultar** `mcp_sessions`
 * — o mcp-admin e o seed não pagam por um número que não mostram.
 */
export type VirtualMcpReadOptions = { onlineWindowMs?: number };

/** Quantas skills a miniatura do card mostra. */
const VIRTUAL_MCP_PREVIEW_SIZE = 8;

// `m` é o servidor, `u` o dono e `c` os contadores do vínculo, numa única
// passada por `virtual_mcp_skills` (LATERAL) em vez de quatro subconsultas.
// As chaves vivas e o preview continuam subconsultas: a listagem é de painel
// (poucas linhas) e cada uma responde a uma pergunta distinta.
function virtualMcpColumns({ onlineWindowMs }: VirtualMcpReadOptions): SQL {
  const online =
    onlineWindowMs === undefined
      ? sql`0::int`
      : sql`(SELECT count(*) FROM mcp_sessions ms
          WHERE ms.virtual_mcp_uuid = m.uuid
            AND ms.ended_at IS NULL
            AND ms.last_seen_at >= now() - ${windowInterval(onlineWindowMs, 'onlineWindowMs')})::int`;

  return sql`
  m.uuid, m.slug, m.name, m.description, m.is_active, m.is_open,
  m.owner_user_uuid, u.email AS owner_email, m.layout,
  c.skill_count, c.tool_count, c.prompt_count, c.resource_count,
  (SELECT count(*) FROM virtual_mcp_keys k
    WHERE k.virtual_mcp_uuid = m.uuid AND k.revoked_at IS NULL)::int AS active_key_count,
  (m.uuid::text = (SELECT st.value FROM settings st WHERE st.key = ${DEFAULT_MCP_SETTING}))
    AS is_default,
  ${online} AS online_sessions,
  COALESCE((
    SELECT json_agg(json_build_object('slug', p.slug, 'name', p.name, 'icon', p.icon)
                    ORDER BY p.name, p.slug)
    FROM (
      SELECT s.slug, s.name, s.icon
      FROM virtual_mcp_skills v JOIN skills s ON s.uuid = v.skill_uuid
      WHERE v.virtual_mcp_uuid = m.uuid
      ORDER BY s.name ASC, s.slug ASC
      LIMIT ${VIRTUAL_MCP_PREVIEW_SIZE}
    ) p
  ), '[]'::json) AS preview,
  m.created_at, m.updated_at
`;
}

const VIRTUAL_MCP_FROM = sql`
  FROM virtual_mcps m
  LEFT JOIN users u ON u.uuid = m.owner_user_uuid
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS skill_count,
           (count(*) FILTER (WHERE v.as_skill))::int AS tool_count,
           (count(*) FILTER (WHERE v.as_prompt))::int AS prompt_count,
           (count(*) FILTER (WHERE v.as_resource))::int AS resource_count
    FROM virtual_mcp_skills v
    WHERE v.virtual_mcp_uuid = m.uuid
  ) c ON true
`;

function toVirtualMcpSummary(row: Row): VirtualMcpSummary {
  return {
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    isActive: Boolean(row.is_active),
    isOpen: Boolean(row.is_open),
    ownerUserUuid: row.owner_user_uuid ?? null,
    ownerEmail: row.owner_email ?? null,
    skillCount: Number(row.skill_count ?? 0),
    toolCount: Number(row.tool_count ?? 0),
    promptCount: Number(row.prompt_count ?? 0),
    resourceCount: Number(row.resource_count ?? 0),
    activeKeyCount: Number(row.active_key_count ?? 0),
    // NULL quando não há padrão configurado: `Boolean(null)` é `false`.
    isDefault: Boolean(row.is_default),
    onlineSessions: Number(row.online_sessions ?? 0),
    preview: toVirtualMcpPreview(row.preview),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toVirtualMcpPreview(value: unknown): VirtualMcpPreviewSkill[] {
  const rows = (typeof value === 'string' ? JSON.parse(value) : value) as Row[] | null;
  return (rows ?? []).map((p) => ({ slug: p.slug, name: p.name, icon: p.icon ?? null }));
}

/** As chaves de `virtual_mcps.layout` que o canvas conhece. */
const LAYOUT_KEYS = ['server', 'internet'] as const;

/**
 * O JSON de `virtual_mcps.layout`, só com o que o canvas conhece: `server` e
 * `internet`, cada um com `x` e `y` numéricos. O CHECK do banco garante um
 * objeto e nada mais; chave estranha ou ponto torto é ignorado aqui, para o
 * painel nunca receber um layout que não sabe desenhar.
 */
function toVirtualMcpLayout(value: unknown): VirtualMcpLayout {
  const raw = (typeof value === 'string' ? JSON.parse(value) : value) as Row | null;
  const layout: VirtualMcpLayout = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return layout;
  for (const key of LAYOUT_KEYS) {
    const point = readPoint(raw[key]);
    if (point) layout[key] = point;
  }
  return layout;
}

/** Um `{x, y}` com os dois finitos, ou nada. */
function readPoint(value: unknown): CanvasPoint | null {
  if (!value || typeof value !== 'object') return null;
  const { x, y } = value as Row;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/**
 * As flags, os contadores e a posição vêm do vínculo (`v`), não da skill.
 * `position` é nula até alguém arrastar o nó (as duas colunas andam juntas,
 * por CHECK).
 */
function toVirtualMcpSkill(row: Row): VirtualMcpSkill {
  return {
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    icon: row.icon ?? null,
    asSkill: Boolean(row.as_skill),
    asPrompt: Boolean(row.as_prompt),
    asResource: Boolean(row.as_resource),
    viewCount: Number(row.view_count ?? 0),
    downloadCount: Number(row.download_count ?? 0),
    position:
      row.pos_x === null || row.pos_x === undefined || row.pos_y === null || row.pos_y === undefined
        ? null
        : { x: Number(row.pos_x), y: Number(row.pos_y) },
  };
}

/**
 * Listagem do painel. Sem `ownerUserUuid` (ou `undefined`) é a visão do
 * admin: todos, inclusive inativos e órfãos. Com um UUID, só os daquele dono.
 * `null` é "nenhum dono possível" — a sessão de bootstrap, que não é conta —
 * e devolve lista vazia em vez de vazar os órfãos, que são só do admin.
 * `onlineWindowMs` liga o contador de clientes online (ver
 * `VirtualMcpReadOptions`).
 */
export async function listVirtualMcps(
  options: { ownerUserUuid?: string | null } & VirtualMcpReadOptions = {},
): Promise<VirtualMcpSummary[]> {
  const owner = options.ownerUserUuid;
  if (owner === null) return [];
  if (owner !== undefined && !isUuid(owner)) return [];

  const result = await db().execute(sql`
    SELECT ${virtualMcpColumns(options)} ${VIRTUAL_MCP_FROM}
    ${owner !== undefined ? sql`WHERE m.owner_user_uuid = ${owner}` : sql``}
    ORDER BY m.name ASC, m.slug ASC
  `);
  return (result.rows as Row[]).map(toVirtualMcpSummary);
}

async function loadVirtualMcpSkills(virtualMcpUuid: string): Promise<VirtualMcpSkill[]> {
  const result = await db().execute(sql`
    SELECT s.uuid, s.slug, s.name, s.description, s.icon,
           v.as_skill, v.as_prompt, v.as_resource, v.view_count, v.download_count,
           v.pos_x, v.pos_y
    FROM virtual_mcp_skills v
    JOIN skills s ON s.uuid = v.skill_uuid
    WHERE v.virtual_mcp_uuid = ${virtualMcpUuid}
    ORDER BY s.name ASC, s.slug ASC
  `);
  return (result.rows as Row[]).map(toVirtualMcpSkill);
}

/** Detalhe = resumo + skills vinculadas + layout do canvas. Inclui inativos: é o painel que lê. */
async function loadVirtualMcpDetail(
  where: SQL,
  options: VirtualMcpReadOptions,
): Promise<VirtualMcpDetail | null> {
  const result = await db().execute(sql`
    SELECT ${virtualMcpColumns(options)} ${VIRTUAL_MCP_FROM} WHERE ${where} LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  const summary = toVirtualMcpSummary(row);
  return {
    ...summary,
    skills: await loadVirtualMcpSkills(summary.uuid),
    layout: toVirtualMcpLayout(row.layout),
  };
}

export async function getVirtualMcp(
  slug: string,
  options: VirtualMcpReadOptions = {},
): Promise<VirtualMcpDetail | null> {
  const wanted = (slug ?? '').trim();
  if (!wanted) return null;
  return loadVirtualMcpDetail(sql`m.slug = ${wanted}`, options);
}

/** UUID malformado devolve `null` — é "não existe", não erro de servidor. */
export async function getVirtualMcpByUuid(
  uuid: string,
  options: VirtualMcpReadOptions = {},
): Promise<VirtualMcpDetail | null> {
  if (!isUuid(uuid)) return null;
  return loadVirtualMcpDetail(sql`m.uuid = ${uuid}`, options);
}

/** O que o servidor precisa por requisição, e nada mais. */
export type VirtualMcpRuntime = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  isOpen: boolean;
};

/**
 * Resolve o servidor pelo slug da URL, **só se ativo**. É a consulta de toda
 * requisição a `/virtual/<slug>/mcp`: uma linha pela chave única, sem
 * agregação. Inativo e inexistente são a mesma resposta (404) de propósito —
 * a URL não deve confirmar que um servidor desligado existe.
 */
export async function resolveVirtualMcp(slug: string): Promise<VirtualMcpRuntime | null> {
  const wanted = (slug ?? '').trim();
  if (!wanted) return null;

  const result = await db().execute(sql`
    SELECT uuid, slug, name, description, is_open
    FROM virtual_mcps WHERE slug = ${wanted} AND is_active
    LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  return {
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    isOpen: Boolean(row.is_open),
  };
}

export type CreateVirtualMcpInput = {
  /** Omitido: gerado a partir de `name`. Informado: precisa passar em `isValidSlug`. */
  slug?: string;
  name: string;
  description?: string;
  isOpen?: boolean;
  /** `null` = sem dono (sessão de bootstrap); só o admin gerencia depois. */
  ownerUserUuid: string | null;
};

export async function createVirtualMcp(
  input: CreateVirtualMcpInput,
  source: AuditSource,
  actor: AuditActor,
): Promise<VirtualMcpDetail> {
  const name = (optionalText(input.name, 'name') ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');

  const description = optionalText(input.description, 'description')?.trim() ?? '';
  const isOpen = optionalBoolean(input.isOpen, 'isOpen') ?? false;
  const owner = ownerOrNull(input.ownerUserUuid);

  // Slug vazio é "gera para mim", como em `createSkill`.
  const requestedSlug = optionalText(input.slug, 'slug')?.trim() || undefined;
  if (requestedSlug !== undefined) assertVirtualMcpSlug(requestedSlug);

  // Mesma corrida de `createSkill`: o slug gerado é escolhido antes do INSERT
  // e outra criação pode levá-lo no meio. Gerado, vale tentar de novo;
  // pedido, o conflito é a resposta.
  let slug = '';
  for (let attempt = 1; ; attempt += 1) {
    slug = requestedSlug ?? (await freeVirtualMcpSlug(name));

    try {
      const uuid = await db().transaction(async (tx) => {
        const inserted = await tx.execute(sql`
          INSERT INTO virtual_mcps (slug, name, description, is_open, owner_user_uuid)
          VALUES (${slug}, ${name}, ${description}, ${isOpen}, ${owner})
          RETURNING uuid
        `);
        const created = (inserted.rows as Row[])[0].uuid as string;
        await auditTx(tx, virtualMcpAudit('mcp.create', slug, source, actor));
        return created;
      });

      const detail = await getVirtualMcpByUuid(uuid);
      if (!detail) throw new Error('MCP virtual criado mas não encontrado');
      return detail;
    } catch (err) {
      // O dono sumiu entre a sessão e a criação.
      if (isForeignKeyViolation(err)) throw notFound(`Conta não encontrada: ${owner}`);
      if (!isUniqueViolation(err)) throw err;
      if (requestedSlug !== undefined || attempt >= SLUG_ATTEMPTS) {
        throw conflict(`Já existe um MCP virtual com o slug "${slug}"`);
      }
    }
  }
}

export type UpdateVirtualMcpInput = {
  slug?: string;
  name?: string;
  description?: string;
  isOpen?: boolean;
  isActive?: boolean;
  /** `undefined` não mexe; `null` apaga o dono. */
  ownerUserUuid?: string | null;
};

/** Parcial, no padrão de `updateUser`: campo ausente fica como está. */
export async function updateVirtualMcp(
  uuid: string,
  input: UpdateVirtualMcpInput,
  source: AuditSource,
  actor: AuditActor,
): Promise<VirtualMcpDetail> {
  if (!isUuid(uuid)) throw notFound(`MCP virtual não encontrado: ${uuid}`);

  const sets: SQL[] = [];

  if (input.name !== undefined) {
    const name = optionalText(input.name, 'name')?.trim();
    if (!name) throw badRequest('O campo "name" não pode ficar vazio');
    sets.push(sql`name = ${name}`);
  }
  if (input.description !== undefined) {
    sets.push(sql`description = ${optionalText(input.description, 'description')?.trim() ?? ''}`);
  }
  const isOpen = optionalBoolean(input.isOpen, 'isOpen');
  if (isOpen !== undefined) sets.push(sql`is_open = ${isOpen}`);
  const isActive = optionalBoolean(input.isActive, 'isActive');
  if (isActive !== undefined) sets.push(sql`is_active = ${isActive}`);
  if (input.ownerUserUuid !== undefined) {
    sets.push(sql`owner_user_uuid = ${ownerOrNull(input.ownerUserUuid)}`);
  }

  // Slug vazio continua significando "mantém o atual", como em `updateSkill`.
  const requestedSlug = optionalText(input.slug, 'slug')?.trim() || undefined;
  if (requestedSlug !== undefined) {
    assertVirtualMcpSlug(requestedSlug);
    sets.push(sql`slug = ${requestedSlug}`);
  }

  sets.push(sql`updated_at = now()`);

  try {
    await db().transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE virtual_mcps SET ${sql.join(sets, sql`, `)}
        WHERE uuid = ${uuid}
        RETURNING slug
      `);
      const row = (result.rows as Row[])[0];
      if (!row) throw notFound(`MCP virtual não encontrado: ${uuid}`);
      // O slug novo em caso de rename: é o que o painel vai mostrar dali em diante.
      await auditTx(tx, virtualMcpAudit('mcp.update', row.slug as string, source, actor));
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`Já existe um MCP virtual com o slug "${requestedSlug}"`);
    }
    if (isForeignKeyViolation(err)) {
      throw notFound(`Conta não encontrada: ${input.ownerUserUuid}`);
    }
    throw err;
  }

  const detail = await getVirtualMcpByUuid(uuid);
  if (!detail) throw new Error('MCP virtual atualizado mas não encontrado');
  return detail;
}

/** A cascata leva vínculos e chaves. */
export async function deleteVirtualMcp(
  uuid: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<void> {
  if (!isUuid(uuid)) throw notFound(`MCP virtual não encontrado: ${uuid}`);

  await db().transaction(async (tx) => {
    const result = await tx.execute(
      sql`DELETE FROM virtual_mcps WHERE uuid = ${uuid} RETURNING slug`,
    );
    const row = (result.rows as Row[])[0];
    if (!row) throw notFound(`MCP virtual não encontrado: ${uuid}`);
    await auditTx(tx, virtualMcpAudit('mcp.delete', row.slug as string, source, actor));
  });
}

/**
 * Define o recorte de forma **declarativa**: a lista é o estado desejado
 * inteiro. Numa transação: quem saiu da lista é removido, quem entrou é
 * inserido e quem ficou tem só as flags reescritas — os contadores do vínculo
 * sobrevivem a um re-salvar do formulário.
 *
 * As três flags são obrigatórias por item (não há default no banco, de
 * propósito): a escolha por superfície é do vínculo, não da skill.
 */
export async function setVirtualMcpSkills(
  uuid: string,
  skills: VirtualMcpSkillInput[],
  source: AuditSource,
  actor: AuditActor,
): Promise<VirtualMcpDetail> {
  if (!isUuid(uuid)) throw notFound(`MCP virtual não encontrado: ${uuid}`);
  if (!Array.isArray(skills)) throw badRequest('O campo "skills" deve ser uma lista');

  const wanted = skills.map((item, index) => {
    const position = `Item ${index + 1}`;
    const slug = (optionalText(item?.slug, 'slug') ?? '').trim();
    if (!slug) throw badRequest(`${position}: o campo "slug" é obrigatório`);
    return {
      slug,
      asSkill: requireBoolean(item.asSkill, 'asSkill', slug),
      asPrompt: requireBoolean(item.asPrompt, 'asPrompt', slug),
      asResource: requireBoolean(item.asResource, 'asResource', slug),
    };
  });

  const seen = new Set<string>();
  for (const item of wanted) {
    if (seen.has(item.slug)) throw badRequest(`Slug repetido na lista: "${item.slug}"`);
    seen.add(item.slug);
  }
  const slugs = wanted.map((item) => item.slug);

  await db().transaction(async (tx) => {
    // `FOR UPDATE` serializa dois salvamentos concorrentes do mesmo recorte:
    // o segundo espera o primeiro e enxerga o estado dele, em vez de os dois
    // apagarem e inserirem por cima um do outro.
    const locked = await tx.execute(
      sql`SELECT slug FROM virtual_mcps WHERE uuid = ${uuid} FOR UPDATE`,
    );
    const mcp = (locked.rows as Row[])[0];
    if (!mcp) throw notFound(`MCP virtual não encontrado: ${uuid}`);

    const bySlug = new Map<string, string>();
    if (slugs.length > 0) {
      const found = await tx.execute(sql`
        SELECT uuid, slug FROM skills WHERE slug = ANY(${sql.param(slugs)}::text[])
      `);
      for (const row of found.rows as Row[]) bySlug.set(row.slug as string, row.uuid as string);
    }
    const missing = slugs.filter((slug) => !bySlug.has(slug));
    if (missing.length > 0) {
      throw badRequest(`Skills não encontradas: ${missing.join(', ')}`);
    }

    const keep = slugs.map((slug) => bySlug.get(slug)!);
    await tx.execute(sql`
      DELETE FROM virtual_mcp_skills
      WHERE virtual_mcp_uuid = ${uuid}
        AND skill_uuid <> ALL(${sql.param(keep)}::uuid[])
    `);

    // Só as flags no `DO UPDATE`: contadores e posição no canvas (`pos_x`/
    // `pos_y`) de quem ficou não entram na lista e ficam como estavam.
    for (const item of wanted) {
      await tx.execute(sql`
        INSERT INTO virtual_mcp_skills
          (virtual_mcp_uuid, skill_uuid, as_skill, as_prompt, as_resource)
        VALUES (${uuid}, ${bySlug.get(item.slug)!},
                ${item.asSkill}, ${item.asPrompt}, ${item.asResource})
        ON CONFLICT (virtual_mcp_uuid, skill_uuid) DO UPDATE SET
          as_skill = EXCLUDED.as_skill,
          as_prompt = EXCLUDED.as_prompt,
          as_resource = EXCLUDED.as_resource
      `);
    }

    await tx.execute(sql`UPDATE virtual_mcps SET updated_at = now() WHERE uuid = ${uuid}`);
    await auditTx(tx, virtualMcpAudit('mcp.update', mcp.slug as string, source, actor));
  });

  const detail = await getVirtualMcpByUuid(uuid);
  if (!detail) throw new Error('MCP virtual atualizado mas não encontrado');
  return detail;
}

/** O que o canvas grava: o layout dos nós fixos e/ou a posição de skills vinculadas. */
export type VirtualMcpCanvasInput = {
  /** Só as chaves informadas substituem as gravadas; as demais ficam. */
  layout?: VirtualMcpLayout;
  /** Cada uma precisa estar vinculada a este vMCP. */
  positions?: readonly { slug: string; x: number; y: number }[];
};

/**
 * Grava o estado do canvas de um vMCP (`docs/10-admin-canvas-e-sessoes.md`):
 * mescla `layout` em `virtual_mcps.layout` (chave a chave, só as informadas)
 * e grava `pos_x`/`pos_y` das skills listadas. Tudo numa transação: um slug
 * desconhecido ou não vinculado a **este** vMCP é 400 e nada é gravado.
 *
 * Coordenadas precisam ser números finitos e são arredondadas para o pixel
 * inteiro. **Sem auditoria e sem `updated_at`**: mover um nó é estado de
 * tela, não publicação — o `updated_at` do vMCP continua dizendo quando o
 * recorte mudou. A checagem de que o chamador administra o vMCP é do app.
 */
export async function setVirtualMcpCanvas(
  virtualMcpUuid: string,
  input: VirtualMcpCanvasInput,
): Promise<void> {
  if (!isUuid(virtualMcpUuid)) throw notFound(`MCP virtual não encontrado: ${virtualMcpUuid}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('O canvas deve ser um objeto com "layout" e/ou "positions"');
  }

  const layoutPatch: Partial<Record<(typeof LAYOUT_KEYS)[number], CanvasPoint>> = {};
  if (input.layout !== undefined) {
    if (!input.layout || typeof input.layout !== 'object' || Array.isArray(input.layout)) {
      throw badRequest('O campo "layout" deve ser um objeto');
    }
    for (const key of LAYOUT_KEYS) {
      const value = (input.layout as Row)[key];
      if (value === undefined) continue;
      layoutPatch[key] = requirePoint(value, `layout.${key}`);
    }
  }

  if (input.positions !== undefined && !Array.isArray(input.positions)) {
    throw badRequest('O campo "positions" deve ser uma lista');
  }
  const seen = new Set<string>();
  const positions = (input.positions ?? []).map((item, index) => {
    const field = `positions[${index}]`;
    const slug = (optionalText(item?.slug, `${field}.slug`) ?? '').trim();
    if (!slug) throw badRequest(`${field}: o campo "slug" é obrigatório`);
    if (seen.has(slug)) throw badRequest(`Slug repetido na lista: "${slug}"`);
    seen.add(slug);
    return { slug, ...requirePoint(item, field) };
  });

  await db().transaction(async (tx) => {
    // `FOR UPDATE` serializa com `setVirtualMcpSkills`: o canvas não grava a
    // posição de um vínculo que um salvamento concorrente está removendo.
    const locked = await tx.execute(
      sql`SELECT uuid FROM virtual_mcps WHERE uuid = ${virtualMcpUuid} FOR UPDATE`,
    );
    if ((locked.rows as Row[]).length === 0) {
      throw notFound(`MCP virtual não encontrado: ${virtualMcpUuid}`);
    }

    if (Object.keys(layoutPatch).length > 0) {
      // `||` de jsonb substitui chave a chave: as não informadas ficam.
      await tx.execute(sql`
        UPDATE virtual_mcps SET layout = layout || ${JSON.stringify(layoutPatch)}::jsonb
        WHERE uuid = ${virtualMcpUuid}
      `);
    }

    for (const item of positions) {
      const updated = await tx.execute(sql`
        UPDATE virtual_mcp_skills v SET pos_x = ${item.x}, pos_y = ${item.y}
        FROM skills s
        WHERE v.virtual_mcp_uuid = ${virtualMcpUuid}
          AND v.skill_uuid = s.uuid
          AND s.slug = ${item.slug}
        RETURNING v.skill_uuid
      `);
      if ((updated.rows as Row[]).length === 0) {
        throw badRequest(`A skill "${item.slug}" não está vinculada a este MCP virtual`);
      }
    }
  });
}

/**
 * Os vMCPs que o site lista (`docs/09-mcp-padrao-e-skills-flutuantes.md`
 * §4.2): abertos e ligados, sem dono nem chaves — nada que um anônimo não
 * possa saber. Um fechado ou desligado não aparece, nem que seja o padrão.
 */
export async function listOpenVirtualMcps(): Promise<PublicVirtualMcp[]> {
  const result = await db().execute(sql`
    SELECT m.uuid, m.slug, m.name, m.description,
      (SELECT count(*) FROM virtual_mcp_skills v WHERE v.virtual_mcp_uuid = m.uuid)::int AS skill_count,
      (m.uuid::text = (SELECT st.value FROM settings st WHERE st.key = ${DEFAULT_MCP_SETTING}))
        AS is_default
    FROM virtual_mcps m
    WHERE m.is_open AND m.is_active
    ORDER BY is_default DESC NULLS LAST, m.name ASC, m.slug ASC
  `);
  return (result.rows as Row[]).map((row) => ({
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    skillCount: Number(row.skill_count ?? 0),
    isDefault: Boolean(row.is_default),
  }));
}

/** Linha de auditoria de um MCP virtual: sem skill, com o slug do servidor como alvo. */
function virtualMcpAudit(
  action: 'mcp.create' | 'mcp.update' | 'mcp.delete',
  slug: string,
  source: AuditSource,
  actor: AuditActor,
): AuditInput {
  return {
    skillUuid: null,
    skillSlug: null,
    filePath: null,
    action,
    source,
    previousContent: null,
    actor,
    targetLabel: slug,
  };
}

function assertVirtualMcpSlug(slug: string): void {
  if (!isValidSlug(slug)) throw badRequest(`Slug inválido: "${slug}"`);
}

/** Slug livre a partir do nome, no padrão de `resolveSlug` — mas sobre `virtual_mcps`. */
async function freeVirtualMcpSlug(name: string): Promise<string> {
  const desired = slugify(name) || 'mcp';
  const result = await db().execute(
    sql`SELECT slug FROM virtual_mcps WHERE slug = ${desired} OR slug LIKE ${desired + '-%'}`,
  );
  const taken = (result.rows as Row[]).map((row) => row.slug as string);
  return uniqueSlug(desired, taken);
}

/** `null` passa; UUID torto é "conta não encontrada", como em `createApiKey`. */
function ownerOrNull(value: string | null): string | null {
  if (value === null) return null;
  if (!isUuid(value)) throw notFound(`Conta não encontrada: ${String(value)}`);
  return value;
}

/** Mesma história de `optionalText`: `{"isOpen": "sim"}` é erro do cliente, não 500. */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw badRequest(`O campo "${field}" deve ser booleano`);
  return value;
}

/** As flags do vínculo não têm default: omitir uma é erro, não `false`. */
function requireBoolean(value: unknown, field: string, slug: string): boolean {
  if (typeof value !== 'boolean') {
    throw badRequest(`Skill "${slug}": o campo "${field}" é obrigatório e deve ser booleano`);
  }
  return value;
}

// ------------------------------------------------- chaves de MCP virtual ---

const VIRTUAL_MCP_KEY_COLUMNS = sql`
  id, virtual_mcp_uuid, name, prefix, created_by_user_uuid, last_used_at, revoked_at, created_at
`;

function toVirtualMcpKeySummary(row: Row): VirtualMcpKeySummary {
  return {
    id: row.id,
    virtualMcpUuid: row.virtual_mcp_uuid,
    name: row.name,
    prefix: row.prefix,
    createdByUserUuid: row.created_by_user_uuid ?? null,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Inclui as revogadas: elas explicam as linhas de auditoria que produziram. */
export async function listVirtualMcpKeys(virtualMcpUuid: string): Promise<VirtualMcpKeySummary[]> {
  if (!isUuid(virtualMcpUuid)) return [];

  const result = await db().execute(sql`
    SELECT ${VIRTUAL_MCP_KEY_COLUMNS}
    FROM virtual_mcp_keys WHERE virtual_mcp_uuid = ${virtualMcpUuid}
    ORDER BY created_at DESC
  `);
  return (result.rows as Row[]).map(toVirtualMcpKeySummary);
}

/**
 * Grava a chave emitida. O segredo em texto **não** passa por aqui: quem o
 * gera e o mostra uma única vez é o app, com `generateApiKey('psv')` de shared.
 */
export async function createVirtualMcpKey(input: {
  virtualMcpUuid: string;
  name: string;
  prefix: string;
  keyHash: string;
  createdByUserUuid: string | null;
}): Promise<VirtualMcpKeySummary> {
  if (!isUuid(input.virtualMcpUuid)) {
    throw notFound(`MCP virtual não encontrado: ${input.virtualMcpUuid}`);
  }
  const createdBy = ownerOrNull(input.createdByUserUuid ?? null);

  const name = (input.name ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');
  if (!input.prefix?.trim() || !input.keyHash?.trim()) {
    throw badRequest('Prefixo e hash da chave são obrigatórios');
  }

  try {
    const result = await db().execute(sql`
      INSERT INTO virtual_mcp_keys (virtual_mcp_uuid, name, prefix, key_hash, created_by_user_uuid)
      VALUES (${input.virtualMcpUuid}, ${name}, ${input.prefix.trim()}, ${input.keyHash}, ${createdBy})
      RETURNING ${VIRTUAL_MCP_KEY_COLUMNS}
    `);
    return toVirtualMcpKeySummary((result.rows as Row[])[0]);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Prefixo de chave já em uso; tente novamente');
    // O servidor (ou quem emite) sumiu entre a sessão e a emissão.
    if (isForeignKeyViolation(err)) {
      throw notFound(`MCP virtual não encontrado: ${input.virtualMcpUuid}`);
    }
    throw err;
  }
}

/**
 * Revoga, **sempre** restrita ao servidor informado: a chave pertence ao MCP,
 * e a URL do painel já diz de qual. `false` quando não achou, não é dele ou
 * já estava revogada — idempotente, nunca reescreve o `revoked_at` original.
 */
export async function revokeVirtualMcpKey(id: string, virtualMcpUuid: string): Promise<boolean> {
  if (!isUuid(id) || !isUuid(virtualMcpUuid)) return false;

  const result = await db().execute(sql`
    UPDATE virtual_mcp_keys SET revoked_at = now()
    WHERE id = ${id}
      AND virtual_mcp_uuid = ${virtualMcpUuid}
      AND revoked_at IS NULL
    RETURNING id
  `);
  return (result.rows as Row[]).length > 0;
}

export type VirtualMcpKeyRecord = {
  id: string;
  virtualMcpUuid: string;
  name: string;
  prefix: string;
  keyHash: string;
  revokedAt: string | null;
};

/**
 * Primeiro passo da autenticação: acha a linha pelo prefixo público. A
 * conferência do segredo contra `keyHash` é do app (`verifyApiKeySecret`), e
 * conferir se a chave abre **este** servidor também: compare `virtualMcpUuid`
 * com o resolvido pela URL — uma chave `psv_` válida de outro MCP não vale.
 */
export async function getVirtualMcpKeyByPrefix(prefix: string): Promise<VirtualMcpKeyRecord | null> {
  const wanted = (prefix ?? '').trim();
  if (!wanted) return null;

  const result = await db().execute(sql`
    SELECT id, virtual_mcp_uuid, name, prefix, key_hash, revoked_at
    FROM virtual_mcp_keys WHERE prefix = ${wanted} LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  return {
    id: row.id,
    virtualMcpUuid: row.virtual_mcp_uuid,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.key_hash,
    revokedAt: iso(row.revoked_at),
  };
}

/** Marca o uso. Falha silenciosa de propósito: não é para derrubar a chamada. */
export async function touchVirtualMcpKey(id: string): Promise<void> {
  if (!isUuid(id)) return;
  await db().execute(sql`UPDATE virtual_mcp_keys SET last_used_at = now() WHERE id = ${id}`);
}

// ------------------------------------------------------------ sessões MCP ---

// Espelhos dos `CHECK`s de `mcp_sessions` (`schema/015-mcp-sessions.sql`):
// um valor fora da lista é 400 aqui, e não uma violação de CHECK virando 500.
const MCP_SESSION_TRANSPORTS: readonly McpSessionTransport[] = ['streamable', 'sse', 'stateless'];
const MCP_SESSION_MOUNTS: readonly McpSessionMount[] = ['root', 'virtual'];
const MCP_SESSION_AUTHS: readonly McpSessionAuth[] = ['open', 'key'];
const MCP_SESSION_END_REASONS: readonly McpSessionEndReason[] = ['closed', 'timeout', 'shutdown'];

/** Teto para o que vem de cabeçalhos e do `clientInfo`: é rótulo de tela, não conteúdo. */
const MCP_SESSION_LABEL_MAX = 512;

export type OpenMcpSessionInput = {
  /** `mcp-session-id`, o `sessionId` do SSE ou a chave sintética do stateless. */
  sessionId: string;
  transport: McpSessionTransport;
  mount: McpSessionMount;
  virtualMcpUuid: string;
  /** Cópia: o histórico sobrevive à remoção do vMCP. */
  virtualMcpSlug: string;
  auth: McpSessionAuth;
  /** A chave `psv_` usada, quando `auth` é `'key'`. */
  keyId?: string | null;
  /** Já resolvido pelo `trust proxy` (X-Forwarded-For quando confiável). */
  ip: string;
  userAgent?: string | null;
  /** `clientInfo` do `initialize`; pode chegar depois, por `touchMcpSession`. */
  clientName?: string | null;
  clientVersion?: string | null;
  /** Requisições já contadas na abertura (padrão 1). */
  requests?: number;
};

// `ms` é a sessão, `k` a chave (LEFT JOIN: a maioria é aberta ou a chave foi embora).
const MCP_SESSION_COLUMNS = sql`
  ms.id, ms.session_id, ms.transport, ms.mount, ms.virtual_mcp_uuid, ms.virtual_mcp_slug,
  ms.auth, ms.key_id, k.name AS key_name, ms.ip, ms.user_agent,
  ms.client_name, ms.client_version, ms.started_at, ms.last_seen_at,
  ms.ended_at, ms.end_reason, ms.request_count
`;

function toMcpSessionSummary(row: Row): McpSessionSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    transport: row.transport,
    mount: row.mount,
    virtualMcpUuid: row.virtual_mcp_uuid ?? null,
    virtualMcpSlug: row.virtual_mcp_slug,
    auth: row.auth,
    keyId: row.key_id ?? null,
    keyName: row.key_name ?? null,
    ip: row.ip,
    userAgent: row.user_agent ?? null,
    clientName: row.client_name ?? null,
    clientVersion: row.client_version ?? null,
    startedAt: new Date(row.started_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    endedAt: iso(row.ended_at),
    endReason: row.end_reason ?? null,
    requestCount: Number(row.request_count ?? 0),
    isOnline: Boolean(row.is_online),
  };
}

/**
 * Abre a linha de uma sessão e devolve o `id` — é ele que o servidor guarda
 * ao lado do transporte para os `touch`/`close` seguintes. `sessionId`, `ip`
 * e `virtualMcpSlug` vazios, uuid torto ou valor fora dos `CHECK`s são 400;
 * um vMCP (ou chave) que sumiu entre a resolução e a abertura é 404.
 */
export async function openMcpSession(input: OpenMcpSessionInput): Promise<string> {
  const sessionId = requireText(input.sessionId, 'sessionId');
  const transport = oneOf(input.transport, MCP_SESSION_TRANSPORTS, 'transport');
  const mount = oneOf(input.mount, MCP_SESSION_MOUNTS, 'mount');
  if (!isUuid(input.virtualMcpUuid)) {
    throw badRequest('O campo "virtualMcpUuid" precisa ser um uuid');
  }
  const virtualMcpSlug = requireText(input.virtualMcpSlug, 'virtualMcpSlug');
  const auth = oneOf(input.auth, MCP_SESSION_AUTHS, 'auth');
  const keyId = input.keyId ?? null;
  if (keyId !== null && !isUuid(keyId)) throw badRequest('O campo "keyId" precisa ser um uuid');
  const ip = requireText(input.ip, 'ip');
  const requests = input.requests === undefined ? 1 : requireCount(input.requests, 'requests');

  try {
    const result = await db().execute(sql`
      INSERT INTO mcp_sessions (
        session_id, transport, mount, virtual_mcp_uuid, virtual_mcp_slug, auth, key_id,
        ip, user_agent, client_name, client_version, request_count
      )
      VALUES (
        ${sessionId}, ${transport}, ${mount}, ${input.virtualMcpUuid}, ${virtualMcpSlug},
        ${auth}, ${keyId}, ${ip},
        ${sessionLabel(input.userAgent, 'userAgent')},
        ${sessionLabel(input.clientName, 'clientName')},
        ${sessionLabel(input.clientVersion, 'clientVersion')},
        ${requests}
      )
      RETURNING id
    `);
    return (result.rows as Row[])[0].id as string;
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw notFound(`MCP virtual ou chave não encontrados: ${input.virtualMcpUuid}`);
    }
    throw err;
  }
}

/**
 * Marca atividade: `last_seen_at = now()` e `request_count += requests`.
 * `clientName`/`clientVersion` preenchem só o que ainda está nulo — o
 * `initialize` pode chegar depois da abertura, mas nunca reescreve o que já
 * foi visto. Linha já encerrada não é tocada; `id` torto é ignorado, como em
 * `touchApiKey`: não é para derrubar a requisição.
 */
export async function touchMcpSession(
  id: string,
  patch: { requests: number; clientName?: string | null; clientVersion?: string | null },
): Promise<void> {
  if (!isUuid(id)) return;
  const requests = requireCount(patch.requests, 'requests');

  await db().execute(sql`
    UPDATE mcp_sessions SET
      last_seen_at = now(),
      request_count = request_count + ${requests},
      client_name = COALESCE(client_name, ${sessionLabel(patch.clientName, 'clientName')}),
      client_version = COALESCE(client_version, ${sessionLabel(patch.clientVersion, 'clientVersion')})
    WHERE id = ${id} AND ended_at IS NULL
  `);
}

/** Encerra com `ended_at = now()`, só se ainda aberta: o primeiro fim é o que fica. */
export async function closeMcpSession(id: string, reason: McpSessionEndReason): Promise<void> {
  const endReason = oneOf(reason, MCP_SESSION_END_REASONS, 'reason');
  if (!isUuid(id)) return;

  await db().execute(sql`
    UPDATE mcp_sessions SET ended_at = now(), end_reason = ${endReason}
    WHERE id = ${id} AND ended_at IS NULL
  `);
}

/**
 * O mesmo, em lote — o `shutdown` do servidor fecha tudo o que tinha aberto.
 * Devolve quantas fechou de fato (as já encerradas não contam).
 */
export async function closeMcpSessions(
  ids: readonly string[],
  reason: McpSessionEndReason,
): Promise<number> {
  const endReason = oneOf(reason, MCP_SESSION_END_REASONS, 'reason');
  if (!Array.isArray(ids)) throw badRequest('O campo "ids" deve ser uma lista');
  const valid = ids.filter(isUuid);
  if (valid.length === 0) return 0;

  const result = await db().execute(sql`
    UPDATE mcp_sessions SET ended_at = now(), end_reason = ${endReason}
    WHERE id = ANY(${sql.param(valid)}::uuid[]) AND ended_at IS NULL
    RETURNING id
  `);
  return (result.rows as Row[]).length;
}

/**
 * A linha aberta de uma sessão com atividade dentro de `withinMs`, ou `null`.
 * É o reuso de linha do stateless: depois de um restart o servidor não tem
 * mais o `id` em memória, recalcula a chave sintética e a reencontra aqui em
 * vez de abrir uma segunda linha para o mesmo cliente. Havendo mais de uma
 * (dois processos abriram ao mesmo tempo), vale a mais recente.
 */
export async function findOpenMcpSession(input: {
  sessionId: string;
  transport: McpSessionTransport;
  withinMs: number;
}): Promise<string | null> {
  const sessionId = requireText(input.sessionId, 'sessionId');
  const transport = oneOf(input.transport, MCP_SESSION_TRANSPORTS, 'transport');
  const within = windowInterval(input.withinMs, 'withinMs');

  const result = await db().execute(sql`
    SELECT id FROM mcp_sessions
    WHERE session_id = ${sessionId}
      AND transport = ${transport}
      AND ended_at IS NULL
      AND last_seen_at >= now() - ${within}
    ORDER BY last_seen_at DESC
    LIMIT 1
  `);
  return ((result.rows as Row[])[0]?.id as string | undefined) ?? null;
}

/**
 * A varredura de expiração: encerra como `timeout` o que ficou sem atividade
 * — stateless além de `statelessWindowMs`, streamable/sse além de
 * `sessionTtlMs`. O fim gravado é **presumido**: `last_seen_at` mais o prazo,
 * o instante em que a sessão deixou de estar online, e não o instante da
 * varredura (que pode ter demorado a rodar). Devolve quantas fechou.
 */
export async function expireMcpSessions(input: {
  statelessWindowMs: number;
  sessionTtlMs: number;
}): Promise<number> {
  const stateless = windowInterval(input.statelessWindowMs, 'statelessWindowMs');
  const ttl = windowInterval(input.sessionTtlMs, 'sessionTtlMs');
  const deadline = sql`CASE WHEN transport = 'stateless' THEN ${stateless} ELSE ${ttl} END`;

  const result = await db().execute(sql`
    UPDATE mcp_sessions SET
      ended_at = last_seen_at + ${deadline},
      end_reason = 'timeout'
    WHERE ended_at IS NULL
      AND last_seen_at < now() - ${deadline}
    RETURNING id
  `);
  return (result.rows as Row[]).length;
}

export type ListMcpSessionsOptions = {
  /** Obrigatória: é o que define `isOnline` (e `onlineOnly`). */
  onlineWindowMs: number;
  /** Um vMCP só. */
  virtualMcpUuid?: string;
  /**
   * O recorte de quem não é admin: só os vMCPs que administra. `[]` devolve
   * a página vazia sem consultar. Sessões de um vMCP já apagado (uuid nulo)
   * ficam fora do recorte — só o admin as vê.
   */
  virtualMcpUuids?: readonly string[];
  onlineOnly?: boolean;
  /** Clamp 1..200; padrão 50. */
  limit?: number;
  offset?: number;
};

/**
 * A lista de sessões do painel: mais recente atividade primeiro, com o nome
 * da chave (`LEFT JOIN virtual_mcp_keys`) e `isOnline` calculado no SQL com a
 * janela informada. `total` respeita os mesmos filtros da página.
 */
export async function listMcpSessions(options: ListMcpSessionsOptions): Promise<McpSessionPage> {
  const limit = clamp(options.limit ?? 50, 1, 200);
  const offset = pageOffset(options.offset);
  const online = sql`(ms.ended_at IS NULL
    AND ms.last_seen_at >= now() - ${windowInterval(options.onlineWindowMs, 'onlineWindowMs')})`;

  const conditions: SQL[] = [];
  if (options.virtualMcpUuid !== undefined) {
    if (!isUuid(options.virtualMcpUuid)) {
      throw badRequest('O campo "virtualMcpUuid" precisa ser um uuid');
    }
    conditions.push(sql`ms.virtual_mcp_uuid = ${options.virtualMcpUuid}`);
  }
  if (options.virtualMcpUuids !== undefined) {
    if (!Array.isArray(options.virtualMcpUuids)) {
      throw badRequest('O campo "virtualMcpUuids" deve ser uma lista');
    }
    if (options.virtualMcpUuids.length === 0) return { items: [], total: 0, limit, offset };
    for (const uuid of options.virtualMcpUuids) {
      if (!isUuid(uuid)) throw badRequest(`"virtualMcpUuids" traz um valor que não é uuid: ${String(uuid)}`);
    }
    conditions.push(
      sql`ms.virtual_mcp_uuid = ANY(${sql.param([...options.virtualMcpUuids])}::uuid[])`,
    );
  }
  if (options.onlineOnly === true) conditions.push(online);

  const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const counted = await db().execute(
    sql`SELECT count(*)::int AS total FROM mcp_sessions ms ${where}`,
  );
  const total = Number((counted.rows as Row[])[0]?.total ?? 0);

  const result = await db().execute(sql`
    SELECT ${MCP_SESSION_COLUMNS}, ${online} AS is_online
    FROM mcp_sessions ms
    LEFT JOIN virtual_mcp_keys k ON k.id = ms.key_id
    ${where}
    ORDER BY ms.last_seen_at DESC, ms.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return { items: (result.rows as Row[]).map(toMcpSessionSummary), total, limit, offset };
}

/**
 * Quantos clientes estão online agora — o número do globo da Internet —, no
 * total e por transporte. Com `virtualMcpUuid`, só daquele vMCP.
 */
export async function countOnlineMcpSessions(options: {
  onlineWindowMs: number;
  virtualMcpUuid?: string;
}): Promise<{ total: number; byTransport: Record<McpSessionTransport, number> }> {
  const window = windowInterval(options.onlineWindowMs, 'onlineWindowMs');
  if (options.virtualMcpUuid !== undefined && !isUuid(options.virtualMcpUuid)) {
    throw badRequest('O campo "virtualMcpUuid" precisa ser um uuid');
  }

  const result = await db().execute(sql`
    SELECT ms.transport, count(*)::int AS n
    FROM mcp_sessions ms
    WHERE ms.ended_at IS NULL
      AND ms.last_seen_at >= now() - ${window}
      ${options.virtualMcpUuid !== undefined ? sql`AND ms.virtual_mcp_uuid = ${options.virtualMcpUuid}` : sql``}
    GROUP BY ms.transport
  `);

  const byTransport: Record<McpSessionTransport, number> = { streamable: 0, sse: 0, stateless: 0 };
  let total = 0;
  for (const row of result.rows as Row[]) {
    const transport = row.transport as McpSessionTransport;
    const n = Number(row.n ?? 0);
    if (transport in byTransport) byTransport[transport] = n;
    total += n;
  }
  return { total, byTransport };
}

/** Texto obrigatório, aparado: vazio é 400. */
function requireText(value: unknown, field: string): string {
  const text = (optionalText(value, field) ?? '').trim();
  if (!text) throw badRequest(`O campo "${field}" é obrigatório`);
  return text;
}

/** Um valor de uma lista fechada (os `CHECK`s do banco, espelhados aqui). */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw badRequest(`O campo "${field}" deve ser um de: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Contagem de requisições: inteiro ≥ 0. */
function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest(`O campo "${field}" deve ser um número inteiro maior ou igual a zero`);
  }
  return Math.trunc(value);
}

/** Rótulo opcional de sessão: aparado, vazio vira nulo, cortado no teto. */
function sessionLabel(value: unknown, field: string): string | null {
  const text = optionalText(value, field)?.trim();
  if (!text) return null;
  return truncate(text, MCP_SESSION_LABEL_MAX);
}

// --------------------------------------------------------------- internos ---

async function requireSkill(slug: string): Promise<SkillSummary> {
  const skill = await getSkillSummary(slug, { visibility: 'all' });
  if (!skill) throw notFound(`Skill não encontrada: ${slug}`);
  return skill;
}

async function resolveSlug(requested: string | undefined, fallbackName: string): Promise<string> {
  const desired = slugify(requested?.trim() || fallbackName) || 'skill';
  const result = await db().execute(
    sql`SELECT slug FROM skills WHERE slug = ${desired} OR slug LIKE ${desired + '-%'}`,
  );
  const taken = (result.rows as Row[]).map((row) => row.slug as string);
  const slug = uniqueSlug(desired, taken);

  if (requested?.trim() && slug !== desired) {
    throw conflict(`Já existe uma skill com o slug "${desired}"`);
  }
  return slug;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function upsertFileTx(tx: Tx, skillUuid: string, path: string, buffer: Buffer) {
  const mimeType = mimeTypeFor(path);
  const textual = isTextualMime(mimeType) && !buffer.includes(0);
  const text = textual ? buffer.toString('utf8') : null;
  const binary = textual ? null : buffer;

  // O conflito é inferido pelo índice `files_skill_path_lower_uniq`
  // (migration 0003): gravar `Notas.md` sobre `notas.md` sobrescreve a linha
  // existente em vez de criar uma segunda. A caixa recebida vira a definitiva —
  // caso contrário a listagem continuaria mostrando o nome antigo.
  await tx.execute(sql`
    INSERT INTO files (skill_uuid, relative_path, text_content, binary_content, mime_type, size_bytes)
    VALUES (${skillUuid}, ${path}, ${text}, ${binary}, ${mimeType}, ${buffer.byteLength})
    ON CONFLICT (skill_uuid, lower(relative_path)) DO UPDATE SET
      relative_path = EXCLUDED.relative_path,
      text_content = EXCLUDED.text_content,
      binary_content = EXCLUDED.binary_content,
      mime_type = EXCLUDED.mime_type,
      size_bytes = EXCLUDED.size_bytes,
      updated_at = now()
  `);
}

/**
 * Os chamadores garantem que `rawTags` é um array (`optionalTextList`); aqui os
 * itens seguem tolerantes de propósito: número ou `null` numa lista de tags
 * vira texto e é descartado se ficar vazio, sem derrubar a gravação inteira.
 */
async function replaceTagsTx(tx: Tx, skillUuid: string, rawTags: readonly string[]) {
  const names = Array.from(
    new Set(
      rawTags
        .map((tag) => String(tag ?? '').trim().toLowerCase())
        .filter((tag) => tag.length > 0 && tag.length <= 48),
    ),
  );

  await tx.execute(sql`DELETE FROM skill_tags WHERE skill_uuid = ${skillUuid}`);
  if (names.length === 0) return;

  await tx.execute(sql`
    INSERT INTO tags (name)
    SELECT unnest(${sql.param(names)}::text[]) ON CONFLICT (name) DO NOTHING
  `);
  await tx.execute(sql`
    INSERT INTO skill_tags (skill_uuid, tag_id)
    SELECT ${skillUuid}, t.id FROM tags t WHERE t.name = ANY(${sql.param(names)}::text[])
    ON CONFLICT DO NOTHING
  `);
}

type AuditInput = {
  skillUuid: string | null;
  skillSlug: string | null;
  filePath: string | null;
  action: AuditAction;
  source: AuditSource;
  previousContent: string | null;
  /**
   * Quem executou. Opcional porque a origem (`web-admin`/`mcp-admin`) sempre
   * existiu e o ator só passou a existir com as contas: chamada antiga grava
   * a linha sem ator, exatamente como antes.
   */
  actor?: AuditActor | null;
  /** Alvo de um evento de conta; nulo nas linhas de skill. */
  targetLabel?: string | null;
};

/** Monta o INSERT — compartilhado pelas escritas de skill e por `recordAccountAudit`. */
function auditInsert(entry: AuditInput): SQL {
  return sql`
    INSERT INTO audit_log (
      skill_uuid, skill_slug, file_path, action, source, previous_content,
      actor_user_uuid, actor_label, target_label
    )
    VALUES (${entry.skillUuid}, ${entry.skillSlug}, ${entry.filePath}, ${entry.action},
            ${entry.source}, ${truncate(entry.previousContent, 200_000)},
            ${entry.actor?.userUuid ?? null}, ${entry.actor?.label ?? null},
            ${entry.targetLabel ?? null})
  `;
}

async function auditTx(tx: Tx, entry: AuditInput) {
  await tx.execute(auditInsert(entry));
}

/** UUID canônico. Serve para não deixar um identificador torto virar erro 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Timestamp opcional em ISO — o padrão de saída de datas do módulo. */
function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeQuery(raw: string | null | undefined): string | null {
  const query = (raw ?? '').trim();
  return query.length > 0 ? query.slice(0, 200) : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/** `OFFSET` é bigint: fração ou lixo vira 0, não erro do driver. */
function pageOffset(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * O ícone como chegou do formulário ou da tool, pela regra de shared:
 * `undefined` não mexe, `null`/vazio apaga, texto válido é o ícone e o resto
 * é erro do cliente.
 */
function optionalIcon(value: unknown): string | null | undefined {
  const icon = normalizeSkillIcon(value);
  if (icon === false) {
    throw badRequest('O ícone precisa ser um único emoji ou a URL http(s) de uma imagem');
  }
  return icon;
}

/** Teto de `INTEGER` do Postgres: uma coordenada além disso é lixo, não um pixel. */
const CANVAS_MAX = 2_147_483_647;

/**
 * Um ponto do canvas vindo do cliente: `x` e `y` numéricos e finitos,
 * arredondados para o pixel inteiro. Qualquer outra coisa é 400.
 */
function requirePoint(value: unknown, field: string): CanvasPoint {
  const point = readPoint(value);
  if (!point) throw badRequest(`O campo "${field}" precisa ser um ponto {x, y} numérico`);
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (Math.abs(x) > CANVAS_MAX || Math.abs(y) > CANVAS_MAX) {
    throw badRequest(`O campo "${field}" está fora do canvas`);
  }
  return { x, y };
}

/** Uma janela em milissegundos como intervalo do Postgres; não finita ou ≤ 0 é 400. */
function windowInterval(ms: unknown, field: string): SQL {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw badRequest(`O campo "${field}" deve ser um número de milissegundos maior que zero`);
  }
  return sql`make_interval(secs => ${ms / 1000})`;
}

/** Uma `Date` válida ou nada; outro tipo, ou data inválida, é 400. */
function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw badRequest(`O campo "${field}" deve ser uma data válida`);
  }
  return value;
}
