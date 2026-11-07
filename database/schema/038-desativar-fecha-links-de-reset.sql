-- Purple Skills — desativar a conta fecha os links de redefinição vivos.
--
-- Problema (`tasks/014` da auditoria de 2026-11-07): o `023` fecha os links
-- vivos quando a **senha** muda, e o próprio comentário dele avisa que "uma
-- desativação não chega aqui". Um link pedido com a conta ativa continuava
-- valendo depois de o admin desativá-la: quem o tinha na mão — talvez quem
-- invadiu a caixa de e-mail, que pode ser o motivo da desativação — trocava a
-- senha da conta desativada, já com `must_change_password` desligado, e era
-- essa senha que passava a valer na reativação. A desativação não era a
-- contenção completa que o `docs/05` §2.5 dá a entender.
--
-- Correção: um segundo trigger em `users`, irmão do `023`, que fecha os links
-- vivos da conta quando `is_active` passa de `true` para `false`. A regra fica
-- no banco pelo mesmo motivo da `023`: é do dado — **conta desativada, nenhum
-- link antigo serve** —, e qualquer caminho que desative a conta (o painel, o
-- mcp-admin, um script) a herda. A outra metade é do app: a confirmação do
-- link confere `isActive` da conta, o que cobre a corrida entre consumir o
-- link e trocar a senha, que nenhum trigger alcança.
--
-- O fechamento é o `superseded_at` do `023`, não `used_at`: ninguém redefiniu
-- a senha com esses links. Só link **vivo** é tocado — o vencido continua
-- "morto por prazo", como na `023`.
--
-- Reativar **não** reabre nada: o link fechado continua fechado, e quem quiser
-- redefinir a senha pede outro depois da reativação.
--
-- Função própria, e não a `users_password_reset_tokens_tg()` do `023`: o corpo
-- é o mesmo hoje, mas as duas regras podem divergir, e a `023` reaplicada não
-- deve alcançar este trigger.
--
-- Efeito sobre dados existentes: o backfill do fim fecha os links vivos de
-- conta **já desativada** — os que o trigger teria fechado se existisse na
-- época. Conta ativa não é tocada.
--
-- Idempotente: `CREATE OR REPLACE` na função, `DROP TRIGGER IF EXISTS` antes do
-- `CREATE TRIGGER`, e o backfill que numa segunda passada não acha link aberto
-- de conta desativada.

-- -------------------------------------- desativação fecha os links vivos ---
-- `AFTER UPDATE OF is_active` limita o gatilho às escritas que citam a coluna;
-- o `WHEN` tira as que não a mudam de `true` para `false` (regravar `false`,
-- reativar). Uma troca de papel, um logout ou uma troca de senha não chegam
-- aqui — a de senha é do trigger do `023`.
CREATE OR REPLACE FUNCTION users_deactivation_reset_tokens_tg() RETURNS TRIGGER AS $$
BEGIN
    UPDATE reset_tokens
       SET superseded_at = now()
     WHERE user_uuid = NEW.uuid
       AND used_at IS NULL
       AND superseded_at IS NULL
       AND expires_at > now();
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_deactivation_reset_tokens_trg ON users;
CREATE TRIGGER users_deactivation_reset_tokens_trg
    AFTER UPDATE OF is_active ON users
    FOR EACH ROW
    WHEN (OLD.is_active AND NOT NEW.is_active)
    EXECUTE FUNCTION users_deactivation_reset_tokens_tg();

-- ------------------------------------------------------------- backfill -----
-- Os links vivos de quem já está desativado. Numa instalação sem esse caso não
-- toca nada; numa segunda execução não acha mais ninguém.
UPDATE reset_tokens AS t
   SET superseded_at = now()
  FROM users AS u
 WHERE u.uuid = t.user_uuid
   AND NOT u.is_active
   AND t.used_at IS NULL
   AND t.superseded_at IS NULL
   AND t.expires_at > now();
