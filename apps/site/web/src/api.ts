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

export type SkillDetail = SkillSummary & {
  skillMd: string;
  files: SkillFileMeta[];
};

export type SearchResult = {
  items: SkillSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type SiteMeta = {
  name: string;
  tagline: string;
  baseUrl: string;
  mcpUrl: string | null;
  mcpAdminUrl: string | null;
  adminUrl: string | null;
};

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? `Falha na requisição (${response.status})`);
  }
  return (await response.json()) as T;
}

export type SearchParams = {
  q?: string;
  tag?: string;
  limit?: number;
  offset?: number;
  sort?: string;
};

export function searchSkills(params: SearchParams): Promise<SearchResult> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.tag) query.set('tag', params.tag);
  if (params.limit) query.set('limit', String(params.limit));
  if (params.offset) query.set('offset', String(params.offset));
  if (params.sort) query.set('sort', params.sort);
  return get<SearchResult>(`/api/skills?${query.toString()}`);
}

export const fetchSkill = (slug: string) => get<SkillDetail>(`/api/skills/${encodeURIComponent(slug)}`);
export const fetchTags = () => get<{ items: { name: string; count: number }[] }>('/api/tags');
export const fetchMeta = () => get<SiteMeta>('/api/meta');

export const downloadUrl = (slug: string) => `/skills/${encodeURIComponent(slug)}/download`;

export const fileUrl = (slug: string, path: string) =>
  `/api/skills/${encodeURIComponent(slug)}/files/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
