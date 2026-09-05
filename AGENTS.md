# Instruções para agentes

Vale para qualquer agente que trabalhe neste repositório (Claude Code, Codex,
Cursor, Gemini CLI, …). O arquivo `CLAUDE.md` aponta para cá.

## Divisão de responsabilidades

| Área | Pasta | Dono |
|------|-------|------|
| Banco de dados | `database/` | **agente dba** |
| Site público | `apps/site/` | agente do site |
| Painel administrativo | `apps/admin/` | agente do admin |
| MCP público | `apps/mcp-public/` | agente do mcp-public |
| MCP administrativo | `apps/mcp-admin/` | agente do mcp-admin |
| Utilitários comuns | `packages/shared/` | quem precisar, com cuidado — é usado pelos cinco |

## Regra do banco de dados

**O banco é do agente dba e vive inteiro em `database/`.** Antes de qualquer
tarefa que leia ou grave dados, leia a especificação:
[`database/README.md`](database/README.md).

O que todo agente **fora** de `database/` deve seguir:

- Acesse o banco **só** pelo pacote `@purple-skills/db`
  (`import { getDb, listSkills, … } from '@purple-skills/db'`). As funções
  disponíveis estão listadas na especificação.
- **Não** escreva SQL, DDL ou migration fora de `database/schema/`.
- **Não** crie `pg.Pool`/`pg.Client` próprio nem leia `DATABASE_URL`/`PG*`
  diretamente — use `getDb()`.
- **Não** declare serviços `postgres`, `migrate` ou `seed` em nenhum compose:
  eles são definidos em `database/docker-compose.yml` e incluídos pela raiz.
- **Não** rode `drizzle-kit generate`/`push`. `database/src/schema.ts` é
  tipagem; a fonte de verdade são os arquivos `database/schema/nnn-nome.sql`.
- Precisa de uma coluna, índice ou query que não existe? É trabalho do dba —
  peça, não improvise no seu app.

O agente dba, por sua vez, fica **confinado a `database/`**: ele não edita
`apps/` nem `packages/`. Quando uma mudança de schema quebra um app, ele
descreve o impacto e a correção fica com o agente daquele app.

## Convenções gerais

- Monorepo com npm workspaces; Node.js 22+ e TypeScript estrito.
- Comentários, mensagens de erro, log e documentação em **português**.
- `npm run typecheck` e `npm test` precisam passar antes de entregar.
- Nenhum `.env*` versionado além de `.env.example`, sempre com `CHANGE_ME` no
  lugar de cada segredo.
- Decisões de arquitetura em [`docs/02-architecture-decisions.md`](docs/02-architecture-decisions.md);
  desvios e detalhes de implementação em [`docs/03-implementation-notes.md`](docs/03-implementation-notes.md);
  design em [`docs/04-design-system.md`](docs/04-design-system.md).
