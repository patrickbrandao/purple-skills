# Camada de dados — especificação

Esta pasta é o **domínio do agente DBA**. Tudo que define, cria, migra, popula
ou acessa o PostgreSQL do Purple Skills mora aqui: os containers, os arquivos de
schema e a biblioteca de acesso compartilhada pelos cinco apps que abrem conexão.

Os demais agentes (site, admin, mcp-public, mcp-admin, indexer) **consomem** o
que está documentado aqui e não escrevem SQL nem abrem conexão por conta própria
— a homepage não abre conexão nenhuma. As regras estão em
[Contrato com os outros agentes](#contrato-com-os-outros-agentes).

## Conteúdo

```
database/
  docker-compose.yml   containers postgres, migrate e seed (incluídos pela raiz)
  Dockerfile           imagem que aplica o schema e carrega os exemplos
  schema/              nnn-nome.sql — a fonte de verdade do banco
  src/
    client.ts          pool, resolução de conexão, healthcheck
    schema.ts          tabelas em Drizzle (tipagem + query builder; ver abaixo)
    queries.ts         a API que os apps usam
    errors.ts          AppError e helpers de status
    migrate.ts         runner das migrations
    seed.ts            catálogo de exemplo
    *.integration.test.ts  testes que exigem um Postgres real (ver Testes)
```

O pacote npm continua se chamando **`@purple-skills/db`** — só o diretório mudou
de `packages/db` para `database/`.

## Arquivos de schema

Todo objeto do banco (tabela, tipo, índice, constraint, função, trigger,
extensão) é definido em `database/schema/`, em arquivos nomeados

```
nnn-nome.sql          nnn = 3 dígitos, com zeros à esquerda
```

| Arquivo | O que define |
|---------|--------------|
| `001-init.sql` | schema inicial: `skills`, `files`, `tags`, `skill_tags`, `audit_log`, índices, funções e triggers do `search_vector` |
| `002-fix-search-vector-on-create.sql` | corrige a indexação do `SKILL.md` no momento da criação |
| `003-case-insensitive-file-paths.sql` | unicidade de `relative_path` sem diferenciar caixa |
| `004-contas.sql` | `users`, `skills.created_by_user_uuid`, ator e alvo no `audit_log`, `CHECK` de `action` ampliado |
| `005-api-keys.sql` | `api_keys` — credenciais `psk_` por usuário para o MCP administrativo |
| `006-reset-tokens.sql` | `reset_tokens` — link de uso único para redefinir senha |
| `007-publicacao-mcp.sql` | `skills.use_as_prompt` / `use_as_resource` e os índices parciais das listagens do MCP público |
| `008-publicacao-como-skill.sql` | `skills.use_as_skill` — a superfície de ferramentas do MCP público vira opt-out |
| `009-mcp-virtual.sql` | `virtual_mcps`, `virtual_mcp_skills`, `virtual_mcp_keys` e o `CHECK` de `action` com os eventos `mcp.*` |
| `010-public-mcp-keys.sql` | `public_mcp_keys` — chaves `psp_` gerenciadas do antigo MCP principal — e o `CHECK` de `action` com `public.key.*` |
| `011-mcp-padrao.sql` | `settings` (o vMCP padrão que responde em `/mcp`), `mcp.default` no `CHECK` de `action`, backfill do vMCP `public` e remoção de `public_mcp_keys` |
| `012-skills-flutuantes.sql` | remove `skills.is_public` e as três `use_as_*`, os índices parciais de `007` e o `skills_public_score_idx`; cria `skills_score_idx` |
| `013-skill-icon.sql` | `skills.icon` — emoji ou URL http(s) de imagem, com `CHECK` de tamanho (≤ 512); a regra de forma é do app |
| `014-canvas-do-vmcp.sql` | posições do canvas do painel: `virtual_mcp_skills.pos_x`/`pos_y` (com `CHECK` de par) e `virtual_mcps.layout` JSONB (`CHECK` de objeto) |
| `015-mcp-sessions.sql` | `mcp_sessions` — contabilidade de sessões do MCP público, com os índices parciais sobre as abertas; **nunca é podada** |
| `016-catalogos.sql` | catálogos: `skills.is_active` (a skill desligada globalmente), `catalogs`, `catalog_skills` (a participação, com `is_active`), `virtual_mcp_catalogs` (as três portas do vínculo e a posição no canvas, com `CHECK` de par) e o `CHECK` de `action` com `catalog.*` |
| `017-acesso-granular.sql` | acesso granular: `users.role` troca `leitor` por `membro` (com `UPDATE` das linhas), `skills.owner_user_uuid` (backfill de `created_by`, **uma vez**), `skills.is_public` e `catalogs.is_public`, as três tabelas de concessão (`skill_grants`, `catalog_grants`, `virtual_mcp_grants`) e o `CHECK` de `action` com `*.share`/`*.unshare` |
| `018-acessos-por-skill.sql` | `skill_accesses` — uma linha por leitura de skill (MCP público, site, mcp-admin), com FKs `SET NULL` e as cópias que sobrevivem à remoção, os catálogos do caminho em arrays paralelos (índice GIN) e os índices por skill, vMCP e data; **nunca é podada** |
| `019-acessos-por-conta.sql` | a guia "Acessos" da conta: índice composto `(user_uuid, created_at DESC)` em `skill_accesses`, no lugar do simples de `018` (derrubado) |
| `020-rag.sql` | busca semântica: a extensão `vector`, `files.content_sha256` (por trigger), `skills.rag_stale` (com os triggers de skill, arquivo e tag), `rag_spaces`, `rag_texts`, `rag_skill_texts`, `rag_vectors` (FK composta + `CHECK` de dimensão) e o `CHECK` de `action` com `rag.settings`/`rag.reindex` |
| `021-chaves-por-emissor.sql` | "Chaves emitidas" da conta: índice composto `(created_by_user_uuid, created_at DESC)` em `virtual_mcp_keys` (também cobre o `SET NULL` da remoção da conta) |
| `022-busca-por-substring.sql` | busca por pedaço de palavra: os doze GIN de trigrama que faltavam ao `ILIKE '%termo%'` — `skills.description` e `skills.slug` (para o `BitmapOr` fechar com o `name` do `001`), as quatro colunas do `q` de `audit_log` e as seis do `q` de `skill_accesses` |
| `023-links-de-reset-substituidos.sql` | link de redefinição que foi fechado sem uso: `reset_tokens.superseded_at` (exclusivo com `used_at` por `CHECK`), o trigger em `users` que fecha os links vivos quando a senha muda e o backfill que deixa, no máximo, um link vivo por conta |
| `024-auditoria-de-troca-de-senha.sql` | a ação `user.password` no `CHECK` de `audit_log.action` (a lista inteira, repetida): a senha de outra conta trocada pelo admin ou por um link de redefinição passa a caber na trilha |
| `025-fila-de-textos-do-rag.sql` | `rag_text_status` — o estado do par (espaço, texto) na fila do indexador: a **recusa** definitiva do provedor e a **reserva** com prazo, que impede duas réplicas de pagar pelo mesmo embedding |
| `026-auditoria-de-vinculo-e-reativacao.sql` | as ações `user.activate` e `user.link` no `CHECK` de `audit_log.action` (a lista inteira, repetida): a conta reativada e a identidade OIDC que passa a abrir uma conta que já existia cabem na trilha |
| `027-rag-stale-na-troca-de-tipo.sql` | `files_rag_stale_tg` redefinida: o atalho "hash e caminho iguais, nada aconteceu" passa a exigir também o mesmo **tipo** (e a mesma skill) — o hash é dos bytes, e o arquivo que troca de `binary_content` para `text_content` com o conteúdo igual não marcava a skill. Só a função muda; nenhum dado |
| `028-reserva-de-skills-com-prazo.sql` | `rag_skill_claims` — a skill **reservada e ainda não terminada** pelo indexador, com prazo (`until`) e tentativas: o lote de um indexador morto volta à fila sozinho em vez de ficar marcado como feito para sempre |
| `029-arquivos-de-texto-antigos.sql` | só dados: as linhas de `files` gravadas como binário **antes** de a tabela de mime do shared ganhar 70 extensões (beta.22) viram texto — só o UTF-8 válido e sem byte nulo; hash, tamanho e os dois `updated_at` não mudam, e as skills donas ficam `rag_stale`. **Depois da `027` de propósito** — antes dela o `UPDATE` cairia inteiro no atalho do trigger antigo. Ver [Arquivos da skill](#arquivos-da-skill) |
| `030-quarentena.sql` | quarentena: `quarantine_skills` e `quarantine_files` (o envio que espera aprovação — texto **ou** binário com o CHECK, caminho único por envio sem diferenciar caixa e o trigger que carimba `updated_at` do envio), o `CHECK` de `action` com as cinco ações `quarantine.*` (a lista inteira, repetida — a base era esta até a `031`) e a chave `quarantine.approvers` em `settings`, semeada com `admin+owner`. Nenhuma coluna de RAG e nenhum trigger de `rag_stale`: ver [Quarentena](#quarentena) |
| `031-clonagem.sql` | clonagem: as três ações `skill.clone`, `catalog.clone` e `mcp.clone` no `CHECK` de `audit_log.action` (a lista inteira, repetida — **quem mexer nele depois parte desta**), com `target_label` = `<slug de origem> -> <slug da cópia>`. Nenhuma coluna, nenhuma tabela e nenhum dado: o que a cópia leva já cabe nas tabelas que existem — ver [Clonagem](#clonagem) |
| `033-username.sql` | username: `users.username` (obrigatória, única por `lower(username)`), o **backfill derivado do `name`** (com `translate()` e mapa de acentos — esta instalação não tem `unaccent` —, `user-<8 hex>` para nome inutilizável ou reservado e sufixo numérico em colisão), `usernames` (o livro dos nomes já gastos: abandonado nunca volta), a **reescrita do histórico** (`audit_log.actor_label`/`target_label` e `skill_accesses.user_email` → `user_username`, com `DROP COLUMN` e o trigram de `022` recriado) e `user.username` no `CHECK` de `action` — ver [Username](#username) |
| `032-atividade.sql` | a tela de Atividade: `mcp_call_counters` (o contador de chamadas JSON-RPC por balde de 15 min, com a PK pelo **slug** do vMCP e a `family` gravada junto) e os dois índices que faltavam em `mcp_sessions` (`started_at DESC` e `ended_at DESC`). Nenhuma coluna nova nas tabelas antigas e nenhum dado — ver [Atividade](#atividade) |
| `034-perfil.sql` | perfil: `user_profiles` (bio, site, `links` JSONB e o `is_public` opt-in, com os CHECKs de teto e de cardinalidade) e `user_avatars` (os bytes da foto, `mime` da lista fechada, `sha256` do ETag conferido pelo banco e o teto de 512 KB), as duas com PK `user_uuid` e `ON DELETE CASCADE`, mais o índice parcial `user_profiles_public_idx` e `user.profile` no `CHECK` de `action`. **Nenhuma linha é criada**: a do perfil nasce no primeiro salvamento — ver [Perfil](#perfil) |
| `035-destino-da-quarentena.sql` | destino da quarentena: `quarantine_catalogs` e `quarantine_mcps` (os catálogos e os vMCPs, com as três portas e o CHECK de "pelo menos uma", em que a skill entra **quando o envio for aprovado**), as duas com `ON DELETE CASCADE` para o envio **e** para o alvo, e os índices inversos. Sem trigger de carimbo e sem ação nova no `CHECK` de `action`; revoga o "nasce flutuante" da promoção — ver [O destino](#o-destino) |

Regras:

- **Ordem lexicográfica = ordem de aplicação.** O runner lê o diretório, ordena
  por nome e aplica o que ainda não está em `schema_migrations`.
- Uma migration aplicada é **imutável**: nunca edite um arquivo já publicado,
  crie o próximo número. A única exceção é o **comentário** do cabeçalho, quando
  ele aponta para um lugar que deixou de existir — foi o caso do `020`, que
  remetia a `tmp/RAG-GOOGLE.md` (gitignorado, fora do repositório) em vez de
  `docs/14-rag.md`. DDL, nunca; texto que mente, sim.
- Cada arquivo roda em **uma transação**; se falhar, sofre rollback inteiro e o
  processo aborta com o nome do arquivo.
- Escreva DDL idempotente (`IF NOT EXISTS`, `CREATE OR REPLACE`,
  `DROP ... IF EXISTS`) — é o que permite reaplicar num banco parcialmente migrado.
  A idempotência é **da época do arquivo**: ela torna a migration segura para
  rodar duas vezes sobre o schema que ela esperava, e **não** sobre um schema
  mais novo — ver [Reaplicar migration antiga](#reaplicar-migration-antiga).
- O nome do arquivo é a **identidade** da migration dentro de `schema_migrations`.
  Renomear exige entrada em `RENAMED` no [`src/migrate.ts`](src/migrate.ts), como
  foi feito na mudança de `packages/db/migrations/nnnn_nome.sql` para cá.
- O que a migration cria e o DSL do Drizzle expressa — coluna, tipo, NOT NULL,
  DEFAULT, chave primária, UNIQUE, chave estrangeira com a ação de remoção e
  índice por coluna — tem de aparecer em [`src/schema.ts`](src/schema.ts) com o
  mesmo nome. Índice **parcial** ou **por expressão**, CHECK, função e trigger
  não cabem lá e ficam só no SQL: os índices desses dois tipos entram na lista
  `SOMENTE_SQL` de `src/schema.integration.test.ts`, com o motivo. Ver
  [O `schema.ts` e o banco](#o-schemats-e-o-banco).

### Reaplicar migration antiga

`IF EXISTS` garante que a segunda passada **não falha** — não que ela não faz
nada. Um `DROP` correto em `nnn` destrói o que `mmm > nnn` criou com o mesmo
nome, e quatro casos estão medidos:

- o `012` faz `DROP COLUMN IF EXISTS is_public`, e o `017` recriou
  `skills.is_public` com outro sentido (quem pode **ler**). Reaplicado, o `012`
  derruba a coluna nova com o dado dentro: toda listagem de skill passa a falhar
  (`column s.is_public does not exist`), reaplicar o `017` a devolve **zerada**,
  e nada disso deixa linha em `audit_log` — não há como saber depois quais
  skills eram públicas, só por backup;
- toda migration que mexe no `CHECK` de `audit_log.action` o reescreve inteiro,
  com a lista da época dela. O `017` reaplicado estreita o `CHECK` de volta, e o
  "Reindexar" do painel (`rag.reindex`, da `020`) deixa de gravar — o mesmo vale
  para o `016` sobre as três ações de clonagem da `031`, que é o que
  `catalogs.integration.test.ts` mede no fim (e desfaz reaplicando a `031`);
- a `020` recria `files_rag_stale_tg`, que a `027` redefiniu: reaplicada sozinha,
  desfaz a correção;
- a `022` cria um GIN sobre `skill_accesses.user_email`, coluna que a `033`
  **apagou** ao trocar o e-mail pelo username. Reaplicada sobre o schema de
  hoje ela não estraga nada: **falha** (`column "user_email" does not exist`),
  o arquivo inteiro sofre rollback e o runner aborta. É o caso mais benigno dos
  quatro, e o único que se anuncia; `accesses.integration.test.ts` o mede, e
  `settings.integration.test.ts` tira a `022` da sua reexecução por causa dele.

O runner só chega a isso com o histórico **truncado**, e por isso o **CLI**
(`npm run migrate`, o container `migrate`) confere antes de aplicar qualquer
coisa e, se recusar, não aplica nada e sai com 1:

| Situação | Como o runner percebe | Mensagem |
|----------|-----------------------|----------|
| falta uma linha no meio — apagada à mão, ou `schema_migrations` restaurada de um backup mais velho que o schema | arquivo fora do histórico com número **menor** que o maior já aplicado | `Migration retroativa recusada: <arquivos> …` |
| falta o histórico inteiro — restauração sem `schema_migrations`, ou a tabela derrubada | histórico vazio **e** `skills` já existe (a marca d'água é zero e não acusaria nada) | `Reaplicação recusada: schema_migrations está vazia …` |

Banco novo (sem histórico e sem `skills`) e arquivo novo com o maior número
passam como sempre. Três saídas, conforme o caso:

- **o histórico foi truncado:** recomponha-o — uma linha por arquivo que o banco
  **já tem**. Restaure `schema_migrations` do mesmo backup; sem ele, insira os
  nomes à mão (`INSERT INTO schema_migrations (name) VALUES ('001-init.sql'), …`)
  até a versão de que o dump saiu, e só então rode o `migrate`;
- **o arquivo é mesmo novo e só recebeu um número menor** (renumeração entre
  cópias de trabalho): `MIGRATE_ALLOW_RETRO=1 npm run migrate`, ou
  `docker compose run --rm -e MIGRATE_ALLOW_RETRO=1 migrate`. A variável desliga
  a conferência inteira e devolve o comportamento de antes; é de uso pontual, na
  linha de comando — não é configuração para o `.env`;
- **o arquivo foi renomeado depois de aplicado:** não é nenhum dos dois, é
  `RENAMED` em `src/migrate.ts`.

A conferência é uma **opção** de `runMigrations(connection, { refuseRetroactive
})`, desligada por padrão: quem chama a função direto são as suítes de
integração, que apagam uma linha do histórico **de propósito**, num banco
descartável, para provar que o SQL não falha nem muda a estrutura na segunda
passada. Isso **não** prova idempotência de dado — `migrate.integration.test.ts`
mede o contrário. `psql -f` num arquivo antigo passa ao largo do runner e de
qualquer guarda: não faça.

### O `schema.ts` e o banco

[`src/schema.ts`](src/schema.ts) é **tipagem** e query builder — a fonte de
verdade continua sendo o SQL. Ninguém roda `drizzle-kit generate`/`push`: o
arquivo não descreve tudo, e o diff proporia **remover** o que falta. Isso já
aconteceu de virar divergência silenciosa — existiam só no SQL três chaves
estrangeiras (duas delas `SET NULL`, na trilha de auditoria e no criador da
skill), nove índices, os dois UNIQUE de `rag_spaces` e seis `DESC` —, por isso a
regra passou a ser explícita e verificada:

- **está declarado** tudo o que o DSL expressa fielmente: coluna, tipo, NOT
  NULL, DEFAULT, chave primária, UNIQUE, chave estrangeira com a ação de
  remoção e índice por coluna, com a classe de operadores (`gin_trgm_ops`) e o
  `DESC` quando o SQL os tem;
- **fica só no SQL** o que ele não expressa: índice parcial
  (`skills_rag_stale_idx`, os dois de `mcp_sessions` abertas, `users_oidc_uniq`)
  e por expressão (`files_skill_path_lower_uniq`, `users_email_lower_uniq`,
  `users_username_lower_uniq`, `skills_score_idx`,
  `quarantine_files_path_lower_uniq`), os CHECKs, as
  funções e os triggers de busca, de RAG e do carimbo da quarentena;
- **os nomes batem** onde o DSL os aceita: PK composta (`primaryKey({ name })`),
  UNIQUE (`.unique('<tabela>_<coluna>_key')`) e índice. A exceção é a chave
  estrangeira declarada na coluna: o `.references()` não tem nome, o Postgres a
  chama `<tabela>_<coluna>_fkey` e o Drizzle a chamaria `..._fk` — o que a
  identifica são as colunas, e é por elas que a conferência passa.

Quem garante isso é a suíte
[`src/schema.integration.test.ts`](src/schema.integration.test.ts): migra um
banco do zero e compara `pg_attribute`, `pg_constraint` e `pg_index` com o que o
Drizzle declara, nos dois sentidos. Índice parcial ou por expressão
precisa de uma linha na lista `SOMENTE_SQL` do teste, com o motivo — e a lista
também é conferida: entrada que não corresponde a um índice parcial/por
expressão existente derruba a suíte.

### Tabelas

| Tabela | Papel |
|--------|-------|
| `skills` | o acervo: `slug`, `name`, `description`, `icon` (emoji ou URL, nulo = monograma), `is_active` (desligada some de todo vMCP e do site sem perder vínculo), `is_public` (quem pode **ler**: qualquer conta e o site — não publica em MCP nenhum), `owner_user_uuid` (o dono; nulo = órfã, só do admin), contadores e `search_vector`. A skill é **exibida** onde está vinculada, direto ou por catálogo |
| `files` | árvore de arquivos da skill; texto **ou** binário, nunca os dois (CHECK), com o `content_sha256` do que está gravado (`020`, por trigger) |
| `tags` / `skill_tags` | tags e o vínculo N:N com as skills |
| `audit_log` | trilha de auditoria de create/update/delete **e dos eventos de conta**, com o conteúdo anterior, o ator e o alvo |
| `users` | contas: o **username** (o identificador público, único por `lower(username)`, `033`), o e-mail (privado: entrar, recuperar a senha e casar com a identidade OIDC), papel (`admin`/`editor`/`membro`), senha, vínculo OIDC, `token_version` e o bloqueio do login |
| `usernames` | o livro dos usernames já gastos nesta instalação (`033`): PK em `lower(username)`, `user_uuid` anulável (`SET NULL`) e `released_at`. **Username abandonado nunca volta** — ver [Username](#username) |
| `user_profiles` | o perfil de uma conta (`034`): `bio` (`''` = sem bio), `website_url`, `links` (JSONB, até 8) e `is_public` — opt-in, desligado por padrão. PK `user_uuid`, `ON DELETE CASCADE`. A linha **nasce no primeiro salvamento**, não com a conta — ver [Perfil](#perfil) |
| `user_avatars` | os bytes da foto (`034`), em tabela separada para não viajarem em leitura nenhuma de perfil: `bytes`, `mime` (PNG/JPEG/WebP, CHECK), `sha256` (o ETag, conferido contra os bytes pelo CHECK) e `updated_at`. PK `user_uuid`, `ON DELETE CASCADE`, teto de 512 KB |
| `api_keys` | chaves `psk_` por usuário; guarda o prefixo e o hash, nunca o segredo |
| `reset_tokens` | tokens de redefinição de senha, com expiração, uso único e o fechamento do link substituído (`superseded_at`, `023`) — ver [Links de redefinição de senha](#links-de-redefinição-de-senha) |
| `virtual_mcps` | servidores MCP virtuais: `slug`, dono (`owner_user_uuid`), `is_active`, `is_open` e `layout` (posições dos nós fixos do canvas, JSONB) |
| `virtual_mcp_skills` | vínculo skill ↔ MCP virtual, com as flags `as_skill`/`as_prompt`/`as_resource`, contadores **próprios** e a posição do nó no canvas (`pos_x`/`pos_y`, nulas = auto-layout) |
| `virtual_mcp_keys` | chaves `psv_` por servidor; mesmo formato de `api_keys` |
| `catalogs` | grupos de skills com dono (`owner_user_uuid`, como `virtual_mcps`), `is_active`, `is_public` (legível por qualquer conta e pelo site, **com os membros ativos**) e contadores **do catálogo** (somam quando a skill chegou ao vMCP por ele) |
| `catalog_skills` | a participação skill ↔ catálogo, com `is_active` (desativa a skill **neste** catálogo sem removê-la) — sem portas: quem as decide é o vínculo com o vMCP |
| `virtual_mcp_catalogs` | vínculo catálogo ↔ MCP virtual, N:N, com as flags `as_skill`/`as_prompt`/`as_resource` (valem para todo membro) e a posição do nó no canvas (`pos_x`/`pos_y`) |
| `skill_grants` / `catalog_grants` / `virtual_mcp_grants` | as concessões por objeto (`017`): PK `(objeto, conta)`, os dois `ON DELETE CASCADE`, `level` em `view`/`edit`/`manage` (CHECK), `granted_by_user_uuid` informativo (`SET NULL`) e `created_at`; índice reverso por `user_uuid`. Dono e admin **não** têm linha |
| `settings` | configuração da instalação, chave-valor; `default_virtual_mcp` guarda o uuid do vMCP que responde em `/mcp`, sem FK, as três chaves `rag.*` guardam driver, modelo e estado do indexador (`020`) e `quarantine.approvers` guarda quem aprova um envio (`030`, semeada com `admin+owner`) |
| `mcp_sessions` | uma linha por cliente conectado a um vMCP pelo MCP público: transporte, por onde chegou, credencial, IP, `clientInfo`, atividade e fim. Sobrevive à remoção do vMCP e nunca é podada |
| `skill_accesses` | uma linha por **leitura** de uma skill (`018`): o que foi lido (`kind`, `surface`), por onde (`origin`, o vMCP, os catálogos do caminho), com que credencial (`auth`, chave `psv_`, chave `psk_` e a conta pelo `user_username`), de onde (`ip`, `user_agent`, `clientInfo`, `session_id`) e quando. Toda FK é `SET NULL` com a cópia ao lado; nunca é podada |
| `mcp_call_counters` | quantas chamadas JSON-RPC o MCP público atendeu (`032`), por balde de 15 minutos, vMCP, transporte e método. É **contador, não registro**: nada de tool, argumento, IP, conta ou sessão. PK `(bucket, virtual_mcp_slug, transport, method)` — pelo slug, porque o uuid é `SET NULL` e nulo não fecha chave; `family` é derivada do método e gravada junto. Nunca é podada |
| `rag_spaces` | um espaço de embedding (`020`): driver, modelo, dimensões e os **dois prefixos** do driver — a identidade é a combinação dos cinco |
| `rag_texts` | o texto canônico, endereçado pelo próprio SHA-256 e guardado **sem** o prefixo do driver; o hash é conferido pelo banco |
| `rag_skill_texts` | as ocorrências: onde cada texto aparece (skill, fonte, arquivo, parte). Texto em uso não pode ser apagado |
| `rag_vectors` | o vetor de um texto num espaço; a FK composta com `rag_spaces` e o `CHECK` de `vector_dims` impedem vetor de dimensão errada |
| `rag_text_status` | o estado do par (espaço, texto) na fila (`025`): `reservado` com prazo (`until`) ou `recusado` sem prazo, com o motivo. As duas FKs são `CASCADE` — estado de fila não segura a coleta de órfãos nem sobrevive ao espaço |
| `rag_skill_claims` | a skill **reservada e ainda não terminada** pelo indexador (`028`): PK `skill_uuid` (`CASCADE`), `until` e `attempts`. Fica vazia entre dois ciclos; o que sobra depois de `until` é o lote de um indexador que morreu. Ver [A fila de skills](#a-fila-de-skills-reserva-com-prazo) |
| `quarantine_skills` | o envio que espera aprovação (`030`): `name` (rótulo, **não** é único), `description`, `source_filename`, o dono (`owner_user_uuid`, `SET NULL` como `skills`) e as duas datas. Sem slug, tag, ícone, `is_active`, `is_public`, vínculo, contador, concessão, `search_vector` nem RAG — ver [Quarentena](#quarentena) |
| `quarantine_files` | os arquivos do envio: a modelagem de `files` (texto **ou** binário, com o CHECK), com o caminho único **dentro do envio** e sem diferenciar caixa, e **sem** `content_sha256` — o hash existe para o RAG, que não passa por aqui |
| `quarantine_catalogs` | o destino do envio em catálogos (`035`): PK `(quarantine_uuid, catalog_uuid)`, as duas FKs em cascata e o índice inverso por `catalog_uuid`. **Não é vínculo** — nada aqui aparece no catálogo até a aprovação |
| `quarantine_mcps` | o destino do envio em vMCPs (`035`): PK `(quarantine_uuid, virtual_mcp_uuid)`, as três portas **sem DEFAULT** com o CHECK `quarantine_mcps_some_port_chk`, as duas FKs em cascata e o índice inverso por `virtual_mcp_uuid` |
| `schema_migrations` | controle do runner (criado por ele, não por um `.sql`) |

Chaves primárias são `uuidv7()` do PostgreSQL 18. A busca usa `tsvector` com
configuração `simple`, mantido por trigger — ver `001` e `002`.

O desenho de contas, papéis e credenciais está em
[`docs/05-accounts-and-roles.md`](../docs/05-accounts-and-roles.md); `004` a
`006` são a parte dele que vive aqui, e o
[`docs/12-acesso-granular.md`](../docs/12-acesso-granular.md) (`017`) é o que
vale para escopo. Três pontos que o modelo assume:

- **o papel limita a ação; o escopo é do dono e das concessões.** Skill
  (`017`), vMCP (`009`) e catálogo (`016`) têm `owner_user_uuid`; quem cria
  vira dono, e `skills.created_by_user_uuid` continua só informativo. O admin
  manda em tudo; o dono no seu; os demais no que lhes foi concedido
  (`skill_grants` etc.) — ver [Acesso granular](#acesso-granular);
- **o ator pode não ser uma conta.** `audit_log.actor_user_uuid` é nulo para o
  `MCP_ADMIN_TOKEN` e para o bootstrap; quem sempre existe é `actor_label`.
  O que eles criam nasce **órfão** (dono nulo), só do admin — e as skills e
  os catálogos órfãos passam ao admin solitário quando ele entra
  (`adoptOrphans`, ver [Acesso granular](#acesso-granular));
- **`leitor` não existe mais.** O `017` renomeou o papel para `membro` e
  migrou as linhas; a diferença para `editor` é só **criar**.

### Onde uma skill é exibida

Uma skill é **flutuante** (`012`,
[`docs/09-mcp-padrao-e-skills-flutuantes.md`](../docs/09-mcp-padrao-e-skills-flutuantes.md)):
ela não carrega as portas do MCP. Aos **servidores MCP** chega por um de dois
caminhos: o **vínculo direto** (`virtual_mcp_skills`), que carrega as três
portas, `as_skill`, `as_prompt` e `as_resource`, obrigatórias e sem default, e
contadores próprios; ou um **catálogo** de que participa, vinculado ao vMCP
(`016`, ver [Catálogos](#catálogos)). No **site** há, desde o `017`, dois
caminhos que **não passam por vMCP nenhum**: `skills.is_public` (quem pode
**ler** — a coluna voltou com outro sentido, ver o fim desta seção) e a
participação ativa num catálogo público e ligado. A regra inteira do site é
`OPEN_EXPOSURE` em [`src/queries.ts`](src/queries.ts): skill ligada que é
pública, **ou** está em vMCP aberto e ligado, **ou** tem participação ativa em
catálogo público e ligado. Em **todos** os caminhos a skill precisa estar
**ligada** (`skills.is_active`); o contador global da skill continua somando
junto.

**Era**, até o `017`: "não tem coluna de visibilidade e só é exibida — no site
e nos servidores MCP — onde chega a um MCP virtual". Continua valendo para os
servidores MCP; para o site deixou de valer (`docs/12` decisões 4 e 14), e um
app que replique "só aparece via vMCP" esconde a skill pública sem vínculo e o
membro de catálogo público (`tasks/060`).

Toda leitura de skill recebe uma `visibility` **ou** um `viewer`:

| Opção | Enxerga | Quem passa |
|-------|---------|------------|
| `visibility: 'open'` (padrão) | skills **ligadas** que são públicas (`is_public`), ou expostas em ao menos um vMCP aberto e ligado (por vínculo direto ou por catálogo), ou com participação ativa em catálogo público e ligado | site e API REST anônima |
| `visibility: 'all'` | o acervo inteiro, inclusive flutuantes, desligadas e órfãs; `access: 'owner'` em tudo. **Nunca com conta na chamada**: é a visão do admin entregue a quem quer que tenha pedido | quem roda sem sessão: o `seed` e as releituras internas das escritas. Nenhum app a passa — o token global e a sessão de bootstrap chegam à mesma visão pela linha de baixo, com `role: 'admin'` e `userUuid: null` |
| `viewer: { role, userUuid }` | com `role: 'admin'`, o mesmo que `'all'`; senão, o que a conta vê (`docs/12` §3.1): pública, dela, concedida a ela, em vMCP aberto e ligado, em catálogo público e ligado, ou dentro de um vMCP/catálogo que ela possui ou lhe foi concedido. **Sem** filtrar `is_active` — o painel mostra a desligada a quem a vê. Sobrepõe `visibility` | painel e mcp-admin (a sessão ou o dono da chave `psk_`) |
| `virtualMcp: { uuid, surface }` | a exposição naquele vMCP com a porta da superfície, pela precedência dos catálogos; sobrepõe as duas acima | mcp-public |

Na visibilidade `'open'` a leitura também **deixa de trazer** o que o site não
mostra, em vez de trazer e o app cortar (`tasks/002`): `grants` vem vazio em
`getSkillDetail`, e dentro de `mcps` o `catalogs` do caminho **só nomeia
catálogo público**. O vínculo por catálogo privado continua contando para a
exposição — a skill *está* naquele servidor —, o que não sai é o nome do
catálogo fechado. Além de fechar o vazamento pelo lado do banco, é o que para
de pagar uma consulta de concessões por página da skill.

**O dono saiu dessa lista na `033`.** Até ela, `ownerUserUuid`/`ownerEmail`
vinham nulos no site, porque o rótulo do dono era o **e-mail** — dado pessoal
que o `docs/12` §10 aceitava expor a conta logada, não ao anônimo. O rótulo
agora é o username, e a decisão 11 do `docs/19` é explícita: a ficha pública
credita o dono por `@username`. As duas colunas saem em toda visibilidade, e
quem corta o `ownerUserUuid` da resposta anônima é a lista de permissão de
`apps/site/src/api.ts` — ele é o `sub` do cookie de sessão do painel
(`tasks/001`).

O padrão é o restritivo de propósito: quem esquece a opção mostra de menos,
nunca de mais. O filtro mora no SQL porque o `total` de `listSkills` e a
contagem de `listTags` não têm conserto depois da consulta. `SkillSummary`
traz `isActive`, `isPublic`, o dono (`ownerUserUuid`, `ownerUsername`), o
`ownerHasProfile` (se o crédito ao dono vira link para `/u/<username>`, `034` —
ver [Perfil](#perfil)), o
`access` da conta que leu (ver [Acesso granular](#acesso-granular)) e
`mcps`, os vMCPs em que a skill está — um item por servidor, `direct: true`
num vínculo direto e `direct: false` (com `catalogs` dizendo por quais) num
servidor alcançado só por catálogo: numa leitura `'all'` todos; com `viewer`,
só os que a conta vê (aberto e ligado, dela, ou concedido a ela); no site só
os abertos e ligados — ele não revela em que servidor fechado uma skill
está. `catalogs` (os catálogos de que participa, com o estado de cada um e da
participação) vem inteiro em `'all'`, recortado pelo `viewer` (público e
ligado, dele, ou concedido), e vazio no site.

`is_public`, `use_as_skill`, `use_as_prompt` e `use_as_resource` existiram
entre `001` e `012`; `007` e `008` são a história delas, e o `011` copiou o
que valia para o vínculo com o vMCP `public` antes de o `012` as apagar. O
`is_public` de hoje (`017`) é outra coluna com o mesmo nome e outro sentido:
**quem pode ler**, não o que o MCP publica.

### Acesso granular

Dono, concessões por objeto e "público" (`017`,
[`docs/12-acesso-granular.md`](../docs/12-acesso-granular.md)). Skill, catálogo
e vMCP têm dono; cada um tem uma tabela de concessões com um nível
cumulativo por conta (`view` < `edit` < `manage`); skill e catálogo têm
`is_public`, e o "público" do vMCP é o `is_open` que já existia. O que cada
nível cobre é a tabela de `docs/12` §3.2 — **a permissão é do app**
(`accessLevel`, `canView`/`canEdit`/`canManage`/`canOwn` de shared); o banco
devolve o `access` e recusa só o que não faz sentido gravar.

**O `access` por linha.** `SkillSummary`, `CatalogSummary` e
`VirtualMcpSummary` trazem `access: EffectiveAccess`: `'owner'` para o admin
(por papel, pelo token global ou pelo bootstrap — `viewer` ausente com
`'all'`) e para o dono; o nível da concessão direta; `'view'` para quem só
chega por público, por vMCP aberto ou por contêiner que possui ou lhe foi
concedido; `null` numa leitura sem conta (o site). Os `*Detail` trazem
`grants: Grant[]` sempre — é o app que decide a quem repassar (só `manage`,
dono e admin).

**As listagens de contêiner** seguem a forma curta de `docs/12` §3.1:
`listCatalogs({ viewer })` e `listVirtualMcps({ viewer })` devolvem, para
quem não é admin, o que é público/aberto **e ligado**, o que é da conta e o
que lhe foi concedido; `getCatalog(slug, { viewer })`,
`getCatalogByUuid(uuid, { viewer })`, `getVirtualMcp(slug, { viewer })` e
`getVirtualMcpByUuid(uuid, { viewer })` devolvem `null` fora disso, como se
o objeto não existisse. Sem `viewer` é a visão do admin, como antes;
`{ ownerUserUuid }` continua valendo como filtro por dono.

**`scope`** (`'mine' | 'shared' | 'public'`), em `listSkills`, `listCatalogs`
e `listVirtualMcps`, é o filtro Meus / Compartilhados comigo / Públicos e
exige `viewer` (400 sem ele; o admin também tem "meus"): `'mine'` é o que a
conta possui; `'shared'` o que lhe foi concedido — direto ou, nas skills, por
um contêiner que ela possui ou lhe foi concedido — **e não é dela**;
`'public'` o que qualquer um lê (skill pública, em vMCP aberto e ligado ou em
catálogo público e ligado; catálogo público e ligado; vMCP aberto e ligado).
Os três se sobrepõem de propósito: uma skill pública num vMCP concedido é
`'shared'` e `'public'`.

**Concessões.** Três trios com a mesma forma, identificando o objeto pelo
slug (é o que a REST e o mcp-admin têm) e a conta pelo uuid (o que
`lookupUsers` devolve):

```ts
await setSkillGrant('minha-skill', userUuid, 'edit', 'web-admin', actor);   // upsert → Grant
await removeSkillGrant('minha-skill', userUuid, 'web-admin', actor);        // 404 se não havia
await listSkillGrants(skillUuid);                                          // Grant[], por nome
// setCatalogGrant / removeCatalogGrant / listCatalogGrants(catalogUuid)
// setVirtualMcpGrant / removeVirtualMcpGrant / listVirtualMcpGrants(virtualMcpUuid)
```

- `set*Grant` é **upsert**: mudar o nível reescreve a linha inteira (nível,
  quem concedeu e `created_at`) — ela descreve a concessão atual. Recusa com
  400: nível fora dos três, conta torta, inexistente ou desativada, o dono do
  objeto e uma conta admin (os dois já têm tudo). Slug desconhecido é 404. O
  objeto é travado (`FOR UPDATE`) durante a escrita. Não toca `updated_at`
  do objeto: conceder não muda o objeto.
- `remove*Grant` apaga a linha; concessão inexistente (ou uuid torto) é 404
  e nada é auditado. **Não olha `users.is_active`**: a concessão de uma conta
  desativada é revogável como qualquer outra.
- `Grant` é `{ userUuid, username, name, role, isActive, level,
  grantedByUserUuid, grantedByUsername, createdAt }` — os dois rótulos de conta
  eram o e-mail até a `033` (ver [Username](#username)); quem concedeu pode já ter
  sido removido (`SET NULL` → os dois nulos). `isActive` é o da **conta**
  (`users.is_active`), não o da concessão — é o que o painel usa para marcar a
  linha de quem foi desativado (`tasks/039`).
- Conta **desativada** mantém as linhas, inertes: as leituras por `viewer`
  não olham `users.is_active` (uma sessão de conta desativada não existe);
  reativar devolve o acesso — e é por isso que a linha vem marcada e pode ser
  revogada antes. **Conceder e mudar o nível continuam recusados** para ela
  (`set*Grant` é upsert: são a mesma chamada), como a transferência. Conta
  removida leva as linhas (`CASCADE`) e deixa os objetos dela órfãos.

**Transferência e público.** `updateSkill` / `updateSkillWithContent` /
`updateCatalog` / `updateVirtualMcp` aceitam `ownerUserUuid` e `isPublic`
(vMCP: `isOpen`). Um uuid de novo dono precisa ser de conta **existente e
ativa** — 400 senão, inclusive uuid torto —, e a concessão que essa conta
tinha no objeto é apagada na mesma transação (o dono é implícito); `null`
deixa órfão. `createSkill` grava `owner_user_uuid = actor.userUuid` (além de
`created_by`) e aceita `isPublic`; `createCatalog` aceita `isPublic`. A
checagem de que o chamador é dono ou admin é do app. Campo ausente **não é
regravado** nas quatro (ver [Escrita de skill](#escrita-de-skill)): sem
`ownerUserUuid`, a coluna do dono fica como está no banco, e uma adoção ou
transferência concorrente não é desfeita.

**Adoção pelo admin solitário.** O que a sessão de bootstrap e o
`MCP_ADMIN_TOKEN` criam nasce órfão; `adoptOrphans(userUuid, source, actor)`
passa esses objetos à conta quando ela é **a única admin ativa**. O painel
chama depois do `/api/setup` e de cada login bem-sucedido (senha e SSO), em
melhor esforço:

```ts
const { adopted, skills, catalogs } = await adoptOrphans(user.uuid, 'web-admin', ator);
```

- Só age se a conta existe, está ativa, tem `role = 'admin'` e nenhuma
  **outra** conta admin está ativa (admin desativado não conta). Fora disso —
  inclusive uuid torto — devolve `{ adopted: false, skills: 0, catalogs: 0 }`,
  sem gravar e sem lançar.
- Adota **skills e catálogos** com `owner_user_uuid IS NULL`. **vMCPs ficam
  de fora**: o `public`/padrão nasce órfão de propósito (`docs/09`,
  decisão 6).
- Cada adoção é uma transferência: a concessão que a conta tinha no objeto
  adotado é apagada (o dono é implícito) e a auditoria tem o mesmo formato
  (abaixo), uma linha por objeto, com o ator e a origem recebidos — skills
  primeiro, cada tipo na ordem do slug. Concessões de outras contas ficam.
- Adotar não muda o objeto: `updated_at` fica, e o dono não entra nos
  triggers de pendência do `020` — `rag_stale` e `search_vector` também
  ficam.
- `AdoptOrphansResult.adopted` diz se a conta era **elegível** (a varredura
  rodou); `skills`/`catalogs` são o que **esta** chamada adotou. A segunda
  chamada devolve `{ adopted: true, skills: 0, catalogs: 0 }` e não audita
  nada; um órfão criado depois é adotado na chamada seguinte.
- Uma transação, atrás de um advisory lock de transação (chave
  `hashtextextended('purple-skills:adopt-orphans', 0)`), com a conta em `FOR
  SHARE` até o fim: logins simultâneos se enfileiram e só o primeiro acha os
  órfãos; um rebaixamento ou uma desativação concorrente espera. Uma conta
  promovida a admin depois da checagem não desfaz a adoção — ela valeu para
  o estado lido. Nenhum índice novo: `skills_owner_user_uuid_idx` (`017`) e
  `catalogs_owner_user_uuid_idx` (`016`) cobrem o `IS NULL`.
- Quem pode disparar é regra do app; o banco confere só a elegibilidade.

**`lookupUsers(q, limit = 10)`** é a busca "Compartilhar com…": contas
**ativas** cujo nome ou **username** contém `q` (`ILIKE`, com o termo
**literal** — ver [O termo de busca](#o-termo-de-busca-literal-e-indexado)),
por nome, `UserLookup[]` (`uuid`, `username`, `name`, `role`). `q` aparado com
menos de dois caracteres devolve `[]` sem consultar; `limit` é clamp 1..50.

O e-mail saiu **dos dois lados** na `033` (`docs/19` decisão 10), e não só da
projeção: devolver só o username mas continuar casando por endereço deixaria
qualquer conta logada descobrir a qual username um e-mail corresponde, bastando
digitá-lo. A sondagem anula o sigilo mesmo com o campo fora da resposta.

**Site.** `listPublicCatalogs()` lista os catálogos públicos e ligados
(`PublicCatalog`: `ownerUsername` e **não** `ownerUserUuid`, sem concessões,
`skillCount` = participações ativas de skills ligadas), por nome. `getPublicCatalog(slug)` é a página:
`PublicCatalogDetail` com `skills` = **todos** os membros ativos como
`SkillSummary` na visibilidade do site (`mcps` só com abertos e ligados,
`catalogs` vazio, `access` nulo), por nome — inclusive os privados e os que
não estão em vMCP aberto nenhum, porque o contêiner expõe (`docs/12`
decisão 5). Privado, desligado ou inexistente é `null`, sem distinção.

**Auditoria** (`docs/12` §8, com o rótulo da `033`): `skill.share` /
`skill.unshare` levam `skill_uuid`/`skill_slug` e `target_label` =
`username:nível` / `username`; `catalog.share` / `mcp.share` levam
`<slug> <username>:<nível>` e `catalog.unshare` / `mcp.unshare` levam
`<slug> <username>` — sem skill, como os demais eventos de contêiner.
Transferir é `update` / `catalog.update` / `mcp.update` do objeto com o
username do novo dono no label (`username` na skill, `<slug> <username>` nos
outros); deixar órfão não muda o label. A adoção (`adoptOrphans`) grava
exatamente isso: `update` com `skill_uuid`/`skill_slug` e o username, ou
`catalog.update` com `<slug> <username>`. Ligar o flag público é um `update`
comum.

Era o **e-mail** em todos esses lugares até a `033`, que reescreveu o que
estava gravado — ver [Username](#username).

**Efeito da `017` numa instalação existente** (`docs/12` §9): leitores
viram membros e **deixam de ver** o que não é deles, público ou exposto;
editores deixam de editar o que não criaram. O admin marca públicas as
skills que devem continuar visíveis, concede `view`/`edit` ou transfere.

### Username

O identificador **público** da conta (`033`,
[`docs/19-username.md`](../docs/19-username.md)). Ele ocupa, em toda superfície,
o lugar que o e-mail ocupava: dono de skill, catálogo e vMCP; linha da ACL e
"concedido por"; quem leu na guia Acessos; a busca de contas; o rótulo
congelado em `audit_log` e em `skill_accesses`; e a ficha pública do site. O
e-mail **continua obrigatório e único**, e volta a ter três usos, todos
privados: entrar, recuperar a senha e casar com a identidade OIDC
(`docs/05` §2.4 e §2.6, que não mudam).

**A forma é de shared, não daqui.** `packages/shared/src/username.ts`
(`normalizeUsername`, `usernameFromName`, `usernameWithSuffix`,
`usernameFromUuid`, `isEmailLogin`, `RESERVED_USERNAMES`) é o único lugar que
decide o que vale; `queries.ts` a chama e a `033` a repete em SQL — uma vez, e
só porque uma migration não chama TypeScript. Em resumo: 3 a 32 caracteres,
`[a-z0-9._-]`, alfanumérico nas pontas, sem duas pontuações seguidas, **sem
`@`**, sem forma de uuid e fora da lista de reservados; a caixa não é
preservada.

**As duas tabelas.** `users.username` é o nome **atual**, único por
`lower(username)` (`users_username_lower_uniq`, por expressão, como o do
e-mail). `usernames` é o livro de tudo que a instalação já gastou: uma linha
por nome, PK em `lower(username)`, `user_uuid` anulável e `released_at`.
Tomar um nome é **inserir** ali — a PK é o que torna a reserva atômica e
permanente.

**Username abandonado nunca volta** (decisão 6). Sem isso o `@joao` de uma
trilha de 2025 poderia ser outra pessoa em 2026, e o rótulo congelado — que
existe justamente para sobreviver à remoção da conta (`004`) — passaria a
apontar para quem não fez nada. Duas consequências que valem ler antes de
mexer no código:

- a linha do livro **nunca é adotada**. A tentação é reaproveitar a que está
  com `user_uuid` nulo e `released_at` nulo, que parece "reservada e nunca
  usada"; ela é também o estado de uma conta **apagada** (a FK é `ON DELETE
  SET NULL`), e adotá-la devolveria a circulação o nome de quem foi embora.
  O `INSERT` é `ON CONFLICT DO NOTHING`, sempre;
- trocar de username **libera** o antigo (`released_at`) e mantém o
  `user_uuid` dele: a linha passa a dizer "foi desta conta e não é de
  ninguém". Nunca é apagada.

**As duas recusas são distintas de propósito.** Quem pede um nome que é de uma
conta **viva** recebe `Já existe uma conta com o username "x"`; quem pede um
que a instalação já gastou recebe `O username "x" já foi usado nesta
instalação`. Quem administra precisa saber se o nome está ocupado agora ou
queimado para sempre.

**As funções.** `getUserByUsername` é irmã de `getUserByEmail`.
`getUserByLogin(identifier)` é o campo único do login (`docs/19` decisão 3):
tem `@`, é e-mail; não tem, é username — decidível porque `normalizeUsername`
recusa `@`. `createUser` exige `username` e grava a linha do livro na mesma
transação; `updateUser` aceita `username` (só admin, e quem confere o papel é
o app) e faz a troca inteira numa transação. `nextFreeUsername(base)` é
leitura — o primeiro nome livre nas **duas** fontes, com o sufixo numérico de
`usernameWithSuffix` — e serve à sugestão do formulário e ao
auto-provisionamento OIDC; base inutilizável é 400, porque a função **não
inventa base**: quem chama decide o fallback (`usernameFromUuid`).
`reserveUsername(candidate, userUuid)` é a irmã que grava, para uma conta que
já existe: na colisão ela numera em vez de recusar.

**O que a `033` fez com o que já estava no banco.** É a migration mais
invasiva desde o `017`, e não tem volta sem backup:

- **backfill do `name`**, nunca da parte antes do `@` — publicar o local part
  para todo o painel vazaria metade do endereço, que é o que a mudança existe
  para evitar. Nome inutilizável, curto demais ou reservado cai em
  `user-<8 hex do uuid>`; colisão (inclusive entre dois `user-<8 hex>` iguais,
  que `uuidv7()` produz em contas criadas no mesmo minuto) recebe sufixo
  numérico;
- **`audit_log` reescrito**: o e-mail vira username em `actor_label` e
  `target_label`, por ocorrência e com fronteira nas duas pontas (os rótulos
  são compostos: `username`, `username:nível`, `<slug> username:nível`,
  `username <resto>`), na ordem **decrescente de `length(email)`** — senão
  `ana@x.com` seria trocado dentro de `mariana@x.com`. O que sobra com forma
  de e-mail vira `conta removida`, e essa varredura é **restrita** a
  `target_label` de `user.*`, `*.share` e `*.unshare` mais `actor_label` de
  qualquer ação: `target_label` de quarentena é nome de envio escrito por
  gente, e um envio chamado `relatorio@2026.q1` não é conta nenhuma;
- **`skill_accesses.user_email` deixou de existir**: virou `user_username`
  (por `user_uuid`, depois por `lower(email)`, o resto `conta removida`), e o
  GIN de trigrama do `022` foi recriado sobre a coluna nova. Leitura **sem
  conta** (site anônimo, vMCP aberto) continua com a coluna nula — `conta
  removida` ali seria inventar uma conta que nunca houve.

Quem mede tudo isso é
[`src/username.integration.test.ts`](src/username.integration.test.ts), sobre
uma base parada no `032`: é o único lugar onde o backfill e a reescrita rodam
sobre dados do mundo antigo.

### Perfil

A página atrás do `@username` (`034`,
[`docs/20-perfil.md`](../docs/20-perfil.md)). O `033` fez do username o
identificador público; aqui ele ganha uma foto, uma bio, um site, links e uma
página no site em `/u/<username>`.

**Duas tabelas, e a separação é o ponto.** `user_profiles` é a parte editável;
`user_avatars` são os bytes. Eles não podem viajar junto com a leitura do
perfil — a página do perfil lê o perfil e a ficha de skill lê o dono, e uma
coluna `bytea` na mesma linha faria toda leitura arrastar até 512 KB para
descartá-los. É a mesma razão de `files.binary_content` (`001`) morar na linha
do arquivo e não na da skill. Separadas, `user_avatars` só é lida pela rota que
serve a imagem, e as duas colunas de perfil que falam de foto (`hasAvatar`,
`avatarUpdatedAt`) vêm de um `LEFT JOIN` que **não cita** `bytes`.

**A linha nasce no primeiro salvamento.** A `034` não cria linha nenhuma: quem
nunca abriu a tela não tem perfil, e `getProfile` devolve o objeto **vazio e
privado** em vez de nulo — "sem perfil" e "perfil em branco" são o mesmo estado
para quem lê. `saveProfile` é `INSERT … ON CONFLICT DO UPDATE`, e o upsert
acontece mesmo quando a chamada só troca o `name`.

**Público é opt-in** (`is_public`, padrão `false`) e decide o que sai para o
**anônimo**, não o que o painel mostra: a foto aparece nas listas e fichas entre
contas logadas com o perfil privado, como o monograma já aparecia.

**O que o banco garante e o que é do shared.** A forma é de
`packages/shared/src/profile.ts` (`normalizeBio`, `normalizeWebsite`,
`normalizeProfileLinks`, `sniffAvatarMime`) — `queries.ts` a chama, nunca a
reescreve, como faz com `normalizeUsername` desde o `033`. Os CHECKs são teto e
lista fechada, a última linha para um caminho de escrita novo: bio ≤ 500,
`website_url` ≤ 512, `links` array de até 8 (`jsonb_typeof` + cardinalidade,
como `virtual_mcps.layout` do `014`), `mime` em PNG/JPEG/WebP, `bytes` entre 1 e
512 KB e `sha256 = sha256(bytes)` — o mesmo CHECK de hash de `rag_texts` (`020`),
aqui porque um ETag que não descreve os bytes servidos é pior do que nenhum
ETag.

**O `sha256` é o ETag.** Ele existe para a rota da imagem responder 304 sem
cache longo — e cache longo é justamente o que deixaria um avatar visível
depois de o perfil virar privado. Os cabeçalhos são de `avatarHeaders`, do
shared, iguais no painel e no site.

**`user.profile` na trilha** é o admin **limpando** o perfil de alguém
(`clearProfile`): bio, site, links e foto saem e o `is_public` desliga. É o
único caminho pelo qual quem não é o dono mexe no perfil, e ele não escreve
texto — o admin apaga, nunca corrige no lugar da pessoa. A edição do **próprio**
perfil não entra na trilha, pelo mesmo critério que mantém o login fora dela
(`docs/05` §2.8).

**`ownerHasProfile`** viaja em `SkillSummary` e em `PublicCatalog`: diz se o
`por @fulano` da ficha vira link para `/u/<username>` ou fica no texto. A
pergunta é exatamente a que `getPublicProfile` responde — perfil público **e**
conta ativa —, porque um link para conta desativada levaria ao 404 que a
desativação acabou de criar. É o **único** dado de perfil que viaja na ficha da
skill.

> **A forma dele foi medida.** Como subconsulta escalar, e não `EXISTS`: o
> planejador trata um `EXISTS` correlacionado por igualdade como *hashed
> SubPlan* e materializa o conjunto inteiro das contas com perfil público uma
> vez por consulta. Na listagem do site (5 000 skills, página de 24) com 50 000
> contas e 50 060 perfis, isso levou a consulta de **3,9 ms** para **10,9 ms**
> (e para 14,1 ms com dois `EXISTS`, perfil e conta separados). A escalar não
> pode ser hasheada, é avaliada por linha e faz 24 buscas no
> `user_profiles_public_idx` em **Index Only Scan** com `Heap Fetches: 0`: 4,2 ms,
> ou **+0,24 ms** sobre a mesma listagem sem a coluna. Com 60 perfis as três
> formas empatam dentro do ruído — a escalar é a única que não piora quando a
> instalação cresce. É para ela que o índice parcial existe.

**O que as leituras públicas recusam.** `getPublicProfile(username)` devolve
`null` para perfil privado, conta desativada e username inexistente, **sem
distinguir os três**: distinguir seria responder "esta conta existe, mas não
quer ser vista", que é a informação que o opt-in existe para não dar. O
`username` que ele devolve é o **canônico** (caixa baixa, como gravado), para o
site montar a chamada seguinte sem propagar a grafia da URL.

**A conferência da rota da imagem é `isProfilePublic(username)`, não
`getPublicProfile`.** As duas respondem à mesma pergunta — e usam o **mesmo**
predicado, `PERFIL_PUBLICO`, e não duas cópias dele —, mas `getPublicProfile`
monta junto as skills e os catálogos públicos da pessoa (com `skillColumns` e
as subconsultas por linha) para devolver a página. Servir uma foto com ela
fazia cada `<img>` pagar a listagem inteira daquela conta: numa conta com 200
skills públicas, abrir a página materializava essas linhas **duas vezes** — uma
para a página, outra para a imagem —, numa rota anônima. É a mesma família do
custo medido em `ownerHasProfile`: trabalho proporcional ao acervo numa
consulta que não precisa dele. Medido com 202 skills públicas na conta:
**4,04 ms** contra **0,37 ms** (mediana de 30 chamadas, ida e volta ao banco
incluídos), e a consulta barata toca 2 páginas — não cresce com o acervo.
`profile.integration.test.ts` prova a diferença **estruturalmente**, com a
tabela `skills` renomeada: quem a lê falha, quem não a lê responde igual.

**As duas leituras de avatar são burras de propósito.** `getAvatar(userUuid)` e
`getAvatarByUsername(username)` **não olham** `is_public` nem `is_active`: o
painel serve a foto a qualquer sessão logada e o site confere
`getPublicProfile` **antes** de pedir os bytes. A política é de quem chama, e
as duas superfícies não têm a mesma política. `getAvatarByUsername` existe para
o site não precisar de `getUserByUsername`, que devolveria hash de senha,
`token_version` e o subject OIDC para desenhar uma imagem.

**`listPublicByOwner(username)`** lista o que a pessoa publicou e o site já
mostrava: as skills pelo mesmo `OPEN_EXPOSURE` das demais leituras do site e os
catálogos pela regra de `listPublicCatalogs`. Estar no perfil **não** torna
nada visível. Ela não filtra `users.is_active` — a conta desativada fica sem
página (quem recusa é `getPublicProfile`), mas o acervo público dela segue no
site como sempre esteve. As duas listas vêm inteiras, sem paginação, como em
`getPublicCatalog`.

**`avatarUpdatedAt` em `UserSummary`.** O carimbo acompanha a conta em toda
leitura de `users`, para uma lista do painel saber se há foto sem uma
requisição por linha. Ele entra em `USER_COLUMNS` por **subconsulta
correlacionada**, e não por `LEFT JOIN`, porque a lista também é usada em
`RETURNING` (onde não há `FROM` para juntar nada) — e porque uma junção ali
convidaria alguém a acrescentar `bytes` ao `SELECT`, que é o que a tabela
separada existe para impedir.

### MCP padrão

`settings` é chave-valor (`key TEXT PRIMARY KEY, value TEXT, updated_at`). A
chave `default_virtual_mcp` guarda o **uuid** do vMCP que responde em `/mcp`,
como texto e **sem FK** de propósito: um vMCP apagado deixa o valor
pendurado, e é assim que `resolveDefaultVirtualMcp` distingue "nenhum padrão"
(chave ausente ou nula) de "o padrão foi removido" (valor sem linha). O
padrão **não tem tratamento especial** no banco: pode ser fechado, desligado
ou apagado como qualquer vMCP.

O backfill do `011` cria o vMCP `public` (ou `public-N`) numa instalação que
já tem skills: sem dono, ligado e aberto, com toda skill `is_public` vinculada
e as flags copiadas de `use_as_*`. Numa instalação sem skills nada é criado;
o `seed` cria o `public` com as skills de exemplo e o marca como padrão.

### Ícone da skill

`skills.icon` (`013`) é **um emoji ou a URL http(s) de uma imagem**; nulo é
o estado normal, e o painel desenha o monograma pelas iniciais. A regra de
forma mora em shared (`isValidSkillIcon` / `normalizeSkillIcon`) e as
queries a aplicam antes de gravar: `undefined` não mexe, `null` ou vazio
apaga, texto válido é o ícone e o resto é 400 ("O ícone precisa ser um
único emoji ou a URL http(s) de uma imagem"). O banco garante só o teto de
512 caracteres (`skills_icon_length_chk`). O ícone não entra no
`search_vector`.

### Canvas do vMCP

O painel desenha cada vMCP como um canvas (`docs/10-admin-canvas-e-sessoes.md`):
o servidor com três portas, as skills vinculadas como nós ligados a ele e o
globo "Internet". As posições são **compartilhadas** entre quem administra
e moram ao lado do que posicionam (`014`):

- `virtual_mcp_skills.pos_x`/`pos_y` — o nó da skill **naquele** vMCP; a
  mesma skill pode estar em outro lugar no canvas de outro servidor. As duas
  nulas é auto-layout (o CHECK exige o par). Caem junto com o vínculo:
  tirar a última aresta remove o nó e o vínculo, e voltar é entrar sem
  posição. `setVirtualMcpSkills` preserva a posição de quem ficou (como
  preserva os contadores); `linkSkill` grava a posição no INSERT e, num
  vínculo que já existe, só quando informada.
- `virtual_mcps.layout` — JSONB com os nós fixos,
  `{"server": {"x", "y"}, "internet": {"x", "y"}}`, cada chave opcional;
  `{}` é auto-layout. O CHECK só exige um objeto; a leitura devolve
  **apenas** `server`/`internet` com `x`/`y` numéricos e ignora o resto, e a
  escrita mescla chave a chave (`||`), sem apagar o que não conhece.

Mover um nó é estado de tela, não publicação: `setVirtualMcpCanvas` **não
audita nem toca `updated_at`**.

Um catálogo vinculado é o quarto tipo de nó (`016`,
[`docs/11-catalogos.md`](../docs/11-catalogos.md) §5): a posição mora em
`virtual_mcp_catalogs.pos_x`/`pos_y`, com o mesmo CHECK de par, cai junto
com o vínculo e é gravada pelo mesmo `setVirtualMcpCanvas`, em
`catalogPositions`. `VirtualMcpDetail.catalogs` traz cada nó com as portas
do vínculo, `position` e `activeSkillCount` — o número do nó.

### Catálogos

Um catálogo (`016`, [`docs/11-catalogos.md`](../docs/11-catalogos.md)) é um
**grupo de skills com dono** que se vincula a um vMCP de uma vez, com uma
escolha de portas só. Uma skill pode estar em vários catálogos; um catálogo
pode estar em vários vMCPs; e um vMCP tem catálogos além das skills diretas.

**Precedência.** Para um par (vMCP, skill), a regra mora na consulta
(`exposedIn` em `queries.ts`, o SQL de `docs/11` §3.2) e é uma só, para
`listSkills`, `getSkillSummary`, `getSkillDetail`, `listTags`,
`listPublishedSkills`, `stats` e `listOpenVirtualMcps`:

- com **vínculo direto** (`virtual_mcp_skills`), valem as portas dele **e
  nada mais** — ele sobrescreve qualquer catálogo. É assim que se restringe
  uma skill num servidor sem tirá-la do grupo; e, ao contrário, um vínculo
  direto só com Prompts numa skill que um catálogo entrega como Tools **tira**
  a skill das ferramentas daquele vMCP;
- sem vínculo direto, valem os catálogos **ligados** em que a skill tem
  participação **ativa** e que estão vinculados ao vMCP; entre catálogos não
  há precedência — as portas são a **união** (`bool_or`).

**As três desativações**, reversíveis e sem apagar vínculo nenhum:

| Coluna | Alcance | Quem edita |
|--------|---------|------------|
| `skills.is_active` | a skill some de **todo** vMCP (direto ou por catálogo) e do site; o painel e o mcp-admin continuam a mostrá-la **a quem a vê** (eles leem pelo `viewer`, que não filtra `is_active`; `'all'` é só do token global e do bootstrap) | `createSkill`/`updateSkill`/`updateSkillWithContent` (`isActive`) — é `update` na skill |
| `catalog_skills.is_active` | a participação: a skill fica no catálogo e não é entregue **por ele** | `setCatalogSkillActive`, `setCatalogSkills` — é `catalog.update` |
| `catalogs.is_active` | o catálogo inteiro deixa de contribuir em todo vMCP; membros e vínculos ficam | `updateCatalog` — é `catalog.update` |

**Contadores.** `recordSkillAccess` (e as antigas `incrementViewCount(skill,
mcp)` / `incrementDownloadCount`, que só somam) somam no global da skill e
**no caminho**: havendo vínculo direto, no vínculo, como antes; sem ele, em
**cada** catálogo que contribuiu (ligado, com participação ativa, vinculado
ao vMCP). Um acesso pelo vínculo direto não soma no catálogo mesmo que a
skill esteja nele — o catálogo não foi o caminho. Pelo mesmo motivo,
`recordSkillAccess` só conta o catálogo que **serve a porta da leitura**
(`tool`/`file`/`download` → `as_skill`; `prompt` e `resource` → a de mesmo
nome), a regra de `exposedIn`: um catálogo vinculado só com Prompts não
entrega um `get_skill`. As duas antigas não recebem a superfície e seguem
somando em todo catálogo vinculado, com qualquer porta — nenhum app as chama
mais. Não há contador por
vínculo catálogo×vMCP. Continua best-effort, sem transação. Desde o `018`
cada leitura também deixa uma linha em `skill_accesses`, com os mesmos
catálogos — ver [Acessos por skill](#acessos-por-skill); a do mcp-admin
deixa só a linha, sem somar.

**Custo de escrita do contador da skill** (`tasks/055`, medido em
2026-09-19). `skills_score_idx` (`012`) é um índice por expressão sobre
`view_count + download_count`, e HOT exige que nenhuma coluna referenciada por
índice mude: **todo incremento em `skills` é um UPDATE não-HOT**, com entrada
nova nos dez índices da tabela — quatro deles GIN, e o do `search_vector`
recebe de novo o léxico inteiro do `SKILL.md`. O atalho de
`skills_search_vector_tg` (`002`) poupa o **recálculo** do vetor, não a
**reinserção** no índice. Em `pg18`, 2 000 skills com `SKILL.md` de 200 a 2 000
palavras, 300 incrementos/s por 4 min (uma transação por incremento, autovacuum
ligado, distribuição enviesada):

| cenário | HOT | WAL por incremento | índices de `skills` (eram 7 MB) |
|---|---|---|---|
| hoje | **0 %** | **49 315 bytes** (79 registros) | 68 MB, 4 passadas de autovacuum |
| sem `skills_score_idx` | 99,5 % | 220 bytes | 12 MB, 1 passada |
| sem o índice + `fillfactor = 70` | 99,4 % | 222 bytes | 11 MB |
| com o índice + `fillfactor = 90` | 0 % | 74 240 bytes | 72 MB |

`fillfactor` não muda nada em nenhum dos dois sentidos (a tupla tem 1–2 KB, e
a poda da página devolve o espaço sozinha). O que o índice rende está na
**leitura**: a ordenação padrão de toda listagem sem termo
(`(view_count + download_count) DESC, updated_at DESC LIMIT n`) para nas
primeiras linhas visíveis em vez de avaliar o recorte de visibilidade no acervo
inteiro. Página 1 do site, só a consulta da página (o `count(*)` é igual nos
dois casos):

| skills | com o índice | sem, `jit=off` | sem, `jit` padrão |
|---|---|---|---|
| 2 000 | 0,32 ms | 2,6 ms | 2,1 ms |
| 10 000 | 0,38 ms | 9,1 ms | 39 ms |
| 52 000 | 0,56 ms | 54–78 ms | **396 ms** |

**Decisão: o índice fica**, e nenhuma migration saiu daqui. Derrubá-lo troca
um custo de fundo (WAL e inchaço de GIN, numa escrita que ninguém espera) por
uma regressão que o visitante vê e que cresce com o acervo — a listagem padrão
fica de 2 a 3,5 vezes mais lenta, e a partir de ~10 mil skills a consulta sem
índice cruza `jit_above_cost` e paga compilação, o mesmo defeito de estimativa
de [O termo de busca](#o-termo-de-busca-literal-e-indexado). O desenho que fica
com os dois lados foi medido e está **pendente, como tarefa própria**: o índice
de ordenação numa tabela estreita (`skill_uuid`, `score`), mantida por trigger,
com `listSkills` ordenando por ela num `JOIN`. Medido: `skills` 99,5 % HOT
(309 bytes), a estreita 250 bytes por incremento e parada em 1,3 MB — **~560
bytes contra 49 315** —, e a página dirigida pelo índice dela nas cinco
variantes de recorte, em 0,2–0,4 ms. Ele mexe no `FROM` da consulta principal e
exige que toda skill tenha a sua linha (o `JOIN` é interno, senão o planejador
não dirige pelo índice): não é correção de uma linha. O custo da migration
nunca foi o obstáculo — `DROP INDEX` é metadado, pede `ACCESS EXCLUSIVE` em
`skills` por um instante e não reescreve nada, e `fillfactor` só valeria para
páginas novas sem um `VACUUM FULL` (que trava a tabela inteira) —; o obstáculo
é a leitura. Até lá vale a regra: **nenhum índice novo toca
`view_count`/`download_count` sem medição**.

**As queries** (mesmo padrão de `virtual_mcps`: ator obrigatório, `FOR
UPDATE` nas declarativas, `updated_at = now()` nas escritas que mudam o
objeto, auditoria com `targetLabel` = slug do catálogo; **a permissão é do
app** — criar é `canCreate` de shared, o resto é o nível da conta no objeto
(`accessLevel` + `canView`/`canEdit`/`canManage`/`canOwn`, ver
[Acesso granular](#acesso-granular)); **vincular** catálogo↔vMCP é `edit` no
vMCP **e** `view` no catálogo, e **desvincular** é só o `edit` do vMCP —
`docs/12` decisão 7):

> **Era**, até o `017`: "`canCreateCatalog` / `canManageCatalog` de shared, e
> vincular catálogo↔vMCP exige administrar **os dois**" (`docs/11` decisão 7 e
> §3.4). Revogado pela decisão 7 do `docs/12`; os dois helpers continuam
> exportados, `@deprecated`. Quem implementar a regra antiga responde 403 a quem
> tem `edit` legítimo no servidor (`tasks/060`).

- `listCatalogs()` sem opção é a visão do admin (todos, inclusive desligados
  e órfãos); `{ viewer }` é o que a conta vê e `{ scope }` o filtro do
  painel (ver [Acesso granular](#acesso-granular)); `{ ownerUserUuid }`
  restringe ao dono; `{ ownerUserUuid: null }` devolve `[]`. `CatalogSummary`
  traz `isPublic`, `access`, `skillCount` (membros), `activeSkillCount`
  (participação ativa **e** skill ligada — o que um vMCP recebe), `mcpCount`
  e os contadores.
- `getCatalog(slug, { viewer? })` / `getCatalogByUuid(uuid, { viewer? })`
  devolvem `CatalogDetail`: resumo + `skills` (`CatalogSkill`: `isActive` é a
  participação, `skillIsActive` é a skill — o alerta da lista — e `addedAt`)
  + `mcps` (`CatalogMcpRef`, com as portas do vínculo) + `grants`. Incluem
  inativos: é o painel que lê. Com `viewer` que não é admin, `null` fora do
  que a conta vê — e as duas listas vêm **recortadas pela conta** (`tasks/010`):
  `mcps` só com os vMCPs que ela vê (aberto e ligado, dela ou concedido a ela —
  a regra da lista `mcps` da skill, que vale inclusive para o dono do catálogo)
  e `skills` só com os membros que ela consegue abrir. Dono e concessão no
  catálogo leem todo membro; quem chega só pelo "público" lê a participação
  **ativa** (`docs/12` §3.1) e o que alcança por outra rota. `mcpCount` e
  `skillCount` continuam **globais**: `mcpCount` é o número da confirmação de
  exclusão do painel, e a diferença para o tamanho da lista é o "e mais N que
  você não vê". As **escritas** de catálogo releem sem `viewer` e devolvem a
  visão do admin — recortar antes de responder a quem só tem `edit` é do app
  (nenhuma delas mexe em vínculo com vMCP: o `mcps` da leitura prévia vale).
- `createCatalog({ slug?, name, description?, isPublic?, ownerUserUuid },
  source, actor)` audita `catalog.create`. Slug omitido é gerado do nome;
  informado passa por `isValidSlug`; em uso é 409. `updateCatalog(uuid, {
  slug?, name?, description?, isActive?, isPublic?, ownerUserUuid? })` é
  parcial no padrão de `updateVirtualMcp` e audita `catalog.update` (com
  `<slug> <username>` numa transferência — as regras estão em
  [Acesso granular](#acesso-granular)); `deleteCatalog` audita
  `catalog.delete` e a cascata leva membros, vínculos e concessões.
- `setCatalogSkills(uuid, [{ slug, isActive? }])` é **declarativa**: quem
  saiu é removido; quem entrou é inserido com `isActive` (ou ativo, se
  omitido); quem ficou tem a participação reescrita **só** se `isActive`
  veio — omitido não mexe, e um re-salvar não religa o que alguém desativou.
  Slug desconhecido ou repetido é 400 e nada muda.
- Um membro de cada vez: `addCatalogSkill(uuid, skillSlug)` (idempotente —
  já membro fica como está e não audita; skill desconhecida é 404),
  `removeCatalogSkill(uuid, skillSlug)` e `setCatalogSkillActive(uuid,
  skillSlug, isActive)` (404 se não é membro). Todos devolvem
  `CatalogDetail` e auditam `catalog.update`.
- Pelo lado do vMCP: `linkCatalog(virtualMcpUuid, catalogUuid, flags, source,
  actor, { position? })` cria ou reescreve o vínculo no padrão de `linkSkill`
  (posição no INSERT e, num vínculo existente, só quando informada);
  `unlinkCatalog(virtualMcpUuid, catalogUuid, source, actor)` desfaz (404 se
  não vinculado); `setVirtualMcpCatalogs(uuid, [{ slug, asSkill, asPrompt,
  asResource }])` é a declarativa, no padrão de `setVirtualMcpSkills`
  (posição de quem ficou preservada; três flags obrigatórias). Os três
  devolvem `VirtualMcpDetail` e auditam `mcp.update` no servidor, com o slug
  dele — vincular um catálogo é mudar o que o servidor entrega, como com
  skill.
- `VirtualMcpSummary.catalogCount` conta os vínculos de catálogo;
  `skillCount`/`toolCount`/`promptCount`/`resourceCount` continuam contando
  **só os vínculos diretos**. `listOpenVirtualMcps().skillCount` — o número
  do site — conta as skills ligadas expostas por qualquer caminho **naquele
  servidor**. `stats().openSkills` é mais largo: ele conta pelo `OPEN_EXPOSURE`,
  a regra do site inteira (skill ligada que é pública, **ou** está em vMCP
  aberto e ligado, **ou** tem participação ativa em catálogo público e ligado),
  então **não** é a soma dos `skillCount` — uma skill pública sem vMCP nenhum
  entra nele e em nenhum deles. `unlinkedSkills` é quem não tem vínculo direto
  **nem** catálogo.

O `seed` cria o catálogo `exemplos` com todas as skills de exemplo como
membros ativos e **sem vínculo com vMCP nenhum**: ele existe para o painel
mostrar o que é um catálogo, e não publica nada até alguém vinculá-lo.

### Sessões do MCP público

`mcp_sessions` (`015`) tem **uma linha por cliente conectado a um vMCP**.
Nos transportes com sessão (Streamable HTTP, SSE) a linha nasce no
`initialize` e termina quando o cliente fecha, o TTL vence ou o servidor
para. No stateless não há sessão: o servidor calcula uma chave sintética
(hash de IP + agente + credencial + vMCP) e agrupa numa linha as requisições
de um mesmo cliente enquanto elas chegam dentro da janela; depois de um
restart, `findOpenMcpSession` reencontra a linha aberta em vez de abrir
outra. `session_id` **não é único**: o histórico de duas linhas da mesma
sessão vale.

| Conceito | Regra |
|----------|-------|
| online | `ended_at IS NULL AND last_seen_at >= now() - janela`. Não é coluna: a janela (`MCP_SESSION_ONLINE_WINDOW_MS`) é do app e vem por chamada; uma coluna envelheceria entre duas varreduras |
| fim real | `closed` (o cliente fechou) ou `shutdown` (o servidor parou), com `ended_at = now()`. O primeiro fim é o que fica: uma linha encerrada não é tocada por `touch` nem por outro `close` |
| fim presumido | `timeout`, gravado por `expireMcpSessions`: stateless sem atividade além da janela do stateless, streamable/sse além do TTL da sessão. `ended_at` é `last_seen_at` **mais o prazo** — quando a sessão deixou de estar online, não quando a varredura rodou |
| histórico | `virtual_mcp_uuid` e `key_id` são `ON DELETE SET NULL`; `virtual_mcp_slug` é cópia e `auth` continua dizendo se houve chave. Apagar o vMCP não apaga o que aconteceu nele |
| poda | **nenhuma.** Decisão: nunca apagar. Não há job, trigger nem retenção; se um dia for preciso, é uma migration com a política escrita, não um DELETE numa query |

Os índices parciais `(last_seen_at) WHERE ended_at IS NULL` e `(session_id)
WHERE ended_at IS NULL` cobrem a varredura, o contador de online e o reuso
de linha do stateless; as encerradas, que viram a maioria, ficam fora deles.

### Acessos por skill

`skill_accesses` (`018`, `docs/13-fichas-e-acessos.md`) tem **uma linha por
leitura de uma skill** — é a guia "Acessos" da ficha da skill e da do
catálogo. Os contadores (`view_count`/`download_count` da skill, do vínculo
e do catálogo) continuam existindo e são somados na mesma escrita; a linha é
o que diz *quem*, *por onde* e *quando*.

| Conceito | Regra |
|----------|-------|
| quem grava | o MCP público (`origin = 'mcp'`: `get_skill` → `surface = 'tool'`, `resources/read` → `'resource'`, `prompts/get` → `'prompt'`, o `SKILL.md` avulso → `'file'`, o pacote → `'download'`), o site (`'site'`: `'page'`, `'file'`, `'download'`) e o mcp-admin (`'mcp-admin'`: `'admin-tool'`). O painel **não** grava |
| `kind` | `view` ou `download` — o contador que a leitura soma. **Exceção:** com `origin = 'mcp-admin'` a linha entra e **nenhum** contador é somado (skill, vínculo ou catálogo): o `get_skill` do mcp-admin nunca contou, e a pontuação do acervo não muda de significado por a leitura passar a ser registrada |
| `auth` | `open` (vMCP aberto), `key` (chave `psv_`, em `key_id`/`key_name`), `user` (chave `psk_` em `api_key_id`/`api_key_name` e a conta em `user_uuid`/`user_username`) ou `anonymous` (o site) |
| caminho | com vMCP, os catálogos por onde a skill chegou a ele **nesta leitura** — os mesmos que recebem o contador: ligados, com participação ativa, vinculados ao vMCP **com a porta da superfície lida** (`tool`, `file` e `download` pela de skill; `prompt` e `resource` pela de mesmo nome — a regra de `exposedIn`), e só sem vínculo direto (a precedência não olha porta). Três arrays paralelos (`catalog_uuids`/`_slugs`/`_names`), vazios no vínculo direto, no site e no mcp-admin. As linhas gravadas antes dessa regra (`tasks/041`) trazem todo catálogo vinculado, com qualquer porta, e não há como recalculá-las |
| rótulos e cópias | o que vem do cliente (`session_id`, `ip`, `user_agent`, `client_name`, `client_version`) passa por `normalizeSessionLabel`: caractere de controle vira espaço — o `text` não guarda U+0000, e o byte nulo no `clientInfo` derrubava a linha **e** os contadores —, apara, vazio vira nulo, teto de `MCP_SESSION_LABEL_MAX` (512). As **cópias de nome** (skill, vMCP, chave `psv_`, chave `psk_`, cada catálogo) são cortadas no mesmo teto: nome não tem limite na criação e a linha é copiada a cada leitura. Nos dois casos **cortar, nunca recusar** — não há `CHECK` de tamanho de propósito, porque o registro vale mais do que o campo |
| histórico | toda FK (`skill_uuid`, `virtual_mcp_uuid`, `key_id`, `api_key_id`, `user_uuid`) é `ON DELETE SET NULL` e tem a **cópia** ao lado (`skill_slug`/`skill_name`, `virtual_mcp_slug`/`virtual_mcp_name`, `key_name`, `api_key_name`, `user_username`). Apagar o objeto não apaga a leitura; o uuid nulo é o que diz que ele sumiu. Os arrays de catálogo não têm FK: o uuid fica, e a **listagem** o devolve nulo quando o catálogo já não existe |
| poda | **nenhuma**, como `mcp_sessions`: sem job, trigger nem retenção |

Os índices `(skill_uuid, created_at DESC)`, `(virtual_mcp_uuid, created_at
DESC)`, `(user_uuid, created_at DESC)` (`019`, a guia da conta) e
`(created_at DESC)` cobrem as guias e uma lista global; o GIN sobre
`catalog_uuids` cobre a guia do catálogo (`@> ARRAY[uuid]`, com a ordenação
feita sobre o resultado — barato no volume esperado; se um dia não for, é
uma tabela de junção com `(catalog_uuid, created_at)`, numa migration). O
`022` acrescenta seis GIN de trigrama, um por coluna do `q` — ver
[O termo de busca](#o-termo-de-busca-literal-e-indexado); são ~290 bytes por
linha, dois terços deles de `session_id`, numa tabela sem poda.

### Atividade

A tela de Atividade (`032`, [`docs/18-atividade.md`](../docs/18-atividade.md))
é uma grade de dias e o **relatório agregado** de um deles. Ela junta quatro
fontes: três que já existiam e nunca tinham sido lidas por dia —
`mcp_sessions` (quem se conectou), `skill_accesses` (o que foi lido) e
`audit_log` (o que mudou no catálogo) — mais `mcp_call_counters`, que nasceu
com ela.

O que faltava era **o que foi chamado**: o MCP público atende `tools/call`,
`resources/read`, `prompts/get`, os três métodos da SEP-2640 e o vaivém de
`initialize`/`ping`/`notifications/*`, e o único rastro disso era
`mcp_sessions.request_count` — um número por sessão, que soma tudo e não
distingue método nenhum.

| Conceito | Regra |
|----------|-------|
| contador, não registro | a menor unidade é "quantas vezes". Nenhuma coluna guarda nome de tool, argumento, IP, e-mail ou `session_id`. Uma linha por chamada custaria a escrita no caminho quente (é uma linha por **mensagem** JSON-RPC, `ping` incluído) para guardar o que o relatório não mostra; quem precisa do evento a evento tem a trilha, as sessões e a guia de acessos da skill |
| balde de 15 min | `bucket` é o início de um balde de `MCP_CALL_BUCKET_MS` (shared), calculado pelo app e **achatado de novo** na gravação. Quinze minutos é o maior passo que ainda recorta o dia em **qualquer** fuso: todo deslocamento IANA é múltiplo de 15 min (o +05:45 do Nepal é o extremo). Com balde de uma hora, um relatório em Katmandu somaria 45 minutos do dia vizinho; com balde diário, o fuso teria de ser congelado na gravação e o número nunca fecharia com o das outras três fontes, que são instantes exatos |
| chave do UPSERT | `(bucket, virtual_mcp_slug, transport, method)` — pelo **slug**, e não pelo uuid: `virtual_mcp_uuid` é `SET NULL`, coluna de PK não aceita nulo e, mesmo num UNIQUE, NULL nunca conflita com NULL. Pelo uuid, cada flush posterior à remoção do vMCP inseriria linha nova em vez de somar, e o relatório contaria em dobro justo onde a cópia deveria segurar o histórico |
| `family` | derivada de `method` por `mcpCallFamily` (shared) e **gravada junto**: o relatório agrupa por ela sem reimplementar a regra em SQL, e a regra mora num lugar só. O preço é a classificação congelada na gravação — reclassificar é um `UPDATE` numa migration, com a história dita, e não uma mudança silenciosa de sentido nos números antigos |
| `method` | texto de terceiro: é **limpo e cortado** em `MCP_CALL_METHOD_MAX` (128), nunca recusado. Um `CHECK` violado derrubaria a statement inteira do flush — que é um INSERT com várias linhas — e levaria junto as chamadas de todos os outros servidores daquele despejo (o defeito de `tasks/038`). Saem as categorias `Cc` (o `text` recusa U+0000 com 22021 antes de olhar a consulta) e `Cf` — o override bidi U+202E, o espaço de largura zero U+200B e o BOM U+FEFF: invisíveis, eles inverteriam a leitura da tela e fariam dois métodos idênticos aos olhos nunca somarem na mesma linha, porque o agrupamento é por igualdade de bytes. Um método JSON-RPC é identificador de máquina e não tem uso legítimo para nenhum deles; o rótulo de `clientInfo` tem (ZWJ e ZWNJ montam emoji e ligam letras em persa e em hindi) e continua só com `Cc` — ver `callMethod`. O corte também mantém a linha longe do limite de tupla do btree, que `method` sendo parte da PK torna alcançável |
| histórico | `virtual_mcp_uuid` é `ON DELETE SET NULL` e o slug é a cópia, como `015` e `018`. O flush resolve o uuid por `LEFT JOIN`: um servidor apagado entre a chamada e o despejo faria a FK recusar o INSERT (23503) e o lote inteiro se perderia; assim a linha entra com o uuid nulo e o slug |
| poda | **nenhuma**, como `mcp_sessions` e `skill_accesses`. Aqui é barato por construção: o número de linhas por dia é 96 baldes × vMCPs × transportes × métodos distintos, e não cresce com o tráfego |

Os índices: a PK serve ao `ON CONFLICT` do flush; `(bucket DESC)` é a faixa do
heatmap e a do relatório; `(virtual_mcp_uuid)` é só a varredura do `SET NULL`,
porque a PK começa por `bucket` e não acha as linhas de um servidor. Em
`mcp_sessions`, a `032` acrescenta `(started_at DESC)` — a série conta sessões
**abertas** no dia, e só havia índice por `last_seen_at` — e `(ended_at DESC)`,
para o relatório contar as **encerradas** nele. O custo de escrita do segundo é
pequeno perto do que a tabela já paga: `last_seen_at` é indexado e sobe a cada
requisição, então todo `UPDATE` de sessão já é não-HOT.

**O dia é o de quem olha.** O painel converte o dia do calendário do navegador
em dois instantes e manda `since`/`until`; o fuso IANA só acompanha a
**série**, porque é lá que o SQL agrupa por dia. As quatro fontes são sempre
filtradas por instante (`coluna >= since AND coluna <= until`) e só então
agrupadas por `(coluna AT TIME ZONE tz)::date` — na ordem inversa o índice
morreria e cada leitura varreria a tabela inteira.

### Busca semântica (RAG)

A `020` acrescenta a metade vetorial da busca
([`docs/14-rag.md`](../docs/14-rag.md)). A regra que organiza tudo é o
**espaço de embedding**: a
combinação (driver, modelo, dimensões, prefixo de documento, prefixo de
consulta). Vetores de espaços diferentes nunca se misturam numa consulta, e
**o prefixo entra na identidade** porque no `gemini-embedding-2` a tarefa vai
escrita no próprio texto enviado — trocar o prefixo muda todo vetor, como
trocar o modelo. Não há número de versão de receita: com o prefixo na
identidade, editar o prefixo e esquecer de subir a versão é impossível.

| Conceito | Onde mora |
|----------|-----------|
| **texto canônico** | `rag_texts`, endereçado pelo próprio SHA-256 (32 bytes) e guardado **sem** o prefixo. O `CHECK` recalcula o hash: um texto nunca fica sob o hash de outro, e um texto com o prefixo colado é recusado. Duas skills com o mesmo conteúdo dão uma linha só e um vetor por espaço |
| **ocorrência** | `rag_skill_texts`, PK `(skill_uuid, source, relative_path, part)`. `source` é `meta` (nome + descrição + tags, sem arquivo) ou `file` (uma parte de um arquivo, com `file_id`). Cai com a skill e com o arquivo (`CASCADE`); `text_sha256` **não** tem cascata — texto em uso é protegido |
| **vetor** | `rag_vectors`, PK `(space_uuid, text_sha256)`. `dimensions` vem do espaço pela FK composta e o `CHECK` confere `vector_dims(embedding)`. A busca é **exata**, sem índice: o HNSW do pgvector para em 2000 dimensões e o modelo tem 3072 |
| **pendência de skill** | `skills.rag_stale`, marcada por trigger em skill (nome, descrição), arquivo (texto e caminho, nunca binário — e a **troca** binário ↔ texto com o conteúdo igual, desde a `027`: o hash é dos bytes e não a enxerga) e tag. Contador não marca. Quem limpa é o indexador, ao reservar |
| **reserva de skill** | `rag_skill_claims` (`028`): a linha nasce na reserva, com prazo, e some quando o trabalho termina. É o que impede o lote de um indexador morto de ficar "feito" para sempre. Ver [A fila de skills](#a-fila-de-skills-reserva-com-prazo) |
| **pendência de texto** | um anti-join: texto com ocorrência e sem vetor no espaço ativo (`listPendingRagTexts`), **menos** o que está recusado ou reservado (`rag_text_status`, `025`) |
| **estado na fila** | `rag_text_status`, PK `(space_uuid, text_sha256)`: `reservado` até `until` (alguém está pagando por ele agora) ou `recusado` sem prazo (o provedor não aceita o conteúdo). Ver [A fila de textos](#a-fila-de-textos-recusa-e-reserva) |
| **hash do arquivo** | `files.content_sha256`, por trigger (coluna gerada não serve: `convert_to` é STABLE). Num arquivo que cabe inteiro num texto, é o **mesmo** hash de `rag_texts` |

O indexador (container próprio, fora de `database/`) reserva um lote com
`claimStaleSkills`, que marca a skill como limpa **antes** de ler o conteúdo:
uma mudança feita durante o processamento volta a marcá-la pelo trigger, e
nada se perde; uma falha chama `releaseStaleSkill`. A reserva usa CTE
`MATERIALIZED` com `FOR UPDATE SKIP LOCKED` — dois indexadores em paralelo
pegam lotes diferentes — e, desde a `028`, é **gravada com prazo**: ver
[A fila de skills](#a-fila-de-skills-reserva-com-prazo).

### A fila de skills: reserva com prazo

Até a `028` a reserva era só o `rag_stale = false`, commitado antes do
trabalho. A única memória de que o lote ainda precisava ser refatiado era uma
variável do indexador — e processo morto no meio do lote (SIGKILL, OOM, o
Postgres reiniciando e levando junto a devolução do `catch`) deixava as skills
restantes marcadas como feitas para sempre, com o painel mostrando "0 skills a
refatiar". A `025` já tinha escrito o argumento para a fila vizinha: indexador
morto não estaciona a fila, e é por isso que a reserva tem prazo.

`rag_skill_claims` tem uma linha por skill **reservada e ainda não terminada**:

| Quem | O que faz com a linha |
|------|-----------------------|
| `claimStaleSkills(limit, { claimMs? })` | grava, junto com o `rag_stale = false`, com `until = now() + claimMs` (padrão 10 min, clamp 1 s .. 1 h) |
| `readSkillForRag(uuid)` | soma uma **tentativa** — é o "comecei" do indexador |
| `replaceSkillTexts(uuid, …)` | apaga: gravar é terminar. **Depois** do commit, em statement própria |
| `releaseStaleSkill(uuid)` | remarca a skill e apaga: a rodada seguinte a pega, sem esperar o prazo |
| remover a skill | apaga, pela cascata |

O que sobra depois de `until` é, por construção, a reserva de quem não terminou,
e entra no lote seguinte mesmo com `rag_stale = false`. Quatro regras:

- **reserva viva segura a skill**, inclusive a que o trigger remarcou durante o
  processamento: um indexador por skill de cada vez. Sem isso duas réplicas
  podiam ler versões diferentes e a mais lenta gravar a antiga por cima da nova.
  Quando a primeira termina, a pendência que o trigger deixou traz a skill de
  volta na rodada seguinte;
- **a ordem devolvida é a de processamento**: primeiro as pendentes, depois as
  de reserva vencida, por tentativas. A skill que derruba o processo cai no fim
  do lote, depois de as companheiras terem sido gravadas. Na **escolha** é o
  contrário — as vencidas têm prioridade, porque são poucas e já esperaram o
  prazo inteiro, e um acervo recém-marcado para reindexar não pode deixá-las
  para depois;
- **a tentativa é contada na leitura, não na reserva.** Contar na reserva puniria
  as companheiras de lote, que venceram junto sem nunca terem sido abertas. Com
  `RAG_CLAIM_MAX_ATTEMPTS` (3) leituras começadas e nenhuma terminada, a reserva
  vencida deixa de ser retomada e a skill **aparece** em
  `ragCoverage().stuckSkills`, em vez de sumir. É o que impede o prazo de virar
  *crash-loop*: antes, por acidente, a skill que derrubava o indexador saía da
  fila na reserva e nunca mais voltava. Conteúdo novo (o trigger) e o
  "Reindexar" recomeçam a conta;
- **`ragCoverage().staleSkills` conta as duas coisas** — a pendente e a reservada
  não terminada —, com `stuckSkills` dentro dele.

Por que tabela e não duas colunas em `skills`: baixar a reserva no sucesso seria
mais um `UPDATE` na linha da skill por skill processada, numa tabela em que a
ordem de travas já custou um deadlock medido (`FOR UPDATE` na skill ×
`files_rag_stale_trg`). Aqui a statement de reserva **nunca espera** por linha de
`skills` (`SKIP LOCKED`), a baixa e a devolução seguram uma trava só cada, e é
por isso que nenhuma delas fecha ciclo com quem grava arquivo. Medido com dois
indexadores, dois escritores (`setFile`, `setFiles`, `updateSkill`) e
"Reindexar" concorrentes, com mortes simuladas: ~5 mil reservas, ~10 mil skills
refatiadas e ~10 mil escritas, zero deadlock, zero entrega dupla e nada perdido
depois de drenar. Nenhum índice além da PK: a tabela fica vazia entre dois
ciclos.

**Limpeza de órfãos: a do indexador, e só ela.** Texto sem ocorrência nenhuma
(o que sobra de uma skill editada ou apagada) é apagado por
`collectOrphanRagTexts`, chamada uma vez por ciclo, **depois** de embutir; os
vetores e o estado de fila dele vão pelas cascatas de `rag_vectors` e de
`rag_text_status`. Foi o que a `020` deixou escrito como "limpeza futura", e é a
única poda do banco — `mcp_sessions` e `skill_accesses` continuam sem nenhuma.
Não há job nem trigger: quem apaga é o indexador, num `LIMIT`, e a política está
aqui em vez de estar num cron.

Duas coisas que a coleta assume:

- **texto em uso é intocável.** O anti-join é sobre `rag_skill_texts`, e a FK
  sem cascata (`020`) é a rede de segurança: uma ocorrência gravada no meio do
  caminho faz o `DELETE` falhar, e a falha é lida como "não coletei" — o lote
  fica para a rodada seguinte. O `FOR UPDATE SKIP LOCKED` deixa de fora o texto
  que outra transação já travou;
- **a janela que ela abre é fechada em `insertRagVectors`.** Entre a leitura da
  fila e a volta do provedor, um texto pode ter sido coletado; a gravação faz
  `JOIN rag_texts` e simplesmente ignora o hash que sumiu, em vez de perder o
  lote inteiro pela FK.

### A fila de textos: recusa e reserva

A `025` dá memória à fila de `listPendingRagTexts`, que era um anti-join puro —
sempre na mesma ordem (`created_at`) e sem reserva. Os dois furos que isso
deixava, os dois vistos rodando:

- **o texto que o provedor recusa nunca saía da fila.** Entrada longa demais é
  400 no `gemini-embedding-2`; aquele texto continuava sendo o mais antigo sem
  vetor para sempre, voltava a cada ciclo e nada atrás dele chegava a ser
  tentado. O indexador passou a guardar a recusa **em memória do processo**, o
  que destravava a fila e se perdia no restart;
- **duas réplicas pagavam pelo mesmo embedding.** As duas liam a mesma fila e a
  segunda gravação caía no `ON CONFLICT DO NOTHING`, com o dinheiro já gasto.
  `FOR UPDATE SKIP LOCKED` na leitura **não** resolve isso: o bloqueio morre no
  fim da transação da leitura, e a chamada ao provedor é fora dela. O que
  resolve é uma marca **gravada**, como o `rag_stale = false` de
  `claimStaleSkills`.

Os dois são estado do par (espaço, texto) — um texto recusado num modelo pode
ser aceito por outro — e moram na mesma tabela, em **um** de dois estados:

| Estado | Como se lê | O que significa |
|--------|-----------|-----------------|
| reservado | `until IS NOT NULL` | alguém está pagando por este texto agora. Vencido o prazo, ele volta à fila: indexador morto não estaciona a fila |
| recusado | `until IS NULL`, com `reason` | o provedor recusou o conteúdo de vez. Sem prazo — insistir é pagar por um erro garantido |

- **a reserva é gravada pela própria leitura.** `listPendingRagTexts(space,
  limit, { reserveMs })` lê e reserva numa statement só: não há janela entre
  "vi que estava livre" e "marquei como meu". Quem perde a corrida recebe só o
  que sobrou, e a chamada tenta **uma** segunda vez para alcançar o que está
  atrás na fila. Sem `reserveMs` a consulta é leitura pura, como antes;
- **quem encerra a reserva é o vetor.** `insertRagVectors` apaga a linha
  `reservado` de todo hash do lote, tenha o vetor entrado ou já estado lá:
  daí em diante quem exclui o texto da fila é o próprio `rag_vectors`. Sem
  isso a tabela cresceria até ter uma linha por texto;
- **a recusa é para sempre** (naquele espaço) e não é tocada por gravação
  nenhuma. Recusar duas vezes o mesmo texto não reescreve a linha: `reason` e
  `created_at` são os da recusa que tirou o texto da fila. `ragCoverage`
  devolve `refusedTexts` para o painel explicar a cobertura que não fecha — o
  número está **dentro** de `pendingTexts`, porque a pendência é real;
- **quem desiste do lote devolve a reserva.** Eram só duas as saídas — o vetor
  gravado e o vencimento —, e o indexador **vivo** que falhava (chave, cota, 5xx,
  prazo estourado) segurava os 64 textos por dez minutos: o ciclo seguinte
  reservava os 64 de trás, falhava de novo, e com a fila inteira reservada
  passava a publicar "sem erro" com centenas de textos sem vetor.
  `releaseRagTextReservations(space, hashes)` apaga as linhas `reservado` dos
  hashes dados — a fatia que falhou **e** os lotes que nem foram tentados — e
  eles voltam no ciclo seguinte. Com `{ retryAfterMs }` (clamp 1 s .. 24 h) a
  reserva **fica**, com o prazo novo: é o estado entre "tente já" e "nunca
  mais", para o 400 sem prova de que o problema é o conteúdo e para o
  `Retry-After` do limite de taxa. A reserva não tem dono: devolver depois de o
  próprio prazo ter vencido pode baixar a que a réplica vizinha acabou de tomar,
  e o pior caso é o de antes da `025` — dois pagam pelo mesmo texto;
- **a recusa só se desfaz à mão.** `clearRagRefusals(space, source, actor)` apaga
  as recusas de **um** espaço e audita (`rag.reindex`, com `"<n> recusas"`). É
  reparo, não expiração: existe para o dia em que a marca foi gravada por
  engano — os três drivers jogam todo 400 residual em "recusa de conteúdo", e um
  400 que é da instalação (URL base num proxy, contrato da API, conta) marca o
  acervo inteiro. "Reindexar" não limpa (mesmo texto, mesmo hash, mesma
  recusa), reiniciar o indexador também não. O que for recusa genuína é
  recusado uma vez mais e remarcado. **Quem grava recusa precisa de prova** de
  que o problema é o conteúdo — o provedor aceitou outro texto nas mesmas
  condições —; sem ela, o caminho é o adiamento acima;
- **trocar de modelo começa com a fila vazia**, e não por cascata: a troca
  **cria** um espaço e o estado é por espaço; o anterior fica inteiro, com as
  reservas e recusas dele, pronto para quem voltar atrás (`docs/14-rag.md` §10).
  A cascata de `rag_spaces` é defensiva — nenhum caminho de produção apaga
  espaço. E um texto recusado que fica órfão perde a marca quando é coletado —
  se o mesmo conteúdo voltar ao acervo, o provedor o recusa uma vez mais.

Nenhum índice novo além da PK `(space_uuid, text_sha256)`, que é o que a
exclusão da fila usa, e de `rag_text_status_text_idx`, que serve à cascata
vinda de `rag_texts` na coleta de órfãos.

### Quarentena

Um **envio** (`030`, [`docs/15-quarentena.md`](../docs/15-quarentena.md)) é o
pacote que chegou por importação de `.zip`/`.skill` e espera aprovação: uma
pasta de arquivos com dono, fora do acervo. `quarantine_skills` é o envio,
`quarantine_files` são os arquivos dele, e a promoção transforma os dois numa
skill de verdade — que é o único jeito de esse conteúdo chegar ao acervo.

**O que ela não tem, e a ausência é o desenho:** slug, tag, ícone,
`is_active`, `is_public`, vínculo com vMCP ou catálogo, contador, concessão
(`*_grants`), `search_vector` e RAG. O **destino** do `035` não desfaz isso: é
o que a aprovação vai criar, não um vínculo — ver [O destino](#o-destino). Três
consequências que valem antes de qualquer mudança aqui:

- **não há colisão de nome.** `name` é rótulo — lido do `name:` do `SKILL.md`
  ou do nome do arquivo enviado —, não é único e não vira slug: dois envios do
  mesmo pacote convivem, que é o caso esperado de quem recebe duas versões e
  quer abrir as duas antes de escolher. A identidade é o `uuid` (`uuidv7()`,
  como o resto do banco) e é por ele que o painel endereça o envio;
- **a quarentena não sofre RAG.** Nenhuma coluna de RAG (sem `rag_stale`, sem
  `content_sha256`), nenhum trigger de pendência e nenhuma linha em `skills` —
  os triggers do `020` (e a função que o `027` redefiniu) estão presos a
  `files`, `skills` e `skill_tags`, e o indexador varre `skills`. O hash existe
  para reaproveitar vetor; sem RAG, seria coluna que ninguém lê. O único
  trigger das tabelas novas é `quarantine_files_touch_trg`, que carimba
  `quarantine_skills.updated_at` quando um arquivo é gravado ou removido;
- **o `SKILL.md` fica cru, com o frontmatter dentro.** Ao contrário de `files`,
  aqui não há metadado em coluna: o arquivo é a única verdade, e é ele que se
  edita. Quem separa metadados de corpo é a promoção, uma vez.

O envio pertence a **quem o submeteu** (`owner_user_uuid`), com `ON DELETE SET
NULL` como `skills` (`017`): conta removida deixa o envio órfão, só do admin,
em vez de levar o pacote junto. `created_by_user_uuid` fica ao lado,
informativo. **O recorte por papel é do app** (`canViewQuarantine`,
`canEditQuarantine`, `canPromoteQuarantine` de shared): o banco não filtra por
papel — quem quer só os envios de uma conta passa `ownerUserUuid` a
`listQuarantine`, e é assim que um membro que perdeu o papel de editor continua
vendo o que trouxe.

**Arquivos.** A mesma modelagem de `files`: caminho por
`normalizeRelativePath`, mime pela extensão, texto **ou** binário pela régua de
`fileColumns` (mime textual, sem byte nulo e UTF-8 válido), nunca os dois
(`quarantine_files_one_content_chk`). O caminho é único **dentro do envio** e
sem diferenciar caixa (`quarantine_files_path_lower_uniq`, a lição do `003`);
entre envios diferentes o mesmo caminho é livre. Três diferenças em relação à
skill, as três de propósito: o `SKILL.md` **pode faltar** (e `createQuarantineFile`
o cria, como cria qualquer caminho livre — numa skill ele sempre existe e criá-lo
é 409), **pode ser removido** (`deleteQuarantineFile`), porque um envio sem ele
é um estado legítimo — só não é promovível —, e **pode ser binário**.

**O `SKILL.md` binário entra na quarentena.** Em `files` ele é o único caminho
que tem de ser texto e o resto é 400 (ver
[Arquivos da skill](#arquivos-da-skill)); aqui a mesma exigência seria um
defeito, e foi medido como um: um pacote cujo `SKILL.md` veio em Windows-1252
ou UTF-16 era recusado nos **dois** destinos, sem lugar nenhum onde consertá-lo.
Na quarentena ninguém decodifica arquivo — ele é bytes crus do upload ao
download, não há `search_vector`, não há RAG e não há metadado em coluna que o
contradiga —, e receber o pacote torto é justamente para o que o espaço serve.
Ele é guardado byte a byte como qualquer anexo binário; quem cobra o texto é a
promoção, na porta do acervo (linha `SKILL.md` da tabela abaixo). Vale nos três
caminhos de gravação — `createQuarantine`, `setQuarantineFiles` e, agora que
`createQuarantineFile`/`setQuarantineFile` recebem `Buffer | string` como
`createFile`/`setFile`, também o arquivo avulso.

**A promoção** (`promoteQuarantine`) acontece numa transação só — senão
restaria skill pela metade ou envio apagado sem skill — e decide isto:

| Passo | O que fica decidido |
|-------|---------------------|
| `SKILL.md` | são dois **400** com o nome do envio na mensagem, e **nada é apagado** nos dois: o envio fica para receber ou consertar o arquivo. Sem ele (`isSkillMd`, como nas demais), e com ele **binário** — o que a quarentena aceita de propósito volta a ser exigido aqui, porque daqui em diante esse arquivo é lido como texto; a mensagem manda converter para UTF-8 e salvar, dentro da própria quarentena |
| metadados | `skillMetaFromMarkdown` do `SKILL.md` cru dá nome, descrição e tags; nome vazio cai para o nome do envio, descrição vazia para a dele. O corpo gravado é o `stripFrontmatter` |
| slug | **derivado, com sufixo automático** (`-2`, `-3`…) — o caminho de quem cria sem pedir slug, nunca o explícito que devolve 409. Vale para o `name:` do frontmatter e para o nome do envio; colisão aqui não é erro de quem aprova |
| dono | **quem aprova**, nas duas colunas (`owner_user_uuid` e `created_by_user_uuid`), como em `createSkill` — promover **é** criar a skill. Ator sem conta (token global, bootstrap) gera skill órfã, e o dono do envio não entra em lugar nenhum da skill. Ver [Por que o dono é quem aprova](#por-que-o-dono-é-quem-aprova) |
| exposição | sem ícone, `is_public` falso e ligada, como sempre — e, **na mesma transação**, participação ativa em cada catálogo do destino e vínculo direto com cada vMCP dele, com as portas gravadas (`035`). Sem destino, nasce **flutuante**, como antes. ~~A skill nasce sempre flutuante: publicar é um ato à parte, depois~~ — revogado pelo `035` (`docs/15` §11); ver [O destino](#o-destino) |
| anexos | os demais arquivos do envio viram anexos da skill, com o caminho intacto e os bytes como estão |
| o envio | a linha da quarentena **some**, e os arquivos e o destino vão pela cascata |

A skill promovida é skill normal: os triggers do `020` a marcam `rag_stale` e o
`search_vector` é montado como em qualquer criação. A promoção audita a `create`
da skill, como toda criação, uma `mcp.update` por vMCP e uma `catalog.update` por
catálogo do destino cumprido, **e** `quarantine.promote` com `target_label` =
`<nome do envio> -> <slug criado>`, nessa ordem.

#### Por que o dono é quem aprova

A regra **era** a oposta, e era deliberada: dono = quem submeteu, criador =
quem promoveu, "o admin que aprova não toma a skill de quem a trouxe"
(`docs/15` decisão 7). O mantenedor a reverteu depois de um defeito medido na
validação da quarentena, e o registro do motivo fica aqui porque a regra antiga
está documentada.

Com a política `quarantine.approvers = admin+editor`, o editor que aprovava o
envio de outra conta criava uma skill **privada, flutuante e sem concessão
nenhuma**, cujo dono era outra pessoa — e, no instante seguinte, deixava de
enxergá-la: `skillVisibleTo` não alcança nada disso, `loadSkill` devolve 404, e
o aviso de sucesso caía numa tela de "Skill não encontrada". Não era um
problema de tela: o objeto criado estava fora do alcance de quem o criou.

Com o dono sendo quem aprova, o defeito some na raiz e a promoção passa a se
comportar como `createSkill` — quem cria enxerga, edita e publica o que criou
(`docs/12` decisão 8). Devolver a skill a quem a trouxe continua possível e
vira um ato com trilha: transferir (`updateSkill` com `ownerUserUuid`, que
audita `update` com o username do novo dono) ou conceder (`setSkillGrant`).
Quem quiser reconstituir a origem tem a linha `quarantine.promote`, com o nome
do envio, e o `quarantine.create`, com quem submeteu.

**A fila das escritas** de um envio é a trava da própria linha (`FOR UPDATE`, a
primeira statement de toda escrita), e não um advisory lock como em
[Arquivos da skill](#arquivos-da-skill): aqui não há dois caminhos pedindo as
mesmas tabelas em ordens opostas — toda escrita começa pelo envio e só então
toca `quarantine_files`. O trigger de carimbo também não fecha ciclo: o
`UPDATE … SET updated_at` pede `FOR NO KEY UPDATE`, que **não** conflita com o
`FOR KEY SHARE` da FK (medido: com duas transações segurando o `FOR KEY SHARE`
da mesma linha, o primeiro `UPDATE` passa e o segundo só espera). Quem chega
depois de o envio ser apagado ou promovido recebe **404**, nunca 23503.

Por isso `createQuarantineFile` dispensa o `ON CONFLICT DO NOTHING` que
`createFile` usa como garantia final: a trava do envio barra **até o INSERT de
quem não a pediu**, porque a FK de `quarantine_files` precisa de `FOR KEY
SHARE` na linha do envio e esse modo conflita com `FOR UPDATE` — medido, um
`INSERT` cru fica esperando e só entra quando a trava sai. Entre a conferência
de caminho ocupado e o INSERT não cabe ninguém.

**Auditoria** (as cinco ações do `CHECK`): `quarantine.create` é o envio que
apareceu e `quarantine.delete` o que foi descartado, os dois com o **nome do
envio** em `target_label` — ele não tem slug, e `skill_uuid`/`skill_slug` ficam
nulos. Toda escrita **dentro** do envio é `quarantine.update`, com o caminho em
`file_path` e o conteúdo anterior em `previous_content` quando havia texto:
criar, sobrescrever e remover um arquivo são a mesma coisa do ponto de vista da
fila — o envio mudou. Gravar o destino também é `quarantine.update`, sem
`file_path`. `quarantine.promote` leva `<nome> -> <slug>` e
`quarantine.settings` leva `chave=valor`, como `rag.settings`.

**Quem aprova** é a chave `quarantine.approvers` em `settings` — `admin`,
`admin+owner` (o padrão) ou `admin+editor` —, semeada pela `030` com `ON
CONFLICT DO NOTHING`: a instalação que já escolheu não é reescrita, e a
semeadura não entra na trilha (ninguém decidiu o padrão de fábrica).
`getQuarantineApprovers` cai no padrão de shared quando a chave falta ou tem
valor que não é um dos três — a política nunca fica indefinida; e
`setQuarantineApprovers` recebe `unknown` (o valor vem do corpo da requisição),
recusa com 400 o que não é um dos três e audita `quarantine.settings`. **Quem
pode o quê continua sendo do app**: a chave é só o valor guardado.

#### O destino

O **destino** (`035`, [`docs/15-quarentena.md`](../docs/15-quarentena.md) §11)
é para onde a skill vai quando o envio for aprovado: os catálogos em que ela
entra, com participação ativa, e os vMCPs em que ela ganha **vínculo direto**,
com as três portas escolhidas. Quem importa escolhe no upload
(`createQuarantine` com `targets`), e a ficha do envio o edita até a aprovação
(`setQuarantineTargets`). Ele revoga a decisão 8 do `docs/15` — a skill
promovida nascia sempre flutuante — e o primeiro item da §9 dele.

**Destino não é vínculo.** `quarantine_catalogs` e `quarantine_mcps` não entram
em leitura nenhuma de skill, catálogo, servidor ou site: até a aprovação o envio
não aparece em lugar nenhum, e nada muda nos alvos. Quem as lê é a ficha
(`getQuarantine`, com nome, slug e `isActive` **atuais** de cada alvo,
ordenados por nome) e a promoção, que cria os vínculos de verdade **na mesma
transação** em que cria a skill — e as linhas do destino somem na cascata do
envio apagado.

**A permissão é do app**, como no resto da quarentena: quem grava o destino, e
quem aprova, precisa de `edit` em cada alvo, e o app confere antes de chamar. O
banco só confere a forma e que o alvo existe:

| Situação | Resposta |
|----------|----------|
| `targets` sem as duas listas, ou que não é objeto | **400** — o destino é declarativo, e lista ausente lida como vazia apagaria o gravado |
| uuid torto (`targets.catalogs[i]`, `targets.mcps[i]`) | **400** com o índice |
| catálogo ou vMCP desconhecido | **400** `Catálogo não encontrado: <uuid>` / `MCP virtual não encontrado: <uuid>`, como em `resolveLinks` — é erro de quem mandou a lista |
| o mesmo alvo duas vezes (em qualquer caixa) | **400** `… repetido no destino` |
| porta ausente ou não booleana | **400** (`requireBoolean`) |
| vMCP com as três portas desligadas | **400** — o CHECK `quarantine_mcps_some_port_chk` recusaria de qualquer jeito; a mensagem diz qual |
| alvo apagado entre a checagem e o INSERT | **400** "… do destino não existe mais" (a FK, por `targetGoneOr`), nunca 500 |

Tudo isso vem **antes de gravar qualquer coisa**: em `createQuarantine` o envio
não nasce; em `setQuarantineTargets` o destino gravado fica como estava.

**`setQuarantineTargets` é declarativa**, como `setCatalogSkills`: o que saiu é
removido, o que entrou é inserido e o vMCP que ficou tem só as portas reescritas
(o `created_at` dele fica). Envio com uuid torto ou inexistente é **404**. Com
mudança, carimba `quarantine_skills.updated_at` **à mão** e audita
`quarantine.update` com o nome do envio. **Sem mudança — o mesmo destino, em
qualquer ordem e caixa —, nada é tocado**: nem o carimbo, nem a trilha. O painel
salva a ficha inteira, e um salvar sem mudança não é evento (o critério de
`addCatalogSkill` com quem já é membro).

**Sem trigger de carimbo**, ao contrário de `quarantine_files`: um trigger nas
tabelas do destino dispararia também na cascata de `deleteCatalog` e
`deleteVirtualMcp`, e essas transações passariam a pedir a linha do envio
segurando a do alvo — a ordem inversa da promoção, que trava o envio e depois o
alvo.

**Alvo apagado antes da aprovação tira o destino em silêncio**: a FK para o
alvo é `ON DELETE CASCADE`, e a remoção do catálogo ou do vMCP leva a linha do
destino sem erro, sem auditoria no envio e sem mexer no `updated_at` dele. Um
destino que não existe mais não tem o que cumprir, e barrar a remoção por causa
de um envio pendente daria ao envio um poder que ele não tem.

**A aprovação cumpre o destino** (`promoteQuarantine`), na transação de sempre,
depois de criar a skill e antes de apagar o envio: `linkTx` em cada vMCP
(`mcp.update`) e, em cada catálogo, `INSERT` em `catalog_skills` com `ON
CONFLICT DO NOTHING` e `touchCatalogTx` (`catalog.update`), como
`addCatalogSkill`. O dono continua sendo quem aprova e `is_public` continua
falso; sem destino, a skill nasce flutuante, como antes. O retry do slug
continua valendo — a transação inteira repete, destino junto.

**`expectedTargets` fecha a janela entre o app e o banco.** O app confere
`edit` em cada alvo que leu na ficha e passa esse destino em
`options.expectedTargets`; dentro da transação, com o envio travado, ele é
comparado com o gravado (conjunto de catálogos; conjunto de vMCPs com as três
portas). Diferente é **409** (`conflict`), `O destino do envio "<nome>" mudou
enquanto você aprovava: confira e aprove de novo`, **sem criar nada**. Omitido,
a promoção cumpre o gravado sem comparar — é o que mantém os chamadores
antigos. Malformado é 400, antes da transação. O catálogo apagado depois de a
ficha ser lida cai aqui também: o gravado perdeu a linha pela cascata, e a ficha
velha dá 409.

O alvo apagado **no meio** da promoção — depois de o destino ser lido, antes de
ser travado — é **pulado**: a trava volta vazia e ele fica de fora. É o mesmo
estado final de a remoção ter vindo logo depois da aprovação, quando a cascata
de `catalog_skills`/`virtual_mcp_skills` levaria o que ela criou.

**A ordem das travas** da promoção é fixa: o envio (`FOR UPDATE`); **todos os
vMCPs**, na ordem do uuid, pelo caminho de `linkTx` (trava pura, vínculo,
`UPDATE` por último); e só então **todos os catálogos**, na ordem do uuid, em
`FOR UPDATE`. `setQuarantineTargets` grava na mesma ordem (vMCPs, depois
catálogos, cada lista numa statement e na ordem do uuid), porque as FKs dela
pedem `FOR KEY SHARE` nos mesmos alvos. Medido em banco descartável, 150
rodadas por cenário:

| Variação | 40P01 |
|----------|-------|
| **a ordem escolhida**, contra outra promoção, `setQuarantineTargets` de outro envio, `linkCatalog` + `setVirtualMcpCatalogs`, `setCatalogSkills` + `addCatalogSkill` + `linkSkill` + `createSkill` com vínculos, e `deleteCatalog` + `deleteVirtualMcp` dos próprios alvos | **0** em todos |
| catálogo antes do vMCP, contra `linkCatalog` + `setVirtualMcpCatalogs` | **149 de 150** rodadas — eles seguram o vMCP e pedem o catálogo pela FK de `virtual_mcp_catalogs` |
| sem a ordem do uuid (sorteada por promoção), promoção × promoção | **78 de 150** pares |
| `setQuarantineTargets` com catálogos antes de vMCPs, contra a promoção | 0 em 300 — a ordem dela fica por precaução (o `FOR KEY SHARE` no vMCP pode esperar um `UPDATE` em andamento, a espera descrita em `linkTx`), não por medida |

Nenhuma escrita do código trava catálogo e depois vMCP, então "vMCP primeiro"
não fecha ciclo com ninguém. A cena determinística do ciclo (uma transação crua
segura o vMCP, a promoção espera, a transação pede o catálogo pela FK) está em
`quarantine-targets.integration.test.ts`, com laços curtos de cada cenário.

### Clonagem

Duplicar uma skill, um catálogo ou um MCP virtual (`031`,
[`docs/16-clonagem.md`](../docs/16-clonagem.md)). As três funções têm a mesma
forma, recebem o **uuid do original** (leitura por slug, escrita por uuid) e
devolvem a ficha da **cópia**, do mesmo tipo que a criação devolve:

```ts
const copia = await cloneSkill(uuid, { name, slug, ownerUserUuid }, 'web-admin', ator);
// cloneCatalog(uuid, input, source, ator) → CatalogDetail
// cloneVirtualMcp(uuid, input, source, ator) → VirtualMcpDetail
```

`CloneInput` tem os três campos opcionais: `name` (ausente ou vazio é o mesmo
nome do original), `slug` (ver abaixo) e `ownerUserUuid` (o dono da cópia;
ausente ou `null` deixa órfã, como tudo o que o token global e o bootstrap
criam). Uuid torto ou inexistente é 404; dono que não existe é 404
(`Conta não encontrada`), como na criação.

**O que a cópia leva, e o que não leva:**

| Tipo | Copia | **Não** copia |
|------|-------|---------------|
| skill | `name`, `description`, `icon`, `is_active`, **todos os arquivos** (texto e binário) e as **tags** | vínculo com vMCP (`virtual_mcp_skills`), participação em catálogo (`catalog_skills`), concessões (`skill_grants`), contadores, histórico — a cópia nasce **flutuante** |
| catálogo | `name`, `description`, `is_active` e os **membros** (`catalog_skills`), apontando para as mesmas skills e **com o `is_active` de cada participação** | vínculo com vMCP (`virtual_mcp_catalogs`), concessões (`catalog_grants`), contadores |
| vMCP | `name`, `description`, `is_active`, o `layout` do canvas, os vínculos com skills e com catálogos (as três portas e o par `pos_x`/`pos_y` de cada um) e as **concessões** (`virtual_mcp_grants`) | chaves `psv_`, contadores do vínculo (nascem em zero), sessões, acessos e o posto de **vMCP padrão** (`settings.default_virtual_mcp` não é tocado) |

Quatro regras valem para as três:

- **a cópia nasce fechada**: `is_public` (skill e catálogo) e `is_open` (vMCP)
  são `false` **sempre**, mesmo com o original público ou aberto. Publicar é um
  ato à parte, com trilha. `is_active` é copiado como está — a cópia de uma
  skill desligada nasce desligada;
- **o dono é quem clonou** — o parâmetro, não o ator da auditoria. Em `skills`,
  `created_by_user_uuid` recebe o mesmo valor; catálogo e vMCP não têm essa
  coluna;
- **o slug tem dois caminhos.** Sem `input.slug`, a base é o **slug do
  original** (não o nome) e o desempate é automático — `-2`, `-3`… pelo mesmo
  `uniqueSlug` de `freeSkillSlugTx` —, e por esse caminho clonar **nunca**
  responde 409. Com `input.slug`, ele passa pela validação do tipo
  (`isValidSlug`; 400 no inválido) e, se já existir, é **409**, como em
  `resolveSlug` e `createCatalog`: foi um endereço pedido, e escolher outro em
  silêncio devolveria um objeto em lugar que o chamador não pediu;
- **uma linha só na trilha**, no objeto **novo**, dentro da mesma transação:
  `skill.clone` (com `skill_uuid`/`skill_slug` da cópia), `catalog.clone` ou
  `mcp.clone`, com `target_label` = `<slug de origem> -> <slug da cópia>` — a
  gramática de `quarantine.promote`. **Sem** a `create` do objeto junto: a
  mesma operação apareceria duas vezes.

Nas concessões copiadas do vMCP, `granted_by_user_uuid` passa a ser **quem
clonou** (é ele quem concede no objeto novo) e a linha da **própria pessoa que
clonou não é copiada** — ela é a dona da cópia, e conceder ao dono é recusado
como redundante (`docs/12` decisão 10). As chaves `psv_` não vão junto porque
**não há como**: o segredo não é guardado (só o prefixo e o hash) e `prefix` é
UNIQUE; o servidor novo começa sem credencial.

A skill clonada é skill normal: nasce **pendente de RAG** (o trigger do `020`
marca `rag_stale` no INSERT e a cada arquivo de texto) e com o `search_vector`
montado como em qualquer criação.

**As travas** (a razão de cada uma está em
[`docs/03-implementation-notes.md`](../docs/03-implementation-notes.md),
"Armadilhas medidas"):

- **skill** — `lockSkillFilesTx` no **original**, como **primeira statement**
  (a mesma fila de `createFile`/`setFiles`/`deleteSkill`: ela dá uma foto
  estável dos arquivos a copiar e, por ser a primeira, não segura linha nenhuma
  enquanto espera), e depois `SELECT … FOR KEY SHARE` no original — nunca `FOR
  UPDATE`, que em `skills` entra em deadlock com o trigger
  `files_rag_stale_trg`. A cópia **não** toma a fila da skill nova: o uuid dela
  ainda não existe e ninguém pode disputá-lo;
- **catálogo** — a trava de `lockCatalogTx` (`FOR UPDATE`) no original: é o 404
  e faz a cópia dos membros enxergar um estado só;
- **vMCP** — `FOR NO KEY UPDATE` no original, como em `lockVirtualMcpTx`: `FOR
  UPDATE` barraria o `FOR KEY SHARE` que a FK de `skill_accesses` pede e mataria
  `recordSkillAccess`. Não há `UPDATE` no servidor de origem para deixar por
  último: o original é só lido.

Medido em banco descartável (pg18, 40 pares simultâneos de cada combinação, 280
no total): clone × clone do mesmo original (skill e vMCP), clone de skill ×
`setFiles` na origem, clone de skill, de catálogo e de vMCP ×
`recordSkillAccess`, e clone de catálogo × clone de skill sobre a mesma massa —
**nenhuma morte por deadlock e nenhuma falha**. E a diferença das duas travas de
contêiner, medida com `FOR KEY SHARE NOWAIT` de um terceiro cliente: com o vMCP
em `FOR NO KEY UPDATE` a FK de `skill_accesses` **passa**; em `FOR UPDATE` ela
leva `55P03`. No catálogo o `FOR UPDATE` de `lockCatalogTx` barra esse mesmo
`FOR KEY SHARE`, e fica assim de propósito: quem insere filho de `catalogs`
(`linkCatalog`, `addCatalogSkill`, `setCatalogSkills`) já toma a mesma trava
antes, e o que espera pela clonagem é o contador de `recordSkillAccess` — por
uma transação curta, como em qualquer edição de membro.

Os arquivos da skill são copiados com `INSERT … SELECT` **dentro do banco** —
nenhum byte passa pela memória do processo —, e toda lista copiada
(`skill_tags`, `catalog_skills`, `virtual_mcp_skills`, `virtual_mcp_catalogs`,
`virtual_mcp_grants`) vai **ordenada**, porque a FK trava as linhas
referenciadas na ordem em que elas entram e duas clonagens em ordens diferentes
travariam em cruz.

### Links de redefinição de senha

`reset_tokens` (`006`) guarda o SHA-256 de cada link de "esqueci a senha". O
`023` acrescentou o que faltava para **um** link valer de cada vez: pedir o
link cinco vezes deixava cinco válidos ao mesmo tempo, e trocar a senha não
fechava nenhum — um link vazado seguia redefinindo a senha depois.

Cada linha fica em **um** de três estados, e os três são contáveis:

| Estado | Como se lê | O que significa |
|--------|-----------|-----------------|
| usado | `used_at IS NOT NULL` | este link redefiniu a senha. É o par da linha `user.password` com ator `link-de-redefinicao` na trilha |
| substituído | `superseded_at IS NOT NULL` | o link estava **vivo** e foi fechado **sem** uso |
| em aberto | os dois nulos | vivo se `expires_at > now()`; morto por prazo se não |

`reset_tokens_estado_chk` garante a exclusividade: uma linha não diz as duas
coisas. Por isso a invalidação **não** é `used_at = now()` nos anteriores (faria
a tabela mentir sobre quem redefiniu senha) nem um `DELETE` (apagaria o registro
da tentativa, que o `006` guarda de propósito).

Quem fecha são dois pontos, e o fechamento só toca link **vivo** — link que
venceu sem ninguém clicar continua "morto por prazo" em vez de ser reetiquetado:

- **a emissão.** `createResetToken` fecha os vivos da conta e insere o novo numa
  statement só (CTE que escreve): a linha nova não pode ser fechada pela própria
  emissão, porque a CTE só vê o estado anterior ao comando;
- **a troca da senha.** Um trigger em `users`
  (`users_password_reset_tokens_trg`, `AFTER UPDATE OF password_hash` com
  `WHEN` de valor diferente) fecha os vivos da conta. Mora no banco porque são
  três caminhos que trocam senha — o link consumido, o reset do admin e a troca
  pelo próprio dono, todos por `updateUser` — e a regra é do dado: **senha
  nova, nenhum link antigo serve.** Um caminho novo a herda sem precisar
  lembrar dela; um logout (`bumpTokenVersion`) não fecha nada.

Não há unicidade parcial de "um vivo por conta": dois pedidos simultâneos não
veem a linha um do outro e um `UNIQUE` transformaria duplo clique em erro. Os
dois links são do mesmo dono e o pedido seguinte fecha os dois. Nenhum índice
novo — `reset_tokens_user_uuid_idx` (`006`) já cobre o `WHERE user_uuid = $1`,
que é o que o comentário dele sempre prometeu.

## Containers

Definidos em [`docker-compose.yml`](docker-compose.yml) e incluídos pelo compose
da raiz. **Rode sempre a partir da raiz do repositório:**

```bash
docker compose up -d postgres      # só o banco
docker compose run --rm migrate    # aplica database/schema/*.sql
docker compose run --rm seed       # skills de exemplo (opcional)
```

| Serviço | Imagem | Papel |
|---------|--------|-------|
| `postgres` | `pgvector/pgvector:pg18-trixie` | o banco; volume `pgdata` |
| `migrate` | `tmsoftbrasil/purple-skills-db` (perfil `migrate`) | aplica o schema e sai |
| `seed` | `tmsoftbrasil/purple-skills-db` (perfil `seed`) | popula o catálogo de exemplo e sai |

`migrate` e `seed` usam o mesmo `database/Dockerfile` — é a única imagem que
carrega o SQL. Ela é publicada no Docker Hub como `tmsoftbrasil/purple-skills-db`,
e `docker compose build` a gera a partir do código. As imagens dos apps recebem
só o `dist/` do cliente.

O `migrate` **recusa** aplicar um arquivo antigo sobre um banco que já passou
dele — histórico truncado, em geral por uma restauração sem `schema_migrations`
— e sai com 1 sem aplicar nada. As saídas, inclusive
`docker compose run --rm -e MIGRATE_ALLOW_RETRO=1 migrate`, estão em
[Reaplicar migration antiga](#reaplicar-migration-antiga).

**Tetos de memória.** O `postgres` tem `mem_limit`/`memswap_limit` iguais, em
`POSTGRES_MEM_LIMIT` (padrão `2048m`); `migrate` e `seed` dividem
`DB_JOB_MEM_LIMIT` (padrão `512m`) no `x-db-job`. Nenhum dos três tem `cpus` —
limitar a CPU do banco atrasaria migration e consulta legítima. O número do
banco é dimensionado pela memória que o kernel **não** consegue recuperar
quando o cgroup enche: as áreas compartilhadas (`shared_buffers` 128 MB, o
padrão do PostgreSQL 18 que a imagem não altera), os 50 backends que o pool dos
apps abre (`DB_POOL_MAX` 10 × 5 serviços; medido num banco do zero, 227 MiB com
o schema aplicado e 50 sessões aquecidas, ~4 MB privados por backend antes de
qualquer dado) mais o `work_mem` de cada nó de sort/hash — 4 MB, 8 MB nos de
hash, porque `hash_mem_multiplier` é 2 — e três autovacuum a
`maintenance_work_mem`. O page cache do volume fica fora da conta de propósito:
é reclamável, e sob pressão o kernel o descarta em vez de matar o processo —
custa desempenho, não o `postmaster`. Quem subir `shared_buffers`, `work_mem`,
`maintenance_work_mem`, `max_connections` ou `DB_POOL_MAX` sobe o teto na mesma
conta: **abaixo do pico o teto deixa de ser proteção e passa a ser a causa da
queda** — o OOM killer que alcança um backend faz o postmaster tratar a morte
como queda e derrubar todas as sessões. `/dev/shm` segue nos 64 MB padrão do
Docker, onde vivem os segmentos das consultas paralelas
(`dynamic_shared_memory_type = posix`); um `work_mem` bem maior pede `shm_size`
explícito, que também conta contra o teto.

**A porta do banco** é publicada em `POSTGRES_BIND_ADDR` (padrão `127.0.0.1`) e
**não acompanha o `BIND_ADDR`** da raiz. Nenhum app usa essa porta — todos
chegam por `postgres:5432` na rede `internal`, pelo `PGHOST` do
[Contrato de conexão](#contrato-de-conexão) —, ela existe para o `psql` e o
cliente gráfico de quem administra a máquina, e o `BIND_ADDR=0.0.0.0` que abre o
painel para outra máquina não deve arrastar consigo um servidor sem limite de
tentativa de login nem trava de conta. Sair do loopback é explícito:
`POSTGRES_BIND_ADDR=0.0.0.0` — e não com a senha que o `.env.example` traz.

Sem Docker, com um Postgres acessível:

```bash
npm run build:packages   # e **não** `npm run build -w @purple-skills/db`: num
npm run migrate          # clone novo o pacote não compila sozinho, porque
npm run seed             # importa @purple-skills/shared, que ainda não tem
                         # `dist/` — são três TS2307
```

## Contrato de conexão

A biblioteca resolve a conexão nesta ordem, e nenhum app deve reimplementá-la:

1. `DATABASE_URL`, se definida (a senha precisa estar percent-encodada);
2. as variáveis do driver: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`.

O compose usa as `PG*` justamente porque não passam por parse de URL. Os nomes
dessas cinco chaves são parte do contrato: mudá-los é decisão do DBA, e o
`x-app-env` do compose da raiz precisa acompanhar.

Tamanho do pool: `DB_POOL_MAX` (padrão 10). Os timeouts de conexão e de ociosidade
são fixos em `src/client.ts`.

## API para os outros agentes

Importe sempre pelo pacote, nunca por caminho relativo:

```ts
import { getDb, listSkills, createSkill, AppError } from '@purple-skills/db';
```

| Grupo | Exportações |
|-------|-------------|
| Conexão | `getDb`, `createDb`, `closeDb`, `databaseConfig`, `waitForDatabase`, `healthCheck`, tipo `Database` |
| Leitura | `listSkills`, `listPublishedSkills`, `getSkillSummary`, `getSkillDetail` (aceitam `visibility`, `viewer`, `virtualMcp`; a listagem também `scope` e `semantic`), `listFiles`, `readFile`, `readTextFile`, `readAllFiles`, `listTags`, `listAudit`, `stats` |
| Busca | `SEARCH_QUERY_MAX_LENGTH` — o teto do termo em caracteres, o mesmo das quatro listagens; ver [O termo de busca](#o-termo-de-busca-literal-e-indexado) |
| Escrita | `createSkill`, `updateSkill`, `updateSkillWithContent` (as três aceitam `icon`, `isActive` e `isPublic`; as duas últimas também `ownerUserUuid`), `deleteSkill`, `setFile` (upsert), `createFile` (só se o caminho está livre), `setFiles`, `deleteFile`, `previewSetFilesDeletions` (a prévia do `replace`, só leitura) — ver [Arquivos da skill](#arquivos-da-skill) |
| Acesso | `setSkillGrant`, `removeSkillGrant`, `listSkillGrants`, `setCatalogGrant`, `removeCatalogGrant`, `listCatalogGrants`, `setVirtualMcpGrant`, `removeVirtualMcpGrant`, `listVirtualMcpGrants`, `lookupUsers`, `adoptOrphans` |
| Site | `listOpenVirtualMcps`, `listPublicCatalogs`, `getPublicCatalog` |
| Vínculo pelo lado da skill | `linkSkill` (aceita `{ position }`), `unlinkSkill` (e `mcps` em `createSkill`) |
| Canvas | `setVirtualMcpCanvas` (`layout`, `positions`, `catalogPositions`); `layout`/`catalogs` em `VirtualMcpDetail`, `position`/`icon` em `VirtualMcpSkill`, `toolCount`/`promptCount`/`resourceCount`/`preview`/`previewCatalogs`/`onlineSessions`/`catalogCount` em `VirtualMcpSummary` |
| Catálogos | `listCatalogs`, `getCatalog`, `getCatalogByUuid`, `createCatalog`, `updateCatalog`, `deleteCatalog`, `setCatalogSkills`, `addCatalogSkill`, `removeCatalogSkill`, `setCatalogSkillActive`, `linkCatalog`, `unlinkCatalog`, `setVirtualMcpCatalogs` |
| Sessões MCP | `openMcpSession`, `touchMcpSession`, `closeMcpSession`, `closeMcpSessions`, `findOpenMcpSession`, `expireMcpSessions`, `listMcpSessions`, `countOnlineMcpSessions`; `normalizeSessionLabel` e `MCP_SESSION_LABEL_MAX` — a regra e o teto do rótulo de cliente, os mesmos da gravação, para o mcp-public cortar na memória |
| Auditoria paginada | `listAuditPage` |
| Acessos por skill | `recordSkillAccess` (grava a leitura **e** soma os contadores), `listSkillAccesses` |
| Atividade | `bumpMcpCallCounters` (o flush do MCP público), `listActivityDays` (a série do heatmap) e `activityOfDay` (o relatório de um dia); `MCP_CALL_METHOD_MAX` — o teto do método, para o rastreador cortar na memória com o mesmo número do banco — e `ACTIVITY_RANGE_MAX_DAYS`. `ActivityDay`, `ActivitySeries`, `ActivitySlice`, `ActivityReport`, `McpCallBucketInput`, `MCP_CALL_BUCKET_MS` e `mcpCallFamily` vêm de shared. Ver [Atividade: as queries](#atividade-as-queries) |
| Contadores | `incrementViewCount`, `incrementDownloadCount` (só somam; os apps migram para `recordSkillAccess`) |
| RAG | `getRagSettings`, `seedRagSetting`, `setRagSetting`, `setRagIndexerStatus`, `resolveRagSpace`, `findRagSpace`, `ragSchemaReady`, `claimStaleSkills`, `releaseStaleSkill`, `readSkillForRag`, `replaceSkillTexts`, `listPendingRagTexts`, `releaseRagTextReservations`, `markRagTextRefused`, `clearRagRefusals`, `collectOrphanRagTexts`, `insertRagVectors`, `ragCoverage`, `markAllSkillsStale`, `RAG_SETTING_KEYS`, `RAG_EDITABLE_SETTINGS`, `RAG_CLAIM_MAX_ATTEMPTS` |
| Clonagem | `cloneSkill`, `cloneCatalog`, `cloneVirtualMcp` — o **uuid do original**, `CloneInput`, a origem e o ator; devolvem a ficha da cópia (`SkillDetail`/`CatalogDetail`/`VirtualMcpDetail`). Ver [Clonagem](#clonagem) |
| Quarentena | `listQuarantine`, `getQuarantine`, `createQuarantine`, `readQuarantineFile`, `readAllQuarantineFiles`, `createQuarantineFile`, `setQuarantineFile`, `setQuarantineFiles`, `deleteQuarantineFile`, `deleteQuarantine`, `setQuarantineTargets`, `promoteQuarantine` (com `options.expectedTargets`), `getQuarantineApprovers`, `setQuarantineApprovers` — ver [Quarentena](#quarentena) e [O destino](#o-destino). O envio é endereçado pelo **uuid**; `QuarantineSummary`/`QuarantineDetail`/`QuarantinePage`, `QuarantineTargets`/`QuarantineTargetsInput` e `QuarantineApprovers` vêm de shared |
| Extensão de skills (MCP) | `listSkillsManifest(virtualMcpUuid, { slug? })` e `readSkillMdBodies(uuids)` — o manifesto da SEP-2640 e os corpos do `SKILL.md` em lote; `SkillManifestEntry`, `SkillManifestFile` e `SkillMdBody`. Ver [Manifesto da extensão de skills](#manifesto-da-extensão-de-skills) |
| Contas | `countUsers`, `listUsers`, `getUserByUuid`, `getUserByEmail`, `getUserByUsername`, `getUserByLogin` (o campo único do login), `getUserByOidc`, `createUser`, `updateUser`, `registerFailedLogin`, `registerSuccessfulLogin` |
| Username | `nextFreeUsername(base)` — o primeiro nome livre nas **duas** fontes, para a sugestão do painel e o auto-provisionamento OIDC — e `reserveUsername(candidate, userUuid)`, que toma e grava numerando em vez de recusar. Ver [Username](#username) |
| Perfil | `getProfile(userUuid)` (o vazio e privado quando não há linha), `saveProfile(userUuid, input)` (upsert parcial; aceita `name` e o grava em `users`), `clearProfile(userUuid, source, actor)` (a limpeza do admin: esvazia, desliga, apaga a foto e audita `user.profile`, numa transação), `getPublicProfile(username)` (só com `is_public` **e** conta ativa; `null` sem distinguir os motivos), `isProfilePublic(username)` — a mesma pergunta **sem** montar as listas, para a rota da imagem — e `listPublicByOwner(username)`. A foto: `setAvatar(userUuid, bytes, mime?)` — o tipo sai dos **bytes**, e o `mime` informado é conferência —, `deleteAvatar`, `getAvatar(userUuid)`, `getAvatarByUsername(username)` e `avatarStamp(userUuid)`. As duas leituras de avatar **não** olham `is_public`: a política é de quem chama. Ver [Perfil](#perfil) |
| Chaves de API | `listApiKeys`, `createApiKey`, `revokeApiKey`, `getApiKeyByPrefix`, `touchApiKey` |
| Senha | `createResetToken`, `consumeResetToken` |
| Auditoria de conta | `recordAccountAudit` |
| MCP virtual | `listVirtualMcps`, `listOpenVirtualMcps`, `getVirtualMcp`, `getVirtualMcpByUuid`, `resolveVirtualMcp`, `createVirtualMcp`, `updateVirtualMcp`, `deleteVirtualMcp`, `setVirtualMcpSkills`, `listVirtualMcpKeys`, `listVirtualMcpKeysByCreator`, `createVirtualMcpKey`, `revokeVirtualMcpKey`, `getVirtualMcpKeyByPrefix`, `touchVirtualMcpKey` |
| MCP padrão | `DEFAULT_MCP_SETTING`, `resolveDefaultVirtualMcp`, `setDefaultVirtualMcp` |
| Erros | `AppError`, `notFound`, `badRequest`, `conflict`, `unauthorized`, `isUniqueViolation`, `isForeignKeyViolation` |
| Schema/tipos | `skills`, `files`, `tags`, `skillTags`, `auditLog`, `users`, `apiKeys`, `resetTokens`, `virtualMcps`, `virtualMcpSkills`, `virtualMcpKeys`, `catalogs`, `catalogSkills`, `virtualMcpCatalogs`, `skillGrants`, `catalogGrants`, `virtualMcpGrants`, `settings`, `mcpSessions`, `mcpCallCounters`, `skillAccesses`, `ragSpaces`, `ragTexts`, `ragSkillTexts`, `ragVectors`, `ragTextStatus`, `ragSkillClaims`, `quarantineSkills`, `quarantineFiles`, `quarantineCatalogs`, `quarantineMcps`, `usernames`, `userProfiles`, `userAvatars`, `SkillRow`, `FileRow`, `TagRow`, `AuditRow`, `UserRow`, `UsernameRow`, `UserProfileRow`, `UserAvatarRow`, `ApiKeyRow`, `ResetTokenRow`, `VirtualMcpRow`, `VirtualMcpSkillRow`, `VirtualMcpKeyRow`, `CatalogRow`, `CatalogSkillRow`, `VirtualMcpCatalogRow`, `SkillGrantRow`, `CatalogGrantRow`, `VirtualMcpGrantRow`, `SettingRow`, `McpSessionRow`, `McpCallCounterRow`, `SkillAccessRow`, `RagSpaceRow`, `RagTextRow`, `RagSkillTextRow`, `RagVectorRow`, `RagTextStatusRow`, `RagSkillClaimRow`, `QuarantineSkillRow`, `QuarantineFileRow`, `QuarantineCatalogRow`, `QuarantineMcpRow` |
| Tipos de query | `UserRecord`, `CreateUserInput`, `UpdateUserInput`, `ApiKeyRecord`, `RevokedApiKey`, `RevokedVirtualMcpKey`, `Stats`, `ListOptions`, `SkillVisibility`, `Viewer`, `SortOrder`, `PublicationSurface`, `PublishedSkill`, `FileInput`, `FileContent`, `SetFilesOptions`, `CreateSkillInput`, `UpdateSkillInput`, `SkillLinkFlags`, `VirtualScope`, `VirtualMcpRuntime`, `VirtualMcpKeyRecord`, `VirtualMcpKeyWithMcp`, `DefaultMcpResolution`, `CreateVirtualMcpInput`, `UpdateVirtualMcpInput`, `VirtualMcpReadOptions`, `VirtualMcpCanvasInput`, `CreateCatalogInput`, `UpdateCatalogInput`, `CatalogReadOptions`, `AdoptOrphansResult`, `OpenMcpSessionInput`, `ListMcpSessionsOptions`, `ListSkillAccessesOptions`, `ListActivityDaysOptions`, `ActivityOfDayOptions`, `ListAuditOptions`, `SemanticScope`, `SearchMode`, `SkillSearchResult`, `RagNeighbor`, `RagSettingKey`, `RagEditableSetting`, `RagSettings`, `RagSettingRow`, `RagSeedResult`, `RagSpaceInput`, `RagSpace`, `RagSkillContent`, `RagSkillFile`, `RagTextInput`, `RagPendingText`, `PendingRagTextsOptions`, `ClaimStaleSkillsOptions`, `ReleaseRagTextsOptions`, `RagVectorInput`, `RagCoverage`, `ListQuarantineOptions`, `CreateQuarantineInput`, `PromoteQuarantineOptions`, `CloneInput`, `SaveProfileInput`, `Avatar`, `AvatarMeta`, `PublicByOwner` (a entrada e a saída de `recordSkillAccess`/`listSkillAccesses` — `SkillAccessInput`, `SkillAccessEntry`, `SkillAccessPage` e os quatro literais — vêm de shared) |
| Migrations | `runMigrations` (aceita `{ refuseRetroactive }` — ver [Reaplicar migration antiga](#reaplicar-migration-antiga)), `schemaDir`, tipo `RunMigrationsOptions` |

As funções de escrita já gravam em `audit_log`, recebem a origem
(`'web-admin'` ou `'mcp-admin'`) e aceitam um **ator opcional** no fim:

```ts
await createSkill(input, 'web-admin', { userUuid: user.uuid, label: user.username });
await setFiles(slug, arquivos, 'mcp-admin', { replace: true }, ator); // actor é o 5º
```

O ator é `AuditActor` de `@purple-skills/shared` (`{ userUuid, label }`).
Omiti-lo grava a linha sem ator, como antes — nenhuma chamada existente quebra.
Em `createSkill` ele também preenche `skills.created_by_user_uuid`.

### O caractere nulo

`text` e `varchar` do Postgres não guardam U+0000: o servidor recusa o
**parâmetro** com 22021 (`invalid byte sequence for encoding "UTF8": 0x00`)
antes de olhar a consulta, e o erro subia como 500 com o SQL inteiro no log
(`tasks/038`). Duas regras, conforme o que o texto é:

- **rótulo de escrita best-effort** — o que o cliente MCP anuncia e o que vem de
  cabeçalho, em `openMcpSession`, `touchMcpSession` e `recordSkillAccess` — é
  **limpo** por `normalizeSessionLabel`, nunca recusado. Recusar fazia quem se
  apresentava com um nulo no `clientInfo.name` continuar lendo tudo e sumir da
  guia "Acessos", dos contadores e da tela de sessões;
- **todo o resto** que passa por `optionalText`/`requireText` (nome, descrição,
  slug pedido, `q`, `actor`, os obrigatórios de `openMcpSession`…) e o termo de
  `listSkills` é **400** — `O campo "<campo>" não pode conter o caractere nulo`
  / `O termo de busca não pode conter o caractere nulo`. Nada que gravava passou
  a ser recusado: com o nulo, nenhuma dessas chamadas jamais chegou ao fim.

O que **não** está coberto: identificador que chega cru a uma leitura por slug,
e-mail ou tag (`getSkillDetail`, `getSkillSummary`, `getCatalog`,
`getPublicCatalog`, `getVirtualMcp`, `resolveVirtualMcp`, `getUserByEmail`, o
`tag` de `listSkills`…) ainda devolve o 22021 do driver — medido em todas elas.
O remédio barato é do app — recusar `%00` na URL uma vez, no roteador —, não
vinte checagens aqui.

### Escrita de skill

`updateSkill` e `updateSkillWithContent` são **parciais**, no padrão de
`updateUser` / `updateVirtualMcp` / `updateCatalog`: o `UPDATE` leva só as
colunas que a chamada informou. `undefined` não mexe; `icon` nulo ou vazio
apaga, `description` nula limpa, `name` nulo ou vazio é 400; `tags` omitidas
não mexem e `[]` (ou nulo) apaga as tags. Campo ausente não vira `SET`, e por
isso dois salvamentos simultâneos na mesma skill **não se desfazem**: o
`isPublic: false` de quem acabou de tornar a skill privada não volta a `true`
porque um colega salvou um texto com a foto que tinha lido antes. Quem informa
o **mesmo** campo continua no "o último grava", como em qualquer UPDATE.

- `updated_at = now()` entra **sempre**, mesmo quando nenhuma outra coluna
  muda — é ele que ordena os "recentes" do site;
- o slug só é regravado quando a chamada pede outro, e a função devolve o
  `SkillDetail` do slug **gravado** (o novo, num rename): uma renomeação
  concorrente não é desfeita nem faz a releitura do fim falhar;
- **slug pedido explicitamente passa por `isValidSlug`** — 400 (`Slug inválido:
  "<como veio>"`) em `createSkill` e no rename, como em `createVirtualMcp` e
  `createCatalog`. Slug **omitido** continua sendo gerado do nome pelo
  `slugify`, dentro do teto de 96. Antes, `slug: "Minha Skill!"` respondia 201
  com `minha-skill`: um endereço que o cliente não pediu e que ele não consegue
  reenviar na edição, porque a validação do lado dele recusa o que mandou;
- as **tags** entram em ordem alfabética, e não na que o cliente mandou: dois
  salvamentos simultâneos que criam as mesmas tags novas em ordens diferentes
  travavam em cruz e o Postgres matava um deles (deadlock, 40P01 → 500). A
  leitura reordena por nome, então nada muda para quem chama;
- skill apagada entre a leitura e o `UPDATE` é 404 (`Skill não encontrada:
  <slug>`), não erro interno;
- **sem trava de linha nova**, de propósito: `FOR UPDATE` na skill entra em
  deadlock com o trigger `files_rag_stale_trg` (`020`) de quem grava arquivo — a
  mesma razão pela qual `createFile` trava em `FOR KEY SHARE` (ver
  [Arquivos da skill](#arquivos-da-skill)). O contrato não muda: nenhum app
  precisa tratar conflito de versão;
- **com `skillMd`, a escrita entra na fila das escritas de arquivo** (o advisory
  lock de `lockSkillFilesTx`, primeira statement da transação): ela trava
  `skills` e depois o `SKILL.md`, a ordem inversa de quem grava arquivo, e sem a
  fila `updateSkillWithContent` × `setFile('SKILL.md')` perdia um dos lados por
  deadlock em 59 de 150 pares. O `SKILL.md` anterior que a auditoria guarda é
  lido com a fila na mão. Sem `skillMd` — e em `updateSkill` — nada disso
  acontece: a escrita não toca `files` e não espera ninguém. `deleteSkill`
  entra na mesma fila.

### Arquivos da skill

O caminho passa por `normalizeRelativePath` de shared (barras, `./`, `..`,
teto de 512 caracteres; o que não serve é 400 `Caminho inválido: <como
veio>`) e é único **sem diferenciar caixa** (`003`). Mime, texto × binário e
tamanho saem de uma regra só (`fileColumns` em `queries.ts`): mime pela
extensão; texto quando o mime é textual, não há byte nulo **e os bytes são
UTF-8 válido**; binário no resto. A régua é `isTextualContent` de shared, a
mesma do `extractZip` — pacote e banco não discordam. Conteúdo vazio vale: `''`
num texto, `bytea` vazio num binário.

- **Um arquivo "de texto" em outra codificação é binário.** O `.csv` que o Excel
  exporta é Windows-1252: tem mime textual e nenhum byte nulo, e
  `toString('utf8')` não falha com ele — troca cada byte inválido por U+FFFD,
  sem erro e sem volta (`preço` virava `pre�o`, com o `size_bytes` do original e
  o conteúdo de outro tamanho). Ele é guardado byte a byte e baixado igual ao
  que chegou; não abre no editor, não entra na busca nem no RAG. O BOM é UTF-8
  válido e fica onde está.
- **O `SKILL.md` tem de ser texto.** É o único caminho que `readTextFile`, o
  `search_vector` e o RAG leem: gravado como binário, a skill ficaria de corpo
  vazio para todo leitor. Byte nulo ou UTF-8 inválido nele é 400 (`O SKILL.md
  precisa ser um texto UTF-8 válido, sem byte nulo`) em `setFile`, `setFiles`,
  `createSkill` e `updateSkillWithContent`, e nada é gravado. **A exigência é de
  `files`, não de `fileColumns`:** a gravação em `quarantine_files` passa o
  destino e aceita o `SKILL.md` binário, porque lá ninguém o decodifica e
  consertar o pacote torto é o que a quarentena faz — quem volta a cobrar o
  texto é `promoteQuarantine`, com outro 400. Ver [Quarentena](#quarentena).
- **A regra vale na gravação; a leitura usa o que está gravado**
  (`text_content IS NOT NULL`). Ampliar a tabela de mime do shared não
  reclassifica linha antiga: a `029` converteu as anteriores à beta.22 (só o
  UTF-8 válido e sem byte nulo, sem tocar hash, tamanho nem `updated_at`, e
  marcando `rag_stale`), e uma nova ampliação pede **outra** migration de
  conversão, com a lista de extensões copiada à mão — SQL não importa
  TypeScript.
- **O que já foi trocado não tem conserto** — U+FFFD não guarda o byte original.
  Dá para localizar, e é só diagnóstico (um arquivo pode conter U+FFFD de
  propósito): `SELECT s.slug, f.relative_path FROM files f JOIN skills s ON
  s.uuid = f.skill_uuid WHERE f.text_content LIKE '%' || U&'\FFFD' || '%'`.
  Reenviar o original regrava a linha, agora como binário.
- **Quem dobra a caixa é sempre o Postgres.** A identidade do caminho é o
  índice sobre `lower(relative_path)`, na coleção do banco; toda comparação —
  o dedupe do lote, o "o que fica" do `replace`, os 409 de `createFile` — usa
  essa mesma `lower()`, nunca o `toLowerCase()` do JS. Os dois discordam em
  `İ` (dois code points no JS, um na libc) e no sigma final, e o lado certo
  muda com o provedor de coleção do cluster: com a chave feita no JS, o
  `replace` apagava o `İndice.md` que acabara de gravar, e `İ.md` + `I.md` no
  mesmo lote derrubavam a statement (21000).

| Função | Semântica | Auditoria |
|--------|-----------|-----------|
| `setFile(slug, caminho, conteúdo, source, actor?)` | **upsert**: sobrescreve o arquivo existente em qualquer caixa, e a caixa nova passa a ser a gravada | `create` ou `update`, com o conteúdo anterior |
| `createFile(slug, caminho, conteúdo, source, actor?)` | **cria só se o caminho está livre**; ocupado é 409 e nada muda. Mesmos parâmetros e retorno (`SkillFileMeta`) de `setFile` | `create` com o caminho normalizado e `previousContent` nulo; recusa não audita |
| `setFiles(slug, arquivos, source, { replace?, expectedDeletions? }, actor?)` | upsert em lote; com `replace` (padrão) apaga o que ficou de fora, menos o `SKILL.md` | um `delete` por caminho removido, com o conteúdo anterior dos textuais, **mais** um `update` sem caminho |
| `deleteFile(slug, caminho, source, actor?)` | apaga a linha daquele caminho; o `SKILL.md` é 400 e caminho ausente é 404 | `delete` com o conteúdo anterior |

Skill desconhecida é 404 (`Skill não encontrada: <slug>`) nas quatro —
inclusive a que foi apagada **durante** a escrita: a FK de `files` que falhava
(23503) subia como erro interno em `setFile` e `setFiles`. Os 409
de `createFile` têm `code: 'conflict'`, não diferenciam caixa e são
conferidos nesta ordem:

| Situação | Mensagem |
|----------|----------|
| o `SKILL.md` da raiz, em qualquer caixa — existe em toda skill, mesmo sem linha | `O SKILL.md já existe em toda skill` |
| já há arquivo no caminho | `Já existe um arquivo em <caminho gravado>` |
| um prefixo do caminho é arquivo (`docs` pedindo `docs/a.md`; o `SKILL.md` da raiz conta) | `<prefixo gravado> é um arquivo, não uma pasta` |
| há arquivos abaixo do caminho (`docs/a.md` pedindo `docs`) | `Já existe uma pasta <pasta gravada>` |

O caminho da mensagem é o **gravado**, com a caixa da linha que já existe. A
comparação é `lower()` com `=` e `starts_with`, nunca `LIKE`: `_` e `%` num
nome são literais. Conteúdo que não é texto nem `Buffer` é 400 (`O conteúdo
do arquivo precisa ser texto ou bytes`). Um `skill.md` dentro de uma pasta é
um arquivo comum.

**Concorrência: a fila das escritas de arquivo.** Toda transação que mexe nos
arquivos de uma skill começa por um advisory lock de transação (chave
`hashtextextended('purple-skills:files:<uuid da skill>', 0)`,
`lockSkillFilesTx`): `createFile`, `setFile`, `setFiles`, `deleteFile`,
`deleteSkill` e o `updateSkillWithContent` que traz `skillMd`. O motivo é que
há duas ordens de trava em jogo, e elas são opostas:

- quem **grava arquivo** trava a linha de `files` e, pelos triggers
  (`files_reindex_skill_trg` no `SKILL.md`, `files_rag_stale_trg` em todo texto
  de skill indexada), pede a linha de `skills` no fim da **mesma** statement;
- quem **salva a skill com o `SKILL.md`** trava `skills` e depois a linha do
  `SKILL.md`; quem **apaga a skill** trava `skills` e a cascata pede as linhas
  de `files`; e o `setFiles` com `replace` já tem a skill (pelo trigger do
  upsert) quando o `DELETE` pede a linha que um `setFile`/`deleteFile` segura.

Medido em pares concorrentes, antes da fila: `updateSkillWithContent` ×
`setFile('SKILL.md')` perdia um dos lados por deadlock (40P01 → 500) em **59 de
150 pares**; `setFiles(replace)` × `setFile` num arquivo que sai, em 7 de 100;
× `deleteFile`, em 4 de 100. Com a fila, nenhuma morte nos mesmos laços nem em
58 mil operações mistas. Duas regras a mantêm sem ciclo, e quem mexer aqui
precisa respeitar as duas:

- ela é **sempre a primeira statement** da transação — quem espera por ela não
  segura linha nenhuma. Tomá-la depois de um `UPDATE` recria o deadlock;
- dentro dela, **nada de `db()`**: a leitura do conteúdo anterior (que a
  auditoria registra) vai pela própria transação. Uma segunda conexão do pool
  pode não vir, com a fila ocupando as outras.

`updateSkill` e o `updateSkillWithContent` **sem** `skillMd` ficam fora dela —
não tocam `files` — e não esperam um envio de arquivos em andamento. O custo de
quem entra é esperar: um `setFile` deixa de passar na frente de um `.zip` que
está sendo gravado na mesma skill.

`createFile` ainda trava a skill em `FOR KEY SHARE` (é o 404 de quem sumiu),
confere e insere com `ON CONFLICT (skill_uuid, lower(relative_path)) DO
NOTHING`; sem linha devolvida, é o 409 do arquivo existente — a garantia contra
um INSERT alheio, feito por fora destas funções. A trava **não** é `FOR UPDATE`
na skill, de propósito, e isso vale para a fila inteira: o INSERT de arquivo
pede `FOR KEY SHARE` na checagem da FK e o trigger `files_rag_stale_trg`
(`020`) faz `UPDATE` nela. Com a skill em `FOR UPDATE`, um INSERT do mesmo
caminho novo entra em deadlock (40P01) com a criação.

`setFiles` toma **a mesma trava** e é por isso que a confirmação da remoção
vale: `expectedDeletions` é o número de arquivos que a chamada espera remover,
conferido **dentro** da transação, depois do `DELETE` — se não bater, nada é
gravado e a chamada é 409. É o que fecha a janela entre a prévia que o cliente
leu (`listFiles`) e a escrita; omitido, a remoção acontece como sempre. As
linhas `delete` nascem do próprio `DELETE … RETURNING`, numa statement só: o
conteúdo registrado é o que a transação de fato apagou. O lote de gravação é
uma statement por fatia (200 arquivos ou 8 MiB), com os caminhos deduplicados
por `lower(...)` — a do Postgres, numa consulta curta antes do lote, dispensada
quando há um arquivo só. O pacote que traz `Notas.md` e `notas.md` juntos grava
uma linha, com a última grafia e o último conteúdo, como o laço de antes fazia.

`deleteFile` lê o arquivo **com a fila na mão**: duas remoções simultâneas do
mesmo caminho eram dois sucessos e duas linhas `delete`; agora a segunda é 404.

`previewSetFilesDeletions(skillUuid, caminhos)` devolve o que um `setFiles` com
`replace` **removeria** agora — os caminhos gravados fora da lista, menos o
`SKILL.md`, na ordem de `listFiles` —, com **o mesmo predicado do `DELETE`** (um
fragmento SQL só). É a prévia de quem pede confirmação antes de enviar
`expectedDeletions`: refeita no app, ela dobra a caixa com o `toLowerCase()` do
JS e discorda do banco em `İ` e no sigma final — anunciava uma remoção que não
acontece, e o 409 da contagem não tinha saída. Só leitura, sem trava (a janela
até a escrita é do `expectedDeletions`); caminho inválido é o 400 de `setFiles`
e uuid torto é `[]`.

Limite conhecido de `setFile`, que fica: não confere arquivo × pasta (um
`setFile('docs/a.md')` numa skill com o arquivo `docs` grava os dois). **Era**,
até a fila, também um limite conhecido o deadlock entre ele e uma escrita em
lote na mesma skill indexada (`setFiles` × `setFile`, desde a `020`).

### Leitura por vMCP e vínculo pelo lado da skill

`listSkills`, `getSkillSummary`, `getSkillDetail` e `listTags` aceitam
`virtualMcp?: VirtualScope` (`{ uuid, surface: 'skill' | 'prompt' |
'resource' }`) — o recorte de um MCP virtual. Com ela o `WHERE` vira a
exposição naquele servidor com a porta da superfície pedida — o vínculo
direto, ou, sem ele, a união dos catálogos (ver [Catálogos](#catálogos)) —
e ignora `visibility`. `listPublishedSkills(surface, virtualMcpUuid)` faz o
mesmo para `prompts/list` e `resources/list`, e `incrementViewCount(skill,
mcp)` / `incrementDownloadCount(skill, mcp)` somam no global **e** no caminho
(o vínculo direto, ou cada catálogo que contribuiu):

```ts
// apps/mcp-public — a raiz (vMCP padrão) e /virtual/<slug>/mcp
const resultado = await listSkills({ query, virtualMcp: { uuid: mcp.uuid, surface: 'skill' } });
const prompts = await listPublishedSkills('prompt', mcp.uuid);
await incrementViewCount(skill.uuid, mcp.uuid);

// apps/site — o padrão, `'open'`: skill ligada que é pública, está em vMCP
// aberto e ligado ou tem participação ativa em catálogo público e ligado
const catalogo = await listSkills({ query });

// apps/admin, apps/mcp-admin — o que a CONTA enxerga (`docs/12` §3.1): a sessão
// do painel ou o dono da chave `psk_`. O admin, por papel, já vê tudo por aqui.
const doPainel = await listSkills({ query, viewer: { role: user.role, userUuid: user.uuid } });
```

> **Era**, até o `017`: `// apps/admin, apps/mcp-admin — tudo` com
> `listSkills({ query, visibility: 'all' })`. **Não copie isso para um endpoint
> com conta**: `'all'` devolve o acervo inteiro — privadas, desligadas e órfãs —
> com `access: 'owner'` em cada linha, a qualquer papel (`tasks/060`). Hoje
> **nenhum app passa `'all'`**: até o `MCP_ADMIN_TOKEN` e a sessão de bootstrap
> entram por `viewer`, com `role: 'admin'` e `userUuid: null` — é o papel que
> dá a visão inteira. A opção fica para o que roda sem sessão nenhuma: o
> `seed` e as releituras internas das escritas.

O vínculo se escreve pelos dois lados. Pelo lado do MCP,
`setVirtualMcpSkills` (declarativa, abaixo). Pelo lado da skill:

- `createSkill({ …, mcps: [{ virtualMcpUuid, asSkill, asPrompt, asResource }] })`
  grava os vínculos na mesma transação da criação; uuid torto ou
  desconhecido, repetido ou flag ausente é 400 e nada é gravado;
- `linkSkill(slug, virtualMcpUuid, flags, source, actor, { position? })`
  cria ou reescreve um vínculo (contadores e posição no canvas de um vínculo
  existente ficam; `position` informada entra no INSERT e substitui no
  UPDATE) e devolve o `SkillDetail` com `mcps`;
- `unlinkSkill(slug, virtualMcpUuid, source, actor)` desfaz; vínculo
  inexistente é 404.

Os três auditam `mcp.update` no vMCP, com o slug dele em `targetLabel`, como
`setVirtualMcpSkills`. **A permissão é do app**, e vem antes de chamar:
`edit` no vMCP alvo **e** `view` na skill para vincular (`docs/12` decisão 6);
só o `edit` do vMCP para desvincular.

> **Era**, até o `017`: "conferir que o chamador administra o vMCP
> (`canManageVirtualMcp`)". O helper continua exportado, `@deprecated`, como
> atalho de `accessLevel` + `canOwn` — mais restritivo que a regra em vigor: com
> ele, quem tem `edit` concedido no servidor recebe 403 (`tasks/060`).

**Concorrência: a ordem das travas no recorte de um vMCP.** Toda escrita que
mexe nos vínculos de um servidor — `linkSkill`, `unlinkSkill`, os `mcps` de
`createSkill`, `setVirtualMcpSkills`, `setVirtualMcpCanvas` e o lado dos
catálogos — segue a mesma ordem: **trava** a linha do vMCP, mexe nos vínculos e
só então **grava** no vMCP (`updated_at`, `layout`). São três regras, cada uma
com o deadlock (40P01 → 500) que a motivou, medido em pares concorrentes:

| Regra | Sem ela |
|-------|---------|
| **o vMCP antes do vínculo.** `linkSkill`/`unlinkSkill` reescreviam o vínculo e só depois tocavam o servidor — a ordem inversa do canvas e do recorte | 28 mortes em 150 pares `linkSkill` × canvas, 57 com `unlinkSkill`, 59 e 71 contra `setVirtualMcpSkills`. Um operador só dispara: soltar um nó e mexer numa porta dele dentro do debounce do canvas |
| **trava pura no começo, `UPDATE` no fim.** A checagem de FK (`FOR KEY SHARE`) de quem insere filho do servidor não espera um `FOR NO KEY UPDATE` — salvo quando segue a cadeia de versões da linha e esbarra numa versão ainda não commitada: aí espera o `UPDATE` em andamento (`while rechecking updated tuple` no log) | com o `UPDATE virtual_mcps` adiantado para o começo, `recordSkillAccess` (que soma o contador do vínculo e depois confere a FK com o vMCP) fechava ciclo com quem atualizou o vMCP e esperava o vínculo: 3 mortes em 34 mil operações mistas. Com `SELECT … FOR NO KEY UPDATE` no começo, nenhuma em 58 mil |
| **`FOR NO KEY UPDATE`, não `FOR UPDATE`**, nas travas do vMCP (`lockVirtualMcpTx`, `setVirtualMcpSkills`, `setVirtualMcpCanvas`, `linkTx`). As duas excluem todo escritor do recorte e seguram `deleteVirtualMcp`, a renomeação e a transferência; `FOR UPDATE` barra também o `FOR KEY SHARE` das FKs | `recordSkillAccess` × canvas: 9 mortes em 150 pares; × `setVirtualMcpSkills`: 26 — quase sempre a do registro de acesso, e a leitura sumia da guia Acessos com o contador. De quebra, a abertura de sessão e os demais registros de acesso do servidor ficavam ~1 s na fila |

Os `mcps` de `createSkill` são gravados **na ordem do uuid**, e não na que o
cliente mandou: cada vínculo trava o seu servidor até o COMMIT, e duas criações
publicando nos mesmos dois servidores em ordens opostas perdiam uma das duas em
149 de 150 pares. O que muda para quem lê é a ordem das linhas `mcp.update` na
auditoria. E o vMCP apagado entre a validação e a transação de `linkSkill` é o
mesmo 400 da validação (`MCP virtual não encontrado: <uuid>`), em vez da FK do
vínculo subir como erro interno (44 de 100 pares `deleteVirtualMcp` ×
`linkSkill`).

Resíduo conhecido, fora destas funções: `deleteVirtualMcp` × `recordSkillAccess`
não deu deadlock em 100 pares, mas em 9 deles o registro de acesso resolveu o
vMCP, perdeu a corrida e falhou na FK (23503) — a leitura fica sem linha. É
melhor esforço de quem chama, e apagar um servidor sob tráfego é raro.

### Manifesto da extensão de skills

A extensão de skills do MCP (SEP-2640,
[`docs/17-skills-extension.md`](../docs/17-skills-extension.md)) publica cada
skill como um *resource* conformante, com o inventário dos arquivos e um
digest por arquivo. **Nenhuma migration saiu daí**: o digest é o
`files.content_sha256` que a `020` já mantém por trigger.

```ts
// apps/mcp-public — skills/list (o catálogo) e skills/get (uma skill)
const manifesto = await listSkillsManifest(mcp.uuid);
const [uma] = await listSkillsManifest(mcp.uuid, { slug });
const corpos = await readSkillMdBodies(furosDoCache);
```

- `listSkillsManifest(virtualMcpUuid, { slug? })` devolve `SkillManifestEntry[]`
  — `uuid`, `slug`, `name`, `description`, `tags`, `updatedAt` e `files`
  (`{ relativePath, sizeBytes, sha256 }`, o hash em hexadecimal minúsculo; quem
  monta o prefixo `sha256:` é o consumidor). O recorte é o de toda leitura do
  servidor: `s.is_active` mais `exposedIn` na superfície `'skill'`, isto é, a
  precedência do vínculo direto sobre o catálogo, sem reimplementação. Por slug
  ASC, como `listPublishedSkills`, e uuid torto devolve `[]`. Os arquivos vêm
  **todos** (o `SKILL.md` inclusive), na ordem de `listFiles`.
- As **tags saem por `array_agg(t.name ORDER BY t.name)`**, e isso é
  invariante, não gosto: o servidor remonta o frontmatter com elas
  (`buildFrontmatter`, que respeita a ordem recebida) e publica o SHA-256 do
  texto composto. Tag fora de ordem faria o digest divergir do conteúdo entre
  duas chamadas, de forma intermitente.
- **Nenhum corpo de arquivo entra no manifesto** — é o ponto dele. O `SKILL.md`
  é gravado **sem frontmatter**, então o `content_sha256` daquela linha é o hash
  do corpo, e não do que o `resources/read` devolve: publicá-lo faria toda skill
  falhar na verificação de todo host. O digest e o tamanho do `SKILL.md`
  composto são calculados pelo servidor, na hora, por `composeSkillMd`.
- `readSkillMdBodies(uuids)` devolve `{ skillUuid, body }[]` — o corpo gravado,
  em lote, para os furos do cache de `skills/list`. **Sem ordem definida** (o
  lote é fatiado de 50 em 50): case pelo `skillUuid`. Uuid torto é filtrado em
  vez de estourar no driver, repetido volta uma vez só, e a skill sem linha de
  `SKILL.md` — ou com ela gravada como binário — simplesmente não aparece, o que
  não é erro.
- `updatedAt` é a chave de cache do texto composto, e ela é sólida porque
  `planSkillUpdate` empurra `updated_at = now()` em qualquer `updateSkill`
  (inclusive numa troca só de tags) e o trigger `files_reindex_skill_tg` da
  `001` carimba a skill quando a linha alterada é o `SKILL.md`.

Por que funções novas e não `listSkills`/`listFiles`: a primeira clampa em 100
e carrega agregações que o manifesto descarta (o mesmo motivo de
`listPublishedSkills`); e `SkillFileMeta` é tipo do shared, lido pelo painel e
pelo site, que não têm o que fazer com um hash.

### MCP virtual

- `listVirtualMcps()` sem opção é a visão do admin (todos, inclusive inativos
  e órfãos); `{ viewer }` é o que a conta vê e `{ scope }` o filtro do
  painel (ver [Acesso granular](#acesso-granular)); `{ ownerUserUuid }`
  restringe ao dono; `{ ownerUserUuid: null }` devolve `[]` — a sessão de
  bootstrap não é dona de nada. `listOpenVirtualMcps()` é a lista do site:
  só abertos e ligados, sem dono nem chaves, com `skillCount` e `isDefault`.
- `VirtualMcpSummary` traz, além de `skillCount`, os contadores por porta
  (`toolCount` = vínculos com `as_skill`, `promptCount`, `resourceCount`) —
  todos **só dos vínculos diretos** —, `catalogCount`, os dois previews da
  colmeia do card — `preview` (skills com vínculo direto, por nome: `slug`,
  `name`, `icon`) e `previewCatalogs` (catálogos vinculados, por nome:
  `slug`, `name`, `isActive` do catálogo), cada um com até
  `VIRTUAL_MCP_PREVIEW_SIZE` (19, de shared) itens; os contadores continuam
  contando tudo — e `onlineSessions`.
  Este último só é contado quando a chamada informa a
  janela — `listVirtualMcps({ onlineWindowMs })`, `getVirtualMcp(slug, {
  onlineWindowMs })`, `getVirtualMcpByUuid(uuid, { onlineWindowMs })`; sem
  ela é 0 e `mcp_sessions` nem é consultada. Janela não finita ou ≤ 0 é 400.
- `getVirtualMcp(slug, { viewer? })` / `getVirtualMcpByUuid(uuid, {
  viewer? })` devolvem `VirtualMcpDetail` (resumo + skills vinculadas, com
  as flags, os contadores **do vínculo**, o `icon` e a `position` no canvas +
  `catalogs`, os catálogos vinculados com as portas, a `position` e o
  `activeSkillCount` do nó + o `layout` dos nós fixos + `grants`) e incluem
  inativos: é o painel que lê. Com `viewer` que não é admin, `null` fora do
  que a conta vê. `resolveVirtualMcp` é o oposto — só ativos, uma linha, sem
  agregação — e é o que o servidor consulta a cada requisição.
- `setVirtualMcpCanvas(uuid, { layout?, positions?, catalogPositions? })`
  grava o canvas: mescla `layout` chave a chave (só as informadas
  substituem) e grava `pos_x`/`pos_y` das skills (`positions`) e dos
  catálogos (`catalogPositions`) listados (`{ slug, x, y }`). Coordenadas
  precisam ser números finitos e são arredondadas para o pixel inteiro. Tudo
  numa transação: slug desconhecido, repetido ou não vinculado a **este**
  vMCP é 400 e nada é gravado; uuid inválido ou sem linha é 404. Sem
  auditoria e sem `updated_at`. A permissão é do app.
- `createVirtualMcp` / `updateVirtualMcp` / `deleteVirtualMcp` exigem ator e
  auditam como `mcp.create` / `mcp.update` / `mcp.delete`, com `targetLabel`
  = slug do MCP (o novo, em rename; `<slug> <username>` numa transferência).
  Slug omitido é gerado do nome; informado passa por `isValidSlug`; em uso é
  409. `updateVirtualMcp` é parcial no padrão de `updateUser` (`undefined`
  não mexe, `ownerUserUuid: null` apaga o dono; um uuid precisa ser de conta
  ativa e apaga a concessão dela — ver [Acesso granular](#acesso-granular)).
- `setVirtualMcpSkills(uuid, lista)` é **declarativa**: a lista é o estado
  desejado. Quem saiu é removido, quem entrou é inserido, quem ficou tem só as
  flags reescritas e mantém os contadores. As três flags são obrigatórias por
  item; slug desconhecido ou repetido é 400 e nada muda.
- Chaves `psv_` espelham as `psk_`: `createVirtualMcpKey` recebe prefixo e
  hash já gerados pelo app (`generateApiKey('psv')`), `getVirtualMcpKeyByPrefix`
  acha a linha — conferir o segredo **e** se `virtualMcpUuid` é o do servidor
  da URL é do app — e `revokeVirtualMcpKey(id, virtualMcpUuid)` é sempre
  restrita ao MCP. Devolve `RevokedVirtualMcpKey` (`{ name, prefix }`) da chave
  revogada, ou `null` quando não achou, não é daquele servidor ou já estava
  revogada (era `boolean` até o `tasks/040`; `if (!revoked)` continua valendo).
  A auditoria das chaves (`mcp.key.create` / `mcp.key.revoke`) é gravada pelo
  app via `recordAccountAudit`, e o `targetLabel` identifica a chave pelo
  **nome** — na revogação também: é para isso que ela devolve nome e prefixo,
  lidos no próprio UPDATE. O uuid da chave não serve de rótulo: não aparece em
  tela nenhuma e some com o vMCP (`CASCADE`), deixando a linha sem referente.
- `listVirtualMcpKeysByCreator(userUuid)` é "Meu espaço → Chaves emitidas":
  as chaves que a conta emitiu (`created_by_user_uuid`), em todos os vMCPs,
  como `VirtualMcpKeyWithMcp` — o `VirtualMcpKeySummary` de
  `listVirtualMcpKeys` (nunca o hash) mais `virtualMcpSlug` e
  `virtualMcpName`. Ativas primeiro, depois `created_at DESC`; inclui as
  revogadas. Uuid torto é `[]`. Não filtra por acesso ao servidor (a chave é
  de quem emitiu; o que mostrar é do app); chave de vMCP apagado some com ele
  (`CASCADE`), e a de conta removida perde o emissor (`SET NULL`) e sai da
  lista. Índice do `021`.

### MCP padrão

- `resolveDefaultVirtualMcp()` é a consulta de toda requisição à raiz do
  mcp-public (e do `/api/meta` do site): um `LEFT JOIN` de `settings` com
  `virtual_mcps` por `uuid::text`, sem cache. Devolve `DefaultMcpResolution`:
  `{ status: 'ok', mcp }` com o mesmo `VirtualMcpRuntime` de
  `resolveVirtualMcp`, ou `none` (chave ausente/nula), `deleted` (valor sem
  linha) e `inactive` (linha com `is_active = false`, com `uuid` e `slug`).
- `setDefaultVirtualMcp(uuid | null, source, actor)` faz o upsert da chave e
  audita como `mcp.default`, com o slug novo — ou `"nenhum"` — em
  `targetLabel`. Uuid sem linha é 404; um vMCP desligado é aceito. **Só o
  admin escolhe**, e essa checagem é do app. O valor gravado é o uuid
  **canônico, lido do banco**, não o texto recebido: maiúsculas são o mesmo
  uuid para a validação, mas a leitura compara `uuid::text` (sempre em
  minúsculas) com o texto de `settings`, e o valor gravado como veio fazia o
  padrão recém-escolhido resolver como `deleted` (`tasks/033`). Quem tiver um
  valor antigo em maiúsculas conserta escolhendo o mesmo servidor de novo.
- `VirtualMcpSummary.isDefault` é calculado na listagem e no detalhe a partir
  da mesma chave.

### Contas, chaves e senha

- `UserRecord` é `UserSummary` **mais** `passwordHash`, `tokenVersion`,
  `failedAttempts` e `oidcSubject`. Nada disso vai para o navegador: `listUsers`
  devolve `UserSummary`. `UserSummary` ganhou `avatarUpdatedAt` no `034`:
  o carimbo da foto, nulo quando não há — os **bytes** nunca saem por aqui (ver
  [Perfil](#perfil)).
- `updateUser` é parcial. `undefined` é "não mexe", `null` é "apaga";
  `bumpTokenVersion: true` incrementa `token_version` e derruba todo cookie já
  emitido para a conta.
  - **`updated_at` é "última alteração administrativa da conta"**, e é por isso
    que `registerFailedLogin`/`registerSuccessfulLogin` não o tocam. Pelo mesmo
    motivo, `updateUser(uuid, { bumpTokenVersion: true })` **sozinho** — o "Sair"
    do painel — não o carimba: é movimento de sessão, sem linha na trilha que
    explique uma data nova (`tasks/034`). Com qualquer campo da conta junto
    (senha, papel, ativação, vínculo OIDC, destrave) o carimbo vale, e
    `updateUser(uuid, {})` continua sendo um UPDATE válido que carimba.
  - **`clearLoginLock: true`** zera `failed_attempts` e `locked_until` no mesmo
    UPDATE (`tasks/005`). É o destrave que acompanha a senha redefinida por
    quem administra ou por um link de e-mail: o login confere a trava **antes**
    da senha, então sem ele a senha nova, correta, segue recusada até o prazo
    vencer. `false` e ausente não mexem; `last_login_at` fica como está — não é
    login. Quando passá-lo é decisão do app.
- As duas invariantes da população de administradores são **opt-in**, e as duas
  correm numa transação atrás do mesmo advisory lock (chave
  `hashtextextended('purple-skills:admins', 0)`) — em READ COMMITTED,
  `INSERT … WHERE NOT EXISTS` e `UPDATE … WHERE … AND EXISTS (…)` avaliam o
  predicado no snapshot da transação, não há linha em que travar, e duas
  transações simultâneas passam as duas:
  - `createUser({ …, onlyIfTableEmpty: true })` grava **só com a tabela de
    contas vazia** — é o primeiro administrador, o `/api/setup`. Tabela cheia é
    409 (`Este painel já tem contas: o primeiro administrador já foi criado`).
    Dois setups simultâneos criavam dois admins ativos, e isso **desliga** a
    adoção de órfãos (`adoptOrphans` exige uma admin ativa só). **Sem o campo,
    `createUser` grava em qualquer estado da tabela, inclusive vazia e com
    qualquer papel**: que a primeira conta seja o admin do setup é garantia de
    quem chama (`tasks/001`) — ver
    [Instalação sem administrador](#instalação-sem-administrador);
  - `updateUser(uuid, { …, requireOtherActiveAdmin: true })` recusa com 400
    (`Esta é a última conta de administrador ativa — promova outra antes`, o
    texto que o painel já mostra) quando, depois do `UPDATE`, não existe
    **outra** conta admin ativa. Informe o campo só quando a escrita tira a
    conta do grupo (rebaixar ou desativar um admin): a conferência é "existe
    outra", não "sobrou alguma". Sem o campo, nada muda — e é assim que um
    ambiente de teste ainda consegue desativar a última admin.
- `registerFailedLogin(uuid, { maxAttempts, lockSeconds })` faz tudo num UPDATE
  só. Ao atingir o teto, grava `locked_until` e **zera** o contador.
- `getApiKeyByPrefix` faz só o primeiro passo: achar a linha pelo prefixo
  público. Comparar o segredo com `keyHash` é do app
  (`verifyApiKeySecret` de shared).
- `revokeApiKey(id, userUuid?)` com dono restringe ao dono; sem dono é o admin.
  Devolve `RevokedApiKey` — `{ name, prefix, userUuid, userEmail }`, o que
  identifica a chave numa linha de auditoria, com o **dono** dela (que com o
  admin revogando não é quem chamou) — ou `null` quando não achou ou já estava
  revogada, sem reescrever o `revoked_at` original. Era `boolean` até o
  `tasks/040`: quem só testa `if (!revoked)` não muda. É com esse retorno que o
  app rotula o `key.revoke` como rotulou o `key.create`, pelo nome e pelo
  prefixo, em vez do uuid da chave.
- `createResetToken` emite o link e **fecha os que a conta tinha vivos**; a
  assinatura (`{ userUuid, tokenHash, expiresAt }`) não mudou. `consumeResetToken`
  é um UPDATE condicional atômico: dois cliques no mesmo link não redefinem a
  senha duas vezes, e link substituído ou vencido devolve `null`, sem distinguir
  o motivo. Trocar a senha por `updateUser` fecha os vivos por trigger — ver
  [Links de redefinição de senha](#links-de-redefinição-de-senha).
- `recordAccountAudit` grava os eventos de conta (`user.create`, `user.role`,
  `user.deactivate`, `user.activate`, `user.password`, `user.link`,
  `user.username`, `key.create`, `key.revoke`), os das
  chaves de MCP virtual (`mcp.key.create`, `mcp.key.revoke`) e os das chaves do
  MCP principal (`public.key.create`, `public.key.revoke`) — linhas sem skill,
  com `targetLabel` dizendo sobre quem foi.
- `user.password` (`024`) é a senha de **outra** conta trocada por quem
  administra ou por um link de redefinição; `targetLabel` é o username da conta
  afetada e o **ator** diz o caminho: o username do admin, `bootstrap` ou
  `link-de-redefinicao` (ali só se sabe que alguém portava o link). A troca
  feita pelo próprio dono logado fica fora, como o login. Senha nenhuma, nem
  hash, entra na linha.
- `user.activate` e `user.link` (`026`, `tasks/003`) são os outros dois eventos
  que mudam **quem consegue entrar** na conta. `user.activate` é o par de
  `user.deactivate`: reativar devolve o login, as concessões e as chaves `psk_`
  de uma vez; ator = quem reativou, `targetLabel` = username da conta. `user.link`
  é uma identidade OIDC passando a abrir uma conta local que já existia — uma
  vez por conta, **não é login** (login segue fora da trilha, `docs/05` §2.8);
  o ator é o caminho, `oidc:<issuer>` com `userUuid` nulo, como no `user.create`
  por SSO, e `targetLabel` leva o username e o `subject` que assumiu a conta.
- `user.profile` (`034`) é o admin **limpando** o perfil público de uma conta.
  **Não** passa por `recordAccountAudit`: quem a grava é `clearProfile`, que
  apaga e audita na mesma transação — auditar numa chamada à parte deixaria a
  trilha e o dado divergirem quando a segunda falhasse. Ator = quem limpou,
  `targetLabel` = o username de quem foi limpo. Ver [Perfil](#perfil).
- `user.username` (`033`) é o username de uma conta trocado por um **admin**
  (`docs/19` decisão 5 — só admin troca): ator = quem trocou, `targetLabel` =
  `<antigo> -> <novo>`, a mesma gramática da clonagem (`031`). É esta linha que
  mantém legível a trilha anterior à troca, e o nome antigo não volta a
  circular (decisão 6) — então ela nunca passa a apontar para outra pessoa.

### Instalação sem administrador

O painel fecha o `/api/setup` e o login pela `ADMIN_PASSWORD` quando aparece a
**primeira conta**, não o primeiro administrador. Se essa conta nasceu `membro`
ou `editor` (`tasks/001`: o primeiro login por SSO antes do setup, ou uma conta
criada pela API com a sessão de bootstrap), a instalação fica com contas e
**sem ninguém que possa promover ninguém** — e a volta é pelo banco. Esta é a
única escrita à mão que esta especificação recomenda; rode-a no `psql` do
container (`docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d
"$POSTGRES_DB"'`), trocando o e-mail:

```sql
-- O diagnóstico: a receita só vale com `admins_ativos = 0`.
SELECT count(*) AS contas,
       count(*) FILTER (WHERE role = 'admin' AND is_active) AS admins_ativos
FROM users;

-- A promoção, com a linha na trilha que o painel gravaria (`user.role`).
WITH promovida AS (
  UPDATE users
  SET role = 'admin', is_active = true, token_version = token_version + 1, updated_at = now()
  WHERE lower(email) = lower('pessoa@exemplo.com')
    AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND is_active)
  RETURNING username
)
INSERT INTO audit_log (action, source, actor_label, target_label)
SELECT 'user.role', 'web-admin', 'sql-manual', username || ' → admin' FROM promovida
RETURNING target_label;
```

- é o que `updateAccount` faz numa promoção: papel, `token_version + 1` (a
  sessão aberta da conta cai e ela entra de novo já como admin) e a linha
  `user.role` com `<username> → admin`. A conta é **procurada** pelo e-mail (é
  o que quem opera tem na mão) e o rótulo gravado é o **username**, como toda
  linha da trilha desde o `033`. O ator é `sql-manual`, sem conta — o
  `source` é `web-admin` porque o `CHECK` só tem dois valores, como no `seed`;
- o `NOT EXISTS` é o que a torna **segura ao repetir**: com um administrador
  ativo ela não promove nem audita nada (devolve zero linhas) — havendo admin,
  o caminho é a tela de contas. Zero linhas na primeira vez é e-mail errado;
- **não esvazie `users`** para reabrir o setup: a cascata leva as chaves `psk_`
  e todas as concessões das contas, e deixa órfão o que elas possuíam.

### Auditoria paginada

`listAudit(limit)` continua sendo as últimas linhas, sem filtro (o widget do
dashboard). A tela da trilha usa `listAuditPage(options)`, que devolve
`AuditPage` (`items`, `total`, `limit`, `offset`), com `total` sob os mesmos
filtros da página:

| Opção | Efeito |
|-------|--------|
| `limit`, `offset` | clamp 1..200, padrão 50; offset negativo ou torto vira 0 e o que passa de `Number.MAX_SAFE_INTEGER` **satura** nele — ver [O offset satura](#o-offset-satura) |
| `action` | igualdade; valor fora do `CHECK` de `audit_log.action` é 400 |
| `actor` | igualdade com `actor_label` (username, `token-global`, `bootstrap`, `seed`) |
| `q` | `ILIKE %q%` em `skill_slug`, `target_label`, `file_path` e `actor_label`, com o termo **literal** e os quatro GIN de trigrama do `022` — ver [O termo de busca](#o-termo-de-busca-literal-e-indexado) |
| `since`, `until` | `created_at >=` / `<=`; precisam ser `Date` válidas |

#### O offset satura

Vale para as quatro listagens paginadas — `listSkills`, `listAuditPage`,
`listMcpSessions` e `listSkillAccesses` —, que passam o deslocamento pelo mesmo
`pageOffset`. `OFFSET` é `bigint` e o driver manda o número como texto:
`?offset=99999999999999999999` chega como `1e20`, finito e inteiro para o
JavaScript, sobe como `"100000000000000000000"` e o Postgres responde 22003; de
`1e21` em diante o texto é `"1e+21"` e a resposta é 22P02. Os dois eram 500
numa listagem **anônima** (`tasks/086`). Agora o valor satura em
`Number.MAX_SAFE_INTEGER` — cabe folgado no `bigint` e é o maior inteiro exato
do `number`, então o `offset` devolvido na página é o que foi ao banco — e a
resposta é a página vazia de quem paginou além do fim, com o `total` certo.
**Saturar, e não recusar**, é o que `limit` (`clamp`) e o offset negativo já
faziam; nenhum chamador precisa tratar erro novo. `Infinity` e `NaN` continuam
virando 0. Um `limit` que chega `NaN` continua virando o **mínimo** (1), não o
padrão: quem lê inteiro de query string usa o `asInt` do app, não `Number(...)`.

### Sessões MCP: as queries

Quem escreve é o mcp-public, a cada requisição; quem lê é o painel. As
regras de "online", fim real, fim presumido e histórico estão em
[Sessões do MCP público](#sessões-do-mcp-público), acima.

```ts
const id = await openMcpSession({
  sessionId, transport: 'streamable', mount: 'root',
  virtualMcpUuid: mcp.uuid, virtualMcpSlug: mcp.slug,
  auth: key ? 'key' : 'open', keyId: key?.id ?? null,
  ip: req.ip, userAgent: req.get('user-agent'),
  clientName, clientVersion,            // do initialize, quando já se sabe
  requests: 1,                          // já contadas na abertura (padrão 1)
});
await touchMcpSession(id, { requests: 1, clientName, clientVersion }); // last_seen_at = now()
await closeMcpSession(id, 'closed');                                  // ou 'shutdown'
await closeMcpSessions(idsAbertos, 'shutdown');                       // no desligamento; devolve quantas fechou
const reuso = await findOpenMcpSession({ sessionId: chave, transport: 'stateless', withinMs });
const fechadas = await expireMcpSessions({ statelessWindowMs, sessionTtlMs }); // a varredura
```

- `openMcpSession` devolve o `id` da linha, que o servidor guarda ao lado do
  transporte. `sessionId`, `ip` e `virtualMcpSlug` vazios, uuid torto ou
  valor fora dos `CHECK`s são 400; vMCP ou chave que sumiram entre a
  resolução e a abertura, 404. `userAgent`, `clientName` e `clientVersion`
  passam por `normalizeSessionLabel` (abaixo): sem caractere de controle,
  aparados e cortados em 512 caracteres. O `clientInfo` é texto livre do
  cliente, e um byte nulo nele fazia a sessão inteira não ser registrada.
- `normalizeSessionLabel(texto): string | null` e `MCP_SESSION_LABEL_MAX`
  (512) são **a regra do rótulo**, exportada para o mcp-public aplicar na
  memória o mesmo corte que o banco aplica na gravação: categoria Unicode
  `Cc` (C0, DEL, C1) e separadores de linha (`Zl`/`Zp`) viram espaço, as
  pontas são aparadas, vazio é `null`, o resto é cortado no teto. É
  idempotente, e o resultado é uma **cópia**: no V8 o recorte de uma string
  longa segura a string-mãe inteira (medido: 400 rótulos de 512 caracteres
  tirados de nomes de 1 MB seguravam 401 MB de heap; copiados, 1,4 MB).
- `touchMcpSession` soma `requests`, avança `last_seen_at` e preenche
  `client_name`/`client_version` **só se ainda nulos**; linha encerrada não
  é tocada; `id` torto é ignorado (é o caminho quente, como `touchApiKey`).
- `findOpenMcpSession` devolve o `id` da linha aberta com esse
  `sessionId`/`transport` e atividade dentro de `withinMs` (a mais recente,
  se houver mais de uma), ou `null`.
- `expireMcpSessions` encerra como `timeout` e devolve quantas fechou.
- `listMcpSessions({ onlineWindowMs, virtualMcpUuid?, virtualMcpUuids?,
  onlineOnly?, limit?, offset? })` devolve `McpSessionPage`: ordem
  `last_seen_at DESC`, `keyName` por `LEFT JOIN virtual_mcp_keys`, `isOnline`
  pela janela (obrigatória). `virtualMcpUuids` é o recorte de quem não é
  admin (só os vMCPs que administra): `[]` devolve a página vazia sem
  consultar, e sessões de um vMCP já apagado ficam fora dele — só o admin as
  vê. Uuid torto em qualquer filtro é 400; `limit` clamp 1..200, padrão 50;
  offset torto vira 0 e o gigante satura ([O offset satura](#o-offset-satura)).
- `countOnlineMcpSessions({ onlineWindowMs, virtualMcpUuid? })` é o número do
  globo: `{ total, byTransport: { streamable, sse, stateless } }`.

### Acessos por skill: as queries

Quem escreve é quem serve a skill (mcp-public, site, mcp-admin), disparando
sem esperar; quem lê é o painel. As regras de caminho, cópias e histórico
estão em [Acessos por skill](#acessos-por-skill), acima.

```ts
// apps/mcp-public — get_skill num vMCP com chave
void recordSkillAccess({
  skillUuid: detail.uuid, kind: 'view', surface: 'tool', origin: 'mcp',
  auth: key ? 'key' : 'open', virtualMcpUuid: mcp.uuid, keyId: key?.id,
  sessionId, ip: req.ip, userAgent: req.get('user-agent'), clientName, clientVersion,
}).catch(log);

// apps/site — o pacote
void recordSkillAccess({ skillUuid, kind: 'download', surface: 'download', origin: 'site', auth: 'anonymous', ip, userAgent }).catch(log);

// apps/mcp-admin — get_skill pela chave psk_
void recordSkillAccess({ skillUuid, kind: 'view', surface: 'admin-tool', origin: 'mcp-admin', auth: 'user', apiKeyId: key.id, userUuid: user.uuid, ip }).catch(log);

// apps/admin — a guia "Acessos"
const page = await listSkillAccesses({ skillUuid, q: 'ana@', origin: 'mcp', limit: 50, offset: 0 });
const doCatalogo = await listSkillAccesses({ catalogUuid });
```

- `recordSkillAccess(input: SkillAccessInput): Promise<void>` grava a linha
  **e soma os contadores** (skill sempre; com `virtualMcpUuid`, o vínculo
  direto se existir, senão cada catálogo que contribuiu — os mesmos que
  entram na linha), numa instrução só e sem transação, como `bumpCounter`.
  Com `origin: 'mcp-admin'` **só grava a linha**: contador nenhum é tocado.
  Resolve as cópias sozinha (slug/nome da skill e do vMCP, nome da chave
  `psv_` por `keyId`, da `psk_` por `apiKeyId`, username por `userUuid`).
  `kind`/`surface`/`origin`/`auth` fora dos `CHECK`s, `skillUuid` torto ou
  rótulo que não é string são 400 (bug do chamador). **Skill inexistente não
  grava nada e não lança** — ela pode ter sumido entre a leitura e o
  registro. Uuid torto num campo opcional, ou vMCP/chave/conta que já não
  existe, é ignorado: a coluna fica nula e `auth` fica como veio. Os
  rótulos (`sessionId`, `ip`, `userAgent`, `clientName`, `clientVersion`)
  passam por `normalizeSessionLabel` — sem caractere de controle, aparados
  e cortados em 512 caracteres — e as cópias de nome são cortadas no mesmo
  teto; o byte nulo num rótulo **não** derruba mais a linha nem os
  contadores (ver "rótulos e cópias" em
  [Acessos por skill](#acessos-por-skill)). Os catálogos do caminho são só os
  que servem a porta da `surface` informada.
- `listSkillAccesses({ skillUuid?, catalogUuid?, virtualMcpUuid?, userUuid?,
  apiKeyId?, q?, origin?, kind?, limit?, offset? })` devolve
  `SkillAccessPage` (`items: SkillAccessEntry[]`, `total`, `limit`,
  `offset`): ordem `created_at DESC, id DESC`; os filtros por objeto são
  igualdade e se somam (`userUuid` é a guia da conta — as leituras pelas
  chaves `psk_` dela —, `apiKeyId` recorta a uma chave); `limit` clamp
  1..200, padrão 50; offset torto vira 0 e o gigante satura
  ([O offset satura](#o-offset-satura)); `q` é `ILIKE %q%` em
  `user_username`, `api_key_name`, `key_name`, `ip`, `client_name` e
  `session_id`, com o termo **literal** e os seis GIN de trigrama do `022`
  (ver [O termo de busca](#o-termo-de-busca-literal-e-indexado));
  `origin`/`kind` fora do `CHECK` e uuid torto em qualquer
  filtro são 400. `catalogs` vem como `[{ uuid, slug, name }]` na ordem
  gravada (por nome), com `uuid` nulo para catálogo já apagado. O filtro
  pela skill, pelo vMCP, pela conta ou pela chave apagados não acha mais
  nada (a coluna foi a nulo); o pelo catálogo apagado ainda acha, porque o
  array guarda o uuid.

### Atividade: as queries

Quem escreve é o mcp-public, a cada flush; quem lê é o painel — a tela é só do
admin, como a Auditoria. As regras de balde, chave, `family` e histórico estão
em [Atividade](#atividade), acima.

```ts
// apps/mcp-public — o despejo dos baldes fechados, junto com o de request_count
await bumpMcpCallCounters([
  { bucket: '2026-05-20T09:00:00.000Z', virtualMcpUuid: mcp.uuid, virtualMcpSlug: mcp.slug,
    transport: 'streamable', method: 'tools/call', calls: 5 },
]);

// apps/admin — a grade, no fuso do navegador
const days = await listActivityDays({ since, until, timezone: 'America/Sao_Paulo' });

// apps/admin — o dia clicado, já convertido em instantes pelo painel
const relatorio = await activityOfDay({ since: inicioDoDia, until: fimDoDia, top: 5 });
```

- `bumpMcpCallCounters(items: readonly McpCallBucketInput[]): Promise<void>`
  soma os baldes num **único** `INSERT ... ON CONFLICT` por lote (500 linhas
  por statement), nunca um por item. Lista vazia devolve sem consultar. O
  `bucket` é achatado no passo de `MCP_CALL_BUCKET_MS` ainda que já venha
  alinhado — a PK é por balde, e um instante fora do passo fragmentaria a linha
  que deveria somar. O `method` é limpo e cortado (acima) e o lote é
  **deduplicado depois da limpeza**: dois métodos crus que virem o mesmo texto
  na mesma statement dariam 21000 ("ON CONFLICT DO UPDATE command cannot affect
  row a second time"), a armadilha já medida em `upsertFilesTx`. Item sem
  método que sobreviva à limpeza, ou com `calls` zero, é descartado — não é
  chamada nenhuma. `bucket` que não é data, uuid torto, slug vazio, transporte
  fora do `CHECK` e `calls` negativo são **400**: esses campos são nossos, não
  do cliente, e um valor errado neles é bug de quem chama.
- **As linhas vão ao banco ordenadas pela chave**, e o `SELECT` do INSERT leva
  um `ORDER BY` que fixa essa ordem no plano. É a lição de `replaceTagsTx`: o
  `ON CONFLICT DO UPDATE` trava as linhas uma a uma, na ordem em que elas saem
  da consulta, e cada uma fica travada até o COMMIT. O rastreador do mcp-public
  despeja **todas** as sessões de uma vez, e duas sessões do mesmo vMCP, mesmo
  transporte e mesmo balde trazem os mesmos métodos em ordens diferentes — a
  ordem em que cada uma viu cada método pela primeira vez. Sem a ordenação elas
  travavam em cruz e o Postgres matava uma (40P01), e as chamadas do despejo
  morto sumiam **sem rastro**: o rastreador limpa o balde antes do `await` e
  engole o erro, então o dia mais movimentado era o mais subcontado. Medido com
  os 8 métodos ordinários: 6 sessões simultâneas → 37 mortes em 90 despejos e
  41,1% das chamadas perdidas; 10 sessões → 173 em 250 e 69,2% perdidas;
  ordenado, zero nos dois. Ordenar em JavaScript não basta — o plano é um
  `Hash Right Join` com `virtual_mcps`, e o que sai de um join não tem ordem
  prometida (medido: os métodos saíam numa terceira ordem, nem a de entrada nem
  a da chave) —, por isso o `ORDER BY` pela posição no array já ordenado.
- `listActivityDays({ since, until, timezone? })` devolve `ActivityDay[]` —
  **só os dias com `total > 0`**, em ordem crescente, `day` em `AAAA-MM-DD` no
  fuso pedido (padrão `'UTC'`); o painel completa a grade com zeros. Uma
  consulta só, com as quatro fontes em `UNION ALL` de agregados: cada ramo lê o
  índice por instante da sua tabela. `total` é a soma de `sessions` (sessões
  abertas no dia), `calls` (a soma dos baldes), `reads` (leituras de skill) e
  `events` (linhas da trilha).
- **O fuso é conferido**, não confiado: só nome IANA (o que o navegador manda
  em `Intl.DateTimeFormat().resolvedOptions().timeZone`), e contra o
  `pg_timezone_names` **do servidor** — a autoridade é a tzdata que o `AT TIME
  ZONE` usa. Desconhecido é **400** (`Fuso horário desconhecido: …`), e não o
  500 que o `invalid_parameter_value` do Postgres daria no meio da consulta.
  Deslocamento cru (`+05:45`) é recusado de propósito: o Postgres o interpreta
  com convenção de sinal diferente da do ISO em algumas formas, e o dia sairia
  recortado ao contrário sem ninguém perceber. Os nomes aprovados ficam num
  conjunto por processo (a lista custa ~10 ms — é uma varredura do diretório de
  fusos); só o positivo é guardado, então um fuso novo na tzdata do servidor
  passa a valer sem reiniciar ninguém.
- **A faixa satura** em `ACTIVITY_RANGE_MAX_DAYS` (400 dias, pouco mais do ano
  que a grade desenha): pedir dez anos devolve os últimos 400 dias, como o
  `clamp` de `limit` das listagens — não é erro. `since` depois de `until` é
  400, nas duas leituras.
- `activityOfDay({ since, until, top? })` devolve o `ActivityReport` **sem**
  `day` e `timezone` — esses são de quem perguntou, e o banco não os reinventa.
  Aqui não há agrupamento por dia e, portanto, fuso nenhum: a faixa já vem em
  instantes. São sete consultas pequenas em `Promise.all`, uma por fonte e por
  natureza (escalares × fatias); **os totais saem das fatias** (`transport`,
  `family`, `surface` e `action` são `NOT NULL` com `CHECK`, então toda linha
  da faixa cai em exatamente uma fatia). `top` é o tamanho dos top-N (agentes,
  métodos, servidores, skills), padrão 5, clamp 1..50.
- `ActivitySlice` é `{ key, label, count }`, da maior contagem para a menor,
  desempatando pela chave. `label` é nulo quando a chave já se explica (um
  transporte, uma ação da trilha) e vem preenchido onde o nome vale mais: a
  família no método, o nome do vMCP no slug, o nome da skill no slug. Três
  recortes que valem ser ditos: `clients.ended` e `byEndReason` contam pelo
  **`ended_at`** dentro do dia (a sessão pode ter começado na véspera);
  `reads.skills` e `topSkills` agrupam pelo **`skill_slug`**, a cópia que
  sobrevive à remoção da skill; e `catalog.actors` conta
  `COALESCE(actor_user_uuid, actor_label)` — a conta removida deixa o uuid nulo
  e o rótulo fica, e quem nunca foi conta (o token global, o bootstrap) só tem
  rótulo. Ninguém é identificado: o que sai é **quantos** foram.

### Busca semântica: as queries

Quem escreve é o **indexador**; quem lê é o mcp-public, o site e o painel. O
modelo está em [Busca semântica (RAG)](#busca-semântica-rag), acima.

```ts
// apps/indexer — um ciclo
if (!(await ragSchemaReady())) return;                    // espera a migration, não cai
const { 'rag.driver': driver } = await getRagSettings();  // o banco decide, não o ambiente
const espaco = await resolveRagSpace({ driver: 'google', model: 'gemini-embedding-2',
  dimensions: 3072, documentPrefix: 'title: none | text: ', queryPrefix: 'task: search result | query: ' });

for (const uuid of await claimStaleSkills(20)) {
  const skill = await readSkillForRag(uuid);              // null = sumiu; siga em frente
  if (!skill) continue;
  try {
    await replaceSkillTexts(uuid, dividir(skill));        // declarativa, numa transação
  } catch (err) {
    await releaseStaleSkill(uuid);                        // volta para a fila
    throw err;
  }
}
const pendentes = await listPendingRagTexts(espaco.uuid, 64, { reserveMs: 600_000 });
const resolvidos = new Set<Buffer>();                     // ganhou vetor ou recusa
for (const lote of lotes(pendentes)) {                    // grava lote a lote
  try {
    await insertRagVectors(espaco.uuid, await embutir(lote));
    lote.forEach((t) => resolvidos.add(t.sha256));
  } catch (err) {
    if (recusaComProva(err)) {                            // o provedor aceitou OUTRO texto neste ciclo
      await markRagTextRefused(espaco.uuid, lote[0].sha256, err.message);
      resolvidos.add(lote[0].sha256);
      continue;
    }
    // Falha que não é do conteúdo: devolve o que o ciclo reservou e não resolveu —
    // a fatia que falhou e os lotes que nem foram tentados — e encerra a etapa.
    const resto = pendentes.map((t) => t.sha256).filter((h) => !resolvidos.has(h));
    await releaseRagTextReservations(espaco.uuid, resto); // ou { retryAfterMs } para adiar
    break;
  }
}
await collectOrphanRagTexts(500);                         // só depois de embutir
await setRagIndexerStatus({ at: new Date().toISOString(), keyPresent: true, lastError: null });

// apps/admin — a seção "Busca semântica" de Configurações
await seedRagSetting('rag.driver', process.env.RAG_DRIVER!);       // só no primeiro boot
await setRagSetting('rag.model', modelo, 'web-admin', ator);       // audita rag.settings
const { texts, withVector, pendingTexts, refusedTexts, staleSkills } = await ragCoverage(espaco?.uuid ?? null);
await markAllSkillsStale('web-admin', ator);                       // audita rag.reindex

// apps/mcp-public e apps/site — a consulta
const espacoAtivo = await findRagSpace(identidade);                // não cria nada
const page = await listSkills({ query, virtualMcp, semantic: { spaceUuid: espacoAtivo.uuid, vector } });
page.mode; // 'hybrid' | 'text'
```

- **A configuração.** `getRagSettings()` devolve só as chaves gravadas
  (`rag.driver`, `rag.model`, `rag.indexer.status`) — a chave **ausente** do
  objeto é o que diz que o banco ainda não decidiu. `seedRagSetting(key,
  value)` grava **só** quando não há linha e devolve `{ written, value }`,
  com o valor em uso: é com ele que o admin avisa no log que a variável de
  ambiente foi ignorada; quando grava, audita `rag.settings` com o ator
  `ambiente`. `setRagSetting(key, value, source, actor)` é o painel, e audita
  igual, com `chave=valor` em `target_label`. As duas só aceitam
  `rag.driver` e `rag.model` (400 no resto): o que é um driver ou um modelo
  **válido** é regra do app, não do banco. `setRagIndexerStatus(objeto)` é
  do indexador, guarda o JSON como texto (teto de 8 KB) e **não audita** —
  ele é regravado a cada ciclo.
- **O espaço.** `resolveRagSpace(identidade)` acha ou cria (é o indexador);
  `findRagSpace(identidade)` só consulta — uma busca não pode inaugurar um
  espaço vazio e concluir que não há vetor. Os cinco campos são obrigatórios;
  os prefixos **não são aparados** (o espaço no fim de `'title: none | text: '`
  faz parte do prefixo) e cabem em 200 caracteres.
- **A fila.** `claimStaleSkills(limit, { claimMs? })` reserva **com prazo**
  (`028`, padrão 10 min) e devolve os uuids **na ordem em que convém processar**
  — as pendentes, depois as de reserva vencida, por tentativas;
  `releaseStaleSkill(uuid)` devolve um à fila e baixa a reserva (uuid torto é
  ignorado: isso roda no `catch`); `markAllSkillsStale` marca todas e **não
  apaga vetor nenhum** — o que ele refaz é a divisão, e o texto que não mudou
  reaproveita o vetor. Nenhum dos três toca `updated_at`: reindexar não é
  publicar. Ver [A fila de skills](#a-fila-de-skills-reserva-com-prazo).
- **Os textos.** `readSkillForRag(uuid)` devolve metadados, tags e os
  arquivos **de texto** (com `id`, `content` e o `sha256` do arquivo), ou
  `null` se a skill sumiu — e, havendo reserva, **soma uma tentativa** nela
  antes de carregar o conteúdo: é o "comecei" do indexador (sem reserva não
  escreve nada). `replaceSkillTexts` é o "terminei": depois de commitar, apaga
  a reserva — o indexador não chama mais nada no caminho feliz.
  `replaceSkillTexts(uuid, ocorrências)` é
  **declarativa**: apaga as ocorrências da skill e grava a lista inteira numa
  transação, calculando o hash **no banco**. Conteúdo vazio ou só com
  espaços, ocorrência repetida, `meta` com caminho, `file` sem caminho ou sem
  `fileId` são 400; skill inexistente é 404.
- **Os vetores.** `listPendingRagTexts(spaceUuid, limit, { reserveMs? })` é o
  anti-join (texto órfão fica de fora, e desde o `025` também o recusado e o
  reservado por outro indexador — ver
  [A fila de textos](#a-fila-de-textos-recusa-e-reserva)). Com `reserveMs`
  (clamp 1 s .. 1 h) a mesma statement **grava a reserva** e devolve só o que
  ela conseguiu reservar; sem ele, é leitura pura. Chame-a fora de uma
  transação comprida: até a statement commitar, o indexador vizinho espera a
  linha da reserva. `insertRagVectors(spaceUuid, vetores)` copia `dimensions`
  do espaço, ignora o que já existe e devolve quantos entraram — espaço
  inexistente grava zero, vetor de dimensão errada bate no CHECK, **hash cujo
  texto sumiu é ignorado** (o `JOIN rag_texts`) e a reserva de cada hash do
  lote é apagada.
- **A recusa e os órfãos.** `markRagTextRefused(spaceUuid, sha256, motivo)` tira
  o texto da fila daquele espaço de vez; é idempotente, corta o motivo em 500
  caracteres e **não lança** quando o espaço ou o texto já não existe (ela roda
  no tratamento de erro do indexador) — uuid torto e hash fora de 32 bytes
  continuam 400. **Só grave recusa com prova** de que o problema é o conteúdo;
  sem ela, `releaseRagTextReservations(spaceUuid, hashes, { retryAfterMs? })`
  devolve os textos à fila (ou adia a volta) e devolve quantas reservas mexeu —
  só toca `reservado`, ignora hash sem reserva e espaço inexistente, e é 400 com
  uuid torto ou hash fora de 32 bytes. `clearRagRefusals(spaceUuid, source,
  actor)` é o reparo manual: apaga as recusas daquele espaço, devolve quantas
  saíram e audita `rag.reindex` com `"<n> recusas"` — a memória de recusas do
  **processo** do indexador não é alcançada, quem chama precisa fazê-lo
  esquecê-la (ver [A fila de textos](#a-fila-de-textos-recusa-e-reserva)).
  `collectOrphanRagTexts(limit = 500)` apaga os textos sem ocorrência e devolve
  quantos saíram; chame **depois** de embutir, quando todo `replaceSkillTexts`
  da rodada já commitou.
- **`ragCoverage(spaceUuid | null)`** é o número do painel: `texts` (com
  ocorrência), `withVector`, `pendingTexts`, `refusedTexts` (dentro de
  `pendingTexts`: o que nunca vai ter vetor naquele espaço), `staleSkills` (as
  pendentes **mais** as reservadas e não terminadas) e `stuckSkills` (dentro de
  `staleSkills`: a reserva venceu no teto de tentativas — opcional no tipo,
  sempre presente no retorno). Uuid nulo ou torto é o driver desligado:
  `withVector` 0.

### O termo de busca: literal e indexado

Quatro listagens procuram um termo **no meio** do texto com `ILIKE '%termo%'`:
`listSkills` (`query`, em `name`, `description` e `slug`, ao lado do
`search_vector`), `listAuditPage` e `listSkillAccesses` (`q`, em quatro e seis
colunas) e `lookupUsers`. Duas regras valem para todas.

**O termo é literal.** `likePattern` escapa `%`, `_` e `\` antes de montar o
padrão; só os dois `%` das pontas continuam curinga — é o "contém" que a busca
é. Sem isso, `q=%` casava o acervo inteiro (e a trilha de auditoria inteira),
`q=snake_case` casava `snake case`, e um padrão como `%_%_%_%…` — cabe folgado
no teto de `SEARCH_QUERY_MAX_LENGTH` (200 caracteres) — era o pior caso do
casamento de `LIKE` aplicado linha a linha, numa superfície sem autenticação
nem limite de taxa. **Quem digitava `%` de propósito passa a procurar o
caractere `%`**; nada muda para caixa, acento ou palavra parcial. O termo vai
**cru** ao `websearch_to_tsquery`, que não tem curinga de `LIKE`.

**A busca por substring só usa índice de trigrama** (`pg_trgm`, `022`), e num
`OR` o planejador só monta o `BitmapOr` quando **todos** os ramos têm índice —
falta um e a varredura volta inteira. Por isso o `022` completa os quatro ramos
de `skills` (`description` e `slug`, ao lado do `name` do `001` e do
`search_vector`) e dá um GIN por coluna procurada a `audit_log` e a
`skill_accesses`, as duas tabelas que **nunca são podadas**. Medido com 52 mil
skills, 200 mil linhas de auditoria e 200 mil de acessos, `jit=off`:

| busca | sem o `022` | com o `022` |
|---|---|---|
| skills, termo que casa 10 400 de 52 000 | 104 ms | **14 ms** |
| skills, o pior caso `%_%_%_…` | 478 ms | **4 ms** |
| auditoria, termo seletivo | 102 ms | **17 ms** |
| acessos, termo seletivo | 278 ms | **46 ms** |
| acessos, o pior caso `%_%_%_…` | 1230 ms | **3 ms** |

Três coisas que o número esconde:

- **o escape e os índices são uma coisa só.** Escapar sem indexar *piora* o
  pior caso (311 ms → 478 ms nas skills): o padrão deixa de ser curinga que
  falha rápido e passa a ser um literal de 120 caracteres comparado linha a
  linha. Quem reverter o `022` mantendo o `likePattern` fica com a busca mais
  lenta do que antes das duas mudanças;
- **termo de uma ou duas letras não tem índice possível** — o `pg_trgm` não
  extrai trigrama de `%ab%`. Em `audit_log` e `skill_accesses` o planejador
  acerta e varre (o mesmo tempo de antes); em `listSkills` ele erra e lê os
  três índices inteiros (104 ms → 147 ms), porque o custo *estimado* da
  varredura está inflado pelas subconsultas de visibilidade. É o mesmo defeito
  de estimativa que faz o `jit` compilar toda busca com termo, e some com ele;
- **com o `jit` padrão nada disso é visível**: a mesma busca de 14 ms mede
  458 ms, e ~445 ms são compilação. Os números acima são com `jit=off` de
  propósito — o ganho do índice é real, mas hoje fica debaixo do `jit`.

`users` fica fora do `022`: `lookupUsers` para em `LIMIT 10` sobre uma tabela
de contas, e o mínimo de dois caracteres cai justo na faixa em que o trigrama
não serve.

`virtual_mcps` e `catalogs` também ficam fora, e isso é **decisão**, não
esquecimento: o único `LIKE` sobre elas é o `slug LIKE 'pedido-%'` que
`freeVirtualMcpSlug`/`freeCatalogSlug` usam para achar um sufixo livre, e são
tabelas de dezenas de linhas — a varredura é mais barata que o índice. O
`skills_slug_trgm_idx` do `022` existe porque `skills` tem outra ordem de
grandeza (e ele, de passagem, faz o `slug LIKE 'x-%'` de `resolveSlug` virar
`BitmapOr` com o `UNIQUE`). Reescrever esses `LIKE` como faixa
(`slug >= 'x-' AND slug < 'x.'`) está **errado** na coleção do cluster
(`en_US.utf8`, libc): o hífen é ignorado no nível primário e os slugs ocupados
desaparecem da consulta — medido, 0 linhas onde o `LIKE` devolveu 2, o que faria
`uniqueSlug` reoferecer um slug em uso.

**O prefixo procurado muda perto do teto do slug** (`takenSlugs`, a consulta das
três). O teto é 96 caracteres; perto dele o desempate `-N` não cabe, `uniqueSlug`
encurta a base, e o candidato **deixa de começar** pelo slug desejado — com 96
caracteres, o segundo homônimo é `<94 caracteres>-2`, que `desejado-%` não
casa. A consulta não o via, reoferecia-o ao terceiro homônimo, e as três
tentativas de `SLUG_ATTEMPTS`, idênticas, terminavam em 409 citando um slug que
ninguém pediu — para sempre, não só sob concorrência (com a base de 94, a partir
do 11º). Acima de 90 caracteres (96 − 5 do maior sufixo − 1 hífen aparado no
corte) a busca passa a ser pelo **prefixo comum** de 90, que contém os outros
dois padrões; linha a mais é inofensiva, `uniqueSlug` só testa pertinência. É
um `LIKE` só, e não os três com `OR`, porque medido em 52 mil skills cada
`LIKE` de ~90 caracteres pelo trigrama é estimado caro e dois deles trocavam o
`BitmapOr` por varredura (2,7 ms → 6,3 ms); sozinho, ele mantém o índice. Até
90 caracteres a consulta é a de sempre, byte a byte. O número depende do
`MAX_SLUG` de shared, que não é exportado: se ele mudar, o teste dos homônimos
de nome longo (`skills.integration.test.ts`) acusa.

### A busca híbrida

`listSkills({ ..., semantic: { spaceUuid, vector, neighbors? } })` funde a
busca textual de hoje com a perna vetorial por *Reciprocal Rank Fusion*
(`1/(60 + posição)`), na **mesma** consulta que aplica o recorte de
visibilidade. Quem embute a consulta é o app, com o prefixo de consulta do
espaço — o prefixo não aparece no SQL.

- o recorte (`visibility`/`viewer`/`virtualMcp` e o filtro de tag) vale nas
  **duas** pernas: uma skill de vMCP fechado não vaza pela perna vetorial na
  busca de outro servidor nem no site;
- a perna textual entra **inteira**, sem teto: ela é o conjunto de resultados
  da busca, o mesmo da busca sem RAG. A vetorial entra com `neighbors`
  vizinhos (padrão 20, clamp 1..100) — ali o teto é uma janela de
  vizinhança, não um conjunto de resultados. **Não há corte por distância** na
  v1. O teto de 100 que a perna textual tinha travava o `total` em
  100 + `neighbors` e deixava o resto inalcançável: o mesmo termo anunciava 400
  resultados sem a perna vetorial e 120 com ela, e a paginação parava na página
  5;
- `total` é o tamanho do **conjunto fundido** — a perna textual mais os
  vizinhos que não casam no texto — e sai da **mesma** consulta da página, ao
  contrário da busca de sempre. A perna vetorial é uma varredura exata (sem
  índice), e contar à parte a fazia rodar duas vezes por busca; `fusao` é
  materializada (uma linha por skill do conjunto: uuid, `rrf` e `dist`) e a
  contagem vem dela. Paginar além do fim não zera o total: a página vazia não
  traz linha nenhuma, e **só** nesse caso a contagem volta a ser uma consulta à
  parte;
- a ordem em `relevance` é a da busca textual com os vizinhos **empurrados para
  cima**: `1/(60 + pos)` decresce com a posição em cada perna, então quem
  aparece nas duas soma as duas frações e sobe. É por isso que a perna textual
  não tem teto — cortada em 100, ela negava a soma a quem casava no texto abaixo
  dessa posição, e a cauda era reordenada por popularidade em vez de relevância;
- `sort` continua valendo: `relevance` usa o RRF, e `name`/`recent`/`score`
  reordenam o conjunto fundido;
- **toda ordem de `listSkills` termina em `s.uuid`**, na busca de sempre e na
  híbrida. `name` não é único, `updated_at` e os contadores empatam em lote
  (`now()` é o mesmo na transação inteira de um seed ou de uma importação, e um
  acervo novo tem tudo em zero), e o `rrf` empata **entre as pernas** — `pos` é
  único por perna, então um resultado só-texto e um só-vetor na mesma posição
  recebem o mesmo `1/(60 + pos)`. Sem chave única a ordem entre empatados é
  indefinida, e como cada página é uma execução à parte a paginação deixava de
  ser partição: medido em 60 páginas de 12 sobre skills empatadas, só 481 de 720
  linhas eram distintas em `score`, 334 em `recent`, 371 em `name` e 661 na
  relevância textual — o resto repetia e outras tantas nunca apareciam, com o
  `total` certo o tempo todo. O plano não muda: `score` continua em `Incremental
  Sort` sobre o `skills_score_idx` (a chave nova só ordena dentro do grupo
  empatado), e `recent`/`name` já eram ordenação completa;
- sem `query` a opção é **ignorada** (não há o que fundir) e o modo é
  `'text'`. Espaço torto ou vetor que não é lista de números finitos é 400:
  a essa altura o app já decidiu que dá para buscar por significado.

O retorno é `SkillSearchResult`: o `SearchResult` de shared — que já traz
`mode: 'text' | 'hybrid'` — **mais** `neighbors: { slug, distance }[]`, os
vizinhos da perna vetorial que chegaram à página. A distância fica **fora**
de `items`, e no banco em vez de em shared, de propósito: `SkillSummary` é o
que os apps serializam para o cliente, e a distância não vai para o cliente
na v1 — ela é o que o app registra no log.

## Contrato com os outros agentes

**Podem:**

- importar de `@purple-skills/db` e usar as funções acima;
- ler esta especificação e os arquivos de `schema/` para entender o modelo;
- pedir ao DBA uma query ou coluna nova que ainda não exista.

**Não podem:**

- escrever SQL, DDL ou migration fora de `database/`;
- criar `pg.Pool`/`Client` próprio ou ler `PGHOST`/`DATABASE_URL` direto —
  use `getDb()`;
- declarar serviços `postgres`, `migrate` ou `seed` em outro compose;
- copiar `database/schema/` para dentro da imagem de um app;
- rodar `drizzle-kit generate`/`push`: `src/schema.ts` é tipagem, não a fonte de
  verdade, e o diff apagaria índices parciais, por expressão, CHECKs, funções e
  triggers — ver [O `schema.ts` e o banco](#o-schemats-e-o-banco).

Precisa de algo que não está aqui? A mudança é do DBA: acrescente
`schema/nnn-nome.sql`, exponha a query em `src/queries.ts` e atualize este
documento — nessa ordem.

## Testes

As queries têm testes de integração que exigem um PostgreSQL real e ficam
desligados por padrão. Aponte para um banco **descartável** — o schema é
recriado do zero a cada execução:

```bash
TEST_DATABASE_URL=postgres://postgres:CHANGE_ME@127.0.0.1:5432/purple_skills_test \
  npx vitest run database/src/files.integration.test.ts database/src/users.integration.test.ts \
    database/src/virtual-mcps.integration.test.ts database/src/settings.integration.test.ts \
    database/src/sessions.integration.test.ts database/src/catalogs.integration.test.ts \
    database/src/access.integration.test.ts database/src/accesses.integration.test.ts \
    database/src/rag.integration.test.ts database/src/orphans.integration.test.ts \
    database/src/schema.integration.test.ts database/src/migrate.integration.test.ts \
    database/src/locks.integration.test.ts database/src/skills.integration.test.ts \
    database/src/quarantine.integration.test.ts database/src/manifest.integration.test.ts \
    database/src/activity.integration.test.ts database/src/profile.integration.test.ts \
    database/src/quarantine-targets.integration.test.ts
```

A suíte do RAG e a do `schema.ts` exigem **pgvector** no servidor (a imagem
`pgvector/pgvector` já o traz) e um papel que possa `CREATE EXTENSION`, como o
`pg_trgm` do `001` — as duas aplicam o schema inteiro.

| Suíte | Cobre |
|-------|-------|
| `files.integration.test.ts` | unicidade de caminho sem diferenciar caixa; `createFile`: arquivo vazio (texto e binário) na raiz e em pasta, com o retorno igual à listagem; as quatro recusas com a mensagem exata, sem alterar conteúdo nem auditar (inclusive o `SKILL.md` sem linha); `_` e `%` literais; a auditoria `create`; os 404/400; criações concorrentes (o mesmo caminho em várias caixas e arquivo × pasta); e o INSERT alheio em andamento que vira 409 pelo `ON CONFLICT`, sem deadlock, com a skill indexada; **texto × binário** (o `.csv` em Windows-1252 guardado byte a byte em `setFile`, `setFiles`, `createFile` e nos anexos de `createSkill`; acento, vazio e BOM intactos; o `SKILL.md` que não é texto recusado com 400 nas quatro escritas, sem mudar o corpo gravado); **a caixa dobrada pelo Postgres** (o `replace` que não apaga o `İndice.md`, `İ.md` + `I.md` no mesmo lote sem 21000 — conferido contra o `lower()` do próprio cluster); **a fila das escritas de arquivo** (`setFile` e `updateSkillWithContent` esperando no advisory lock sem segurar linha, reproduzido com um cliente cru no papel da outra ponta; o salvamento sem `skillMd` fora da fila; pares concorrentes formulário × arquivo, `replace` × avulso, duas remoções do mesmo caminho e `deleteSkill` × escrita respondendo 404 em vez de 23503); e a **`029`** sobre linhas gravadas por SQL cru como antes da beta.22 (o que converte e o que fica binário — `.INI`, `dir.v2/run.ps1`, `.env.example`, `.env`, `Makefile`, `x.`, Latin-1, UTF-16, byte nulo, PNG —, hash, tamanho e datas iguais, `rag_stale`, a segunda passada que não reescreve nada e a marcação que vale também com a função de trigger anterior à `027`) |
| `users.integration.test.ts` | contas, bloqueio de login, chaves de API, tokens de reset (uso único, expirado, o link fechado na emissão do próximo e na troca da senha, o vencido que não é reetiquetado, o logout que não fecha nada e o `CHECK` dos dois carimbos) e o ator na auditoria; mais a primeira conta que nasce `membro` sem o `onlyIfTableEmpty` e a **receita de "Instalação sem administrador"** rodada com o SQL do README (promove, derruba a sessão, audita e não age na segunda vez nem com admin ativo); o "Sair" que **não** carimba `updated_at` (e o campo junto, ou `{}`, que carimba); `clearLoginLock` destravando no UPDATE da senha, com `false`/ausente deixando a trava; a revogação de chave `psk_` devolvendo nome, prefixo e dono (e `null` na segunda vez, sem reescrever `revoked_at`); e `user.activate`/`user.link` na trilha, como filtro de `listAuditPage`, com o `CHECK` ainda fechado e a `026` re-executada; mais o **username**: `getUserByUsername` e o campo único de `getUserByLogin` (com `@` e sem), a recusa do nome torto e as **duas** mensagens de 409 (conta viva × nome já gasto, inclusive o de uma conta apagada), a troca que libera o antigo sem apagá-lo e nunca o devolve, e `nextFreeUsername`/`reserveUsername` consultando `users` e `usernames` juntas; mais o **carimbo do avatar** (`034`) em `UserSummary`, nas quatro leituras de conta e nos `RETURNING` de `createUser` e `updateUser` — é onde a subconsulta correlacionada de `USER_COLUMNS` prova que vale, já que ali não há `FROM` para juntar nada —, com a cascata levando a foto na conta apagada |
| `username.integration.test.ts` | a `033` sobre uma base parada no `032` — **o único lugar** onde o backfill e a reescrita do histórico rodam sobre dados do mundo antigo: o username derivado do `name` (com acento, no teto de 32 e com sufixo em colisão, e nunca do local part do e-mail), o `user-<8 hex>` de nome inutilizável, reservado e curto demais, com o **empate entre três** que `uuidv7()` produz no mesmo minuto resolvido pelo sufixo; a coluna obrigatória, o único por `lower(username)` e o livro nascendo completo; a trilha reescrita nos quatro formatos de rótulo, com `ana@x.com` **não** trocado dentro de `mariana@x.com`, `conta removida` no que sobrou e a **quarentena intocada** (um envio chamado `relatorio@2026.q1` tem forma de e-mail e não é conta); `skill_accesses` casando por uuid e por `lower(email)`, a leitura anônima seguindo nula, o `user_email` apagado e o trigram recriado; `user.username` no `CHECK` com a lista do `031` inteira; e a reaplicação que não reescreve rótulo, conta nem livro — e não deixa a função auxiliar no banco |
| `virtual-mcps.integration.test.ts` | MCP virtual: recorte declarativo, leituras por vínculo, contadores duplos, chaves `psv_` (inclusive as emitidas por conta, `listVirtualMcpKeysByCreator`, o índice do `021` e a revogação que devolve nome e prefixo — `null` quando não é daquele servidor ou já estava revogada), o runtime que ignora inativos e a **clonagem de vMCP** (`031`): vínculos de skill e de catálogo com as três portas e as posições, `layout` inteiro, concessões com `granted_by` trocado por quem clonou e **sem** a linha dele, cópia fechada com o original aberto, **sem chave**, com os contadores do vínculo zerados e sem herdar o posto de vMCP padrão; o original intacto; o `-2`/`-3`, o slug pedido (livre, 409 e 400), os 404 e a linha `mcp.clone` com `<origem> -> <cópia>`, sem `mcp.create` junto |
| `settings.integration.test.ts` | MCP padrão: escolha e limpeza com auditoria, o uuid em **maiúsculas** que grava o canônico em vez de virar "removido", as três causas de recusa da raiz, o CHECK com `mcp.default` e o caminho de atualização de uma base parada no `010` (`011` em diante aplicadas de uma vez e **re-executadas** sobre o resultado, para provar que o SQL não falha nem muda a **estrutura** na segunda passada — de **dado** não prova nada: toda skill do cenário é privada, e o `012` reaplicado derruba o `is_public` do `017`; ver `migrate.integration.test.ts`). A lista de migrations é lida da pasta, não escrita à mão — menos a `022`, que fica **fora da segunda passada**: ela cria um GIN sobre `skill_accesses.user_email`, coluna que a `033` apagou, e reaplicada falha (ver [Reaplicar migration antiga](#reaplicar-migration-antiga)) |
| `sessions.integration.test.ts` | sessões do MCP público: abrir/tocar/fechar, o `clientInfo` que só entra uma vez, o reuso de linha do stateless, a expiração com fim presumido por transporte, a listagem com filtros, recorte e `isOnline`, o contador por transporte, `onlineSessions` no resumo do vMCP com e sem janela, a linha que sobrevive à remoção do vMCP sem ser podada, o offset além da faixa do `bigint` saturando, e o `clientInfo` com byte nulo e caractere de controle: a sessão entra com o rótulo limpo, o `touch` não perde as requisições, o nome além do teto entra cortado e o nulo num campo obrigatório é 400 |
| `catalogs.integration.test.ts` | catálogos (inclui o recorte do site: o catálogo **privado** do caminho não é nomeado em `mcps[].catalogs` fora de `'all'`/`viewer`, e o dono vem nulo): criar/atualizar/apagar com auditoria e alcance por dono; `setCatalogSkills` declarativa preservando a participação de quem ficou; a precedência (o vínculo direto sobrescreve, dois catálogos somam); as três desativações tirando a skill do servidor e do site; `mcps` com `direct: false` e `catalogs`; os contadores por caminho; `activeSkillCount` do nó excluindo quem tem vínculo direto; `catalogPositions` no canvas e o CHECK de par; as cascatas; `stats` e `listOpenVirtualMcps` com catálogo; a re-execução do `016`; e a **clonagem de catálogo** (`031`), **depois** dela de propósito — a re-execução estreita o `CHECK` de `audit_log.action` para a lista da época e `catalog.clone` volta a ser recusada até a `031` ser reaplicada (que é como o teste começa, provando a idempotência dela): membros copiados com o `is_active` de cada participação, cópia privada com o original público, sem vínculo com vMCP e sem concessão, original intacto, o `-2`/`-3`, o slug pedido (livre, 409 e 400), os 404 e a linha `catalog.clone` com `<origem> -> <cópia>`, sozinha na trilha |
| `virtual-mcps.integration.test.ts` também cobre | a visibilidade `'open'` do site (só vMCP aberto e ligado), `mcps` na skill, `listPublishedSkills` por vMCP, o `icon` da skill (regra de shared, 400 no inválido, CHECK de tamanho), os contadores por porta e os dois previews da colmeia (`preview` e `previewCatalogs`, com o teto `VIRTUAL_MCP_PREVIEW_SIZE` e o `isActive` do catálogo), e o canvas (`setVirtualMcpCanvas`, posição preservada por `setVirtualMcpSkills`, `linkSkill` com posição, `layout` que ignora lixo, os CHECKs de `014`) |
| `access.integration.test.ts` | acesso granular: o `017` sobre uma base parada no `016` (backfill do dono, órfã sem criador, `leitor` → `membro` e o CHECK novo — mais o username que a `033` derivou do **nome** daquela conta legada, e a linha dela no livro); o que cada conta vê por `viewer` (dona, concessão direta, pública, via vMCP aberto, via catálogo público, via contêiner concedido, e o negativo), o `access` por linha, `mcps`/`catalogs` recortados, `scope` nos três tipos (inclusive para o admin), listagens e detalhes de catálogo/vMCP por `viewer`; `set*Grant` como upsert e as recusas, `remove*Grant` e os 404, as seis ações de auditoria com o formato do label; a concessão de **conta desativada** marcada em `Grant.isActive` e revogável nos três tipos (com a mudança de nível ainda recusada, e sem devolver nada na reativação); a **ficha do catálogo recortada pela conta** — `mcps` só com os vMCPs que ela vê (inclusive para a dona do catálogo) e `skills` só com os membros que ela abre, com `mcpCount`/`skillCount` globais; transferência que apaga a concessão do novo dono e recusa inativo/inexistente/torto nos três tipos; o flag público em skill e catálogo e o site acompanhando; `lookupUsers` por nome e por username, com o **e-mail recusado dos dois lados** (inclusive `%%` e `_` como caractere); `listPublicCatalogs`/`getPublicCatalog` com membros privados e o `ownerUsername` que a decisão 11 do `docs/19` passou a expor ao anônimo; as cascatas; a re-execução do `017` que não devolve dono a ninguém; e o UPDATE parcial das duas escritas de skill, com a escrita concorrente (renomeação, público e desligamento) sobrevivendo à trava da linha; mais o `ownerHasProfile` (`034`) no catálogo público e na skill dele, falso enquanto a dona não abre o perfil, falso com o perfil salvo e privado, verdadeiro com ele público |
| `rag.integration.test.ts` | busca semântica (`020`): os 29 cenários de verificação do DDL — o backfill do hash numa base parada no `019` (sem tocar `updated_at`), a coluna gerada que o Postgres recusa, os triggers de pendência (skill, arquivo de texto, binário que não marca, UPDATE sem mudança, SKILL.md, tag, contador), o `CHECK` do hash e o texto com prefixo recusado, a deduplicação de textos iguais, o `CHECK` de dimensão e a FK composta, cobertura e pendências (com o texto órfão de fora), a fusão RRF, as cascatas de espaço, skill e arquivo e o texto em uso protegido, a reserva em lote e duas em paralelo, o HNSW acima de 2000 dimensões, a identidade do espaço com os dois prefixos (e os limites dos prefixos) e o mesmo texto em dois espaços; mais o **recorte de visibilidade real** nas duas pernas (o vMCP fechado que não vaza no site nem em outro servidor), a paginação e o `total` do conjunto fundido (inclusive a página além do fim e o conjunto fundido vazio, em que a contagem volta a ser uma consulta à parte, e as 120 skills com o mesmo termo, que provam que a perna textual entra inteira: o `total` é o da busca textual mais os vizinhos, e duas páginas cobrem o conjunto sem repetir nem pular), a semeadura e o painel em `settings` com as duas ações novas de auditoria, o **termo literal** (`%`, `_` e `\` como caractere, com as skills de controle que o curinga traria, nas duas pernas, e caixa/acento/palavra parcial intactos) e a re-execução da `020`; mais a **fila de textos** do `025` (a recusa gravada que tira o texto da fila daquele espaço e não é reescrita na segunda vez, o espaço/texto inexistente que não grava nem lança, a reserva com prazo que não deixa duas chamadas em paralelo pegarem o mesmo texto, a reserva vencida que volta à fila, a gravação do vetor que encerra a reserva, o hash sem texto que `insertRagVectors` ignora em vez de perder o lote, e a coleta de órfãos levando vetor e estado pelas cascatas; a **devolução da reserva** do lote que falha, um texto de cada vez e o lote inteiro, sem tocar a recusa, e o **adiamento** com `retryAfterMs`; `clearRagRefusals` limpando um espaço só, sem tocar a reserva nem o outro espaço, com a auditoria); a **troca binário ↔ texto** com o conteúdo igual marcando nos dois sentidos, e o binário regravado igual continuando sem marcar (`027`); e a **reserva de skills com prazo** (`028`: a linha gravada e baixada por terminar e por devolver, o lote do indexador morto que volta só depois do prazo e na ordem de processamento, a skill que derruba o indexador travada no teto de tentativas e visível em `stuckSkills`, o conteúdo novo que recomeça a conta, a reserva viva segurando a skill remarcada, duas réplicas repartindo as vencidas, a statement que pula a linha travada em vez de esperar, a cascata e `ragSchemaReady` esperando a sexta tabela). As listas de migrations são lidas da pasta, e a reexecução da `020` leva a `027` junto |
| `accesses.integration.test.ts` | acessos por skill (`018`): a leitura do site com as cópias e só o contador global; pelo MCP público por catálogo (os catálogos do caminho por nome, cada um somando, e a participação desativada saindo do caminho) e por vínculo direto (catálogos vazios, o contador do vínculo); pelo mcp-admin com o nome da chave `psk_` e o **username** da conta **e contador nenhum somado**; skill inexistente sem gravar nem lançar, opcionais tortos ou sumidos ignorados, e os 400; a listagem com cada filtro (skill, catálogo, vMCP, conta e chave `psk_` — duas contas, cada uma só vê a sua —, `origin`, `kind`), o `q` em cada coluna, a ordem, o clamp e os 400; as cópias sobrevivendo à remoção da skill, do catálogo, do vMCP (e da chave `psv_`) e da conta (e da chave `psk_`), sem poda; o `q` **literal** (`%` e `_` como caractere e o pior caso de LIKE casando nada); e a re-execução do `018` e do `019` juntos, com o conjunto exato de índices — os seis GIN de trigrama incluídos — e o CHECK dos arrays, mais a `022` **recusada** sobre o schema da `033` (`user_email` já não existe) sem deixar nada pela metade; mais **o caminho que olha a porta** (dois catálogos no mesmo vMCP com portas diferentes: cada superfície grava e soma só no que a serve, `resource` sem ninguém fica sem caminho, a guia de cada catálogo só mostra o que passou por ele, e a precedência do vínculo direto segue sem porta), o **rótulo com byte nulo e controle** (a linha entra limpa **e** os contadores sobem; `normalizeSessionLabel` no teto, idempotente e com o par substituto cortado virando U+FFFD; o nulo em `q`, no termo de `listSkills` e num nome é 400), as **cópias de nome cortadas** em 512 com os três arrays de catálogo alinhados, e o **offset saturando** nas quatro listagens |
| `activity.integration.test.ts` | a tela de Atividade (`032`): o UPSERT somando no mesmo balde (dois despejos e um instante fora do passo de 15 min caindo na mesma linha), a lista vazia que não consulta nada, o saneamento do `method` (byte nulo e ESC sumindo, os dois virando a mesma chave **no mesmo lote** sem 21000, o método de 300 caracteres cortado em `MCP_CALL_METHOD_MAX`, o só-controle e o `calls` zero descartados sem derrubar o lote), o vMCP apagado que entra com uuid nulo e o slug (a FK recusaria o lote inteiro) e os cinco 400 de quem chama; a **série nos dois fusos** — o mesmo instante (02:30Z de 10/03) contado no dia 10 em UTC e no dia **9** em `America/Sao_Paulo`, com as quatro fontes somando no `total` —, o fuso desconhecido (inclusive `+05:45` e o nome com espaço) e a faixa invertida com 400, e a faixa de dez anos saturando em 400 dias; o relatório de um dia com as quatro fontes populadas (três sessões e duas identidades, o agente repetido no `topAgents`, a encerrada que **começou na véspera**, doze chamadas em quatro famílias, três transportes e dois servidores, as leituras por superfície/origem/credencial com a skill mais lida, e a trilha com dois atores e duas origens), o `top` recortando só os top-N e o clamp no mínimo; e o dia vazio devolvendo zeros, listas vazias e série vazia |
| `profile.integration.test.ts` | o perfil (`034`): a conta que nasce **sem** linha e a leitura que devolve o vazio e privado, a linha que nasce no primeiro salvamento (privada), o campo ausente que não é regravado e o `websiteUrl: null` que apaga, o `name` gravado em `users` (e só ele, com o carimbo subindo), as dez recusas da regra do shared com o campo nomeado (bio no teto depois de normalizada, URL, 9 links, URL repetida em caixa diferente, rótulo vazio e o caractere nulo em bio e em link) e os 404 de conta inexistente nas três escritas — inclusive o que só a chave estrangeira do upsert acusa; a **foto**: o tipo decidido pelos bytes, o SVG recusado, o `mime` informado que não bate com os bytes, o vazio e o acima de 512 KB, a substituição, o `sha256` que o ETag usa conferido contra o calculado em Node, `getAvatarByUsername` por caixa diferente, o carimbo sozinho, a foto de quem **não** tem perfil e a remoção idempotente; a **página pública**: privada, conta desativada e username inexistente no mesmo `null` (e o `@` e o vazio), o username canônico, a reativação que devolve a página, e as duas listas com o que já era público — a privada e a desligada de fora, a que só chega por vMCP aberto dentro, e o catálogo privado e o desligado fora; a **conferência barata** da rota da imagem (`isProfilePublic`): com a tabela `skills` renomeada, ela responde e `getPublicProfile` falha — a prova de que não toca no acervo —, mais a igualdade com a página nos seis casos e o perfil desligado e a conta desativada fechando as duas juntas; `ownerHasProfile` falso sem linha, com linha privada, com dono desativado e em skill órfã, verdadeiro nas três visibilidades e no catálogo público; `clearProfile` esvaziando, desligando, apagando a foto, auditando `user.profile` com o username no alvo e alcançando a foto de quem nunca salvou perfil (auditando de novo sem nada a limpar); os CHECKs do `034` recusando por SQL cru (mime, teto e piso de bytes, hash que não descreve os bytes, bio, site e os dois de `links`) e o `CHECK` de `action` com a ação nova; a cascata das duas tabelas na conta apagada, com o acervo ficando órfão e o username seguindo gasto; e a **re-execução da `034`**, que não muda estrutura, dado nem o CHECK |
| `schema.integration.test.ts` | `src/schema.ts` × banco migrado do zero (ver [O `schema.ts` e o banco](#o-schemats-e-o-banco)): tabela, coluna (tipo, NOT NULL, DEFAULT), chave primária e UNIQUE **com o nome da constraint**, chave estrangeira com a ação de remoção e índice (método, colunas, classe de operadores e `DESC`), nos dois sentidos; mais a lista `SOMENTE_SQL` dos parciais e por expressão, que precisa corresponder a índices que existem |
| `orphans.integration.test.ts` | adoção pelo admin solitário (`adoptOrphans`): a única admin ativa (com outra desativada) adota as skills órfãs do token global, do bootstrap e sem ator e o catálogo órfão, sem tocar o que tem dono nem os vMCPs (o `public` padrão continua órfão); `updated_at` de skills, catálogos e vMCPs, `rag_stale` e `search_vector` intocados; a concessão prévia da conta (promovida de editora) apagada só nos adotados, e as de outras contas e do vMCP mantidas; uma linha de auditoria por objeto no formato da transferência, com o ator e a origem recebidos (inclusive `bootstrap`); a segunda chamada sem adotar nem auditar; três chamadas simultâneas auditando uma vez só; o `q` **literal** de `listAuditPage` (`%` e `_` como caractere, e o pior caso de LIKE casando nada); e as recusas sem gravar — membro, editor, uuid torto ou inexistente, admin desativada (mesmo sendo a única), duas admins ativas, a outra reativada e a própria conta desativada |
| `quarantine.integration.test.ts` | quarentena (`030`): a chave `quarantine.approvers` semeada com o padrão; dois envios **do mesmo nome** convivendo, a lista mais recentes primeiro, o `SKILL.md` gravado cru com o frontmatter dentro; texto × binário com o CHECK (o `.csv` em Windows-1252 e o PNG byte a byte, e os dois INSERTs crus que o CHECK recusa); caminho duplicado em caixa diferente **recusado dentro do envio** (pela query e pelo índice) e **livre entre envios**, com o upsert trocando a grafia; o `SKILL.md` criável quando falta, removível, e as mensagens de pasta × arquivo; o `updated_at` do envio subindo ao gravar **e** ao apagar um arquivo; oito escritas simultâneas no mesmo envio sem deadlock e a remoção concorrente virando 404; o recorte por dono (`null` e uuid torto devolvendo vazio), a busca literal (`%` como caractere) e a paginação; uuid torto `null` na leitura e 404 na escrita; a cascata do envio apagado; o `SET NULL` do dono removido deixando o envio órfão; a promoção sem `SKILL.md` recusada **sem apagar nada** (e consertada acrescentando o arquivo); o `SKILL.md` **binário** entrando no envio e voltando byte a byte, a promoção dele recusada com o envio e os arquivos intactos, o conserto por cima (salvar o arquivo em UTF-8 no próprio envio) e o mesmo arquivo continuando **recusado em `files`**; a promoção completa (slug com sufixo quando ocupado, **dono e criador o promotor**, inclusive no envio de outra conta, tags e descrição do frontmatter, `SKILL.md` sem frontmatter, anexos com caminho e bytes intactos, skill flutuante e envio sumido), a auditoria `quarantine.promote` com `<nome> -> <slug>`; a skill promovida **pendente de RAG** e reservada por `claimStaleSkills`, com as tabelas novas sem trigger de RAG e sem coluna de RAG; a política recusando o valor inválido e auditando `quarantine.settings`; o `CHECK` com as cinco ações novas e as antigas; e a **re-execução da `030`**, que não muda estrutura, dado nem a política já escolhida |
| `quarantine-targets.integration.test.ts` | o destino da quarentena (`035`): o envio sem destino com as duas listas vazias; criar com destino na mesma transação, a ficha com nome, slug e `isActive` **atuais** ordenados por nome, **nada** em `catalog_skills`/`virtual_mcp_skills` e uma linha só (`quarantine.create`) na trilha; as dez recusas de destino (uuid torto, desconhecido, repetido em outra caixa, porta não booleana, as três desligadas, lista ausente, não objeto) sem gravar envio, e o CHECK das portas por fora das queries; `setQuarantineTargets` declarativa (o que sai, o que entra, as portas reescritas com o `created_at` mantido, o carimbo e a `quarantine.update`), o mesmo destino em outra ordem e caixa **sem carimbo nem trilha**, o vazio que limpa, e os 404/400 sem mudar nada; catálogo e vMCP apagados tirando o destino **em silêncio**; a promoção com destino (participação ativa, portas, dono e `is_public` de sempre, a trilha `create` → `mcp.update` → `catalog.update` → `quarantine.promote` e o destino apagado com o envio); o `expectedTargets` divergente em quatro formas dando **409** com a mensagem exata e **nenhuma** linha nova em skills, membros, vínculos ou trilha, o malformado 400 e o omitido cumprindo o gravado; a ficha velha depois de apagar um catálogo (409) e a nova aprovando sem ele; o retry do slug com destino (homônimos aprovados juntos, os dois cumpridos); a **ordem de travas** — a cena determinística do ciclo com quem segura o vMCP e pede o catálogo, e laços curtos de pares contra outra promoção, `setQuarantineTargets`, `linkCatalog`/`setVirtualMcpCatalogs`, `setCatalogSkills`/`addCatalogSkill`/`linkSkill`/`createSkill` e as remoções dos alvos, sem nenhuma falha; e a **re-execução da `035`** sem mudar dado |
| `migrate.integration.test.ts` | o **runner**: com a recusa ligada, o banco novo aplica tudo e a segunda passada não faz nada; a linha que falta no meio do histórico é recusada nomeando os arquivos, sem aplicar nenhum e com o `is_public` intacto; o histórico inteiro perdido é recusado pelo schema que já existe (a marca d'água seria zero) e a recomposição documentada destrava; o **CLI de verdade**, num processo filho — de um caminho com espaço, acento e symlink (o caso em que ele saía com 0 sem fazer nada), recusando por padrão com código 1 e liberando com `MIGRATE_ALLOW_RETRO=1`; e, sem a recusa, o porquê dela medido: o `012` reaplicado derruba o `is_public` do `017`, o `017` o devolve zerado e sem linha na trilha, e estreita o `CHECK` de `audit_log` a ponto de recusar `rag.reindex` |
| `locks.integration.test.ts` | a **ordem de travas** no recorte do vMCP (`tasks/023`): `linkSkill` e `unlinkSkill` esperando o canvas na linha do servidor, sem segurar o vínculo (um cliente cru faz o papel do canvas e atualiza o vínculo por cima, sem deadlock); as quatro travas do recorte em `FOR NO KEY UPDATE` — cada função real é pausada depois de travar o vMCP e um terceiro cliente consegue o `FOR KEY SHARE NOWAIT` que a FK de `skill_accesses` pede; a regra "trava pura no começo, `UPDATE` no fim", conferida pelo `pgrowlocks` (contrib; pulada com aviso se o servidor não tiver) com a função pausada no vínculo; pares concorrentes no mesmo vínculo (`linkSkill`/`unlinkSkill`/`recordSkillAccess` × canvas e recorte); `createSkill` publicando nos mesmos servidores em ordens opostas; o vMCP apagado no meio de um `linkSkill` virando o 400 da validação; e o canvas tudo ou nada com o `layout` gravado por último |
| `skills.integration.test.ts` | **slug gerado perto do teto** (`tasks/035`): três e quatro homônimos de nome longo, a base de 94 caracteres atravessando `-9` → `-10`, dois nomes diferentes com o mesmo prefixo dividindo os desempates encurtados, o mesmo para vMCP e catálogo, e o caso comum e o slug pedido em uso (409 com o próprio slug) intactos; **paginação com desempate** (`tasks/036`): sobre 90 skills inseridas num `INSERT` só — empatadas em nome, `updated_at` e contadores —, as páginas de `score`, `recent`, `name` e da relevância textual são uma partição do conjunto, e a busca híbrida com o `rrf` empatado entre as pernas (30 só-texto × 30 só-vetor, página de 1) também; e a **clonagem de skill** (`031`): propriedades, arquivos (texto e binário, byte a byte, com o hash recalculado) e tags copiados, a cópia nascendo privada mesmo com o original público, desligada como ele, flutuante (sem vMCP, sem catálogo e sem concessão) mesmo com o original publicado e compartilhado, pendente de RAG e com o criador acompanhando o dono; o `-2` e o `-3`, o nome pedido que não mexe no desempate, o slug pedido livre, ocupado (409) e inválido (400), os 404 de uuid torto, sumido e dono inexistente sem deixar rastro, e a linha `skill.clone` com `<origem> -> <cópia>` e sem `create` junto; mais o `ownerHasProfile` (`034`) seguindo o **dono da linha**: verdadeiro na fonte, cuja dona tem página, e falso na cópia, de quem clonou e não tem. Exige pgvector |
| `manifest.integration.test.ts` | o manifesto da extensão de skills (SEP-2640, ver [Manifesto da extensão de skills](#manifesto-da-extensão-de-skills)): o recorte de `listSkillsManifest` (vínculo direto com `as_skill`, o que só tem prompt/resource, a desligada, a de outro vMCP, a que chega por catálogo e a que o vínculo direto sem `as_skill` esconde apesar do catálogo), `options.slug` devolvendo uma entrada ou nenhuma (inclusive a vazia), as **tags ordenadas por nome** com os `tags.id` semeados em ordem inversa (pedir as tags fora de ordem numa skill só não prova nada: `replaceTagsTx` ordena os nomes antes de gravar), o inventário com o `SKILL.md` primeiro (provado por um anexo que a coleção do banco põe antes dele) e o `sha256` hexadecimal batendo com o calculado em Node sobre os mesmos bytes — texto multibyte e binário —, com `sizeBytes` em bytes; a skill sem linha de `SKILL.md` listada mesmo assim; e `readSkillMdBodies` com lista vazia, uuid torto, uuid inexistente, várias skills de uma vez, uuid repetido e um lote de 55 corpos que atravessa o teto de fatiamento; mais o `updatedAt` subindo com o `SKILL.md` — a chave de cache do texto composto |
| `migrate.test.ts` (sem banco) | `migrationNumber` nos dois formatos de nome, e `isEntrypoint` com caminhos reais num diretório temporário: espaço e acento (a URL percent-encodada que a comparação antiga não reconhecia), symlink, `--preserve-symlinks-main`, outro arquivo e `argv[1]` ausente ou inexistente |

As vinte de integração recriam o mesmo banco e o Vitest roda arquivos em
paralelo: elas se serializam por um advisory lock (`pg_advisory_lock`) segurado
durante todo o arquivo. Suíte de integração nova aqui dentro precisa usar o
mesmo número.
