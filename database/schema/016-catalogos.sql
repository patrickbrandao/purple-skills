-- Purple Skills — catálogos: grupos de skills com dono, vinculados a um vMCP
-- de uma vez.
--
-- Problema: desde o `012`, publicar uma skill é vinculá-la a um MCP virtual,
-- uma a uma, com as três portas escolhidas por vínculo. Para o time que
-- mantém trinta skills de um domínio e quer oferecê-las a três servidores,
-- cada servidor novo são trinta vínculos e cada skill nova são três. Faltava
-- uma unidade entre a skill e o servidor: um grupo que se publica de uma vez,
-- com uma escolha de portas só, e que continua valendo quando o grupo muda.
-- Desenho fechado em `docs/11-catalogos.md`.
--
-- Quatro peças:
--
--   * `skills.is_active` — a skill desligada **globalmente** (decisão 10):
--     some de todo vMCP, por vínculo direto ou por catálogo, e do site, sem
--     perder vínculo nenhum. O painel e o mcp-admin continuam a vê-la. É a
--     terceira desativação reversível ao lado das duas abaixo.
--
--   * `catalogs` — o grupo. Tem dono pelo mesmo motivo do vMCP
--     (`owner_user_uuid` com `ON DELETE SET NULL`: sobrevive à conta e vira
--     órfão, só do admin), `is_active` desliga o catálogo inteiro sem apagar
--     membros nem vínculos, e os contadores são **do catálogo**, globais: cada
--     acesso a uma skill que chegou a um vMCP *por este catálogo* soma aqui e
--     no global da skill — não há contador por vínculo catálogo×vMCP, de
--     propósito (`docs/11-catalogos.md` §9).
--
--   * `catalog_skills` — a participação. `is_active` desativa a skill *neste*
--     catálogo sem removê-la (decisão 8); é diferente de `skills.is_active`,
--     que vale em tudo. Sem portas: quem decide as portas é o vínculo com o
--     vMCP, e uma skill que precisa de portas diferentes do grupo num servidor
--     usa o vínculo direto, que sobrescreve o catálogo (decisão 4).
--
--   * `virtual_mcp_catalogs` — o vínculo catálogo ↔ vMCP, muitos-para-muitos,
--     com as três portas `NOT NULL` **sem default**, como em
--     `virtual_mcp_skills` e pelo mesmo motivo: a escolha por superfície é
--     obrigatória a cada vínculo. `pos_x`/`pos_y` é o nó do catálogo no canvas
--     daquele vMCP, com o mesmo CHECK de par do `014`, e cai junto com o
--     vínculo.
--
-- A precedência entre vínculo direto e catálogo **não** mora no banco: é a
-- consulta (`visibilityClause` em `queries.ts`, o SQL de
-- `docs/11-catalogos.md` §3.2) que faz o direto sobrescrever e os catálogos
-- somarem entre si. Não há trigger nem coluna derivada.
--
-- `updated_at` de `catalogs` é mantido pelas queries (`SET updated_at =
-- now()`), sem trigger — o padrão de `skills` e `virtual_mcps`.
--
-- Efeito sobre dados existentes: nenhum. Toda skill nasce ligada
-- (`DEFAULT true`), as três tabelas nascem vazias e o CHECK de
-- `audit_log.action` só cresce (superconjunto do de `011`): nenhuma linha
-- existente passa a violá-lo.

-- ----------------------------------------------------------------- skills ---
ALTER TABLE skills ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- --------------------------------------------------------------- catalogs ---
-- O slug é validado no app (`isValidSlug` de shared), como o dos vMCPs.
CREATE TABLE IF NOT EXISTS catalogs (
    uuid            UUID PRIMARY KEY DEFAULT uuidv7(),
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    owner_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL,
    view_count      BIGINT NOT NULL DEFAULT 0,
    download_count  BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A listagem "meus catálogos" do editor e a varredura do SET NULL quando a
-- conta é removida.
CREATE INDEX IF NOT EXISTS catalogs_owner_user_uuid_idx ON catalogs (owner_user_uuid);

-- --------------------------------------------------------- catalog_skills ---
CREATE TABLE IF NOT EXISTS catalog_skills (
    catalog_uuid UUID NOT NULL REFERENCES catalogs(uuid) ON DELETE CASCADE,
    skill_uuid   UUID NOT NULL REFERENCES skills(uuid) ON DELETE CASCADE,
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (catalog_uuid, skill_uuid)
);

-- A chave primária cobre a página do catálogo ("quem está aqui?"); o índice
-- inverso cobre o painel "Nos catálogos" da página da skill, a precedência
-- por skill nas leituras e a varredura do CASCADE quando a skill é removida.
CREATE INDEX IF NOT EXISTS catalog_skills_skill_uuid_idx ON catalog_skills (skill_uuid);

-- --------------------------------------------------- virtual_mcp_catalogs ---
CREATE TABLE IF NOT EXISTS virtual_mcp_catalogs (
    virtual_mcp_uuid UUID NOT NULL REFERENCES virtual_mcps(uuid) ON DELETE CASCADE,
    catalog_uuid     UUID NOT NULL REFERENCES catalogs(uuid) ON DELETE CASCADE,
    as_skill         BOOLEAN NOT NULL,
    as_prompt        BOOLEAN NOT NULL,
    as_resource      BOOLEAN NOT NULL,
    pos_x            INTEGER,
    pos_y            INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (virtual_mcp_uuid, catalog_uuid)
);

-- Meio ponto não é ponto: as duas coordenadas juntas ou nenhuma (o mesmo
-- CHECK de `virtual_mcp_skills`, `014`). DROP + ADD porque o Postgres não
-- tem `ADD CONSTRAINT IF NOT EXISTS`.
ALTER TABLE virtual_mcp_catalogs DROP CONSTRAINT IF EXISTS virtual_mcp_catalogs_pos_pair_chk;
ALTER TABLE virtual_mcp_catalogs ADD CONSTRAINT virtual_mcp_catalogs_pos_pair_chk
    CHECK ((pos_x IS NULL) = (pos_y IS NULL));

-- A chave primária cobre o canvas do vMCP ("quais catálogos estão aqui?"); o
-- índice inverso cobre o painel "Vinculado em" da página do catálogo, a
-- precedência por catálogo nas leituras e a varredura do CASCADE quando o
-- catálogo é removido.
CREATE INDEX IF NOT EXISTS virtual_mcp_catalogs_catalog_uuid_idx
    ON virtual_mcp_catalogs (catalog_uuid);

-- ------------------------------------------------------------- audit_log ---
-- Eventos de catálogo (`docs/11-catalogos.md` §7): linhas sem skill, com o
-- slug do catálogo em `target_label`. Vincular um catálogo a um vMCP é
-- `mcp.update` no servidor, como com skill — não há ação nova para isso.
-- DROP + ADD porque o Postgres não tem `ADD CONSTRAINT IF NOT EXISTS`; a
-- lista repete a de `011` inteira, e não só acrescenta, porque o CHECK é um
-- objeto só.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (
    action IN (
        'create',
        'update',
        'delete',
        'user.create',
        'user.role',
        'user.deactivate',
        'key.create',
        'key.revoke',
        'mcp.create',
        'mcp.update',
        'mcp.delete',
        'mcp.default',
        'mcp.key.create',
        'mcp.key.revoke',
        'catalog.create',
        'catalog.update',
        'catalog.delete',
        'public.key.create',
        'public.key.revoke'
    )
);
