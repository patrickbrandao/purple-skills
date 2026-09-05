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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type SkillRow = typeof skills.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
