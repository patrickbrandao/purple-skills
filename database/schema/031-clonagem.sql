-- Purple Skills — clonagem: as três ações de cópia na trilha de auditoria.
--
-- Problema: duplicar uma skill, um catálogo ou um MCP virtual era refazer tudo
-- à mão — criar o objeto, reenviar os arquivos, recriar os vínculos — e o que
-- saía disso não tinha origem registrada em lugar nenhum. A clonagem faz a
-- cópia numa transação só (`cloneSkill`, `cloneCatalog`, `cloneVirtualMcp` em
-- `src/queries.ts`), e a trilha precisa de um evento próprio para ela: sem
-- isso, o clone entraria como uma criação comum e ninguém saberia depois de
-- quem ele saiu.
--
-- O que este arquivo faz: **só** o CHECK de `audit_log.action`, acrescentando
--
--   * `skill.clone`   — a cópia de uma skill, com `skill_uuid`/`skill_slug` da
--                       **cópia**, como as demais linhas de skill;
--   * `catalog.clone` — a cópia de um catálogo;
--   * `mcp.clone`     — a cópia de um MCP virtual.
--
-- Nos três, `target_label` é `<slug de origem> -> <slug da cópia>`, a mesma
-- gramática de `quarantine.promote` (`030`) — é o único lugar onde os dois
-- lados da cópia aparecem juntos. Uma linha só por clonagem, no objeto novo:
-- o clone **não** grava também a `create`/`catalog.create`/`mcp.create` do
-- objeto, senão a mesma operação apareceria duas vezes na trilha.
--
-- Nenhuma coluna, nenhuma tabela e nenhum dado: o que a clonagem copia já cabe
-- inteiro nas tabelas que existem, e o que ela **não** copia — chave `psv_`
-- (o segredo não é guardado e `prefix` é UNIQUE), contadores, sessões,
-- acessos, histórico — não precisa de coluna nova para ficar de fora.
--
-- DROP + ADD porque não há `ADD CONSTRAINT IF NOT EXISTS`; a lista repete a de
-- `030-quarentena.sql` inteira, e não só acrescenta, porque o CHECK é um
-- objeto só. **Quem mexer neste CHECK depois parte desta lista**: uma
-- migration que repita a do `030` apaga as três daqui.
--
-- O espelho em TypeScript é `AUDIT_ACTIONS` (`src/queries.ts`, o filtro de
-- `listAuditPage`) e `AuditAction` de `@purple-skills/shared`: os três andam
-- juntos.
--
-- Efeito sobre dados existentes: **nenhum.** O CHECK só cresce — nenhuma linha
-- gravada passa a violá-lo, e a validação da constraint nova varre a tabela
-- uma vez (é o preço de todo `ADD CONSTRAINT` aqui desde o `004`).
--
-- Idempotente: `DROP … IF EXISTS` antes do `ADD`. Reaplicar não muda nada.

-- -------------------------------------------------------------- audit_log ---
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
        'skill.clone',
        'catalog.clone',
        'mcp.clone',
        'public.key.create',
        'public.key.revoke',
        'rag.settings',
        'rag.reindex',
        'quarantine.create',
        'quarantine.update',
        'quarantine.delete',
        'quarantine.promote',
        'quarantine.settings'
    )
);
