# Decisões de Arquitetura

Este documento registra as decisões de design resolvidas a partir da ideia
original (`01-idea.md`), organizadas por tópico. Serve como referência para
a implementação.

## 1. Estrutura do repositório

- **Monorepo** usando **npm workspaces**.
- Layout de pastas:
  - `apps/site` — site público (Express + React/Vite + Tailwind)
  - `apps/admin` — painel administrativo (Express + React/Vite + Tailwind)
  - `apps/mcp-public` — servidor MCP público
  - `apps/mcp-admin` — servidor MCP administrativo
  - `packages/db` — schema Drizzle, queries, migrations (Postgres)
  - `packages/shared` — tipos e utilitários compartilhados (ex: geração de
    slug, cálculo de rating, geração de zip)
- Cada `app` exporta sua própria imagem Docker (4 imagens no total), todas
  conectando diretamente ao Postgres via `packages/db` — **sem** um serviço
  de API interno intermediário.

## 2. Frontend (site + admin)

- **SPA em React**, build com **Vite**, estilizado com **Tailwind CSS**.
- Express em cada app serve os assets estáticos da SPA e expõe uma API
  **REST JSON** própria (`/api/...`) consumida pelo frontend.
- A API REST do **site** é pública (CORS aberto), podendo ser usada por
  terceiros como alternativa ao MCP público — ver seção 6 sobre
  contabilização de acessos.
- A API REST do **admin** continua interna (mesma origem), protegida por
  sessão de login.

## 3. Banco de dados

- **Postgres 18** (`pgvector/pgvector:pg18-trixie`), usado apenas por seus
  recursos relacionais/full-text no v1 (busca vetorial fica para o futuro).
- Acesso via **Drizzle ORM** (query builder + migrations em SQL).
- Migrations aplicadas por um **passo dedicado `migrate`** no
  docker-compose (`docker compose run migrate`), nunca pelos 4 serviços
  simultaneamente no boot.

### 3.1 Tabela `skills`

| coluna          | tipo                    | notas                                   |
|------------------|-------------------------|------------------------------------------|
| `uuid`           | UUID (default `uuidv7()` nativo do PG18) | PK |
| `slug`           | text, unique            | identificador legível usado em URLs/MCP |
| `name`           | text                    |                                          |
| `description`    | text                    |                                          |
| `is_public`      | boolean                 | público/privado                          |
| `view_count`     | bigint, default 0       | incrementado a cada acesso ao SKILL.md   |
| `download_count` | bigint, default 0       | incrementado a cada download do pacote   |
| `search_vector`  | tsvector                | mantido por trigger (ver seção 5)        |
| `created_at` / `updated_at` | timestamptz  |                                          |

- **Ranking/"votação de acesso"**: `ORDER BY (view_count + download_count) DESC`
  — soma simples, sem pesos, calculada em tempo de query (sem coluna de
  score armazenada).

### 3.2 Tabela `files`

| coluna           | tipo         | notas                                                   |
|-------------------|--------------|-----------------------------------------------------------|
| `id`              | UUID (uuidv7)| PK                                                          |
| `skill_uuid`      | UUID         | FK → `skills.uuid`                                         |
| `relative_path`   | text         | ex: `SKILL.md`, `examples/foo.md`                          |
| `text_content`    | text, nullable |                                                            |
| `binary_content`  | bytea, nullable |                                                          |
| `mime_type`       | text         | detectado por extensão no servidor                          |
| `size_bytes`      | bigint       |                                                              |
| `created_at` / `updated_at` | timestamptz | |

- `CHECK`: exatamente uma das colunas `text_content`/`binary_content` deve
  ser não-nula.
- **Sem histórico de versões** — edição de arquivo é um `UPDATE` in-place.
  Renomear caminho = delete + insert (sem rastreamento de rename).
- Toda skill deve ter no mínimo um arquivo com `relative_path = 'SKILL.md'`.
  Isso é garantido **na camada de aplicação**: criar uma skill (painel web
  ou MCP admin) exige o conteúdo do SKILL.md como campo obrigatório, e a
  criação da skill + do arquivo SKILL.md ocorre na mesma transação. As
  ferramentas de edição nunca expõem uma opção de deletar o arquivo
  `SKILL.md` (apenas sobrescrever seu conteúdo).
- Sem limite de tamanho de arquivo/skill no v1 (risco aceito e assumido).

### 3.3 Tabela `tags` / `skill_tags`

- Tags são **livres**, definidas pelo admin por skill (criadas na primeira
  vez que são usadas, sugeridas por autocomplete depois).
- Relação muitos-para-muitos (`skill_tags`).
- Tags servem **apenas para filtro/navegação** no site e como parâmetro de
  filtro no MCP público — não influenciam o ranking de busca/rating.

### 3.4 Tabela `audit_log`

- Log simples de auditoria (sem funcionalidade de restore):
  - `skill_uuid`, `file_path`, `action` (`create`/`update`/`delete`),
    `source` (`web-admin` / `mcp-admin`), `previous_content` (snapshot do
    conteúdo anterior, quando aplicável), `created_at`.

## 4. Upload/gestão de arquivos

- Painel admin: upload de **.zip** (extraído no servidor, preservando
  `relative_path`) **ou** formulário para adicionar/editar um arquivo por
  vez.
- MCP admin: `set_file(slug, path, content)` para um arquivo por vez, mais
  uma variante `set_files_bulk(slug, zip_base64)` para importar uma árvore
  inteira.
- Atualização parcial de conteúdo: o payload de "definir novo conteúdo"
  aceita uma lista de arquivos para *upsert* e trata **omissão de um
  caminho anterior como exclusão implícita** (o payload representa o
  estado desejado completo daquele conjunto de arquivos).

## 5. Busca

- **Full-text search** do Postgres (`tsvector`/`GIN`), sem busca vetorial
  no v1 (deixada para o futuro, usando `pgvector` que já está disponível na
  imagem do Postgres).
- `skills.search_vector` combina `name + description + texto do SKILL.md`.
- Mantido por **trigger** no Postgres, disparado em updates de `skills` e
  do arquivo `SKILL.md` correspondente.
- Apenas o conteúdo do `SKILL.md` entra na busca — demais arquivos
  anexados não são indexados no v1.

## 6. Contadores de acesso

- Dois contadores por skill: `view_count` (acesso à página/conteúdo do
  SKILL.md) e `download_count` (download do pacote).
- **Incremento simples e atômico, sem deduplicação** por IP/sessão (sem
  Redis/cache extra) — risco de inflação por refresh-spam aceito no v1.
- **A mesma lógica incrementa os contadores em qualquer superfície de
  acesso**: página do site, API REST pública do site, e MCP público
  (`get_skill` incrementa `view_count`; seguir a URL de download do
  `download_skill` incrementa `download_count`). Não há tentativa de
  distinguir "SPA" de "chamada de API/script" — tecnicamente
  indistinguíveis sem autenticação, então a distinção não é implementada.

## 7. Autenticação e autorização

### 7.1 Painel administrativo (web)

- Senha única definida via env var ou arquivo (padrão de secrets — seção
  7.4).
- Comparação **timing-safe** direta (sem hashing — é um segredo único
  fornecido pelo operador, não uma senha de usuário armazenada em banco).
- Sessão mantida via **cookie assinado, httpOnly, stateless** (sem session
  store no banco).
- **Sem rate limiting** no login no v1 (risco aceito).

### 7.2 MCP administrativo

- Autenticação obrigatória via header `Authorization: Bearer <token>`,
  token definido via env var/arquivo, comparação direta de string.

### 7.3 MCP público

- Autenticação **opcional**, controlada pela env var `MCP_PUBLIC_KEY`:
  - Se vazia/ausente → servidor totalmente aberto, sem autenticação.
  - Se definida → exige header `Authorization: Bearer <MCP_PUBLIC_KEY>`,
    comparação direta case-sensitive.
- CORS totalmente aberto (`*`), pois o objetivo é ser consumido por
  qualquer agente externo.

### 7.4 Padrão de secrets (env vars)

Todos os segredos seguem o padrão `<NOME>` / `<NOME>_FILE` (a aplicação lê
o arquivo se `<NOME>_FILE` estiver definido; senão usa `<NOME>` direto):

- `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE`
- `ADMIN_SESSION_SECRET` / `ADMIN_SESSION_SECRET_FILE`
- `MCP_ADMIN_TOKEN` / `MCP_ADMIN_TOKEN_FILE`
- `MCP_PUBLIC_KEY` / `MCP_PUBLIC_KEY_FILE`

## 8. Contrato das ferramentas MCP

### 8.1 MCP público (`apps/mcp-public`)

- `search_skills(query, tag?, limit?, offset?)` → lista de
  `{ slug, name, description, tags, score }` (apenas skills públicas).
- `get_skill(slug)` → conteúdo completo do SKILL.md + lista de arquivos
  anexados. Incrementa `view_count`.
- `download_skill(slug)` → retorna a **URL** de download do site
  (`{SITE_BASE_URL}/skills/{slug}/download}`), construída a partir de uma
  env var de base URL. Não gera o zip no próprio processo MCP; a
  requisição HTTP real (feita por quem seguir o link) incrementa
  `download_count` no site.
- Suporte a todas as versões do protocolo MCP TypeScript SDK: SSE,
  Streamable HTTP e modo stateless.

### 8.2 MCP administrativo (`apps/mcp-admin`)

CRUD completo, espelhando o painel administrativo:

- `create_skill(name, description, skill_md_content, tags?)`
- `edit_skill(slug, { name?, description?, tags? })`
- `set_visibility(slug, "public" | "private")`
- `set_file(slug, path, content)`
- `set_files_bulk(slug, zip_base64)`
- `delete_file(slug, path)` (bloqueado para `path = "SKILL.md"`)
- `delete_skill(slug)`
- `list_skills(includePrivate = true)`

## 9. Download de pacotes

- Formato **ZIP**, gerado on-the-fly a partir das linhas da tabela
  `files` (streaming, ex: lib `archiver`), preservando `relative_path`.

## 10. Infraestrutura / Docker

- Node.js: versão **LTS ativa no momento da implementação** (pin explícito
  no Dockerfile, ex: `node:22-alpine`, atualizado quando a LTS mudar).
- `docker-compose.yml` local orquestra as 4 imagens + Postgres + o passo
  `migrate`, em rede Docker interna.
- Cada imagem também pode rodar de forma independente/standalone em
  produção, apontando para um Postgres externo via env vars.

## 11. Testes e CI/CD

- **Testes**: unitários (Vitest) cobrindo `packages/db`/`packages/shared`
  (queries, cálculo de rating, geração de slug, geração de zip) e os
  handlers das ferramentas MCP. Sem testes de integração com banco real
  nem E2E no v1.
- **CI/CD** (GitHub Actions):
  - Workflow de PR: lint + testes.
  - Workflow de release: build e push das 4 imagens para o GitHub
    Container Registry (ghcr.io).

## 12. Licença

- **MIT**.

## 13. Riscos aceitos conscientemente (v1)

Para manter o software "simples, bonito e pontual" conforme pedido, as
seguintes limitações foram aceitas deliberadamente e podem ser
endereçadas em versões futuras:

- Contadores de view/download podem ser inflacionados trivialmente (sem
  dedup, sem rate limiting).
- Sem limite de tamanho de arquivo/skill — possível abuso de armazenamento
  no Postgres.
- Login do admin sem rate limiting contra brute-force.
- Sem histórico/versionamento de arquivos — edições sobrescrevem o estado
  atual (apenas um log de auditoria simples, sem restore).
