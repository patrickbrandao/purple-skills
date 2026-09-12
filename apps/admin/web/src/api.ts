/** Cópia manual do tipo de `@purple-skills/shared` — este bundle é de browser. */
export type SkillSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  isPublic: boolean;
  useAsSkill: boolean;
  useAsPrompt: boolean;
  useAsResource: boolean;
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

export type SkillDetail = SkillSummary & { skillMd: string; files: SkillFileMeta[] };

export type SearchResult = {
  items: SkillSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type Stats = {
  totalSkills: number;
  publicSkills: number;
  privateSkills: number;
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
  | 'public.key.create'
  | 'public.key.revoke';

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

export type Role = 'admin' | 'editor' | 'leitor';

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'administrador',
  editor: 'editor',
  leitor: 'leitor',
};

/** Espelha `packages/shared/src/roles.ts` — a decisão real é do servidor. */
export const canWrite = (role: Role) => role === 'admin' || role === 'editor';
export const canDelete = (role: Role) => role === 'admin';
export const canManageUsers = (role: Role) => role === 'admin';
export const canCreateVirtualMcp = canWrite;
export const canManageVirtualMcp = (
  role: Role,
  ownerUserUuid: string | null,
  userUuid: string | null,
) => role === 'admin' || (userUuid !== null && ownerUserUuid === userUuid);

export type SessionUser = {
  uuid: string | null;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  /** Sessão aberta com a ADMIN_PASSWORD, antes de existir qualquer conta. */
  legacy: boolean;
};

export type Session = {
  authenticated: boolean;
  user: SessionUser | null;
  needsSetup: boolean;
  legacyLogin: boolean;
  oidc: { enabled: boolean; name?: string };
  passwordResetByEmail: boolean;
  siteName: string;
  siteBaseUrl: string;
  /** Base pública do MCP público — vazia quando `MCP_PUBLIC_URL` não foi configurada. */
  mcpPublicUrl: string;
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

export type VirtualMcpSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  isActive: boolean;
  isOpen: boolean;
  ownerUserUuid: string | null;
  ownerEmail: string | null;
  skillCount: number;
  privateSkillCount: number;
  activeKeyCount: number;
  /** É o vMCP que responde em `/mcp`. */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type VirtualMcpSkill = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  isPublic: boolean;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
  viewCount: number;
  downloadCount: number;
};

export type VirtualMcpDetail = VirtualMcpSummary & { skills: VirtualMcpSkill[] };

export type VirtualMcpSkillInput = {
  slug: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

export type VirtualMcpRef = { uuid: string; slug: string; name: string };

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

/** Código do 400 que pede confirmação para abrir um MCP com skill privada. */
export const CONFIRM_OPEN_REQUIRED = 'confirm_open_required';

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

export const getStats = () => request<Stats>('/api/stats');
export const getAudit = () => request<{ items: AuditEntry[] }>('/api/audit');
export const getTags = () => request<{ items: { name: string; count: number }[] }>('/api/tags');

export function listSkills(params: { q?: string; tag?: string; limit?: number; offset?: number; sort?: string }) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return request<SearchResult>(`/api/skills?${query.toString()}`);
}

export const getSkill = (slug: string) =>
  request<SkillDetail & { virtualMcps: VirtualMcpRef[] }>(`/api/skills/${encodeURIComponent(slug)}`);

export type CreateSkillBody = {
  name: string;
  slug?: string;
  description?: string;
  skillMd: string;
  tags?: string[];
  isPublic?: boolean;
  useAsSkill?: boolean;
  useAsPrompt?: boolean;
  useAsResource?: boolean;
};

export const createSkill = (body: CreateSkillBody) =>
  request<SkillDetail>('/api/skills', { method: 'POST', body: json(body) });

export type UpdateSkillBody = Partial<CreateSkillBody>;

export const updateSkill = (slug: string, body: UpdateSkillBody) =>
  request<SkillDetail>(`/api/skills/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    body: json(body),
  });

export const setVisibility = (slug: string, isPublic: boolean) =>
  request<SkillSummary>(`/api/skills/${encodeURIComponent(slug)}/visibility`, {
    method: 'POST',
    body: json({ isPublic }),
  });

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
    tags?: string[];
    isPublic?: boolean;
    useAsSkill?: boolean;
    useAsPrompt?: boolean;
    useAsResource?: boolean;
  },
) {
  const form = new FormData();
  form.append('file', file);
  if (fields.name) form.append('name', fields.name);
  if (fields.description) form.append('description', fields.description);
  if (fields.tags?.length) form.append('tags', JSON.stringify(fields.tags));
  form.append('isPublic', String(fields.isPublic === true));
  // Esta nasce ligada: quem omite quer o padrão, não o desligamento.
  form.append('useAsSkill', String(fields.useAsSkill !== false));
  form.append('useAsPrompt', String(fields.useAsPrompt === true));
  form.append('useAsResource', String(fields.useAsResource === true));
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

export const getMcps = () => request<{ items: VirtualMcpSummary[] }>('/api/mcps');

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
  confirmOpen?: boolean;
};

export const updateMcp = (slug: string, body: UpdateMcpBody) =>
  request<VirtualMcpDetail>(mcpPath(slug), { method: 'PATCH', body: json(body) });

export const deleteMcp = (slug: string) => request<unknown>(mcpPath(slug), { method: 'DELETE' });

export const setMcpSkills = (slug: string, skills: VirtualMcpSkillInput[], confirmOpen?: boolean) =>
  request<VirtualMcpDetail>(`${mcpPath(slug)}/skills`, {
    method: 'PUT',
    body: json({ skills, confirmOpen }),
  });

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
