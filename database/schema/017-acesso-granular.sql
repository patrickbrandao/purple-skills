-- Purple Skills — acesso granular: dono de skill, concessões por objeto e o
-- flag "público".
--
-- Problema: depois do `016`, o papel global limita a **ação** e nunca o
-- **escopo** — todo editor edita qualquer skill e todo leitor lê todas, e a
-- única forma de colaborar num vMCP ou catálogo é ser o dono. Isso serve a
-- uma equipe pequena e deixa de servir quando a instalação abriga vários
-- times: não há como dar a alguém uma skill sem dar todas, nem marcar uma
-- skill como "qualquer um lê" sem servi-la por um vMCP aberto. Desenho
-- fechado em `docs/12-acesso-granular.md`.
--
-- Cinco peças:
--
--   * `users.role` troca `leitor` por `membro` (decisão 12): o nome mentia,
--     porque um membro passa a editar o que é seu. É a primeira migration do
--     projeto que reescreve um valor de enumeração — o `UPDATE` corre com o
--     CHECK antigo já derrubado e o novo ainda por criar.
--
--   * `skills.owner_user_uuid` (decisão 8) — a skill ganha dono, como o vMCP
--     (`009`) e o catálogo (`016`) já tinham, com o mesmo `ON DELETE SET NULL`:
--     sobrevive à conta e vira órfã, só do admin. `created_by_user_uuid` fica,
--     informativo. O backfill copia `created_by` uma única vez: o bloco só
--     roda quando a coluna ainda não existe, para uma re-execução não devolver
--     a quem criou uma skill que o dono transferiu ou deixou órfã de propósito.
--
--   * `skills.is_public` e `catalogs.is_public` (decisão 4) — "quem pode
--     ler": qualquer conta logada e o site anônimo. **Não** decide exposição
--     no MCP, que continua sendo vínculo (`012`). O `is_public` de skill
--     existiu entre `001` e `012` com outro sentido (o do MCP principal); esta
--     é uma coluna nova por coincidência de nome. vMCP não ganha flag: o
--     `is_open` que já existe é o "público" dele.
--
--   * `skill_grants`, `catalog_grants`, `virtual_mcp_grants` (decisão 16) —
--     uma tabela por tipo, sem polimorfismo: FK real nos dois lados é o que
--     garante que apagar um objeto ou uma conta não deixa concessão
--     pendurada, e é o padrão de `virtual_mcp_skills` e `catalog_skills`.
--     `level` é um dos três níveis cumulativos (`view` < `edit` < `manage`);
--     dono e admin não têm linha — o app recusa conceder a eles. O índice
--     reverso por `user_uuid` cobre a listagem "compartilhados comigo" e a
--     varredura do CASCADE quando a conta é removida.
--
--   * `audit_log.action` ganha as seis ações da decisão 17: `*.share` (com
--     `email:nível` em `target_label`, e o slug antes nos de catálogo e vMCP)
--     e `*.unshare`. Transferir o dono e ligar o flag público são `update` do
--     objeto, com o e-mail do novo dono no label.
--
-- A regra de quem enxerga o quê (`docs/12` §3.1) **não** mora no banco: é a
-- opção `viewer` das leituras em `queries.ts`, pelo motivo de sempre — o
-- `total` de `listSkills` e a contagem de tags não têm conserto depois.
--
-- Efeito sobre dados existentes: toda skill ganha dono (quem a criou) ou fica
-- órfã; nada nasce público; leitores viram membros e **deixam de ver** o que
-- não é deles, público ou exposto em vMCP aberto — é o propósito da mudança
-- (`docs/12` §9): o admin marca públicas as skills que devem continuar
-- visíveis, ou concede `view`. Editores deixam de editar skills que não são
-- deles; o backfill cobre quem criou, o resto é concessão ou transferência.
-- As três tabelas nascem vazias e o CHECK de `audit_log.action` só cresce.

-- ------------------------------------------------------------------ users ---
-- O UPDATE fica **entre** o DROP e o ADD: com o CHECK antigo de pé, gravar
-- `membro` é recusado; com o novo de pé antes do UPDATE, é o ADD que falha
-- nas linhas `leitor`. `users_role_check` é o nome gerado pelo CHECK inline
-- de `004-contas.sql`; DROP + ADD porque o Postgres não tem `ADD CONSTRAINT
-- IF NOT EXISTS`. Na segunda execução o UPDATE não acha linha nenhuma.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

UPDATE users SET role = 'membro' WHERE role = 'leitor';

ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'editor', 'membro'));

-- ----------------------------------------------------------------- skills ---
-- Coluna e backfill num bloco só, condicionado à coluna não existir: é o
-- que faz o backfill rodar **uma** vez. Um `ADD COLUMN IF NOT EXISTS`
-- seguido de `UPDATE ... WHERE owner_user_uuid IS NULL` re-preencheria, na
-- segunda passada, toda skill que ficou órfã de propósito.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'skills'
          AND column_name = 'owner_user_uuid'
    ) THEN
        RETURN;
    END IF;

    ALTER TABLE skills
        ADD COLUMN owner_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL;

    -- Quem criou vira dono; skill criada pelo bootstrap, pelo token global ou
    -- pelo seed (`created_by` nulo) fica órfã, só do admin.
    UPDATE skills SET owner_user_uuid = created_by_user_uuid;
END $$;

-- A listagem "minhas skills" e a varredura do SET NULL quando a conta é
-- removida, como em `virtual_mcps` e `catalogs`.
CREATE INDEX IF NOT EXISTS skills_owner_user_uuid_idx ON skills (owner_user_uuid);

-- Nada nasce público: o que já está em vMCP aberto continua visível pela
-- regra de exposição, e o que não está continua invisível fora do painel.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

-- --------------------------------------------------------------- catalogs ---
ALTER TABLE catalogs ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;

-- ----------------------------------------------------------- skill_grants ---
-- `(objeto, conta)` é a chave: uma concessão por par, e mudar o nível é
-- reescrever a linha. `granted_by_user_uuid` é informativo (quem concedeu) e
-- sobrevive à remoção de quem concedeu, como `virtual_mcp_keys.created_by`.
CREATE TABLE IF NOT EXISTS skill_grants (
    skill_uuid           UUID NOT NULL REFERENCES skills(uuid) ON DELETE CASCADE,
    user_uuid            UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
    level                TEXT NOT NULL CHECK (level IN ('view', 'edit', 'manage')),
    granted_by_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (skill_uuid, user_uuid)
);

-- A chave primária cobre a página do objeto ("quem tem acesso aqui?"); o
-- índice inverso cobre "compartilhados comigo" e o CASCADE da conta.
CREATE INDEX IF NOT EXISTS skill_grants_user_uuid_idx ON skill_grants (user_uuid);

-- --------------------------------------------------------- catalog_grants ---
CREATE TABLE IF NOT EXISTS catalog_grants (
    catalog_uuid         UUID NOT NULL REFERENCES catalogs(uuid) ON DELETE CASCADE,
    user_uuid            UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
    level                TEXT NOT NULL CHECK (level IN ('view', 'edit', 'manage')),
    granted_by_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (catalog_uuid, user_uuid)
);

CREATE INDEX IF NOT EXISTS catalog_grants_user_uuid_idx ON catalog_grants (user_uuid);

-- ----------------------------------------------------- virtual_mcp_grants ---
CREATE TABLE IF NOT EXISTS virtual_mcp_grants (
    virtual_mcp_uuid     UUID NOT NULL REFERENCES virtual_mcps(uuid) ON DELETE CASCADE,
    user_uuid            UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
    level                TEXT NOT NULL CHECK (level IN ('view', 'edit', 'manage')),
    granted_by_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (virtual_mcp_uuid, user_uuid)
);

CREATE INDEX IF NOT EXISTS virtual_mcp_grants_user_uuid_idx ON virtual_mcp_grants (user_uuid);

-- -------------------------------------------------------------- audit_log ---
-- As seis ações de concessão (`docs/12-acesso-granular.md` §8). `skill.share`
-- e `skill.unshare` levam `skill_uuid`/`skill_slug`, como `update`; as de
-- catálogo e vMCP levam `<slug> <email>:<nível>` (e `<slug> <email>` ao
-- revogar) em `target_label`, porque a coluna é uma só e a trilha precisa dos
-- dois. DROP + ADD porque o Postgres não tem `ADD CONSTRAINT IF NOT EXISTS`;
-- a lista repete a de `016` inteira, e não só acrescenta, porque o CHECK é
-- um objeto só.
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
        'skill.share',
        'skill.unshare',
        'catalog.share',
        'catalog.unshare',
        'mcp.share',
        'mcp.unshare',
        'public.key.create',
        'public.key.revoke'
    )
);
