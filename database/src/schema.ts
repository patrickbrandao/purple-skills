/**
 * Schema Drizzle usado para **tipagem** e como query builder.
 *
 * A fonte de verdade do banco são os arquivos SQL de `database/schema/`. Não
 * gere migrations a partir deste arquivo (`drizzle-kit generate`/`push`): o que
 * o DSL do Drizzle não expressa — índice por expressão, índice parcial, os
 * CHECKs, as funções e os triggers de busca e de RAG — **não** está declarado
 * aqui, e o diff proporia remover esses objetos.
 *
 * O que o DSL expressa fielmente **está**: coluna, tipo, NOT NULL, DEFAULT,
 * chave primária, UNIQUE, chave estrangeira com a ação de remoção e índice por
 * coluna (com a classe de operadores e o DESC). É o que
 * `schema.integration.test.ts` confere, objeto a objeto, contra um banco
 * migrado do zero: uma migration que acrescente um desses sem refletir aqui
 * derruba o teste. A lista do que fica **só** no SQL, com o motivo de cada
 * item, mora nesse teste.
 */
import {
  bigint,
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ProfileLink, VirtualMcpLayout } from '@purple-skills/shared';

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
    slug: text('slug').notNull().unique('skills_slug_key'),
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
    /**
     * Informativo (`docs/05-accounts-and-roles.md` §2.1): não autoriza nada. A
     * FK é `SET NULL` (`schema/004-contas.sql`): remover a conta não apaga a
     * skill dela, só esquece quem a criou.
     */
    createdByUserUuid: uuid('created_by_user_uuid').references(() => users.uuid, {
      onDelete: 'set null',
    }),
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
    // `004`: chave estrangeira sem índice faz da remoção de uma conta uma
    // varredura inteira desta tabela. Nenhuma query filtra por esta coluna.
    index('skills_created_by_idx').on(table.createdByUserUuid),
    // Os quatro ramos do `OR` da busca, juntos de propósito: falta um e o
    // `BitmapOr` não se forma, a varredura volta inteira. `name` é do `001`;
    // `description` e `slug` são do `022-busca-por-substring.sql`.
    index('skills_name_trgm_idx').using('gin', table.name.op('gin_trgm_ops')),
    index('skills_description_trgm_idx').using('gin', table.description.op('gin_trgm_ops')),
    index('skills_slug_trgm_idx').using('gin', table.slug.op('gin_trgm_ops')),
    // Dois ficam só no SQL, por não caberem no DSL: o da fila do indexador é
    // **parcial** (`skills_rag_stale_idx`, `WHERE rag_stale`, `020`) e o da
    // pontuação é por **expressão** (`skills_score_idx`,
    // `(view_count + download_count) DESC`, `012`). Por referenciar os dois
    // contadores, ele faz de todo incremento um UPDATE não-HOT — medido e
    // mantido de propósito (`tasks/055`): ver "Custo de escrita do contador
    // da skill" no README antes de criar outro índice sobre essas colunas.
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
  name: text('name').notNull().unique('tags_name_key'),
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
  (table) => [
    primaryKey({ name: 'skill_tags_pkey', columns: [table.skillUuid, table.tagId] }),
    // A PK cobre a busca por skill; este é o caminho inverso, as skills de uma
    // tag (`001`).
    index('skill_tags_tag_id_idx').on(table.tagId),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    /**
     * Sem FK de propósito (`001`): a trilha sobrevive à remoção da skill, e o
     * `skill_slug` ao lado é a cópia que fica.
     */
    skillUuid: uuid('skill_uuid'),
    skillSlug: text('skill_slug'),
    filePath: text('file_path'),
    action: text('action').notNull(),
    source: text('source').notNull(),
    previousContent: text('previous_content'),
    /**
     * Nulo quando o ator não é uma conta (`token-global`, bootstrap) — e
     * também depois de a conta ser removida, porque a FK é `SET NULL`
     * (`schema/004-contas.sql`): a trilha não fica com uuid pendurado nem
     * impede a remoção. Quem sempre existe é o `actor_label`.
     */
    actorUserUuid: uuid('actor_user_uuid').references(() => users.uuid, {
      onDelete: 'set null',
    }),
    actorLabel: text('actor_label'),
    /** Alvo de um evento de conta — ver `schema/004-contas.sql`. */
    targetLabel: text('target_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A página da trilha é sempre por data decrescente (`001`).
    index('audit_log_created_at_idx').on(table.createdAt.desc()),
    index('audit_log_skill_uuid_idx').on(table.skillUuid),
    // `004`: como o de `skills`, é o índice do `SET NULL` — a trilha é filtrada
    // por `actor_label`, não por este uuid.
    index('audit_log_actor_user_uuid_idx').on(table.actorUserUuid),
    // As quatro colunas do `q` de `listAuditPage` (`022-busca-por-substring.sql`):
    // `ILIKE '%termo%'` só usa índice de trigrama, e num `OR` só há `BitmapOr`
    // se **todos** os ramos tiverem um.
    index('audit_log_skill_slug_trgm_idx').using('gin', table.skillSlug.op('gin_trgm_ops')),
    index('audit_log_file_path_trgm_idx').using('gin', table.filePath.op('gin_trgm_ops')),
    index('audit_log_actor_label_trgm_idx').using('gin', table.actorLabel.op('gin_trgm_ops')),
    index('audit_log_target_label_trgm_idx').using('gin', table.targetLabel.op('gin_trgm_ops')),
  ],
);

// ----------------------------------------------------------------- contas ---

// Os três índices únicos de `users` (`users_email_lower_uniq`,
// `users_username_lower_uniq` e o parcial `users_oidc_uniq`) são por expressão
// e ficam só no SQL — aqui é tipagem.
export const users = pgTable('users', {
  uuid: uuid('uuid').primaryKey().default(sql`uuidv7()`),
  /**
   * O identificador **público** da conta (`033`, `docs/19-username.md`): dono,
   * linha da ACL, quem leu na guia Acessos, busca de contas, trilha e ficha
   * pública do site. Único por `lower(username)`. O e-mail ao lado voltou a
   * ser privado — entrar, recuperar a senha e casar com a identidade OIDC.
   */
  username: text('username').notNull(),
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

/**
 * O livro de usernames (`schema/033-username.sql`, `docs/19` decisão 6): uma
 * linha por nome que esta instalação já gastou.
 *
 * **Username abandonado nunca volta.** Sem esta tabela o `@joao` de uma trilha
 * de 2025 poderia ser outra pessoa em 2026, e `audit_log` — que congela o
 * rótulo em texto justamente para sobreviver à remoção da conta — passaria a
 * apontar para quem não fez nada. Tomar um nome é **inserir aqui**: a PK em
 * `lower(username)` é o que torna a reserva atômica e permanente.
 *
 * `userUuid` é anulável de propósito: a conta pode ser apagada e a reserva tem
 * de sobreviver a isso (o mesmo motivo de `audit_log.actor_label` existir).
 * `releasedAt` preenchido diz "não é de ninguém e não volta a ser" — é o que
 * a troca de username carimba no nome antigo.
 */
export const usernames = pgTable(
  'usernames',
  {
    usernameLower: text('username_lower').primaryKey(),
    userUuid: uuid('user_uuid').references(() => users.uuid, { onDelete: 'set null' }),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  // Chave estrangeira sem índice transforma a remoção de uma conta num seq
  // scan da tabela referenciada (a mesma razão de `skills_created_by_idx`).
  (table) => [index('usernames_user_uuid_idx').on(table.userUuid)],
);

/**
 * O perfil de uma conta (`schema/034-perfil.sql`, `docs/20-perfil.md`): a
 * parte editável do "quem é a pessoa por trás do `@username`".
 *
 * A linha **nasce no primeiro salvamento**, não com a conta: quem nunca abriu
 * a tela não tem perfil, e toda leitura trata a ausência como o perfil vazio e
 * privado. `isPublic` é opt-in e decide o que sai para o **anônimo** — no
 * painel, entre contas logadas, a foto aparece de todo jeito.
 *
 * `ON DELETE CASCADE` porque o perfil é *da* pessoa, ao contrário do que ela
 * publicou (skill, catálogo, vMCP), que fica órfão pelo `SET NULL` do `017`.
 *
 * Os três CHECKs (teto da bio, teto do site, `jsonb_typeof` + cardinalidade dos
 * links) ficam só no SQL. O `user_profiles_public_idx` também: é **parcial**.
 */
export const userProfiles = pgTable('user_profiles', {
  userUuid: uuid('user_uuid')
    .primaryKey()
    .references(() => users.uuid, { onDelete: 'cascade' }),
  /** `''` é "sem bio": os dois seriam o mesmo estado com dois valores. */
  bio: text('bio').notNull().default(''),
  websiteUrl: text('website_url'),
  /** Até 8 `{ label, url }` — JSONB como `virtualMcps.layout`, não é padrão novo. */
  links: jsonb('links').$type<ProfileLink[]>().notNull().default(sql`'[]'::jsonb`),
  isPublic: boolean('is_public').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A foto da conta (`schema/034-perfil.sql`), em tabela separada **de propósito**.
 *
 * Os bytes não podem viajar junto com a leitura do perfil: a página
 * `/u/<username>` lê o perfil e a ficha de skill lê o dono, e uma coluna
 * `bytea` na mesma linha faria toda leitura arrastar até 512 KB para
 * descartá-los. É a mesma razão de `files.binaryContent` (`001`) morar na linha
 * do arquivo e não na da skill.
 *
 * `sha256` existe para o **ETag** da rota que serve a imagem: é o que permite
 * revalidar com 304 sem cache longo — e cache longo é o que deixaria um avatar
 * visível depois de o perfil virar privado. O CHECK que o amarra aos bytes, o
 * da lista de mimes e o do teto de 512 KB ficam só no SQL.
 */
export const userAvatars = pgTable('user_avatars', {
  userUuid: uuid('user_uuid')
    .primaryKey()
    .references(() => users.uuid, { onDelete: 'cascade' }),
  bytes: bytea('bytes').notNull(),
  mime: text('mime').notNull(),
  sha256: bytea('sha256').notNull(),
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
    prefix: text('prefix').notNull().unique('api_keys_prefix_key'),
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
    tokenHash: text('token_hash').notNull().unique('reset_tokens_token_hash_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Preenchido = este link redefiniu a senha. É o que a auditoria conta. */
    usedAt: timestamp('used_at', { withTimezone: true }),
    /**
     * Preenchido = o link estava vivo e foi fechado **sem** uso, por um pedido
     * novo ou pela troca da senha (`schema/023-links-de-reset-substituidos.sql`).
     * Exclusivo com `usedAt` (`reset_tokens_estado_chk`); os dois nulos é link
     * em aberto — vivo, ou morto por prazo.
     */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
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
    slug: text('slug').notNull().unique('virtual_mcps_slug_key'),
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
    primaryKey({
      name: 'virtual_mcp_skills_pkey',
      columns: [table.virtualMcpUuid, table.skillUuid],
    }),
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
    prefix: text('prefix').notNull().unique('virtual_mcp_keys_prefix_key'),
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
    slug: text('slug').notNull().unique('catalogs_slug_key'),
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
    primaryKey({ name: 'catalog_skills_pkey', columns: [table.catalogUuid, table.skillUuid] }),
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
    primaryKey({
      name: 'virtual_mcp_catalogs_pkey',
      columns: [table.virtualMcpUuid, table.catalogUuid],
    }),
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
    primaryKey({ name: 'skill_grants_pkey', columns: [table.skillUuid, table.userUuid] }),
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
    primaryKey({ name: 'catalog_grants_pkey', columns: [table.catalogUuid, table.userUuid] }),
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
    primaryKey({
      name: 'virtual_mcp_grants_pkey',
      columns: [table.virtualMcpUuid, table.userUuid],
    }),
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
    // A lista do painel, com e sem filtro por servidor, é por atividade
    // decrescente: o `DESC` é do índice (`015`).
    index('mcp_sessions_virtual_mcp_last_seen_idx').on(
      table.virtualMcpUuid,
      table.lastSeenAt.desc(),
    ),
    index('mcp_sessions_last_seen_idx').on(table.lastSeenAt.desc()),
    index('mcp_sessions_key_id_idx').on(table.keyId),
    // A tela de Atividade (`schema/032-atividade.sql`): a série do heatmap
    // conta sessões **abertas** no dia, e o relatório as **encerradas** nele.
    index('mcp_sessions_started_at_idx').on(table.startedAt.desc()),
    index('mcp_sessions_ended_at_idx').on(table.endedAt.desc()),
  ],
);

// -------------------------------------------------------- chamadas do MCP ---

/**
 * Contador de chamadas JSON-RPC do MCP público, por balde de 15 minutos
 * (`docs/18-atividade.md`, `schema/032-atividade.sql`). É **contador, não
 * registro**: a menor unidade é "quantas vezes", e nenhuma coluna guarda nome
 * de tool, argumento, IP, e-mail ou sessão.
 *
 * A PK é `(bucket, virtual_mcp_slug, transport, method)` — o slug, e não o
 * uuid, porque `virtual_mcp_uuid` é `SET NULL` e nulo não fecha chave: depois
 * que o vMCP some, o UPSERT passaria a inserir linha nova a cada flush em vez
 * de somar. `family` é derivada de `method` (`mcpCallFamily` de shared) e
 * gravada junto, para o relatório agrupar sem reimplementar a regra em SQL.
 * Os CHECKs de `transport` e `family` ficam só no SQL; o teto de `method` é
 * saneamento de `bumpMcpCallCounters`, não CHECK. Nunca é podada.
 */
export const mcpCallCounters = pgTable(
  'mcp_call_counters',
  {
    /** Início do balde de `MCP_CALL_BUCKET_MS`; quem o calcula é quem atendeu a chamada. */
    bucket: timestamp('bucket', { withTimezone: true }).notNull(),
    /** Nulo depois que o vMCP é apagado; o slug abaixo é a cópia que fica. */
    virtualMcpUuid: uuid('virtual_mcp_uuid').references(() => virtualMcps.uuid, {
      onDelete: 'set null',
    }),
    virtualMcpSlug: text('virtual_mcp_slug').notNull(),
    transport: text('transport').notNull(),
    /** O método JSON-RPC cru, já limpo e cortado em `MCP_CALL_METHOD_MAX`. */
    method: text('method').notNull(),
    family: text('family').notNull(),
    calls: bigint('calls', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    primaryKey({
      name: 'mcp_call_counters_pkey',
      columns: [table.bucket, table.virtualMcpSlug, table.transport, table.method],
    }),
    // A faixa do heatmap e a do relatório do dia; o `DESC` é do índice (`032`).
    index('mcp_call_counters_bucket_idx').on(table.bucket.desc()),
    // Só a varredura do SET NULL: a PK começa por `bucket` e não acha as
    // linhas de um servidor.
    index('mcp_call_counters_virtual_mcp_idx').on(table.virtualMcpUuid),
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
    /**
     * A cópia que sobrevive à remoção da conta. Era `user_email` até o `033`,
     * que a converteu linha a linha e apagou a coluna: a guia Acessos é de
     * `manage`, não de admin, e entregava o endereço de quem leu a qualquer
     * dono de skill. `conta removida` é o que o `033` gravou onde a conta já
     * não existia; nulo é leitura **sem conta** (site anônimo, vMCP aberto).
     */
    userUsername: text('user_username'),
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
    // Toda guia de acessos é por data decrescente: o `DESC` é do índice.
    index('skill_accesses_skill_created_idx').on(table.skillUuid, table.createdAt.desc()),
    index('skill_accesses_catalog_uuids_idx').using('gin', table.catalogUuids),
    index('skill_accesses_virtual_mcp_created_idx').on(
      table.virtualMcpUuid,
      table.createdAt.desc(),
    ),
    index('skill_accesses_created_idx').on(table.createdAt.desc()),
    index('skill_accesses_key_id_idx').on(table.keyId),
    index('skill_accesses_api_key_id_idx').on(table.apiKeyId),
    // A guia da conta (`schema/019-acessos-por-conta.sql`), que substituiu o simples do `018`.
    index('skill_accesses_user_created_idx').on(table.userUuid, table.createdAt.desc()),
    // As seis colunas do `q` da guia (`schema/022-busca-por-substring.sql`):
    // `ILIKE '%termo%'` só usa índice de trigrama, e num `OR` só há
    // `BitmapOr` se **todos** os ramos tiverem um.
    index('skill_accesses_user_username_trgm_idx').using(
      'gin',
      table.userUsername.op('gin_trgm_ops'),
    ),
    index('skill_accesses_api_key_name_trgm_idx').using(
      'gin',
      table.apiKeyName.op('gin_trgm_ops'),
    ),
    index('skill_accesses_key_name_trgm_idx').using('gin', table.keyName.op('gin_trgm_ops')),
    index('skill_accesses_ip_trgm_idx').using('gin', table.ip.op('gin_trgm_ops')),
    index('skill_accesses_client_name_trgm_idx').using(
      'gin',
      table.clientName.op('gin_trgm_ops'),
    ),
    index('skill_accesses_session_id_trgm_idx').using('gin', table.sessionId.op('gin_trgm_ops')),
  ],
);

// -------------------------------------------------------------------- RAG ---

/**
 * Um espaço de embedding (`schema/020-rag.sql`, `docs/14-rag.md` §5):
 * driver, modelo, dimensões e os **dois prefixos** do driver. A identidade é
 * a combinação dos cinco — trocar o prefixo cria outro espaço, como trocar o
 * modelo, e vetores de espaços diferentes nunca se misturam numa consulta. O
 * CHECK de tamanho dos prefixos fica só no SQL.
 */
export const ragSpaces = pgTable(
  'rag_spaces',
  {
    uuid: uuid('uuid').primaryKey().default(sql`uuidv7()`),
    driver: text('driver').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    /** O que o driver põe antes do texto ao embutir um documento; vazio é válido. */
    documentPrefix: text('document_prefix').notNull(),
    /** O mesmo, para a consulta. Sem DEFAULT no banco: esquecê-lo é erro. */
    queryPrefix: text('query_prefix').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // A identidade do espaço são os cinco campos juntos.
    unique('rag_spaces_identity_uniq').on(
      table.driver,
      table.model,
      table.dimensions,
      table.documentPrefix,
      table.queryPrefix,
    ),
    // Redundante como unicidade (o uuid já é PK) e obrigatório como **alvo** da
    // FK composta de `rag_vectors`: o Postgres só referencia coluna com UNIQUE.
    unique('rag_spaces_uuid_dimensions_uniq').on(table.uuid, table.dimensions),
  ],
);

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
    primaryKey({
      name: 'rag_skill_texts_pkey',
      columns: [table.skillUuid, table.source, table.relativePath, table.part],
    }),
    index('rag_skill_texts_sha256_idx').on(table.textSha256),
    index('rag_skill_texts_file_idx').on(table.fileId),
  ],
);

/**
 * O vetor de um texto num espaço. `dimensions` é copiada do espaço pela FK
 * composta `(space_uuid, dimensions) → rag_spaces (uuid, dimensions)`; o
 * `rag_vectors_dimensions_chk`, que confere `vector_dims(embedding)` contra
 * ela, fica só no SQL. A busca é exata, sem índice — o HNSW do pgvector para
 * em 2000 dimensões.
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
    primaryKey({ name: 'rag_vectors_pkey', columns: [table.spaceUuid, table.textSha256] }),
    // É esta FK que impede vetor de dimensão errada: a linha só existe se o par
    // (espaço, dimensões) existir em `rag_spaces`, e o CHECK compara o vetor
    // com a coluna copiada.
    foreignKey({
      name: 'rag_vectors_space_fk',
      columns: [table.spaceUuid, table.dimensions],
      foreignColumns: [ragSpaces.uuid, ragSpaces.dimensions],
    }).onDelete('cascade'),
    index('rag_vectors_text_idx').on(table.textSha256),
  ],
);

/**
 * O estado do par (espaço, texto) na fila do indexador (`schema/025-fila-de-textos-do-rag.sql`):
 * `state = 'reservado'` com `until` no futuro é "alguém está pagando por este
 * texto agora"; `state = 'recusado'` com `until` nulo é "o provedor recusou o
 * conteúdo de vez". As duas FKs são `CASCADE` — estado de fila não pode
 * impedir a coleta de órfãos nem sobreviver ao espaço. O
 * `rag_text_status_state_chk`, que é ao mesmo tempo o domínio de `state` e a
 * forma de cada estado, fica só no SQL.
 */
export const ragTextStatus = pgTable(
  'rag_text_status',
  {
    spaceUuid: uuid('space_uuid')
      .notNull()
      .references(() => ragSpaces.uuid, { onDelete: 'cascade' }),
    textSha256: bytea('text_sha256')
      .notNull()
      .references(() => ragTexts.sha256, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    /** Fim da reserva; nulo é o que marca a recusa, que não tem prazo. */
    until: timestamp('until', { withTimezone: true }),
    /** O que o provedor disse ao recusar; nulo numa reserva (CHECK). */
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'rag_text_status_pkey', columns: [table.spaceUuid, table.textSha256] }),
    // Para a cascata vinda de `rag_texts` na coleta de órfãos.
    index('rag_text_status_text_idx').on(table.textSha256),
  ],
);

/**
 * A skill **reservada e ainda não terminada** pelo indexador
 * (`schema/028-reserva-de-skills-com-prazo.sql`). `claimStaleSkills` grava a
 * linha junto com o `rag_stale = false`; o fim do trabalho, a devolução e a
 * remoção da skill (cascata) a apagam. O que sobra depois de `until` é a reserva
 * de um indexador que morreu no meio do lote, e volta à fila sozinha. `attempts`
 * conta leituras começadas e não terminadas — é o teto que impede a skill que
 * derruba o indexador de voltar para sempre. É estado de fila, como
 * `rag_text_status`: por isso não mora em `skills`.
 */
export const ragSkillClaims = pgTable('rag_skill_claims', {
  skillUuid: uuid('skill_uuid')
    .primaryKey()
    .references(() => skills.uuid, { onDelete: 'cascade' }),
  /** Fim da reserva: viva segura a skill, vencida a devolve à fila. */
  until: timestamp('until', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// -------------------------------------------------------------- quarentena ---

/**
 * Um envio esperando aprovação (`schema/030-quarentena.sql`,
 * `docs/15-quarentena.md`). Deliberadamente pobre: sem slug, tag, ícone,
 * `is_active`, `is_public`, vínculo com vMCP ou catálogo, contador, concessão e
 * `search_vector` — é uma pasta de arquivos com dono. `name` é rótulo e **não**
 * é único: dois envios do mesmo pacote convivem, e quem os distingue é o
 * `uuid`. Nada de RAG passa por aqui; os triggers do `020` estão presos a
 * `files`, `skills` e `skill_tags`.
 */
export const quarantineSkills = pgTable(
  'quarantine_skills',
  {
    uuid: uuid('uuid').primaryKey().default(sql`uuidv7()`),
    /** Lido do `name:` do SKILL.md ou do nome do arquivo enviado. Só rótulo. */
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** O `pacote.zip` de origem, informativo. */
    sourceFilename: text('source_filename'),
    /** Quem submeteu; nulo = órfão, só do admin, como `skills.owner_user_uuid`. */
    ownerUserUuid: uuid('owner_user_uuid').references(() => users.uuid, {
      onDelete: 'set null',
    }),
    createdByUserUuid: uuid('created_by_user_uuid').references(() => users.uuid, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // "Os envios desta conta", e o índice do `SET NULL` da remoção dela.
    index('quarantine_skills_owner_user_uuid_idx').on(table.ownerUserUuid),
    // A listagem é "mais recentes primeiro", sem outra ordenação possível.
    index('quarantine_skills_created_at_idx').on(table.createdAt.desc()),
  ],
);

/**
 * Os arquivos do envio: a mesma modelagem de `files` — texto **ou** binário,
 * nunca os dois (`quarantine_files_one_content_chk`) — **sem**
 * `content_sha256`, que existe para o RAG reaproveitar vetor e aqui seria uma
 * coluna que ninguém lê. A unicidade de caminho é por envio e sem diferenciar
 * caixa: fica na migration `030`, no índice funcional
 * `quarantine_files_path_lower_uniq`.
 */
export const quarantineFiles = pgTable(
  'quarantine_files',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    quarantineUuid: uuid('quarantine_uuid')
      .notNull()
      .references(() => quarantineSkills.uuid, { onDelete: 'cascade' }),
    relativePath: text('relative_path').notNull(),
    textContent: text('text_content'),
    binaryContent: bytea('binary_content'),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('quarantine_files_quarantine_uuid_idx').on(table.quarantineUuid)],
);

export type SkillRow = typeof skills.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type TagRow = typeof tags.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type UsernameRow = typeof usernames.$inferSelect;
export type UserProfileRow = typeof userProfiles.$inferSelect;
export type UserAvatarRow = typeof userAvatars.$inferSelect;
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
export type McpCallCounterRow = typeof mcpCallCounters.$inferSelect;
export type SkillAccessRow = typeof skillAccesses.$inferSelect;
export type RagSpaceRow = typeof ragSpaces.$inferSelect;
export type RagTextStatusRow = typeof ragTextStatus.$inferSelect;
export type RagTextRow = typeof ragTexts.$inferSelect;
export type RagSkillTextRow = typeof ragSkillTexts.$inferSelect;
export type RagVectorRow = typeof ragVectors.$inferSelect;
export type RagSkillClaimRow = typeof ragSkillClaims.$inferSelect;
export type QuarantineSkillRow = typeof quarantineSkills.$inferSelect;
export type QuarantineFileRow = typeof quarantineFiles.$inferSelect;
