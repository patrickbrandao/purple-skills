-- Purple Skills — o link de redefinição de senha que foi substituído.
--
-- Problema: o comentário do índice `reset_tokens_user_uuid_idx`, em
-- `006-reset-tokens.sql`, promete "invalidar os anteriores ao emitir um novo".
-- Esse passo nunca foi escrito: `createResetToken` só fazia o INSERT, então
-- pedir "esqueci a senha" cinco vezes deixava **cinco links válidos ao mesmo
-- tempo**, cada um vivo até o próprio prazo (`PASSWORD_RESET_TTL`, uma hora no
-- padrão). Pior: trocar a senha não tocava os demais, nem por link, nem pelo
-- reset do admin, nem pela troca feita pelo próprio dono — um link vazado
-- continuava redefinindo a senha depois que a pessoa achava que havia
-- resolvido o problema (`tasks/027`, adjacente ao `tasks/003`, onde o atacante
-- escolhia o domínio do link que chegava à vítima).
--
-- Por que uma coluna nova, e não `used_at = now()` nos anteriores: `used_at`
-- significa "este link redefiniu a senha" — é o par da linha `user.password`
-- com ator `link-de-redefinicao` na trilha de auditoria (`tasks/030`). Marcá-lo
-- num link em que ninguém clicou faria a tabela mentir e tornaria "quantos
-- links foram de fato usados" incontável. Apagar a linha destrói o registro da
-- tentativa, que o `006` guarda de propósito (é como se vê alguém pedindo
-- redefinição da senha de outra pessoa em série). Com `superseded_at`, cada
-- linha fica em **um** de três estados, e os três são contáveis:
--
--   used_at NOT NULL         o link redefiniu a senha;
--   superseded_at NOT NULL   o link estava vivo e foi fechado sem uso, por um
--                            pedido novo ou pela troca da senha;
--   os dois nulos            em aberto — vivo se `expires_at > now()`, morto
--                            por prazo se não.
--
-- O fechamento só toca link **vivo** justamente para o terceiro estado
-- continuar dizendo a verdade: link que venceu sem ninguém clicar permanece
-- "morto por prazo" em vez de ser reetiquetado como substituído.
--
-- Quem fecha, e por quê em dois lugares:
--
--   * na emissão, `createResetToken` (uma statement só, com a CTE que fecha os
--     anteriores antes do INSERT) — é o pedido que o `006` já anunciava;
--   * na troca da senha, o trigger abaixo, em `users`. Fica no banco, e não no
--     app, porque são três caminhos que trocam senha (o link consumido, o reset
--     do admin e a troca pelo próprio dono, todos por `updateUser`) e porque a
--     regra é do dado: **senha nova, nenhum link antigo serve**. Um caminho
--     novo a herda sem precisar lembrar dela.
--
-- O `CHECK` fecha o par: uma linha não pode dizer as duas coisas. A trava
-- existente `reset_tokens_user_uuid_idx` (`006`) já cobre o `WHERE user_uuid =
-- $1` das duas escritas — nenhum índice novo.
--
-- Não há unicidade parcial ("no máximo um link vivo por conta"): dois pedidos
-- simultâneos não veem a linha um do outro (cada um lê o snapshot anterior ao
-- próprio comando) e o UNIQUE transformaria um duplo clique em erro 500 no
-- "esqueci a senha". Os dois links nasceram do mesmo pedido, do mesmo dono, e o
-- pedido seguinte fecha os dois.
--
-- Efeito sobre dados existentes: a coluna nasce nula em toda linha, e o
-- backfill do fim fecha os links vivos que já coexistem, **menos o mais
-- recente de cada conta** — o que a pessoa acabou de pedir e tem na caixa de
-- entrada. Sem ele a janela que este arquivo fecha continuaria aberta por um
-- TTL depois da atualização. Quem tiver um link antigo na mão pede outro.
--
-- Idempotente: `ADD COLUMN IF NOT EXISTS`, `DROP … IF EXISTS` antes do CHECK e
-- do trigger, `CREATE OR REPLACE` na função, e o backfill que numa segunda
-- passada não acha nenhuma linha (depois dele sobra, no máximo, um link vivo
-- por conta).

-- ----------------------------------------------------------- reset_tokens ---
ALTER TABLE reset_tokens ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

-- DROP + ADD porque o Postgres não tem `ADD CONSTRAINT IF NOT EXISTS`; o CHECK
-- é de tabela porque olha duas colunas.
ALTER TABLE reset_tokens DROP CONSTRAINT IF EXISTS reset_tokens_estado_chk;
ALTER TABLE reset_tokens ADD CONSTRAINT reset_tokens_estado_chk
    CHECK (used_at IS NULL OR superseded_at IS NULL);

-- ---------------------------------------- senha nova fecha os links vivos ---
-- `AFTER UPDATE OF password_hash` já limita o gatilho às escritas que mexem na
-- coluna; o `WHEN` tira as que a regravam com o mesmo valor. Um logout
-- (`token_version`), uma troca de papel ou uma desativação não chegam aqui.
--
-- O link que **acabou de ser consumido** não é tocado: ele já tem `used_at`, e
-- o UPDATE só olha os abertos. É isso que mantém `used_at` como o registro de
-- quem realmente redefiniu a senha.
CREATE OR REPLACE FUNCTION users_password_reset_tokens_tg() RETURNS TRIGGER AS $$
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

DROP TRIGGER IF EXISTS users_password_reset_tokens_trg ON users;
CREATE TRIGGER users_password_reset_tokens_trg
    AFTER UPDATE OF password_hash ON users
    FOR EACH ROW
    WHEN (NEW.password_hash IS DISTINCT FROM OLD.password_hash)
    EXECUTE FUNCTION users_password_reset_tokens_tg();

-- ------------------------------------------------------------- backfill -----
-- Fecha os links vivos que coexistem hoje, preservando o mais recente de cada
-- conta (`created_at`, com o `id` desempatando — `uuidv7()` é ordenado no
-- tempo). Roda em qualquer base: numa instalação sem link vivo não toca nada, e
-- numa segunda execução não acha mais ninguém com irmão mais novo.
UPDATE reset_tokens AS t
   SET superseded_at = now()
 WHERE t.used_at IS NULL
   AND t.superseded_at IS NULL
   AND t.expires_at > now()
   AND EXISTS (
       SELECT 1
         FROM reset_tokens AS mais_novo
        WHERE mais_novo.user_uuid = t.user_uuid
          AND mais_novo.used_at IS NULL
          AND mais_novo.superseded_at IS NULL
          AND mais_novo.expires_at > now()
          AND (mais_novo.created_at, mais_novo.id) > (t.created_at, t.id)
   );
