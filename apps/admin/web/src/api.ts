/**
 * Cliente da API do painel e os tipos que ela devolve.
 *
 * Os tipos são cópias manuais dos de `@purple-skills/shared`: este bundle é de
 * navegador e não importa o pacote. Ao mudar um lá, mude aqui.
 */

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

/** Uma concessão: a conta, o nível e quem concedeu. */
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

export type UserLookup = { uuid: string; email: string; name: string; role: Role };

/** O filtro das listas: meus, compartilhados comigo, públicos. */
export type AccessScope = 'mine' | 'shared' | 'public';

/** Os campos de acesso que skill, catálogo e vMCP têm em comum. */
export type Accessible = {
  ownerUserUuid: string | null;
  ownerEmail: string | null;
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
  /** Onde a skill está, direto ou por catálogo. Vazio = flutuante: não é exibida em lugar nenhum. */
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
};

export type Stats = {
  totalSkills: number;
  openSkills: number;
  unlinkedSkills: number;
  totalFiles: number;
  totalViews: number;
  totalDownloads: number;
  totalTags: number;
  totalUsers: number;
  activeUsers: number;
};

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'user.create'
  | 'user.role'
  | 'user.deactivate'
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
  | 'public.key.create'
  | 'public.key.revoke';

export const AUDIT_ACTIONS: AuditAction[] = [
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
export const canCreate = (role: Role) => role === 'admin' || role === 'editor';
export const canManageUsers = (role: Role) => role === 'admin';

export type SessionUser = {
  uuid: string | null;
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

export type Session = {
  authenticated: boolean;
  user: SessionUser | null;
  needsSetup: boolean;
  legacyLogin: boolean;
  oidc: { enabled: boolean; name?: string };
  passwordResetByEmail: boolean;
  siteName: string;
  brand: AdminBrand;
  siteBaseUrl: string;
  /** Base pública do MCP público — vazia quando `MCP_PUBLIC_URL` não foi configurada. */
  mcpPublicUrl: string;
  links: AdminLinks;
  /** Janela em que um cliente conta como online (MCP_SESSION_ONLINE_WINDOW_MS). */
  onlineWindowMs: number;
  version: string;
};

export type UserSummary = {
  uuid: string;
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
  preview: VirtualMcpPreviewSkill[];
  /** Catálogos vinculados, ligados ou não. */
  catalogCount: number;
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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = 'error',
  ) {
    super(message);
  }
}

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

export const getSession = () => request<Session>('/api/session');

export const login = (credentials: { email?: string; password: string }) =>
  request<{ authenticated: boolean }>('/api/login', { method: 'POST', body: json(credentials) });

export const logout = () => request<unknown>('/api/logout', { method: 'POST' });

export const setup = (body: {
  adminPassword: string;
  email: string;
  name: string;
  password: string;
}) => request<{ authenticated: boolean; user: UserSummary }>('/api/setup', {
  method: 'POST',
  body: json(body),
});

// ------------------------------------------------------------ minha conta ---

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

// ----------------------------------------------------------------- contas ---

export const getUsers = () => request<{ items: UserSummary[] }>('/api/users');

export const createUser = (body: {
  email: string;
  name: string;
  role: Role;
  password?: string;
}) => request<{ user: UserSummary; temporaryPassword: string | null }>('/api/users', {
  method: 'POST',
  body: json(body),
});

export const updateUser = (uuid: string, body: { name?: string; role?: Role; isActive?: boolean }) =>
  request<UserSummary>(`/api/users/${encodeURIComponent(uuid)}`, {
    method: 'PATCH',
    body: json(body),
  });

export const resetUserPassword = (uuid: string) =>
  request<{ user: UserSummary; temporaryPassword: string }>(
    `/api/users/${encodeURIComponent(uuid)}/reset-password`,
    { method: 'POST' },
  );

/** Busca de contas para compartilhar: qualquer sessão, só contas ativas, 2+ caracteres. */
export const lookupUsers = (q: string) => request<{ items: UserLookup[] }>(`/api/users/lookup${qs({ q })}`);

// ----------------------------------------------------------------- acesso ---

export type AccessKind = 'skill' | 'catalog' | 'mcp';

const accessPath = (kind: AccessKind, slug: string, email: string) =>
  `/api/${kind === 'mcp' ? 'mcps' : kind === 'catalog' ? 'catalogs' : 'skills'}/${encodeURIComponent(slug)}/access/${encodeURIComponent(email)}`;

/** Concede ou muda o nível de uma conta num objeto (exige `manage`). */
export const share = (kind: AccessKind, slug: string, email: string, level: AccessLevel) =>
  request<Grant>(accessPath(kind, slug, email), { method: 'PUT', body: json({ level }) });

export const unshare = (kind: AccessKind, slug: string, email: string) =>
  request<{ revoked: true }>(accessPath(kind, slug, email), { method: 'DELETE' });

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

export const deleteFile = (slug: string, path: string) =>
  request<unknown>(filePath(slug, path), { method: 'DELETE' });

export const rawFileUrl = (slug: string, path: string) => `${filePath(slug, path)}?raw`;

/** Download do pacote da skill (ZIP). Serve skills privadas — a sessão vai no cookie. */
export const skillDownloadUrl = (slug: string) =>
  `/api/skills/${encodeURIComponent(slug)}/download`;

/** Mesmo ZIP do `skillDownloadUrl`, servido com a extensão `.skill`. */
export const skillPackageUrl = (slug: string) =>
  `/api/skills/${encodeURIComponent(slug)}/download.skill`;

export function importZip(
  file: File,
  fields: {
    name?: string;
    description?: string;
    icon?: string;
    tags?: string[];
    mcps?: SkillLinkInput[];
  },
) {
  const form = new FormData();
  form.append('file', file);
  if (fields.name) form.append('name', fields.name);
  if (fields.description) form.append('description', fields.description);
  if (fields.icon) form.append('icon', fields.icon);
  if (fields.tags?.length) form.append('tags', JSON.stringify(fields.tags));
  if (fields.mcps?.length) form.append('mcps', JSON.stringify(fields.mcps));
  return request<SkillDetail>('/api/skills/import', { method: 'POST', body: form });
}

export function uploadZip(slug: string, file: File, replace: boolean) {
  const form = new FormData();
  form.append('file', file);
  return request<{ files: SkillFileMeta[] }>(
    `/api/skills/${encodeURIComponent(slug)}/upload?replace=${replace ? 1 : 0}`,
    { method: 'POST', body: form },
  );
}

export function uploadFiles(slug: string, files: FileList | File[], prefix = '') {
  const form = new FormData();
  for (const file of Array.from(files)) form.append('files', file);
  if (prefix) form.append('prefix', prefix);
  return request<{ files: SkillFileMeta[] }>(`/api/skills/${encodeURIComponent(slug)}/files`, {
    method: 'POST',
    body: form,
  });
}

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
