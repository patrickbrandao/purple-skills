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
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
    /** Interruptor global: em `false` não há publicação em superfície alguma. */
    isPublic: boolean('is_public').notNull().default(false),
    // Por quais superfícies do MCP público a skill sai: as ferramentas, o
    // prompt (pelo slug) e o resource `skill://<slug>`. Ortogonais entre si e a
    // `is_public` — sozinhas não publicam nada. Ver `schema/007-publicacao-mcp.sql`
    // e `schema/008-publicacao-como-skill.sql`.
    /** Opt-out: nasce `true` porque as ferramentas são o padrão de toda skill pública. */
    useAsSkill: boolean('use_as_skill').notNull().default(true),
    useAsPrompt: boolean('use_as_prompt').notNull().default(false),
    useAsResource: boolean('use_as_resource').notNull().default(false),
    viewCount: bigint('view_count', { mode: 'number' }).notNull().default(0),
    downloadCount: bigint('download_count', { mode: 'number' }).notNull().default(0),
    searchVector: tsvector('search_vector'),
    /** Informativo (`docs/05-accounts-and-roles.md` §2.1): não autoriza nada. */
    createdByUserUuid: uuid('created_by_user_uuid'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('skills_search_vector_idx').using('gin', table.searchVector)],
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
export type SettingRow = typeof settings.$inferSelect;
