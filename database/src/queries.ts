import { sql, type SQL } from 'drizzle-orm';
import {
  SKILL_MD,
  VIRTUAL_MCP_PREVIEW_SIZE,
  isAccessLevel,
  isAccessScope,
  isRole,
  isSkillMd,
  isTextualContent,
  isValidSlug,
  mimeTypeFor,
  normalizeRelativePath,
  normalizeSkillIcon,
  skillScore,
  slugify,
  uniqueSlug,
  type AccessLevel,
  type AccessScope,
  type ApiKeySummary,
  type AuditAction,
  type AuditActor,
  type AuditEntry,
  type AuditPage,
  type AuditSource,
  type CanvasPoint,
  type CatalogDetail,
  type CatalogMcpRef,
  type CatalogSkill,
  type CatalogSkillInput,
  type CatalogSummary,
  type EffectiveAccess,
  type Grant,
  type McpSessionAuth,
  type McpSessionEndReason,
  type McpSessionMount,
  type McpSessionPage,
  type McpSessionSummary,
  type McpSessionTransport,
  type PublicCatalog,
  type PublicCatalogDetail,
  type PublicVirtualMcp,
  type Role,
  type SkillCatalogRef,
  type SkillDetail,
  type SkillFileMeta,
  type SkillLinkInput,
  type SkillMcpRef,
  type SkillSummary,
  type SearchResult,
  type SkillAccessAuth,
  type SkillAccessEntry,
  type SkillAccessInput,
  type SkillAccessKind,
  type SkillAccessOrigin,
  type SkillAccessPage,
  type SkillAccessSurface,
  type UserLookup,
  type UserSummary,
  type VirtualMcpCatalog,
  type VirtualMcpCatalogInput,
  type VirtualMcpDetail,
  type VirtualMcpKeySummary,
  type VirtualMcpLayout,
  type VirtualMcpPreviewCatalog,
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
 * a enxergar só as skills **expostas** nele na superfície pedida — pelo
 * vínculo direto ou, sem ele, por um catálogo vinculado
 * (`docs/11-catalogos.md` §3.2). Quando presente, `visibility` é ignorada:
 * quem decide é o vínculo.
 */
export type VirtualScope = { uuid: string; surface: VirtualSurface };

/**
 * O que uma leitura enxerga (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4.2,
 * ampliada por `docs/12-acesso-granular.md` §7).
 *
 * `'open'` — o padrão, e o que o site e a API REST mostram: só skills
 * **ligadas** que são públicas (`is_public`), ou expostas em ao menos um vMCP
 * aberto e ligado (por vínculo direto ou por catálogo), ou com participação
 * ativa em catálogo público e ligado. `'all'` — o acervo inteiro, inclusive
 * skills flutuantes (sem vínculo) e desligadas: o admin, o token global e a
 * sessão de bootstrap. Quem não é admin passa `viewer` em vez disso. O padrão
 * é o restritivo de propósito: um chamador que esquece a opção mostra de
 * menos, nunca de mais.
 */
export type SkillVisibility = 'open' | 'all';

/**
 * A conta que está lendo (`docs/12-acesso-granular.md` §3.1). Com `role:
 * 'admin'` é o mesmo que `visibility: 'all'` e todo `access` é `'owner'`; com
 * outro papel, a leitura vê o que é da conta, o que lhe foi concedido, o que
 * é público e o que está dentro de um contêiner que ela vê, e `access` diz
 * o que ela pode em cada linha. `userUuid` nulo com papel que não é admin
 * enxerga só o público — não é um caso do painel, mas não pode vazar nada.
 */
export type Viewer = { role: Role; userUuid: string | null };

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
  /** A conta que lê — ver `Viewer`. Sobrepõe `visibility`. */
  viewer?: Viewer;
  /**
   * O filtro das listas do painel, relativo ao `viewer` (exige um): `'mine'`
   * é o que a conta possui; `'shared'` o que lhe foi concedido, direto ou
   * por um contêiner que ela possui ou lhe foi concedido, e que não é dela;
   * `'public'` o que qualquer um lê. Sem `scope`, a união.
   */
  scope?: AccessScope;
  /** Recorte de um MCP virtual — ver `VirtualScope`. Sobrepõe `visibility` e `viewer`. */
  virtualMcp?: VirtualScope;
  sort?: SortOrder;
  /** A perna vetorial da busca — ver `SemanticScope`. Sem ela, a busca é a de sempre. */
  semantic?: SemanticScope;
};

/**
 * A perna vetorial da busca híbrida (`docs/14-rag.md` §8.2). Quem a monta é o
 * app: ele lê o driver e o modelo de `settings`, acha o espaço ativo
 * (`findRagSpace`), embute a consulta com o **prefixo de
 * consulta** daquele espaço e passa o vetor aqui. O prefixo não aparece no
 * SQL: ele só existe na chamada ao provedor.
 *
 * Sem `query` a opção é ignorada e o modo é `'text'` — uma listagem sem
 * termo não tem o que fundir. Espaço torto ou vetor que não é uma lista de
 * números finitos é 400: a essa altura o app já decidiu que dá para buscar
 * por significado, e degradar em silêncio seria responder `'hybrid'` sem
 * perna vetorial nenhuma.
 */
export type SemanticScope = {
  spaceUuid: string;
  vector: readonly number[];
  /** Vizinhos trazidos pela perna vetorial; padrão 20, clamp 1..100. */
  neighbors?: number;
};

/**
 * Como a página foi obtida: só texto, ou texto fundido com a perna vetorial.
 * É o campo `mode` de `SearchResult`, com nome — derivado dele para não haver
 * duas listas a manter.
 */
export type SearchMode = SearchResult['mode'];

/** Um vizinho da perna vetorial que chegou à página, com a distância do cosseno. */
export type RagNeighbor = { slug: string; distance: number };

/**
 * O que `listSkills` devolve: o `SearchResult` de shared — que já traz o
 * `mode` — **mais** os vizinhos da perna vetorial.
 *
 * `neighbors` fica **fora** de `items`, e no banco em vez de em shared, de
 * propósito: `SkillSummary` é o que os apps serializam para o cliente, e a
 * distância não vai para o cliente na v1 (§8.1) — aqui ela é o que o app
 * registra no log.
 */
export type SkillSearchResult = SearchResult & {
  neighbors: RagNeighbor[];
};

/** `k` do Reciprocal Rank Fusion (§8.2): o mesmo das duas pernas. */
const RRF_K = 60;

/**
 * Vizinhos da perna vetorial quando o chamador não pede outro número (§8.2).
 *
 * É o **único** teto da busca híbrida, e de propósito: a perna vetorial é uma
 * janela de vizinhança, não um conjunto de resultados. A perna textual já teve
 * um teto igual (100 skills) e ele travava o `total` da busca em
 * 100 + `neighbors`, deixando tudo além disso inalcançável — o mesmo termo
 * anunciava 400 resultados sem a perna vetorial e 120 com ela, e a paginação
 * parava na página 5.
 */
const SEMANTIC_NEIGHBORS = 20;

/**
 * Teto do termo de busca, em caracteres: `normalizeQuery` corta nele, e é o
 * mesmo para skills, auditoria, acessos e contas. Exportado porque o site e o
 * MCP público validam o `q` antes de chegar aqui — o número não deve viver em
 * três lugares. Termo maior não é erro: é cortado.
 */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/** As chaves de `ListOptions` que também valem ao ler uma skill só, ou as tags. */
type ReadOptions = Pick<ListOptions, 'visibility' | 'viewer' | 'virtualMcp'>;

/**
 * O modo de uma leitura, resolvido de `visibility` e `viewer`: `'all'` (o
 * admin — por papel, pelo token global ou pelo bootstrap), `'open'` (o site)
 * ou a conta que lê, com o uuid dela (nulo se torto ou ausente).
 */
type ReadMode = { kind: 'all' } | { kind: 'open' } | { kind: 'viewer'; user: string | null };

function readMode({ visibility = 'open', viewer }: Pick<ReadOptions, 'visibility' | 'viewer'>): ReadMode {
  if (viewer !== undefined && viewer !== null) {
    if (!isRole(viewer.role)) throw badRequest(`Papel inválido: ${String(viewer.role)}`);
    if (viewer.role === 'admin') return { kind: 'all' };
    return { kind: 'viewer', user: isUuid(viewer.userUuid) ? viewer.userUuid : null };
  }
  return visibility === 'all' ? { kind: 'all' } : { kind: 'open' };
}

/** O `scope` das listagens, validado; exige `viewer` porque é relativo a ele. */
function readScope(options: Pick<ListOptions, 'viewer' | 'scope'>): AccessScope | undefined {
  if (options.scope === undefined || options.scope === null) return undefined;
  if (!isAccessScope(options.scope)) {
    throw badRequest(`O campo "scope" deve ser um de: mine, shared, public`);
  }
  if (options.viewer === undefined || options.viewer === null) {
    throw badRequest('O filtro "scope" exige "viewer"');
  }
  return options.scope;
}

/**
 * A conta a que o `scope` é relativo: a do `viewer`, mesmo quando é admin —
 * o admin também tem "meus". Nulo quando não há conta (bootstrap, token).
 */
function scopeUser(options: Pick<ListOptions, 'viewer'>): string | null {
  const uuid = options.viewer?.userUuid;
  return isUuid(uuid) ? uuid : null;
}

/** O uuid do viewer (ou nulo) como parâmetro tipado, para as comparações com colunas uuid. */
const userParam = (user: string | null): SQL => sql`${user}::uuid`;

/**
 * A skill `s` (da consulta que embute isto) está exposta no vMCP `mcp` — uma
 * expressão SQL com o uuid do servidor: `m.uuid` de um `virtual_mcps m` de
 * fora, ou um parâmetro. É a precedência de `docs/11-catalogos.md` §3.2, em
 * SQL e num lugar só:
 *
 *   - com vínculo **direto** (`virtual_mcp_skills`), valem as portas dele e
 *     nada mais — ele sobrescreve qualquer catálogo;
 *   - sem vínculo direto, valem os catálogos **ligados** em que a skill tem
 *     participação **ativa** e que estão vinculados ao vMCP; entre catálogos
 *     não há precedência, as portas somam.
 *
 * Com `surface`, a porta pedida precisa estar ligada no caminho que valeu;
 * sem, basta a skill estar lá por qualquer caminho, com qualquer porta — é
 * a pergunta do site ("está publicada aqui?"), não a do servidor MCP.
 *
 * `skills.is_active` fica de fora de propósito: quem chama decide se a
 * pergunta é "estaria exposta" (o painel, em `mcps`) ou "está exposta" (o
 * site e o servidor, que acrescentam `s.is_active`).
 */
function exposedIn(mcp: SQL, surface?: VirtualSurface): SQL {
  const direct = surface ? sql`AND ${surfaceFlag('v', surface)}` : sql``;
  const viaCatalog = surface ? sql`AND ${surfaceFlag('vc', surface)}` : sql``;
  return sql`(
    EXISTS (
      SELECT 1 FROM virtual_mcp_skills v
      WHERE v.skill_uuid = s.uuid AND v.virtual_mcp_uuid = ${mcp} ${direct}
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM virtual_mcp_skills v
        WHERE v.skill_uuid = s.uuid AND v.virtual_mcp_uuid = ${mcp}
      )
      AND EXISTS (
        SELECT 1 FROM catalog_skills cs
        JOIN catalogs c ON c.uuid = cs.catalog_uuid AND c.is_active
        JOIN virtual_mcp_catalogs vc ON vc.catalog_uuid = c.uuid AND vc.virtual_mcp_uuid = ${mcp}
        WHERE cs.skill_uuid = s.uuid AND cs.is_active ${viaCatalog}
      )
    )
  )`;
}

/**
 * A skill `s` está exposta em algum vMCP aberto e ligado, por vínculo direto
 * ou por catálogo. Sem `s.is_active` de propósito, como `exposedIn`: quem
 * chama decide se pergunta "estaria" (o painel) ou "está" (o site).
 */
const OPEN_MCP_EXPOSURE: SQL = sql`EXISTS (
  SELECT 1 FROM virtual_mcps m
  WHERE m.is_open AND m.is_active AND ${exposedIn(sql`m.uuid`)}
)`;

/** A skill `s` tem participação ativa em algum catálogo público e ligado (`docs/12` decisão 5). */
const PUBLIC_CATALOG_EXPOSURE: SQL = sql`EXISTS (
  SELECT 1 FROM catalog_skills cs JOIN catalogs c ON c.uuid = cs.catalog_uuid
  WHERE cs.skill_uuid = s.uuid AND cs.is_active AND c.is_active AND c.is_public
)`;

/**
 * Qualquer um pode ler a skill `s`, ligada ou não: ela é pública, está em
 * vMCP aberto e ligado, ou em catálogo público e ligado. É a parte "público"
 * do que uma conta enxerga e o filtro `scope: 'public'`.
 */
const PUBLIC_REACH: SQL = sql`(s.is_public OR ${OPEN_MCP_EXPOSURE} OR ${PUBLIC_CATALOG_EXPOSURE})`;

/**
 * A regra do site (`docs/12-acesso-granular.md` §7), em SQL: skill ligada
 * **e** legível por qualquer um. `s` é a skill da consulta de fora.
 */
const OPEN_EXPOSURE: SQL = sql`(s.is_active AND ${PUBLIC_REACH})`;

/** O nível concedido a `user` na skill `s`, ou nulo. */
const skillGrantOf = (user: string | null): SQL =>
  sql`(SELECT g.level FROM skill_grants g WHERE g.skill_uuid = s.uuid AND g.user_uuid = ${userParam(user)})`;

/** O vMCP `m` é de `user` ou lhe foi concedido — a árvore inteira dele é legível (`docs/12` decisão 5). */
const mcpSeenBy = (user: string | null): SQL =>
  sql`(m.owner_user_uuid = ${userParam(user)} OR EXISTS (
    SELECT 1 FROM virtual_mcp_grants vg
    WHERE vg.virtual_mcp_uuid = m.uuid AND vg.user_uuid = ${userParam(user)}
  ))`;

/** O catálogo `c` é de `user` ou lhe foi concedido — todos os membros são legíveis. */
const catalogSeenBy = (user: string | null): SQL =>
  sql`(c.owner_user_uuid = ${userParam(user)} OR EXISTS (
    SELECT 1 FROM catalog_grants cg
    WHERE cg.catalog_uuid = c.uuid AND cg.user_uuid = ${userParam(user)}
  ))`;

/**
 * A skill `s` chega a `user` por concessão — direta, ou por estar num vMCP
 * ou catálogo que a conta possui ou lhe foi concedido. Pelo vMCP vale o
 * mesmo caminho da chave `psv_` (`exposedIn`: direto ou por catálogo ligado
 * com participação ativa); pelo catálogo vale toda participação, ativa ou
 * não, porque quem vê o catálogo vê a lista inteira de membros.
 */
const skillSharedWith = (user: string | null): SQL =>
  sql`(${skillGrantOf(user)} IS NOT NULL
    OR EXISTS (SELECT 1 FROM virtual_mcps m WHERE ${mcpSeenBy(user)} AND ${exposedIn(sql`m.uuid`)})
    OR EXISTS (
      SELECT 1 FROM catalog_skills cs JOIN catalogs c ON c.uuid = cs.catalog_uuid
      WHERE cs.skill_uuid = s.uuid AND ${catalogSeenBy(user)}
    ))`;

/**
 * O que uma conta que não é admin enxerga (`docs/12-acesso-granular.md`
 * §3.1): o público, o que é dela e o que lhe chega por concessão. Sem
 * `s.is_active`, como `'all'`: o painel mostra a skill desligada a quem a vê.
 */
const skillVisibleTo = (user: string | null): SQL =>
  sql`(${PUBLIC_REACH} OR s.owner_user_uuid = ${userParam(user)} OR ${skillSharedWith(user)})`;

/**
 * O `access` de cada linha (`SkillSummary.access`): `'owner'` para o admin e
 * para o dono, o nível da concessão direta, `'view'` para quem chega por
 * público ou contêiner, e nulo numa leitura sem conta (o site).
 */
function accessColumn(mode: ReadMode, owner: SQL, grantOf: (user: string | null) => SQL): SQL {
  if (mode.kind === 'all') return sql`'owner'::text`;
  if (mode.kind === 'open') return sql`NULL::text`;
  return sql`CASE WHEN ${owner} = ${userParam(mode.user)} THEN 'owner'
    ELSE COALESCE(${grantOf(mode.user)}, 'view') END`;
}

/** O filtro `scope` das skills, relativo à conta. */
function skillScopeClause(scope: AccessScope, user: string | null): SQL {
  switch (scope) {
    case 'mine':
      return sql`s.owner_user_uuid = ${userParam(user)}`;
    case 'shared':
      return sql`(s.owner_user_uuid IS DISTINCT FROM ${userParam(user)} AND ${skillSharedWith(user)})`;
    default:
      return PUBLIC_REACH;
  }
}

/**
 * A cláusula de visibilidade que `listSkills`, `getSkillSummary` e `listTags`
 * compartilham. Com `virtualMcp`, é a exposição naquele servidor e **só**
 * nele, na superfície pedida, com a skill ligada; sem, é o modo da leitura:
 * `'all'` (tudo, inclusive desligadas), `'open'` (a regra do site) ou o que
 * a conta do `viewer` enxerga.
 */
function visibilityClause({ visibility, viewer, virtualMcp }: ReadOptions): SQL {
  if (virtualMcp) {
    // UUID torto é "nenhuma skill", não erro do driver virando HTTP 500.
    if (!isUuid(virtualMcp.uuid)) return sql`false`;
    return sql`(s.is_active AND ${exposedIn(sql`${virtualMcp.uuid}::uuid`, virtualMcp.surface)})`;
  }
  const mode = readMode({ visibility, viewer });
  if (mode.kind === 'all') return sql`true`;
  if (mode.kind === 'open') return OPEN_EXPOSURE;
  return skillVisibleTo(mode.user);
}

/**
 * A coluna de porta do vínculo (`v`, skill ↔ vMCP) ou do vínculo de catálogo
 * (`vc`, catálogo ↔ vMCP) que corresponde à superfície — nunca texto do
 * chamador: `surface` é um dos três valores fechados, e o alias é nosso.
 */
function surfaceFlag(alias: 'v' | 'vc', surface: VirtualSurface): SQL {
  switch (surface) {
    case 'prompt':
      return sql.raw(`${alias}.as_prompt`);
    case 'resource':
      return sql.raw(`${alias}.as_resource`);
    default:
      return sql.raw(`${alias}.as_skill`);
  }
}

/**
 * As colunas de `SkillSummary`. Além dos metadados, cada linha traz dois JSON:
 *
 * `mcps` — em quais vMCPs a skill está. É a união de dois caminhos, um item
 * por servidor: os vínculos **diretos** (`direct: true`, as portas do
 * vínculo) e os servidores alcançados **só por catálogo** (`direct: false`,
 * as portas são a união dos catálogos ligados, com participação ativa,
 * vinculados a ele, e `catalogs` diz quais). Um servidor com vínculo direto
 * não aparece pelo caminho do catálogo: o direto sobrescreve
 * (`docs/11-catalogos.md` §3.2). Numa leitura `'all'` vêm todos; com
 * `viewer`, só os que a conta vê (aberto e ligado, dela ou concedido a ela);
 * nas demais só os com vMCP aberto e ligado — o site não pode revelar em
 * qual servidor fechado uma skill está, e é por essa lista que o mcp-public
 * sabe se a skill tem página no site. `skills.is_active` não filtra aqui: a
 * lista diz onde a skill *estaria*, e `isActive` diz se ela sai.
 *
 * `catalogs` — os catálogos de que a skill participa, com o estado do
 * catálogo e o da participação. Na leitura `'all'` todos; com `viewer`, os
 * que a conta vê (público e ligado, dela ou concedido a ela); no site,
 * nenhum — é o painel "Nos catálogos" da página da skill.
 *
 * E, desde o `017`, o dono (`owner_user_uuid`, `owner_email`), o flag
 * `is_public` e o `access` da conta que lê (`accessColumn`).
 *
 * **O dono não sai na visibilidade do site.** Em `'open'` as duas colunas vêm
 * nulas, como o `access` e o `catalogs` já vinham: o e-mail do dono é dado
 * pessoal que o `docs/12` §10 aceita expor a **conta logada**, não ao
 * visitante anônimo (`tasks/002`), e o app do site já corta os dois campos da
 * resposta. Aqui é o outro lado da mesma decisão — e o efeito é parar de pagar
 * uma subconsulta de e-mail **por linha** cujo resultado ninguém lê.
 */
function skillColumns(options: ReadOptions): SQL {
  const mode = readMode(options);
  const everyLink = mode.kind === 'all';
  // O vMCP `x` (do UNION abaixo) entra na lista `mcps` da skill.
  const mcpFilter = everyLink
    ? sql`true`
    : mode.kind === 'viewer'
      ? sql`((x.is_open AND x.is_active) OR x.owner_user_uuid = ${userParam(mode.user)} OR EXISTS (
          SELECT 1 FROM virtual_mcp_grants vg
          WHERE vg.virtual_mcp_uuid = x.uuid AND vg.user_uuid = ${userParam(mode.user)}
        ))`
      : sql`(x.is_open AND x.is_active)`;
  // O catálogo `c` entra na lista `catalogs`; nulo é "lista vazia" (o site).
  const catalogFilter = everyLink
    ? sql`true`
    : mode.kind === 'viewer'
      ? sql`((c.is_public AND c.is_active) OR ${catalogSeenBy(mode.user)})`
      : null;
  // Qual catálogo do caminho tem o **nome revelado** dentro de `mcps`. O
  // vínculo continua contando para a exposição (a skill *está* naquele vMCP,
  // por um catálogo privado ou não) — o que muda é só o que a lista nomeia: no
  // site, catálogo privado não é nomeado (`tasks/002`). Sem isto, a resposta
  // anônima dizia por qual catálogo fechado a skill chegava a um vMCP aberto.
  const catalogNameFilter = mode.kind === 'open' ? sql`c.is_public` : sql`true`;
  // No site o dono não sai (`tasks/002`): as duas colunas viram nulo literal e
  // a subconsulta do e-mail deixa de rodar por linha.
  const ownerColumns =
    mode.kind === 'open'
      ? sql`NULL::uuid AS owner_user_uuid, NULL::text AS owner_email`
      : sql`s.owner_user_uuid,
  (SELECT u.email FROM users u WHERE u.uuid = s.owner_user_uuid) AS owner_email`;
  return sql`
  s.uuid, s.slug, s.name, s.description, s.icon, s.is_active, s.is_public,
  ${ownerColumns},
  ${accessColumn(mode, sql`s.owner_user_uuid`, skillGrantOf)} AS access,
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
      'uuid', x.uuid, 'slug', x.slug, 'name', x.name,
      'isOpen', x.is_open, 'isActive', x.is_active,
      'isDefault', (x.uuid::text = (SELECT st.value FROM settings st WHERE st.key = ${DEFAULT_MCP_SETTING})),
      'asSkill', x.as_skill, 'asPrompt', x.as_prompt, 'asResource', x.as_resource,
      'direct', x.direct, 'catalogs', x.catalogs
    ) ORDER BY x.name, x.slug)
    FROM (
      SELECT m.uuid, m.slug, m.name, m.is_open, m.is_active, m.owner_user_uuid,
             v.as_skill, v.as_prompt, v.as_resource,
             true AS direct, '[]'::json AS catalogs
      FROM virtual_mcp_skills v JOIN virtual_mcps m ON m.uuid = v.virtual_mcp_uuid
      WHERE v.skill_uuid = s.uuid
      UNION ALL
      SELECT m.uuid, m.slug, m.name, m.is_open, m.is_active, m.owner_user_uuid,
             bool_or(vc.as_skill), bool_or(vc.as_prompt), bool_or(vc.as_resource),
             false,
             COALESCE(json_agg(json_build_object('uuid', c.uuid, 'slug', c.slug, 'name', c.name)
                      ORDER BY c.name, c.slug) FILTER (WHERE ${catalogNameFilter}), '[]'::json)
      FROM catalog_skills cs
      JOIN catalogs c ON c.uuid = cs.catalog_uuid AND c.is_active
      JOIN virtual_mcp_catalogs vc ON vc.catalog_uuid = c.uuid
      JOIN virtual_mcps m ON m.uuid = vc.virtual_mcp_uuid
      WHERE cs.skill_uuid = s.uuid AND cs.is_active
        AND NOT EXISTS (
          SELECT 1 FROM virtual_mcp_skills v
          WHERE v.skill_uuid = s.uuid AND v.virtual_mcp_uuid = m.uuid
        )
      GROUP BY m.uuid, m.slug, m.name, m.is_open, m.is_active, m.owner_user_uuid
    ) x
    WHERE ${mcpFilter}
  ), '[]'::json) AS mcps,
  ${
    catalogFilter
      ? sql`COALESCE((
          SELECT json_agg(json_build_object(
            'uuid', c.uuid, 'slug', c.slug, 'name', c.name,
            'isActive', c.is_active, 'memberActive', cs.is_active
          ) ORDER BY c.name, c.slug)
          FROM catalog_skills cs JOIN catalogs c ON c.uuid = cs.catalog_uuid
          WHERE cs.skill_uuid = s.uuid AND ${catalogFilter}
        ), '[]'::json)`
      : sql`'[]'::json`
  } AS catalogs
`;
}

/** O texto de `access` vindo do SQL, fechado nos valores de `EffectiveAccess`. */
function toAccess(value: unknown): EffectiveAccess {
  return value === 'owner' || isAccessLevel(value) ? value : null;
}

/** O JSON de `mcps`, com o `isDefault` nulo (sem padrão) normalizado. */
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
    direct: Boolean(m.direct),
    catalogs: ((m.catalogs ?? []) as Row[]).map((c) => ({
      uuid: c.uuid,
      slug: c.slug,
      name: c.name,
    })),
  }));
}

/** O JSON de `catalogs` da skill: o catálogo e a participação dela nele. */
function toSkillCatalogRefs(value: unknown): SkillCatalogRef[] {
  const rows = (typeof value === 'string' ? JSON.parse(value) : value) as Row[] | null;
  return (rows ?? []).map((c) => ({
    uuid: c.uuid,
    slug: c.slug,
    name: c.name,
    isActive: Boolean(c.isActive),
    memberActive: Boolean(c.memberActive),
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
    isActive: Boolean(row.is_active),
    isPublic: Boolean(row.is_public),
    ownerUserUuid: row.owner_user_uuid ?? null,
    ownerEmail: row.owner_email ?? null,
    access: toAccess(row.access),
    mcps: toSkillMcpRefs(row.mcps),
    catalogs: toSkillCatalogRefs(row.catalogs),
    viewCount,
    downloadCount,
    score: skillScore(viewCount, downloadCount),
    tags: (row.tags ?? []) as string[],
    fileCount: Number(row.file_count ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Busca paginada de skills, com full-text + fallback por substring e, quando
 * o chamador passa `semantic`, a perna vetorial fundida por *Reciprocal Rank
 * Fusion* (§8.2) — ver `hybridSkills`.
 */
export async function listSkills(options: ListOptions = {}): Promise<SkillSearchResult> {
  const limit = clamp(options.limit ?? 24, 1, 100);
  // `pageOffset`, como nas quatro irmãs (`listAuditPage`, `listMcpSessions`,
  // `listSkillAccesses`): `Math.max(0, NaN)` é `NaN`, e um `OFFSET NaN` estoura
  // no driver em vez de virar a primeira página (`tasks/046`).
  const offset = pageOffset(options.offset);
  const query = normalizeQuery(options.query);
  const tag = options.tag?.trim() || null;
  const sort = options.sort ?? (query ? 'relevance' : 'score');

  const rank = query
    ? sql`ts_rank(s.search_vector, websearch_to_tsquery('simple', ${query}))`
    : sql`0::float4`;

  // Toda alternativa termina em `s.uuid`, a chave primária (`tasks/036`). `name`
  // não é único, e `updated_at` e os contadores empatam **em lote** — `now()` é o
  // mesmo na transação inteira (seed, importação) e um acervo novo tem tudo em
  // zero. Sem chave única a ordem entre empatados é indefinida, e cada página é
  // uma execução à parte (o top-N de `LIMIT` nem é estável): medido em 60
  // páginas de 12 sobre skills empatadas, só 481 de 720 linhas eram distintas em
  // `score`, 334 em `recent` e 371 em `name` — o resto repetia, e outras tantas
  // nunca apareciam. É o que as listagens irmãs já fazem (`s.name, s.slug`,
  // `created_at DESC, id DESC`). `uuid`, e não `slug`: 16 bytes comparados por
  // `memcmp`, contra um texto na coleção do banco. Vale para a busca híbrida,
  // que reusa este `order`.
  const order =
    sort === 'recent'
      ? sql`s.updated_at DESC, s.uuid`
      : sort === 'name'
        ? sql`s.name ASC, s.uuid`
        : sort === 'relevance' && query
          ? sql`rank DESC, (s.view_count + s.download_count) DESC, s.updated_at DESC, s.uuid`
          : sql`(s.view_count + s.download_count) DESC, s.updated_at DESC, s.uuid`;

  const scope = readScope(options);

  // O recorte de quem pode ver o quê, mais o filtro de tag: vale para a
  // consulta de sempre **e** para as duas pernas da híbrida.
  const recorte = sql`${visibilityClause(options)}
      ${scope ? sql`AND ${skillScopeClause(scope, scopeUser(options))}` : sql``}
      ${
        tag
          ? sql`AND EXISTS (
              SELECT 1 FROM skill_tags st JOIN tags t ON t.id = st.tag_id
              WHERE st.skill_uuid = s.uuid AND lower(t.name) = lower(${tag})
            )`
          : sql``
      }`;

  // A perna textual: o que a busca de hoje casa. O termo vai literal ao
  // `ILIKE` (`likePattern`) e cru ao `tsquery`, que não tem curinga de `LIKE`.
  const textual = query
    ? sql`AND (
        s.search_vector @@ websearch_to_tsquery('simple', ${query})
        OR s.name ILIKE ${likePattern(query)}
        OR s.description ILIKE ${likePattern(query)}
        OR s.slug ILIKE ${likePattern(query)}
      )`
    : sql``;

  const semantic = options.semantic ? semanticScope(options.semantic) : null;
  if (semantic && query) {
    return hybridSkills({ options, recorte, order, query, semantic, limit, offset });
  }

  // Filtro compartilhado entre a contagem e a página de resultados.
  const where = sql`WHERE ${recorte} ${textual}`;

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
    mode: 'text',
    neighbors: [],
  };
}

/** A perna vetorial validada: uuid do espaço, o vetor em texto e o teto de vizinhos. */
type SemanticLeg = { spaceUuid: string; vector: string; neighbors: number };

function semanticScope(scope: SemanticScope): SemanticLeg {
  if (!isUuid(scope?.spaceUuid)) {
    throw badRequest(`Uuid de espaço inválido: ${String(scope?.spaceUuid)}`);
  }
  return {
    spaceUuid: scope.spaceUuid,
    vector: ragVectorLiteral(scope?.vector, 'semantic.vector'),
    neighbors: clamp(scope?.neighbors ?? SEMANTIC_NEIGHBORS, 1, 100),
  };
}

/**
 * A busca híbrida (§8.2): a perna textual de sempre — **inteira**, sem teto —
 * e a perna vetorial com os `neighbors` vizinhos mais próximos, fundidas por
 * RRF (`1/(k + posição)`, `k = 60`) num `FULL OUTER JOIN`.
 *
 * Os três pontos que fazem a diferença entre isto e uma busca vetorial solta:
 *
 *   - **o recorte vale nas duas pernas.** Uma skill de um vMCP fechado não
 *     pode vazar pela perna vetorial na busca de outro servidor nem no site;
 *   - **o `total` é o tamanho do conjunto fundido**, e não o da perna
 *     textual: senão a paginação mentiria assim que um vizinho entrasse sem
 *     casar no texto;
 *   - **a perna textual entra inteira.** Ela é o conjunto de resultados, e o
 *     teto de 100 que havia nela travava o conjunto fundido — e com ele o
 *     `total` e a paginação — em 100 + `neighbors`: ligar o RAG encolhia a
 *     busca. Quem põe a cauda no lugar dela é o próprio RRF: `1/(60 + pos)`
 *     decresce com a posição. Mas `pos` é único **por perna**, não na fusão: um
 *     resultado só-texto na posição N e um só-vetor na posição N recebem o
 *     mesmo `1/(60 + N)`, e `rrf` empata. Quem fecha a ordem total — e com ela
 *     a garantia de a paginação funda não repetir nem pular linha — é o
 *     `s.uuid` no fim do `order` de `listSkills` (`tasks/036`).
 *
 * A distância nunca corta nada na v1: os `neighbors` vizinhos vêm mesmo pouco
 * relacionados, e o que decide a ordem é a fusão. A perna vetorial é uma
 * busca **exata** (sem índice): `gemini-embedding-2` tem 3072 dimensões e o
 * HNSW do pgvector para em 2000.
 *
 * Justamente por ser uma varredura, a página e o `total` saem de **uma**
 * consulta: `fusao` é materializada e as duas pernas rodam uma vez só. A
 * contagem à parte sobrou para a página vazia — ver o comentário abaixo.
 */
async function hybridSkills(input: {
  options: ListOptions;
  recorte: SQL;
  order: SQL;
  query: string;
  semantic: SemanticLeg;
  limit: number;
  offset: number;
}): Promise<SkillSearchResult> {
  const { options, recorte, order, query, semantic, limit, offset } = input;
  const like = likePattern(query);
  // `k` do RRF é constante nossa, não texto de fora.
  const k = sql.raw(String(RRF_K));

  const cte = sql`
    consulta AS (
      SELECT websearch_to_tsquery('simple', ${query}) AS tsq, ${semantic.vector}::vector AS qv
    ),
    texto AS (
      SELECT s.uuid,
             row_number() OVER (ORDER BY ts_rank(s.search_vector, c.tsq) DESC,
                                         (s.view_count + s.download_count) DESC, s.uuid) AS pos
        FROM skills s, consulta c
       WHERE ${recorte}
         AND (s.search_vector @@ c.tsq
              OR s.name ILIKE ${like} OR s.description ILIKE ${like} OR s.slug ILIKE ${like})
    ),
    semantica AS (
      SELECT o.skill_uuid AS uuid, min(v.embedding <=> c.qv) AS dist
        FROM rag_skill_texts o
        JOIN rag_vectors v ON v.space_uuid = ${semantic.spaceUuid}::uuid
                          AND v.text_sha256 = o.text_sha256
        JOIN skills s ON s.uuid = o.skill_uuid
       CROSS JOIN consulta c
       WHERE ${recorte}
       GROUP BY o.skill_uuid
       ORDER BY dist, o.skill_uuid
       LIMIT ${semantic.neighbors}
    ),
    semantica_pos AS (
      SELECT uuid, dist, row_number() OVER (ORDER BY dist, uuid) AS pos FROM semantica
    ),
    fusao AS MATERIALIZED (
      SELECT COALESCE(t.uuid, v.uuid) AS uuid,
             COALESCE(1.0 / (${k} + t.pos), 0) + COALESCE(1.0 / (${k} + v.pos), 0) AS rrf,
             v.dist
        FROM texto t FULL OUTER JOIN semantica_pos v ON v.uuid = t.uuid
    )`;

  // A contagem sai da **mesma** consulta da página, ao contrário da busca de
  // sempre: `fusao` é `MATERIALIZED` e citada duas vezes (na contagem e na
  // página), então as duas pernas rodam uma vez só. Em duas consultas, a perna
  // vetorial — varredura exata, sem índice (`020-rag.sql`) — era paga duas
  // vezes por busca: medido num banco de teste com 12 mil vetores de 3072
  // dimensões, a contagem sozinha custava ~99 ms (~96 ms na varredura) e
  // repetia os mesmos 104 mil buffers da página. A mediana da busca caiu de
  // 152 ms para 63 ms (e de 1093 ms para 128 ms com o `jit` padrão, que agora
  // compila uma vez só e num nível mais baixo).
  //
  // Na busca textual isso não daria: lá a contagem e a página são consultas
  // independentes, e `count(*) OVER ()` zeraria o total ao paginar além do fim.
  // Aqui `fusao` é materializada de qualquer jeito — ela tem uma linha por
  // skill do conjunto de resultados (uuid, `rrf`, `dist`, e nada mais), então
  // guardá-la sai muito mais barato do que varrer os vetores de novo. É o que
  // torna o `total` **exato** de graça: no mesmo banco de teste, com 400 skills
  // casando o termo, a busca ficou em 74 ms contra 78 ms da versão que cortava
  // a perna textual em 100 (o `total` mentia: 120); no pior caso medido —
  // 50 mil das 52 mil skills casando — são 145 ms contra 104 ms, e é a
  // diferença entre anunciar 50 020 resultados alcançáveis e anunciar 120.
  const result = await db().execute(sql`
    WITH ${cte},
    contagem AS (SELECT count(*)::int AS total FROM fusao)
    SELECT ${skillColumns(options)}, f.rrf AS rank, f.dist AS distance,
           (SELECT total FROM contagem) AS total
    FROM fusao f
    JOIN skills s ON s.uuid = f.uuid
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}
  `);

  const rows = result.rows as Row[];
  // Página sem linha nenhuma (offset além do fim) não traz o total embarcado —
  // e `total` não pode virar 0, senão a paginação mentiria. Só nesse caso, que
  // é a exceção, a contagem vira uma consulta à parte: é mais barato pagar a
  // segunda varredura na página vazia do que em toda busca.
  const total =
    rows.length > 0
      ? Number(rows[0]!.total ?? 0)
      : Number(
          (
            (await db().execute(sql`WITH ${cte} SELECT count(*)::int AS total FROM fusao`))
              .rows as Row[]
          )[0]?.total ?? 0,
        );

  return {
    items: rows.map(toSummary),
    total,
    limit,
    offset,
    mode: 'hybrid',
    neighbors: rows
      .filter((row) => row.distance !== null && row.distance !== undefined)
      .map((row) => ({ slug: row.slug as string, distance: Number(row.distance) })),
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
 * As skills ligadas e expostas num vMCP na superfície pedida (`as_prompt` /
 * `as_resource`), para `prompts/list` e `resources/list` — pela mesma
 * precedência das outras leituras (`exposedIn`): o vínculo direto sobrescreve,
 * sem ele vale a união dos catálogos.
 *
 * Não reusa `listSkills` por dois motivos: aquela limita o resultado a 100, o
 * que esconderia skills em silêncio numa listagem que o protocolo entrega
 * inteira, sem cursor nem teto; e carrega por linha agregações que as duas
 * listagens descartam. Como não há teto, a linha precisa ser barata — daí só
 * três colunas. A ordem por slug é estável entre chamadas: a lista é
 * recomputada a cada requisição, e uma lista embaralhada seria ruído.
 */
export async function listPublishedSkills(
  surface: PublicationSurface,
  virtualMcpUuid: string,
): Promise<PublishedSkill[]> {
  if (!isUuid(virtualMcpUuid)) return [];

  const result = await db().execute(sql`
    SELECT s.slug, s.name, s.description
    FROM skills s
    WHERE s.is_active AND ${exposedIn(sql`${virtualMcpUuid}::uuid`, surface)}
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

/**
 * Skill completa: metadados + SKILL.md + lista de arquivos anexados.
 *
 * `grants` vem **vazio** na visibilidade do site (`'open'`, o que inclui o
 * recorte por vMCP do mcp-public): quem lê sem conta não recebe a lista de
 * quem tem acesso, e a consulta de concessões — uma por página da skill —
 * deixa de rodar para ser descartada pelo app (`tasks/002`). Com `'all'` ou
 * `viewer` ela continua vindo inteira; quem decide a quem repassar é o app
 * (só `manage`, dono e admin).
 */
export async function getSkillDetail(
  slug: string,
  options: ReadOptions = {},
): Promise<SkillDetail | null> {
  const summary = await getSkillSummary(slug, options);
  if (!summary) return null;

  const files = await listFiles(summary.uuid);
  const skillMd = await readTextFile(summary.uuid, SKILL_MD);
  const grants =
    readMode(options).kind === 'open' ? [] : await listSkillGrants(summary.uuid);

  return { ...summary, skillMd: skillMd ?? '', files, grants };
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
  return readFileFrom(db(), skillUuid, relativePath);
}

/**
 * `readFile` sobre a conexão de quem chama: o pool, numa leitura avulsa, ou a
 * transação de uma escrita. Quem grava lê o conteúdo anterior **com a fila das
 * escritas na mão** (`lockSkillFilesTx`) — e pela própria transação, nunca por
 * `db()`: pedir uma segunda conexão ao pool segurando a primeira é o jeito de
 * travar o processo quando a fila enche o pool.
 */
async function readFileFrom(
  executor: Pick<Tx, 'execute'>,
  skillUuid: string,
  relativePath: string,
): Promise<FileContent | null> {
  const result = await executor.execute(sql`
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
 * Com `virtualMcpUuid`, soma **no global da skill e no caminho** por onde ela
 * chegou ao servidor (`docs/11-catalogos.md` §3.3): havendo vínculo direto,
 * no vínculo (o contador "por este MCP"); sem ele, em **cada** catálogo que
 * contribuiu — ligado, com a participação ativa e vinculado ao vMCP. Um
 * acesso pelo vínculo direto não soma no catálogo mesmo que a skill esteja
 * nele: o catálogo não foi o caminho.
 *
 * UPDATEs sem transação: são contadores best-effort, e perder um incremento
 * numa falha no meio é preferível a segurar a leitura por um lock a mais.
 *
 * Desde o `018`, quem serve uma skill grava a leitura com
 * `recordSkillAccess`, que soma estes mesmos contadores no mesmo caminho e
 * ainda deixa a linha da guia "Acessos". As duas funções abaixo ficam para
 * quem só quer o número, e nenhum app as chama mais. **Uma diferença:** elas
 * não recebem a superfície lida, então somam em todo catálogo vinculado ao
 * vMCP, com qualquer porta; `recordSkillAccess` sabe a superfície e só conta
 * o catálogo que serve aquela porta (`tasks/041`).
 */
export async function incrementViewCount(skillUuid: string, virtualMcpUuid?: string): Promise<void> {
  await bumpCounter('view_count', skillUuid, virtualMcpUuid);
}

export async function incrementDownloadCount(
  skillUuid: string,
  virtualMcpUuid?: string,
): Promise<void> {
  await bumpCounter('download_count', skillUuid, virtualMcpUuid);
}

/** O nome da coluna é um dos dois literais nossos — nunca texto do chamador. */
async function bumpCounter(
  counter: 'view_count' | 'download_count',
  skillUuid: string,
  virtualMcpUuid: string | undefined,
): Promise<void> {
  const column = sql.raw(counter);
  await db().execute(sql`UPDATE skills SET ${column} = ${column} + 1 WHERE uuid = ${skillUuid}`);
  if (virtualMcpUuid === undefined || !isUuid(virtualMcpUuid)) return;

  // O `RETURNING` diz se havia vínculo direto: com ele, o caminho foi o
  // vínculo e os catálogos não entram; sem ele, o caminho foram os catálogos.
  const direct = await db().execute(sql`
    UPDATE virtual_mcp_skills SET ${column} = ${column} + 1
    WHERE virtual_mcp_uuid = ${virtualMcpUuid} AND skill_uuid = ${skillUuid}
    RETURNING skill_uuid
  `);
  if ((direct.rows as Row[]).length > 0) return;

  await db().execute(sql`
    UPDATE catalogs SET ${column} = ${column} + 1
    WHERE uuid IN (
      SELECT c.uuid FROM catalogs c
      JOIN catalog_skills cs ON cs.catalog_uuid = c.uuid
      JOIN virtual_mcp_catalogs vc ON vc.catalog_uuid = c.uuid
      WHERE cs.skill_uuid = ${skillUuid}
        AND vc.virtual_mcp_uuid = ${virtualMcpUuid}
        AND c.is_active AND cs.is_active
    )
  `);
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
 * U+0000. Montado por código, e não escrito como escape, de propósito: uma
 * ferramenta que "resolva" o escape deixa um byte nulo literal no fonte, e o
 * arquivo passa a ser binário para o `git` e para o `grep`.
 */
const NUL = String.fromCharCode(0);

/**
 * Texto vindo de JSON que ninguém validou.
 *
 * O MCP valida a entrada com zod antes de chegar aqui, mas a rota REST do
 * painel entrega o corpo cru: `{"slug": 123}` fazia `(123).trim()` estourar
 * `TypeError` e virar HTTP 500, quando tipo errado é erro do cliente (400).
 * `null` é tratado como ausente — cada chamador decide o que fazer com isso,
 * como já fazia com `undefined`.
 *
 * O caractere nulo também é 400: `text` e `varchar` não o guardam, e o
 * Postgres recusa o **parâmetro** com 22021 antes de olhar a consulta — nome,
 * descrição, slug ou `q` com ele terminavam em 500, com o SQL inteiro no log
 * (`tasks/038`). Nada que gravava passa a ser recusado: com o nulo, nenhuma
 * dessas escritas jamais chegou ao fim. Os rótulos de sessão **não** passam
 * por aqui — `sessionLabel` limpa em vez de recusar.
 */
function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`O campo "${field}" deve ser uma string`);
  if (value.includes(NUL)) throw badRequest(`O campo "${field}" não pode conter o caractere nulo`);
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
  /**
   * Ligada (padrão). Desligada, a skill existe no painel e em lugar nenhum
   * mais, mesmo com vínculos (`docs/11-catalogos.md` §3.1).
   */
  isActive?: boolean;
  /**
   * Legível por qualquer conta e pelo site (`docs/12` decisão 4); padrão
   * `false`. Não publica em MCP nenhum — isso é `mcps`.
   */
  isPublic?: boolean;
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
  /** Omitido: gerado a partir de `name`. Informado: precisa passar em `isValidSlug`. */
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
  const isActive = optionalBoolean(input.isActive, 'isActive') ?? true;
  const isPublic = optionalBoolean(input.isPublic, 'isPublic') ?? false;
  // Em ordem fixa (a do uuid), e não na que o cliente mandou: cada `linkTx` trava
  // o vMCP até o COMMIT, e duas criações publicando nos mesmos servidores em
  // ordens opostas travavam em cruz — medido, 149 de 150 pares perdiam uma das
  // duas por deadlock (40P01 → 500). É a lição das tags (`replaceTagsTx`): a
  // ordem só precisa ser a **mesma** em todo chamador. O que muda para quem lê é
  // a ordem das linhas `mcp.update` na auditoria.
  const links = [...(await resolveLinks(input.mcps ?? []))].sort((a, b) =>
    a.virtualMcpUuid.toLowerCase() < b.virtualMcpUuid.toLowerCase() ? -1 : 1,
  );

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
        // Quem cria vira dono (`docs/12` decisão 8); sem conta (bootstrap,
        // token global, seed) a skill nasce órfã, só do admin.
        const inserted = await tx.execute(sql`
          INSERT INTO skills
            (slug, name, description, icon, is_active, is_public,
             created_by_user_uuid, owner_user_uuid)
          VALUES (${slug}, ${name}, ${description}, ${icon}, ${isActive}, ${isPublic},
                  ${actor?.userUuid ?? null}, ${actor?.userUuid ?? null})
          RETURNING uuid
        `);
        const uuid = (inserted.rows as Row[])[0].uuid as string;

        // O SKILL.md e os anexos numa statement só (fatiada por tamanho):
        // importar um `.zip` grande era uma ida ao banco por arquivo
        // (`tasks/049`). Nenhum anexo é `SKILL.md` — o filtro acima os tirou.
        await upsertFilesTx(tx, uuid, [
          { path: SKILL_MD, buffer: Buffer.from(input.skillMd, 'utf8') },
          ...attachments,
        ]);
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
  /** `undefined` não mexe. Desligar some de todo vMCP e do site sem perder vínculo. */
  isActive?: boolean;
  /** `undefined` não mexe. Ligar torna a skill legível por qualquer conta e pelo site. */
  isPublic?: boolean;
  /**
   * Transferência (`docs/12` decisão 9): `undefined` não mexe; um uuid
   * precisa ser de conta existente e ativa (400 senão), e a concessão que
   * essa conta tinha na skill é apagada — o dono é implícito; `null` deixa a
   * skill órfã (só o admin). A checagem de que o chamador é dono ou admin é
   * do app. Audita `update` com o e-mail do novo dono em `target_label`.
   */
  ownerUserUuid?: string | null;
  tags?: string[];
  /** Renomeia. Precisa passar em `isValidSlug`; em uso por outra skill é 409. */
  slug?: string;
};

export async function updateSkill(
  slug: string,
  input: UpdateSkillInput,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillDetail> {
  const existing = await requireSkill(slug);
  const plan = await planSkillUpdate(input, existing);
  let savedSlug = existing.slug;

  try {
    await db().transaction(async (tx) => {
      // A transferência valida o novo dono e apaga a concessão dele antes
      // do UPDATE; o e-mail vai para o label da auditoria.
      const newOwnerEmail = plan.transfer
        ? await transferOwnerTx(tx, GRANTS.skill, existing.uuid, input.ownerUserUuid ?? null)
        : undefined;
      savedSlug = await updateSkillRowTx(tx, existing, plan);

      if (plan.tags !== undefined) {
        await replaceTagsTx(tx, existing.uuid, plan.tags);
      }

      await auditTx(tx, {
        skillUuid: existing.uuid,
        skillSlug: savedSlug,
        filePath: null,
        action: 'update',
        source,
        actor,
        previousContent: null,
        targetLabel: newOwnerEmail ?? null,
      });
    });
  } catch (err) {
    // Outra escrita concorrente pode ter levado o slug entre a checagem e o
    // UPDATE: isso é conflito (409), não falha interna.
    if (isUniqueViolation(err)) throw conflict(`Já existe uma skill com o slug "${plan.newSlug}"`);
    throw err;
  }

  const detail = await getSkillDetail(savedSlug, { visibility: 'all' });
  if (!detail) throw new Error('Skill atualizada mas não encontrada');
  return detail;
}

/** O que `planSkillUpdate` decidiu para o UPDATE de uma skill. */
type SkillUpdatePlan = {
  /** Só as colunas informadas, mais `updated_at` — nunca vazio. */
  sets: SQL[];
  /** `ownerUserUuid` veio (uuid ou `null`): há transferência a validar na transação. */
  transfer: boolean;
  /** As tags a regravar; `undefined` é "não mexe". */
  tags: readonly string[] | undefined;
  /** O slug pedido, já resolvido — é o que vai na mensagem do 409. */
  newSlug: string;
};

/**
 * Os `SET` de `updateSkill` / `updateSkillWithContent`: **só** as colunas que o
 * chamador informou, no padrão de `updateUser` / `updateVirtualMcp` /
 * `updateCatalog`.
 *
 * Regravar o valor lido **antes** da transação (`requireSkill`) desfazia a
 * escrita de quem salvou no meio: dois salvamentos na mesma skill, cada um com
 * a sua foto, e o segundo devolvia `is_public` — ou o nome, a descrição, o
 * ícone, o estado, o slug — ao que era, sem erro para ninguém e com as duas
 * linhas de auditoria dizendo que deu certo. O raciocínio já valia para o dono
 * (por causa de `adoptOrphans`); agora vale para todas as colunas, e campo
 * ausente não chega ao banco: duas escritas de campos diferentes convivem.
 *
 * Sem trava nova, de propósito: um `FOR UPDATE` na skill entra em deadlock com
 * o trigger `files_rag_stale_trg` (`020`) de quem grava arquivo — é a mesma
 * razão pela qual `createFile` trava a skill em `FOR KEY SHARE`.
 *
 * `updated_at = now()` entra sempre: um salvamento que não mudou coluna
 * nenhuma continua sendo um salvamento, e é ele que ordena os "recentes".
 */
async function planSkillUpdate(
  input: UpdateSkillInput,
  existing: SkillSummary,
): Promise<SkillUpdatePlan> {
  const sets: SQL[] = [];

  if (input.name !== undefined) {
    const name = optionalText(input.name, 'name')?.trim();
    if (!name) throw badRequest('O campo "name" não pode ficar vazio');
    sets.push(sql`name = ${name}`);
  }
  if (input.description !== undefined) {
    sets.push(sql`description = ${optionalText(input.description, 'description')?.trim() ?? ''}`);
  }
  const tags = input.tags !== undefined ? (optionalTextList(input.tags, 'tags') ?? []) : undefined;
  const icon = optionalIcon(input.icon);
  if (icon !== undefined) sets.push(sql`icon = ${icon}`);
  const isActive = optionalBoolean(input.isActive, 'isActive');
  if (isActive !== undefined) sets.push(sql`is_active = ${isActive}`);
  const isPublic = optionalBoolean(input.isPublic, 'isPublic');
  if (isPublic !== undefined) sets.push(sql`is_public = ${isPublic}`);
  // O novo dono é validado dentro da transação (`transferOwnerTx`), antes
  // deste SET chegar ao banco.
  const transfer = input.ownerUserUuid !== undefined;
  if (transfer) sets.push(sql`owner_user_uuid = ${input.ownerUserUuid ?? null}`);

  // Slug vazio continua significando "mantém o atual", como antes de haver
  // checagem de tipo — só a troca por um slug diferente vai ao `resolveSlug`.
  const requestedSlug = optionalText(input.slug, 'slug')?.trim();
  const newSlug =
    requestedSlug && requestedSlug !== existing.slug
      ? await resolveSlug(requestedSlug, requestedSlug)
      : existing.slug;
  if (newSlug !== existing.slug) sets.push(sql`slug = ${newSlug}`);

  sets.push(sql`updated_at = now()`);

  return { sets, transfer, tags, newSlug };
}

/**
 * O UPDATE das duas. Devolve o slug **gravado** — o novo, num rename; o que
 * estiver na linha, quando esta escrita não mexeu no slug —, e é ele que vai
 * para a auditoria e para a releitura do fim.
 */
async function updateSkillRowTx(
  tx: Tx,
  existing: SkillSummary,
  plan: SkillUpdatePlan,
): Promise<string> {
  const result = await tx.execute(sql`
    UPDATE skills SET ${sql.join(plan.sets, sql`, `)}
    WHERE uuid = ${existing.uuid}
    RETURNING slug
  `);
  const row = (result.rows as Row[])[0];
  // Um `deleteSkill` concorrente entre a leitura e o UPDATE: 404, e não o 500
  // da releitura que já não acharia a skill.
  if (!row) throw notFound(`Skill não encontrada: ${existing.slug}`);
  return row.slug as string;
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
  const plan = await planSkillUpdate(input, existing);
  let savedSlug = existing.slug;

  const skillMd = typeof input.skillMd === 'string' ? Buffer.from(input.skillMd, 'utf8') : null;
  // Antes da transação: um `SKILL.md` com byte nulo é 400 sem tocar no banco.
  if (skillMd) fileColumns(SKILL_MD, skillMd);

  try {
    await db().transaction(async (tx) => {
      // Quem grava o `SKILL.md` entra na fila das escritas de arquivo da skill
      // ANTES de tocar em qualquer linha (`tasks/022`). Esta transação trava
      // `skills` e depois o `SKILL.md` em `files`; um `setFile('SKILL.md')` trava
      // `files` e, pelo trigger `files_reindex_skill_trg`, pede `skills` no fim
      // da statement — ordens opostas, 40P01. Nada de `FOR UPDATE` na skill (é
      // a armadilha que `createFile` documenta): a fila é um advisory lock, que
      // ninguém pede segurando linha. Sem `skillMd` esta escrita não toca
      // `files` e fica fora da fila, como `updateSkill`.
      let previousSkillMd: string | null = null;
      if (skillMd) {
        await lockSkillFilesTx(tx, existing.uuid);
        const previous = await readFileFrom(tx, existing.uuid, SKILL_MD);
        previousSkillMd = previous?.isText ? previous.buffer.toString('utf8') : null;
      }

      // A transferência valida o novo dono e apaga a concessão dele antes
      // do UPDATE; o e-mail vai para o label da auditoria.
      const newOwnerEmail = plan.transfer
        ? await transferOwnerTx(tx, GRANTS.skill, existing.uuid, input.ownerUserUuid ?? null)
        : undefined;
      savedSlug = await updateSkillRowTx(tx, existing, plan);

      if (plan.tags !== undefined) {
        await replaceTagsTx(tx, existing.uuid, plan.tags);
      }

      if (skillMd) {
        await upsertFileTx(tx, existing.uuid, SKILL_MD, skillMd);
        await auditTx(tx, {
          skillUuid: existing.uuid,
          skillSlug: savedSlug,
          filePath: SKILL_MD,
          action: 'update',
          source,
          actor,
          previousContent: previousSkillMd,
        });
      }

      await auditTx(tx, {
        skillUuid: existing.uuid,
        skillSlug: savedSlug,
        filePath: null,
        action: 'update',
        source,
        actor,
        previousContent: null,
        targetLabel: newOwnerEmail ?? null,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`Já existe uma skill com o slug "${plan.newSlug}"`);
    throw err;
  }

  const detail = await getSkillDetail(savedSlug, { visibility: 'all' });
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
      asSkill: requireBoolean(item.asSkill, 'asSkill', `MCP virtual "${uuid}"`),
      asPrompt: requireBoolean(item.asPrompt, 'asPrompt', `MCP virtual "${uuid}"`),
      asResource: requireBoolean(item.asResource, 'asResource', `MCP virtual "${uuid}"`),
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
 *
 * **A ordem das travas** (`tasks/023`) é a de toda escrita no recorte de um
 * vMCP — `setVirtualMcpSkills`, `setVirtualMcpCanvas`, os catálogos: **travar**
 * o vMCP, mexer nos vínculos e só então **gravar** no vMCP. São duas regras, e
 * as duas foram medidas:
 *
 *   - *o vMCP antes do vínculo.* Na ordem inversa, reescrever um vínculo
 *     existente segurava a linha dele e pedia a do servidor, enquanto o canvas
 *     segurava a do servidor e pedia a do vínculo: 28 mortes por 40P01 em 150
 *     pares contra o canvas, 59 contra o recorte;
 *   - *trava pura no começo, `UPDATE` no fim.* Adiantar o `UPDATE virtual_mcps`
 *     para o começo fecha aquele ciclo e abre outro, mais raro: a FK de
 *     `skill_accesses` pede `FOR KEY SHARE` no vMCP, que não espera um `FOR NO
 *     KEY UPDATE` — mas, se o snapshot dela viu uma versão já superada da linha,
 *     o Postgres segue a cadeia de versões e **espera o `UPDATE` em andamento**
 *     (`while rechecking updated tuple` no log). `recordSkillAccess` segura o
 *     vínculo e espera o vMCP; quem atualizou o vMCP espera o vínculo. Medido: 3
 *     mortes em 34 mil operações mistas. A trava pura não cria versão nova da
 *     linha, então não há o que esperar; e, quando o `UPDATE` chega, esta
 *     transação já tem todos os vínculos de que precisa.
 *
 * `FOR NO KEY UPDATE`, e não `FOR UPDATE` — ver `lockVirtualMcpTx`.
 */
async function linkTx(
  tx: Tx,
  skillUuid: string,
  link: ResolvedLink,
  source: AuditSource,
  actor: AuditActor | null | undefined,
  position: CanvasPoint | null = null,
) {
  const locked = await tx.execute(sql`
    SELECT uuid FROM virtual_mcps WHERE uuid = ${link.virtualMcpUuid} FOR NO KEY UPDATE
  `);
  // O vMCP foi apagado entre o `resolveLinks` e a transação: o mesmo 400 de lá,
  // em vez da FK do INSERT abaixo virar 500 (medido: 44 de 100 pares
  // `deleteVirtualMcp` × `linkSkill`).
  if ((locked.rows as Row[]).length === 0) {
    throw badRequest(`MCP virtual não encontrado: ${link.virtualMcpUuid}`);
  }
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
  // Por último, com o vínculo já na mão (ver acima).
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
    // A ordem de `linkTx` (`tasks/023`): trava pura no vMCP, o vínculo, e só
    // então o `UPDATE` do vMCP. Na ordem antiga (o vínculo primeiro) eram 57
    // mortes por 40P01 em 150 pares contra o canvas. vMCP inexistente cai no
    // 404 de baixo, como sempre: não há vínculo a desfazer.
    await tx.execute(
      sql`SELECT uuid FROM virtual_mcps WHERE uuid = ${virtualMcpUuid} FOR NO KEY UPDATE`,
    );
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
    // A mesma fila das escritas de arquivo (`setFile`): o `DELETE` trava a skill
    // e a cascata pede as linhas de `files`, a ordem inversa de quem grava
    // arquivo. Com a fila, a remoção espera a escrita em andamento e quem vier
    // depois recebe 404.
    await lockSkillFilesTx(tx, existing.uuid);
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

/**
 * Cria ou sobrescreve um arquivo da skill (upsert, em qualquer caixa). Para
 * criar sem risco de sobrescrever, `createFile`.
 *
 * **Concorrência** (`tasks/022`): a transação começa pela fila das escritas de
 * arquivo da skill (`lockSkillFilesTx`), como `createFile`, `setFiles`,
 * `deleteFile`, `deleteSkill` e o `updateSkillWithContent` que grava o
 * `SKILL.md`. Quem grava arquivo trava a linha de `files` e, pelos triggers
 * (`files_reindex_skill_trg`, `files_rag_stale_trg`), pede a de `skills` no fim
 * da **mesma** statement; quem salva a skill trava `skills` e depois o
 * `SKILL.md`. Ordens opostas: medido em pares concorrentes, 59 de 150 morriam
 * com 40P01 (500). A fila é sempre a **primeira** statement — ninguém a pede
 * segurando linha, então ela não fecha ciclo —, e o conteúdo anterior é lido
 * com ela na mão: a auditoria registra o que esta escrita de fato substituiu.
 */
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
  // Antes da transação: o `SKILL.md` que não é texto é 400 sem tocar no banco.
  const { mimeType, sizeBytes, isText } = fileColumns(path, buffer);

  try {
    await db().transaction(async (tx) => {
      await lockSkillFilesTx(tx, existing.uuid);
      const previous = await readFileFrom(tx, existing.uuid, path);
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
  } catch (err) {
    throw skillGoneOr(err, slug);
  }

  return { relativePath: path, mimeType, sizeBytes, isText };
}

/**
 * Um `deleteSkill` entre o `requireSkill` e o INSERT do arquivo: a FK de `files`
 * falha (23503), e isso é o 404 da skill que sumiu — não erro interno. Medido
 * em pares `deleteSkill` × `setFile`: 29 a 34 de 100 respondiam 500.
 */
function skillGoneOr(err: unknown, slug: string): unknown {
  return isForeignKeyViolation(err, 'files_skill_uuid_fkey')
    ? notFound(`Skill não encontrada: ${slug}`)
    : err;
}

/**
 * Cria um arquivo **só se o caminho está livre** — o "Novo arquivo" do
 * painel. `setFile` é upsert: usado para criar, sobrescreveria em silêncio um
 * arquivo que o operador não viu (outra aba, outro operador, o mcp-admin),
 * inclusive com outra caixa.
 *
 * Mesmos parâmetros, retorno e erros de entrada de `setFile` (404 da skill,
 * 400 do caminho), mais o 400 de um conteúdo que não é texto nem `Buffer`.
 * Caminho ocupado é 409 (`conflict`), sem diferenciar caixa, nesta ordem:
 *
 * - o `SKILL.md` da raiz, que conta como existente mesmo sem linha;
 * - um arquivo no mesmo caminho — a mensagem traz a grafia gravada;
 * - um prefixo do caminho que é arquivo (`docs` pedindo `docs/a.md`), o
 *   `SKILL.md` da raiz inclusive;
 * - arquivos abaixo do caminho, que já é uma pasta (`docs/a.md` pedindo
 *   `docs`) — a mensagem traz a grafia da pasta gravada.
 *
 * As comparações são `lower(...)` com `=` e `starts_with`, nunca `LIKE`: `_` e
 * `%` num nome são literais. Criar audita `create` com o caminho normalizado,
 * como o `setFile` de um arquivo novo; uma recusa não audita nada.
 *
 * **Atomicidade.** Uma transação serializa as criações na mesma skill
 * (`lockSkillFilesTx`, a mesma trava que `setFiles` toma), confere e insere com
 * `ON CONFLICT DO NOTHING` — a garantia final contra quem grava sem a trava
 * (`setFile`): sem linha devolvida, é o 409 do arquivo existente.
 *
 * A trava é um advisory lock, e não `SELECT … FROM skills … FOR UPDATE`, de
 * propósito: quem grava sem ela também precisa da linha da skill — o INSERT
 * pede `FOR KEY SHARE` na checagem da FK e, se a skill já foi indexada, o
 * trigger `files_rag_stale_trg` (`020`) faz um `UPDATE` nela. Um `FOR UPDATE`
 * aqui barra os dois (um `FOR NO KEY UPDATE`, o segundo): um `setFile` do
 * mesmo caminho novo fica esperando esta transação enquanto ela espera o
 * INSERT dele no índice único — deadlock (40P01), e o `setFile` vira 500. O
 * `FOR KEY SHARE` que fica aqui não barra nenhum dos dois; ele é o 404 de
 * quem sumiu e segura um `deleteSkill` até o fim da criação.
 */
export async function createFile(
  slug: string,
  relativePath: string,
  content: Buffer | string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillFileMeta> {
  const existing = await requireSkill(slug);
  const path = normalizeRelativePath(relativePath);
  if (!path) throw badRequest(`Caminho inválido: ${relativePath}`);
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
    throw badRequest('O conteúdo do arquivo precisa ser texto ou bytes');
  }
  // `normalizeRelativePath` já trouxe qualquer caixa de `skill.md` para `SKILL.md`.
  if (isSkillMd(path)) throw conflict('O SKILL.md já existe em toda skill');

  const file = fileColumns(
    path,
    typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
  );
  const depth = path.split('/').length;
  const underSkillMd = depth > 1 && isSkillMd(path.slice(0, path.indexOf('/')));

  await db().transaction(async (tx) => {
    await lockSkillFilesTx(tx, existing.uuid);

    const skill = await tx.execute(
      sql`SELECT uuid FROM skills WHERE uuid = ${existing.uuid} FOR KEY SHARE`,
    );
    if ((skill.rows as Row[]).length === 0) throw notFound(`Skill não encontrada: ${slug}`);

    // Uma consulta para as três ocupações; `conflito` é a ordem das mensagens
    // (1 o mesmo caminho, 2 um prefixo que é arquivo, 3 algo abaixo dele) e,
    // dentro de cada uma, vence o caminho mais curto.
    const found = await tx.execute(sql`
      WITH pedido AS (SELECT lower(${path}) AS caminho)
      SELECT f.relative_path,
             CASE
               WHEN lower(f.relative_path) = p.caminho THEN 1
               WHEN starts_with(p.caminho, lower(f.relative_path) || '/') THEN 2
               ELSE 3
             END AS conflito
        FROM files f
       CROSS JOIN pedido p
       WHERE f.skill_uuid = ${existing.uuid}
         AND (lower(f.relative_path) = p.caminho
              OR starts_with(p.caminho, lower(f.relative_path) || '/')
              OR starts_with(lower(f.relative_path), p.caminho || '/'))
       ORDER BY conflito, char_length(f.relative_path), f.relative_path
       LIMIT 1
    `);
    const row = (found.rows as Row[])[0];
    const taken = row ? (row.relative_path as string) : null;
    const kind = row ? Number(row.conflito) : 0;

    if (kind === 1) throw conflict(`Já existe um arquivo em ${taken}`);
    if (kind === 2) throw conflict(`${taken} é um arquivo, não uma pasta`);
    if (underSkillMd) throw conflict(`${SKILL_MD} é um arquivo, não uma pasta`);
    if (kind === 3) {
      // `lower()` não cria nem tira `/`: os primeiros segmentos da linha são a pasta.
      const folder = taken!.split('/').slice(0, depth).join('/');
      throw conflict(`Já existe uma pasta ${folder}`);
    }

    const inserted = await tx.execute(sql`
      ${insertFileSql(existing.uuid, path, file)}
      ON CONFLICT (skill_uuid, lower(relative_path)) DO NOTHING
      RETURNING id
    `);
    if ((inserted.rows as Row[]).length === 0) {
      // Alguém sem a trava gravou o caminho depois da conferência. O ON
      // CONFLICT esperou o COMMIT dele, e em READ COMMITTED esta leitura, que
      // é outra instrução, já enxerga a linha.
      const winner = await tx.execute(sql`
        SELECT relative_path FROM files
        WHERE skill_uuid = ${existing.uuid} AND lower(relative_path) = lower(${path})
        LIMIT 1
      `);
      const current = (winner.rows as Row[])[0]?.relative_path as string | undefined;
      throw conflict(`Já existe um arquivo em ${current ?? path}`);
    }

    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: existing.slug,
      filePath: path,
      action: 'create',
      source,
      actor,
      previousContent: null,
    });
  });

  return {
    relativePath: path,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    isText: file.isText,
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

  await db().transaction(async (tx) => {
    // A fila das escritas de arquivo da skill, como em `setFile`: o `DELETE`
    // trava a linha de `files` e o trigger pede a de `skills`, e um `setFiles`
    // com `replace` — que já tem a skill e quer apagar esta mesma linha — fechava
    // o ciclo (medido: 4 mortes por 40P01 em 100 pares). A leitura vem depois
    // da fila: duas remoções simultâneas do mesmo caminho auditavam as duas.
    await lockSkillFilesTx(tx, existing.uuid);
    const previous = await readFileFrom(tx, existing.uuid, path);
    if (!previous) throw notFound(`Arquivo não encontrado: ${path}`);

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

/**
 * "Fora desta lista de caminhos", como o banco o decide: a `lower()` do
 * Postgres dos dois lados, a mesma do índice `files_skill_path_lower_uniq`. É o
 * predicado do `DELETE` de `setFiles` e o da prévia — um fragmento só, para os
 * dois nunca discordarem (`tasks/017`).
 */
function outsideOfSql(keep: readonly string[]): SQL {
  return sql`lower(relative_path) <> ALL(ARRAY(
    SELECT lower(enviado) FROM unnest(${sql.param([...keep])}::text[]) AS t(enviado)
  ))`;
}

/**
 * O que um `setFiles(slug, arquivos, …, { replace: true })` **removeria** agora:
 * os caminhos gravados que não estão na lista, menos o `SKILL.md`. É a prévia
 * que o chamador mostra antes de confirmar (`expectedDeletions`), com **o mesmo
 * predicado do `DELETE`** — quem a refaz no app dobra a caixa com o
 * `toLowerCase()` do JS e discorda do banco em `İ` e no sigma final: anunciava
 * uma remoção que não acontece, e o 409 de `expectedDeletions` não tinha saída.
 *
 * Só leitura, sem trava: a árvore pode mudar entre a prévia e a escrita, e é
 * para isso que `expectedDeletions` é conferido dentro da transação. Caminho
 * inválido é o mesmo 400 de `setFiles`; a ordem é a de `listFiles`.
 */
export async function previewSetFilesDeletions(
  skillUuid: string,
  relativePaths: readonly string[],
): Promise<string[]> {
  if (!isUuid(skillUuid)) return [];
  const keep = relativePaths.map((relativePath) => {
    const path = normalizeRelativePath(relativePath);
    if (!path) throw badRequest(`Caminho inválido: ${relativePath}`);
    return path;
  });
  keep.push(SKILL_MD);

  const result = await db().execute(sql`
    SELECT relative_path FROM files
    WHERE skill_uuid = ${skillUuid} AND ${outsideOfSql(keep)}
    ORDER BY relative_path ASC
  `);
  return (result.rows as Row[]).map((row) => row.relative_path as string);
}

export type SetFilesOptions = {
  /**
   * `true` (padrão): o payload representa o estado desejado completo — caminhos
   * omitidos são removidos (exceto SKILL.md, sempre preservado).
   */
  replace?: boolean;
  /**
   * Quantos arquivos a chamada **espera** remover. Informado, é conferido
   * **dentro** da transação, depois do `DELETE`: se o número não bater, nada é
   * gravado e a chamada é 409 (`tasks/011`). É o que fecha a janela entre a
   * prévia que o cliente leu (`listFiles`) e a escrita — outro operador, outra
   * aba ou o mcp-admin podem ter mexido na árvore no meio. Omitido, a remoção
   * acontece como sempre.
   */
  expectedDeletions?: number;
};

/**
 * Upsert em lote. Com `replace` (o padrão), o que ficou de fora **sai** — menos
 * o `SKILL.md`, que nunca sai por aqui.
 *
 * **Auditoria**: uma linha `delete` por caminho removido, com o conteúdo
 * anterior dos textuais, mais a linha `update` da escrita em lote. Antes só
 * existia o `update` sem caminho, e uma remoção em massa não deixava como
 * reconstruir o que se perdeu (`tasks/011`) — o oposto de `deleteFile`, que
 * sempre guardou o conteúdo. As linhas nascem do próprio `DELETE … RETURNING`,
 * numa statement só: o conteúdo registrado é o que a transação de fato apagou.
 *
 * **Concorrência**: a transação toma o advisory lock da skill, o mesmo de
 * `createFile` (`lockSkillFilesTx`) — é ele que faz o par prévia +
 * `expectedDeletions` valer de verdade, porque a contagem que o cliente
 * confirmou é conferida com a árvore travada. De passagem, duas escritas em
 * lote na mesma skill passam a se enfileirar em vez de disputar linha por
 * linha, que é o caminho do deadlock que o README já registra entre elas
 * (`setFiles([x, y])` × `setFile(y)`, com o trigger `files_rag_stale_trg` do
 * `020` no meio). Nada de `FOR UPDATE` na skill: esse é o deadlock que a trava
 * de `createFile` existe para evitar.
 */
export async function setFiles(
  slug: string,
  inputs: readonly FileInput[],
  source: AuditSource,
  options: SetFilesOptions = {},
  actor?: AuditActor | null,
): Promise<SkillFileMeta[]> {
  const existing = await requireSkill(slug);
  const replace = options.replace !== false;

  const expected = options.expectedDeletions;
  if (expected !== undefined && (!Number.isInteger(expected) || expected < 0)) {
    throw badRequest('O campo "expectedDeletions" precisa ser um inteiro não negativo');
  }

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
    await lockSkillFilesTx(tx, existing.uuid);
    await upsertFilesTx(tx, existing.uuid, normalized);

    let removed = 0;
    if (replace) {
      // Os caminhos vão **como vieram**: quem dobra a caixa é o Postgres, dos
      // dois lados, com a mesma `lower()` do índice `files_skill_path_lower_uniq`
      // (`tasks/017`). O `toLowerCase()` do JS faz o mapeamento completo do
      // Unicode — `İ` vira dois code points, o sigma final vira `ς` — e o
      // `lower()` do cluster (libc) é 1:1: com as chaves feitas no JS, este
      // `DELETE` apagava o `İndice.md` que o upsert acabara de gravar, com
      // resposta de sucesso.
      const keep = normalized.map((f) => f.path);
      keep.push(SKILL_MD);
      // Uma statement: o `DELETE` devolve o que saiu e a auditoria parte dessa
      // lista. `left(...)` é o `truncate` de `auditInsert` em SQL — o conteúdo
      // vai até 200 000 caracteres, e binário não vai (o `text_content` dele é
      // nulo, como em `deleteFile`).
      const gone = await tx.execute(sql`
        WITH removidos AS (
          DELETE FROM files
          WHERE skill_uuid = ${existing.uuid}
            AND ${outsideOfSql(keep)}
          RETURNING relative_path, text_content
        ), auditados AS (
          INSERT INTO audit_log (
            skill_uuid, skill_slug, file_path, action, source, previous_content,
            actor_user_uuid, actor_label, target_label
          )
          SELECT ${existing.uuid}, ${slug}, relative_path, 'delete', ${source},
                 left(text_content, 200000), ${actor?.userUuid ?? null},
                 ${actor?.label ?? null}, NULL
          FROM removidos
          RETURNING 1
        )
        SELECT count(*)::int AS total FROM auditados
      `);
      removed = Number((gone.rows as Row[])[0]?.total ?? 0);
    }

    if (expected !== undefined && removed !== expected) {
      throw conflict(
        `A árvore de arquivos mudou: a chamada confirmou ${expected} remoção(ões) e ` +
          `${removed} arquivo(s) sairiam agora — releia a árvore e tente de novo`,
      );
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
  }).catch((err: unknown) => {
    // A skill apagada entre o `requireSkill` e o INSERT é 404, como em `setFile`.
    throw skillGoneOr(err, slug);
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

/**
 * A chave do advisory lock que serializa as escritas que decidem **quantos
 * administradores ativos existem** (a forma é a de `ADOPT_ORPHANS_LOCK`): o
 * primeiro admin e o último. As duas invariantes não se fecham com
 * `INSERT … WHERE NOT EXISTS` nem com `UPDATE … WHERE … AND EXISTS (…)`: em
 * READ COMMITTED o predicado é avaliado no snapshot da transação, não há linha
 * em que travar, e duas transações simultâneas passam as duas (`tasks/049`).
 */
const ADMIN_POPULATION_LOCK = 'purple-skills:admins';

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
  /**
   * `true` grava **só se a tabela de contas está vazia** — é o primeiro
   * administrador, o `/api/setup` do painel. A contagem e o INSERT correm na
   * mesma transação, atrás do advisory lock da população de administradores:
   * dois cliques simultâneos no "criar o primeiro admin" se enfileiram e o
   * segundo recebe 409 em vez de criar uma segunda conta admin — o que
   * **desligaria a adoção de órfãos**, que exige uma admin ativa só
   * (`adoptOrphans`), deixando a instalação com skills e catálogos sem dono.
   * Não vale para `createAccount` nem para o auto-provisionamento OIDC — e
   * **nada aqui os impede de gravar com a tabela vazia**: sem o campo,
   * `createUser` grava em qualquer estado da tabela, com qualquer papel. Uma
   * primeira conta `membro` fecha o `/api/setup` e o login legado sem existir
   * administrador (`tasks/001`), e quem tem de garantir que a primeira conta é
   * o admin do setup é o chamador: conta nenhuma é apagada pelo produto, então
   * um `countUsers() === 0` lido antes do INSERT não tem corrida. A guarda não
   * mora nesta função porque seria incondicional, e criar uma conta comum
   * primeiro é o que ambiente de teste faz. A saída de uma instalação que já
   * caiu nesse estado está no `README.md` ("Instalação sem administrador").
   */
  onlyIfTableEmpty?: boolean;
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

  const insert = sql`
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
  `;

  try {
    if (input.onlyIfTableEmpty === true) {
      return await db().transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${ADMIN_POPULATION_LOCK}, 0))`,
        );
        const total = await tx.execute(sql`SELECT count(*)::int AS total FROM users`);
        if (Number((total.rows as Row[])[0]?.total ?? 0) > 0) {
          throw conflict('Este painel já tem contas: o primeiro administrador já foi criado');
        }
        const created = await tx.execute(insert);
        return toUserRecord((created.rows as Row[])[0]);
      });
    }

    const result = await db().execute(insert);
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
  /**
   * true incrementa token_version — derruba todo cookie já emitido. **Sozinho**
   * (nenhum outro campo na chamada) não carimba `updated_at`: é o "Sair" do
   * painel, movimento de sessão e não alteração administrativa da conta
   * (`tasks/034`). Com qualquer campo junto, o carimbo vale como sempre.
   */
  bumpTokenVersion?: boolean;
  /**
   * `true` zera `failed_attempts` e `locked_until` no mesmo UPDATE — o destrave
   * que acompanha a senha redefinida por quem administra ou por um link de
   * e-mail (`tasks/005`). Sem ele a senha nova, correta, segue recusada até a
   * trava vencer: o login confere `locked_until` **antes** da senha, e o único
   * outro código que a limpa é `registerSuccessfulLogin`, que fica inalcançável.
   * `false` e ausente não mexem — a troca pelo próprio dono logado não tem por
   * que tocar a trava. Não é login: `last_login_at` fica como está.
   */
  clearLoginLock?: boolean;
  /**
   * `true` recusa a escrita com 400 se não houver **outra** conta admin ativa
   * depois dela — a invariante "sempre sobra um administrador" (`tasks/049`).
   * A conferência corre na mesma transação do UPDATE, atrás do advisory lock da
   * população de administradores, e é por isso que dois rebaixamentos
   * simultâneos não passam os dois: a checagem do app, sozinha, lê o estado
   * anterior ao UPDATE do vizinho.
   *
   * Passe o campo **só** quando a escrita tira a conta do grupo (rebaixar um
   * admin, desativar um admin): a conferência é "existe outra admin ativa", não
   * "sobrou alguma" — informá-lo numa escrita qualquer recusaria o UPDATE numa
   * instalação com um admin só. Os demais caminhos (senha, logout, vínculo
   * OIDC) não pagam transação nem lock.
   */
  requireOtherActiveAdmin?: boolean;
};

/**
 * Atualização parcial: campo ausente fica como está.
 *
 * `undefined` significa "não mexe" e `null` significa "apaga" — é o que separa
 * "não estou trocando a senha" de "esta conta passa a ser só-OIDC".
 *
 * Mexer em `passwordHash` (inclusive para `null`) **fecha os links de
 * redefinição vivos da conta**, por um trigger em `users`
 * (`schema/023-links-de-reset-substituidos.sql`): senha nova, nenhum link
 * antigo serve. Vale para os três caminhos que trocam senha — o link
 * consumido, o reset do admin e a troca pelo próprio dono.
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
  if (input.clearLoginLock === true) {
    sets.push(sql`failed_attempts = 0`, sql`locked_until = NULL`);
  }

  // Medido **antes** do push do `token_version`: "nenhum campo da conta entrou
  // no SET, e a chamada só revoga as sessões" — o "Sair" do painel.
  const soRevogaSessoes = sets.length === 0 && input.bumpTokenVersion === true;
  // Incremento no próprio UPDATE: ler-e-somar no app perderia uma revogação
  // concorrente, que é justamente o que não pode falhar aqui.
  if (input.bumpTokenVersion === true) sets.push(sql`token_version = token_version + 1`);

  // `updated_at` descreve alteração administrativa da conta — a razão de
  // `registerFailedLogin`/`registerSuccessfulLogin` não o tocarem. O logout é
  // movimento de sessão e não tem linha na trilha que explique uma data nova
  // (`tasks/034`): ali o carimbo fica como está. Com qualquer campo junto —
  // senha, papel, ativação, vínculo OIDC, destrave — ele vale; e
  // `updateUser(uuid, {})`, o PATCH do painel que não mudou nada, continua
  // carimbando, que é também o que mantém o `SET` não vazio.
  if (!soRevogaSessoes) sets.push(sql`updated_at = now()`);

  const update = sql`
    UPDATE users SET ${sql.join(sets, sql`, `)}
    WHERE uuid = ${uuid}
    RETURNING ${USER_COLUMNS}
  `;

  try {
    if (input.requireOtherActiveAdmin === true) {
      return await db().transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${ADMIN_POPULATION_LOCK}, 0))`,
        );
        // O UPDATE vem primeiro e a invariante é conferida sobre o estado
        // **depois** dele: assim não importa qual campo mudou. Nada de
        // `FOR UPDATE`/`FOR SHARE` nas linhas dos outros admins — duas
        // transações travando a linha uma da outra dariam deadlock (40P01), que
        // o app devolveria como 500.
        const result = await tx.execute(update);
        const row = (result.rows as Row[])[0];
        if (!row) throw notFound(`Conta não encontrada: ${uuid}`);

        const others = await tx.execute(sql`
          SELECT EXISTS (
            SELECT 1 FROM users WHERE role = 'admin' AND is_active AND uuid <> ${uuid}
          ) AS found
        `);
        if (!(others.rows as Row[])[0]?.found) {
          // O texto é o que o painel já mostra (`accounts.ts`): a recusa do
          // banco não pode aparecer diferente da recusa do app.
          throw badRequest('Esta é a última conta de administrador ativa — promova outra antes');
        }
        return toUserRecord(row);
      });
    }

    const result = await db().execute(update);
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
 * O que a revogação de uma chave `psk_` devolve: o que identifica a chave numa
 * linha de auditoria, lido no próprio UPDATE. O app rotula o `key.revoke` como
 * rotulou o `key.create` — pelo nome e pelo prefixo — em vez do uuid, que não
 * aparece em tela nenhuma (`tasks/040`). `userEmail` é o dono da chave, que com
 * o admin revogando não é quem chamou.
 */
export type RevokedApiKey = {
  name: string;
  prefix: string;
  userUuid: string;
  userEmail: string;
};

/**
 * Revoga. `userUuid` presente restringe ao dono (usuário revogando a própria
 * chave); ausente é o admin revogando qualquer uma.
 *
 * `null` quando não achou **ou** já estava revogada — a operação é
 * idempotente e nunca reescreve o `revoked_at` original, que é o que datou a
 * revogação na auditoria. Era `boolean` até o `tasks/040`: quem só testa
 * `if (!revoked)` não muda, porque `null` é falso e o objeto é verdadeiro.
 */
export async function revokeApiKey(
  id: string,
  userUuid?: string | null,
): Promise<RevokedApiKey | null> {
  if (!isUuid(id)) return null;

  const owner = userUuid ?? null;
  if (owner !== null && !isUuid(owner)) return null;

  // O JOIN é pela PK de `users` e sempre casa (`user_uuid` é NOT NULL com FK);
  // `UPDATE … FROM` só trava a linha da chave, não a da conta.
  const result = await db().execute(sql`
    UPDATE api_keys k SET revoked_at = now()
    FROM users u
    WHERE k.id = ${id}
      AND k.revoked_at IS NULL
      AND (${owner}::uuid IS NULL OR k.user_uuid = ${owner}::uuid)
      AND u.uuid = k.user_uuid
    RETURNING k.name, k.prefix, k.user_uuid, u.email
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;
  return {
    name: row.name,
    prefix: row.prefix,
    userUuid: row.user_uuid,
    userEmail: row.email,
  };
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

/**
 * Emite um link de redefinição e **fecha os que a conta ainda tinha vivos**
 * (`schema/023-links-de-reset-substituidos.sql`): pedir "esqueci a senha" cinco
 * vezes deixava cinco links válidos ao mesmo tempo, cada um até o próprio
 * prazo, e um link vazado seguia servindo depois de a pessoa pedir outro.
 *
 * `superseded_at`, não `used_at`: quem não foi clicado não redefiniu senha
 * nenhuma, e é `used_at` que a trilha de auditoria conta.
 *
 * Uma statement só, com a CTE: a linha nova não pode ser fechada pela própria
 * emissão, e a CTE só vê o estado anterior ao comando. Ela roda até o fim mesmo
 * sem ser citada pelo INSERT — é a regra das CTEs que escrevem.
 */
export async function createResetToken(input: {
  userUuid: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  if (!isUuid(input.userUuid)) throw notFound(`Conta não encontrada: ${input.userUuid}`);
  if (!input.tokenHash?.trim()) throw badRequest('O hash do token é obrigatório');

  await db().execute(sql`
    WITH substituidos AS (
      UPDATE reset_tokens SET superseded_at = now()
      WHERE user_uuid = ${input.userUuid}
        AND used_at IS NULL
        AND superseded_at IS NULL
        AND expires_at > now()
      RETURNING 1
    )
    INSERT INTO reset_tokens (user_uuid, token_hash, expires_at)
    VALUES (${input.userUuid}, ${input.tokenHash}, ${input.expiresAt})
  `);
}

/**
 * Queima o token e devolve o dono, ou `null` se não existe, já foi usado,
 * expirou ou **foi substituído** por um pedido mais novo (`023`).
 *
 * Um único UPDATE condicional: é ele que garante que dois cliques no mesmo
 * link não redefinam a senha duas vezes. Ler e depois marcar abriria a janela
 * entre as duas consultas.
 *
 * Os irmãos não são fechados aqui: quem redefine a senha chama `updateUser` em
 * seguida, e o trigger do `023` fecha o que sobrou — inclusive quando a senha
 * é trocada por outro caminho, sem link nenhum.
 */
export async function consumeResetToken(tokenHash: string): Promise<{ userUuid: string } | null> {
  const wanted = (tokenHash ?? '').trim();
  if (!wanted) return null;

  const result = await db().execute(sql`
    UPDATE reset_tokens SET used_at = now()
    WHERE token_hash = ${wanted}
      AND used_at IS NULL
      AND superseded_at IS NULL
      AND expires_at > now()
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
 * emissão e a revogação são do app, e o alvo é o nome da chave. Na revogação o
 * app o recebe de `revokeApiKey`/`revokeVirtualMcpKey`, que devolvem nome e
 * prefixo da chave revogada (`tasks/040`) — o uuid dela não serve de rótulo:
 * não aparece em tela nenhuma e, na `psv_`, some com o vMCP.
 *
 * `user.password` é a senha de **outra** conta trocada por quem administra ou
 * por um link de redefinição (`024`); o ator diz o caminho (e-mail do admin,
 * `bootstrap` ou `link-de-redefinicao`) e `targetLabel` a conta afetada. A
 * troca feita pelo próprio dono logado não entra, como o login.
 *
 * `user.activate` e `user.link` (`026`, `tasks/003`) são os outros dois eventos
 * que mudam **quem consegue entrar** na conta. `user.activate` é o par de
 * `user.deactivate` — reativar devolve o login, as concessões e as chaves
 * `psk_` de uma vez —, com o e-mail de quem reativou como ator. `user.link` é
 * uma identidade OIDC passando a abrir uma conta local que já existia: uma vez
 * por conta, não é login; o ator é o caminho (`oidc:<issuer>`, o rótulo do
 * `user.create` por SSO, com `userUuid` nulo) e `targetLabel` leva o e-mail da
 * conta e o `subject` que a assumiu.
 */
export async function recordAccountAudit(entry: {
  action:
    | 'user.create'
    | 'user.role'
    | 'user.deactivate'
    | 'user.activate'
    | 'user.password'
    | 'user.link'
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
 * Espelho do `CHECK` de `audit_log.action` (hoje em
 * `schema/026-auditoria-de-vinculo-e-reativacao.sql`, que repete a lista
 * inteira), para recusar um filtro inválido com 400 em vez de devolver uma
 * página vazia.
 */
const AUDIT_ACTIONS: readonly AuditAction[] = [
  'create',
  'update',
  'delete',
  'user.create',
  'user.role',
  'user.deactivate',
  'user.activate',
  'user.password',
  'user.link',
  'key.create',
  'key.revoke',
  'mcp.create',
  'mcp.update',
  'mcp.delete',
  'mcp.default',
  'mcp.key.create',
  'mcp.key.revoke',
  'catalog.create',
  'catalog.update',
  'catalog.delete',
  'skill.share',
  'skill.unshare',
  'catalog.share',
  'catalog.unshare',
  'mcp.share',
  'mcp.unshare',
  'public.key.create',
  'public.key.revoke',
  'rag.settings',
  'rag.reindex',
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
    const pattern = likePattern(q);
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
  /** Ligadas e expostas em ao menos um vMCP aberto e ligado, por vínculo direto ou catálogo — o que o site mostra. */
  openSkills: number;
  /** Flutuantes: sem vínculo direto com servidor nenhum **e** fora de todo catálogo. */
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
      (SELECT count(*) FROM skills s WHERE ${OPEN_EXPOSURE})::int AS open_skills,
      (SELECT count(*) FROM skills s
        WHERE NOT EXISTS (SELECT 1 FROM virtual_mcp_skills v WHERE v.skill_uuid = s.uuid)
          AND NOT EXISTS (SELECT 1 FROM catalog_skills cs WHERE cs.skill_uuid = s.uuid))::int
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
  // O que vai para `settings` é o uuid **lido do banco**, não o texto recebido
  // (`tasks/033`). `isUuid` e o tipo `uuid` aceitam maiúsculas, então a
  // validação abaixo acha o servidor; mas `value` é TEXT e toda leitura compara
  // `m.uuid::text = st.value`, com `uuid::text` sempre em minúsculas — o valor
  // gravado como veio era aceito, auditado como sucesso e resolvido como
  // `deleted`, com a raiz do MCP público em 404.
  let canonical: string | null = null;
  if (uuid !== null) {
    const mcp = await getVirtualMcpByUuid(uuid);
    if (!mcp) throw notFound(`MCP virtual não encontrado: ${uuid}`);
    slug = mcp.slug;
    canonical = mcp.uuid;
  }

  await db().transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO settings (key, value) VALUES (${DEFAULT_MCP_SETTING}, ${canonical})
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
export type VirtualMcpReadOptions = {
  onlineWindowMs?: number;
  /**
   * A conta que lê (`docs/12` §3.1). Sem ela é a visão do admin: tudo, com
   * `access: 'owner'`. Com uma conta que não é admin, a listagem devolve só
   * os vMCPs que ela vê (aberto e ligado, dela ou concedido a ela), o
   * detalhe é `null` fora disso, e `access` diz o nível em cada um.
   */
  viewer?: Viewer;
};

// `m` é o servidor, `u` o dono e `c` os contadores do vínculo, numa única
// passada por `virtual_mcp_skills` (LATERAL) em vez de quatro subconsultas.
// As chaves vivas e os dois previews continuam subconsultas: a listagem é de
// painel (poucas linhas) e cada uma responde a uma pergunta distinta. Os
// previews param em `VIRTUAL_MCP_PREVIEW_SIZE` (de shared: é o tamanho da
// colmeia do card) — os contadores continuam contando tudo.
function virtualMcpColumns({ onlineWindowMs, viewer }: VirtualMcpReadOptions): SQL {
  const access = accessColumn(readMode({ visibility: 'all', viewer }), sql`m.owner_user_uuid`, mcpGrantOf);
  const online =
    onlineWindowMs === undefined
      ? sql`0::int`
      : sql`(SELECT count(*) FROM mcp_sessions ms
          WHERE ms.virtual_mcp_uuid = m.uuid
            AND ms.ended_at IS NULL
            AND ms.last_seen_at >= now() - ${windowInterval(onlineWindowMs, 'onlineWindowMs')})::int`;

  return sql`
  m.uuid, m.slug, m.name, m.description, m.is_active, m.is_open,
  m.owner_user_uuid, u.email AS owner_email, m.layout, ${access} AS access,
  c.skill_count, c.tool_count, c.prompt_count, c.resource_count,
  (SELECT count(*) FROM virtual_mcp_keys k
    WHERE k.virtual_mcp_uuid = m.uuid AND k.revoked_at IS NULL)::int AS active_key_count,
  (SELECT count(*) FROM virtual_mcp_catalogs vc
    WHERE vc.virtual_mcp_uuid = m.uuid)::int AS catalog_count,
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
  COALESCE((
    SELECT json_agg(json_build_object('slug', p.slug, 'name', p.name, 'isActive', p.is_active)
                    ORDER BY p.name, p.slug)
    FROM (
      SELECT c.slug, c.name, c.is_active
      FROM virtual_mcp_catalogs vc JOIN catalogs c ON c.uuid = vc.catalog_uuid
      WHERE vc.virtual_mcp_uuid = m.uuid
      ORDER BY c.name ASC, c.slug ASC
      LIMIT ${VIRTUAL_MCP_PREVIEW_SIZE}
    ) p
  ), '[]'::json) AS preview_catalogs,
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
    access: toAccess(row.access),
    skillCount: Number(row.skill_count ?? 0),
    toolCount: Number(row.tool_count ?? 0),
    promptCount: Number(row.prompt_count ?? 0),
    resourceCount: Number(row.resource_count ?? 0),
    activeKeyCount: Number(row.active_key_count ?? 0),
    // NULL quando não há padrão configurado: `Boolean(null)` é `false`.
    isDefault: Boolean(row.is_default),
    onlineSessions: Number(row.online_sessions ?? 0),
    preview: toVirtualMcpPreview(row.preview),
    catalogCount: Number(row.catalog_count ?? 0),
    previewCatalogs: toVirtualMcpPreviewCatalogs(row.preview_catalogs),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toVirtualMcpPreview(value: unknown): VirtualMcpPreviewSkill[] {
  const rows = (typeof value === 'string' ? JSON.parse(value) : value) as Row[] | null;
  return (rows ?? []).map((p) => ({ slug: p.slug, name: p.name, icon: p.icon ?? null }));
}

/** Os catálogos vinculados que a colmeia do card mostra, com o `is_active` do catálogo. */
function toVirtualMcpPreviewCatalogs(value: unknown): VirtualMcpPreviewCatalog[] {
  const rows = (typeof value === 'string' ? JSON.parse(value) : value) as Row[] | null;
  return (rows ?? []).map((p) => ({ slug: p.slug, name: p.name, isActive: Boolean(p.isActive) }));
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
    position: toPosition(row),
  };
}

/**
 * Listagem do painel. Sem opção é a visão do admin: todos, inclusive
 * inativos e órfãos, com `access: 'owner'`. Com `viewer` que não é admin, só
 * os que a conta vê (`docs/12` §3.1: aberto e ligado, dela, ou concedido a
 * ela), e `scope` filtra entre meus / compartilhados comigo / públicos
 * (relativo ao `viewer`, inclusive quando ele é admin).
 *
 * `ownerUserUuid` é o filtro anterior ao `017` e continua valendo: com um
 * UUID, só os daquele dono; `null` é "nenhum dono possível" — a sessão de
 * bootstrap, que não é conta — e devolve lista vazia em vez de vazar os
 * órfãos, que são só do admin. `onlineWindowMs` liga o contador de clientes
 * online (ver `VirtualMcpReadOptions`).
 */
export async function listVirtualMcps(
  options: { ownerUserUuid?: string | null; scope?: AccessScope } & VirtualMcpReadOptions = {},
): Promise<VirtualMcpSummary[]> {
  const owner = options.ownerUserUuid;
  if (owner === null) return [];
  if (owner !== undefined && !isUuid(owner)) return [];
  const mode = readMode({ visibility: 'all', viewer: options.viewer });
  const scope = readScope(options);

  const conditions: SQL[] = [];
  if (owner !== undefined) conditions.push(sql`m.owner_user_uuid = ${owner}`);
  if (mode.kind === 'viewer') conditions.push(mcpVisibleTo(mode.user));
  if (scope) conditions.push(mcpScopeClause(scope, scopeUser(options)));
  const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const result = await db().execute(sql`
    SELECT ${virtualMcpColumns(options)} ${VIRTUAL_MCP_FROM}
    ${where}
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

/**
 * Os catálogos vinculados a um vMCP — os nós de catálogo do canvas
 * (`docs/11-catalogos.md` §5). As portas e a posição são do vínculo (`vc`);
 * `skill_count` conta todo membro e `active_skill_count` é o número do nó:
 * membros com participação ativa e skill ligada que **não** têm vínculo
 * direto com este vMCP — quem já é nó próprio não conta duas vezes.
 */
async function loadVirtualMcpCatalogs(virtualMcpUuid: string): Promise<VirtualMcpCatalog[]> {
  const result = await db().execute(sql`
    SELECT c.uuid, c.slug, c.name, c.description, c.is_active, c.owner_user_uuid,
           vc.as_skill, vc.as_prompt, vc.as_resource, vc.pos_x, vc.pos_y,
           (SELECT count(*) FROM catalog_skills cs WHERE cs.catalog_uuid = c.uuid)::int
             AS skill_count,
           (SELECT count(*) FROM catalog_skills cs
             JOIN skills s ON s.uuid = cs.skill_uuid
             WHERE cs.catalog_uuid = c.uuid AND cs.is_active AND s.is_active
               AND NOT EXISTS (
                 SELECT 1 FROM virtual_mcp_skills v
                 WHERE v.virtual_mcp_uuid = vc.virtual_mcp_uuid AND v.skill_uuid = cs.skill_uuid
               ))::int AS active_skill_count
    FROM virtual_mcp_catalogs vc
    JOIN catalogs c ON c.uuid = vc.catalog_uuid
    WHERE vc.virtual_mcp_uuid = ${virtualMcpUuid}
    ORDER BY c.name ASC, c.slug ASC
  `);
  return (result.rows as Row[]).map((row) => ({
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    isActive: Boolean(row.is_active),
    ownerUserUuid: row.owner_user_uuid ?? null,
    asSkill: Boolean(row.as_skill),
    asPrompt: Boolean(row.as_prompt),
    asResource: Boolean(row.as_resource),
    skillCount: Number(row.skill_count ?? 0),
    activeSkillCount: Number(row.active_skill_count ?? 0),
    position: toPosition(row),
  }));
}

/** `pos_x`/`pos_y` de um vínculo como ponto, ou nulo (as duas andam juntas, por CHECK). */
function toPosition(row: Row): CanvasPoint | null {
  return row.pos_x === null || row.pos_x === undefined || row.pos_y === null || row.pos_y === undefined
    ? null
    : { x: Number(row.pos_x), y: Number(row.pos_y) };
}

/**
 * Detalhe = resumo + skills e catálogos vinculados + layout do canvas +
 * concessões. Inclui inativos: é o painel que lê. Com `viewer` que não é
 * admin, um vMCP que a conta não vê é `null`, como se não existisse.
 */
async function loadVirtualMcpDetail(
  where: SQL,
  options: VirtualMcpReadOptions,
): Promise<VirtualMcpDetail | null> {
  const mode = readMode({ visibility: 'all', viewer: options.viewer });
  const visible = mode.kind === 'viewer' ? sql`AND ${mcpVisibleTo(mode.user)}` : sql``;
  const result = await db().execute(sql`
    SELECT ${virtualMcpColumns(options)} ${VIRTUAL_MCP_FROM} WHERE ${where} ${visible} LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  const summary = toVirtualMcpSummary(row);
  return {
    ...summary,
    skills: await loadVirtualMcpSkills(summary.uuid),
    catalogs: await loadVirtualMcpCatalogs(summary.uuid),
    layout: toVirtualMcpLayout(row.layout),
    grants: await listVirtualMcpGrants(summary.uuid),
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
  /**
   * Transferência (`docs/12` decisão 9): `undefined` não mexe; um uuid
   * precisa ser de conta existente e ativa (400 senão), e a concessão que
   * essa conta tinha no vMCP é apagada — o dono é implícito; `null` apaga o
   * dono. Audita `mcp.update` com `<slug> <email do novo dono>`.
   */
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
  // O novo dono é validado dentro da transação (`transferOwnerTx`), antes
  // deste SET chegar ao banco.
  const transfer = input.ownerUserUuid !== undefined;
  if (transfer) sets.push(sql`owner_user_uuid = ${input.ownerUserUuid ?? null}`);

  // Slug vazio continua significando "mantém o atual", como em `updateSkill`.
  const requestedSlug = optionalText(input.slug, 'slug')?.trim() || undefined;
  if (requestedSlug !== undefined) {
    assertVirtualMcpSlug(requestedSlug);
    sets.push(sql`slug = ${requestedSlug}`);
  }

  sets.push(sql`updated_at = now()`);

  try {
    await db().transaction(async (tx) => {
      const newOwnerEmail = transfer
        ? await transferOwnerTx(tx, GRANTS.mcp, uuid, input.ownerUserUuid ?? null)
        : undefined;
      const result = await tx.execute(sql`
        UPDATE virtual_mcps SET ${sql.join(sets, sql`, `)}
        WHERE uuid = ${uuid}
        RETURNING slug
      `);
      const row = (result.rows as Row[])[0];
      if (!row) throw notFound(`MCP virtual não encontrado: ${uuid}`);
      // O slug novo em caso de rename: é o que o painel vai mostrar dali em
      // diante; numa transferência, o e-mail do novo dono vem junto.
      const label = transferLabel(row.slug as string, newOwnerEmail);
      await auditTx(tx, virtualMcpAudit('mcp.update', label, source, actor));
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
      asSkill: requireBoolean(item.asSkill, 'asSkill', `Skill "${slug}"`),
      asPrompt: requireBoolean(item.asPrompt, 'asPrompt', `Skill "${slug}"`),
      asResource: requireBoolean(item.asResource, 'asResource', `Skill "${slug}"`),
    };
  });

  const seen = new Set<string>();
  for (const item of wanted) {
    if (seen.has(item.slug)) throw badRequest(`Slug repetido na lista: "${item.slug}"`);
    seen.add(item.slug);
  }
  const slugs = wanted.map((item) => item.slug);

  await db().transaction(async (tx) => {
    // A trava serializa dois salvamentos concorrentes do mesmo recorte: o
    // segundo espera o primeiro e enxerga o estado dele, em vez de os dois
    // apagarem e inserirem por cima um do outro. `FOR NO KEY UPDATE`, e não
    // `FOR UPDATE` — ver `lockVirtualMcpTx`.
    const locked = await tx.execute(
      sql`SELECT slug FROM virtual_mcps WHERE uuid = ${uuid} FOR NO KEY UPDATE`,
    );
    const mcp = (locked.rows as Row[])[0];
    if (!mcp) throw notFound(`MCP virtual não encontrado: ${uuid}`);

    const bySlug = await resolveSkillSlugsTx(tx, slugs);
    const keep = slugs.map((slug) => bySlug.get(slug)!);
    await tx.execute(sql`
      DELETE FROM virtual_mcp_skills
      WHERE virtual_mcp_uuid = ${uuid}
        AND skill_uuid <> ALL(${sql.param(keep)}::uuid[])
    `);

    // Só as flags no `DO UPDATE`: contadores e posição no canvas (`pos_x`/
    // `pos_y`) de quem ficou não entram na lista e ficam como estavam.
    //
    // Uma statement para a lista inteira, não uma por item (`tasks/049`): o
    // canvas salva todos os vínculos a cada movimento, e o slug repetido já foi
    // recusado com 400 acima — é o que garante que o `DO UPDATE` não tente
    // afetar a mesma linha duas vezes (21000).
    if (wanted.length > 0) {
      const linhas = wanted.map(
        (item) =>
          sql`(${uuid}, ${bySlug.get(item.slug)!}, ${item.asSkill}, ${item.asPrompt}, ${item.asResource})`,
      );
      await tx.execute(sql`
        INSERT INTO virtual_mcp_skills
          (virtual_mcp_uuid, skill_uuid, as_skill, as_prompt, as_resource)
        VALUES ${sql.join(linhas, sql`, `)}
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

/** Um nó do canvas a posicionar: o slug do que ele representa e o ponto. */
type NodePosition = { slug: string; x: number; y: number };

/** O que o canvas grava: o layout dos nós fixos e/ou a posição de skills e catálogos vinculados. */
export type VirtualMcpCanvasInput = {
  /** Só as chaves informadas substituem as gravadas; as demais ficam. */
  layout?: VirtualMcpLayout;
  /** Skills: cada uma precisa estar vinculada a este vMCP. */
  positions?: readonly NodePosition[];
  /** Catálogos: cada um precisa estar vinculado a este vMCP (`docs/11-catalogos.md` §5). */
  catalogPositions?: readonly NodePosition[];
};

/**
 * Grava o estado do canvas de um vMCP (`docs/10-admin-canvas-e-sessoes.md`):
 * mescla `layout` em `virtual_mcps.layout` (chave a chave, só as informadas)
 * e grava `pos_x`/`pos_y` das skills (`positions`) e dos catálogos
 * (`catalogPositions`) listados. Tudo numa transação: um slug desconhecido
 * ou não vinculado a **este** vMCP é 400 e nada é gravado.
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
    throw badRequest('O canvas deve ser um objeto com "layout", "positions" e/ou "catalogPositions"');
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

  const positions = readNodePositions(input.positions, 'positions');
  const catalogPositions = readNodePositions(input.catalogPositions, 'catalogPositions');

  await db().transaction(async (tx) => {
    // A trava serializa com toda escrita no recorte (`setVirtualMcpSkills`,
    // `linkSkill`, `unlinkSkill`, os catálogos): o canvas não grava a posição
    // de um vínculo que um salvamento concorrente está removendo. `FOR NO KEY
    // UPDATE`, e não `FOR UPDATE` — ver `lockVirtualMcpTx`.
    const locked = await tx.execute(
      sql`SELECT uuid FROM virtual_mcps WHERE uuid = ${virtualMcpUuid} FOR NO KEY UPDATE`,
    );
    if ((locked.rows as Row[]).length === 0) {
      throw notFound(`MCP virtual não encontrado: ${virtualMcpUuid}`);
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

    for (const item of catalogPositions) {
      const updated = await tx.execute(sql`
        UPDATE virtual_mcp_catalogs vc SET pos_x = ${item.x}, pos_y = ${item.y}
        FROM catalogs c
        WHERE vc.virtual_mcp_uuid = ${virtualMcpUuid}
          AND vc.catalog_uuid = c.uuid
          AND c.slug = ${item.slug}
        RETURNING vc.catalog_uuid
      `);
      if ((updated.rows as Row[]).length === 0) {
        throw badRequest(`O catálogo "${item.slug}" não está vinculado a este MCP virtual`);
      }
    }

    // O `UPDATE` do vMCP por último, com os vínculos já gravados — a regra de
    // `linkTx`: antes das posições ele criava uma versão nova da linha do
    // servidor, e a FK de um `recordSkillAccess` que já segurava um daqueles
    // vínculos esperava por ela. É tudo ou nada do mesmo jeito: uma posição
    // recusada desfaz a transação inteira, com ou sem `layout`.
    if (Object.keys(layoutPatch).length > 0) {
      // `||` de jsonb substitui chave a chave: as não informadas ficam.
      await tx.execute(sql`
        UPDATE virtual_mcps SET layout = layout || ${JSON.stringify(layoutPatch)}::jsonb
        WHERE uuid = ${virtualMcpUuid}
      `);
    }
  });
}

/**
 * Uma lista de posições do canvas vinda do cliente: `undefined` é vazia;
 * cada item precisa de slug (sem repetição na lista) e de um ponto válido.
 */
function readNodePositions(value: unknown, field: string): NodePosition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw badRequest(`O campo "${field}" deve ser uma lista`);

  const seen = new Set<string>();
  return (value as Row[]).map((item, index) => {
    const label = `${field}[${index}]`;
    const slug = (optionalText(item?.slug, `${label}.slug`) ?? '').trim();
    if (!slug) throw badRequest(`${label}: o campo "slug" é obrigatório`);
    if (seen.has(slug)) throw badRequest(`Slug repetido na lista: "${slug}"`);
    seen.add(slug);
    return { slug, ...requirePoint(item, label) };
  });
}

/**
 * Os vMCPs que o site lista (`docs/09-mcp-padrao-e-skills-flutuantes.md`
 * §4.2): abertos e ligados, sem dono nem chaves — nada que um anônimo não
 * possa saber. Um fechado ou desligado não aparece, nem que seja o padrão.
 * `skillCount` é o que o site mostra: skills ligadas expostas no servidor por
 * qualquer porta, por vínculo direto ou por catálogo.
 */
export async function listOpenVirtualMcps(): Promise<PublicVirtualMcp[]> {
  const result = await db().execute(sql`
    SELECT m.uuid, m.slug, m.name, m.description,
      (SELECT count(*) FROM skills s
        WHERE s.is_active AND ${exposedIn(sql`m.uuid`)})::int AS skill_count,
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
  return uniqueSlug(desired, await takenSlugs('virtual_mcps', desired));
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

/**
 * As flags do vínculo não têm default: omitir uma é erro, não `false`.
 * `subject` nomeia o item na mensagem (`Skill "x"`, `Catálogo "y"`).
 */
function requireBoolean(value: unknown, field: string, subject: string): boolean {
  if (typeof value !== 'boolean') {
    throw badRequest(`${subject}: o campo "${field}" é obrigatório e deve ser booleano`);
  }
  return value;
}

/**
 * Trava o vMCP e devolve o slug: serializa escritas concorrentes no recorte
 * dele — dois salvamentos não apagam e inserem por cima um do outro — e é o
 * 404 de quem não existe.
 *
 * **`FOR NO KEY UPDATE`, e não `FOR UPDATE`** (`tasks/023`), aqui e nas duas
 * travas irmãs (`setVirtualMcpSkills`, `setVirtualMcpCanvas`). As duas excluem
 * todo escritor do recorte, inclusive o `UPDATE virtual_mcps` de `linkTx`, e as
 * duas seguram `deleteVirtualMcp`, a renomeação e a transferência (que pedem
 * `FOR UPDATE`). A diferença é o `FOR KEY SHARE` que todo INSERT em tabela filha
 * pede pela FK: `FOR UPDATE` o barra, e `recordSkillAccess` — uma statement só,
 * que soma o contador do vínculo e **depois** confere a FK de `skill_accesses`
 * com o servidor — segurava o vínculo esperando o vMCP enquanto o canvas
 * segurava o vMCP esperando o vínculo. Medido: 9 mortes por 40P01 em 150 pares
 * contra o canvas e 26 contra o recorte, quase sempre a do registro de acesso
 * (a leitura sumia da guia Acessos, com o contador); com `FOR NO KEY UPDATE`,
 * nenhuma. É a mesma lição do `FOR UPDATE` em `skills` (`createFile`): numa
 * linha-mãe ele cruza com a FK de quem insere filho.
 */
async function lockVirtualMcpTx(tx: Tx, uuid: string): Promise<{ slug: string }> {
  const locked = await tx.execute(
    sql`SELECT slug FROM virtual_mcps WHERE uuid = ${uuid} FOR NO KEY UPDATE`,
  );
  const row = (locked.rows as Row[])[0];
  if (!row) throw notFound(`MCP virtual não encontrado: ${uuid}`);
  return { slug: row.slug as string };
}

/** O fecho de toda escrita no recorte do vMCP: `updated_at` e a linha `mcp.update`. */
async function touchVirtualMcpTx(
  tx: Tx,
  uuid: string,
  slug: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<void> {
  await tx.execute(sql`UPDATE virtual_mcps SET updated_at = now() WHERE uuid = ${uuid}`);
  await auditTx(tx, virtualMcpAudit('mcp.update', slug, source, actor));
}

/** O detalhe depois de uma escrita; sumir no meio é falha interna, não 404. */
async function virtualMcpAfterWrite(uuid: string, verb: string): Promise<VirtualMcpDetail> {
  const detail = await getVirtualMcpByUuid(uuid);
  if (!detail) throw new Error(`MCP virtual ${verb} mas não encontrado`);
  return detail;
}

// -------------------------------------------------------------- catálogos ---

/**
 * A conta que lê um catálogo (`docs/12` §3.1). Sem ela é a visão do admin:
 * tudo, com `access: 'owner'`. Com uma conta que não é admin, a listagem
 * devolve só os catálogos que ela vê (público e ligado, dela ou concedido a
 * ela), o detalhe é `null` fora disso, e `access` diz o nível em cada um.
 */
export type CatalogReadOptions = { viewer?: Viewer };

// `c` é o catálogo, `u` o dono. Os três contadores são subconsultas porque a
// listagem é de painel (poucas linhas) e cada um responde a uma pergunta
// distinta: quantos membros, quantos saem de fato, em quantos servidores.
function catalogColumns({ viewer }: CatalogReadOptions): SQL {
  const access = accessColumn(readMode({ visibility: 'all', viewer }), sql`c.owner_user_uuid`, catalogGrantOf);
  return sql`
  c.uuid, c.slug, c.name, c.description, c.is_active, c.is_public, c.owner_user_uuid,
  u.email AS owner_email, ${access} AS access, c.view_count, c.download_count,
  (SELECT count(*) FROM catalog_skills cs WHERE cs.catalog_uuid = c.uuid)::int AS skill_count,
  (SELECT count(*) FROM catalog_skills cs JOIN skills s ON s.uuid = cs.skill_uuid
    WHERE cs.catalog_uuid = c.uuid AND cs.is_active AND s.is_active)::int AS active_skill_count,
  (SELECT count(*) FROM virtual_mcp_catalogs vc WHERE vc.catalog_uuid = c.uuid)::int AS mcp_count,
  c.created_at, c.updated_at
`;
}

const CATALOG_FROM = sql`FROM catalogs c LEFT JOIN users u ON u.uuid = c.owner_user_uuid`;

function toCatalogSummary(row: Row): CatalogSummary {
  return {
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    isActive: Boolean(row.is_active),
    ownerUserUuid: row.owner_user_uuid ?? null,
    ownerEmail: row.owner_email ?? null,
    isPublic: Boolean(row.is_public),
    access: toAccess(row.access),
    skillCount: Number(row.skill_count ?? 0),
    activeSkillCount: Number(row.active_skill_count ?? 0),
    mcpCount: Number(row.mcp_count ?? 0),
    viewCount: Number(row.view_count ?? 0),
    downloadCount: Number(row.download_count ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Listagem do painel, com a semântica de `listVirtualMcps`: sem opção é a
 * visão do admin (todos, inclusive desligados e órfãos, `access: 'owner'`);
 * com `viewer` que não é admin, só os que a conta vê (público e ligado,
 * dela, ou concedido a ela), e `scope` filtra entre meus / compartilhados
 * comigo / públicos. `ownerUserUuid` é o filtro anterior ao `017`: com um
 * UUID, só os daquele dono; `null` — a sessão de bootstrap, que não é conta
 * — devolve `[]` em vez de vazar os órfãos, que são só do admin.
 */
export async function listCatalogs(
  options: { ownerUserUuid?: string | null; scope?: AccessScope } & CatalogReadOptions = {},
): Promise<CatalogSummary[]> {
  const owner = options.ownerUserUuid;
  if (owner === null) return [];
  if (owner !== undefined && !isUuid(owner)) return [];
  const mode = readMode({ visibility: 'all', viewer: options.viewer });
  const scope = readScope(options);

  const conditions: SQL[] = [];
  if (owner !== undefined) conditions.push(sql`c.owner_user_uuid = ${owner}`);
  if (mode.kind === 'viewer') conditions.push(catalogVisibleTo(mode.user));
  if (scope) conditions.push(catalogScopeClause(scope, scopeUser(options)));
  const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const result = await db().execute(sql`
    SELECT ${catalogColumns(options)} ${CATALOG_FROM}
    ${where}
    ORDER BY c.name ASC, c.slug ASC
  `);
  return (result.rows as Row[]).map(toCatalogSummary);
}

/**
 * Os membros, com a participação (`cs.is_active`) e o estado da própria
 * skill (`skillIsActive`, o alerta da lista). Inclui inativos: é o painel
 * que lê.
 *
 * Com `viewer` que não é admin, **só os membros que a conta consegue abrir**
 * (`tasks/010`). Dono e concessão no catálogo continuam vendo todos — por
 * `catalogSeenBy` todo membro é legível, ativo ou não. Quem chega só pelo
 * "público" lê a participação **ativa** (`docs/12` §3.1) e deixa de receber
 * nome, slug e descrição da skill privada cuja participação foi desativada —
 * que o site já não mostrava, e cuja página respondia 404 a essa conta.
 *
 * `cs.is_active` vem primeiro de propósito: o catálogo já passou por
 * `catalogVisibleTo`, então participação ativa **implica** skill legível (pelo
 * público ou pelo contêiner concedido), e o `OR` para ali. `skillVisibleTo`, o
 * predicado caro do arquivo, só roda para a participação desativada.
 */
async function loadCatalogSkills(catalogUuid: string, mode: ReadMode): Promise<CatalogSkill[]> {
  const readable =
    mode.kind === 'viewer' ? sql`AND (cs.is_active OR ${skillVisibleTo(mode.user)})` : sql``;
  const result = await db().execute(sql`
    SELECT s.uuid, s.slug, s.name, s.description, s.icon,
           cs.is_active, s.is_active AS skill_is_active, cs.created_at AS added_at
    FROM catalog_skills cs
    JOIN skills s ON s.uuid = cs.skill_uuid
    WHERE cs.catalog_uuid = ${catalogUuid}
      ${readable}
    ORDER BY s.name ASC, s.slug ASC
  `);
  return (result.rows as Row[]).map((row) => ({
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    icon: row.icon ?? null,
    isActive: Boolean(row.is_active),
    skillIsActive: Boolean(row.skill_is_active),
    addedAt: new Date(row.added_at).toISOString(),
  }));
}

/**
 * Os vMCPs em que o catálogo está, com as portas do vínculo. Na visão do admin
 * (`'all'`) inclui fechados e desligados; com `viewer`, **só os que a conta vê**
 * (aberto e ligado, dela ou concedido a ela) — a regra da lista `mcps` da skill
 * (`skillColumns`), que vale para todo `viewer` que não é admin, inclusive o
 * dono do catálogo. A ficha do catálogo não pode revelar o servidor fechado
 * que `getVirtualMcp(slug, { viewer })` devolve como `null` e que a ficha da
 * skill esconde (`tasks/010`): um catálogo público é legível por qualquer conta.
 *
 * `CatalogSummary.mcpCount` continua **global**, de propósito: é o número que a
 * confirmação de exclusão do painel mostra, e ali subestimar é pior que dizer
 * quantos servidores existem. A diferença para o tamanho desta lista é o "e
 * mais N que você não vê".
 */
async function loadCatalogMcps(catalogUuid: string, mode: ReadMode): Promise<CatalogMcpRef[]> {
  const visible = mode.kind === 'viewer' ? sql`AND ${mcpVisibleTo(mode.user)}` : sql``;
  const result = await db().execute(sql`
    SELECT m.uuid, m.slug, m.name, m.is_open, m.is_active, m.owner_user_uuid,
           (m.uuid::text = (SELECT st.value FROM settings st WHERE st.key = ${DEFAULT_MCP_SETTING}))
             AS is_default,
           vc.as_skill, vc.as_prompt, vc.as_resource
    FROM virtual_mcp_catalogs vc
    JOIN virtual_mcps m ON m.uuid = vc.virtual_mcp_uuid
    WHERE vc.catalog_uuid = ${catalogUuid}
      ${visible}
    ORDER BY m.name ASC, m.slug ASC
  `);
  return (result.rows as Row[]).map((row) => ({
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    isOpen: Boolean(row.is_open),
    isActive: Boolean(row.is_active),
    isDefault: Boolean(row.is_default),
    ownerUserUuid: row.owner_user_uuid ?? null,
    asSkill: Boolean(row.as_skill),
    asPrompt: Boolean(row.as_prompt),
    asResource: Boolean(row.as_resource),
  }));
}

/**
 * Detalhe = resumo + membros + vMCPs vinculados + concessões. Inclui
 * inativos: é o painel que lê. Com `viewer` que não é admin, um catálogo
 * que a conta não vê é `null`, como se não existisse — e as duas listas vêm
 * recortadas pelo que ela vê (`loadCatalogSkills`, `loadCatalogMcps`). As
 * escritas releem **sem** `viewer` (`catalogAfterWrite`): o que elas devolvem é
 * a visão do admin, e recortar antes de responder a quem só tem `edit` é do app.
 */
async function loadCatalogDetail(
  where: SQL,
  options: CatalogReadOptions,
): Promise<CatalogDetail | null> {
  const mode = readMode({ visibility: 'all', viewer: options.viewer });
  const visible = mode.kind === 'viewer' ? sql`AND ${catalogVisibleTo(mode.user)}` : sql``;
  const result = await db().execute(sql`
    SELECT ${catalogColumns(options)} ${CATALOG_FROM} WHERE ${where} ${visible} LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  const summary = toCatalogSummary(row);
  return {
    ...summary,
    skills: await loadCatalogSkills(summary.uuid, mode),
    mcps: await loadCatalogMcps(summary.uuid, mode),
    grants: await listCatalogGrants(summary.uuid),
  };
}

export async function getCatalog(
  slug: string,
  options: CatalogReadOptions = {},
): Promise<CatalogDetail | null> {
  const wanted = (slug ?? '').trim();
  if (!wanted) return null;
  return loadCatalogDetail(sql`c.slug = ${wanted}`, options);
}

/** UUID malformado devolve `null` — é "não existe", não erro de servidor. */
export async function getCatalogByUuid(
  uuid: string,
  options: CatalogReadOptions = {},
): Promise<CatalogDetail | null> {
  if (!isUuid(uuid)) return null;
  return loadCatalogDetail(sql`c.uuid = ${uuid}`, options);
}

/** O detalhe depois de uma escrita; sumir no meio é falha interna, não 404. */
async function catalogAfterWrite(uuid: string, verb: string): Promise<CatalogDetail> {
  const detail = await getCatalogByUuid(uuid);
  if (!detail) throw new Error(`Catálogo ${verb} mas não encontrado`);
  return detail;
}

export type CreateCatalogInput = {
  /** Omitido: gerado a partir de `name`. Informado: precisa passar em `isValidSlug`. */
  slug?: string;
  name: string;
  description?: string;
  /** Legível por qualquer conta e pelo site, com os membros (`docs/12` decisões 4 e 5); padrão `false`. */
  isPublic?: boolean;
  /** `null` = sem dono (sessão de bootstrap, token global); só o admin gerencia depois. */
  ownerUserUuid: string | null;
};

/**
 * Cria o catálogo, ligado e vazio, e audita `catalog.create` com o slug em
 * `target_label`. A checagem de papel (`canCreate`) é do app.
 */
export async function createCatalog(
  input: CreateCatalogInput,
  source: AuditSource,
  actor: AuditActor,
): Promise<CatalogDetail> {
  const name = (optionalText(input.name, 'name') ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');

  const description = optionalText(input.description, 'description')?.trim() ?? '';
  const isPublic = optionalBoolean(input.isPublic, 'isPublic') ?? false;
  const owner = ownerOrNull(input.ownerUserUuid);

  // Slug vazio é "gera para mim", como em `createVirtualMcp`.
  const requestedSlug = optionalText(input.slug, 'slug')?.trim() || undefined;
  if (requestedSlug !== undefined) assertCatalogSlug(requestedSlug);

  // Mesma corrida de `createVirtualMcp`: o slug gerado é escolhido antes do
  // INSERT e outra criação pode levá-lo no meio. Gerado, vale tentar de
  // novo; pedido, o conflito é a resposta.
  let slug = '';
  for (let attempt = 1; ; attempt += 1) {
    slug = requestedSlug ?? (await freeCatalogSlug(name));

    try {
      const uuid = await db().transaction(async (tx) => {
        const inserted = await tx.execute(sql`
          INSERT INTO catalogs (slug, name, description, is_public, owner_user_uuid)
          VALUES (${slug}, ${name}, ${description}, ${isPublic}, ${owner})
          RETURNING uuid
        `);
        const created = (inserted.rows as Row[])[0].uuid as string;
        await auditTx(tx, catalogAudit('catalog.create', slug, source, actor));
        return created;
      });
      return catalogAfterWrite(uuid, 'criado');
    } catch (err) {
      // O dono sumiu entre a sessão e a criação.
      if (isForeignKeyViolation(err)) throw notFound(`Conta não encontrada: ${owner}`);
      if (!isUniqueViolation(err)) throw err;
      if (requestedSlug !== undefined || attempt >= SLUG_ATTEMPTS) {
        throw conflict(`Já existe um catálogo com o slug "${slug}"`);
      }
    }
  }
}

export type UpdateCatalogInput = {
  slug?: string;
  name?: string;
  description?: string;
  /** Desligar tira o catálogo inteiro de todo vMCP vinculado; membros e vínculos ficam. */
  isActive?: boolean;
  /** `undefined` não mexe. Ligar torna o catálogo e os membros ativos legíveis por qualquer um. */
  isPublic?: boolean;
  /**
   * Transferência (`docs/12` decisão 9): `undefined` não mexe; um uuid
   * precisa ser de conta existente e ativa (400 senão), e a concessão que
   * essa conta tinha no catálogo é apagada — o dono é implícito; `null`
   * apaga o dono. Audita `catalog.update` com `<slug> <email do novo dono>`.
   */
  ownerUserUuid?: string | null;
};

/**
 * Parcial, no padrão de `updateVirtualMcp`: campo ausente fica como está.
 * Audita `catalog.update` com o slug (o novo, em rename).
 */
export async function updateCatalog(
  uuid: string,
  input: UpdateCatalogInput,
  source: AuditSource,
  actor: AuditActor,
): Promise<CatalogDetail> {
  if (!isUuid(uuid)) throw notFound(`Catálogo não encontrado: ${uuid}`);

  const sets: SQL[] = [];

  if (input.name !== undefined) {
    const name = optionalText(input.name, 'name')?.trim();
    if (!name) throw badRequest('O campo "name" não pode ficar vazio');
    sets.push(sql`name = ${name}`);
  }
  if (input.description !== undefined) {
    sets.push(sql`description = ${optionalText(input.description, 'description')?.trim() ?? ''}`);
  }
  const isActive = optionalBoolean(input.isActive, 'isActive');
  if (isActive !== undefined) sets.push(sql`is_active = ${isActive}`);
  const isPublic = optionalBoolean(input.isPublic, 'isPublic');
  if (isPublic !== undefined) sets.push(sql`is_public = ${isPublic}`);
  // O novo dono é validado dentro da transação (`transferOwnerTx`), antes
  // deste SET chegar ao banco.
  const transfer = input.ownerUserUuid !== undefined;
  if (transfer) sets.push(sql`owner_user_uuid = ${input.ownerUserUuid ?? null}`);

  // Slug vazio continua significando "mantém o atual", como em `updateVirtualMcp`.
  const requestedSlug = optionalText(input.slug, 'slug')?.trim() || undefined;
  if (requestedSlug !== undefined) {
    assertCatalogSlug(requestedSlug);
    sets.push(sql`slug = ${requestedSlug}`);
  }

  sets.push(sql`updated_at = now()`);

  try {
    await db().transaction(async (tx) => {
      const newOwnerEmail = transfer
        ? await transferOwnerTx(tx, GRANTS.catalog, uuid, input.ownerUserUuid ?? null)
        : undefined;
      const result = await tx.execute(sql`
        UPDATE catalogs SET ${sql.join(sets, sql`, `)}
        WHERE uuid = ${uuid}
        RETURNING slug
      `);
      const row = (result.rows as Row[])[0];
      if (!row) throw notFound(`Catálogo não encontrado: ${uuid}`);
      const label = transferLabel(row.slug as string, newOwnerEmail);
      await auditTx(tx, catalogAudit('catalog.update', label, source, actor));
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict(`Já existe um catálogo com o slug "${requestedSlug}"`);
    }
    if (isForeignKeyViolation(err)) {
      throw notFound(`Conta não encontrada: ${input.ownerUserUuid}`);
    }
    throw err;
  }

  return catalogAfterWrite(uuid, 'atualizado');
}

/** A cascata leva os membros (`catalog_skills`) e os vínculos (`virtual_mcp_catalogs`). */
export async function deleteCatalog(
  uuid: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<void> {
  if (!isUuid(uuid)) throw notFound(`Catálogo não encontrado: ${uuid}`);

  await db().transaction(async (tx) => {
    const result = await tx.execute(sql`DELETE FROM catalogs WHERE uuid = ${uuid} RETURNING slug`);
    const row = (result.rows as Row[])[0];
    if (!row) throw notFound(`Catálogo não encontrado: ${uuid}`);
    await auditTx(tx, catalogAudit('catalog.delete', row.slug as string, source, actor));
  });
}

/**
 * Define os membros de forma **declarativa**, como `setVirtualMcpSkills`: a
 * lista é o estado desejado inteiro. Numa transação: quem saiu é removido;
 * quem entrou é inserido com `isActive` (ou ativo, se omitido); quem ficou
 * tem a participação reescrita **só** se `isActive` veio — omitido não mexe,
 * e um re-salvar da lista não religa o que alguém desativou. Slug
 * desconhecido ou repetido é 400 e nada muda. Audita `catalog.update`.
 */
export async function setCatalogSkills(
  uuid: string,
  skills: CatalogSkillInput[],
  source: AuditSource,
  actor: AuditActor,
): Promise<CatalogDetail> {
  if (!isUuid(uuid)) throw notFound(`Catálogo não encontrado: ${uuid}`);
  if (!Array.isArray(skills)) throw badRequest('O campo "skills" deve ser uma lista');

  const wanted = skills.map((item, index) => {
    const slug = (optionalText(item?.slug, 'slug') ?? '').trim();
    if (!slug) throw badRequest(`Item ${index + 1}: o campo "slug" é obrigatório`);
    return { slug, isActive: optionalBoolean(item.isActive, `isActive (${slug})`) };
  });

  const seen = new Set<string>();
  for (const item of wanted) {
    if (seen.has(item.slug)) throw badRequest(`Slug repetido na lista: "${item.slug}"`);
    seen.add(item.slug);
  }
  const slugs = wanted.map((item) => item.slug);

  await db().transaction(async (tx) => {
    const catalog = await lockCatalogTx(tx, uuid);
    const bySlug = await resolveSkillSlugsTx(tx, slugs);
    const keep = slugs.map((slug) => bySlug.get(slug)!);

    await tx.execute(sql`
      DELETE FROM catalog_skills
      WHERE catalog_uuid = ${uuid}
        AND skill_uuid <> ALL(${sql.param(keep)}::uuid[])
    `);

    // Duas statements, uma por ramo, em vez de uma por item (`tasks/049`): não
    // dá para juntar os dois ramos num INSERT só, porque o `DO UPDATE` alcança
    // `EXCLUDED` e a própria tabela, nunca o `VALUES` de origem — não há como
    // escrever "mantém o valor atual quando o pedido não informou".
    const omitidos = wanted.filter((item) => item.isActive === undefined);
    const informados = wanted.filter((item) => item.isActive !== undefined);

    if (omitidos.length > 0) {
      // Quem entra nasce ativo (o DEFAULT); quem já estava fica como está.
      const linhas = omitidos.map((item) => sql`(${uuid}, ${bySlug.get(item.slug)!})`);
      await tx.execute(sql`
        INSERT INTO catalog_skills (catalog_uuid, skill_uuid)
        VALUES ${sql.join(linhas, sql`, `)}
        ON CONFLICT (catalog_uuid, skill_uuid) DO NOTHING
      `);
    }
    if (informados.length > 0) {
      const linhas = informados.map(
        (item) => sql`(${uuid}, ${bySlug.get(item.slug)!}, ${item.isActive!})`,
      );
      await tx.execute(sql`
        INSERT INTO catalog_skills (catalog_uuid, skill_uuid, is_active)
        VALUES ${sql.join(linhas, sql`, `)}
        ON CONFLICT (catalog_uuid, skill_uuid) DO UPDATE SET is_active = EXCLUDED.is_active
      `);
    }

    await touchCatalogTx(tx, uuid, catalog.slug, source, actor);
  });

  return catalogAfterWrite(uuid, 'atualizado');
}

/**
 * Acrescenta um membro, ativo. Já membro: nada muda e nada é auditado — a
 * participação fica como estava. Skill desconhecida é 404.
 */
export async function addCatalogSkill(
  uuid: string,
  skillSlug: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<CatalogDetail> {
  if (!isUuid(uuid)) throw notFound(`Catálogo não encontrado: ${uuid}`);
  const slug = requireText(skillSlug, 'skill');

  await db().transaction(async (tx) => {
    const catalog = await lockCatalogTx(tx, uuid);
    const skill = await tx.execute(sql`SELECT uuid FROM skills WHERE slug = ${slug}`);
    const skillUuid = (skill.rows as Row[])[0]?.uuid as string | undefined;
    if (!skillUuid) throw notFound(`Skill não encontrada: ${slug}`);

    const inserted = await tx.execute(sql`
      INSERT INTO catalog_skills (catalog_uuid, skill_uuid)
      VALUES (${uuid}, ${skillUuid})
      ON CONFLICT (catalog_uuid, skill_uuid) DO NOTHING
      RETURNING skill_uuid
    `);
    if ((inserted.rows as Row[]).length > 0) {
      await touchCatalogTx(tx, uuid, catalog.slug, source, actor);
    }
  });

  return catalogAfterWrite(uuid, 'atualizado');
}

/** Remove um membro. Quem não é membro é 404: nada muda e nada é auditado. */
export async function removeCatalogSkill(
  uuid: string,
  skillSlug: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<CatalogDetail> {
  if (!isUuid(uuid)) throw notFound(`Catálogo não encontrado: ${uuid}`);
  const slug = requireText(skillSlug, 'skill');

  await db().transaction(async (tx) => {
    const catalog = await lockCatalogTx(tx, uuid);
    const removed = await tx.execute(sql`
      DELETE FROM catalog_skills cs USING skills s
      WHERE cs.catalog_uuid = ${uuid} AND cs.skill_uuid = s.uuid AND s.slug = ${slug}
      RETURNING cs.skill_uuid
    `);
    if ((removed.rows as Row[]).length === 0) {
      throw notFound(`A skill "${slug}" não está neste catálogo`);
    }
    await touchCatalogTx(tx, uuid, catalog.slug, source, actor);
  });

  return catalogAfterWrite(uuid, 'atualizado');
}

/**
 * Liga ou desliga a **participação** de um membro (`catalog_skills.is_active`)
 * — a caixa da tela do catálogo. Não toca `skills.is_active`, que é global e
 * se edita na skill. Quem não é membro é 404.
 */
export async function setCatalogSkillActive(
  uuid: string,
  skillSlug: string,
  isActive: boolean,
  source: AuditSource,
  actor: AuditActor,
): Promise<CatalogDetail> {
  if (!isUuid(uuid)) throw notFound(`Catálogo não encontrado: ${uuid}`);
  const slug = requireText(skillSlug, 'skill');
  const active = requireBoolean(isActive, 'isActive', `Skill "${slug}"`);

  await db().transaction(async (tx) => {
    const catalog = await lockCatalogTx(tx, uuid);
    const updated = await tx.execute(sql`
      UPDATE catalog_skills cs SET is_active = ${active}
      FROM skills s
      WHERE cs.catalog_uuid = ${uuid} AND cs.skill_uuid = s.uuid AND s.slug = ${slug}
      RETURNING cs.skill_uuid
    `);
    if ((updated.rows as Row[]).length === 0) {
      throw notFound(`A skill "${slug}" não está neste catálogo`);
    }
    await touchCatalogTx(tx, uuid, catalog.slug, source, actor);
  });

  return catalogAfterWrite(uuid, 'atualizado');
}

/**
 * Vincula (ou reescreve as portas de) um catálogo num vMCP, no padrão de
 * `linkSkill`: a posição no canvas entra no INSERT e, num vínculo que já
 * existe, só substitui quando informada. Audita `mcp.update` no servidor com
 * o slug dele — vincular um catálogo é mudar o que o servidor entrega, como
 * com skill. A permissão é do app: `edit` no vMCP **e** `view` no catálogo
 * (`docs/12-acesso-granular.md`, decisão 7); desvincular é só o `edit` do
 * vMCP. **Era**, até o `017`: "exige administrar os dois"
 * (`docs/11-catalogos.md` decisão 7 e §3.4, revogadas pelo `12`).
 */
export async function linkCatalog(
  virtualMcpUuid: string,
  catalogUuid: string,
  flags: SkillLinkFlags,
  source: AuditSource,
  actor: AuditActor,
  options: { position?: CanvasPoint } = {},
): Promise<VirtualMcpDetail> {
  if (!isUuid(virtualMcpUuid)) throw notFound(`MCP virtual não encontrado: ${virtualMcpUuid}`);
  if (!isUuid(catalogUuid)) throw notFound(`Catálogo não encontrado: ${catalogUuid}`);
  const subject = `Catálogo "${catalogUuid}"`;
  const asSkill = requireBoolean(flags?.asSkill, 'asSkill', subject);
  const asPrompt = requireBoolean(flags?.asPrompt, 'asPrompt', subject);
  const asResource = requireBoolean(flags?.asResource, 'asResource', subject);
  const position =
    options.position === undefined ? null : requirePoint(options.position, 'position');

  try {
    await db().transaction(async (tx) => {
      const mcp = await lockVirtualMcpTx(tx, virtualMcpUuid);
      const found = await tx.execute(sql`SELECT 1 FROM catalogs WHERE uuid = ${catalogUuid}`);
      if ((found.rows as Row[]).length === 0) {
        throw notFound(`Catálogo não encontrado: ${catalogUuid}`);
      }

      await tx.execute(sql`
        INSERT INTO virtual_mcp_catalogs
          (virtual_mcp_uuid, catalog_uuid, as_skill, as_prompt, as_resource, pos_x, pos_y)
        VALUES (${virtualMcpUuid}, ${catalogUuid}, ${asSkill}, ${asPrompt}, ${asResource},
                ${position?.x ?? null}, ${position?.y ?? null})
        ON CONFLICT (virtual_mcp_uuid, catalog_uuid) DO UPDATE SET
          as_skill = EXCLUDED.as_skill,
          as_prompt = EXCLUDED.as_prompt,
          as_resource = EXCLUDED.as_resource,
          pos_x = COALESCE(EXCLUDED.pos_x, virtual_mcp_catalogs.pos_x),
          pos_y = COALESCE(EXCLUDED.pos_y, virtual_mcp_catalogs.pos_y)
      `);
      await touchVirtualMcpTx(tx, virtualMcpUuid, mcp.slug, source, actor);
    });
  } catch (err) {
    // O catálogo sumiu entre a checagem e o INSERT.
    if (isForeignKeyViolation(err)) throw notFound(`Catálogo não encontrado: ${catalogUuid}`);
    throw err;
  }

  return virtualMcpAfterWrite(virtualMcpUuid, 'atualizado');
}

/** Desfaz o vínculo; a posição no canvas vai junto. Não vinculado é 404: nada muda e nada é auditado. */
export async function unlinkCatalog(
  virtualMcpUuid: string,
  catalogUuid: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<VirtualMcpDetail> {
  if (!isUuid(virtualMcpUuid)) throw notFound(`MCP virtual não encontrado: ${virtualMcpUuid}`);
  if (!isUuid(catalogUuid)) throw notFound(`Catálogo não encontrado: ${catalogUuid}`);

  await db().transaction(async (tx) => {
    const mcp = await lockVirtualMcpTx(tx, virtualMcpUuid);
    const removed = await tx.execute(sql`
      DELETE FROM virtual_mcp_catalogs
      WHERE virtual_mcp_uuid = ${virtualMcpUuid} AND catalog_uuid = ${catalogUuid}
      RETURNING catalog_uuid
    `);
    if ((removed.rows as Row[]).length === 0) {
      throw notFound('O catálogo não está vinculado a este MCP virtual');
    }
    await touchVirtualMcpTx(tx, virtualMcpUuid, mcp.slug, source, actor);
  });

  return virtualMcpAfterWrite(virtualMcpUuid, 'atualizado');
}

/**
 * Define os catálogos de um vMCP de forma **declarativa**, no padrão de
 * `setVirtualMcpSkills`: quem saiu é removido, quem entrou é inserido, quem
 * ficou tem só as portas reescritas e mantém a posição no canvas. As três
 * portas são obrigatórias por item; slug desconhecido ou repetido é 400 e
 * nada muda. Audita `mcp.update` no servidor.
 */
export async function setVirtualMcpCatalogs(
  uuid: string,
  catalogs: VirtualMcpCatalogInput[],
  source: AuditSource,
  actor: AuditActor,
): Promise<VirtualMcpDetail> {
  if (!isUuid(uuid)) throw notFound(`MCP virtual não encontrado: ${uuid}`);
  if (!Array.isArray(catalogs)) throw badRequest('O campo "catalogs" deve ser uma lista');

  const wanted = catalogs.map((item, index) => {
    const slug = (optionalText(item?.slug, 'slug') ?? '').trim();
    if (!slug) throw badRequest(`Item ${index + 1}: o campo "slug" é obrigatório`);
    const subject = `Catálogo "${slug}"`;
    return {
      slug,
      asSkill: requireBoolean(item.asSkill, 'asSkill', subject),
      asPrompt: requireBoolean(item.asPrompt, 'asPrompt', subject),
      asResource: requireBoolean(item.asResource, 'asResource', subject),
    };
  });

  const seen = new Set<string>();
  for (const item of wanted) {
    if (seen.has(item.slug)) throw badRequest(`Slug repetido na lista: "${item.slug}"`);
    seen.add(item.slug);
  }
  const slugs = wanted.map((item) => item.slug);

  await db().transaction(async (tx) => {
    const mcp = await lockVirtualMcpTx(tx, uuid);
    const bySlug = await resolveSlugsTx(tx, 'catalogs', slugs, 'Catálogos não encontrados');
    const keep = slugs.map((slug) => bySlug.get(slug)!);

    await tx.execute(sql`
      DELETE FROM virtual_mcp_catalogs
      WHERE virtual_mcp_uuid = ${uuid}
        AND catalog_uuid <> ALL(${sql.param(keep)}::uuid[])
    `);

    // Só as portas no `DO UPDATE`: a posição no canvas de quem ficou fica. Uma
    // statement para a lista inteira, como em `setVirtualMcpSkills`.
    if (wanted.length > 0) {
      const linhas = wanted.map(
        (item) =>
          sql`(${uuid}, ${bySlug.get(item.slug)!}, ${item.asSkill}, ${item.asPrompt}, ${item.asResource})`,
      );
      await tx.execute(sql`
        INSERT INTO virtual_mcp_catalogs
          (virtual_mcp_uuid, catalog_uuid, as_skill, as_prompt, as_resource)
        VALUES ${sql.join(linhas, sql`, `)}
        ON CONFLICT (virtual_mcp_uuid, catalog_uuid) DO UPDATE SET
          as_skill = EXCLUDED.as_skill,
          as_prompt = EXCLUDED.as_prompt,
          as_resource = EXCLUDED.as_resource
      `);
    }

    await touchVirtualMcpTx(tx, uuid, mcp.slug, source, actor);
  });

  return virtualMcpAfterWrite(uuid, 'atualizado');
}

/** Linha de auditoria de um catálogo: sem skill, com o slug do catálogo como alvo. */
function catalogAudit(
  action: 'catalog.create' | 'catalog.update' | 'catalog.delete',
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

function assertCatalogSlug(slug: string): void {
  if (!isValidSlug(slug)) throw badRequest(`Slug inválido: "${slug}"`);
}

/** Slug livre a partir do nome, no padrão de `freeVirtualMcpSlug` — mas sobre `catalogs`. */
async function freeCatalogSlug(name: string): Promise<string> {
  const desired = slugify(name) || 'catalogo';
  return uniqueSlug(desired, await takenSlugs('catalogs', desired));
}

/**
 * Trava o catálogo (`FOR UPDATE`) e devolve o slug: serializa escritas
 * concorrentes nos membros, e é o 404 de quem não existe.
 */
async function lockCatalogTx(tx: Tx, uuid: string): Promise<{ slug: string }> {
  const locked = await tx.execute(sql`SELECT slug FROM catalogs WHERE uuid = ${uuid} FOR UPDATE`);
  const row = (locked.rows as Row[])[0];
  if (!row) throw notFound(`Catálogo não encontrado: ${uuid}`);
  return { slug: row.slug as string };
}

/** O fecho de toda escrita nos membros: `updated_at` e a linha `catalog.update`. */
async function touchCatalogTx(
  tx: Tx,
  uuid: string,
  slug: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<void> {
  await tx.execute(sql`UPDATE catalogs SET updated_at = now() WHERE uuid = ${uuid}`);
  await auditTx(tx, catalogAudit('catalog.update', slug, source, actor));
}

// ------------------------------------------------------------------ acesso ---
//
// Dono, concessões por objeto e "público" (`docs/12-acesso-granular.md`,
// `schema/017-acesso-granular.sql`). Os fragmentos de skill (`skillVisibleTo`,
// `skillGrantOf`, `PUBLIC_REACH`) ficam junto de `visibilityClause`, no topo;
// aqui estão os de vMCP (`m`) e catálogo (`c`), a validação de transferência
// e as escritas de concessão. **A permissão é do app** (`accessLevel`,
// `canManage`, `canOwn` de shared): quem chega aqui já pôde.

/** O nível concedido a `user` no vMCP `m`, ou nulo. */
const mcpGrantOf = (user: string | null): SQL =>
  sql`(SELECT vg.level FROM virtual_mcp_grants vg
    WHERE vg.virtual_mcp_uuid = m.uuid AND vg.user_uuid = ${userParam(user)})`;

/** O que uma conta que não é admin enxerga dos vMCPs: aberto e ligado, dela, ou concedido. */
const mcpVisibleTo = (user: string | null): SQL =>
  sql`((m.is_open AND m.is_active) OR ${mcpSeenBy(user)})`;

function mcpScopeClause(scope: AccessScope, user: string | null): SQL {
  switch (scope) {
    case 'mine':
      return sql`m.owner_user_uuid = ${userParam(user)}`;
    case 'shared':
      return sql`(m.owner_user_uuid IS DISTINCT FROM ${userParam(user)} AND ${mcpGrantOf(user)} IS NOT NULL)`;
    default:
      return sql`(m.is_open AND m.is_active)`;
  }
}

/** O nível concedido a `user` no catálogo `c`, ou nulo. */
const catalogGrantOf = (user: string | null): SQL =>
  sql`(SELECT cg.level FROM catalog_grants cg
    WHERE cg.catalog_uuid = c.uuid AND cg.user_uuid = ${userParam(user)})`;

/** O que uma conta que não é admin enxerga dos catálogos: público e ligado, dela, ou concedido. */
const catalogVisibleTo = (user: string | null): SQL =>
  sql`((c.is_public AND c.is_active) OR ${catalogSeenBy(user)})`;

function catalogScopeClause(scope: AccessScope, user: string | null): SQL {
  switch (scope) {
    case 'mine':
      return sql`c.owner_user_uuid = ${userParam(user)}`;
    case 'shared':
      return sql`(c.owner_user_uuid IS DISTINCT FROM ${userParam(user)} AND ${catalogGrantOf(user)} IS NOT NULL)`;
    default:
      return sql`(c.is_public AND c.is_active)`;
  }
}

/**
 * Os três tipos de objeto com concessão, e o que muda entre eles: a tabela
 * de concessões e a coluna do objeto, a tabela do objeto (para o slug, o
 * dono e o `FOR UPDATE`), as ações de auditoria e se a linha de auditoria
 * leva a skill (`skill_uuid`/`skill_slug`) ou o slug em `target_label`.
 * Todos os nomes são literais nossos — nunca texto do chamador.
 */
type GrantSpec = {
  table: 'skill_grants' | 'catalog_grants' | 'virtual_mcp_grants';
  column: 'skill_uuid' | 'catalog_uuid' | 'virtual_mcp_uuid';
  objects: 'skills' | 'catalogs' | 'virtual_mcps';
  label: 'Skill' | 'Catálogo' | 'MCP virtual';
  share: 'skill.share' | 'catalog.share' | 'mcp.share';
  unshare: 'skill.unshare' | 'catalog.unshare' | 'mcp.unshare';
};

const GRANTS = {
  skill: {
    table: 'skill_grants',
    column: 'skill_uuid',
    objects: 'skills',
    label: 'Skill',
    share: 'skill.share',
    unshare: 'skill.unshare',
  },
  catalog: {
    table: 'catalog_grants',
    column: 'catalog_uuid',
    objects: 'catalogs',
    label: 'Catálogo',
    share: 'catalog.share',
    unshare: 'catalog.unshare',
  },
  mcp: {
    table: 'virtual_mcp_grants',
    column: 'virtual_mcp_uuid',
    objects: 'virtual_mcps',
    label: 'MCP virtual',
    share: 'mcp.share',
    unshare: 'mcp.unshare',
  },
} as const satisfies Record<string, GrantSpec>;

/** O objeto de uma concessão, travado (`FOR UPDATE`) dentro da transação. */
type GrantedObject = { uuid: string; slug: string; ownerUserUuid: string | null };

/**
 * Trava o objeto pelo slug (ou pelo uuid) e devolve uuid, slug e dono. O
 * `FOR UPDATE` serializa conceder, revogar e transferir sobre o mesmo
 * objeto — e é o 404 de quem não existe.
 */
async function lockGrantedObjectTx(tx: Tx, spec: GrantSpec, where: SQL): Promise<GrantedObject> {
  const locked = await tx.execute(sql`
    SELECT uuid, slug, owner_user_uuid FROM ${sql.raw(spec.objects)} WHERE ${where} FOR UPDATE
  `);
  const row = (locked.rows as Row[])[0];
  if (!row) throw notFound(`${spec.label} não encontrado`);
  return { uuid: row.uuid, slug: row.slug, ownerUserUuid: row.owner_user_uuid ?? null };
}

/**
 * Valida o novo dono de uma transferência (`docs/12` decisão 9) e apaga a
 * concessão que ele tinha no objeto — o dono é implícito, não tem linha.
 * Conta torta, inexistente ou desativada é 400; `null` (deixar órfão) passa.
 * Trava o objeto antes de mexer nas concessões, na mesma ordem de
 * `setGrant`/`removeGrant`, para dois caminhos concorrentes não se
 * cruzarem. Devolve o e-mail do novo dono, para o label da auditoria.
 */
async function transferOwnerTx(
  tx: Tx,
  spec: GrantSpec,
  objectUuid: string,
  newOwner: string | null,
): Promise<string | null> {
  if (!isUuid(objectUuid)) throw notFound(`${spec.label} não encontrado: ${objectUuid}`);
  await lockGrantedObjectTx(tx, spec, sql`uuid = ${objectUuid}`);
  if (newOwner === null) return null;
  if (!isUuid(newOwner)) throw badRequest(`Conta não encontrada: ${String(newOwner)}`);

  const found = await tx.execute(
    sql`SELECT email, is_active FROM users WHERE uuid = ${newOwner} FOR SHARE`,
  );
  const user = (found.rows as Row[])[0];
  if (!user) throw badRequest(`Conta não encontrada: ${newOwner}`);
  if (!user.is_active) {
    throw badRequest(`A conta "${user.email}" está desativada e não pode receber a transferência`);
  }

  await tx.execute(sql`
    DELETE FROM ${sql.raw(spec.table)}
    WHERE ${sql.raw(spec.column)} = ${objectUuid} AND user_uuid = ${newOwner}
  `);
  return user.email as string;
}

/**
 * O `target_label` de um `update` de catálogo ou vMCP: só o slug, ou
 * `<slug> <email do novo dono>` numa transferência (`docs/12` §8). Deixar
 * órfão (`null`) não muda o label: não há e-mail a registrar.
 */
function transferLabel(slug: string, newOwnerEmail: string | null | undefined): string {
  return newOwnerEmail ? `${slug} ${newOwnerEmail}` : slug;
}

/**
 * As colunas de `Grant`: `g` é a concessão, `u` a conta, `gb` quem concedeu.
 * `u.is_active` sai junto para o painel marcar a linha de uma conta desativada
 * (`tasks/039`): a concessão dela continua aqui, inerte, e volta a valer se a
 * conta for reativada — quem administra a ACL precisa ver isso para decidir
 * revogar. Vem do mesmo JOIN pela PK, sem coluna, índice nem junção nova.
 */
function grantsQuery(spec: GrantSpec, objectUuid: string, userUuid?: string): SQL {
  return sql`
    SELECT g.user_uuid, u.email, u.name, u.role, u.is_active, g.level,
           g.granted_by_user_uuid, gb.email AS granted_by_email, g.created_at
    FROM ${sql.raw(spec.table)} g
    JOIN users u ON u.uuid = g.user_uuid
    LEFT JOIN users gb ON gb.uuid = g.granted_by_user_uuid
    WHERE g.${sql.raw(spec.column)} = ${objectUuid}
      ${userUuid === undefined ? sql`` : sql`AND g.user_uuid = ${userUuid}`}
    ORDER BY u.name ASC, u.email ASC
  `;
}

function toGrant(row: Row): Grant {
  return {
    userUuid: row.user_uuid,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    isActive: row.is_active === true,
    level: row.level as AccessLevel,
    grantedByUserUuid: row.granted_by_user_uuid ?? null,
    grantedByEmail: row.granted_by_email ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function listGrants(spec: GrantSpec, objectUuid: string): Promise<Grant[]> {
  if (!isUuid(objectUuid)) return [];
  const result = await db().execute(grantsQuery(spec, objectUuid));
  return (result.rows as Row[]).map(toGrant);
}

/**
 * Concede (ou muda o nível — é um upsert) `level` a uma conta num objeto,
 * identificado pelo slug (`docs/12` decisão 10). Recusa com 400: nível fora
 * dos três, conta torta/inexistente/desativada, o dono do objeto e uma conta
 * admin — os dois já têm tudo, e uma linha para eles seria ruído. Slug
 * desconhecido é 404. Ao mudar o nível a linha é reescrita inteira (nível,
 * quem concedeu e quando): ela descreve a concessão **atual**. Audita
 * `*.share` com `email:nível` (e o slug antes, em catálogo e vMCP) e devolve
 * a concessão. A checagem de que o chamador tem `manage` é do app.
 */
async function setGrant(
  spec: GrantSpec,
  slug: string,
  userUuid: string,
  level: AccessLevel,
  source: AuditSource,
  actor: AuditActor,
): Promise<Grant> {
  const wantedSlug = requireText(slug, 'slug');
  if (!isAccessLevel(level)) {
    throw badRequest(`Nível inválido: ${String(level)} (use view, edit ou manage)`);
  }
  if (!isUuid(userUuid)) throw badRequest(`Conta não encontrada: ${String(userUuid)}`);

  return db().transaction(async (tx) => {
    const object = await lockGrantedObjectTx(tx, spec, sql`slug = ${wantedSlug}`);

    const found = await tx.execute(
      sql`SELECT email, role, is_active FROM users WHERE uuid = ${userUuid} FOR SHARE`,
    );
    const user = (found.rows as Row[])[0];
    if (!user) throw badRequest(`Conta não encontrada: ${userUuid}`);
    if (!user.is_active) throw badRequest(`A conta "${user.email}" está desativada`);
    if (user.role === 'admin') {
      throw badRequest(`"${user.email}" é administrador e já tem acesso a tudo`);
    }
    if (object.ownerUserUuid === userUuid) {
      throw badRequest(`"${user.email}" é o dono e já tem acesso a tudo`);
    }

    await tx.execute(sql`
      INSERT INTO ${sql.raw(spec.table)}
        (${sql.raw(spec.column)}, user_uuid, level, granted_by_user_uuid)
      VALUES (${object.uuid}, ${userUuid}, ${level}, ${actor.userUuid ?? null})
      ON CONFLICT (${sql.raw(spec.column)}, user_uuid) DO UPDATE SET
        level = EXCLUDED.level,
        granted_by_user_uuid = EXCLUDED.granted_by_user_uuid,
        created_at = now()
    `);
    await auditTx(tx, grantAudit(spec, 'share', object, `${user.email}:${level}`, source, actor));

    const grant = (await tx.execute(grantsQuery(spec, object.uuid, userUuid)).then(
      (r) => (r.rows as Row[])[0],
    ))!;
    return toGrant(grant);
  });
}

/**
 * Revoga a concessão de uma conta num objeto. Concessão inexistente (ou
 * conta torta) é 404 e nada é auditado; slug desconhecido também. Audita
 * `*.unshare` com o e-mail (e o slug antes, em catálogo e vMCP).
 */
async function removeGrant(
  spec: GrantSpec,
  slug: string,
  userUuid: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<void> {
  const wantedSlug = requireText(slug, 'slug');

  await db().transaction(async (tx) => {
    const object = await lockGrantedObjectTx(tx, spec, sql`slug = ${wantedSlug}`);
    if (!isUuid(userUuid)) throw notFound(`A conta não tem concessão neste ${spec.label.toLowerCase()}`);

    const removed = await tx.execute(sql`
      DELETE FROM ${sql.raw(spec.table)} g USING users u
      WHERE g.${sql.raw(spec.column)} = ${object.uuid}
        AND g.user_uuid = ${userUuid}
        AND u.uuid = g.user_uuid
      RETURNING u.email
    `);
    const row = (removed.rows as Row[])[0];
    if (!row) throw notFound(`A conta não tem concessão neste ${spec.label.toLowerCase()}`);
    await auditTx(tx, grantAudit(spec, 'unshare', object, row.email as string, source, actor));
  });
}

/**
 * A linha de auditoria de uma concessão (`docs/12` §8): na skill, com
 * `skill_uuid`/`skill_slug` e `email:nível` (ou só o e-mail) no label; em
 * catálogo e vMCP, sem skill e com o slug antes, separado por espaço.
 */
function grantAudit(
  spec: GrantSpec,
  kind: 'share' | 'unshare',
  object: GrantedObject,
  who: string,
  source: AuditSource,
  actor: AuditActor,
): AuditInput {
  const onSkill = spec.table === 'skill_grants';
  return {
    skillUuid: onSkill ? object.uuid : null,
    skillSlug: onSkill ? object.slug : null,
    filePath: null,
    action: spec[kind],
    source,
    previousContent: null,
    actor,
    targetLabel: onSkill ? who : `${object.slug} ${who}`,
  };
}

export const setSkillGrant = (
  slug: string,
  userUuid: string,
  level: AccessLevel,
  source: AuditSource,
  actor: AuditActor,
): Promise<Grant> => setGrant(GRANTS.skill, slug, userUuid, level, source, actor);

export const removeSkillGrant = (
  slug: string,
  userUuid: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<void> => removeGrant(GRANTS.skill, slug, userUuid, source, actor);

/** As concessões de uma skill, por nome da conta. Uuid torto é `[]`. */
export const listSkillGrants = (skillUuid: string): Promise<Grant[]> =>
  listGrants(GRANTS.skill, skillUuid);

export const setCatalogGrant = (
  slug: string,
  userUuid: string,
  level: AccessLevel,
  source: AuditSource,
  actor: AuditActor,
): Promise<Grant> => setGrant(GRANTS.catalog, slug, userUuid, level, source, actor);

export const removeCatalogGrant = (
  slug: string,
  userUuid: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<void> => removeGrant(GRANTS.catalog, slug, userUuid, source, actor);

export const listCatalogGrants = (catalogUuid: string): Promise<Grant[]> =>
  listGrants(GRANTS.catalog, catalogUuid);

export const setVirtualMcpGrant = (
  slug: string,
  userUuid: string,
  level: AccessLevel,
  source: AuditSource,
  actor: AuditActor,
): Promise<Grant> => setGrant(GRANTS.mcp, slug, userUuid, level, source, actor);

export const removeVirtualMcpGrant = (
  slug: string,
  userUuid: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<void> => removeGrant(GRANTS.mcp, slug, userUuid, source, actor);

export const listVirtualMcpGrants = (virtualMcpUuid: string): Promise<Grant[]> =>
  listGrants(GRANTS.mcp, virtualMcpUuid);

/**
 * O que `adoptOrphans` fez. `adopted` diz se a conta era **elegível** — a
 * única conta admin ativa — e a varredura rodou; `skills` e `catalogs` dizem
 * quantos objetos ela adotou **nesta** chamada. Uma segunda chamada devolve
 * `adopted: true` com as contagens em zero.
 */
export type AdoptOrphansResult = { adopted: boolean; skills: number; catalogs: number };

/** A chave do advisory lock que serializa as adoções (a forma é a de `lockSkillFilesTx`). */
const ADOPT_ORPHANS_LOCK = 'purple-skills:adopt-orphans';

const notAdopted = (): AdoptOrphansResult => ({ adopted: false, skills: 0, catalogs: 0 });

/**
 * O administrador solitário adota o que nasceu órfão. A sessão de bootstrap e
 * o `MCP_ADMIN_TOKEN` criam skills e catálogos sem dono; quando a instalação
 * tem **uma** conta admin ativa, esses objetos passam a ser dela. O painel
 * chama depois do `/api/setup` e de cada login bem-sucedido, em melhor
 * esforço.
 *
 * Só age se a conta existe, está ativa, é `admin` e nenhuma **outra** conta
 * admin está ativa (admin desativado não conta). Fora disso — inclusive uuid
 * torto — devolve `adopted: false` sem gravar nada e sem lançar.
 *
 * Adota skills e catálogos; **vMCPs ficam de fora** — o `public`/padrão nasce
 * órfão de propósito (`docs/09`, decisão 6). Cada adoção é uma transferência:
 * a concessão que a conta tinha no objeto é apagada (o dono é implícito) e a
 * auditoria é a mesma (`update` na skill com o e-mail no label,
 * `catalog.update` com `<slug> <email>`), uma linha por objeto, com o ator e
 * a origem recebidos. Adotar não muda o objeto: `updated_at` fica, e só o
 * dono mudando não marca `rag_stale` (os triggers do `020` olham nome,
 * descrição, arquivo e tag).
 *
 * Tudo numa transação, atrás de um advisory lock de transação: duas chamadas
 * simultâneas (login em duas abas) se enfileiram, e a segunda já não acha
 * órfão nenhum — nada é auditado em dobro. A conta fica em `FOR SHARE` até o
 * fim, o que segura um rebaixamento ou uma desativação concorrente. Uma conta
 * promovida a admin **depois** da checagem não desfaz a adoção: ela valeu
 * para o estado que a checagem leu. A permissão (quem pode disparar) é do app.
 */
export async function adoptOrphans(
  userUuid: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<AdoptOrphansResult> {
  if (!isUuid(userUuid)) return notAdopted();

  return db().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ADOPT_ORPHANS_LOCK}, 0))`);

    const found = await tx.execute(
      sql`SELECT email, role, is_active FROM users WHERE uuid = ${userUuid} FOR SHARE`,
    );
    const user = (found.rows as Row[])[0];
    if (!user || user.role !== 'admin' || !user.is_active) return notAdopted();

    const others = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM users WHERE role = 'admin' AND is_active AND uuid <> ${userUuid}
      ) AS found
    `);
    if ((others.rows as Row[])[0]?.found) return notAdopted();

    const email = user.email as string;
    const skills = await adoptOrphansTx(tx, GRANTS.skill, userUuid, email, source, actor);
    const catalogs = await adoptOrphansTx(tx, GRANTS.catalog, userUuid, email, source, actor);
    return { adopted: true, skills, catalogs };
  });
}

/**
 * Passa à conta todo objeto sem dono de um tipo, num comando só: o `UPDATE`
 * devolve os adotados, e o `DELETE` da concessão e o `INSERT` da auditoria
 * partem dessa lista — só o que **este** comando adotou é auditado. O
 * `WHERE owner_user_uuid IS NULL` é reavaliado sobre a versão nova de uma
 * linha que outra transação acabou de transferir: ela não é adotada. A
 * auditoria segue a ordem do slug. Devolve quantos adotou. O tipo do `spec`
 * deixa o vMCP de fora de propósito.
 */
async function adoptOrphansTx(
  tx: Tx,
  spec: typeof GRANTS.skill | typeof GRANTS.catalog,
  userUuid: string,
  email: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<number> {
  const onSkill = spec.table === 'skill_grants';
  const action: AuditAction = onSkill ? 'update' : 'catalog.update';
  // Os mesmos campos de `grantAudit` e de uma transferência: na skill, o uuid
  // e o slug dela com o e-mail no label; no catálogo, sem skill e com o slug
  // antes do e-mail. Os casts existem porque, num `INSERT … SELECT`, o
  // Postgres não infere o tipo do parâmetro pela coluna de destino.
  const audited = onSkill
    ? sql`a.uuid, a.slug, ${email}::text`
    : sql`NULL::uuid, NULL::text, a.slug || ' ' || ${email}::text`;

  const result = await tx.execute(sql`
    WITH adopted AS (
      UPDATE ${sql.raw(spec.objects)} SET owner_user_uuid = ${userUuid}
      WHERE owner_user_uuid IS NULL
      RETURNING uuid, slug
    ),
    dropped AS (
      DELETE FROM ${sql.raw(spec.table)} g USING adopted a
      WHERE g.${sql.raw(spec.column)} = a.uuid AND g.user_uuid = ${userUuid}
    ),
    logged AS (
      INSERT INTO audit_log (
        skill_uuid, skill_slug, target_label, file_path, action, source,
        previous_content, actor_user_uuid, actor_label
      )
      SELECT ${audited}, NULL, ${action}::text, ${source}::text,
             NULL, ${actor.userUuid ?? null}::uuid, ${actor.label}::text
      FROM adopted a
      ORDER BY a.slug
    )
    SELECT count(*)::int AS total FROM adopted
  `);
  return Number((result.rows as Row[])[0]?.total ?? 0);
}

/** Teto da busca de contas: é uma lista de sugestões, não uma listagem. */
const USER_LOOKUP_MAX = 50;

/**
 * A busca "Compartilhar com…" (`docs/12` decisão 13): contas **ativas** cujo
 * nome ou e-mail contém `q` (`ILIKE`), por nome. Menos de dois caracteres
 * (depois de aparar) devolve `[]` sem consultar — é o mínimo para não
 * listar a instalação inteira a cada tecla. Aberta a qualquer conta logada;
 * a checagem de sessão é do app.
 */
export async function lookupUsers(q: string, limit = 10): Promise<UserLookup[]> {
  const wanted = (optionalText(q, 'q') ?? '').trim();
  if (wanted.length < 2) return [];
  const pattern = likePattern(wanted.slice(0, SEARCH_QUERY_MAX_LENGTH));

  const result = await db().execute(sql`
    SELECT uuid, email, name, role FROM users
    WHERE is_active AND (name ILIKE ${pattern} OR email ILIKE ${pattern})
    ORDER BY name ASC, email ASC
    LIMIT ${clamp(limit, 1, USER_LOOKUP_MAX)}
  `);
  return (result.rows as Row[]).map((row) => ({
    uuid: row.uuid,
    email: row.email,
    name: row.name,
    role: row.role as Role,
  }));
}

/** Os catálogos que o site lista (`docs/12` §7): públicos e ligados, sem dono nem concessões. */
const PUBLIC_CATALOG_COLUMNS = sql`
  c.uuid, c.slug, c.name, c.description,
  (SELECT count(*) FROM catalog_skills cs JOIN skills s ON s.uuid = cs.skill_uuid
    WHERE cs.catalog_uuid = c.uuid AND cs.is_active AND s.is_active)::int AS skill_count
`;

function toPublicCatalog(row: Row): PublicCatalog {
  return {
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    skillCount: Number(row.skill_count ?? 0),
  };
}

/**
 * A seção "Catálogos" do site: os públicos e ligados, por nome, com
 * `skillCount` = membros com participação ativa e skill ligada — o que a
 * página do catálogo vai listar.
 */
export async function listPublicCatalogs(): Promise<PublicCatalog[]> {
  const result = await db().execute(sql`
    SELECT ${PUBLIC_CATALOG_COLUMNS} FROM catalogs c
    WHERE c.is_public AND c.is_active
    ORDER BY c.name ASC, c.slug ASC
  `);
  return (result.rows as Row[]).map(toPublicCatalog);
}

/**
 * A página de um catálogo no site: os membros ativos (participação ativa e
 * skill ligada), **todos**, mesmo os privados e os que não estão em vMCP
 * aberto nenhum — o contêiner expõe (`docs/12` decisão 5). Cada um vem como
 * `SkillSummary` na visibilidade do site (`mcps` só com os vMCPs abertos e
 * ligados, `catalogs` vazio, `access` nulo), por nome. Catálogo privado,
 * desligado ou inexistente é `null`, sem distinção.
 */
export async function getPublicCatalog(slug: string): Promise<PublicCatalogDetail | null> {
  const wanted = (slug ?? '').trim();
  if (!wanted) return null;

  const found = await db().execute(sql`
    SELECT ${PUBLIC_CATALOG_COLUMNS} FROM catalogs c
    WHERE c.slug = ${wanted} AND c.is_public AND c.is_active
    LIMIT 1
  `);
  const row = (found.rows as Row[])[0];
  if (!row) return null;
  const catalog = toPublicCatalog(row);

  const members = await db().execute(sql`
    SELECT ${skillColumns({ visibility: 'open' })}
    FROM skills s
    WHERE s.is_active AND EXISTS (
      SELECT 1 FROM catalog_skills cs
      WHERE cs.catalog_uuid = ${catalog.uuid} AND cs.skill_uuid = s.uuid AND cs.is_active
    )
    ORDER BY s.name ASC, s.slug ASC
  `);
  return { ...catalog, skills: (members.rows as Row[]).map(toSummary) };
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

/** Uma chave `psv_` com o servidor a que pertence — "Meu espaço → Chaves emitidas". */
export type VirtualMcpKeyWithMcp = VirtualMcpKeySummary & {
  virtualMcpSlug: string;
  virtualMcpName: string;
};

/**
 * As chaves que a conta emitiu, em todos os vMCPs: ativas primeiro, depois as
 * mais novas. Inclui as revogadas, como `listVirtualMcpKeys`, e nunca o hash.
 * Não filtra por acesso ao servidor — a chave é de quem a emitiu, e a
 * decisão de mostrar é do app. Chave de vMCP apagado não aparece (`CASCADE`).
 */
export async function listVirtualMcpKeysByCreator(
  userUuid: string,
): Promise<VirtualMcpKeyWithMcp[]> {
  if (!isUuid(userUuid)) return [];

  const result = await db().execute(sql`
    SELECT
      k.id,
      k.virtual_mcp_uuid,
      k.name,
      k.prefix,
      k.created_by_user_uuid,
      k.last_used_at,
      k.revoked_at,
      k.created_at,
      m.slug AS virtual_mcp_slug,
      m.name AS virtual_mcp_name
    FROM virtual_mcp_keys k
    JOIN virtual_mcps m ON m.uuid = k.virtual_mcp_uuid
    WHERE k.created_by_user_uuid = ${userUuid}
    ORDER BY (k.revoked_at IS NOT NULL) ASC, k.created_at DESC, k.id DESC
  `);
  return (result.rows as Row[]).map((row) => ({
    ...toVirtualMcpKeySummary(row),
    virtualMcpSlug: row.virtual_mcp_slug,
    virtualMcpName: row.virtual_mcp_name,
  }));
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
 * O que a revogação de uma chave `psv_` devolve, para o app rotular o
 * `mcp.key.revoke` como rotulou a emissão (`tasks/040`). O nome é congelado na
 * linha de auditoria porque a chave some com o vMCP (`ON DELETE CASCADE`): uma
 * linha que só guardasse o uuid ficaria sem referente. O servidor não vem
 * junto — quem chama já o informou.
 */
export type RevokedVirtualMcpKey = { name: string; prefix: string };

/**
 * Revoga, **sempre** restrita ao servidor informado: a chave pertence ao MCP,
 * e a URL do painel já diz de qual. `null` quando não achou, não é dele ou
 * já estava revogada — idempotente, nunca reescreve o `revoked_at` original.
 * Era `boolean` até o `tasks/040`; `if (!revoked)` continua valendo.
 */
export async function revokeVirtualMcpKey(
  id: string,
  virtualMcpUuid: string,
): Promise<RevokedVirtualMcpKey | null> {
  if (!isUuid(id) || !isUuid(virtualMcpUuid)) return null;

  const result = await db().execute(sql`
    UPDATE virtual_mcp_keys SET revoked_at = now()
    WHERE id = ${id}
      AND virtual_mcp_uuid = ${virtualMcpUuid}
      AND revoked_at IS NULL
    RETURNING name, prefix
  `);
  const row = (result.rows as Row[])[0];
  return row ? { name: row.name, prefix: row.prefix } : null;
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

/**
 * Teto para o que vem de cabeçalhos e do `clientInfo`: é rótulo de tela, não
 * conteúdo. Exportado para o mcp-public cortar **na memória** com o mesmo
 * número que o banco usa na gravação (`tasks/047`) — ver
 * `normalizeSessionLabel`.
 */
export const MCP_SESSION_LABEL_MAX = 512;

/**
 * Um rótulo de tela (`clientInfo`, `user-agent`, IP, id de sessão) pronto para
 * gravar: caractere de controle e separador de linha viram espaço, as pontas
 * são aparadas, vazio vira nulo e o resto é cortado em
 * `MCP_SESSION_LABEL_MAX`. Aplicar duas vezes dá o mesmo resultado.
 *
 * **Por que limpar, e não recusar.** O `text` do Postgres não guarda U+0000:
 * um byte nulo no nome que o cliente MCP anuncia derrubava a escrita inteira
 * com 22021 — e em `recordSkillAccess` os três UPDATEs de contador vivem na
 * mesma instrução do INSERT. Quem se apresentava assim continuava lendo tudo
 * e sumia da guia "Acessos", dos contadores e da tela de sessões
 * (`tasks/038`). O rótulo é decorativo e o registro não: perder o primeiro é
 * aceitável, perder o segundo é evasão de auditoria por quem está sendo
 * auditado. Sai a categoria `Cc` inteira (C0, DEL e C1) mais `Zl`/`Zp`, e não
 * só o nulo: quebra de linha e ESC num rótulo são, na melhor das hipóteses,
 * lixo na tela e no log de quem administra.
 *
 * **Por que copiar.** No V8 o recorte de uma string longa (`slice`, `trim`)
 * guarda uma referência à string-mãe. Medido: 400 rótulos de 512 caracteres
 * recortados de um `clientInfo.name` de 1 MB seguravam 401 MB de heap, e
 * 1,4 MB depois de copiados. Para a gravação tanto faz — o valor vai ao
 * driver e morre —, mas o mcp-public guarda o rótulo em memória por sessão
 * (`tasks/047`) e usa esta função para ter **a mesma regra** do banco. A ida
 * e volta por `Buffer` ainda troca por U+FFFD o substituto solitário que o
 * corte possa ter deixado no meio de um par.
 */
export function normalizeSessionLabel(value: string): string | null {
  const text = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').trim();
  if (!text) return null;
  return Buffer.from(text.slice(0, MCP_SESSION_LABEL_MAX).trimEnd(), 'utf8').toString('utf8');
}

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
 * um vMCP (ou chave) que sumiu entre a resolução e a abertura é 404. Os
 * rótulos (`userAgent`, `clientName`, `clientVersion`) passam por
 * `normalizeSessionLabel`: o que o cliente anuncia no `initialize` é texto
 * livre, e um byte nulo ali fazia a sessão inteira não ser registrada.
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

// ------------------------------------------------------ acessos por skill ---

// Os CHECKs de `skill_accesses`, espelhados: um valor fora da lista é 400
// aqui, e não uma violação de CHECK virando 500.
const SKILL_ACCESS_KINDS: readonly SkillAccessKind[] = ['view', 'download'];
const SKILL_ACCESS_SURFACES: readonly SkillAccessSurface[] = [
  'tool', 'resource', 'prompt', 'file', 'download', 'page', 'admin-tool',
];
const SKILL_ACCESS_ORIGINS: readonly SkillAccessOrigin[] = ['mcp', 'site', 'mcp-admin'];
const SKILL_ACCESS_AUTHS: readonly SkillAccessAuth[] = ['open', 'key', 'user', 'anonymous'];

/**
 * A porta do vínculo por onde uma leitura registrada entrou no vMCP. O
 * mcp-public serve `get_skill` (`tool`), o `SKILL.md` avulso (`file`) e o
 * pacote (`download`) pelo recorte `surface: 'skill'`; `prompts/get` e
 * `resources/read`, pela porta de mesmo nome. `page` (site) e `admin-tool`
 * (mcp-admin) não têm vMCP: o valor nem chega a ser usado, e o padrão é a
 * porta de skill.
 */
function accessPort(surface: SkillAccessSurface): VirtualSurface {
  switch (surface) {
    case 'prompt':
      return 'prompt';
    case 'resource':
      return 'resource';
    default:
      return 'skill';
  }
}

/**
 * Grava uma leitura em `skill_accesses` (`docs/13-fichas-e-acessos.md`,
 * `schema/018-acessos-por-skill.sql`) **e soma os contadores** exatamente
 * como `incrementViewCount`/`incrementDownloadCount`: no global da skill
 * sempre e, com `virtualMcpUuid`, no caminho — o vínculo direto se existir,
 * senão cada catálogo que contribuiu (ligado, participação ativa, vinculado
 * ao vMCP). Os catálogos que somam são os mesmos gravados na linha.
 *
 * **O caminho olha a porta.** Catálogo que contribuiu é o que serve a
 * superfície **desta** leitura — `accessPort`: `tool`, `file` e `download`
 * pela porta de skill, `prompt` e `resource` pela de mesmo nome —, a mesma
 * regra de `exposedIn`. Um catálogo vinculado só com Prompts não entrega um
 * `get_skill`: gravá-lo no caminho somava o contador dele e mostrava a quem
 * o administra o IP, a chave e o cliente de uma leitura que não passou por
 * ele (`tasks/041`). As linhas anteriores à correção ficam como foram
 * gravadas: não há registro de qual era a porta do vínculo naquela hora.
 *
 * **Exceção: `origin = 'mcp-admin'` só grava a linha.** O `get_skill` do
 * mcp-admin nunca contou — é administração, não consumo — e a pontuação do
 * acervo (`skillScore`, sobre os contadores) não pode mudar de significado
 * porque a leitura passou a ser registrada. Os catálogos do caminho não se
 * aplicam (não há vMCP) e nenhum contador é tocado.
 *
 * As cópias (slug e nome da skill e do vMCP, nome da chave `psv_` por
 * `keyId`, da `psk_` por `apiKeyId`, e-mail por `userUuid`) são resolvidas
 * aqui, num INSERT ... SELECT só: é o que fica legível depois que o objeto
 * some. `kind`, `surface`, `origin` e `auth` fora dos CHECKs e `skillUuid`
 * torto são 400 — é bug de quem chama. Uuid torto num campo **opcional** é
 * ignorado (a coluna fica nula), assim como um vMCP, chave ou conta que já
 * não existe: `auth` continua dizendo o que houve. Skill inexistente não
 * grava nada e não lança — ela pode ter sumido entre a leitura e o registro.
 *
 * Uma instrução só, sem transação explícita, como `bumpCounter`: é
 * best-effort e os chamadores disparam com `void … .catch(log)`. Os rótulos
 * (`sessionId`, `ip`, `userAgent`, `clientName`, `clientVersion`) passam por
 * `normalizeSessionLabel`, como em `openMcpSession`: sem caractere de
 * controle — o byte nulo derrubava a linha **e** os contadores, `tasks/038`
 * —, aparados e cortados em `MCP_SESSION_LABEL_MAX` (512). As **cópias de
 * nome** (skill, vMCP, chave `psv_`, chave `psk_` e cada catálogo) são
 * cortadas no mesmo teto: slug (96) e e-mail (254) já têm limite na entrada,
 * nome não tem nenhum, e a linha é copiada a cada leitura numa tabela que
 * nunca é podada (`tasks/042`). Cortar, e não um `CHECK`, pelo mesmo motivo
 * dos rótulos: o registro vale mais do que o campo.
 */
export async function recordSkillAccess(input: SkillAccessInput): Promise<void> {
  if (!isUuid(input.skillUuid)) throw badRequest('O campo "skillUuid" precisa ser um uuid');
  const kind = oneOf(input.kind, SKILL_ACCESS_KINDS, 'kind');
  const surface = oneOf(input.surface, SKILL_ACCESS_SURFACES, 'surface');
  const origin = oneOf(input.origin, SKILL_ACCESS_ORIGINS, 'origin');
  const auth = oneOf(input.auth, SKILL_ACCESS_AUTHS, 'auth');
  const virtualMcpUuid = optionalUuid(input.virtualMcpUuid);
  const keyId = optionalUuid(input.keyId);
  const apiKeyId = optionalUuid(input.apiKeyId);
  const userUuid = optionalUuid(input.userUuid);
  // O nome da coluna é um dos dois literais nossos — nunca texto do chamador.
  const column = sql.raw(kind === 'view' ? 'view_count' : 'download_count');
  // A porta do vínculo catálogo↔vMCP por onde **esta** leitura entrou.
  const porta = surfaceFlag('vc', accessPort(surface));
  // O teto das cópias de nome — outro literal nosso, não parâmetro.
  const teto = sql.raw(String(MCP_SESSION_LABEL_MAX));

  // Os três UPDATEs leem o RETURNING de `ins`: sem skill, `ins` é vazio e
  // nenhum deles toca linha alguma; sem vMCP, o vínculo não casa; com
  // vínculo direto, `catalog_uuids` é vazio e os catálogos ficam. No
  // mcp-admin os três ficam de fora — a linha entra, os contadores não.
  const counters =
    origin === 'mcp-admin'
      ? sql``
      : sql`,
    global AS (
      UPDATE skills s SET ${column} = s.${column} + 1
      FROM ins WHERE s.uuid = ins.skill_uuid
    ),
    direct AS (
      UPDATE virtual_mcp_skills v SET ${column} = v.${column} + 1
      FROM ins WHERE v.virtual_mcp_uuid = ins.virtual_mcp_uuid AND v.skill_uuid = ins.skill_uuid
    ),
    via AS (
      UPDATE catalogs c SET ${column} = c.${column} + 1
      FROM ins WHERE c.uuid = ANY(ins.catalog_uuids)
    )`;

  // `ins` grava a linha com as cópias resolvidas por LEFT JOIN (o que não
  // existe vira nulo, sem derrubar o INSERT) e com os catálogos do caminho
  // em `p` — só quando há vMCP e **não** há vínculo direto, a precedência
  // de `docs/11` §3.2, e só os que servem a porta desta leitura (`porta`).
  // A precedência (`NOT EXISTS`) fica sem porta, idêntica à de `exposedIn`.
  // O nome é cortado dentro do `array_agg`, ordenado pelo nome inteiro: os
  // três arrays continuam posição a posição (o CHECK de cardinalidade do 018).
  await db().execute(sql`
    WITH ins AS (
      INSERT INTO skill_accesses (
        skill_uuid, skill_slug, skill_name, kind, surface, origin, auth,
        virtual_mcp_uuid, virtual_mcp_slug, virtual_mcp_name,
        catalog_uuids, catalog_slugs, catalog_names,
        key_id, key_name, api_key_id, api_key_name, user_uuid, user_email,
        session_id, ip, user_agent, client_name, client_version
      )
      SELECT
        s.uuid, s.slug, left(s.name, ${teto}), ${kind}, ${surface}, ${origin}, ${auth},
        m.uuid, m.slug, left(m.name, ${teto}),
        COALESCE(p.uuids, '{}'::uuid[]), COALESCE(p.slugs, '{}'::text[]), COALESCE(p.names, '{}'::text[]),
        k.id, left(k.name, ${teto}), ak.id, left(ak.name, ${teto}), u.uuid, u.email,
        ${sessionLabel(input.sessionId, 'sessionId')},
        ${sessionLabel(input.ip, 'ip')},
        ${sessionLabel(input.userAgent, 'userAgent')},
        ${sessionLabel(input.clientName, 'clientName')},
        ${sessionLabel(input.clientVersion, 'clientVersion')}
      FROM skills s
      LEFT JOIN virtual_mcps m ON m.uuid = ${virtualMcpUuid}::uuid
      LEFT JOIN virtual_mcp_keys k ON k.id = ${keyId}::uuid
      LEFT JOIN api_keys ak ON ak.id = ${apiKeyId}::uuid
      LEFT JOIN users u ON u.uuid = ${userUuid}::uuid
      LEFT JOIN LATERAL (
        SELECT array_agg(c.uuid ORDER BY c.name, c.slug) AS uuids,
               array_agg(c.slug ORDER BY c.name, c.slug) AS slugs,
               array_agg(left(c.name, ${teto}) ORDER BY c.name, c.slug) AS names
        FROM catalogs c
        JOIN catalog_skills cs
          ON cs.catalog_uuid = c.uuid AND cs.skill_uuid = s.uuid AND cs.is_active
        JOIN virtual_mcp_catalogs vc
          ON vc.catalog_uuid = c.uuid AND vc.virtual_mcp_uuid = m.uuid AND ${porta}
        WHERE c.is_active
          AND NOT EXISTS (
            SELECT 1 FROM virtual_mcp_skills v
            WHERE v.virtual_mcp_uuid = m.uuid AND v.skill_uuid = s.uuid
          )
      ) p ON true
      WHERE s.uuid = ${input.skillUuid}::uuid
      RETURNING skill_uuid, virtual_mcp_uuid, catalog_uuids
    )${counters}
    SELECT count(*)::int AS n FROM ins
  `);
}

export type ListSkillAccessesOptions = {
  /** A guia da skill. */
  skillUuid?: string;
  /** A guia do catálogo: leituras em que ele foi (um dos) caminho(s). */
  catalogUuid?: string;
  /** A guia do servidor. */
  virtualMcpUuid?: string;
  /** A guia da conta: as leituras feitas por ela (pelas chaves `psk_`, no mcp-admin). */
  userUuid?: string;
  /** Uma chave `psk_` só — normalmente junto com `userUuid`. */
  apiKeyId?: string;
  /** `ILIKE %q%` em `user_email`, `api_key_name`, `key_name`, `ip`, `client_name` e `session_id`. */
  q?: string;
  /** Igualdade; fora do `CHECK` é 400. */
  origin?: SkillAccessOrigin;
  kind?: SkillAccessKind;
  /** Clamp 1..200; padrão 50. */
  limit?: number;
  offset?: number;
};

// `a` é o acesso. Os catálogos vêm dos três arrays, na ordem gravada
// (`WITH ORDINALITY`), com o uuid conferido em `catalogs`: o de um catálogo
// apagado sai nulo, o mesmo sinal das outras FKs — só que calculado aqui,
// porque array não tem `ON DELETE SET NULL`.
const SKILL_ACCESS_COLUMNS = sql`
  a.id, a.skill_uuid, a.skill_slug, a.skill_name, a.kind, a.surface, a.origin, a.auth,
  a.virtual_mcp_uuid, a.virtual_mcp_slug, a.virtual_mcp_name,
  COALESCE((
    SELECT json_agg(json_build_object('uuid', c.uuid, 'slug', p.slug, 'name', p.name)
                    ORDER BY p.ord)
    FROM unnest(a.catalog_uuids, a.catalog_slugs, a.catalog_names)
         WITH ORDINALITY AS p(uuid, slug, name, ord)
    LEFT JOIN catalogs c ON c.uuid = p.uuid
  ), '[]'::json) AS catalogs,
  a.key_id, a.key_name, a.api_key_id, a.api_key_name, a.user_uuid, a.user_email,
  a.session_id, a.ip, a.user_agent, a.client_name, a.client_version, a.created_at
`;

function toSkillAccessEntry(row: Row): SkillAccessEntry {
  const raw = (typeof row.catalogs === 'string' ? JSON.parse(row.catalogs) : row.catalogs) as
    | Row[]
    | null;
  return {
    id: row.id,
    skillUuid: row.skill_uuid ?? null,
    skillSlug: row.skill_slug,
    skillName: row.skill_name,
    kind: row.kind,
    surface: row.surface,
    origin: row.origin,
    auth: row.auth,
    virtualMcpUuid: row.virtual_mcp_uuid ?? null,
    virtualMcpSlug: row.virtual_mcp_slug ?? null,
    virtualMcpName: row.virtual_mcp_name ?? null,
    catalogs: (raw ?? []).map((c) => ({ uuid: c.uuid ?? null, slug: c.slug, name: c.name })),
    keyId: row.key_id ?? null,
    keyName: row.key_name ?? null,
    apiKeyId: row.api_key_id ?? null,
    apiKeyName: row.api_key_name ?? null,
    userUuid: row.user_uuid ?? null,
    userEmail: row.user_email ?? null,
    sessionId: row.session_id ?? null,
    ip: row.ip ?? null,
    userAgent: row.user_agent ?? null,
    clientName: row.client_name ?? null,
    clientVersion: row.client_version ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * A guia "Acessos": as últimas leituras (`created_at DESC, id DESC`), de uma
 * skill, de um catálogo (quando ele foi o caminho), de um vMCP ou de uma
 * conta (e/ou de uma chave `psk_` dela), com os filtros da tela. `total`
 * respeita os mesmos filtros da página. Uuid torto
 * em qualquer filtro é 400, como em `listMcpSessions`; `q` vazio é ignorado.
 * Uma leitura de skill, vMCP ou catálogo já apagados continua na lista, com
 * as cópias. O filtro pela skill ou pelo vMCP apagados não a acha mais (a
 * coluna foi a nulo); o filtro pelo catálogo apagado ainda acha, porque o
 * array guarda o uuid — a página dele já não existe, e o histórico fica
 * alcançável por quem tiver o uuid.
 */
export async function listSkillAccesses(
  options: ListSkillAccessesOptions = {},
): Promise<SkillAccessPage> {
  const limit = clamp(options.limit ?? 50, 1, 200);
  const offset = pageOffset(options.offset);
  const conditions: SQL[] = [];

  if (options.skillUuid !== undefined) {
    if (!isUuid(options.skillUuid)) throw badRequest('O campo "skillUuid" precisa ser um uuid');
    conditions.push(sql`a.skill_uuid = ${options.skillUuid}::uuid`);
  }
  if (options.catalogUuid !== undefined) {
    if (!isUuid(options.catalogUuid)) throw badRequest('O campo "catalogUuid" precisa ser um uuid');
    conditions.push(sql`a.catalog_uuids @> ARRAY[${options.catalogUuid}::uuid]`);
  }
  if (options.virtualMcpUuid !== undefined) {
    if (!isUuid(options.virtualMcpUuid)) {
      throw badRequest('O campo "virtualMcpUuid" precisa ser um uuid');
    }
    conditions.push(sql`a.virtual_mcp_uuid = ${options.virtualMcpUuid}::uuid`);
  }
  if (options.userUuid !== undefined) {
    if (!isUuid(options.userUuid)) throw badRequest('O campo "userUuid" precisa ser um uuid');
    conditions.push(sql`a.user_uuid = ${options.userUuid}::uuid`);
  }
  if (options.apiKeyId !== undefined) {
    if (!isUuid(options.apiKeyId)) throw badRequest('O campo "apiKeyId" precisa ser um uuid');
    conditions.push(sql`a.api_key_id = ${options.apiKeyId}::uuid`);
  }
  if (options.origin !== undefined) {
    conditions.push(sql`a.origin = ${oneOf(options.origin, SKILL_ACCESS_ORIGINS, 'origin')}`);
  }
  if (options.kind !== undefined) {
    conditions.push(sql`a.kind = ${oneOf(options.kind, SKILL_ACCESS_KINDS, 'kind')}`);
  }
  const q = normalizeQuery(optionalText(options.q, 'q'));
  if (q) {
    const pattern = likePattern(q);
    conditions.push(sql`(
      a.user_email ILIKE ${pattern}
      OR a.api_key_name ILIKE ${pattern}
      OR a.key_name ILIKE ${pattern}
      OR a.ip ILIKE ${pattern}
      OR a.client_name ILIKE ${pattern}
      OR a.session_id ILIKE ${pattern}
    )`);
  }

  const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const counted = await db().execute(
    sql`SELECT count(*)::int AS total FROM skill_accesses a ${where}`,
  );
  const total = Number((counted.rows as Row[])[0]?.total ?? 0);

  const result = await db().execute(sql`
    SELECT ${SKILL_ACCESS_COLUMNS}
    FROM skill_accesses a
    ${where}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return { items: (result.rows as Row[]).map(toSkillAccessEntry), total, limit, offset };
}

// -------------------------------------------------------------------- RAG ---

/**
 * As chaves de `settings` da busca semântica (`docs/14-rag.md` §4.3).
 * `rag.driver` e `rag.model` são semeadas pelo ambiente no
 * primeiro boot do admin e, dali em diante, mandam sobre ele — quem decide é
 * o banco; `rag.indexer.status` é o estado que só o indexador conhece (a
 * chave da API não chega ao painel), regravado a cada ciclo.
 */
export const RAG_SETTING_KEYS = ['rag.driver', 'rag.model', 'rag.indexer.status'] as const;
export type RagSettingKey = (typeof RAG_SETTING_KEYS)[number];

/** As duas que o ambiente semeia e o painel edita — as que entram na auditoria. */
export const RAG_EDITABLE_SETTINGS = ['rag.driver', 'rag.model'] as const;
export type RagEditableSetting = (typeof RAG_EDITABLE_SETTINGS)[number];

/** Quem assina a semeadura pelo ambiente (§4.1): não é conta, como o bootstrap. */
const RAG_SEED_ACTOR: AuditActor = { userUuid: null, label: 'ambiente' };

/** Teto do JSON de `rag.indexer.status` — o estado descrito na §4.3 cabe folgado. */
const RAG_STATUS_MAX = 8_192;

/** Teto de cada prefixo, o mesmo do `rag_spaces_prefix_length_chk`. */
const RAG_PREFIX_MAX = 200;

/** Uma linha de `settings` do RAG: o valor em uso e quando ele mudou. */
export type RagSettingRow = {
  key: RagSettingKey;
  value: string | null;
  updatedAt: string;
};

/**
 * O que está gravado, chave a chave. A chave **ausente** do objeto é o que
 * distingue "o banco ainda não tem linha" (o ambiente semeia) de "o banco
 * diz nada" — ver `seedRagSetting`.
 */
export type RagSettings = Partial<Record<RagSettingKey, RagSettingRow>>;

/** As três chaves do RAG que estão gravadas. Chave sem linha não aparece. */
export async function getRagSettings(): Promise<RagSettings> {
  const result = await db().execute(sql`
    SELECT key, value, updated_at
    FROM settings
    WHERE key = ANY(${sql.param([...RAG_SETTING_KEYS])}::text[])
  `);

  const settings: RagSettings = {};
  for (const row of result.rows as Row[]) {
    const key = row.key as RagSettingKey;
    settings[key] = {
      key,
      value: row.value ?? null,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }
  return settings;
}

/** O resultado de uma semeadura: se gravou e qual valor ficou valendo. */
export type RagSeedResult = {
  /** `false` quando já havia linha — o ambiente foi ignorado. */
  written: boolean;
  /** O valor em uso depois da chamada: o semeado, ou o que já estava lá. */
  value: string | null;
};

/**
 * Semeia uma chave com o valor do ambiente (§4.1): grava **só** quando o
 * banco ainda não tem linha para ela, e devolve o que ficou valendo — é com
 * isso que o admin decide avisar no log que a variável foi ignorada.
 *
 * Quem semeia é o boot do admin, e só ele. A linha gravada entra na
 * auditoria com o ator `ambiente`; quando não grava, nada é auditado — senão
 * a trilha ganharia uma linha por reinício de container.
 */
export async function seedRagSetting(
  key: RagEditableSetting,
  value: string,
  source: AuditSource = 'web-admin',
): Promise<RagSeedResult> {
  const chave = oneOf(key, RAG_EDITABLE_SETTINGS, 'key');
  const valor = ragSettingValue(value);

  return db().transaction(async (tx) => {
    const inserted = await tx.execute(sql`
      INSERT INTO settings (key, value) VALUES (${chave}, ${valor})
      ON CONFLICT (key) DO NOTHING
      RETURNING value
    `);
    if ((inserted.rows as Row[]).length > 0) {
      await auditTx(tx, {
        skillUuid: null,
        skillSlug: null,
        filePath: null,
        action: 'rag.settings',
        source,
        previousContent: null,
        actor: RAG_SEED_ACTOR,
        targetLabel: `${chave}=${valor}`,
      });
      return { written: true, value: valor };
    }

    const current = await tx.execute(sql`SELECT value FROM settings WHERE key = ${chave}`);
    return { written: false, value: (current.rows as Row[])[0]?.value ?? null };
  });
}

/**
 * Grava uma das chaves editáveis pelo painel e audita `rag.settings`, com
 * `chave=valor` em `target_label`. **O sentido do valor é do app**: o que é
 * um driver ou um modelo válido está no registro de `packages/rag`, não aqui
 * — o banco só garante que é texto não vazio e dentro do tamanho.
 *
 * `rag.indexer.status` não passa por aqui (400): ele é do indexador, é
 * regravado a cada ciclo e auditá-lo inundaria a trilha — ver
 * `setRagIndexerStatus`.
 */
export async function setRagSetting(
  key: RagEditableSetting,
  value: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<RagSettings> {
  const chave = oneOf(key, RAG_EDITABLE_SETTINGS, 'key');
  const valor = ragSettingValue(value);

  await db().transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO settings (key, value) VALUES (${chave}, ${valor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
    await auditTx(tx, {
      skillUuid: null,
      skillSlug: null,
      filePath: null,
      action: 'rag.settings',
      source,
      previousContent: null,
      actor,
      targetLabel: `${chave}=${valor}`,
    });
  });

  return getRagSettings();
}

/**
 * O estado do indexador (§4.3), gravado a cada ciclo: um objeto JSON com o
 * que só ele sabe — se a chave da API existe, quando rodou, qual foi o
 * último erro. Sem auditoria e sem ator de propósito: é telemetria, não
 * decisão de ninguém. O formato do objeto é do indexador; o banco guarda o
 * JSON como texto e só limita o tamanho.
 */
export async function setRagIndexerStatus(status: Record<string, unknown>): Promise<void> {
  if (typeof status !== 'object' || status === null || Array.isArray(status)) {
    throw badRequest('O estado do indexador deve ser um objeto');
  }
  let json: string;
  try {
    json = JSON.stringify(status);
  } catch {
    throw badRequest('O estado do indexador precisa ser serializável em JSON');
  }
  if (json.length > RAG_STATUS_MAX) {
    throw badRequest(`O estado do indexador passa de ${RAG_STATUS_MAX} caracteres`);
  }

  await db().execute(sql`
    INSERT INTO settings (key, value) VALUES ('rag.indexer.status', ${json})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
}

/**
 * A identidade de um espaço de embedding (§5.1): driver, modelo, dimensões e
 * os **dois prefixos** do driver. Trocar qualquer um deles é outro espaço —
 * no `gemini-embedding-2` a tarefa vai escrita no próprio texto enviado, e um
 * prefixo diferente muda todo vetor. Os prefixos não são aparados: o espaço
 * em branco do fim de `'title: none | text: '` faz parte do prefixo.
 */
export type RagSpaceInput = {
  driver: string;
  model: string;
  dimensions: number;
  documentPrefix: string;
  queryPrefix: string;
};

export type RagSpace = RagSpaceInput & {
  uuid: string;
  createdAt: string;
};

/**
 * Acha (ou cria) o espaço com essa identidade e devolve a linha. Quem chama é
 * o **indexador**: os leitores usam `findRagSpace`, que não cria nada — uma
 * busca não pode inaugurar um espaço vazio e responder que não há vetor.
 *
 * Duas chamadas com a mesma identidade devolvem o mesmo uuid, inclusive em
 * paralelo (o `ON CONFLICT DO NOTHING` sobre `rag_spaces_identity_uniq`).
 */
export async function resolveRagSpace(input: RagSpaceInput): Promise<RagSpace> {
  const space = ragSpaceInput(input);

  await db().execute(sql`
    INSERT INTO rag_spaces (driver, model, dimensions, document_prefix, query_prefix)
    VALUES (${space.driver}, ${space.model}, ${space.dimensions},
            ${space.documentPrefix}, ${space.queryPrefix})
    ON CONFLICT (driver, model, dimensions, document_prefix, query_prefix) DO NOTHING
  `);

  const found = await findRagSpace(space);
  // Só acontece se alguém apagar o espaço entre o INSERT e o SELECT.
  if (!found) throw conflict('O espaço de embedding sumiu durante a criação');
  return found;
}

/** O espaço com essa identidade, ou `null`. Não cria nada — é o que os leitores usam. */
export async function findRagSpace(input: RagSpaceInput): Promise<RagSpace | null> {
  const space = ragSpaceInput(input);

  const result = await db().execute(sql`
    SELECT uuid, driver, model, dimensions, document_prefix, query_prefix, created_at
    FROM rag_spaces
    WHERE driver = ${space.driver}
      AND model = ${space.model}
      AND dimensions = ${space.dimensions}
      AND document_prefix = ${space.documentPrefix}
      AND query_prefix = ${space.queryPrefix}
  `);

  const row = (result.rows as Row[])[0];
  if (!row) return null;
  return {
    uuid: row.uuid as string,
    driver: row.driver as string,
    model: row.model as string,
    dimensions: Number(row.dimensions),
    documentPrefix: row.document_prefix as string,
    queryPrefix: row.query_prefix as string,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * As tabelas do RAG existem? É o que o indexador pergunta antes de começar
 * (e o que os leitores conferem uma vez), para **esperar** a migration em vez
 * de cair: o container do indexador sobe junto com o do banco e pode chegar
 * antes do `migrate`.
 *
 * São **seis**: `rag_text_status` entrou na `025`, porque a fila de textos
 * passou a excluir o que está reservado ou recusado, e `rag_skill_claims` na
 * `028`, porque a reserva de skills passou a gravar o prazo nela. Num banco
 * parado antes disso a reserva falharia a cada ciclo; com a tabela na conta, o
 * indexador espera a migration, que é o comportamento desenhado. Quem busca
 * (site, MCP público) cai na busca textual enquanto espera, e só guarda a
 * resposta quando ela é "pronto".
 */
export async function ragSchemaReady(): Promise<boolean> {
  const result = await db().execute(sql`
    SELECT to_regclass('public.rag_spaces') IS NOT NULL
       AND to_regclass('public.rag_texts') IS NOT NULL
       AND to_regclass('public.rag_skill_texts') IS NOT NULL
       AND to_regclass('public.rag_vectors') IS NOT NULL
       AND to_regclass('public.rag_text_status') IS NOT NULL
       AND to_regclass('public.rag_skill_claims') IS NOT NULL AS pronto
  `);
  return Boolean((result.rows as Row[])[0]?.pronto);
}

/** Opções de `claimStaleSkills`. */
export type ClaimStaleSkillsOptions = {
  /**
   * Prazo da reserva, em milissegundos (clamp 1 s .. 1 h; padrão 10 min). É o
   * tempo que um indexador **morto** segura as skills do lote: vencido, elas
   * voltam à fila sozinhas. Precisa cobrir o laço de refatiação inteiro — ler,
   * dividir e gravar o lote todo —, não uma skill. Curto demais, a réplica
   * vizinha retoma uma skill que ainda está sendo refatiada; o resultado é
   * trabalho repetido, nunca dado errado (`replaceSkillTexts` é declarativa).
   */
  claimMs?: number;
};

/** O prazo padrão da reserva de skills: o mesmo da de textos no indexador. */
const RAG_CLAIM_DEFAULT_MS = 600_000;

/**
 * Leituras começadas e não terminadas a partir das quais a reserva vencida
 * deixa de ser retomada (`028`). Três é o bastante para distinguir a skill que
 * **derruba** o indexador de um azar — um deploy no meio do lote, o banco
 * reiniciando — e pouco o bastante para o *crash-loop* durar meia hora, não
 * para sempre.
 */
export const RAG_CLAIM_MAX_ATTEMPTS = 3;

/**
 * Reserva até `limit` skills pendentes e as marca como limpas **antes** de o
 * indexador ler o conteúdo: uma mudança feita durante o processamento volta a
 * marcá-las pelo trigger, e nada se perde. Se o processamento falhar, quem
 * desfaz é `releaseStaleSkill`.
 *
 * A reserva é **gravada com prazo** em `rag_skill_claims` (`028`), na mesma
 * statement. Antes, a única memória de que o lote ainda precisava de trabalho
 * era uma variável do indexador: processo morto no meio do lote (SIGKILL, OOM,
 * o banco caindo junto com a devolução do `catch`) deixava as skills restantes
 * como "feitas" para sempre, com o painel mostrando zero pendências. Entram no
 * lote, portanto, dois tipos de skill:
 *
 *   * a **pendente** (`rag_stale`) sem reserva viva. Reserva viva segura até a
 *     skill que o trigger remarcou: um indexador por skill de cada vez — sem
 *     isso, duas réplicas podiam ler versões diferentes e a mais lenta gravar a
 *     antiga por cima da nova. A contagem de tentativas recomeça: conteúdo novo
 *     (ou o "Reindexar") é uma chance nova;
 *   * a de **reserva vencida** e ainda não pendente — a que um indexador morto
 *     deixou para trás —, enquanto `attempts` não bate em
 *     `RAG_CLAIM_MAX_ATTEMPTS`. No teto ela para de voltar e aparece em
 *     `ragCoverage().stuckSkills`.
 *
 * As vencidas têm prioridade na **escolha** (são poucas e já esperaram o prazo
 * inteiro; um acervo recém-marcado para reindexar não pode deixá-las para
 * depois) e vêm por último na **ordem devolvida**, por tentativas: processe na
 * ordem. É o que faz a skill que derruba o processo cair no fim do lote, depois
 * de as companheiras terem sido gravadas.
 *
 * As CTEs são `MATERIALIZED` de propósito: sem isso o planner pode empurrar o
 * `LIMIT` para depois do `UPDATE` e reservar mais linhas do que o lote pedido
 * (§5.5, cenário 22). O `SKIP LOCKED` é o que faz dois indexadores em paralelo
 * pegarem lotes diferentes em vez de esperar um pelo outro — a statement nunca
 * espera uma linha de `skills`, e por isso não fecha ciclo com quem grava
 * arquivo. O `DO UPDATE … WHERE until <= now()` é a segunda trava: a reserva
 * vencida que o vizinho retomou entre a leitura e a gravação não é tomada, e só
 * sai no resultado o que esta chamada de fato reservou.
 */
export async function claimStaleSkills(
  limit = 20,
  options: ClaimStaleSkillsOptions = {},
): Promise<string[]> {
  const size = clamp(limit, 1, 500);
  const prazo =
    options.claimMs === undefined || options.claimMs === null
      ? RAG_CLAIM_DEFAULT_MS
      : clamp(requireCount(options.claimMs, 'claimMs'), RAG_RESERVE_MIN_MS, RAG_RESERVE_MAX_MS);

  const result = await db().execute(sql`
    WITH vencidas AS MATERIALIZED (
      SELECT s.uuid, s.updated_at, c.attempts
        FROM rag_skill_claims c
        JOIN skills s ON s.uuid = c.skill_uuid
       WHERE c.until <= now()
         AND NOT s.rag_stale
         AND c.attempts < ${RAG_CLAIM_MAX_ATTEMPTS}
       ORDER BY c.attempts, s.updated_at, s.uuid
       LIMIT ${size}
         FOR UPDATE OF s SKIP LOCKED
    ),
    frescas AS MATERIALIZED (
      SELECT s.uuid, s.updated_at
        FROM skills s
       WHERE s.rag_stale
         AND NOT EXISTS (
           SELECT 1 FROM rag_skill_claims c
            WHERE c.skill_uuid = s.uuid AND c.until > now()
         )
       ORDER BY s.updated_at, s.uuid
       LIMIT ${size}
         FOR UPDATE OF s SKIP LOCKED
    ),
    escolhidas AS MATERIALIZED (
      SELECT * FROM (
        SELECT uuid, updated_at, attempts, false AS fresca FROM vencidas
        UNION ALL
        SELECT uuid, updated_at, 0, true FROM frescas
      ) candidatas
      ORDER BY fresca, attempts, updated_at, uuid
      LIMIT ${size}
    ),
    reservas AS (
      INSERT INTO rag_skill_claims (skill_uuid, until, attempts)
      SELECT e.uuid, now() + make_interval(secs => ${prazo}::float8 / 1000), 0
        FROM escolhidas e
      ON CONFLICT (skill_uuid) DO UPDATE
         SET until = EXCLUDED.until,
             attempts = CASE
               WHEN (SELECT e.fresca FROM escolhidas e WHERE e.uuid = rag_skill_claims.skill_uuid)
               THEN 0
               ELSE rag_skill_claims.attempts
             END,
             updated_at = now()
       WHERE rag_skill_claims.until <= now()
      RETURNING skill_uuid
    ),
    limpas AS (
      UPDATE skills s
         SET rag_stale = false
        FROM reservas r
       WHERE s.uuid = r.skill_uuid AND s.rag_stale
    )
    SELECT e.uuid
      FROM reservas r
      JOIN escolhidas e ON e.uuid = r.skill_uuid
     ORDER BY e.fresca DESC, e.attempts, e.updated_at, e.uuid
  `);
  return (result.rows as Row[]).map((row) => row.uuid as string);
}

/**
 * Devolve a skill à fila depois de uma falha: volta a ficar pendente e perde a
 * reserva, então a rodada seguinte a pega — sem esperar o prazo. Uuid torto é
 * ignorado: isto roda no `catch` do indexador, e um segundo erro aqui
 * esconderia o primeiro.
 *
 * São **duas** statements, cada uma com a sua trava, e nesta ordem de
 * propósito. Uma statement só travaria a linha de `skills` e a da reserva
 * juntas, na ordem inversa à de `claimStaleSkills`, e é assim que se fecha um
 * ciclo. E se o processo morrer entre as duas, a skill fica pendente **com** a
 * reserva viva: espera o prazo e volta. Na ordem contrária ela ficaria sem
 * nenhuma das duas marcas — perdida, que é o defeito que a `028` corrige.
 */
export async function releaseStaleSkill(uuid: string): Promise<void> {
  if (!isUuid(uuid)) return;
  await db().execute(sql`
    UPDATE skills SET rag_stale = true WHERE uuid = ${uuid}::uuid AND NOT rag_stale
  `);
  await db().execute(sql`DELETE FROM rag_skill_claims WHERE skill_uuid = ${uuid}::uuid`);
}

/** Um arquivo de texto da skill, como o indexador o recebe para dividir. */
export type RagSkillFile = {
  id: string;
  relativePath: string;
  content: string;
  /**
   * `files.content_sha256`. Num arquivo que cabe inteiro num texto canônico
   * ele **é** o hash do texto (§5.2): nenhuma normalização entra no meio.
   */
  sha256: Buffer;
  sizeBytes: number;
};

/** Tudo que o indexador precisa para refatiar uma skill: metadados e arquivos de texto. */
export type RagSkillContent = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Em ordem alfabética — a divisão precisa ser determinística (§5.3). */
  tags: string[];
  /** Só os de texto, por caminho. Binário não é embutido. */
  files: RagSkillFile[];
};

/**
 * Lê a skill reservada. `null` quando ela sumiu entre a reserva e a leitura —
 * caso normal, não erro: o indexador passa para a próxima.
 *
 * É também o **"comecei"** do indexador: havendo reserva (`rag_skill_claims`,
 * `028`), a leitura soma uma tentativa nela **antes** de carregar o conteúdo —
 * é carregando os arquivos que um acervo enorme derruba o processo, e a conta
 * precisa estar gravada quando isso acontecer. Terminar (`replaceSkillTexts`) ou
 * devolver (`releaseStaleSkill`) apaga a reserva e a conta com ela; só sobra
 * tentativa na skill cuja leitura começou e nunca acabou. Contar na reserva, em
 * vez de aqui, puniria as companheiras de lote que nem chegaram a ser abertas.
 * Sem reserva (um teste, um relatório) a leitura não escreve nada.
 */
export async function readSkillForRag(uuid: string): Promise<RagSkillContent | null> {
  if (!isUuid(uuid)) return null;

  await db().execute(sql`
    UPDATE rag_skill_claims
       SET attempts = attempts + 1, updated_at = now()
     WHERE skill_uuid = ${uuid}::uuid
  `);

  const result = await db().execute(sql`
    SELECT s.uuid, s.slug, s.name, s.description,
           COALESCE((
             SELECT array_agg(t.name ORDER BY t.name)
             FROM skill_tags st JOIN tags t ON t.id = st.tag_id
             WHERE st.skill_uuid = s.uuid
           ), '{}') AS tags
    FROM skills s
    WHERE s.uuid = ${uuid}::uuid
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  const files = await db().execute(sql`
    SELECT id, relative_path, text_content, content_sha256, size_bytes
    FROM files
    WHERE skill_uuid = ${uuid}::uuid AND text_content IS NOT NULL
    ORDER BY relative_path
  `);

  return {
    uuid: row.uuid as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    tags: (row.tags ?? []) as string[],
    files: (files.rows as Row[]).map((file) => ({
      id: file.id as string,
      relativePath: file.relative_path as string,
      content: (file.text_content as string) ?? '',
      sha256: file.content_sha256 as Buffer,
      sizeBytes: Number(file.size_bytes ?? 0),
    })),
  };
}

/**
 * Uma ocorrência: onde um texto canônico aparece dentro da skill.
 *
 * `source: 'meta'` é o texto de metadados (nome, descrição e tags), um por
 * skill, sem caminho nem arquivo; `source: 'file'` é uma parte de um arquivo,
 * com o caminho, o `fileId` e o número da parte, de 0 em diante na ordem do
 * arquivo. O `content` é o texto **canônico** — sem o prefixo do driver, que
 * só entra na chamada à API.
 */
export type RagTextInput = {
  source: 'meta' | 'file';
  content: string;
  /** Vazio (ou omitido) em `meta`; o caminho do arquivo em `file`. */
  relativePath?: string;
  /** A parte, de 0 em diante; padrão 0. */
  part?: number;
  /** Nulo (ou omitido) em `meta`; o id do arquivo em `file`. */
  fileId?: string | null;
};

/**
 * Reescreve, numa transação, **todas** as ocorrências da skill: apaga as
 * antigas e grava a lista inteira. Os textos canônicos entram em `rag_texts`
 * com `ON CONFLICT DO NOTHING` — dois arquivos iguais, na mesma skill ou em
 * skills diferentes, viram uma linha só e um vetor só por espaço (§5.2).
 *
 * O hash é calculado **no banco**, a partir do próprio conteúdo: assim o
 * texto nunca fica guardado sob o hash de outro, e o `rag_texts_sha256_chk`
 * não tem como ser contrariado. Lista vazia apaga as ocorrências da skill e
 * não grava nada — é o caso da skill sem texto nenhum.
 *
 * Devolve quantas ocorrências ficaram. Conteúdo vazio ou só com espaços é 400
 * (§5.3: arquivo em branco não gera texto), assim como ocorrência repetida,
 * fonte fora das duas, parte negativa e `fileId` torto.
 *
 * Gravar é **terminar**: a reserva da skill (`rag_skill_claims`, `028`) é
 * apagada em seguida, e com ela a contagem de tentativas. O indexador não
 * precisa chamar mais nada no caminho feliz.
 */
export async function replaceSkillTexts(
  skillUuid: string,
  texts: readonly RagTextInput[],
): Promise<number> {
  if (!isUuid(skillUuid)) throw badRequest(`Uuid de skill inválido: ${String(skillUuid)}`);
  if (!Array.isArray(texts)) throw badRequest('O campo "texts" deve ser uma lista');

  const enderecos = new Set<string>();
  const ocorrencias = texts.map((text, index) => {
    const source = oneOf(text?.source, ['meta', 'file'] as const, `texts[${index}].source`);
    const content = typeof text?.content === 'string' ? text.content : '';
    if (!content.trim()) throw badRequest(`O texto de "texts[${index}]" está vazio`);

    const part = requireCount(text?.part ?? 0, `texts[${index}].part`);
    const relativePath = (optionalText(text?.relativePath, `texts[${index}].relativePath`) ?? '').trim();
    const fileId = text?.fileId ?? null;

    if (source === 'meta' && (relativePath !== '' || fileId !== null)) {
      throw badRequest(`A fonte "meta" de "texts[${index}]" não tem arquivo nem caminho`);
    }
    if (source === 'file') {
      if (!relativePath) throw badRequest(`O caminho de "texts[${index}]" é obrigatório`);
      if (!isUuid(fileId)) throw badRequest(`O arquivo de "texts[${index}]" é inválido`);
    }

    // Separador que não cabe num caminho nem em `source`: `optionalText` já
    // recusou o nulo. Pela constante, não pelo escape — ver `NUL`.
    const endereco = `${source}${NUL}${relativePath}${NUL}${part}`;
    if (enderecos.has(endereco)) throw badRequest(`Ocorrência repetida em "texts[${index}]"`);
    enderecos.add(endereco);

    return { source, content, relativePath, part, fileId: source === 'file' ? (fileId as string) : null };
  });

  const total = await db().transaction(async (tx) => {
    const skill = await tx.execute(sql`SELECT 1 FROM skills WHERE uuid = ${skillUuid}::uuid`);
    if ((skill.rows as Row[]).length === 0) throw notFound(`Skill não encontrada: ${skillUuid}`);

    await tx.execute(sql`DELETE FROM rag_skill_texts WHERE skill_uuid = ${skillUuid}::uuid`);
    if (ocorrencias.length === 0) return 0;

    const conteudos = [...new Set(ocorrencias.map((o) => o.content))];
    await tx.execute(sql`
      INSERT INTO rag_texts (sha256, content)
      SELECT sha256(convert_to(c, 'UTF8')), c
      FROM unnest(${sql.param(conteudos)}::text[]) AS c
      ON CONFLICT (sha256) DO NOTHING
    `);

    const linhas = ocorrencias.map(
      (o) => sql`(${skillUuid}::uuid, ${o.source}, ${o.relativePath}, ${o.part},
                  ${o.fileId}::uuid, sha256(convert_to(${o.content}, 'UTF8')))`,
    );
    try {
      await tx.execute(sql`
        INSERT INTO rag_skill_texts (skill_uuid, source, relative_path, part, file_id, text_sha256)
        VALUES ${sql.join(linhas, sql`, `)}
      `);
    } catch (err) {
      // O arquivo pode ter sumido entre a leitura da skill e a gravação.
      if (isForeignKeyViolation(err)) throw badRequest('Arquivo não encontrado na skill');
      throw err;
    }
    return ocorrencias.length;
  });

  // O trabalho terminou: a reserva da skill (`028`) sai. **Depois** do commit e
  // em statement própria, de propósito — dentro da transação acima a trava da
  // reserva conviveria com as de `rag_texts`, `files` e `skills` (as FKs das
  // ocorrências), e `claimStaleSkills` trava `skills` antes da reserva: é a
  // ordem inversa, e ordem inversa é deadlock. Uma statement que segura uma
  // trava só não fecha ciclo. Se o processo morrer entre o commit e esta linha,
  // a reserva vence e a skill é refatiada uma vez a mais — declarativo e de
  // graça.
  await db().execute(sql`DELETE FROM rag_skill_claims WHERE skill_uuid = ${skillUuid}::uuid`);
  return total;
}

/** Um texto canônico ainda sem vetor no espaço ativo. */
export type RagPendingText = {
  /** Os 32 bytes do SHA-256 — é assim que ele volta em `insertRagVectors`. */
  sha256: Buffer;
  content: string;
};

/** Opções de `listPendingRagTexts`. */
export type PendingRagTextsOptions = {
  /**
   * Prazo da reserva, em milissegundos (clamp 1 s .. 1 h). Informado, a
   * chamada **grava** uma reserva por texto devolvido (`rag_text_status`,
   * `025`) e devolve **só** os textos que ela conseguiu reservar: é o que
   * impede duas réplicas do indexador de pagar pelo mesmo embedding.
   *
   * Omitido, a consulta é leitura pura, como antes — quem só quer saber o que
   * falta (um relatório, um teste) não escreve nada, e dois leitores recebem a
   * mesma lista.
   *
   * O prazo precisa cobrir o caminho **todo** do texto: a chamada ao provedor
   * e a gravação do vetor. Curto demais, dois indexadores voltam a se
   * atropelar (o pior caso é o de hoje, não é perda de dado); longo demais, um
   * indexador morto segura o texto até vencer. `insertRagVectors` apaga a
   * reserva de quem chegou ao vetor, então o prazo só vale para quem ainda não
   * terminou.
   */
  reserveMs?: number;
};

/** Piso e teto do prazo de reserva: 1 s e 1 h. */
const RAG_RESERVE_MIN_MS = 1_000;
const RAG_RESERVE_MAX_MS = 3_600_000;

/**
 * Os textos **com ocorrência** que ainda não têm vetor no espaço, dos mais
 * antigos para os mais novos. Texto órfão (sem ocorrência) fica de fora: ele
 * não é buscável, e embuti-lo custaria dinheiro à toa.
 *
 * Também ficam de fora os textos que o provedor **recusou** neste espaço e os
 * que outro indexador **reservou** e ainda tem no prazo (`rag_text_status`,
 * `025`). Sem a primeira exclusão, o texto recusado é o mais antigo sem vetor
 * para sempre e nada atrás dele chega a ser tentado; sem a segunda, duas
 * réplicas leem a mesma fila e pagam duas vezes pelo mesmo embedding.
 *
 * Com `reserveMs`, a leitura e a reserva são **uma** statement: não há janela
 * entre "vi que estava livre" e "marquei como meu". Quem perde a corrida
 * recebe só o que sobrou; se o vizinho levou o lote inteiro, a chamada tenta
 * **uma** segunda vez e alcança o que está atrás na fila. Chame-a fora de uma
 * transação comprida: enquanto a statement não commita, o indexador vizinho
 * espera a linha da reserva.
 */
export async function listPendingRagTexts(
  spaceUuid: string,
  limit = 64,
  options: PendingRagTextsOptions = {},
): Promise<RagPendingText[]> {
  if (!isUuid(spaceUuid)) throw badRequest(`Uuid de espaço inválido: ${String(spaceUuid)}`);
  const size = clamp(limit, 1, 500);
  const prazo =
    options.reserveMs === undefined || options.reserveMs === null
      ? null
      : clamp(requireCount(options.reserveMs, 'reserveMs'), RAG_RESERVE_MIN_MS, RAG_RESERVE_MAX_MS);

  // `until > now()` é a reserva viva: vencida, o texto volta à fila sozinho —
  // indexador morto não estaciona a fila. A recusa não tem prazo.
  const candidatos = sql`
    SELECT t.sha256, t.content, t.created_at
    FROM rag_texts t
    WHERE EXISTS (SELECT 1 FROM rag_skill_texts o WHERE o.text_sha256 = t.sha256)
      AND NOT EXISTS (
        SELECT 1 FROM rag_vectors v
        WHERE v.space_uuid = ${spaceUuid}::uuid AND v.text_sha256 = t.sha256
      )
      AND NOT EXISTS (
        SELECT 1 FROM rag_text_status s
        WHERE s.space_uuid = ${spaceUuid}::uuid AND s.text_sha256 = t.sha256
          AND (s.state = 'recusado' OR s.until > now())
      )
    ORDER BY t.created_at
    LIMIT ${size}
  `;

  // A CTE é `MATERIALIZED` pelo motivo de `claimStaleSkills`: o lote é o que o
  // `LIMIT` escolheu, uma vez só. O `DO UPDATE` com `WHERE` é o que resolve a
  // corrida — quem chega depois espera a linha do vizinho, reencontra a reserva
  // viva, não atualiza nada e, por isso, não recebe o texto no resultado. Só a
  // reserva **vencida** é tomada. Os dois inserem na ordem de `created_at`,
  // então não há ciclo de bloqueio (a lição do `replaceTagsTx`).
  const consulta = prazo
    ? sql`
        WITH candidatos AS MATERIALIZED (${candidatos}),
        reserva AS (
          INSERT INTO rag_text_status (space_uuid, text_sha256, state, until)
          SELECT ${spaceUuid}::uuid, c.sha256, 'reservado',
                 now() + make_interval(secs => ${prazo}::float8 / 1000)
          FROM candidatos c
          ON CONFLICT (space_uuid, text_sha256) DO UPDATE
             SET until = EXCLUDED.until, updated_at = now()
           WHERE rag_text_status.state = 'reservado' AND rag_text_status.until <= now()
          RETURNING text_sha256
        )
        SELECT c.sha256, c.content, (r.text_sha256 IS NOT NULL) AS reservado
        FROM candidatos c LEFT JOIN reserva r ON r.text_sha256 = c.sha256
        ORDER BY c.created_at
      `
    : candidatos;

  // O `LEFT JOIN` traz os candidatos com a marca de quem esta chamada
  // conseguiu reservar: sem a marca, outro indexador levou o texto enquanto
  // isto rodava. Daí as **duas** tentativas: quando o vizinho leva o lote
  // inteiro, a segunda passada já vê a reserva dele e alcança o que está
  // atrás na fila, em vez de a réplica que perdeu a corrida ficar um ciclo
  // parada com a fila cheia. Candidato nenhum é fila vazia — aí não há
  // segunda passada.
  for (let tentativa = 0; tentativa < (prazo ? 2 : 1); tentativa += 1) {
    const linhas = (await db().execute(consulta)).rows as Row[];
    const meus = prazo ? linhas.filter((row) => Boolean(row.reservado)) : linhas;
    if (meus.length > 0 || linhas.length === 0) {
      return meus.map((row) => ({
        sha256: row.sha256 as Buffer,
        content: row.content as string,
      }));
    }
  }
  return [];
}

/**
 * Tira o texto da fila deste espaço **de vez**: o provedor recusou o conteúdo
 * (entrada longa demais, caractere que ele não aceita) e insistir é pagar por
 * um erro garantido. A recusa é por par (espaço, texto) — outro modelo pode
 * aceitar o que este recusou.
 *
 * **Chame só com prova de que o problema é o conteúdo**: o provedor aceitou
 * outro texto nas mesmas condições (mesma chave, URL, modelo e formato). Um 400
 * sozinho não prova isso — os três drivers jogam todo 400 residual em "recusa
 * de conteúdo", e o que é da instalação (proxy, contrato da API, conta) atinge
 * todo texto. A marca é permanente e nenhuma gravação automática a desfaz; sem
 * prova, o caminho é `releaseRagTextReservations` (com `retryAfterMs` para tirar
 * o texto da cabeça da fila sem condená-lo), e o reparo de uma marca gravada
 * por engano é `clearRagRefusals`.
 *
 * Idempotente, e é o contrário de `DO NOTHING`: a linha que está lá é a
 * **reserva** do próprio indexador que acabou de levar a recusa, e deixá-la
 * como está devolveria o texto à fila no vencimento. O `DO UPDATE` converte a
 * reserva em recusa; uma segunda recusa do mesmo texto não reescreve nada
 * (`WHERE state <> 'recusado'`), então `reason` e `created_at` continuam sendo
 * os da recusa que tirou o texto da fila.
 *
 * Espaço ou texto que já não existe não grava nada, em vez de lançar: isto roda
 * no tratamento de erro do indexador, e um segundo erro aqui esconderia o
 * primeiro. Uuid torto e hash de tamanho errado continuam sendo 400 — são erro
 * de chamada, não corrida.
 */
export async function markRagTextRefused(
  spaceUuid: string,
  sha256: Buffer,
  reason: string,
): Promise<void> {
  if (!isUuid(spaceUuid)) throw badRequest(`Uuid de espaço inválido: ${String(spaceUuid)}`);
  if (!Buffer.isBuffer(sha256) || sha256.length !== 32) {
    throw badRequest('O campo "sha256" deve ter 32 bytes');
  }
  // O CHECK do banco corta em 500; cortar aqui evita transformar uma mensagem
  // de provedor comprida numa falha de gravação no meio do tratamento de erro.
  const motivo = (typeof reason === 'string' ? reason.trim() : '').slice(0, 500) || null;

  await db().execute(sql`
    INSERT INTO rag_text_status (space_uuid, text_sha256, state, until, reason)
    SELECT sp.uuid, t.sha256, 'recusado', NULL, ${motivo}
    FROM rag_spaces sp, rag_texts t
    WHERE sp.uuid = ${spaceUuid}::uuid AND t.sha256 = ${sha256}::bytea
    ON CONFLICT (space_uuid, text_sha256) DO UPDATE
       SET state = 'recusado', until = NULL, reason = EXCLUDED.reason, updated_at = now()
     WHERE rag_text_status.state <> 'recusado'
  `);
}

/**
 * Desfaz as recusas de **um** espaço: no ciclo seguinte os textos voltam à fila.
 * É reparo manual e auditado, não expiração — a recusa continua sem prazo e
 * intocada por qualquer gravação automática (`025`).
 *
 * Existe para o dia em que a marca foi gravada **por engano**. Os três drivers
 * jogam todo 400 residual em `RagInputTooLongError`, e um 400 que é da
 * instalação — `RAG_<DRIVER>_BASE_URL` apontando para um intermediário que não
 * entende um campo, contrato de API que mudou, erro de conta devolvido como 400
 * — atinge **todo** texto: o acervo inteiro vira "recusado para sempre", 64
 * textos por ciclo, sem um erro no painel. Corrigida a causa, nada voltava
 * sozinho: "Reindexar" reinsere o mesmo texto sob o mesmo hash (mesma linha,
 * mesma recusa), reiniciar o container deixou de limpar desde que a marca foi
 * para o banco, e o driver `google` só tem um modelo para trocar.
 *
 * O que for recusa genuína é recusado **uma vez mais** e remarcado — o mesmo
 * custo que a `025` aceita para o texto recusado que é coletado e volta ao
 * acervo. A reserva não é tocada, nem outro espaço. Devolve quantas saíram.
 *
 * Audita como `rag.reindex`, com `"<n> recusas"` no lugar de `"<n> skills"`: é
 * a mesma família ("tente de novo o que já foi tentado"), e uma ação própria
 * pediria reescrever o `CHECK` de `audit_log.action` e o tipo de shared por um
 * botão de reparo. Espaço inexistente não apaga nada e audita `"0 recusas"` — o
 * gesto do admin aconteceu. Uuid torto é 400.
 *
 * A memória do **processo** do indexador (`RecusasRag`) não é alcançada daqui:
 * quem chama isto precisa fazer o indexador esquecer a lista dele (ou
 * reiniciá-lo), senão ele reserva os textos e os descarta em memória.
 */
export async function clearRagRefusals(
  spaceUuid: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<number> {
  if (!isUuid(spaceUuid)) throw badRequest(`Uuid de espaço inválido: ${String(spaceUuid)}`);
  return db().transaction(async (tx) => {
    const result = await tx.execute(sql`
      DELETE FROM rag_text_status
      WHERE space_uuid = ${spaceUuid}::uuid AND state = 'recusado'
      RETURNING text_sha256
    `);
    const total = (result.rows as Row[]).length;
    await auditTx(tx, {
      skillUuid: null,
      skillSlug: null,
      filePath: null,
      action: 'rag.reindex',
      source,
      previousContent: null,
      actor,
      targetLabel: `${total} recusas`,
    });
    return total;
  });
}

/**
 * Apaga os textos canônicos **sem ocorrência nenhuma** e, pela cascata de
 * `rag_vectors` e de `rag_text_status`, os vetores e o estado de fila deles.
 * Devolve quantos saíram.
 *
 * Editar ou apagar uma skill deixa texto para trás: `replaceSkillTexts` apaga
 * as ocorrências, e a FK de `rag_skill_texts.text_sha256` é sem cascata de
 * propósito (texto **em uso** não pode ser apagado). Sem coleta, esses textos e
 * os vetores de 3072 dimensões que eles custaram ficam para sempre — a `020`
 * chamava isso de "limpeza futura", e esta é ela. Quem chama é o indexador, no
 * fim de cada ciclo, quando todo `replaceSkillTexts` da rodada já commitou.
 *
 * Duas proteções contra a gravação concorrente de uma ocorrência para um texto
 * que **agora** é órfão:
 *
 *   * `FOR UPDATE SKIP LOCKED` deixa de fora o texto que outra transação já
 *     travou (a checagem da FK toma `FOR KEY SHARE` na linha de `rag_texts`);
 *   * a violação de FK é lida como "não coletei", e não como erro: a ocorrência
 *     que entrou no meio do caminho é o dado certo, e o texto volta a ser órfão
 *     — se voltar — na rodada seguinte.
 */
export async function collectOrphanRagTexts(limit = 500): Promise<number> {
  const size = clamp(limit, 1, 5_000);
  try {
    const result = await db().execute(sql`
      WITH orfaos AS MATERIALIZED (
        SELECT t.sha256
        FROM rag_texts t
        WHERE NOT EXISTS (SELECT 1 FROM rag_skill_texts o WHERE o.text_sha256 = t.sha256)
        ORDER BY t.created_at
        LIMIT ${size}
          FOR UPDATE SKIP LOCKED
      )
      DELETE FROM rag_texts t
      USING orfaos o
      WHERE t.sha256 = o.sha256
      RETURNING t.sha256
    `);
    return (result.rows as Row[]).length;
  } catch (err) {
    // 23503: alguém gravou uma ocorrência para um destes textos entre a
    // varredura e o DELETE. O lote inteiro fica para a próxima rodada.
    if (isForeignKeyViolation(err)) return 0;
    throw err;
  }
}

/** Um vetor pronto: o hash do texto que o gerou e o embedding. */
export type RagVectorInput = {
  sha256: Buffer;
  embedding: readonly number[];
};

/**
 * Grava os vetores no espaço. A `dimensions` de cada linha vem do **espaço**,
 * não do chamador: é a FK composta que a prende, e o CHECK recusa um vetor de
 * outro tamanho (§5.4). Espaço inexistente não grava nada; vetor já gravado é
 * ignorado (`ON CONFLICT DO NOTHING`) — reprocessar um lote é inofensivo.
 *
 * O `JOIN rag_texts` deixa de fora o hash cujo texto **sumiu** entre a leitura
 * da fila e a volta do provedor — a janela que a coleta de órfãos
 * (`collectOrphanRagTexts`) abre. Sem ele, um hash coletado derrubaria o lote
 * inteiro pela FK, levando com ele os vetores bons e o que eles custaram.
 *
 * Grava também o fim da reserva: a linha `reservado` de `rag_text_status`
 * (`025`) some para todo hash do lote, tenha o vetor entrado ou já estado lá.
 * Ela existe para reservar o pagamento, e o pagamento acabou; quem passa a
 * excluir o texto da fila é o próprio `rag_vectors`. A **recusa** não é tocada.
 *
 * Devolve quantos entraram.
 */
export async function insertRagVectors(
  spaceUuid: string,
  vectors: readonly RagVectorInput[],
): Promise<number> {
  if (!isUuid(spaceUuid)) throw badRequest(`Uuid de espaço inválido: ${String(spaceUuid)}`);
  if (!Array.isArray(vectors)) throw badRequest('O campo "vectors" deve ser uma lista');
  if (vectors.length === 0) return 0;

  const linhas = vectors.map((item, index) => {
    if (!Buffer.isBuffer(item?.sha256) || item.sha256.length !== 32) {
      throw badRequest(`O hash de "vectors[${index}]" deve ter 32 bytes`);
    }
    return sql`(${item.sha256}::bytea, ${ragVectorLiteral(item?.embedding, `vectors[${index}]`)}::vector)`;
  });

  const result = await db().execute(sql`
    WITH entrada AS MATERIALIZED (
      SELECT * FROM (VALUES ${sql.join(linhas, sql`, `)}) AS v(sha256, embedding)
    ),
    gravados AS (
      INSERT INTO rag_vectors (space_uuid, dimensions, text_sha256, embedding)
      SELECT sp.uuid, sp.dimensions, e.sha256, e.embedding
      FROM entrada e
      JOIN rag_texts t ON t.sha256 = e.sha256
      CROSS JOIN rag_spaces sp
      WHERE sp.uuid = ${spaceUuid}::uuid
      ON CONFLICT (space_uuid, text_sha256) DO NOTHING
      RETURNING text_sha256
    ),
    liberadas AS (
      DELETE FROM rag_text_status s
      USING entrada e
      WHERE s.space_uuid = ${spaceUuid}::uuid
        AND s.text_sha256 = e.sha256
        AND s.state = 'reservado'
    )
    SELECT text_sha256 FROM gravados
  `);
  return (result.rows as Row[]).length;
}

/** Opções de `releaseRagTextReservations`. */
export type ReleaseRagTextsOptions = {
  /**
   * Em vez de devolver os textos **já**, marca a volta para daqui a tantos
   * milissegundos (clamp 1 s .. 24 h): a reserva continua lá, com o prazo novo,
   * e a fila só os reentrega quando ele vencer.
   *
   * É o estado que faltava entre "tente no próximo ciclo" e "nunca mais": o
   * texto que levou um 400 **sem prova** de que o problema é o conteúdo (nada
   * foi aceito neste ciclo) sai da cabeça da fila sem ganhar uma marca
   * permanente; e o lote que bateu no limite de taxa pode esperar o
   * `Retry-After` em vez de voltar em 30 segundos. Não guarda motivo — quem
   * explica é o log do indexador.
   */
  retryAfterMs?: number;
};

/** Teto do adiamento: um dia. Mais que isso é recusa, e recusa tem função própria. */
const RAG_RETRY_AFTER_MAX_MS = 86_400_000;

/**
 * Devolve à fila os textos que um indexador reservou e **não** resolveu: o lote
 * falhou por motivo que não é o conteúdo (chave, cota, 5xx, prazo estourado,
 * erro ao gravar o vetor), ou nem chegou a ser tentado porque um lote anterior
 * dos mesmos 64 falhou. Sem isto a reserva da `025` só tinha duas saídas — o
 * vetor gravado e o vencimento —, e o indexador **vivo** que desistia do lote o
 * segurava por dez minutos: o ciclo seguinte reservava os 64 seguintes, falhava
 * de novo, e com a fila inteira reservada passava a publicar "sem erro" com
 * centenas de textos sem vetor.
 *
 * Só toca linha `reservado`: a recusa é para sempre e não é mexida por aqui.
 * Hash sem reserva (já ganhou vetor, já foi recusado, já venceu e foi coletado)
 * é ignorado, assim como espaço que não existe — isto roda no tratamento de
 * erro do indexador. Uuid torto e hash fora de 32 bytes continuam 400: são erro
 * de chamada, não corrida. Devolve quantas reservas saíram (ou foram adiadas).
 *
 * **A reserva não tem dono.** Chamar isto depois de a própria reserva ter
 * vencido pode baixar a que outra réplica acabou de tomar; o pior caso é o que a
 * `025` já aceita por escrito — duas réplicas pagam pelo mesmo texto —, nunca
 * perda de dado, e só acontece se o ciclo que falhou durou mais que o prazo.
 *
 * As linhas são travadas na ordem de `rag_texts.created_at`, a mesma em que
 * `listPendingRagTexts` as grava: duas statements que pegam o mesmo conjunto na
 * mesma ordem esperam uma pela outra em vez de se travarem em cruz.
 */
export async function releaseRagTextReservations(
  spaceUuid: string,
  hashes: readonly Buffer[],
  options: ReleaseRagTextsOptions = {},
): Promise<number> {
  if (!isUuid(spaceUuid)) throw badRequest(`Uuid de espaço inválido: ${String(spaceUuid)}`);
  if (!Array.isArray(hashes)) throw badRequest('O campo "hashes" deve ser uma lista');
  const adiar =
    options.retryAfterMs === undefined || options.retryAfterMs === null
      ? null
      : clamp(
          requireCount(options.retryAfterMs, 'retryAfterMs'),
          RAG_RESERVE_MIN_MS,
          RAG_RETRY_AFTER_MAX_MS,
        );
  if (hashes.length === 0) return 0;

  const valores = hashes.map((hash, index) => {
    if (!Buffer.isBuffer(hash) || hash.length !== 32) {
      throw badRequest(`O hash de "hashes[${index}]" deve ter 32 bytes`);
    }
    return sql`${hash}::bytea`;
  });

  const alvo = sql`
    SELECT s.text_sha256
      FROM rag_text_status s
      JOIN rag_texts t ON t.sha256 = s.text_sha256
     WHERE s.space_uuid = ${spaceUuid}::uuid
       AND s.state = 'reservado'
       AND s.text_sha256 IN (${sql.join(valores, sql`, `)})
     ORDER BY t.created_at
       FOR UPDATE OF s
  `;

  const result = await db().execute(
    adiar === null
      ? sql`
          WITH alvo AS MATERIALIZED (${alvo})
          DELETE FROM rag_text_status s
           USING alvo a
           WHERE s.space_uuid = ${spaceUuid}::uuid AND s.text_sha256 = a.text_sha256
          RETURNING s.text_sha256
        `
      : sql`
          WITH alvo AS MATERIALIZED (${alvo})
          UPDATE rag_text_status s
             SET until = now() + make_interval(secs => ${adiar}::float8 / 1000), updated_at = now()
            FROM alvo a
           WHERE s.space_uuid = ${spaceUuid}::uuid AND s.text_sha256 = a.text_sha256
          RETURNING s.text_sha256
        `,
  );
  return (result.rows as Row[]).length;
}

/** O número da seção "Busca semântica" do painel (§9). */
export type RagCoverage = {
  /** Textos canônicos com ocorrência — o denominador da cobertura. */
  texts: number;
  /** Quantos deles já têm vetor no espaço. */
  withVector: number;
  /** `texts - withVector`: o que o indexador ainda vai embutir. */
  pendingTexts: number;
  /**
   * Quantos dos pendentes o provedor **recusou** de vez neste espaço (`025`).
   *
   * Está **dentro** de `pendingTexts`, de propósito: a cobertura que não fecha
   * é um fato, e este número é a explicação dela. Sem ele o painel mostraria
   * pendência eterna sem dizer por quê.
   */
  refusedTexts: number;
  /**
   * Skills que ainda precisam ser refatiadas: as marcadas (`rag_stale`) **mais**
   * as reservadas e não terminadas (`rag_skill_claims`, `028`). Sem a segunda
   * parcela o lote que um indexador morto deixou para trás contava como feito, e
   * o painel mostrava zero pendências com skills fora da busca.
   */
  staleSkills: number;
  /**
   * Quantas delas estão **travadas**: a reserva venceu com
   * `RAG_CLAIM_MAX_ATTEMPTS` leituras começadas e nenhuma terminada, e o
   * indexador não as retoma sozinho — é a skill que o derruba. Está **dentro**
   * de `staleSkills`, como `refusedTexts` está dentro de `pendingTexts`: a
   * pendência é real, e este número é a explicação dela. Editar a skill ou
   * "Reindexar" dá uma chance nova.
   *
   * `ragCoverage` sempre o devolve; é opcional no tipo para não quebrar quem
   * monta um `RagCoverage` à mão.
   */
  stuckSkills?: number;
};

/**
 * Cobertura do espaço e pendências. `spaceUuid` nulo (ou torto) é o caso do
 * driver desligado: nenhum texto tem vetor, e os números continuam dizendo o
 * tamanho do acervo.
 */
export async function ragCoverage(spaceUuid: string | null): Promise<RagCoverage> {
  const space = optionalUuid(spaceUuid);
  const result = await db().execute(sql`
    SELECT
      (SELECT count(DISTINCT o.text_sha256) FROM rag_skill_texts o)::int AS texts,
      (SELECT count(DISTINCT o.text_sha256)
         FROM rag_skill_texts o
         JOIN rag_vectors v ON v.space_uuid = ${space}::uuid AND v.text_sha256 = o.text_sha256
      )::int AS com_vetor,
      -- Só os recusados que **têm ocorrência**: é o mesmo denominador da
      -- coluna texts, senão o número não caberia dentro da pendência.
      (SELECT count(DISTINCT o.text_sha256)
         FROM rag_skill_texts o
         JOIN rag_text_status s ON s.space_uuid = ${space}::uuid
                               AND s.text_sha256 = o.text_sha256
                               AND s.state = 'recusado'
      )::int AS recusados,
      -- Duas parcelas, e não um OR: a primeira continua no índice parcial
      -- skills_rag_stale_idx; a segunda varre rag_skill_claims, que tem no
      -- máximo um lote por réplica. Um OR … EXISTS varreria skills inteira a
      -- cada ciclo do indexador e a cada abertura do painel.
      (
        (SELECT count(*) FROM skills WHERE rag_stale)
        + (SELECT count(*) FROM rag_skill_claims c
             JOIN skills s ON s.uuid = c.skill_uuid
            WHERE NOT s.rag_stale)
      )::int AS pendentes,
      (SELECT count(*) FROM rag_skill_claims c
         JOIN skills s ON s.uuid = c.skill_uuid
        WHERE NOT s.rag_stale
          AND c.until <= now()
          AND c.attempts >= ${RAG_CLAIM_MAX_ATTEMPTS}
      )::int AS travadas
  `);

  const row = (result.rows as Row[])[0] ?? {};
  const texts = Number(row.texts ?? 0);
  const withVector = Number(row.com_vetor ?? 0);
  return {
    texts,
    withVector,
    pendingTexts: texts - withVector,
    refusedTexts: Number(row.recusados ?? 0),
    staleSkills: Number(row.pendentes ?? 0),
    stuckSkills: Number(row.travadas ?? 0),
  };
}

/**
 * O botão "Reindexar" do painel: marca todo o acervo como pendente. **Não
 * apaga vetor nenhum** — o que ele refaz é a divisão em textos, e o texto que
 * não mudou reaproveita o vetor que já existe. Não toca `updated_at`:
 * reindexar não é publicar, e a ordenação "recentes" do site não muda.
 *
 * Devolve quantas skills passaram a pendentes e audita `rag.reindex`.
 */
export async function markAllSkillsStale(source: AuditSource, actor: AuditActor): Promise<number> {
  return db().transaction(async (tx) => {
    const result = await tx.execute(sql`
      UPDATE skills SET rag_stale = true WHERE NOT rag_stale RETURNING uuid
    `);
    const total = (result.rows as Row[]).length;
    await auditTx(tx, {
      skillUuid: null,
      skillSlug: null,
      filePath: null,
      action: 'rag.reindex',
      source,
      previousContent: null,
      actor,
      targetLabel: `${total} skills`,
    });
    return total;
  });
}

/** Valor de `settings` do RAG: texto não vazio, aparado, até 200 caracteres. */
function ragSettingValue(value: unknown): string {
  const text = requireText(value, 'value');
  if (text.length > 200) throw badRequest('O valor da configuração passa de 200 caracteres');
  return text;
}

/**
 * Um prefixo do driver: texto (vazio é válido — há driver que não escreve a
 * tarefa no texto) de até 200 caracteres, **sem aparar**. O espaço do fim de
 * `'title: none | text: '` faz parte do prefixo e muda o vetor.
 */
function ragPrefix(value: unknown, field: string): string {
  if (typeof value !== 'string') throw badRequest(`O campo "${field}" é obrigatório`);
  if (value.length > RAG_PREFIX_MAX) {
    throw badRequest(`O campo "${field}" passa de ${RAG_PREFIX_MAX} caracteres`);
  }
  return value;
}

/** A identidade do espaço, validada. */
function ragSpaceInput(input: RagSpaceInput): RagSpaceInput {
  const dimensions = input?.dimensions;
  if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw badRequest('O campo "dimensions" deve ser um inteiro maior que zero');
  }
  return {
    driver: requireText(input?.driver, 'driver'),
    model: requireText(input?.model, 'model'),
    dimensions,
    documentPrefix: ragPrefix(input?.documentPrefix, 'documentPrefix'),
    queryPrefix: ragPrefix(input?.queryPrefix, 'queryPrefix'),
  };
}

/** Um embedding no formato textual do pgvector (`[x,y,z]`). */
function ragVectorLiteral(value: unknown, field: string): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(`O campo "${field}" deve ser uma lista de números`);
  }
  const numbers = value.map((n) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw badRequest(`O campo "${field}" tem valor que não é número finito`);
    }
    return n;
  });
  return `[${numbers.join(',')}]`;
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

/**
 * Rótulo opcional de sessão: ausente é nulo, outro tipo é 400 e o texto passa
 * por `normalizeSessionLabel` (sem controle, aparado, vazio vira nulo, cortado
 * no teto). A checagem de tipo é local, e não a de `optionalText`, de
 * propósito: aquela **recusa** o byte nulo com 400, e aqui ele é limpo — numa
 * escrita best-effort o registro vale mais do que o campo (`tasks/038`).
 */
function sessionLabel(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest(`O campo "${field}" deve ser uma string`);
  return normalizeSessionLabel(value);
}

// --------------------------------------------------------------- internos ---

async function requireSkill(slug: string): Promise<SkillSummary> {
  const skill = await getSkillSummary(slug, { visibility: 'all' });
  if (!skill) throw notFound(`Skill não encontrada: ${slug}`);
  return skill;
}

/**
 * Slugs → uuids numa tabela com `slug` único, dentro da transação de uma
 * escrita declarativa. Qualquer slug desconhecido é 400 com a lista inteira
 * dos que faltam (`label` é o começo da mensagem), e nada é gravado. O nome
 * da tabela é um dos dois literais nossos — nunca texto do chamador.
 */
async function resolveSlugsTx(
  tx: Tx,
  table: 'skills' | 'catalogs',
  slugs: readonly string[],
  label: string,
): Promise<Map<string, string>> {
  const bySlug = new Map<string, string>();
  if (slugs.length > 0) {
    const found = await tx.execute(sql`
      SELECT uuid, slug FROM ${sql.raw(table)} WHERE slug = ANY(${sql.param([...slugs])}::text[])
    `);
    for (const row of found.rows as Row[]) bySlug.set(row.slug as string, row.uuid as string);
  }
  const missing = slugs.filter((slug) => !bySlug.has(slug));
  if (missing.length > 0) throw badRequest(`${label}: ${missing.join(', ')}`);
  return bySlug;
}

async function resolveSkillSlugsTx(tx: Tx, slugs: readonly string[]): Promise<Map<string, string>> {
  return resolveSlugsTx(tx, 'skills', slugs, 'Skills não encontradas');
}

/**
 * O menor prefixo que o slug desejado e **todo** desempate numérico de
 * `uniqueSlug` têm em comum. O teto do slug é 96 (`MAX_SLUG` de shared, que não é
 * exportado): perto dele o sufixo `-2`…`-9999` não cabe, `withSuffix` encurta a
 * base e o candidato deixa de começar por `desired` — no máximo 5 caracteres de
 * sufixo e 1 hífen aparado no corte (o `slugify` colapsa hífens), 96 − 5 − 1.
 * Se o teto de shared mudar, este número muda junto; o teste dos homônimos de
 * nome longo (`virtual-mcps.integration.test.ts`) é quem acusa.
 */
const SLUG_SCAN_PREFIX = 90;

/**
 * Os slugs que podem colidir com `desired` numa das três tabelas que geram slug
 * a partir do nome — o que `uniqueSlug` recebe como `taken`.
 *
 * No caso comum é a consulta de sempre: o próprio slug e os desempates
 * `desired-N`. Acima de `SLUG_SCAN_PREFIX` ela **não via** os desempates
 * encurtados (`tasks/035`): com `desired` de 96 caracteres o segundo homônimo
 * vira `<94 caracteres>-2`, que não casa `desired-%`; o terceiro recebia o mesmo
 * slug de novo, o INSERT batia no UNIQUE, as três tentativas de `SLUG_ATTEMPTS`
 * eram idênticas e a criação respondia 409 citando um slug que ninguém pediu —
 * para sempre, não só sob concorrência. Ali a busca passa a ser pelo prefixo
 * comum, que **contém** os outros dois padrões; linha a mais é inofensiva,
 * `uniqueSlug` só testa pertinência.
 *
 * Um padrão só, e não os três com `OR`, de propósito: medido em 52 mil skills,
 * cada `LIKE` de ~90 caracteres pelo GIN de trigrama é estimado caro (muitos
 * trigramas) e dois deles faziam o planejador trocar o `BitmapOr` por varredura
 * (2,7 ms → 6,3 ms); o padrão único mantém o `skills_slug_trgm_idx` e os 2,7 ms.
 *
 * O `LIKE` de prefixo **fica**: reescrevê-lo como faixa (`>=`/`<`) devolve zero
 * linhas na coleção do cluster (`en_US.utf8` ignora o hífen no nível primário —
 * ver "O termo de busca" no README). `desired` sai do `slugify`, só `[a-z0-9-]`:
 * não há `%` nem `_` a escapar. O nome da tabela é um dos três literais nossos,
 * nunca texto do chamador — como em `resolveSlugsTx`.
 */
async function takenSlugs(
  table: 'skills' | 'virtual_mcps' | 'catalogs',
  desired: string,
): Promise<string[]> {
  const where =
    desired.length > SLUG_SCAN_PREFIX
      ? sql`slug LIKE ${desired.slice(0, SLUG_SCAN_PREFIX) + '%'}`
      : sql`slug = ${desired} OR slug LIKE ${desired + '-%'}`;
  const result = await db().execute(sql`SELECT slug FROM ${sql.raw(table)} WHERE ${where}`);
  return (result.rows as Row[]).map((row) => row.slug as string);
}

/**
 * O slug de uma skill: o pedido, se veio, ou um livre a partir do nome.
 *
 * Slug **pedido** passa por `isValidSlug`, como em `assertVirtualMcpSlug` e
 * `assertCatalogSlug` (`tasks/049`): antes, `slug: "Minha Skill!"` respondia 201
 * com `minha-skill` — um endereço que o cliente não pediu, não guardou e não
 * consegue reenviar na edição (a validação do lado dele recusa o que ele mandou).
 * Slug **gerado** a partir do nome continua passando pelo `slugify`, que é
 * justamente o que o torna válido; o teto de 96 caracteres de `uniqueSlug` é
 * parte disso (`tasks/046`).
 */
async function resolveSlug(requested: string | undefined, fallbackName: string): Promise<string> {
  const asked = requested?.trim();
  if (asked && !isValidSlug(asked)) throw badRequest(`Slug inválido: "${asked}"`);

  const desired = slugify(asked || fallbackName) || 'skill';
  const slug = uniqueSlug(desired, await takenSlugs('skills', desired));

  if (asked && slug !== desired) {
    throw conflict(`Já existe uma skill com o slug "${desired}"`);
  }
  return slug;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Como um arquivo vai para `files`: ver `fileColumns`. */
type FileColumns = {
  mimeType: string;
  isText: boolean;
  sizeBytes: number;
  text: string | null;
  binary: Buffer | null;
};

/**
 * A regra única de gravação de arquivo: o mime pela extensão; texto quando o
 * mime é textual, não há byte nulo **e os bytes são UTF-8 válido**, binário no
 * resto (`files_one_content_chk` exige exatamente um dos dois); o tamanho em
 * bytes. Conteúdo vazio vale nos dois casos — `''` num texto, `bytea` vazio num
 * binário, nunca `NULL`. Servem-se dela o INSERT (`insertFileSql`) e o
 * `SkillFileMeta` que as escritas devolvem.
 *
 * A régua é `isTextualContent` de shared — a mesma que o `extractZip` usa, para
 * o pacote e o banco não discordarem (`tasks/015`). Um `.csv` em Windows-1252
 * tem mime textual e nenhum byte nulo, e `toString('utf8')` **não falha** com
 * ele: troca cada byte inválido por U+FFFD, sem erro e sem volta — `preço` virava
 * `pre�o` para sempre, com `size_bytes` do original e conteúdo de outro tamanho.
 * Esse arquivo é binário: guardado byte a byte e baixado igual ao que chegou.
 *
 * O `SKILL.md` é o único caminho que **tem** de ser texto: é ele que
 * `readTextFile`, o `search_vector` e o RAG leem. Gravado como binário, a skill
 * ficaria com o corpo vazio para todo leitor, sem erro — por isso é 400 aqui, em
 * vez de trocar uma corrupção silenciosa por um sumiço silencioso.
 */
function fileColumns(path: string, buffer: Buffer): FileColumns {
  const mimeType = mimeTypeFor(path);
  const isText = isTextualContent(mimeType, buffer);
  if (!isText && isSkillMd(path)) {
    throw badRequest('O SKILL.md precisa ser um texto UTF-8 válido, sem byte nulo');
  }
  return {
    mimeType,
    isText,
    sizeBytes: buffer.byteLength,
    text: isText ? buffer.toString('utf8') : null,
    binary: isText ? null : buffer,
  };
}

/** As colunas do INSERT de arquivo — a forma de uma linha e a de lote usam a mesma. */
const FILE_INSERT_COLUMNS = sql`(skill_uuid, relative_path, text_content, binary_content, mime_type, size_bytes)`;

/** O INSERT de um arquivo, sem a cláusula de conflito — quem chama decide. */
function insertFileSql(skillUuid: string, path: string, file: FileColumns): SQL {
  return sql`
    INSERT INTO files ${FILE_INSERT_COLUMNS}
    VALUES (${skillUuid}, ${path}, ${file.text}, ${file.binary}, ${file.mimeType}, ${file.sizeBytes})
  `;
}

/**
 * O `DO UPDATE` das gravações de arquivo. O conflito é inferido pelo índice
 * `files_skill_path_lower_uniq` (migration `003`): gravar `Notas.md` sobre
 * `notas.md` sobrescreve a linha existente em vez de criar uma segunda, e a
 * caixa recebida vira a definitiva — caso contrário a listagem continuaria
 * mostrando o nome antigo.
 */
const FILE_UPSERT_CONFLICT = sql`
  ON CONFLICT (skill_uuid, lower(relative_path)) DO UPDATE SET
    relative_path = EXCLUDED.relative_path,
    text_content = EXCLUDED.text_content,
    binary_content = EXCLUDED.binary_content,
    mime_type = EXCLUDED.mime_type,
    size_bytes = EXCLUDED.size_bytes,
    updated_at = now()
`;

/**
 * O teto de um lote de arquivos numa statement só. O limite do protocolo são
 * 65535 parâmetros — ~10 900 arquivos com seis colunas —, mas quem manda aqui é
 * o **byte**: um `.zip` de 200 imagens viraria uma mensagem de centenas de MiB
 * montada inteira na memória do Node e do Postgres. O lote fecha no primeiro dos
 * dois limites.
 */
const FILE_BATCH_ROWS = 200;
const FILE_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * Upsert de vários arquivos da mesma skill em **poucas** statements: um `.zip`
 * de 200 arquivos era 200 idas ao banco (`tasks/049`).
 *
 * Duas coisas que a forma em lote exige e o laço não exigia:
 *
 * - **deduplicar por `lower(relative_path)` — o do Postgres, não o
 *   `toLowerCase()` do JS —, mantendo a última ocorrência.** O alvo do conflito
 *   é um índice sobre `lower(...)`, e um pacote que traga `Notas.md` e
 *   `notas.md` juntos faria o Postgres recusar a statement inteira com *"ON
 *   CONFLICT DO UPDATE command cannot affect row a second time"* (21000). No
 *   laço a última gravação vencia em silêncio, e é esse resultado — uma linha,
 *   com a última grafia e o último conteúdo — que fica. Com a chave feita no
 *   JS, `İ.md` e `I.md` passavam por diferentes e caíam na mesma chave do
 *   índice: o 21000 que o dedupe existe para evitar (`tasks/017`);
 * - **fatiar o lote** por linha e por byte (ver acima).
 */
async function upsertFilesTx(
  tx: Tx,
  skillUuid: string,
  files: readonly { path: string; buffer: Buffer }[],
): Promise<void> {
  const keys = await foldPathsTx(tx, files.map((file) => file.path));
  const unique = new Map<string, { path: string; buffer: Buffer }>();
  files.forEach((file, index) => unique.set(keys[index]!, file));

  let rows: SQL[] = [];
  let bytes = 0;

  const flush = async () => {
    if (rows.length === 0) return;
    await tx.execute(sql`
      INSERT INTO files ${FILE_INSERT_COLUMNS}
      VALUES ${sql.join(rows, sql`, `)}
      ${FILE_UPSERT_CONFLICT}
    `);
    rows = [];
    bytes = 0;
  };

  for (const { path, buffer } of unique.values()) {
    const file = fileColumns(path, buffer);
    rows.push(
      sql`(${skillUuid}, ${path}, ${file.text}, ${file.binary}, ${file.mimeType}, ${file.sizeBytes})`,
    );
    bytes += buffer.byteLength;
    if (rows.length >= FILE_BATCH_ROWS || bytes >= FILE_BATCH_BYTES) await flush();
  }
  await flush();
}

/**
 * A chave de caixa de cada caminho **como o Postgres a calcula** — a mesma
 * `lower()` do índice `files_skill_path_lower_uniq`, na coleção do banco —, na
 * ordem recebida. Um caminho só não tem o que deduplicar e dispensa a ida ao
 * banco (é o `setFile` e o `SKILL.md` de toda escrita de skill).
 *
 * Reimplementar a dobra no JS seria uma segunda régua: `toLowerCase()` faz o
 * mapeamento completo do Unicode e o `lower()` da libc é 1:1, e o lado certo
 * muda com o provedor de coleção do cluster (ICU e `builtin` fazem o completo).
 * Perguntar ao banco é imune às duas coisas.
 */
async function foldPathsTx(tx: Tx, paths: readonly string[]): Promise<string[]> {
  if (paths.length <= 1) return [...paths];
  const result = await tx.execute(sql`
    SELECT lower(caminho) AS chave
    FROM unnest(${sql.param([...paths])}::text[]) WITH ORDINALITY AS t(caminho, ordem)
    ORDER BY ordem
  `);
  const keys = (result.rows as Row[]).map((row) => row.chave as string);
  if (keys.length !== paths.length) throw new Error('A dobra de caixa dos caminhos voltou incompleta');
  return keys;
}

/**
 * A fila das escritas de arquivo numa skill — `createFile`, `setFile`,
 * `setFiles`, `deleteFile`, `deleteSkill` e o `updateSkillWithContent` que grava
 * o `SKILL.md`: um advisory lock **de transação**, solto sozinho no
 * COMMIT/ROLLBACK — nada vaza para a conexão devolvida ao pool. A chave é o hash
 * de um texto com prefixo próprio; uma colisão (2⁻⁶⁴) só faria duas escritas
 * esperarem uma pela outra sem motivo, nunca gravaria errado.
 *
 * **Tem de ser a primeira statement da transação.** É isso que a impede de
 * fechar ciclo: quem espera por ela não segura linha nenhuma. Tomá-la depois de
 * um `UPDATE` ou de um `SELECT … FOR …` recria o deadlock que ela existe para
 * evitar — e, dentro dela, nada de `db()`: a segunda conexão do pool pode não
 * vir (ver `readFileFrom`).
 */
async function lockSkillFilesTx(tx: Tx, skillUuid: string): Promise<void> {
  const key = `purple-skills:files:${skillUuid}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Um arquivo só — o `setFile`. A regra do conflito é a do lote. */
async function upsertFileTx(tx: Tx, skillUuid: string, path: string, buffer: Buffer) {
  await upsertFilesTx(tx, skillUuid, [{ path, buffer }]);
}

/**
 * Os chamadores garantem que `rawTags` é um array (`optionalTextList`); aqui os
 * itens seguem tolerantes de propósito: número ou `null` numa lista de tags
 * vira texto e é descartado se ficar vazio, sem derrubar a gravação inteira.
 *
 * **A lista é ordenada, e não fica na ordem que o cliente mandou** (`tasks/038`):
 * o INSERT multilinha trava as linhas de `tags` uma a uma, na ordem da lista, e
 * uma tag **inédita** fica travada até o COMMIT de quem a criou. Dois
 * salvamentos simultâneos com as mesmas tags novas em ordens diferentes
 * travavam em cruz e o Postgres matava um deles — deadlock (40P01), que o app
 * devolve como 500. Medido no caminho real (`createSkill` em pares, quatro tags
 * inéditas em comum, ordens opostas): 6 mortes em 40 pares antes, nenhuma
 * depois. A ordem só precisa ser a **mesma** em todo chamador; qual é, não
 * importa — a leitura reordena por nome (`array_agg(... ORDER BY t.name)`).
 *
 * **Duas statements, e `DO NOTHING` na primeira, de propósito.** Uma statement
 * só não resolve: o que uma CTE que escreve insere não é visível ao resto do
 * mesmo comando, então o `SELECT` do vínculo não acharia a tag que a CTE acabou
 * de criar. E `DO NOTHING` é seguro: quando a tag está sendo criada por outra
 * transação, o INSERT **espera** o fim dela — é o que o deadlock acima prova —
 * e o `SELECT` seguinte, outra statement em READ COMMITTED, já lê um snapshot
 * novo, com a tag dentro. Trocá-lo por `DO UPDATE SET name = EXCLUDED.name` não
 * ganharia nada e custaria uma versão nova de cada linha de `tags` a cada
 * salvamento, além de travar a linha até o COMMIT mesmo quando a tag já existia.
 */
async function replaceTagsTx(tx: Tx, skillUuid: string, rawTags: readonly string[]) {
  const names = Array.from(
    new Set(
      rawTags
        .map((tag) => String(tag ?? '').trim().toLowerCase())
        .filter((tag) => tag.length > 0 && tag.length <= 48),
    ),
  ).sort();

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

/**
 * Um uuid num campo opcional de escrita best-effort: torto, vazio ou de outro
 * tipo é ignorado (nulo), não é erro — o registro vale mais do que o campo.
 */
function optionalUuid(value: unknown): string | null {
  return isUuid(value) ? value : null;
}

/** Timestamp opcional em ISO — o padrão de saída de datas do módulo. */
function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * O termo de busca das listagens: aparado, vazio vira nulo, cortado no teto.
 * Com o caractere nulo é 400, pelo mesmo motivo de `optionalText` — e aqui
 * importa mais, porque `listSkills` recebe o termo cru e é a superfície
 * anônima: `GET /api/skills?q=%00` no site era 500 com o SQL no log
 * (`tasks/038`). Nenhum texto do banco contém o nulo, então não há o que casar.
 */
function normalizeQuery(raw: string | null | undefined): string | null {
  const query = (raw ?? '').trim();
  if (query.includes(NUL)) throw badRequest('O termo de busca não pode conter o caractere nulo');
  return query.length > 0 ? query.slice(0, SEARCH_QUERY_MAX_LENGTH) : null;
}

/**
 * O termo digitado como padrão de `ILIKE '%…%'`, com `%`, `_` e `\`
 * **escapados**: no `LIKE` os dois primeiros são curinga e o terceiro é o
 * escape, e nenhum dos três é curinga na cabeça de quem está procurando.
 *
 * Sem escapar, `q=%` casava o acervo inteiro (e as 200 mil linhas de
 * auditoria), `q=snake_case` casava `snake case`, e um padrão como
 * `%_%_%_%…` — cabe folgado nos 200 caracteres — era o pior caso do
 * casamento de `LIKE` aplicado linha a linha: medido em 200 mil linhas de
 * `skill_accesses`, 778 ms contra 149 ms de uma busca comum, numa superfície
 * sem autenticação nem limite de taxa.
 *
 * Só os dois `%` das pontas continuam curinga — é o "contém" que a busca é.
 * O padrão escapado **continua usando** o índice de trigramas do `022`: o
 * `pg_trgm` conhece o escape e extrai os trigramas do texto literal.
 */
function likePattern(query: string): string {
  return '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * O maior deslocamento que desce ao SQL. `OFFSET` é `bigint` (teto
 * 9223372036854775807) e o driver manda o número como **texto**: `1e20`
 * (`?offset=99999999999999999999`, finito e inteiro para o JavaScript) sobe
 * como `"100000000000000000000"` e o Postgres responde 22003; de `1e21` em
 * diante o texto é `"1e+21"`, que nem é sintaxe de `bigint` (22P02). Os dois
 * viravam 500 numa listagem anônima (`tasks/086`). `MAX_SAFE_INTEGER` cabe
 * folgado no `bigint`, é o maior inteiro que o `number` representa exato — o
 * `offset` devolvido na página é o mesmo que foi ao banco — e está além de
 * qualquer paginação real.
 */
const MAX_PAGE_OFFSET = Number.MAX_SAFE_INTEGER;

/**
 * `OFFSET` é bigint: fração ou lixo vira 0 e o que passa da faixa **satura**
 * em `MAX_PAGE_OFFSET` — nunca erro do driver. Saturar, e não recusar, é o
 * que as listagens já fazem com `limit` (`clamp`) e com o offset negativo: a
 * resposta é a página vazia de quem paginou além do fim, com o `total` certo.
 */
function pageOffset(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(MAX_PAGE_OFFSET, Math.max(0, Math.trunc(value)));
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
