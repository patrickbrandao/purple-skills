/**
 * Cliente da API do painel e os tipos que ela devolve.
 *
 * Os tipos são cópias manuais dos de `@purple-skills/shared`: este bundle é de
 * navegador e não importa o pacote. Ao mudar um lá, mude aqui. A exceção é o
 * `import type` abaixo: tipo puro, apagado na compilação — nada do pacote entra
 * no bundle do navegador —, e ele é o corpo que a tela **discrimina em tempo de
 * execução** (`'bundle' in resposta`), onde uma cópia envelhecida não daria erro
 * de compilação, daria tela errada.
 */
import type {
  BundleImported,
  BundleSkipped,
  QuarantineBundleResult,
  QuarantineImportResult,
} from '@purple-skills/shared';

/** O mínimo para nomear um catálogo numa referência. */
export type CatalogRef = { uuid: string; slug: string; name: string };

/** Um catálogo de que a skill participa, visto da skill. */
export type SkillCatalogRef = CatalogRef & {
  /** O catálogo está ligado. */
  isActive: boolean;
  /** A participação desta skill neste catálogo está ativa. */
  memberActive: boolean;
};

/** Um vMCP em que a skill está, com as três portas do vínculo. */
export type SkillMcpRef = {
  uuid: string;
  slug: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
  isDefault: boolean;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
  /** Vínculo direto. Falso: a skill chega só por catálogo, e as portas são a união deles. */
  direct: boolean;
  /** Os catálogos por onde a skill chega a este vMCP; vazio num vínculo direto. */
  catalogs: CatalogRef[];
};

// ----------------------------------------------------------------- acesso ---

/** Nível de uma concessão (`docs/12-acesso-granular.md` §3.2), cumulativo. */
export type AccessLevel = 'view' | 'edit' | 'manage';
/** O que a sessão pode num objeto: um nível, dono (ou admin) ou nada. */
export type EffectiveAccess = AccessLevel | 'owner' | null;

export const ACCESS_LEVELS: AccessLevel[] = ['view', 'edit', 'manage'];

export const ACCESS_LABEL: Record<Exclude<EffectiveAccess, null>, string> = {
  view: 'visualizar',
  edit: 'editar',
  manage: 'administrar',
  owner: 'dono',
};

export const ACCESS_HINT: Record<AccessLevel, string> = {
  view: 'Lê e usa nos próprios contêineres.',
  edit: 'Conteúdo, membros, vínculos e canvas.',
  manage: 'Propriedades, chaves e quem tem acesso.',
};

const ACCESS_RANK: Record<Exclude<EffectiveAccess, null>, number> = { view: 1, edit: 2, manage: 3, owner: 4 };

/** Espelha `packages/shared/src/roles.ts` — a decisão real é do servidor. */
export const accessAtLeast = (access: EffectiveAccess, minimum: AccessLevel | 'owner') =>
  access !== null && ACCESS_RANK[access] >= ACCESS_RANK[minimum];
export const canView = (access: EffectiveAccess) => accessAtLeast(access, 'view');
export const canEdit = (access: EffectiveAccess) => accessAtLeast(access, 'edit');
export const canManage = (access: EffectiveAccess) => accessAtLeast(access, 'manage');
export const canOwn = (access: EffectiveAccess) => access === 'owner';

/**
 * Uma concessão: a conta, o nível e quem concedeu.
 *
 * A conta se identifica pelo **username**. `userUuid` e `grantedByUserUuid`
 * chegam do servidor como apelido do username — o uuid de uma conta não sai mais
 * do painel (`ownerByUsername`, em `admin/src/access.ts`) —, e nada aqui os lê.
 */
export type Grant = {
  userUuid: string;
  username: string;
  name: string;
  role: Role;
  /**
   * A conta está ativa? Desativada, a concessão fica na lista, inerte, e volta a
   * valer se a conta for reativada (`docs/12` §2) — por isso a guia Acesso a
   * marca, e revogá-la continua possível.
   */
  isActive: boolean;
  level: AccessLevel;
  grantedByUserUuid: string | null;
  grantedByUsername: string | null;
  createdAt: string;
};

export type UserLookup = { uuid: string; username: string; name: string; role: Role };

/** O filtro das listas: meus, compartilhados comigo, públicos. */
export type AccessScope = 'mine' | 'shared' | 'public';

/** Os campos de acesso que skill, catálogo e vMCP têm em comum. */
export type Accessible = {
  /**
   * Chega do servidor como **apelido de `ownerUsername`**: o uuid da conta dona
   * não sai mais do painel (`ownerByUsername`, em `admin/src/access.ts`). O dono
   * se compara pelo username — ver `ownedBy`, em `AccessPanel.tsx`.
   */
  ownerUserUuid: string | null;
  ownerUsername: string | null;
  access: EffectiveAccess;
};

export type SkillSummary = Accessible & {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Emoji ou URL de imagem; nulo cai no monograma. */
  icon: string | null;
  /** Desligada: some de todo vMCP e do site; só o painel a vê. */
  isActive: boolean;
  /** Legível por qualquer conta e pelo site, sem concessão. Não a publica em MCP nenhum. */
  isPublic: boolean;
  /**
   * Onde a skill está, direto ou por catálogo. Vazio = flutuante: nenhum MCP a
   * serve. No site ela ainda entra se `isPublic` ou se participa de catálogo
   * público (`docs/12-acesso-granular.md` §7) — ver `noSite` em `components/ui.tsx`.
   */
  mcps: SkillMcpRef[];
  /** Os catálogos de que participa. */
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

/** `grants` vem preenchido só para quem tem `manage`. */
export type SkillDetail = SkillSummary & { skillMd: string; files: SkillFileMeta[]; grants: Grant[] };

export type SearchResult = {
  items: SkillSummary[];
  total: number;
  limit: number;
  offset: number;
  /**
   * Como a busca foi resolvida (`docs/14-rag.md` §8.3).
   * `text` é a busca de sempre; `hybrid` soma a perna vetorial. Cair para
   * `text` não é erro — é o que acontece com a busca semântica desligada.
   */
  mode: 'text' | 'hybrid';
};

/**
 * Os números do painel. `/api/stats` recorta por viewer (`docs/12` §3.1): quem
 * não é admin recebe só os três primeiros, e os demais **faltam** na resposta.
 * Faltar não é zero — quem lê precisa tratar a ausência, não exibir "0".
 */
export type Stats = {
  totalSkills: number;
  openSkills: number;
  totalTags: number;
  // Só para admin: são números da instalação inteira, não do que a conta vê.
  unlinkedSkills?: number;
  totalFiles?: number;
  totalViews?: number;
  totalDownloads?: number;
  totalUsers?: number;
  activeUsers?: number;
};

/**
 * Espelho do `AuditAction` de `packages/shared/src/types.ts`, **na mesma
 * ordem**. `audit.test.ts` compara esta lista com a fonte de lá e falha quando
 * uma ação fica sem espelho, sem rótulo ou sem tom: ação nova entra aqui, em
 * `AUDIT_ACTIONS` e nos dois mapas de `audit.ts`.
 */
export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'user.create'
  | 'user.role'
  | 'user.deactivate'
  | 'user.activate'
  | 'user.password'
  | 'user.link'
  | 'user.username'
  | 'user.profile'
  | 'key.create'
  | 'key.revoke'
  | 'mcp.create'
  | 'mcp.update'
  | 'mcp.delete'
  | 'mcp.default'
  | 'mcp.key.create'
  | 'mcp.key.revoke'
  | 'catalog.create'
  | 'catalog.update'
  | 'catalog.delete'
  | 'skill.share'
  | 'skill.unshare'
  | 'catalog.share'
  | 'catalog.unshare'
  | 'mcp.share'
  | 'mcp.unshare'
  // Clonagem (`docs/16-clonagem.md`): a linha fica no objeto **novo** e o
  // alvo é `<slug de origem> -> <slug da cópia>`, a mesma gramática de
  // `quarantine.promote`. A cópia nasce fechada e o clone de vMCP não leva
  // chave, então nenhum evento de exposição ou de chave acompanha a linha.
  | 'skill.clone'
  | 'catalog.clone'
  | 'mcp.clone'
  // Busca semântica (`docs/14-rag.md` §9): o alvo é `chave=valor` em
  // `rag.settings` e a quantidade de skills marcadas em `rag.reindex`.
  | 'rag.settings'
  | 'rag.reindex'
  // Quarentena (`docs/15-quarentena.md`): o alvo é o nome do envio, e em
  // `quarantine.promote` é `<nome> -> <slug>` da skill criada.
  | 'quarantine.create'
  | 'quarantine.update'
  | 'quarantine.delete'
  | 'quarantine.promote'
  | 'quarantine.settings'
  | 'public.key.create'
  | 'public.key.revoke';

export const AUDIT_ACTIONS: AuditAction[] = [
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
  'rag.settings',
  'rag.reindex',
  'quarantine.create',
  'quarantine.update',
  'quarantine.delete',
  'quarantine.promote',
  'quarantine.settings',
  'public.key.create',
  'public.key.revoke',
];

export type AuditEntry = {
  id: string;
  skillUuid: string | null;
  skillSlug: string | null;
  filePath: string | null;
  action: AuditAction;
  source: 'web-admin' | 'mcp-admin';
  actorUserUuid: string | null;
  actorLabel: string | null;
  targetLabel: string | null;
  createdAt: string;
};

export type AuditPage = { items: AuditEntry[]; total: number; limit: number; offset: number };

export type Role = 'admin' | 'editor' | 'membro';

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'administrador',
  editor: 'editor',
  membro: 'membro',
};

/**
 * Espelha `packages/shared/src/roles.ts` — a decisão real é do servidor. O
 * papel decide só criar e gerenciar a instalação; o resto é o `access` de
 * cada objeto (`docs/12-acesso-granular.md`).
 */
export const ROLES: Role[] = ['admin', 'editor', 'membro'];

export const ROLE_HINT: Record<Role, string> = {
  admin: 'Vê e administra tudo, inclusive contas, auditoria e o MCP padrão.',
  editor: 'Cria skills, catálogos e servidores (e vira dono); administra o que é seu ou lhe foi concedido.',
  membro: 'Não cria nada; administra o que é seu ou lhe foi concedido e lê o que é público.',
};

export const canCreate = (role: Role) => role === 'admin' || role === 'editor';
export const canManageUsers = (role: Role) => role === 'admin';

export type SessionUser = {
  uuid: string | null;
  username: string;
  /** Carimbo da foto, para o avatar da sidebar; `null` cai no monograma. */
  avatarUpdatedAt: string | null;
  /**
   * O endereço da própria pessoa, e só dela (`docs/19-username.md` decisão 8):
   * a tela Conta e o menu do usuário o mostram. Nenhuma outra conta o vê.
   */
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  /** Sessão aberta com a ADMIN_PASSWORD, antes de existir qualquer conta. */
  legacy: boolean;
};

/** Links externos da sidebar; nulos somem da tela. */
export type AdminLinks = { docs: string | null; support: string | null; chat: string | null };

/** A marca do painel (ADMIN_BRAND_NAME / ADMIN_BRAND_ICON_URL). */
export type AdminBrand = { name: string; iconUrl: string };

/** O que `/api/session` entrega a qualquer visitante: o que a tela de login usa. */
export type SessionLogin = {
  authenticated: boolean;
  user: SessionUser | null;
  needsSetup: boolean;
  legacyLogin: boolean;
  oidc: { enabled: boolean; name?: string };
  passwordResetByEmail: boolean;
  siteName: string;
  brand: AdminBrand;
};

/**
 * O que a instalação conta de si mesma: endereços, janela de online, busca
 * semântica e versão. O servidor só manda isto **com sessão** — a rota responde
 * antes do `requireAuth`, porque o login depende dela, e sem o recorte a trava
 * de papel da tela "Ambiente" seria apenas visual.
 */
export type SessionOperation = {
  siteBaseUrl: string;
  /** Base pública do MCP público — vazia quando `MCP_PUBLIC_URL` não foi configurada. */
  mcpPublicUrl: string;
  links: AdminLinks;
  /** Janela em que um cliente conta como online (MCP_SESSION_ONLINE_WINDOW_MS). */
  onlineWindowMs: number;
  /**
   * O que o `.env` do painel define para a busca semântica — só leitura. Quem
   * decide é o valor gravado no banco (`docs/14-rag.md` §5).
   */
  rag?: { driver: string | null; model: string | null };
  version: string;
};

export type Session = SessionLogin & SessionOperation;

/**
 * O que vale antes de haver sessão — e quando `/api/session` não responde.
 * Completar a resposta anônima aqui mantém `Session` total: as telas de dentro,
 * que são as únicas a ler estes campos, continuam sem fallback.
 */
export const SESSION_OPERATION_DEFAULTS: SessionOperation = {
  siteBaseUrl: '/',
  mcpPublicUrl: '',
  links: { docs: null, support: null, chat: null },
  onlineWindowMs: 120_000,
  version: '',
};

export type UserSummary = {
  uuid: string;
  username: string;
  /** Carimbo da foto (`docs/20-perfil.md`); `null` é conta sem foto. */
  avatarUpdatedAt: string | null;
  /** Só admin lê esta lista, e é por isso que o e-mail continua nela (decisão 8). */
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
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

// ----------------------------------------------------------- MCP virtual ---

export type CanvasPoint = { x: number; y: number };
export type VirtualMcpLayout = { server?: CanvasPoint; internet?: CanvasPoint };
export type VirtualMcpPreviewSkill = { slug: string; name: string; icon: string | null };
export type VirtualMcpPreviewCatalog = { slug: string; name: string; isActive: boolean };

export type VirtualMcpSummary = Accessible & {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  isActive: boolean;
  isOpen: boolean;
  skillCount: number;
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  activeKeyCount: number;
  /** É o vMCP que responde em `/mcp`. */
  isDefault: boolean;
  onlineSessions: number;
  /** Até 19 skills com vínculo direto, por nome, para a colmeia do card. */
  preview: VirtualMcpPreviewSkill[];
  /** Catálogos vinculados, ligados ou não. */
  catalogCount: number;
  /** Até 19 catálogos vinculados, por nome, para a colmeia do card. */
  previewCatalogs: VirtualMcpPreviewCatalog[];
  createdAt: string;
  updatedAt: string;
};

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
  position: CanvasPoint | null;
};

/** Um catálogo visto de dentro do vMCP — o nó do canvas; as portas são do vínculo. */
export type VirtualMcpCatalog = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  isActive: boolean;
  ownerUserUuid: string | null;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
  /** Membros, contando inativos. */
  skillCount: number;
  /** O número do nó: membros ativos sem vínculo direto com este vMCP. */
  activeSkillCount: number;
  position: CanvasPoint | null;
};

export type VirtualMcpDetail = VirtualMcpSummary & {
  skills: VirtualMcpSkill[];
  catalogs: VirtualMcpCatalog[];
  layout: VirtualMcpLayout;
  /** Só para quem tem `manage`. */
  grants: Grant[];
};

export type VirtualMcpSkillInput = {
  slug: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

export type VirtualMcpCatalogInput = VirtualMcpSkillInput;

// -------------------------------------------------------------- catálogos ---

/** Um grupo de skills com dono, vinculado a vMCPs de uma vez (`docs/11-catalogos.md`). */
export type CatalogSummary = Accessible & {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Desligado: deixa de contribuir para todo vMCP vinculado; membros e vínculos ficam. */
  isActive: boolean;
  /** Legível por qualquer conta e pelo site, que lista os membros — inclusive skills privadas. */
  isPublic: boolean;
  /** Membros, contando participações desativadas e skills desligadas. */
  skillCount: number;
  /** Membros com participação ativa e skill ativa — o que um vMCP vinculado recebe. */
  activeSkillCount: number;
  mcpCount: number;
  viewCount: number;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CatalogSkill = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  /** A participação neste catálogo. */
  isActive: boolean;
  /** A skill em si — falso é o alerta na lista. */
  skillIsActive: boolean;
  addedAt: string;
};

/**
 * Um vMCP em que o catálogo está. A lista vem só com os que a conta vê; o que
 * sobra de `mcpCount` é o "e mais N" da ficha. O `ownerUserUuid` que o tipo
 * compartilhado declara **não chega**: o servidor o omite (uuid de conta não sai
 * do painel, e aqui não há e-mail ao lado para virar apelido).
 */
export type CatalogMcpRef = {
  uuid: string;
  slug: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
  isDefault: boolean;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

export type CatalogDetail = CatalogSummary & { skills: CatalogSkill[]; mcps: CatalogMcpRef[]; grants: Grant[] };

export type CatalogSkillInput = { slug: string; isActive?: boolean };

/** Vínculo pedido pelo lado da skill: o vMCP pelo slug e as três portas. */
export type SkillLinkInput = {
  slug: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

export type LinkFlags = { asSkill: boolean; asPrompt: boolean; asResource: boolean };

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

/** Uma chave `psv_` com o servidor a que pertence (Meu espaço → Chaves emitidas). */
export type IssuedMcpKey = VirtualMcpKeySummary & { virtualMcpSlug: string; virtualMcpName: string };

/** Cópia manual de `InstallationSettings` de `@purple-skills/shared`. */
export type InstallationSettings = {
  defaultMcp:
    | { status: 'ok'; uuid: string; slug: string; name: string; isOpen: boolean }
    | { status: 'inactive'; uuid: string; slug: string; name: null; isOpen: null }
    | { status: 'none' | 'deleted'; uuid: null; slug: null; name: null; isOpen: null };
};

// ------------------------------------------------------------ sessões MCP ---

export type McpSessionTransport = 'streamable' | 'sse' | 'stateless';
export type McpSessionMount = 'root' | 'virtual';
export type McpSessionAuth = 'open' | 'key';
export type McpSessionEndReason = 'closed' | 'timeout' | 'shutdown';

export type McpSessionSummary = {
  id: string;
  sessionId: string;
  transport: McpSessionTransport;
  mount: McpSessionMount;
  virtualMcpUuid: string | null;
  virtualMcpSlug: string;
  auth: McpSessionAuth;
  keyId: string | null;
  keyName: string | null;
  ip: string;
  userAgent: string | null;
  clientName: string | null;
  clientVersion: string | null;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  endReason: McpSessionEndReason | null;
  requestCount: number;
  isOnline: boolean;
};

export type McpSessionPage = {
  items: McpSessionSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type OnlineCount = { total: number; byTransport: Record<McpSessionTransport, number> };

// ------------------------------------------------------- acessos por skill ---

/**
 * Uma leitura de skill registrada pelo MCP público, pelo site ou pelo
 * mcp-admin (`docs/13-fichas-e-acessos.md`): a guia "Acessos" da skill e do
 * catálogo. Cópias de slug, nome, e-mail e chave sobrevivem à remoção do que
 * elas nomeiam.
 */
export type SkillAccessKind = 'view' | 'download';
export type SkillAccessSurface = 'tool' | 'resource' | 'prompt' | 'file' | 'download' | 'page' | 'admin-tool';
export type SkillAccessOrigin = 'mcp' | 'site' | 'mcp-admin';
export type SkillAccessAuth = 'open' | 'key' | 'user' | 'anonymous';

export type SkillAccessEntry = {
  id: string;
  skillUuid: string | null;
  skillSlug: string;
  skillName: string;
  kind: SkillAccessKind;
  surface: SkillAccessSurface;
  origin: SkillAccessOrigin;
  auth: SkillAccessAuth;
  virtualMcpUuid: string | null;
  virtualMcpSlug: string | null;
  virtualMcpName: string | null;
  /** Os catálogos por onde a skill chegou ao vMCP nesta leitura; vazio no vínculo direto, no site e no mcp-admin. */
  catalogs: { uuid: string | null; slug: string; name: string }[];
  keyId: string | null;
  keyName: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  userUuid: string | null;
  userUsername: string | null;
  sessionId: string | null;
  ip: string | null;
  userAgent: string | null;
  clientName: string | null;
  clientVersion: string | null;
  createdAt: string;
};

export type SkillAccessPage = {
  items: SkillAccessEntry[];
  total: number;
  limit: number;
  offset: number;
};

export type AccessLogQuery = {
  /** Texto livre: e-mail, nome de chave, IP, cliente ou id de sessão. */
  q?: string;
  origin?: SkillAccessOrigin | '';
  kind?: SkillAccessKind | '';
  limit?: number;
  offset?: number;
};

// ------------------------------------------------------------- atividade ---

/**
 * A tela de Atividade (`docs/18-atividade.md`): a grade de dias e o relatório
 * agregado de um deles. Cópia manual da seção "atividade" de
 * `@purple-skills/shared` — o cabeçalho deste arquivo diz por quê. O espelho de
 * `McpCallFamily`/`MCP_CALL_FAMILIES` é conferido por `activity.test.ts`, como
 * o de `AuditAction` é por `audit.test.ts`.
 *
 * Tudo aqui é soma. Nenhum corpo desta seção carrega IP, e-mail, `session_id`
 * nem identificador de operação: a menor unidade é "quantas vezes". Quem
 * precisa do evento a evento tem a trilha (`/api/audit`), as sessões
 * (`/api/sessions`) e a guia de acessos da skill.
 */

/**
 * A família de uma chamada, que é como o painel a agrupa — e como o canvas já
 * nomeia as portas de um vMCP (`--port-tools`, `--port-resources`,
 * `--port-prompts`). `skills` são os três métodos da extensão SEP-2640;
 * `session` é o que abre e mantém a conversa e não é consumo de conteúdo;
 * `other` recolhe o que um cliente mandar fora disso.
 */
export type McpCallFamily = 'tools' | 'resources' | 'prompts' | 'skills' | 'session' | 'other';

export const MCP_CALL_FAMILIES: readonly McpCallFamily[] = ['tools', 'resources', 'prompts', 'skills', 'session', 'other'];

/** Um dia da grade. Dia sem linha é dia sem atividade — aqui, ao contrário de `Stats`, faltar É zero. */
export type ActivityDay = {
  /** `AAAA-MM-DD` no fuso pedido na consulta. */
  day: string;
  /** Sessões abertas no dia (uma por cliente conectado a um vMCP). */
  sessions: number;
  /** Mensagens JSON-RPC recebidas pelo MCP público. */
  calls: number;
  /** Leituras de skill por qualquer superfície, inclusive o site e o mcp-admin. */
  reads: number;
  /** Eventos da trilha de auditoria (o que mudou no catálogo). */
  events: number;
  /** A soma das quatro — é ela que dá a cor da célula. */
  total: number;
};

/** A série que o heatmap desenha. */
export type ActivitySeries = {
  /** Só os dias com alguma atividade, em ordem crescente; o painel completa a grade com zeros. */
  days: ActivityDay[];
  /** A faixa efetivamente consultada, `AAAA-MM-DD` no fuso abaixo. */
  since: string;
  until: string;
  /** O fuso IANA em que os dias foram recortados — o do navegador, quando o painel o informa. */
  timezone: string;
};

/** Uma fatia nomeada de um total. `label` sai do banco quando o nome vale mais que a chave (um vMCP, uma skill). */
export type ActivitySlice = { key: string; label: string | null; count: number };

/** O relatório de um dia. Tudo somado: a menor unidade é "quantas vezes", nunca "quem" ou "qual operação". */
export type ActivityReport = {
  day: string;
  timezone: string;
  /** Quem se conectou ao MCP público. */
  clients: {
    /** Sessões abertas no dia. */
    sessions: number;
    /** Identidades distintas por trás delas. */
    distinct: number;
    /** Nomes de agente distintos declarados no `initialize` (`clientInfo.name`). */
    agents: number;
    /** Sessões encerradas no dia, por motivo. */
    ended: number;
    byTransport: ActivitySlice[];
    byAuth: ActivitySlice[];
    byEndReason: ActivitySlice[];
    /** Os agentes mais vistos, por nome declarado — sem versão, sem IP. */
    topAgents: ActivitySlice[];
  };
  /** O que foi chamado no MCP público. */
  calls: {
    total: number;
    byFamily: ActivitySlice[];
    /** Os métodos mais chamados, com a família de cada um no `label`. */
    topMethods: ActivitySlice[];
    byTransport: ActivitySlice[];
    /** Os servidores mais chamados; `key` é o slug e `label`, o nome. */
    byServer: ActivitySlice[];
  };
  /** O que foi lido do acervo. */
  reads: {
    total: number;
    /** Quantas leituras foram entrega de pacote (`kind = 'download'`). */
    downloads: number;
    /** Skills distintas lidas no dia. */
    skills: number;
    bySurface: ActivitySlice[];
    byOrigin: ActivitySlice[];
    byAuth: ActivitySlice[];
    /** As skills mais lidas; `key` é o slug e `label`, o nome. */
    topSkills: ActivitySlice[];
  };
  /** O que mudou no catálogo, pela trilha. */
  catalog: {
    total: number;
    /** Atores distintos (contas, tokens e o `ambiente`), contados sem identificar. */
    actors: number;
    /** Por ação da trilha; `key` é o `AuditAction`. */
    byAction: ActivitySlice[];
    /** Por origem do evento: `web-admin` ou `mcp-admin`. */
    bySource: ActivitySlice[];
  };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = 'error',
  ) {
    super(message);
  }
}

/**
 * O objeto pedido ficou **fora de alcance**: não existe mais, ou a conta deixou
 * de vê-lo — o servidor responde 404 aos dois, para não revelar o que existe
 * (`assertAccess`, em `admin/src/access.ts`). É o único erro de leitura que
 * justifica tirar a pessoa de uma ficha já carregada: sessão vencida (401),
 * 5xx e queda de rede passam, e sair desmontaria a tela com o que está nela.
 */
export const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(body.message ?? `Erro ${response.status}`, response.status, body.error);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (body: unknown) => JSON.stringify(body);

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '' && value !== false) {
      query.set(key, String(value));
    }
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

export const getSession = async (): Promise<Session> => ({
  ...SESSION_OPERATION_DEFAULTS,
  ...(await request<SessionLogin & Partial<SessionOperation>>('/api/session')),
});

/**
 * Um campo só para os dois caminhos (`docs/19-username.md` decisão 3): tem `@`,
 * o servidor trata como e-mail; não tem, como username. `identifier` ausente é o
 * login legado pela `ADMIN_PASSWORD`, que só vale com a tabela de contas vazia.
 */
export const login = (credentials: { identifier?: string; password: string }) =>
  request<{ authenticated: boolean }>('/api/login', { method: 'POST', body: json(credentials) });

/**
 * Sair apaga o cookie **e** revoga a conta: `revoked` diz que o `token_version`
 * subiu, ou seja, que as sessões desta conta em outros aparelhos caíram junto
 * (`docs/05-accounts-and-roles.md` §2.2). Vem `false` na sessão de bootstrap,
 * que não tem conta, e quando o banco recusou o incremento.
 */
export const logout = () =>
  request<{ authenticated: false; revoked: boolean }>('/api/logout', { method: 'POST' });

export const setup = (body: {
  adminPassword: string;
  username: string;
  email: string;
  name: string;
  password: string;
}) => request<{ authenticated: boolean; user: UserSummary }>('/api/setup', {
  method: 'POST',
  body: json(body),
});

// ------------------------------------------------------------ minha conta ---

/** Cópia manual de `ProfileLink` de `@purple-skills/shared` (ver o cabeçalho). */
export type ProfileLink = { label: string; url: string };

/** Cópia manual de `UserProfile`. O e-mail não está aqui, e é a funcionalidade. */
export type UserProfile = {
  username: string;
  name: string;
  bio: string;
  websiteUrl: string | null;
  links: ProfileLink[];
  isPublic: boolean;
  hasAvatar: boolean;
  avatarUpdatedAt: string | null;
};

export const getMyProfile = () => request<UserProfile>('/api/me/profile');

/** Campo ausente é "não mexe": a tela manda só o que mudou. */
export const saveMyProfile = (body: {
  name?: string;
  bio?: string;
  websiteUrl?: string | null;
  links?: ProfileLink[];
  isPublic?: boolean;
}) => request<UserProfile>('/api/me/profile', { method: 'PATCH', body: json(body) });

export const uploadMyAvatar = (file: File) => {
  const form = new FormData();
  form.append('file', file);
  return request<UserProfile>('/api/me/profile/avatar', { method: 'PUT', body: form });
};

export const deleteMyAvatar = () =>
  request<UserProfile>('/api/me/profile/avatar', { method: 'DELETE' });

/** Limpar o perfil de outra conta: só admin, e é apagar, nunca reescrever. */
export const clearUserProfile = (uuid: string) =>
  request<UserProfile>(`/api/users/${encodeURIComponent(uuid)}/profile`, { method: 'DELETE' });

/**
 * A URL da foto de uma conta, para um `<img src>`.
 *
 * O `stamp` (o `avatarUpdatedAt` do perfil) vai como query **de propósito**: a
 * rota responde `max-age=0, must-revalidate`, então trocar a foto já apareceria
 * na revalidação seguinte — mas o `<img>` de uma aba aberta há meia hora não
 * revalida sozinho. Com o carimbo na URL, trocar a foto troca a URL, e a
 * imagem nova entra sem recarregar a página.
 *
 * `null` quando a conta não tem foto: quem chama desenha o monograma.
 */
export const avatarUrl = (username: string, stamp: string | null): string | null =>
  stamp === null
    ? null
    : `/api/users/${encodeURIComponent(username)}/avatar?v=${encodeURIComponent(stamp)}`;

export const changePassword = (body: { currentPassword?: string; newPassword: string }) =>
  request<{ changed: boolean }>('/api/me/password', { method: 'POST', body: json(body) });

export const getKeys = () => request<{ items: ApiKeySummary[] }>('/api/me/keys');

/** O campo `token` chega uma única vez, na resposta desta chamada. */
export const createKey = (name: string) =>
  request<{ key: ApiKeySummary; token: string }>('/api/me/keys', {
    method: 'POST',
    body: json({ name }),
  });

export const revokeKey = (id: string) =>
  request<unknown>(`/api/me/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** As chaves `psv_` que a conta emitiu, em qualquer servidor. */
export const getMyMcpKeys = () => request<{ items: IssuedMcpKey[] }>('/api/me/mcp-keys');

// ----------------------------------------------------------------- contas ---

export const getUsers = () => request<{ items: UserSummary[] }>('/api/users');

export const createUser = (body: {
  username: string;
  email: string;
  name: string;
  role: Role;
  password?: string;
}) => request<{ user: UserSummary; temporaryPassword: string | null }>('/api/users', {
  method: 'POST',
  body: json(body),
});

export const updateUser = (
  uuid: string,
  body: { name?: string; username?: string; role?: Role; isActive?: boolean },
) =>
  request<UserSummary>(`/api/users/${encodeURIComponent(uuid)}`, {
    method: 'PATCH',
    body: json(body),
  });

/** A ficha de uma conta (`docs/13-fichas-e-acessos.md` §3.4), só admin. */
export const getUser = (uuid: string) => request<UserSummary>(`/api/users/${encodeURIComponent(uuid)}`);

export const getUserKeys = (uuid: string) =>
  request<{ items: ApiKeySummary[] }>(`/api/users/${encodeURIComponent(uuid)}/keys`);

export const revokeUserKey = (uuid: string, id: string) =>
  request<{ revoked: boolean }>(`/api/users/${encodeURIComponent(uuid)}/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getUserAccesses = (uuid: string, query: AccessLogQuery = {}) =>
  request<SkillAccessPage>(`/api/users/${encodeURIComponent(uuid)}/accesses${qs(query)}`);

export const resetUserPassword = (uuid: string) =>
  request<{ user: UserSummary; temporaryPassword: string }>(
    `/api/users/${encodeURIComponent(uuid)}/reset-password`,
    { method: 'POST' },
  );

/** Busca de contas para compartilhar: qualquer sessão, só contas ativas, 2+ caracteres. */
export const lookupUsers = (q: string) => request<{ items: UserLookup[] }>(`/api/users/lookup${qs({ q })}`);

// ----------------------------------------------------------------- acesso ---

export type AccessKind = 'skill' | 'catalog' | 'mcp';

const accessPath = (kind: AccessKind, slug: string, username: string) =>
  `/api/${kind === 'mcp' ? 'mcps' : kind === 'catalog' ? 'catalogs' : 'skills'}/${encodeURIComponent(slug)}/access/${encodeURIComponent(username)}`;

/** Concede ou muda o nível de uma conta num objeto (exige `manage`). */
export const share = (kind: AccessKind, slug: string, username: string, level: AccessLevel) =>
  request<Grant>(accessPath(kind, slug, username), { method: 'PUT', body: json({ level }) });

export const unshare = (kind: AccessKind, slug: string, username: string) =>
  request<{ revoked: true }>(accessPath(kind, slug, username), { method: 'DELETE' });

// -------------------------------------------------------------- clonagem ---

/**
 * O corpo das três rotas de clonagem (`docs/16-clonagem.md`). Os dois campos
 * são opcionais **de propósito**: sem `slug`, quem desempata é o servidor
 * (`uniqueSlug`), e esse é o único caminho que nunca responde 409. O painel só
 * manda o que a pessoa mudou — ver `corpoDaClonagem`, em `CloneDialog.tsx`.
 *
 * O que a cópia leva e o que ela não leva é decisão do servidor: ela nasce
 * fechada (nunca pública, nunca aberta) e de quem clonou; skill e catálogo não
 * levam concessão, e o vMCP leva as concessões, os vínculos e o canvas, mas
 * **não** leva chaves.
 */
export type CloneBody = { name?: string; slug?: string };

// ------------------------------------------------- redefinição de senha -----

export const requestPasswordReset = (email: string) =>
  request<{ requested: boolean }>('/api/password-reset/request', {
    method: 'POST',
    body: json({ email }),
  });

export const confirmPasswordReset = (token: string, password: string) =>
  request<{ reset: boolean }>('/api/password-reset/confirm', {
    method: 'POST',
    body: json({ token, password }),
  });

// -------------------------------------------------- stats, auditoria, tags ---

export const getStats = () => request<Stats>('/api/stats');

export type AuditQuery = {
  limit?: number;
  offset?: number;
  action?: AuditAction | '';
  actor?: string;
  q?: string;
  since?: string;
  until?: string;
};

export const getAudit = (query: AuditQuery = {}) =>
  request<AuditPage>(`/api/audit${qs(query)}`);

export const getTags = () => request<{ items: { name: string; count: number }[] }>('/api/tags');

// ------------------------------------------------------------- atividade ---

/**
 * A série do heatmap (`docs/18-atividade.md`).
 *
 * `since`/`until` são **instantes**: o dia do calendário de quem olha, virado
 * em borda por `activityInstants` (o `auditRange` da trilha). O fuso IANA vai
 * junto — e só aqui — porque é no SQL desta consulta que os instantes são
 * agrupados por dia; no relatório de um dia a janela já chega recortada e o
 * fuso não muda nada.
 */
export const getActivity = (query: { since?: string; until?: string; timezone?: string }) =>
  request<ActivitySeries>(`/api/activity${qs({ since: query.since, until: query.until, tz: query.timezone })}`);

/**
 * O relatório de um dia.
 *
 * O dia vai no caminho (`AAAA-MM-DD`) e a janela dele, em instantes, na query:
 * é ela que o servidor compara. O dia no caminho é **rótulo** — sem o fuso de
 * quem olha ele não delimita nada, e foi por confundir as duas coisas que a
 * trilha já abriu uma janela de 27 horas (`tasks/044`).
 *
 * O `tz` vai junto mesmo sem mudar recorte nenhum — aqui não há agrupamento
 * por dia, e a janela já chega pronta. Ele existe porque o corpo **ecoa** o
 * fuso em `ActivityReport.timezone`: sem mandá-lo, o servidor caía no padrão e
 * todo relatório afirmava "UTC" ao lado de números recortados em São Paulo. O
 * campo não é lido pela tela hoje, e era justamente isso que deixava a mentira
 * passar despercebida.
 */
export const getActivityDay = (day: string, query: { since?: string; until?: string; top?: number; timezone?: string }) =>
  request<ActivityReport>(
    `/api/activity/${encodeURIComponent(day)}${qs({ since: query.since, until: query.until, top: query.top, tz: query.timezone })}`,
  );

// ----------------------------------------------------------------- skills ---

export function listSkills(params: {
  q?: string;
  tag?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  scope?: AccessScope | '';
}) {
  return request<SearchResult>(`/api/skills${qs(params)}`);
}

export const getSkill = (slug: string) => request<SkillDetail>(`/api/skills/${encodeURIComponent(slug)}`);

export type CreateSkillBody = {
  name: string;
  slug?: string;
  description?: string;
  icon?: string | null;
  skillMd: string;
  tags?: string[];
  /** Onde publicar já na criação; só em vMCPs que a sessão edita. */
  mcps?: SkillLinkInput[];
  isPublic?: boolean;
};

export const createSkill = (body: CreateSkillBody) =>
  request<SkillDetail>('/api/skills', { method: 'POST', body: json(body) });

export type UpdateSkillBody = Partial<Omit<CreateSkillBody, 'mcps'>> & {
  isActive?: boolean;
  /** Transferir o dono: só dono e admin. */
  ownerUserUuid?: string | null;
};

export const updateSkill = (slug: string, body: UpdateSkillBody) =>
  request<SkillDetail>(`/api/skills/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    body: json(body),
  });

// Vínculo pelo lado da skill: `edit` no vMCP alvo e `view` na skill.
const skillMcpPath = (slug: string, mcp: string) =>
  `/api/skills/${encodeURIComponent(slug)}/mcps/${encodeURIComponent(mcp)}`;

export const linkSkillToMcp = (slug: string, mcp: string, flags: LinkFlags & { position?: CanvasPoint }) =>
  request<SkillDetail>(skillMcpPath(slug, mcp), { method: 'PUT', body: json(flags) });

export const unlinkSkillFromMcp = (slug: string, mcp: string) =>
  request<SkillDetail>(skillMcpPath(slug, mcp), { method: 'DELETE' });

/** Uma cópia da skill, com os arquivos: responde o mesmo corpo de `createSkill`. */
export const cloneSkill = (slug: string, body: CloneBody = {}) =>
  request<SkillDetail>(`/api/skills/${encodeURIComponent(slug)}/clone`, { method: 'POST', body: json(body) });

export const deleteSkill = (slug: string) =>
  request<unknown>(`/api/skills/${encodeURIComponent(slug)}`, { method: 'DELETE' });

const filePath = (slug: string, path: string) =>
  `/api/skills/${encodeURIComponent(slug)}/files/${path.split('/').map(encodeURIComponent).join('/')}`;

export const getFile = (slug: string, path: string) =>
  request<{ relativePath: string; mimeType: string; sizeBytes: number; isText: boolean; content: string | null }>(
    filePath(slug, path),
  );

export const setFile = (slug: string, path: string, content: string) =>
  request<SkillFileMeta>(filePath(slug, path), { method: 'PUT', body: json({ content }) });

/** Cria o arquivo só se o caminho estiver livre: um que já existe é 409, nunca sobrescrito. */
export const createFile = (slug: string, path: string, content = '') =>
  request<SkillFileMeta>(filePath(slug, path), { method: 'POST', body: json({ content }) });

export const deleteFile = (slug: string, path: string) =>
  request<unknown>(filePath(slug, path), { method: 'DELETE' });

export const rawFileUrl = (slug: string, path: string) => `${filePath(slug, path)}?raw`;

/** Download do pacote da skill (ZIP). Serve skills privadas — a sessão vai no cookie. */
export const skillDownloadUrl = (slug: string) =>
  `/api/skills/${encodeURIComponent(slug)}/download`;

/** Mesmo ZIP do `skillDownloadUrl`, servido com a extensão `.skill`. */
export const skillPackageUrl = (slug: string) =>
  `/api/skills/${encodeURIComponent(slug)}/download.skill`;

/** Onde um pacote importado cai (`docs/15-quarentena.md`). */
export type ImportDestination = 'production' | 'quarantine';

/**
 * O resultado de importar um pacote com **várias** skills, direto do pacote
 * compartilhado. Quem consome é a tela de importação.
 */
export type { BundleImported, BundleSkipped, QuarantineBundleResult, QuarantineImportResult };

type ImportFields = {
  name?: string;
  description?: string;
  icon?: string;
  tags?: string[];
  mcps?: SkillLinkInput[];
};

/**
 * Importa um pacote direto para o acervo. Quais formatos valem é assunto do
 * `FORMATOS_ACEITOS` de `packages/shared/src/archive.ts` — aqui a lista não se
 * repete: era repetida pela metade, sem o `.zstd`, e a tela herdou o engano.
 * Os campos do formulário completam o que o frontmatter do SKILL.md não
 * trouxer.
 *
 * Um pacote com mais de uma skill — contando as que passaram do teto de
 * arquivos — é recusado aqui com 400: o caminho delas é a quarentena, e a
 * mensagem do servidor explica isso por extenso.
 */
export function importZip(file: File, fields: ImportFields) {
  return request<SkillDetail>('/api/skills/import', {
    method: 'POST',
    body: importForm(file, fields, 'production'),
  });
}

/**
 * O mesmo pacote, para a quarentena: nada é interpretado, os arquivos entram
 * crus e ninguém publica nada até alguém aprovar. Nome e descrição saem do
 * SKILL.md quando ele existe — os campos do formulário não valem aqui, porque
 * na quarentena não há metadado separado do arquivo.
 *
 * Duas respostas na mesma rota: **uma** skill volta como `QuarantineDetail`,
 * como sempre; **duas ou mais** voltam como `QuarantineBundleResult`, uma linha
 * por skill. Uma skill só, mas com alguma pulada pelo caminho, também volta como
 * bundle — é o único corpo com onde dizer o que ficou de fora. Quem chama
 * discrimina por `'bundle' in resposta`.
 */
export function importToQuarantine(file: File) {
  return request<QuarantineImportResult>('/api/skills/import', {
    method: 'POST',
    body: importForm(file, {}, 'quarantine'),
  });
}

function importForm(file: File, fields: ImportFields, destination: ImportDestination): FormData {
  const form = new FormData();
  form.append('file', file);
  form.append('destination', destination);
  if (fields.name) form.append('name', fields.name);
  if (fields.description) form.append('description', fields.description);
  if (fields.icon) form.append('icon', fields.icon);
  if (fields.tags?.length) form.append('tags', JSON.stringify(fields.tags));
  if (fields.mcps?.length) form.append('mcps', JSON.stringify(fields.mcps));
  return form;
}

/**
 * Envio de arquivos avulsos para uma skill: **só texto**
 * (`docs/15-quarentena.md`). Binário é recusado pelo servidor com o nome do
 * arquivo na mensagem; quem precisa dele importa o pacote.
 */
export function uploadFiles(slug: string, files: FileList | File[], prefix = '') {
  const form = new FormData();
  for (const file of Array.from(files)) form.append('files', file);
  if (prefix) form.append('prefix', prefix);
  return request<{ files: SkillFileMeta[] }>(`/api/skills/${encodeURIComponent(slug)}/files`, {
    method: 'POST',
    body: form,
  });
}

// ------------------------------------------------------------ quarentena ---

/**
 * Um envio esperando aprovação (`docs/15-quarentena.md`). Cópia manual de
 * `QuarantineSummary` de `@purple-skills/shared`.
 *
 * Note o que **não** existe aqui: slug, tags, ícone, `isActive`, `isPublic`,
 * vínculo com vMCP ou catálogo, contadores e concessões. A quarentena é uma
 * pasta de arquivos com dono — e como não há slug, o endereço é o `uuid`.
 */
export type QuarantineSummary = {
  uuid: string;
  name: string;
  description: string;
  sourceFilename: string | null;
  /** Sai pelo username, como em toda ficha do painel; nulo é envio órfão. */
  ownerUserUuid: string | null;
  ownerUsername: string | null;
  fileCount: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type QuarantineDetail = QuarantineSummary & {
  files: SkillFileMeta[];
};

/**
 * O envio como a **ficha** o entrega: cópia manual de `QuarantineSheet` de
 * `@purple-skills/shared`. `canPromote` não é dado do banco — é a política da
 * instalação aplicada a quem pediu — e é obrigatório de propósito: opcional,
 * um `undefined` vindo de um servidor velho desenharia o botão "Aprovar" para
 * quem não pode. A decisão que vale continua sendo a da rota de promover.
 */
export type QuarantineSheet = QuarantineDetail & {
  canPromote: boolean;
};

const quarantinePath = (uuid: string) => `/api/quarantine/${encodeURIComponent(uuid)}`;

export const getQuarantineList = (query = '', limit = 50, offset = 0) =>
  request<{ items: QuarantineSummary[]; total: number; limit: number; offset: number }>(
    `/api/quarantine${qs({ q: query, limit, offset })}`,
  );

export const getQuarantineItem = (uuid: string) => request<QuarantineSheet>(quarantinePath(uuid));

export const deleteQuarantineItem = (uuid: string) =>
  request<unknown>(quarantinePath(uuid), { method: 'DELETE' });

/** Aprova: cria a skill em produção e apaga o envio. Devolve a skill criada. */
export const promoteQuarantineItem = (uuid: string) =>
  request<SkillDetail>(`${quarantinePath(uuid)}/promote`, { method: 'POST' });

export const quarantineDownloadUrl = (uuid: string) => `${quarantinePath(uuid)}/download`;

const quarantineFilePath = (uuid: string, path: string) =>
  `${quarantinePath(uuid)}/files/${path.split('/').map(encodeURIComponent).join('/')}`;

export const getQuarantineFile = (uuid: string, path: string) =>
  request<{ relativePath: string; mimeType: string; sizeBytes: number; isText: boolean; content: string | null }>(
    quarantineFilePath(uuid, path),
  );

/** Grava o arquivo como está sendo editado — inclusive o frontmatter do SKILL.md. */
export const setQuarantineFile = (uuid: string, path: string, content: string) =>
  request<SkillFileMeta>(quarantineFilePath(uuid, path), { method: 'PUT', body: json({ content }) });

export const createQuarantineFile = (uuid: string, path: string, content = '') =>
  request<SkillFileMeta>(quarantineFilePath(uuid, path), { method: 'POST', body: json({ content }) });

export const deleteQuarantineFile = (uuid: string, path: string) =>
  request<unknown>(quarantineFilePath(uuid, path), { method: 'DELETE' });

export const rawQuarantineFileUrl = (uuid: string, path: string) =>
  `${quarantineFilePath(uuid, path)}?raw`;

/** Quem aprova, nesta instalação. Cópia de `QuarantineApprovers` de shared. */
export type QuarantineApprovers = 'admin' | 'admin+owner' | 'admin+editor';

export const QUARANTINE_APPROVERS_LABEL: Record<QuarantineApprovers, string> = {
  admin: 'somente administradores',
  'admin+owner': 'administradores e o dono do envio',
  'admin+editor': 'administradores e editores',
};

export const getQuarantineSettings = () =>
  request<{ approvers: QuarantineApprovers; options: QuarantineApprovers[] }>('/api/settings/quarantine');

export const setQuarantineSettings = (approvers: QuarantineApprovers) =>
  request<{ approvers: QuarantineApprovers; options: QuarantineApprovers[] }>('/api/settings/quarantine', {
    method: 'PUT',
    body: json({ approvers }),
  });

// ----------------------------------------------------------- MCP virtual ---

const mcpPath = (slug: string) => `/api/mcps/${encodeURIComponent(slug)}`;

export const getMcps = (scope: AccessScope | '' = '') =>
  request<{ items: VirtualMcpSummary[] }>(`/api/mcps${qs({ scope })}`);

export const getMcp = (slug: string) => request<VirtualMcpDetail>(mcpPath(slug));

export const createMcp = (body: { name: string; slug?: string; description?: string; isOpen?: boolean }) =>
  request<VirtualMcpDetail>('/api/mcps', { method: 'POST', body: json(body) });

export type UpdateMcpBody = {
  name?: string;
  slug?: string;
  description?: string;
  isOpen?: boolean;
  isActive?: boolean;
  ownerUserUuid?: string | null;
};

export const updateMcp = (slug: string, body: UpdateMcpBody) =>
  request<VirtualMcpDetail>(mcpPath(slug), { method: 'PATCH', body: json(body) });

/** Uma cópia do servidor, com as concessões, os vínculos e o canvas — sem as chaves. */
export const cloneMcp = (slug: string, body: CloneBody = {}) =>
  request<VirtualMcpDetail>(`${mcpPath(slug)}/clone`, { method: 'POST', body: json(body) });

export const deleteMcp = (slug: string) => request<unknown>(mcpPath(slug), { method: 'DELETE' });

export const setMcpSkills = (slug: string, skills: VirtualMcpSkillInput[]) =>
  request<VirtualMcpDetail>(`${mcpPath(slug)}/skills`, { method: 'PUT', body: json({ skills }) });

export type CanvasPosition = { slug: string; x: number; y: number };

/** Posições do canvas: estado de tela, sem auditoria. */
export const setMcpCanvas = (
  slug: string,
  body: { layout?: VirtualMcpLayout; positions?: CanvasPosition[]; catalogPositions?: CanvasPosition[] },
) => request<{ ok: true }>(`${mcpPath(slug)}/canvas`, { method: 'PUT', body: json(body) });

// Catálogos no vMCP: `edit` no vMCP e `view` no catálogo que entra.
const mcpCatalogPath = (mcp: string, catalog: string) => `${mcpPath(mcp)}/catalogs/${encodeURIComponent(catalog)}`;

export const setMcpCatalogs = (slug: string, catalogs: VirtualMcpCatalogInput[]) =>
  request<VirtualMcpDetail>(`${mcpPath(slug)}/catalogs`, { method: 'PUT', body: json({ catalogs }) });

export const linkCatalogToMcp = (mcp: string, catalog: string, flags: LinkFlags & { position?: CanvasPoint }) =>
  request<VirtualMcpDetail>(mcpCatalogPath(mcp, catalog), { method: 'PUT', body: json(flags) });

export const unlinkCatalogFromMcp = (mcp: string, catalog: string) =>
  request<VirtualMcpDetail>(mcpCatalogPath(mcp, catalog), { method: 'DELETE' });

// -------------------------------------------------------------- catálogos ---

const catalogPath = (slug: string) => `/api/catalogs/${encodeURIComponent(slug)}`;
const catalogSkillPath = (slug: string, skill: string) => `${catalogPath(slug)}/skills/${encodeURIComponent(skill)}`;

export const getCatalogs = (scope: AccessScope | '' = '') =>
  request<{ items: CatalogSummary[] }>(`/api/catalogs${qs({ scope })}`);

export const getCatalog = (slug: string) => request<CatalogDetail>(catalogPath(slug));

export const createCatalog = (body: { name: string; slug?: string; description?: string; isPublic?: boolean }) =>
  request<CatalogDetail>('/api/catalogs', { method: 'POST', body: json(body) });

export type UpdateCatalogBody = {
  name?: string;
  slug?: string;
  description?: string;
  isActive?: boolean;
  isPublic?: boolean;
  ownerUserUuid?: string | null;
};

export const updateCatalog = (slug: string, body: UpdateCatalogBody) =>
  request<CatalogDetail>(catalogPath(slug), { method: 'PATCH', body: json(body) });

/** Uma cópia do catálogo, com os mesmos membros: responde o mesmo corpo de `createCatalog`. */
export const cloneCatalog = (slug: string, body: CloneBody = {}) =>
  request<CatalogDetail>(`${catalogPath(slug)}/clone`, { method: 'POST', body: json(body) });

export const deleteCatalog = (slug: string) => request<unknown>(catalogPath(slug), { method: 'DELETE' });

export const setCatalogSkills = (slug: string, skills: CatalogSkillInput[]) =>
  request<CatalogDetail>(`${catalogPath(slug)}/skills`, { method: 'PUT', body: json({ skills }) });

/** Adiciona a skill (participação ativa); numa que já é membro não mexe em nada. */
export const addCatalogSkill = (slug: string, skill: string) =>
  request<CatalogDetail>(catalogSkillPath(slug, skill), { method: 'PUT', body: json({}) });

/** Liga ou desliga a participação da skill no catálogo, sem removê-la. */
export const setCatalogSkillActive = (slug: string, skill: string, isActive: boolean) =>
  request<CatalogDetail>(catalogSkillPath(slug, skill), { method: 'PUT', body: json({ isActive }) });

export const removeCatalogSkill = (slug: string, skill: string) =>
  request<CatalogDetail>(catalogSkillPath(slug, skill), { method: 'DELETE' });

export const getMcpOnline = (slug: string) => request<OnlineCount>(`${mcpPath(slug)}/online`);

export const getMcpSessions = (slug: string, query: { online?: boolean; limit?: number; offset?: number } = {}) =>
  request<McpSessionPage>(`${mcpPath(slug)}/sessions${qs(query)}`);

export const getSessions = (query: { mcp?: string; online?: boolean; limit?: number; offset?: number } = {}) =>
  request<McpSessionPage>(`/api/sessions${qs(query)}`);

/** Os últimos acessos a uma skill (quem administra) e a um catálogo (idem), paginados. */
export const getSkillAccesses = (slug: string, query: AccessLogQuery = {}) =>
  request<SkillAccessPage>(`/api/skills/${encodeURIComponent(slug)}/accesses${qs(query)}`);

export const getCatalogAccesses = (slug: string, query: AccessLogQuery = {}) =>
  request<SkillAccessPage>(`${catalogPath(slug)}/accesses${qs(query)}`);

export const getMcpKeys = (slug: string) =>
  request<{ items: VirtualMcpKeySummary[] }>(`${mcpPath(slug)}/keys`);

/** O campo `token` chega uma única vez, na resposta desta chamada. */
export const createMcpKey = (slug: string, name: string) =>
  request<{ key: VirtualMcpKeySummary; token: string }>(`${mcpPath(slug)}/keys`, {
    method: 'POST',
    body: json({ name }),
  });

export const revokeMcpKey = (slug: string, id: string) =>
  request<unknown>(`${mcpPath(slug)}/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });

// ------------------------------------------------------- configuração ---

export const getSettings = () => request<InstallationSettings>('/api/settings');

/** `null` limpa o padrão: a raiz passa a responder 404. */
export const setDefaultMcp = (uuid: string | null) =>
  request<InstallationSettings>('/api/settings/default-mcp', { method: 'PUT', body: json({ uuid }) });

// ------------------------------------------------------------ formatação ---

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "agora", "há 3 min", "há 2 h", "há 5 d" — para últimas atividades. */
export function formatRelative(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.round(diff / 1000);
  if (s < 45) return 'agora';
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `há ${h} h`;
  const d = Math.round(h / 24);
  return `há ${d} d`;
}

export const num = (value: number | undefined | null) =>
  value === undefined || value === null ? '—' : value.toLocaleString('pt-BR');

export const plural = (n: number, one: string, many: string) => `${num(n)} ${n === 1 ? one : many}`;

/**
 * Uma conta na tela: `@username`, ou o texto de ausência quando não há.
 *
 * Existe para o `@` ser **um lugar só**. Doze telas mostram o dono de um objeto,
 * e o arroba escrito à mão em cada uma delas é a receita para uma sair sem —
 * ou, pior, para alguém concluir que ali não é um username. O texto de ausência
 * fica com quem chama, porque ele muda com o contexto: "sem dono" numa linha de
 * lista, "nenhum (só administradores)" numa ficha que precisa explicar o
 * efeito.
 */
export const atUser = (username: string | null | undefined, ausente: string): string =>
  username ? `@${username}` : ausente;

/**
 * A busca semântica, como o painel a vê (`docs/14-rag.md` §9).
 *
 * O painel **não recebe** a chave da API: quem sabe se ela existe e se o
 * provedor a aceitou é o indexador, que publica o estado no banco a cada ciclo.
 * Por isso `keyState` pode ser `desconhecido` — é o caso honesto de quando o
 * indexador ainda não rodou. O que chega aqui é sempre a **classificação** do
 * estado da chave, decidida no servidor pela classe do último erro; o valor
 * dela não sai do container que fala com o provedor.
 */
export type RagValue = {
  value: string;
  origem: 'banco' | 'ambiente' | 'padrão';
  updatedAt: string | null;
  /**
   * O `.env` diz outra coisa e está sendo ignorado: o banco decide (§5). No
   * modelo, também quando o `RAG_MODEL` não é do driver que o banco gravou.
   */
  ambienteIgnorado: string | null;
};

export type RagCoverage = {
  texts: number;
  withVector: number;
  pendingTexts: number;
  /**
   * Quantos dos pendentes o provedor recusou de vez neste espaço. Está **dentro**
   * de `pendingTexts`: é a explicação da cobertura que não fecha.
   */
  refusedTexts: number;
  staleSkills: number;
  /**
   * Quantas das skills a refatiar o indexador não retoma sozinho: a leitura delas
   * começou três vezes e nenhuma terminou. Está **dentro** de `staleSkills`.
   */
  stuckSkills?: number;
};

export type RagIndexerState = {
  at?: string;
  driver?: string;
  model?: string;
  keyPresent?: boolean;
  lastError?: string | null;
  /**
   * A classe de `lastError`, como o indexador a publica; `null` quando o erro
   * não veio do provedor, ausente em estado gravado por indexador antigo. Quem
   * a traduz em `keyState` é o servidor — a tela não decide por ela.
   */
  lastErrorKind?: string | null;
  lastErrorAt?: string | null;
};

export type RagSettings = {
  driver: RagValue;
  model: RagValue;
  drivers: string[];
  /** Os modelos do driver em uso. */
  models: string[];
  /** Um item por driver implementado, com o rótulo e os modelos dele. */
  driverOptions: { id: string; label: string; models: string[] }[];
  /** Falso enquanto a migration do RAG não rodou nesta instalação. */
  schemaReady: boolean;
  spaceUuid: string | null;
  coverage: RagCoverage | null;
  indexer: RagIndexerState | null;
  /**
   * `nao-confirmada`: o último ciclo terminou com um erro que não fala da chave.
   * `sem-credito`: a conta do provedor precisa ser paga; esperar não resolve.
   */
  keyState:
    | 'presente'
    | 'ausente'
    | 'recusada'
    | 'cota-esgotada'
    | 'sem-credito'
    | 'nao-confirmada'
    | 'desconhecido';
  /** Só o Google tem nível gratuito que lê o conteúdo enviado; nos outros é nulo. */
  freeTierWarning: string | null;
};

export const getRagSettings = () => request<RagSettings>('/api/settings/rag');

export const saveRagSettings = (body: { driver?: string; model?: string }) =>
  request<RagSettings>('/api/settings/rag', { method: 'PUT', body: json(body) });

export const reindexRag = () =>
  request<{ skills: number }>('/api/settings/rag/reindex', { method: 'POST' });

/**
 * Devolve à fila os textos recusados do espaço em uso. Não é o "Reindexar": custa
 * requisições ao provedor, e o que for recusa genuína é recusado uma vez mais.
 */
export const clearRagRefusals = () =>
  request<{ refusals: number }>('/api/settings/rag/refusals/clear', { method: 'POST' });
