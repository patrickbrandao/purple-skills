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
| `view_count`     | bigint, default 0       | incrementado a cada acesso ao SKILL.md   |
| `download_count` | bigint, default 0       | incrementado a cada download do pacote   |
| `search_vector`  | tsvector                | mantido por trigger (ver seção 5)        |
| `created_at` / `updated_at` | timestamptz  |                                          |

- **Ranking/"votação de acesso"**: `ORDER BY (view_count + download_count) DESC`
  — soma simples, sem pesos, calculada em tempo de query (sem coluna de
  score armazenada).
- **A skill é flutuante: não há coluna de visibilidade.** Ela só é exibida —
  no site e nos servidores MCP — onde está vinculada a um MCP virtual
  (`virtual_mcp_skills`), e o vínculo carrega as três portas (`as_skill`,
  `as_prompt`, `as_resource`). O site mostra o que está em ao menos um MCP
  virtual aberto e ligado. `is_public` e as `use_as_*` existiram entre `001` e
  `012`; o desenho está em
  [`09-mcp-padrao-e-skills-flutuantes.md`](09-mcp-padrao-e-skills-flutuantes.md).

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

## 3.5 Metadados fora do `SKILL.md`

Slug, nome, descrição e tags moram em **colunas de `skills`** e são a única
fonte da verdade. O que fica gravado na linha `SKILL.md` de `files` é só o
**corpo do prompt**, sem frontmatter.

- O frontmatter é **gerado na leitura**, sempre que o arquivo é materializado:
  download do `.zip`, leitura crua em `/files/SKILL.md`, `get_skill_file` do
  MCP público, `get_file` do MCP admin e o `resources/read` de `skill://<slug>`.
  O `prompts/get`, ao contrário, entrega **só o corpo**: nome e descrição já
  viajam nos metadados do `prompts/list`, e repeti-los no texto é ruído que o
  modelo lê como instrução.
- Formato Agent Skills: `name` é o **slug** (o nome oficial, `a-z0-9-`);
  `description` é a descrição; o nome de exibição e as tags — que a spec não
  define — vão em `metadata.title` e `metadata.tags`.
- Toda escrita de conteúdo (`POST/PATCH /api/skills`, `PUT .../files/SKILL.md`,
  upload de `.zip`, `create_skill`/`set_file`/`set_files_bulk` do MCP admin)
  **descarta** o frontmatter que venha no corpo.
- Motivo: com o frontmatter gravado, renomear a skill deixava o arquivo
  mentindo sobre ela, e o painel oferecia duas telas para o mesmo dado —
  campo e texto — que divergiam em silêncio. Gerar na leitura torna o
  desencontro impossível.
- Como tirar o frontmatter também vale na leitura, skills gravadas antes desta
  decisão são limpas sem migração de dados.

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
  acesso**: página do site, API REST pública do site, e MCP público —
  `get_skill`, `resources/read` de `skill://<slug>` e `prompts/get` incrementam
  `view_count`; seguir a URL de download do `download_skill` incrementa
  `download_count`. Ler a skill por resource ou invocá-la por prompt é acesso
  do mesmo jeito que chamar a ferramenta. Não há tentativa de distinguir "SPA"
  de "chamada de API/script" — tecnicamente indistinguíveis sem autenticação,
  então a distinção não é implementada.

## 7. Autenticação e autorização

### 7.1 Painel administrativo (web)

O painel usa **contas com papéis**. O desenho completo, com as doze decisões
que o produziram, está em [`05-accounts-and-roles.md`](05-accounts-and-roles.md);
o que segue é o resumo do que está no ar.

- **Contas locais** em `users`, com senha guardada como hash **scrypt**
  (`packages/shared/src/password.ts`, custo e salt embutidos no próprio hash).
- Três papéis **globais** — `admin`, `editor`, `membro`. Desde o `12`
  (§12.3) o papel decide só **criar** (editor+) e gerenciar a instalação
  (admin); o **escopo** é o acesso por objeto — dono, concessões e o flag
  público. Um `membro` administra o que é seu ou lhe foi concedido e não cria
  nada.
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
  `openid-client`. O papel nunca vem do provedor; conta nova nasce `membro` e
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
- As tools seguem o acesso por objeto do painel (§12.3): criar exige papel
  `editor`+, o resto é o nível da credencial em cada skill, catálogo ou vMCP;
  `delete_*` e `transfer_*` são do dono (ou admin).
- Uma sessão Streamable HTTP fica **presa à credencial que a abriu**: reusar um
  `mcp-session-id` com outra credencial responde 403, senão o papel gravado na
  sessão valeria para quem descobrisse o identificador.

### 7.3 MCP público

- **Não existe mais um servidor "principal" à parte**
  ([`09-mcp-padrao-e-skills-flutuantes.md`](09-mcp-padrao-e-skills-flutuantes.md)).
  O que responde em `/mcp` é o **MCP virtual escolhido como padrão** na
  tabela `settings` (chave `default_virtual_mcp`), pelo painel ou pelo
  mcp-admin, só por admin. Ele continua respondendo em `/virtual/<slug>/mcp`
  e não tem tratamento especial: pode ser fechado, desligado ou apagado, e
  nesses casos `/mcp` responde 404 dizendo a causa (nenhum padrão, removido,
  desligado).
- A autenticação de `/mcp` é a do próprio vMCP padrão: aberto quando
  `is_open`, senão chave `psv_` dele. `MCP_PUBLIC_AUTH`, `MCP_PUBLIC_KEY` e
  as chaves `psp_` de `public_mcp_keys` deixaram de existir no `011`; o
  mcp-public recusa subir enquanto as variáveis estiverem definidas.
- CORS totalmente aberto (`*`), pois o objetivo é ser consumido por
  qualquer agente externo.
- **MCPs virtuais** (`/virtual/<slug>/mcp`, [`08-mcp-virtual.md`](08-mcp-virtual.md)):
  o mesmo processo monta, sob esse prefixo, um servidor de leitura por MCP
  virtual, com um recorte próprio do catálogo (inclusive skills privadas) e
  autenticação própria — chave `psv_` da tabela `virtual_mcp_keys`, ou
  aberto quando `is_open`. A chave de um virtual não abre outro. Sessões
  ficam presas à identidade (MCP + chave) que as abriu, como no mcp-admin; a
  raiz reusa a identidade do vMCP padrão. Os downloads são servidos pelo
  próprio mcp-public, sob o prefixo por onde o servidor foi chamado (vazio na
  raiz) e com a mesma credencial.

### 7.4 Padrão de secrets (env vars)

Todos os segredos seguem o padrão `<NOME>` / `<NOME>_FILE` (a aplicação lê
o arquivo se `<NOME>_FILE` estiver definido; senão usa `<NOME>` direto):

- `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE` (bootstrap — §7.1)
- `ADMIN_SESSION_SECRET` / `ADMIN_SESSION_SECRET_FILE`
- `MCP_ADMIN_TOKEN` / `MCP_ADMIN_TOKEN_FILE`
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

- Todo ponto de montagem — `/mcp` (o vMCP padrão) e `/virtual/<slug>/mcp` —
  serve o mesmo servidor: as cinco ferramentas e as superfícies de prompt e
  resource, lendo pelo vínculo `virtual_mcp_skills` (flags `as_skill` /
  `as_prompt` / `as_resource`). Nome `<MCP_SERVER_NAME>-<slug>` e instruções
  com a descrição do vMCP.
- `search_skills(query, tag?, limit?, offset?)` → lista de
  `{ slug, name, description, tags, score }` das skills vinculadas com
  `as_skill`.
- `get_skill(slug)` → conteúdo completo do SKILL.md + lista de arquivos
  anexados. Incrementa `view_count` no vínculo e na skill.
- `download_skill(slug)` → retorna a **URL** de download servida pelo próprio
  mcp-public sob o prefixo do mount (`/skills/<slug>/download` na raiz,
  `/virtual/<slug>/skills/<skill>/download` nos demais), atrás da mesma
  credencial. Não gera o zip na chamada; a requisição HTTP real incrementa
  `download_count`. A `url` da página do site só sai quando a skill é pública.
- Suporte a todas as versões do protocolo MCP TypeScript SDK: SSE,
  Streamable HTTP e modo stateless.

### 8.2 MCP administrativo (`apps/mcp-admin`)

CRUD completo, espelhando o painel administrativo:

- `create_skill(name, description, skill_md_content, tags?, slug?,
  mcps?: [{slug, asSkill, asPrompt, asResource}])` — nasce publicada onde a
  credencial administra, ou sem vínculo
- `edit_skill(slug, { name?, description?, tags?, new_slug?, is_active? })`
  — `is_active: false` desliga a skill em tudo ([`11`](11-catalogos.md))
- `link_skill(skill, mcp, asSkill, asPrompt, asResource)` /
  `unlink_skill(skill, mcp)` — o vínculo pelo lado da skill; a permissão é a
  do MCP virtual alvo
- `set_file(slug, path, content)`
- `set_files_bulk(slug, zip_base64)`
- `delete_file(slug, path)` (bloqueado para `path = "SKILL.md"`)
- `delete_skill(slug)`
- `list_skills()` — o catálogo inteiro, inclusive skills sem vínculo, cada
  uma com `mcps`
- MCPs virtuais ([`08`](08-mcp-virtual.md) §6.2): `list_virtual_mcps()`,
  `get_virtual_mcp(slug)`, `create_virtual_mcp(name, slug?, description?,
  is_open?)`, `update_virtual_mcp(slug, {name?, new_slug?, description?,
  is_open?, is_active?})`, `delete_virtual_mcp(slug, confirm)`,
  `set_virtual_mcp_skills(slug, [{slug, asSkill, asPrompt, asResource}])`, `list_virtual_mcp_keys(slug)`,
  `create_virtual_mcp_key(slug, name)`, `revoke_virtual_mcp_key(slug, key_id)`.
  Alcance por dono: o token global e as chaves de admin administram qualquer
  um; a chave de um usuário, os MCPs de que ele é dono.
- MCP padrão ([`09`](09-mcp-padrao-e-skills-flutuantes.md) §3.6):
  `get_default_virtual_mcp()` e `set_default_virtual_mcp(slug | null)`, o
  segundo só admin.
- Catálogos ([`11`](11-catalogos.md) §6.3): `list_catalogs()`,
  `get_catalog(slug)`, `create_catalog(name, slug?, description?)`,
  `update_catalog(slug, {name?, new_slug?, description?, is_active?})`,
  `delete_catalog(slug, confirm)`, `set_catalog_skills(slug, [{slug,
  isActive?}])` e, no vMCP, `set_virtual_mcp_catalogs(slug, [{slug, asSkill,
  asPrompt, asResource}])` — este exige administrar o MCP **e** cada
  catálogo. Mesmo alcance por dono dos MCPs virtuais.

## 9. Download de pacotes

- Formato **ZIP**, gerado on-the-fly a partir das linhas da tabela
  `files` (streaming, ex: lib `archiver`), preservando `relative_path`.
- O `SKILL.md` do pacote é montado na hora: frontmatter vindo dos metadados
  da skill + corpo gravado (§3.5).
- O mesmo ZIP é servido também com a extensão **`.skill`** (rota
  `…/download.skill`), o formato aberto de Agent Skills — só muda o nome do
  arquivo baixado, o conteúdo é idêntico.
- O painel admin expõe as duas rotas em `/api/skills/:slug/download[.skill]`
  (atrás de `requireAuth`, servindo também skills privadas); esse download não
  incrementa `download_count`.

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
  - Workflow de PR: lint + testes + build das 7 imagens **sem push** (só
    valida que o Dockerfile de cada app e o de `database/` constroem).
  - **Sem workflow de release.** Nenhum job de CI tem credencial de registry.
    Publicar imagem é passo manual: depois de criar a tag da versão, quem
    mantém roda [`release-images.sh`](../release-images.sh) — builda e faz
    `docker push` das 7 imagens (os 6 apps mais `purple-skills-db`) para o
    Docker Hub, na conta `tmsoftbrasil` (`tmsoftbrasil/purple-skills-<nome>`),
    sempre como `latest`. Requer `docker login` prévio nessa conta.

## 12. Licença

- **MIT**.

## 12.1 Painel: console com canvas e sessões

Desenho em [`10-admin-canvas-e-sessoes.md`](10-admin-canvas-e-sessoes.md).

- O painel é um **console**: sidebar de 220px, barra superior com o sino, o
  palco num painel que ocupa a tela. Paleta própria (`tokens.css` do admin,
  escuro primeiro, espelhado no claro), que **diverge** do site e da homepage
  de propósito — ver `04`. Toda ação existe primeiro como comando da paleta
  ⌘K e só depois como botão.
- A home é **Servidores MCP** (cards com miniatura das skills, selos e
  clientes online). A "Visão geral" saiu; a auditoria virou página própria,
  com filtros, paginação e a lista de sessões MCP.
- O servidor MCP virtual é um **canvas** (React Flow): o vMCP com as três
  portas (Tools, Resources, Prompts) à direita, as skills ligadas a uma ou
  mais delas, o globo da Internet à esquerda com o contador de clientes
  online. Cada aresta é um vínculo gravado na hora; a última aresta que sai
  tira a skill do servidor. Posições no banco (`014`), compartilhadas.
- **Sessões do MCP público** em `mcp_sessions` (`015`): uma linha por
  cliente e transporte, com IP resolvido pelo `trust proxy`, `clientInfo`,
  atividade e fim real ou presumido. "Online" = atividade nos últimos
  `MCP_SESSION_ONLINE_WINDOW_MS` (2 min). Sem poda.
- **Ícone da skill** (`013`): emoji ou URL, com monograma como padrão.

## 12.2 Catálogos

Desenho em [`11-catalogos.md`](11-catalogos.md). Migration `016`.

- Um **catálogo** é um grupo de skills com dono (como o vMCP): quem cria
  (editor+) é o dono, admin manda em todos. Uma skill pode estar em vários.
- Vinculado a um vMCP (`virtual_mcp_catalogs`, muitos-para-muitos), entrega
  **todos os membros ativos** pelas portas do vínculo — uma escolha só para
  o grupo. Vincular exige administrar **os dois** lados; não há convite.
- **Precedência**: o vínculo direto da skill com o vMCP **sobrescreve** o
  catálogo; sem vínculo direto, as portas são a **união** dos catálogos que
  chegam ao vMCP. A regra mora no SQL (`visibilityClause`), como sempre.
- Três desativações reversíveis: `skills.is_active` (global — some de tudo,
  inclusive do site e do vínculo direto), `catalog_skills.is_active` (a
  participação, só naquele catálogo) e `catalogs.is_active` (o catálogo).
- Contador **por catálogo**, global: cada acesso a uma skill que chegou ao
  vMCP pelo catálogo soma nele e na skill; por vínculo direto, no vínculo.
- No canvas, o catálogo é um **nó só**, com as mesmas portas e gestos da
  skill e o número de skills ativas — excluindo as que já são nó próprio.
- Auditoria: `catalog.create` / `catalog.update` / `catalog.delete`; o
  vínculo com o vMCP é `mcp.update` no servidor.

## 12.3 Acesso granular

Desenho em [`12-acesso-granular.md`](12-acesso-granular.md). Migration `017`.

- **Skill, catálogo e vMCP têm dono** (`owner_user_uuid`; a skill herdou o
  de `created_by`). Dono e admin apagam e transferem; nenhum nível de
  concessão chega lá.
- **Concessões por objeto** em `skill_grants`, `catalog_grants` e
  `virtual_mcp_grants`, um nível cumulativo por conta: `view` < `edit` <
  `manage`. `manage` concede e revoga; a lista de concessões só é visível a
  quem tem `manage`.
- **Escopo por conta**: quem não é admin vê o que é seu, o que lhe foi
  concedido e o que é público (`skills.is_public`, `catalogs.is_public`) ou
  aberto (`virtual_mcps.is_open`). A cláusula mora no SQL (`viewer` nas
  leituras), pelo motivo de sempre. Admin, o token global e o bootstrap veem
  tudo.
- **Contêiner expõe**: ver um vMCP ou um catálogo lê todas as skills dentro,
  para pessoa e máquina; um catálogo público ou um vMCP aberto expõe os
  membros no site, mesmo privados. Vincular exige `view` na skill e `edit`
  no contêiner; catálogo↔vMCP, `edit` no vMCP e `view` no catálogo.
- **`leitor` virou `membro`**: a única diferença para `editor` é criar.
- **Site**: lista também skills públicas sem vMCP aberto e os catálogos
  públicos, com página própria (`/catalogos/<slug>`).
- Auditoria: `skill.share` / `skill.unshare`, `catalog.share` /
  `catalog.unshare`, `mcp.share` / `mcp.unshare`; transferência e flag
  público são `update` do objeto.

## 12.4 Fichas, colmeia e registro de acessos

Desenho em [`13-fichas-e-acessos.md`](13-fichas-e-acessos.md). Migration `018`.

- **Lista → visualizar → editar.** A ficha de uma skill ou de um catálogo é
  só leitura; toda alteração — conteúdo, metadados, publicação, acesso,
  remover — mora em `/editar`, com a mesma organização de guias: Skill,
  Propriedades e Acessos na skill; Catálogo, Skills, Propriedades e Acessos
  no catálogo. Guias são rotas.
- **Registro por leitura** em `skill_accesses`: cada `get_skill`,
  resource, prompt, SKILL.md avulso e pacote do MCP público, o detalhe, o
  SKILL.md e o pacote do site, e o `get_skill` do mcp-admin por chave `psk_`
  viram uma linha com quem leu (chave `psv_`, conta, aberto ou anônimo), o
  servidor, os catálogos por onde a skill chegou, sessão, IP e cliente. Os
  contadores são somados na mesma escrita; nunca é podada; cópias de slug,
  nome, chave e e-mail sobrevivem à remoção do que nomeiam. A guia é de
  quem administra o objeto (`manage`).
- **A colmeia** do card do servidor: um hexágono liso por skill direta
  (`rgb(59, 145, 145)`) e por catálogo (`rgb(112, 59, 145)`), até 19, e um
  "+N" com o resto.
- **Usuários seguem o mesmo princípio**: lista que só navega, "Nova conta"
  num modal, ficha só leitura e edição com as guias Conta, Chaves, Acessos
  (as leituras pelas chaves `psk_` da conta) e Atividade (a auditoria
  filtrada pelo ator). Migration `019` (índice por conta).

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

**Riscos introduzidos pelo MCP virtual** ([`08`](08-mcp-virtual.md) §8): um
virtual aberto (`is_open`) com skill privada dentro é publicação de fato,
protegida só pela confirmação explícita; a diferença 404/401 sob `/virtual/`
permite enumerar os slugs dos MCPs; e o virtual é a primeira entidade com dono
— a exceção ao "papel limita a ação, não o escopo" da `§7.1`, restrita a ele.

**Riscos introduzidos pelo painel novo e pelas sessões**
([`10`](10-admin-canvas-e-sessoes.md) §8): cada gesto no canvas é uma
escrita imediata, sem desfazer; o stateless agrupa clientes por IP + agente
+ credencial, então dois clientes iguais atrás do mesmo NAT contam como um;
`mcp_sessions` cresce para sempre, por decisão; as posições do canvas são
compartilhadas, então um administrador reorganiza o canvas de todos.

**Riscos introduzidos pelo MCP padrão e pelas skills flutuantes**
([`09`](09-mcp-padrao-e-skills-flutuantes.md) §5): o vMCP `public` criado na
migração nasce aberto, e quem protegia o principal com `MCP_PUBLIC_KEY` é
avisado só pela trava de boot; trocar o padrão derruba as sessões abertas na
raiz até reconectar; todo MCP virtual aberto é público de fato e listado no
site, sem a confirmação que `08` exigia.

**Riscos introduzidos pelo registro de acessos**
([`13`](13-fichas-e-acessos.md) §7): `skill_accesses` cresce uma linha por
leitura, para sempre, por decisão; as cópias de nome, chave e e-mail
envelhecem (dizem o que aconteceu, não o que é); e quem só administra um
servidor entra na edição da skill com os campos travados, para publicá-la.
