-- Purple Skills — índices da busca por pedaço de palavra (`ILIKE '%termo%'`).
--
-- Problema: quatro telas procuram um termo **no meio** do texto, com
-- `ILIKE '%termo%'`, e um `LIKE` que começa por curinga não usa índice
-- B-tree — só um índice de trigramas (`pg_trgm`, já criado no `001`). O `001`
-- indexou **uma** das colunas procuradas, `skills.name`; e num `OR` o
-- planejador só troca a varredura por um `BitmapOr` quando **todos** os ramos
-- têm índice. Faltando `description` e `slug`, a busca de skills lia a tabela
-- inteira; `audit_log` e `skill_accesses` não tinham índice nenhum para o
-- `q` das telas de Auditoria e de Acessos — e são justamente as duas tabelas
-- que **nunca são podadas** (`015`, `018`), então o custo só cresce.
--
-- Medido num banco descartável (`pgvector/pgvector:pg18-trixie`, `jit=off`
-- para isolar a varredura; com o `jit` padrão a compilação domina e esconde
-- tudo — ver o comentário no fim):
--
--   * 52 mil skills, termo que casa 10 400: a consulta de `listSkills` cai de
--     105 ms para 20 ms (`Seq Scan` → `BitmapOr` dos quatro ramos);
--   * 200 mil linhas de `audit_log`, termo seletivo: 99 ms → 6 ms;
--   * 200 mil linhas de `skill_accesses`, termo seletivo: 149 ms → 3 ms.
--
-- **Um índice por coluna, e não um sobre a concatenação.** A alternativa —
-- um GIN só, sobre `col1 || col2 || …`, com o `OR` original ao lado como
-- filtro exato — foi medida: mesmo tempo de consulta (6,9 ms e 2,9 ms),
-- tamanho parecido (18 MB e 50 MB contra 20 MB e 57 MB) e escrita 13 % mais
-- barata. Não compensa: ela exige que a expressão do índice seja idêntica,
-- caractere a caractere, à que `queries.ts` escreve — quem editar um dos dois
-- desliga o índice **em silêncio**. Por coluna, o SQL das consultas não muda.
--
-- **Custo de escrita.** `skill_accesses` recebe uma linha por leitura de
-- skill no MCP público. Medido com 20 mil INSERTs linha a linha: 33 µs por
-- linha sem os índices, 71 µs com os seis (+38 µs). Irrelevante ao lado do
-- resto de uma leitura de skill. `audit_log` só é escrito em operação
-- administrativa.
--
-- **Custo de espaço**, nas duas tabelas sem poda: ~100 bytes por linha em
-- `audit_log` (20 MB por 200 mil) e ~290 em `skill_accesses` (57 MB por
-- 200 mil). Dois terços do segundo são de `session_id`, que é um hash — cada
-- linha traz ~35 trigramas distintos. Se um dia isso pesar, a saída é trocar
-- a busca por substring em `session_id` por igualdade (quem procura uma
-- sessão cola o identificador inteiro) e derrubar esse índice; é mudança de
-- contrato (`ListSkillAccessesOptions.q`), por isso não é feita aqui.
--
-- **Termo de uma ou duas letras.** `pg_trgm` não extrai trigrama de `%ab%`,
-- então o índice não ajuda: o planejador volta ao `Seq Scan`, e é o que
-- acontece em `audit_log` e `skill_accesses` (132 ms, o mesmo de antes). Em
-- `listSkills` ele escolhe **errado** e varre os três índices inteiros
-- (104 ms → 148 ms em 52 mil skills), porque o custo *estimado* da varredura
-- está inflado pelas subconsultas de visibilidade — o mesmo defeito de
-- estimativa que faz o `jit` compilar toda busca (596 ms de 668 ms). Com uma
-- estimativa sã o planejador acerta: na mesma massa, sem as subconsultas, ele
-- escolhe `Seq Scan` para `%co%` e `BitmapOr` para `%commits%`. Ou seja, a
-- regressão é da estimativa, não do índice, e morre junto com ela.
--
-- `users` fica **de fora** de propósito: `lookupUsers` para em `LIMIT 10`
-- sobre uma tabela de contas (milhares, não milhões), tem mínimo de dois
-- caracteres — justo a faixa em que o trigrama não serve — e mede 4 ms com
-- 5000 contas. Índice ali seria custo de escrita em todo login sem ganho.
--
-- `IF NOT EXISTS` torna a re-execução um no-op. `CREATE INDEX` sem
-- `CONCURRENTLY` porque o runner roda o arquivo em transação: cada tabela
-- fica sem escrita enquanto o seu índice é construído (de 0,1 s a 0,9 s por
-- índice com 200 mil linhas). Numa instalação grande vale rodar a migration
-- fora do horário de uso.
--
-- Efeito sobre dados existentes: nenhum — só índice. O que muda de
-- comportamento é o **escape** de `%`, `_` e `\` no termo, e isso é de
-- `queries.ts` (`likePattern`), não daqui.

-- ---------------------------------------------------------------- skills ---
-- Os quatro ramos do `OR` de `listSkills`/`hybridSkills`: o `tsvector`
-- (`skills_search_vector_idx`, `001`), `name` (`skills_name_trgm_idx`, `001`)
-- e estes dois. Sem os quatro não há `BitmapOr` — falta um, e a varredura
-- volta inteira.
CREATE INDEX IF NOT EXISTS skills_description_trgm_idx
    ON skills USING GIN (description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS skills_slug_trgm_idx
    ON skills USING GIN (slug gin_trgm_ops);

-- ------------------------------------------------------------- audit_log ---
-- As quatro colunas do `q` de `listAuditPage`.
CREATE INDEX IF NOT EXISTS audit_log_skill_slug_trgm_idx
    ON audit_log USING GIN (skill_slug gin_trgm_ops);

CREATE INDEX IF NOT EXISTS audit_log_target_label_trgm_idx
    ON audit_log USING GIN (target_label gin_trgm_ops);

CREATE INDEX IF NOT EXISTS audit_log_file_path_trgm_idx
    ON audit_log USING GIN (file_path gin_trgm_ops);

CREATE INDEX IF NOT EXISTS audit_log_actor_label_trgm_idx
    ON audit_log USING GIN (actor_label gin_trgm_ops);

-- -------------------------------------------------------- skill_accesses ---
-- As seis colunas do `q` de `listSkillAccesses`.
CREATE INDEX IF NOT EXISTS skill_accesses_user_email_trgm_idx
    ON skill_accesses USING GIN (user_email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS skill_accesses_api_key_name_trgm_idx
    ON skill_accesses USING GIN (api_key_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS skill_accesses_key_name_trgm_idx
    ON skill_accesses USING GIN (key_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS skill_accesses_ip_trgm_idx
    ON skill_accesses USING GIN (ip gin_trgm_ops);

CREATE INDEX IF NOT EXISTS skill_accesses_client_name_trgm_idx
    ON skill_accesses USING GIN (client_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS skill_accesses_session_id_trgm_idx
    ON skill_accesses USING GIN (session_id gin_trgm_ops);
