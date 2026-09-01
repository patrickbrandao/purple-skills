export type SkillSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  isPublic: boolean;
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
};

export type AuditEntry = {
  id: string;
  skillUuid: string | null;
  skillSlug: string | null;
  filePath: string | null;
  action: 'create' | 'update' | 'delete';
  source: 'web-admin' | 'mcp-admin';
  createdAt: string;
};

export type Session = { authenticated: boolean; siteName: string; siteBaseUrl: string };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new ApiError(body.message ?? `Erro ${response.status}`, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const getSession = () => request<Session>('/api/session');
export const login = (password: string) =>
  request<{ authenticated: boolean }>('/api/login', { method: 'POST', body: json({ password }) });
export const logout = () => request<unknown>('/api/logout', { method: 'POST' });

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
  request<SkillDetail>(`/api/skills/${encodeURIComponent(slug)}`);

export type CreateSkillBody = {
  name: string;
  slug?: string;
  description?: string;
  skillMd: string;
  tags?: string[];
  isPublic?: boolean;
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

export function importZip(file: File, fields: { name?: string; description?: string; tags?: string[]; isPublic?: boolean }) {
  const form = new FormData();
  form.append('file', file);
  if (fields.name) form.append('name', fields.name);
  if (fields.description) form.append('description', fields.description);
  if (fields.tags?.length) form.append('tags', JSON.stringify(fields.tags));
  form.append('isPublic', String(fields.isPublic === true));
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
