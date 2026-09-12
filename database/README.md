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
| `skills` | catálogo: `slug`, `name`, `description`, contadores e `search_vector`. Sem coluna de visibilidade: a skill é exibida onde está vinculada |
| `files` | árvore de arquivos da skill; texto **ou** binário, nunca os dois (CHECK) |
| `tags` / `skill_tags` | tags e o vínculo N:N com as skills |
| `audit_log` | trilha de auditoria de create/update/delete **e dos eventos de conta**, com o conteúdo anterior, o ator e o alvo |
| `users` | contas: papel (`admin`/`editor`/`leitor`), senha, vínculo OIDC, `token_version` e o bloqueio do login |
| `api_keys` | chaves `psk_` por usuário; guarda o prefixo e o hash, nunca o segredo |
| `reset_tokens` | tokens de redefinição de senha, com expiração e uso único |
| `virtual_mcps` | servidores MCP virtuais: `slug`, dono (`owner_user_uuid`), `is_active`, `is_open` |
| `virtual_mcp_skills` | vínculo skill ↔ MCP virtual, com as flags `as_skill`/`as_prompt`/`as_resource` e contadores **próprios** |
| `virtual_mcp_keys` | chaves `psv_` por servidor; mesmo formato de `api_keys` |
| `settings` | configuração da instalação, chave-valor; `default_virtual_mcp` guarda o uuid do vMCP que responde em `/mcp`, sem FK |
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
| Escrita | `createSkill`, `updateSkill`, `updateSkillWithContent`, `deleteSkill`, `setFile`, `setFiles`, `deleteFile` |
| Vínculo pelo lado da skill | `linkSkill`, `unlinkSkill` (e `mcps` em `createSkill`) |
| Contadores | `incrementViewCount`, `incrementDownloadCount` |
| Contas | `countUsers`, `listUsers`, `getUserByUuid`, `getUserByEmail`, `getUserByOidc`, `createUser`, `updateUser`, `registerFailedLogin`, `registerSuccessfulLogin` |
| Chaves de API | `listApiKeys`, `createApiKey`, `revokeApiKey`, `getApiKeyByPrefix`, `touchApiKey` |
| Senha | `createResetToken`, `consumeResetToken` |
| Auditoria de conta | `recordAccountAudit` |
| MCP virtual | `listVirtualMcps`, `listOpenVirtualMcps`, `getVirtualMcp`, `getVirtualMcpByUuid`, `resolveVirtualMcp`, `createVirtualMcp`, `updateVirtualMcp`, `deleteVirtualMcp`, `setVirtualMcpSkills`, `listVirtualMcpKeys`, `createVirtualMcpKey`, `revokeVirtualMcpKey`, `getVirtualMcpKeyByPrefix`, `touchVirtualMcpKey` |
| MCP padrão | `DEFAULT_MCP_SETTING`, `resolveDefaultVirtualMcp`, `setDefaultVirtualMcp` |
| Erros | `AppError`, `notFound`, `badRequest`, `conflict`, `unauthorized`, `isUniqueViolation`, `isForeignKeyViolation` |
| Schema/tipos | `skills`, `files`, `tags`, `skillTags`, `auditLog`, `users`, `apiKeys`, `resetTokens`, `virtualMcps`, `virtualMcpSkills`, `virtualMcpKeys`, `settings`, `SkillRow`, `FileRow`, `TagRow`, `AuditRow`, `UserRow`, `ApiKeyRow`, `ResetTokenRow`, `VirtualMcpRow`, `VirtualMcpSkillRow`, `VirtualMcpKeyRow`, `SettingRow` |
| Tipos de query | `UserRecord`, `CreateUserInput`, `UpdateUserInput`, `ApiKeyRecord`, `Stats`, `ListOptions`, `SkillVisibility`, `SortOrder`, `PublicationSurface`, `PublishedSkill`, `FileInput`, `FileContent`, `SetFilesOptions`, `SkillLinkFlags`, `VirtualScope`, `VirtualMcpRuntime`, `VirtualMcpKeyRecord`, `DefaultMcpResolution`, `CreateVirtualMcpInput`, `UpdateVirtualMcpInput` |
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
- `linkSkill(slug, virtualMcpUuid, flags, source, actor)` cria ou reescreve
  um vínculo (contadores de um vínculo existente ficam) e devolve o
  `SkillDetail` com `mcps`;
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
- `getVirtualMcp(slug)` / `getVirtualMcpByUuid(uuid)` devolvem
  `VirtualMcpDetail` (resumo + skills vinculadas, com as flags e os contadores
  **do vínculo**) e incluem inativos: é o painel que lê. `resolveVirtualMcp`
  é o oposto — só ativos, uma linha, sem agregação — e é o que o servidor
  consulta a cada requisição.
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
    database/src/virtual-mcps.integration.test.ts database/src/settings.integration.test.ts
```

| Suíte | Cobre |
|-------|-------|
| `files.integration.test.ts` | unicidade de caminho sem diferenciar caixa |
| `users.integration.test.ts` | contas, bloqueio de login, chaves de API, tokens de reset e o ator na auditoria |
| `virtual-mcps.integration.test.ts` | MCP virtual: recorte declarativo, leituras por vínculo, contadores duplos, chaves `psv_` e o runtime que ignora inativos |
| `settings.integration.test.ts` | MCP padrão: escolha e limpeza com auditoria, as três causas de recusa da raiz, o CHECK com `mcp.default` e o caminho de atualização de uma base parada no `010` (backfill do `011` e `DROP` do `012`, idempotentes) |
| `virtual-mcps.integration.test.ts` também cobre | a visibilidade `'open'` do site (só vMCP aberto e ligado), `mcps` na skill e `listPublishedSkills` por vMCP |

As quatro recriam o mesmo banco e o Vitest roda arquivos em paralelo: elas se
serializam por um advisory lock (`pg_advisory_lock`) segurado durante todo o
arquivo. Suíte de integração nova aqui dentro precisa usar o mesmo número.
