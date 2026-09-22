-- Purple Skills — username: o identificador público da conta.
--
-- Problema: o **e-mail** é hoje o identificador público desta instalação
-- (`docs/19-username.md` §1). Ele aparece como dono de toda skill, catálogo e
-- vMCP; na lista de concessões e em "concedido por"; na guia Acessos, que é de
-- `manage` e não de admin (o dono de uma skill vê o endereço de quem a leu);
-- na busca "Compartilhar com…", aberta a **qualquer conta logada**; na URL das
-- rotas de concessão; e congelado em texto em `audit_log.actor_label` /
-- `target_label` e em `skill_accesses.user_email`. Numa instalação com dez
-- colaboradores, uma conta `membro` recém-criada lê o endereço de todo mundo
-- digitando duas letras. Nenhuma dessas telas precisa de um endereço: precisa
-- de um nome curto e estável que identifique uma pessoa.
--
-- O username ocupa esse lugar e devolve ao e-mail três usos, todos privados:
-- entrar, recuperar a senha e casar com a identidade do OIDC (`docs/05` §2.4 e
-- §2.6, que **não** mudam). Esta migration é a parte de banco, em cinco
-- partes, na ordem do `docs/19` §4:
--
--   1. `users.username`, que nasce nula;
--   2. o backfill derivado do **campo `name`**, nunca da parte antes do `@` —
--      publicar o local part para todo o painel vazaria metade do endereço,
--      que é o que esta mudança existe para evitar (decisão 4);
--   3. `usernames`, o livro de nomes já usados: username abandonado nunca
--      volta a circular (decisão 6);
--   4. a reescrita do histórico congelado (decisão 7);
--   5. `user.username` no CHECK de `audit_log.action` (decisão 5).
--
-- Efeito sobre dados existentes: **grande e deliberado.** Toda conta ganha um
-- username derivado do nome; `audit_log.actor_label`/`target_label` e
-- `skill_accesses` são reescritos, trocando e-mail por username onde a conta
-- ainda existe e por `conta removida` onde não existe mais; e
-- `skill_accesses.user_email` **deixa de existir**. Não há caminho de volta: o
-- endereço some da trilha, que é o ponto. Quem quiser o antes precisa do
-- backup anterior a esta migration.
--
-- Idempotente: `IF NOT EXISTS` / `OR REPLACE` / `DROP … IF EXISTS`, o backfill
-- só olha `username IS NULL`, a semeadura de `usernames` é
-- `ON CONFLICT DO NOTHING` e os dois blocos de reescrita procuram **e-mail**,
-- que depois da primeira passada já não está em rótulo nenhum. Reaplicar num
-- banco já migrado não reescreve nada e não falha — o bloco de
-- `skill_accesses` inteiro fica atrás de "a coluna `user_email` ainda existe?".
--
-- Custo: a reescrita de `audit_log` é um `UPDATE` por conta, cada um varrendo
-- a tabela (que nunca é podada, `004`). Com dezenas de contas e 200 mil linhas
-- são alguns segundos; numa instalação com milhares de contas vale rodar fora
-- do horário de uso, como o `022` já avisava.
--
-- O espelho em TypeScript é `src/schema.ts` (tipagem), `src/queries.ts`
-- (`USER_COLUMNS`, `AUDIT_ACTIONS`, as projeções de rótulo) e
-- `packages/shared/src/username.ts`, que é quem decide o que é um username
-- válido — aqui a regra é repetida em SQL, e só porque uma migration não
-- chama TypeScript.

-- =========================================================== 1. a coluna ===
-- Nasce nula: o backfill abaixo a preenche e só então ela vira NOT NULL.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;

-- O índice único vem **antes** do backfill, de propósito: com a coluna toda
-- nula ele não recusa nada (NULL não colide com NULL) e é ele que o laço usa
-- para perguntar "este nome está livre?" sem varrer `users` a cada conta.
-- Por expressão, como `users_email_lower_uniq` (`004`) — fica só no SQL, com
-- a linha em `SOMENTE_SQL` de `src/schema.integration.test.ts`.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_uniq ON users (lower(username));

-- ========================================================= 2. o backfill ===
-- A regra é a de `usernameFromName` (`docs/19` §3.1), repetida em SQL:
--
--   1. remove os acentos — `Patrick Brandão` → `Patrick Brandao`;
--   2. caixa baixa;
--   3. tudo que não é [a-z0-9] vira `-`;
--   4. colapsa repetições de `-` (o `+` da classe já faz isso) e apara a
--      pontuação das pontas;
--   5. corta em 32 e apara de novo;
--   6. menos de 3 caracteres, ou reservado: cai no `user-<8 hex do uuid>`.
--
-- **`translate()` com mapa explícito, não `unaccent`.** Esta instalação não
-- tem a extensão, e a migration não vai passar a exigir uma. O par de cadeias
-- é copiado de `ACCENT_FROM`/`ACCENT_TO` de `packages/shared/src/username.ts`,
-- caractere a caractere: as duas implementações da mesma regra só ficam iguais
-- se a regra for uma tabela. Se fosse NFD lá e `translate()` aqui, o backfill
-- e a criação de conta divergiriam em silêncio no primeiro nome acentuado.
--
-- Três checagens de `normalizeUsername` **não** aparecem aqui porque o
-- resultado do passo 5 não tem como falhá-las: o texto só tem `[a-z0-9-]`, não
-- começa nem termina em `-` e não tem `--` (a classe com `+` colapsa a
-- repetição), então a forma está satisfeita; e nenhum candidato tem forma de
-- uuid, que exige 36 caracteres contra o teto de 32.
--
-- **A colisão recebe sufixo numérico** (`-2`, `-3`, …, truncando o radical
-- para caber em 32) — é `usernameWithSuffix`, a mesma regra que
-- `nextFreeUsername` aplica na criação de conta e no auto-provisionamento
-- OIDC. O `docs/19` §4 diz "colisão … cai no `user-<8 hex>`", e isso **não
-- fecha**: `users.uuid` é `uuidv7()`, cujos 8 primeiros hex são os 32 bits
-- altos do carimbo de milissegundos — eles só mudam a cada ~65 segundos, e
-- duas contas criadas no mesmo minuto cairiam no *mesmo* `user-<8 hex>`, que é
-- outra colisão. Seguimos, então, a decisão 4 da tabela ("derivado do campo
-- `name`, com sufixo numérico em colisão") e o §3.1, e guardamos o
-- `user-<8 hex>` para o que o §4 descreve sem ambiguidade: nome inutilizável e
-- nome reservado. Um mecanismo só, que também resolve dois `user-<8 hex>`
-- iguais.
--
-- Linha a linha, e não um `UPDATE … FROM` com janela: o sufixo tem de
-- consultar o que as linhas anteriores **acabaram** de tomar (dois "Ana" e uma
-- "Ana 2" dariam `ana`, `ana-2` e `ana-2` num passe só), e um laço que fecha
-- contra o índice é mais barato de ler do que a janela recursiva que faria o
-- mesmo. A ordem é `created_at, uuid`: determinística, e quem chegou primeiro
-- fica com o nome derivado.
DO $$
DECLARE
    conta     RECORD;
    base      TEXT;
    candidato TEXT;
    n         INTEGER;
BEGIN
    FOR conta IN
        SELECT uuid, name, created_at FROM users WHERE username IS NULL
        ORDER BY created_at, uuid
    LOOP
        base := nullif(
            regexp_replace(
                left(
                    regexp_replace(
                        regexp_replace(
                            lower(translate(
                                conta.name,
                                'àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝÑÇ',
                                'aaaaaaeeeeiiiiooooouuuuyyncAAAAAAEEEEIIIIOOOOOUUUUYNC'
                            )),
                            '[^a-z0-9]+', '-', 'g'),
                        '^-+|-+$', '', 'g'),
                    32),
                '-+$', '', 'g'),
            '');

        -- Nome inutilizável (vazio, só pontuação), curto demais ou reservado:
        -- a lista é `RESERVED_USERNAMES` do shared, repetida.
        IF base IS NULL
           OR length(base) < 3
           OR base = ANY (ARRAY[
                  'admin', 'api', 'me', 'none', 'null', 'purple-skills',
                  'root', 'setup', 'support', 'system'
              ])
        THEN
            base := 'user-' || left(replace(conta.uuid::text, '-', ''), 8);
        END IF;

        n := 1;
        candidato := base;
        WHILE EXISTS (SELECT 1 FROM users v WHERE lower(v.username) = candidato) LOOP
            n := n + 1;
            -- `usernameWithSuffix`: o radical é truncado para o sufixo caber
            -- no teto, e a pontuação que sobrar na emenda é aparada.
            candidato := rtrim(left(base, 32 - length(n::text) - 1), '-._') || '-' || n::text;
        END LOOP;

        UPDATE users SET username = candidato WHERE uuid = conta.uuid;
    END LOOP;
END $$;

-- Com toda linha preenchida, a coluna passa a ser obrigatória. Reaplicar é
-- no-op: `SET NOT NULL` numa coluna que já é NOT NULL não falha nem reescreve.
ALTER TABLE users ALTER COLUMN username SET NOT NULL;

-- ============================================ 3. o livro de usernames ======
-- Decisão 6: **username abandonado nunca volta.** Sem esta tabela o `@joao` de
-- uma trilha de 2025 poderia ser outra pessoa em 2026, e a trilha de auditoria
-- — que congela rótulo em texto justamente para sobreviver à remoção da conta
-- (`004`) — passaria a apontar para quem não fez nada.
--
-- Tomar um username é **inserir aqui**: a PK é o que torna a reserva atômica e
-- permanente. `released_at` preenchido diz "não é de ninguém e não volta a
-- ser". `user_uuid` é anulável porque a conta pode ser apagada e a reserva tem
-- de sobreviver a isso — a mesma razão de `actor_label` existir.
CREATE TABLE IF NOT EXISTS usernames (
    username_lower TEXT PRIMARY KEY,
    user_uuid      UUID REFERENCES users(uuid) ON DELETE SET NULL,
    taken_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at    TIMESTAMPTZ
);

-- Chave estrangeira sem índice transforma a remoção de uma conta num seq scan
-- da tabela referenciada (`004`, a mesma razão de `skills_created_by_idx`).
CREATE INDEX IF NOT EXISTS usernames_user_uuid_idx ON usernames (user_uuid);

-- A semeadura com o que o backfill acabou de decidir. `ON CONFLICT DO NOTHING`
-- para a reaplicação: numa instalação em que um admin já trocou o username de
-- alguém, a linha antiga (com `released_at`) e a nova já estão aqui, e nenhuma
-- das duas pode ser reescrita.
INSERT INTO usernames (username_lower, user_uuid)
SELECT lower(username), uuid FROM users
ON CONFLICT (username_lower) DO NOTHING;

-- =================================== 4. a reescrita do histórico ===========
-- Decisão 7. O que está congelado em texto continua congelado — o que muda é
-- **qual** texto. Onde a conta ainda existe, entra o username; o que não
-- resolve vira `conta removida`.

-- ------------------------------------------------------- skill_accesses ---
-- Uma linha por leitura de skill (`018`), e a coluna `user_email` é a cópia
-- que sobrevive à remoção da conta. Ela vira `user_username`.
--
-- O bloco inteiro fica atrás de "a coluna antiga ainda existe?": depois da
-- primeira passada ela não existe mais, e um `UPDATE` que a cite seria erro de
-- sintaxe em tempo de execução, não um no-op. É o que torna a reaplicação
-- segura sem `IF EXISTS` espalhado por comando.
ALTER TABLE skill_accesses ADD COLUMN IF NOT EXISTS user_username TEXT;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'skill_accesses' AND column_name = 'user_email'
    ) THEN
        -- 1º: pelo uuid, que é o vínculo de verdade enquanto a conta existe.
        UPDATE skill_accesses a SET user_username = u.username
          FROM users u
         WHERE u.uuid = a.user_uuid AND a.user_username IS NULL;

        -- 2º: o que sobrou com e-mail gravado tenta casar por `lower(email)` —
        -- a conta pode ter sido recriada, ou o `SET NULL` da remoção do `018`
        -- pode ter zerado o uuid de uma conta homônima que voltou.
        UPDATE skill_accesses a SET user_username = u.username
          FROM users u
         WHERE a.user_username IS NULL
           AND a.user_email IS NOT NULL
           AND lower(u.email) = lower(a.user_email);

        -- 3º: o resto. `user_email` nulo é leitura **sem conta** (site
        -- anônimo, vMCP aberto) e continua sem username — `conta removida` ali
        -- seria inventar uma conta que nunca houve.
        UPDATE skill_accesses SET user_username = 'conta removida'
         WHERE user_username IS NULL AND user_email IS NOT NULL;

        ALTER TABLE skill_accesses DROP COLUMN user_email;
    END IF;
END $$;

-- O GIN de trigrama do `022` caiu junto com a coluna (todo índice cai com ela).
-- Sem ele o `q` da guia Acessos volta ao `Seq Scan`: num `OR`, o planejador só
-- monta o `BitmapOr` quando **todos** os ramos têm índice.
DROP INDEX IF EXISTS skill_accesses_user_email_trgm_idx;

CREATE INDEX IF NOT EXISTS skill_accesses_user_username_trgm_idx
    ON skill_accesses USING GIN (user_username gin_trgm_ops);

-- ------------------------------------------------------------ audit_log ---
-- O rótulo é **composto**, em quatro formatos: `email` (evento de conta,
-- `*.unshare` de skill, transferência de skill), `email:nível`
-- (`skill.share`), `<slug> email:nível` (`catalog.share`, `mcp.share`) e
-- `email <resto>` (`user.link`, que leva o `subject` depois). Por isso a troca
-- é **por ocorrência**, não por igualdade.
--
-- A fronteira vale nas **duas pontas**: à esquerda o começo do texto ou um
-- espaço; à direita o fim, um espaço ou `:`. Sem ela, `ana@x.com` seria
-- trocado dentro de `ana@x.com.br` — que pode não ser conta nenhuma e por isso
-- não é alcançado pela ordem decrescente abaixo.
--
-- A troca é literal (`replace`, não `regexp_replace`): o e-mail é dado de
-- usuário e virar regex exigiria escapar `.`, `+` e `-` sem errar nenhum. O
-- casamento é sensível à caixa, e isso é correto aqui: o rótulo é cópia de
-- `users.email`, e `updateUser` não aceita trocar o e-mail de uma conta — a
-- grafia gravada na trilha é a mesma que está na tabela. O que escapar disso
-- cai na varredura final.
CREATE OR REPLACE FUNCTION username_troca_rotulo(rotulo TEXT, de TEXT, para TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    -- O texto é acolchoado com um espaço em cada ponta para que "começo" e
    -- "fim" virem o mesmo caso que "espaço", e desacolchoado no fim. `substr`
    -- e não `btrim`: tirar exatamente um caractere de cada lado preserva um
    -- rótulo que já tivesse espaço nas pontas.
    SELECT substr(t, 2, length(t) - 2)
      FROM (
        SELECT replace(
                   replace(' ' || rotulo || ' ', ' ' || de || ':', ' ' || para || ':'),
                   ' ' || de || ' ',
                   ' ' || para || ' '
               ) AS t
      ) x
$$;

-- **Ordem decrescente de `length(email)`**: sem ela `ana@x.com` seria trocado
-- dentro de `mariana@x.com` — que é conta de outra pessoa e, se viesse
-- primeiro, já teria sido trocada por inteiro. As duas defesas (a ordem e a
-- fronteira) cobrem casos diferentes e nenhuma das duas é dispensável.
--
-- O `WHERE` é só para não reescrever a linha que não contém o endereço: a
-- troca em si está dentro da função.
DO $$
DECLARE
    conta RECORD;
BEGIN
    FOR conta IN
        SELECT email, username FROM users ORDER BY length(email) DESC, lower(email)
    LOOP
        UPDATE audit_log SET
            actor_label  = username_troca_rotulo(actor_label,  conta.email, conta.username),
            target_label = username_troca_rotulo(target_label, conta.email, conta.username)
         WHERE strpos(coalesce(actor_label, ''),  conta.email) > 0
            OR strpos(coalesce(target_label, ''), conta.email) > 0;
    END LOOP;
END $$;

-- A função existe só para esta migration; deixá-la no banco seria um objeto
-- que nenhuma query chama e que o `schema.ts` não descreve.
DROP FUNCTION IF EXISTS username_troca_rotulo(TEXT, TEXT, TEXT);

-- A varredura final: o que sobrou com forma de e-mail é de conta que não
-- existe mais, e vira `conta removida` — a ocorrência, não a linha inteira,
-- para o `<slug>` e o `:nível` que estão ao lado continuarem legíveis.
--
-- Ela é **restrita às ações cujo rótulo sabidamente é um e-mail**: `user.*`,
-- `*.share` e `*.unshare` em `target_label`, e `actor_label` de qualquer ação
-- (ali só há e-mail de conta, `token-global`, `bootstrap`,
-- `link-de-redefinicao` e `oidc:<issuer>`). `target_label` de quarentena fica
-- **fora**: é nome de envio escrito por gente, e um envio chamado
-- `relatorio@2026.q1` não é conta nenhuma. O mesmo vale para o slug de uma
-- clonagem e para o `chave=valor` de `rag.settings`.
--
-- A forma reconhecida é a de `normalizeEmail` do shared — algo, `@`, algo com
-- ponto —, sem espaço nem `:` dentro, e com a mesma fronteira das duas pontas
-- usada acima.
UPDATE audit_log
   SET target_label = regexp_replace(
           target_label, '(^|[ ])[^ :]+@[^ :]+\.[^ :]+(?=$|[ :])', '\1conta removida', 'g')
 WHERE target_label ~ '(^|[ ])[^ :]+@[^ :]+\.[^ :]+($|[ :])'
   AND (action LIKE 'user.%' OR action LIKE '%.share' OR action LIKE '%.unshare');

UPDATE audit_log
   SET actor_label = regexp_replace(
           actor_label, '(^|[ ])[^ :]+@[^ :]+\.[^ :]+(?=$|[ :])', '\1conta removida', 'g')
 WHERE actor_label ~ '(^|[ ])[^ :]+@[^ :]+\.[^ :]+($|[ :])';

-- ====================================== 5. a ação nova de auditoria ========
-- `user.username`: o username de uma conta trocado por um admin (decisão 5 —
-- **só** admin troca). `actor_label` é quem trocou; `target_label` é
-- `<antigo> -> <novo>`, a mesma gramática que a clonagem usa (`031`) e que
-- `quarantine.promote` usa (`030`). É esta linha que mantém legível a trilha
-- anterior à troca: o rótulo congelado lá continua dizendo `<antigo>`, e é
-- aqui que se descobre quem ele virou — e, como o nome antigo não volta a
-- circular (decisão 6), a trilha nunca passa a apontar para outra pessoa.
--
-- DROP + ADD porque não há `ADD CONSTRAINT IF NOT EXISTS`; a lista repete a de
-- `031-clonagem.sql` inteira, e não só acrescenta, porque o CHECK é um objeto
-- só. **Quem mexer neste CHECK depois parte desta lista.**
--
-- Sobre dados existentes: nenhum efeito. A lista só cresce, então nenhuma
-- linha gravada passa a violá-la; o `ADD CONSTRAINT` valida a tabela inteira
-- sob ACCESS EXCLUSIVE, como nas dez vezes anteriores desde o `004`.
--
-- O espelho em TypeScript é `AUDIT_ACTIONS` (`src/queries.ts`, o filtro de
-- `listAuditPage`), o union de `recordAccountAudit` e `AuditAction` de
-- `@purple-skills/shared`: os quatro andam juntos.
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
