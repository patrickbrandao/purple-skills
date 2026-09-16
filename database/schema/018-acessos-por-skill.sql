-- Purple Skills — registro por acesso de skill.
--
-- Problema: o que se sabe de quem lê uma skill são três contadores —
-- `skills.view_count`/`download_count`, os do vínculo direto e os do
-- catálogo — somados a cada leitura. Um número diz "quanto", nunca "quem",
-- "por onde" nem "quando": a ficha da skill e a do catálogo no painel ganham
-- uma guia "Acessos" que lista as últimas leituras com filtro por quem leu,
-- e para isso é preciso uma linha por leitura. Desenho em
-- `docs/13-fichas-e-acessos.md`.
--
-- `skill_accesses` tem **uma linha por leitura**, gravada por quem serviu:
--
--   * o MCP público — `get_skill` (`surface = 'tool'`), `resources/read`
--     (`'resource'`), `prompts/get` (`'prompt'`), o `SKILL.md` avulso
--     (`'file'`) e o pacote `.zip`/`.skill` (`'download'`) — com
--     `origin = 'mcp'`, o vMCP por onde a skill foi lida e a credencial:
--     `auth = 'open'` num servidor aberto ou `'key'` com a chave `psv_`;
--   * o site — o detalhe (`'page'`), o `SKILL.md` (`'file'`) e o pacote
--     (`'download'`) — com `origin = 'site'` e `auth = 'anonymous'`;
--   * o mcp-admin — o `get_skill` (`'admin-tool'`) — com `origin =
--     'mcp-admin'`, `auth = 'user'`, a chave `psk_` e a conta dona dela.
--
--   O painel **não** grava: ler no painel é administrar, não consumir.
--   `kind` é o que o contador antigo distinguia — `view` ou `download` — e a
--   escrita que insere a linha soma os mesmos contadores de antes, no mesmo
--   caminho (`recordSkillAccess` em `queries.ts`).
--
-- **A linha sobrevive à remoção de tudo que referencia**, pela mesma regra
-- de `mcp_sessions` (`015`): toda FK é `ON DELETE SET NULL` e ao lado de
-- cada uma há a **cópia** do que a guia mostra — `skill_slug`/`skill_name`,
-- `virtual_mcp_slug`/`virtual_mcp_name`, `key_name`, `api_key_name` e
-- `user_email` — gravada na escrita. Apagar a skill, o vMCP, a chave ou a
-- conta não apaga o que aconteceu, e a guia continua legível depois que o
-- objeto sumiu; o uuid nulo é o que diz que sumiu.
--
-- Os catálogos por onde a skill chegou ao vMCP **nesta leitura** ficam em
-- três arrays paralelos (`catalog_uuids`, `catalog_slugs`, `catalog_names`,
-- mesma posição = mesmo catálogo), e não numa tabela de junção: uma leitura
-- passa por poucos catálogos (a maioria por nenhum — vínculo direto, site,
-- mcp-admin), a escrita é um INSERT só e o filtro "acessos deste catálogo"
-- é o índice GIN sobre `catalog_uuids`. Sem FK, o uuid de um catálogo
-- apagado fica no array; é a listagem que o devolve nulo, conferindo
-- `catalogs` — o mesmo sinal das outras colunas, calculado em vez de
-- gravado. São os mesmos catálogos que receberam o contador: ligados, com a
-- participação ativa e vinculados ao vMCP, e só quando não há vínculo
-- direto (a precedência de `docs/11-catalogos.md` §3.2).
--
-- `session_id` é o `mcp-session-id`, o `sessionId` do SSE ou a chave
-- sintética do stateless — o que `mcp_sessions.session_id` guarda —, para
-- a guia agrupar leituras de uma sessão; sem FK, porque a sessão não é
-- única lá. `ip`, `user_agent`, `client_name` e `client_version` seguem o
-- `015`: o IP já resolvido pelo `trust proxy` e o `clientInfo` do
-- `initialize`, quando o servidor o conhece.
--
-- Índices, todos com `created_at DESC` porque toda leitura é "as últimas":
-- por skill (a guia da skill), por catálogo (GIN — a guia do catálogo faz
-- `catalog_uuids @> ARRAY[uuid]` e ordena o resultado), por vMCP (a guia do
-- servidor, e a varredura do SET NULL) e global (uma lista geral futura).
-- `key_id`, `api_key_id` e `user_uuid` ganham índice simples só pela
-- varredura do SET NULL — sem ele, apagar uma conta leria a tabela inteira.
--
-- **Sem poda.** A decisão é a de `mcp_sessions` (`docs/10` decisão 8):
-- nunca apagar. Não há job, trigger nem retenção; se um dia for preciso, é
-- uma migration com a política escrita, não um DELETE numa query.
--
-- Efeito sobre dados existentes: nenhum. A tabela nasce vazia e os
-- contadores antigos continuam onde estão; as leituras anteriores a esta
-- migration não têm linha — os contadores são a única memória delas.

-- ---------------------------------------------------------- skill_accesses ---
CREATE TABLE IF NOT EXISTS skill_accesses (
    id               UUID PRIMARY KEY DEFAULT uuidv7(),
    skill_uuid       UUID REFERENCES skills(uuid) ON DELETE SET NULL,
    skill_slug       TEXT NOT NULL,
    skill_name       TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('view', 'download')),
    surface          TEXT NOT NULL CHECK (
                         surface IN ('tool', 'resource', 'prompt', 'file', 'download', 'page', 'admin-tool')
                     ),
    origin           TEXT NOT NULL CHECK (origin IN ('mcp', 'site', 'mcp-admin')),
    auth             TEXT NOT NULL CHECK (auth IN ('open', 'key', 'user', 'anonymous')),
    virtual_mcp_uuid UUID REFERENCES virtual_mcps(uuid) ON DELETE SET NULL,
    virtual_mcp_slug TEXT,
    virtual_mcp_name TEXT,
    catalog_uuids    UUID[] NOT NULL DEFAULT '{}',
    catalog_slugs    TEXT[] NOT NULL DEFAULT '{}',
    catalog_names    TEXT[] NOT NULL DEFAULT '{}',
    key_id           UUID REFERENCES virtual_mcp_keys(id) ON DELETE SET NULL,
    key_name         TEXT,
    api_key_id       UUID REFERENCES api_keys(id) ON DELETE SET NULL,
    api_key_name     TEXT,
    user_uuid        UUID REFERENCES users(uuid) ON DELETE SET NULL,
    user_email       TEXT,
    session_id       TEXT,
    ip               TEXT,
    user_agent       TEXT,
    client_name      TEXT,
    client_version   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Os três arrays descrevem os mesmos catálogos, posição a posição: um
-- comprimento diferente seria uma linha que ninguém sabe ler. DROP + ADD
-- porque o Postgres não tem `ADD CONSTRAINT IF NOT EXISTS`.
ALTER TABLE skill_accesses DROP CONSTRAINT IF EXISTS skill_accesses_catalogs_parallel_chk;
ALTER TABLE skill_accesses ADD CONSTRAINT skill_accesses_catalogs_parallel_chk
    CHECK (
        cardinality(catalog_uuids) = cardinality(catalog_slugs)
        AND cardinality(catalog_uuids) = cardinality(catalog_names)
    );

-- A guia "Acessos" da skill, e a varredura do SET NULL quando ela é apagada.
CREATE INDEX IF NOT EXISTS skill_accesses_skill_created_idx
    ON skill_accesses (skill_uuid, created_at DESC);

-- A guia "Acessos" do catálogo: `catalog_uuids @> ARRAY[uuid]`.
CREATE INDEX IF NOT EXISTS skill_accesses_catalog_uuids_idx
    ON skill_accesses USING GIN (catalog_uuids);

-- A guia do servidor, e a varredura do SET NULL quando o vMCP é apagado.
CREATE INDEX IF NOT EXISTS skill_accesses_virtual_mcp_created_idx
    ON skill_accesses (virtual_mcp_uuid, created_at DESC);

-- Uma lista global, sem filtro.
CREATE INDEX IF NOT EXISTS skill_accesses_created_idx
    ON skill_accesses (created_at DESC);

-- Só a varredura do SET NULL: revogar não apaga, mas a cascata do vMCP
-- apaga as chaves `psv_`, e apagar a conta apaga as `psk_`.
CREATE INDEX IF NOT EXISTS skill_accesses_key_id_idx
    ON skill_accesses (key_id);

CREATE INDEX IF NOT EXISTS skill_accesses_api_key_id_idx
    ON skill_accesses (api_key_id);

CREATE INDEX IF NOT EXISTS skill_accesses_user_uuid_idx
    ON skill_accesses (user_uuid);
