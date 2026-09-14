import type { AccessLevel, EffectiveAccess, Role } from './roles.js';

/**
 * Um vMCP em que a skill está, visto da skill: o servidor e as três portas
 * do vínculo (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4). É a única
 * forma de uma skill ser exibida — no MCP e no site.
 */
export type SkillMcpRef = {
  uuid: string;
  slug: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
  /** Responde também em `/mcp`. */
  isDefault: boolean;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
  /**
   * Vínculo direto (`virtual_mcp_skills`). Falso: a skill chega a este vMCP
   * só por catálogo (`docs/11-catalogos.md` §3) e as portas acima são a união
   * dos catálogos em `catalogs`. O vínculo direto, quando existe, sobrescreve
   * qualquer catálogo — por isso os dois nunca aparecem juntos.
   */
  direct: boolean;
  /** Os catálogos por onde a skill chega a este vMCP; vazio num vínculo direto. */
  catalogs: CatalogRef[];
};

/** O mínimo para nomear um catálogo numa referência. */
export type CatalogRef = { uuid: string; slug: string; name: string };

/** Um catálogo de que a skill participa, visto da skill. */
export type SkillCatalogRef = CatalogRef & {
  /** O catálogo está ligado. */
  isActive: boolean;
  /** A participação **desta** skill neste catálogo está ativa. */
  memberActive: boolean;
};

export type SkillSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /**
   * Ícone da skill nos cards e nos nós do canvas do painel: um emoji ou a
   * URL (http/https) de uma imagem. Nulo cai no monograma pelas iniciais
   * (`isValidSkillIcon` de `icon.ts` é a regra).
   */
  icon: string | null;
  /**
   * Desligada (`docs/11-catalogos.md` §2): some de todo vMCP e do site, por
   * vínculo direto ou por catálogo, sem perder vínculo nenhum. Só o painel e
   * o mcp-admin (visibilidade `'all'`) continuam a enxergá-la.
   */
  isActive: boolean;
  /**
   * Quem pode ler sem concessão: qualquer conta logada e o site anônimo
   * (`docs/12-acesso-granular.md` decisão 4). Não decide exposição no MCP —
   * isso continua sendo vínculo.
   */
  isPublic: boolean;
  /** Nulo quando o dono foi removido ou quando quem criou não era conta (bootstrap, token global). */
  ownerUserUuid: string | null;
  ownerEmail: string | null;
  /**
   * O que a conta que leu pode nesta skill (`accessLevel` de `roles.ts`,
   * mais `'view'` quando ela chega por um contêiner que a conta vê). Numa
   * leitura sem conta (site, `visibility: 'all'` sem `viewer`) é `'owner'`
   * para o painel/mcp-admin do admin e `null` para o site.
   */
  access: EffectiveAccess;
  /**
   * Em quais vMCPs a skill está — por vínculo direto **ou** por catálogo.
   * Numa leitura de visibilidade `'all'` (painel, mcp-admin) vêm todos; nas
   * demais, só os abertos e ligados — que é o que o site pode mostrar. Vazio
   * = skill flutuante, exibida em lugar nenhum.
   */
  mcps: SkillMcpRef[];
  /** Os catálogos de que participa. Só na visibilidade `'all'`; vazio nas demais. */
  catalogs: SkillCatalogRef[];
  viewCount: number;
  downloadCount: number;
  score: number;
  tags: string[];
  fileCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SkillFileMeta = {
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  isText: boolean;
};

export type SkillDetail = SkillSummary & {
  skillMd: string;
  files: SkillFileMeta[];
  /**
   * As concessões da skill (`skill_grants`). O banco sempre as devolve; o
   * app só as repassa a quem tem `manage` (`docs/12` decisão 11).
   */
  grants: Grant[];
};

// ------------------------------------------------------------- acesso ------

/** Uma concessão por objeto: a conta, o nível e quem concedeu. */
export type Grant = {
  userUuid: string;
  email: string;
  name: string;
  role: Role;
  level: AccessLevel;
  grantedByUserUuid: string | null;
  grantedByEmail: string | null;
  createdAt: string;
};

/** Resultado da busca de contas para compartilhar (`GET /api/users/lookup`). */
export type UserLookup = { uuid: string; email: string; name: string; role: Role };

/** O filtro das listas do painel: meus, compartilhados comigo, públicos. */
export type AccessScope = 'mine' | 'shared' | 'public';

export const ACCESS_SCOPES: readonly AccessScope[] = ['mine', 'shared', 'public'];

export function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === 'string' && (ACCESS_SCOPES as readonly string[]).includes(value);
}

export type SearchResult = {
  items: SkillSummary[];
  total: number;
  limit: number;
  offset: number;
};

/** Tipos compartilhados entre a API REST, o frontend e os servidores MCP. */

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  // Eventos de conta (`docs/05-accounts-and-roles.md` §2.8). Login e falha de
  // login ficam de fora: quem os trata é o rate limiting, e auditá-los mudaria
  // a ordem de grandeza do log.
  | 'user.create'
  | 'user.role'
  | 'user.deactivate'
  | 'key.create'
  | 'key.revoke'
  // Eventos de MCP virtual (`docs/08-mcp-virtual.md` §6). `target_label` é o
  // slug do servidor; nas chaves, o nome da chave.
  | 'mcp.create'
  | 'mcp.update'
  | 'mcp.delete'
  // A troca do vMCP padrão (`docs/09-mcp-padrao-e-skills-flutuantes.md`);
  // `target_label` é o slug novo, ou "nenhum".
  | 'mcp.default'
  | 'mcp.key.create'
  | 'mcp.key.revoke'
  // Eventos de catálogo (`docs/11-catalogos.md` §7). `target_label` é o slug
  // do catálogo; mudar a lista de skills dele é `catalog.update`, e vincular
  // um catálogo a um vMCP é `mcp.update` no servidor, como com skill.
  | 'catalog.create'
  | 'catalog.update'
  | 'catalog.delete'
  // Concessões (`docs/12-acesso-granular.md` §8). `target_label` é
  // `email:nível` ao conceder e o e-mail ao revogar; em catálogo e vMCP o
  // slug vem antes, separado por espaço. Transferir o dono é `update`.
  | 'skill.share'
  | 'skill.unshare'
  | 'catalog.share'
  | 'catalog.unshare'
  | 'mcp.share'
  | 'mcp.unshare'
  // Chaves `psp_` do antigo MCP principal. Nada mais as produz desde o `011`;
  // ficam no tipo porque a trilha ainda carrega linhas com elas.
  | 'public.key.create'
  | 'public.key.revoke';

export type AuditSource = 'web-admin' | 'mcp-admin';

/**
 * Quem executou a ação.
 *
 * `userUuid` é nulo quando o ator não é uma conta: o `MCP_ADMIN_TOKEN`
 * (`token-global`) e o bootstrap do primeiro admin. `label` é sempre
 * preenchido e é o que o painel mostra.
 */
export type AuditActor = {
  userUuid: string | null;
  label: string;
};

export const TOKEN_ACTOR: AuditActor = { userUuid: null, label: 'token-global' };
export const BOOTSTRAP_ACTOR: AuditActor = { userUuid: null, label: 'bootstrap' };

export type AuditEntry = {
  id: string;
  skillUuid: string | null;
  skillSlug: string | null;
  filePath: string | null;
  action: AuditAction;
  source: AuditSource;
  actorUserUuid: string | null;
  actorLabel: string | null;
  /** Alvo de um evento de conta (e-mail do usuário, nome da chave). */
  targetLabel: string | null;
  createdAt: string;
};

// ------------------------------------------------------------- contas ------

export type UserSummary = {
  uuid: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  /** `false` numa conta que só entra por OIDC. */
  hasPassword: boolean;
  mustChangePassword: boolean;
  oidcIssuer: string | null;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiKeySummary = {
  id: string;
  userUuid: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

// ------------------------------------------------------- MCP virtual ------

/**
 * As três superfícies de um MCP virtual, decididas **por vínculo** — e não
 * pelas flags da skill, que valem só para o MCP principal
 * (`docs/08-mcp-virtual.md` §3.2).
 */
export type VirtualSurface = 'skill' | 'prompt' | 'resource';

export type VirtualMcpSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Desligado: tudo sob `/virtual/<slug>` responde 404, as chaves ficam. */
  isActive: boolean;
  /** Aberto: sem chave. Com skill privada dentro, é publicação de fato. */
  isOpen: boolean;
  /** Nulo quando o dono foi removido ou quando quem criou foi a sessão de bootstrap. */
  ownerUserUuid: string | null;
  ownerEmail: string | null;
  /** O que a conta que leu pode neste vMCP; `'view'` inclui ler as skills dentro. */
  access: EffectiveAccess;
  skillCount: number;
  /** Quantas skills saem por cada porta — os contadores do card no painel. */
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  activeKeyCount: number;
  /** É o vMCP que responde em `/mcp` (`settings.default_virtual_mcp`). */
  isDefault: boolean;
  /**
   * Clientes online agora: sessões sem fim e com atividade dentro da janela
   * (`MCP_SESSION_ONLINE_WINDOW_MS`) que o chamador informou. Zero quando a
   * listagem foi feita sem janela.
   */
  onlineSessions: number;
  /** Até 8 skills vinculadas, para a miniatura do card: slug, nome e ícone. */
  preview: VirtualMcpPreviewSkill[];
  /** Catálogos vinculados (`virtual_mcp_catalogs`), ligados ou não. */
  catalogCount: number;
  createdAt: string;
  updatedAt: string;
};

export type VirtualMcpPreviewSkill = { slug: string; name: string; icon: string | null };

/** Um ponto do canvas do painel, em pixels do React Flow. */
export type CanvasPoint = { x: number; y: number };

/**
 * Posições dos nós fixos do canvas de um vMCP: o próprio servidor e o globo da
 * Internet. As posições das skills vivem no vínculo (`VirtualMcpSkill.position`).
 * Ausente = auto-layout.
 */
export type VirtualMcpLayout = { server?: CanvasPoint; internet?: CanvasPoint };

/** Uma skill vista de dentro do MCP virtual: as flags e os contadores são do vínculo. */
export type VirtualMcpSkill = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
  viewCount: number;
  downloadCount: number;
  /** Posição do nó no canvas do painel; nula até alguém arrastar. */
  position: CanvasPoint | null;
};

export type VirtualMcpDetail = VirtualMcpSummary & {
  skills: VirtualMcpSkill[];
  catalogs: VirtualMcpCatalog[];
  layout: VirtualMcpLayout;
  /** As concessões (`virtual_mcp_grants`); o app só as repassa a quem tem `manage`. */
  grants: Grant[];
};

/**
 * Um catálogo visto de dentro do MCP virtual — o nó do canvas
 * (`docs/11-catalogos.md` §5). As portas são do vínculo
 * (`virtual_mcp_catalogs`) e valem para todo membro do catálogo.
 */
export type VirtualMcpCatalog = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** O catálogo em si está ligado; desligado, não contribui nada. */
  isActive: boolean;
  ownerUserUuid: string | null;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
  /** Membros, contando inativos. */
  skillCount: number;
  /**
   * O número do nó: membros com participação ativa e skill ativa que **não**
   * têm vínculo direto com este vMCP — os que já são nó próprio no canvas
   * não contam duas vezes.
   */
  activeSkillCount: number;
  /** Posição do nó no canvas do painel; nula até alguém arrastar. */
  position: CanvasPoint | null;
};

/** Entrada de `setVirtualMcpCatalogs`: as três portas, obrigatórias como nas skills. */
export type VirtualMcpCatalogInput = {
  slug: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

/** Entrada de `setVirtualMcpSkills`: a escolha das três superfícies é obrigatória. */
export type VirtualMcpSkillInput = {
  slug: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

/**
 * Vínculo visto do lado da skill (`createSkill({ mcps })`, `link_skill`):
 * o vMCP alvo e as três portas, obrigatórias como em `VirtualMcpSkillInput`.
 */
export type SkillLinkInput = {
  virtualMcpUuid: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

/** Um vMCP aberto e ligado, como o site o lista: sem dono, sem chaves. */
export type PublicVirtualMcp = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  skillCount: number;
  /** Responde também em `/mcp`. */
  isDefault: boolean;
};

/**
 * A configuração da instalação, como o painel a vê
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`). Por ora, só o vMCP padrão:
 * qual responde em `/mcp`, ou por que nenhum responde.
 */
export type InstallationSettings = {
  defaultMcp:
    | { status: 'ok'; uuid: string; slug: string; name: string; isOpen: boolean }
    | { status: 'inactive'; uuid: string; slug: string; name: null; isOpen: null }
    | { status: 'none' | 'deleted'; uuid: null; slug: null; name: null; isOpen: null };
};

export type VirtualMcpKeySummary = {
  id: string;
  virtualMcpUuid: string;
  name: string;
  prefix: string;
  createdByUserUuid: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

/** Uma página da trilha de auditoria, como o painel a lista. */
export type AuditPage = { items: AuditEntry[]; total: number; limit: number; offset: number };

// ---------------------------------------------------------- catálogos ------

/**
 * Um catálogo: um grupo de skills com dono (`docs/11-catalogos.md`). Vinculado
 * a um vMCP, entrega todos os membros ativos de uma vez, pelas portas do
 * vínculo; uma skill pode estar em vários catálogos.
 */
export type CatalogSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Desligado: deixa de contribuir para todo vMCP vinculado; membros e vínculos ficam. */
  isActive: boolean;
  /** Nulo quando o dono foi removido ou quando quem criou foi a sessão de bootstrap. */
  ownerUserUuid: string | null;
  ownerEmail: string | null;
  /** Legível por qualquer conta e pelo site; expõe os membros (`docs/12` decisões 4 e 5). */
  isPublic: boolean;
  /** O que a conta que leu pode neste catálogo; `'view'` inclui ler os membros. */
  access: EffectiveAccess;
  /** Membros, contando participações desativadas e skills desligadas. */
  skillCount: number;
  /** Membros com participação ativa **e** skill ativa — o que um vMCP vinculado recebe. */
  activeSkillCount: number;
  /** vMCPs em que o catálogo está vinculado. */
  mcpCount: number;
  /** Contadores do catálogo: acessos a skills que chegaram ao vMCP por ele. */
  viewCount: number;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
};

/** Uma skill vista de dentro do catálogo. */
export type CatalogSkill = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  /** A participação neste catálogo: desativada, a skill fica e não é entregue. */
  isActive: boolean;
  /** A skill em si (`skills.is_active`) — falso é o alerta na lista. */
  skillIsActive: boolean;
  addedAt: string;
};

/** Um vMCP em que o catálogo está, visto do catálogo: as portas são do vínculo. */
export type CatalogMcpRef = {
  uuid: string;
  slug: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
  isDefault: boolean;
  ownerUserUuid: string | null;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

export type CatalogDetail = CatalogSummary & {
  skills: CatalogSkill[];
  mcps: CatalogMcpRef[];
  /** As concessões (`catalog_grants`); o app só as repassa a quem tem `manage`. */
  grants: Grant[];
};

/** Um catálogo público e ligado, como o site o lista: sem dono, sem concessões. */
export type PublicCatalog = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Membros com participação ativa e skill ativa. */
  skillCount: number;
};

/** A página do catálogo no site: os membros ativos, todos (`docs/12` decisão 5). */
export type PublicCatalogDetail = PublicCatalog & {
  skills: SkillSummary[];
};

/** Entrada de `setCatalogSkills`: `isActive` omitido é "ativa" para quem entra e "não mexe" para quem fica. */
export type CatalogSkillInput = {
  slug: string;
  isActive?: boolean;
};

// ------------------------------------------------------- sessões MCP ------

/**
 * Contabilidade de sessões do MCP público (`docs/10-admin-canvas-e-sessoes.md`).
 *
 * Uma linha por cliente conectado a um vMCP. Nos transportes com sessão
 * (Streamable HTTP e SSE) a linha nasce no `initialize` e termina quando o
 * cliente fecha, o TTL vence ou o servidor para. No stateless não há sessão:
 * a linha agrupa as requisições de um mesmo cliente (IP, agente e credencial)
 * enquanto elas chegam dentro da janela de "online".
 */
export type McpSessionTransport = 'streamable' | 'sse' | 'stateless';
/** Por onde o cliente chegou: a raiz (`/mcp`) ou `/virtual/<slug>`. */
export type McpSessionMount = 'root' | 'virtual';
export type McpSessionAuth = 'open' | 'key';
export type McpSessionEndReason = 'closed' | 'timeout' | 'shutdown';

export type McpSessionSummary = {
  id: string;
  /** `mcp-session-id`, o `sessionId` do SSE ou a chave sintética do stateless. */
  sessionId: string;
  transport: McpSessionTransport;
  mount: McpSessionMount;
  /** Nulo quando o vMCP foi apagado depois; o slug fica como histórico. */
  virtualMcpUuid: string | null;
  virtualMcpSlug: string;
  auth: McpSessionAuth;
  keyId: string | null;
  keyName: string | null;
  /** IP de origem já resolvido pelo `trust proxy` (X-Forwarded-For quando confiável). */
  ip: string;
  userAgent: string | null;
  /** `clientInfo` do `initialize`, quando o cliente o enviou. */
  clientName: string | null;
  clientVersion: string | null;
  startedAt: string;
  lastSeenAt: string;
  /** Fim real (fechou) ou presumido pelo timeout. */
  endedAt: string | null;
  endReason: McpSessionEndReason | null;
  requestCount: number;
  /** Sem fim e com atividade dentro da janela informada na consulta. */
  isOnline: boolean;
};

export type McpSessionPage = {
  items: McpSessionSummary[];
  total: number;
  limit: number;
  offset: number;
};

/** Links externos da sidebar do painel; nulos somem da tela. */
export type AdminLinks = { docs: string | null; support: string | null; chat: string | null };

/** A marca do painel: o nome e o ícone da sidebar, do login e da aba do navegador. */
export type AdminBrand = { name: string; iconUrl: string };
