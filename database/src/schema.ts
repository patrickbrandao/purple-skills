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

/**
 * `vector` do pgvector (`schema/020-rag.sql`), **sem dimensão fixa**: a coluna
 * serve a qualquer espaço de embedding e quem trava o tamanho de cada linha é
 * a FK composta com `rag_spaces` mais o `rag_vectors_dimensions_chk`. O driver
 * troca o vetor no formato textual `[x,y,z]`.
 */
const vector = customType<{ data: string; driverData: string }>({
  dataType: () => 'vector',
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
     * A skill precisa ser refatiada pelo RAG (`schema/020-rag.sql`). Nasce
     * `true` e é marcada pelos triggers de skill, arquivo e tag; quem limpa é
     * o indexador, ao reservar o lote. Incremento de contador não marca.
     */
    ragStale: boolean('rag_stale').notNull().default(true),
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
    // O índice da fila do indexador é **parcial** (`WHERE rag_stale`) e por
    // isso fica só no SQL: `skills_rag_stale_idx` em `schema/020-rag.sql`.
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
    /**
     * SHA-256 do conteúdo gravado, texto ou binário (`schema/020-rag.sql`).
     * Quem preenche é o trigger `files_content_sha256_trg` — coluna gerada não
     * serve, `convert_to` é STABLE. Num arquivo que cabe inteiro num texto
     * canônico, este é o mesmo hash de `rag_texts`.
     */
    contentSha256: bytea('content_sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('files_skill_uuid_idx').on(table.skillUuid),
    index('files_content_sha256_idx').on(table.contentSha256),
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
  (table) => [
    index('virtual_mcp_keys_virtual_mcp_uuid_idx').on(table.virtualMcpUuid),
    // `021`: "Chaves emitidas" da conta e a varredura do SET NULL.
    index('virtual_mcp_keys_created_by_created_idx').on(
      table.createdByUserUuid,
      table.createdAt.desc(),
    ),
  ],
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

// ------------------------------------------------------ acessos por skill ---

/**
 * Uma linha por leitura de uma skill (`docs/13-fichas-e-acessos.md`,
 * `schema/018-acessos-por-skill.sql`): o que a guia "Acessos" da skill e do
 * catálogo listam. Gravada pelo MCP público, pelo site e pelo mcp-admin; o
 * painel não grava. Toda FK é `SET NULL` e ao lado de cada uma vai a cópia
 * (slug, nome, e-mail) que fica quando o objeto some. Os catálogos por onde
 * a skill chegou ao vMCP são três arrays paralelos (mesma posição = mesmo
 * catálogo), sem FK: a listagem confere `catalogs` para devolver o uuid nulo
 * de um catálogo apagado. Nunca é podada. Os CHECKs de `kind`, `surface`,
 * `origin` e `auth`, o de paralelismo dos arrays e o índice GIN ficam só no
 * SQL.
 */
export const skillAccesses = pgTable(
  'skill_accesses',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /** Nulo depois que a skill é apagada; slug e nome abaixo são as cópias que ficam. */
    skillUuid: uuid('skill_uuid').references(() => skills.uuid, { onDelete: 'set null' }),
    skillSlug: text('skill_slug').notNull(),
    skillName: text('skill_name').notNull(),
    kind: text('kind').notNull(),
    surface: text('surface').notNull(),
    origin: text('origin').notNull(),
    auth: text('auth').notNull(),
    /** Só no MCP público; nulo no site e no mcp-admin, ou depois que o vMCP é apagado. */
    virtualMcpUuid: uuid('virtual_mcp_uuid').references(() => virtualMcps.uuid, {
      onDelete: 'set null',
    }),
    virtualMcpSlug: text('virtual_mcp_slug'),
    virtualMcpName: text('virtual_mcp_name'),
    catalogUuids: uuid('catalog_uuids').array().notNull().default(sql`'{}'::uuid[]`),
    catalogSlugs: text('catalog_slugs').array().notNull().default(sql`'{}'::text[]`),
    catalogNames: text('catalog_names').array().notNull().default(sql`'{}'::text[]`),
    /** A chave `psv_` do vMCP (`auth = 'key'`). */
    keyId: uuid('key_id').references(() => virtualMcpKeys.id, { onDelete: 'set null' }),
    keyName: text('key_name'),
    /** A chave `psk_` e a conta dona dela (`auth = 'user'`, o mcp-admin). */
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    apiKeyName: text('api_key_name'),
    userUuid: uuid('user_uuid').references(() => users.uuid, { onDelete: 'set null' }),
    userEmail: text('user_email'),
    /** O de `mcp_sessions.session_id`, sem FK: lá ele não é único. */
    sessionId: text('session_id'),
    /** Já resolvido pelo `trust proxy` do app. */
    ip: text('ip'),
    userAgent: text('user_agent'),
    clientName: text('client_name'),
    clientVersion: text('client_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('skill_accesses_skill_created_idx').on(table.skillUuid, table.createdAt),
    index('skill_accesses_catalog_uuids_idx').using('gin', table.catalogUuids),
    index('skill_accesses_virtual_mcp_created_idx').on(table.virtualMcpUuid, table.createdAt),
    index('skill_accesses_created_idx').on(table.createdAt),
    index('skill_accesses_key_id_idx').on(table.keyId),
    index('skill_accesses_api_key_id_idx').on(table.apiKeyId),
    // A guia da conta (`schema/019-acessos-por-conta.sql`), que substituiu o simples do `018`.
    index('skill_accesses_user_created_idx').on(table.userUuid, table.createdAt),
  ],
);

// -------------------------------------------------------------------- RAG ---

/**
 * Um espaço de embedding (`schema/020-rag.sql`, `tmp/RAG-GOOGLE.md` §5):
 * driver, modelo, dimensões e os **dois prefixos** do driver. A identidade é
 * a combinação dos cinco — trocar o prefixo cria outro espaço, como trocar o
 * modelo, e vetores de espaços diferentes nunca se misturam numa consulta. O
 * `UNIQUE (driver, model, dimensions, document_prefix, query_prefix)`, o
 * `UNIQUE (uuid, dimensions)` que a FK de `rag_vectors` usa e o CHECK de
 * tamanho dos prefixos ficam só no SQL.
 */
export const ragSpaces = pgTable('rag_spaces', {
  uuid: uuid('uuid').primaryKey().default(sql`uuidv7()`),
  driver: text('driver').notNull(),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  /** O que o driver põe antes do texto ao embutir um documento; vazio é válido. */
  documentPrefix: text('document_prefix').notNull(),
  /** O mesmo, para a consulta. Sem DEFAULT no banco: esquecê-lo é erro. */
  queryPrefix: text('query_prefix').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * O texto canônico, endereçado pelo próprio SHA-256 e guardado **sem** o
 * prefixo do driver — é o que permite ao mesmo texto servir a qualquer espaço
 * e a duas skills iguais compartilharem um vetor. O `rag_texts_sha256_chk`,
 * que recalcula o hash do conteúdo, fica só no SQL.
 */
export const ragTexts = pgTable(
  'rag_texts',
  {
    sha256: bytea('sha256').primaryKey(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('rag_texts_created_at_idx').on(table.createdAt)],
);

/**
 * A ocorrência: onde um texto aparece. `source: 'meta'` é o texto de
 * metadados da skill (sem caminho nem arquivo); `source: 'file'` é uma parte
 * de um arquivo. `text_sha256` **não** tem cascata de propósito: texto em uso
 * não pode ser apagado. O CHECK que amarra `source` a `relative_path`/
 * `file_id` fica só no SQL.
 */
export const ragSkillTexts = pgTable(
  'rag_skill_texts',
  {
    skillUuid: uuid('skill_uuid')
      .notNull()
      .references(() => skills.uuid, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    relativePath: text('relative_path').notNull().default(''),
    part: integer('part').notNull().default(0),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'cascade' }),
    textSha256: bytea('text_sha256')
      .notNull()
      .references(() => ragTexts.sha256),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.skillUuid, table.source, table.relativePath, table.part] }),
    index('rag_skill_texts_sha256_idx').on(table.textSha256),
    index('rag_skill_texts_file_idx').on(table.fileId),
  ],
);

/**
 * O vetor de um texto num espaço. `dimensions` é copiada do espaço pela FK
 * composta `(space_uuid, dimensions) → rag_spaces (uuid, dimensions)` e o
 * `rag_vectors_dimensions_chk` confere o vetor contra ela: as duas ficam só
 * no SQL, como a FK composta, que o Drizzle não declara aqui. A busca é
 * exata, sem índice — o HNSW do pgvector para em 2000 dimensões.
 */
export const ragVectors = pgTable(
  'rag_vectors',
  {
    spaceUuid: uuid('space_uuid').notNull(),
    dimensions: integer('dimensions').notNull(),
    textSha256: bytea('text_sha256')
      .notNull()
      .references(() => ragTexts.sha256, { onDelete: 'cascade' }),
    embedding: vector('embedding').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceUuid, table.textSha256] }),
    index('rag_vectors_text_idx').on(table.textSha256),
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
export type SkillAccessRow = typeof skillAccesses.$inferSelect;
export type RagSpaceRow = typeof ragSpaces.$inferSelect;
export type RagTextRow = typeof ragTexts.$inferSelect;
export type RagSkillTextRow = typeof ragSkillTexts.$inferSelect;
export type RagVectorRow = typeof ragVectors.$inferSelect;
