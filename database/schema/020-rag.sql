-- Purple Skills — RAG, primeira implementação: busca semântica com o driver
-- google (`tmp/RAG-GOOGLE.md`, futuro `docs/14`).
--
-- Problema: a busca é full-text com configuração `simple` (`001`, `002`), que
-- não faz stemming nem entende sinônimo, flexão ou idioma: "como versionar
-- commits" não encontra a skill "Conventional Commits". A correção é uma perna
-- vetorial fundida com a textual (§8.2), e vetor é dado com regra própria —
-- ele só vale ao lado do **espaço de embedding** que o gerou.
--
-- Um espaço é a combinação (driver, modelo, dimensões, prefixo de documento,
-- prefixo de consulta). Os prefixos entram na identidade porque, no
-- `gemini-embedding-2`, a tarefa vai escrita no próprio texto enviado: trocar
-- o prefixo muda todo vetor, como trocar o modelo. Sem número de versão de
-- receita de propósito — editar o prefixo e esquecer de subir a versão
-- misturaria vetores de espaços diferentes sem aviso, e com o prefixo na
-- identidade isso é impossível.
--
-- O que este arquivo cria:
--
--   * `files.content_sha256` — SHA-256 do conteúdo gravado (texto ou binário),
--     calculado por trigger. Coluna gerada não serve: `convert_to` e
--     `textsend` são STABLE e o Postgres recusa a expressão;
--   * `skills.rag_stale` — a skill precisa ser refatiada pelo indexador. Os
--     triggers (skill, arquivo e tag) marcam; quem limpa é o indexador.
--     Incremento de contador **não** marca;
--   * `rag_spaces` — um espaço por identidade, com os dois prefixos;
--   * `rag_texts` — o texto canônico, endereçado pelo próprio hash e guardado
--     **sem** o prefixo do driver, para servir a qualquer espaço. O prefixo é
--     aplicado só na chamada à API;
--   * `rag_skill_texts` — as ocorrências: onde cada texto aparece (skill,
--     fonte, arquivo, parte);
--   * `rag_vectors` — o vetor de um texto num espaço. A FK composta com o
--     CHECK de dimensão impede vetor de tamanho diferente do do espaço;
--   * as ações `rag.settings` e `rag.reindex` no CHECK de `audit_log.action`.
--
-- Efeito sobre dados existentes: **toda skill nasce pendente** (`rag_stale`
-- default `true`) — é o que faz o indexador varrer o acervo na primeira
-- execução. Os arquivos ganham o hash num backfill que **não** toca
-- `skills.updated_at`: o trigger de reindexação de `001`/`002` fica desligado
-- só durante ele, senão o backfill mudaria a ordenação "recentes" do site.
-- Nenhuma linha é apagada e nenhuma coluna existente muda de sentido.
--
-- Custo de aplicação: o backfill reescreve `files` inteira e o `DISABLE
-- TRIGGER` segura ACCESS EXCLUSIVE na tabela até o fim da transação — numa
-- base grande, aplique em janela. Tudo roda numa transação só, como as demais.
--
-- Idempotente: `IF NOT EXISTS` / `OR REPLACE` / `DROP … IF EXISTS`, e o
-- backfill só toca linha sem hash — numa segunda passada ele não acha nenhuma.

CREATE EXTENSION IF NOT EXISTS vector;

-- --------------------------------------------------- files.content_sha256 ---
-- O hash do que está gravado, texto ou binário. Para arquivo curto — o que vai
-- inteiro para um texto canônico — ele é o mesmo hash de `rag_texts`, e é isso
-- que permite ao indexador reaproveitar o vetor sem reler o arquivo.
ALTER TABLE files ADD COLUMN IF NOT EXISTS content_sha256 BYTEA;

CREATE OR REPLACE FUNCTION files_content_sha256_tg() RETURNS TRIGGER AS $$
BEGIN
    -- `files_one_content_chk` garante que exatamente um dos dois é nulo.
    NEW.content_sha256 := sha256(COALESCE(convert_to(NEW.text_content, 'UTF8'), NEW.binary_content));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS files_content_sha256_trg ON files;
CREATE TRIGGER files_content_sha256_trg
    BEFORE INSERT OR UPDATE ON files
    FOR EACH ROW EXECUTE FUNCTION files_content_sha256_tg();

-- Backfill: o `UPDATE … SET content_sha256 = NULL` existe para disparar o
-- trigger acima, que preenche a coluna. A reindexação de `001`/`002` fica
-- desligada durante ele para não tocar `skills.updated_at` de toda skill com
-- SKILL.md. A transação do runner garante que o trigger volta ligado mesmo
-- se algo falhar aqui.
ALTER TABLE files DISABLE TRIGGER files_reindex_skill_trg;
UPDATE files SET content_sha256 = NULL WHERE content_sha256 IS NULL;
ALTER TABLE files ENABLE TRIGGER files_reindex_skill_trg;

ALTER TABLE files ALTER COLUMN content_sha256 SET NOT NULL;

-- Achar os arquivos de um conteúdo: a porta de entrada da limpeza futura de
-- órfãos e de qualquer dedup por conteúdo.
CREATE INDEX IF NOT EXISTS files_content_sha256_idx ON files (content_sha256);

-- ------------------------------------------------------- skills.rag_stale ---
-- Pendência de skill: o conteúdo mudou e a divisão em textos precisa ser
-- refeita. Nasce `true` em toda linha — inclusive nas que já existem.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS rag_stale BOOLEAN NOT NULL DEFAULT true;

-- A reserva do indexador é `WHERE rag_stale ORDER BY updated_at, uuid LIMIT n
-- FOR UPDATE SKIP LOCKED` (§5.6): o índice parcial cobre o filtro e entrega a
-- ordem completa, inclusive o desempate por uuid, sem ordenação à parte.
CREATE INDEX IF NOT EXISTS skills_rag_stale_idx ON skills (updated_at, uuid) WHERE rag_stale;

-- Mudou o que entra no texto de metadados (nome ou descrição)? Pendente.
-- Contador e `rag_stale = false` do próprio indexador não marcam.
CREATE OR REPLACE FUNCTION skills_rag_stale_tg() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT'
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.description IS DISTINCT FROM OLD.description THEN
        NEW.rag_stale := true;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS skills_rag_stale_trg ON skills;
CREATE TRIGGER skills_rag_stale_trg
    BEFORE INSERT OR UPDATE ON skills
    FOR EACH ROW EXECUTE FUNCTION skills_rag_stale_tg();

-- O `WHERE NOT rag_stale` evita escrever numa linha já pendente: sem ele, um
-- `setFiles` de dez arquivos faria dez UPDATEs na mesma skill.
CREATE OR REPLACE FUNCTION skills_mark_rag_stale(p_uuid UUID) RETURNS VOID AS $$
    UPDATE skills SET rag_stale = true WHERE uuid = p_uuid AND NOT rag_stale;
$$ LANGUAGE SQL;

-- Arquivo: só o que o RAG lê (conteúdo de texto e caminho) marca. Binário não
-- é embutido; UPDATE que não mexe em conteúdo nem em caminho não marca; e uma
-- troca de skill (que a unicidade de caminho torna rara) marca as duas.
CREATE OR REPLACE FUNCTION files_rag_stale_tg() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.content_sha256 IS NOT DISTINCT FROM OLD.content_sha256
       AND NEW.relative_path IS NOT DISTINCT FROM OLD.relative_path THEN
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

DROP TRIGGER IF EXISTS files_rag_stale_trg ON files;
CREATE TRIGGER files_rag_stale_trg
    AFTER INSERT OR UPDATE OR DELETE ON files
    FOR EACH ROW EXECUTE FUNCTION files_rag_stale_tg();

-- Tags entram no texto de metadados: incluir ou remover uma deixa pendente.
CREATE OR REPLACE FUNCTION skill_tags_rag_stale_tg() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM skills_mark_rag_stale(OLD.skill_uuid);
    ELSE
        PERFORM skills_mark_rag_stale(NEW.skill_uuid);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS skill_tags_rag_stale_trg ON skill_tags;
CREATE TRIGGER skill_tags_rag_stale_trg
    AFTER INSERT OR DELETE ON skill_tags
    FOR EACH ROW EXECUTE FUNCTION skill_tags_rag_stale_tg();

-- ------------------------------------------------------------- rag_spaces ---
-- Um espaço de embedding. Os prefixos são o texto que o driver põe antes do
-- texto canônico na hora de embutir — vazios num driver que não escreve a
-- tarefa no texto. **Sem DEFAULT de propósito:** quem esquece o prefixo recebe
-- erro, não um espaço mudo que partiria o acervo em dois sem ninguém notar.
CREATE TABLE IF NOT EXISTS rag_spaces (
    uuid             UUID PRIMARY KEY DEFAULT uuidv7(),
    driver           TEXT NOT NULL,
    model            TEXT NOT NULL,
    dimensions       INTEGER NOT NULL CHECK (dimensions > 0),
    document_prefix  TEXT NOT NULL,
    query_prefix     TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT rag_spaces_prefix_length_chk CHECK (
        length(document_prefix) <= 200 AND length(query_prefix) <= 200
    ),
    CONSTRAINT rag_spaces_identity_uniq UNIQUE (driver, model, dimensions, document_prefix, query_prefix),
    -- Alvo da FK composta de `rag_vectors`: é ela que prende cada vetor à
    -- dimensão declarada pelo espaço.
    CONSTRAINT rag_spaces_uuid_dimensions_uniq UNIQUE (uuid, dimensions)
);

-- -------------------------------------------------------------- rag_texts ---
-- O texto canônico, sem o prefixo do driver e sem normalização nenhuma. O hash
-- é conferido pelo banco: um texto nunca fica guardado sob o hash de outro, e
-- um texto com o prefixo colado na frente é recusado.
CREATE TABLE IF NOT EXISTS rag_texts (
    sha256      BYTEA PRIMARY KEY,
    content     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT rag_texts_sha256_chk CHECK (sha256 = sha256(convert_to(content, 'UTF8')))
);

-- Os textos pendentes saem em `ORDER BY created_at LIMIT n` (§5.6): o índice
-- dá a ordem pronta e deixa a varredura parar no lote.
CREATE INDEX IF NOT EXISTS rag_texts_created_at_idx ON rag_texts (created_at);

-- -------------------------------------------------------- rag_skill_texts ---
-- Onde um texto aparece. A PK é o endereço da ocorrência dentro da skill;
-- o mesmo texto em duas skills são duas linhas apontando para um hash só.
CREATE TABLE IF NOT EXISTS rag_skill_texts (
    skill_uuid     UUID NOT NULL REFERENCES skills(uuid) ON DELETE CASCADE,
    source         TEXT NOT NULL CHECK (source IN ('meta', 'file')),
    relative_path  TEXT NOT NULL DEFAULT '',
    part           INTEGER NOT NULL DEFAULT 0 CHECK (part >= 0),
    -- Cascata: apagar o arquivo apaga as partes dele na hora.
    file_id        UUID REFERENCES files(id) ON DELETE CASCADE,
    -- Sem cascata de propósito: texto em uso não pode ser apagado.
    text_sha256    BYTEA NOT NULL REFERENCES rag_texts(sha256),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (skill_uuid, source, relative_path, part),
    CONSTRAINT rag_skill_texts_source_chk CHECK (
        (source = 'meta' AND relative_path = '' AND file_id IS NULL)
     OR (source = 'file' AND relative_path <> '' AND file_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS rag_skill_texts_sha256_idx ON rag_skill_texts (text_sha256);
CREATE INDEX IF NOT EXISTS rag_skill_texts_file_idx ON rag_skill_texts (file_id);

-- ------------------------------------------------------------ rag_vectors ---
-- O vetor de um texto num espaço. `embedding` é `VECTOR` sem dimensão fixa
-- (a coluna serve a qualquer espaço) e a dimensão é travada **por linha**:
-- `dimensions` é copiada do espaço pela FK composta e o CHECK confere o vetor
-- contra ela. A busca é exata, sem índice — HNSW não aceita mais de 2000
-- dimensões, e `gemini-embedding-2` tem 3072.
CREATE TABLE IF NOT EXISTS rag_vectors (
    space_uuid   UUID NOT NULL,
    dimensions   INTEGER NOT NULL,
    text_sha256  BYTEA NOT NULL REFERENCES rag_texts(sha256) ON DELETE CASCADE,
    embedding    VECTOR NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (space_uuid, text_sha256),
    CONSTRAINT rag_vectors_space_fk FOREIGN KEY (space_uuid, dimensions)
        REFERENCES rag_spaces (uuid, dimensions) ON DELETE CASCADE,
    CONSTRAINT rag_vectors_dimensions_chk CHECK (vector_dims(embedding) = dimensions)
);

-- A perna vetorial entra por `rag_skill_texts` e busca o vetor pelo hash.
CREATE INDEX IF NOT EXISTS rag_vectors_text_idx ON rag_vectors (text_sha256);

-- -------------------------------------------------------------- audit_log ---
-- `rag.settings` é a troca de driver ou de modelo pelo painel (e a semeadura
-- pelo ambiente, com o ator `ambiente`); `rag.reindex` é o botão que marca
-- todo o acervo como pendente. Nas duas, `target_label` diz o quê:
-- `rag.driver=google` numa, o número de skills marcadas na outra. DROP + ADD
-- porque não há `ADD CONSTRAINT IF NOT EXISTS`; a lista repete a de `017`
-- inteira, e não só acrescenta, porque o CHECK é um objeto só.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (
    action IN (
        'create',
        'update',
        'delete',
        'user.create',
        'user.role',
        'user.deactivate',
        'key.create',
        'key.revoke',
        'mcp.create',
        'mcp.update',
        'mcp.delete',
        'mcp.default',
        'mcp.key.create',
        'mcp.key.revoke',
        'catalog.create',
        'catalog.update',
        'catalog.delete',
        'skill.share',
        'skill.unshare',
        'catalog.share',
        'catalog.unshare',
        'mcp.share',
        'mcp.unshare',
        'public.key.create',
        'public.key.revoke',
        'rag.settings',
        'rag.reindex'
    )
);
