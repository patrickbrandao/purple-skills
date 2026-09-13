-- Purple Skills — ícone da skill.
--
-- Problema: o painel está sendo refeito como um canvas (`docs/10-admin-canvas-
-- e-sessoes.md`), com cada skill desenhada como um nó ligado ao vMCP. Um nó
-- só com texto não se distingue dos vizinhos à primeira vista, e os cards da
-- listagem têm o mesmo problema. A skill precisa de uma marca visual própria.
--
-- `skills.icon` guarda **um emoji ou a URL http(s) de uma imagem**. A regra de
-- validação mora no app (`normalizeSkillIcon` de `@purple-skills/shared`, que
-- as queries aplicam antes de gravar): distinguir "um único emoji" de "dois
-- emojis" ou de uma letra pede propriedades Unicode que não vale a pena
-- reproduzir em SQL. O que o banco garante é o teto de tamanho, o mesmo
-- `SKILL_ICON_MAX_LENGTH` do app, para uma URL sem fim não entrar por outro
-- caminho. O CHECK é nomeado e inline no `ADD COLUMN IF NOT EXISTS`, que numa
-- segunda execução pula o comando inteiro, constraint junto — como em `004`.
--
-- Nulo é o estado normal: sem ícone o painel desenha o monograma pelas
-- iniciais do nome, e por isso vazio vira nulo, nunca erro.
--
-- Efeito sobre dados existentes: nenhum. A coluna nasce nula em toda skill e
-- o `search_vector` (`001`, `002`) não a lê — um ícone não é termo de busca.

-- ----------------------------------------------------------------- skills ---
ALTER TABLE skills
    ADD COLUMN IF NOT EXISTS icon TEXT
        CONSTRAINT skills_icon_length_chk CHECK (icon IS NULL OR char_length(icon) <= 512);
