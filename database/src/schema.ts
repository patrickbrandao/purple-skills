/**
 * Schema Drizzle usado para **tipagem** e como query builder.
 *
 * A fonte de verdade do banco são os arquivos SQL de `database/schema/`: os
 * índices trigram e por expressão, os CHECKs de `files` e `audit_log`, as
 * funções e os triggers de busca **não** estão declarados aqui. Não gere
 * migrations a partir deste arquivo (`drizzle-kit generate`/`push`) — o diff
 * removeria esses objetos.
 */
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { VirtualMcpLayout } from '@purple-skills/shared';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

export const skills = pgTable(
  'skills',
  {
    uuid: uuid('uuid').primaryKey().default(sql`uuidv7()`),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /**
     * Um emoji ou a URL http(s) de uma imagem (`schema/013-skill-icon.sql`).
     * A regra é `normalizeSkillIcon` de shared; o banco só limita o tamanho.
     * Nulo cai no monograma do painel.
     */
    icon: text('icon'),
    /**
     * Desligada **globalmente** (`schema/016-catalogos.sql`): some de todo
     * vMCP, por vínculo direto ou por catálogo, e do site, sem perder vínculo
     * nenhum. Só o painel e o mcp-admin (visibilidade `'all'`) a enxergam.
     */
    isActive: boolean('is_active').notNull().default(true),
    /**
     * Quem pode ler sem concessão: qualquer conta logada e o site anônimo
     * (`schema/017-acesso-granular.sql`, `docs/12` decisão 4). **Não** decide
     * exposição no MCP — a skill continua flutuante e só é exibida num
     * servidor onde está vinculada, direto (`virtual_mcp_skills`) ou por
     * catálogo (`virtual_mcp_catalogs`); ver `schema/012-skills-flutuantes.sql`.
     */
    isPublic: boolean('is_public').notNull().default(false),
    viewCount: bigint('view_count', { mode: 'number' }).notNull().default(0),
    downloadCount: bigint('download_count', { mode: 'number' }).notNull().default(0),
    searchVector: tsvector('search_vector'),
    /** Informativo (`docs/05-accounts-and-roles.md` §2.1): não autoriza nada. */
    createdByUserUuid: uuid('created_by_user_uuid'),
    /**
     * O dono (`docs/12` decisão 8): apaga, transfere e concede. Nulo é órfã —
     * só o admin —, o que acontece quando a conta é removida (`SET NULL`) ou
     * quando quem criou não era conta (bootstrap, token global, seed).
     */
    ownerUserUuid: uuid('owner_user_uuid').references(() => users.uuid, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('skills_search_vector_idx').using('gin', table.searchVector),
    index('skills_owner_user_uuid_idx').on(table.ownerUserUuid),
  ],
);

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    skillUuid: uuid('skill_uuid')
      .notNull()
      .references(() => skills.uuid, { onDelete: 'cascade' }),
    relativePath: text('relative_path').notNull(),
    textContent: text('text_content'),
    binaryContent: bytea('binary_content'),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('files_skill_uuid_idx').on(table.skillUuid),
    // A unicidade de `relative_path` é case-insensitive e não cabe aqui: vive na
    // migration 003-case-insensitive-file-paths.sql, no índice funcional
    // `files_skill_path_lower_uniq` sobre (skill_uuid, lower(relative_path)).
    // A constraint antiga `files_skill_path_uniq`, que comparava byte a byte,
    // foi derrubada por ela — declará-la aqui faria acreditar que ainda vale.
  ],
);

export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const skillTags = pgTable(
  'skill_tags',
  {
    skillUuid: uuid('skill_uuid')
      .notNull()
      .references(() => skills.uuid, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.skillUuid, table.tagId] })],
);

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  skillUuid: uuid('skill_uuid'),
  skillSlug: text('skill_slug'),
  filePath: text('file_path'),
  action: text('action').notNull(),
  source: text('source').notNull(),
  previousContent: text('previous_content'),
  /** Nulo quando o ator não é uma conta (`token-global`, bootstrap). */
  actorUserUuid: uuid('actor_user_uuid'),
  actorLabel: text('actor_label'),
  /** Alvo de um evento de conta — ver `schema/004-contas.sql`. */
  targetLabel: text('target_label'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ----------------------------------------------------------------- contas ---

// Os índices únicos de `users` (`users_email_lower_uniq` e o parcial
// `users_oidc_uniq`) são por expressão e ficam só no SQL — aqui é tipagem.
export const users = pgTable('users', {
  uuid: uuid('uuid').primaryKey().default(sql`uuidv7()`),
  email: text('email').notNull(),
  name: text('name').notNull(),
  /** Nulo numa conta que só entra por OIDC. */
  passwordHash: text('password_hash'),
  role: text('role').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  /** Incrementar invalida todo cookie já emitido para a conta. */
  tokenVersion: integer('token_version').notNull().default(0),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  oidcIssuer: text('oidc_issuer'),
  oidcSubject: text('oidc_subject'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userUuid: uuid('user_uuid')
      .notNull()
      .references(() => users.uuid, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Público e indexado: é por ele que a autenticação encontra a linha. */
    prefix: text('prefix').notNull().unique(),
    keyHash: text('key_hash').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('api_keys_user_uuid_idx').on(table.userUuid)],
);

export const resetTokens = pgTable(
  'reset_tokens',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userUuid: uuid('user_uuid')
      .notNull()
      .references(() => users.uuid, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('reset_tokens_user_uuid_idx').on(table.userUuid)],
);

// ------------------------------------------------------------ MCP virtual ---

/**
 * Servidor MCP de leitura com recorte próprio (`docs/08-mcp-virtual.md`). É a
 * primeira entidade com ownership: `ownerUserUuid` nulo é órfão (só o admin
 * gerencia) ou criado pela sessão de bootstrap.
 */
export const virtualMcps = pgTable(
  'virtual_mcps',
  {
    uuid: uuid('uuid').primaryKey().default(sql`uuidv7()`),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Desligado: tudo sob `/virtual/<slug>` responde 404; vínculos e chaves ficam. */
    isActive: boolean('is_active').notNull().default(true),
    /** Aberto: sem chave. Com skill privada dentro, é publicação de fato. */
    isOpen: boolean('is_open').notNull().default(false),
    ownerUserUuid: uuid('owner_user_uuid').references(() => users.uuid, { onDelete: 'set null' }),
    /**
     * Posições dos nós fixos do canvas do painel (`server`, `internet`), cada
     * chave opcional; `{}` é auto-layout (`schema/014-canvas-do-vmcp.sql`). O
     * CHECK que exige um objeto fica só no SQL.
     */
    layout: jsonb('layout').$type<VirtualMcpLayout>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('virtual_mcps_owner_user_uuid_idx').on(table.ownerUserUuid)],
);

/**
 * Vínculo skill ↔ MCP virtual. As três flags são **do vínculo** e sem default:
 * as `use_as_*` da skill valem só para o MCP principal. Os contadores também
 * são do vínculo; o global da skill continua somando.
 */
export const virtualMcpSkills = pgTable(
  'virtual_mcp_skills',
  {
    virtualMcpUuid: uuid('virtual_mcp_uuid')
      .notNull()
      .references(() => virtualMcps.uuid, { onDelete: 'cascade' }),
    skillUuid: uuid('skill_uuid')
      .notNull()
      .references(() => skills.uuid, { onDelete: 'cascade' }),
    asSkill: boolean('as_skill').notNull(),
    asPrompt: boolean('as_prompt').notNull(),
    asResource: boolean('as_resource').notNull(),
    viewCount: bigint('view_count', { mode: 'number' }).notNull().default(0),
    downloadCount: bigint('download_count', { mode: 'number' }).notNull().default(0),
    /**
     * Posição do nó da skill no canvas **deste** vMCP, em pixels; as duas nulas
     * é auto-layout (`schema/014-canvas-do-vmcp.sql`). O CHECK que exige as
     * duas juntas fica só no SQL.
     */
    posX: integer('pos_x'),
    posY: integer('pos_y'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.virtualMcpUuid, table.skillUuid] }),
    index('virtual_mcp_skills_skill_uuid_idx').on(table.skillUuid),
  ],
);

/** Chaves `psv_` — pertencem ao servidor, não a um usuário. Mesmo formato de `api_keys`. */
export const virtualMcpKeys = pgTable(
  'virtual_mcp_keys',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    virtualMcpUuid: uuid('virtual_mcp_uuid')
      .notNull()
      .references(() => virtualMcps.uuid, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Público e indexado: é por ele que a autenticação encontra a linha. */
    prefix: text('prefix').notNull().unique(),
    keyHash: text('key_hash').notNull(),
    /** Informativo: quem emitiu. Sobrevive à remoção da conta. */
    createdByUserUuid: uuid('created_by_user_uuid').references(() => users.uuid, {
      onDelete: 'set null',
    }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('virtual_mcp_keys_virtual_mcp_uuid_idx').on(table.virtualMcpUuid)],
);

// -------------------------------------------------------------- catálogos ---

/**
 * Um grupo de skills com dono (`docs/11-catalogos.md`, `schema/016-catalogos.sql`).
 * Vinculado a um vMCP, entrega todos os membros ativos de uma vez, pelas
 * portas do vínculo. Mesma regra de dono do vMCP: nulo é órfão (só o admin)
 * ou criado pela sessão de bootstrap. Os contadores são **do catálogo**:
 * somam a cada acesso a uma skill que chegou ao vMCP por ele.
 */
export const catalogs = pgTable(
  'catalogs',
  {
    uuid: uuid('uuid').primaryKey().default(sql`uuidv7()`),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Desligado: deixa de contribuir para todo vMCP vinculado; membros e vínculos ficam. */
    isActive: boolean('is_active').notNull().default(true),
    /**
     * Legível por qualquer conta e pelo site, que lista os membros ativos —
     * todos, mesmo os privados (`docs/12` decisões 4 e 5).
     */
    isPublic: boolean('is_public').notNull().default(false),
    ownerUserUuid: uuid('owner_user_uuid').references(() => users.uuid, { onDelete: 'set null' }),
    viewCount: bigint('view_count', { mode: 'number' }).notNull().default(0),
    downloadCount: bigint('download_count', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('catalogs_owner_user_uuid_idx').on(table.ownerUserUuid)],
);

/**
 * A participação de uma skill num catálogo. `isActive` desativa a skill
 * **neste** catálogo sem removê-la — diferente de `skills.isActive`, que vale
 * em tudo. Sem portas: quem as decide é o vínculo do catálogo com o vMCP.
 */
export const catalogSkills = pgTable(
  'catalog_skills',
  {
    catalogUuid: uuid('catalog_uuid')
      .notNull()
      .references(() => catalogs.uuid, { onDelete: 'cascade' }),
    skillUuid: uuid('skill_uuid')
      .notNull()
      .references(() => skills.uuid, { onDelete: 'cascade' }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.catalogUuid, table.skillUuid] }),
    index('catalog_skills_skill_uuid_idx').on(table.skillUuid),
  ],
);

/**
 * Vínculo catálogo ↔ MCP virtual, muitos-para-muitos. As três portas são do
 * vínculo, sem default, e valem para todo membro do catálogo; o vínculo
 * direto da skill (`virtualMcpSkills`), quando existe, sobrescreve. A posição
 * é o nó do catálogo no canvas **deste** vMCP (CHECK de par só no SQL).
 */
export const virtualMcpCatalogs = pgTable(
  'virtual_mcp_catalogs',
  {
    virtualMcpUuid: uuid('virtual_mcp_uuid')
      .notNull()
      .references(() => virtualMcps.uuid, { onDelete: 'cascade' }),
    catalogUuid: uuid('catalog_uuid')
      .notNull()
      .references(() => catalogs.uuid, { onDelete: 'cascade' }),
    asSkill: boolean('as_skill').notNull(),
    asPrompt: boolean('as_prompt').notNull(),
    asResource: boolean('as_resource').notNull(),
    posX: integer('pos_x'),
    posY: integer('pos_y'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.virtualMcpUuid, table.catalogUuid] }),
    index('virtual_mcp_catalogs_catalog_uuid_idx').on(table.catalogUuid),
  ],
);

// ------------------------------------------------------------- concessões ---

/**
 * As concessões por objeto (`docs/12-acesso-granular.md`,
 * `schema/017-acesso-granular.sql`): uma linha por par (objeto, conta) com o
 * nível cumulativo (`view` < `edit` < `manage`; o CHECK fica só no SQL).
 * Dono e admin não têm linha — o acesso deles é implícito. FK real nos dois
 * lados, com CASCADE: apagar o objeto ou a conta leva a concessão.
 * `grantedByUserUuid` é informativo e sobrevive à remoção de quem concedeu.
 */
export const skillGrants = pgTable(
  'skill_grants',
  {
    skillUuid: uuid('skill_uuid')
      .notNull()
      .references(() => skills.uuid, { onDelete: 'cascade' }),
    userUuid: uuid('user_uuid')
      .notNull()
      .references(() => users.uuid, { onDelete: 'cascade' }),
    level: text('level').notNull(),
    grantedByUserUuid: uuid('granted_by_user_uuid').references(() => users.uuid, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.skillUuid, table.userUuid] }),
    index('skill_grants_user_uuid_idx').on(table.userUuid),
  ],
);

export const catalogGrants = pgTable(
  'catalog_grants',
  {
    catalogUuid: uuid('catalog_uuid')
      .notNull()
      .references(() => catalogs.uuid, { onDelete: 'cascade' }),
    userUuid: uuid('user_uuid')
      .notNull()
      .references(() => users.uuid, { onDelete: 'cascade' }),
    level: text('level').notNull(),
    grantedByUserUuid: uuid('granted_by_user_uuid').references(() => users.uuid, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.catalogUuid, table.userUuid] }),
    index('catalog_grants_user_uuid_idx').on(table.userUuid),
  ],
);

export const virtualMcpGrants = pgTable(
  'virtual_mcp_grants',
  {
    virtualMcpUuid: uuid('virtual_mcp_uuid')
      .notNull()
      .references(() => virtualMcps.uuid, { onDelete: 'cascade' }),
    userUuid: uuid('user_uuid')
      .notNull()
      .references(() => users.uuid, { onDelete: 'cascade' }),
    level: text('level').notNull(),
    grantedByUserUuid: uuid('granted_by_user_uuid').references(() => users.uuid, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.virtualMcpUuid, table.userUuid] }),
    index('virtual_mcp_grants_user_uuid_idx').on(table.userUuid),
  ],
);

// --------------------------------------------------------------- settings ---

/**
 * Configuração da instalação, chave-valor
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`). A chave `default_virtual_mcp`
 * guarda o uuid do vMCP que responde em `/mcp`, como texto e sem FK de
 * propósito: um vMCP apagado deixa o valor pendurado, e é assim que o servidor
 * distingue "nenhum padrão" de "o padrão foi removido".
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ----------------------------------------------------------- sessões MCP ---

/**
 * Uma linha por cliente conectado a um vMCP (`docs/10-admin-canvas-e-sessoes.md`,
 * `schema/015-mcp-sessions.sql`). "Online" não é coluna: é `ended_at IS NULL`
 * com `last_seen_at` dentro da janela que o chamador informa. Nunca é podada.
 * Os CHECKs de `transport`, `mount`, `auth` e `end_reason` e os índices
 * parciais sobre as abertas ficam só no SQL.
 */
export const mcpSessions = pgTable(
  'mcp_sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** `mcp-session-id`, o `sessionId` do SSE ou a chave sintética do stateless. Não é única. */
    sessionId: text('session_id').notNull(),
    transport: text('transport').notNull(),
    /** Por onde chegou: `root` (`/mcp`) ou `virtual` (`/virtual/<slug>`). */
    mount: text('mount').notNull(),
    /** Nulo depois que o vMCP é apagado; o slug abaixo é a cópia que fica. */
    virtualMcpUuid: uuid('virtual_mcp_uuid').references(() => virtualMcps.uuid, {
      onDelete: 'set null',
    }),
    virtualMcpSlug: text('virtual_mcp_slug').notNull(),
    auth: text('auth').notNull(),
    keyId: uuid('key_id').references(() => virtualMcpKeys.id, { onDelete: 'set null' }),
    /** Já resolvido pelo `trust proxy` do app. */
    ip: text('ip').notNull(),
    userAgent: text('user_agent'),
    clientName: text('client_name'),
    clientVersion: text('client_version'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Fim real (`closed`, `shutdown`) ou presumido pela varredura (`timeout`). */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
    requestCount: integer('request_count').notNull().default(0),
  },
  (table) => [
    index('mcp_sessions_virtual_mcp_last_seen_idx').on(table.virtualMcpUuid, table.lastSeenAt),
    index('mcp_sessions_last_seen_idx').on(table.lastSeenAt),
    index('mcp_sessions_key_id_idx').on(table.keyId),
  ],
);

export type SkillRow = typeof skills.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ResetTokenRow = typeof resetTokens.$inferSelect;
export type VirtualMcpRow = typeof virtualMcps.$inferSelect;
export type VirtualMcpSkillRow = typeof virtualMcpSkills.$inferSelect;
export type VirtualMcpKeyRow = typeof virtualMcpKeys.$inferSelect;
export type CatalogRow = typeof catalogs.$inferSelect;
export type CatalogSkillRow = typeof catalogSkills.$inferSelect;
export type VirtualMcpCatalogRow = typeof virtualMcpCatalogs.$inferSelect;
export type SkillGrantRow = typeof skillGrants.$inferSelect;
export type CatalogGrantRow = typeof catalogGrants.$inferSelect;
export type VirtualMcpGrantRow = typeof virtualMcpGrants.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
export type McpSessionRow = typeof mcpSessions.$inferSelect;
