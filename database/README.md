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
    schema.ts          tabelas em Drizzle (tipagem + query builder)
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

Regras:

- **Ordem lexicográfica = ordem de aplicação.** O runner lê o diretório, ordena
  por nome e aplica o que ainda não está em `schema_migrations`.
- Uma migration aplicada é **imutável**: nunca edite um arquivo já publicado,
  crie o próximo número.
- Cada arquivo roda em **uma transação**; se falhar, sofre rollback inteiro e o
  processo aborta com o nome do arquivo.
- Escreva DDL idempotente (`IF NOT EXISTS`, `CREATE OR REPLACE`,
  `DROP ... IF EXISTS`) — é o que permite reaplicar num banco parcialmente migrado.
- O nome do arquivo é a **identidade** da migration dentro de `schema_migrations`.
  Renomear exige entrada em `RENAMED` no [`src/migrate.ts`](src/migrate.ts), como
  foi feito na mudança de `packages/db/migrations/nnnn_nome.sql` para cá.

### Tabelas

| Tabela | Papel |
|--------|-------|
| `skills` | catálogo: `slug`, `name`, `description`, `icon` (emoji ou URL, nulo = monograma), contadores e `search_vector`. Sem coluna de visibilidade: a skill é exibida onde está vinculada |
| `files` | árvore de arquivos da skill; texto **ou** binário, nunca os dois (CHECK) |
| `tags` / `skill_tags` | tags e o vínculo N:N com as skills |
| `audit_log` | trilha de auditoria de create/update/delete **e dos eventos de conta**, com o conteúdo anterior, o ator e o alvo |
| `users` | contas: papel (`admin`/`editor`/`leitor`), senha, vínculo OIDC, `token_version` e o bloqueio do login |
| `api_keys` | chaves `psk_` por usuário; guarda o prefixo e o hash, nunca o segredo |
| `reset_tokens` | tokens de redefinição de senha, com expiração e uso único |
| `virtual_mcps` | servidores MCP virtuais: `slug`, dono (`owner_user_uuid`), `is_active`, `is_open` e `layout` (posições dos nós fixos do canvas, JSONB) |
| `virtual_mcp_skills` | vínculo skill ↔ MCP virtual, com as flags `as_skill`/`as_prompt`/`as_resource`, contadores **próprios** e a posição do nó no canvas (`pos_x`/`pos_y`, nulas = auto-layout) |
| `virtual_mcp_keys` | chaves `psv_` por servidor; mesmo formato de `api_keys` |
| `settings` | configuração da instalação, chave-valor; `default_virtual_mcp` guarda o uuid do vMCP que responde em `/mcp`, sem FK |
| `mcp_sessions` | uma linha por cliente conectado a um vMCP pelo MCP público: transporte, por onde chegou, credencial, IP, `clientInfo`, atividade e fim. Sobrevive à remoção do vMCP e nunca é podada |
| `schema_migrations` | controle do runner (criado por ele, não por um `.sql`) |

Chaves primárias são `uuidv7()` do PostgreSQL 18. A busca usa `tsvector` com
configuração `simple`, mantido por trigger — ver `001` e `002`.

O desenho de contas, papéis e credenciais está em
[`docs/05-accounts-and-roles.md`](../docs/05-accounts-and-roles.md); `004` a
`006` são a parte dele que vive aqui. Dois pontos que o modelo assume:

- **não há ownership nas skills.** `skills.created_by_user_uuid` é informativo;
  o papel limita a ação, nunca o escopo. A única exceção do projeto é
  `virtual_mcps.owner_user_uuid` (`009`): o MCP virtual tem dono, o admin
  manda em todos e o dono no seu;
- **o ator pode não ser uma conta.** `audit_log.actor_user_uuid` é nulo para o
  `MCP_ADMIN_TOKEN` e para o bootstrap; quem sempre existe é `actor_label`.

### Onde uma skill é exibida

Uma skill é **flutuante** (`012`,
[`docs/09-mcp-padrao-e-skills-flutuantes.md`](../docs/09-mcp-padrao-e-skills-flutuantes.md)):
não tem coluna de visibilidade e só é exibida — no site e nos servidores MCP
— onde está **vinculada** a um MCP virtual. O vínculo (`virtual_mcp_skills`)
carrega as três portas, `as_skill`, `as_prompt` e `as_resource`,
obrigatórias e sem default, e contadores próprios; o contador global da
skill continua somando junto.

Toda leitura de skill recebe uma `visibility`:

| `visibility` | Enxerga | Quem passa |
|--------------|---------|------------|
| `'open'` (padrão) | skills com vínculo a ao menos um vMCP **aberto e ligado** | site e API REST |
| `'all'` | o catálogo inteiro, inclusive flutuantes | painel e mcp-admin |
| `virtualMcp: { uuid, surface }` | o vínculo daquele vMCP com a flag da superfície; sobrepõe `visibility` | mcp-public |

O padrão é o restritivo de propósito: quem esquece a opção mostra de menos,
nunca de mais. O filtro mora no SQL porque o `total` de `listSkills` e a
contagem de `listTags` não têm conserto depois da consulta. `SkillSummary`
traz `mcps`, os vínculos da skill: numa leitura `'all'` todos; nas demais só
os com vMCP aberto e ligado — o site não revela em que servidor fechado uma
skill está.

`is_public`, `use_as_skill`, `use_as_prompt` e `use_as_resource` existiram
entre `001` e `012`; `007` e `008` são a história delas, e o `011` copiou o
que valia para o vínculo com o vMCP `public` antes de o `012` as apagar.

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
| `migrate` | `purple-skills-db` (perfil `migrate`) | aplica o schema e sai |
| `seed` | `purple-skills-db` (perfil `seed`) | popula o catálogo de exemplo e sai |

`migrate` e `seed` usam o mesmo `database/Dockerfile` — é a única imagem que
carrega o SQL. As imagens dos apps recebem só o `dist/` do cliente.

Sem Docker, com um Postgres acessível:

```bash
npm run build -w @purple-skills/db
npm run migrate
npm run seed
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
| Leitura | `listSkills`, `listPublishedSkills`, `getSkillSummary`, `getSkillDetail`, `listFiles`, `readFile`, `readTextFile`, `readAllFiles`, `listTags`, `listAudit`, `stats` |
| Escrita | `createSkill`, `updateSkill`, `updateSkillWithContent` (as três aceitam `icon`), `deleteSkill`, `setFile`, `setFiles`, `deleteFile` |
| Vínculo pelo lado da skill | `linkSkill` (aceita `{ position }`), `unlinkSkill` (e `mcps` em `createSkill`) |
| Canvas | `setVirtualMcpCanvas`; `layout` em `VirtualMcpDetail`, `position`/`icon` em `VirtualMcpSkill`, `toolCount`/`promptCount`/`resourceCount`/`preview`/`onlineSessions` em `VirtualMcpSummary` |
| Sessões MCP | `openMcpSession`, `touchMcpSession`, `closeMcpSession`, `closeMcpSessions`, `findOpenMcpSession`, `expireMcpSessions`, `listMcpSessions`, `countOnlineMcpSessions` |
| Auditoria paginada | `listAuditPage` |
| Contadores | `incrementViewCount`, `incrementDownloadCount` |
| Contas | `countUsers`, `listUsers`, `getUserByUuid`, `getUserByEmail`, `getUserByOidc`, `createUser`, `updateUser`, `registerFailedLogin`, `registerSuccessfulLogin` |
| Chaves de API | `listApiKeys`, `createApiKey`, `revokeApiKey`, `getApiKeyByPrefix`, `touchApiKey` |
| Senha | `createResetToken`, `consumeResetToken` |
| Auditoria de conta | `recordAccountAudit` |
| MCP virtual | `listVirtualMcps`, `listOpenVirtualMcps`, `getVirtualMcp`, `getVirtualMcpByUuid`, `resolveVirtualMcp`, `createVirtualMcp`, `updateVirtualMcp`, `deleteVirtualMcp`, `setVirtualMcpSkills`, `listVirtualMcpKeys`, `createVirtualMcpKey`, `revokeVirtualMcpKey`, `getVirtualMcpKeyByPrefix`, `touchVirtualMcpKey` |
| MCP padrão | `DEFAULT_MCP_SETTING`, `resolveDefaultVirtualMcp`, `setDefaultVirtualMcp` |
| Erros | `AppError`, `notFound`, `badRequest`, `conflict`, `unauthorized`, `isUniqueViolation`, `isForeignKeyViolation` |
| Schema/tipos | `skills`, `files`, `tags`, `skillTags`, `auditLog`, `users`, `apiKeys`, `resetTokens`, `virtualMcps`, `virtualMcpSkills`, `virtualMcpKeys`, `settings`, `mcpSessions`, `SkillRow`, `FileRow`, `TagRow`, `AuditRow`, `UserRow`, `ApiKeyRow`, `ResetTokenRow`, `VirtualMcpRow`, `VirtualMcpSkillRow`, `VirtualMcpKeyRow`, `SettingRow`, `McpSessionRow` |
| Tipos de query | `UserRecord`, `CreateUserInput`, `UpdateUserInput`, `ApiKeyRecord`, `Stats`, `ListOptions`, `SkillVisibility`, `SortOrder`, `PublicationSurface`, `PublishedSkill`, `FileInput`, `FileContent`, `SetFilesOptions`, `CreateSkillInput`, `UpdateSkillInput`, `SkillLinkFlags`, `VirtualScope`, `VirtualMcpRuntime`, `VirtualMcpKeyRecord`, `DefaultMcpResolution`, `CreateVirtualMcpInput`, `UpdateVirtualMcpInput`, `VirtualMcpReadOptions`, `VirtualMcpCanvasInput`, `OpenMcpSessionInput`, `ListMcpSessionsOptions`, `ListAuditOptions` |
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

### Leitura por vMCP e vínculo pelo lado da skill

`listSkills`, `getSkillSummary`, `getSkillDetail` e `listTags` aceitam
`virtualMcp?: VirtualScope` (`{ uuid, surface: 'skill' | 'prompt' |
'resource' }`) — o recorte de um MCP virtual. Com ela o `WHERE` vira um
`EXISTS` sobre `virtual_mcp_skills` com a flag da superfície pedida e ignora
`visibility`. `listPublishedSkills(surface, virtualMcpUuid)` faz o mesmo para
`prompts/list` e `resources/list`, e `incrementViewCount(skill, mcp)` /
`incrementDownloadCount(skill, mcp)` somam no vínculo **e** no global:

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
  e órfãos); `{ ownerUserUuid }` restringe ao dono; `{ ownerUserUuid: null }`
  devolve `[]` — a sessão de bootstrap não é dona de nada.
  `listOpenVirtualMcps()` é a lista do site: só abertos e ligados, sem dono
  nem chaves, com `skillCount` e `isDefault`.
- `VirtualMcpSummary` traz, além de `skillCount`, os contadores por porta
  (`toolCount` = vínculos com `as_skill`, `promptCount`, `resourceCount`),
  `preview` (até 8 skills vinculadas por nome: `slug`, `name`, `icon`) e
  `onlineSessions`. Este último só é contado quando a chamada informa a
  janela — `listVirtualMcps({ onlineWindowMs })`, `getVirtualMcp(slug, {
  onlineWindowMs })`, `getVirtualMcpByUuid(uuid, { onlineWindowMs })`; sem
  ela é 0 e `mcp_sessions` nem é consultada. Janela não finita ou ≤ 0 é 400.
- `getVirtualMcp(slug)` / `getVirtualMcpByUuid(uuid)` devolvem
  `VirtualMcpDetail` (resumo + skills vinculadas, com as flags, os contadores
  **do vínculo**, o `icon` e a `position` no canvas + o `layout` dos nós
  fixos) e incluem inativos: é o painel que lê. `resolveVirtualMcp` é o
  oposto — só ativos, uma linha, sem agregação — e é o que o servidor
  consulta a cada requisição.
- `setVirtualMcpCanvas(uuid, { layout?, positions? })` grava o canvas:
  mescla `layout` chave a chave (só as informadas substituem) e grava
  `pos_x`/`pos_y` das skills listadas (`{ slug, x, y }`). Coordenadas
  precisam ser números finitos e são arredondadas para o pixel inteiro. Tudo
  numa transação: slug desconhecido, repetido ou não vinculado a **este**
  vMCP é 400 e nada é gravado; uuid inválido ou sem linha é 404. Sem
  auditoria e sem `updated_at`. A permissão é do app.
- `createVirtualMcp` / `updateVirtualMcp` / `deleteVirtualMcp` exigem ator e
  auditam como `mcp.create` / `mcp.update` / `mcp.delete`, com `targetLabel`
  = slug do MCP (o novo, em rename). Slug omitido é gerado do nome; informado
  passa por `isValidSlug`; em uso é 409. `updateVirtualMcp` é parcial no
  padrão de `updateUser` (`undefined` não mexe, `ownerUserUuid: null` apaga o
  dono).
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
- `registerFailedLogin(uuid, { maxAttempts, lockSeconds })` faz tudo num UPDATE
  só. Ao atingir o teto, grava `locked_until` e **zera** o contador.
- `getApiKeyByPrefix` faz só o primeiro passo: achar a linha pelo prefixo
  público. Comparar o segredo com `keyHash` é do app
  (`verifyApiKeySecret` de shared).
- `revokeApiKey(id, userUuid?)` com dono restringe ao dono; sem dono é o admin.
  Devolve `false` quando não achou ou já estava revogada.
- `consumeResetToken` é um UPDATE condicional atômico: dois cliques no mesmo
  link não redefinem a senha duas vezes.
- `recordAccountAudit` grava os eventos de conta (`user.create`, `user.role`,
  `user.deactivate`, `key.create`, `key.revoke`), os das chaves de MCP
  virtual (`mcp.key.create`, `mcp.key.revoke`) e os das chaves do MCP
  principal (`public.key.create`, `public.key.revoke`) — linhas sem skill,
  com `targetLabel` dizendo sobre quem foi.

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
| `q` | `ILIKE %q%` em `skill_slug`, `target_label`, `file_path` e `actor_label` |
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
  verdade, e o diff apagaria índices, CHECKs, funções e triggers.

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
    database/src/sessions.integration.test.ts
```

| Suíte | Cobre |
|-------|-------|
| `files.integration.test.ts` | unicidade de caminho sem diferenciar caixa |
| `users.integration.test.ts` | contas, bloqueio de login, chaves de API, tokens de reset e o ator na auditoria |
| `virtual-mcps.integration.test.ts` | MCP virtual: recorte declarativo, leituras por vínculo, contadores duplos, chaves `psv_` e o runtime que ignora inativos |
| `settings.integration.test.ts` | MCP padrão: escolha e limpeza com auditoria, as três causas de recusa da raiz, o CHECK com `mcp.default` e o caminho de atualização de uma base parada no `010` (`011` a `015` aplicadas de uma vez e **re-executadas** sobre o resultado, para provar a idempotência do SQL) |
| `sessions.integration.test.ts` | sessões do MCP público: abrir/tocar/fechar, o `clientInfo` que só entra uma vez, o reuso de linha do stateless, a expiração com fim presumido por transporte, a listagem com filtros, recorte e `isOnline`, o contador por transporte, `onlineSessions` no resumo do vMCP com e sem janela, e a linha que sobrevive à remoção do vMCP sem ser podada |
| `virtual-mcps.integration.test.ts` também cobre | a visibilidade `'open'` do site (só vMCP aberto e ligado), `mcps` na skill, `listPublishedSkills` por vMCP, o `icon` da skill (regra de shared, 400 no inválido, CHECK de tamanho), os contadores por porta e o preview, e o canvas (`setVirtualMcpCanvas`, posição preservada por `setVirtualMcpSkills`, `linkSkill` com posição, `layout` que ignora lixo, os CHECKs de `014`) |

As cinco recriam o mesmo banco e o Vitest roda arquivos em paralelo: elas se
serializam por um advisory lock (`pg_advisory_lock`) segurado durante todo o
arquivo. Suíte de integração nova aqui dentro precisa usar o mesmo número.
