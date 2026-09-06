-- Purple Skills — tokens de uso único para redefinição de senha.
--
-- Problema: sem esta tabela, "esqueci a senha" só existe pelo caminho do
-- admin gerando senha temporária. Com SMTP configurado o painel manda um link,
-- e o link precisa de um segredo que expira e **queima ao ser usado**
-- (`docs/05-accounts-and-roles.md` §2.6).
--
-- Só o hash do token é gravado: quem lê o banco não consegue redefinir senha
-- de ninguém. `token_hash` é único porque o consumo é um `UPDATE ... WHERE
-- token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING`, e é
-- a atomicidade desse UPDATE que impede dois cliques no mesmo link de
-- redefinirem a senha duas vezes.
--
-- Linhas expiradas não são apagadas por trigger nem por job: ficam como
-- registro de tentativa e são baratas. Se um dia incomodarem, a limpeza é um
-- DELETE por `expires_at`.
--
-- Efeito sobre dados existentes: nenhum, a tabela nasce vazia.

CREATE TABLE IF NOT EXISTS reset_tokens (
    id         UUID PRIMARY KEY DEFAULT uuidv7(),
    user_uuid  UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tokens de uma conta (invalidar os anteriores ao emitir um novo) e a
-- varredura do CASCADE quando a conta é removida.
CREATE INDEX IF NOT EXISTS reset_tokens_user_uuid_idx ON reset_tokens (user_uuid);
