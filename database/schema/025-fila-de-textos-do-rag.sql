-- Purple Skills — a fila de textos do indexador ganha memória: recusa
-- definitiva e reserva com prazo (`docs/14-rag.md` §5.6 e §7.1).
--
-- Problema: `listPendingRagTexts` é um anti-join puro — "texto com ocorrência e
-- sem vetor neste espaço", sempre na mesma ordem (`created_at`) e **sem
-- reserva**. Isso deixa dois furos, os dois medidos em produção local:
--
--   1. **o texto que o provedor recusa pelo conteúdo nunca sai da fila.** O
--      `gemini-embedding-2` recusa entrada longa demais com 400; um texto assim
--      continua sendo o mais antigo sem vetor para sempre, volta em todo ciclo
--      e nada atrás dele chega a ser tentado. O indexador passou a guardar a
--      recusa **em memória do processo** (`RecusasRag`), o que destrava a fila
--      mas se perde no restart: reiniciar o container manda o texto recusado ao
--      provedor uma vez mais, e a janela pedida ao banco cresce com o número de
--      recusas até bater no teto de 500 linhas da consulta;
--   2. **duas réplicas do indexador pagam pelo mesmo embedding.** As duas leem
--      a mesma fila, chamam o provedor pelos mesmos textos e a segunda gravação
--      cai no `ON CONFLICT DO NOTHING` — o dinheiro já foi gasto. `FOR UPDATE
--      SKIP LOCKED` na leitura **não** resolve: o bloqueio morre no fim da
--      transação da leitura e a chamada ao provedor acontece fora dela. O que
--      falta é uma marca **gravada**, como o `rag_stale = false` que
--      `claimStaleSkills` escreve antes de ler o conteúdo.
--
-- Os dois são estado do par **(espaço, texto)** e cabem numa tabela só:
-- `rag_text_status`. Um texto recusado no `gemini-embedding-2` pode muito bem
-- ser aceito por outro modelo, e é o espaço que identifica o par
-- driver+modelo+prefixos — por isso a chave não é o texto sozinho.
--
-- Cada linha está em **um** de dois estados, e os dois são contáveis:
--
--   reservado   `until IS NOT NULL`: alguém está pagando por este texto agora.
--               Vencido o prazo, ele volta à fila — indexador morto não
--               estaciona a fila, e é por isso que a reserva tem prazo em vez
--               de ser um booleano;
--   recusado    `until IS NULL`: o provedor recusou o conteúdo de vez. Não há
--               prazo: insistir custaria dinheiro por um erro garantido.
--
-- O que este arquivo cria:
--
--   * `rag_text_status` — a tabela acima, PK `(space_uuid, text_sha256)`, que é
--     também o índice da exclusão feita por `listPendingRagTexts`;
--   * `rag_text_status_text_idx` — para a cascata vinda de `rag_texts`. Sem
--     ela, a coleta de órfãos (`collectOrphanRagTexts`, até 500 textos por
--     ciclo) faria uma varredura sequencial desta tabela por texto apagado.
--
-- **As duas FKs são `ON DELETE CASCADE`**, e isso é parte do desenho: apagar o
-- espaço (trocar de modelo) ou o texto (a coleta de órfãos) leva o estado
-- junto. O efeito colateral é conhecido e aceito: um texto **recusado** que
-- fica órfão e é coletado perde a marca — se o mesmo conteúdo voltar ao acervo,
-- o provedor o recusa uma vez mais. Guardar a recusa de um texto que já não
-- existe custaria uma tabela sem dono.
--
-- Efeito sobre dados existentes: **nenhum.** A tabela nasce vazia, nenhuma
-- coluna muda de sentido e nenhuma linha é apagada. Numa base em que o
-- indexador já rodou, o primeiro ciclo depois desta migration redescobre as
-- recusas que viviam na memória do processo — uma vez, e aí elas ficam
-- gravadas.
--
-- Idempotente: `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, sem
-- backfill. Reaplicar não muda nada.

-- --------------------------------------------------------- rag_text_status ---
CREATE TABLE IF NOT EXISTS rag_text_status (
    -- Cascata: trocar de modelo apaga o espaço e com ele todo o estado da fila
    -- dele — reserva e recusa de um espaço não dizem nada sobre outro.
    space_uuid   UUID NOT NULL REFERENCES rag_spaces(uuid) ON DELETE CASCADE,
    -- Cascata, ao contrário de `rag_skill_texts.text_sha256`: aqui a linha é
    -- estado sobre o texto, não uso dele, e não pode impedir a coleta de
    -- órfãos.
    text_sha256  BYTEA NOT NULL REFERENCES rag_texts(sha256) ON DELETE CASCADE,
    state        TEXT NOT NULL,
    -- O fim da reserva. Nulo é o que distingue a recusa (definitiva) da
    -- reserva (com prazo) — ver o CHECK.
    until        TIMESTAMPTZ,
    -- O que o provedor disse ao recusar. Só na recusa: numa reserva não há nada
    -- a explicar, e deixá-lo nulo ali torna a leitura do estado inequívoca.
    reason       TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Quando o estado mudou: a reserva renovada e a recusa gravada em cima de
    -- uma reserva regravam esta coluna, `created_at` não.
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- O par é a identidade, e a PK é o índice que `listPendingRagTexts` usa
    -- para excluir o que está reservado ou recusado.
    PRIMARY KEY (space_uuid, text_sha256),
    -- Um CHECK só, porque as duas coisas são a mesma: ele é o domínio de
    -- `state` **e** a forma de cada estado. Uma linha não pode dizer as duas
    -- coisas, como em `reset_tokens_estado_chk` (`023`).
    CONSTRAINT rag_text_status_state_chk CHECK (
        (state = 'reservado' AND until IS NOT NULL AND reason IS NULL)
     OR (state = 'recusado'  AND until IS NULL)
    ),
    -- Mensagem de provedor pode vir com corpo de resposta inteiro dentro; o
    -- teto existe para uma linha de estado não guardar um log.
    CONSTRAINT rag_text_status_reason_length_chk CHECK (
        reason IS NULL OR length(reason) <= 500
    )
);

-- A cascata de `rag_texts`: sem este índice, cada texto apagado pela coleta de
-- órfãos varre `rag_text_status` inteira. É o mesmo motivo do
-- `rag_vectors_text_idx` (`020`).
CREATE INDEX IF NOT EXISTS rag_text_status_text_idx ON rag_text_status (text_sha256);
