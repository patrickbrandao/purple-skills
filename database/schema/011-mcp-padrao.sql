-- Purple Skills — o MCP público é o vMCP padrão.
--
-- Problema: o MCP público principal (`/mcp`) era um servidor à parte,
-- hard-coded no mcp-public, com regra de leitura própria (`is_public` mais as
-- flags `use_as_*` da skill), autenticação própria (`MCP_PUBLIC_AUTH`: aberto,
-- `MCP_PUBLIC_KEY` ou chaves `psp_` de `public_mcp_keys`) e downloads
-- apontando para o site. O MCP virtual (`009`) já fazia tudo isso de um jeito
-- só — recorte pelo vínculo, chaves `psv_` ou aberto, downloads próprios — e
-- os dois modelos coexistiam para o mesmo servidor. Desenho fechado em
-- `docs/09-mcp-padrao-e-skills-flutuantes.md` (PR1).
--
-- A partir daqui **só existem vMCPs**. O que responde em `/mcp` é o vMCP que a
-- instalação escolheu como padrão; ele continua respondendo também em
-- `/virtual/<slug>/mcp`, e não tem nenhum outro tratamento especial: pode ser
-- fechado, desligado ou apagado como qualquer um, e nesses casos a raiz
-- responde 404 dizendo a causa. Três peças:
--
--   * `settings` — configuração da instalação, chave-valor. A chave
--     `default_virtual_mcp` guarda o **uuid** do vMCP padrão como texto, sem
--     FK de propósito: um vMCP apagado deixa o valor pendurado, e é assim que
--     o servidor distingue "nenhum padrão configurado" (chave ausente ou nula)
--     de "o padrão foi removido" (valor sem linha em `virtual_mcps`). Quem
--     escreve aqui é só o admin, pelo painel ou pelo mcp-admin.
--
--   * `audit_log.action` ganha `mcp.default` (a troca do padrão, com o slug
--     novo ou "nenhum" em `target_label`). Os valores `public.key.*` ficam no
--     CHECK porque há linhas gravadas com eles; nada mais os produz.
--
--   * `public_mcp_keys` é removida: a raiz passa a autenticar pela regra do
--     próprio vMCP padrão (`is_open` ou chaves `psv_` dele), e as chaves
--     `psp_` não abrem mais nada. Quem as usava emite chaves `psv_` no vMCP
--     padrão. O mcp-public recusa subir enquanto `MCP_PUBLIC_AUTH` ou
--     `MCP_PUBLIC_KEY` estiverem definidas, para o operador ler o aviso.
--
-- Efeito sobre dados existentes — o backfill. Numa instalação que já tem
-- skills, o bloco abaixo cria o vMCP `public` (ou `public-N` se o slug estiver
-- em uso): sem dono, ligado e **aberto**, com toda skill `is_public` vinculada
-- e as três flags do vínculo copiadas de `use_as_skill`/`use_as_prompt`/
-- `use_as_resource`. Assim o `/mcp` de quem sobe de versão publica exatamente
-- o que publicava antes. Nasce aberto porque esse é o padrão do `.env.example`
-- e o estado da maioria das instalações; quem protegia o principal com
-- `MCP_PUBLIC_KEY` é avisado pela trava de boot do mcp-public antes de servir
-- qualquer coisa, e fecha o `public` ou emite chaves no painel. Numa instalação
-- sem skills (nova) nada é criado: a raiz responde 404 até um admin escolher o
-- padrão, ou até o `seed` criar o `public`.
--
-- O bloco é idempotente: só roda quando `settings` ainda não tem a chave.
-- Contadores do vínculo nascem em zero; o total da skill continua o que era.

-- --------------------------------------------------------------- settings ---
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- audit_log ---
-- DROP + ADD porque o Postgres não tem `ADD CONSTRAINT IF NOT EXISTS`; a
-- lista repete a de `010` inteira, e não só acrescenta, porque o CHECK é um
-- objeto só.
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
        'public.key.create',
        'public.key.revoke'
    )
);

-- --------------------------------------------------------------- backfill ---
DO $$
DECLARE
    v_uuid UUID;
    v_slug TEXT := 'public';
    v_n    INT  := 1;
BEGIN
    -- Já rodou, ou um admin já escolheu o padrão: não mexe.
    IF EXISTS (SELECT 1 FROM settings WHERE key = 'default_virtual_mcp') THEN
        RETURN;
    END IF;

    -- Instalação nova: nada a preservar, a raiz começa em 404.
    IF NOT EXISTS (SELECT 1 FROM skills) THEN
        RETURN;
    END IF;

    -- `public` pode ser o slug de um vMCP que alguém já criou; o do backfill
    -- ganha sufixo, como `uniqueSlug` faz no app.
    WHILE EXISTS (SELECT 1 FROM virtual_mcps WHERE slug = v_slug) LOOP
        v_n    := v_n + 1;
        v_slug := 'public-' || v_n;
    END LOOP;

    INSERT INTO virtual_mcps (slug, name, description, is_active, is_open, owner_user_uuid)
    VALUES (
        v_slug,
        'Public',
        'Catálogo público desta instalação: o que o MCP principal publicava antes de existir o MCP padrão.',
        true,
        true,
        NULL
    )
    RETURNING uuid INTO v_uuid;

    -- Toda skill pública entra, com as superfícies que tinha no principal.
    -- Uma skill pública sem nenhuma superfície entra com as três desligadas:
    -- ela continua no vínculo (e no site), sem porta no MCP, como estava.
    INSERT INTO virtual_mcp_skills
        (virtual_mcp_uuid, skill_uuid, as_skill, as_prompt, as_resource)
    SELECT v_uuid, s.uuid, s.use_as_skill, s.use_as_prompt, s.use_as_resource
    FROM skills s
    WHERE s.is_public;

    INSERT INTO settings (key, value) VALUES ('default_virtual_mcp', v_uuid::text);
END $$;

-- -------------------------------------------------------- public_mcp_keys ---
DROP TABLE IF EXISTS public_mcp_keys;
