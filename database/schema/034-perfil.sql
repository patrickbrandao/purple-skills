-- Purple Skills — perfil: quem é a pessoa por trás do `@username`.
--
-- Problema: a `033` fez do `@username` o identificador público — a ficha de
-- uma skill diz "por `@patrick`" —, e não há nada atrás dele
-- (`docs/20-perfil.md` §1). Do lado de dentro é o mesmo: a conta tem `name` e
-- papel, e nada que diga quem a pessoa é. O perfil é esse "atrás": uma foto
-- que substitui o monograma no painel e um bloco **público e opcional**
-- (descrição, site e links) com página em `/u/<username>`.
--
-- O que este arquivo cria:
--
--   * `user_profiles` — a parte editável do perfil, uma linha por conta que já
--     salvou alguma coisa;
--   * `user_avatars` — os bytes da foto, em tabela separada (ver abaixo);
--   * `user.profile` no CHECK de `audit_log.action` — o admin que **limpa** o
--     perfil de alguém (decisão 6). A edição do próprio perfil fica fora da
--     trilha, pelo mesmo critério que mantém o login fora dela (`docs/05`
--     §2.8): mudaria a ordem de grandeza do log.
--
-- **Por que duas tabelas, e não uma com mais uma coluna.** Os bytes da foto
-- não podem viajar junto com a leitura do perfil: a página `/u/<username>` lê
-- o perfil e a ficha de skill lê o dono, e uma coluna `bytea` na mesma linha
-- faria toda leitura arrastar até 512 KB do banco para descartá-los.
-- Separadas, `user_avatars` só é lida pela rota que serve a imagem. É a mesma
-- razão de `files.binary_content` (`001`) existir na linha do arquivo e não na
-- da skill.
--
-- **Nenhuma linha nasce aqui.** A migration cria estrutura vazia: a linha de
-- `user_profiles` nasce no **primeiro salvamento** (`saveProfile`, um
-- `INSERT … ON CONFLICT DO UPDATE`), e quem nunca abriu a tela não tem perfil
-- — toda leitura trata a ausência como o perfil vazio e privado. É a decisão 4
-- (público é opt-in) levada ao banco: ligar o perfil de alguém sem que essa
-- pessoa tenha pedido é o que a funcionalidade existe para não fazer.
--
-- **Não há e-mail em tabela nenhuma daqui, em superfície nenhuma**, e é isso
-- que permite a funcionalidade existir: a decisão 8 do `docs/19-username.md`
-- tirou o endereço de circulação, e um "e-mail de contato público" no perfil o
-- traria de volta pela porta da frente (`docs/20` §9).
--
-- Efeito sobre dados existentes: **nenhum.** Duas tabelas novas, vazias;
-- nenhuma coluna nova nas tabelas antigas; e o CHECK de `audit_log` só cresce,
-- então nenhuma linha gravada passa a violá-lo.
--
-- Idempotente: `IF NOT EXISTS` em tudo e `DROP CONSTRAINT IF EXISTS` antes do
-- `ADD` (não há `ADD CONSTRAINT IF NOT EXISTS`). Reaplicar não muda nada — e
-- não há dado para reaplicar.
--
-- O espelho em TypeScript é `src/schema.ts` (tipagem), `src/queries.ts` (as
-- funções da `§4.1` e `AUDIT_ACTIONS`) e `packages/shared/src/profile.ts`, que
-- é quem decide o que é uma bio, uma URL, um link e uma foto válidos. Os
-- CHECKs abaixo **não** repetem essa regra: eles são teto e lista fechada, o
-- que o banco consegue garantir sozinho para sempre (a mesma divisão do `013`,
-- em que o CHECK do ícone é de tamanho e a forma é do app).

-- ----------------------------------------------------------- user_profiles ---
-- A PK é o `user_uuid`: uma conta tem um perfil, e não há uuid próprio porque
-- não existe perfil sem conta para endereçar. `ON DELETE CASCADE` porque o
-- perfil é *da* pessoa — ao contrário do que ela publicou (skill, catálogo,
-- vMCP), que fica órfão de propósito (`SET NULL` do `017`): a bio de quem foi
-- embora não é acervo de ninguém.
CREATE TABLE IF NOT EXISTS user_profiles (
    user_uuid   UUID PRIMARY KEY REFERENCES users(uuid) ON DELETE CASCADE,
    -- `''` é "sem bio", nunca nulo: os dois seriam o mesmo estado com dois
    -- valores, e um só evita o `?? ''` espalhado por cada tela (`docs/20`
    -- §3.1). Texto puro — o site renderiza markdown com HTML cru desligado, e
    -- o motivo de não haver markdown aqui é outro: título, imagem e tabela
    -- numa bio quebram o cartão e transformam o perfil em página livre.
    bio         TEXT NOT NULL DEFAULT '',
    -- O site pessoal, campo próprio porque o pedido o nomeou à parte
    -- (decisão 5). Aqui o nulo é útil: é ele que diz à página para não
    -- desenhar a linha.
    website_url TEXT,
    -- Até 8 entradas de `{label, url}`. JSONB como `virtual_mcps.layout`
    -- (`014`) — não é padrão novo. Tabela própria daria ordem e constraint por
    -- linha; para no máximo 8 entradas que nunca são consultadas por URL, o
    -- array é o que tem o tamanho do problema.
    links       JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Opt-in, desligado por padrão (decisão 4): bio, foto e links são
    -- auto-expressão, não metadado do acervo. Decide o que sai para o
    -- **anônimo**; no painel, entre contas logadas, a foto aparece de todo
    -- jeito, como o monograma já aparece.
    is_public   BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- `BIO_MAX_LENGTH` do shared. Em caracteres, não em bytes: é o que
    -- `normalizeBio` mede, e medir diferente dos dois lados deixaria passar
    -- pelo app o que o banco recusa (ou o contrário) no primeiro acento.
    CONSTRAINT user_profiles_bio_len_chk CHECK (length(bio) <= 500),
    -- `PROFILE_URL_MAX_LENGTH`. O CHECK é **teto**, não forma: quem decide se
    -- a URL vale é `isProfileUrl` (http(s) absoluto, sem espaço), como no
    -- ícone da skill (`013`). Sem o teto, o campo vira texto livre servido de
    -- graça numa página anônima.
    CONSTRAINT user_profiles_website_len_chk CHECK (
        website_url IS NULL OR length(website_url) <= 512
    ),
    -- `jsonb_typeof` mais cardinalidade, a dupla do `virtual_mcps.layout`
    -- (`014`) com o teto do `PROFILE_LINKS_MAX`. O limite de 8 não é estético:
    -- a lista vai para uma página anônima e, sem teto, é um campo de texto
    -- livre de 8 KB servido a quem passar. O **conteúdo** de cada entrada
    -- (rótulo aparado, URL http(s), sem URL repetida) é de
    -- `normalizeProfileLinks` — um CHECK não faz subconsulta, e conferir
    -- elemento a elemento em SQL seria a terceira cópia de uma regra que já
    -- tem duas.
    CONSTRAINT user_profiles_links_chk CHECK (
        jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 8
    )
);

-- O índice da rota pública. `getPublicProfile` casa por `lower(username)` **e**
-- `is_public` **e** `users.is_active`: o primeiro pedaço já tem índice desde a
-- `033` (`users_username_lower_uniq`, único e por expressão), e `is_active` sai
-- da mesma linha de `users` que ele encontra. O que falta é o pedaço daqui, e
-- **parcial** de propósito: o perfil privado não entra no índice, então a
-- pergunta "esta conta tem perfil público?" se resolve no índice, sem tocar a
-- tabela. Quem a faz em volume não é a página do perfil (uma linha) e sim o
-- `ownerHasProfile` de `skillColumns`, uma vez por skill em toda listagem do
-- site — e lá a resposta é "não" na maioria esmagadora das linhas, que é
-- exatamente o caso que o índice parcial resolve sem heap.
--
-- Ele só é usado se a pergunta for feita **por linha**, e por isso
-- `ownerHasProfile` é uma subconsulta escalar em `src/queries.ts`, e não um
-- `EXISTS`: o `EXISTS` correlacionado vira *hashed SubPlan* e o planejador
-- varre `user_profiles` inteira uma vez por consulta, ignorando este índice.
-- Medido na listagem do site com 50 mil perfis: 10,9 ms contra 4,2 ms
-- (Index Only Scan, `Heap Fetches: 0`). O comentário da função tem os números.
--
-- Parcial não cabe no DSL do Drizzle: fica só aqui, com a linha em
-- `SOMENTE_SQL` de `src/schema.integration.test.ts`.
CREATE INDEX IF NOT EXISTS user_profiles_public_idx
    ON user_profiles (user_uuid) WHERE is_public;

-- ------------------------------------------------------------ user_avatars ---
-- Uma foto por conta; enviar de novo substitui (`docs/20` §3.2). Mesma PK e
-- mesma cascata de `user_profiles`, e **independente dela**: a foto aparece no
-- painel mesmo com o perfil privado, e pode existir sem nenhum campo público
-- salvo.
CREATE TABLE IF NOT EXISTS user_avatars (
    user_uuid  UUID PRIMARY KEY REFERENCES users(uuid) ON DELETE CASCADE,
    bytes      BYTEA NOT NULL,
    mime       TEXT NOT NULL,
    -- Existe para o **ETag** da rota que serve a imagem: é o que faz o
    -- navegador revalidar com 304 em vez de baixar de novo, sem cache longo —
    -- e cache longo é justamente o que deixaria um avatar visível depois de o
    -- perfil virar privado ou de a conta ser desativada.
    sha256     BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- `AVATAR_MIME_TYPES` do shared, lista fechada e repetida aqui. **SVG está
    -- fora, e não por descuido:** ele é XML com `<script>` dentro, e servido na
    -- mesma origem do site um SVG de avatar é execução de código de terceiro na
    -- página — nenhum teto de tamanho resolve isso. Quem decide o tipo são os
    -- **bytes iniciais** (`sniffAvatarMime`), nunca a extensão nem o
    -- `Content-Type` do cliente; o CHECK é a última linha, para o caso de um
    -- caminho de escrita novo esquecer a conferência.
    CONSTRAINT user_avatars_mime_chk CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    -- `AVATAR_MAX_BYTES` (512 KB), conferido sobre os bytes gravados e não
    -- sobre o `Content-Length`, que é texto que quem envia escolhe. O piso de
    -- 1 byte fecha a outra ponta: arquivo vazio não é imagem, e `sniffAvatarMime`
    -- já o recusaria — aqui ele também não entra por SQL cru.
    CONSTRAINT user_avatars_size_chk CHECK (octet_length(bytes) BETWEEN 1 AND 524288),
    -- O hash é conferido pelo banco, como em `rag_texts_sha256_chk` (`020`):
    -- um ETag que não corresponde aos bytes servidos é pior do que nenhum ETag,
    -- porque o navegador guarda a imagem errada e não volta a perguntar.
    CONSTRAINT user_avatars_sha256_chk CHECK (sha256 = sha256(bytes))
);

-- ======================================= a ação nova de auditoria ===========
-- `user.profile`: um admin **limpou** o perfil público de uma conta — bio,
-- site, links e foto saem, e o `is_public` desliga (decisão 6). É moderação, e
-- o único caminho pelo qual alguém que não é o dono mexe no perfil: o admin
-- nunca escreve texto no lugar de outra pessoa. `actor_label` é quem limpou;
-- `target_label` é o username de quem foi limpo.
--
-- A edição do **próprio** perfil não entra na trilha (decisão derivada do §2),
-- e é por isso que existe uma ação só, e não um `user.profile` por salvamento.
--
-- DROP + ADD porque não há `ADD CONSTRAINT IF NOT EXISTS`; a lista repete a da
-- `033-username.sql` inteira, e não só acrescenta, porque o CHECK é um objeto
-- só. **Quem mexer neste CHECK depois parte desta lista.**
--
-- Sobre dados existentes: nenhum efeito. A lista só cresce, então nenhuma
-- linha gravada passa a violá-la; o `ADD CONSTRAINT` valida a tabela inteira
-- sob ACCESS EXCLUSIVE, como nas onze vezes anteriores desde o `004`.
--
-- O espelho em TypeScript é `AUDIT_ACTIONS` (`src/queries.ts`, o filtro de
-- `listAuditPage`) e `AuditAction` de `@purple-skills/shared`. `user.profile`
-- **não** entra no union de `recordAccountAudit`: quem a grava é `clearProfile`,
-- que apaga e audita na mesma transação — auditar a limpeza numa chamada
-- separada deixaria a trilha e o dado divergirem quando a segunda falhasse.
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
        'user.username',
        'user.profile',
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
        'skill.clone',
        'catalog.clone',
        'mcp.clone',
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
