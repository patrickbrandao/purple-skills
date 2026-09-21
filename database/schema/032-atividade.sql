-- Purple Skills — a tela de Atividade: contagem de chamadas do MCP público.
--
-- Problema: o painel tem três tabelas que descrevem o dia a dia da instalação
-- — `mcp_sessions` (quem se conectou), `skill_accesses` (o que foi lido) e
-- `audit_log` (o que mudou no catálogo) — e nenhuma delas jamais foi lida
-- **por dia**: não há como responder "quanto se usou isto na terça?". Pior,
-- falta a fonte mais óbvia: **o que foi chamado**. O MCP público atende
-- `tools/call`, `resources/read`, `prompts/get`, os três métodos da SEP-2640 e
-- o vaivém de `initialize`/`ping`/`notifications/*`, e o único rastro disso é
-- `mcp_sessions.request_count` — um número só, por sessão, que soma tudo e não
-- distingue método nenhum. A tela de Atividade (`docs/18-atividade.md`) é a
-- grade de dias mais o relatório agregado de um deles, e é esta migration que
-- lhe dá a quarta fonte.
--
-- `mcp_call_counters` é **contador, não registro**: a menor unidade é "quantas
-- vezes". Não se grava nome de tool, argumento, IP, e-mail nem `session_id`
-- (decisão 4 da tela) — quem precisa do evento a evento tem a trilha, as
-- sessões e a guia de acessos da skill. Uma linha por chamada custaria a
-- escrita no caminho quente do servidor (é uma linha por **mensagem**
-- JSON-RPC, `ping` incluído) para guardar o que o relatório não mostra.
--
--   * `bucket` é o início de um balde de 15 minutos, calculado pelo app
--     (`MCP_CALL_BUCKET_MS` em shared). Quinze minutos é o maior passo que
--     ainda permite recortar o dia em **qualquer** fuso: todo deslocamento da
--     base IANA é múltiplo de 15 min (o +05:45 do Nepal é o extremo). Com
--     balde de uma hora um relatório em Katmandu somaria 45 minutos do dia
--     vizinho; com balde diário o fuso teria de ser congelado na gravação e o
--     número nunca fecharia com o das outras três fontes, que são instantes
--     exatos. O rastreador do MCP público acumula em memória e despeja no
--     mesmo flush agrupado que já existe para `request_count`;
--   * `virtual_mcp_uuid` é `ON DELETE SET NULL` e `virtual_mcp_slug` é a
--     **cópia**, como em `015` e `018`: apagar o vMCP não apaga o que
--     aconteceu nele;
--   * `transport` diz qual dos três transportes atendeu, com o mesmo `CHECK`
--     de `mcp_sessions`; `method` é o método JSON-RPC cru;
--   * `family` é **derivada** de `method` (`mcpCallFamily` em shared) e é
--     gravada junto de propósito: o relatório agrupa por ela sem reimplementar
--     a regra em SQL — a regra mora num lugar só, e um método novo do
--     protocolo não exige reescrever a consulta. O preço é que a classificação
--     fica congelada na gravação; reclassificar é um `UPDATE` numa migration,
--     com a história dita, e não uma mudança silenciosa de sentido nos números
--     antigos;
--   * `calls` é quanto aquele balde somou.
--
-- **A chave do conflito é `(bucket, virtual_mcp_slug, transport, method)`, e
-- não o uuid.** Duas razões, e as duas doem: `virtual_mcp_uuid` é anulável
-- (`SET NULL`) e coluna de PK não aceita nulo; e, mesmo num UNIQUE, NULL nunca
-- conflita com NULL no btree — depois de o vMCP ser apagado, cada flush
-- inseriria uma linha nova em vez de somar na que já existe, e o relatório
-- passaria a contar em dobro exatamente onde a cópia deveria segurar o
-- histórico. O slug é `NOT NULL` e é a identidade histórica do servidor, a
-- mesma que `015` e `018` guardam.
--
-- **O teto de `method` é saneamento no TS, não `CHECK`.** `method` é texto de
-- terceiro: o cliente escolhe o que manda. O flush é **um** INSERT com várias
-- linhas, e um `CHECK` recusado derrubaria a statement inteira — as chamadas
-- de todos os outros vMCPs daquele despejo se perderiam por causa de um
-- cliente torto, que é o mesmo defeito de `tasks/038` (o byte nulo no
-- `clientInfo` derrubava a linha **e** os contadores). Então `bumpMcpCallCounters`
-- limpa e corta antes de gravar, como `normalizeSessionLabel` faz com os
-- rótulos: fora a categoria `Cc` inteira — o Postgres recusa U+0000 em `text`
-- com 22021 antes mesmo de olhar a consulta — e corte no teto. Cortar também é
-- o que mantém a linha dentro do limite de tupla de índice do btree (~2704
-- bytes), que `method` sendo parte da PK torna alcançável por quem quiser.
-- Pelo mesmo motivo a função **deduplica** depois de limpar: dois métodos crus
-- que virem o mesmo texto limpo na mesma statement dariam 21000 ("ON CONFLICT
-- DO UPDATE command cannot affect row a second time"), que é a armadilha já
-- medida em `upsertFilesTx`.
--
-- Índices:
--
--   * a PK serve ao `ON CONFLICT` do flush, que é a escrita quente;
--   * `mcp_call_counters_bucket_idx (bucket DESC)` é a faixa do heatmap e a do
--     relatório do dia — as duas filtram `bucket >= … AND bucket <= …`, e sem
--     ele a varredura seria da tabela inteira. `DESC` para acompanhar o resto
--     do projeto, em que toda leitura é "os mais recentes";
--   * `mcp_sessions_started_at_idx (started_at DESC)` é o índice que faltava:
--     `mcp_sessions` só tinha por `last_seen_at`, e a série do heatmap conta
--     sessões **abertas** no dia (`started_at`), não tocadas nele;
--   * `mcp_sessions_ended_at_idx (ended_at DESC)` é o par dele para o
--     relatório do dia, que conta as sessões **encerradas** no dia e as quebra
--     por motivo — uma sessão pode ter começado ontem. O custo de escrita é
--     pequeno perto do que a tabela já paga: `last_seen_at` é indexado e sobe
--     a cada requisição, então todo `UPDATE` de sessão já é não-HOT; encerrar
--     acrescenta uma entrada de índice, e encerrar acontece uma vez por
--     sessão.
--
-- **Sem poda automática**, pela mesma decisão de `015` e `018` (`docs/10`
-- decisão 8): nunca apagar. Aqui ela é barata por construção — o número de
-- linhas por dia é 96 baldes × vMCPs × transportes × métodos distintos, e não
-- cresce com o tráfego. Se um dia for preciso podar, é uma migration com a
-- política escrita, não um DELETE escondido numa query.
--
-- Efeito sobre dados existentes: nenhum. A tabela nasce vazia e o MCP público
-- começa a preenchê-la no primeiro flush depois de subir; as chamadas
-- anteriores a esta migration não têm linha — `mcp_sessions.request_count` é
-- a única memória delas, e ele não sabe dizer de que método foram. Os dois
-- índices de `mcp_sessions` não mudam dado nenhum.

-- ------------------------------------------------------ mcp_call_counters ---
CREATE TABLE IF NOT EXISTS mcp_call_counters (
    bucket           TIMESTAMPTZ NOT NULL,
    virtual_mcp_uuid UUID REFERENCES virtual_mcps(uuid) ON DELETE SET NULL,
    virtual_mcp_slug TEXT NOT NULL,
    transport        TEXT NOT NULL CHECK (transport IN ('streamable', 'sse', 'stateless')),
    method           TEXT NOT NULL,
    family           TEXT NOT NULL CHECK (
                         family IN ('tools', 'resources', 'prompts', 'skills', 'session', 'other')
                     ),
    calls            BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, virtual_mcp_slug, transport, method)
);

-- A faixa do heatmap e a do relatório do dia.
CREATE INDEX IF NOT EXISTS mcp_call_counters_bucket_idx
    ON mcp_call_counters (bucket DESC);

-- A varredura do SET NULL quando o vMCP é apagado — a PK começa por `bucket`
-- e não serve para achar as linhas de um servidor.
CREATE INDEX IF NOT EXISTS mcp_call_counters_virtual_mcp_idx
    ON mcp_call_counters (virtual_mcp_uuid);

-- ------------------------------------------------ índices de mcp_sessions ---
-- A série do heatmap: sessões abertas no dia.
CREATE INDEX IF NOT EXISTS mcp_sessions_started_at_idx
    ON mcp_sessions (started_at DESC);

-- O relatório do dia: sessões encerradas no dia, e o motivo de cada uma.
CREATE INDEX IF NOT EXISTS mcp_sessions_ended_at_idx
    ON mcp_sessions (ended_at DESC);
