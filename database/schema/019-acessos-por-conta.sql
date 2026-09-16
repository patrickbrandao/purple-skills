-- Purple Skills — a guia "Acessos" da ficha de conta.
--
-- Problema: a ficha de usuário do painel passa a listar as leituras de skill
-- feitas pela conta — pelas chaves `psk_` do mcp-admin —, e a consulta é
-- `WHERE user_uuid = ? ORDER BY created_at DESC LIMIT n`. O `018` deu a
-- `user_uuid` um índice simples, pensado só para a varredura do `SET NULL`
-- quando a conta é removida: com ele, cada página da guia lê **todas** as
-- leituras da conta e as ordena. Um índice composto `(user_uuid, created_at
-- DESC)` percorre já na ordem da tela e para no `LIMIT`, como os de skill e
-- de vMCP do `018` — e, pela coluna líder, continua servindo à varredura do
-- `SET NULL`. O simples vira redundante e é derrubado aqui.
--
-- `api_key_id` fica com o índice simples: o filtro por chave vem junto com
-- o da conta (a chave é um subconjunto dela) e não há tela "só por chave".
--
-- Dois passos, nesta ordem: criar o composto antes de derrubar o simples,
-- para não haver instante sem índice sobre `user_uuid`. `IF NOT EXISTS` /
-- `IF EXISTS` tornam a re-execução um no-op; se o `018` for reaplicado
-- sozinho sobre uma base já no `019`, ele recria o simples e uma nova
-- passada deste arquivo o derruba de novo.
--
-- Efeito sobre dados existentes: nenhum — só índice.

-- ---------------------------------------------------------- skill_accesses ---
-- A guia "Acessos" da conta, e a varredura do SET NULL quando ela é apagada.
CREATE INDEX IF NOT EXISTS skill_accesses_user_created_idx
    ON skill_accesses (user_uuid, created_at DESC);

DROP INDEX IF EXISTS skill_accesses_user_uuid_idx;
