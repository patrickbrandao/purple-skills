-- Purple Skills — unicidade de caminho de arquivo sem diferenciar caixa.
--
-- Problema: `files_skill_path_uniq` compara `relative_path` byte a byte, mas
-- toda leitura filtra por `lower(relative_path)`. Gravar `skill.md` numa skill
-- que já tem `SKILL.md` não caía no ON CONFLICT — inseria uma segunda linha.
-- A partir daí o conteúdo exibido, indexado na busca e empacotado no .zip era
-- escolhido por um `LIMIT 1` sem ordem, e a linha duplicada não podia ser
-- apagada (`delete_file` recusa qualquer variante de SKILL.md).
--
-- Correção em três partes: consolidar o que já duplicou, impedir novas
-- duplicatas no próprio banco, e dar desempate determinístico à leitura da
-- busca como rede de segurança.

-- ---------------------------------------------------------------------------
-- 1. Consolidação: uma linha por (skill, caminho sem caixa).
--
--    Mantém a mais recente (`updated_at`, desempate por `id`), que é o mesmo
--    resultado que o ON CONFLICT da parte 2 produziria se já estivesse valendo
--    quando a duplicata foi criada: a última gravação vence.
-- ---------------------------------------------------------------------------
DELETE FROM files f
USING files keep
WHERE f.skill_uuid = keep.skill_uuid
  AND lower(f.relative_path) = lower(keep.relative_path)
  AND (f.updated_at, f.id) < (keep.updated_at, keep.id);

-- Sobrevivente do arquivo principal passa a usar a grafia canônica.
UPDATE files
   SET relative_path = 'SKILL.md'
 WHERE lower(relative_path) = 'skill.md'
   AND relative_path <> 'SKILL.md';

-- ---------------------------------------------------------------------------
-- 2. Unicidade insensível a caixa.
-- ---------------------------------------------------------------------------
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_skill_path_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS files_skill_path_lower_uniq
    ON files (skill_uuid, lower(relative_path));

-- ---------------------------------------------------------------------------
-- 3. Desempate determinístico na montagem do vetor de busca.
--
--    Com o índice acima o subselect já não pode casar duas linhas; o ORDER BY
--    fica como garantia caso a unicidade seja afrouxada no futuro.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION skills_build_search_vector(
    p_uuid UUID, p_name TEXT, p_description TEXT
) RETURNS TSVECTOR AS $$
    SELECT setweight(to_tsvector('simple', coalesce(p_name, '')), 'A')
        || setweight(to_tsvector('simple', coalesce(p_description, '')), 'B')
        || setweight(to_tsvector('simple', coalesce((
               SELECT f.text_content FROM files f
               WHERE f.skill_uuid = p_uuid AND lower(f.relative_path) = 'skill.md'
               ORDER BY f.relative_path
               LIMIT 1
           ), '')), 'C');
$$ LANGUAGE SQL STABLE;

-- ---------------------------------------------------------------------------
-- 4. Reindexa: a consolidação pode ter trocado qual SKILL.md vale.
-- ---------------------------------------------------------------------------
UPDATE skills SET search_vector = skills_build_search_vector(uuid, name, description);
