-- Purple Skills — contabilidade de sessões do MCP público.
--
-- Problema: ninguém sabe quem está conectado a um vMCP. O mcp-public atende
-- três transportes (Streamable HTTP com sessão, SSE legado e Streamable
-- stateless) e não deixa rastro de nenhum deles: o painel não tem como dizer
-- "3 clientes online agora" no globo da Internet do canvas, nem listar quem
-- foi que leu o servidor ontem, com que agente e com qual chave. Desenho em
-- `docs/10-admin-canvas-e-sessoes.md`.
--
-- `mcp_sessions` tem **uma linha por cliente conectado a um vMCP**:
--
--   * `session_id` é o `mcp-session-id` (Streamable), o `sessionId` do SSE ou,
--     no stateless — que não tem sessão —, uma chave sintética que o servidor
--     calcula (hash de IP + agente + credencial + vMCP) para agrupar as
--     requisições de um mesmo cliente numa linha só enquanto elas chegam
--     dentro da janela de "online". Não é única: um restart do servidor
--     reabre a mesma sessão em outra linha, e o histórico das duas vale;
--   * `transport` diz qual dos três; `mount` diz por onde o cliente chegou —
--     a raiz `/mcp` (o vMCP padrão) ou `/virtual/<slug>`. É o mesmo servidor
--     nos dois casos, mas a pergunta "quem ainda usa a raiz?" tem resposta;
--   * `virtual_mcp_uuid` é `ON DELETE SET NULL` e `virtual_mcp_slug` é uma
--     **cópia**: apagar o vMCP não apaga o que aconteceu nele, e a linha
--     continua dizendo em qual servidor foi. `key_id` segue a mesma regra
--     para a chave `psv_` usada (`auth = 'key'`); aberto é `auth = 'open'`;
--   * `ip` chega já resolvido pelo `trust proxy` do app (X-Forwarded-For
--     quando confiável). `client_name`/`client_version` vêm do `clientInfo`
--     do `initialize`, quando o cliente o envia — e podem chegar depois da
--     abertura, por isso o `touch` os preenche só se ainda nulos;
--   * `last_seen_at` avança a cada requisição; `request_count` conta todas.
--     `ended_at` é o fim **real** (`closed`: o cliente fechou; `shutdown`: o
--     servidor parou) ou **presumido** (`timeout`: a varredura de expiração
--     não viu atividade dentro do TTL da sessão, ou da janela do stateless,
--     e grava `last_seen_at` mais o prazo como fim — o instante em que a
--     sessão teria deixado de estar online, e não o instante da varredura).
--
-- "Online" não é uma coluna: é `ended_at IS NULL AND last_seen_at >= now() -
-- janela`, com a janela (`MCP_SESSION_ONLINE_WINDOW_MS`) vinda do app a cada
-- consulta. Uma coluna envelheceria entre duas varreduras; a expressão é
-- verdadeira no instante em que se pergunta.
--
-- Índices: por vMCP e por atividade (a lista do painel, ordenada por
-- `last_seen_at DESC`, filtrada ou não por servidor), e dois **parciais**
-- sobre as abertas — `(last_seen_at) WHERE ended_at IS NULL`, que é o que a
-- varredura de expiração e o contador de online leem, e `(session_id) WHERE
-- ended_at IS NULL`, para o stateless reencontrar a própria linha depois de
-- um restart. As encerradas, que são a maioria com o tempo, ficam fora dos
-- dois.
--
-- **Sem poda automática.** A decisão foi "nunca apagar": a tabela é o
-- histórico de quem usou cada servidor, e uma linha por sessão é barata. Não
-- há job, trigger nem retenção; se um dia for preciso, é uma migration com
-- a política escrita, não um DELETE escondido numa query.
--
-- Efeito sobre dados existentes: nenhum. A tabela nasce vazia; o mcp-public
-- começa a preenchê-la na primeira requisição depois de subir.

-- ----------------------------------------------------------- mcp_sessions ---
CREATE TABLE IF NOT EXISTS mcp_sessions (
    id               UUID PRIMARY KEY DEFAULT uuidv7(),
    session_id       TEXT NOT NULL,
    transport        TEXT NOT NULL CHECK (transport IN ('streamable', 'sse', 'stateless')),
    mount            TEXT NOT NULL CHECK (mount IN ('root', 'virtual')),
    virtual_mcp_uuid UUID REFERENCES virtual_mcps(uuid) ON DELETE SET NULL,
    virtual_mcp_slug TEXT NOT NULL,
    auth             TEXT NOT NULL CHECK (auth IN ('open', 'key')),
    key_id           UUID REFERENCES virtual_mcp_keys(id) ON DELETE SET NULL,
    ip               TEXT NOT NULL,
    user_agent       TEXT,
    client_name      TEXT,
    client_version   TEXT,
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at         TIMESTAMPTZ,
    end_reason       TEXT CHECK (end_reason IN ('closed', 'timeout', 'shutdown')),
    request_count    INTEGER NOT NULL DEFAULT 0
);

-- A lista do painel filtrada por servidor, e a varredura do SET NULL quando o
-- vMCP é apagado.
CREATE INDEX IF NOT EXISTS mcp_sessions_virtual_mcp_last_seen_idx
    ON mcp_sessions (virtual_mcp_uuid, last_seen_at DESC);

-- A lista do painel sem filtro.
CREATE INDEX IF NOT EXISTS mcp_sessions_last_seen_idx
    ON mcp_sessions (last_seen_at DESC);

-- Só as abertas: a varredura de expiração e o contador de online.
CREATE INDEX IF NOT EXISTS mcp_sessions_open_last_seen_idx
    ON mcp_sessions (last_seen_at)
    WHERE ended_at IS NULL;

-- Só as abertas, por sessão: o reuso de linha do stateless depois de um restart.
CREATE INDEX IF NOT EXISTS mcp_sessions_open_session_id_idx
    ON mcp_sessions (session_id)
    WHERE ended_at IS NULL;

-- A varredura do SET NULL quando a chave é removida pela cascata do vMCP.
CREATE INDEX IF NOT EXISTS mcp_sessions_key_id_idx
    ON mcp_sessions (key_id);
