-- Purple Skills — quarentena: o pacote enviado que espera aprovação.
--
-- Problema: importar um `.zip`/`.skill` cria a skill na hora. Quem envia o
-- pacote de terceiro é quem o publica, e não há um passo entre "chegou" e "está
-- no acervo" — nenhum lugar onde o conteúdo possa ser lido, corrigido e só
-- então aprovado. A quarentena é esse lugar: uma pasta de arquivos com dono,
-- fora do acervo, que a promoção transforma numa skill de verdade.
--
-- O que este arquivo cria:
--
--   * `quarantine_skills` — o envio. Deliberadamente pobre: **não** tem slug,
--     tag, ícone, `is_active`, `is_public`, vínculo com vMCP ou catálogo,
--     contador, concessão nem `search_vector`. O que existe é o rótulo (`name`,
--     lido do `name:` do SKILL.md ou do nome do arquivo enviado), a descrição,
--     o arquivo de origem e o dono;
--   * `quarantine_files` — os arquivos do envio, com a mesma modelagem de
--     `files`: texto **ou** binário, nunca os dois (CHECK), mime, tamanho e
--     unicidade de caminho **sem diferenciar caixa**, como o `003` fez lá;
--   * as cinco ações `quarantine.*` no CHECK de `audit_log.action`;
--   * a chave `quarantine.approvers` em `settings`, semeada com o padrão da
--     instalação.
--
-- Quatro decisões que o desenho grava e que valem ler antes de mexer:
--
--   * **não há colisão de nome.** Duplicata é o caso esperado — o mesmo pacote
--     enviado duas vezes são dois envios —, e por isso `name` não é UNIQUE e
--     não vira slug. A identidade é o `uuid` (`uuidv7()`, como o resto do
--     banco); quem separa dois homônimos na tela é a data e o dono;
--   * **o envio pertence a quem o submeteu.** `owner_user_uuid` é
--     `ON DELETE SET NULL`, como `skills.owner_user_uuid` no `017`: a conta
--     removida deixa o envio órfão, só do admin, em vez de levar o pacote
--     junto. `created_by_user_uuid` fica ao lado, informativo, com o mesmo
--     sentido que tem em `skills`;
--   * **o SKILL.md fica cru, com o frontmatter dentro.** Ao contrário de
--     `files`, aqui não há separação entre metadados e corpo: o que foi enviado
--     é o que está gravado e é o que se edita. Quem separa os dois é a
--     promoção, uma vez, ao criar a skill;
--   * **a quarentena não sofre RAG.** Nenhuma coluna de RAG, nenhum hash e
--     nenhum trigger de pendência. Os triggers do `020` (e a função redefinida
--     pelo `027`) estão presos a `files`, `skills` e `skill_tags` — nenhum
--     deles alcança as tabelas daqui, e o indexador varre `skills`, que não tem
--     linha nenhuma de envio. O hash de `files.content_sha256` existe para o
--     RAG reaproveitar vetor; sem RAG, ele seria uma coluna que ninguém lê.
--
-- Efeito sobre dados existentes: **nenhum.** Duas tabelas novas, vazias; o
-- CHECK de `audit_log` só cresce (nenhuma linha gravada passa a violá-lo); e a
-- chave de `settings` só é inserida se ainda não houver linha — a instalação
-- que já escolheu quem aprova não é reescrita.
--
-- Idempotente: `IF NOT EXISTS` / `OR REPLACE` / `DROP … IF EXISTS`, e a
-- semeadura com `ON CONFLICT DO NOTHING`. Reaplicar não muda nada.

-- ------------------------------------------------------ quarantine_skills ---
CREATE TABLE IF NOT EXISTS quarantine_skills (
    uuid                 UUID PRIMARY KEY DEFAULT uuidv7(),
    -- Só rótulo: não vira slug, não é único e não entra em busca nenhuma.
    name                 TEXT NOT NULL,
    description          TEXT NOT NULL DEFAULT '',
    -- O `pacote.zip` de origem, informativo — some junto com o envio.
    source_filename      TEXT,
    -- Quem submeteu; nulo = órfão, só do admin (o `SET NULL` do `017`).
    owner_user_uuid      UUID REFERENCES users(uuid) ON DELETE SET NULL,
    created_by_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Os envios desta conta": o recorte de quem perdeu o papel de editor e só
-- enxerga o que é seu. Cobre também o `SET NULL` da remoção da conta.
CREATE INDEX IF NOT EXISTS quarantine_skills_owner_user_uuid_idx
    ON quarantine_skills (owner_user_uuid);

-- A listagem é "mais recentes primeiro", sem outra ordenação possível.
CREATE INDEX IF NOT EXISTS quarantine_skills_created_at_idx
    ON quarantine_skills (created_at DESC);

-- ------------------------------------------------------- quarantine_files ---
-- A mesma modelagem de `files`, sem `content_sha256`: o hash é do RAG, e o RAG
-- não passa por aqui.
CREATE TABLE IF NOT EXISTS quarantine_files (
    id              UUID PRIMARY KEY DEFAULT uuidv7(),
    quarantine_uuid UUID NOT NULL REFERENCES quarantine_skills(uuid) ON DELETE CASCADE,
    relative_path   TEXT NOT NULL,
    text_content    TEXT,
    binary_content  BYTEA,
    mime_type       TEXT NOT NULL DEFAULT 'application/octet-stream',
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT quarantine_files_one_content_chk CHECK (
        (text_content IS NOT NULL AND binary_content IS NULL)
     OR (text_content IS NULL AND binary_content IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS quarantine_files_quarantine_uuid_idx
    ON quarantine_files (quarantine_uuid);

-- Unicidade **dentro do envio** e sem diferenciar caixa, pela lição do `003`:
-- a escrita diferencia a caixa e a leitura não, então `skill.md` ao lado de
-- `SKILL.md` deixaria a promoção escolhendo o arquivo principal sem critério.
-- Entre envios diferentes o mesmo caminho é livre — dois envios do mesmo
-- pacote são o caso esperado.
CREATE UNIQUE INDEX IF NOT EXISTS quarantine_files_path_lower_uniq
    ON quarantine_files (quarantine_uuid, lower(relative_path));

-- Escrever um arquivo é mexer no envio: a listagem ordena por data e a ficha
-- mostra quando o pacote foi tocado pela última vez. O mesmo papel de
-- `files_reindex_skill_trg` (`001`), sem a parte de reindexação — aqui não há
-- `search_vector` nem `rag_stale` para marcar.
--
-- No `DELETE` em cascata (o envio inteiro sendo apagado) o `UPDATE` não acha
-- linha nenhuma: a linha-pai já foi removida pelo mesmo comando e é invisível
-- ao trigger. Zero linhas atualizadas, sem erro — é o que se quer.
--
-- **Sem o "só se mudou" de `skills_mark_rag_stale`**, de propósito: ali o
-- guarda é um booleano (`WHERE NOT rag_stale`), idempotente; aqui ele só
-- poderia ser `updated_at <> now()`, e duas transações que comecem no mesmo
-- microssegundo perderiam a marcação — um carimbo errado em troca de um
-- `UPDATE`. Um lote de N arquivos faz N `UPDATE`s nesta linha, todos HOT
-- (nenhum índice da tabela referencia `updated_at`) e numa tabela pequena.
CREATE OR REPLACE FUNCTION quarantine_files_touch_tg() RETURNS TRIGGER AS $$
DECLARE
    alvo UUID;
BEGIN
    alvo := CASE WHEN TG_OP = 'DELETE' THEN OLD.quarantine_uuid ELSE NEW.quarantine_uuid END;
    UPDATE quarantine_skills SET updated_at = now() WHERE uuid = alvo;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quarantine_files_touch_trg ON quarantine_files;
CREATE TRIGGER quarantine_files_touch_trg
    AFTER INSERT OR UPDATE OR DELETE ON quarantine_files
    FOR EACH ROW EXECUTE FUNCTION quarantine_files_touch_tg();

-- -------------------------------------------------------------- audit_log ---
-- As cinco ações da quarentena. `target_label` é o **nome do envio** (ele não
-- tem slug); em `quarantine.promote` é `<nome do envio> -> <slug criado>`, que
-- é o único lugar onde os dois lados do portão aparecem juntos. Editar ou
-- apagar um arquivo do envio é `quarantine.update`, com o caminho em
-- `file_path`; `quarantine.settings` leva `chave=valor`, como `rag.settings`.
--
-- DROP + ADD porque não há `ADD CONSTRAINT IF NOT EXISTS`; a lista repete a de
-- `026-auditoria-de-vinculo-e-reativacao.sql` inteira, e não só acrescenta,
-- porque o CHECK é um objeto só. **Quem mexer neste CHECK depois parte desta
-- lista**: uma migration que repita a do `026` apaga as cinco daqui.
--
-- O espelho em TypeScript é `AUDIT_ACTIONS` (`src/queries.ts`, o filtro de
-- `listAuditPage`) e `AuditAction` de `@purple-skills/shared`: os três andam
-- juntos.
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check CHECK (
    action IN (
        'create',
        'update',
        'delete',
        'user.create',
        'user.role',
        'user.deactivate',
        'user.activate',
        'user.password',
        'user.link',
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
        'rag.reindex',
        'quarantine.create',
        'quarantine.update',
        'quarantine.delete',
        'quarantine.promote',
        'quarantine.settings'
    )
);

-- --------------------------------------------------------------- settings ---
-- Quem pode aprovar um envio: `admin`, `admin+owner` ou `admin+editor`
-- (`QUARANTINE_APPROVERS` de shared é a lista; a regra de quem pode o quê mora
-- lá, não aqui). O padrão é `admin+owner` — quem enviou aprova o que é seu —,
-- e o portão existe para o pacote de terceiro, não para atrapalhar quem já
-- podia criar a skill direto pelo formulário.
--
-- `ON CONFLICT DO NOTHING` é a semeadura de `seedRagSetting`: a instalação que
-- já escolheu outra política não é reescrita, e reaplicar não muda nada. Sem
-- linha em `audit_log`: ninguém decidiu isso — é o padrão de fábrica, e a
-- trilha só registra a escolha que alguém fez (`setQuarantineApprovers`).
INSERT INTO settings (key, value)
VALUES ('quarantine.approvers', 'admin+owner')
ON CONFLICT (key) DO NOTHING;
