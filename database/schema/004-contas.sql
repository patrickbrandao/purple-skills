-- Purple Skills — contas de usuário, papéis e ator na auditoria.
--
-- Problema: o painel tem uma senha única (`ADMIN_PASSWORD`) e o MCP
-- administrativo um token único. O `audit_log` registra a **superfície**
-- (`web-admin` / `mcp-admin`), nunca o **ator** — "quem apagou essa skill?"
-- não tem resposta. Também não há revogação individual nem grau de poder.
-- Desenho aprovado em `docs/05-accounts-and-roles.md` §2 e §3.
--
-- Esta migration cria `users` e liga as tabelas existentes a ela:
--
--   * `skills.created_by_user_uuid` é **informativo** (§2.1): não existe
--     ownership, o papel limita a ação e não o escopo. `ON DELETE SET NULL`
--     porque a skill sobrevive à remoção de quem a criou.
--   * `audit_log` ganha `actor_user_uuid` + `actor_label`. O label é obrigatório
--     na prática porque nem todo ator é uma conta: o `MCP_ADMIN_TOKEN`
--     (`token-global`) e o bootstrap do primeiro admin gravam UUID nulo.
--   * `audit_log.target_label` **é uma extensão ao §3 da spec**. Sem ela um
--     evento de conta não diz *sobre quem* foi — "admin trocou o papel de
--     quem?" — porque `skill_slug` e `file_path` ficam nulos nessas linhas e
--     não há a que fazer JOIN depois que a conta alvo é removida. Guarda o
--     e-mail do usuário ou o nome da chave, congelado no momento do evento.
--
-- Efeito sobre dados existentes: nenhum. As colunas nascem nulas, `users`
-- nasce vazia (é o que mantém `/setup` disponível numa instalação já no ar) e
-- as linhas de auditoria antigas continuam sem ator, o que é verdade — elas
-- foram gravadas quando não havia contas.

-- ----------------------------------------------------------------- users ---
-- `password_hash` nulo = conta que só entra por OIDC.
-- `token_version` é a alavanca de revogação da sessão stateless (§2.2):
-- trocar senha, mudar papel ou desativar incrementa, e todo cookie emitido
-- antes deixa de valer na requisição seguinte.
-- `locked_until` + `failed_attempts` são a camada persistente do rate limiting
-- do login (§2.7) — a janela em memória por IP não sobrevive a restart nem
-- vale para múltiplos containers do painel.
CREATE TABLE IF NOT EXISTS users (
    uuid                 UUID PRIMARY KEY DEFAULT uuidv7(),
    email                TEXT NOT NULL,
    name                 TEXT NOT NULL,
    password_hash        TEXT,
    role                 TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'leitor')),
    is_active            BOOLEAN NOT NULL DEFAULT true,
    token_version        INTEGER NOT NULL DEFAULT 0,
    must_change_password BOOLEAN NOT NULL DEFAULT false,
    oidc_issuer          TEXT,
    oidc_subject         TEXT,
    locked_until         TIMESTAMPTZ,
    failed_attempts      INTEGER NOT NULL DEFAULT 0,
    last_login_at        TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unicidade por `lower(email)`: a vinculação OIDC ↔ conta local é sempre pelo
-- e-mail (§2.4), e a mesma pessoa não pode virar duas contas por causa da
-- caixa. Toda busca por e-mail usa `lower(email) = lower($1)` e cai neste
-- índice.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq ON users (lower(email));

-- Parcial: contas locais têm os dois campos nulos e não devem colidir entre si
-- num índice de duas colunas nulas.
CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_uniq
    ON users (oidc_issuer, oidc_subject)
    WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;

-- ---------------------------------------------------------------- skills ---
-- `ADD COLUMN IF NOT EXISTS` com `REFERENCES` inline é idempotente: numa
-- segunda execução o comando inteiro é pulado, constraint junto.
ALTER TABLE skills
    ADD COLUMN IF NOT EXISTS created_by_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL;

-- Chave estrangeira sem índice transforma a remoção de uma conta num seq scan
-- da tabela referenciada.
CREATE INDEX IF NOT EXISTS skills_created_by_idx ON skills (created_by_user_uuid);

-- ------------------------------------------------------------- audit_log ---
ALTER TABLE audit_log
    ADD COLUMN IF NOT EXISTS actor_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_label TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS target_label TEXT;

CREATE INDEX IF NOT EXISTS audit_log_actor_user_uuid_idx ON audit_log (actor_user_uuid);

-- Eventos de conta (§2.8). Login e falha de login ficam **de fora**: quem os
-- trata é o rate limiting, e auditá-los mudaria a ordem de grandeza do log.
-- `audit_log_action_check` é o nome gerado pelo CHECK inline de `001-init.sql`;
-- DROP + ADD porque o Postgres não tem `ADD CONSTRAINT IF NOT EXISTS`.
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
        'key.revoke'
    )
);
