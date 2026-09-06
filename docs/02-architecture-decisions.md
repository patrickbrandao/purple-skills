# Decisões de Arquitetura

Este documento registra as decisões de design resolvidas a partir da ideia
original (`01-idea.md`), organizadas por tópico. Serve como referência para
a implementação.

## 1. Estrutura do repositório

- **Monorepo** usando **npm workspaces**.
- Layout de pastas:
  - `database` — **toda** a camada de dados: arquivos de schema
    (`database/schema/nnn-nome.sql`), cliente e queries (`@purple-skills/db`),
    e os containers `postgres`, `migrate` e `seed`
  - `apps/homepage` — página de apresentação do projeto, estática (Express
    servindo uma SPA React/Vite + Tailwind, **sem banco**)
  - `apps/site` — catálogo do usuário (Express + React/Vite + Tailwind)
  - `apps/admin` — painel administrativo (Express + React/Vite + Tailwind)
  - `apps/mcp-public` — servidor MCP público
  - `apps/mcp-admin` — servidor MCP administrativo
  - `packages/shared` — tipos e utilitários compartilhados (ex: geração de
    slug, cálculo de rating, geração de zip)
- Cada `app` exporta sua própria imagem Docker (5 imagens). Quatro delas
  conectam diretamente ao Postgres via `@purple-skills/db` — **sem** um serviço
  de API interno intermediário; a `homepage` não abre conexão nenhuma.
  `database` exporta uma sexta imagem, usada só pelos passos `migrate` e `seed`.
- **A homepage é separada do site de propósito.** A apresentação do projeto não
  depende de banco nem de instalação: pode ir para o ar sozinha, num CDN ou num
  domínio de vitrine, enquanto o `site` é a página de quem já tem um catálogo
  rodando e só quer consultá-lo e conectar seus agentes.
- `database` é uma **fronteira de responsabilidade**, não só uma pasta: é o
  domínio do agente dba, e nenhum app escreve SQL, migration ou container de
  banco. O contrato está em `database/README.md`; a divisão entre agentes, em
  `AGENTS.md`.

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
  docker-compose (`docker compose run migrate`), nunca pelos serviços
  simultaneamente no boot.
- Os arquivos de schema ficam em `database/schema/`, nomeados `nnn-nome.sql`
  (3 dígitos, zeros à esquerda), aplicados em ordem lexicográfica. São a fonte
  de verdade do banco: `database/src/schema.ts` é só tipagem.

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
- Sem limite **por skill** (soma dos arquivos) no v1, risco aceito. Há tetos
  por requisição — upload, corpo JSON e descompressão de zip — configuráveis
  por env var e documentados no `.env.example`.

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

O painel usa **contas com papéis**. O desenho completo, com as doze decisões
que o produziram, está em [`05-accounts-and-roles.md`](05-accounts-and-roles.md);
o que segue é o resumo do que está no ar.

- **Contas locais** em `users`, com senha guardada como hash **scrypt**
  (`packages/shared/src/password.ts`, custo e salt embutidos no próprio hash).
- Três papéis **globais** — `admin`, `editor`, `leitor`. O papel limita a
  ação, nunca o escopo: não há ownership por skill. Um `leitor` enxerga as
  skills privadas mas não escreve; um `editor` escreve em todas mas não apaga
  skill nem gerencia contas.
- Sessão em **cookie assinado, httpOnly, stateless**, agora com
  `{ sub, role, ver, exp }`. `ver` é uma cópia de `users.token_version`: o
  middleware relê a conta a cada requisição e recusa a sessão quando a versão
  mudou ou a conta foi desativada. Trocar senha, mudar papel ou desativar
  incrementa a versão — é a revogação individual, sem tabela de sessões.
- **`ADMIN_PASSWORD` virou senha de bootstrap.** Enquanto `users` está vazia
  ela ainda entra sozinha e habilita `POST /api/setup`, que cria o primeiro
  administrador. Depois da primeira conta, `/setup` responde 404 e o login sem
  e-mail é recusado.
- **Rate limiting no login em duas camadas**: janela em memória por IP
  (`LOGIN_IP_*`, absorve a rajada sem tocar o banco) e `users.locked_until`
  (`LOGIN_MAX_ATTEMPTS`/`LOGIN_LOCK_SECONDS`, sobrevive a restart e vale para
  vários containers).
- **OIDC opcional** (`OIDC_ISSUER`), authorization code + PKCE via
  `openid-client`. O papel nunca vem do provedor; conta nova nasce `leitor` e
  conta existente mantém o papel que tem. `OIDC_ALLOWED_DOMAINS` vazia
  **desliga** o auto-provisionamento, de propósito — ver §13.
- **SMTP opcional** (`SMTP_URL` + `SMTP_FROM`) para o link de redefinição de
  senha. Sem ele, o admin gera uma senha temporária no painel e a conta entra
  com `must_change_password`.

### 7.2 MCP administrativo

Duas credenciais valem, ambas por `Authorization: Bearer`:

| Credencial | Ator no `audit_log` | Papel |
|------------|---------------------|-------|
| `MCP_ADMIN_TOKEN` | `token-global` | `admin` |
| `psk_<prefixo>_<segredo>` | o usuário dono | o papel do dono |

- O token global **continua valendo**, comparado em tempo constante
  (`safeEqual`): torná-lo inerte ao criar o primeiro usuário derrubaria todo
  agente já configurado.
- A chave de usuário é encontrada pelo **prefixo** (8 caracteres, indexado) e
  conferida por hash scrypt do segredo. O texto completo aparece uma única vez,
  na emissão. Chave revogada ou de conta desativada não autentica.
- As ferramentas de escrita recusam papel `leitor`; `delete_skill` exige
  `admin`.
- Uma sessão Streamable HTTP fica **presa à credencial que a abriu**: reusar um
  `mcp-session-id` com outra credencial responde 403, senão o papel gravado na
  sessão valeria para quem descobrisse o identificador.

### 7.3 MCP público

- Autenticação **opcional**, controlada pela env var `MCP_PUBLIC_KEY`:
  - Se vazia/ausente → servidor totalmente aberto, sem autenticação.
  - Se definida → exige header `Authorization: Bearer <MCP_PUBLIC_KEY>`,
    comparação case-sensitive em tempo constante (`safeEqual`), com a chave
    lida uma única vez no boot.
- CORS totalmente aberto (`*`), pois o objetivo é ser consumido por
  qualquer agente externo.

### 7.4 Padrão de secrets (env vars)

Todos os segredos seguem o padrão `<NOME>` / `<NOME>_FILE` (a aplicação lê
o arquivo se `<NOME>_FILE` estiver definido; senão usa `<NOME>` direto):

- `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE` (bootstrap — §7.1)
- `ADMIN_SESSION_SECRET` / `ADMIN_SESSION_SECRET_FILE`
- `MCP_ADMIN_TOKEN` / `MCP_ADMIN_TOKEN_FILE`
- `MCP_PUBLIC_KEY` / `MCP_PUBLIC_KEY_FILE`
- `OIDC_CLIENT_SECRET` / `OIDC_CLIENT_SECRET_FILE`
- `SMTP_URL` / `SMTP_URL_FILE`

### 7.5 Segredos do repositório e do ambiente de testes

O projeto publicado versiona **apenas** o `.env.example`, com `CHANGE_ME` nos
lugares dos segredos. Nenhum valor real é versionado, e o CI reprova qualquer
`.env*` que apareça no índice (job `secrets-scan` + `.gitleaks.toml`).

Os arquivos com valores preenchidos — `.env`, `.env-builder`, `run-builder.sh`
e `docker-compose-builder.yml` — pertencem ao **ambiente de testes do
mantenedor**, não ao projeto. Estão no `.gitignore` e no `.dockerignore`, nunca
entraram no repositório nem na imagem, e não descrevem nenhuma implantação de
produção do Purple Skills.

O commit inicial `a01fdaf` publicou o `.env.example` com valores preenchidos em
vez de placeholders; o `7fd36ca` os trocou por `CHANGE_ME`. São credenciais
daquele mesmo ambiente de testes. Continuam no histórico — que é imutável — e
por isso ficam dispensadas no `.gitleaks.toml`, com escopo fechado no commit
**e** no arquivo, para que nenhum outro segredo do mesmo commit seja silenciado.

> **Quem implanta o Purple Skills gera os próprios segredos.** Nenhum valor
> deste repositório, atual ou histórico, serve como padrão: são exemplos de um
> ambiente de testes, e reaproveitá-los deixa a instalação com credenciais
> públicas.

### 7.6 O que a entrega de contas revogou

Contas e papéis mudaram três decisões que valiam antes desta seção:

| Antes | Agora |
|-------|-------|
| Senha única, comparada sem hashing | Senha por conta, hash scrypt em `users.password_hash` |
| Sessão stateless **autossuficiente** | Continua stateless, mas o middleware lê a conta a cada requisição para conferir `token_version` e `is_active` |
| Sem rate limiting no login | Janela por IP + `users.locked_until` |

A segunda troca é um custo assumido: o painel passa a tocar o banco em rotas
que antes não tocavam. É um `SELECT` por chave primária num app de baixo
volume, e em troca não há linha de sessão para expirar nem limpar.

O que **não** mudou: o `MCP_ADMIN_TOKEN` segue válido como credencial de
máquina, e uma instalação que nunca passe pelo `/setup` continua funcionando
com a senha única indefinidamente (§4.1 da spec).

Ficaram deliberadamente de fora: ownership por skill, fluxo de revisão, RBAC
com permissões compostas, tabela de sessões, auditoria de login e papel vindo
de grupo do IdP. Os motivos estão na §5 de
[`05-accounts-and-roles.md`](05-accounts-and-roles.md).

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

- **Testes**: unitários (Vitest) cobrindo `packages/shared` (rating, slug,
  caminhos, zip, frontmatter, segredos, sessão, leitura de env) e os handlers
  das ferramentas MCP, com `@purple-skills/db` mockado. As queries de
  `database/` têm um teste de integração que exige um Postgres real e fica
  desligado sem `TEST_DATABASE_URL`. Sem E2E no v1.
- **CI/CD** (GitHub Actions):
  - Workflow de PR: lint + testes.
  - Workflow de release: build e push das 5 imagens (os 4 apps mais
    `purple-skills-db`) para o GitHub Container Registry (ghcr.io).

## 12. Licença

- **MIT**.

## 13. Riscos aceitos conscientemente (v1)

Para manter o software "simples, bonito e pontual" conforme pedido, as
seguintes limitações foram aceitas deliberadamente e podem ser
endereçadas em versões futuras:

- Contadores de view/download podem ser inflacionados trivialmente (sem
  dedup, sem rate limiting).
- Sem limite por skill (soma dos arquivos) — possível abuso de armazenamento
  no Postgres, dentro dos tetos de cada requisição.
- Sem histórico/versionamento de arquivos — edições sobrescrevem o estado
  atual (apenas um log de auditoria simples, sem restore).
- `audit_log` cresce sem política de retenção. Os eventos de conta acrescentam
  pouco volume (login e falha de login **não** são auditados, §2.8 da spec),
  mas a decisão de quando podar continua em aberto.

**Endereçados pela entrega de contas e papéis** (§7.1): o login ganhou rate
limiting, e o `audit_log` passou a registrar o ator (`actor_user_uuid` /
`actor_label`) além da superfície, com revogação individual por
`token_version`.

**Risco residual introduzido por ela**, documentado na §2.4 da spec: a
vinculação de um login OIDC a uma conta local é sempre **pelo e-mail**. Um
provedor que permita a alguém declarar um endereço arbitrário dentro de um
domínio autorizado consegue assumir a conta correspondente, inclusive a de um
administrador. A mitigação é operacional — aponte `OIDC_ISSUER` para um
provedor que você controla e mantenha `OIDC_ALLOWED_DOMAINS` restrita a
domínios sob sua administração. Com a lista vazia, o auto-provisionamento fica
desligado e a instalação falha fechada.
