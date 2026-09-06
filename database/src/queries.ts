import { sql, type SQL } from 'drizzle-orm';
import {
  SKILL_MD,
  isRole,
  isSkillMd,
  isTextualMime,
  mimeTypeFor,
  normalizeRelativePath,
  skillScore,
  slugify,
  uniqueSlug,
  type ApiKeySummary,
  type AuditAction,
  type AuditActor,
  type AuditEntry,
  type AuditSource,
  type Role,
  type SkillDetail,
  type SkillFileMeta,
  type SkillSummary,
  type SearchResult,
  type UserSummary,
} from '@purple-skills/shared';
import { getDb, type Database } from './client.js';
import {
  badRequest,
  conflict,
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
} from './errors.js';

type Row = Record<string, any>;

const db = () => getDb().db;

export type SortOrder = 'score' | 'recent' | 'name' | 'relevance';

export type ListOptions = {
  query?: string | null;
  tag?: string | null;
  limit?: number;
  offset?: number;
  includePrivate?: boolean;
  sort?: SortOrder;
};

const SKILL_COLUMNS = sql`
  s.uuid, s.slug, s.name, s.description, s.is_public, s.view_count, s.download_count,
  s.created_at, s.updated_at,
  COALESCE((
    SELECT array_agg(t.name ORDER BY t.name)
    FROM skill_tags st JOIN tags t ON t.id = st.tag_id
    WHERE st.skill_uuid = s.uuid
  ), '{}') AS tags,
  (SELECT count(*) FROM files f WHERE f.skill_uuid = s.uuid) AS file_count
`;

function toSummary(row: Row): SkillSummary {
  const viewCount = Number(row.view_count ?? 0);
  const downloadCount = Number(row.download_count ?? 0);

  return {
    uuid: row.uuid,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    isPublic: Boolean(row.is_public),
    viewCount,
    downloadCount,
    score: skillScore(viewCount, downloadCount),
    tags: (row.tags ?? []) as string[],
    fileCount: Number(row.file_count ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Busca paginada de skills, com full-text + fallback por substring. */
export async function listSkills(options: ListOptions = {}): Promise<SearchResult> {
  const limit = clamp(options.limit ?? 24, 1, 100);
  const offset = Math.max(0, options.offset ?? 0);
  const query = normalizeQuery(options.query);
  const tag = options.tag?.trim() || null;
  const includePrivate = options.includePrivate === true;
  const sort = options.sort ?? (query ? 'relevance' : 'score');

  const rank = query
    ? sql`ts_rank(s.search_vector, websearch_to_tsquery('simple', ${query}))`
    : sql`0::float4`;

  const order =
    sort === 'recent'
      ? sql`s.updated_at DESC`
      : sort === 'name'
        ? sql`s.name ASC`
        : sort === 'relevance' && query
          ? sql`rank DESC, (s.view_count + s.download_count) DESC, s.updated_at DESC`
          : sql`(s.view_count + s.download_count) DESC, s.updated_at DESC`;

  // Filtro compartilhado entre a contagem e a página de resultados.
  const where = sql`
    WHERE (${includePrivate} OR s.is_public)
      ${
        query
          ? sql`AND (
              s.search_vector @@ websearch_to_tsquery('simple', ${query})
              OR s.name ILIKE ${'%' + query + '%'}
              OR s.description ILIKE ${'%' + query + '%'}
              OR s.slug ILIKE ${'%' + query + '%'}
            )`
          : sql``
      }
      ${
        tag
          ? sql`AND EXISTS (
              SELECT 1 FROM skill_tags st JOIN tags t ON t.id = st.tag_id
              WHERE st.skill_uuid = s.uuid AND lower(t.name) = lower(${tag})
            )`
          : sql``
      }
  `;

  // `count(*) OVER ()` só chega nas linhas retornadas: paginar além do fim
  // devolvia total 0. A contagem precisa ser independente de LIMIT/OFFSET.
  const counted = await db().execute(sql`
    SELECT count(*)::int AS total FROM skills s ${where}
  `);
  const total = Number((counted.rows as Row[])[0]?.total ?? 0);

  const result = await db().execute(sql`
    SELECT ${SKILL_COLUMNS}, ${rank} AS rank
    FROM skills s
    ${where}
    ORDER BY ${order}
    LIMIT ${limit} OFFSET ${offset}
  `);

  return {
    items: (result.rows as Row[]).map(toSummary),
    total,
    limit,
    offset,
  };
}

export async function getSkillSummary(
  slug: string,
  { includePrivate = false }: { includePrivate?: boolean } = {},
): Promise<SkillSummary | null> {
  const result = await db().execute(sql`
    SELECT ${SKILL_COLUMNS} FROM skills s
    WHERE s.slug = ${slug} AND (${includePrivate} OR s.is_public)
    LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? toSummary(row) : null;
}

/** Skill completa: metadados + SKILL.md + lista de arquivos anexados. */
export async function getSkillDetail(
  slug: string,
  { includePrivate = false }: { includePrivate?: boolean } = {},
): Promise<SkillDetail | null> {
  const summary = await getSkillSummary(slug, { includePrivate });
  if (!summary) return null;

  const files = await listFiles(summary.uuid);
  const skillMd = await readTextFile(summary.uuid, SKILL_MD);

  return { ...summary, skillMd: skillMd ?? '', files };
}

export async function listFiles(skillUuid: string): Promise<SkillFileMeta[]> {
  const result = await db().execute(sql`
    SELECT relative_path, mime_type, size_bytes, (text_content IS NOT NULL) AS is_text
    FROM files WHERE skill_uuid = ${skillUuid}
    ORDER BY (lower(relative_path) = 'skill.md') DESC, relative_path ASC
  `);

  return (result.rows as Row[]).map((row) => ({
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    isText: Boolean(row.is_text),
  }));
}

export type FileContent = {
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
  isText: boolean;
};

export async function readFile(
  skillUuid: string,
  relativePath: string,
): Promise<FileContent | null> {
  const result = await db().execute(sql`
    SELECT relative_path, mime_type, size_bytes, text_content, binary_content
    FROM files
    WHERE skill_uuid = ${skillUuid} AND lower(relative_path) = lower(${relativePath})
    ORDER BY relative_path
    LIMIT 1
  `);

  const row = (result.rows as Row[])[0];
  if (!row) return null;

  const isText = row.text_content !== null;
  return {
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    isText,
    buffer: isText ? Buffer.from(row.text_content, 'utf8') : Buffer.from(row.binary_content),
  };
}

export async function readTextFile(skillUuid: string, relativePath: string): Promise<string | null> {
  const file = await readFile(skillUuid, relativePath);
  if (!file) return null;
  return file.isText ? file.buffer.toString('utf8') : null;
}

/** Todos os arquivos da skill, com bytes — usado na geração do ZIP. */
export async function readAllFiles(skillUuid: string): Promise<FileContent[]> {
  const result = await db().execute(sql`
    SELECT relative_path, mime_type, size_bytes, text_content, binary_content
    FROM files WHERE skill_uuid = ${skillUuid}
    ORDER BY (lower(relative_path) = 'skill.md') DESC, relative_path ASC
  `);

  return (result.rows as Row[]).map((row) => {
    const isText = row.text_content !== null;
    return {
      relativePath: row.relative_path,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      isText,
      buffer: isText ? Buffer.from(row.text_content, 'utf8') : Buffer.from(row.binary_content),
    };
  });
}

// ------------------------------------------------------------- contadores ---

export async function incrementViewCount(skillUuid: string): Promise<void> {
  await db().execute(sql`UPDATE skills SET view_count = view_count + 1 WHERE uuid = ${skillUuid}`);
}

export async function incrementDownloadCount(skillUuid: string): Promise<void> {
  await db().execute(
    sql`UPDATE skills SET download_count = download_count + 1 WHERE uuid = ${skillUuid}`,
  );
}

// ------------------------------------------------------------------ tags ---

export async function listTags(
  { includePrivate = false }: { includePrivate?: boolean } = {},
): Promise<{ name: string; count: number }[]> {
  const result = await db().execute(sql`
    SELECT t.name, count(*)::int AS count
    FROM tags t
    JOIN skill_tags st ON st.tag_id = t.id
    JOIN skills s ON s.uuid = st.skill_uuid
    WHERE (${includePrivate} OR s.is_public)
    GROUP BY t.name
    ORDER BY count DESC, t.name ASC
  `);

  return (result.rows as Row[]).map((row) => ({ name: row.name, count: Number(row.count) }));
}

// -------------------------------------------------------------- escrita ----

export type CreateSkillInput = {
  name: string;
  description?: string;
  skillMd: string;
  tags?: string[];
  isPublic?: boolean;
  slug?: string;
  /**
   * Anexos gravados na mesma transação da criação (importação de `.zip`).
   * Gravá-los depois deixaria a skill existindo sem os arquivos quando o
   * segundo passo falhasse. `SKILL.md` vem sempre por `skillMd`.
   */
  files?: readonly FileInput[];
};

/** Quantas vezes reescolher um slug gerado automaticamente após uma colisão. */
const SLUG_ATTEMPTS = 3;

export async function createSkill(
  input: CreateSkillInput,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillDetail> {
  const name = (input.name ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');
  if (typeof input.skillMd !== 'string' || !input.skillMd.trim()) {
    throw badRequest('O conteúdo do SKILL.md é obrigatório');
  }

  // Validado antes de abrir a transação: um caminho recusado no meio da
  // gravação deixaria a skill criada sem parte dos anexos.
  const attachments = (input.files ?? [])
    .map((file) => {
      const path = normalizeRelativePath(file.relativePath);
      if (!path) throw badRequest(`Caminho inválido: ${file.relativePath}`);
      const buffer = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(file.content, 'utf8');
      return { path, buffer };
    })
    // O SKILL.md vem por `skillMd`; um homônimo entre os anexos é ignorado.
    .filter((file) => !isSkillMd(file.path));

  const explicitSlug = Boolean(input.slug?.trim());
  let slug = '';

  // `resolveSlug` consulta os slugs ocupados e o INSERT acontece depois: duas
  // criações simultâneas podem escolher o mesmo. Com slug gerado a partir do
  // nome, a intenção é "qualquer slug livre" e vale tentar de novo; com slug
  // pedido explicitamente, o conflito é a resposta correta.
  for (let attempt = 1; ; attempt += 1) {
    slug = await resolveSlug(input.slug, name);

    try {
      await db().transaction(async (tx) => {
        const inserted = await tx.execute(sql`
          INSERT INTO skills (slug, name, description, is_public, created_by_user_uuid)
          VALUES (${slug}, ${name}, ${input.description?.trim() ?? ''}, ${input.isPublic === true},
                  ${actor?.userUuid ?? null})
          RETURNING uuid
        `);
        const uuid = (inserted.rows as Row[])[0].uuid as string;

        await upsertFileTx(tx, uuid, SKILL_MD, Buffer.from(input.skillMd, 'utf8'));
        for (const file of attachments) {
          await upsertFileTx(tx, uuid, file.path, file.buffer);
        }
        await replaceTagsTx(tx, uuid, input.tags ?? []);
        await auditTx(tx, {
          skillUuid: uuid,
          skillSlug: slug,
          filePath: null,
          action: 'create',
          source,
          actor,
          previousContent: null,
        });
      });
      break;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (explicitSlug || attempt >= SLUG_ATTEMPTS) {
        throw conflict(`Já existe uma skill com o slug "${slug}"`);
      }
    }
  }

  const detail = await getSkillDetail(slug, { includePrivate: true });
  if (!detail) throw new Error('Skill criada mas não encontrada');
  return detail;
}

export type UpdateSkillInput = {
  name?: string;
  description?: string;
  tags?: string[];
  isPublic?: boolean;
  slug?: string;
};

export async function updateSkill(
  slug: string,
  input: UpdateSkillInput,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillDetail> {
  const existing = await requireSkill(slug);

  const name = input.name?.trim();
  if (input.name !== undefined && !name) throw badRequest('O campo "name" não pode ficar vazio');

  const newSlug =
    input.slug !== undefined && input.slug.trim() && input.slug.trim() !== existing.slug
      ? await resolveSlug(input.slug, input.slug)
      : existing.slug;

  try {
    await db().transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE skills SET
          name = ${name ?? existing.name},
          description = ${input.description !== undefined ? input.description.trim() : existing.description},
          is_public = ${input.isPublic !== undefined ? input.isPublic : existing.isPublic},
          slug = ${newSlug},
          updated_at = now()
        WHERE uuid = ${existing.uuid}
      `);

      if (input.tags !== undefined) {
        await replaceTagsTx(tx, existing.uuid, input.tags);
      }

      await auditTx(tx, {
        skillUuid: existing.uuid,
        skillSlug: newSlug,
        filePath: null,
        action: 'update',
        source,
        actor,
        previousContent: null,
      });
    });
  } catch (err) {
    // Outra escrita concorrente pode ter levado o slug entre a checagem e o
    // UPDATE: isso é conflito (409), não falha interna.
    if (isUniqueViolation(err)) throw conflict(`Já existe uma skill com o slug "${newSlug}"`);
    throw err;
  }

  const detail = await getSkillDetail(newSlug, { includePrivate: true });
  if (!detail) throw new Error('Skill atualizada mas não encontrada');
  return detail;
}

/**
 * Atualiza metadados **e** o SKILL.md numa transação só.
 *
 * O painel envia conteúdo e metadados numa única chamada; gravar o arquivo
 * antes (em transação própria) e depois validar o slug deixava a skill num
 * estado meio-salvo quando a validação falhava — conteúdo novo, metadados
 * antigos. Aqui é tudo ou nada.
 */
export async function updateSkillWithContent(
  slug: string,
  input: UpdateSkillInput & { skillMd?: string },
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillDetail> {
  const existing = await requireSkill(slug);

  const name = input.name?.trim();
  if (input.name !== undefined && !name) throw badRequest('O campo "name" não pode ficar vazio');

  const newSlug =
    input.slug !== undefined && input.slug.trim() && input.slug.trim() !== existing.slug
      ? await resolveSlug(input.slug, input.slug)
      : existing.slug;

  const previousSkillMd =
    typeof input.skillMd === 'string' ? await readTextFile(existing.uuid, SKILL_MD) : null;

  try {
    await db().transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE skills SET
          name = ${name ?? existing.name},
          description = ${input.description !== undefined ? input.description.trim() : existing.description},
          is_public = ${input.isPublic !== undefined ? input.isPublic : existing.isPublic},
          slug = ${newSlug},
          updated_at = now()
        WHERE uuid = ${existing.uuid}
      `);

      if (input.tags !== undefined) {
        await replaceTagsTx(tx, existing.uuid, input.tags);
      }

      if (typeof input.skillMd === 'string') {
        await upsertFileTx(tx, existing.uuid, SKILL_MD, Buffer.from(input.skillMd, 'utf8'));
        await auditTx(tx, {
          skillUuid: existing.uuid,
          skillSlug: newSlug,
          filePath: SKILL_MD,
          action: 'update',
          source,
          actor,
          previousContent: previousSkillMd,
        });
      }

      await auditTx(tx, {
        skillUuid: existing.uuid,
        skillSlug: newSlug,
        filePath: null,
        action: 'update',
        source,
        actor,
        previousContent: null,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`Já existe uma skill com o slug "${newSlug}"`);
    throw err;
  }

  const detail = await getSkillDetail(newSlug, { includePrivate: true });
  if (!detail) throw new Error('Skill atualizada mas não encontrada');
  return detail;
}

export async function setVisibility(
  slug: string,
  isPublic: boolean,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillSummary> {
  const existing = await requireSkill(slug);

  await db().transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE skills SET is_public = ${isPublic}, updated_at = now() WHERE uuid = ${existing.uuid}`,
    );
    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: slug,
      filePath: null,
      action: 'update',
      source,
      actor,
      previousContent: existing.isPublic ? 'public' : 'private',
    });
  });

  const summary = await getSkillSummary(slug, { includePrivate: true });
  if (!summary) throw notFound();
  return summary;
}

export async function deleteSkill(
  slug: string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<void> {
  const existing = await requireSkill(slug);

  await db().transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM skills WHERE uuid = ${existing.uuid}`);
    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: slug,
      filePath: null,
      action: 'delete',
      source,
      actor,
      previousContent: null,
    });
  });
}

export type FileInput = { relativePath: string; content: Buffer | string };

/** Cria ou sobrescreve um arquivo da skill. */
export async function setFile(
  slug: string,
  relativePath: string,
  content: Buffer | string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<SkillFileMeta> {
  const existing = await requireSkill(slug);
  const path = normalizeRelativePath(relativePath);
  if (!path) throw badRequest(`Caminho inválido: ${relativePath}`);

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const previous = await readFile(existing.uuid, path);

  await db().transaction(async (tx) => {
    await upsertFileTx(tx, existing.uuid, path, buffer);
    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: slug,
      filePath: path,
      action: previous ? 'update' : 'create',
      source,
      actor,
      previousContent: previous?.isText ? previous.buffer.toString('utf8') : null,
    });
  });

  const mimeType = mimeTypeFor(path);
  return {
    relativePath: path,
    mimeType,
    sizeBytes: buffer.byteLength,
    isText: isTextualMime(mimeType) && !buffer.includes(0),
  };
}

export async function deleteFile(
  slug: string,
  relativePath: string,
  source: AuditSource,
  actor?: AuditActor | null,
): Promise<void> {
  const existing = await requireSkill(slug);
  const path = normalizeRelativePath(relativePath);
  if (!path) throw badRequest(`Caminho inválido: ${relativePath}`);
  if (isSkillMd(path)) throw badRequest('O arquivo SKILL.md não pode ser removido');

  const previous = await readFile(existing.uuid, path);
  if (!previous) throw notFound(`Arquivo não encontrado: ${path}`);

  await db().transaction(async (tx) => {
    // Pelo caminho exato da linha lida, não por `lower(...)`: um filtro
    // insensível a caixa apagaria de uma vez todas as variantes do nome.
    await tx.execute(
      sql`DELETE FROM files WHERE skill_uuid = ${existing.uuid} AND relative_path = ${previous.relativePath}`,
    );
    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: slug,
      filePath: path,
      action: 'delete',
      source,
      actor,
      previousContent: previous.isText ? previous.buffer.toString('utf8') : null,
    });
  });
}

export type SetFilesOptions = {
  /**
   * `true` (padrão): o payload representa o estado desejado completo — caminhos
   * omitidos são removidos (exceto SKILL.md, sempre preservado).
   */
  replace?: boolean;
};

export async function setFiles(
  slug: string,
  inputs: readonly FileInput[],
  source: AuditSource,
  options: SetFilesOptions = {},
  actor?: AuditActor | null,
): Promise<SkillFileMeta[]> {
  const existing = await requireSkill(slug);
  const replace = options.replace !== false;

  const normalized = inputs.map((input) => {
    const path = normalizeRelativePath(input.relativePath);
    if (!path) throw badRequest(`Caminho inválido: ${input.relativePath}`);
    const buffer = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, 'utf8');
    return { path, buffer };
  });

  if (normalized.length === 0 && replace) {
    throw badRequest('Nenhum arquivo informado');
  }

  await db().transaction(async (tx) => {
    for (const file of normalized) {
      await upsertFileTx(tx, existing.uuid, file.path, file.buffer);
    }

    if (replace) {
      const keep = normalized.map((f) => f.path.toLowerCase());
      keep.push(SKILL_MD.toLowerCase());
      await tx.execute(sql`
        DELETE FROM files
        WHERE skill_uuid = ${existing.uuid}
          AND lower(relative_path) <> ALL(${sql.param(keep)}::text[])
      `);
    }

    await auditTx(tx, {
      skillUuid: existing.uuid,
      skillSlug: slug,
      filePath: null,
      action: 'update',
      source,
      actor,
      previousContent: null,
    });
  });

  return listFiles(existing.uuid);
}

// ----------------------------------------------------------------- contas ---

/**
 * Conta com os campos que nunca saem do servidor.
 *
 * `UserSummary` é o que a API devolve ao navegador; `UserRecord` acrescenta o
 * hash da senha, a versão do token, o contador de falhas e o subject OIDC —
 * material de autenticação, que fica entre o banco e o middleware.
 */
export type UserRecord = UserSummary & {
  passwordHash: string | null;
  tokenVersion: number;
  failedAttempts: number;
  oidcSubject: string | null;
};

const USER_COLUMNS = sql`
  uuid, email, name, password_hash, role, is_active, token_version,
  must_change_password, oidc_issuer, oidc_subject, locked_until, failed_attempts,
  last_login_at, created_at, updated_at
`;

function toUserRecord(row: Row): UserRecord {
  return {
    uuid: row.uuid,
    email: row.email,
    name: row.name,
    role: row.role as Role,
    isActive: Boolean(row.is_active),
    hasPassword: row.password_hash !== null && row.password_hash !== undefined,
    mustChangePassword: Boolean(row.must_change_password),
    oidcIssuer: row.oidc_issuer ?? null,
    lockedUntil: iso(row.locked_until),
    lastLoginAt: iso(row.last_login_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    passwordHash: row.password_hash ?? null,
    tokenVersion: Number(row.token_version ?? 0),
    failedAttempts: Number(row.failed_attempts ?? 0),
    oidcSubject: row.oidc_subject ?? null,
  };
}

// Derivado do record por remoção: acrescentar um campo sensível a `UserRecord`
// não o faz vazar para a listagem por esquecimento.
function toUserSummary(row: Row): UserSummary {
  const {
    passwordHash: _passwordHash,
    tokenVersion: _tokenVersion,
    failedAttempts: _failedAttempts,
    oidcSubject: _oidcSubject,
    ...summary
  } = toUserRecord(row);
  return summary;
}

/** Zero libera a rota `/setup` do painel (`docs/05-accounts-and-roles.md` §2.3). */
export async function countUsers(): Promise<number> {
  const result = await db().execute(sql`SELECT count(*)::int AS total FROM users`);
  return Number((result.rows as Row[])[0]?.total ?? 0);
}

export async function listUsers(): Promise<UserSummary[]> {
  const result = await db().execute(sql`
    SELECT ${USER_COLUMNS} FROM users ORDER BY created_at
  `);
  return (result.rows as Row[]).map(toUserSummary);
}

/** UUID malformado devolve `null` — é "não existe", não erro de servidor. */
export async function getUserByUuid(uuid: string): Promise<UserRecord | null> {
  if (!isUuid(uuid)) return null;

  const result = await db().execute(sql`
    SELECT ${USER_COLUMNS} FROM users WHERE uuid = ${uuid} LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? toUserRecord(row) : null;
}

/** Busca por `lower(email)`, que é como a unicidade é garantida no banco. */
export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const wanted = (email ?? '').trim();
  if (!wanted) return null;

  const result = await db().execute(sql`
    SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower(${wanted}) LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? toUserRecord(row) : null;
}

export async function getUserByOidc(issuer: string, subject: string): Promise<UserRecord | null> {
  if (!issuer?.trim() || !subject?.trim()) return null;

  const result = await db().execute(sql`
    SELECT ${USER_COLUMNS} FROM users
    WHERE oidc_issuer = ${issuer.trim()} AND oidc_subject = ${subject.trim()}
    LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  return row ? toUserRecord(row) : null;
}

export type CreateUserInput = {
  email: string;
  name: string;
  role: Role;
  /** Ausente ou `null` cria conta sem senha local — só entra por OIDC. */
  passwordHash?: string | null;
  mustChangePassword?: boolean;
  oidcIssuer?: string | null;
  oidcSubject?: string | null;
  isActive?: boolean;
};

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  // O e-mail é gravado como veio (apenas aparado): a unicidade é por
  // `lower(email)` no índice, então preservar a caixa não duplica ninguém e
  // mantém a grafia que a pessoa usa.
  const email = (input.email ?? '').trim();
  if (!email) throw badRequest('O campo "email" é obrigatório');

  const name = (input.name ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');

  if (!isRole(input.role)) throw badRequest(`Papel inválido: ${String(input.role)}`);

  try {
    const result = await db().execute(sql`
      INSERT INTO users (
        email, name, password_hash, role, is_active, must_change_password,
        oidc_issuer, oidc_subject
      )
      VALUES (
        ${email}, ${name}, ${input.passwordHash ?? null}, ${input.role},
        ${input.isActive !== false}, ${input.mustChangePassword === true},
        ${input.oidcIssuer ?? null}, ${input.oidcSubject ?? null}
      )
      RETURNING ${USER_COLUMNS}
    `);
    return toUserRecord((result.rows as Row[])[0]);
  } catch (err) {
    if (isUniqueViolation(err, 'users_oidc_uniq')) {
      throw conflict('Já existe uma conta vinculada a essa identidade OIDC');
    }
    if (isUniqueViolation(err)) {
      throw conflict(`Já existe uma conta com o e-mail "${email}"`);
    }
    throw err;
  }
}

export type UpdateUserInput = {
  name?: string;
  role?: Role;
  isActive?: boolean;
  passwordHash?: string | null;
  mustChangePassword?: boolean;
  oidcIssuer?: string | null;
  oidcSubject?: string | null;
  /** true incrementa token_version — derruba todo cookie já emitido. */
  bumpTokenVersion?: boolean;
};

/**
 * Atualização parcial: campo ausente fica como está.
 *
 * `undefined` significa "não mexe" e `null` significa "apaga" — é o que separa
 * "não estou trocando a senha" de "esta conta passa a ser só-OIDC".
 */
export async function updateUser(uuid: string, input: UpdateUserInput): Promise<UserRecord> {
  if (!isUuid(uuid)) throw notFound(`Conta não encontrada: ${uuid}`);

  const sets: SQL[] = [];

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw badRequest('O campo "name" não pode ficar vazio');
    sets.push(sql`name = ${name}`);
  }
  if (input.role !== undefined) {
    if (!isRole(input.role)) throw badRequest(`Papel inválido: ${String(input.role)}`);
    sets.push(sql`role = ${input.role}`);
  }
  if (input.isActive !== undefined) sets.push(sql`is_active = ${input.isActive}`);
  if (input.passwordHash !== undefined) sets.push(sql`password_hash = ${input.passwordHash}`);
  if (input.mustChangePassword !== undefined) {
    sets.push(sql`must_change_password = ${input.mustChangePassword}`);
  }
  if (input.oidcIssuer !== undefined) sets.push(sql`oidc_issuer = ${input.oidcIssuer}`);
  if (input.oidcSubject !== undefined) sets.push(sql`oidc_subject = ${input.oidcSubject}`);
  // Incremento no próprio UPDATE: ler-e-somar no app perderia uma revogação
  // concorrente, que é justamente o que não pode falhar aqui.
  if (input.bumpTokenVersion === true) sets.push(sql`token_version = token_version + 1`);

  sets.push(sql`updated_at = now()`);

  try {
    const result = await db().execute(sql`
      UPDATE users SET ${sql.join(sets, sql`, `)}
      WHERE uuid = ${uuid}
      RETURNING ${USER_COLUMNS}
    `);
    const row = (result.rows as Row[])[0];
    if (!row) throw notFound(`Conta não encontrada: ${uuid}`);
    return toUserRecord(row);
  } catch (err) {
    if (isUniqueViolation(err, 'users_oidc_uniq')) {
      throw conflict('Já existe uma conta vinculada a essa identidade OIDC');
    }
    throw err;
  }
}

/**
 * Contabiliza uma tentativa de login falha (§2.7).
 *
 * Tudo num UPDATE só: duas tentativas simultâneas não podem ler o mesmo
 * contador e gravar o mesmo valor. Ao atingir o teto, o contador **volta a
 * zero** e o bloqueio passa a ser `locked_until` — quem errar de novo depois
 * que o bloqueio vencer recomeça a contagem em vez de ser travado de imediato.
 *
 * `updated_at` não é tocado de propósito: ele descreve alteração
 * administrativa da conta, não movimento de login.
 */
export async function registerFailedLogin(
  uuid: string,
  options: { maxAttempts: number; lockSeconds: number },
): Promise<{ failedAttempts: number; lockedUntil: string | null }> {
  if (!isUuid(uuid)) throw notFound(`Conta não encontrada: ${uuid}`);

  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts));
  const lockSeconds = Math.max(1, Math.trunc(options.lockSeconds));

  const result = await db().execute(sql`
    UPDATE users SET
      failed_attempts = CASE
        WHEN failed_attempts + 1 >= ${maxAttempts} THEN 0
        ELSE failed_attempts + 1
      END,
      locked_until = CASE
        WHEN failed_attempts + 1 >= ${maxAttempts}
          THEN now() + make_interval(secs => ${lockSeconds})
        ELSE locked_until
      END
    WHERE uuid = ${uuid}
    RETURNING failed_attempts, locked_until
  `);

  const row = (result.rows as Row[])[0];
  if (!row) throw notFound(`Conta não encontrada: ${uuid}`);

  return {
    failedAttempts: Number(row.failed_attempts ?? 0),
    lockedUntil: iso(row.locked_until),
  };
}

/** Login aceito: zera o contador, libera o bloqueio e marca o acesso. */
export async function registerSuccessfulLogin(uuid: string): Promise<void> {
  if (!isUuid(uuid)) return;

  await db().execute(sql`
    UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
    WHERE uuid = ${uuid}
  `);
}

// ------------------------------------------------------------ chaves de API --

function toApiKeySummary(row: Row): ApiKeySummary {
  return {
    id: row.id,
    userUuid: row.user_uuid,
    name: row.name,
    prefix: row.prefix,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Inclui as revogadas: elas explicam as linhas de auditoria que produziram. */
export async function listApiKeys(userUuid: string): Promise<ApiKeySummary[]> {
  if (!isUuid(userUuid)) return [];

  const result = await db().execute(sql`
    SELECT id, user_uuid, name, prefix, last_used_at, revoked_at, created_at
    FROM api_keys WHERE user_uuid = ${userUuid}
    ORDER BY created_at DESC
  `);
  return (result.rows as Row[]).map(toApiKeySummary);
}

/**
 * Grava a chave emitida. O segredo em texto **não** passa por aqui: quem o
 * gera e o mostra uma única vez é o app, com `generateApiKey()` de shared.
 */
export async function createApiKey(input: {
  userUuid: string;
  name: string;
  prefix: string;
  keyHash: string;
}): Promise<ApiKeySummary> {
  if (!isUuid(input.userUuid)) throw notFound(`Conta não encontrada: ${input.userUuid}`);

  const name = (input.name ?? '').trim();
  if (!name) throw badRequest('O campo "name" é obrigatório');
  if (!input.prefix?.trim() || !input.keyHash?.trim()) {
    throw badRequest('Prefixo e hash da chave são obrigatórios');
  }

  try {
    const result = await db().execute(sql`
      INSERT INTO api_keys (user_uuid, name, prefix, key_hash)
      VALUES (${input.userUuid}, ${name}, ${input.prefix.trim()}, ${input.keyHash})
      RETURNING id, user_uuid, name, prefix, last_used_at, revoked_at, created_at
    `);
    return toApiKeySummary((result.rows as Row[])[0]);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('Prefixo de chave já em uso; tente novamente');
    // A conta sumiu entre a sessão e a emissão.
    if (isForeignKeyViolation(err)) throw notFound(`Conta não encontrada: ${input.userUuid}`);
    throw err;
  }
}

/**
 * Revoga. `userUuid` presente restringe ao dono (usuário revogando a própria
 * chave); ausente é o admin revogando qualquer uma.
 *
 * `false` quando não achou **ou** já estava revogada — a operação é
 * idempotente e nunca reescreve o `revoked_at` original, que é o que datou a
 * revogação na auditoria.
 */
export async function revokeApiKey(id: string, userUuid?: string | null): Promise<boolean> {
  if (!isUuid(id)) return false;

  const owner = userUuid ?? null;
  if (owner !== null && !isUuid(owner)) return false;

  const result = await db().execute(sql`
    UPDATE api_keys SET revoked_at = now()
    WHERE id = ${id}
      AND revoked_at IS NULL
      AND (${owner}::uuid IS NULL OR user_uuid = ${owner}::uuid)
    RETURNING id
  `);
  return (result.rows as Row[]).length > 0;
}

export type ApiKeyRecord = {
  id: string;
  userUuid: string;
  name: string;
  prefix: string;
  keyHash: string;
  revokedAt: string | null;
};

/**
 * Primeiro passo da autenticação por chave: acha a linha pelo prefixo público.
 * A conferência do segredo contra `keyHash` é do app — comparação de hash não
 * é trabalho do banco.
 */
export async function getApiKeyByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
  const wanted = (prefix ?? '').trim();
  if (!wanted) return null;

  const result = await db().execute(sql`
    SELECT id, user_uuid, name, prefix, key_hash, revoked_at
    FROM api_keys WHERE prefix = ${wanted} LIMIT 1
  `);
  const row = (result.rows as Row[])[0];
  if (!row) return null;

  return {
    id: row.id,
    userUuid: row.user_uuid,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.key_hash,
    revokedAt: iso(row.revoked_at),
  };
}

/** Marca o uso. Falha silenciosa de propósito: não é para derrubar a chamada. */
export async function touchApiKey(id: string): Promise<void> {
  if (!isUuid(id)) return;
  await db().execute(sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${id}`);
}

// ------------------------------------------------------ tokens de reset -----

export async function createResetToken(input: {
  userUuid: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<void> {
  if (!isUuid(input.userUuid)) throw notFound(`Conta não encontrada: ${input.userUuid}`);
  if (!input.tokenHash?.trim()) throw badRequest('O hash do token é obrigatório');

  await db().execute(sql`
    INSERT INTO reset_tokens (user_uuid, token_hash, expires_at)
    VALUES (${input.userUuid}, ${input.tokenHash}, ${input.expiresAt})
  `);
}

/**
 * Queima o token e devolve o dono, ou `null` se não existe, já foi usado ou
 * expirou.
 *
 * Um único UPDATE condicional: é ele que garante que dois cliques no mesmo
 * link não redefinam a senha duas vezes. Ler e depois marcar abriria a janela
 * entre as duas consultas.
 */
export async function consumeResetToken(tokenHash: string): Promise<{ userUuid: string } | null> {
  const wanted = (tokenHash ?? '').trim();
  if (!wanted) return null;

  const result = await db().execute(sql`
    UPDATE reset_tokens SET used_at = now()
    WHERE token_hash = ${wanted} AND used_at IS NULL AND expires_at > now()
    RETURNING user_uuid
  `);
  const row = (result.rows as Row[])[0];
  return row ? { userUuid: row.user_uuid } : null;
}

// -------------------------------------------------------------- auditoria ---

/**
 * Auditoria de eventos de conta — linhas sem skill.
 *
 * `targetLabel` é quem sofreu a ação (e-mail da conta, nome da chave),
 * congelado no momento do evento: sem ele a linha não diz sobre quem foi, já
 * que `skill_slug`/`file_path` são nulos e a conta pode nem existir mais.
 */
export async function recordAccountAudit(entry: {
  action: 'user.create' | 'user.role' | 'user.deactivate' | 'key.create' | 'key.revoke';
  source: AuditSource;
  actor: AuditActor;
  targetLabel: string | null;
}): Promise<void> {
  await db().execute(
    auditInsert({
      skillUuid: null,
      skillSlug: null,
      filePath: null,
      action: entry.action,
      source: entry.source,
      previousContent: null,
      actor: entry.actor,
      targetLabel: entry.targetLabel,
    }),
  );
}

export async function listAudit(limit = 100): Promise<AuditEntry[]> {
  const result = await db().execute(sql`
    SELECT id, skill_uuid, skill_slug, file_path, action, source,
           actor_user_uuid, actor_label, target_label, created_at
    FROM audit_log ORDER BY created_at DESC LIMIT ${clamp(limit, 1, 500)}
  `);

  return (result.rows as Row[]).map((row) => ({
    id: row.id,
    skillUuid: row.skill_uuid,
    skillSlug: row.skill_slug,
    filePath: row.file_path,
    action: row.action,
    source: row.source,
    actorUserUuid: row.actor_user_uuid ?? null,
    actorLabel: row.actor_label ?? null,
    targetLabel: row.target_label ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export type Stats = {
  totalSkills: number;
  publicSkills: number;
  privateSkills: number;
  totalFiles: number;
  totalViews: number;
  totalDownloads: number;
  totalTags: number;
  totalUsers: number;
  activeUsers: number;
};

export async function stats(): Promise<Stats> {
  const result = await db().execute(sql`
    SELECT
      (SELECT count(*) FROM skills)::int AS total_skills,
      (SELECT count(*) FROM skills WHERE is_public)::int AS public_skills,
      (SELECT count(*) FROM files)::int AS total_files,
      (SELECT COALESCE(sum(view_count), 0) FROM skills)::bigint AS total_views,
      (SELECT COALESCE(sum(download_count), 0) FROM skills)::bigint AS total_downloads,
      (SELECT count(*) FROM tags)::int AS total_tags,
      (SELECT count(*) FROM users)::int AS total_users,
      (SELECT count(*) FROM users WHERE is_active)::int AS active_users
  `);

  const row = (result.rows as Row[])[0];
  const totalSkills = Number(row.total_skills);
  const publicSkills = Number(row.public_skills);

  return {
    totalSkills,
    publicSkills,
    privateSkills: totalSkills - publicSkills,
    totalFiles: Number(row.total_files),
    totalViews: Number(row.total_views),
    totalDownloads: Number(row.total_downloads),
    totalTags: Number(row.total_tags),
    totalUsers: Number(row.total_users),
    activeUsers: Number(row.active_users),
  };
}

export async function healthCheck(): Promise<boolean> {
  try {
    await db().execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- internos ---

async function requireSkill(slug: string): Promise<SkillSummary> {
  const skill = await getSkillSummary(slug, { includePrivate: true });
  if (!skill) throw notFound(`Skill não encontrada: ${slug}`);
  return skill;
}

async function resolveSlug(requested: string | undefined, fallbackName: string): Promise<string> {
  const desired = slugify(requested?.trim() || fallbackName) || 'skill';
  const result = await db().execute(
    sql`SELECT slug FROM skills WHERE slug = ${desired} OR slug LIKE ${desired + '-%'}`,
  );
  const taken = (result.rows as Row[]).map((row) => row.slug as string);
  const slug = uniqueSlug(desired, taken);

  if (requested?.trim() && slug !== desired) {
    throw conflict(`Já existe uma skill com o slug "${desired}"`);
  }
  return slug;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function upsertFileTx(tx: Tx, skillUuid: string, path: string, buffer: Buffer) {
  const mimeType = mimeTypeFor(path);
  const textual = isTextualMime(mimeType) && !buffer.includes(0);
  const text = textual ? buffer.toString('utf8') : null;
  const binary = textual ? null : buffer;

  // O conflito é inferido pelo índice `files_skill_path_lower_uniq`
  // (migration 0003): gravar `Notas.md` sobre `notas.md` sobrescreve a linha
  // existente em vez de criar uma segunda. A caixa recebida vira a definitiva —
  // caso contrário a listagem continuaria mostrando o nome antigo.
  await tx.execute(sql`
    INSERT INTO files (skill_uuid, relative_path, text_content, binary_content, mime_type, size_bytes)
    VALUES (${skillUuid}, ${path}, ${text}, ${binary}, ${mimeType}, ${buffer.byteLength})
    ON CONFLICT (skill_uuid, lower(relative_path)) DO UPDATE SET
      relative_path = EXCLUDED.relative_path,
      text_content = EXCLUDED.text_content,
      binary_content = EXCLUDED.binary_content,
      mime_type = EXCLUDED.mime_type,
      size_bytes = EXCLUDED.size_bytes,
      updated_at = now()
  `);
}

async function replaceTagsTx(tx: Tx, skillUuid: string, rawTags: readonly string[]) {
  const names = Array.from(
    new Set(
      rawTags
        .map((tag) => String(tag ?? '').trim().toLowerCase())
        .filter((tag) => tag.length > 0 && tag.length <= 48),
    ),
  );

  await tx.execute(sql`DELETE FROM skill_tags WHERE skill_uuid = ${skillUuid}`);
  if (names.length === 0) return;

  await tx.execute(sql`
    INSERT INTO tags (name)
    SELECT unnest(${sql.param(names)}::text[]) ON CONFLICT (name) DO NOTHING
  `);
  await tx.execute(sql`
    INSERT INTO skill_tags (skill_uuid, tag_id)
    SELECT ${skillUuid}, t.id FROM tags t WHERE t.name = ANY(${sql.param(names)}::text[])
    ON CONFLICT DO NOTHING
  `);
}

type AuditInput = {
  skillUuid: string | null;
  skillSlug: string | null;
  filePath: string | null;
  action: AuditAction;
  source: AuditSource;
  previousContent: string | null;
  /**
   * Quem executou. Opcional porque a origem (`web-admin`/`mcp-admin`) sempre
   * existiu e o ator só passou a existir com as contas: chamada antiga grava
   * a linha sem ator, exatamente como antes.
   */
  actor?: AuditActor | null;
  /** Alvo de um evento de conta; nulo nas linhas de skill. */
  targetLabel?: string | null;
};

/** Monta o INSERT — compartilhado pelas escritas de skill e por `recordAccountAudit`. */
function auditInsert(entry: AuditInput): SQL {
  return sql`
    INSERT INTO audit_log (
      skill_uuid, skill_slug, file_path, action, source, previous_content,
      actor_user_uuid, actor_label, target_label
    )
    VALUES (${entry.skillUuid}, ${entry.skillSlug}, ${entry.filePath}, ${entry.action},
            ${entry.source}, ${truncate(entry.previousContent, 200_000)},
            ${entry.actor?.userUuid ?? null}, ${entry.actor?.label ?? null},
            ${entry.targetLabel ?? null})
  `;
}

async function auditTx(tx: Tx, entry: AuditInput) {
  await tx.execute(auditInsert(entry));
}

/** UUID canônico. Serve para não deixar um identificador torto virar erro 500. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Timestamp opcional em ISO — o padrão de saída de datas do módulo. */
function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(value as string).toISOString();
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeQuery(raw: string | null | undefined): string | null {
  const query = (raw ?? '').trim();
  return query.length > 0 ? query.slice(0, 200) : null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
