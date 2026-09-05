<div align="center">

# 🟣 Purple Skills

**Catálogo aberto de skills para agentes de IA — site público, painel administrativo e dois servidores MCP.**

Software livre (MIT), em containers, pensado para ser simples, bonito e pontual.

</div>

---

## O que é

Purple Skills hospeda **skills** — pacotes de instruções reutilizáveis para
agentes de IA, no formato `SKILL.md` + arquivos auxiliares. Ele entrega quatro
superfícies sobre o mesmo catálogo:

| Serviço | O que faz | Porta padrão |
|---------|-----------|--------------|
| **site** | Site público: busca, leitura do SKILL.md renderizado e download | `3000` |
| **admin** | Painel de administração protegido por senha | `3001` |
| **mcp-public** | Servidor MCP para agentes descobrirem e baixarem skills | `3002` |
| **mcp-admin** | Servidor MCP para administrar o catálogo (CRUD completo) | `3003` |

O banco é **PostgreSQL 18** (imagem `pgvector/pgvector:pg18-trixie`). A busca do
v1 usa **full-text search nativo** (`tsvector` + GIN); o `pgvector` já está
disponível para busca vetorial numa versão futura.

## Começando em 60 segundos

```bash
cp .env.example .env      # ajuste ADMIN_PASSWORD e MCP_ADMIN_TOKEN
docker compose run --rm migrate   # aplica database/schema/*.sql
docker compose up -d
docker compose run --rm seed      # opcional: skills de exemplo
```

Os serviços `postgres`, `migrate` e `seed` vêm de
[`database/docker-compose.yml`](database/docker-compose.yml), incluído pelo
compose da raiz — rode sempre a partir da raiz do repositório.

- Site: <http://localhost:3000>
- Painel: <http://localhost:3001> (senha = `ADMIN_PASSWORD`)
- MCP público: <http://localhost:3002>
- MCP admin: <http://localhost:3003>

### Atrás do Traefik

Preencha os `*_FQDN` no `.env` e suba com o override:

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d
```

O override assume um Traefik já rodando na rede externa `traefik`, com o
entrypoint `websecure` e o certresolver `le`.

## Desenvolvimento local

Requer Node.js 22+ (LTS) e um Postgres 18 acessível.

```bash
npm install
npm run build -w @purple-skills/shared
npm run build -w @purple-skills/db
npm run migrate            # aplica database/schema/*.sql em DATABASE_URL
npm run seed               # opcional

npm run dev:site           # http://localhost:5173 (Vite) + API em :3000
npm run dev:admin          # http://localhost:5174 (Vite) + API em :3001
npm run dev:mcp-public     # http://localhost:3002
npm run dev:mcp-admin      # http://localhost:3003

npm test                   # testes unitários (Vitest)
npm run typecheck          # TypeScript em todos os workspaces
```

Os testes das queries de `database/` exigem um Postgres real e ficam
desligados por padrão. Para rodá-los, aponte `TEST_DATABASE_URL` para um banco
**descartável** — o schema é recriado do zero a cada execução:

```bash
TEST_DATABASE_URL=postgres://postgres:CHANGE_ME@127.0.0.1:5432/purple_skills_test \
  npx vitest run database/src/files.integration.test.ts
```

## Estrutura do repositório

Monorepo com **npm workspaces**:

```
database/        camada de dados — domínio do agente dba
  schema/        nnn-nome.sql: tabelas, tipos, índices, funções e triggers
  src/           cliente, queries e tipagem Drizzle (@purple-skills/db)
  Dockerfile     imagem que aplica o schema e carrega os exemplos
  docker-compose.yml   containers postgres, migrate e seed
apps/
  site/          site público      — Express + React/Vite + Tailwind
  admin/         painel admin      — Express + React/Vite + Tailwind
  mcp-public/    MCP público       — @modelcontextprotocol/sdk
  mcp-admin/     MCP administrativo
packages/
  shared/        slug, ranking, mime, zip, secrets, sessão
```

Cada app gera sua **própria imagem Docker** e fala **direto com o Postgres** —
não há um serviço de API intermediário.

### O banco fica em `database/`

Tudo o que é banco de dados — os containers `postgres`, `migrate` e `seed`, os
arquivos de schema e a biblioteca de acesso — está confinado em `database/` e é
responsabilidade do **agente dba**. Os apps só consomem `@purple-skills/db`;
nenhum deles escreve SQL ou abre conexão por conta própria.

O contrato completo (arquivos de schema, tabelas, variáveis de conexão, API
disponível e o que cada agente pode ou não fazer) está em
[`database/README.md`](database/README.md); a divisão de responsabilidades entre
os agentes, em [`AGENTS.md`](AGENTS.md).

## Identidade visual

O mascote é **o Mago Roxo**, e o roxo é a cor de tudo. Site e painel
compartilham o mesmo sistema de design — tokens de cor em CSS, tema claro e
escuro, tipografia Aeonik + JetBrains Mono e os diagramas em SVG da home.

Onde mexer em cada peça está em
[`docs/04-design-system.md`](docs/04-design-system.md). Resumo do que importa:
`tokens.css`, `base.css` e `markdown.css` são **idênticos** nos dois apps e
precisam ser copiados juntos ao mudar um deles.

## Conectando um agente ao MCP

Os dois servidores MCP expõem **os três transportes** do SDK TypeScript:

| Rota | Transporte |
|------|------------|
| `POST/GET/DELETE /mcp` | Streamable HTTP **com sessão** (header `mcp-session-id`) |
| `POST /mcp/stateless` | Streamable HTTP **stateless** (um servidor por requisição) |
| `GET /sse` + `POST /messages` | SSE legado |

Exemplo de configuração em um cliente MCP:

```json
{
  "mcpServers": {
    "purple-skills": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

### Ferramentas do MCP público

| Ferramenta | Descrição |
|-----------|-----------|
| `search_skills(query?, tag?, limit?, offset?)` | Busca full-text nas skills públicas |
| `get_skill(slug)` | SKILL.md completo + metadados. **Conta um acesso** |
| `get_skill_file(slug, path)` | Lê um arquivo auxiliar da skill |
| `download_skill(slug)` | Devolve a URL do pacote `.zip` |
| `list_tags()` | Tags disponíveis, com contagem |

Autenticação é **opcional**: sem `MCP_PUBLIC_KEY` o servidor é aberto; com ela,
exige `Authorization: Bearer <MCP_PUBLIC_KEY>`.

### Ferramentas do MCP administrativo

Exige sempre `Authorization: Bearer <MCP_ADMIN_TOKEN>`.

| Ferramenta | Descrição |
|-----------|-----------|
| `list_skills(includePrivate?, query?, tag?, limit?, offset?)` | Lista tudo, inclusive privadas |
| `get_skill(slug)` / `get_file(slug, path)` | Leitura |
| `create_skill(name, description?, skill_md_content, tags?, slug?, is_public?)` | Cria a skill e o SKILL.md na mesma transação |
| `edit_skill(slug, {name?, description?, tags?, new_slug?})` | Edita metadados |
| `set_visibility(slug, "public" \| "private")` | Publica/despublica |
| `set_file(slug, path, content)` | Cria ou sobrescreve um arquivo |
| `set_files_bulk(slug, zip_base64, replace?)` | Importa uma árvore inteira de um `.zip` — por padrão o zip é o **estado completo** (omitidos são removidos, `SKILL.md` preservado) |
| `delete_file(slug, path)` | Remove um arquivo (**bloqueado** para `SKILL.md`) |
| `delete_skill(slug, confirm)` | Remove a skill (exige `confirm: true`) |
| `list_tags()` / `get_stats()` | Navegação e métricas |

## API REST pública

A API do site é aberta (CORS `*`) e serve como alternativa ao MCP:

```
GET  /api/skills?q=&tag=&sort=&limit=&offset=   lista/busca (só públicas)
GET  /api/skills/:slug                          detalhe + SKILL.md  (conta acesso)
GET  /api/skills/:slug/files/<caminho>          arquivo avulso
GET  /api/tags                                  tags com contagem
GET  /skills/:slug/download                     pacote .zip        (conta download)
GET  /healthz                                   saúde do serviço
```

## Contadores e ranking

Cada skill tem `view_count` e `download_count`. O ranking do site é a **soma
simples** dos dois (`ORDER BY view_count + download_count DESC`), calculada em
tempo de query.

O incremento é atômico e acontece em **qualquer superfície de acesso** — página
do site, API REST e `get_skill` do MCP. Acesso direto a arquivos auxiliares
**não** conta; apenas o `SKILL.md` e o download do pacote.

## Configuração

Todas as variáveis estão documentadas em [`.env.example`](.env.example). Todo
segredo aceita `<NOME>` ou `<NOME>_FILE`:

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `DATABASE_URL` | sim* | Conexão com o Postgres (senha percent-encodada). *Alternativa sem escape: `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` — é o que o compose usa |
| `ADMIN_PASSWORD` / `_FILE` | sim (admin) | Senha do painel |
| `ADMIN_SESSION_SECRET` / `_FILE` | recomendada | Chave do cookie de sessão (derivada da senha com scrypt se ausente) |
| `MCP_ADMIN_TOKEN` / `_FILE` | sim (mcp-admin) | Bearer token administrativo |
| `MCP_PUBLIC_KEY` / `_FILE` | não | Se definida, protege o MCP público |
| `SITE_BASE_URL` | recomendada | Base das URLs de download geradas pelo MCP |

Só o [`.env.example`](.env.example) é versionado, e com `CHANGE_ME` no lugar de
cada segredo — o CI reprova qualquer outro `.env*` que entre no índice. Os
arquivos preenchidos (`.env`, `.env-builder`, `run-builder.sh`,
`docker-compose-builder.yml`) são do ambiente de testes do mantenedor, ficam
fora do Git e da imagem, e não fazem parte do projeto publicado. **Gere seus
próprios segredos**: nenhum valor deste repositório — inclusive os que o commit
inicial publicou antes de virarem placeholders — deve ser reaproveitado. Ver
[`docs/02-architecture-decisions.md` §7.5](docs/02-architecture-decisions.md).

## Limitações assumidas no v1

Documentadas em [`docs/02-architecture-decisions.md`](docs/02-architecture-decisions.md):

- Contadores sem deduplicação — infláveis por refresh-spam.
- Sem limite por skill (soma dos arquivos). Existem tetos por requisição:
  upload de 64 MB (`ADMIN_MAX_UPLOAD_BYTES`), zip de 256 MB descomprimidos e
  512 entradas (`ZIP_MAX_UNCOMPRESSED_BYTES`, `ZIP_MAX_ENTRIES`) e 32 MB de
  base64 no `set_files_bulk` (`MCP_MAX_ZIP_BASE64`).
- Login do painel sem rate limiting.
- Sem versionamento de arquivos (apenas um log de auditoria, sem restore).
- Busca vetorial deixada para uma versão futura.

## Licença

[MIT](LICENSE).
