# Camada de dados — especificação

Esta pasta é o **domínio do agente DBA**. Tudo que define, cria, migra, popula
ou acessa o PostgreSQL do Purple Skills mora aqui: os containers, os arquivos de
schema e a biblioteca de acesso compartilhada pelos quatro apps.

Os demais agentes (site, admin, mcp-public, mcp-admin) **consomem** o que está
documentado aqui e não escrevem SQL nem abrem conexão por conta própria. As
regras estão em [Contrato com os outros agentes](#contrato-com-os-outros-agentes).

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
  `skills_score_idx`), os CHECKs, as funções e os triggers de busca e de RAG;
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
| `users` | contas: papel (`admin`/`editor`/`membro`), senha, vínculo OIDC, `token_version` e o bloqueio do login |
| `api_keys` | chaves `psk_` por usuário; guarda o prefixo e o hash, nunca o segredo |
| `reset_tokens` | tokens de redefinição de senha, com expiração, uso único e o fechamento do link substituído (`superseded_at`, `023`) — ver [Links de redefinição de senha](#links-de-redefinição-de-senha) |
| `virtual_mcps` | servidores MCP virtuais: `slug`, dono (`owner_user_uuid`), `is_active`, `is_open` e `layout` (posições dos nós fixos do canvas, JSONB) |
| `virtual_mcp_skills` | vínculo skill ↔ MCP virtual, com as flags `as_skill`/`as_prompt`/`as_resource`, contadores **próprios** e a posição do nó no canvas (`pos_x`/`pos_y`, nulas = auto-layout) |
| `virtual_mcp_keys` | chaves `psv_` por servidor; mesmo formato de `api_keys` |
| `catalogs` | grupos de skills com dono (`owner_user_uuid`, como `virtual_mcps`), `is_active`, `is_public` (legível por qualquer conta e pelo site, **com os membros ativos**) e contadores **do catálogo** (somam quando a skill chegou ao vMCP por ele) |
| `catalog_skills` | a participação skill ↔ catálogo, com `is_active` (desativa a skill **neste** catálogo sem removê-la) — sem portas: quem as decide é o vínculo com o vMCP |
| `virtual_mcp_catalogs` | vínculo catálogo ↔ MCP virtual, N:N, com as flags `as_skill`/`as_prompt`/`as_resource` (valem para todo membro) e a posição do nó no canvas (`pos_x`/`pos_y`) |
| `skill_grants` / `catalog_grants` / `virtual_mcp_grants` | as concessões por objeto (`017`): PK `(objeto, conta)`, os dois `ON DELETE CASCADE`, `level` em `view`/`edit`/`manage` (CHECK), `granted_by_user_uuid` informativo (`SET NULL`) e `created_at`; índice reverso por `user_uuid`. Dono e admin **não** têm linha |
| `settings` | configuração da instalação, chave-valor; `default_virtual_mcp` guarda o uuid do vMCP que responde em `/mcp`, sem FK, e as três chaves `rag.*` guardam driver, modelo e estado do indexador (`020`) |
| `mcp_sessions` | uma linha por cliente conectado a um vMCP pelo MCP público: transporte, por onde chegou, credencial, IP, `clientInfo`, atividade e fim. Sobrevive à remoção do vMCP e nunca é podada |
| `skill_accesses` | uma linha por **leitura** de uma skill (`018`): o que foi lido (`kind`, `surface`), por onde (`origin`, o vMCP, os catálogos do caminho), com que credencial (`auth`, chave `psv_`, chave `psk_` e conta), de onde (`ip`, `user_agent`, `clientInfo`, `session_id`) e quando. Toda FK é `SET NULL` com a cópia ao lado; nunca é podada |
| `rag_spaces` | um espaço de embedding (`020`): driver, modelo, dimensões e os **dois prefixos** do driver — a identidade é a combinação dos cinco |
| `rag_texts` | o texto canônico, endereçado pelo próprio SHA-256 e guardado **sem** o prefixo do driver; o hash é conferido pelo banco |
| `rag_skill_texts` | as ocorrências: onde cada texto aparece (skill, fonte, arquivo, parte). Texto em uso não pode ser apagado |
| `rag_vectors` | o vetor de um texto num espaço; a FK composta com `rag_spaces` e o `CHECK` de `vector_dims` impedem vetor de dimensão errada |
| `rag_text_status` | o estado do par (espaço, texto) na fila (`025`): `reservado` com prazo (`until`) ou `recusado` sem prazo, com o motivo. As duas FKs são `CASCADE` — estado de fila não segura a coleta de órfãos nem sobrevive ao espaço |
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
não tem coluna de visibilidade e só é exibida — no site e nos servidores MCP
— onde chega a um MCP virtual, por um de dois caminhos: o **vínculo direto**
(`virtual_mcp_skills`), que carrega as três portas, `as_skill`, `as_prompt`
e `as_resource`, obrigatórias e sem default, e contadores próprios; ou um
**catálogo** de que participa, vinculado ao vMCP (`016`, ver
[Catálogos](#catálogos)). Nos dois casos a skill precisa estar **ligada**
(`skills.is_active`); o contador global da skill continua somando junto.

Toda leitura de skill recebe uma `visibility` **ou** um `viewer`:

| Opção | Enxerga | Quem passa |
|-------|---------|------------|
| `visibility: 'open'` (padrão) | skills **ligadas** que são públicas (`is_public`), ou expostas em ao menos um vMCP aberto e ligado (por vínculo direto ou por catálogo), ou com participação ativa em catálogo público e ligado | site e API REST anônima |
| `visibility: 'all'` | o acervo inteiro, inclusive flutuantes, desligadas e órfãs; `access: 'owner'` em tudo | token global e sessão de bootstrap |
| `viewer: { role, userUuid }` | com `role: 'admin'`, o mesmo que `'all'`; senão, o que a conta vê (`docs/12` §3.1): pública, dela, concedida a ela, em vMCP aberto e ligado, em catálogo público e ligado, ou dentro de um vMCP/catálogo que ela possui ou lhe foi concedido. **Sem** filtrar `is_active` — o painel mostra a desligada a quem a vê. Sobrepõe `visibility` | painel e mcp-admin (a sessão ou o dono da chave `psk_`) |
| `virtualMcp: { uuid, surface }` | a exposição naquele vMCP com a porta da superfície, pela precedência dos catálogos; sobrepõe as duas acima | mcp-public |

Na visibilidade `'open'` a leitura também **deixa de trazer** o que o site não
mostra, em vez de trazer e o app cortar (`tasks/002`): o dono vem nulo
(`ownerUserUuid`/`ownerEmail` — e-mail é dado pessoal que o `docs/12` §10 aceita
expor a conta logada, não ao anônimo), `grants` vem vazio em `getSkillDetail`, e
dentro de `mcps` o `catalogs` do caminho **só nomeia catálogo público**. O
vínculo por catálogo privado continua contando para a exposição — a skill *está*
naquele servidor —, o que não sai é o nome do catálogo fechado. Além de fechar o
vazamento pelo lado do banco, é o que para de pagar uma subconsulta de e-mail
por linha e uma consulta de concessões por página da skill.

O padrão é o restritivo de propósito: quem esquece a opção mostra de menos,
nunca de mais. O filtro mora no SQL porque o `total` de `listSkills` e a
contagem de `listTags` não têm conserto depois da consulta. `SkillSummary`
traz `isActive`, `isPublic`, o dono (`ownerUserUuid`, `ownerEmail`), o
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
  e nada é auditado.
- `Grant` é `{ userUuid, email, name, role, level, grantedByUserUuid,
  grantedByEmail, createdAt }`; quem concedeu pode já ter sido removido
  (`SET NULL` → os dois nulos).
- Conta **desativada** mantém as linhas, inertes: as leituras por `viewer`
  não olham `users.is_active` (uma sessão de conta desativada não existe);
  reativar devolve o acesso. Conta removida leva as linhas (`CASCADE`) e deixa
  os objetos dela órfãos.

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
**ativas** cujo nome ou e-mail contém `q` (`ILIKE`, com o termo **literal** —
ver [O termo de busca](#o-termo-de-busca-literal-e-indexado)), por nome,
`UserLookup[]` (`uuid`, `email`, `name`, `role`). `q` aparado com menos de dois
caracteres devolve `[]` sem consultar; `limit` é clamp 1..50.

**Site.** `listPublicCatalogs()` lista os catálogos públicos e ligados
(`PublicCatalog`: sem dono, sem concessões, `skillCount` = participações
ativas de skills ligadas), por nome. `getPublicCatalog(slug)` é a página:
`PublicCatalogDetail` com `skills` = **todos** os membros ativos como
`SkillSummary` na visibilidade do site (`mcps` só com abertos e ligados,
`catalogs` vazio, `access` nulo), por nome — inclusive os privados e os que
não estão em vMCP aberto nenhum, porque o contêiner expõe (`docs/12`
decisão 5). Privado, desligado ou inexistente é `null`, sem distinção.

**Auditoria** (`docs/12` §8): `skill.share` / `skill.unshare` levam
`skill_uuid`/`skill_slug` e `target_label` = `email:nível` / `email`;
`catalog.share` / `mcp.share` levam `<slug> <email>:<nível>` e
`catalog.unshare` / `mcp.unshare` levam `<slug> <email>` — sem skill, como
os demais eventos de contêiner. Transferir é `update` / `catalog.update` /
`mcp.update` do objeto com o e-mail do novo dono no label (`email` na skill,
`<slug> <email>` nos outros); deixar órfão não muda o label. A adoção
(`adoptOrphans`) grava exatamente isso: `update` com `skill_uuid`/`skill_slug`
e o e-mail, ou `catalog.update` com `<slug> <email>`. Ligar o flag
público é um `update` comum.

**Efeito da `017` numa instalação existente** (`docs/12` §9): leitores
viram membros e **deixam de ver** o que não é deles, público ou exposto;
editores deixam de editar o que não criaram. O admin marca públicas as
skills que devem continuar visíveis, concede `view`/`edit` ou transfere.

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
| `skills.is_active` | a skill some de **todo** vMCP (direto ou por catálogo) e do site; o painel e o mcp-admin (`'all'`) continuam a vê-la | `createSkill`/`updateSkill`/`updateSkillWithContent` (`isActive`) — é `update` na skill |
| `catalog_skills.is_active` | a participação: a skill fica no catálogo e não é entregue **por ele** | `setCatalogSkillActive`, `setCatalogSkills` — é `catalog.update` |
| `catalogs.is_active` | o catálogo inteiro deixa de contribuir em todo vMCP; membros e vínculos ficam | `updateCatalog` — é `catalog.update` |

**Contadores.** `recordSkillAccess` (e as antigas `incrementViewCount(skill,
mcp)` / `incrementDownloadCount`, que só somam) somam no global da skill e
**no caminho**: havendo vínculo direto, no vínculo, como antes; sem ele, em
**cada** catálogo que contribuiu (ligado, com participação ativa, vinculado
ao vMCP). Um acesso pelo vínculo direto não soma no catálogo mesmo que a
skill esteja nele — o catálogo não foi o caminho. Não há contador por
vínculo catálogo×vMCP. Continua best-effort, sem transação. Desde o `018`
cada leitura também deixa uma linha em `skill_accesses`, com os mesmos
catálogos — ver [Acessos por skill](#acessos-por-skill); a do mcp-admin
deixa só a linha, sem somar.

**As queries** (mesmo padrão de `virtual_mcps`: ator obrigatório, `FOR
UPDATE` nas declarativas, `updated_at = now()` nas escritas que mudam o
objeto, auditoria com `targetLabel` = slug do catálogo; **a permissão é do
app** — `canCreateCatalog` / `canManageCatalog` de shared, e vincular
catálogo↔vMCP exige administrar **os dois**):

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
  que a conta vê.
- `createCatalog({ slug?, name, description?, isPublic?, ownerUserUuid },
  source, actor)` audita `catalog.create`. Slug omitido é gerado do nome;
  informado passa por `isValidSlug`; em uso é 409. `updateCatalog(uuid, {
  slug?, name?, description?, isActive?, isPublic?, ownerUserUuid? })` é
  parcial no padrão de `updateVirtualMcp` e audita `catalog.update` (com
  `<slug> <email>` numa transferência — as regras estão em
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
| `auth` | `open` (vMCP aberto), `key` (chave `psv_`, em `key_id`/`key_name`), `user` (chave `psk_` em `api_key_id`/`api_key_name` e a conta em `user_uuid`/`user_email`) ou `anonymous` (o site) |
| caminho | com vMCP, os catálogos por onde a skill chegou a ele **nesta leitura** — os mesmos que recebem o contador: ligados, com participação ativa, vinculados ao vMCP, e só sem vínculo direto. Três arrays paralelos (`catalog_uuids`/`_slugs`/`_names`), vazios no vínculo direto, no site e no mcp-admin |
| histórico | toda FK (`skill_uuid`, `virtual_mcp_uuid`, `key_id`, `api_key_id`, `user_uuid`) é `ON DELETE SET NULL` e tem a **cópia** ao lado (`skill_slug`/`skill_name`, `virtual_mcp_slug`/`virtual_mcp_name`, `key_name`, `api_key_name`, `user_email`). Apagar o objeto não apaga a leitura; o uuid nulo é o que diz que ele sumiu. Os arrays de catálogo não têm FK: o uuid fica, e a **listagem** o devolve nulo quando o catálogo já não existe |
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
| **pendência de skill** | `skills.rag_stale`, marcada por trigger em skill (nome, descrição), arquivo (texto e caminho, nunca binário) e tag. Contador não marca. Quem limpa é o indexador, ao reservar |
| **pendência de texto** | um anti-join: texto com ocorrência e sem vetor no espaço ativo (`listPendingRagTexts`), **menos** o que está recusado ou reservado (`rag_text_status`, `025`) |
| **estado na fila** | `rag_text_status`, PK `(space_uuid, text_sha256)`: `reservado` até `until` (alguém está pagando por ele agora) ou `recusado` sem prazo (o provedor não aceita o conteúdo). Ver [A fila de textos](#a-fila-de-textos-recusa-e-reserva) |
| **hash do arquivo** | `files.content_sha256`, por trigger (coluna gerada não serve: `convert_to` é STABLE). Num arquivo que cabe inteiro num texto, é o **mesmo** hash de `rag_texts` |

O indexador (container próprio, fora de `database/`) reserva um lote com
`claimStaleSkills`, que marca a skill como limpa **antes** de ler o conteúdo:
uma mudança feita durante o processamento volta a marcá-la pelo trigger, e
nada se perde; uma falha chama `releaseStaleSkill`. A reserva usa CTE
`MATERIALIZED` com `FOR UPDATE SKIP LOCKED` — dois indexadores em paralelo
pegam lotes diferentes.

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
- **trocar de modelo zera os dois**, pela cascata de `rag_spaces`: espaço novo,
  fila nova. E um texto recusado que fica órfão perde a marca quando é coletado
  — se o mesmo conteúdo voltar ao acervo, o provedor o recusa uma vez mais.

Nenhum índice novo além da PK `(space_uuid, text_sha256)`, que é o que a
exclusão da fila usa, e de `rag_text_status_text_idx`, que serve à cascata
vinda de `rag_texts` na coleta de órfãos.

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
| Escrita | `createSkill`, `updateSkill`, `updateSkillWithContent` (as três aceitam `icon`, `isActive` e `isPublic`; as duas últimas também `ownerUserUuid`), `deleteSkill`, `setFile` (upsert), `createFile` (só se o caminho está livre), `setFiles`, `deleteFile` — ver [Arquivos da skill](#arquivos-da-skill) |
| Acesso | `setSkillGrant`, `removeSkillGrant`, `listSkillGrants`, `setCatalogGrant`, `removeCatalogGrant`, `listCatalogGrants`, `setVirtualMcpGrant`, `removeVirtualMcpGrant`, `listVirtualMcpGrants`, `lookupUsers`, `adoptOrphans` |
| Site | `listOpenVirtualMcps`, `listPublicCatalogs`, `getPublicCatalog` |
| Vínculo pelo lado da skill | `linkSkill` (aceita `{ position }`), `unlinkSkill` (e `mcps` em `createSkill`) |
| Canvas | `setVirtualMcpCanvas` (`layout`, `positions`, `catalogPositions`); `layout`/`catalogs` em `VirtualMcpDetail`, `position`/`icon` em `VirtualMcpSkill`, `toolCount`/`promptCount`/`resourceCount`/`preview`/`previewCatalogs`/`onlineSessions`/`catalogCount` em `VirtualMcpSummary` |
| Catálogos | `listCatalogs`, `getCatalog`, `getCatalogByUuid`, `createCatalog`, `updateCatalog`, `deleteCatalog`, `setCatalogSkills`, `addCatalogSkill`, `removeCatalogSkill`, `setCatalogSkillActive`, `linkCatalog`, `unlinkCatalog`, `setVirtualMcpCatalogs` |
| Sessões MCP | `openMcpSession`, `touchMcpSession`, `closeMcpSession`, `closeMcpSessions`, `findOpenMcpSession`, `expireMcpSessions`, `listMcpSessions`, `countOnlineMcpSessions` |
| Auditoria paginada | `listAuditPage` |
| Acessos por skill | `recordSkillAccess` (grava a leitura **e** soma os contadores), `listSkillAccesses` |
| Contadores | `incrementViewCount`, `incrementDownloadCount` (só somam; os apps migram para `recordSkillAccess`) |
| RAG | `getRagSettings`, `seedRagSetting`, `setRagSetting`, `setRagIndexerStatus`, `resolveRagSpace`, `findRagSpace`, `ragSchemaReady`, `claimStaleSkills`, `releaseStaleSkill`, `readSkillForRag`, `replaceSkillTexts`, `listPendingRagTexts`, `markRagTextRefused`, `collectOrphanRagTexts`, `insertRagVectors`, `ragCoverage`, `markAllSkillsStale`, `RAG_SETTING_KEYS`, `RAG_EDITABLE_SETTINGS` |
| Contas | `countUsers`, `listUsers`, `getUserByUuid`, `getUserByEmail`, `getUserByOidc`, `createUser`, `updateUser`, `registerFailedLogin`, `registerSuccessfulLogin` |
| Chaves de API | `listApiKeys`, `createApiKey`, `revokeApiKey`, `getApiKeyByPrefix`, `touchApiKey` |
| Senha | `createResetToken`, `consumeResetToken` |
| Auditoria de conta | `recordAccountAudit` |
| MCP virtual | `listVirtualMcps`, `listOpenVirtualMcps`, `getVirtualMcp`, `getVirtualMcpByUuid`, `resolveVirtualMcp`, `createVirtualMcp`, `updateVirtualMcp`, `deleteVirtualMcp`, `setVirtualMcpSkills`, `listVirtualMcpKeys`, `listVirtualMcpKeysByCreator`, `createVirtualMcpKey`, `revokeVirtualMcpKey`, `getVirtualMcpKeyByPrefix`, `touchVirtualMcpKey` |
| MCP padrão | `DEFAULT_MCP_SETTING`, `resolveDefaultVirtualMcp`, `setDefaultVirtualMcp` |
| Erros | `AppError`, `notFound`, `badRequest`, `conflict`, `unauthorized`, `isUniqueViolation`, `isForeignKeyViolation` |
| Schema/tipos | `skills`, `files`, `tags`, `skillTags`, `auditLog`, `users`, `apiKeys`, `resetTokens`, `virtualMcps`, `virtualMcpSkills`, `virtualMcpKeys`, `catalogs`, `catalogSkills`, `virtualMcpCatalogs`, `skillGrants`, `catalogGrants`, `virtualMcpGrants`, `settings`, `mcpSessions`, `skillAccesses`, `ragSpaces`, `ragTexts`, `ragSkillTexts`, `ragVectors`, `SkillRow`, `FileRow`, `TagRow`, `AuditRow`, `UserRow`, `ApiKeyRow`, `ResetTokenRow`, `VirtualMcpRow`, `VirtualMcpSkillRow`, `VirtualMcpKeyRow`, `CatalogRow`, `CatalogSkillRow`, `VirtualMcpCatalogRow`, `SkillGrantRow`, `CatalogGrantRow`, `VirtualMcpGrantRow`, `SettingRow`, `McpSessionRow`, `SkillAccessRow`, `RagSpaceRow`, `RagTextRow`, `RagSkillTextRow`, `RagVectorRow`, `RagTextStatusRow` |
| Tipos de query | `UserRecord`, `CreateUserInput`, `UpdateUserInput`, `ApiKeyRecord`, `Stats`, `ListOptions`, `SkillVisibility`, `Viewer`, `SortOrder`, `PublicationSurface`, `PublishedSkill`, `FileInput`, `FileContent`, `SetFilesOptions`, `CreateSkillInput`, `UpdateSkillInput`, `SkillLinkFlags`, `VirtualScope`, `VirtualMcpRuntime`, `VirtualMcpKeyRecord`, `VirtualMcpKeyWithMcp`, `DefaultMcpResolution`, `CreateVirtualMcpInput`, `UpdateVirtualMcpInput`, `VirtualMcpReadOptions`, `VirtualMcpCanvasInput`, `CreateCatalogInput`, `UpdateCatalogInput`, `CatalogReadOptions`, `AdoptOrphansResult`, `OpenMcpSessionInput`, `ListMcpSessionsOptions`, `ListSkillAccessesOptions`, `ListAuditOptions`, `SemanticScope`, `SearchMode`, `SkillSearchResult`, `RagNeighbor`, `RagSettingKey`, `RagEditableSetting`, `RagSettings`, `RagSettingRow`, `RagSeedResult`, `RagSpaceInput`, `RagSpace`, `RagSkillContent`, `RagSkillFile`, `RagTextInput`, `RagPendingText`, `PendingRagTextsOptions`, `RagVectorInput`, `RagCoverage` (a entrada e a saída de `recordSkillAccess`/`listSkillAccesses` — `SkillAccessInput`, `SkillAccessEntry`, `SkillAccessPage` e os quatro literais — vêm de shared) |
| Migrations | `runMigrations`, `schemaDir` |

As funções de escrita já gravam em `audit_log`, recebem a origem
(`'web-admin'` ou `'mcp-admin'`) e aceitam um **ator opcional** no fim:

```ts
await createSkill(input, 'web-admin', { userUuid: user.uuid, label: user.email });
await setFiles(slug, arquivos, 'mcp-admin', { replace: true }, ator); // actor é o 5º
```

O ator é `AuditActor` de `@purple-skills/shared` (`{ userUuid, label }`).
Omiti-lo grava a linha sem ator, como antes — nenhuma chamada existente quebra.
Em `createSkill` ele também preenche `skills.created_by_user_uuid`.

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
- **sem trava nova**, de propósito: `FOR UPDATE` na skill entra em deadlock com
  o trigger `files_rag_stale_trg` (`020`) de quem grava arquivo — a mesma razão
  pela qual `createFile` trava em `FOR KEY SHARE` (ver
  [Arquivos da skill](#arquivos-da-skill)). O contrato não muda: nenhum app
  precisa tratar conflito de versão.

### Arquivos da skill

O caminho passa por `normalizeRelativePath` de shared (barras, `./`, `..`,
teto de 512 caracteres; o que não serve é 400 `Caminho inválido: <como
veio>`) e é único **sem diferenciar caixa** (`003`). Mime, texto × binário e
tamanho saem de uma regra só (`fileColumns` em `queries.ts`): mime pela
extensão; texto quando o mime é textual e não há byte nulo; binário no resto.
Conteúdo vazio vale: `''` num texto, `bytea` vazio num binário.

| Função | Semântica | Auditoria |
|--------|-----------|-----------|
| `setFile(slug, caminho, conteúdo, source, actor?)` | **upsert**: sobrescreve o arquivo existente em qualquer caixa, e a caixa nova passa a ser a gravada | `create` ou `update`, com o conteúdo anterior |
| `createFile(slug, caminho, conteúdo, source, actor?)` | **cria só se o caminho está livre**; ocupado é 409 e nada muda. Mesmos parâmetros e retorno (`SkillFileMeta`) de `setFile` | `create` com o caminho normalizado e `previousContent` nulo; recusa não audita |
| `setFiles(slug, arquivos, source, { replace?, expectedDeletions? }, actor?)` | upsert em lote; com `replace` (padrão) apaga o que ficou de fora, menos o `SKILL.md` | um `delete` por caminho removido, com o conteúdo anterior dos textuais, **mais** um `update` sem caminho |
| `deleteFile(slug, caminho, source, actor?)` | apaga a linha daquele caminho; o `SKILL.md` é 400 e caminho ausente é 404 | `delete` com o conteúdo anterior |

Skill desconhecida é 404 (`Skill não encontrada: <slug>`) nas quatro. Os 409
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

**Concorrência.** `createFile` roda numa transação: serializa as criações na
mesma skill com um advisory lock de transação (chave
`hashtextextended('purple-skills:files:<uuid da skill>', 0)`), trava a skill
em `FOR KEY SHARE` (é o 404 de quem sumiu e segura um `deleteSkill`),
confere e insere com `ON CONFLICT (skill_uuid, lower(relative_path)) DO
NOTHING`. Sem linha devolvida, é o 409 do arquivo existente — a garantia
contra quem grava sem a trava (`setFile`). A trava **não** é
`FOR UPDATE` na skill, de propósito: o INSERT desses escritores pede `FOR KEY
SHARE` na checagem da FK e, com a skill indexada, o trigger
`files_rag_stale_trg` (`020`) faz `UPDATE` nela. Com a skill em `FOR
UPDATE`, um `setFile` do mesmo caminho novo entra em deadlock (40P01) com a
criação.

`setFiles` toma **a mesma trava** e é por isso que a confirmação da remoção
vale: `expectedDeletions` é o número de arquivos que a chamada espera remover,
conferido **dentro** da transação, depois do `DELETE` — se não bater, nada é
gravado e a chamada é 409. É o que fecha a janela entre a prévia que o cliente
leu (`listFiles`) e a escrita; omitido, a remoção acontece como sempre. As
linhas `delete` nascem do próprio `DELETE … RETURNING`, numa statement só: o
conteúdo registrado é o que a transação de fato apagou. O lote de gravação é
uma statement por fatia (200 arquivos ou 8 MiB), com os caminhos deduplicados
por `lower(...)` — o pacote que traz `Notas.md` e `notas.md` juntos grava uma
linha, com a última grafia e o último conteúdo, como o laço de antes fazia.

Limites conhecidos de `setFile`, que segue sem trava: não confere arquivo ×
pasta (um `setFile('docs/a.md')` numa skill com o arquivo `docs` grava os
dois), e ele e uma escrita em lote na mesma skill indexada podem entrar em
deadlock entre si (`setFiles([x, y])` × `setFile(y)`) desde a `020`.

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

// apps/site — só o que está em vMCP aberto e ligado (o padrão)
const catalogo = await listSkills({ query });

// apps/admin, apps/mcp-admin — tudo
const tudo = await listSkills({ query, visibility: 'all' });
```

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
`setVirtualMcpSkills`. **A permissão é do app**: conferir que o chamador
administra o vMCP (`canManageVirtualMcp`) vem antes de chamar.

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
  = slug do MCP (o novo, em rename; `<slug> <email>` numa transferência).
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
  restrita ao MCP. A auditoria das chaves (`mcp.key.create` / `mcp.key.revoke`)
  é gravada pelo app via `recordAccountAudit`, com `targetLabel` = nome da chave.
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
  admin escolhe**, e essa checagem é do app.
- `VirtualMcpSummary.isDefault` é calculado na listagem e no detalhe a partir
  da mesma chave.

### Contas, chaves e senha

- `UserRecord` é `UserSummary` **mais** `passwordHash`, `tokenVersion`,
  `failedAttempts` e `oidcSubject`. Nada disso vai para o navegador: `listUsers`
  devolve `UserSummary`.
- `updateUser` é parcial. `undefined` é "não mexe", `null` é "apaga";
  `bumpTokenVersion: true` incrementa `token_version` e derruba todo cookie já
  emitido para a conta.
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
    adoção de órfãos (`adoptOrphans` exige uma admin ativa só);
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
  Devolve `false` quando não achou ou já estava revogada.
- `createResetToken` emite o link e **fecha os que a conta tinha vivos**; a
  assinatura (`{ userUuid, tokenHash, expiresAt }`) não mudou. `consumeResetToken`
  é um UPDATE condicional atômico: dois cliques no mesmo link não redefinem a
  senha duas vezes, e link substituído ou vencido devolve `null`, sem distinguir
  o motivo. Trocar a senha por `updateUser` fecha os vivos por trigger — ver
  [Links de redefinição de senha](#links-de-redefinição-de-senha).
- `recordAccountAudit` grava os eventos de conta (`user.create`, `user.role`,
  `user.deactivate`, `user.password`, `key.create`, `key.revoke`), os das
  chaves de MCP virtual (`mcp.key.create`, `mcp.key.revoke`) e os das chaves do
  MCP principal (`public.key.create`, `public.key.revoke`) — linhas sem skill,
  com `targetLabel` dizendo sobre quem foi.
- `user.password` (`024`) é a senha de **outra** conta trocada por quem
  administra ou por um link de redefinição; `targetLabel` é o e-mail da conta
  afetada e o **ator** diz o caminho: o e-mail do admin, `bootstrap` ou
  `link-de-redefinicao` (ali só se sabe que alguém portava o link). A troca
  feita pelo próprio dono logado fica fora, como o login. Senha nenhuma, nem
  hash, entra na linha.

### Auditoria paginada

`listAudit(limit)` continua sendo as últimas linhas, sem filtro (o widget do
dashboard). A tela da trilha usa `listAuditPage(options)`, que devolve
`AuditPage` (`items`, `total`, `limit`, `offset`), com `total` sob os mesmos
filtros da página:

| Opção | Efeito |
|-------|--------|
| `limit`, `offset` | clamp 1..200, padrão 50; offset negativo ou torto vira 0 |
| `action` | igualdade; valor fora do `CHECK` de `audit_log.action` é 400 |
| `actor` | igualdade com `actor_label` (e-mail, `token-global`, `bootstrap`, `seed`) |
| `q` | `ILIKE %q%` em `skill_slug`, `target_label`, `file_path` e `actor_label`, com o termo **literal** e os quatro GIN de trigrama do `022` — ver [O termo de busca](#o-termo-de-busca-literal-e-indexado) |
| `since`, `until` | `created_at >=` / `<=`; precisam ser `Date` válidas |

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
  são aparados e cortados em 512 caracteres.
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
  vê. Uuid torto em qualquer filtro é 400; `limit` clamp 1..200, padrão 50.
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
  `psv_` por `keyId`, da `psk_` por `apiKeyId`, e-mail por `userUuid`).
  `kind`/`surface`/`origin`/`auth` fora dos `CHECK`s, `skillUuid` torto ou
  rótulo que não é string são 400 (bug do chamador). **Skill inexistente não
  grava nada e não lança** — ela pode ter sumido entre a leitura e o
  registro. Uuid torto num campo opcional, ou vMCP/chave/conta que já não
  existe, é ignorado: a coluna fica nula e `auth` fica como veio. Os
  rótulos (`sessionId`, `ip`, `userAgent`, `clientName`, `clientVersion`)
  são aparados e cortados em 512 caracteres.
- `listSkillAccesses({ skillUuid?, catalogUuid?, virtualMcpUuid?, userUuid?,
  apiKeyId?, q?, origin?, kind?, limit?, offset? })` devolve
  `SkillAccessPage` (`items: SkillAccessEntry[]`, `total`, `limit`,
  `offset`): ordem `created_at DESC, id DESC`; os filtros por objeto são
  igualdade e se somam (`userUuid` é a guia da conta — as leituras pelas
  chaves `psk_` dela —, `apiKeyId` recorta a uma chave); `limit` clamp
  1..200, padrão 50; offset torto vira 0; `q` é `ILIKE %q%` em
  `user_email`, `api_key_name`, `key_name`, `ip`, `client_name` e
  `session_id`, com o termo **literal** e os seis GIN de trigrama do `022`
  (ver [O termo de busca](#o-termo-de-busca-literal-e-indexado));
  `origin`/`kind` fora do `CHECK` e uuid torto em qualquer
  filtro são 400. `catalogs` vem como `[{ uuid, slug, name }]` na ordem
  gravada (por nome), com `uuid` nulo para catálogo já apagado. O filtro
  pela skill, pelo vMCP, pela conta ou pela chave apagados não acha mais
  nada (a coluna foi a nulo); o pelo catálogo apagado ainda acha, porque o
  array guarda o uuid.

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
for (const lote of lotes(pendentes)) {                    // grava lote a lote
  try {
    await insertRagVectors(espaco.uuid, await embutir(lote));
  } catch (err) {
    if (recusaDeConteudo(err)) await markRagTextRefused(espaco.uuid, lote[0].sha256, err.message);
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
- **A fila.** `claimStaleSkills(limit)` reserva e devolve os uuids;
  `releaseStaleSkill(uuid)` devolve um à fila (uuid torto é ignorado: isso
  roda no `catch`); `markAllSkillsStale` marca todas e **não apaga vetor
  nenhum** — o que ele refaz é a divisão, e o texto que não mudou reaproveita
  o vetor. Nenhum dos três toca `updated_at`: reindexar não é publicar.
- **Os textos.** `readSkillForRag(uuid)` devolve metadados, tags e os
  arquivos **de texto** (com `id`, `content` e o `sha256` do arquivo), ou
  `null` se a skill sumiu. `replaceSkillTexts(uuid, ocorrências)` é
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
  continuam 400. `collectOrphanRagTexts(limit = 500)` apaga os textos sem
  ocorrência e devolve quantos saíram; chame **depois** de embutir, quando todo
  `replaceSkillTexts` da rodada já commitou.
- **`ragCoverage(spaceUuid | null)`** é o número do painel: `texts` (com
  ocorrência), `withVector`, `pendingTexts`, `refusedTexts` (dentro de
  `pendingTexts`: o que nunca vai ter vetor naquele espaço) e `staleSkills`.
  Uuid nulo ou torto é o driver desligado: `withVector` 0.

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
    database/src/schema.integration.test.ts
```

A suíte do RAG e a do `schema.ts` exigem **pgvector** no servidor (a imagem
`pgvector/pgvector` já o traz) e um papel que possa `CREATE EXTENSION`, como o
`pg_trgm` do `001` — as duas aplicam o schema inteiro.

| Suíte | Cobre |
|-------|-------|
| `files.integration.test.ts` | unicidade de caminho sem diferenciar caixa; `createFile`: arquivo vazio (texto e binário) na raiz e em pasta, com o retorno igual à listagem; as quatro recusas com a mensagem exata, sem alterar conteúdo nem auditar (inclusive o `SKILL.md` sem linha); `_` e `%` literais; a auditoria `create`; os 404/400; criações concorrentes (o mesmo caminho em várias caixas e arquivo × pasta); e o INSERT alheio em andamento que vira 409 pelo `ON CONFLICT`, sem deadlock, com a skill indexada |
| `users.integration.test.ts` | contas, bloqueio de login, chaves de API, tokens de reset (uso único, expirado, o link fechado na emissão do próximo e na troca da senha, o vencido que não é reetiquetado, o logout que não fecha nada e o `CHECK` dos dois carimbos) e o ator na auditoria |
| `virtual-mcps.integration.test.ts` | MCP virtual: recorte declarativo, leituras por vínculo, contadores duplos, chaves `psv_` (inclusive as emitidas por conta, `listVirtualMcpKeysByCreator`, e o índice do `021`) e o runtime que ignora inativos |
| `settings.integration.test.ts` | MCP padrão: escolha e limpeza com auditoria, as três causas de recusa da raiz, o CHECK com `mcp.default` e o caminho de atualização de uma base parada no `010` (`011` em diante aplicadas de uma vez e **re-executadas** sobre o resultado, para provar a idempotência do SQL) |
| `sessions.integration.test.ts` | sessões do MCP público: abrir/tocar/fechar, o `clientInfo` que só entra uma vez, o reuso de linha do stateless, a expiração com fim presumido por transporte, a listagem com filtros, recorte e `isOnline`, o contador por transporte, `onlineSessions` no resumo do vMCP com e sem janela, e a linha que sobrevive à remoção do vMCP sem ser podada |
| `catalogs.integration.test.ts` | catálogos (inclui o recorte do site: o catálogo **privado** do caminho não é nomeado em `mcps[].catalogs` fora de `'all'`/`viewer`, e o dono vem nulo): criar/atualizar/apagar com auditoria e alcance por dono; `setCatalogSkills` declarativa preservando a participação de quem ficou; a precedência (o vínculo direto sobrescreve, dois catálogos somam); as três desativações tirando a skill do servidor e do site; `mcps` com `direct: false` e `catalogs`; os contadores por caminho; `activeSkillCount` do nó excluindo quem tem vínculo direto; `catalogPositions` no canvas e o CHECK de par; as cascatas; `stats` e `listOpenVirtualMcps` com catálogo; e a re-execução do `016` |
| `virtual-mcps.integration.test.ts` também cobre | a visibilidade `'open'` do site (só vMCP aberto e ligado), `mcps` na skill, `listPublishedSkills` por vMCP, o `icon` da skill (regra de shared, 400 no inválido, CHECK de tamanho), os contadores por porta e os dois previews da colmeia (`preview` e `previewCatalogs`, com o teto `VIRTUAL_MCP_PREVIEW_SIZE` e o `isActive` do catálogo), e o canvas (`setVirtualMcpCanvas`, posição preservada por `setVirtualMcpSkills`, `linkSkill` com posição, `layout` que ignora lixo, os CHECKs de `014`) |
| `access.integration.test.ts` | acesso granular: o `017` sobre uma base parada no `016` (backfill do dono, órfã sem criador, `leitor` → `membro` e o CHECK novo); o que cada conta vê por `viewer` (dona, concessão direta, pública, via vMCP aberto, via catálogo público, via contêiner concedido, e o negativo), o `access` por linha, `mcps`/`catalogs` recortados, `scope` nos três tipos (inclusive para o admin), listagens e detalhes de catálogo/vMCP por `viewer`; `set*Grant` como upsert e as recusas, `remove*Grant` e os 404, as seis ações de auditoria com o formato do label; transferência que apaga a concessão do novo dono e recusa inativo/inexistente/torto nos três tipos; o flag público em skill e catálogo e o site acompanhando; `lookupUsers` (inclusive `%%` e `_` como caractere); `listPublicCatalogs`/`getPublicCatalog` com membros privados; as cascatas; a re-execução do `017` que não devolve dono a ninguém; e o UPDATE parcial das duas escritas de skill, com a escrita concorrente (renomeação, público e desligamento) sobrevivendo à trava da linha |
| `rag.integration.test.ts` | busca semântica (`020`): os 29 cenários de verificação do DDL — o backfill do hash numa base parada no `019` (sem tocar `updated_at`), a coluna gerada que o Postgres recusa, os triggers de pendência (skill, arquivo de texto, binário que não marca, UPDATE sem mudança, SKILL.md, tag, contador), o `CHECK` do hash e o texto com prefixo recusado, a deduplicação de textos iguais, o `CHECK` de dimensão e a FK composta, cobertura e pendências (com o texto órfão de fora), a fusão RRF, as cascatas de espaço, skill e arquivo e o texto em uso protegido, a reserva em lote e duas em paralelo, o HNSW acima de 2000 dimensões, a identidade do espaço com os dois prefixos (e os limites dos prefixos) e o mesmo texto em dois espaços; mais o **recorte de visibilidade real** nas duas pernas (o vMCP fechado que não vaza no site nem em outro servidor), a paginação e o `total` do conjunto fundido (inclusive a página além do fim e o conjunto fundido vazio, em que a contagem volta a ser uma consulta à parte, e as 120 skills com o mesmo termo, que provam que a perna textual entra inteira: o `total` é o da busca textual mais os vizinhos, e duas páginas cobrem o conjunto sem repetir nem pular), a semeadura e o painel em `settings` com as duas ações novas de auditoria, o **termo literal** (`%`, `_` e `\` como caractere, com as skills de controle que o curinga traria, nas duas pernas, e caixa/acento/palavra parcial intactos) e a re-execução da `020`; mais a **fila de textos** do `025` (a recusa gravada que tira o texto da fila daquele espaço e não é reescrita na segunda vez, o espaço/texto inexistente que não grava nem lança, a reserva com prazo que não deixa duas chamadas em paralelo pegarem o mesmo texto, a reserva vencida que volta à fila, a gravação do vetor que encerra a reserva, o hash sem texto que `insertRagVectors` ignora em vez de perder o lote, e a coleta de órfãos levando vetor e estado pelas cascatas) |
| `accesses.integration.test.ts` | acessos por skill (`018`): a leitura do site com as cópias e só o contador global; pelo MCP público por catálogo (os catálogos do caminho por nome, cada um somando, e a participação desativada saindo do caminho) e por vínculo direto (catálogos vazios, o contador do vínculo); pelo mcp-admin com o nome da chave `psk_` e o e-mail **e contador nenhum somado**; skill inexistente sem gravar nem lançar, opcionais tortos ou sumidos ignorados, e os 400; a listagem com cada filtro (skill, catálogo, vMCP, conta e chave `psk_` — duas contas, cada uma só vê a sua —, `origin`, `kind`), o `q` em cada coluna, a ordem, o clamp e os 400; as cópias sobrevivendo à remoção da skill, do catálogo, do vMCP (e da chave `psv_`) e da conta (e da chave `psk_`), sem poda; o `q` **literal** (`%` e `_` como caractere e o pior caso de LIKE casando nada); e a re-execução do `018`, do `019` e do `022` juntos, com o conjunto exato de índices — os seis GIN de trigrama incluídos — e o CHECK dos arrays |
| `schema.integration.test.ts` | `src/schema.ts` × banco migrado do zero (ver [O `schema.ts` e o banco](#o-schemats-e-o-banco)): tabela, coluna (tipo, NOT NULL, DEFAULT), chave primária e UNIQUE **com o nome da constraint**, chave estrangeira com a ação de remoção e índice (método, colunas, classe de operadores e `DESC`), nos dois sentidos; mais a lista `SOMENTE_SQL` dos parciais e por expressão, que precisa corresponder a índices que existem |
| `orphans.integration.test.ts` | adoção pelo admin solitário (`adoptOrphans`): a única admin ativa (com outra desativada) adota as skills órfãs do token global, do bootstrap e sem ator e o catálogo órfão, sem tocar o que tem dono nem os vMCPs (o `public` padrão continua órfão); `updated_at` de skills, catálogos e vMCPs, `rag_stale` e `search_vector` intocados; a concessão prévia da conta (promovida de editora) apagada só nos adotados, e as de outras contas e do vMCP mantidas; uma linha de auditoria por objeto no formato da transferência, com o ator e a origem recebidos (inclusive `bootstrap`); a segunda chamada sem adotar nem auditar; três chamadas simultâneas auditando uma vez só; o `q` **literal** de `listAuditPage` (`%` e `_` como caractere, e o pior caso de LIKE casando nada); e as recusas sem gravar — membro, editor, uuid torto ou inexistente, admin desativada (mesmo sendo a única), duas admins ativas, a outra reativada e a própria conta desativada |

As onze recriam o mesmo banco e o Vitest roda arquivos em paralelo: elas se
serializam por um advisory lock (`pg_advisory_lock`) segurado durante todo o
arquivo. Suíte de integração nova aqui dentro precisa usar o mesmo número.
