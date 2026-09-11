-- Purple Skills — chaves gerenciadas do MCP público principal.
--
-- Problema: o MCP público principal só conhece dois estados. Ou é **aberto**
-- (sem `MCP_PUBLIC_KEY`), ou é protegido por uma **única** chave de ambiente
-- que todo cliente compartilha — tirar o acesso de um agente significa trocar
-- a env e reconfigurar todos os outros, e não há como saber qual deles usou a
-- chave por último. O MCP virtual (`009`) já resolveu isso para os servidores
-- de recorte com as chaves `psv_`; o principal ficou para trás. Desenho em
-- `docs/08-mcp-virtual.md` §7 (PR2).
--
-- `public_mcp_keys` é a **terceira forma** de proteger o principal:
-- `MCP_PUBLIC_AUTH=managed`. Nesse modo o servidor aceita as chaves desta
-- tabela (e ainda a `MCP_PUBLIC_KEY`, se definida, para a transição). A env
-- explícita existe para que emitir a primeira chave **não** tranque um
-- servidor que estava aberto. As chaves são emitidas **só por admin**, no
-- painel e pelo mcp-admin, e revogadas uma a uma.
--
-- Formato: `psp_<prefixo>_<segredo>`, o mesmo das `psk_` (`005`) e `psv_`
-- (`009`). O banco guarda o `prefix` (público, único, indexado — é por ele que
-- a autenticação acha a linha) e o `key_hash` (scrypt do segredo); o segredo
-- em si aparece uma única vez, na emissão, e nunca é gravado.
--
-- Diferenças para as irmãs, de propósito:
--
--   * **sem FK de servidor.** O MCP principal é um só, então não há
--     `virtual_mcp_uuid` aqui — a tabela inteira é dele;
--   * **a chave é do servidor, não de um usuário.** Não carrega papel nem
--     escopo: quem a apresenta lê o que o principal publica, e só.
--     `created_by_user_uuid` é informativo (quem emitiu) e `ON DELETE SET
--     NULL` porque a chave sobrevive à remoção de quem a criou — o mesmo
--     de `virtual_mcp_keys`.
--
-- Revogar é `revoked_at = now()`, não DELETE: a chave revogada continua
-- explicando as linhas de auditoria que produziu.
--
-- Efeito sobre dados existentes: nenhum. A tabela nasce vazia, o servidor
-- continua em `open`/`key` até alguém ligar `managed`, e o CHECK de
-- `audit_log.action` só cresce (superconjunto do de `009`): nenhuma linha
-- existente passa a violá-lo.

-- ------------------------------------------------------- public_mcp_keys ---
CREATE TABLE IF NOT EXISTS public_mcp_keys (
    id                   UUID PRIMARY KEY DEFAULT uuidv7(),
    name                 TEXT NOT NULL,
    prefix               TEXT NOT NULL UNIQUE,
    key_hash             TEXT NOT NULL,
    created_by_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL,
    last_used_at         TIMESTAMPTZ,
    revoked_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A varredura do SET NULL quando a conta de quem emitiu é removida. A busca
-- da autenticação é pelo `prefix`, coberto pelo índice único da coluna.
CREATE INDEX IF NOT EXISTS public_mcp_keys_created_by_user_uuid_idx
    ON public_mcp_keys (created_by_user_uuid);

-- ------------------------------------------------------------- audit_log ---
-- Eventos das chaves do principal (`docs/08-mcp-virtual.md` §7): linhas sem
-- skill, com `target_label` = nome da chave. DROP + ADD porque o Postgres não
-- tem `ADD CONSTRAINT IF NOT EXISTS`; a lista repete a de `009` inteira, e
-- não só acrescenta, porque o CHECK é um objeto só.
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
        'mcp.key.revoke',
        'public.key.create',
        'public.key.revoke'
    )
);
