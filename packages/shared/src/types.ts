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
  skillCount: number;
  /** Quantas das vinculadas são privadas — o painel avisa quando `isOpen`. */
  privateSkillCount: number;
  activeKeyCount: number;
  /** É o vMCP que responde em `/mcp` (`settings.default_virtual_mcp`). */
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Uma skill vista de dentro do MCP virtual: as flags e os contadores são do vínculo. */
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

/** Entrada de `setVirtualMcpSkills`: a escolha das três superfícies é obrigatória. */
export type VirtualMcpSkillInput = {
  slug: string;
  asSkill: boolean;
  asPrompt: boolean;
  asResource: boolean;
};

/** Referência curta — o selo "publicada em" da página da skill. */
export type VirtualMcpRef = {
  uuid: string;
  slug: string;
  name: string;
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
