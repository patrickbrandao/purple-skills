-- Purple Skills — chaves de API por usuário para o MCP administrativo.
--
-- Problema: o `MCP_ADMIN_TOKEN` é único e compartilhado. Todo agente MCP fala
-- com o mesmo poder e sob a mesma identidade; tirar o acesso de um significa
-- trocar o token de todos, e o `audit_log` não sabe qual agente escreveu.
-- Desenho em `docs/05-accounts-and-roles.md` §2.5.
--
-- A chave tem o formato `psk_<prefixo>_<segredo>` e aparece por inteiro uma
-- única vez, na emissão. O banco guarda:
--
--   * `prefix` — público, único e indexado. É por ele que `requireBearer`
--     encontra a linha, sem varrer a tabela comparando hash por hash;
--   * `key_hash` — scrypt do segredo. O segredo em si nunca é gravado.
--
-- Revogar é `revoked_at = now()`, não DELETE: a chave revogada continua
-- explicando as linhas de auditoria que ela produziu. `ON DELETE CASCADE` no
-- dono porque uma chave sem usuário não autentica ninguém — e a política do
-- projeto é desativar a conta, não removê-la.
--
-- Efeito sobre dados existentes: nenhum, a tabela nasce vazia. O
-- `MCP_ADMIN_TOKEN` continua válido em paralelo (§2.3), como ator
-- `token-global` e sem linha aqui.

CREATE TABLE IF NOT EXISTS api_keys (
    id           UUID PRIMARY KEY DEFAULT uuidv7(),
    user_uuid    UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL UNIQUE,
    key_hash     TEXT NOT NULL,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Listagem das chaves de uma conta (tela "minhas chaves") e a varredura do
-- CASCADE quando a conta é removida.
CREATE INDEX IF NOT EXISTS api_keys_user_uuid_idx ON api_keys (user_uuid);
