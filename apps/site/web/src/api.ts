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
  /**
   * Quem mantém a skill, pelo **username** (`docs/19-username.md` decisão 11).
   * `null` é skill sem dono, e a página não credita ninguém. O `ownerUserUuid`
   * não vem para cá: é o `sub` do cookie de sessão do painel, e não tem uso
   * numa página anônima.
   */
  ownerUsername: string | null;
  /**
   * O dono tem perfil público? É o que decide se o crédito vira link para
   * `/u/<username>` ou fica em texto (`docs/20-perfil.md` §7). É o único dado
   * de perfil que viaja na ficha da skill.
   */
  ownerHasProfile: boolean;
  /**
   * Onde a skill está: os MCPs virtuais **abertos e ligados** que a publicam,
   * com as portas de cada um. Pode vir vazia: desde o acesso granular
   * (`docs/12-acesso-granular.md` §7) a skill também chega ao site por ter sido
   * marcada pública ou por estar em um catálogo público e ligado.
   */
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
   * Como a busca foi resolvida (`docs/14-rag.md` §8.3).
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
  | { status: 'ok'; slug: string; name: string; requiresKey: boolean }
  | {
      status: 'none' | 'deleted' | 'inactive';
      slug: string | null;
      name: null;
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
  /** `MCP_ADMIN_URL` como o operador a escreveu: o endereço completo, já com o `/mcp`. */
  mcpAdminUrl: string | null;
  adminUrl: string | null;
  /**
   * `true` com `SITE_CORS_ORIGIN` no padrão (`*`): a API aceita qualquer
   * origem. `false` quando a instalação restringiu — o navegador de outra
   * origem não lê a resposta; script e agente, sem `Origin`, continuam lendo.
   */
  corsOpen: boolean;
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
  /** Quem mantém o catálogo, pelo username; `null` é catálogo sem dono. */
  ownerUsername: string | null;
  /** O dono tem perfil público? Decide se o crédito vira link (`docs/20` §7). */
  ownerHasProfile: boolean;
  /** Membros com participação ativa e skill ativa. */
  skillCount: number;
};

/** A página do catálogo: todos os membros ativos, mesmo os não marcados públicos. */
export type PublicCatalogDetail = PublicCatalog & { skills: SkillSummary[] };

export const fetchPublicCatalogs = () => get<{ items: PublicCatalog[] }>('/api/catalogs');

export const fetchPublicCatalog = (slug: string) =>
  get<PublicCatalogDetail>(`/api/catalogs/${encodeURIComponent(slug)}`);

// ---------------------------------------------------------------- perfil ---

/** Cópia manual de `ProfileLink` de `@purple-skills/shared`. */
export type ProfileLink = { label: string; url: string };

/**
 * O perfil público (`docs/20-perfil.md`). Só existe quando a pessoa publicou:
 * a rota responde 404 para perfil privado, conta desativada e username
 * inexistente, sem distinguir os três.
 *
 * **Não há e-mail neste tipo**, nem poderia haver (`docs/19` decisão 8).
 */
export type PublicProfile = {
  username: string;
  name: string;
  bio: string;
  websiteUrl: string | null;
  links: ProfileLink[];
  hasAvatar: boolean;
  avatarUpdatedAt: string | null;
  skills: SkillSummary[];
  catalogs: PublicCatalog[];
};

export const fetchPublicProfile = (username: string) =>
  get<PublicProfile>(`/api/profiles/${encodeURIComponent(username)}`);

/**
 * A URL da foto, com o carimbo como cache-buster — a rota revalida a cada uso
 * (`max-age=0`), e o carimbo é o que faz a imagem nova entrar sem recarregar a
 * página. `null` quando não há foto: a página desenha o ícone genérico.
 */
export const profileAvatarUrl = (username: string, stamp: string | null): string | null =>
  stamp === null
    ? null
    : `/u/${encodeURIComponent(username)}/avatar?v=${encodeURIComponent(stamp)}`;

/** A página de um perfil público, para o crédito da ficha da skill virar link. */
export const profilePath = (username: string) => `/u/${encodeURIComponent(username)}`;

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
