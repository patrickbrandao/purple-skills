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
| `skills` | catálogo: `slug`, `name`, `description`, `is_public`, contadores e `search_vector` |
| `files` | árvore de arquivos da skill; texto **ou** binário, nunca os dois (CHECK) |
| `tags` / `skill_tags` | tags e o vínculo N:N com as skills |
| `audit_log` | trilha de auditoria de create/update/delete **e dos eventos de conta**, com o conteúdo anterior, o ator e o alvo |
| `users` | contas: papel (`admin`/`editor`/`leitor`), senha, vínculo OIDC, `token_version` e o bloqueio do login |
| `api_keys` | chaves `psk_` por usuário; guarda o prefixo e o hash, nunca o segredo |
| `reset_tokens` | tokens de redefinição de senha, com expiração e uso único |
| `schema_migrations` | controle do runner (criado por ele, não por um `.sql`) |

Chaves primárias são `uuidv7()` do PostgreSQL 18. A busca usa `tsvector` com
configuração `simple`, mantido por trigger — ver `001` e `002`.

O desenho de contas, papéis e credenciais está em
[`docs/05-accounts-and-roles.md`](../docs/05-accounts-and-roles.md); `004` a
`006` são a parte dele que vive aqui. Dois pontos que o modelo assume:

- **não há ownership.** `skills.created_by_user_uuid` é informativo; o papel
  limita a ação, nunca o escopo;
- **o ator pode não ser uma conta.** `audit_log.actor_user_uuid` é nulo para o
  `MCP_ADMIN_TOKEN` e para o bootstrap; quem sempre existe é `actor_label`.

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
| Leitura | `listSkills`, `getSkillSummary`, `getSkillDetail`, `listFiles`, `readFile`, `readTextFile`, `readAllFiles`, `listTags`, `listAudit`, `stats` |
| Escrita | `createSkill`, `updateSkill`, `updateSkillWithContent`, `setVisibility`, `deleteSkill`, `setFile`, `setFiles`, `deleteFile` |
| Contadores | `incrementViewCount`, `incrementDownloadCount` |
| Contas | `countUsers`, `listUsers`, `getUserByUuid`, `getUserByEmail`, `getUserByOidc`, `createUser`, `updateUser`, `registerFailedLogin`, `registerSuccessfulLogin` |
| Chaves de API | `listApiKeys`, `createApiKey`, `revokeApiKey`, `getApiKeyByPrefix`, `touchApiKey` |
| Senha | `createResetToken`, `consumeResetToken` |
| Auditoria de conta | `recordAccountAudit` |
| Erros | `AppError`, `notFound`, `badRequest`, `conflict`, `unauthorized`, `isUniqueViolation`, `isForeignKeyViolation` |
| Schema/tipos | `skills`, `files`, `tags`, `skillTags`, `auditLog`, `users`, `apiKeys`, `resetTokens`, `SkillRow`, `FileRow`, `TagRow`, `AuditRow`, `UserRow`, `ApiKeyRow`, `ResetTokenRow` |
| Tipos de query | `UserRecord`, `CreateUserInput`, `UpdateUserInput`, `ApiKeyRecord`, `Stats`, `ListOptions`, `SortOrder`, `FileInput`, `FileContent`, `SetFilesOptions` |
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
  `user.deactivate`, `key.create`, `key.revoke`) — linhas sem skill, com
  `targetLabel` dizendo sobre quem foi.

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
  npx vitest run database/src/files.integration.test.ts database/src/users.integration.test.ts
```

| Suíte | Cobre |
|-------|-------|
| `files.integration.test.ts` | unicidade de caminho sem diferenciar caixa |
| `users.integration.test.ts` | contas, bloqueio de login, chaves de API, tokens de reset e o ator na auditoria |

As duas recriam o mesmo banco e o Vitest roda arquivos em paralelo: elas se
serializam por um advisory lock (`pg_advisory_lock`) segurado durante todo o
arquivo. Suíte de integração nova aqui dentro precisa usar o mesmo número.
