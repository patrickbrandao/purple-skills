-- Purple Skills — skills flutuantes: fim de `is_public` e das `use_as_*`.
--
-- Problema: desde o `011` não existe mais um MCP principal que leia as flags
-- da skill — todo servidor, inclusive o que responde em `/mcp`, lê pelo
-- vínculo `virtual_mcp_skills`. As quatro colunas continuavam no banco e nas
-- telas sem efeito em MCP nenhum, e `is_public` ainda decidia sozinha o que o
-- site mostra: dois sistemas de visibilidade para a mesma skill. Desenho
-- fechado em `docs/09-mcp-padrao-e-skills-flutuantes.md` (PR2).
--
-- A partir daqui uma skill é um elemento **flutuante**: existe no catálogo e
-- só é exibida — no MCP e no site — onde alguém a vinculou. O site passa a
-- listar o que está em ao menos um vMCP aberto e ligado; "privada" deixa de
-- ser um estado da skill e vira "sem vínculo com servidor aberto". As três
-- portas (ferramentas, prompt, resource) continuam sendo decididas por
-- vínculo, como o `009` já fazia.
--
-- O que sai:
--   * `skills.is_public`, `use_as_skill`, `use_as_prompt`, `use_as_resource`;
--   * os índices parciais de `007` (`skills_public_prompt_idx`,
--     `skills_public_resource_idx`), que dependiam de `is_public`;
--   * `skills_public_score_idx` de `001`, prefixado por `is_public`. Entra no
--     lugar `skills_score_idx`, só pela soma dos contadores: é a ordenação
--     padrão de toda listagem.
--
-- Efeito sobre dados existentes: as colunas são descartadas com o que havia
-- nelas. Nada se perde de publicação, porque o `011` já copiou `is_public` e
-- as `use_as_*` para o vínculo com o vMCP `public` — uma instalação que sobe
-- de versão passa pelo `011` antes deste arquivo, sempre. A leitura do
-- `search_vector` (`001`, `002`) não toca nenhuma dessas colunas. Idempotente:
-- `DROP ... IF EXISTS` em tudo.

-- ---------------------------------------------------------------- índices ---
DROP INDEX IF EXISTS skills_public_prompt_idx;
DROP INDEX IF EXISTS skills_public_resource_idx;
DROP INDEX IF EXISTS skills_public_score_idx;

CREATE INDEX IF NOT EXISTS skills_score_idx
    ON skills (((view_count + download_count)) DESC);

-- ----------------------------------------------------------------- skills ---
ALTER TABLE skills DROP COLUMN IF EXISTS use_as_skill;
ALTER TABLE skills DROP COLUMN IF EXISTS use_as_prompt;
ALTER TABLE skills DROP COLUMN IF EXISTS use_as_resource;
ALTER TABLE skills DROP COLUMN IF EXISTS is_public;
