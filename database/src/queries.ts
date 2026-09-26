import { sql, type SQL } from 'drizzle-orm';
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  BIO_MAX_LENGTH,
  MCP_CALL_BUCKET_MS,
  PROFILE_LINKS_MAX,
  QUARANTINE_APPROVERS,
  QUARANTINE_APPROVERS_DEFAULT,
  QUARANTINE_APPROVERS_SETTING,
  SKILL_MD,
  VIRTUAL_MCP_PREVIEW_SIZE,
  isAccessLevel,
  isAccessScope,
  isQuarantineApprovers,
  isRole,
  isSkillMd,
  isEmailLogin,
  isTextualContent,
  isValidSlug,
  mcpCallFamily,
  mimeTypeFor,
  normalizeBio,
  normalizeProfileLinks,
  normalizeRelativePath,
  normalizeSkillIcon,
  normalizeUsername,
  normalizeWebsite,
  sniffAvatarMime,
  skillMetaFromMarkdown,
  skillScore,
  slugify,
  stripFrontmatter,
  uniqueSlug,
  usernameWithSuffix,
  type AccessLevel,
  type AccessScope,
  type ActivityDay,
  type ActivityReport,
  type ActivitySlice,
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
  type McpCallBucketInput,
  type McpSessionAuth,
  type McpSessionEndReason,
  type McpSessionMount,
  type McpSessionPage,
  type McpSessionSummary,
  type McpSessionTransport,
  type AvatarMime,
  type ProfileLink,
  type PublicCatalog,
  type PublicCatalogDetail,
  type PublicProfile,
  type PublicVirtualMcp,
  type QuarantineApprovers,
  type QuarantineCatalogTarget,
  type QuarantineDetail,
  type QuarantineMcpTarget,
  type QuarantinePage,
  type QuarantineSummary,
  type QuarantineTargets,
  type QuarantineTargetsInput,
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
  type UserProfile,
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

/**
 * O dono (`owner`, a coluna de quem chama) tem **página de perfil** — é o
 * booleano que decide se o `por @fulano` da ficha vira link para
 * `/u/<username>` ou fica no texto de hoje (`docs/20-perfil.md` §7). Sem ele o
 * site apontaria para 404 em toda conta que nunca abriu o perfil. Serve à
 * skill (`skillColumns`) e ao catálogo público (`PUBLIC_CATALOG_COLUMNS`), que
 * creditam o dono do mesmo jeito.
 *
 * A pergunta é exatamente a que `getPublicProfile` responde — perfil público
 * **e** conta ativa —, e as duas condições andam juntas de propósito: se aqui
 * bastasse `is_public`, a ficha de uma skill cujo dono foi desativado viraria
 * um link para a página que a desativação acabou de derrubar. Username
 * inexistente não entra na conta: quem não tem conta não tem skill.
 *
 * É o **único** dado de perfil que viaja na ficha: bio, foto e links ficam na
 * rota do perfil, que é onde alguém foi vê-los de propósito.
 *
 * Vale em **toda** visibilidade, inclusive a do site — como o dono desde a
 * `033`.
 *
 * **A forma é subconsulta escalar, e não `EXISTS`, por medida.** As duas dizem
 * a mesma coisa, mas o planejador trata um `EXISTS` correlacionado por
 * igualdade como *hashed SubPlan*: ele materializa o conjunto inteiro das
 * contas com perfil público uma vez por consulta e depois consulta o hash.
 * Isso é ótimo com 60 perfis e péssimo com muitos — na listagem do site
 * (5 000 skills, página de 24), com 50 000 contas e 50 060 perfis, o `EXISTS`
 * levou a consulta de 3,9 ms para **10,9 ms**; a versão com dois `EXISTS`
 * (perfil e conta separados), para 14,1 ms. A escalar não pode ser hasheada e
 * é avaliada por linha: 24 buscas no `user_profiles_public_idx` (**Index Only
 * Scan**, `Heap Fetches: 0` — o índice parcial do `034` existe para isto),
 * 4,2 ms, ou **+0,24 ms** sobre a mesma listagem sem a coluna. Com 60 perfis
 * as três formas empatam dentro do ruído; a escalar é a única que não piora
 * quando a instalação cresce.
 */
const ownerHasProfile = (owner: SQL): SQL => sql`COALESCE((
  SELECT true FROM user_profiles p JOIN users u ON u.uuid = p.user_uuid
  WHERE p.user_uuid = ${owner} AND p.is_public AND u.is_active
  LIMIT 1
), false)`;

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
 * E, desde o `017`, o dono (`owner_user_uuid`, `owner_username`), o flag
 * `is_public` e o `access` da conta que lê (`accessColumn`).
 *
 * **O dono sai em toda visibilidade, inclusive a do site.** Era o contrário
 * até o `033`: em `'open'` as duas colunas vinham nulas porque o rótulo do
 * dono era o **e-mail**, dado pessoal que o `docs/12` §10 aceitava expor a
 * conta logada e não ao anônimo (`tasks/002`). O rótulo agora é o username, e
 * a decisão 11 do `docs/19` é explícita: a ficha pública credita o dono por
 * `@username` — o username é dado público justamente para poder ser creditado.
 * O que continua fora da resposta anônima é o `ownerUserUuid`, e quem o corta
 * é a lista de permissão de `apps/site/src/api.ts`: ele é o `sub` do cookie de
 * sessão do painel (`tasks/001`).
 *
 * Ao lado deles, desde o `034`, `ownerHasProfile`: se o
 * `por @fulano` vira link para `/u/<username>` ou fica no texto. Também em toda
 * visibilidade, e também um probe por linha — o do índice parcial do perfil
 * público.
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
  // A subconsulta do dono roda em toda visibilidade desde o `033`: o site
  // credita o dono por `@username` (`docs/19` decisão 11), e o username é o
  // dado que existe para ser creditado. Ela custa uma busca pela PK de `users`
  // por linha — o preço de uma página do site mostrar quem publicou.
  const ownerColumns = sql`s.owner_user_uuid,
  (SELECT u.username FROM users u WHERE u.uuid = s.owner_user_uuid) AS owner_username,
  ${ownerHasProfile(sql`s.owner_user_uuid`)} AS owner_has_profile`;
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
    ownerUsername: row.owner_username ?? null,
    ownerHasProfile: Boolean(row.owner_has_profile),
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

/** Um arquivo da skill, como o manifesto da extensão precisa dele. */
export type SkillManifestFile = {
  relativePath: string;
  sizeBytes: number;
  /** SHA-256 do conteúdo gravado, em hexadecimal minúsculo (64 caracteres). */
  sha256: string;
};

/** Uma skill servida por um vMCP, com o inventário completo dos arquivos. */
export type SkillManifestEntry = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  /** A chave de cache do SKILL.md composto, no formato que o resto do pacote usa para timestamp. */
  updatedAt: string;
  files: SkillManifestFile[];
};

/**
 * O manifesto da extensão de skills do MCP (SEP-2640,
 * `docs/17-skills-extension.md` §9): as skills `as_skill` expostas no vMCP,
 * cada uma com o inventário **completo** dos arquivos — caminho, tamanho e o
 * `files.content_sha256` da `020` em hexadecimal, que é exatamente o `digest`
 * que a SEP pede, sem nenhum hash novo. Com `options.slug`, uma skill só: é o
 * `skills/get`; sem ele, o catálogo inteiro do servidor (`skills/list`).
 *
 * **Nenhum corpo de arquivo entra aqui** — é o ponto inteiro da consulta. O
 * `SKILL.md` composto (o corpo mais o frontmatter remontado) é medido e
 * hasheado na hora pelo servidor, por `composeSkillMd`, e o corpo dele vem por
 * `readSkillMdBodies`, só para os furos do cache (§5.2 e §5.3). Publicar o
 * `content_sha256` da linha do `SKILL.md` como digest do que o `resources/read`
 * devolve faria **toda** skill falhar na verificação de **todo** host: aquele
 * hash é o do corpo gravado, sem frontmatter.
 *
 * Não reusa `listSkills` pelo mesmo motivo de `listPublishedSkills` (o teto de
 * 100 numa listagem que o protocolo entrega inteira, e agregações por linha que
 * o manifesto descarta), e não estende `listFiles` porque `SkillFileMeta` é
 * tipo do shared, lido pelo painel e pelo site, que não têm o que fazer com um
 * hash. A ordem por slug é estável entre chamadas, como lá.
 *
 * Uma consulta só: os arquivos vêm agregados numa subconsulta correlacionada,
 * no estilo de `mcps` e `catalogs` em `skillColumns`. Duas consultas (as skills
 * e depois `skill_uuid = ANY(...)`) fariam o mesmo trabalho no banco e ainda
 * pediriam o casamento das listas no JS.
 */
export async function listSkillsManifest(
  virtualMcpUuid: string,
  options: { slug?: string } = {},
): Promise<SkillManifestEntry[]> {
  if (!isUuid(virtualMcpUuid)) return [];
  // `undefined` é o catálogo inteiro; qualquer outra coisa filtra — inclusive
  // o vazio, que não casa com slug nenhum. Um `skills/get` sem slug pedindo a
  // lista toda e ficando com a primeira entrada seria a skill errada.
  const slugFilter =
    options.slug === undefined || options.slug === null
      ? sql``
      : sql`AND s.slug = ${options.slug}`;

  const result = await db().execute(sql`
    SELECT s.uuid, s.slug, s.name, s.description, s.updated_at,
           -- O ORDER BY t.name abaixo é invariante, não preferência: o
           -- buildFrontmatter do shared escreve metadata.tags na ordem que
           -- recebe, e o servidor publica o SHA-256 do texto composto. Tag fora
           -- de ordem faz o digest divergir do conteúdo entre duas chamadas, de
           -- forma intermitente e praticamente irreproduzível. Não tire.
           COALESCE((
             SELECT array_agg(t.name ORDER BY t.name)
             FROM skill_tags st JOIN tags t ON t.id = st.tag_id
             WHERE st.skill_uuid = s.uuid
           ), '{}') AS tags,
           COALESCE((
             SELECT json_agg(json_build_object(
               'relativePath', f.relative_path,
               'sizeBytes', f.size_bytes,
               'sha256', encode(f.content_sha256, 'hex')
             ) ORDER BY (lower(f.relative_path) = 'skill.md') DESC, f.relative_path ASC)
             FROM files f WHERE f.skill_uuid = s.uuid
           ), '[]'::json) AS files
    FROM skills s
    WHERE s.is_active AND ${exposedIn(sql`${virtualMcpUuid}::uuid`, 'skill')} ${slugFilter}
    ORDER BY s.slug ASC
  `);

  return (result.rows as Row[]).map((row) => ({
    uuid: row.uuid as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string) ?? '',
    tags: (row.tags ?? []) as string[],
    updatedAt: new Date(row.updated_at).toISOString(),
    files: toManifestFiles(row.files),
  }));
}

/** O JSON de `files` do manifesto, na ordem que o SQL já fixou. */
function toManifestFiles(value: unknown): SkillManifestFile[] {
  const rows = (typeof value === 'string' ? JSON.parse(value) : value) as Row[] | null;
  return (rows ?? []).map((file) => ({
    relativePath: file.relativePath as string,
    sizeBytes: Number(file.sizeBytes ?? 0),
    sha256: file.sha256 as string,
  }));
}

/** O corpo gravado do SKILL.md (sem frontmatter — o frontmatter é remontado na leitura). */
export type SkillMdBody = { skillUuid: string; body: string };

/**
 * Quantos `SKILL.md` por statement. Diferente de `FILE_BATCH_ROWS`, aqui o
 * teto é só de linha: quem chama não sabe o tamanho dos corpos antes de lê-los,
 * e um lote de 50 `SKILL.md` grandes já é uma mensagem respeitável — o teto de
 * leitura do servidor são 4 MiB **por arquivo**, e nada impede um corpo maior
 * no banco. Cinquenta furos de cache numa listagem só é o pior caso de um vMCP
 * recém-aberto; em regime o lote é de um ou dois.
 */
const SKILL_MD_BATCH_ROWS = 50;

/**
 * Os corpos gravados do `SKILL.md` de várias skills, em lote — os furos do
 * cache de `skills/list` (`docs/17-skills-extension.md` §5.3). Quem compõe o
 * frontmatter por cima é o servidor (`composeSkillMd`), com os metadados que
 * `listSkillsManifest` já trouxe.
 *
 * **Sem ordem definida**: acima do teto o lote é fatiado, e cada fatia é uma
 * statement. Quem chama casa pelo `skillUuid` — é um preenchimento de cache,
 * não uma listagem.
 *
 * Skill sem linha de `SKILL.md`, ou com ela gravada como binário, simplesmente
 * não aparece no resultado: não é erro, é uma skill que o `resources/read`
 * também não serviria. Quem chama trata a ausência — a entrada vira
 * `"dynamic"` (§5.4).
 *
 * Uuid torto é filtrado aqui, e não deixado estourar no driver: a lista vem de
 * um cache em memória do servidor, e um valor sujo derrubaria a listagem
 * inteira em vez de faltar uma entrada.
 */
export async function readSkillMdBodies(skillUuids: readonly string[]): Promise<SkillMdBody[]> {
  if (!Array.isArray(skillUuids)) throw badRequest('O campo "skillUuids" deve ser uma lista');
  // Sem repetição: a mesma skill pedida duas vezes voltaria em duas linhas
  // iguais, e o corpo é a parte cara da resposta.
  const valid = [...new Set(skillUuids.filter(isUuid))];
  if (valid.length === 0) return [];

  const bodies: SkillMdBody[] = [];
  for (let start = 0; start < valid.length; start += SKILL_MD_BATCH_ROWS) {
    const batch = valid.slice(start, start + SKILL_MD_BATCH_ROWS);
    const result = await db().execute(sql`
      SELECT skill_uuid, text_content
      FROM files
      WHERE skill_uuid = ANY(${sql.param(batch)}::uuid[])
        AND lower(relative_path) = 'skill.md'
        AND text_content IS NOT NULL
    `);
    for (const row of result.rows as Row[]) {
      bodies.push({
        skillUuid: row.skill_uuid as string,
        body: (row.text_content as string) ?? '',
      });
    }
  }
  return bodies;
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
  return toFileContent(row);
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

  return (result.rows as Row[]).map(toFileContent);
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

/**
 * As colunas de `UserRecord`, mais o carimbo do avatar (`034`).
 *
 * O carimbo vem por **subconsulta correlacionada**, e não por `LEFT JOIN`, por
 * duas razões: a lista é usada também em `RETURNING` (onde não há `FROM` para
 * juntar nada), e citar `user_avatars` por junção convidaria alguém a
 * acrescentar `bytes` ao `SELECT` — que é o que a tabela separada existe para
 * impedir. Custa um probe pela PK por linha e devolve nulo quando não há foto,
 * que é o estado da esmagadora maioria das contas.
 */
const USER_COLUMNS = sql`
  uuid, username, email, name, password_hash, role, is_active, token_version,
  must_change_password, oidc_issuer, oidc_subject, locked_until, failed_attempts,
  last_login_at, created_at, updated_at,
  (SELECT a.updated_at FROM user_avatars a WHERE a.user_uuid = users.uuid) AS avatar_updated_at
`;

function toUserRecord(row: Row): UserRecord {
  return {
    uuid: row.uuid,
    username: row.username,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    isActive: Boolean(row.is_active),
    hasPassword: row.password_hash !== null && row.password_hash !== undefined,
    mustChangePassword: Boolean(row.must_change_password),
    oidcIssuer: row.oidc_issuer ?? null,
    lockedUntil: iso(row.locked_until),
    lastLoginAt: iso(row.last_login_at),
    avatarUpdatedAt: iso(row.avatar_updated_at),
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

/**
 * Busca por `lower(username)`, que é como a unicidade é garantida no banco
 * (`users_username_lower_uniq`, `033`). Irmã de `getUserByEmail`.
 *
 * O texto passa por `normalizeUsername` antes de virar consulta: o que não é
 * um username válido não é de conta nenhuma, e devolver `null` sem ir ao banco
 * é o mesmo "não existe" que um uuid torto recebe em `getUserByUuid`.
 */
export async function getUserByUsername(username: string): Promise<UserRecord | null> {
  const wanted = normalizeUsername(username);
  if (!wanted) return null;

  const result = await db().execute(sql`
    SELECT ${USER_COLUMNS} FROM users WHERE lower(username) = ${wanted} LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? toUserRecord(row) : null;
}

/**
 * O campo único do login, "usuário ou e-mail" (`docs/19` decisão 3): tem `@`,
 * é e-mail; não tem, é username.
 *
 * A regra é decidível porque `normalizeUsername` recusa `@` — os dois
 * conjuntos não se tocam e não há caso ambíguo. Quem decide de que lado cai é
 * `isEmailLogin`, do shared, e não uma segunda cópia da regra aqui.
 *
 * O erro do login continua genérico e o rate limiting do
 * `docs/05-accounts-and-roles.md` §2.7 não muda: ele conta tentativas na mesma
 * **conta**, tenha ela sido nomeada por um lado ou pelo outro.
 */
export async function getUserByLogin(identifier: string): Promise<UserRecord | null> {
  const wanted = (identifier ?? '').trim();
  if (!wanted) return null;
  return isEmailLogin(wanted) ? getUserByEmail(wanted) : getUserByUsername(wanted);
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

// ------------------------------------------------- o livro de usernames -----

/**
 * O username como ele vai para o banco, ou 400.
 *
 * O painel já chama `normalizeUsername` e recusa antes de tocar no banco, mas
 * a conferência é repetida aqui de propósito: o mcp-admin, o seed e qualquer
 * script também passam por `createUser`/`updateUser`, e a regra tem de valer
 * para todos os caminhos. Quem decide o que vale é
 * `packages/shared/src/username.ts`, nunca uma segunda cópia da regra.
 */
function requireUsername(value: unknown): string {
  const raw = optionalText(value, 'username')?.trim() ?? '';
  if (!raw) throw badRequest('O campo "username" é obrigatório');

  const username = normalizeUsername(raw);
  if (!username) {
    throw badRequest(
      `Username inválido: "${raw}" (3 a 32 caracteres, letras, números, ".", "_" e "-",` +
        ' sem começar ou terminar em pontuação e sem duas seguidas)',
    );
  }
  return username;
}

/** Quantos candidatos `nextFreeUsername`/`reserveUsername` tentam antes de desistir. */
const USERNAME_SUFFIX_MAX = 1000;

/**
 * Grava a tomada de um username no livro (`usernames`, `033`); `false` se o
 * nome já está lá.
 *
 * Tomar é **inserir**: a PK em `lower(username)` é o que torna a reserva
 * atômica e permanente, e é ela que impede o `@joao` de uma trilha de 2025 de
 * ser outra pessoa em 2026 (decisão 6).
 *
 * `DO NOTHING`, e **nunca** um `DO UPDATE` que reaproveitasse a linha de quem
 * já passou por ela. A tentação existe — uma linha com `user_uuid` nulo e
 * `released_at` nulo parece "reservada e nunca usada" — mas ela é também o
 * estado de uma conta **apagada**: a FK é `ON DELETE SET NULL`, e a remoção da
 * conta deixa exatamente essa forma. Adotá-la devolveria a circulação o nome
 * de quem foi embora, que é o que a decisão 6 existe para proibir.
 */
async function takeUsernameTx(tx: Tx, username: string, userUuid: string | null): Promise<boolean> {
  const taken = await tx.execute(sql`
    INSERT INTO usernames (username_lower, user_uuid)
    VALUES (${username}, ${userUuid})
    ON CONFLICT (username_lower) DO NOTHING
    RETURNING username_lower
  `);
  return (taken.rows as Row[]).length > 0;
}

/** O 409 de quem tentou tomar um username que esta instalação já gastou. */
const usernameSpent = (username: string) =>
  conflict(`O username "${username}" já foi usado nesta instalação`);

/**
 * O primeiro candidato **livre**, consultando as duas fontes: `users.username`
 * (o que está em uso agora) e `usernames` (tudo que esta instalação já gastou,
 * inclusive o que foi abandonado). Livre quer dizer livre nas duas — um nome
 * abandonado não é oferecido, que é a decisão 6.
 *
 * A numeração é `usernameWithSuffix` do shared (`joao`, `joao-2`, `joao-3`, …,
 * truncando o radical para o sufixo caber em 32), a mesma do backfill da
 * `033`. É a sugestão do formulário de criar conta e o nome que o
 * auto-provisionamento OIDC passa a `createUser`.
 *
 * **Não inventa base**: `base` inutilizável é 400. Quem tem um nome que não dá
 * username (vazio, só pontuação, reservado) passa o fallback
 * `usernameFromUuid(uuid)`, como faz o backfill — a decisão de qual fallback
 * usar é de quem chama, não daqui.
 *
 * É leitura, não reserva: entre a sugestão e a gravação outra conta pode tomar
 * o nome, e quem fecha essa janela é o 409 de `createUser`.
 */
export async function nextFreeUsername(base: string): Promise<string> {
  const wanted = requireUsername(base);

  const result = await db().execute(sql`
    SELECT lower(username) AS nome FROM users
     WHERE lower(username) = ${wanted} OR lower(username) LIKE ${`${wanted}-%`}
    UNION
    SELECT username_lower AS nome FROM usernames
     WHERE username_lower = ${wanted} OR username_lower LIKE ${`${wanted}-%`}
  `);
  const ocupados = new Set((result.rows as Row[]).map((row) => row.nome as string));

  for (let n = 1; n <= USERNAME_SUFFIX_MAX; n += 1) {
    const candidato = usernameWithSuffix(wanted, n);
    // O radical truncado pode colidir com um nome que o `LIKE` não pegou
    // (`joao-silva` → `joao-sil-100`); por isso o teto e não um `while` cego.
    if (candidato && !ocupados.has(candidato)) return candidato;
  }
  throw conflict(`Não há username livre derivado de "${wanted}"`);
}

/**
 * Dá a uma conta **que já existe** o primeiro username livre derivado de
 * `candidate`, resolvendo o sufixo numérico, e devolve o que ficou.
 *
 * É a irmã que **grava** de `nextFreeUsername`: a linha entra em `usernames`,
 * o nome antigo da conta é liberado e `users.username` passa a ser o novo,
 * tudo numa transação. A diferença para `updateUser({ username })` é o que
 * acontece na colisão: lá é 409 (o admin pediu **aquele** nome), aqui é o
 * próximo sufixo — é o que serve a um caminho que não pode falhar, como uma
 * importação ou um reparo.
 *
 * A conta precisa existir porque `usernames.user_uuid` tem FK: uma reserva sem
 * dono seria um nome queimado que ninguém poderia tomar depois (a linha não é
 * adotável — ver `takeUsernameTx`). Quem ainda não tem conta usa
 * `nextFreeUsername` e passa o resultado a `createUser`, que fecha a corrida
 * com o 409.
 */
export async function reserveUsername(candidate: string, userUuid: string): Promise<string> {
  const base = requireUsername(candidate);
  if (!isUuid(userUuid)) throw notFound(`Conta não encontrada: ${String(userUuid)}`);

  return db().transaction(async (tx) => {
    const found = await tx.execute(sql`SELECT username FROM users WHERE uuid = ${userUuid} FOR UPDATE`);
    const row = (found.rows as Row[])[0];
    if (!row) throw notFound(`Conta não encontrada: ${userUuid}`);
    const antigo = (row.username as string).toLowerCase();

    for (let n = 1; n <= USERNAME_SUFFIX_MAX; n += 1) {
      const tentativa = usernameWithSuffix(base, n);
      if (!tentativa) continue;
      if (tentativa === antigo) return antigo;
      // Um nome em uso por conta viva também está no livro (o `033` semeou
      // `usernames` com todos), mas a conferência em `users` fica: é ela que
      // diz a regra do produto — não existe username fora de `users` — em vez
      // de confiar na semeadura.
      const emUso = await tx.execute(sql`
        SELECT 1 FROM users WHERE lower(username) = ${tentativa} LIMIT 1
      `);
      if ((emUso.rows as Row[]).length > 0) continue;
      if (!(await takeUsernameTx(tx, tentativa, userUuid))) continue;

      await tx.execute(sql`
        UPDATE usernames SET released_at = now()
        WHERE username_lower = ${antigo} AND released_at IS NULL
      `);
      await tx.execute(sql`
        UPDATE users SET username = ${tentativa}, updated_at = now() WHERE uuid = ${userUuid}
      `);
      return tentativa;
    }
    throw conflict(`Não há username livre derivado de "${base}"`);
  });
}

export type CreateUserInput = {
  /**
   * O identificador público da conta (`docs/19` decisão 1). Obrigatório e
   * único por `lower(username)`; `normalizeUsername` do shared decide o que
   * vale. Quem não tem um nome que dê username usa `nextFreeUsername` sobre
   * `usernameFromName(name)` ou, em último caso, `usernameFromUuid(uuid)`.
   */
  username: string;
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

  // A caixa do username **não** é preservada, ao contrário da do e-mail: o
  // endereço é da pessoa, o username é identificador público, e `@Joao` e
  // `@joao` na mesma tela é confusão sem ganho (`docs/19` §3).
  const username = requireUsername(input.username);

  if (!isRole(input.role)) throw badRequest(`Papel inválido: ${String(input.role)}`);

  const insert = sql`
    INSERT INTO users (
      username, email, name, password_hash, role, is_active, must_change_password,
      oidc_issuer, oidc_subject
    )
    VALUES (
      ${username}, ${email}, ${name}, ${input.passwordHash ?? null}, ${input.role},
      ${input.isActive !== false}, ${input.mustChangePassword === true},
      ${input.oidcIssuer ?? null}, ${input.oidcSubject ?? null}
    )
    RETURNING ${USER_COLUMNS}
  `;

  try {
    // Sempre em transação, desde o `033`: a conta e a linha do livro de
    // usernames entram juntas ou não entram. Uma conta gravada sem a reserva
    // deixaria o nome livre para outra pessoa depois que ela fosse apagada, que
    // é justamente o que a decisão 6 proíbe.
    return await db().transaction(async (tx) => {
      if (input.onlyIfTableEmpty === true) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${ADMIN_POPULATION_LOCK}, 0))`,
        );
        const total = await tx.execute(sql`SELECT count(*)::int AS total FROM users`);
        if (Number((total.rows as Row[])[0]?.total ?? 0) > 0) {
          throw conflict('Este painel já tem contas: o primeiro administrador já foi criado');
        }
      }
      // O INSERT em `users` vem primeiro, e é o índice único que separa as duas
      // recusas: quem esbarra nele tem uma conta **viva** com aquele nome; quem
      // passa por ele e esbarra no livro está pedindo um nome **abandonado**.
      const created = await tx.execute(insert);
      const user = toUserRecord((created.rows as Row[])[0]);
      if (!(await takeUsernameTx(tx, username, user.uuid))) throw usernameSpent(username);
      return user;
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_oidc_uniq')) {
      throw conflict('Já existe uma conta vinculada a essa identidade OIDC');
    }
    if (isUniqueViolation(err, 'users_username_lower_uniq')) {
      throw conflict(`Já existe uma conta com o username "${username}"`);
    }
    if (isUniqueViolation(err)) {
      throw conflict(`Já existe uma conta com o e-mail "${email}"`);
    }
    throw err;
  }
}

export type UpdateUserInput = {
  name?: string;
  /**
   * Trocar o identificador público da conta — **só admin** (`docs/19`
   * decisão 5); quem confere o papel é o app. Na mesma transação o nome novo
   * entra em `usernames`, o antigo recebe `released_at` e `users` é
   * atualizada: o antigo não volta a circular, e a trilha congelada com ele
   * continua apontando para quem era (decisão 6).
   *
   * Informar o username que a conta **já tem** é no-op nas duas tabelas — não
   * gasta o nome nem gera linha nova no livro —, e só carimba `updated_at`
   * como qualquer PATCH.
   */
  username?: string;
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
  const novoUsername = input.username === undefined ? null : requireUsername(input.username);
  if (novoUsername !== null) sets.push(sql`username = ${novoUsername}`);
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
    // Transação quando a escrita precisa de mais de um comando: a invariante
    // "sempre sobra um administrador" e a troca de username, que mexe em
    // `users` **e** em `usernames`. Os demais caminhos (senha, logout, vínculo
    // OIDC) continuam num comando só, sem transação nem lock.
    if (novoUsername !== null || input.requireOtherActiveAdmin === true) {
      return await db().transaction(async (tx) => {
        if (input.requireOtherActiveAdmin === true) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${ADMIN_POPULATION_LOCK}, 0))`,
          );
        }
        // O livro de usernames é acertado **antes** do UPDATE, com a linha da
        // conta travada: é ele que recusa o nome já gasto, e recusar depois de
        // gravar deixaria a transação desfazendo trabalho à toa.
        if (novoUsername !== null) await trocaUsernameTx(tx, uuid, novoUsername);

        // O UPDATE vem antes da conferência de administradores e a invariante é
        // medida sobre o estado **depois** dele: assim não importa qual campo
        // mudou. Nada de `FOR UPDATE`/`FOR SHARE` nas linhas dos outros admins
        // — duas transações travando a linha uma da outra dariam deadlock
        // (40P01), que o app devolveria como 500.
        const result = await tx.execute(update);
        const row = (result.rows as Row[])[0];
        if (!row) throw notFound(`Conta não encontrada: ${uuid}`);

        if (input.requireOtherActiveAdmin === true) {
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
    // A corrida: outra transação tomou o nome entre a conferência e o UPDATE.
    if (isUniqueViolation(err, 'users_username_lower_uniq')) {
      throw conflict(`Já existe uma conta com o username "${novoUsername}"`);
    }
    throw err;
  }
}

/**
 * A troca de username dentro da transação de `updateUser` (`docs/19`
 * decisão 5): toma o nome novo no livro e marca o antigo como liberado.
 *
 * O antigo recebe `released_at` e **mantém** `user_uuid`: a linha passa a
 * dizer "foi desta conta e não é de ninguém", que é o que torna legível uma
 * trilha congelada com o nome velho. Ela nunca é apagada — reciclar é o que a
 * decisão 6 proíbe.
 *
 * As duas recusas são distintas de propósito: o nome de uma conta **viva** é
 * 409 "já existe uma conta com o username", e o de uma conta que passou por
 * aqui é 409 "já foi usado nesta instalação". Quem administra precisa saber se
 * o nome está ocupado agora ou queimado para sempre.
 */
async function trocaUsernameTx(tx: Tx, uuid: string, novo: string): Promise<void> {
  const found = await tx.execute(sql`SELECT username FROM users WHERE uuid = ${uuid} FOR UPDATE`);
  const row = (found.rows as Row[])[0];
  if (!row) throw notFound(`Conta não encontrada: ${uuid}`);

  const antigo = (row.username as string).toLowerCase();
  // Regravar o mesmo nome não gasta nada e não deixa linha no livro.
  if (antigo === novo) return;

  const emUso = await tx.execute(sql`
    SELECT 1 FROM users WHERE lower(username) = ${novo} AND uuid <> ${uuid} LIMIT 1
  `);
  if ((emUso.rows as Row[]).length > 0) {
    throw conflict(`Já existe uma conta com o username "${novo}"`);
  }
  if (!(await takeUsernameTx(tx, novo, uuid))) throw usernameSpent(novo);

  await tx.execute(sql`
    UPDATE usernames SET released_at = now()
    WHERE username_lower = ${antigo} AND released_at IS NULL
  `);
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

// ----------------------------------------------------------------- perfil ---

/**
 * O perfil (`034`, `docs/20-perfil.md`): a foto, a bio, o site e os links de
 * uma conta, mais a página pública em `/u/<username>`.
 *
 * Três coisas que o desenho grava e que valem ler antes de mexer:
 *
 * - **a linha de `user_profiles` nasce no primeiro salvamento**, não com a
 *   conta. Quem nunca abriu a tela não tem linha, e `getProfile` devolve o
 *   perfil **vazio e privado**: "sem perfil" e "perfil em branco" são o mesmo
 *   estado para quem lê. Conta que não existe é outra coisa, e é 404;
 * - **os bytes da foto moram em `user_avatars`** e só saem por `getAvatar` /
 *   `getAvatarByUsername`. Nenhuma leitura de perfil os toca — `hasAvatar` e
 *   `avatarUpdatedAt` vêm de um `LEFT JOIN` que não cita a coluna `bytes`, e
 *   por isso o TOAST dela nem é aberto;
 * - **a regra do que vale é do shared** (`packages/shared/src/profile.ts`):
 *   `normalizeBio`, `normalizeWebsite`, `normalizeProfileLinks` e
 *   `sniffAvatarMime`. Aqui elas são chamadas, nunca reescritas — o mesmo
 *   papel que `normalizeUsername` tem na `033`. Os CHECKs do banco são teto e
 *   lista fechada, a última linha de defesa para um caminho de escrita novo.
 *
 * A edição do próprio perfil **não entra na trilha**, pelo mesmo critério que
 * mantém o login fora dela (`docs/05` §2.8): mudaria a ordem de grandeza do
 * log. A **limpeza pelo admin** (`clearProfile`) entra, porque é ato de um
 * sobre outro.
 */

/**
 * O que `saveProfile` aceita. Campo ausente **não é regravado** — é o PATCH do
 * painel, e `{ isPublic: true }` sozinho não pode apagar a bio de ninguém.
 *
 * `websiteUrl: null` é "apaga", e é a única forma de limpar o campo: em
 * `normalizeWebsite`, `undefined` e `null` devolvem o mesmo `null`, então quem
 * decide entre "não mexe" e "apaga" é a presença da chave, aferida aqui antes
 * de chamar.
 *
 * `name` é o **nome de exibição**, que mora em `users` e não aqui (decisão 1):
 * a coluna já existia e o que muda é quem escreve. Esta é a única escrita em
 * `users` que não passa por `updateUser`, e por isso ela grava **só** o nome —
 * papel, estado, e-mail e username continuam onde estavam.
 */
export type SaveProfileInput = {
  name?: string;
  bio?: string;
  websiteUrl?: string | null;
  links?: ProfileLink[];
  isPublic?: boolean;
};

/**
 * O avatar sem os bytes: o que `setAvatar` devolve e o ETag precisa.
 *
 * `sha256` sai **cru**, como está na coluna, e não em hexadecimal: quem serve a
 * imagem é que decide a forma do ETag (`avatarHeaders` do shared o quer em hex,
 * e as duas rotas convertem na linha em que montam o cabeçalho). É a mesma
 * postura das duas leituras de avatar não olharem `is_public` — a função é
 * burra, a apresentação é de quem chama.
 */
export type AvatarMeta = {
  mime: AvatarMime;
  /** SHA-256 dos bytes gravados, 32 bytes; `toString('hex')` dá o ETag. */
  sha256: Buffer;
  updatedAt: string;
};

/** O avatar inteiro: o que a rota que serve a imagem precisa. */
export type Avatar = AvatarMeta & { bytes: Buffer };

/** O que a pessoa publicou e o site já mostrava (decisão 7). */
export type PublicByOwner = { skills: SkillSummary[]; catalogs: PublicCatalog[] };

/**
 * As colunas de `UserProfile`. Parte de `users` (o username e o nome de
 * exibição) e completa com `user_profiles`, que **pode não existir**: os
 * `COALESCE` são o perfil vazio e privado de quem nunca salvou.
 *
 * `user_avatars` entra pelo `LEFT JOIN` só para dizer **se** há foto e de
 * quando ela é. A coluna `bytes` não é citada em lugar nenhum daqui de
 * propósito: citá-la faria cada leitura de perfil arrastar até 512 KB para
 * descartar.
 */
const PROFILE_COLUMNS = sql`
  u.username, u.name,
  COALESCE(p.bio, '') AS bio,
  p.website_url,
  COALESCE(p.links, '[]'::jsonb) AS links,
  COALESCE(p.is_public, false) AS is_public,
  (a.user_uuid IS NOT NULL) AS has_avatar,
  a.updated_at AS avatar_updated_at
`;

const PROFILE_FROM = sql`
  FROM users u
  LEFT JOIN user_profiles p ON p.user_uuid = u.uuid
  LEFT JOIN user_avatars a ON a.user_uuid = u.uuid
`;

/**
 * Os links gravados, passados de novo pela regra do shared.
 *
 * Parece redundante — o que entrou já foi normalizado —, mas a coluna é JSONB
 * e o CHECK do banco só garante "array de até 8". Uma linha escrita à mão, um
 * backup de outra versão ou um `UPDATE` de manutenção podem pôr qualquer coisa
 * ali, e a leitura não é lugar de explodir: `normalizeProfileLinks` devolve
 * `null` para o que não vale, e `null` vira lista vazia.
 */
function toProfileLinks(value: unknown): ProfileLink[] {
  const bruto = typeof value === 'string' ? JSON.parse(value) : value;
  return normalizeProfileLinks(bruto) ?? [];
}

function toUserProfile(row: Row): UserProfile {
  return {
    username: row.username,
    name: row.name,
    bio: row.bio ?? '',
    websiteUrl: row.website_url ?? null,
    links: toProfileLinks(row.links),
    isPublic: Boolean(row.is_public),
    hasAvatar: Boolean(row.has_avatar),
    avatarUpdatedAt: iso(row.avatar_updated_at),
  };
}

/**
 * O perfil como a própria conta o vê. Conta **sem linha** de perfil devolve o
 * objeto vazio e privado — é o que a tela abre na primeira vez, e é o que faz
 * "sem perfil" e "perfil em branco" serem o mesmo estado para quem lê.
 *
 * Conta inexistente (ou uuid torto) é **404**, e não `null` como nas demais
 * leituras deste módulo. Duas razões: `saveProfile` e `clearProfile` já
 * respondem 404 ao mesmo caso, e um `null` aqui significaria "esta conta não
 * existe" no lugar exato em que o chamador está perguntando por um perfil —
 * a confusão que faz um app tratar o retorno como se nunca fosse nulo. Quem
 * chama sempre tem uma conta na mão (a sessão, ou um uuid que ele mesmo acabou
 * de resolver).
 */
export async function getProfile(userUuid: string): Promise<UserProfile> {
  if (!isUuid(userUuid)) throw notFound(`Conta não encontrada: ${String(userUuid)}`);

  const result = await db().execute(sql`
    SELECT ${PROFILE_COLUMNS} ${PROFILE_FROM} WHERE u.uuid = ${userUuid}::uuid LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  if (!row) throw notFound(`Conta não encontrada: ${userUuid}`);
  return toUserProfile(row);
}

/**
 * Salva o perfil da própria conta — o `INSERT … ON CONFLICT DO UPDATE` que faz
 * a linha nascer no primeiro salvamento.
 *
 * O upsert acontece **sempre**, mesmo numa chamada que só troca o `name`: é o
 * que torna literal a regra "a linha nasce no primeiro salvamento", e a linha
 * em branco com `is_public = false` é indistinguível da ausência para toda
 * leitura. O `SET` nunca fica vazio porque `updated_at` entra sozinho.
 *
 * Tudo numa transação: o nome mora em `users` e o resto em `user_profiles`, e
 * um PATCH que gravasse metade seria uma tela que mostra o nome novo com a bio
 * velha. A ordem é `users` primeiro, depois `user_profiles` — a mesma de
 * `clearProfile`, e é ela que impede que dois salvamentos simultâneos se
 * travem em sentidos opostos.
 *
 * As recusas são 400 com o campo nomeado; conta inexistente é 404, inclusive
 * quando quem a descobre é a chave estrangeira do upsert.
 */
export async function saveProfile(
  userUuid: string,
  input: SaveProfileInput,
): Promise<UserProfile> {
  if (!isUuid(userUuid)) throw notFound(`Conta não encontrada: ${String(userUuid)}`);

  // O nome de exibição segue a regra de `updateUser`: aparado e não vazio. Um
  // perfil sem nome deixaria a página pública creditando o vazio.
  const nome = input.name === undefined ? undefined : optionalText(input.name, 'name')?.trim();
  if (input.name !== undefined && !nome) throw badRequest('O campo "name" não pode ficar vazio');

  let bio: string | undefined;
  if (input.bio !== undefined) {
    if (input.bio !== null && typeof input.bio !== 'string') {
      throw badRequest('O campo "bio" deve ser uma string');
    }
    const normalizada = normalizeBio(input.bio);
    if (normalizada === null) {
      throw badRequest(`O campo "bio" passa de ${BIO_MAX_LENGTH} caracteres`);
    }
    // O caractere nulo não cabe em `text` e o Postgres recusa o **parâmetro**
    // com 22021 antes de olhar a consulta — sem esta linha, uma bio colada de
    // um arquivo binário viraria 500 com o SQL inteiro no log (`tasks/038`).
    if (normalizada.includes(NUL)) {
      throw badRequest('O campo "bio" não pode conter o caractere nulo');
    }
    bio = normalizada;
  }

  let site: string | null | undefined;
  if (input.websiteUrl !== undefined) {
    const normalizado = normalizeWebsite(input.websiteUrl);
    if (normalizado === false) {
      throw badRequest('O campo "websiteUrl" deve ser uma URL http(s) absoluta');
    }
    site = normalizado;
  }

  let links: ProfileLink[] | undefined;
  if (input.links !== undefined) {
    const normalizados = normalizeProfileLinks(input.links);
    if (normalizados === null) {
      throw badRequest(
        `O campo "links" aceita até ${PROFILE_LINKS_MAX} entradas de rótulo e ` +
          `URL http(s), sem repetir a mesma URL`,
      );
    }
    // JSONB não guarda o caractere nulo **nem escapado**: a sequência de seis
    // caracteres que o `JSON.stringify` produz é recusada pelo servidor com
    // 22P05, no meio da transação e com o SQL no log. Por isso a conferência é
    // nas cadeias, e não no JSON já serializado — ali o byte já virou texto e
    // o `includes` não o acha.
    if (normalizados.some((link) => link.label.includes(NUL) || link.url.includes(NUL))) {
      throw badRequest('O campo "links" não pode conter o caractere nulo');
    }
    links = normalizados;
  }

  const publico = optionalBoolean(input.isPublic, 'isPublic');

  const sets: SQL[] = [];
  if (bio !== undefined) sets.push(sql`bio = ${bio}`);
  if (site !== undefined) sets.push(sql`website_url = ${site}`);
  if (links !== undefined) sets.push(sql`links = ${JSON.stringify(links)}::jsonb`);
  if (publico !== undefined) sets.push(sql`is_public = ${publico}`);
  sets.push(sql`updated_at = now()`);

  try {
    return await db().transaction(async (tx) => {
      if (nome !== undefined) {
        // `updated_at` de `users` é "última alteração da conta", e trocar o
        // nome de exibição é uma. O que a decisão 1 permite é **só** isto:
        // papel, estado e username continuam sendo de `updateUser`.
        const alterada = await tx.execute(sql`
          UPDATE users SET name = ${nome}, updated_at = now()
          WHERE uuid = ${userUuid}::uuid
          RETURNING uuid
        `);
        if ((alterada.rows as Row[]).length === 0) {
          throw notFound(`Conta não encontrada: ${userUuid}`);
        }
      }

      await tx.execute(sql`
        INSERT INTO user_profiles (user_uuid, bio, website_url, links, is_public)
        VALUES (
          ${userUuid}::uuid,
          ${bio ?? ''},
          ${site ?? null},
          ${JSON.stringify(links ?? [])}::jsonb,
          ${publico ?? false}
        )
        ON CONFLICT (user_uuid) DO UPDATE SET ${sql.join(sets, sql`, `)}
      `);

      const lido = await tx.execute(sql`
        SELECT ${PROFILE_COLUMNS} ${PROFILE_FROM} WHERE u.uuid = ${userUuid}::uuid LIMIT 1
      `);
      const row = (lido.rows as Row[])[0];
      if (!row) throw notFound(`Conta não encontrada: ${userUuid}`);
      return toUserProfile(row);
    });
  } catch (err) {
    // A conta não existe: quem descobre é a FK do upsert quando a chamada não
    // trouxe `name` (sem ele não há UPDATE em `users` para acusar antes).
    if (isForeignKeyViolation(err)) throw notFound(`Conta não encontrada: ${userUuid}`);
    throw err;
  }
}

/**
 * "Limpar perfil" do admin (decisão 6): esvazia os campos públicos, desliga o
 * `is_public`, **apaga a foto** e grava `user.profile` na trilha — tudo numa
 * transação, porque metade de uma moderação é pior do que nenhuma.
 *
 * É o único caminho pelo qual alguém que não é o dono mexe no perfil, e ele
 * não escreve texto: o admin apaga, nunca corrige no lugar da pessoa. O que
 * some é o que estava publicado; o `name` fica (é campo de conta, de
 * `updateUser`) e a conta continua exatamente como estava.
 *
 * A foto sai mesmo quando não há linha de perfil: `user_avatars` é
 * independente de `user_profiles`, e uma conta pode ter enviado foto sem nunca
 * ter salvo um campo público.
 *
 * **Audita sempre**, inclusive quando não havia nada a limpar. A linha registra
 * o ato de quem administra — e decidir "não havia nada" dependeria de uma
 * leitura que a próxima escrita concorrente já teria desmentido. Conta
 * inexistente (ou uuid torto) é 404, sem auditar.
 */
export async function clearProfile(
  userUuid: string,
  source: AuditSource,
  actor?: AuditActor,
): Promise<UserProfile> {
  if (!isUuid(userUuid)) throw notFound(`Conta não encontrada: ${String(userUuid)}`);

  return db().transaction(async (tx) => {
    const found = await tx.execute(sql`
      SELECT username, name FROM users WHERE uuid = ${userUuid}::uuid LIMIT 1
    `);
    const conta = (found.rows as Row[])[0];
    if (!conta) throw notFound(`Conta não encontrada: ${userUuid}`);

    // Sem `INSERT`: não há o que limpar numa conta que nunca salvou perfil, e
    // criar a linha em branco aqui seria o admin abrindo perfil para alguém.
    await tx.execute(sql`
      UPDATE user_profiles
         SET bio = '', website_url = NULL, links = '[]'::jsonb,
             is_public = false, updated_at = now()
       WHERE user_uuid = ${userUuid}::uuid
    `);
    await tx.execute(sql`DELETE FROM user_avatars WHERE user_uuid = ${userUuid}::uuid`);

    await auditTx(tx, {
      skillUuid: null,
      skillSlug: null,
      filePath: null,
      action: 'user.profile',
      source,
      previousContent: null,
      actor,
      targetLabel: conta.username as string,
    });

    return {
      username: conta.username as string,
      name: conta.name as string,
      bio: '',
      websiteUrl: null,
      links: [],
      isPublic: false,
      hasAvatar: false,
      avatarUpdatedAt: null,
    };
  });
}

// ------------------------------------------------------------------ foto ---

/**
 * Grava a foto da conta; enviar de novo substitui (uma foto por conta).
 *
 * **O tipo é decidido pelos bytes**, por `sniffAvatarMime` — nunca pela
 * extensão nem pelo `Content-Type` da parte multipart, que são texto que quem
 * envia escolhe. O argumento `mime` é opcional e serve para o chamador
 * **confirmar** o que sniffou: informado e diferente dos bytes, é 400. Um app
 * que repasse o tipo declarado pelo cliente recebe essa recusa com os dois
 * valores na mensagem, em vez de gravar uma mentira que a rota depois serve.
 *
 * A conferência é repetida aqui mesmo com o painel já a fazendo, pela razão de
 * `requireUsername` em `createUser`: o mcp-admin, um script e um caminho novo
 * chegam por esta porta, e a regra não pode depender de quem chamou.
 *
 * O `sha256` é calculado **pelo banco** sobre os bytes gravados, num CTE que
 * os manda uma vez só. É o ETag da rota que serve a imagem (`avatarHeaders` do
 * shared), e o CHECK `user_avatars_sha256_chk` garante que ele nunca descreve
 * outros bytes.
 */
export async function setAvatar(
  userUuid: string,
  bytes: Uint8Array,
  mime?: string,
): Promise<AvatarMeta> {
  if (!isUuid(userUuid)) throw notFound(`Conta não encontrada: ${String(userUuid)}`);
  if (!ArrayBuffer.isView(bytes)) throw badRequest('A foto precisa vir como bytes');

  const buffer = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length === 0) throw badRequest('A foto está vazia');
  if (buffer.length > AVATAR_MAX_BYTES) {
    throw badRequest(`A foto passa de ${Math.floor(AVATAR_MAX_BYTES / 1024)} KB`);
  }

  const tipo = sniffAvatarMime(buffer);
  if (!tipo) {
    throw badRequest(`Formato de imagem não reconhecido: use ${AVATAR_MIME_TYPES.join(', ')}`);
  }
  if (mime !== undefined && mime !== tipo) {
    throw badRequest(
      `O tipo informado (${String(mime)}) não corresponde aos bytes enviados (${tipo})`,
    );
  }

  try {
    const result = await db().execute(sql`
      WITH nova AS (SELECT ${buffer}::bytea AS bytes)
      INSERT INTO user_avatars (user_uuid, bytes, mime, sha256)
      SELECT ${userUuid}::uuid, nova.bytes, ${tipo}, sha256(nova.bytes) FROM nova
      ON CONFLICT (user_uuid) DO UPDATE
        SET bytes = EXCLUDED.bytes, mime = EXCLUDED.mime,
            sha256 = EXCLUDED.sha256, updated_at = now()
      RETURNING mime, sha256, updated_at
    `);
    const row = (result.rows as Row[])[0];
    return {
      mime: row.mime as AvatarMime,
      sha256: row.sha256 as Buffer,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  } catch (err) {
    if (isForeignKeyViolation(err)) throw notFound(`Conta não encontrada: ${userUuid}`);
    throw err;
  }
}

/** Apaga a foto. `false` = não havia nenhuma — não é erro, é o estado normal. */
export async function deleteAvatar(userUuid: string): Promise<boolean> {
  if (!isUuid(userUuid)) return false;

  const result = await db().execute(sql`
    DELETE FROM user_avatars WHERE user_uuid = ${userUuid}::uuid RETURNING user_uuid
  `);
  return (result.rows as Row[]).length > 0;
}

/**
 * Os bytes da foto, o tipo e o hash — a rota que serve a imagem.
 *
 * **Não olha `is_public` nem `is_active`**, e isso é deliberado: o painel serve
 * a foto a qualquer sessão logada (ela é o avatar das listas e das fichas, como
 * o monograma), e o site confere `getPublicProfile` **antes** de pedir os
 * bytes. A política é de quem chama; a função é burra de propósito, porque uma
 * função que decidisse sozinha teria de decidir igual para as duas superfícies
 * — e elas não são iguais.
 */
export async function getAvatar(userUuid: string): Promise<Avatar | null> {
  if (!isUuid(userUuid)) return null;

  const result = await db().execute(sql`
    SELECT bytes, mime, sha256, updated_at
    FROM user_avatars WHERE user_uuid = ${userUuid}::uuid LIMIT 1
  `);
  return toAvatar((result.rows as Row[])[0]);
}

/**
 * A irmã de `getAvatar` endereçada pelo username, para o site servir
 * `/u/:username/avatar` **sem** passar por `getUserByUsername` — que devolve
 * `UserRecord`, com hash de senha, `token_version` e o subject OIDC dentro. Pôr
 * material de autenticação na mão de um app anônimo para desenhar uma imagem é
 * o oposto do que a `033` fez.
 *
 * Também não olha `is_public` nem `is_active`, pela razão de `getAvatar`: quem
 * decide é o chamador, e no site quem decide é o `getPublicProfile` que vem
 * antes — sem ele, a foto de um perfil recém-tornado privado continuaria
 * servida a quem tivesse a URL, e a URL é pública por construção, porque
 * esteve numa página.
 */
export async function getAvatarByUsername(username: string): Promise<Avatar | null> {
  const wanted = normalizeUsername(username);
  if (!wanted) return null;

  const result = await db().execute(sql`
    SELECT a.bytes, a.mime, a.sha256, a.updated_at
    FROM user_avatars a JOIN users u ON u.uuid = a.user_uuid
    WHERE lower(u.username) = ${wanted} LIMIT 1
  `);
  return toAvatar((result.rows as Row[])[0]);
}

function toAvatar(row: Row | undefined): Avatar | null {
  if (!row) return null;
  return {
    bytes: row.bytes as Buffer,
    mime: row.mime as AvatarMime,
    sha256: row.sha256 as Buffer,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Só o carimbo da foto, para o painel montar a URL com cache-buster sem ler a
 * imagem. `null` = não há foto.
 *
 * A consulta não cita `bytes`: é uma leitura de índice mais uma linha estreita,
 * e é por isso que ela pode aparecer numa lista de contas sem custar um
 * megabyte por tela.
 */
export async function avatarStamp(userUuid: string): Promise<string | null> {
  if (!isUuid(userUuid)) return null;

  const result = await db().execute(sql`
    SELECT updated_at FROM user_avatars WHERE user_uuid = ${userUuid}::uuid LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? new Date(row.updated_at).toISOString() : null;
}

// --------------------------------------------------------- página pública ---

/**
 * O casamento da rota pública, em um lugar só: o username, o perfil ligado e a
 * conta ativa, sobre `users u` e `user_profiles p`.
 *
 * Ele é compartilhado por `getPublicProfile` e `isProfilePublic` de propósito.
 * As duas respondem à **mesma** pergunta em superfícies diferentes (a página e
 * a imagem), e duas cópias do predicado divergiriam no dia em que uma condição
 * mudasse — e a divergência apareceria como uma foto que continua sendo
 * servida depois de a página ter sumido, que é justamente o que não pode
 * acontecer.
 *
 * O `username` já vem normalizado por quem chama. Os dois índices que o plano
 * usa são `users_username_lower_uniq` (`033`) e `user_profiles_public_idx`
 * (`034`).
 */
const PERFIL_PUBLICO = (username: string): SQL =>
  sql`lower(u.username) = ${username} AND p.is_public AND u.is_active`;

/**
 * A pergunta da rota da imagem: **esta pessoa tem página de perfil?**
 *
 * Existe para o site não pagar a listagem inteira de alguém a cada `<img>`.
 * `GET /u/:username/avatar` precisa conferir `is_public`/`is_active` antes de
 * servir os bytes, e fazer isso com `getPublicProfile` arrastava junto as
 * skills e os catálogos públicos da pessoa — materializados com
 * `skillColumns`, subconsultas por linha e tudo — só para serem descartados.
 * Numa conta com 200 skills públicas, abrir a página do perfil montava essas
 * 200 linhas **duas vezes**: uma para a página e outra para a foto, numa rota
 * anônima. É a mesma família do custo medido em `ownerHasProfile`: trabalho
 * proporcional ao acervo numa consulta que não precisa dele.
 *
 * Duas buscas de índice e nenhuma linha de skill ou catálogo. O predicado é o
 * `PERFIL_PUBLICO` de `getPublicProfile`, e não uma cópia.
 *
 * **Não substitui a conferência, substitui o custo dela.** A política continua
 * sendo de quem chama: `getAvatarByUsername` segue burra, e é o site que
 * pergunta primeiro. Username torto ou inexistente é `false`, como perfil
 * privado e conta desativada — os quatro casos são indistinguíveis, pela razão
 * de `getPublicProfile`.
 */
export async function isProfilePublic(username: string): Promise<boolean> {
  const wanted = normalizeUsername(username);
  if (!wanted) return false;

  const result = await db().execute(sql`
    SELECT 1 FROM users u JOIN user_profiles p ON p.user_uuid = u.uuid
    WHERE ${PERFIL_PUBLICO(wanted)}
    LIMIT 1
  `);
  return (result.rows as Row[]).length > 0;
}

/**
 * O perfil como o **site anônimo** o vê. Só existe com `is_public` **e** a
 * conta ativa; nos demais casos é `null`, sem distinguir o motivo.
 *
 * Perfil privado, conta desativada e username inexistente são o mesmo `null` de
 * propósito (`docs/20` §7): distinguir os dois primeiros do terceiro seria
 * responder "esta conta existe, mas não quer ser vista", que é exatamente a
 * informação que o opt-in existe para não dar.
 *
 * O `username` devolvido é o **canônico** — o que está gravado, em caixa baixa
 * —, e não o que veio da URL: é com ele que o site monta a chamada seguinte
 * (o avatar) sem propagar a grafia de quem digitou.
 */
export async function getPublicProfile(username: string): Promise<PublicProfile | null> {
  const wanted = normalizeUsername(username);
  if (!wanted) return null;

  const result = await db().execute(sql`
    SELECT u.uuid, u.username, u.name, p.bio, p.website_url, p.links,
           (a.user_uuid IS NOT NULL) AS has_avatar, a.updated_at AS avatar_updated_at
    FROM users u
    JOIN user_profiles p ON p.user_uuid = u.uuid
    LEFT JOIN user_avatars a ON a.user_uuid = u.uuid
    WHERE ${PERFIL_PUBLICO(wanted)}
    LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  const publicado = await publicByOwnerUuid(row.uuid as string);
  return {
    username: row.username,
    name: row.name,
    bio: row.bio ?? '',
    websiteUrl: row.website_url ?? null,
    links: toProfileLinks(row.links),
    hasAvatar: Boolean(row.has_avatar),
    avatarUpdatedAt: iso(row.avatar_updated_at),
    ...publicado,
  };
}

/**
 * As skills e os catálogos **já públicos** de uma conta — a decisão 7 do
 * `docs/20`. Estar no perfil não torna nada visível: o recorte das skills é o
 * mesmo `OPEN_EXPOSURE` do site (pública, em vMCP aberto e ligado, ou em
 * catálogo público e ligado — sempre com a skill ligada), e o dos catálogos é
 * o mesmo de `listPublicCatalogs`.
 *
 * **Não filtra `users.is_active`**: uma conta desativada continua sem página
 * de perfil (quem recusa é `getPublicProfile`), mas as skills públicas dela
 * seguem no site como sempre estiveram — desativar uma conta nunca despublicou
 * o acervo dela, e não é aqui que isso mudaria. Username inexistente ou torto
 * devolve as duas listas vazias, não erro.
 */
export async function listPublicByOwner(username: string): Promise<PublicByOwner> {
  const wanted = normalizeUsername(username);
  if (!wanted) return { skills: [], catalogs: [] };

  const found = await db().execute(sql`
    SELECT uuid FROM users WHERE lower(username) = ${wanted} LIMIT 1
  `);
  const row = (found.rows as Row[])[0];
  if (!row) return { skills: [], catalogs: [] };

  return publicByOwnerUuid(row.uuid as string);
}

/**
 * O corpo de `listPublicByOwner`, pelo uuid que `getPublicProfile` já tem em
 * mãos — sem procurar o username uma segunda vez.
 *
 * As duas listas vêm **inteiras**, sem paginação, como em `getPublicCatalog`:
 * a página desenha o que a pessoa publicou, e um "ver mais" que ninguém pediu
 * seria outra decisão. Quem publica centenas de skills paga uma página grande.
 */
async function publicByOwnerUuid(ownerUuid: string): Promise<PublicByOwner> {
  const skills = await db().execute(sql`
    SELECT ${skillColumns({ visibility: 'open' })}
    FROM skills s
    WHERE s.owner_user_uuid = ${ownerUuid}::uuid AND ${OPEN_EXPOSURE}
    ORDER BY s.name ASC, s.slug ASC
  `);
  const catalogs = await db().execute(sql`
    SELECT ${PUBLIC_CATALOG_COLUMNS} ${PUBLIC_CATALOG_FROM}
    WHERE c.owner_user_uuid = ${ownerUuid}::uuid AND c.is_public AND c.is_active
    ORDER BY c.name ASC, c.slug ASC
  `);

  return {
    skills: (skills.rows as Row[]).map(toSummary),
    catalogs: (catalogs.rows as Row[]).map(toPublicCatalog),
  };
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
 * aparece em tela nenhuma (`tasks/040`). `userUsername` é o dono da chave, que
 * com o admin revogando não é quem chamou; era o e-mail até o `033`, e virou
 * username pela mesma regra de toda projeção de rótulo de conta (`docs/19`
 * §4.1) — este aqui vai para `audit_log`, onde ficaria congelado para sempre.
 */
export type RevokedApiKey = {
  name: string;
  prefix: string;
  userUuid: string;
  userUsername: string;
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
    RETURNING k.name, k.prefix, k.user_uuid, u.username
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;
  return {
    name: row.name,
    prefix: row.prefix,
    userUuid: row.user_uuid,
    userUsername: row.username,
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
    | 'user.username'
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
  'user.username',
  'user.profile',
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
  'skill.clone',
  'catalog.clone',
  'mcp.clone',
  'public.key.create',
  'public.key.revoke',
  'rag.settings',
  'rag.reindex',
  'quarantine.create',
  'quarantine.update',
  'quarantine.delete',
  'quarantine.promote',
  'quarantine.settings',
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
  m.owner_user_uuid, u.username AS owner_username, m.layout, ${access} AS access,
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
    ownerUsername: row.owner_username ?? null,
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

/**
 * Linha de auditoria de um MCP virtual: sem skill, com o slug do servidor como
 * alvo. Em `mcp.clone` o alvo é o par `<origem> -> <cópia>` (ver `cloneVirtualMcp`).
 */
function virtualMcpAudit(
  action: 'mcp.create' | 'mcp.update' | 'mcp.delete' | 'mcp.clone',
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
  u.username AS owner_username, ${access} AS access, c.view_count, c.download_count,
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
    ownerUsername: row.owner_username ?? null,
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

/**
 * Linha de auditoria de um catálogo: sem skill, com o slug do catálogo como
 * alvo. Em `catalog.clone` o alvo é o par `<origem> -> <cópia>` (ver `cloneCatalog`).
 */
function catalogAudit(
  action: 'catalog.create' | 'catalog.update' | 'catalog.delete' | 'catalog.clone',
  slug: string,
  source: AuditSource,
  actor: AuditActor | null | undefined,
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

/**
 * O fecho de toda escrita nos membros: `updated_at` e a linha `catalog.update`.
 * Aceita ator nulo por causa da promoção da quarentena (`promoteQuarantine`),
 * que, como `createSkill`, roda também sem conta.
 */
async function touchCatalogTx(
  tx: Tx,
  uuid: string,
  slug: string,
  source: AuditSource,
  actor: AuditActor | null | undefined,
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
 * cruzarem. Devolve o **username** do novo dono, para o label da auditoria —
 * é ele que fica congelado em `target_label` para sempre (`docs/19` §4.1), e
 * congelar ali um endereço de e-mail era metade do vazamento que o `033`
 * fechou.
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
    sql`SELECT username, is_active FROM users WHERE uuid = ${newOwner} FOR SHARE`,
  );
  const user = (found.rows as Row[])[0];
  if (!user) throw badRequest(`Conta não encontrada: ${newOwner}`);
  if (!user.is_active) {
    throw badRequest(
      `A conta "${user.username}" está desativada e não pode receber a transferência`,
    );
  }

  await tx.execute(sql`
    DELETE FROM ${sql.raw(spec.table)}
    WHERE ${sql.raw(spec.column)} = ${objectUuid} AND user_uuid = ${newOwner}
  `);
  return user.username as string;
}

/**
 * O `target_label` de um `update` de catálogo ou vMCP: só o slug, ou
 * `<slug> <username do novo dono>` numa transferência (`docs/12` §8, com o
 * rótulo do `docs/19`). Deixar órfão (`null`) não muda o label: não há conta a
 * registrar.
 */
function transferLabel(slug: string, newOwnerUsername: string | null | undefined): string {
  return newOwnerUsername ? `${slug} ${newOwnerUsername}` : slug;
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
    SELECT g.user_uuid, u.username, u.name, u.role, u.is_active, g.level,
           g.granted_by_user_uuid, gb.username AS granted_by_username, g.created_at
    FROM ${sql.raw(spec.table)} g
    JOIN users u ON u.uuid = g.user_uuid
    LEFT JOIN users gb ON gb.uuid = g.granted_by_user_uuid
    WHERE g.${sql.raw(spec.column)} = ${objectUuid}
      ${userUuid === undefined ? sql`` : sql`AND g.user_uuid = ${userUuid}`}
    ORDER BY u.name ASC, u.username ASC
  `;
}

function toGrant(row: Row): Grant {
  return {
    userUuid: row.user_uuid,
    username: row.username,
    name: row.name,
    role: row.role as Role,
    isActive: row.is_active === true,
    level: row.level as AccessLevel,
    grantedByUserUuid: row.granted_by_user_uuid ?? null,
    grantedByUsername: row.granted_by_username ?? null,
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
 * `*.share` com `username:nível` (e o slug antes, em catálogo e vMCP) e
 * devolve a concessão. A checagem de que o chamador tem `manage` é do app.
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
      sql`SELECT username, role, is_active FROM users WHERE uuid = ${userUuid} FOR SHARE`,
    );
    const user = (found.rows as Row[])[0];
    if (!user) throw badRequest(`Conta não encontrada: ${userUuid}`);
    if (!user.is_active) throw badRequest(`A conta "${user.username}" está desativada`);
    if (user.role === 'admin') {
      throw badRequest(`"${user.username}" é administrador e já tem acesso a tudo`);
    }
    if (object.ownerUserUuid === userUuid) {
      throw badRequest(`"${user.username}" é o dono e já tem acesso a tudo`);
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
    await auditTx(
      tx,
      grantAudit(spec, 'share', object, `${user.username}:${level}`, source, actor),
    );

    const grant = (await tx.execute(grantsQuery(spec, object.uuid, userUuid)).then(
      (r) => (r.rows as Row[])[0],
    ))!;
    return toGrant(grant);
  });
}

/**
 * Revoga a concessão de uma conta num objeto. Concessão inexistente (ou
 * conta torta) é 404 e nada é auditado; slug desconhecido também. Audita
 * `*.unshare` com o username (e o slug antes, em catálogo e vMCP).
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
      RETURNING u.username
    `);
    const row = (removed.rows as Row[])[0];
    if (!row) throw notFound(`A conta não tem concessão neste ${spec.label.toLowerCase()}`);
    await auditTx(tx, grantAudit(spec, 'unshare', object, row.username as string, source, actor));
  });
}

/**
 * A linha de auditoria de uma concessão (`docs/12` §8): na skill, com
 * `skill_uuid`/`skill_slug` e `username:nível` (ou só o username) no label; em
 * catálogo e vMCP, sem skill e com o slug antes, separado por espaço.
 *
 * O rótulo é **congelado**, e por isso é username desde o `033`: `audit_log`
 * nunca é podada, e um endereço de e-mail gravado aqui ficaria legível para
 * quem lê a trilha muito depois de a conta sumir.
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
      sql`SELECT username, role, is_active FROM users WHERE uuid = ${userUuid} FOR SHARE`,
    );
    const user = (found.rows as Row[])[0];
    if (!user || user.role !== 'admin' || !user.is_active) return notAdopted();

    const others = await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM users WHERE role = 'admin' AND is_active AND uuid <> ${userUuid}
      ) AS found
    `);
    if ((others.rows as Row[])[0]?.found) return notAdopted();

    const username = user.username as string;
    const skills = await adoptOrphansTx(tx, GRANTS.skill, userUuid, username, source, actor);
    const catalogs = await adoptOrphansTx(tx, GRANTS.catalog, userUuid, username, source, actor);
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
  username: string,
  source: AuditSource,
  actor: AuditActor,
): Promise<number> {
  const onSkill = spec.table === 'skill_grants';
  const action: AuditAction = onSkill ? 'update' : 'catalog.update';
  // Os mesmos campos de `grantAudit` e de uma transferência: na skill, o uuid
  // e o slug dela com o username no label; no catálogo, sem skill e com o slug
  // antes do username. Os casts existem porque, num `INSERT … SELECT`, o
  // Postgres não infere o tipo do parâmetro pela coluna de destino.
  const audited = onSkill
    ? sql`a.uuid, a.slug, ${username}::text`
    : sql`NULL::uuid, NULL::text, a.slug || ' ' || ${username}::text`;

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
 * A busca "Compartilhar com…" (`docs/12` decisão 13, com o recorte do
 * `docs/19` decisão 10): contas **ativas** cujo nome ou **username** contém
 * `q` (`ILIKE`), por nome. Menos de dois caracteres (depois de aparar) devolve
 * `[]` sem consultar — é o mínimo para não listar a instalação inteira a cada
 * tecla. Aberta a qualquer conta logada; a checagem de sessão é do app.
 *
 * **O e-mail saiu dos dois lados**, e não só da projeção. Continuar a *casar*
 * por endereço deixaria qualquer conta logada descobrir a qual username um
 * e-mail corresponde — bastaria digitar o endereço e ler o resultado. A
 * sondagem anula o sigilo mesmo com o campo fora da resposta, e é por isso que
 * o `OR email ILIKE` não está mais aqui.
 */
export async function lookupUsers(q: string, limit = 10): Promise<UserLookup[]> {
  const wanted = (optionalText(q, 'q') ?? '').trim();
  if (wanted.length < 2) return [];
  const pattern = likePattern(wanted.slice(0, SEARCH_QUERY_MAX_LENGTH));

  const result = await db().execute(sql`
    SELECT uuid, username, name, role FROM users
    WHERE is_active AND (name ILIKE ${pattern} OR username ILIKE ${pattern})
    ORDER BY name ASC, username ASC
    LIMIT ${clamp(limit, 1, USER_LOOKUP_MAX)}
  `);
  return (result.rows as Row[]).map((row) => ({
    uuid: row.uuid,
    username: row.username,
    name: row.name,
    role: row.role as Role,
  }));
}

/**
 * Os catálogos que o site lista (`docs/12` §7): públicos e ligados, sem
 * concessões.
 *
 * O dono entra pelo **username** desde o `033` (`docs/19` decisão 11): a ficha
 * pública credita quem publicou, na skill e no catálogo — e, desde o `034`,
 * com `ownerHasProfile` ao lado, que diz se esse crédito vira link para
 * `/u/<username>` (`docs/20` §7). `owner_user_uuid`
 * fica fora — é o `sub` do cookie de sessão do painel e não tem uso numa
 * página anônima. Por isso o `LEFT JOIN`, e não uma subconsulta: a listagem
 * tem poucas linhas e o dono é sempre um só.
 */
const PUBLIC_CATALOG_COLUMNS = sql`
  c.uuid, c.slug, c.name, c.description, u.username AS owner_username,
  ${ownerHasProfile(sql`c.owner_user_uuid`)} AS owner_has_profile,
  (SELECT count(*) FROM catalog_skills cs JOIN skills s ON s.uuid = cs.skill_uuid
    WHERE cs.catalog_uuid = c.uuid AND cs.is_active AND s.is_active)::int AS skill_count
`;

/** O `FROM` das duas leituras públicas de catálogo, com o dono ao lado. */
const PUBLIC_CATALOG_FROM = sql`FROM catalogs c LEFT JOIN users u ON u.uuid = c.owner_user_uuid`;

function toPublicCatalog(row: Row): PublicCatalog {
  return {
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    ownerUsername: row.owner_username ?? null,
    ownerHasProfile: Boolean(row.owner_has_profile),
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
    SELECT ${PUBLIC_CATALOG_COLUMNS} ${PUBLIC_CATALOG_FROM}
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
    SELECT ${PUBLIC_CATALOG_COLUMNS} ${PUBLIC_CATALOG_FROM}
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
 * `keyId`, da `psk_` por `apiKeyId`, username por `userUuid`) são resolvidas
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
 * cortadas no mesmo teto: slug (96) e username (32) já têm limite na entrada,
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
        key_id, key_name, api_key_id, api_key_name, user_uuid, user_username,
        session_id, ip, user_agent, client_name, client_version
      )
      SELECT
        s.uuid, s.slug, left(s.name, ${teto}), ${kind}, ${surface}, ${origin}, ${auth},
        m.uuid, m.slug, left(m.name, ${teto}),
        COALESCE(p.uuids, '{}'::uuid[]), COALESCE(p.slugs, '{}'::text[]), COALESCE(p.names, '{}'::text[]),
        k.id, left(k.name, ${teto}), ak.id, left(ak.name, ${teto}), u.uuid, u.username,
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
  /** `ILIKE %q%` em `user_username`, `api_key_name`, `key_name`, `ip`, `client_name` e `session_id`. */
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
  a.key_id, a.key_name, a.api_key_id, a.api_key_name, a.user_uuid, a.user_username,
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
    userUsername: row.user_username ?? null,
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
      a.user_username ILIKE ${pattern}
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

// -------------------------------------------------------------- atividade ---

/**
 * A tela de Atividade (`docs/18-atividade.md`): a escrita que dá a quarta
 * fonte (`bumpMcpCallCounters`), a grade de dias (`listActivityDays`) e o
 * relatório agregado de um dia (`activityOfDay`).
 *
 * As duas leituras são **agregadas**: nada que saia delas carrega IP, e-mail,
 * `session_id`, nome de tool nem identificador de operação — a menor unidade é
 * "quantas vezes". Quem precisa do evento a evento tem `listAuditPage`,
 * `listMcpSessions` e `listSkillAccesses`.
 *
 * O dia é o de **quem olha**: o painel converte o dia do calendário do
 * navegador em dois instantes e manda `since`/`until`. O fuso IANA só
 * acompanha a **série**, porque é lá que o SQL agrupa por dia; o relatório de
 * um dia é uma faixa de instantes e não depende de fuso nenhum. As quatro
 * fontes são sempre filtradas por instante (`coluna >= since AND coluna <=
 * until`) e só depois agrupadas por `(coluna AT TIME ZONE …)::date` — na
 * ordem inversa o índice morreria e cada leitura varreria a tabela inteira.
 */

/**
 * Teto do método JSON-RPC gravado em `mcp_call_counters`.
 *
 * Exportado como `MCP_SESSION_LABEL_MAX`, para o rastreador do mcp-public
 * cortar **na memória** com o mesmo número do banco: quem acumula o balde
 * chaveia o mapa pelo método cru, e dois métodos que só diferem depois do
 * corte viram a mesma linha aqui. 128 é folga larga — o maior método do
 * protocolo hoje é `resources/directory/read`, com 23 caracteres; o que passa
 * disso é texto que um cliente inventou.
 */
export const MCP_CALL_METHOD_MAX = 128;

/**
 * Quantas linhas por `INSERT` do flush. O despejo de 15 minutos de um servidor
 * movimentado é da ordem de dezenas de linhas (vMCPs × transportes × métodos);
 * o corte existe pelo mesmo motivo de `FILE_BATCH_ROWS` — uma statement com
 * milhares de linhas e sete parâmetros cada é um pacote enorme para o driver.
 */
const MCP_CALL_BATCH_ROWS = 500;

/** Padrão e teto do top-N das fatias do relatório. */
const ACTIVITY_TOP_DEFAULT = 5;
const ACTIVITY_TOP_MAX = 50;

/**
 * Teto da faixa consultada, em dias: 400.
 *
 * A grade desenha um ano (como todo heatmap de contribuições) e o fuso de quem
 * olha empurra as pontas; 400 dias cobrem isso com folga e impedem que alguém
 * peça dez anos e faça o banco agrupar o histórico inteiro. Passar do teto não
 * é erro — a faixa **satura** puxando o `since` para `until - 400 dias`, como
 * o `clamp` de `limit` das listagens: quem pediu demais recebe o fim da faixa,
 * que é o que a tela mostra.
 */
export const ACTIVITY_RANGE_MAX_DAYS = 400;

const DIA_MS = 86_400_000;

/**
 * Nome de fuso IANA, na forma que o navegador manda
 * (`Intl.DateTimeFormat().resolvedOptions().timeZone`): `UTC`,
 * `America/Sao_Paulo`, `America/Argentina/Buenos_Aires`, `Etc/GMT+5`.
 *
 * O primeiro caractere é uma letra de propósito: isso recusa deslocamento cru
 * (`+05:45`), que o Postgres aceita com convenção de sinal **diferente** da do
 * ISO em algumas formas e daria um dia recortado ao contrário sem ninguém
 * perceber.
 */
const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const TIMEZONE_MAX = 64;

/**
 * Fusos já confirmados contra o `pg_timezone_names` **deste** servidor, por
 * processo. A lista é a autoridade (é a tzdata que o `AT TIME ZONE` usa), mas
 * lê-la custa ~10 ms — ela é uma varredura do diretório de fusos, não uma
 * tabela. Só o positivo é guardado: um nome recusado é reconferido na chamada
 * seguinte, então um fuso acrescentado à tzdata do servidor passa a valer sem
 * reiniciar ninguém. O conjunto é limitado pelos ~500 nomes reais — o lixo
 * morre antes, no `TIMEZONE_RE`.
 */
const fusosConferidos = new Set<string>(['UTC']);

/**
 * O fuso pedido, conferido. Ausente é `'UTC'`.
 *
 * Nome desconhecido é **400**, e não o 500 que o Postgres daria: `AT TIME ZONE
 * 'Marte/Olympus'` lança `invalid_parameter_value` no meio da consulta, e o
 * fuso vem do navegador de quem abriu a tela — é entrada, não bug nosso.
 */
async function activityTimezone(value: unknown): Promise<string> {
  if (value === undefined || value === null) return 'UTC';
  if (typeof value !== 'string') throw badRequest('O campo "timezone" deve ser uma string');
  const tz = value.trim();
  if (fusosConferidos.has(tz)) return tz;
  if (tz.length > TIMEZONE_MAX || !TIMEZONE_RE.test(tz)) {
    throw badRequest(`Fuso horário desconhecido: ${tz.slice(0, TIMEZONE_MAX)}`);
  }
  // `lower()` dos dois lados: o `AT TIME ZONE` não diferencia caixa e a coluna
  // guarda a grafia canônica (`UTC`, não `utc`).
  const conferido = await db().execute(
    sql`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE lower(name) = lower(${tz})) AS ok`,
  );
  if (!(conferido.rows as Row[])[0]?.ok) throw badRequest(`Fuso horário desconhecido: ${tz}`);
  fusosConferidos.add(tz);
  return tz;
}

/** A faixa de instantes das duas leituras, conferida e saturada em `ACTIVITY_RANGE_MAX_DAYS`. */
function activityRange(options: { since: unknown; until: unknown }): { since: Date; until: Date } {
  const since = requireDate(options.since, 'since');
  const until = requireDate(options.until, 'until');
  if (until.getTime() < since.getTime()) {
    throw badRequest('A faixa de atividade termina antes de começar');
  }
  const teto = ACTIVITY_RANGE_MAX_DAYS * DIA_MS;
  if (until.getTime() - since.getTime() <= teto) return { since, until };
  return { since: new Date(until.getTime() - teto), until };
}

/** Uma `Date` obrigatória; ausente ou inválida é 400. */
function requireDate(value: unknown, field: string): Date {
  const date = optionalDate(value, field);
  if (!date) throw badRequest(`O campo "${field}" é obrigatório`);
  return date;
}

/**
 * Um método JSON-RPC pronto para gravar, ou `null` quando não sobra nada.
 *
 * É `normalizeSessionLabel` com outro teto e sem o espaço no meio: as
 * categorias `Cc` (o `text` do Postgres recusa U+0000 com 22021 antes de olhar
 * a consulta, `tasks/038`) e `Cf`, mais os separadores de linha, **somem**, as
 * pontas são aparadas e o resto é cortado em `MCP_CALL_METHOD_MAX`. Limpar, e
 * não recusar, porque o flush é um INSERT com várias linhas: um `CHECK`
 * violado por um cliente torto derrubaria a statement inteira e levaria junto
 * as chamadas de todos os outros servidores daquele despejo.
 *
 * **Por que `Cf` também — e por que só aqui.** `Cf` é o formatador invisível:
 * o override bidi U+202E, o espaço de largura zero U+200B e o BOM U+FEFF.
 * Sem ele, `"tools/call" + U+202E + "evil"` chegava intacto à coluna `method`
 * e subia para "Métodos mais chamados", onde o override inverte a leitura do
 * que está ao redor dele na tela; e o U+200B cria dois métodos visualmente
 * idênticos que nunca somam na mesma linha, porque o agrupamento é por
 * igualdade de bytes. Um método JSON-RPC é identificador de máquina
 * (`tools/call`): `Cf` nenhum é legítimo dentro dele. Num rótulo de tela é o
 * contrário — `Cf` traz o ZWJ (U+200D) e o ZWNJ (U+200C), que montam emoji
 * composto e ligam letras em persa e em hindi, e `normalizeSessionLabel` troca
 * o que remove por **espaço**: aplicá-lo lá partiria ao meio o nome legítimo
 * de quem se apresenta. Por isso o rótulo continua como está, e a defesa
 * contra o bidi na tela de sessões é de quem desenha, não do banco.
 */
function callMethod(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  if (!text) return null;
  return Buffer.from(text.slice(0, MCP_CALL_METHOD_MAX).trimEnd(), 'utf8').toString('utf8');
}

/** Uma linha do flush, já saneada e somada com as suas iguais. */
type McpCallRow = {
  bucket: Date;
  uuid: string;
  slug: string;
  transport: McpSessionTransport;
  method: string;
  calls: number;
};

/**
 * Soma no banco os baldes de chamadas fechados pelo rastreador do MCP público
 * (`docs/18-atividade.md`).
 *
 * Um `INSERT` com várias linhas por lote, nunca um por item: o flush de 15
 * minutos chega com dezenas deles e é disparado do caminho de quem está
 * atendendo. Lista vazia devolve sem consultar.
 *
 * - **O balde é achatado aqui** (`floor(t / MCP_CALL_BUCKET_MS)`), ainda que
 *   quem chama já o mande alinhado: a PK é `(bucket, slug, transporte,
 *   método)`, e um instante fora do passo fragmentaria a linha que deveria
 *   somar. Achatar o que já está achatado não muda nada.
 * - **O método é saneado e o lote deduplicado** — dois métodos crus que virem
 *   o mesmo texto limpo na mesma statement dariam 21000 ("ON CONFLICT DO
 *   UPDATE command cannot affect row a second time"), a armadilha já medida em
 *   `upsertFilesTx`. Item sem método que sobreviva ao saneamento, ou com
 *   `calls` zero, é descartado: não é chamada nenhuma.
 * - **O uuid do vMCP é resolvido por `LEFT JOIN`**, como as cópias de
 *   `recordSkillAccess`. Um servidor apagado entre a chamada e o flush faria a
 *   FK recusar o INSERT (23503) e o lote inteiro se perderia; assim a linha
 *   entra com o uuid nulo e o `virtual_mcp_slug`, que é a identidade histórica
 *   — a mesma regra de `015` e `018`.
 * - **As linhas são ordenadas pela chave antes de virarem `VALUES`**, e o
 *   INSERT as emite nessa ordem — ver o bloco de ordenação, abaixo.
 * - `bucket` que não é data, uuid torto, slug vazio, transporte fora do
 *   `CHECK` e `calls` negativo são **400**: esses campos são nossos, não do
 *   cliente, e um valor errado neles é bug de quem chama.
 */
export async function bumpMcpCallCounters(items: readonly McpCallBucketInput[]): Promise<void> {
  if (items.length === 0) return;

  // Chave = a PK. `JSON.stringify` e não um separador qualquer: o método é
  // texto do cliente e pode conter o separador que se escolhesse.
  const somados = new Map<string, McpCallRow>();

  for (const item of items) {
    const instante = requireDate(new Date(String(item.bucket ?? '')), 'bucket');
    const bucket = new Date(Math.floor(instante.getTime() / MCP_CALL_BUCKET_MS) * MCP_CALL_BUCKET_MS);
    if (!isUuid(item.virtualMcpUuid)) throw badRequest('O campo "virtualMcpUuid" precisa ser um uuid');
    const slug = requireText(item.virtualMcpSlug, 'virtualMcpSlug');
    const transport = oneOf(item.transport, MCP_SESSION_TRANSPORTS, 'transport');
    const calls = requireCount(item.calls, 'calls');
    const method = callMethod(item.method);
    if (!method || calls === 0) continue;

    const chave = JSON.stringify([bucket.toISOString(), slug, transport, method]);
    const anterior = somados.get(chave);
    if (anterior) anterior.calls += calls;
    else somados.set(chave, { bucket, uuid: item.virtualMcpUuid, slug, transport, method, calls });
  }

  // **A ordem é a da chave, e não a de chegada** — a mesma lição de
  // `replaceTagsTx` e do `ORDER BY` da clonagem: o `ON CONFLICT DO UPDATE`
  // trava as linhas de `mcp_call_counters` uma a uma, na ordem em que elas
  // saem do `VALUES`, e cada uma fica travada até o COMMIT de quem a tocou.
  // O rastreador do mcp-public despeja **todas** as sessões num `Promise.all`
  // a cada varredura (`sessions.ts`), e duas sessões do mesmo vMCP, mesmo
  // transporte e mesmo balde de 15 min trazem os mesmos métodos em ordens
  // diferentes — a ordem em que cada sessão viu cada método pela primeira vez.
  // Elas travavam em cruz e o Postgres matava uma: deadlock (40P01), que
  // `colherChamadas` engole depois de já ter feito `calls.clear()`, então as
  // chamadas do despejo morto **somem sem deixar rastro** e o dia mais
  // movimentado é o mais subcontado. Medido contra um Postgres de verdade, com
  // os 8 métodos ordinários: 6 sessões → 37 mortes em 90 despejos e 41,1% das
  // chamadas perdidas; 10 sessões → 173 em 250 e 69,2% perdidas; com as linhas
  // ordenadas, nenhuma morte e nenhuma chamada perdida nos dois casos.
  //
  // Qual ordem é, não importa — importa ser a **mesma** em todo chamador. É a
  // da chave do `Map`, que é a própria PK serializada, comparada por unidade
  // de código (`<`/`>`, nunca `localeCompare`, que depende da locale do
  // processo e daria ordens diferentes em máquinas diferentes). Ordenar antes
  // de fatiar faz a ordem valer também **entre** os lotes de
  // `MCP_CALL_BATCH_ROWS`.
  const ordenadas = [...somados.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const linhas = ordenadas.map(
    ([, linha], pos) => sql`(
      ${pos}::int, ${linha.bucket}::timestamptz, ${linha.uuid}::uuid, ${linha.slug}::text,
      ${linha.transport}::text, ${linha.method}::text, ${mcpCallFamily(linha.method)}::text,
      ${linha.calls}::bigint
    )`,
  );

  for (let i = 0; i < linhas.length; i += MCP_CALL_BATCH_ROWS) {
    const lote = linhas.slice(i, i + MCP_CALL_BATCH_ROWS);
    // `ORDER BY v.pos` — a posição no array ordenado — porque ordenar em
    // JavaScript **não basta**: o plano deste INSERT é um `Hash Right Join`
    // com `virtual_mcps` do lado externo e o `VALUES` do lado da tabela hash,
    // e o que sai de um join não tem ordem prometida nenhuma. Medido com o
    // trigger de observação do teste: sem o `ORDER BY`, seis métodos saíam do
    // join numa terceira ordem — nem a de entrada, nem a da chave. Com ele o
    // plano ganha um `Sort` no topo do SELECT, e é esse `Sort` que fixa a
    // ordem em que o INSERT trava as linhas, qualquer que seja o plano de
    // amanhã.
    await db().execute(sql`
      INSERT INTO mcp_call_counters (bucket, virtual_mcp_uuid, virtual_mcp_slug, transport, method, family, calls)
      SELECT v.bucket, m.uuid, v.slug, v.transport, v.method, v.family, v.calls
      FROM (VALUES ${sql.join(lote, sql`, `)}) AS v (pos, bucket, virtual_mcp_uuid, slug, transport, method, family, calls)
      LEFT JOIN virtual_mcps m ON m.uuid = v.virtual_mcp_uuid
      ORDER BY v.pos
      ON CONFLICT (bucket, virtual_mcp_slug, transport, method)
      DO UPDATE SET calls = mcp_call_counters.calls + EXCLUDED.calls
    `);
  }
}

export type ListActivityDaysOptions = {
  /** Instante inicial, inclusive. */
  since: Date;
  /** Instante final, inclusive. */
  until: Date;
  /** Fuso IANA em que os dias são recortados; padrão `'UTC'`. Nome desconhecido é 400. */
  timezone?: string;
};

/**
 * A série do heatmap: um item por dia **com alguma atividade**, em ordem
 * crescente, com o dia em `AAAA-MM-DD` no fuso pedido.
 *
 * Uma consulta só, com as quatro fontes em `UNION ALL` de agregados — e não
 * quatro idas ao banco nem quatro `LEFT JOIN` sobre uma série de dias: cada
 * ramo lê o seu índice por instante e devolve, no máximo, um punhado de linhas
 * (um dia cada). Dia sem linha é dia sem atividade; o painel completa a grade
 * com zeros, e `total` (a soma das quatro) é o que dá a cor da célula.
 *
 * As chamadas entram pelo `bucket`, que é o início do balde de 15 minutos —
 * como todo deslocamento IANA é múltiplo de 15 minutos, nenhum balde fica
 * partido entre dois dias em fuso nenhum (é o porquê de `MCP_CALL_BUCKET_MS`).
 */
export async function listActivityDays(options: ListActivityDaysOptions): Promise<ActivityDay[]> {
  const { since, until } = activityRange(options);
  const tz = await activityTimezone(options.timezone);

  const result = await db().execute(sql`
    WITH dias AS (
      SELECT (ms.started_at AT TIME ZONE ${tz}::text)::date AS dia,
             count(*)::bigint AS sessions, 0::bigint AS calls, 0::bigint AS reads, 0::bigint AS events
        FROM mcp_sessions ms
       WHERE ms.started_at >= ${since}::timestamptz AND ms.started_at <= ${until}::timestamptz
       GROUP BY 1
      UNION ALL
      SELECT (c.bucket AT TIME ZONE ${tz}::text)::date, 0, COALESCE(sum(c.calls), 0), 0, 0
        FROM mcp_call_counters c
       WHERE c.bucket >= ${since}::timestamptz AND c.bucket <= ${until}::timestamptz
       GROUP BY 1
      UNION ALL
      SELECT (a.created_at AT TIME ZONE ${tz}::text)::date, 0, 0, count(*), 0
        FROM skill_accesses a
       WHERE a.created_at >= ${since}::timestamptz AND a.created_at <= ${until}::timestamptz
       GROUP BY 1
      UNION ALL
      SELECT (l.created_at AT TIME ZONE ${tz}::text)::date, 0, 0, 0, count(*)
        FROM audit_log l
       WHERE l.created_at >= ${since}::timestamptz AND l.created_at <= ${until}::timestamptz
       GROUP BY 1
    )
    SELECT to_char(dia, 'YYYY-MM-DD') AS day,
           sum(sessions)::bigint AS sessions,
           sum(calls)::bigint AS calls,
           sum(reads)::bigint AS reads,
           sum(events)::bigint AS events
      FROM dias
     GROUP BY dia
    HAVING sum(sessions) + sum(calls) + sum(reads) + sum(events) > 0
     ORDER BY dia
  `);

  return (result.rows as Row[]).map((row) => {
    const sessions = Number(row.sessions);
    const calls = Number(row.calls);
    const reads = Number(row.reads);
    const events = Number(row.events);
    return { day: row.day, sessions, calls, reads, events, total: sessions + calls + reads + events };
  });
}

export type ActivityOfDayOptions = {
  /** Instante inicial do dia, inclusive — já convertido pelo painel. */
  since: Date;
  /** Instante final do dia, inclusive. */
  until: Date;
  /** Tamanho dos top-N (agentes, métodos, servidores, skills); padrão 5, clamp 1..50. */
  top?: number;
};

/**
 * O relatório de um dia, agregado. `day` e `timezone` são de quem perguntou —
 * o banco não os reinventa.
 *
 * Sete consultas pequenas em `Promise.all`, uma por fonte e por natureza
 * (escalares × fatias), em vez de um monstro de uma consulta só: cada uma usa
 * o índice por instante da sua tabela e nenhuma depende do resultado da outra.
 *
 * **Os totais saem das fatias**, sem consulta própria: `transport`, `family`,
 * `surface` e `action` são `NOT NULL` com `CHECK` nas quatro tabelas, então
 * toda linha da faixa cai em exatamente uma fatia e a soma delas é o total
 * exato. O que não dá para derivar — contagens distintas, downloads e as
 * sessões encerradas — é que vai nas consultas de escalares.
 *
 * Três recortes valem a pena ser ditos:
 *
 * - `clients.ended` e `byEndReason` contam pelo **`ended_at`** dentro do dia,
 *   não pelo `started_at`: a sessão pode ter começado ontem e terminado hoje.
 *   É o índice `mcp_sessions_ended_at_idx` da `032`;
 * - `reads.skills` e `topSkills` agrupam pelo **`skill_slug`**, a cópia que
 *   sobrevive à remoção da skill, e não pelo uuid, que vai a nulo (`018`);
 * - `catalog.actors` conta `COALESCE(actor_user_uuid, actor_label)`: a conta
 *   removida deixa o uuid nulo e o rótulo fica, e quem nunca foi conta (o
 *   token global, o bootstrap) só tem rótulo. Ninguém é identificado — o que
 *   sai é quantos foram.
 */
export async function activityOfDay(
  options: ActivityOfDayOptions,
): Promise<Omit<ActivityReport, 'day' | 'timezone'>> {
  const { since, until } = activityRange(options);
  const top = clamp(options.top ?? ACTIVITY_TOP_DEFAULT, 1, ACTIVITY_TOP_MAX);
  const faixa = (coluna: SQL) => sql`${coluna} >= ${since}::timestamptz AND ${coluna} <= ${until}::timestamptz`;
  const abertas = faixa(sql`ms.started_at`);

  const [clientes, fatiasClientes, fatiasChamadas, leituras, fatiasLeituras, catalogo, fatiasCatalogo] =
    await Promise.all([
      db().execute(sql`
        SELECT count(DISTINCT ms.session_id)::bigint AS distintas,
               count(DISTINCT ms.client_name)::bigint AS agentes,
               (SELECT count(*) FROM mcp_sessions e WHERE ${faixa(sql`e.ended_at`)})::bigint AS encerradas
          FROM mcp_sessions ms
         WHERE ${abertas}
      `),
      db().execute(sql`
        SELECT 'transport' AS dim, ms.transport AS chave, NULL::text AS rotulo, count(*)::bigint AS n
          FROM mcp_sessions ms WHERE ${abertas} GROUP BY ms.transport
        UNION ALL
        SELECT 'auth', ms.auth, NULL, count(*)::bigint
          FROM mcp_sessions ms WHERE ${abertas} GROUP BY ms.auth
        UNION ALL
        SELECT 'end_reason', ms.end_reason, NULL, count(*)::bigint
          FROM mcp_sessions ms WHERE ${faixa(sql`ms.ended_at`)} AND ms.end_reason IS NOT NULL
         GROUP BY ms.end_reason
        UNION ALL
        SELECT * FROM (
          SELECT 'agent' AS dim, ms.client_name AS chave, NULL::text AS rotulo, count(*)::bigint AS n
            FROM mcp_sessions ms WHERE ${abertas} AND ms.client_name IS NOT NULL
           GROUP BY ms.client_name ORDER BY n DESC, chave LIMIT ${top}
        ) agentes
      `),
      db().execute(sql`
        SELECT 'family' AS dim, c.family AS chave, NULL::text AS rotulo, sum(c.calls)::bigint AS n
          FROM mcp_call_counters c WHERE ${faixa(sql`c.bucket`)} GROUP BY c.family
        UNION ALL
        SELECT 'transport', c.transport, NULL, sum(c.calls)::bigint
          FROM mcp_call_counters c WHERE ${faixa(sql`c.bucket`)} GROUP BY c.transport
        UNION ALL
        SELECT * FROM (
          SELECT 'method' AS dim, c.method AS chave, min(c.family) AS rotulo, sum(c.calls)::bigint AS n
            FROM mcp_call_counters c WHERE ${faixa(sql`c.bucket`)}
           GROUP BY c.method ORDER BY n DESC, chave LIMIT ${top}
        ) metodos
        UNION ALL
        SELECT * FROM (
          SELECT 'server' AS dim, c.virtual_mcp_slug AS chave, max(m.name) AS rotulo, sum(c.calls)::bigint AS n
            FROM mcp_call_counters c
            LEFT JOIN virtual_mcps m ON m.uuid = c.virtual_mcp_uuid
           WHERE ${faixa(sql`c.bucket`)}
           GROUP BY c.virtual_mcp_slug ORDER BY n DESC, chave LIMIT ${top}
        ) servidores
      `),
      db().execute(sql`
        SELECT (count(*) FILTER (WHERE a.kind = 'download'))::bigint AS downloads,
               count(DISTINCT a.skill_slug)::bigint AS skills
          FROM skill_accesses a
         WHERE ${faixa(sql`a.created_at`)}
      `),
      db().execute(sql`
        SELECT 'surface' AS dim, a.surface AS chave, NULL::text AS rotulo, count(*)::bigint AS n
          FROM skill_accesses a WHERE ${faixa(sql`a.created_at`)} GROUP BY a.surface
        UNION ALL
        SELECT 'origin', a.origin, NULL, count(*)::bigint
          FROM skill_accesses a WHERE ${faixa(sql`a.created_at`)} GROUP BY a.origin
        UNION ALL
        SELECT 'auth', a.auth, NULL, count(*)::bigint
          FROM skill_accesses a WHERE ${faixa(sql`a.created_at`)} GROUP BY a.auth
        UNION ALL
        SELECT * FROM (
          SELECT 'skill' AS dim, a.skill_slug AS chave, max(a.skill_name) AS rotulo, count(*)::bigint AS n
            FROM skill_accesses a WHERE ${faixa(sql`a.created_at`)}
           GROUP BY a.skill_slug ORDER BY n DESC, chave LIMIT ${top}
        ) skills
      `),
      db().execute(sql`
        SELECT count(DISTINCT COALESCE(l.actor_user_uuid::text, l.actor_label))::bigint AS atores
          FROM audit_log l
         WHERE ${faixa(sql`l.created_at`)}
      `),
      db().execute(sql`
        SELECT 'action' AS dim, l.action AS chave, NULL::text AS rotulo, count(*)::bigint AS n
          FROM audit_log l WHERE ${faixa(sql`l.created_at`)} GROUP BY l.action
        UNION ALL
        SELECT 'source', l.source, NULL, count(*)::bigint
          FROM audit_log l WHERE ${faixa(sql`l.created_at`)} GROUP BY l.source
      `),
    ]);

  const umClientes = (clientes.rows as Row[])[0] ?? {};
  const umLeituras = (leituras.rows as Row[])[0] ?? {};
  const umCatalogo = (catalogo.rows as Row[])[0] ?? {};

  const byTransport = activitySlices(fatiasClientes.rows as Row[], 'transport');
  const byFamily = activitySlices(fatiasChamadas.rows as Row[], 'family');
  const bySurface = activitySlices(fatiasLeituras.rows as Row[], 'surface');
  const byAction = activitySlices(fatiasCatalogo.rows as Row[], 'action');

  return {
    clients: {
      sessions: somaDeFatias(byTransport),
      distinct: Number(umClientes.distintas ?? 0),
      agents: Number(umClientes.agentes ?? 0),
      ended: Number(umClientes.encerradas ?? 0),
      byTransport,
      byAuth: activitySlices(fatiasClientes.rows as Row[], 'auth'),
      byEndReason: activitySlices(fatiasClientes.rows as Row[], 'end_reason'),
      topAgents: activitySlices(fatiasClientes.rows as Row[], 'agent'),
    },
    calls: {
      total: somaDeFatias(byFamily),
      byFamily,
      topMethods: activitySlices(fatiasChamadas.rows as Row[], 'method'),
      byTransport: activitySlices(fatiasChamadas.rows as Row[], 'transport'),
      byServer: activitySlices(fatiasChamadas.rows as Row[], 'server'),
    },
    reads: {
      total: somaDeFatias(bySurface),
      downloads: Number(umLeituras.downloads ?? 0),
      skills: Number(umLeituras.skills ?? 0),
      bySurface,
      byOrigin: activitySlices(fatiasLeituras.rows as Row[], 'origin'),
      byAuth: activitySlices(fatiasLeituras.rows as Row[], 'auth'),
      topSkills: activitySlices(fatiasLeituras.rows as Row[], 'skill'),
    },
    catalog: {
      total: somaDeFatias(byAction),
      actors: Number(umCatalogo.atores ?? 0),
      byAction,
      bySource: activitySlices(fatiasCatalogo.rows as Row[], 'source'),
    },
  };
}

/**
 * As fatias de uma dimensão, da maior para a menor. A ordem é decidida aqui,
 * e não no SQL: os `UNION ALL` das consultas de fatias trazem as dimensões
 * misturadas, e o `ORDER BY` de cada ramo só existe onde há `LIMIT` (os
 * top-N). Empate desempata pela chave, para a tela não dançar entre dois
 * carregamentos iguais.
 */
function activitySlices(rows: Row[], dim: string): ActivitySlice[] {
  return rows
    .filter((row) => row.dim === dim)
    .map((row) => ({ key: String(row.chave), label: row.rotulo ?? null, count: Number(row.n) }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** O total de uma dimensão **completa** (sem top-N) — ver `activityOfDay`. */
function somaDeFatias(slices: readonly ActivitySlice[]): number {
  return slices.reduce((soma, slice) => soma + slice.count, 0);
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

// ------------------------------------------------------------- quarentena ---

/**
 * A quarentena (`docs/15-quarentena.md`, `schema/030-quarentena.sql`) é o
 * espaço de espera entre o pacote que alguém enviou e o acervo: um envio é uma
 * **pasta de arquivos com dono**, fora de `skills`, que a promoção transforma
 * numa skill de verdade.
 *
 * O que ela deliberadamente não tem: slug, tag, ícone, `is_active`,
 * `is_public`, vínculo com vMCP ou catálogo, contador, concessão,
 * `search_vector` e RAG. Duas consequências para quem chama:
 *
 * - **o envio é endereçado pelo `uuid`**, nunca por nome — nome não é único
 *   aqui, e dois envios do mesmo pacote convivem de propósito;
 * - **a permissão é do app** (`canViewQuarantine`, `canEditQuarantine` e
 *   `canPromoteQuarantine` de shared, com a política de
 *   `getQuarantineApprovers`). O banco não recorta por papel: `listQuarantine`
 *   recebe `ownerUserUuid` quando o app quer só os de uma conta.
 *
 * O **destino** (`035`, `quarantine_catalogs` e `quarantine_mcps`) não é
 * vínculo: é o que a aprovação vai criar. Até lá o envio não aparece em
 * catálogo nem em vMCP nenhum, e nenhuma leitura fora desta seção olha as duas
 * tabelas. Quem grava ou cumpre um destino confere `edit` em cada alvo **no
 * app**, antes de chamar — o banco só confere que o alvo existe.
 */

/** As colunas de `QuarantineSummary`: o envio, o dono e os números da pasta. */
const QUARANTINE_COLUMNS = sql`
  q.uuid, q.name, q.description, q.source_filename, q.owner_user_uuid,
  u.username AS owner_username, n.total AS file_count, n.bytes AS size_bytes,
  q.created_at, q.updated_at
`;

/**
 * O `FROM` das leituras do envio. A contagem e a soma dos bytes saem de uma
 * lateral só — duas subconsultas escalares varreriam o mesmo índice duas
 * vezes por linha —, e ela sempre devolve uma linha: `file_count` e
 * `size_bytes` nunca vêm nulos, nem num envio vazio.
 */
const QUARANTINE_FROM = sql`
  FROM quarantine_skills q
  LEFT JOIN users u ON u.uuid = q.owner_user_uuid
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS total, coalesce(sum(f.size_bytes), 0)::bigint AS bytes
      FROM quarantine_files f
     WHERE f.quarantine_uuid = q.uuid
  ) n ON true
`;

function toQuarantineSummary(row: Row): QuarantineSummary {
  return {
    uuid: row.uuid,
    name: row.name,
    description: row.description ?? '',
    sourceFilename: row.source_filename ?? null,
    ownerUserUuid: row.owner_user_uuid ?? null,
    ownerUsername: row.owner_username ?? null,
    fileCount: Number(row.file_count ?? 0),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export type ListQuarantineOptions = {
  /** Clamp 1..200; padrão 50. */
  limit?: number;
  offset?: number;
  /**
   * Sem ele, a fila inteira. Com um uuid, só os envios daquela conta — é o
   * recorte de quem perdeu o papel de editor e continua vendo o que
   * submeteu. `null` é "nenhum dono possível" (a sessão de bootstrap, que não
   * é conta) e devolve lista vazia em vez de vazar os órfãos, que são só do
   * admin: a mesma semântica de `listVirtualMcps` e `listCatalogs`.
   */
  ownerUserUuid?: string | null;
  /** `ILIKE %q%` em `name` e `description`, com o termo **literal**. */
  search?: string;
};

/**
 * A fila, **mais recentes primeiro** (`quarantine_skills_created_at_idx`), com
 * o desempate por `uuid` — que é `uuidv7()` e, portanto, cresce com o tempo:
 * dois envios do mesmo instante nunca trocam de lugar entre duas páginas.
 */
export async function listQuarantine(
  options: ListQuarantineOptions = {},
): Promise<QuarantinePage> {
  const limit = clamp(options.limit ?? 50, 1, 200);
  const offset = pageOffset(options.offset);

  const owner = options.ownerUserUuid;
  if (owner === null) return { items: [], total: 0, limit, offset };
  if (owner !== undefined && !isUuid(owner)) return { items: [], total: 0, limit, offset };

  const conditions: SQL[] = [];
  if (owner !== undefined) conditions.push(sql`q.owner_user_uuid = ${owner}`);

  const search = normalizeQuery(optionalText(options.search, 'search'));
  if (search) {
    const pattern = likePattern(search);
    conditions.push(sql`(q.name ILIKE ${pattern} OR q.description ILIKE ${pattern})`);
  }

  const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

  const counted = await db().execute(sql`
    SELECT count(*)::int AS total FROM quarantine_skills q ${where}
  `);
  const total = Number((counted.rows as Row[])[0]?.total ?? 0);

  const result = await db().execute(sql`
    SELECT ${QUARANTINE_COLUMNS} ${QUARANTINE_FROM}
    ${where}
    ORDER BY q.created_at DESC, q.uuid DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return { items: (result.rows as Row[]).map(toQuarantineSummary), total, limit, offset };
}

/**
 * A ficha do envio, com a árvore de arquivos e o destino. **Uuid torto é
 * `null`**, não erro: o painel endereça o envio pelo que veio na URL, e um
 * texto que não é uuid tem de virar o 404 da tela — não o 22P02 do driver
 * (500).
 *
 * `targets` traz nome, slug e `isActive` **atuais** de cada catálogo e vMCP do
 * destino, ordenados por nome (desempate pelo slug, como `listCatalogs`); sem
 * destino, `{ catalogs: [], mcps: [] }`. O recorte do que a sessão enxerga é
 * do app (`QuarantineSheet`).
 */
export async function getQuarantine(uuid: string): Promise<QuarantineDetail | null> {
  if (!isUuid(uuid)) return null;

  const result = await db().execute(sql`
    SELECT ${QUARANTINE_COLUMNS} ${QUARANTINE_FROM} WHERE q.uuid = ${uuid}
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  return {
    ...toQuarantineSummary(row),
    files: await listQuarantineFilesFrom(db(), uuid),
    targets: await listQuarantineTargetsFrom(db(), uuid),
  };
}

export type CreateQuarantineInput = {
  /** O rótulo: o `name:` do SKILL.md, ou o nome do arquivo enviado. */
  name: string;
  description?: string;
  /** O `pacote.zip` de origem, informativo. */
  sourceFilename?: string | null;
  /**
   * Os arquivos como chegaram — **o SKILL.md vai cru, com o frontmatter
   * dentro**. Lista vazia é um envio vazio, e é um estado legítimo: o
   * arquivo que falta pode ser acrescentado depois, antes de aprovar.
   */
  files?: readonly FileInput[];
  /**
   * O destino (`035`): os catálogos em que a skill entra e os vMCPs em que ela
   * ganha vínculo direto **quando o envio for aprovado** — até lá, nada muda
   * neles. Gravado na mesma transação do envio. Omitido: sem destino, e a
   * aprovação cria a skill flutuante. Informado, as duas listas são
   * obrigatórias (vazia vale). A checagem de que quem envia edita cada alvo é
   * do app, antes de chamar.
   */
  targets?: QuarantineTargetsInput;
};

/**
 * Grava o envio, os arquivos e o destino numa transação só: gravá-los depois
 * deixaria o envio existindo sem o pacote quando o segundo passo falhasse — a
 * mesma razão dos anexos de `createSkill`.
 *
 * O dono é quem submeteu (`actor`), como em `createSkill`; sem conta (token
 * global, bootstrap) o envio nasce órfão, só do admin. Audita
 * `quarantine.create` com o nome do envio em `target_label` — o destino é
 * parte do envio que apareceu, e não ganha linha própria.
 *
 * O destino é validado **antes** da transação (`parseQuarantineTargets` e
 * `assertQuarantineTargetsExist`): uuid torto ou desconhecido, alvo repetido e
 * vMCP com as três portas desligadas são 400, e nada é gravado.
 */
export async function createQuarantine(
  input: CreateQuarantineInput,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<QuarantineDetail> {
  const name = (optionalText(input.name, 'name') ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');
  const description = optionalText(input.description, 'description')?.trim() ?? '';
  const sourceFilename = optionalText(input.sourceFilename, 'sourceFilename')?.trim() || null;
  // Validados antes de abrir a transação: um caminho recusado no meio da
  // gravação deixaria o envio criado sem parte dos arquivos.
  const files = quarantineFileInputs(input.files ?? []);
  const targets =
    input.targets === undefined ? NO_TARGETS : parseQuarantineTargets(input.targets, 'targets');
  await assertQuarantineTargetsExist(db(), targets);

  let uuid: string;
  try {
    uuid = await db().transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO quarantine_skills
          (name, description, source_filename, owner_user_uuid, created_by_user_uuid)
        VALUES (${name}, ${description}, ${sourceFilename},
                ${actor?.userUuid ?? null}, ${actor?.userUuid ?? null})
        RETURNING uuid
      `);
      const novo = (inserted.rows as Row[])[0].uuid as string;
      // Sem travar nada: ninguém mais conhece este uuid ainda.
      await upsertQuarantineFilesTx(tx, novo, files);
      await writeQuarantineTargetsTx(tx, novo, targets);
      await auditTx(tx, quarantineAudit('quarantine.create', name, source, actor));
      return novo;
    });
  } catch (err) {
    throw targetGoneOr(err);
  }

  const detail = await getQuarantine(uuid);
  if (!detail) throw new Error('Envio criado mas não encontrado');
  return detail;
}

/** Um arquivo do envio, com os bytes — a mesma forma de `readFile`. */
export async function readQuarantineFile(
  uuid: string,
  relativePath: string,
): Promise<FileContent | null> {
  if (!isUuid(uuid)) return null;
  return readQuarantineFileFrom(db(), uuid, relativePath);
}

/** Todos os arquivos do envio, com bytes — é o `.zip` que o painel baixa. */
export async function readAllQuarantineFiles(uuid: string): Promise<FileContent[]> {
  if (!isUuid(uuid)) return [];
  return readAllQuarantineFilesFrom(db(), uuid);
}

/**
 * Cria um arquivo do envio **só se o caminho está livre**, com as mesmas
 * recusas de `createFile` (o mesmo caminho, um prefixo que é arquivo, algo
 * abaixo de um caminho que já é pasta) e as mesmas mensagens.
 *
 * **Uma diferença, e é de propósito:** aqui o `SKILL.md` é um caminho como
 * outro qualquer. Numa skill ele sempre existe e criá-lo é 409; num envio ele
 * pode faltar — e criá-lo é justamente o que conserta o envio que a promoção
 * recusou.
 *
 * **Sem o `ON CONFLICT DO NOTHING` de `createFile`**: lá ele é a garantia
 * contra quem grava sem a trava, e aqui não há esse "quem". A trava é a linha
 * do envio em `FOR UPDATE` (`lockQuarantineTx`, a primeira statement), e ela
 * barra **até o INSERT de quem não a pediu** — a FK de `quarantine_files` pede
 * `FOR KEY SHARE` na linha do envio, que conflita com `FOR UPDATE`. Medido:
 * com uma transação segurando o `FOR UPDATE`, um `INSERT` cru na outra fica
 * esperando e só entra depois do `ROLLBACK` dela. Entre a conferência e o
 * INSERT não cabe ninguém.
 */
export async function createQuarantineFile(
  uuid: string,
  relativePath: string,
  content: Buffer | string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillFileMeta> {
  assertQuarantineUuid(uuid);
  const path = normalizeRelativePath(relativePath);
  if (!path) throw badRequest(`Caminho inválido: ${relativePath}`);
  if (typeof content !== 'string' && !Buffer.isBuffer(content)) {
    throw badRequest('O conteúdo do arquivo precisa ser texto ou bytes');
  }

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  // `quarantine_files`: aqui o `SKILL.md` binário entra, e é a promoção que o
  // cobra em texto — ver `fileColumns`.
  const file = fileColumns(path, buffer, 'quarantine_files');
  const depth = path.split('/').length;

  await db().transaction(async (tx) => {
    const envio = await lockQuarantineTx(tx, uuid);

    // Uma consulta para as três ocupações, como em `createFile`: `conflito` é a
    // ordem das mensagens e, dentro de cada uma, vence o caminho mais curto.
    const found = await tx.execute(sql`
      WITH pedido AS (SELECT lower(${path}) AS caminho)
      SELECT f.relative_path,
             CASE
               WHEN lower(f.relative_path) = p.caminho THEN 1
               WHEN starts_with(p.caminho, lower(f.relative_path) || '/') THEN 2
               ELSE 3
             END AS conflito
        FROM quarantine_files f
       CROSS JOIN pedido p
       WHERE f.quarantine_uuid = ${uuid}
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
    if (kind === 3) {
      // `lower()` não cria nem tira `/`: os primeiros segmentos da linha são a pasta.
      const folder = taken!.split('/').slice(0, depth).join('/');
      throw conflict(`Já existe uma pasta ${folder}`);
    }

    await tx.execute(insertQuarantineFileSql(uuid, path, file));
    await auditTx(tx, quarantineAudit('quarantine.update', envio.name, source, actor, path));
  });

  return {
    relativePath: path,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    isText: file.isText,
  };
}

/**
 * Cria ou sobrescreve um arquivo do envio (upsert, em qualquer caixa). Audita
 * `quarantine.update` com o caminho em `file_path` e o conteúdo anterior —
 * `quarantine.create` é o envio que apareceu, não o arquivo.
 */
export async function setQuarantineFile(
  uuid: string,
  relativePath: string,
  content: Buffer | string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillFileMeta> {
  assertQuarantineUuid(uuid);
  const path = normalizeRelativePath(relativePath);
  if (!path) throw badRequest(`Caminho inválido: ${relativePath}`);

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  // Fora da transação, como na skill — só que aqui o `SKILL.md` binário passa:
  // salvá-lo como veio é parte do conserto que a quarentena permite.
  const { mimeType, sizeBytes, isText } = fileColumns(path, buffer, 'quarantine_files');

  await db().transaction(async (tx) => {
    const envio = await lockQuarantineTx(tx, uuid);
    const previous = await readQuarantineFileFrom(tx, uuid, path);
    await upsertQuarantineFilesTx(tx, uuid, [{ path, buffer }]);
    await auditTx(
      tx,
      quarantineAudit(
        'quarantine.update',
        envio.name,
        source,
        actor,
        path,
        previous?.isText ? previous.buffer.toString('utf8') : null,
      ),
    );
  });

  return { relativePath: path, mimeType, sizeBytes, isText };
}

/**
 * Vários arquivos de uma vez — o envio de um `.zip` inteiro sobre um envio que
 * já existe. Upsert, **sem `replace`**: o que não veio fica. Uma statement por
 * lote (`upsertQuarantineFilesTx`) e uma linha de auditoria só, sem
 * `file_path`; devolve a árvore inteira depois da gravação, como `setFiles`.
 */
export async function setQuarantineFiles(
  uuid: string,
  files: readonly FileInput[],
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillFileMeta[]> {
  assertQuarantineUuid(uuid);
  const normalized = quarantineFileInputs(files);
  if (normalized.length === 0) throw badRequest('Nenhum arquivo informado');

  await db().transaction(async (tx) => {
    const envio = await lockQuarantineTx(tx, uuid);
    await upsertQuarantineFilesTx(tx, uuid, normalized);
    await auditTx(tx, quarantineAudit('quarantine.update', envio.name, source, actor));
  });

  return listQuarantineFilesFrom(db(), uuid);
}

/**
 * Apaga um arquivo do envio; caminho que não existe é 404. **O `SKILL.md` pode
 * sair** — ao contrário de `deleteFile`: um envio sem ele é um estado legítimo
 * (só não é promovível), e a quarentena é uma pasta, não uma skill.
 */
export async function deleteQuarantineFile(
  uuid: string,
  relativePath: string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<void> {
  assertQuarantineUuid(uuid);
  const path = normalizeRelativePath(relativePath);
  if (!path) throw badRequest(`Caminho inválido: ${relativePath}`);

  await db().transaction(async (tx) => {
    const envio = await lockQuarantineTx(tx, uuid);
    const previous = await readQuarantineFileFrom(tx, uuid, path);
    if (!previous) throw notFound(`Arquivo não encontrado: ${path}`);

    // Pelo caminho exato da linha lida, não por `lower(...)`: um filtro
    // insensível a caixa apagaria de uma vez todas as variantes do nome.
    await tx.execute(sql`
      DELETE FROM quarantine_files
      WHERE quarantine_uuid = ${uuid} AND relative_path = ${previous.relativePath}
    `);
    await auditTx(
      tx,
      quarantineAudit(
        'quarantine.update',
        envio.name,
        source,
        actor,
        path,
        previous.isText ? previous.buffer.toString('utf8') : null,
      ),
    );
  });
}

/**
 * Descarta o envio. Os arquivos vão junto pela cascata
 * (`quarantine_files_quarantine_uuid_fkey`); audita `quarantine.delete` com o
 * nome do envio. Envio inexistente — ou uuid torto — é 404.
 */
export async function deleteQuarantine(
  uuid: string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<void> {
  assertQuarantineUuid(uuid);

  await db().transaction(async (tx) => {
    const envio = await lockQuarantineTx(tx, uuid);
    await tx.execute(sql`DELETE FROM quarantine_skills WHERE uuid = ${uuid}`);
    await auditTx(tx, quarantineAudit('quarantine.delete', envio.name, source, actor));
  });
}

/**
 * Define o destino do envio de forma **declarativa**, como `setCatalogSkills`:
 * `targets` é o estado desejado inteiro. Quem saiu é removido, quem entrou é
 * inserido e o vMCP que ficou tem só as portas reescritas (o `created_at`
 * fica). Devolve a ficha inteira, com o destino relido.
 *
 * Os erros, em ordem: envio com uuid torto é 404; destino malformado — lista
 * que falta, uuid torto, alvo repetido, porta que não é booleana ou vMCP com as
 * três desligadas — é 400 antes de abrir a transação; envio inexistente é o 404
 * de `lockQuarantineTx`; catálogo ou vMCP desconhecido é 400, e nada muda.
 *
 * **Sem mudança, sem escrita**: quando o destino pedido é o gravado (mesmos
 * catálogos; mesmos vMCPs com as mesmas portas), nada é tocado — nem
 * `updated_at`, nem a trilha —, como `addCatalogSkill` com quem já é membro. O
 * painel salva a ficha inteira, e um salvar sem mudança não é evento.
 *
 * Com mudança: carimba `updated_at` do envio **à mão** (o trigger de
 * `quarantine_files` não alcança o destino, e o `035` explica por que não há
 * trigger aqui) e audita `quarantine.update` com o nome do envio em
 * `target_label`, sem `file_path`.
 *
 * **A ordem das travas** é a da promoção: o envio primeiro (`FOR UPDATE`), e
 * depois os vMCPs **antes** dos catálogos, cada lista na ordem do uuid. Aqui ela
 * vale para o `FOR KEY SHARE` que a FK de cada INSERT pede no alvo — ver a nota
 * de `promoteQuarantine`, que diz o que foi medido e por que ela fica mesmo sem
 * ter aparecido na medida.
 *
 * O alvo apagado entre a checagem e o INSERT vira o mesmo 400 (`targetGoneOr`):
 * o destino pedido não existe mais, e quem pediu confere de novo.
 */
export async function setQuarantineTargets(
  uuid: string,
  targets: QuarantineTargetsInput,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<QuarantineDetail> {
  assertQuarantineUuid(uuid);
  const wanted = parseQuarantineTargets(targets, 'targets');

  try {
    await db().transaction(async (tx) => {
      const envio = await lockQuarantineTx(tx, uuid);
      await assertQuarantineTargetsExist(tx, wanted);

      const current = await readQuarantineTargetKeysFrom(tx, uuid);
      if (sameTargets(current, wanted)) return;

      await writeQuarantineTargetsTx(tx, uuid, wanted);
      await tx.execute(sql`UPDATE quarantine_skills SET updated_at = now() WHERE uuid = ${uuid}`);
      await auditTx(tx, quarantineAudit('quarantine.update', envio.name, source, actor));
    });
  } catch (err) {
    throw targetGoneOr(err);
  }

  const detail = await getQuarantine(uuid);
  if (!detail) throw new Error('Envio atualizado mas não encontrado');
  return detail;
}

export type PromoteQuarantineOptions = {
  /**
   * O destino que quem aprova **leu na ficha** e para o qual o app conferiu
   * `edit` em cada alvo. Dentro da transação, com o envio travado, ele é
   * comparado com o gravado — conjunto de catálogos; conjunto de vMCPs com as
   * três portas — e a diferença é **409**, sem criar nada: fecha a janela entre
   * a checagem do app e a gravação. Omitido, a promoção cumpre o que estiver
   * gravado sem comparar.
   */
  expectedTargets?: QuarantineTargetsInput;
};

/**
 * A aprovação: o envio vira skill e **some da quarentena**, numa transação só —
 * senão restaria uma skill pela metade ou um envio apagado sem skill.
 *
 * O que ela decide, em ordem:
 *
 * 1. **sem `SKILL.md` legível não há promoção** (`isSkillMd`, como nas demais):
 *    é 400 quando ele **falta** e 400 quando ele está lá mas **não é texto
 *    UTF-8 válido**, os dois com o nome do envio na mensagem e **sem apagar
 *    nada** — o envio fica onde está, para receber ou consertar o arquivo. A
 *    segunda recusa é a contrapartida de a quarentena aceitar o `SKILL.md`
 *    binário (ver `fileColumns`): guardar o pacote torto é para o que o espaço
 *    serve, e é aqui, na porta do acervo, que a exigência de `files` volta a
 *    valer — daqui em diante esse arquivo é lido como texto
 *    (`skillMetaFromMarkdown`, `stripFrontmatter`, o `search_vector`, o RAG);
 * 2. **os metadados saem do SKILL.md cru** (`skillMetaFromMarkdown`): nome,
 *    descrição e tags. Nome vazio cai para o nome do envio, descrição vazia
 *    para a do envio. O corpo gravado é o `stripFrontmatter` dele — daqui em
 *    diante os metadados moram em colunas, como em toda skill. Um SKILL.md só
 *    de frontmatter vira uma skill de corpo **vazio**, e isso passa: o envio é
 *    a verdade, e barrar a aprovação por uma linha em branco seria mandar quem
 *    revisou editar o pacote para nada — `createSkill` recusa porque lá o
 *    corpo é o que o chamador digitou;
 * 3. **o slug é derivado, com sufixo automático** (`-2`, `-3`…): o mesmo
 *    caminho de quem cria uma skill sem pedir slug. Vale tanto para o `name:`
 *    do frontmatter quanto para o nome do envio — colisão aqui não é erro de
 *    ninguém, e devolver 409 a quem aprova seria um beco sem saída;
 * 4. **o dono é quem aprova**, nas duas colunas: `owner_user_uuid` e
 *    `created_by_user_uuid` recebem o ator, como em `createSkill` — promover
 *    **é** criar a skill. Ator sem conta (token global, bootstrap) gera skill
 *    órfã, como em qualquer criação, e o dono do envio não entra em lugar
 *    nenhum da skill. A regra anterior — dono = quem submeteu — era deliberada
 *    (`docs/15` decisão 7) e escondia um defeito medido: com a política
 *    `quarantine.approvers = admin+editor`, o editor que aprovava o envio de
 *    outra conta criava uma skill privada, flutuante e sem concessão nenhuma —
 *    que `skillVisibleTo` não alcança — e **deixava de enxergá-la no mesmo
 *    instante**: o aviso de sucesso caía numa tela de "Skill não encontrada".
 *    Devolver a skill a quem a trouxe é transferir ou conceder, que são atos
 *    com trilha;
 * 5. **a skill nasce onde o destino manda** (`035`): sem ícone, `is_public`
 *    falso e ligada, como sempre, e — na mesma transação — **com participação
 *    ativa em cada catálogo** do destino (`catalog.update` no catálogo, como
 *    `addCatalogSkill`) e **vínculo direto com cada vMCP**, com as portas
 *    gravadas (`linkTx`, `mcp.update` no servidor). Sem destino, nasce
 *    flutuante, como antes. Era sempre flutuante (`docs/15` decisão 8) até o
 *    `035`, que a revogou: quem importa escolhe o destino no upload;
 * 6. **os demais arquivos viram anexos**, com o caminho intacto;
 * 7. a linha da quarentena e os arquivos dela **somem** (a cascata cuida dos
 *    arquivos e do destino).
 *
 * **O destino esperado** (`options.expectedTargets`) é comparado com o gravado
 * logo depois de travar o envio, antes de ler arquivo: diferente é **409**, e
 * nada é criado nem apagado.
 *
 * **O alvo apagado no meio é pulado em silêncio.** O destino é lido com o
 * envio travado, mas `deleteCatalog`/`deleteVirtualMcp` não passam pelo envio:
 * a cascata do `035` tira a linha do destino sem pedir a dele. Se o catálogo
 * ou o vMCP some entre a leitura e a trava do alvo, a trava volta vazia e ele
 * fica de fora — o mesmo estado final de a remoção ter vindo logo depois da
 * aprovação, quando a cascata de `catalog_skills`/`virtual_mcp_skills` levaria
 * a participação e o vínculo recém-criados.
 *
 * **A ordem das travas**, fixa: o envio (`FOR UPDATE`, `lockQuarantineTx`);
 * depois **todos os vMCPs**, na ordem do uuid, cada um pelo caminho de `linkTx`
 * (trava pura, vínculo, `UPDATE` por último); e só então **todos os
 * catálogos**, na ordem do uuid, cada um em `FOR UPDATE` (`lockCatalogTx`). As
 * duas escolhas foram medidas, 150 rodadas por cenário contra um banco
 * descartável (os cenários ficaram em `quarantine-targets.integration.test.ts`,
 * com 30):
 *
 *   - *o uuid dentro de cada lista*, a lição de `createSkill`: com a ordem
 *     sorteada por promoção, duas promoções com os mesmos alvos morreram por
 *     40P01 em 78 de 150 pares; na ordem do uuid, em nenhum;
 *   - *o vMCP antes do catálogo*, porque é a ordem de quem já existe:
 *     `linkCatalog`, `setVirtualMcpCatalogs` e `cloneVirtualMcp` seguram o vMCP
 *     e pedem, pela FK de `virtual_mcp_catalogs`, `FOR KEY SHARE` no catálogo —
 *     que o `FOR UPDATE` da promoção barra. Com o catálogo primeiro, a promoção
 *     segurava o catálogo esperando o vMCP enquanto o `linkCatalog` segurava o
 *     vMCP esperando o catálogo: 149 mortes em 150 rodadas de duas promoções,
 *     um `linkCatalog` e um `setVirtualMcpCatalogs` nos mesmos alvos; com o
 *     vMCP primeiro, nenhuma. Nenhuma escrita do código trava catálogo e depois
 *     vMCP, então esta ordem não fecha ciclo com ninguém.
 *
 * Na mesma medida, zero mortes contra `setQuarantineTargets` de outro envio,
 * `setCatalogSkills`, `addCatalogSkill`, `linkSkill`, `createSkill` com vínculos
 * e `deleteCatalog`/`deleteVirtualMcp` dos próprios alvos.
 *
 * `setQuarantineTargets` pede as mesmas linhas pela FK (`FOR KEY SHARE`) e grava
 * na mesma ordem, vMCPs e depois catálogos. Ali a ordem **não** apareceu na
 * medida — catálogos primeiro também deu zero em 300 rodadas contra a promoção
 * —, e ela fica por precaução: o `FOR KEY SHARE` no vMCP pode esperar um
 * `UPDATE virtual_mcps` em andamento (a espera por versão superada descrita
 * em `linkTx`), e na mesma ordem quem ainda espera um vMCP não segura catálogo
 * nenhum.
 *
 * A skill promovida é skill normal: os triggers do `020` a marcam pendente
 * para o RAG (`rag_stale`) e o `search_vector` é montado como em qualquer
 * criação. Audita a `create` da skill, como toda criação, as linhas de cada
 * destino cumprido e `quarantine.promote` com `<nome do envio> -> <slug
 * criado>`.
 */
export async function promoteQuarantine(
  uuid: string,
  source: AuditSource,
  actor?: AuditActor | null,
  options: PromoteQuarantineOptions = {},
): Promise<SkillDetail> {
  assertQuarantineUuid(uuid);
  const expected =
    options.expectedTargets === undefined
      ? null
      : parseQuarantineTargets(options.expectedTargets, 'expectedTargets');

  let slug = '';

  // O slug é escolhido lendo os ocupados e gravado depois: duas promoções (ou
  // uma promoção e uma criação) simultâneas podem escolher o mesmo. Como ele é
  // **derivado**, a intenção é "qualquer slug livre" e vale tentar de novo — a
  // transação inteira, porque a violação de UNIQUE aborta tudo. O envio segue
  // intacto no banco até o COMMIT que o apaga, então repetir é seguro.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db().transaction(async (tx) => {
        const envio = await lockQuarantineTx(tx, uuid);

        // Com o envio travado, ninguém grava destino até o COMMIT; só a cascata
        // de um alvo apagado ainda o alcança (ver a nota acima).
        const destino = await readQuarantineTargetKeysFrom(tx, uuid);
        if (expected && !sameTargets(destino, expected)) {
          throw conflict(
            `O destino do envio "${envio.name}" mudou enquanto você aprovava: ` +
              'confira e aprove de novo',
          );
        }

        const files = await readAllQuarantineFilesFrom(tx, uuid);

        const main = files.find((file) => isSkillMd(file.relativePath));
        if (!main) {
          throw badRequest(
            `O envio "${envio.name}" não tem SKILL.md e não pode ser aprovado: ` +
              'acrescente o arquivo e tente de novo',
          );
        }
        // `isText` é o que está gravado: no envio, o `SKILL.md` que não é UTF-8
        // válido (ou tem byte nulo) entrou como binário, de propósito. Ele é
        // recusado aqui, antes de qualquer escrita — `toString('utf8')` não
        // falharia, trocaria cada byte inválido por U+FFFD e a skill nasceria
        // com o corpo corrompido para sempre.
        if (!main.isText) {
          throw badRequest(
            `O SKILL.md do envio "${envio.name}" não é um texto UTF-8 válido e não ` +
              'pode ser aprovado: converta o arquivo para UTF-8 e salve-o aqui na ' +
              'quarentena antes de tentar de novo',
          );
        }

        const raw = main.buffer.toString('utf8');
        const meta = skillMetaFromMarkdown(raw);
        const name = meta.name?.trim() || envio.name;
        const description = meta.description?.trim() || envio.description;
        slug = await freeSkillSlugTx(tx, meta.slug || name);

        // Quem aprova vira dono, nas duas colunas, como em `createSkill`: quem
        // promove precisa enxergar a skill que acabou de criar (ver a nota 4).
        const inserted = await tx.execute(sql`
          INSERT INTO skills
            (slug, name, description, is_active, is_public,
             created_by_user_uuid, owner_user_uuid)
          VALUES (${slug}, ${name}, ${description}, true, false,
                  ${actor?.userUuid ?? null}, ${actor?.userUuid ?? null})
          RETURNING uuid
        `);
        const skillUuid = (inserted.rows as Row[])[0].uuid as string;

        await upsertFilesTx(tx, skillUuid, [
          { path: SKILL_MD, buffer: Buffer.from(stripFrontmatter(raw), 'utf8') },
          ...files
            .filter((file) => !isSkillMd(file.relativePath))
            .map((file) => ({ path: file.relativePath, buffer: file.buffer })),
        ]);
        await replaceTagsTx(tx, skillUuid, meta.tags);

        await auditTx(tx, {
          skillUuid,
          skillSlug: slug,
          filePath: null,
          action: 'create',
          source,
          actor,
          previousContent: null,
        });
        await fulfillQuarantineTargetsTx(tx, skillUuid, destino, source, actor);
        await auditTx(
          tx,
          quarantineAudit('quarantine.promote', `${envio.name} -> ${slug}`, source, actor),
        );

        // Por último: o envio só some depois de a skill existir inteira.
        await tx.execute(sql`DELETE FROM quarantine_skills WHERE uuid = ${uuid}`);
      });
      break;
    } catch (err) {
      if (!isUniqueViolation(err, 'skills_slug_key')) throw err;
      if (attempt >= SLUG_ATTEMPTS) throw conflict(`Já existe uma skill com o slug "${slug}"`);
    }
  }

  const detail = await getSkillDetail(slug, { visibility: 'all' });
  if (!detail) throw new Error('Skill promovida mas não encontrada');
  return detail;
}

/**
 * Quem pode aprovar um envio, pela política da instalação
 * (`quarantine.approvers`, semeada pela `030` com `admin+owner`). Chave
 * ausente ou com valor que não é um dos três cai no padrão de shared — a
 * política nunca fica indefinida, e um valor escrito à mão no banco não
 * escancara nem tranca o portão por acidente.
 */
export async function getQuarantineApprovers(): Promise<QuarantineApprovers> {
  const result = await db().execute(sql`
    SELECT value FROM settings WHERE key = ${QUARANTINE_APPROVERS_SETTING}
  `);
  const value = (result.rows as Row[])[0]?.value ?? null;
  return isQuarantineApprovers(value) ? value : QUARANTINE_APPROVERS_DEFAULT;
}

/**
 * Grava a política e audita `quarantine.settings` com `chave=valor`, como
 * `rag.settings`. O valor chega como `unknown` — ele vem do corpo da
 * requisição, sem passar por schema —, e o que não é um dos três de
 * `QUARANTINE_APPROVERS` é 400.
 */
export async function setQuarantineApprovers(
  value: unknown,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<QuarantineApprovers> {
  if (!isQuarantineApprovers(value)) {
    throw badRequest(`Quem aprova precisa ser um de: ${QUARANTINE_APPROVERS.join(', ')}`);
  }

  await db().transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO settings (key, value) VALUES (${QUARANTINE_APPROVERS_SETTING}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `);
    await auditTx(tx, {
      skillUuid: null,
      skillSlug: null,
      filePath: null,
      action: 'quarantine.settings',
      source,
      previousContent: null,
      actor,
      targetLabel: `${QUARANTINE_APPROVERS_SETTING}=${value}`,
    });
  });

  return value;
}

/**
 * Uuid torto é 404, não o 22P02 do driver (500): as escritas recebem o uuid
 * que veio da URL do painel. `getQuarantine` é a exceção — ela devolve `null`,
 * que é o mesmo 404 pelo lado de quem lê.
 */
function assertQuarantineUuid(uuid: string): void {
  if (!isUuid(uuid)) throw notFound(`Envio não encontrado: ${String(uuid)}`);
}

/** A linha de auditoria de um evento da quarentena — o envio não tem slug. */
function quarantineAudit(
  action: AuditAction,
  label: string,
  source: AuditSource,
  actor: AuditActor | null | undefined,
  filePath: string | null = null,
  previousContent: string | null = null,
): AuditInput {
  return {
    skillUuid: null,
    skillSlug: null,
    filePath,
    action,
    source,
    previousContent,
    actor,
    targetLabel: label,
  };
}

/**
 * A fila das escritas de um envio, e a **primeira statement** de todas elas —
 * `createQuarantineFile`, `setQuarantineFile`, `setQuarantineFiles`,
 * `deleteQuarantineFile`, `deleteQuarantine` e `promoteQuarantine`: trava a
 * linha do envio (`FOR UPDATE`) e devolve o que a escrita precisa. É o 404 de
 * quem não existe (mais), impede o envio de ser apagado — ou promovido — no
 * meio de uma escrita de arquivo, e garante que o conteúdo anterior lido para
 * a auditoria é o que esta escrita de fato substituiu.
 *
 * **Sem o advisory lock de `lockSkillFilesTx`**, de propósito: o ciclo que
 * existe lá não existe aqui. Em `files`/`skills` há dois caminhos que pedem as
 * duas tabelas em ordens opostas — quem grava arquivo trava a linha de `files`
 * e pede a de `skills` pelos triggers; quem salva a skill com `skillMd` trava
 * `skills` e depois o `SKILL.md`. Aqui **toda** escrita começa pela linha do
 * envio e só então toca `quarantine_files`, sempre nessa ordem, e o trigger
 * `quarantine_files_touch_trg` não fecha ciclo: o `UPDATE … SET updated_at`
 * pede `FOR NO KEY UPDATE`, que **não** conflita com o `FOR KEY SHARE` da FK —
 * medido, com duas transações segurando o `FOR KEY SHARE` da mesma linha, o
 * primeiro `UPDATE` passa e o segundo apenas espera.
 */
async function lockQuarantineTx(
  tx: Tx,
  uuid: string,
): Promise<{ name: string; description: string }> {
  const locked = await tx.execute(sql`
    SELECT name, description
    FROM quarantine_skills WHERE uuid = ${uuid} FOR UPDATE
  `);
  const row = (locked.rows as Row[])[0];
  if (!row) throw notFound(`Envio não encontrado: ${uuid}`);
  return {
    name: row.name as string,
    description: (row.description ?? '') as string,
  };
}

/**
 * O destino como o banco o compara e o grava: uuids em minúsculas e as duas
 * listas **na ordem do uuid** — a ordem em que a promoção e
 * `setQuarantineTargets` travam os alvos (ver `promoteQuarantine`).
 */
type TargetKeys = { catalogs: string[]; mcps: SkillLinkInput[] };

const NO_TARGETS: TargetKeys = { catalogs: [], mcps: [] };

const byUuid = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Valida a forma do destino, sem ir ao banco. As duas listas são obrigatórias
 * — o destino é declarativo, e uma lista ausente lida como vazia apagaria o
 * que estava gravado sem ninguém pedir. Tudo o que não serve é 400: uuid torto,
 * alvo repetido, porta ausente ou não booleana (`requireBoolean`, como em
 * `resolveLinks`) e vMCP com as três portas desligadas — o CHECK
 * `quarantine_mcps_some_port_chk` recusaria de qualquer jeito, e aqui a
 * mensagem diz qual.
 */
function parseQuarantineTargets(value: unknown, field: string): TargetKeys {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`O campo "${field}" deve ser um objeto com "catalogs" e "mcps"`);
  }
  const input = value as { catalogs?: unknown; mcps?: unknown };
  if (!Array.isArray(input.catalogs)) {
    throw badRequest(`O campo "${field}.catalogs" deve ser uma lista`);
  }
  if (!Array.isArray(input.mcps)) {
    throw badRequest(`O campo "${field}.mcps" deve ser uma lista`);
  }

  const catalogs = new Set<string>();
  input.catalogs.forEach((item: unknown, index: number) => {
    if (!isUuid(item)) {
      throw badRequest(`${field}.catalogs[${index}]: precisa ser o uuid de um catálogo`);
    }
    const uuid = item.toLowerCase();
    if (catalogs.has(uuid)) throw badRequest(`Catálogo repetido no destino: ${uuid}`);
    catalogs.add(uuid);
  });

  const seen = new Set<string>();
  const mcps = input.mcps.map((item: unknown, index: number): SkillLinkInput => {
    const raw = (item as Partial<SkillLinkInput> | null)?.virtualMcpUuid;
    if (!isUuid(raw)) {
      throw badRequest(`${field}.mcps[${index}]: "virtualMcpUuid" precisa ser um uuid`);
    }
    const uuid = raw.toLowerCase();
    if (seen.has(uuid)) throw badRequest(`MCP virtual repetido no destino: ${uuid}`);
    seen.add(uuid);
    const subject = `MCP virtual "${uuid}"`;
    const flags = item as SkillLinkInput;
    const link = {
      virtualMcpUuid: uuid,
      asSkill: requireBoolean(flags.asSkill, 'asSkill', subject),
      asPrompt: requireBoolean(flags.asPrompt, 'asPrompt', subject),
      asResource: requireBoolean(flags.asResource, 'asResource', subject),
    };
    if (!link.asSkill && !link.asPrompt && !link.asResource) {
      throw badRequest(
        `${subject}: ligue pelo menos uma das portas (asSkill, asPrompt ou asResource)`,
      );
    }
    return link;
  });

  return {
    catalogs: [...catalogs].sort(byUuid),
    mcps: mcps.sort((a, b) => byUuid(a.virtualMcpUuid, b.virtualMcpUuid)),
  };
}

/**
 * Catálogo ou vMCP desconhecido no destino é **400**, como em `resolveLinks`:
 * é erro de quem mandou a lista, não recurso da URL. Uma consulta por tabela;
 * a mensagem nomeia o primeiro que falta, na ordem do uuid.
 *
 * Não trava nada: a garantia de que o alvo ainda existe no COMMIT é a FK do
 * INSERT, e o alvo apagado entre esta leitura e ele vira o mesmo 400 por
 * `targetGoneOr`.
 */
async function assertQuarantineTargetsExist(
  executor: Pick<Tx, 'execute'>,
  targets: TargetKeys,
): Promise<void> {
  if (targets.catalogs.length > 0) {
    const found = await executor.execute(sql`
      SELECT uuid FROM catalogs WHERE uuid = ANY(${sql.param(targets.catalogs)}::uuid[])
    `);
    const known = new Set((found.rows as Row[]).map((row) => row.uuid as string));
    const missing = targets.catalogs.find((uuid) => !known.has(uuid));
    if (missing) throw badRequest(`Catálogo não encontrado: ${missing}`);
  }
  if (targets.mcps.length > 0) {
    const wanted = targets.mcps.map((mcp) => mcp.virtualMcpUuid);
    const found = await executor.execute(sql`
      SELECT uuid FROM virtual_mcps WHERE uuid = ANY(${sql.param(wanted)}::uuid[])
    `);
    const known = new Set((found.rows as Row[]).map((row) => row.uuid as string));
    const missing = wanted.find((uuid) => !known.has(uuid));
    if (missing) throw badRequest(`MCP virtual não encontrado: ${missing}`);
  }
}

/** O alvo que sumiu entre a checagem e o INSERT: o 400 da checagem, não 500. */
function targetGoneOr(err: unknown): unknown {
  if (isForeignKeyViolation(err, 'quarantine_catalogs_catalog_uuid_fkey')) {
    return badRequest('Um catálogo do destino não existe mais: confira o destino e tente de novo');
  }
  if (isForeignKeyViolation(err, 'quarantine_mcps_virtual_mcp_uuid_fkey')) {
    return badRequest('Um MCP virtual do destino não existe mais: confira o destino e tente de novo');
  }
  return err;
}

/**
 * Grava o destino inteiro sobre o que houver — o `DELETE` do que saiu e o
 * upsert do que ficou ou entrou. **vMCPs antes de catálogos**, cada lista numa
 * statement e na ordem do uuid: as FKs travam os alvos em `FOR KEY SHARE`
 * nessa ordem, a mesma em que a promoção os trava (ver `promoteQuarantine`).
 * Num envio recém-criado os dois `DELETE`s não acham nada.
 */
async function writeQuarantineTargetsTx(
  tx: Tx,
  uuid: string,
  targets: TargetKeys,
): Promise<void> {
  const mcps = targets.mcps.map((mcp) => mcp.virtualMcpUuid);
  await tx.execute(sql`
    DELETE FROM quarantine_mcps
    WHERE quarantine_uuid = ${uuid}
      AND virtual_mcp_uuid <> ALL(${sql.param(mcps)}::uuid[])
  `);
  if (targets.mcps.length > 0) {
    const linhas = targets.mcps.map(
      (mcp) =>
        sql`(${uuid}, ${mcp.virtualMcpUuid}, ${mcp.asSkill}, ${mcp.asPrompt}, ${mcp.asResource})`,
    );
    // Só as portas no `DO UPDATE`, e só quando mudaram: o vMCP que ficou
    // mantém o `created_at` e não gera versão nova da linha à toa.
    await tx.execute(sql`
      INSERT INTO quarantine_mcps
        (quarantine_uuid, virtual_mcp_uuid, as_skill, as_prompt, as_resource)
      VALUES ${sql.join(linhas, sql`, `)}
      ON CONFLICT (quarantine_uuid, virtual_mcp_uuid) DO UPDATE SET
        as_skill = EXCLUDED.as_skill,
        as_prompt = EXCLUDED.as_prompt,
        as_resource = EXCLUDED.as_resource
      WHERE (quarantine_mcps.as_skill, quarantine_mcps.as_prompt, quarantine_mcps.as_resource)
            IS DISTINCT FROM (EXCLUDED.as_skill, EXCLUDED.as_prompt, EXCLUDED.as_resource)
    `);
  }

  await tx.execute(sql`
    DELETE FROM quarantine_catalogs
    WHERE quarantine_uuid = ${uuid}
      AND catalog_uuid <> ALL(${sql.param(targets.catalogs)}::uuid[])
  `);
  if (targets.catalogs.length > 0) {
    const linhas = targets.catalogs.map((catalog) => sql`(${uuid}, ${catalog})`);
    await tx.execute(sql`
      INSERT INTO quarantine_catalogs (quarantine_uuid, catalog_uuid)
      VALUES ${sql.join(linhas, sql`, `)}
      ON CONFLICT (quarantine_uuid, catalog_uuid) DO NOTHING
    `);
  }
}

/** O destino gravado, na forma de comparação (`TargetKeys`). */
async function readQuarantineTargetKeysFrom(
  executor: Pick<Tx, 'execute'>,
  uuid: string,
): Promise<TargetKeys> {
  const catalogs = await executor.execute(sql`
    SELECT catalog_uuid FROM quarantine_catalogs WHERE quarantine_uuid = ${uuid}
  `);
  const mcps = await executor.execute(sql`
    SELECT virtual_mcp_uuid, as_skill, as_prompt, as_resource
    FROM quarantine_mcps WHERE quarantine_uuid = ${uuid}
  `);
  return {
    catalogs: (catalogs.rows as Row[]).map((row) => row.catalog_uuid as string).sort(byUuid),
    mcps: (mcps.rows as Row[])
      .map((row) => ({
        virtualMcpUuid: row.virtual_mcp_uuid as string,
        asSkill: Boolean(row.as_skill),
        asPrompt: Boolean(row.as_prompt),
        asResource: Boolean(row.as_resource),
      }))
      .sort((a, b) => byUuid(a.virtualMcpUuid, b.virtualMcpUuid)),
  };
}

/** Os dois destinos são o mesmo: os mesmos catálogos e os mesmos vMCPs com as mesmas portas. */
function sameTargets(a: TargetKeys, b: TargetKeys): boolean {
  return (
    a.catalogs.length === b.catalogs.length &&
    a.catalogs.every((uuid, i) => uuid === b.catalogs[i]) &&
    a.mcps.length === b.mcps.length &&
    a.mcps.every((mcp, i) => {
      const other = b.mcps[i]!;
      return (
        mcp.virtualMcpUuid === other.virtualMcpUuid &&
        mcp.asSkill === other.asSkill &&
        mcp.asPrompt === other.asPrompt &&
        mcp.asResource === other.asResource
      );
    })
  );
}

/** A ficha do destino: nome, slug e `isActive` atuais de cada alvo, por nome. */
async function listQuarantineTargetsFrom(
  executor: Pick<Tx, 'execute'>,
  uuid: string,
): Promise<QuarantineTargets> {
  const catalogs = await executor.execute(sql`
    SELECT c.uuid, c.slug, c.name, c.is_active
    FROM quarantine_catalogs qc
    JOIN catalogs c ON c.uuid = qc.catalog_uuid
    WHERE qc.quarantine_uuid = ${uuid}
    ORDER BY c.name ASC, c.slug ASC
  `);
  const mcps = await executor.execute(sql`
    SELECT m.uuid, m.slug, m.name, m.is_active, qm.as_skill, qm.as_prompt, qm.as_resource
    FROM quarantine_mcps qm
    JOIN virtual_mcps m ON m.uuid = qm.virtual_mcp_uuid
    WHERE qm.quarantine_uuid = ${uuid}
    ORDER BY m.name ASC, m.slug ASC
  `);
  return {
    catalogs: (catalogs.rows as Row[]).map(
      (row): QuarantineCatalogTarget => ({
        uuid: row.uuid,
        slug: row.slug,
        name: row.name,
        isActive: Boolean(row.is_active),
      }),
    ),
    mcps: (mcps.rows as Row[]).map(
      (row): QuarantineMcpTarget => ({
        uuid: row.uuid,
        slug: row.slug,
        name: row.name,
        isActive: Boolean(row.is_active),
        asSkill: Boolean(row.as_skill),
        asPrompt: Boolean(row.as_prompt),
        asResource: Boolean(row.as_resource),
      }),
    ),
  };
}

/**
 * Cumpre o destino na transação da promoção, com a skill já criada: vínculo
 * direto em cada vMCP e participação ativa em cada catálogo, **nessa ordem e
 * cada lista na ordem do uuid** (ver `promoteQuarantine`). Cada vínculo audita
 * `mcp.update` (`linkTx`); cada catálogo, `catalog.update` (`touchCatalogTx`),
 * como `addCatalogSkill`.
 *
 * A trava de cada alvo vem antes de tudo o que o toca, e o alvo que ela não
 * acha — apagado depois de o destino ser lido — é pulado sem erro. No vMCP a
 * trava é a mesma que `linkTx` pede em seguida (`FOR NO KEY UPDATE`; pedir de
 * novo na mesma transação não espera), e é ela que dá o slug atual para a
 * auditoria.
 */
async function fulfillQuarantineTargetsTx(
  tx: Tx,
  skillUuid: string,
  targets: TargetKeys,
  source: AuditSource,
  actor: AuditActor | null | undefined,
): Promise<void> {
  for (const mcp of targets.mcps) {
    const locked = await tx.execute(sql`
      SELECT slug FROM virtual_mcps WHERE uuid = ${mcp.virtualMcpUuid} FOR NO KEY UPDATE
    `);
    const row = (locked.rows as Row[])[0];
    if (!row) continue;
    await linkTx(tx, skillUuid, { ...mcp, mcpSlug: row.slug as string }, source, actor);
  }

  for (const catalogUuid of targets.catalogs) {
    // A trava de `lockCatalogTx`, sem o 404 dela.
    const locked = await tx.execute(
      sql`SELECT slug FROM catalogs WHERE uuid = ${catalogUuid} FOR UPDATE`,
    );
    const row = (locked.rows as Row[])[0];
    if (!row) continue;
    await tx.execute(sql`
      INSERT INTO catalog_skills (catalog_uuid, skill_uuid)
      VALUES (${catalogUuid}, ${skillUuid})
      ON CONFLICT (catalog_uuid, skill_uuid) DO NOTHING
    `);
    await touchCatalogTx(tx, catalogUuid, row.slug as string, source, actor);
  }
}

/**
 * Os arquivos recebidos, validados **antes** da transação: caminho por
 * `normalizeRelativePath` (400 no que não serve) e o conteúdo como bytes. Ao
 * contrário de `createSkill`, o `SKILL.md` **não** é filtrado: aqui ele é um
 * arquivo do pacote como os outros, e vai cru.
 */
function quarantineFileInputs(
  files: readonly FileInput[],
): { path: string; buffer: Buffer }[] {
  return files.map((file) => {
    const path = normalizeRelativePath(file.relativePath);
    if (!path) throw badRequest(`Caminho inválido: ${file.relativePath}`);
    const buffer = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content, 'utf8');
    return { path, buffer };
  });
}

/** As colunas do INSERT de arquivo do envio — a de uma linha e a de lote usam a mesma. */
const QUARANTINE_FILE_COLUMNS = sql`(quarantine_uuid, relative_path, text_content, binary_content, mime_type, size_bytes)`;

function insertQuarantineFileSql(uuid: string, path: string, file: FileColumns): SQL {
  return sql`
    INSERT INTO quarantine_files ${QUARANTINE_FILE_COLUMNS}
    VALUES (${uuid}, ${path}, ${file.text}, ${file.binary}, ${file.mimeType}, ${file.sizeBytes})
  `;
}

/** O `DO UPDATE` das gravações, pelo índice `quarantine_files_path_lower_uniq`. */
const QUARANTINE_FILE_UPSERT = sql`
  ON CONFLICT (quarantine_uuid, lower(relative_path)) DO UPDATE SET
    relative_path = EXCLUDED.relative_path,
    text_content = EXCLUDED.text_content,
    binary_content = EXCLUDED.binary_content,
    mime_type = EXCLUDED.mime_type,
    size_bytes = EXCLUDED.size_bytes,
    updated_at = now()
`;

/**
 * Upsert de vários arquivos do mesmo envio em poucas statements, com as duas
 * exigências da forma em lote de `upsertFilesTx`: deduplicar por
 * `lower(relative_path)` — **o do Postgres**, por `foldPathsTx`, senão `İ.md` e
 * `I.md` caem na mesma chave do índice e a statement inteira morre com 21000 —
 * e fatiar o lote por linha e por byte, com os mesmos tetos.
 */
async function upsertQuarantineFilesTx(
  tx: Tx,
  uuid: string,
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
      INSERT INTO quarantine_files ${QUARANTINE_FILE_COLUMNS}
      VALUES ${sql.join(rows, sql`, `)}
      ${QUARANTINE_FILE_UPSERT}
    `);
    rows = [];
    bytes = 0;
  };

  for (const { path, buffer } of unique.values()) {
    const file = fileColumns(path, buffer, 'quarantine_files');
    rows.push(
      sql`(${uuid}, ${path}, ${file.text}, ${file.binary}, ${file.mimeType}, ${file.sizeBytes})`,
    );
    bytes += buffer.byteLength;
    if (rows.length >= FILE_BATCH_ROWS || bytes >= FILE_BATCH_BYTES) await flush();
  }
  await flush();
}

/** A árvore do envio, SKILL.md primeiro — a mesma ordem de `listFiles`. */
async function listQuarantineFilesFrom(
  executor: Pick<Tx, 'execute'>,
  uuid: string,
): Promise<SkillFileMeta[]> {
  const result = await executor.execute(sql`
    SELECT relative_path, mime_type, size_bytes, (text_content IS NOT NULL) AS is_text
    FROM quarantine_files WHERE quarantine_uuid = ${uuid}
    ORDER BY (lower(relative_path) = 'skill.md') DESC, relative_path ASC
  `);

  return (result.rows as Row[]).map((row) => ({
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    isText: Boolean(row.is_text),
  }));
}

/**
 * `readQuarantineFile` sobre a conexão de quem chama — o pool numa leitura
 * avulsa, a transação numa escrita. Quem grava lê o conteúdo anterior pela
 * própria transação, nunca por `db()`: pedir uma segunda conexão ao pool
 * segurando a primeira é o jeito de travar o processo quando a fila enche o
 * pool (ver `readFileFrom`).
 */
async function readQuarantineFileFrom(
  executor: Pick<Tx, 'execute'>,
  uuid: string,
  relativePath: string,
): Promise<FileContent | null> {
  const result = await executor.execute(sql`
    SELECT relative_path, mime_type, size_bytes, text_content, binary_content
    FROM quarantine_files
    WHERE quarantine_uuid = ${uuid} AND lower(relative_path) = lower(${relativePath})
    ORDER BY relative_path
    LIMIT 1
  `);

  const row = (result.rows as Row[])[0];
  if (!row) return null;
  return toFileContent(row);
}

async function readAllQuarantineFilesFrom(
  executor: Pick<Tx, 'execute'>,
  uuid: string,
): Promise<FileContent[]> {
  const result = await executor.execute(sql`
    SELECT relative_path, mime_type, size_bytes, text_content, binary_content
    FROM quarantine_files WHERE quarantine_uuid = ${uuid}
    ORDER BY (lower(relative_path) = 'skill.md') DESC, relative_path ASC
  `);
  return (result.rows as Row[]).map(toFileContent);
}

/** Uma linha de arquivo (de `files` ou de `quarantine_files`) com os bytes. */
function toFileContent(row: Row): FileContent {
  const isText = row.text_content !== null;
  return {
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    isText,
    buffer: isText ? Buffer.from(row.text_content, 'utf8') : Buffer.from(row.binary_content),
  };
}

// --------------------------------------------------------------- clonagem ---
//
// Copiar uma skill, um catálogo ou um MCP virtual (`docs/16-clonagem.md`). As
// três funções recebem o **uuid do original** (a convenção do módulo: leitura por slug, escrita por
// uuid), fazem tudo numa transação só e devolvem a ficha da **cópia** — o
// mesmo tipo que a criação devolve. Uuid torto ou inexistente é 404.
//
// O que vale para as três:
//
//   * **a cópia nasce fechada**: `is_public` (skill e catálogo) e `is_open`
//     (vMCP) são `false` mesmo quando o original é público ou aberto. Publicar
//     é um ato à parte, com trilha; um clone que herdasse a publicação
//     escancararia num clique um objeto que ninguém revisou. `is_active` é
//     copiado como está — a cópia de uma skill desligada nasce desligada;
//   * **o dono é quem clonou** (`input.ownerUserUuid`), nulo quando o ator não
//     tem conta (token global, bootstrap): a cópia nasce órfã, como tudo o que
//     eles criam. Na skill, `created_by_user_uuid` recebe o mesmo valor;
//     catálogo e vMCP não têm essa coluna;
//   * **o slug tem dois caminhos** (`cloneSlugTx`). Sem `input.slug`, a base é
//     o slug do **original** — não o nome — e o desempate é automático (`-2`,
//     `-3`…): por esse caminho clonar nunca responde 409. Com `input.slug`, ele
//     passa pela validação do tipo e, se já existir, é 409, como em
//     `resolveSlug` e `createCatalog`: foi um endereço pedido, e escolher outro
//     em silêncio devolveria um objeto em lugar que o chamador não pediu;
//   * **uma linha só na trilha**, no objeto novo, com `target_label` =
//     `<slug de origem> -> <slug da cópia>` — a gramática de
//     `quarantine.promote`. Sem a `create` do objeto junto: a mesma operação
//     apareceria duas vezes, e quem filtra criações contaria o dobro;
//   * **contador, sessão, acesso e histórico não são copiados.** A cópia nasce
//     zerada: os números são do original, não da forma dele.
//
// O que **não** é copiado, por tipo, está na documentação de cada função.

export type CloneInput = {
  /** Nome da cópia. Ausente ou vazio: o mesmo nome do original. */
  name?: string;
  /** Slug pedido. Ausente: desempate automático a partir do slug do ORIGINAL. */
  slug?: string;
  /** Dono da cópia. Nulo: órfã (token global, bootstrap). */
  ownerUserUuid?: string | null;
};

/**
 * Clona uma skill. A cópia leva as propriedades (`name`, `description`,
 * `icon`, `is_active`), **todos os arquivos** — texto e binário — e as
 * **tags**; nasce privada (`is_public = false`) e **flutuante**.
 *
 * Não são copiados: os vínculos com vMCP (`virtual_mcp_skills`), a
 * participação em catálogos (`catalog_skills`), as concessões
 * (`skill_grants`), os contadores e o histórico. Onde a skill é exibida é
 * decisão de quem publica, e um clone que entrasse sozinho em todo servidor
 * onde o original está publicaria conteúdo novo sem que ninguém o pedisse
 * (`docs/09` §4.3: a publicação é um ato à parte). As concessões ficam de fora
 * pelo mesmo motivo: quem clonou é o dono da cópia, e é ele quem decide de
 * novo com quem compartilhar.
 *
 * A cópia nasce **pendente de RAG**, como toda skill nova: o trigger de
 * `skills` marca `rag_stale` no INSERT e o de `files` marca a cada arquivo de
 * texto. O `search_vector` é montado pelo mesmo caminho da criação.
 *
 * **As travas**, na ordem em que a transação as toma:
 *
 *   1. `lockSkillFilesTx` no **original**, como primeira statement — a mesma
 *      fila de `createFile`/`setFiles`/`deleteSkill`. É ela que dá uma foto
 *      estável dos arquivos a copiar (um `setFiles` concorrente espera o fim
 *      da cópia) e, por ser a primeira, não segura linha nenhuma enquanto
 *      espera: é o que a impede de fechar ciclo. A cópia **não** toma a fila
 *      da skill nova — o uuid dela ainda não existe e ninguém pode disputá-lo;
 *   2. `SELECT … FOR KEY SHARE` no original, nunca `FOR UPDATE`: em `skills` o
 *      `FOR UPDATE` entra em deadlock com o `UPDATE` do trigger
 *      `files_rag_stale_trg` e com o `FOR KEY SHARE` que todo INSERT em tabela
 *      filha pede pela FK (a lição de `createFile`). O que ele faz aqui é
 *      segurar um `deleteSkill` até o fim da cópia e ser o 404 de quem sumiu.
 */
export async function cloneSkill(
  uuid: string,
  input: CloneInput,
  source: AuditSource,
  actor: AuditActor,
): Promise<SkillDetail> {
  if (!isUuid(uuid)) throw notFound(`Skill não encontrada: ${uuid}`);
  const requested = cloneSlugRequest(input, (slug) => {
    if (!isValidSlug(slug)) throw badRequest(`Slug inválido: "${slug}"`);
  });
  const name = optionalText(input.name, 'name')?.trim() || undefined;
  const owner = ownerOrNull(input.ownerUserUuid ?? null);

  let slug = '';

  // O slug é escolhido lendo os ocupados e gravado depois: duas clonagens (ou
  // uma clonagem e uma criação) simultâneas podem escolher o mesmo. Derivado,
  // a intenção é "qualquer slug livre" e vale repetir a transação inteira —
  // nada foi materializado fora do banco. Pedido, o conflito é a resposta.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db().transaction(async (tx) => {
        await lockSkillFilesTx(tx, uuid);

        const found = await tx.execute(
          sql`SELECT slug, name FROM skills WHERE uuid = ${uuid} FOR KEY SHARE`,
        );
        const original = (found.rows as Row[])[0];
        if (!original) throw notFound(`Skill não encontrada: ${uuid}`);
        const origem = original.slug as string;

        slug = await cloneSlugTx(tx, 'skills', origem, requested, 'uma skill');

        // `INSERT … SELECT` a partir da própria linha travada: `description` e
        // `icon` não precisam ir e voltar pelo processo, e o que não está na
        // lista nasce no DEFAULT — contadores em zero, `is_public` falso.
        const inserted = await tx.execute(sql`
          INSERT INTO skills
            (slug, name, description, icon, is_active, is_public,
             created_by_user_uuid, owner_user_uuid)
          SELECT ${slug}, ${name ?? (original.name as string)}, description, icon, is_active, false,
                 ${owner}::uuid, ${owner}::uuid
            FROM skills WHERE uuid = ${uuid}
          RETURNING uuid
        `);
        const novo = (inserted.rows as Row[])[0].uuid as string;

        // Os bytes ficam dentro do banco: uma statement copia texto e binário
        // de todos os arquivos, e um pacote de 200 imagens não passa pela
        // memória do Node (a lição de `upsertFilesTx`). Sem `ON CONFLICT`: a
        // skill acabou de nascer, ninguém mais tem o uuid dela e o original já
        // respeita `files_skill_path_lower_uniq`. O hash (`content_sha256`) é
        // recalculado pelo trigger do `020`, como em qualquer gravação.
        await tx.execute(sql`
          INSERT INTO files
            (skill_uuid, relative_path, text_content, binary_content, mime_type, size_bytes)
          SELECT ${novo}::uuid, relative_path, text_content, binary_content, mime_type, size_bytes
            FROM files WHERE skill_uuid = ${uuid}
           ORDER BY relative_path
        `);

        // `ORDER BY` pela mesma razão de `replaceTagsTx`: o INSERT trava as
        // linhas de `tags` que a FK confere, e duas clonagens com as mesmas
        // tags em ordens diferentes travariam em cruz. Nenhuma tag é criada
        // aqui — o vínculo aponta para as que já existem.
        await tx.execute(sql`
          INSERT INTO skill_tags (skill_uuid, tag_id)
          SELECT ${novo}::uuid, tag_id FROM skill_tags WHERE skill_uuid = ${uuid}
           ORDER BY tag_id
        `);

        await auditTx(tx, {
          skillUuid: novo,
          skillSlug: slug,
          filePath: null,
          action: 'skill.clone',
          source,
          actor,
          previousContent: null,
          targetLabel: `${origem} -> ${slug}`,
        });
      });
      break;
    } catch (err) {
      if (ownerGone(err, SKILL_OWNER_FKS)) throw notFound(`Conta não encontrada: ${owner}`);
      if (!isUniqueViolation(err, 'skills_slug_key')) throw err;
      if (requested !== undefined || attempt >= SLUG_ATTEMPTS) {
        throw conflict(`Já existe uma skill com o slug "${slug}"`);
      }
    }
  }

  const detail = await getSkillDetail(slug, { visibility: 'all' });
  if (!detail) throw new Error('Skill clonada mas não encontrada');
  return detail;
}

/**
 * Clona um catálogo. A cópia leva as propriedades (`name`, `description`,
 * `is_active`) e os **membros** (`catalog_skills`), apontando para as **mesmas
 * skills** e preservando o `is_active` de cada participação — a desativação de
 * um membro é parte da forma do catálogo, não um acidente. Nasce privada
 * (`is_public = false`).
 *
 * Não são copiados: os vínculos com vMCP (`virtual_mcp_catalogs`), as
 * concessões (`catalog_grants`) e os contadores. Como na skill, publicar o
 * grupo num servidor é um ato à parte.
 *
 * **A trava** é a de `lockCatalogTx` (`FOR UPDATE`), a mesma de toda escrita
 * nos membros: ela é o 404 do original e faz a cópia enxergar um estado só —
 * um `setCatalogSkills` concorrente espera o fim da clonagem em vez de entrar
 * no meio dela. Ela não cruza com o `UPDATE` de contador de
 * `recordSkillAccess`: o registro de acesso é uma statement só, que não segura
 * nada de que esta transação precise (o INSERT em `catalog_skills` pede
 * `FOR KEY SHARE` nas skills, que não conflita com o `FOR NO KEY UPDATE` do
 * contador).
 */
export async function cloneCatalog(
  uuid: string,
  input: CloneInput,
  source: AuditSource,
  actor: AuditActor,
): Promise<CatalogDetail> {
  if (!isUuid(uuid)) throw notFound(`Catálogo não encontrado: ${uuid}`);
  const requested = cloneSlugRequest(input, assertCatalogSlug);
  const name = optionalText(input.name, 'name')?.trim() || undefined;
  const owner = ownerOrNull(input.ownerUserUuid ?? null);

  let slug = '';

  for (let attempt = 1; ; attempt += 1) {
    try {
      const novo = await db().transaction(async (tx) => {
        // A trava de `lockCatalogTx`, com as duas colunas que a cópia precisa
        // ler — o slug para o rótulo da trilha e o nome para o padrão.
        const found = await tx.execute(
          sql`SELECT slug, name FROM catalogs WHERE uuid = ${uuid} FOR UPDATE`,
        );
        const original = (found.rows as Row[])[0];
        if (!original) throw notFound(`Catálogo não encontrado: ${uuid}`);
        const origem = original.slug as string;

        slug = await cloneSlugTx(tx, 'catalogs', origem, requested, 'um catálogo');

        const inserted = await tx.execute(sql`
          INSERT INTO catalogs (slug, name, description, is_active, is_public, owner_user_uuid)
          SELECT ${slug}, ${name ?? (original.name as string)}, description, is_active, false,
                 ${owner}::uuid
            FROM catalogs WHERE uuid = ${uuid}
          RETURNING uuid
        `);
        const criado = (inserted.rows as Row[])[0].uuid as string;

        // `is_active` da participação vem junto; `created_at` é o de agora — a
        // participação é nova, o que se preserva é o estado dela. `ORDER BY`
        // pelo mesmo motivo das tags: a FK trava as linhas de `skills` que ela
        // confere, e duas clonagens em ordens diferentes travariam em cruz.
        await tx.execute(sql`
          INSERT INTO catalog_skills (catalog_uuid, skill_uuid, is_active)
          SELECT ${criado}::uuid, skill_uuid, is_active
            FROM catalog_skills WHERE catalog_uuid = ${uuid}
           ORDER BY skill_uuid
        `);

        await auditTx(tx, catalogAudit('catalog.clone', `${origem} -> ${slug}`, source, actor));
        return criado;
      });
      return catalogAfterWrite(novo, 'clonado');
    } catch (err) {
      if (ownerGone(err, CATALOG_OWNER_FKS)) throw notFound(`Conta não encontrada: ${owner}`);
      if (!isUniqueViolation(err, 'catalogs_slug_key')) throw err;
      if (requested !== undefined || attempt >= SLUG_ATTEMPTS) {
        throw conflict(`Já existe um catálogo com o slug "${slug}"`);
      }
    }
  }
}

/**
 * Clona um MCP virtual. A cópia leva as propriedades (`name`, `description`,
 * `is_active`), o `layout` do canvas, os vínculos com **skills** e com
 * **catálogos** — as três portas (`as_skill`/`as_prompt`/`as_resource`) e o par
 * `pos_x`/`pos_y` de cada um — e as **concessões** (`virtual_mcp_grants`).
 * Nasce fechada (`is_open = false`).
 *
 * O que não vai junto:
 *
 *   * **as chaves `psv_`**, e não por escolha: o segredo não é guardado (só o
 *     prefixo e o hash) e `prefix` é UNIQUE, então não há o que copiar — uma
 *     chave "clonada" não abriria a porta de ninguém. O servidor novo começa
 *     sem credencial; emitir é `mcp.key.create`, com trilha;
 *   * **os contadores do vínculo** (`view_count`/`download_count` de
 *     `virtual_mcp_skills`), que nascem em zero: eles contam leituras daquele
 *     servidor, e a cópia ainda não teve nenhuma;
 *   * **as sessões e os acessos**, que são história do original;
 *   * **o posto de vMCP padrão**: `settings.default_virtual_mcp` não é tocado.
 *     Quem responde em `/mcp` continua sendo quem respondia — trocar isso é
 *     `setDefaultVirtualMcp`, e um clone que se promovesse sozinho derrubaria
 *     o servidor público da instalação.
 *
 * Nas concessões copiadas, `granted_by_user_uuid` passa a ser **quem clonou**:
 * é ele quem concede no objeto novo. A linha da própria pessoa que clonou
 * **não** é copiada — ela é a dona da cópia, e conceder ao dono é recusado
 * como redundante (`docs/12` decisão 10 — é o que `setGrant` recusa).
 *
 * **As travas.** A ordem é a única que não gera ciclo no recorte de um vMCP
 * (`tasks/023`): travar o servidor com `FOR NO KEY UPDATE` — nunca
 * `FOR UPDATE`, que barra o `FOR KEY SHARE` que a FK de `skill_accesses` pede
 * e mata `recordSkillAccess` — e só então mexer nos vínculos. Aqui o original
 * é **só lido**: não há `UPDATE` no servidor para deixar por último, e as
 * linhas escritas pendem todas da cópia, cujo uuid ninguém mais conhece.
 */
export async function cloneVirtualMcp(
  uuid: string,
  input: CloneInput,
  source: AuditSource,
  actor: AuditActor,
): Promise<VirtualMcpDetail> {
  if (!isUuid(uuid)) throw notFound(`MCP virtual não encontrado: ${uuid}`);
  const requested = cloneSlugRequest(input, assertVirtualMcpSlug);
  const name = optionalText(input.name, 'name')?.trim() || undefined;
  const owner = ownerOrNull(input.ownerUserUuid ?? null);

  let slug = '';

  for (let attempt = 1; ; attempt += 1) {
    try {
      const novo = await db().transaction(async (tx) => {
        // A trava de `lockVirtualMcpTx`, com as duas colunas que a cópia lê.
        const found = await tx.execute(
          sql`SELECT slug, name FROM virtual_mcps WHERE uuid = ${uuid} FOR NO KEY UPDATE`,
        );
        const original = (found.rows as Row[])[0];
        if (!original) throw notFound(`MCP virtual não encontrado: ${uuid}`);
        const origem = original.slug as string;

        slug = await cloneSlugTx(tx, 'virtual_mcps', origem, requested, 'um MCP virtual');

        // O `layout` (JSONB) é copiado dentro do banco, sem passar pelo
        // processo: o que a leitura devolve é um recorte (só `server` e
        // `internet`), e serializá-lo de volta apagaria o que ela ignora.
        const inserted = await tx.execute(sql`
          INSERT INTO virtual_mcps (slug, name, description, is_active, is_open, owner_user_uuid, layout)
          SELECT ${slug}, ${name ?? (original.name as string)}, description, is_active, false,
                 ${owner}::uuid, layout
            FROM virtual_mcps WHERE uuid = ${uuid}
          RETURNING uuid
        `);
        const criado = (inserted.rows as Row[])[0].uuid as string;

        // Portas e posição de cada vínculo; os contadores ficam no DEFAULT (0).
        // `ORDER BY` como nas tags: a FK trava as linhas de `skills` e de
        // `catalogs` na ordem em que elas entram.
        await tx.execute(sql`
          INSERT INTO virtual_mcp_skills
            (virtual_mcp_uuid, skill_uuid, as_skill, as_prompt, as_resource, pos_x, pos_y)
          SELECT ${criado}::uuid, skill_uuid, as_skill, as_prompt, as_resource, pos_x, pos_y
            FROM virtual_mcp_skills WHERE virtual_mcp_uuid = ${uuid}
           ORDER BY skill_uuid
        `);
        await tx.execute(sql`
          INSERT INTO virtual_mcp_catalogs
            (virtual_mcp_uuid, catalog_uuid, as_skill, as_prompt, as_resource, pos_x, pos_y)
          SELECT ${criado}::uuid, catalog_uuid, as_skill, as_prompt, as_resource, pos_x, pos_y
            FROM virtual_mcp_catalogs WHERE virtual_mcp_uuid = ${uuid}
           ORDER BY catalog_uuid
        `);

        // `IS DISTINCT FROM`, e não `<>`: com dono nulo (a cópia órfã do token
        // global) o `<>` seria nulo para toda linha e nenhuma concessão seria
        // copiada.
        await tx.execute(sql`
          INSERT INTO virtual_mcp_grants (virtual_mcp_uuid, user_uuid, level, granted_by_user_uuid)
          SELECT ${criado}::uuid, user_uuid, level, ${owner}::uuid
            FROM virtual_mcp_grants
           WHERE virtual_mcp_uuid = ${uuid}
             AND user_uuid IS DISTINCT FROM ${owner}::uuid
           ORDER BY user_uuid
        `);

        await auditTx(tx, virtualMcpAudit('mcp.clone', `${origem} -> ${slug}`, source, actor));
        return criado;
      });
      return virtualMcpAfterWrite(novo, 'clonado');
    } catch (err) {
      if (ownerGone(err, MCP_OWNER_FKS)) throw notFound(`Conta não encontrada: ${owner}`);
      if (!isUniqueViolation(err, 'virtual_mcps_slug_key')) throw err;
      if (requested !== undefined || attempt >= SLUG_ATTEMPTS) {
        throw conflict(`Já existe um MCP virtual com o slug "${slug}"`);
      }
    }
  }
}

/**
 * O slug pedido na clonagem, aparado e validado pela regra do tipo. Vazio é
 * "escolha para mim", como em `createVirtualMcp` e `createCatalog`.
 */
function cloneSlugRequest(input: CloneInput, assert: (slug: string) => void): string | undefined {
  const asked = optionalText(input.slug, 'slug')?.trim() || undefined;
  if (asked !== undefined) assert(asked);
  return asked;
}

/**
 * O slug de uma cópia, **dentro da transação** que a grava (nada de `db()`
 * aqui: a segunda conexão do pool pode não vir — ver `readFileFrom`).
 *
 * Sem slug pedido, a base é o slug do **original**, e não o nome: clonar
 * `deploy-docker` dá `deploy-docker-2`, mesmo que o nome tenha virado outro.
 * É o caminho derivado de `freeSkillSlugTx`, que nunca devolve 409. Com slug
 * pedido, o desempate é justamente o que não se quer: se `uniqueSlug` precisou
 * mudar o que veio, o endereço está ocupado e a resposta é 409, como em
 * `resolveSlug`.
 */
async function cloneSlugTx(
  tx: Tx,
  table: 'skills' | 'catalogs' | 'virtual_mcps',
  sourceSlug: string,
  requested: string | undefined,
  subject: string,
): Promise<string> {
  const desired = requested ?? sourceSlug;
  const slug = uniqueSlug(desired, await takenSlugs(table, desired, tx));
  if (requested !== undefined && slug !== desired) {
    throw conflict(`Já existe ${subject} com o slug "${desired}"`);
  }
  return slug;
}

/**
 * As chaves estrangeiras que apontam para a conta **dona** da cópia, por tipo:
 * violá-las é "o dono sumiu entre a sessão e a clonagem", o 404 de
 * `createCatalog`/`createVirtualMcp`. Qualquer outra FK (uma skill, um
 * catálogo ou um concedido removido no meio da cópia) sobe como está — são
 * corridas de outra natureza, e traduzi-las em "conta não encontrada" mentiria.
 */
const SKILL_OWNER_FKS = ['skills_owner_user_uuid_fkey', 'skills_created_by_user_uuid_fkey'] as const;
const CATALOG_OWNER_FKS = ['catalogs_owner_user_uuid_fkey'] as const;
const MCP_OWNER_FKS = ['virtual_mcps_owner_user_uuid_fkey'] as const;

function ownerGone(err: unknown, fks: readonly string[]): boolean {
  return fks.some((constraint) => isForeignKeyViolation(err, constraint));
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
 *
 * `executor` é o pool na criação comum e a **transação** em `freeSkillSlugTx`
 * (a promoção de um envio escolhe o slug com a linha do envio já travada):
 * dentro de uma transação, pedir uma segunda conexão ao pool é o jeito de
 * travar o processo quando a fila o enche — ver `readFileFrom`.
 */
async function takenSlugs(
  table: 'skills' | 'virtual_mcps' | 'catalogs',
  desired: string,
  executor: Pick<Tx, 'execute'> = db(),
): Promise<string[]> {
  const where =
    desired.length > SLUG_SCAN_PREFIX
      ? sql`slug LIKE ${desired.slice(0, SLUG_SCAN_PREFIX) + '%'}`
      : sql`slug = ${desired} OR slug LIKE ${desired + '-%'}`;
  const result = await executor.execute(sql`SELECT slug FROM ${sql.raw(table)} WHERE ${where}`);
  return (result.rows as Row[]).map((row) => row.slug as string);
}

/**
 * Slug de skill livre a partir de um nome, **na transação de quem chama** — é
 * o que `promoteQuarantine` usa. Mesma escolha de `freeCatalogSlug` e
 * `freeVirtualMcpSlug`: o caminho **derivado**, com sufixo automático (`-2`,
 * `-3`…), que nunca devolve 409. Dentro da transação nada de `db()`: a segunda
 * conexão do pool pode não vir (ver `readFileFrom`).
 */
async function freeSkillSlugTx(tx: Tx, name: string): Promise<string> {
  const desired = slugify(name) || 'skill';
  return uniqueSlug(desired, await takenSlugs('skills', desired, tx));
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
 * Para qual das duas tabelas o arquivo vai. A régua de texto × binário é a
 * mesma nas duas; o que muda é só a exigência sobre o `SKILL.md` — ver
 * `fileColumns`.
 */
type FileDestination = 'files' | 'quarantine_files';

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
 * Em `files`, o `SKILL.md` é o único caminho que **tem** de ser texto: é ele que
 * `readTextFile`, o `search_vector` e o RAG leem. Gravado como binário, a skill
 * ficaria com o corpo vazio para todo leitor, sem erro — por isso é 400 aqui, em
 * vez de trocar uma corrupção silenciosa por um sumiço silencioso.
 *
 * Em `quarantine_files` a mesma exigência seria um defeito: ninguém decodifica
 * o arquivo de um envio (ele é bytes crus, do upload ao download), e o pacote
 * cujo `SKILL.md` veio em Windows-1252 ou UTF-16 é exatamente o que a
 * quarentena existe para receber e consertar. Recusá-lo na porta trancava o
 * envio fora dos **dois** destinos. Lá ele entra como qualquer anexo binário, e
 * quem cobra o texto é `promoteQuarantine`, na hora de virar skill.
 */
function fileColumns(
  path: string,
  buffer: Buffer,
  destination: FileDestination = 'files',
): FileColumns {
  const mimeType = mimeTypeFor(path);
  const isText = isTextualContent(mimeType, buffer);
  if (!isText && isSkillMd(path) && destination === 'files') {
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
