/** Tipos compartilhados entre a API REST, o frontend e os servidores MCP. */

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

export type AuditAction = 'create' | 'update' | 'delete';
export type AuditSource = 'web-admin' | 'mcp-admin';

export type AuditEntry = {
  id: string;
  skillUuid: string | null;
  skillSlug: string | null;
  filePath: string | null;
  action: AuditAction;
  source: AuditSource;
  createdAt: string;
};
