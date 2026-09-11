-- Purple Skills — MCP virtual: servidores de leitura com recorte próprio.
--
-- Problema: o MCP público é um só e publica o catálogo inteiro sob uma única
-- regra — `is_public` mais as flags `use_as_*` da skill. Não há como oferecer
-- a um agente específico um **subconjunto** do catálogo, e menos ainda um
-- subconjunto que inclua skills privadas: hoje o único jeito de um agente ler
-- uma skill privada é o MCP administrativo, que também escreve. Desenho
-- fechado em `docs/08-mcp-virtual.md`.
--
-- Um MCP virtual é um servidor de leitura em `/virtual/<slug>/mcp` que publica
-- o recorte que o dono escolheu. Três tabelas:
--
--   * `virtual_mcps` — o servidor. É a **primeira entidade do projeto com
--     ownership** (`owner_user_uuid`): admin manda em todos, o dono no seu. O
--     `ON DELETE SET NULL` é o mesmo de `skills.created_by_user_uuid` — o
--     servidor sobrevive à remoção da conta e vira órfão, gerenciado só pelo
--     admin. Nulo também é o que a sessão de bootstrap grava, que não é conta.
--     `is_active` desliga sem apagar (chaves e vínculos ficam); `is_open`
--     dispensa chave — com skill privada dentro, é publicação de fato, e é o
--     painel que avisa.
--
--   * `virtual_mcp_skills` — o vínculo, com **flags próprias** `as_skill`,
--     `as_prompt` e `as_resource`. São `NOT NULL` **sem default** de
--     propósito: as flags `use_as_*` da skill valem só para o MCP principal e
--     são ignoradas aqui, então a escolha por superfície é obrigatória a cada
--     vínculo — um default esconderia a decisão. Os contadores também são do
--     vínculo: "quantas vezes esta skill foi lida **por este** MCP" é uma
--     pergunta diferente do total global da skill, que continua somando.
--
--   * `virtual_mcp_keys` — chaves `psv_<prefixo>_<segredo>`, no formato exato
--     de `api_keys` (prefixo público indexado, hash scrypt do segredo,
--     revogação por `revoked_at`, sem expiração). A diferença é o dono: a chave
--     pertence ao **servidor**, não a um usuário. `ON DELETE CASCADE` no MCP
--     porque uma chave sem servidor não abre nada; `created_by_user_uuid` é
--     informativo e sobrevive à remoção de quem emitiu.
--
-- `updated_at` de `virtual_mcps` é mantido pelas queries (`SET updated_at =
-- now()`), sem trigger — o mesmo padrão de `skills` desde `001`.
--
-- Efeito sobre dados existentes: nenhum. As três tabelas nascem vazias e o
-- CHECK de `audit_log.action` só cresce (superconjunto do de `004`): nenhuma
-- linha existente passa a violá-lo.

-- ---------------------------------------------------------- virtual_mcps ---
-- O slug é validado no app (`isValidSlug` de shared), como o das skills.
CREATE TABLE IF NOT EXISTS virtual_mcps (
    uuid            UUID PRIMARY KEY DEFAULT uuidv7(),
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    is_active       BOOLEAN NOT NULL DEFAULT true,
    is_open         BOOLEAN NOT NULL DEFAULT false,
    owner_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A listagem "meus MCPs" do editor e a varredura do SET NULL quando a conta é
-- removida.
CREATE INDEX IF NOT EXISTS virtual_mcps_owner_user_uuid_idx ON virtual_mcps (owner_user_uuid);

-- ---------------------------------------------------- virtual_mcp_skills ---
CREATE TABLE IF NOT EXISTS virtual_mcp_skills (
    virtual_mcp_uuid UUID NOT NULL REFERENCES virtual_mcps(uuid) ON DELETE CASCADE,
    skill_uuid       UUID NOT NULL REFERENCES skills(uuid) ON DELETE CASCADE,
    as_skill         BOOLEAN NOT NULL,
    as_prompt        BOOLEAN NOT NULL,
    as_resource      BOOLEAN NOT NULL,
    view_count       BIGINT NOT NULL DEFAULT 0,
    download_count   BIGINT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (virtual_mcp_uuid, skill_uuid)
);

-- A chave primária cobre a pergunta do servidor ("esta skill está neste
-- MCP?"); o índice inverso cobre o selo "publicada em" da página da skill e
-- a varredura do CASCADE quando a skill é removida.
CREATE INDEX IF NOT EXISTS virtual_mcp_skills_skill_uuid_idx ON virtual_mcp_skills (skill_uuid);

-- ------------------------------------------------------ virtual_mcp_keys ---
CREATE TABLE IF NOT EXISTS virtual_mcp_keys (
    id                   UUID PRIMARY KEY DEFAULT uuidv7(),
    virtual_mcp_uuid     UUID NOT NULL REFERENCES virtual_mcps(uuid) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    prefix               TEXT NOT NULL UNIQUE,
    key_hash             TEXT NOT NULL,
    created_by_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL,
    last_used_at         TIMESTAMPTZ,
    revoked_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Listagem das chaves de um servidor e a varredura do CASCADE.
CREATE INDEX IF NOT EXISTS virtual_mcp_keys_virtual_mcp_uuid_idx
    ON virtual_mcp_keys (virtual_mcp_uuid);

-- ------------------------------------------------------------- audit_log ---
-- Eventos do MCP virtual (`docs/08-mcp-virtual.md` §6). São linhas sem skill:
-- `target_label` guarda o slug do servidor e, nas chaves, o nome da chave.
-- DROP + ADD porque o Postgres não tem `ADD CONSTRAINT IF NOT EXISTS`; a
-- lista repete a de `004` inteira, e não só acrescenta, porque o CHECK é um
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
        'mcp.key.create',
        'mcp.key.revoke'
    )
);
