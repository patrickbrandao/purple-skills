-- Purple Skills — os `.sum` que ficaram gravados como binário.
--
-- Problema: o mesmo da `029-arquivos-de-texto-antigos.sql`. `MIME_BY_EXTENSION`
-- (`packages/shared/src/paths.ts`) ganhou `sum: 'text/plain'` — o `go.sum` —, e
-- antes disso `mimeTypeFor` devolvia `application/octet-stream`, então o
-- conteúdo ia para `binary_content`. O envio novo já sai certo; a linha antiga
-- não abre no leitor, o MCP a chama de binária e ela fica fora do RAG.
--
-- Correção: a régua e a forma da `029` (ver lá o porquê de cada escolha), só
-- com a extensão `sum`, em duas tabelas:
--
--   * `files`: vira texto o UTF-8 válido sem byte nulo; hash, tamanho e os dois
--     `updated_at` não mudam; as skills donas ficam `rag_stale`;
--   * `quarantine_files` (`030`): mesmo problema, mesma conversão, sem RAG. O
--     trigger `quarantine_files_touch_trg` carimbaria `quarantine_skills
--     .updated_at`; a data antiga é guardada antes e devolvida depois — sem
--     `DISABLE TRIGGER`, que travaria a tabela.
--
-- Efeito sobre dados existentes: só as linhas `.sum` binárias que passam na
-- régua mudam de coluna; bytes iguais. O resto fica como está, mime inclusive.
--
-- Idempotente: quem foi convertido tem `text_content IS NOT NULL`, e quem ficou
-- binário continua reprovado; a segunda passada não acha candidata. Auxiliares
-- em `pg_temp`, derrubadas no fim.

-- ------------------------------------------------------------ a régua em SQL ---
-- Cópia da `029`: o texto UTF-8 do binário, ou NULL quando não é texto.
CREATE OR REPLACE FUNCTION pg_temp.texto_utf8_ou_nulo(p_bytes BYTEA) RETURNS TEXT AS $$
BEGIN
    IF p_bytes IS NULL OR position('\x00'::bytea IN p_bytes) > 0 THEN
        RETURN NULL;
    END IF;
    RETURN convert_from(p_bytes, 'UTF8');
EXCEPTION
    WHEN character_not_in_repertoire OR untranslatable_character THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- --------------------------------------------------------------- files ---
WITH candidatos AS MATERIALIZED (
    SELECT alvo.id,
           novo.mime_type,
           pg_temp.texto_utf8_ou_nulo(alvo.binary_content) AS texto
      FROM files alvo
      JOIN (VALUES
          ('sum', 'text/plain')
      ) AS novo(ext, mime_type)
        ON novo.ext = lower(
               substring(regexp_replace(alvo.relative_path, '^.*/', '') FROM '^.+\.([^.]+)$')
           )
     WHERE alvo.text_content IS NULL
), convertidos AS (
    UPDATE files f
       SET text_content   = c.texto,
           binary_content = NULL,
           mime_type      = c.mime_type
      FROM candidatos c
     WHERE f.id = c.id
       AND c.texto IS NOT NULL
    RETURNING f.skill_uuid
)
UPDATE skills s
   SET rag_stale = true
 WHERE s.uuid IN (SELECT skill_uuid FROM convertidos)
   AND NOT s.rag_stale;

-- ------------------------------------------------------- quarantine_files ---
-- As candidatas e a data de cada envio, antes do trigger de carimbo agir.
CREATE TEMP TABLE IF NOT EXISTS pg_temp.sum_quarentena ON COMMIT DROP AS
SELECT alvo.id,
       alvo.quarantine_uuid,
       pg_temp.texto_utf8_ou_nulo(alvo.binary_content) AS texto
  FROM quarantine_files alvo
 WHERE alvo.text_content IS NULL
   AND lower(
           substring(regexp_replace(alvo.relative_path, '^.*/', '') FROM '^.+\.([^.]+)$')
       ) = 'sum';

CREATE TEMP TABLE IF NOT EXISTS pg_temp.sum_quarentena_datas ON COMMIT DROP AS
SELECT q.uuid,
       q.updated_at
  FROM quarantine_skills q
 WHERE q.uuid IN (SELECT quarantine_uuid FROM pg_temp.sum_quarentena WHERE texto IS NOT NULL);

UPDATE quarantine_files f
   SET text_content   = c.texto,
       binary_content = NULL,
       mime_type      = 'text/plain'
  FROM pg_temp.sum_quarentena c
 WHERE f.id = c.id
   AND c.texto IS NOT NULL;

-- O trigger é AFTER ROW e já rodou: aqui a data volta ao que era.
UPDATE quarantine_skills q
   SET updated_at = d.updated_at
  FROM pg_temp.sum_quarentena_datas d
 WHERE q.uuid = d.uuid
   AND q.updated_at IS DISTINCT FROM d.updated_at;

-- As auxiliares saem: existem para esta passada, não para o schema.
DROP TABLE IF EXISTS pg_temp.sum_quarentena_datas;
DROP TABLE IF EXISTS pg_temp.sum_quarentena;
DROP FUNCTION IF EXISTS pg_temp.texto_utf8_ou_nulo(BYTEA);
