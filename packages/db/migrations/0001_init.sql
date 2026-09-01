-- Purple Skills — schema inicial (v1)
-- Requer PostgreSQL 18 (uuidv7() nativo).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- skills ---
CREATE TABLE IF NOT EXISTS skills (
    uuid           UUID PRIMARY KEY DEFAULT uuidv7(),
    slug           TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    is_public      BOOLEAN NOT NULL DEFAULT false,
    view_count     BIGINT NOT NULL DEFAULT 0,
    download_count BIGINT NOT NULL DEFAULT 0,
    search_vector  TSVECTOR,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skills_search_vector_idx ON skills USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS skills_name_trgm_idx ON skills USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS skills_public_score_idx
    ON skills (is_public, ((view_count + download_count)) DESC);

-- ----------------------------------------------------------------- files ---
CREATE TABLE IF NOT EXISTS files (
    id             UUID PRIMARY KEY DEFAULT uuidv7(),
    skill_uuid     UUID NOT NULL REFERENCES skills(uuid) ON DELETE CASCADE,
    relative_path  TEXT NOT NULL,
    text_content   TEXT,
    binary_content BYTEA,
    mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes     BIGINT NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT files_one_content_chk CHECK (
        (text_content IS NOT NULL AND binary_content IS NULL)
     OR (text_content IS NULL AND binary_content IS NOT NULL)
    ),
    CONSTRAINT files_skill_path_uniq UNIQUE (skill_uuid, relative_path)
);

CREATE INDEX IF NOT EXISTS files_skill_uuid_idx ON files (skill_uuid);

-- ------------------------------------------------------------------ tags ---
CREATE TABLE IF NOT EXISTS tags (
    id         UUID PRIMARY KEY DEFAULT uuidv7(),
    name       TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_tags (
    skill_uuid UUID NOT NULL REFERENCES skills(uuid) ON DELETE CASCADE,
    tag_id     UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (skill_uuid, tag_id)
);

CREATE INDEX IF NOT EXISTS skill_tags_tag_id_idx ON skill_tags (tag_id);

-- ------------------------------------------------------------- audit_log ---
CREATE TABLE IF NOT EXISTS audit_log (
    id               UUID PRIMARY KEY DEFAULT uuidv7(),
    skill_uuid       UUID,
    skill_slug       TEXT,
    file_path        TEXT,
    action           TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
    source           TEXT NOT NULL CHECK (source IN ('web-admin', 'mcp-admin')),
    previous_content TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_skill_uuid_idx ON audit_log (skill_uuid);

-- ------------------------------------------------------ search_vector -----
-- O vetor combina name (peso A) + description (B) + conteúdo do SKILL.md (C).
-- Configuração 'simple' evita stemming preso a um idioma (conteúdo é misto).

CREATE OR REPLACE FUNCTION skills_build_search_vector(
    p_uuid UUID, p_name TEXT, p_description TEXT
) RETURNS TSVECTOR AS $$
    SELECT setweight(to_tsvector('simple', coalesce(p_name, '')), 'A')
        || setweight(to_tsvector('simple', coalesce(p_description, '')), 'B')
        || setweight(to_tsvector('simple', coalesce((
               SELECT f.text_content FROM files f
               WHERE f.skill_uuid = p_uuid AND lower(f.relative_path) = 'skill.md'
               LIMIT 1
           ), '')), 'C');
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION skills_search_vector_tg() RETURNS TRIGGER AS $$
BEGIN
    -- Incremento de contadores não mexe em name/description/updated_at:
    -- nesse caso reaproveitamos o vetor antigo em vez de reindexar.
    IF TG_OP = 'UPDATE'
       AND NEW.name IS NOT DISTINCT FROM OLD.name
       AND NEW.description IS NOT DISTINCT FROM OLD.description
       AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
       AND OLD.search_vector IS NOT NULL THEN
        NEW.search_vector := OLD.search_vector;
        RETURN NEW;
    END IF;

    NEW.search_vector := skills_build_search_vector(NEW.uuid, NEW.name, NEW.description);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS skills_search_vector_trg ON skills;
CREATE TRIGGER skills_search_vector_trg
    BEFORE INSERT OR UPDATE ON skills
    FOR EACH ROW EXECUTE FUNCTION skills_search_vector_tg();

-- Mudanças no SKILL.md reindexam a skill (o UPDATE dispara o trigger acima).
CREATE OR REPLACE FUNCTION files_reindex_skill_tg() RETURNS TRIGGER AS $$
DECLARE
    target UUID;
    path   TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target := OLD.skill_uuid;
        path := OLD.relative_path;
    ELSE
        target := NEW.skill_uuid;
        path := NEW.relative_path;
    END IF;

    IF lower(path) = 'skill.md' THEN
        UPDATE skills SET updated_at = now() WHERE uuid = target;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS files_reindex_skill_trg ON files;
CREATE TRIGGER files_reindex_skill_trg
    AFTER INSERT OR UPDATE OR DELETE ON files
    FOR EACH ROW EXECUTE FUNCTION files_reindex_skill_tg();
