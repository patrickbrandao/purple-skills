-- Purple Skills — instruções do MCP virtual: a mensagem de sistema do servidor.
--
-- Problema: o mcp-public monta o `instructions` do `initialize` MCP com um
-- texto-base, igual em todo servidor, mais a `description` do vMCP
-- (`docs/08-mcp-virtual.md` decisão 15 e §4.4). A mesma coluna servia a dois
-- leitores que querem coisas diferentes: o **humano** que lista e busca
-- servidores no painel e no site, para quem ela é uma legenda ("o servidor do
-- time de dados, mantido pela Ana"), e o **agente** que conecta, para quem
-- tudo o que chega ali é orientação de uso. Escrever a legenda mudava o que o
-- agente recebia, e escrever para o agente enchia a listagem de imperativos em
-- inglês. O mantenedor separou as duas (o que revoga a decisão 15 do `08`):
--
--   * `description` fica **só** exibição e comentário — listagens, buscas, o
--     cartão do site. Não vai mais ao agente;
--   * `instructions` (coluna nova) é a mensagem de sistema do servidor: é o
--     que o mcp-public acrescenta ao texto-base no `initialize`. Vazia = só o
--     texto-base.
--
-- O teto de 4 000 caracteres é o `VIRTUAL_MCP_INSTRUCTIONS_MAX` de
-- `packages/shared/src/types.ts`, e **os dois andam juntos**: mudar um sem o
-- outro faz o app aceitar o que o banco recusa (500 em vez de 400) ou recusar
-- o que o banco aceitaria. As queries conferem o tamanho antes do INSERT e
-- respondem 400 com a mensagem certa; o CHECK é a garantia que vale para
-- qualquer caminho de escrita. `char_length` conta caracteres, não bytes nem
-- unidades UTF-16 — o app conta do mesmo jeito (por code point).
--
-- **Por que há backfill.** Sem ele, todo servidor existente perderia no dia da
-- atualização o que o agente recebe hoje: a `description` deixa de ir ao
-- `initialize` e `instructions` nasceria vazia. O backfill copia a
-- `description` atual para `instructions` em cada linha que tem uma, para o
-- agente continuar recebendo o mesmo texto até o dono reescrevê-lo — e a partir
-- daí as duas seguem cada uma o seu caminho. A `description` fica **intacta**:
-- nada aqui a apaga nem a reescreve.
--
-- O backfill roda **uma vez**. Coluna e cópia estão num bloco só, condicionado
-- à coluna ainda não existir — o molde do `owner_user_uuid` do `017`. Um
-- `ADD COLUMN IF NOT EXISTS` seguido de `UPDATE … WHERE instructions = ''`
-- devolveria, numa re-execução, as instruções que o dono **apagou de
-- propósito** depois da atualização.
--
-- Efeito sobre dados existentes: todo vMCP ganha `instructions`; nos que têm
-- `description` não vazia ela é a cópia da `description`, cortada em 4 000
-- caracteres (`left`) — a `description` não tem teto, e a rara que passar
-- disso chega ao agente cortada no fim, em vez de derrubar a migration pelo
-- CHECK. Os sem `description` ficam com `''`. `updated_at` **não** muda: não
-- há trigger de carimbo em `virtual_mcps` (`009`), e a cópia não é edição de
-- ninguém. O `ADD COLUMN` com DEFAULT constante não reescreve a tabela; o
-- `UPDATE` reescreve só as linhas com `description`, e `virtual_mcps` é uma
-- tabela de painel (dezenas de linhas).
--
-- Idempotente: o bloco sai logo na segunda execução, com a coluna já lá;
-- o CHECK é inline no `ADD COLUMN` e é pulado junto com ele (como em `013` e
-- `014`). Reaplicar não muda nada.

-- ---------------------------------------------------------- virtual_mcps ---
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'virtual_mcps'
          AND column_name = 'instructions'
    ) THEN
        RETURN;
    END IF;

    ALTER TABLE virtual_mcps
        ADD COLUMN instructions TEXT NOT NULL DEFAULT ''
            CONSTRAINT virtual_mcps_instructions_len_chk CHECK (char_length(instructions) <= 4000);

    -- O que o agente recebia até aqui continua sendo o que ele recebe.
    UPDATE virtual_mcps
       SET instructions = left(description, 4000)
     WHERE description <> '';
END $$;
