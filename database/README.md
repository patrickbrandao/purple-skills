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
| `audit_log` | trilha de auditoria de create/update/delete, com o conteúdo anterior |
| `schema_migrations` | controle do runner (criado por ele, não por um `.sql`) |

Chaves primárias são `uuidv7()` do PostgreSQL 18. A busca usa `tsvector` com
configuração `simple`, mantido por trigger — ver `001` e `002`.

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
| Erros | `AppError`, `notFound`, `badRequest`, `conflict`, `unauthorized`, `isUniqueViolation` |
| Schema/tipos | `skills`, `files`, `tags`, `skillTags`, `auditLog`, `SkillRow`, `FileRow`, `TagRow`, `AuditRow` |
| Migrations | `runMigrations`, `schemaDir` |

As funções de escrita já gravam em `audit_log` e recebem a origem
(`'web-admin'` ou `'mcp-admin'`) como último argumento.

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

As queries têm um teste de integração que exige um PostgreSQL real e fica
desligado por padrão. Aponte para um banco **descartável** — o schema é recriado
do zero a cada execução:

```bash
TEST_DATABASE_URL=postgres://postgres:CHANGE_ME@127.0.0.1:5432/purple_skills_test \
  npx vitest run database/src/files.integration.test.ts
```
