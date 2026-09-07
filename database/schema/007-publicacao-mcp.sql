-- Purple Skills — skill publicada como prompt e como resource do MCP público.
--
-- Problema: `is_public` diz **se** a skill aparece no MCP, nunca **como**. Só
-- existe uma porta — as cinco ferramentas — e o agente só chega ao conteúdo
-- chamando `get_skill`. O protocolo tem duas superfícies melhores para o caso:
-- o prompt, que o cliente lista e o usuário invoca como slash-command, e o
-- resource, um endereço estável `skill://<slug>`. Ligar as duas para o
-- catálogo inteiro seria pior que não ligar (entope a lista de slash-commands
-- de todo cliente conectado), então são opt-in por skill. Desenho fechado em
-- `docs/06-publicacao-mcp.md`.
--
-- As colunas são **ortogonais** a `is_public`: não há CHECK amarrando uma à
-- outra (§3.1). Com um CHECK, despublicar uma skill flagada falharia ou
-- exigiria zerar as flags junto — e a intenção do admin ("quando eu publicar,
-- quero que ela seja um prompt") se perderia no caminho. Soltas, o ciclo
-- publicar → despublicar → republicar preserva a configuração, e o estado
-- "privada, mas será prompt quando publicar" é representável. Quem condiciona
-- é a consulta do MCP público, que filtra `is_public AND use_as_prompt` (ou
-- `use_as_resource`): a flag sozinha nunca publica nada.
--
-- Efeito sobre dados existentes: nenhum. As colunas nascem `false` e não há
-- backfill (§3.2) — ligar o catálogo todo de uma vez é exatamente o que a
-- feature existe para evitar. `DEFAULT` não volátil não reescreve a tabela no
-- PostgreSQL ≥ 11, então o ALTER é instantâneo mesmo com catálogo grande.

ALTER TABLE skills ADD COLUMN IF NOT EXISTS use_as_prompt   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS use_as_resource BOOLEAN NOT NULL DEFAULT false;

-- `prompts/list` e `resources/list` não são paginados e não têm teto (§5.3):
-- cada chamada devolve o catálogo flagado inteiro, e o cliente relista com
-- frequência porque a fábrica do servidor é síncrona e nada notifica mudança.
-- Os índices são **parciais** com o predicado exato dessas consultas — só as
-- poucas linhas flagadas entram, e a pergunta "quais NÃO são prompt?" nunca é
-- feita. O custo de escrita fica em zero para a esmagadora maioria dos UPDATEs
-- de `skills`, que não tocam nenhuma das duas flags.
CREATE INDEX IF NOT EXISTS skills_public_prompt_idx
    ON skills (is_public, use_as_prompt)
    WHERE is_public AND use_as_prompt;

CREATE INDEX IF NOT EXISTS skills_public_resource_idx
    ON skills (is_public, use_as_resource)
    WHERE is_public AND use_as_resource;
