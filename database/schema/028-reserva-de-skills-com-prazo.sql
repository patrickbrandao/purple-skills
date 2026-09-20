-- Purple Skills — a reserva de skills do indexador ganha prazo, como a de
-- textos ganhou na `025`.
--
-- Problema: `claimStaleSkills` reserva um lote escrevendo `rag_stale = false` em
-- até 50 skills **antes** de trabalhar nelas, numa statement que commita na hora.
-- A partir daí a única memória de que elas ainda precisam ser refatiadas é uma
-- variável local do indexador. `rag_stale` é um booleano: não diz quem reservou,
-- desde quando, nem até quando. Se o processo morre no meio do lote — SIGKILL,
-- OOM (o compose dá teto de memória ao container e o `restart` o levanta de
-- novo), ou o Postgres reiniciando, caso em que a devolução do `catch`
-- (`releaseStaleSkill`) falha pelo mesmo motivo e é engolida —, as skills que
-- faltavam ficam marcadas como feitas sem ninguém ter mexido nelas. Ninguém
-- volta a olhar: o painel mostra "0 skills a refatiar", e elas ficam com as
-- ocorrências antigas (ou nenhuma) na busca semântica até alguém editá-las ou
-- clicar em "Reindexar".
--
-- A `025` escreveu o argumento com todas as letras para a fila vizinha —
-- "indexador morto não estaciona a fila, e é por isso que a reserva tem prazo em
-- vez de ser um booleano" — e citou como modelo justamente o booleano daqui.
--
-- Correção: `rag_skill_claims`, uma linha por skill **reservada e ainda não
-- terminada**. `claimStaleSkills` a grava junto com o `rag_stale = false`; quem a
-- apaga é o fim do trabalho (`replaceSkillTexts`), a devolução
-- (`releaseStaleSkill`) ou a remoção da skill (cascata). O que sobra depois de
-- `until` é, por construção, a reserva de um indexador que não terminou — e ela
-- volta à fila sozinha.
--
-- Por que tabela, e não duas colunas em `skills`:
--
--   * **trava.** Baixar a reserva no sucesso seria mais um `UPDATE` na linha de
--     `skills` por skill processada, numa tabela em que a ordem de travas já
--     custou um deadlock medido (`FOR UPDATE` na skill × `files_rag_stale_trg`,
--     `docs/03`). Aqui a baixa é um `DELETE` numa linha que só o indexador toca,
--     em statement própria: transação que segura uma trava só não fecha ciclo;
--   * **é estado de fila, não dado da skill** — a mesma separação de
--     `rag_text_status`. `SkillRow` não ganha campo, e nenhuma leitura de skill
--     passa a carregar o que só o indexador lê.
--
-- `attempts` existe para o prazo não virar *crash-loop*. Hoje, por acidente, a
-- skill que **derruba** o indexador (OOM ao ler um acervo de arquivos enorme) sai
-- da fila na reserva e nunca mais volta. Com prazo puro ela voltaria a cada
-- vencimento e derrubaria o processo para sempre. A conta é de **leituras
-- começadas** (`readSkillForRag`), não de reservas: contar na reserva puniria as
-- companheiras de lote, que venceram junto sem nunca terem sido abertas. No teto
-- (3, em `queries.ts`) a reserva vencida deixa de ser retomada e a skill aparece
-- em `ragCoverage().stuckSkills` em vez de sumir; conteúdo novo (o trigger de
-- pendência) ou o "Reindexar" recomeçam a conta.
--
-- Nenhum índice além da PK: a tabela tem, no máximo, um lote por réplica do
-- indexador — fica vazia entre dois ciclos — e a varredura dela inteira é mais
-- barata que qualquer índice sobre `until`.
--
-- Efeito sobre dados existentes: **nenhum.** A tabela nasce vazia; `skills` não
-- muda. Skill que já tinha sido perdida da fila antes desta migration não tem
-- reserva para vencer: recupera-se com o "Reindexar" do painel, que é de graça
-- (texto que não mudou reaproveita o vetor).
--
-- Idempotente: `CREATE TABLE IF NOT EXISTS`, sem backfill. Reaplicar não muda
-- nada.

-- -------------------------------------------------------- rag_skill_claims ---
CREATE TABLE IF NOT EXISTS rag_skill_claims (
    -- Cascata: reserva de skill apagada não tem o que retomar. É também a PK —
    -- uma skill tem, no máximo, um indexador trabalhando nela.
    skill_uuid  UUID PRIMARY KEY REFERENCES skills(uuid) ON DELETE CASCADE,
    -- O fim da reserva. Viva (`until > now()`), ela segura a skill mesmo que o
    -- trigger a tenha remarcado; vencida, a skill volta à fila.
    until       TIMESTAMPTZ NOT NULL,
    -- Leituras começadas sob esta reserva e não terminadas — ver o cabeçalho.
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Quando a reserva foi retomada ou a leitura contada; `created_at` é o da
    -- primeira reserva da sequência.
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT rag_skill_claims_attempts_chk CHECK (attempts >= 0)
);
