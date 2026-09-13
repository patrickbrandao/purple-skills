-- Purple Skills — posições do canvas de um MCP virtual.
--
-- Problema: o painel do vMCP vira um canvas (`docs/10-admin-canvas-e-sessoes.md`):
-- o servidor é um nó com três portas (Tools, Resources, Prompts), cada skill
-- vinculada é um nó ligado a ele e um globo "Internet" mostra os clientes
-- online. Quem arrasta um nó espera encontrá-lo no mesmo lugar amanhã — e
-- espera que o colega que administra o mesmo servidor veja o mesmo desenho.
-- Posição guardada no navegador não faz nenhuma das duas coisas; o lugar
-- dela é ao lado do que ela posiciona.
--
-- Duas peças:
--
--   * `virtual_mcp_skills.pos_x` / `pos_y` — a posição do nó da skill **no
--     canvas daquele vMCP**. Fica no vínculo, e não na skill, porque a mesma
--     skill pode estar em vários servidores, em lugares diferentes de cada
--     canvas. Nulas = auto-layout (o painel calcula). Caem junto com o
--     vínculo, de propósito: no canvas, tirar a última aresta de uma skill
--     remove o nó **e** o vínculo, e uma posição órfã não teria o que
--     posicionar. Inteiros porque são pixels do React Flow; o CHECK exige as
--     duas juntas — meio ponto não é ponto.
--
--   * `virtual_mcps.layout` — as posições dos nós fixos, como JSON:
--     `{"server": {"x": 0, "y": 0}, "internet": {"x": 0, "y": 0}}`, cada
--     chave opcional. É JSONB, e não duas vezes duas colunas, porque são
--     poucos nós fixos e o conjunto pode crescer sem migration; o CHECK só
--     garante que é um objeto — o app lê apenas as chaves que conhece e
--     ignora o resto. Nasce `{}`: auto-layout.
--
-- Mover um nó é estado de tela, não publicação: as queries que gravam aqui
-- **não** auditam nem tocam `updated_at`, ao contrário de tudo o mais em
-- `virtual_mcps`.
--
-- Efeito sobre dados existentes: nenhum. As posições nascem nulas em todo
-- vínculo e o layout nasce vazio em todo servidor — o canvas abre em
-- auto-layout até alguém arrastar alguma coisa.

-- ---------------------------------------------------- virtual_mcp_skills ---
ALTER TABLE virtual_mcp_skills ADD COLUMN IF NOT EXISTS pos_x INTEGER;
ALTER TABLE virtual_mcp_skills ADD COLUMN IF NOT EXISTS pos_y INTEGER;

-- DROP + ADD porque o Postgres não tem `ADD CONSTRAINT IF NOT EXISTS`.
ALTER TABLE virtual_mcp_skills DROP CONSTRAINT IF EXISTS virtual_mcp_skills_pos_pair_chk;
ALTER TABLE virtual_mcp_skills ADD CONSTRAINT virtual_mcp_skills_pos_pair_chk
    CHECK ((pos_x IS NULL) = (pos_y IS NULL));

-- ---------------------------------------------------------- virtual_mcps ---
-- CHECK nomeado e inline: `ADD COLUMN IF NOT EXISTS` pula o comando inteiro
-- numa segunda execução, constraint junto (como em `004` e `013`).
ALTER TABLE virtual_mcps
    ADD COLUMN IF NOT EXISTS layout JSONB NOT NULL DEFAULT '{}'::jsonb
        CONSTRAINT virtual_mcps_layout_object_chk CHECK (jsonb_typeof(layout) = 'object');
