-- Purple Skills — os arquivos de texto que ficaram gravados como binário.
--
-- Problema: texto × binário é decidido **na gravação** (`fileColumns`, em
-- `src/queries.ts`) e a leitura usa o que está gravado (`text_content IS NOT
-- NULL`) — nada reclassifica uma linha depois. Na beta.22 a tabela de mime do
-- shared (`MIME_BY_EXTENSION`, `packages/shared/src/paths.ts`) ganhou 70
-- extensões de código e configuração: `.php`, `.ini`, `.conf`, `.log`, `.env`,
-- `.ps1`, `.bat`, `.kt`, `.swift`, `.cs`, `.scss`, `.vue`, `.proto`, `.tf`,
-- `.ipynb`, os sufixos de modelo (`.example`, `.sample`, `.template`, `.tpl`) e as
-- demais da lista abaixo. Antes dela `mimeTypeFor` devolvia
-- `application/octet-stream` para todas, e o conteúdo ia para `binary_content`.
--
-- O envio novo já sai certo; a linha antiga continuou binária. O mesmo arquivo,
-- byte a byte, tem tratamento diferente conforme a data do envio: o antigo não
-- abre no leitor nem no editor do painel, o `get_skill_file` do MCP responde "é
-- binário" em vez de entregar o script que a skill manda usar, e ele fica fora
-- da busca semântica (`readSkillForRag` só lê `text_content IS NOT NULL`). A
-- ampliação saiu na beta.22 **sem** esta conversão (`tasks/018`).
--
-- Correção: a linha de `files` com `text_content IS NULL` cuja extensão está na
-- lista vira texto **só quando o conteúdo é UTF-8 válido e não tem byte nulo** —
-- a régua de `isTextualContent` do shared, a mesma da gravação (`tasks/015`).
-- `binary_content` vai a nulo e `mime_type` recebe o que `mimeTypeFor` dá hoje.
--
-- A lista é uma **foto** da tabela do shared na beta.22, de propósito: migration
-- é ponto no tempo, e SQL não importa TypeScript. Ampliar a tabela de novo pede
-- OUTRA migration de conversão. Só entram as extensões que a ampliação trouxe: as
-- que já eram textuais (`.md`, `.json`, `.sh`…) nunca caíram em `binary_content`
-- por esta causa, e as binárias de verdade (`.png`, `.zip`, `.pdf`…) ficam onde
-- estão.
--
-- Efeito sobre dados existentes:
--
--   * a linha que **não** passa na régua fica exatamente como está, `mime_type`
--     inclusive: ela é binária de verdade (um `.gz` renomeado para `.log`, um
--     `.conf` em ISO-8859-1, um `.ps1` em UTF-16, que tem byte nulo). Converter
--     trocaria bytes por U+FFFD; aqui ninguém perde um byte. Diferença conhecida
--     para `fileColumns`, que grava o mime pela extensão mesmo no binário: o
--     reenvio desse arquivo passa a chamá-lo de `text/…` e continua em
--     `binary_content`. A escolha é não mexer em linha que a conversão não
--     alcança;
--   * os bytes não mudam: `convert_from(…, 'UTF8')` devolve o conteúdo que o
--     `convert_to` do trigger `files_content_sha256_trg` (`020`) grava de volta,
--     então `content_sha256` e `size_bytes` continuam idênticos e o indexador
--     reaproveita o vetor de quem já tinha;
--   * `files.updated_at` e `skills.updated_at` **não** são tocados: o arquivo não
--     foi editado, e a ordenação "recentes" do site não pode mudar por causa de
--     uma reclassificação. O `SKILL.md` nunca é candidato (`.md` sempre foi
--     textual), então `files_reindex_skill_trg` (`001`, `002`) não age e
--     `search_vector` fica como está;
--   * as skills donas de um arquivo convertido ficam **pendentes no RAG**
--     (`skills.rag_stale`). Com a busca semântica ligada, esses arquivos passam a
--     ser fatiados e **enviados ao provedor de embeddings** no ciclo seguinte —
--     `.conf`, `.ini`, `.env.example`, `.log`, `.tf` inclusive. É o que já
--     acontece com todo envio novo desde a beta.22; vetor nenhum é apagado e o
--     texto que já existia reaproveita o seu. O custo de API é proporcional ao
--     que foi convertido.
--
-- A pendência é marcada **aqui**, numa instrução explícita, e não deixada para o
-- trigger `files_rag_stale_trg`: este `UPDATE` não muda hash nem caminho, e a
-- função da `020` sai cedo nesse caso. A `027-rag-stale-na-troca-de-tipo.sql` a
-- corrigiu (o atalho passou a olhar o tipo), e depois dela o trigger marca
-- também — a segunda marcação não acha linha (`AND NOT rag_stale`). Marcar aqui
-- faz o arquivo valer dos dois lados da `rag-stale-na-troca-de-tipo`, que é o
-- que uma renumeração entre cópias de trabalho exige.
--
-- Nenhuma trava além das linhas tocadas: nada de `FOR UPDATE` em `skills`, nada
-- de `DISABLE TRIGGER`. O `UPDATE` reescreve o conteúdo (TOAST) e segura as
-- linhas convertidas até o COMMIT; a auxiliar abre uma subtransação por
-- candidata (é o bloco `EXCEPTION` que deixa o UTF-8 inválido passar sem
-- derrubar a transação inteira). Numa base grande com muitos anexos, aplique em
-- janela, como a `020`.
--
-- Idempotente: a segunda passada não acha candidata — quem foi convertido tem
-- `text_content IS NOT NULL`, e quem ficou binário continua não passando na
-- régua. A auxiliar mora em `pg_temp`, é criada com `OR REPLACE` e derrubada no
-- fim: nada entra no schema `public`, nem de passagem.

-- ------------------------------------------------------------ a régua em SQL ---
-- O texto UTF-8 do binário, ou NULL quando o conteúdo não é texto.
--
-- `convert_from` levanta `22021` (`character_not_in_repertoire`) em byte fora
-- do UTF-8 — e um erro aqui abortaria a migration inteira, e com ela o boot. O
-- bloco `EXCEPTION` transforma **só** essa recusa num NULL; qualquer outro erro
-- continua derrubando a transação, que é o certo para o que ninguém previu. O
-- teste do byte nulo vem antes e explícito: é metade da régua, não um detalhe do
-- `convert_from` (que também o recusa, com o mesmo `22021`).
--
-- STABLE, não IMMUTABLE: `convert_from` é STABLE (depende do encoding do banco).
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

-- ------------------------------------------------------------- a conversão ---
-- A extensão é lida como em `mimeTypeFor`: o último segmento do caminho, o que
-- vem depois do **último** ponto, e só quando há algo antes dele —
-- `^.+\.([^.]+)$` recusa `.env` e `Makefile`, que sempre foram `text/plain` pela
-- regra do nome sem extensão e nunca foram gravados como binário por esta causa.
--
-- `candidatos` é `MATERIALIZED` de propósito — é uma cerca de otimização. Como
-- subconsulta comum o planejador a achatava e empurrava o `texto IS NOT NULL`
-- para a varredura de `files`: a régua rodava para **todo** binário da tabela
-- (cada imagem e cada `.zip` decodificados inteiros, uma subtransação cada),
-- antes do corte por extensão, e de novo no `SET`. Cercada, ela roda uma vez, e
-- só para quem casou a extensão (conferido no `EXPLAIN VERBOSE`).
WITH candidatos AS MATERIALIZED (
    SELECT alvo.id,
           novo.mime_type,
           pg_temp.texto_utf8_ou_nulo(alvo.binary_content) AS texto
      FROM files alvo
      JOIN (VALUES
          ('php',        'text/x-php'),
          ('phtml',      'text/x-php'),
          ('mts',        'text/x-typescript'),
          ('cts',        'text/x-typescript'),
          ('pyw',        'text/x-python'),
          ('kt',         'text/x-kotlin'),
          ('kts',        'text/x-kotlin'),
          ('swift',      'text/x-swift'),
          ('cs',         'text/x-csharp'),
          ('cc',         'text/x-c++'),
          ('cxx',        'text/x-c++'),
          ('hpp',        'text/x-c++'),
          ('hh',         'text/x-c++'),
          ('scala',      'text/x-scala'),
          ('dart',       'text/x-dart'),
          ('ex',         'text/x-elixir'),
          ('exs',        'text/x-elixir'),
          ('hs',         'text/x-haskell'),
          ('lua',        'text/x-lua'),
          ('pl',         'text/x-perl'),
          ('pm',         'text/x-perl'),
          ('r',          'text/x-r'),
          ('groovy',     'text/x-groovy'),
          ('gradle',     'text/x-groovy'),
          ('zsh',        'text/x-shellscript'),
          ('ksh',        'text/x-shellscript'),
          ('fish',       'text/x-shellscript'),
          ('ps1',        'text/x-powershell'),
          ('psm1',       'text/x-powershell'),
          ('psd1',       'text/x-powershell'),
          ('bat',        'text/x-msdos-batch'),
          ('cmd',        'text/x-msdos-batch'),
          ('scss',       'text/x-scss'),
          ('sass',       'text/x-sass'),
          ('less',       'text/x-less'),
          ('vue',        'text/x-vue'),
          ('svelte',     'text/x-svelte'),
          ('graphql',    'text/x-graphql'),
          ('gql',        'text/x-graphql'),
          ('proto',      'text/x-protobuf'),
          ('diff',       'text/x-diff'),
          ('patch',      'text/x-diff'),
          ('tex',        'text/x-tex'),
          ('rst',        'text/x-rst'),
          ('adoc',       'text/asciidoc'),
          ('mdx',        'text/markdown'),
          ('j2',         'text/x-jinja'),
          ('jinja',      'text/x-jinja'),
          ('jinja2',     'text/x-jinja'),
          ('hbs',        'text/x-handlebars-template'),
          ('mustache',   'text/x-handlebars-template'),
          ('mk',         'text/x-makefile'),
          ('cmake',      'text/x-cmake'),
          ('json5',      'application/json'),
          ('ipynb',      'application/json'),
          ('jsonl',      'text/plain'),
          ('ndjson',     'text/plain'),
          ('ini',        'text/plain'),
          ('cfg',        'text/plain'),
          ('conf',       'text/plain'),
          ('env',        'text/plain'),
          ('properties', 'text/plain'),
          ('tf',         'text/plain'),
          ('hcl',        'text/plain'),
          ('log',        'text/plain'),
          ('text',       'text/plain'),
          ('example',    'text/plain'),
          ('sample',     'text/plain'),
          ('template',   'text/plain'),
          ('tpl',        'text/plain')
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

-- A auxiliar sai: ela existe para esta passada, não para o schema.
DROP FUNCTION IF EXISTS pg_temp.texto_utf8_ou_nulo(BYTEA);
