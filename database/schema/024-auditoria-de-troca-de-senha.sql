-- Purple Skills — a troca de senha na trilha de auditoria.
--
-- Problema: redefinir a senha de **outra** conta não deixava rastro nenhum. O
-- admin abria a ficha, clicava em "Redefinir senha", recebia a senha temporária
-- na tela e a trilha não guardava nem quem pediu nem sobre quem — a linha mais
-- próxima era `user.deactivate`, de outro evento (`tasks/030`). O mesmo valia
-- para a senha trocada por um link de "esqueci a senha": o link era consumido,
-- a senha mudava, e só `reset_tokens.used_at` sabia disso.
--
-- O app já escreve a linha desde a rodada de correção dos relatórios, com a
-- ação `user.password`; faltava o banco aceitá-la. Sem esta migration o INSERT
-- é recusado pelo `CHECK`, a falha é engolida pelo `catch` de melhor esforço e
-- a senha é trocada sem registro.
--
-- Por que `user.password`, e não `user.password_reset`: nenhuma ação do
-- catálogo usa `_`, e o nome é o paralelo de `user.role` — o que mudou na
-- conta. O que a linha significa:
--
--   actor_label = e-mail do admin   a redefinição pelo painel;
--   actor_label = 'bootstrap'       a redefinição feita pela sessão de setup;
--   actor_label = 'link-de-redefinicao'
--                                   alguém que portava o link trocou a senha —
--                                   não necessariamente o dono da conta, e é
--                                   por isso que o ator não é ele;
--   target_label = e-mail da conta afetada.
--
-- A troca feita pelo próprio dono logado fica fora, como o login: quem age já
-- tem a senha atual na mão. Senha nenhuma (nem hash) entra na linha.
--
-- DROP + ADD porque não há `ADD CONSTRAINT IF NOT EXISTS`; a lista repete a de
-- `020-rag.sql` inteira, e não só acrescenta, porque o `CHECK` é um objeto só.
-- Idempotente: reaplicar recria a mesma constraint. Sobre dados existentes não
-- tem efeito — a lista só cresce, então nenhuma linha gravada passa a violá-la,
-- e a validação que o `ADD CONSTRAINT` faz na tabela inteira encontra tudo
-- dentro da lista nova.
--
-- O espelho em TypeScript é `AUDIT_ACTIONS` (`src/queries.ts`, o filtro de
-- `listAuditPage`) e o union de `recordAccountAudit`: os três andam juntos.

-- ------------------------------------------------------------- audit_log ---
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (
    action IN (
        'create',
        'update',
        'delete',
        'user.create',
        'user.role',
        'user.deactivate',
        'user.password',
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
        'public.key.revoke',
        'rag.settings',
        'rag.reindex'
    )
);
