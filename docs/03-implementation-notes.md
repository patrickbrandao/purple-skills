# Notas de implementação

Complementa `02-architecture-decisions.md` registrando **as decisões tomadas
durante a implementação** — pontos em que a especificação era omissa e uma
escolha teve de ser feita, mais os desvios conscientes.

> **Parcialmente revogado pelo [`15`](15-quarentena.md)** — o `.zip` dentro da
> edição de uma skill não existe mais, e o envio avulso daquela tela passou a
> aceitar só texto. Os trechos estão riscados onde estavam; o resto continua em
> vigor.

## Versões fixadas

| Item | Versão | Motivo |
|------|--------|--------|
| Node.js (imagens) | `node:24-alpine` | LTS ativa no momento da implementação |
| Postgres | `pgvector/pgvector:pg18-trixie` | definido na ideia original; `uuidv7()` nativo |
| Express | 5.x | rotas com wildcard nomeado (`/files/*path`) |
| React / Vite / Tailwind | 19 / 7 / 4 | Tailwind 4 via `@tailwindcss/vite`, sem `tailwind.config.js`. A raiz declara `vite ^7.1.5` junto do Vitest **de propósito**: sem isso o lock instalava o `vite` **8** do Vitest na raiz e o 7 aninhado por app, e os plugins hasteados na raiz (`@vitejs/plugin-react`, `@tailwindcss/vite`) resolviam `import "vite"` para o 8 — o que ligava o ramo rolldown/oxc do `plugin-react` dentro de um pipeline rollup e derrubava o `vite dev` com *Missing field `moduleType`*. Com a declaração, o lock hasteia um **único** `vite` 7.3.6, sem `rolldown` na árvore, e o Vitest roda sobre ele (relatório 052 da auditoria de 2026-09-19) |
| MCP SDK | `@modelcontextprotocol/sdk` 1.x | `McpServer` + os três transportes |

## Workspaces e o `build` da raiz

São **nove** workspaces (`database`, `packages/*`, `apps/*`): as três
bibliotecas — `@purple-skills/shared`, `@purple-skills/rag` e
`@purple-skills/db` (que mora em `database/`, não em `packages/`) — e os **seis**
apps (`homepage`, `site`, `admin`, `mcp-public`, `mcp-admin`, `indexer`). Cada
app tem seu `Dockerfile`; `database/Dockerfile` é a sétima imagem, a do
`migrate`/`seed`.

A ordem de compilação das bibliotecas vive **num lugar só**, o script
`build:packages` (`shared` → `rag` → `db`), e `build` e `typecheck` o reusam em
vez de repetir a lista — foi a repetição que fez a receita esquecer o `rag`
(`020`). `@purple-skills/shared` é consumido pelos seis apps, pelo `rag` e pelo
`database`; nenhuma biblioteca depende de app.

As três bibliotecas resolvem por `exports` apontando para o **`dist/`**, que é
gitignorado: num clone novo nada roda antes de `npm run build:packages`, e essa
lista é a única fonte da ordem — documentação e scripts apontam para ela em vez
de repeti-la. Um `prepare` nos pacotes **não** é opção: os sete Dockerfiles
rodam `npm ci` antes de `COPY packages`, e o npm roda os `prepare` de workspace
em paralelo (foi como o `020` derrubou o `npm ci`). A consequência para quem
mexe em pacote está em
[Armadilhas medidas na revisão de 2026-09-18](#armadilhas-medidas-na-revisão-de-2026-09-18).

O `indexer` é o membro fácil de esquecer da lista: é o único app **sem porta**
(`02`, §1 e §12.5) e não aparece em nenhuma tabela de portas. Ainda assim sobe no
`up -d` como os outros (`02` §10) e tem `build` próprio, `Dockerfile` e imagem no
CI, então entra no `build` da raiz como os outros cinco — quem o omite não vê
erro, só um `apps/indexer/dist` que nunca existiu. **Era**, até a `beta.21`:
~~"sobe atrás do perfil `rag` do compose"~~ — a linha do perfil está comentada
no compose desde a `beta.22`.

## Migrations

A spec pede "migrations em SQL" com um passo dedicado. Em vez de `drizzle-kit`,
o projeto usa um **runner próprio** (`database/src/migrate.ts`): lê
`database/schema/*.sql` em ordem, aplica cada uma em transação e registra em
`schema_migrations`. Motivo: zero dependência extra em runtime, arquivos SQL
legíveis e revisáveis, e o mesmo binário serve para o passo `migrate` do
compose. O Drizzle continua sendo usado como schema + query builder.

## `database/` como fronteira

A camada de dados saiu de `packages/db` para `database/`, na raiz, e passou a
concentrar também os containers (`postgres`, `migrate`, `seed`) e um Dockerfile
próprio. Três consequências práticas:

- **Compose por `include`.** `database/docker-compose.yml` é a única definição
  dos serviços de banco; a raiz o consome com
  `include: [{ path: database/docker-compose.yml, project_directory: . }]`. O
  `project_directory` explícito faz os caminhos relativos e o `.env` resolverem
  a partir da raiz, e não de `database/` — sem ele o `${POSTGRES_PASSWORD}`
  chegaria vazio.
- **Imagem separada para o schema.** `migrate` e `seed` deixaram de reaproveitar
  a imagem do site e passaram a usar `database/Dockerfile`, a única que carrega
  os `.sql`. As imagens dos apps recebem só o `dist/` do cliente — nenhum app
  chama `runMigrations`.
- **Arquivos renomeados.** `nnnn_nome.sql` virou `nnn-nome.sql`. Como o runner
  identifica cada migration pelo nome do arquivo, um banco já migrado veria os
  arquivos renomeados como novos; a tabela `RENAMED` em `migrate.ts` atualiza o
  histórico uma vez, antes de decidir o que aplicar.

## Banco de dados

O que os apps precisam saber das escritas e das consultas de
`@purple-skills/db`. A especificação do banco é
[`database/README.md`](../database/README.md), do dba.

- **As escritas de skill são parciais** (`005`). `updateSkill` e
  `updateSkillWithContent` levam no `UPDATE` só as colunas informadas, mais
  `updated_at = now()`, como as de conta, vMCP e catálogo já faziam. É o que
  impede a perda silenciosa de `is_public`/`is_active` quando dois salvamentos da
  mesma skill se cruzam — **sem** travar a linha, porque um `FOR UPDATE` em
  `skills` entra em deadlock com o trigger `files_rag_stale_trg` da migration
  `020` (ver as armadilhas, no fim deste documento). Nenhum app precisa tratar
  conflito de versão: foi o critério para escolher a lista de `SET` parcial em
  vez da trava.
- **O termo das buscas por substring é literal** (`036`). `likePattern` escapa
  `%`, `_` e `\` nas quatro consultas que procuram por pedaço de texto
  (`listSkills`, `listAuditPage`, `listSkillAccesses`, `lookupUsers`); só os dois
  `%` das pontas seguem curinga — quem digitava `%` de propósito passa a
  procurar o caractere. O teto de 200 caracteres virou `SEARCH_QUERY_MAX_LENGTH`,
  exportado de `@purple-skills/db`, e o site e o mcp-public o **consomem** em vez
  de repetir o número: no corte (`consultaDaBusca`) e na frase "Acima de N
  caracteres…" da descrição de `search_skills`. Até o relatório 037 da auditoria
  de 2026-09-19 a exportação existia e ninguém a importava — o número vivia em
  quatro lugares, e mudá-lo só no banco não teria efeito nenhum. Os testes dos
  apps mockam o pacote com um teto **diferente** de 200, que é o que prova a
  derivação. Escapar **sem** indexar é regressão — as duas metades são
  uma só mudança (ver as armadilhas).
- **Termo de uma ou duas letras não tem índice possível**: o `pg_trgm` não extrai
  trigrama de `%ab%`. Em `audit_log` e `skill_accesses` o planejador acerta e
  varre; em `listSkills` ele erra e lê os três índices inteiros (104 → 147 ms em
  52 mil skills), porque o custo *estimado* da varredura está inflado pelas
  subconsultas de visibilidade. Com estimativa sã ele escolhe `Seq Scan` para
  `%co%` e `BitmapOr` para `%commits%`.
- **Problema conhecido, não corrigido: ~87% do tempo de uma busca com termo é
  compilação JIT.** Medido pelo agente do `035` e confirmado pelo do `036` —
  596 ms de 668 ms; com `jit=off`, 74 ms. A causa é a mesma estimativa inflada do
  item anterior: o custo *estimado* das subconsultas de visibilidade estoura
  `jit_optimize_above_cost`, então o Postgres compila toda busca com termo, e é
  essa mesma estimativa que faz o planejador escolher errado para termo de 1 a 2
  letras — os dois defeitos morrem juntos. Não há relatório em `tasks/` para
  este; a correção é do dba.
- **`src/schema.ts` é tipagem, mas não é um resumo** (`037`). Tudo o que o DSL do
  Drizzle expressa fielmente — coluna, tipo, `NOT NULL`, `DEFAULT`, PK, UNIQUE,
  FK com a ação de remoção e índice por coluna, com classe de operadores e
  `DESC` — tem de estar declarado lá, com o **mesmo nome** da constraint no
  Postgres onde o DSL aceita nome (PK composta, UNIQUE e índice); a FK declarada
  na coluna é a exceção, porque `.references()` não tem nome. Índice parcial e
  por expressão, `CHECK`, função e trigger ficam só no SQL e entram na lista
  `SOMENTE_SQL` de `database/src/schema.integration.test.ts`, que é quem compara
  os dois lados contra um banco migrado do zero.

## Busca full-text

- Configuração **`simple`** (sem stemming) em vez de `portuguese`/`english`: o
  conteúdo do catálogo é misto (pt + en + trechos de código) e um stemmer
  específico degradaria metade dos casos.
- Pesos: `name` = A, `description` = B, `SKILL.md` = C.
- Consulta com `websearch_to_tsquery` (aceita `"frase exata"`, `-excluir`,
  `or`), com **fallback `ILIKE`** em nome/descrição/slug para termos parciais —
  a extensão `pg_trgm` e um índice GIN trigram tornam isso barato de três letras
  para cima; o termo é literal e o caso de uma ou duas letras está em
  [Banco de dados](#banco-de-dados). O `-excluir` vale só nesta perna: na busca
  híbrida a vetorial não aplica predicado de texto, e a skill excluída pode
  voltar como vizinha ([`14-rag.md`](14-rag.md) §12, relatório 062 da auditoria
  de 2026-09-19).
- O trigger de reindexação **pula** updates que não alteram `name`,
  `description` nem `search_vector` — o caso dos contadores —, evitando
  **recalcular** o `tsvector` a cada acesso. O que ele **não** evita é a
  **reinserção no índice GIN**: `skills_score_idx` é por expressão sobre
  `(view_count + download_count)`, então o incremento nunca é HOT, e toda
  versão nova da linha entra de novo em todos os índices da tabela — inclusive
  o GIN do `search_vector`, com o mesmo vetor de antes. Medido nesta rodada
  (relatório 055 da auditoria de 2026-09-19): ~49 KB de WAL por incremento, 0 %
  de HOT e um GIN que incha sozinho; os números e o desenho alternativo estão
  em [`database/README.md`](../database/README.md), "Custo de escrita do
  contador da skill". O índice ficou de propósito — sem ele a listagem padrão
  do site e do painel fica de 2 a 3,5 vezes mais lenta. Mudanças no `SKILL.md` reindexam
  explicitamente pelo trigger de `files` (migration `0002`). O atalho original
  se baseava em `updated_at`, mas `now()` é constante dentro da transação, o
  que fazia a criação da skill indexar sem o corpo do SKILL.md.

## Busca semântica

A decisão do `02` era "sem busca vetorial no v1"; a migration `020` a revogou. O
desenho inteiro está em [`14-rag.md`](14-rag.md) e o resumo de decisão no `02`
§12.5 — aqui ficam só os desvios e o que a entrega deixou em aberto.

- **A extensão `vector` é criada em toda instalação.** A `020` roda sempre e faz
  `CREATE EXTENSION IF NOT EXISTS vector`; quem não configura driver nenhum fica
  com as tabelas `rag_*` vazias (as quatro da `020` mais `rag_text_status`, da
  `025`) e a busca de antes. Não há migration
  opcional no projeto, e uma extensão sem uso é mais barata que um caminho de
  schema que só metade das instalações tem.
- **`packages/rag` não importa `@purple-skills/db`.** Ele recebe texto e devolve
  vetor; as funções do banco chegam por portas injetadas (`SearchPorts` em
  `search.ts`, `IndexerPorts` no indexador). É o que mantém o provedor num lugar
  só, deixa a busca testável sem banco e permite ao dba mexer nas queries sem
  tocar o pacote.
- **O indexador é o único app que não escuta porta** — não entra na tabela de
  Portas, no fim deste documento. Ele varre, dorme e publica o que sabe em
  `rag.indexer.status`, que é como o painel enxerga o estado da chave sem nunca
  recebê-la.
- **A perna vetorial é varredura exata, sem índice**: o HNSW do pgvector para em
  2000 dimensões e o `gemini-embedding-2` tem 3072. Com `voyage` (1024) o índice
  passaria a ser possível; continua fora do escopo enquanto o acervo couber numa
  varredura.
- **A página e o `total` saem de uma consulta só** (`034`). A CTE `fusao` é
  `AS MATERIALIZED` e citada duas vezes (a CTE `contagem` e o `FROM`), então as
  duas pernas rodam uma vez. Contar à parte fazia a perna vetorial rodar duas
  vezes por requisição: medido com 12 mil vetores de 3072 dimensões, 1093 ms →
  128 ms. A contagem separada continua existindo **só** para a página sem linha
  nenhuma, onde o total não pode vir embarcado. O `MATERIALIZED` é explícito de
  propósito: não se depende da regra de inline do planner, e ele ainda mantém o
  custo estimado do plano (1,27 M → 121 k) abaixo do nível caro de otimização do
  `jit`.
- **O conjunto fundido é a perna textual inteira** mais os vizinhos que não casam
  no texto (`035`) — é o que faz o `total` ser exato e a paginação ir até o fim.
  Sem custo no caso normal (400 de 2000 skills casando: 74 ms contra 78 ms) e com
  +40 % no pior caso forçado (50 mil de 52 mil casando: 145 ms contra 104 ms).
  Quem ordena a cauda é o próprio RRF: `1/(60 + pos)` decresce com a posição,
  então não há `CASE` nem teto, e como `pos` é único não há empate novo entre
  páginas. Para o mesmo termo o número exibido **cresce** (era no máximo 120):
  é a correção, não regressão.
- **Pendências registradas como pendência, não como decisão:** não existe apagar
  os vetores de um espaço; e não há recorte de escopo da indexação (ligar vale
  para o acervo inteiro, inclusive skill privada — `14` §4.1 e `02` §13).
  **Era**, até a `025`: ~~"a marca de texto que o provedor recusa vive em memória
  do processo — a porta `markRagTextRefused` do indexador espera uma função que
  `@purple-skills/db` ainda não tem, então reiniciar o container tenta o texto
  recusado uma vez mais"~~ e ~~"nem limpar texto ou vetor órfão"~~. As duas
  funções entraram com a `025` e o indexador já as usa: `markRagTextRefused`
  grava a recusa em `rag_text_status`, e a fila deixa de devolver o texto mesmo
  depois de um reinício; `collectOrphanRagTexts` apaga, no fim de cada ciclo, o
  texto sem ocorrência, e a cascata leva os vetores dele.
- **A fila de textos reserva o que entrega** (`025`): `listPendingRagTexts` com
  `reserveMs` grava a reserva na mesma statement da leitura, o indexador pede
  exatamente `TEXT_BATCH` (64) textos com `RESERVA_MS` de dez minutos, e a
  reserva vence sozinha — indexador morto não estaciona a fila. São **três** as
  portas que mexem nessa tabela, e todas seguem **opcionais** em `IndexerPorts`:
  `markRagTextRefused`, `collectOrphanRagTexts` e `releaseRagTextReservations`.
  É assim que o teste monta o ciclo, e sem elas a recusa morre com o processo,
  os órfãos ficam e o lote que falhou só volta à fila no vencimento. A terceira
  entrou depois, **sem migration** (relatório 024 da auditoria de 2026-09-19):
  o ciclo que desiste — falha do provedor, recusa sem prova, parada pedida —
  devolve à fila o que reservou e não resolveu, em vez de segurá-lo pelos dez
  minutos; a etapa que passou de `RESERVA_MS` **não** devolve, porque a reserva
  não tem dono e já pode ser da réplica vizinha. A memória do processo
  (`RecusasRag`) deixou
  de ser o mecanismo e virou rede de segurança, para quando a gravação da marca
  falha.

## A consulta da busca é normalizada uma vez, no chamador

A consulta chega a `criarBuscaSemantica.resolver` e a `listSkills` já normalizada
pelo mesmo `consultaDaBusca` — 200 caracteres, corte na última palavra inteira,
contagem por caractere (`022`). O corte é do **chamador** porque só ele vê as duas
pernas: dentro de `packages/rag/` seria política de busca num pacote que só
transforma texto em vetor (o indexador manda 6.000 caracteres pelo mesmo driver), e
o app continuaria entregando o texto cru a `listSkills`. O teto **não** é variável
de ambiente, e nada novo entrou em `RAG_SETTINGS`: ele tem de ser o mesmo número do
`normalizeQuery` do banco, e uma variável por instalação voltaria a separar as duas
pernas.

## Contadores

Implementados exatamente como a seção 6 pede — incremento atômico, sem dedup.
A regra "só o SKILL.md conta" foi aplicada de forma literal:

| Superfície | Conta? |
|------------|--------|
| `GET /api/skills/:slug` (página/detalhe) | `view_count` +1 |
| `GET /skills/:slug/files/SKILL.md` | `view_count` +1 |
| `GET /skills/:slug/files/<outro>` | não conta |
| `GET /skills/:slug/download` e `…/download.skill` | `download_count` +1 |
| admin `GET /api/skills/:slug/download` e `…/download.skill` | não conta (operador baixando a própria skill) |
| MCP `get_skill` | `view_count` +1 |
| MCP `resources/read` de `skill://<slug>/SKILL.md` | `view_count` +1 |
| MCP `resources/read` de um arquivo de apoio (`skill://<slug>/<caminho>`) | não conta |
| MCP `skills/list` e `skills/get` | não contam (catálogo, não leitura) |
| MCP `prompts/get` | `view_count` +1 |
| MCP `get_skill_file` | não conta |
| MCP `download_skill` | não conta (só devolve a URL; quem seguir o link conta) |

O método importa: **`HEAD` não conta em nenhuma superfície** (relatório 066 da
auditoria de 2026-09-19). Nenhuma rota registra `head`, e o Express 5 despacha o
`HEAD` para o handler de `GET` — então as rotas anônimas do site e as de download
do mcp-public trazem a guarda explícita: `HEAD` devolve os cabeçalhos do `GET` e
mais nada. Não grava linha em `skill_accesses`, não soma contador e, no pacote,
nem chega a listar os arquivos. Contar `HEAD` transformava `wget --spider`,
monitor de disponibilidade e o gerenciador de download que pergunta antes de
baixar em visita ou download de verdade, e inflava o score que ordena a lista de
skills por padrão; no pacote, o servidor ainda lia e comprimia a skill inteira
para jogar fora, sem a contrapressão que só existe quando o cliente recebe corpo.

E a leitura que **não entrega o texto** também não conta: quando o SKILL.md
passa de `MCP_MAX_FILE_TEXT_BYTES`, `get_skill` responde com os metadados e o
link, e `prompts/get` e `resources/read`, com erro (relatório 032 da auditoria
de 2026-09-19). Quem seguir
o link conta na rota do arquivo — contar nas duas pontas daria duas
visualizações por leitura.

## Ferramentas MCP além do contrato da spec

A seção 8 lista o contrato mínimo. Foram adicionadas, por serem lacunas
práticas evidentes:

- **público**: `get_skill_file(slug, path)` — sem ela, `get_skill` anuncia os
  arquivos anexados mas o agente não tem como lê-los; e `list_tags()`, que
  torna o filtro por tag descobrível.
- **admin**: `get_skill`, `get_file`, `list_tags` e `get_stats` — leitura,
  necessária para o agente editar com contexto.

`delete_skill` ganhou um parâmetro **`confirm: true` obrigatório**: é a única
operação irreversível do conjunto e um agente não deveria conseguir disparar
por engano.

**`get_stats` recorta pelo `viewer`**, como as demais leituras (`023`): admin
recebe os totais da instalação (arquivos, visitas, downloads, flutuantes e
contas), e as outras credenciais só `totalSkills`, `totalTags` e `openSkills` —
este último é o número que o site mostra a um anônimo. Enquanto `stats()` não
aceitar `viewer`, o que não dá para recortar fora do banco é **omitido**, nunca
devolvido global.

## Onde publicar, no import de `.zip`

Nada de publicação vem do frontmatter: `skillMetaFromMarkdown` lê nome,
descrição, slug e tags, e ignora qualquer `is_public` ou `use_as_*` que um
`.zip` de terceiro traga — e continua ignorando depois do `017`, que devolveu
a coluna `skills.is_public`: onde a skill aparece é o vínculo com um MCP
virtual e, para leitura, o "público" que quem importa marca no painel, nunca o
que o pacote declara. (As `use_as_*` seguem inexistentes desde o `012`.) O
formulário manda a lista `mcps` como JSON num campo do multipart, e a rota a
resolve por `resolveLinks` antes de criar qualquer coisa: um vMCP em que a
sessão não tem `edit` é 403, e a skill não é criada. (Era `loadManaged`, que o
`12` substituiu por `load(user, slug, 'edit')`.) É o que impede um `.zip` de se
publicar sozinho, e o que faz o import e o formulário terem exatamente a mesma
regra.

## Semântica de `set_files_bulk`

Segue a seção 4 à risca: **por padrão o zip é o estado desejado completo** e
caminhos omitidos são removidos. O `SKILL.md` é sempre preservado (a seção 3.2
exige que ele exista). `replace: false` desliga a remoção, para o caso de só
querer adicionar arquivos.

**A remoção exige confirmação numérica (`011`).** Com `replace` ligado, a
ferramenta pergunta ao banco, antes de gravar, o que sairia —
`previewSetFilesDeletions`, o **mesmo predicado** do `DELETE` de `setFiles`, com
a `lower()` do Postgres dos dois lados e o `SKILL.md` fora da conta — e, se
houver algo a remover, **recusa a chamada** listando os caminhos. **Era**, até o
relatório 017 da auditoria de 2026-09-19: ~~"a ferramenta calcula antes de
gravar o que sairia — `listFiles` mais a mesma régua do banco (caixa ignorada,
`SKILL.md` nunca sai)"~~ — a régua refeita no JS dobrava a caixa com
`toLowerCase()`, que discorda do banco em `İ` (dois code points no JS, um no
libc): um .zip com `I.md` sobre um `İ.md` gravado anunciava uma remoção que não
acontece, e o `confirm_deletions: 1` que a recusa induzia era 409 para sempre
(medido contra o banco de teste, antes e depois). Para gravar de fato, o agente repete
com `confirm_deletions: <n>`, o **número exato** de arquivos a remover, que só
sai da recusa (ou de `get_skill`). Não é um `confirm: true` porque o acidente a
evitar é o do agente que não olhou a árvore, e um booleano é justamente o campo
que ele preenche por reflexo; um número que não bate também recusa, e é isso que
protege quando a árvore muda entre a prévia e a segunda chamada — a prévia não
tranca a skill (`SELECT … FOR UPDATE` em `skills` daria deadlock com
`files_rag_stale_trg`). O padrão de `replace` continua `true`: quem manda a
árvore completa e nada perde não vê diferença.

~~No painel web o upload de `.zip` faz o oposto — **adiciona/sobrescreve por
padrão**, com um checkbox explícito para substituir a árvore inteira. É uma
superfície diferente (um humano clicando, sem descrição de ferramenta para
ler antes), e o comportamento destrutivo fica visível na tela.~~

> **Revogado neste ponto pelo [`15`](15-quarentena.md)** (§6): o painel não
> importa `.zip` dentro da edição de uma skill, e a rota que o fazia
> (`POST /api/skills/:slug/upload`) saiu. O parágrafo acima descrevia uma tela
> que não existe mais. O `set_files_bulk` do MCP administrativo — o assunto do
> resto desta seção — **não mudou**, e hoje é o único caminho que troca a
> árvore de uma skill que já existe.

## Caminho de arquivo é único sem diferenciar caixa

A escrita comparava `relative_path` byte a byte e a leitura comparava por
`lower(...)`. `skill.md` gravado numa skill que já tinha `SKILL.md` inseria uma
segunda linha "principal", e a partir dali o conteúdo exibido, indexado e
empacotado saía de um `LIMIT 1` sem ordem. Duas travas, nas duas pontas:

- `normalizeRelativePath` canoniza qualquer variante de caixa do arquivo
  principal para `SKILL.md`, então as escritas caem sempre na mesma linha.
- A migration `0003` troca a constraint `UNIQUE (skill_uuid, relative_path)` por
  um índice funcional `UNIQUE (skill_uuid, lower(relative_path))`, e
  `upsertFileTx` infere o conflito por ele. Vale para qualquer arquivo, não só o
  `SKILL.md`: `Notas.md` sobrescreve `notas.md` em vez de duplicar.

A migration consolida o que já tinha duplicado mantendo a linha mais recente —
o mesmo resultado que o `ON CONFLICT` novo produziria. `deleteFile` passou a
apagar pelo caminho exato da linha lida; com o filtro `lower(...)` anterior,
remover `a.md` levava junto um eventual `A.md`.

## Sessão do painel

- Cookie assinado com HMAC-SHA256, `httpOnly`, `SameSite=Lax`, TTL de 12h
  (configurável por `ADMIN_SESSION_TTL`). Sem session store, como pedido.
- **A checagem de `Origin` das escritas compara nome e porta** (`csrfGuard`,
  relatório 006 da auditoria de 2026-09-19). O `Lax` não separa portas do mesmo
  host — "site" não inclui
  porta, e cookie não é isolado por porta —, e `multipart/form-data` e POST sem
  corpo não disparam preflight: nessas rotas a checagem é a barreira, não a
  reserva. A origem própria é o `Host` (ou o `X-Forwarded-Host` de proxy
  confiável) **com a porta**, ou a de `ADMIN_PUBLIC_URL`; `ADMIN_ALLOWED_ORIGINS`
  casa pela origem inteira; o esquema fica com o `Sec-Fetch-Site`, que não
  depende do `X-Forwarded-Proto`. Era comparação só de nome: uma página em outra
  porta da mesma máquina escrevia no painel com o cookie da vítima. Proxy que
  publica o painel numa porta que não repassa no `Host` precisa de
  `ADMIN_PUBLIC_URL`.
- O payload passou a ser `{ sub, role, ver, exp }` com a entrega de contas
  (§7.1 das decisões). `role` e `ver` são **opcionais no tipo**: a sessão da
  senha única não os tem, e o middleware trata a ausência como "sessão legada",
  válida só enquanto `users` estiver vazia. `packages/shared` continua sem
  falar com o banco — ele assina e valida o formato; quem decide se a sessão
  ainda vale é `apps/admin/src/auth.ts`.
- `ADMIN_SESSION_SECRET` é **opcional**: se ausente, é derivado da senha com
  **scrypt** (`N=2^15`), uma vez por processo. O serviço sobe sem configuração
  extra e trocar a senha invalida as sessões antigas — que é o comportamento
  desejado. A KDF lenta é o que impede que um cookie capturado vire um teste
  offline barato da senha do painel; mesmo assim, em produção vale definir o
  segredo explicitamente.
- A flag `Secure` **acompanha o protocolo da requisição** (respeitando
  `X-Forwarded-Proto` via `trust proxy`) em vez de `NODE_ENV`. Fixá-la em
  produção quebraria qualquer deploy HTTP interno; `ADMIN_COOKIE_SECURE`
  permite forçar. A variável é lida por `readBoolEnv` (`@purple-skills/shared`):
  aceita `true`/`false` (também `1`/`0`, `yes`/`no`, `on`/`off`, em qualquer
  caixa), vazia é o automático, e qualquer outro valor **derruba o boot**
  (relatório 056 da auditoria de 2026-09-19). O leitor que havia no painel
  devolvia `false` para tudo que não fosse
  `true`/`1`, e como `false ?? req.secure` é `false`, um `TRUE` ou `yes`
  destravava em silêncio justamente o cookie que o operador quis travar — pior
  que não configurar nada. `OIDC_AUTO_PROVISION` passa pelo mesmo leitor.
- **Sair mostra o spinner antes de navegar.** Com o Shell ainda montado,
  `navigate('/')` abria `/mcps`, cuja busca voltava 401 com o cookie já
  apagado. Como os ramos do `App` tinham o mesmo `ToastProvider` na raiz, o
  React reaproveitava o provider, e o toast "Sessão expirada ou ausente"
  aparecia na tela de login. Agora o spinner desmonta o Shell antes da
  navegação, e cada ramo tem o seu provider (`key`).
- **O corpo de `GET /api/session` tem duas metades** (`024`), montadas por
  `sessionPayload(user, totalUsers)`: a pública — `authenticated`, `user`,
  `needsSetup`, `legacyLogin`, `oidc`, `passwordResetByEmail`, `siteName`,
  `brand` — e a que só sai com sessão: `siteBaseUrl`, `mcpPublicUrl`, `links`,
  `onlineWindowMs`, `rag` e `version`. A rota é registrada **antes** do
  `requireAuth`, porque a tela de login depende dela; é esse recorte que dá trava
  de servidor à tela "Ambiente", que não faz chamada própria. No cliente,
  `Session` é `SessionLogin & SessionOperation` e `getSession()` completa a
  resposta anônima com `SESSION_OPERATION_DEFAULTS` — o mesmo objeto do
  `OFFLINE` —, o que mantém o tipo total para as telas de dentro.
  `routes.test.ts` cobra a lista **fechada** de chaves do corpo anônimo: campo
  novo ali é decisão, não descuido.
- **Sair encerra a conta inteira, e por isso pergunta** (`024`, `029`).
  `endSession` (`apps/admin/src/auth.ts`) concentra o logout: resolve a sessão,
  apaga o cookie e incrementa `token_version`. Com cookie stateless não existe
  revogação por dispositivo, então a confirmação é "Sair de todos os aparelhos?"
  e a tela de login mostra o recado quando `POST /api/logout` volta
  `revoked: true`. Toast não serve: cada ramo do `App` tem o seu
  `ToastProvider` (`key`), e o do ramo anterior é descartado de propósito. A
  revogação é **melhor esforço** — falha vai ao log e não impede a saída, como a
  adoção de órfãos no login. A sessão de bootstrap não tem conta, volta
  `revoked: false` e sai sem confirmação.

## Contas, papéis e credenciais

Decisões que a spec (`05-accounts-and-roles.md`) deixou em aberto:

- **`audit_log.target_label`.** A §3 previa só `actor_user_uuid` e
  `actor_label`. Sem um terceiro campo, um evento de conta não diz *sobre quem*
  foi — `skill_slug` e `file_path` são nulos nessas linhas. A coluna guarda o
  e-mail do alvo, o `email → papel` de uma troca ou o nome da chave.
- **Dois custos de scrypt.** A spec diz "hash de senha e de chave por scrypt".
  Senha de pessoa usa `N=2^15` (~32 MB, ~100 ms); segredo de chave de API usa
  `N=2^12`. O segredo tem 32 bytes aleatórios: não há busca offline a
  encarecer, e o custo alto só somaria latência a cada requisição do MCP. Os
  parâmetros ficam gravados no próprio hash (`scrypt$N$r$p$salt$hash`), então
  aumentá-los depois não invalida o que já está no banco.
- **Prefixo da chave lido por posição, não por `split('_')`.** O alfabeto
  base64url inclui `_`, então o segredo quase sempre tem underscores e a
  divisão ingênua recusaria uma chave legítima. Como o prefixo tem comprimento
  fixo, a posição do separador é determinística.
- **Sessão MCP presa à credencial.** O servidor MCP é criado uma vez por
  sessão; ~~com o papel e o ator daquele momento~~ — desde o `006` os handlers
  nascem **por chamada**, a partir da credencial revalidada na requisição em
  curso (ver [MCP administrativo](#mcp-administrativo)). Sem amarrar, quem
  descobrisse um `mcp-session-id` alheio herdaria o papel dele — daí o 403 quando a
  identidade da requisição não bate com a que abriu a sessão. Vale para os dois
  transportes com sessão: o Streamable HTTP (`mcp-session-id` no header) e o
  SSE legado (`?sessionId=` na query do `POST /messages`), que por ficar fora do
  header é ainda mais fácil de vazar em log e histórico de proxy.
- **Trilha de auditoria só para admin.** `GET /api/audit` devolve `actor_label`
  e `target_label`, que são e-mails — a mesma classe de dado de `/api/users*`.
  O painel esconde o cartão de auditoria para quem não é admin em vez de
  mostrá-lo vazio.
- **Teto de upload é por requisição, não por arquivo.** `limits.fileSize` do
  multer vale por arquivo; com `upload.array('files', 50)` uma requisição
  bufferizava até 50 × o teto em memória. A recusa vem do `Content-Length`,
  antes do multer, com folga para o envelope multipart; ~~quem envia sem
  `Content-Length` ainda esbarra na soma conferida depois do upload~~.
  **Era** assim até o relatório 012 da auditoria de 2026-09-19: a soma
  conferida depois chega tarde para a
  memória, porque num envio `chunked` os 50 arquivos já tinham sido
  bufferizados inteiros (até ~3,2 GB, contra 1,5 GB de `mem_limit`). Agora o
  storage do upload (`budgetedMemoryStorage`, em `apps/admin/src/uploads.ts`)
  soma os bytes **a cada pedaço** e devolve 413 no que estoura: o multer desliga
  o parser, descarta o resto do corpo sem guardar e só então responde. Não é
  411 de propósito — proxy que reempacota o corpo em `chunked` é envio legítimo.
  O multer também passou a limitar arquivos (50), campos de texto (20) e partes
  por requisição: o padrão do busboy é `Infinity`, e cada campo guarda até 1 MB.
- **Reemissão do cookie na troca de senha.** Trocar a senha incrementa
  `token_version`, o que derrubaria a sessão de quem acabou de trocá-la. A rota
  reemite o cookie com a versão nova.
- **Nada de auto-desativação nem último admin.** Um admin não muda o próprio
  papel nem se desativa, e a última conta de administrador ativa não pode ser
  rebaixada ou desligada: o caminho de volta seria editar o banco à mão.
- **A tela de contas some na sessão de bootstrap.** Criar uma conta por ali
  invalidaria a própria sessão na requisição seguinte (a legada só vale com
  `users` vazia). O caminho oferecido é sair e passar pelo `/setup`: o aviso
  do sino, o menu da conta e a paleta fazem as duas coisas num clique e
  abrem o login em `/?setup=1`, já no cadastro. `/account` também fica
  fechada nessa sessão: sem conta, trocar a senha e emitir chave só dariam 400.
  **O servidor acompanha** (relatório 001 da auditoria de 2026-09-19):
  `POST /api/users` responde 400 na sessão de bootstrap, com qualquer papel. A
  guarda era só de interface, e a consequência ia além de a sessão cair: a conta
  criada ali é a **primeira**, fecha o `/api/setup` e o login pela
  `ADMIN_PASSWORD`, e se não for `admin` deixa a instalação sem administrador —
  observado em 16/09/2026. Nem como `admin` a rota aceita: a conta nasceria sem
  o `onlyIfTableEmpty` do setup (`049`) e sem adotar os órfãos.
- **O login não abre no cadastro por padrão**, mesmo com `users` vazia. A
  sessão de bootstrap é o modo de quem não quer contas (§4.1 da spec), ~~e o
  cadastro esconderia o botão do SSO~~. Ele abre com `?setup=1` e continua a um
  clique pelo link "Criar o primeiro administrador". **Era** também para não
  esconder o botão do SSO, até o relatório 001 da auditoria de 2026-09-19: com
  `users` vazia o SSO não entra mais — `resolveOidcUser` recusa o
  auto-provisionamento enquanto não houver conta, porque um `membro` criado ali
  trancava a instalação (`05` §2.3). O botão continua na tela: quem clica volta
  ao login com a mensagem que aponta o link do cadastro, e é assim que quem
  acabou de configurar o OIDC descobre a ordem certa.
- **Token de redefinição em SHA-256, não scrypt.** São 32 bytes aleatórios e a
  busca é por igualdade exata do hash; não há entropia baixa a compensar.
- **`registerFailedLogin`/`registerSuccessfulLogin` não tocam `updated_at`**
  (decisão do DBA): o campo continua significando "última alteração
  administrativa da conta", não "última tentativa de login". **O "Sair" também
  não** (relatório 034 da auditoria de 2026-09-19): `endSession` revoga as
  sessões por `updateUser(uuid, { bumpTokenVersion: true })`, e `updateUser`
  deixa de carimbar quando o `bumpTokenVersion` é o **único** efeito da chamada
  — movimento de sessão não é edição da ficha, e a data avançava a cada logout
  sem linha de auditoria que a explicasse. Com qualquer campo da conta junto
  (senha, papel, ativação, vínculo OIDC, `clearLoginLock`) o carimbo vale como
  sempre, e `updateUser(uuid, {})` — o `PATCH` que não mudou nada — continua
  carimbando, que é o que mantém o `SET` não vazio. Quem mandar outro movimento
  de sessão por `updateUser` herda a regra; os `updated_at` que os logouts da
  beta.22 já carimbaram ficam como estão.
- **O login gasta scrypt mesmo sem conta** (`028`). A mensagem genérica não
  bastava: medido nesta árvore, e-mail sem conta respondia em 1,2 ms e e-mail com
  conta em 69,6 ms (scrypt de `PASSWORD_COST`, ~67 ms num Mac ARM), faixas
  disjuntas — **uma** tentativa classificava o endereço. `loginWithPassword`
  passou a conferir a senha contra um hash sentinela descartável quando não há
  conta, a conta está desativada ou é só-OIDC; o sentinela nasce na primeira
  necessidade, não no import, para o boot não pagar scrypt. O ramo de entrada
  malformada (sem e-mail, senha vazia) **não** gasta scrypt de propósito: decide
  pelo que o cliente mandou, não vaza nada, e queimar CPU ali seria negação de
  serviço barata. Sobram ~4 ms (5 %) de resíduo no caminho com conta — a consulta
  que devolve linha e o `UPDATE` de `registerFailedLogin` —, exploráveis só com
  muitas amostras do mesmo endereço, dentro do teto por IP; fechá-los pediria
  piso de tempo fixo na resposta de falha.
- **`email_verified` pesa por caminho do SSO** (`013`). Exigir o claim nos três
  caminhos trancaria instalação legítima — Entra ID e Okta costumam não emitir
  `email_verified` — e derrubaria quem já entra por SSO. Então: identidade já
  vinculada não é reavaliada (a ligação veio de um ato anterior); **vincular a
  uma conta local que já existe exige `true`**, porque vincular é assumir papel,
  posse e concessões, e a allowlist de domínio só responde de onde vem o
  endereço, não quem é o dono dele; criar conta nova recusa apenas o `false`
  explícito, já que ela nasce `membro` e, depois do `12`, vê só o público, o seu
  e o concedido. O claim é lido do `id_token` ou, quando o e-mail vem do
  `userinfo`, da mesma resposta, e aceita também a string `"true"`, que alguns
  provedores mandam no lugar do booleano. Falta um caminho de vinculação
  deliberada (vincular o SSO já autenticado por senha, ou o admin vincular pelo
  painel) para o IdP que não emite o claim.
- **As invariantes da população de administradores se fecham com advisory lock**
  (`049`) — "sempre sobra um admin ativo" e "só existe um primeiro admin" —, na
  transação da escrita, e não com `INSERT … WHERE NOT EXISTS` nem
  `UPDATE … WHERE … AND EXISTS (…)`: em READ COMMITTED as duas formas avaliam o
  predicado no snapshot da transação, não há linha em que travar, e duas
  transações simultâneas passam as duas (ver as armadilhas, no fim deste
  documento). É a mesma técnica que `adoptOrphans` já usa
  (`ADOPT_ORPHANS_LOCK`).
- **Campo booleano vindo do cliente é cobrado como booleano** (`046`):
  `optionalBoolean` do banco, e `"isActive" precisa ser true ou false` nas rotas
  de vMCP e de catálogo. Em `updateAccount`, `null` também é 400 — `is_active`
  não tem estado "sem valor".

## Auditoria de conta

- **A troca da senha de uma conta por quem não é ela grava `user.password`**
  (`030`), com `target_label` igual ao e-mail da conta afetada. O caminho está no
  **ator**: o e-mail de quem administra (ou `bootstrap`) na redefinição pelo
  painel, e `link-de-redefinicao` no link de e-mail — ali só se sabe que alguém
  portava o link, e atribuir a linha ao dono afirmaria uma posse que um link
  vazado desmente. A troca feita pelo próprio dono logado (`changeOwnPassword`)
  fica fora, como o login: quem age tem a senha atual na mão. O nome não é
  `user.password_reset` porque nenhuma ação do catálogo usa `_`; `user.password` é
  o paralelo de `user.role` — o que mudou na conta. Diferente das vizinhas, esta
  chamada é **melhor esforço**: a senha temporária existe só na resposta da rota,
  e derrubá-la por causa da linha deixaria a conta com uma senha que ninguém
  conhece.
- **Invalidar um link de redefinição é `superseded_at`, nunca `used_at`** (`027`).
  `used_at` é o par da linha `user.password` com ator `link-de-redefinicao` e
  afirma que aquele link redefiniu a senha; marcá-lo num link que ninguém clicou
  tornaria incontável quantos links foram usados. O `reset_tokens_estado_chk`
  mantém os dois carimbos exclusivos, e o fechamento só toca link **vivo** —
  assim "morto por prazo" (os dois nulos, `expires_at` vencido) continua contável
  em vez de ser reetiquetado. Apagar a linha foi descartado: o `006` guarda a
  tentativa de propósito, e é por ela que se vê alguém pedindo a redefinição da
  senha de outra pessoa em série.
- **O vínculo por SSO e a reativação gravam `user.link` e `user.activate`**
  (relatório 003 da auditoria de 2026-09-19; a lista e o formato de cada linha
  estão no `05` §2.8). O vínculo que descarta a senha temporária (relatório 002
  da mesma auditoria) **não** grava `user.password` junto: aquela ação afirma que o próximo acesso
  exige senha nova, e aqui a senha deixou de existir — a nota vai no
  `target_label` do próprio `user.link`, que é a única pista de por que a conta
  ficou sem senha local. `user.activate` segue o padrão direto de
  `user.deactivate`; `user.link` é melhor esforço, e é isso que mantém o SSO de
  pé se o painel novo subir contra um banco ainda sem a migration
  `auditoria-de-vinculo-e-reativacao` (o `CHECK` recusa a ação, o login conclui
  e a falha vai para o log).

## Armazenamento de arquivos

- Texto vs. binário é decidido pelo **mime detectado por extensão** mais uma
  checagem de bytes nulos **e de UTF-8 válido** — um `.md` com bytes nulos vai
  para `bytea`, não para `text` (Postgres rejeitaria `\0` em `text`), e um
  `.csv` em Windows-1252 também: `toString('utf8')` não falha com byte
  inválido, troca cada um por U+FFFD sem erro, e o original não voltava mais
  (relatório 015 da auditoria de 2026-09-19). A régua é uma só,
  `isTextualContent` do `shared`, usada pelo `extractZip` e pelo `fileColumns`
  do banco; o que não passa é guardado byte a byte, com o mime da extensão e
  `isText: false`. O **`SKILL.md` da raiz não tem essa saída** — binário, a
  skill ficaria de corpo vazio para o MCP, a busca e o RAG —, então ele é
  recusado com 400 nas três entradas: o `extractZip` (`ZipContentError`, que
  cobre a importação, o upload de `.zip` e o `set_files_bulk`), o envio avulso
  do painel (que decodifica o arquivo **antes** do banco, e por isso confere
  antes do `toString`) e o próprio banco. O BOM é UTF-8 válido e fica onde está.
- Caminhos passam por `normalizeRelativePath`, que rejeita `..`, caminhos
  absolutos e prefixos de drive do Windows.
- Zips com uma **única pasta raiz que contém o `SKILL.md`** (o padrão de
  `zip -r skill.zip skill/`, e o formato de todo pacote que o painel, o site e o
  MCP público entregam: `<slug>/SKILL.md`) têm essa pasta removida; `__MACOSX`,
  `.DS_Store` e `Thumbs.db` são descartados. A condição do `SKILL.md` — em
  qualquer caixa, logo dentro da pasta — é o que separa **embrulho** de
  **subpasta**. **Era**, até o relatório 075 da auditoria de 2026-09-19:
  ~~"Zips com uma **única pasta raiz** (o padrão de `zip -r skill.zip skill/`)
  têm essa pasta removida"~~, sem condição — um envio parcial
  (`zip -r scripts.zip scripts/`) numa skill já existente caía achatado na raiz,
  ao lado dos `scripts/…` antigos, e no `set_files_bulk` com `replace` a recusa
  por remoção listava justamente os arquivos recém-enviados. O lixo de SO sai
  **antes** da decisão, então o .zip do Finder continua sendo desembrulhado, e
  um `SKILL.md` mais fundo (`references/exemplo/SKILL.md`) não faz de
  `references/` um embrulho. O caso que continua ambíguo, de propósito: uma
  subpasta enviada **com** um `SKILL.md` direto dentro dela é indistinguível de
  um embrulho e é desembrulhada.

  > **Revisado neste ponto pelo [`15`](15-quarentena.md)** (§10): o parágrafo
  > acima segue valendo para o `extractZip`, e por ele para o `set_files_bulk`
  > do MCP administrativo. A **importação** não passa mais por ali — ela lê o
  > pacote cru (`extractArchive`) e deixa o `splitBundle` achar as skills —, e
  > o que desembrulha passou a ser o diretório do `SKILL.md`, em qualquer
  > profundidade: um `.zip` com `archive/skills/foo/SKILL.md` entrava torto,
  > com `skills/foo/` grudado em todo caminho do envio, porque a raiz única não
  > trazia o `SKILL.md` logo abaixo dela. Isso vale quando a raiz do pacote
  > (já sem o embrulho) **não** tem `SKILL.md`; com um lá, o pacote é uma skill
  > só e os caminhos ficam como vieram — é a decisão 27 do `15`, e o preço da
  > outra metade é que o que está fora de um diretório de skill não entra em
  > envio nenhum. O descarte de `__MACOSX`, `.DS_Store` e `Thumbs.db` vale nos
  > dois caminhos (`isJunkPath`).
- **O teto de descompressão não confia no tamanho declarado no diretório
  central** (`004`). Quando ele é zero — o valor que desliga o `maxOutputLength`
  do zlib dentro do `adm-zip` e deixaria a descompressão sem limite —, a entrada
  só é aberta se os bytes comprimidos não puderem inflar além do que resta do
  limite, pela expansão máxima do DEFLATE (**1032×**, teto do formato: medido,
  256 MB de zeros comprimem a 261 KB). Declarado maior que o real já é recusado
  antes de alocar, e declarado menor é cortado pelo próprio zlib. Arquivo vazio de
  verdade declara zero com zero (ou 2) bytes comprimidos e continua passando — é
  assim que o `zipfile` do Python grava.
- **Uma importação legítima custa ~2× o teto descomprimido em memória**: o import
  guarda ao mesmo tempo o `.zip` recebido, os bytes descomprimidos e a segunda
  cópia deles como `textContent`/`binaryContent` em `toExtractedFile` (medido:
  `.zip` de 200 MB → ~400 MB de RSS). Quem aumenta
  `ZIP_MAX_UNCOMPRESSED_BYTES` aumenta `APP_MEM_LIMIT` na mesma conta — ver
  [Portas](#portas).
- **O orçamento de bytes é um só para o pacote, somado entre as camadas de
  envelope** (`extractArchive`): cada `.gz`/`.zst` aberto desconta o que
  produziu, e o leitor de dentro recebe o que sobrou. Enquanto o teto valia
  cheio de novo a cada camada, a conta de "~2×" do item acima deixava de valer
  para o pacote com envelope: medido com maxRSS no Node 26, 250 MB de conteúdo
  custavam 346 MB em `.zip`, 653 MB em `.tar.gz` e 871 MB em gzip(gzip(tar)) —
  com `mem_limit` de 1536m e sem swap, três envios de 264 KB em paralelo
  bastavam para o OOM killer. A mensagem de recusa cita o limite **configurado**,
  não o resto do orçamento, porque é o número que o operador reconhece.
- **O teto de entradas conta o lixo de SO; o de arquivos por skill, não.**
  `BUNDLE_MAX_ENTRIES` é conferido antes do descarte — no `.zip`, sobre o que o
  fim do diretório central declara (`getEntryCount()`, antes de materializar
  entrada nenhuma); no `.tar`, sobre cada membro aberto. Medido: um `.zip` com
  um `SKILL.md` e nove entradas de lixo é recusado com o teto em 9, e a mensagem
  fala em 10. Os bytes do `._<nome>` solto também entram no teto descomprimido,
  porque a assinatura AppleDouble só se prova no conteúdo — ele é lido, somado e
  só então descartado. Depois disso a lista já está limpa, e é a limpa que o
  `splitBundle`, a guarda do pacote sem `SKILL.md` e o `fileCount` do envio
  veem. Era o contrário do que a §10 do [`15`](15-quarentena.md) dizia
  ("o lixo de SO sai antes de qualquer conta"), corrigido lá.

## Download do pacote

O `.zip` é montado **em fluxo** (`044`). O que isso exige de quem mexer nele:

- a rota passa a **lista** (`listFiles`) e um leitor (`readFile`), nunca
  `readAllFiles`. Não há consulta nova no banco: o índice único
  `(skill_uuid, lower(relative_path))` da migration `003` garante uma linha por
  caminho listado;
- o `archiver` só mantém **uma** entrada em memória se cada `append` esperar o
  evento `entry`; sem essa espera as entradas se acumulam na fila interna e o
  ganho desaparece;
- a resposta **não** leva `Content-Length` (o tamanho só se conhece no fim) e os
  cabeçalhos são escritos na primeira entrada. É isso que permite responder erro de
  verdade **antes** do primeiro byte e obriga a derrubar a conexão depois dele: um
  `res.status().json()` com cabeçalho já enviado estoura `ERR_HTTP_HEADERS_SENT`
  dentro do `.catch()` do `asyncRoute` e mata o processo, que não tem
  `unhandledRejection`;
- o nível de compressão é **6**, medido: 0,34 % de tamanho por 38 % de CPU;
- a mesma lógica vive hoje em `apps/site/src/zip.ts` e
  `apps/mcp-public/src/zip.ts` até o `shared` ganhar um `writeZip` preguiçoso —
  quem criar esse `writeZip` deve apagar os dois e converter também
  `apps/admin/src/zip.ts`.

## Homepage separada do site

A apresentação do projeto vive em `apps/homepage`, um app próprio:

- **Sem banco e sem API.** O servidor é um Express que só serve `dist-web/` e
  responde `/healthz` — não importa `@purple-skills/db`, não abre pool e não
  chama rota nenhuma. Nada do que ela mostra depende de haver skills
  cadastradas, o que a torna publicável sozinha (vitrine, CDN, outro domínio).
- **O site perdeu as seções de apresentação.** Ele é a página de quem já usa a
  instalação: cabeçalho curto, catálogo, o `mcp.json` para copiar e os
  endereços de acesso. Quem quer entender o projeto vai para a homepage.
- **Endereços vêm do ambiente, não do `Host`.** `MCP_PUBLIC_URL`,
  `MCP_ADMIN_URL` e `ADMIN_URL` são devolvidos por `/api/meta`; cada um que
  ficar vazio some da página, em vez de virar um endereço adivinhado que não
  responde. **O formato das três não é o mesmo** (relatório 084 da auditoria de
  2026-09-19): `MCP_PUBLIC_URL` é a
  *base*, sem `/mcp` — o site acrescenta o sufixo ao mostrá-la, porque a mesma
  variável monta `<base>/virtual/<slug>/mcp` no site e no painel e as URLs de
  download do mcp-public. `MCP_ADMIN_URL` e `ADMIN_URL` são o endereço
  *completo* e saem crus: só são exibidos (cartão, rodapé e o `mcp.json`
  copiável de "Administre pelo agente"), então a do MCP administrativo já vem com
  o caminho do transporte, normalmente `/mcp`. O site não acrescenta o sufixo de
  propósito — o mcp-admin tem três transportes (`/mcp`, `/mcp/stateless`,
  `/sse`), e normalizar adivinharia um deles e duplicaria o `/mcp` de quem já
  preenche certo. Só com o host, o `mcp.json` copiado faz `POST /` e recebe o 404
  "Rota não encontrada" do mcp-admin.
- **CSS.** `chrome.css` (nav + rodapé) saiu do antigo `landing.css` e virou
  cópia idêntica nos dois apps, junto de `tokens.css` e `base.css`. O que
  sobrou de `landing.css` ficou só na homepage; o site levou o cabeçalho, a
  seção de `mcp.json` e a de endereços para o seu `app.css`. As imagens de
  agentes, IDEs e modelos também ficaram só na homepage.

## Frontend

- ~~**Dark mode fixo** com paleta roxa. Um tema claro dobraria a superfície de
  ajuste visual sem ganho para um v1 — a decisão é revisável.~~ **Revista: os
  três apps têm tema duplo.** O tema é o `data-theme` do `<html>`, escrito por
  um script inline antes da primeira pintura e guardado em `localStorage`
  (`useTheme.ts`, idêntico nos três). O **site** e a **homepage** nascem
  claros e respeitam `prefers-color-scheme`; o **painel** nasce escuro, pela
  referência do redesign, e ignora a preferência do sistema. A paleta do
  painel é a rampa espelhada do [`10`](10-admin-canvas-e-sessoes.md) §3, não a
  do site.
  No **painel**, que tem três consumidores montados ao mesmo tempo (o menu da
  conta, a paleta ⌘K e o canvas), o hook vem de `themeStore.ts` — um estado
  para a página inteira, por `useSyncExternalStore` —, e o `useTheme.ts` dele
  fica só como par da cópia e dono do tipo `Theme`. Com um estado por
  consumidor, quem não tinha feito a troca ficava com o rótulo invertido e
  gastava o primeiro clique reescrevendo o tema que já estava na tela
  (relatório 045 da auditoria de 2026-09-19). O `themeStore` também reescreve
  `style.colorScheme` no `<html>`: o valor inline que o script do boot deixa
  vence o `color-scheme` que o `tokens.css` declara por tema, e sem repeti-lo a
  barra de rolagem e os controles nativos ficavam no tema do boot — site e
  homepage, que seguem com o hook copiado, têm o mesmo defeito latente.
- O frontmatter YAML do `SKILL.md` é **removido antes da renderização**: nome,
  descrição e tags já aparecem no cabeçalho da página.
- `react-markdown` sem `rehype-raw`: HTML cru no `SKILL.md` não é renderizado,
  então conteúdo vindo do painel não injeta script.
- **As janelas modais têm um só comportamento de foco** (`051`). `Modal` e
  `ConfirmProvider` compartilham `useModalFocus`: rótulo por `aria-labelledby`,
  foco inicial dentro da janela (respeitando um `autoFocus` do conteúdo), `Tab`
  circulando por dentro pelas bordas e o foco devolvido a quem abriu, se ele ainda
  estiver na tela. O foco inicial é dado num `setTimeout(0)` de propósito: a
  paleta ⌘K, que abre parte dessas janelas, devolve o foco dela ao fechar pelo
  mesmo mecanismo, e um foco síncrono seria desfeito no mesmo instante. O
  `<dialog>` nativo daria armadilha de foco e fundo inerte de graça, mas trocaria
  `.overlay` por `::backdrop` no `shell.css` — fica para quando o CSS for mexido.
- **Os arquivos que são cópia byte a byte entre apps têm guarda automática** em
  `apps/site/src/arquivosCopiados.test.ts`: dez pares, o site sempre na origem. O
  teste também reprova o par incompleto (arquivo renomeado ou apagado) e o caso
  inverso — o `tokens.css`/`base.css` do painel ficar igual ao do site, ou
  aparecer um `chrome.css` no painel. Mudou a lista de pares? Atualize o
  [`04`](04-design-system.md) no mesmo commit.

## O prompt em duas guias

Na visualização — no site e no painel — o prompt fica numa caixa com duas
guias. **"Skill"** é a leitura: o markdown renderizado, sem o bloco de
metadados, que já aparece no cabeçalho. **"SKILL.md"** é o arquivo inteiro,
frontmatter e corpo, do jeito que o download materializa — para quem quer
copiar e colar num `SKILL.md` próprio. Um botão "Copiar" acompanha a segunda.

O frontmatter é montado **no navegador**, porque o que trafega no JSON é só o
corpo: os metadados moram em colunas do banco. Isso significa duas
implementações do mesmo formato — `packages/shared/src/frontmatter.ts`, que
serve o download, a leitura crua e o MCP, e o espelho
`apps/*/web/src/frontmatter.ts`, que serve a guia. Se as duas divergirem, o
usuário copia uma coisa e baixa outra, então `apps/site/web/src/frontmatter.test.ts`
compara as duas saídas caso a caso, incluindo o que o YAML leria errado sem
aspas, o BOM e o CRLF. O pacote não entra no bundle do navegador (é Node: zip,
streams, `Buffer`), só no teste.

## Leitura antes da edição no painel

Clicar numa skill na lista abre `/skills/:slug`, a **tela de leitura**: o
`SKILL.md` renderizado com a árvore de arquivos ao lado, como o visitante vê no
site. O editor mora em `/skills/:slug/edit` e só se chega nele pelo botão
"Editar" — abrir uma skill deixou de significar estar prestes a mudá-la, e o
caminho de volta é o botão "Visualizar" ou o link do cabeçalho.

A rota do editor **não** tem trava de papel, como antes: quem não pode escrever
já não recebe os botões de salvar e remover, e é assim que a tela se comporta
desde que existe. O que muda é que o botão "Editar" só aparece para quem pode.

A árvore e os ícones por extensão são os mesmos do site — `fileTree.ts` e
`FileTypeIcon.tsx` são cópias idênticas nos dois apps, no mesmo espírito do
`useTheme.ts`. O `FileTree.tsx` é que difere: no painel ele também escolhe um
arquivo — na guia Skill do editor, para abri-lo na guia Arquivos. Criar,
enviar e remover são do `FileExplorer.tsx` dessa guia (ver
[A guia Arquivos do editor de skill](#a-guia-arquivos-do-editor-de-skill)).

## Editor de skill no painel

A tela do `SKILL.md` traz, numa aba só, o formulário de metadados (slug, nome,
descrição, tags, visibilidade) e, abaixo dele, o prompt em markdown com a
pré-visualização renderizada ao lado, em tempo real.

- O rótulo do slug diz o que ele é: **nome oficial da skill** — vai no `name:`
  do frontmatter, na URL e nas ferramentas MCP. O outro campo é o nome de
  exibição do catálogo.
- Entre o formulário e o prompt fica um bloco somente-leitura com as
  **primeiras linhas que serão geradas**, para o operador ver o efeito dos
  campos sem precisar baixar o arquivo.
- O prompt é enviado por `stripFrontmatter` antes de sair do navegador e de
  novo no servidor: as duas pontas garantem o que a §3.5 das decisões exige.
- O `SKILL.md` **aparece** na árvore, porque escondê-lo deixava a árvore
  mentindo sobre o pacote — mas nunca abre como arquivo cru. Na guia Arquivos
  (`13`, decisão 18), clicar nele abre o **corpo do formulário**, com o
  frontmatter gerado travado acima, e quem grava é o Salvar do cabeçalho: num
  editor cru a edição não passaria pelo formulário, e gravar metadados por lá
  seria gravar o que a primeira leitura descarta. O botão de remover não
  existe para ele, e a contagem da guia é a de `fileCount`, com ele.
- `apps/admin/web/src/frontmatter.ts` e `slug.ts` espelham
  `packages/shared`: o pacote é Node (zip, streams, `Buffer`) e não entra no
  bundle do navegador. O servidor continua sendo quem decide.

### Rolagem sincronizada

Rolar um painel move o outro, nos dois sentidos. O que se espelha é a **fração
rolada**, não a posição: fonte e render não têm a mesma altura — um `##`
renderizado ocupa o triplo da linha que o gerou, um bloco de código ocupa o
mesmo. A conta está isolada em `scrollsync.ts`, testada sem DOM.

- Só o painel com que o operador interagiu por último comanda (`leader`).
  Espelhar os dois sentidos ao mesmo tempo faria um puxar o outro em laço: a
  rolagem que o handler provoca no seguidor volta como evento. Digitar também
  reivindica o comando para o markdown, mesmo com o ponteiro parado do lado.
- A sincronia na rolagem é **síncrona**, sem `requestAnimationFrame`: esperar
  um quadro deixaria o seguidor visivelmente atrasado.
- O realinhamento depois de digitar e ao voltar de "Escrever"/"Visualizar"
  roda em `useLayoutEffect` — ler as alturas ali força o cálculo do layout já
  atualizado e o ajuste entra antes do desenho.
- Limite conhecido: a fração acerta começo, meio e fim, e escorrega no meio
  conforme a mistura de títulos, listas e código muda ao longo do documento.
  Medido no painel: num prompt de mistura uniforme o desvio máximo foi 21px
  (~3% da altura do painel); num caso construído para ser desfavorável — 60
  linhas de código seguidas de 20 títulos — chegou a 351px, 0,58 de uma tela.
  Ancorar cada bloco renderizado na linha que o gerou resolveria, ao custo de
  um plugin rehype e de um espelho do textarea para achar a linha visível.

## Conexão com o banco

O compose passa `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`, lidos
nativamente pelo driver, em vez de montar uma `DATABASE_URL`. Motivo: numa URL,
`/`, `?` e `#` na senha encerram a autoridade e quebram o parse, e `%XY` é
percent-decodificado em silêncio — a senha que chega ao Postgres deixa de ser a
configurada. Senha gerada aleatoriamente cai nisso com frequência.
`DATABASE_URL` continua aceita (é o caminho para rodar fora do compose) e é
validada no boot, com uma mensagem que explica o percent-encoding.

## Segredos

- **Placeholder recusado no boot** (`001`). A guarda `assertNotPlaceholder` fica
  **fora** do `readSecret` de propósito: as chaves do RAG também saem do
  `.env.example` com `CHANGE_ME` e são lidas por lá mesmo com a busca semântica
  desligada, então validar dentro do `readSecret` derrubaria o boot do site, do
  mcp-public e do indexador por uma variável que ninguém usa. Quem chama a guarda
  é quem sabe que aquele valor vai autenticar alguém: o `requireSecret` (hoje só
  `MCP_ADMIN_TOKEN`) e os dois pontos do admin — `ADMIN_SESSION_SECRET` e
  `ADMIN_PASSWORD`, que é a credencial que cria o primeiro administrador. O padrão
  é ancorado, então a `DATABASE_URL` de exemplo — que carrega `CHANGE_ME` no
  meio — não casa, e `POSTGRES_PASSWORD` não passa por
  `readSecret`/`requireSecret`: o fluxo do dba segue intocado.
- **Nas chaves do RAG o mesmo placeholder vale como chave ausente** (relatório
  021 da auditoria de 2026-09-19). Não
  derrubar o boot respondia só metade da pergunta: o `CHANGE_ME` seguia sendo
  lido como credencial, e com ele o boot dizia "chave presente para: google,
  openai, voyage", o aviso de "nenhuma chave" nunca saía e, ligado um driver no
  painel, o indexador mandava texto de skill ao provedor com `CHANGE_ME` a cada
  ciclo — com o painel mostrando "recusada" onde o certo é "não configurada".
  `readApiKeyEnv` (`packages/rag/src/settings.ts`) devolve `undefined` para o
  placeholder, pelo predicado `isPlaceholder` — a **mesma** lista do
  `assertNotPlaceholder`, sem lançar. O `readSecret` continua genérico, e o
  `.env.example` continua com `CHANGE_ME`.
- **No ramo `<NOME>_FILE` o valor é aparado** com `trim()`, e arquivo em branco
  vale `undefined`, como no ramo da variável (`046`). O motivo não é o header HTTP
  (a normalização do Fetch apara o espaço em branco das pontas sozinha): é a
  comparação — `safeEqual` do `MCP_ADMIN_TOKEN` contra um `bearerToken` que já vem
  aparado, e a senha de bootstrap digitada por uma pessoa.

## Varredura de segredos

- A lista de placeholders do `.gitleaks.toml` e o `PLACEHOLDERS` de
  `packages/shared/src/secrets.ts` são a mesma lista **com a mesma âncora** — as
  duas casam o valor inteiro; mexer numa pede mexer na outra (`040`). As chaves do
  RAG ficam numa regra separada, com piso de 16 caracteres, porque os testes
  atribuem fixtures curtas (`RAG_GOOGLE_API_KEY: 'k'`): uma exceção por caminho de
  teste desligaria justamente o caso que se quer pegar. Variável de segredo nova
  no `.env.example` pede entrada na regra. A guarda do CI casa o **nome de
  arquivo** (`(^|/)\.env[^/]*$`), não pathspec com ponto.
- A dispensa de interpolação do `.gitleaks.toml` é por **valor** e **ancorada no
  fim**, como a lista de placeholders: passam `${VAR}`, `${VAR:-}` e
  `${VAR:?mensagem}`, e `${VAR:-valor}` é apontado — era `^\$\{` solto, que
  dispensava o valor padrão embutido só por começar com `${` (relatório 065 da
  auditoria de 2026-09-19). Não existe
  dispensa por *linha*: allowlist de topo sem `targetRules` vale para **todas** as
  regras, inclusive as padrão, e calava um token de verdade em qualquer linha que
  só mencionasse `${VAR:-`. O nome com que o compose entrega o segredo ao
  container entra na regra junto com a variável (`PGPASSWORD`,
  `MCP_INSPECTOR_API_TOKEN`); sem ele o casamento cai dentro das chaves e captura
  só o resto (`?defina`), e o remédio para esse achado é pôr a chave na regra, não
  dispensar o valor.
- A varredura do CI é sobre o **histórico inteiro**, então apertar um allowlist
  ressuscita achado de commit antigo e deixa o job vermelho para sempre. Toda
  mudança no `.gitleaks.toml` se ensaia antes, num clone completo, com o comando
  do CI (`gitleaks git --redact --no-banner --config=.gitleaks.toml .`): o diff
  proposto nesse mesmo relatório 065 passava na árvore e reprovava em quatro
  pontos do histórico.
  O que é de commit antigo e não é segredo vira exceção fechada no commit **e** no
  arquivo, como as três que o arquivo já tem.
- O passo que instala o gitleaks confere o `gitleaks_<versão>_checksums.txt` do
  próprio release (formato `sha256` + dois espaços + nome do arquivo, linha
  escolhida por campo exato com `awk` e conferida com `sha256sum -c -`), então o
  hash **não** fica escrito no
  workflow e subir `GITLEAKS_VERSION` continua sendo mudança de uma linha
  (`041`). O gitleaks não publica assinatura nem attestation dos tarballs
  (`gh attestation verify` responde 404), por isso o checksums do release é o teto
  de garantia disponível: pega download corrompido ou adulterado no caminho e
  asset trocado, não pega release refeito por quem tem a conta.

## Configuração numérica

Limites vindos do ambiente passam por `readIntEnv` (`packages/shared`), que
trata vazio como ausente e **derruba o boot** quando o valor não é um inteiro na
faixa. `Number('25MB')` é `NaN`, e como toda comparação com `NaN` é falsa, um
sufixo distraído desligaria justamente a proteção que a variável configura — o
teto de descompressão de zip, o teto de sessões MCP, o tamanho máximo de upload.
Para um limite de segurança, falhar alto é melhor que relaxar em silêncio.

O mesmo vale para strings: `readTextEnv` trata vazio como ausente, porque o
compose repassa variáveis não preenchidas como string vazia e `??` só cobre
`undefined`.

Tamanho **com unidade** passa por `readSizeEnv` (relatório 029 da auditoria de
2026-09-19), e hoje é um só: o `MCP_JSON_LIMIT` dos dois MCPs. O valor vai cru
para o `express.json({ limit })`, e o `bytes` do body-parser aproveita o começo
do que não entende — `48m` e `48 megas` valem 48 **bytes**, `1mbb` vale 1 —,
então o serviço subia e respondia 413 a tudo, sem erro nenhum no boot. Aceita
`<número><kb|mb|gb>` ou um inteiro de bytes; o resto, e o zero, derrubam o boot
com o nome da variável na mensagem. No `.env` do compose o nome é por serviço
(`MCP_PUBLIC_JSON_LIMIT`, `MCP_ADMIN_JSON_LIMIT`): ver
[`02-architecture-decisions.md`](02-architecture-decisions.md) §10.

Daí a regra de escrita das variáveis (`039`): **variável que o código lê entra no
`environment` do compose como `${VAR:-}` e no `.env.example` vazia ou
comentada — nunca com o valor do padrão escrito.** É o que mantém vivo o padrão
**derivado**: `MCP_MAX_SESSIONS_PER_IDENTITY` é um décimo de `MCP_MAX_SESSIONS`,
e um `50` escrito no compose faria os dois pararem de subir juntos. Vale para
`MCP_JSON_LIMIT`, `MCP_MAX_FILE_TEXT_BYTES`, os tetos de taxa e os de sessão.

Os tetos do limite de taxa (`SITE_RATE_LIMIT_MAX` 240, `MCP_RATE_LIMIT_MAX`
600~~, `MCP_MAX_STATELESS_SESSIONS` 5 000~~) aceitam **`0` como "desligado"**,
para a instalação que já limita no proxy (`014`). Os números são por minuto e por
IP, e são generosos de propósito: o site é navegado por pessoas atrás de NAT e o
MCP público por agentes que trabalham em rajada. No MCP público a conta é por
**mensagem**: o lote JSON-RPC paga uma marca por mensagem e tem teto próprio
(`MCP_MAX_BATCH` 20, mínimo `1`), que vale mesmo com o limite em `0` — o proxy
também conta requisição, não mensagem (relatório 046 da auditoria de
2026-09-19).

**Revogado neste ponto pelo relatório 030 da auditoria de 2026-09-19:**
`MCP_MAX_STATELESS_SESSIONS` nunca
aceitou `0`, e não é limite de taxa. É o teto de identidades stateless
contabilizadas **ao mesmo tempo**, no processo inteiro — sem janela de minuto e
sem recorte por IP (`apps/mcp-public/src/sessions.ts`). O mínimo é `1`, o padrão
do `readIntEnv`: `0` derruba o boot do mcp-public com a mensagem de faixa, como
qualquer limite inválido, e há teste fixando isso. Não existe "desligado" para
ela de propósito — sem teto, um `user-agent` variável volta a encher
`mcp_sessions`, que nunca é podada (`014`), e um teto `0` faria o oposto do que o
nome sugere: nenhuma requisição stateless seria contabilizada. Quem já limita no
proxy deixa a variável vazia.

## Ordem dos middlewares

O parser JSON é montado **depois** da autenticação, não no topo do app:

- MCP: `express.json` entra por rota, sempre após `options.auth`, com o teto
  declarado por serviço (`jsonLimit`) — 1 MB no público, cujas ferramentas
  trocam poucos bytes, e 48 MB no admin, que recebe o `.zip` em base64.
- Painel: um parser de 4 KB só para `/api/login`, e o de 32 MB depois de
  `requireAuth`.

Ler megabytes antes de saber quem está chamando entrega memória de graça a
qualquer anônimo — no MCP público, que roda aberto por padrão, isso bastava para
derrubar o processo.

O **limite de taxa por IP**, ao contrário, entra **antes** da autenticação
(`014`): é ele que protege a consulta que o `auth` faz. A isenção de quem tem
chave vem por devolução da marca (`forgive`) logo depois de o `auth` passar — a
presença do `Authorization` não serve de sinal, porque num vMCP aberto o cabeçalho
é ignorado. `/healthz` fica acima do limite nos dois apps que o têm — o site e o
mcp-public: um 429 na sonda reiniciaria um container saudável. O **mcp-admin
não tem limitador** (`02` §7.7): ali o `auth` é a primeira coisa que toca o
banco, e quem publica o serviço limita no proxy.

No painel, logo depois da checagem de origem vem a **recusa do caractere nulo
na URL** (`nulGuard`; achado do relatório 038 da auditoria de 2026-09-19). O
Postgres não guarda U+0000 em `text`: um `%00` num slug, num caminho de arquivo,
numa tag ou num e-mail chegava ao driver e voltava como o 22021 cru — 500, com o
SQL no log. O banco já responde 400 no que passa pelos validadores de texto dele
e no termo de busca, mas as leituras por identificador são vinte pontos; nenhum
endereço do painel tem uso legítimo para o caractere, então a recusa é uma só,
na entrada, antes até das rotas anônimas. Ela olha o endereço **cru**: naquele
ponto o roteador ainda não casou rota nenhuma (`req.params` está vazio), e todo
U+0000 que a decodificação do caminho ou da query string pode produzir vem
escrito `%00` — `%2500` é o texto "%00" e passa. O nulo literal nem chega ao
Express: o parser HTTP do Node recusa a linha da requisição. O corpo JSON fica de
fora (o banco o confere campo a campo). O site e o mcp-public têm a mesma recusa
no roteador deles, depois do limite de taxa (`apps/site/src/api.ts`,
`apps/mcp-public/src/http.ts`); o mcp-admin não tem slug no caminho. O que **não**
passa por URL nenhuma — o nulo em **argumento de tool** (`slug`, `tag`) nos dois
MCPs — continua indo ao banco e volta como erro interno genérico, sem vazar nada
ao cliente.

Cada app tem um tratador de erros no fim da cadeia. Sem ele, o que os
middlewares lançam (upload acima do limite, JSON malformado) escapa do
`route()`/`guard()` e sai como HTML — numa API JSON, o cliente vê apenas
"Erro 500" para o que é erro dele, com o status errado.

## Trust proxy e o IP do cliente

`req.ip`, `req.secure` e `req.hostname` saem do `trustProxySetting` (`026`). O
padrão do `TRUST_PROXY` é uma **função** `(endereço, salto) => confia?` que aceita
um salto de peer interno: a mudança encurta a caminhada na cadeia do
`X-Forwarded-For` e **não** altera `req.secure`, `req.hostname` nem o caso sem
cabeçalho. O `isInternalAddress` — as seis faixas do `loopback, uniquelocal`, com
IPv4 mapeado em IPv6 normalizado — mora em `packages/shared/src/proxy.ts`; a gêmea
de `apps/admin/src/config.ts` deve virar um `import`.

## Cabeçalhos de segurança das páginas

A CSP dos três frontends vive em `packages/shared/src/headers.ts` e é aplicada no
`index.ts` de cada app (`045`). O hash do `<script>` de tema é calculado no boot a
partir do `dist-web/index.html` que o app serve — **nunca** fixado no código, que
se desatualizaria calado a cada mudança no HTML e derrubaria o tema em produção.
`style-src` mantém `'unsafe-inline'` porque o `cmdk` da paleta usa o Radix, que
injeta um `<style>` em runtime (`react-style-singleton`) para travar o scroll;
`img-src` libera `http:` e `https:` porque `isValidSkillIcon` aceita URL externa.
Em desenvolvimento a página vem do Vite e nenhuma dessas respostas é documento,
então a CSP não atrapalha o HMR.

As rotas que servem **arquivo de skill** trocam a CSP pela delas
(`default-src 'none'; sandbox`) e o tipo pelo de `safeContentType`. As duas
defesas — e o `Content-Disposition` — só valem quando o arquivo é aberto **como
documento**; carregado como sub-recurso por uma página da própria origem, quem
decide é a CSP **da página**, e `script-src 'self'` aceitaria o endereço cru de
um `.js` anexado a uma skill. Por isso `safeContentType` rebaixa a `text/plain`
também os tipos de script e `text/css` (relatório 014 da auditoria de
2026-09-19): com o `nosniff` que os três serviços já mandam, o navegador recusa
usá-los — medido no Chromium, não deduzido. Imagem não entra, e a
pré-visualização do painel (`<img src=…?raw>`) segue igual. O "Abrir cru" do
painel manda ainda `Cache-Control: private, no-cache`: conteúdo de skill privada
não fica em cache compartilhado, e a imagem que não mudou volta como 304 pelo
`ETag`.

## Slug e concorrência

`resolveSlug` consulta os slugs ocupados e o INSERT vem depois, então duas
criações simultâneas podem escolher o mesmo. A constraint `UNIQUE` do banco
resolve o empate; o código traduz o `23505` resultante: com slug gerado a partir
do nome, escolhe outro e tenta de novo (a intenção é "qualquer slug livre"); com
slug pedido explicitamente, devolve 409.

O sufixo de desempate de `uniqueSlug` cabe **dentro** do teto de 96 (`MAX_SLUG`),
encurtando a base (`046`): quem gera o slug é o mesmo sistema que depois o valida
com `isValidSlug`, e o teto é o que torna o slug idempotente sob `slugify`.
Afrouxar o `isValidSlug` seria a correção oposta, e abriria o portão do slug
pedido pelo cliente.

O `LIKE 'prefixo%'` que procura os slugs ocupados **usa índice em `skills`** desde
a migration `022` (`skills_slug_trgm_idx`; um GIN de trigramas atende `LIKE` de
prefixo em qualquer coleção); em `virtual_mcps` e `catalogs`, que não ganharam o
índice, é varredura. Reescrevê-lo como faixa **não** é equivalente nesta
instalação — ver as armadilhas, no fim deste documento.

## Ícone da skill

O teto de `SKILL_ICON_MAX_LENGTH` vale para os **dois** ramos de
`isValidSkillIcon` (`046`): o regex de emoji aceita cadeia ZWJ de qualquer
tamanho, e sem o teto no app quem recusa é o `skills_icon_length_chk` do
`schema/013` — trocando um 400 por um 500.

## Paginação

Inteiro de query string entra pelo `asInt` (`apps/site/src/api.ts` e
`apps/admin/src/api.ts`, agora os dois), nunca por `Number(...)` cru: repetido
(`?offset=1&offset=2`) ele chega como array e vira `NaN` (`046`). O **teto**
continua sendo do banco (`clamp`), como o `033` decidiu.

O teto do banco vale para o **`offset`** também (relatório 086 da auditoria de
2026-09-19). `OFFSET` é `bigint`, e um `?offset=` de 20 dígitos cabe num double,
passa pelo `asInt` inteiro e chegava ao driver como texto fora da faixa: 500 na
lista anônima do site, com a SQL da busca no log. `pageOffset` agora **satura** em
`Number.MAX_SAFE_INTEGER` — não recusa, como `clamp` não recusa o `limit` — e a
resposta é a página vazia de quem paginou além do fim, com o `total` certo. Pela
mesma razão o `offset` das tools MCP segue sem `.max()` no schema: o `.int()` do
Zod aceita `1e20`, e quem o põe na faixa é o banco. O mesmo relatório fechou o
resto do `046`: o `/api/audit` do painel ainda lia os dois por `Number(...)`, e
com ele `?limit=abc` virava `NaN`, que o `clamp` lê como o **mínimo** — a trilha
voltava uma linha em vez de 50. `?limit=abc` cai no padrão **no app**; um `NaN`
que chegue ao banco por outro caminho continua valendo o mínimo.

## MCP virtual

Decisões de implementação que [`08-mcp-virtual.md`](08-mcp-virtual.md) deixou
em aberto:

- **Dois pontos de montagem, um mapa de sessões.** `createHttpApp` do
  mcp-public passou a receber `mounts`; os transportes são registrados num
  `Router({ mergeParams: true })` por mount, para o `:slug` do prefixo chegar
  às rotas de dentro. As sessões (Streamable e SSE) vivem num mapa só, com a
  amarração por identidade portada do mcp-admin — a identidade do virtual
  embute MCP e chave. O `http.ts` do mcp-admin continua com a forma antiga
  (um mount implícito): os dois arquivos são cópias por app, como sempre foram.
  O mapa e o teto global são do **processo**, mas o orçamento de sessões é por
  **credencial** (`007`): `MCP_MAX_SESSIONS_PER_IDENTITY`, padrão de um décimo de
  `MCP_MAX_SESSIONS` com mínimo de 10, contado nos dois transportes juntos. O
  `http.ts` do mcp-admin recebeu a mesma mudança.
  ~~As duas cópias seguem em paralelo.~~ **Deixou de valer desde o relatório 046
  da auditoria de 2026-09-19:** só o **público** ganhou o teto de mensagens por
  lote JSON-RPC. Um array com mais de `MCP_MAX_BATCH` mensagens (padrão 20) sai
  com 400 `-32600` sem executar nada, e cada mensagem do lote aceito custa uma
  marca do limitador de taxa — sem isso, um POST de 1 MB com milhares de
  `tools/call` gastava **uma** marca e executava todas. O mcp-admin não recebeu
  o guarda porque lá **toda identidade é autenticada** e não existe limite de
  taxa nenhum: o que o teto protege é o banco contra quem não tem chave. Portar
  o teto para o admin, sem a parte da cota, continua possível — é decisão do
  mantenedor, não descuido. `MCP_MAX_BATCH` só é lida pelo serviço
  `mcp-public`.
- **Base das URLs de download.** `MCP_PUBLIC_URL` no mcp-public; sem ela, a
  origem da requisição (`req.protocol://host`, respeitando `trust proxy`). O
  painel recebe a mesma variável para o snippet de `mcp.json`.
- **`setVirtualMcpSkills` trava o MCP** dentro da transação: dois salvamentos
  concorrentes da lista não se sobrescrevem. A trava é `SELECT … FOR NO KEY
  UPDATE` — **era** `FOR UPDATE`, até o relatório 023 da auditoria de
  2026-09-19: ver a regra da ordem de travas do vMCP em
  [Armadilhas medidas na revisão de 2026-09-18](#armadilhas-medidas-na-revisão-de-2026-09-18).
- **Sem `.skill` nem página no site para skill fora do site.** O virtual serve
  `download` e `download.skill`; a `url` da página sai quando a skill é
  **pública** ou está em algum vMCP aberto e ligado (`mcps` da própria leitura)
  — é o `noSite` de `apps/mcp-public/src/tools.ts`, a regra do
  [`12`](12-acesso-granular.md) §7. Skill que só chega ao site por catálogo
  público segue sem link, porque esse sinal não vem no recorte (ver
  [Site: skills e catálogos públicos](#site-skills-e-catálogos-públicos)).
  **Era**, até a `beta.21`: ~~"a `url` da página só sai quando a skill está em
  algum vMCP aberto e ligado"~~ — a regra do
  [`09`](09-mcp-padrao-e-skills-flutuantes.md) §4.1, de quando `is_public` não
  existia; o `12` a revogou e o código a seguiu na `beta.22` (`050`).
- **Downloads sem cache** (`Cache-Control: no-store`): a resposta depende da
  credencial, e o site continua sendo o único lugar com `max-age`.
- **O painel enxerga todos os vínculos, inclusive com MCP desligado ou
  fechado** — `SkillSummary.mcps` numa leitura `'all'` traz tudo, com o estado
  de cada vMCP: o vínculo existe, e o painel é sobre o vínculo. Numa leitura
  pública a lista só traz os abertos e ligados.
- **O aviso de exposição está pela metade, e a confirmação de abertura não
  existe mais** (`021`). `confirm_open_required`, `confirmOpen` e
  `VirtualMcpSummary.privateSkillCount` viveram entre o PR do
  [`08`](08-mcp-virtual.md) e o PR2 do [`09`](09-mcp-padrao-e-skills-flutuantes.md),
  que os removeu (decisão 9). O regime vigente é o aviso inline da decisão 15 do
  [`12`](12-acesso-granular.md), **por skill e não por contagem**: o painel usa
  `SkillSummary.isPublic` e `VirtualMcpSummary.isOpen`, que já chegam, e avisa ao
  vincular (canvas, ficha da skill e skill nova) e ao **abrir** um servidor
  (`ServerPage.tsx`, texto qualitativo); a tool `update_virtual_mcp` diz o mesmo
  na descrição. Não há **contagem** de skills privadas, e restaurá-la depende de
  `private_skill_count` voltar à consulta do resumo do vMCP.
- **Nome de vMCP, de catálogo e de chave `psv_` tem teto: 200 caracteres**
  (relatório 042 da auditoria de 2026-09-19). Não havia teto nenhum — o único
  freio era o limite do corpo da requisição —, e os três são copiados por extenso
  em cada linha de `skill_accesses`, que nunca é podada. O banco corta a **cópia**
  em 512 na gravação do acesso; este teto é o que impede o nome gigante de
  existir. É `NAME_MAX`, em `apps/admin/src/mcps.ts`, com o gêmeo em
  `apps/mcp-admin/src/mcps.ts`: **uma constante ajustável, não um contrato** —
  quem precisar de outro número muda nos dois e o mantém abaixo de 512. Vale para
  quem **cria ou renomeia**: nome antigo mais longo continua válido até alguém
  mexer nele, porque o Salvar do painel reenvia o nome e um teto retroativo
  travaria a edição do objeto por causa do nome que ele já tem (`assertNameFits`
  recebe o nome atual). A recusa é 400 dizendo o tamanho e o limite. No mcp-admin
  o teto fica no handler, e não como `.max()` no schema zod da tool: assim a
  recusa chega ao agente em português, e o schema não conhece o nome atual. O
  nome da **skill** continua sem teto na entrada (só a cópia é cortada); a chave
  `psk_` já tinha o seu, de 80.
- **`name` que não é texto é 400** nas mesmas rotas (achado do relatório 007 da
  mesma auditoria): `String(valor ?? '')` num objeto cujo `toString` não é função
  — `{"name":{"toString":1}}` — lançava `TypeError`, devolvido como 500 com linha
  de "erro inesperado" no log. `nameFrom`, em `apps/admin/src/mcps.ts`, é o gêmeo
  do `textOf` de `accounts.ts`: ausente ou nulo é vazio, presente e não-texto é
  `O campo "name" deve ser uma string`.

## MCP padrão

Decisões de implementação que
[`09-mcp-padrao-e-skills-flutuantes.md`](09-mcp-padrao-e-skills-flutuantes.md)
deixou em aberto:

- **Um `auth` por mount, uma autenticação.** `rootAuth` e `virtualAuth`
  diferem só em como acham o vMCP (`settings` vs. slug da URL); a conferência
  de `is_open` e da chave `psv_` é a mesma função, `authenticateAgainst`. As
  rotas de download recebem o `auth` do mount por parâmetro
  (`registrarDownloads(auth)`), em vez de importar `virtualAuth` fixo.
- **Prefixo das URLs vem de `req.baseUrl`.** É o prefixo do mount já
  resolvido pelo Express (`''` na raiz, `/virtual/<slug>` no outro), então o
  mesmo vMCP ganha URLs sob o caminho por onde foi chamado, sem um segundo
  parâmetro para dizer "estou na raiz".
- **`GET /` calcula por requisição.** `createHttpApp` ganhou `describe`, uma
  função assíncrona mesclada aos metadados fixos; uma falha nela devolve só
  os fixos, para o endpoint de descoberta nunca depender do banco.
- **A trava de boot olha as três variáveis crua**, não por `readTextEnv`:
  vazia é ausente, qualquer outra coisa derruba, e a mensagem nomeia todas as
  que encontrou.
- **O seed audita como `seed`.** `createVirtualMcp` e `setDefaultVirtualMcp`
  exigem ator; o seed passa `{ userUuid: null, label: 'seed' }`, no mesmo
  espírito de `bootstrap` e `token-global`.
- **`DefaultMcpResolution.inactive` carrega `uuid` e `slug`.** O painel
  precisa pré-selecionar o vMCP desligado no seletor e dizer qual é; `deleted`
  não tem linha para apontar.

## MCP administrativo

- **O servidor é construído uma vez, os handlers nascem por chamada** (`006`). O
  `initialize` monta o `McpServer` da sessão, mas `comCaller` põe o `Caller` da
  requisição em curso num `AsyncLocalStorage` no despacho do transporte e
  `callerAtual(padrao)` o lê dentro das tools, refabricadas com a credencial
  **revalidada**. Não custa nada: `requireBearer` já relia a chave e a conta no
  banco a cada requisição (um `SELECT` em `api_keys` pelo prefixo indexado, um em
  `users`, o `UPDATE` de `last_used_at` sem `await` e um `scrypt`) e o resultado
  era descartado. Papel, ator, IP e agente deixam de ser "a foto do
  `initialize`"; a sessão continua presa à credencial que a abriu pelo
  `identityOf` (403 para credencial alheia) e nenhuma mudança de papel derruba a
  sessão do cliente. Revogar a chave segue sendo o corte imediato e total;
  rebaixar o papel agora vale na próxima requisição. `callerAtual(caller)` cai no
  `Caller` do `initialize` quando não há requisição no contexto — o comportamento
  antigo como piso, nunca admin por omissão. Isto só é barato enquanto
  `createHandlers`, `createMcpHandlers` e `createCatalogHandlers` não fizerem I/O
  no corpo: se algum passar a consultar o banco, vira custo por tool e pede cache.
- **Erro de negócio e erro imprevisto** (`031`, `AUDITORIA-01`). O `guard` de
  `apps/mcp-admin/src/tools.ts` devolve a mensagem inteira do `AppError` — erro de
  negócio, escrito para o agente ler — e embrulha qualquer outra exceção em
  `Erro interno do servidor (ref xxxxxxxx)`, com o mesmo
  `randomUUID().slice(0, 8)` repetido no `console.error`, como o `http.ts` já
  fazia. Ele não pode simplesmente relançar: o `McpServer` do SDK captura a
  exceção do handler e monta o `isError` com `error.message`, então relançar
  vazaria o mesmo texto. Mensagem crua fora de produção foi recusada de
  propósito — o Vitest roda com `NODE_ENV=test` e o teste passaria a fixar o
  caminho que vaza. O mesmo desenho vale no `apps/mcp-public/src/tools.ts`:
  `guard` nas cinco tools e `guardSurface` em `prompts/list`, `prompts/get`,
  `resources/list` e `resources/read`. Nos handlers de baixo nível não dá para
  devolver resultado — lá a exceção vira erro de JSON-RPC, cuja `message` o SDK
  também tira da exceção (`shared/protocol.js`) —, então o `guardSurface`
  relança: `McpError` inteiro (é a recusa escrita para o cliente), `AppError` como
  `InvalidParams` e o resto como `InternalError` genérico. Registrar uma tool nova
  sem o `guard` reabre o vazamento; a validação do Zod roda antes dele e não é
  afetada, e o corte de `resources/templates/list` é deliberado (devolve
  literal). O bloco de `nosniff` do `http.ts` dos dois MCPs é inline e **não** usa
  o `securityHeaders` do `shared`, que existe para respostas de documento (site,
  homepage, painel): num servidor MCP não cabe CSP de documento.
- **Todo handler que decide por caminho de arquivo normaliza antes de decidir**
  (`050`): `get_file` e, agora, `set_file`. `isSkillMd` compara texto exato e
  `normalizeRelativePath` canoniza, então decidir com o caminho cru grava o
  `SKILL.md` por baixo da regra que o protege. A regra estava escrita e ainda
  tinha dois furos (relatório 016 da auditoria de 2026-09-19): o
  `PUT /api/skills/:slug/files/*path` do painel — no Express 5 o curinga chega
  em segmentos já decodificados, e `.%5CSKILL.md`, `./SKILL.md` e `.//SKILL.md`
  passavam crus, gravando o frontmatter enviado na linha do `SKILL.md` (fora da
  vista em toda leitura, dentro do `search_vector` e do texto do RAG) — e o
  `delete_file` do MCP administrativo, inócuo (o banco normaliza e recusa), mas
  com a recusa sem dizer a saída. Hoje normalizam antes de decidir: `get_file`,
  `set_file` e `delete_file` no MCP administrativo; o `GET`, o `PUT` e o envio
  avulso de `…/files` no painel. O `POST` e o `DELETE` de `…/files/*path`
  passam o caminho cru porque a decisão sobre o `SKILL.md` é tomada **dentro**
  do banco, depois de normalizar (`createFile`, `deleteFile`).

## Skills flutuantes

Decisões de implementação do PR2 de
[`09-mcp-padrao-e-skills-flutuantes.md`](09-mcp-padrao-e-skills-flutuantes.md):

- **`mcps` vem na mesma consulta.** `skillColumns` agrega os vínculos em
  `json_agg` por linha, com o filtro de visibilidade da própria leitura:
  `'all'` traz todos, o resto só os abertos e ligados. Uma segunda consulta
  por skill dobraria o custo da listagem do painel, e uma lista sem filtro
  revelaria ao site em que servidor fechado uma skill está.
- **`visibility` padrão é `'open'`.** O restritivo: quem esquece a opção
  mostra de menos. `requireSkill` e todas as escritas passam `'all'`
  explicitamente.
- **`createSkill({ mcps })` resolve os vínculos antes da transação**
  (`resolveLinks`): uuid torto, desconhecido, repetido ou flag ausente é 400
  sem nada gravado. Cada vínculo audita `mcp.update` no vMCP, como
  `setVirtualMcpSkills`, e não uma ação própria — o painel do MCP mostra a
  mesma trilha independente de qual lado vinculou.
- **A permissão fica no app.** `resolveLinks` do banco não sabe quem chama;
  o painel (`mcps.resolveLinks` → `load(user, slug, 'edit')`) e o mcp-admin
  (`managed(slug, 'edit')`) recusam antes de chamar. (Eram `loadManaged` e
  `canManageVirtualMcp`, trocados pelo `12`.)
- **`unlinkSkill` de um vínculo inexistente é 404**, e nada é auditado — um
  `DELETE` repetido não cria linha de trilha.
- **O painel "Publicada em" salva por linha**, não a página inteira: cada
  vMCP é um `PUT`/`DELETE` próprio, com a permissão daquele vMCP. O picker da
  skill nova e do import é controlado e vai no corpo da criação.
- **`skills_score_idx`** substitui o índice prefixado por `is_public`: é a
  ordenação padrão de toda listagem, com ou sem vínculo.

## Painel: canvas e sessões

Desenho em [`10-admin-canvas-e-sessoes.md`](10-admin-canvas-e-sessoes.md).
O que ficou diferente do que a skill `admin-canvas-ui` prescreve, e por quê:

- **Sidebar com rótulos, não trilho de 56px.** A referência visual tinha
  rótulos; ela venceu a skill.
- **Recolher a sidebar anima a coluna do grid.** `grid-template-columns` vai
  de 220px a 0, e o conteúdo mora num `.sidebar-inner` de largura fixa: a
  borda corta os rótulos em vez de espremê-los. `visibility: hidden` entra
  só no fim da animação, e é o que tira a navegação recolhida do Tab. O
  menu da conta abre dentro da própria sidebar (que tem `overflow: hidden`),
  por isso ocupa a largura do rodapé em vez dos 210px mínimos dos menus.
- **Stack mínima.** Só `@xyflow/react`, `cmdk` e `lucide-react` entraram.
  react-router e Tailwind v4 continuam; a rampa espelhada foi mapeada por
  `@theme inline`, sem voltar ao v3. A filtragem da paleta é nossa
  (`fuzzyScore`), porque parte dos itens vem do servidor já filtrada.
- **Grade de 24px, nó de skill de 264×66.** O cartão de 288×144 da skill
  serve a recursos com três linhas de status; a skill só precisa de ícone,
  nome, slug e os três handles de porta, a 25/50/75% da altura.
- **Arestas do servidor para a skill**, com handles à direita e à esquerda
  (a skill manda topo/base). O grafo é horizontal: Internet → servidor →
  skills.
- **Nós reaproveitados, nunca recriados.** O efeito que reconcilia o palco
  com o detalhe do servidor roda a cada contagem de online (5 s). Recriar o
  objeto do nó apaga `measured` e `dragging`: o React Flow mede de novo e o
  arraste em curso cai. Por isso quem já existe só recebe `data` nova, e a
  seleção da gaveta mexe só em `selected`.
- **Clique abre a gaveta, arraste não.** `selectNodesOnDrag` ligado (o
  padrão) seleciona o nó no começo do arraste, e a gaveta abria no meio do
  gesto. Com ele desligado, a gaveta abre por `onNodeClick`, e o d3-drag
  descarta o clique que encerra um arraste.
- **Rótulo de aresta com `z-index: 2`.** Cada aresta é um `<svg>` com o
  próprio `z-index` (1 aqui), e os rótulos moram num portal irmão sem
  `z-index`: sem ele a linha passa por cima do contador. Com 2 o rótulo fica
  acima das arestas e abaixo dos nós, que vêm depois no DOM.
- **Hover do handle repete o `translate`.** O React Flow centraliza o handle
  com `transform: translate(...)`; um `scale` sozinho no hover descartava o
  deslocamento e o handle pulava para longe do cursor.
- **Sem `parentId`, sem grupos, sem undo.** Fora do escopo do `10`.
- **O `remove-edge` do rótulo da aresta chega por `CustomEvent`.** O
  componente da aresta é memoizado e não recebe callbacks por props (o
  React Flow os recriaria a cada render); um evento no `window` mantém a
  aresta pura.
- **Recarga do detalhe depois de cada escrita.** `linkSkill` devolve o
  detalhe da skill, não o do servidor; o canvas refaz `GET /api/mcps/:slug`
  depois de cada gesto, o que também traz os contadores por porta.
- **Sessões: o `onclose` do transporte pode disparar depois do `timeout`.**
  O rastreador só conhece uma sessão até o primeiro `closed`; o segundo
  motivo é ignorado, e é por isso que o TTL avisa `timeout` **antes** de
  fechar o transporte, e o desligamento chama `shutdown` antes de fechar os
  transportes.
- **`req.ip` como IP de origem.** O Express já resolve o `X-Forwarded-For`
  pelo `trust proxy` (`TRUST_PROXY`); o rastreador não reimplementa isso.
- **Vite em dev usa `ADMIN_API_PORT`.** O proxy do `/api` aponta para a
  porta do servidor do painel (`3001` por padrão), configurável para rodar um
  segundo painel ao lado do do compose.
- **Atalho de uma letra consulta o acorde** (`051`). O `g + tecla` da navegação e
  os atalhos do palco (`a`, `c`, `f`) escutam o mesmo `keydown` em `document`, e a
  ordem dos listeners muda a cada remontagem do `GlobalCommands` — por isso o
  acorde é estado de módulo em `ui.tsx` (`armChord`/`isChordKey`): quem pergunta
  primeiro consome a tecla, e a resposta segue a mesma para o **mesmo** evento, de
  modo que os dois lados concordem sobre de quem ela é. Todo atalho novo de uma
  letra tem de chamar `isChordKey` depois do `isTypingTarget`; o `Escape` do palco
  continua antes dos dois, porque precisa funcionar com foco num campo. O
  `shortcut` dos comandos segue sendo metadado da paleta, não despachante.

## Painel: listas com filtro e paginação

- **Zerar a página é trabalho do campo de filtro** (`setOffset(0)` ao lado do
  setter, como em `SessionsTable`), nunca de um `useEffect` que observa o filtro:
  o efeito só zera depois do render e por isso dispara uma segunda consulta
  (`032`). A busca mora dentro do próprio `useEffect`, com a flag `active`
  liberada no cleanup, para que a resposta atrasada seja descartada em vez de
  sobrescrever a nova — a flag é por requisição, então uma lista com `usePolling`
  não cancela o próprio poll.
- **Filtro que mora fora do componente que pagina zera o `offset` na
  renderização** (relatório 051 da auditoria de 2026-09-19). O seletor de
  servidor da Auditoria não alcança o `setOffset` da `SessionsTable`: o que ele
  muda é a `load` dela. A tabela compara a prop com um `useState(() => load)` e
  volta à primeira página **no render**, como o `useSkillFiles` faz na troca de
  skill — não num efeito, pelo mesmo motivo do item acima: o efeito dispararia
  uma segunda
  consulta, e antes disso a primeira iria com o deslocamento velho. Numa lista
  com `usePolling` a guarda de ordem é um **contador por chamada**, e não a flag
  `active`, porque o poll roda fora do cleanup do efeito; e quem já busca na
  montagem passa `{ immediate: false }`, para a mesma consulta não sair duas
  vezes (o "pular" é variável do ciclo, não um `useRef`, senão o `StrictMode`
  gastaria o ref na primeira montagem). Total que encolhe sozinho — "Online
  agora", em que as sessões acabam — recua para a última página que existe
  (`lastPageOffset`), em vez de deixar o rodapé em "51–40 de 40" com o poll
  reenviando o mesmo `offset` para sempre.
- **A lista de Skills é a única que acumula páginas** em vez de trocar de página
  (`033`): `listSkills` do banco faz `clamp(limit, 1, 100)` e os filtros "sem
  vínculo", "no site" e "desligadas", mais a ordenação por nome, são peneira no
  cliente — sobre uma página só, qualquer um deles daria resposta errada. Por isso
  o botão pede a próxima página a partir de `items.length` (e não de um múltiplo de
  100, senão a remoção otimista faria o servidor pular uma skill), o resultado é
  concatenado com dedupe por `uuid`, e o cabeçalho diz de qual universo cada número
  fala enquanto `total > items.length`. O menu Filtro é o único que **não** zera o
  `offset`: zerar jogaria fora as páginas que ele precisa olhar. Mover esses três
  filtros para o banco é o que permitiria trocar isto por paginação de verdade.

## Catálogos

Desenho em [`11-catalogos.md`](11-catalogos.md). O que ficou de
implementação:

- **Um só alvo de aresta no canvas.** Skill e catálogo viram um `Target =
  { kind, slug }`; `pending`, `busy`, a seleção da gaveta, o id da aresta
  (`edge:<kind>:<porta>:<slug>`) e o id do nó (`skill:` / `catalog:`)
  carregam o `kind`, e só `runLink`/`runUnlink` escolhem o `PUT`. O nó de
  catálogo reaproveita a moldura e os três handles do nó de skill
  (`.node-skill.node-catalog`), com o número em destaque à direita.
- **As portas do servidor contam arestas, não vínculos diretos.** No palco
  `counts` soma skills e catálogos por porta; `toolCount` &co. do resumo
  continuam sendo só vínculos diretos, e é isso que o card e o mcp-admin
  mostram — o `catalogCount` fica ao lado.
- **`catalogPositions` no mesmo `PUT /canvas`.** A fila de posições tem dois
  mapas; o `relayout` grava skills e catálogos de uma vez.
- **"Publicada em" mostra o indireto e ainda deixa publicar direto.** Um
  vMCP alcançado só por catálogo aparece com "via catálogo X"; quem
  administra o vMCP vê as caixas com as portas do catálogo e "Publicar" cria
  o vínculo direto, que passa a valer sozinho. "Tirar" só existe para vínculo
  direto — o catálogo se edita na página dele.
- **`noSite` e `McpChips` olham `isActive`.** Uma skill desligada nunca
  está "no site", por mais vínculos que tenha; o selo "desligada" entra na
  frente dos demais.
- **A rota declarativa `PUT /api/mcps/:slug/catalogs` confere cada catálogo
  que entra** (`view`, e só os que ainda não estão vinculados). Quem **sai**
  não é conferido: desde o `12`, desvincular é ação do `edit` do vMCP — tirar
  da lista é mexer no servidor, não no catálogo. Era `loadManaged` nos dois
  lados, com a justificativa "tirar um catálogo alheio é mexer nele".
- **O mcp-public não mudou.** Toda a precedência mora em `@purple-skills/db`
  (`visibilityClause`, `listPublishedSkills`, `incrementViewCount`); o
  servidor continua chamando as mesmas funções com o mesmo recorte.

## Acesso granular

Desenho em [`12-acesso-granular.md`](12-acesso-granular.md). O que a
implementação decidiu além dele:

- **`viewer` em vez de `visibility`.** As leituras de `@purple-skills/db`
  ganharam `viewer: { role, userUuid }`; `visibility: 'all'` continua
  existindo para o token global e o bootstrap (admin sem conta) e `'open'`
  para o site, agora ampliada pelas duas regras de "público". Cada linha
  devolve `access`, calculado no SQL, e o app só compara níveis
  (`assertAccess`).
- **Escritas devolvem o objeto sem conhecer o leitor.** Uma escrita não
  recebe `viewer`, então o detalhe que ela devolve traz `access: 'owner'`;
  os handlers reaplicam o `access` de quem chamou antes de responder, e
  escondem `grants` de quem não tem `manage` (`withGrants`). O detalhe da
  escrita é a **visão do admin inteira**, não só no `access` — e três respostas o
  repassavam além do que o `GET` do mesmo objeto mostra (relatórios 009 e 010 da
  auditoria de 2026-09-19):
  - `PUT`/`DELETE /api/skills/:slug/mcps/:mcp` devolviam a ficha sem recorte
    nenhum — ACL, servidor fechado e catálogo privado de terceiros — a quem só
    tem `edit` em **algum** vMCP e `view` na skill. Agora releem a skill com o
    `viewer` da sessão (`skillSeenBy`, em `mcps.ts`). Desfazer o vínculo pode
    tirar a skill do alcance de quem chamou: a resposta é `200 { "unlinked":
    true }`, não 404. E o `DELETE` responde "não está vinculada" pelo que já leu
    do vMCP, sem ir ao banco, que distinguia "skill não encontrada" — quem edita
    um servidor qualquer confirmaria slug de skill privada alheia;
  - o `PATCH` da skill e as escritas de catálogo reaproveitam da **leitura
    prévia** as listas que a escrita não muda: `mcps` e `catalogs` na skill,
    `mcps` no catálogo (`seenBy`). O banco recorta essas listas por `viewer` na
    leitura; `mcpCount` e `skillCount` do catálogo seguem globais, de propósito,
    e a ficha diz "e mais N que você não vê";
  - no mcp-admin as escritas respondem com texto, e `link_skill`/`unlink_skill`
    montam o delas da releitura com `viewer`: nomeavam todo servidor em que a
    skill continuava e davam a contagem global.
- **Nenhuma conta sai do painel pelo `uuid`** (relatório 011 da mesma auditoria).
  O `uuid` é o `sub` do cookie de sessão; a busca de contas já não o entregava
  (item "a conta é o e-mail", abaixo), mas ele continuava ao lado do e-mail em
  toda ficha e lista: `ownerUserUuid`, os dois uuids de cada concessão, o dono
  dos contêineres aninhados, quem emitiu cada chave `psv_` e quem leu, na guia
  Auditoria. Na borda da REST, `ownerByEmail`/`grantByEmail` (em `access.ts`,
  aplicados por `withGrants` a toda ficha) fazem o campo sair como **apelido do
  e-mail**, como o `uuid` da busca; o que não tem e-mail ao lado sai omitido
  (`mcps[].ownerUserUuid` do catálogo, `catalogs[].ownerUserUuid` do vMCP) ou
  nulo (`createdByUserUuid` de chave alheia). Vale para toda sessão, admin
  inclusive — quem precisa do uuid de verdade tem `/api/users`, a trilha e a
  ficha da conta, que são de admin. A **entrada** `ownerUserUuid` do `PATCH`
  continua aceitando e-mail ou uuid. O campo sai do tipo compartilhado junto com
  o `uuid` do `UserLookup`: é o mesmo pendente.
- **Revogar procura a conta na lista de concessões, não em `users`** (relatório
  039 da mesma auditoria). Os seis `unshare*` resolviam o e-mail por
  `accountByEmail`, que exige conta ativa — certo para conceder e transferir,
  errado para revogar: a concessão de quem foi desativado depois de recebê-la não
  saía por superfície nenhuma, contra a decisão 10 do `12`, e voltava a valer se
  a conta fosse reativada. `grantOf` acha a linha pelo e-mail na lista que o
  `manage` já lê e entrega o uuid a `remove*Grant`, que nunca olhou `is_active`.
  Pela lista, e não por um `accountByEmail` sem a conferência, porque a resposta
  de quem consulta `users` distinguiria "não existe conta com este e-mail" de
  "existe, e não tem concessão aqui" — inclusive para conta desativada, que a
  busca de contas não revela (decisão 13). `Grant.isActive` marca a linha no
  painel ("conta desativada") e nas três tools de leitura do mcp-admin. Mudar o
  **nível** de concessão de conta desativada continua recusado nas duas camadas:
  é a mesma chamada de conceder.
- **404 para quem não vê, 403 para quem vê pouco.** Um objeto fora do
  escopo da conta não existe para ela (a consulta devolve nulo); um objeto
  visível com nível insuficiente responde 403 dizendo o nível que a conta
  tem e o exigido.
- **Upload confere o nível antes do multer** (`requireSkillAccess`), para
  não ler um `.zip` que seria recusado.
- **Sessões de um vMCP são `manage`**, como as chaves: a lista traz IPs e
  nomes de chave. O contador do globo é `view`.
- **Desvincular um catálogo de um vMCP** exige só `edit` no vMCP: tirar da
  lista é mexer no servidor, não no catálogo. Vincular exige também `view`
  no catálogo, como no doc.
- **Deixar um objeto sem dono** (`ownerUserUuid: null`) continua sendo só de
  admin: um dono comum não pode abandonar o objeto num estado em que só o
  admin o alcança. Transferir para outra conta é do dono e do admin.
- **`canWrite` ficou como alias de `canCreate`** em `shared`, marcado
  `@deprecated`, e `canManageVirtualMcp`/`canManageCatalog` como atalhos de
  `accessLevel` + `canOwn`; `canDelete` saiu.
- **O selo de origem** do painel (`AccessBadge`) some para admin: ele é dono
  de tudo e o selo não diria nada.
- **No painel, a conta é o e-mail** (`025`). Em toda a guia Acesso é o e-mail que
  identifica a pessoa: chave do rascunho de concessão, conjunto de exclusão da
  busca, comparação de dono e corpo do `ownerUserUuid` (que passou a aceitar
  e-mail). Quem recorta o payload é `withoutUuid`, em `apps/admin/src/access.ts` —
  o `lookupUsers` do banco continua trazendo a coluna, e é a camada do app que a
  troca pelo e-mail. O campo `uuid` continua no JSON como **apelido do e-mail**
  porque o painel ainda o lê em quatro lugares (`UserPicker`, o `exclude` da
  busca, a comparação com `ownerUserUuid` e o `ownerUserUuid` que o Salvar envia);
  tirá-lo antes do painel faria a transferência de dono virar um `PATCH` sem a
  chave — sucesso sem transferir. Quando o painel passar a ler `email`, o apelido
  sai do tipo, do `withoutUuid` e da projeção do banco, nessa ordem. Comparar um
  com o outro era o que fazia a busca não esconder ninguém. O "você" ao lado do
  dono, que comparava `ownerUserUuid` com o `uuid` da **sessão**, também passou a
  ser pelo e-mail (`ownedBy`, em `AccessPanel.tsx`) — o campo virou apelido do
  e-mail no item "Nenhuma conta sai do painel pelo `uuid`", acima, e tinha de
  mudar no mesmo passo, ou o rótulo sumiria.
- **`Stats` tem três campos obrigatórios e seis opcionais** (`024`): como
  `/api/stats` recorta por viewer, o tipo do painel traz `totalSkills`,
  `openSkills` e `totalTags` sempre e o resto talvez. Quem lê trata a ausência:
  campo que falta **não é zero** — o aviso ou a contagem somem da tela.

## Fichas, colmeia e registro de acessos

Desenho em [`13-fichas-e-acessos.md`](13-fichas-e-acessos.md). O que a
implementação decidiu além dele:

- **Um `recordSkillAccess` no lugar dos dois incrementos.** Os apps chamam
  `recordSkillAccess(input)`, que grava a linha e soma os contadores pela
  mesma regra de caminho de antes; `incrementViewCount`/`incrementDownloadCount`
  continuam exportados por compatibilidade, sem chamadores no repositório.
  Para `origin: 'mcp-admin'` a linha entra e os contadores **não** mudam: o
  `get_skill` do mcp-admin nunca contou.
- **Disparo sem `await`.** O registro é `Promise.resolve().then(() =>
  recordSkillAccess(…)).catch(log)`: o mock dos testes pode devolver
  `undefined`, e uma falha síncrona cai no mesmo `catch`. As respostas do
  site e do MCP não esperam o INSERT.
- **O contexto do MCP público viaja no escopo** (`VirtualScope.access`):
  credencial, IP e agente vêm da requisição que criou o servidor; o
  `clientInfo` e o id da sessão do transporte são getters ligados ao
  `McpServer` em `server.ts`, porque só existem depois do `initialize`. No
  stateless, o id é a chave sintética das sessões. Os downloads (`.zip` e
  SKILL.md avulso) montam o contexto da própria requisição.
- **O mcp-admin registra pela chave `psk_`** e ignora o token global: `Caller`
  ganhou `apiKeyId`, `ip` e `userAgent`, preenchidos em `resolveCaller`.
- **O painel não registra** nem ao abrir a ficha nem ao baixar o `.zip`, como
  já não contava.
- **`SkillMcpsPanel` e `AccessPanel` ganharam `readOnly`**, em vez de um
  segundo componente: a ficha de leitura mostra as mesmas tabelas sem
  nenhum controle. `SkillMetaForm` ganhou `hideDescription` e `disabled`,
  porque a descrição mora na guia Skill.
- **"Público" saiu do formulário da skill.** Em Editar ele só existe na seção
  Acesso. ~~Gravado na hora~~: desde a decisão 24 ele é **pendência do
  Salvar**, que o envia junto do formulário (`isPublic` na chamada de
  `updateSkill` em `SkillEditorPage.tsx`) — o Salvar do cabeçalho grava
  descrição, SKILL.md, metadados, "ligada" **e a visibilidade**.
- **O botão Editar da skill** consulta `GET /api/mcps` para saber se a conta
  edita algum servidor — é o mesmo pedido que "Publicada em" já fazia em
  edição, feito uma vez na leitura.
- **`preview` sobe de 8 para 19** e a listagem de vMCPs ganha
  `previewCatalogs`; o fixture do `import.test.ts` acompanha.
- **A ficha de conta reusa o que existe.** `GET /api/users/:uuid` é
  `getUserByUuid` + `toPublicUser`; as chaves vêm de `listApiKeys`; revogar
  pela ficha usa `revokeApiKey(id, uuidDaConta)` — o escopo pelo dono
  garante que o id é daquela conta — e audita `key.revoke` com
  ~~`"<e-mail>: <id>"`~~ `"<e-mail do dono>: <nome> (<prefixo>)"`. **Era** o
  uuid da chave até o relatório 040 da auditoria de 2026-09-19: ele não aparece
  em tela nenhuma, então a linha não se casava com a do `key.create`, que rotula
  `"<nome> (<prefixo>)"`. `revokeApiKey` passou a devolver `{ name, prefix,
  userUuid, userEmail }` (ou `null`) do próprio `UPDATE`, sem leitura a mais, e
  "as minhas chaves" (`DELETE /api/me/keys/:id`), que gravava o uuid pelado, usa
  o mesmo rótulo. Linha antiga da trilha não é reescrita: continua com o uuid.
  A guia Acessos é `listSkillAccesses({ userUuid })`
  (migration `019`, índice `(user_uuid, created_at DESC)`); a guia
  Atividade é `GET /api/audit?actor=`. `ROLES` e `ROLE_HINT` foram para o
  `api.ts` do painel, porque três telas os usam.

## A guia Arquivos do editor de skill

Desenho em [`13-fichas-e-acessos.md`](13-fichas-e-acessos.md), decisões 17
a 20. O que a implementação decidiu além dele:

- **O estado mora na página, num hook.** `useSkillFiles` (painel) guarda o
  arquivo aberto, a pasta escolhida, o que está recolhido, as pastas novas,
  os rascunhos (`FileDoc`, com o conteúdo gravado ao lado do editado) e as
  gravações em curso. A rota do editor não desmonta entre guias, então nada
  disso se perde; trocar de skill na mesma rota zera tudo. As ações
  assíncronas leem o estado por um `ref`, para não agir sobre a renderização
  que as criou.
- **Operação de arquivo não recarrega a skill.** Criar, salvar, remover e
  enviar trocam só `skill.files` (`onFiles`); antes, cada uma chamava o
  `reload`, que repovoava o formulário e jogava fora a descrição, o SKILL.md
  e as propriedades ainda não salvos. Pelo mesmo motivo, "Publicada em" e
  "Acesso" (Propriedades) passaram a trocar só a skill. Recarrega tudo, com
  confirmação quando há algo pendente, só o envio de um `SKILL.md` na raiz —
  ele troca o corpo do prompt (~~e o `.zip`~~, **revogado neste ponto pelo
  [`15`](15-quarentena.md)**: não há mais `.zip` nesta tela).
- **`reload` não depende de `navigate`.** Com `BrowserRouter`, o `navigate`
  do React Router muda de identidade a cada troca de caminho; como o
  `reload` dependia dele, cada clique numa guia refazia o GET e repovoava o
  formulário. O editor guarda o `navigate` num `ref`. As outras fichas têm o
  mesmo padrão e ficaram como estavam.
- **`fileTree.ts` e `FileTypeIcon.tsx` continuam idênticos aos do site.** O
  que só o editor precisa — pastas novas na árvore, validação do nome,
  colisões de envio, contagem de linhas — mora em `explorer.ts`, com testes em
  `explorer.test.ts`. A validação usa a grafia das pastas que já existem:
  `References/x.md` vai para `references/`, em vez de criar uma pasta irmã
  que só difere na caixa (o banco compara o caminho inteiro sem diferenciar
  caixa, não pasta a pasta).
- **O arquivo aberto segue a grafia gravada.** Um envio com outra caixa
  renomeia a linha (é o upsert); o editor troca a seleção para o nome novo e
  relê o conteúdo. Um arquivo à vista sem conteúdo carregado é lido pela
  própria guia (`ensure`).
- **O editor é um `textarea`** com a numeração num `<pre>` ao lado, rolando
  junto; sem quebra automática, para cada número ser uma linha. Tab, Shift+Tab
  e a indentação do Enter escrevem por `document.execCommand('insertText')`,
  que preserva o desfazer do navegador (com `setRangeText` de reserva). Esc e
  depois Tab sai do campo. A roda sobre a numeração rola o texto.
- **O campo de nome pede o foco num `setTimeout`.** A paleta (Radix), ao
  fechar, devolve o foco a quem o tinha num `setTimeout` próprio; sem esperar
  por ela, o campo aberto por "Novo arquivo" na paleta perdia o cursor. Pelo
  mesmo motivo o campo não desiste no `blur`, e sim no clique fora (que cria o
  que estiver válido) e no Esc.
- **Criar é outra rota, não um cabeçalho.** `If-None-Match: *` no `PUT` seria
  o idioma HTTP, mas a falha dele é 412, e as recusas aqui são de naturezas
  diferentes (arquivo existente, prefixo que é arquivo, pasta) — o `POST` com
  409 e mensagem diz mais. O `createFile` do banco serializa as criações por
  skill com um advisory lock de transação, e não com `FOR UPDATE` na skill,
  que travava em deadlock contra um `setFile` concorrente (ver o README do
  banco).
- **O `SKILL.md` avulso agora perde o frontmatter** no envio de arquivos
  (`POST /api/skills/:slug/files`), como o `.zip` e o `PUT` já faziam — era a
  única escrita de conteúdo fora da regra da §3.5 das decisões.
- **Largura da árvore** em `localStorage`
  (`purple-skills-admin:files-tree-width`), 200 a 560 px, nunca mais que
  45 % da guia; a divisória aceita arrasto, setas (Shift para passos
  maiores), Home/End e duplo clique para voltar a 300 px.

## Guias Acesso, Auditoria e Catálogos; o Salvar da skill

Desenho em [`13-fichas-e-acessos.md`](13-fichas-e-acessos.md), decisões 21
a 24, e a adoção dos órfãos em
[`05-accounts-and-roles.md`](05-accounts-and-roles.md) §2.3. O que a
implementação decidiu além deles:

- **`AccessPanel` virou `AccessTab`**, com três modos em vez do `readOnly`:
  `read` (a ficha de leitura), `live` (catálogo e servidor — cada ação grava
  na hora, como antes) e `draft` (a edição da skill — cada ação só troca o
  rascunho). O arquivo continua `AccessPanel.tsx`, com `AccessBadge`,
  `accessSentence` e `UserPicker`. A busca do novo dono não exclui mais
  quem tem concessão: transferir para essa conta vale, e a concessão some.
- **Os rascunhos são dados puros** (`skillDrafts.ts`, com testes): cada um
  descreve o estado **desejado**; `planChanges` compara com a skill gravada
  e devolve as pendências na ordem de envio; `pruneDrafts` descarta o que
  já não muda nada. Depois do Salvar a página relê a skill e poda: o que foi
  gravado some sozinho, o que falhou continua — sem contabilidade de quais
  chamadas deram certo. Os rascunhos guardam o uuid da skill; trocar de
  skill na mesma rota os zera.
- **Releitura que falha não tira do editor** (relatório 049 da auditoria de
  2026-09-19). Só o **404** — a skill ficou fora de alcance: transferida, ou
  removida por outra pessoa — leva para a lista (`isNotFound`, em `api.ts`). Em
  401, 5xx e queda de rede a página **fica**, não poda nada (sem releitura não
  há como saber o que gravou, e não há contabilidade por chamada) e avisa que o
  que já foi gravado pode seguir listado como pendente; o Salvar seguinte
  reenvia, e os `DELETE` já aplicados voltam como 404 no aviso até a releitura
  limpar. Da resposta do `PATCH` só se aproveita o **slug novo** — as listas
  dela vêm na visibilidade `'all'`, sem recorte por quem lê. Arquivo que não
  grava conta como falha: o `save` do `useSkillFiles` devolve se o conteúdo
  chegou ao servidor, e um pedido feito com a gravação em curso recebe **a
  promessa** dela, em vez de um "não gravou" para um arquivo que gravou.
- **A ordem do Salvar evita o slug velho**: os arquivos vão primeiro (o
  editor de arquivos conhece o slug de antes), depois o formulário — que
  pode trocar o slug —, e as demais chamadas usam o slug devolvido. A
  visibilidade vai no mesmo `PATCH` do formulário quando ele também mudou.
- **Sem pendência, o Salvar relê** a skill, em vez de reenviar o
  formulário: todo `PATCH` toca `updated_at` e audita `update`, e um clique
  sem mudança não deve fingir uma alteração.
- **"Publicada em" mostra só os servidores que a sessão edita** (antes, os
  que ela via — um servidor aberto aparecia com caixas que o servidor
  recusaria). Vale também para o "Publicar em" da skill nova.
- **A guia Catálogos lê `GET /api/catalogs`** para saber estado, dono,
  servidores e se a sessão edita cada catálogo; "Adicionar" usa a página
  `pick-catalog` da paleta, com os não editáveis no `exclude`.
- **Adoção dos órfãos** (`adoptOrphans`, do dba): o painel chama no
  `bootstrapAdmin` (ator `bootstrap`) e depois de cada
  `registerSuccessfulLogin` — senha e os três caminhos do SSO — com a
  própria conta como ator, só para `role = admin`, em `try/catch`. Quem
  confere se a conta é a única admin ativa é o banco, numa transação com
  advisory lock. De carona, o dba corrigiu `updateSkill` e
  `updateSkillWithContent`, que regravavam o dono lido antes da transação e
  podiam desfazer uma adoção ou transferência concorrente.

## Site: skills e catálogos públicos

O site nasceu antes dos catálogos e chamava a lista de skills de "o catálogo".
Com o recurso Catálogos (`11`) e o flag público (`12`), os termos se
separaram:

- **Skills públicas** (`#skills`, antes `#catalogo`): as ligadas que estão
  marcadas públicas, em catálogo público ou em vMCP aberto — a visibilidade
  `'open'`. **Catálogos públicos** (`#catalogs`) vêm logo depois, e cada
  cartão leva à página `/catalogs/<slug>`. A seção, o atalho da nav, o botão
  do cabeçalho e o link do rodapé somem quando não há catálogo público
  (`usePublicCatalogs`, uma busca só para os quatro).
- **O que aparece foi tornado público**, e o site diz isso: selo verde
  (`--jade`) "Visão pública" no cabeçalho, "Skill pública" e "Catálogo
  público" nas páginas, contadores "skills públicas" / "catálogos públicos" e
  a frase de que os itens privados ficam no painel. O selo da skill não diz
  *por que* ela é pública: o site não recebe os catálogos da skill
  (`catalogs` só vem na visibilidade `'all'`).
- **Ritmo compacto.** Títulos de seção, espaços entre as partes, cartões e o
  mascote ficaram menores — por sobrescrita no `app.css`, porque `base.css`
  continua cópia da homepage, que usa os títulos grandes. As seções ganharam
  um fio entre si e `scroll-margin-top`, para o título não cair atrás da nav.
- **Voltar para `/#skills` ou `/#catalogs`** pula para a seção depois que
  ela existe e que a grade de skills sai do esqueleto (senão a troca empurra
  a seção para baixo), com `behavior: 'instant'` — o `smooth` global não anda
  com a aba oculta.
- **`SITE_TAGLINE`** passou a ter o padrão "Skills abertas para agentes de
  IA": o antigo "Catálogo aberto…" confundia com o recurso. Uma instalação com
  a variável preenchida continua mostrando o texto dela.
- O mascote do cabeçalho não sumia no celular: o `img.wiz` do `base.css`
  vencia o `display: none` da media query. A regra agora é
  `.masthead .masthead-fig`. Em tela larga ele é a figura da página e não
  encolhe abaixo de 300px (`clamp(120px, 25vw, 340px)`), o que cabe na altura
  do texto ao lado sem esticar o cabeçalho.
- **`useReveal` alcança o que nasce depois.** As partes que só existem quando
  a busca responde ficavam invisíveis para sempre se o componente esquecesse
  de reobservar — foi o que aconteceu com "Servidores MCP abertos", uma seção
  inteira ocupando espaço em branco entre os dois `mcp.json`. O hook agora
  mantém um `MutationObserver` no `body` e observa todo `.reveal` que chega ao
  DOM; o `deps` continua existindo para quando o React reescreve a `className`
  de um elemento já revelado.
- **O JSON do site é uma lista de permissão** (`002`), não o objeto do banco
  espalhado: `skillPublica`/`detalhePublico` em `apps/site/src/api.ts` nomeiam o
  que sai, e campo novo em `SkillSummary` nasce **fora** do site até alguém
  decidir o contrário. Ficam de fora o dono (`ownerUserUuid`/`ownerEmail`), as
  concessões, o estado interno (`isActive`/`isPublic`/`access`), o `catalogs` da
  skill e, dentro de cada vMCP, `direct`/`catalogs` — que nomeia catálogo privado.
  O [`12`](12-acesso-granular.md) §10 aceita e-mail exposto a **conta logada**
  ("instalação de colaboradores"); o visitante anônimo não está nessa aceitação, e
  o `ownerUserUuid` é ainda o `sub` do cookie do painel. O `icon` ficou na lista
  embora o front ainda não o use: é metadado público como nome e descrição.
- **O `/api/meta` devolve `mcp: { status, slug, name, requiresKey }` — sem
  `description`** (`050`). `resolveDefaultVirtualMcp` não filtra visibilidade (o
  padrão fechado responde em `/mcp` com chave), então tudo o que sai por essa rota
  sai para o anônimo; slug e nome são os campos que o `GET /` do mcp-public já
  publica ([`09`](09-mcp-padrao-e-skills-flutuantes.md) §3.2), a descrição não é.
- **O `/api/meta` leva `corsOpen`, e só o booleano** (relatório 078 da auditoria
  de 2026-09-19). O cartão "API REST
  pública" da home dizia "CORS aberto" como literal fixo, e `SITE_CORS_ORIGIN`
  fecha exatamente isso; agora o rótulo vem da instalação ("CORS aberto" ou
  "CORS restrito"). Pelo critério de cima o booleano pode sair: qualquer cliente
  que mande um `Origin` já o lê no `Access-Control-Allow-Origin` da resposta. A
  **lista** de origens não sai — ela nomeia a intranet de quem fechou. O valor
  mora no `config.ts` do site (`corsOrigin`), lido pelo `cors()` e pela rota.
- **A regra "o que está no site" vive copiada em três lugares** (`050`) — `noSite`
  (`apps/mcp-public/src/tools.ts`), `pageUrl` (`apps/mcp-admin/src/tools.ts`) e
  `noSite` (`apps/admin/web/src/components/ui.tsx`). As duas primeiras cobrem
  `is_public` e o vínculo aberto; **nenhuma** cobre catálogo público, porque não há
  sinal no recorte. Um `onSite` derivado de `OPEN_EXPOSURE` no `skillColumns`
  apagaria as três.
- **O arquivo de skill desce com `Cache-Control: private, max-age=60`** (`045`); o
  equivalente no mcp-public usa `no-store`. Em nenhum dos dois um cache
  compartilhado pode sobreviver a uma despublicação.
- **Os três hooks de dados da home usam o mesmo par `cache` + `inFlight`**
  (`useMeta`, `useSkillsSummary`, `usePublicCatalogs`) (`051`): o `cache` só existe
  depois da resposta, e a home monta seis consumidores de metadados no mesmo
  commit — sem a promessa em voo, seriam seis `GET /api/meta`. O `inFlight` é
  zerado no `catch`, senão uma falha de rede na primeira carga congelaria a busca
  pelo resto da sessão.

## Clonagem

O desenho e o porquê de cada escolha estão em
[`16-clonagem.md`](16-clonagem.md). Aqui só o que é desvio ou consequência de
implementação.

- **A chave `psv_` não é "decidido não copiar": ela não tem como ser
  copiada.** O banco guarda o `prefix` (público) e o **hash scrypt** do
  segredo, nunca o segredo (`database/schema/009-mcp-virtual.sql`), e o
  `prefix` é `UNIQUE` global. Duplicar a linha daria um par de valores que
  ninguém consegue apresentar numa requisição — o texto completo só existiu
  uma vez, na emissão — e ainda gastaria um prefixo. A decisão 8 do
  [`16`](16-clonagem.md) registra a escolha; o que o código faz é simplesmente
  não ter de onde tirar o dado. Vale o mesmo raciocínio para `psk_` e `psp_`,
  que nem entram no escopo.
- **Os arquivos da skill são copiados dentro do banco**, e não lidos pelo app
  para serem gravados de volta. É o desvio em relação à importação, que
  materializa bytes em memória porque eles chegam de fora: aqui os dois lados
  já estão no Postgres, e passar um `.zip` de 200 MB pelo processo do painel
  seria pagar memória por nada. A cópia inteira — objeto, filhos e a linha de
  auditoria — é **uma transação**, como a promoção da quarentena.
- **O `layout` do vMCP tem de ser copiado no banco pelo mesmo motivo, e por
  mais um**: o que a leitura devolve é um **recorte** do JSONB (só as chaves
  que o canvas usa), então serializar o objeto lido de volta apagaria em
  silêncio o que a leitura ignora. `INSERT … SELECT` copia a coluna inteira.
- **Na cópia das concessões do vMCP, a comparação é `IS DISTINCT FROM`, não
  `<>`.** A concessão de quem clonou não é copiada — ela seria uma concessão
  ao dono, que o [`12`](12-acesso-granular.md) recusa como redundante —, mas
  o clone feito pelo `MCP_ADMIN_TOKEN` ou pela sessão de bootstrap nasce
  **órfão**, e com o dono nulo um `user_uuid <> NULL` é nulo em **toda** linha:
  nenhuma concessão seria copiada, e o clone órfão sairia com ACL vazia.
- **`search_vector` não é copiado, é reconstruído — e a ordem do INSERT
  importa.** `skills_build_search_vector` lê o corpo do `SKILL.md` **pela
  `uuid`** (`database/schema/001-init.sql`), então o trigger `BEFORE INSERT`
  da linha de `skills` roda quando ainda não há arquivo nenhum e produz um
  vetor só com nome e descrição. Quem o completa é o
  `files_reindex_skill_tg`, que dispara ao inserir o `SKILL.md` em `files` e
  reescreve o vetor com o corpo (é o conserto da migration `002`). Nada a
  fazer no app — mas quem for medir a cópia logo depois do `INSERT` de
  `skills`, e antes do dos arquivos, encontra um vetor incompleto, e isso não
  é defeito.
- **O painel só manda o campo `slug` quando a pessoa o edita.** É o que faz o
  caminho comum nunca dar 409: sem `slug` no corpo, a rota cai no caminho
  **derivado** de `uniqueSlug`, que desempata sozinho; com `slug`, cai no
  caminho **pedido**, que é o que responde 409 ao colidir — a mesma assimetria
  que `resolveSlug` (`database/src/queries.ts`) já implementa na criação de
  skill. Mandar sempre o slug preenchido transformaria duas clonagens
  simultâneas do mesmo objeto num conflito visível ao operador.
- **O `name:` do frontmatter da cópia não precisa de migração de conteúdo.**
  O que está em `files` é só o corpo; o frontmatter é remontado na leitura por
  `composeSkillMd` (`packages/shared/src/frontmatter.ts`), então o slug novo
  aparece sozinho no download, na leitura crua e nas tools.

## Painel: atividade

O desenho e o porquê de cada escolha estão em
[`18-atividade.md`](18-atividade.md). Aqui só o que é desvio ou armadilha de
implementação.

- **O `AT TIME ZONE` vem depois do filtro por instante, nunca dentro dele.** A
  série da grade filtra a coluna crua — `created_at >= $since AND created_at <=
  $until`, `started_at` nas sessões — e só então converte para agrupar:
  `(created_at AT TIME ZONE $tz)::date` no `GROUP BY`. Escrever a conversão no
  `WHERE` é o caminho natural e mata o índice: a coluna vira expressão, o
  planejador larga `skill_accesses_created_idx` e `audit_log_created_at_idx` e
  varre a tabela inteira — três tabelas que, por decisão, **nunca são podadas**.
  E não há índice de expressão que salve: o fuso é parâmetro de quem está
  olhando, e um índice teria de congelar um fuso só.
- **`mcp_sessions` não tinha índice por `started_at`.** Os da `015` olham
  `last_seen_at` (a pergunta de "online", inclusive a parcial de sessão
  aberta), a sessão aberta por id e a chave — porque até agora ninguém tinha
  perguntado "quantas sessões **começaram** neste dia". A `032` acrescenta
  **dois**: `mcp_sessions_started_at_idx`, para a série, e
  `mcp_sessions_ended_at_idx`, para o relatório do dia, que conta as sessões
  **encerradas** nele e as quebra por motivo — uma sessão pode ter começado
  ontem. `skill_accesses` e `audit_log` já tinham o seu por data.
- **O despejo dos contadores grava em ordem fixa, e o `ORDER BY` faz parte da
  correção.** O `ON CONFLICT DO UPDATE` trava as linhas de `mcp_call_counters`
  na ordem em que elas saem do `VALUES`, e o rastreador despeja todas as
  sessões num `Promise.all`: duas sessões do mesmo vMCP, transporte e balde
  trazem os mesmos métodos em ordens diferentes, travam em cruz e uma morre por
  `40P01` — e o "melhor esforço" da gravação engole o erro **depois** de a
  colheita já ter esvaziado o mapa, então as chamadas somem em silêncio.
  Ordenar o array em JavaScript não basta: o plano é um join com `virtual_mcps`
  e o que sai de um join não tem ordem prometida, então o SELECT leva
  `ORDER BY` por uma posição materializada. Medido: 6 sessões no mesmo servidor
  perdiam 41,1 % das chamadas; ordenadas, nenhuma. É a lição de `replaceTagsTx`
  numa tabela nova.
- **O fuso viaja como `tz` na query string e como `timezone` no corpo.** As
  duas rotas leem `tz` (`fusoDe(query.tz)`); quem escrever `?timezone=` não
  recebe erro nenhum — o parâmetro não é enxergado e o recorte cai no padrão
  `UTC`, que é uma série certa para um fuso que ninguém pediu. O nome curto é a
  regra da query string daqui; `timezone` é o campo da função do banco
  (`listActivityDays`) e o do corpo da resposta, e é essa diferença de nome que
  o `docs/18` `§10` já tinha errado uma vez.
- **Os tipos de atividade entram no painel como cópia manual, e o espelho é um
  teste.** `apps/admin/web/src/api.ts` não importa `@purple-skills/shared` (é
  bundle de navegador), então `ActivityDay`, `ActivitySeries`, `ActivitySlice`
  e `ActivityReport` são copiados à mão, como todos os outros. Para a lista de
  famílias isso não basta: ela é **valor**, não só tipo, e um valor copiado
  envelhece em silêncio — o teste que compara a cópia do painel com o
  `MCP_CALL_FAMILIES` do shared é o mesmo padrão de `audit.test.ts` (os testes,
  ao contrário do bundle, importam o pacote). Família nova sem rótulo no painel
  é uma fatia sem nome na tela, não um erro de compilação.
- **"Atividade" já era o nome de outra coisa.** A ficha da conta tem a guia
  Atividade em `/users/:uuid/activity` (e `/edit/activity`), que é a trilha
  filtrada pelo e-mail (`ActorTrail`, `GET /api/audit?actor=`) — "o que esta
  conta fez". A tela nova é `/activity`, `GET /api/activity`, e é "o que
  aconteceu na instalação". O roteador não se confunde (uma é aninhada em
  `/users/:uuid/`), mas o rótulo, a conversa e os dois endereços vizinhos sim:
  ao mexer num, confira se o texto fala do outro. Renomear a guia da conta não
  entrou no escopo do [`18`](18-atividade.md).

## Endereços em inglês

Os **endereços** — caminho e query string — são em inglês em todas as
superfícies: painel, site, homepage, MCP público e MCP administrativo. As
mensagens, os rótulos, os comentários e a documentação continuam em português
(`AGENTS.md`); o que mudou é só a URL, que é interface de máquina e já era
inglês no `/api/…` e nos transportes MCP (`/mcp`, `/sse`, `/messages`,
`/virtual/<slug>/mcp`). O painel era a exceção: o SPA tinha `/catalogos`,
`/auditoria`, `/configuracoes/mcp-padrao`, e uma guia `/editar/propriedades`
convivia com um `/api/skills/:slug/files` do outro lado da mesma tela.

O que mudou de nome — **não há redirecionamento do endereço antigo**, então
favorito e link de fora apontando para os de baixo caem na rota `*`, que leva a
`/mcps` (no site, à página de 404):

| Antes | Agora |
|-------|-------|
| `/catalogos` | `/catalogs` |
| `/auditoria`, `/auditoria/sessoes` | `/audit`, `/audit/sessions` |
| `/quarentena` | `/quarantine` |
| `/nova-skill` | `/new-skill` |
| `/meu-espaco` | `/my-space` |
| `/configuracoes` | `/settings` |
| `/configuracoes/mcp-padrao`, `…/busca-semantica`, `…/ambiente`, `…/conectar` | `/settings/default-mcp`, `…/semantic-search`, `…/environment`, `…/connect` |
| `/account/chaves-adm`, `/account/chaves-emitidas` | `/account/admin-keys`, `/account/issued-keys` |
| guias `…/arquivos`, `…/catalogos`, `…/propriedades`, `…/acesso`, `…/auditoria` | `…/files`, `…/catalogs`, `…/properties`, `…/access`, `…/audit` |
| guias `…/chaves`, `…/acessos`, `…/atividade`, `…/sessoes` | `…/keys`, `…/accesses`, `…/activity`, `…/sessions` |
| `…/editar` | `…/edit` |
| `?novo=1`, `?modo=zip`, `&destino=quarentena` | `?new=1`, `?mode=zip`, `&destination=quarantine` |
| `?filtro=todas`, `?acesso=todos` | `?filter=all`, `?access=all` |
| site: `/catalogos/<slug>`, âncora `#catalogos`, `#comecar` | `/catalogs/<slug>`, `#catalogs`, `#get-started` |
| homepage: `#como-funciona`, `#pecas`, `#servicos`, `#recursos`, `#comecar` | `#how-it-works`, `#pieces`, `#services`, `#features`, `#get-started` |

Os identificadores de guia no código (`key`, o `Tab` de cada página, o `case`
da trilha em `Layout.tsx`) acompanharam o endereço porque **são** a cauda dele:
a página deriva a guia de `location.pathname`, e um `key` em português com o
caminho em inglês daria guia nenhuma selecionada. Os rótulos visíveis e os
`keywords` da paleta de comandos ficaram como estavam — é o que a pessoa lê e
digita, e continua em português.

Duas coisas de propósito **não** mudaram: o redirecionamento legado
`…/accesses → …/audit` (a guia se chamava Acessos, decisão 22 do
[`13`](13-fichas-e-acessos.md)) segue existindo, agora com o nome em inglês; e
`/skills/new`, que é a ficha da skill de slug `new` e, sem ela, leva ao
formulário (hoje `/new-skill`) — o desempate do `routes.ts` não foi tocado.

## Portas

| Serviço | Porta |
|---------|-------|
| site | 3000 |
| admin | 3001 |
| mcp-public | 3002 |
| mcp-admin | 3003 |
| homepage | 3004 |

O `BIND_ADDR` governa o endereço de publicação do site, do painel, dos dois MCPs e
da homepage. Duas portas **não** o acompanham. A do Postgres tem
`POSTGRES_BIND_ADDR`, padrão `127.0.0.1`, em `database/docker-compose.yml`: nenhum
app a usa — todos falam com o banco pela rede interna — e ela saiu do `BIND_ADDR`
na `beta.22`, então `BIND_ADDR=0.0.0.0` sozinho **não** publica o banco. E a do
`mcp-inspector`, que tem `INSPECTOR_BIND_ADDR` com padrão `127.0.0.1` (`012`): o
inspector sobe com `DANGEROUSLY_OMIT_AUTH` e, de dentro da rede `internal`,
alcança o `mcp-admin` —
uma porta publicada nele equivale a acesso administrativo sem credencial. Expor a
UI exige as duas metades juntas (`INSPECTOR_BIND_ADDR` fora do loopback **e**
`INSPECTOR_OMIT_AUTH=false` com `INSPECTOR_API_TOKEN`, cujo nome antigo era
`MCP_PROXY_AUTH_TOKEN`); o override do Traefik despublica a porta dele como faz com
os demais serviços, sem lhe dar rótulo de roteamento.

O inspector usa **6274 dos dois lados** do mapeamento — é a porta que a imagem
expõe e a que o healthcheck dela consulta (`CLIENT_PORT || 6274`) —, e
`INSPECTOR_PORT` remapeia só o lado do host (`039`). `ALLOWED_ORIGINS` acompanha
essa variável, porque a lista **substitui** a padrão do inspector e a origem que o
navegador manda é a do host. Essa chave precisa de **valor**: uma chave de
`environment` sem valor é resolvida do ambiente do host e, ausente ali, não chega
ao container — foi o que fez de `INSPECTOR_ALLOWED_ORIGINS` variável morta.

Ao lado das portas, o **teto de memória dos containers** (`010`):
`mem_limit`/`memswap_limit` no `x-app-common` (`APP_MEM_LIMIT`, 1,5 GB) e na
`homepage` (`HOMEPAGE_MEM_LIMIT`, 256 MB). Duas razões fixam o valor: (a) o import
guarda ao mesmo tempo o `.zip` recebido, os bytes descomprimidos e a segunda cópia
deles (~2 × o teto descomprimido — ver
[Armazenamento de arquivos](#armazenamento-de-arquivos)), então quem aumenta
`ZIP_MAX_UNCOMPRESSED_BYTES` tem de aumentar `APP_MEM_LIMIT` na mesma conta; e (b)
o limite é declarado nos **campos de serviço**, nunca em `deploy.resources.limits`,
que fora do Swarm é ignorado em silêncio e deixaria o arquivo "válido" sem limite
nenhum.

## `APP_VERSION`

A versão chega à imagem por `--build-arg APP_VERSION`, só nos três Dockerfiles que
declaram o `ARG` (admin, mcp-public, mcp-admin), e o par `ARG`/`ENV` fica
**depois** dos `COPY` do runtime, para que trocar de versão não invalide as camadas
acima (`015`). Sob o compose da raiz esse `ENV` não vale: `x-app-env` manda
`APP_VERSION: ${APP_VERSION:-}` e o vazio sobrescreve o da imagem, porque
`readTextEnv` trata vazio como ausente e volta ao padrão compilado.

## Dockerfiles e `.dockerignore`

- **As listas de manifests copiadas antes do `npm ci` continuam diferentes entre
  os sete Dockerfiles, de propósito** (`053`). Copiar todos em todos é o terreno
  onde o `prepare` de workspace derrubou o `npm ci` no `020`; hoje nenhum workspace
  tem `prepare` e o `npm ci` tolera diretório de workspace ausente. Mexer no
  lockfile pede reconferir isso, e o teste é reproduzir o passo num esqueleto com
  exatamente os manifests que aquele Dockerfile copia.
- **Os padrões de `.env` do `.dockerignore` são recursivos** porque os Dockerfiles
  copiam diretórios de `apps/`: o padrão só de raiz protegia o contexto, não a
  imagem. O critério é o mesmo da guarda do CI — nome de arquivo começando por
  `.env`.

## O que foi verificado

- Testes unitários (Vitest, `npm test`) em `packages/shared` e nos handlers das
  duas famílias de ferramentas MCP, com o banco mockado.
- Verificação em runtime da ordem autenticação → parser nos servidores MCP:
  POST anônimo com corpo grande é recusado com 401 antes de o corpo ser lido, e
  corpo acima do teto responde 413 em JSON-RPC.
- Smoke test manual contra o stack em Docker: os **três transportes** (
  Streamable HTTP com sessão, stateless e SSE legado) nos **dois** servidores
  MCP, CRUD completo pelo MCP admin, propagação de visibilidade para o site,
  reindexação da busca por trigger, contadores, download `.zip` com binários
  preservados, autenticação do painel e do MCP admin.
- Testes de integração com Postgres real (`TEST_DATABASE_URL`, desligados por
  padrão) cobrindo `users`, `api_keys` e `reset_tokens`.
- **O `npm run typecheck` cobre os testes; o `build` continua sem eles.** Cada
  workspace tem um `tsconfig.typecheck.json` (`extends` do de build mais
  `"exclude": []`) e é ele que o script `typecheck` usa — o `tsconfig.json`
  segue excluindo `src/**/*.test.ts`, porque o `dist/` das imagens não leva
  teste. Sem essa separação, os arquivos de teste não passavam por `tsc`
  nenhum: o Vitest transpila sem checar tipo, e um erro de tipo em teste só
  aparecia quando alguém abria o arquivo. Ligar a conferência achou sete erros
  reais, dois deles em asserções que nunca foram verificadas por ficarem sobre
  um valor `unknown`. `"exclude": []` substitui o padrão do TypeScript
  (`node_modules`, `dist`) e só é seguro porque o `include` é estreito
  (`src/**/*.ts`); alargar o `include` quebra a premissa. O `mcp-public` é o
  único com `rootDir` alargado, porque o teste de integração da busca importa o
  indexador de outro workspace (relatório 073 da auditoria de 2026-09-19).
- Smoke test do frontmatter gerado contra um banco de testes: criar/salvar pelo
  painel e pela API com um bloco `---` colado no prompt (descartado nas duas
  pontas), `PUT` direto em `/files/SKILL.md`, importação de `.zip` no padrão
  Agent Skills (slug vindo do `name:`), troca de slug refletida no arquivo sem
  reescrever o corpo, e `Content-Length` do arquivo servido batendo com o
  documento montado.
- Smoke test do fluxo de contas contra o stack em Docker: bootstrap do primeiro
  admin, senha única ficando inerte depois dele, matriz de papéis nas rotas do
  painel, revogação por `token_version`, trava do login por tentativas, e chave
  `psk_` autenticando no MCP administrativo com o papel do dono.
- Smoke test do MCP virtual contra um Postgres descartável (migration `009`
  aplicada duas vezes; suíte de integração `virtual-mcps`): cliente MCP real
  em `/virtual/<slug>/mcp` com chave `psv_` (serverInfo sufixado, instruções
  com a descrição, `search_skills` só o vínculo com uma privada, `get_skill`
  da privada com download no próprio servidor, `.zip` e `SKILL.md` com e sem
  chave, `prompts/list` e `resources/list` obedecendo `as_prompt`/`as_resource`,
  401/404 conforme a `§4.5` de `08`, virtual aberto sem chave, principal sem a
  privada, SSE anunciando o endpoint com prefixo, contadores no vínculo e no
  global); a API do painel (`/api/mcps*`: papel para criar, ~~alcance por
  dono~~ — **Revogado neste ponto por [`12`](12-acesso-granular.md) §3.2**
  (relatório 083 da auditoria de 2026-09-19): o alcance é **por nível de
  acesso**, e o `load` de `apps/admin/src/mcps.ts` o exige por ação (`view` lê,
  `edit` mexe em vínculos, portas e posições, `manage` muda nome, slug, estado,
  abertura, chaves e concessões, `owner` apaga e transfere), com 404 para quem
  não vê —,
  `PUT` declarativo, ~~confirmação de abertura nos dois sentidos~~ (saiu no
  PR2 do `09`; o oposto está fixado em `apps/admin/src/mcps.test.ts`, "abrir
  um vMCP"), transferência
  de dono, chave emitida abrindo o virtual e revogada respondendo 401, selo na
  skill, rename, 409, delete, auditoria `mcp.*`); e as nove tools do
  mcp-admin com o token global.

## Armadilhas medidas na revisão de 2026-09-18

Os 53 relatórios de `tasks/` foram reverificados um por um nessa data. Cinco
aprendizados só aparecem no conjunto — nenhum relatório os tinha sozinho:

- **Não rode `prettier` neste repositório.** A regra está no
  [`AGENTS.md`](../AGENTS.md), entre as convenções gerais: não existe
  `.prettierrc`, e uma passada de `npx prettier --write` num arquivo de
  `database/` reformatou 842 linhas, que tiveram de ser restauradas à mão.
- **O `dist/` dos pacotes engana o typecheck por app.** Os apps resolvem
  `@purple-skills/shared`, `@purple-skills/rag` e `@purple-skills/db` pelo
  `dist/`, então mexer no `src/` de um pacote e rodar `tsc` de um app acusa erro
  fantasma — ou esconde erro real — até `npm run build:packages`. Vários agentes
  tropeçaram nisso na mesma rodada. O jeito de conferir sem recompilar (e sem
  atropelar quem estiver compilando em paralelo) é um tsconfig de **sobreposição**
  que aponte o pacote para o `src/`.
- **`SELECT … FOR UPDATE` em `skills` faz deadlock** com o trigger
  `files_rag_stale_trg` da migration `020`, disparado por quem grava arquivo
  (medido no `005`) — é por isso que `createFile` serializa com advisory lock de
  transação em vez de travar a linha da skill, e por isso as escritas de skill são
  um `UPDATE` parcial. E **`INSERT … WHERE NOT EXISTS` não fecha corrida** em
  READ COMMITTED: o predicado é avaliado no snapshot da transação e não há linha em
  que travar, então duas transações simultâneas passam as duas — precisa de
  `pg_advisory_xact_lock`, como `adoptOrphans` já faz (medido no `049`).
- **`LIKE` de prefixo não se reescreve como faixa** nesta instalação: na coleção do
  cluster (`en_US.utf8`, provedor libc) o hífen é ignorado no nível primário da
  comparação, e `slug >= 'x-' AND slug < 'x.'` devolveu **0 linhas** onde o `LIKE`
  devolveu 2 (medido no `049`). A equivalência só valeria com `COLLATE "C"`
  explícito, que por sua vez descarta o índice `UNIQUE` existente.
- **Escapar `%`/`_` no `ILIKE` sem índice de trigrama piora o pior caso** — 311 ms
  → 478 ms na busca de skills (medido no `036`): o padrão deixa de ser um curinga
  que falha rápido e passa a ser um literal de até 200 caracteres comparado linha a
  linha. As duas mudanças, escapar e indexar, são **uma só** e não devem ser
  separadas num rollback.

A rodada de **2026-09-19** (87 relatórios) acrescentou três, todas medidas em
banco descartável e em árvore de trabalho:

- **Escrita de arquivo de skill entra numa fila, e a fila é a primeira
  statement** (relatórios 022 e 023 da auditoria de 2026-09-19). Quem grava
  arquivo trava `files` e, no fim da mesma statement, pede a linha da skill pelo
  trigger `files_rag_stale_trg`; quem salva a skill com o `SKILL.md` — ou a
  apaga — faz o contrário. Medido antes do remédio: **cerca de 40 % dos pares
  concorrentes** morriam com `40P01` (59 em 150 pares de
  `updateSkillWithContent` × `setFile('SKILL.md')`, 45 com `setFiles`, 61 com
  `ownerUserUuid` no mesmo PATCH). Por isso **toda** transação que toca arquivo
  — `createFile`, `setFile`, `setFiles`, `deleteFile`, `deleteSkill` e o
  `updateSkillWithContent` que traz `skillMd` — começa pelo advisory lock de
  `lockSkillFilesTx`, **como primeira statement** e sem nenhum `db()` dentro. É
  a primeira statement que impede o ciclo: quem espera pela fila não segura
  linha nenhuma; tomá-la depois de um `UPDATE` ou de um `SELECT … FOR …` recria
  o deadlock que ela existe para evitar. Nada de `FOR UPDATE` em `skills`.
- **No recorte do vMCP a ordem é uma só: travar o servidor, mexer nos vínculos,
  gravar no servidor por último** (relatório 023 da auditoria de 2026-09-19). A
  trava é `SELECT … FOR NO KEY UPDATE` — `FOR UPDATE` barra o `FOR KEY SHARE`
  que todo INSERT em tabela filha pede pela FK, e era assim que
  `recordSkillAccess` morria contra o canvas (9 em 150 pares) e contra o recorte
  (26 em 150). O remédio "óbvio" — adiantar o `UPDATE virtual_mcps SET
  updated_at` para o começo de `linkTx` — zera os pares **e abre um ciclo
  novo**: a checagem de FK não espera um `FOR NO KEY UPDATE`, salvo quando segue
  a cadeia de versões da linha e esbarra numa versão ainda não commitada
  (`while rechecking updated tuple` no log do Postgres); aí o registro de acesso
  segura o vínculo e espera o vMCP, enquanto quem atualizou o vMCP espera o
  vínculo. Medido: **3 deadlocks em 34 mil operações** mistas, contra zero em
  57 982 com a ordem correta. Trava pura não cria versão nova da linha, então
  não há o que esperar — e, quando o `UPDATE` chega, a transação já tem todos os
  vínculos de que precisa. Vale igual para o `UPDATE … SET layout` de
  `setVirtualMcpCanvas`, que vai depois das posições.
- **Byte de controle literal num arquivo-fonte some do diff e da varredura de
  segredos** (relatório 063 da auditoria de 2026-09-19). Um `\x00` cru dentro de
  uma classe de regex fazia o `git diff` sair como "Binary files differ", o
  `git diff --numstat` devolver `-\t-\t` em vez de contar linhas e a varredura
  de segredos não enxergar o conteúdo do arquivo — o `gitleaks git` lê o
  histórico por diffs, e um segredo numa linha que o diff não mostra passa
  batido. E a armadilha que cria o byte é a ferramenta de edição dos agentes:
  ela converte o escape de U+0000 escrito dentro de uma string **de volta em
  byte literal**. Por isso a troca não se faz com ela — foi feita por script,
  que confere o arquivo de partida, exige a sequência exata o número certo de
  vezes e recusa deixar byte de controle para trás, com prova de equivalência ao
  lado (mesma linha depois de desfazer a troca, mesmas decisões da regex para os
  65 536 code units, mesmos literais no AST, mesmo JS transpilado). A forma
  certa depende de onde o caractere está: **constante montada em código**
  (`String.fromCharCode(0)`, como o `NUL` de `database/src/queries.ts`) é o
  padrão, porque é imune à ferramenta; o **escape** (`\x00`, `\x1f`, `\x7f`)
  fica para onde a constante não cabe, como uma faixa de regex
  (`[…\x00-\x1f\x7f]`).
  Três fontes foram consertados assim nesta rodada — `apps/admin/web/src/explorer.ts`
  (faixa de regex), `database/src/queries.ts` (dois U+0000 numa chave de
  deduplicação) e `packages/rag/src/chunk.test.ts` (um `0x01` num cabeçalho
  falso de executável) —, mais dois relatórios de `tasks/` que nasceram
  binários pelo mesmo motivo. **Não confie no git para achá-los:** a heurística
  dele procura o nulo só nos primeiros 8 000 bytes, e em `queries.ts` o primeiro
  estava no byte 274 217 — o arquivo sempre saiu como texto no diff. A guarda
  que entrou no `ci.yml` (passo "Nenhum byte de controle nos fontes", no job
  `secrets-scan`, **antes** do gitleaks) olha os **bytes** dos fontes
  versionados, com TAB, LF e CR de fora. O primeiro commit depois de consertar
  um arquivo que era binário ainda sai como "Binary files differ", porque o lado
  antigo é binário; confira pelos comandos (`grep -c '[[:cntrl:]]'`, `file`),
  não pelo diff.

## Username

O desenho e o porquê de cada escolha estão em
[`19-username.md`](19-username.md). Aqui só o que é desvio ou armadilha de
implementação.

- **A regra do username existe em dois lugares, e isso é deliberado — o terceiro
  é que não podia existir.** `packages/shared/src/username.ts` é a fonte; a
  migration `033` repete a derivação em SQL porque roda uma vez e some, antes de
  qualquer código deste pacote existir naquele banco. O que **não** podia
  aparecer era uma terceira cópia viva no navegador: o bundle do painel não
  importa `@purple-skills/shared` (a raiz reexporta módulos que falam com
  `node:fs` e `node:crypto`, e o comentário no topo de
  `apps/admin/web/src/api.ts` registra a regra), e a saída foi um **export por
  subpath** novo no `package.json` do `shared` — `@purple-skills/shared/username`.
  O módulo não importa nada, então entra no bundle sozinho, e é o único do
  pacote com export próprio. Se algum dia outro módulo folha precisar do mesmo,
  o precedente é este.
- **O mapa de acentos é uma tabela, não `String.normalize('NFD')`.** A tentação
  é usar NFD + remoção de combinantes no TypeScript, que é mais curto e mais
  correto. O problema é que a `033` precisa da **mesma** regra em SQL, e esta
  instalação não tem a extensão `unaccent` — lá é `translate()` com um par de
  cadeias. Duas implementações da mesma regra só ficam iguais se a regra for uma
  tabela; NFD de um lado e `translate()` do outro divergiriam em silêncio no
  primeiro nome acentuado, e o backfill produziria um username e a criação de
  conta, outro.
- **O OIDC não deriva o username do `name` às cegas.** Quando o provedor não
  manda nome, `resolveOidcUser` já usava o **e-mail** como `name` da conta —
  então `usernameFromName(name)` devolveria `fulano-empresa-com`, publicando o
  endereço inteiro como identificador público. O código compara `name === email`
  e, nesse caso, cai no fallback `user-<8 hex>`. É feio na tela até um admin
  renomear a conta, e é o que preserva o sigilo.
- **Campo de username em branco significa coisas diferentes ao criar e ao
  editar.** Ao criar (setup e "Nova conta"), vazio quer dizer "derive do nome" —
  é o que faz o formulário funcionar para quem não quer escolher. No `PATCH` de
  uma conta que já existe, vazio é **400**: derivar ali apagaria o identificador
  público de alguém por descuido, num campo que o admin pode ter esvaziado sem
  querer.
- **O Salvar da edição de conta tranca com o username inválido**, e não só com o
  formulário limpo. Sem isso, mudar o nome com o campo Usuário meio digitado
  gravaria o nome e engoliria o username em silêncio: o `save` manda `undefined`
  quando o texto não normaliza, e o `PATCH` simplesmente não mexeria nele.
- **O teste do site precisou de um e-mail plantado na amostra.** A guarda nova
  (`ENDERECO`, em `apps/site/src/api.test.ts`) varre o JSON anônimo inteiro
  procurando forma de e-mail, com qualquer nome de campo. Depois da `033`
  nenhum objeto que o site lê carrega endereço — o que tornaria a guarda vazia.
  A amostra leva um `ownerEmail` de propósito, fora de `CAMPOS_DA_SKILL`, como
  regressão simulada: é o que a suíte encontra se alguém voltar a espalhar o
  objeto do banco (`...detail`) em vez de projetá-lo campo a campo.
- **A ordem da reescrita do histórico importa em dois pontos.** Por comprimento
  decrescente do e-mail, senão `ana@x.com` é substituído *dentro* de
  `mariana@x.com`; e com fronteira nas duas pontas, porque os rótulos são
  compostos em vários formatos (`email`, `email:nível`, `<slug> email:nível`,
  `email <subject>`) e a troca é por ocorrência, não por igualdade.
- **O banco parou de anular o dono na visibilidade `'open'`, e a guarda mudou de
  lugar.** Para a ficha pública creditar `@dono` (decisão 11 do `19`),
  `skillColumns` passou a devolver `ownerUserUuid` **e** `ownerUsername` também
  ao site — antes anulava os dois ali. O `ownerUserUuid` é o `sub` do cookie de
  sessão do painel, então a **lista de permissão de `skillPublica`
  (`apps/site/src/api.ts`) virou a única coisa entre ele e o anônimo**: um
  `...detail` de volta ali vaza o uuid. As guardas de teste são `PROIBIDOS` (com
  a amostra carregando o campo de propósito) e `ENDERECO`, as duas em
  `apps/site/src/api.test.ts`. Custo colateral: uma busca pela PK de `users` por
  linha nas listagens do site.
- **A `022` deixou de poder ser reaplicada sobre o schema de hoje.** Ela cria um
  GIN sobre `skill_accesses.user_email`, coluna que a `033` apagou; reexecutada,
  falha com `column "user_email" does not exist`. O arquivo roda em transação, e
  nada fica pela metade — é o caso mais benigno da família "reaplicar migration
  antiga", e o único que se anuncia em vez de passar em silêncio. Está no
  `database/README.md` e é medido em `accesses.integration.test.ts`.

## Perfil

O desenho e o porquê de cada escolha estão em [`20-perfil.md`](20-perfil.md).
Aqui só o que é desvio ou armadilha de implementação.

- **O tipo da imagem sai dos bytes, e o teto é conferido depois de recebê-los.**
  As duas coisas contrariam o instinto. A extensão e o `Content-Type` da parte
  multipart são texto que o remetente escolhe: aceitar qualquer um é deixá-lo
  declarar que o SVG dele é um PNG. E o `limitRequestBytes` das rotas de upload
  corta pelo teto **do painel** (64 MB, que é o do .zip de uma skill), não pelos
  512 KB do avatar — esse é regra da rota, e por isso vive em
  `apps/admin/src/profile.ts`, depois do multer.
- **`user_avatars` é tabela separada por causa da leitura, não da escrita.** A
  tentação é uma coluna `bytea` em `user_profiles`; o problema aparece na
  página `/u/<username>` e na ficha de skill, que leem o perfil ou o dono e
  arrastariam até 512 KB para descartar. É o mesmo motivo de
  `files.binary_content` (`001`) estar na linha do arquivo e não na da skill.
- **O avatar é servido com `max-age=0, must-revalidate` + ETag, e não com cache
  longo.** Cache longo é justamente o que deixaria a foto visível depois de o
  perfil virar privado. O ETag é o `sha256` da imagem: revalidar custa um 304 de
  alguns bytes, e trocar a foto invalida sozinha. Os cabeçalhos vivem em
  `avatarHeaders`, no `shared`, porque painel e site servem a mesma coisa e duas
  cópias divergiriam.
- **A URL do avatar leva o carimbo como query** (`?v=<avatarUpdatedAt>`). Com
  `max-age=0` a imagem nova entraria na revalidação seguinte, mas um `<img>` de
  aba aberta há meia hora não revalida sozinho — o carimbo troca a URL e a foto
  nova aparece sem recarregar a página.
- **A rota do avatar do site passa pelo `getPublicProfile`, e não direto aos
  bytes.** Sem isso, a imagem de um perfil recém-tornado privado continuaria
  servida a quem tivesse a URL — e a URL é pública por construção, porque esteve
  numa página. As funções do banco (`getAvatar`, `getAvatarByUsername`) são
  deliberadamente burras: a política é de quem chama, porque o painel serve a
  foto a qualquer sessão logada e o site só à pública.
- **O interruptor "publicar" grava sozinho, fora do Salvar.** É a ação mais
  consequente da tela, e não pode ficar pendurada num botão que a pessoa talvez
  não clique: quem desliga o perfil quer que ele saia do ar agora.
- **Campo de username vazio significa coisas diferentes ao criar e ao editar** —
  e o mesmo vale aqui para o perfil: no `PATCH /api/me/profile`, campo ausente é
  "não mexe", o que é o que deixa o interruptor do público não reenviar a bio.
- **`PATCH /api/me/profile` é a única escrita em `users` que não exige admin.**
  Ela aceita `name` e mais nada dali: o corpo é lido campo a campo em
  `profile.save`, e não repassado a `updateUser`. Um repasse cru poria papel,
  estado e username ao alcance de quem montasse o JSON à mão.
