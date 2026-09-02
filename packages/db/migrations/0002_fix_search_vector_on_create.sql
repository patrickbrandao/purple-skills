-- Purple Skills — corrige a indexação do SKILL.md no momento da criação.
--
-- Problema: `createSkill` roda INSERT skills + INSERT files numa única
-- transação. O BEFORE INSERT de `skills` monta o vetor quando o SKILL.md
-- ainda não existe, e o AFTER INSERT de `files` só fazia
-- `UPDATE skills SET updated_at = now()` para forçar a reindexação. Como
-- `now()` é `transaction_timestamp()` (constante dentro da transação), o
-- atalho de `skills_search_vector_tg` enxergava `updated_at` inalterado e
-- reaproveitava o vetor antigo — sem o corpo do SKILL.md.
--
-- Correção em duas partes: o atalho passa a se basear no próprio vetor (e não
-- em `updated_at`), e a reindexação por arquivo passa a ser explícita.

-- ---------------------------------------------------------------------------
-- 1. Atalho baseado no vetor, não em updated_at.
--
--    A otimização original continua valendo: incremento de contadores não
--    mexe em name/description nem em search_vector, então o vetor é mantido
--    sem recalcular. A diferença é que um UPDATE que atribui explicitamente um
--    search_vector novo deixa de ser descartado pelo atalho.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION skills_search_vector_tg() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.name IS NOT DISTINCT FROM OLD.name
       AND NEW.description IS NOT DISTINCT FROM OLD.description
       AND NEW.search_vector IS NOT DISTINCT FROM OLD.search_vector
       AND OLD.search_vector IS NOT NULL THEN
        RETURN NEW;
    END IF;

    NEW.search_vector := skills_build_search_vector(NEW.uuid, NEW.name, NEW.description);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. Mudanças no SKILL.md reindexam explicitamente, sem depender de updated_at.
-- ---------------------------------------------------------------------------
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
        UPDATE skills
           SET search_vector = skills_build_search_vector(uuid, name, description),
               updated_at = now()
         WHERE uuid = target;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3. Backfill: skills criadas antes desta migration têm o vetor sem o corpo do
--    SKILL.md. O UPDATE abaixo passa pelo trigger corrigido e recalcula.
-- ---------------------------------------------------------------------------
UPDATE skills SET search_vector = skills_build_search_vector(uuid, name, description);
