-- Purple Skills — o vínculo de identidade OIDC e a reativação de conta na trilha.
--
-- Problema: dois eventos que mudam **quem consegue entrar numa conta** não
-- cabiam na trilha de auditoria (`tasks/003`), e por isso não deixavam rastro:
--
--   * o primeiro login por SSO cujo e-mail bate com uma conta local grava
--     `oidc_issuer`/`oidc_subject` nela. É o que o painel chama de "vincular é
--     assumir a conta" — com o papel, o que ela possui e o que lhe foi
--     concedido —, e acontece uma vez por conta. O caminho vizinho, a conta
--     **criada** por SSO, já era auditado (`user.create`);
--   * `user.deactivate` é auditado e o sentido contrário não. Reativar devolve
--     de uma vez o login, as concessões (as linhas ficam inertes, não somem) e
--     todas as chaves `psk_` da conta. A trilha mostrava duas desativações
--     seguidas sem dizer quem religou a conta no meio.
--
-- Não é esquecimento de uma chamada no app: faltava a **ação**. O `CHECK` de
-- `audit_log.action` é uma lista fechada, e um INSERT com qualquer das duas era
-- recusado.
--
--   user.activate  o par de `user.deactivate`.
--                  actor_label  = e-mail do admin (ou 'bootstrap');
--                  target_label = e-mail da conta reativada.
--   user.link      uma identidade externa passou a abrir uma conta que já
--                  existia. O ator é o **caminho**, como 'link-de-redefinicao'
--                  em `user.password` (`024`): quem chegou é uma identidade do
--                  provedor, não uma conta.
--                  actor_label  = 'oidc:<issuer>', o mesmo rótulo do
--                                 `user.create` por SSO;
--                  target_label = e-mail da conta e o `subject` que a assumiu.
--
-- Nomes sem `_`, como o resto do catálogo. Login e falha de login continuam
-- **fora** da trilha (`docs/05-accounts-and-roles.md` §2.8): o critério ali é
-- volume, e nenhum destes dois tem esse perfil — o vínculo é uma vez por conta,
-- a reativação é ato administrativo raro.
--
-- DROP + ADD porque não há `ADD CONSTRAINT IF NOT EXISTS`; a lista repete a de
-- `024-auditoria-de-troca-de-senha.sql` inteira, e não só acrescenta, porque o
-- `CHECK` é um objeto só. **Quem mexer neste `CHECK` depois parte desta lista**:
-- uma migration que repita a do `024` apaga as duas ações daqui.
--
-- Idempotente: reaplicar recria a mesma constraint. Sobre dados existentes não
-- tem efeito — a lista só cresce, então nenhuma linha gravada passa a violá-la.
-- O `ADD CONSTRAINT` valida a tabela inteira sob ACCESS EXCLUSIVE, como nas
-- oito vezes anteriores; `audit_log` nunca é podada, e com 200 mil linhas a
-- migration inteira mede dezenas de milissegundos.
--
-- O espelho em TypeScript é `AUDIT_ACTIONS` (`src/queries.ts`, o filtro de
-- `listAuditPage`), o union de `recordAccountAudit` e `AuditAction` de
-- `@purple-skills/shared`: os quatro andam juntos.

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
        'user.activate',
        'user.password',
        'user.link',
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
