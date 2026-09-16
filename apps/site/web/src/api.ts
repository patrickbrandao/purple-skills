/** Um MCP virtual em que a skill está — só os abertos e ligados chegam ao site. */
export type SkillMcpRef = {
  uuid: string;
  slug: string;
  name: string;
  isOpen: boolean;
  isActive: boolean;
  /** Responde também em `/mcp`, o MCP público. */
  isDefault: boolean;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

/** Cópia manual do tipo de `@purple-skills/shared` — este bundle é de browser. */
export type SkillSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Onde a skill está: é por estar em um MCP aberto que ela aparece aqui. */
  mcps: SkillMcpRef[];
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
  /**
   * Como a busca foi resolvida (`tmp/RAG-GOOGLE.md` §8.3, futuro `docs/14`).
   * `text` é a busca de sempre; `hybrid` soma a perna vetorial. Cair para
   * `text` não é erro — é o que acontece com a busca semântica desligada.
   */
  mode: 'text' | 'hybrid';
};

/**
 * O MCP público é o MCP virtual padrão da instalação. `status` diz se há um
 * em pé; `requiresKey`, se o `mcp.json` precisa do header `Authorization`.
 */
export type PublicMcpInfo =
  | { status: 'ok'; slug: string; name: string; description: string; requiresKey: boolean }
  | {
      status: 'none' | 'deleted' | 'inactive';
      slug: string | null;
      name: null;
      description: null;
      requiresKey: null;
    };

/** Um MCP virtual aberto e ligado, como o site o lista. */
export type PublicVirtualMcp = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  skillCount: number;
  isDefault: boolean;
  /** `<MCP_PUBLIC_URL>/virtual/<slug>/mcp`, ou nulo sem a variável. */
  url: string | null;
};

export type SiteMeta = {
  name: string;
  tagline: string;
  baseUrl: string;
  /** `<MCP_PUBLIC_URL>/mcp`, ou nulo quando a variável não foi configurada. */
  mcpUrl: string | null;
  mcp: PublicMcpInfo;
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
export const fetchOpenMcps = () => get<{ items: PublicVirtualMcp[] }>('/api/mcps');

/** Um catálogo público e ligado, como o site o lista (`docs/12-acesso-granular.md` decisão 14). */
export type PublicCatalog = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /** Membros com participação ativa e skill ativa. */
  skillCount: number;
};

/** A página do catálogo: todos os membros ativos, mesmo os não marcados públicos. */
export type PublicCatalogDetail = PublicCatalog & { skills: SkillSummary[] };

export const fetchPublicCatalogs = () => get<{ items: PublicCatalog[] }>('/api/catalogs');
export const fetchPublicCatalog = (slug: string) =>
  get<PublicCatalogDetail>(`/api/catalogs/${encodeURIComponent(slug)}`);

export const downloadUrl = (slug: string) => `/skills/${encodeURIComponent(slug)}/download`;

/** Mesmo ZIP do `downloadUrl`, servido com a extensão `.skill`. */
export const skillPackageUrl = (slug: string) =>
  `/skills/${encodeURIComponent(slug)}/download.skill`;

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
