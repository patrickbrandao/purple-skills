import type { Role } from './roles.js';

export type SkillSummary = {
  uuid: string;
  slug: string;
  name: string;
  description: string;
  /**
   * Interruptor global da publicação: em `false` a skill não aparece em
   * superfície nenhuma do MCP público — nem ferramentas, nem prompt, nem
   * resource — nem no site. Ver `docs/07-superficie-de-ferramentas.md` §3.3.
   */
  isPublic: boolean;
  /**
   * Por quais superfícies do MCP público a skill é oferecida: as ferramentas
   * (`search_skills`, `get_skill`, …), o *prompt* pelo slug e o *resource*
   * `skill://<slug>`. As três são ortogonais a `isPublic`: sozinhas não
   * publicam nada — quem decide a visibilidade continua sendo `isPublic`.
   *
   * `useAsSkill` nasce `true` (opt-out: a superfície de ferramentas é o
   * comportamento histórico de toda skill pública); as outras duas nascem
   * `false` (opt-in). Ver `docs/07-superficie-de-ferramentas.md` §3.1.
   */
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
  | 'key.revoke';

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
