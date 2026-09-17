-- Purple Skills — "Meu espaço → Chaves emitidas".
--
-- Problema: o painel passa a listar as chaves `psv_` que a conta logada
-- emitiu, em todos os vMCPs, com `listVirtualMcpKeysByCreator` — a consulta
-- é `WHERE created_by_user_uuid = ?`. O `009` só indexou `virtual_mcp_uuid`
-- (a listagem por servidor): sem índice em `created_by_user_uuid`, cada
-- abertura da tela varre a tabela inteira, e o `ON DELETE SET NULL` da
-- remoção de uma conta também. É o índice que o `010` já dava à irmã
-- `public_mcp_keys`.
--
-- Composto `(created_by_user_uuid, created_at DESC)`: a tela ordena as ativas
-- primeiro e depois por data, então o índice não entrega a ordem final, mas
-- entrega as linhas da conta já na ordem de data — o que resta é separar as
-- revogadas, barato no volume de chaves de uma conta. Pela coluna líder ele
-- continua servindo à varredura do `SET NULL`.
--
-- `IF NOT EXISTS` torna a re-execução um no-op. `CREATE INDEX` sem
-- `CONCURRENTLY` roda na transação do runner; a tabela é pequena e o bloqueio
-- de escrita dura o tempo da construção.
--
-- Efeito sobre dados existentes: nenhum — só índice.

-- ------------------------------------------------------ virtual_mcp_keys ---
-- As chaves emitidas por uma conta, e a varredura do SET NULL quando ela é
-- apagada.
CREATE INDEX IF NOT EXISTS virtual_mcp_keys_created_by_created_idx
    ON virtual_mcp_keys (created_by_user_uuid, created_at DESC);
