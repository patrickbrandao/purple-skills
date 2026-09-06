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
  unique,
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
    isPublic: boolean('is_public').notNull().default(false),
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
    unique('files_skill_path_uniq').on(table.skillUuid, table.relativePath),
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

export type SkillRow = typeof skills.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ResetTokenRow = typeof resetTokens.$inferSelect;
