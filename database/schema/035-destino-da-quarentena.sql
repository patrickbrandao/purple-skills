-- Purple Skills — destino da quarentena: para onde a skill vai ao ser aprovada.
--
-- Problema: a skill promovida nascia **flutuante** — sem catálogo, sem vMCP
-- (`docs/15-quarentena.md` decisão 8) — e publicá-la era sempre um segundo
-- ato, na ficha da skill, depois da aprovação. Quem importa um pacote já sabe,
-- no upload, em que catálogos e servidores ele deve entrar; o mantenedor pediu
-- que essa escolha seja feita ali e **gravada no envio**, para a aprovação
-- cumpri-la sozinha. A decisão 8 e o item da §9 ("promover para dentro de um
-- catálogo ou servidor") ficam revogados por este arquivo.
--
-- O que este arquivo cria:
--
--   * `quarantine_catalogs` — os catálogos em que a skill **entra** quando o
--     envio for aprovado (participação ativa em `catalog_skills`);
--   * `quarantine_mcps` — os vMCPs em que a skill ganha **vínculo direto** na
--     aprovação, com as três portas de `virtual_mcp_skills` já escolhidas.
--
-- Quatro decisões que o desenho grava e que valem ler antes de mexer:
--
--   * **destino não é vínculo.** Nada aqui aparece em catálogo nem em vMCP:
--     nenhuma leitura de skill, de catálogo, de servidor ou do site olha estas
--     tabelas, e o envio continua fora de tudo até a aprovação. Quem as lê é a
--     ficha do envio (`getQuarantine`) e a promoção, que cria os vínculos de
--     verdade **na mesma transação** em que cria a skill — e só então as linhas
--     daqui somem, pela cascata do envio apagado;
--   * **catálogo ou vMCP apagado antes da aprovação tira o destino em
--     silêncio.** As duas FKs para o alvo são `ON DELETE CASCADE`: apagar o
--     catálogo leva a linha de `quarantine_catalogs` junto, sem erro, sem
--     auditoria no envio e sem mexer no `updated_at` dele. É o desejado — um
--     destino que não existe mais não tem o que cumprir, e barrar a remoção do
--     catálogo por causa de um envio pendente seria dar ao envio um poder que
--     ele não tem. Quem aprova com a ficha antiga na mão recebe 409 (o destino
--     mudou), não uma skill num catálogo que sumiu;
--   * **as portas não têm DEFAULT**, como em `virtual_mcp_skills`: a escolha é
--     do destino, e omitir uma é erro de quem grava. Aqui há um CHECK que lá
--     não há — pelo menos uma ligada —, porque destino com as três desligadas
--     criaria na aprovação um vínculo que não publica nada;
--   * **sem trigger de carimbo**, ao contrário de `quarantine_files`
--     (`quarantine_files_touch_trg`, `030`). Um trigger aqui dispararia também
--     na cascata de `deleteCatalog`/`deleteVirtualMcp` e faria essas duas
--     transações pedirem a linha do envio (`UPDATE quarantine_skills`) enquanto
--     seguram a do catálogo ou do servidor — a ordem inversa da promoção, que
--     trava o envio primeiro e o catálogo depois: deadlock. Quem grava o
--     destino (`setQuarantineTargets`) carimba o `updated_at` do envio à mão,
--     com a linha já travada.
--
-- Nenhuma ação nova no CHECK de `audit_log`: gravar o destino é
-- `quarantine.update` no envio, e o que a promoção cria é auditado como já se
-- audita — `catalog.update` no catálogo, `mcp.update` no servidor.
--
-- Efeito sobre dados existentes: **nenhum.** Duas tabelas novas, vazias; os
-- envios que já estão na fila ficam sem destino, e aprová-los faz o que sempre
-- fez — a skill nasce flutuante.
--
-- Idempotente: `IF NOT EXISTS` em tudo. Reaplicar não muda nada.

-- ---------------------------------------------------- quarantine_catalogs ---
CREATE TABLE IF NOT EXISTS quarantine_catalogs (
    quarantine_uuid UUID NOT NULL REFERENCES quarantine_skills(uuid) ON DELETE CASCADE,
    -- Apagar o catálogo tira o destino, em silêncio (ver o cabeçalho).
    catalog_uuid    UUID NOT NULL REFERENCES catalogs(uuid) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (quarantine_uuid, catalog_uuid)
);

-- A chave primária cobre a ficha do envio ("para onde ele vai?"); o índice
-- inverso cobre a varredura do CASCADE quando o catálogo é removido.
CREATE INDEX IF NOT EXISTS quarantine_catalogs_catalog_uuid_idx
    ON quarantine_catalogs (catalog_uuid);

-- -------------------------------------------------------- quarantine_mcps ---
CREATE TABLE IF NOT EXISTS quarantine_mcps (
    quarantine_uuid  UUID NOT NULL REFERENCES quarantine_skills(uuid) ON DELETE CASCADE,
    -- Apagar o vMCP tira o destino, em silêncio (ver o cabeçalho).
    virtual_mcp_uuid UUID NOT NULL REFERENCES virtual_mcps(uuid) ON DELETE CASCADE,
    -- As portas do vínculo direto que a aprovação cria, sem DEFAULT, como em
    -- `virtual_mcp_skills`.
    as_skill         BOOLEAN NOT NULL,
    as_prompt        BOOLEAN NOT NULL,
    as_resource      BOOLEAN NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (quarantine_uuid, virtual_mcp_uuid),
    CONSTRAINT quarantine_mcps_some_port_chk CHECK (as_skill OR as_prompt OR as_resource)
);

-- O mesmo papel de `quarantine_catalogs_catalog_uuid_idx`, do lado do vMCP.
CREATE INDEX IF NOT EXISTS quarantine_mcps_virtual_mcp_uuid_idx
    ON quarantine_mcps (virtual_mcp_uuid);
