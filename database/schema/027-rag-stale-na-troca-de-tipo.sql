-- Purple Skills — a pendência do RAG passa a enxergar a troca binário ↔ texto.
--
-- Problema: `files_rag_stale_tg` (`020`) sai cedo quando hash e caminho não
-- mudaram — "não aconteceu nada". Só que `content_sha256` é o hash dos BYTES,
-- `sha256(COALESCE(convert_to(text_content, 'UTF8'), binary_content))`, e os
-- bytes de um arquivo UTF-8 válido são os mesmos nas duas colunas: a mesma linha
-- como binário e como texto tem o **mesmo** hash. Medido: um `app.ini` gravado
-- como `bytea` e regravado como texto com o conteúdo igual mantém o hash e deixa
-- `skills.rag_stale` em `false`, nos dois sentidos.
--
-- Até a beta.22 isso não tinha como acontecer: o tipo era função pura de
-- (extensão, bytes), e mesmo hash com mesmo caminho implicava mesmo tipo. A
-- tabela de mime do `shared` cresceu (`.ini`, `.toml`, `.sql` e mais ~70
-- extensões passaram a ser texto), e o arquivo antigo reenviado igual troca de
-- coluna sem avisar o indexador:
--
--   * binário → texto: o arquivo abre no painel e é servido pelo MCP, mas nunca
--     entra na busca semântica — `claimStaleSkills` só reserva `WHERE rag_stale`;
--   * texto → binário: a linha é atualizada, não apagada, então a cascata de
--     `rag_skill_texts.file_id` não dispara e as partes de um arquivo que deixou
--     de ser texto continuam sendo devolvidas pela busca.
--
-- Correção: o atalho só vale quando o TIPO também não mudou. O tipo é a coluna
-- preenchida — `files_one_content_chk` (`001`) garante que exatamente uma das
-- duas é nula. De passagem o atalho deixa de engolir a troca de skill, que o
-- comentário da `020` já prometia marcar nas duas pontas e o código não marcava
-- (mesmo hash e mesmo caminho saíam antes de olhar `skill_uuid`).
--
-- O que **não** muda, de propósito:
--
--   * o hash. Incluir o tipo nele invalidaria o acervo: num arquivo que cabe
--     inteiro num texto canônico, `files.content_sha256` **é** o hash de
--     `rag_texts`, e é isso que reaproveita o vetor sem reler o arquivo (`020`);
--   * `mime_type` fora da conta. Ele muda sem mudar o que o RAG lê (binário que
--     troca de mime não interessa), e não é ele que decide a coluna;
--   * texto → texto e binário → binário com o mesmo conteúdo continuam **sem**
--     marcar: regravar o mesmo arquivo não custa uma refatiação.
--
-- Efeito sobre dados existentes: **nenhum.** Só a função muda; nenhuma linha é
-- lida nem escrita, e o trigger `files_rag_stale_trg` fica como a `020` o criou.
-- Não há backfill: a skill cujo arquivo já trocou de tipo em silêncio desde a
-- beta.22 se recupera pelo "Reindexar" do painel (`markAllSkillsStale`), que é de
-- graça — texto que não mudou reaproveita o vetor. Uma migration de conversão das
-- linhas antigas precisa vir **depois** desta: o `UPDATE files SET text_content =
-- …, binary_content = NULL` dela não muda hash nem caminho, e antes desta cairia
-- inteiro no atalho.
--
-- Trava: `CREATE OR REPLACE FUNCTION` não toca `files` nem `skills`. A função
-- continua fazendo o mesmo `UPDATE skills … WHERE NOT rag_stale` de antes, só
-- que em mais um caso — nenhuma trava nova, nenhum `FOR UPDATE` em `skills`.
--
-- Idempotente: `CREATE OR REPLACE`. Reaplicar não muda nada. **Reaplicar a `020`
-- depois desta, sim:** ela recria a função antiga e desfaz a correção — é o caso
-- geral de migration antiga sobre schema novo, que o runner recusa (ver
-- "Reaplicar migration antiga" em `database/README.md`).

-- ------------------------------------------------------ files_rag_stale_tg ---
CREATE OR REPLACE FUNCTION files_rag_stale_tg() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.content_sha256 IS NOT DISTINCT FROM OLD.content_sha256
       AND NEW.relative_path IS NOT DISTINCT FROM OLD.relative_path
       AND NEW.skill_uuid IS NOT DISTINCT FROM OLD.skill_uuid
       -- A coluna preenchida É o tipo: `files_one_content_chk` garante que
       -- exatamente uma das duas é nula.
       AND (NEW.text_content IS NULL) = (OLD.text_content IS NULL) THEN
        RETURN NULL;
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.text_content IS NOT NULL THEN
        PERFORM skills_mark_rag_stale(OLD.skill_uuid);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.text_content IS NOT NULL THEN
        PERFORM skills_mark_rag_stale(NEW.skill_uuid);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
