<div align="center">

# 🟣 Purple Skills

**Catálogo aberto de skills para agentes de IA — homepage, site do catálogo, painel administrativo e dois servidores MCP.**

Software livre (MIT), em containers, pensado para ser simples, bonito e pontual.

</div>

---

## O que é

Purple Skills hospeda **skills** — pacotes de instruções reutilizáveis para
agentes de IA, no formato `SKILL.md` + arquivos auxiliares. Ele entrega cinco
superfícies:

| Serviço | O que faz | Porta padrão |
|---------|-----------|--------------|
| **homepage** | Apresentação do projeto, estática — não fala com o banco | `3004` |
| **site** | Catálogo do usuário: busca, SKILL.md renderizado, download e o `mcp.json` | `3000` |
| **admin** | Painel de administração com contas e papéis | `3001` |
| **mcp-public** | Servidor MCP para agentes descobrirem e baixarem skills | `3002` |
| **mcp-admin** | Servidor MCP para administrar o catálogo (CRUD completo) | `3003` |

**homepage e site são páginas diferentes de propósito.** A homepage explica o
que é o Purple Skills e leva ao GitHub; ela não conhece instalação nenhuma e
pode ir para o ar sozinha. O site é a página de quem já tem um catálogo no ar:
lista as skills publicadas, ensina a configurar o `mcp.json` e mostra os
endereços de acesso.

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

- Homepage: <http://localhost:3004>
- Site: <http://localhost:3000>
- Painel: <http://localhost:3001> (na primeira vez, a `ADMIN_PASSWORD` cria o administrador)
- MCP público: <http://localhost:3002>
- MCP admin: <http://localhost:3003>

### Atrás do Traefik

Preencha os `*_FQDN` no `.env` e suba com o override:

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d
```

O override assume um Traefik já rodando na rede externa `traefik`, com o
entrypoint `websecure` e o certresolver `le`.

### Depurando os MCPs com o Inspector

O [MCP Inspector](https://github.com/modelcontextprotocol/inspector) oficial
é parte da stack e sobe junto no `up -d` do dia a dia, em
<http://localhost:6274>.

Abra <http://localhost:6274> e aponte para os servidores pelo **nome do
serviço**, não por `localhost`: quem conecta é o backend do inspector, de
dentro da rede `internal`.

| Servidor | URL | Autenticação |
|----------|-----|--------------|
| mcp-public | `http://mcp-public:3002/mcp` | `Authorization: Bearer $MCP_PUBLIC_KEY`, se definida |
| mcp-admin | `http://mcp-admin:3003/mcp` | `Authorization: Bearer $MCP_ADMIN_TOKEN` (obrigatório) |

O inspector sobe **sem autenticação própria** (`DANGEROUSLY_OMIT_AUTH`), o que
só é aceitável porque a porta fica em `127.0.0.1`. Com `BIND_ADDR=0.0.0.0` ele
vira um cliente MCP aberto na rede, com caminho até o `mcp-admin` — não deixe
ligado fora da máquina de desenvolvimento.

## Desenvolvimento local

Requer Node.js 22+ (LTS) e um Postgres 18 acessível.

```bash
npm install
npm run build -w @purple-skills/shared
npm run build -w @purple-skills/db
npm run migrate            # aplica database/schema/*.sql em DATABASE_URL
npm run seed               # opcional

npm run dev:homepage       # http://localhost:5175 (Vite) + estático em :3004
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
  homepage/      apresentação      — Express estático + React/Vite + Tailwind
  site/          catálogo          — Express + React/Vite + Tailwind
  admin/         painel admin      — Express + React/Vite + Tailwind
  mcp-public/    MCP público       — @modelcontextprotocol/sdk
  mcp-admin/     MCP administrativo
packages/
  shared/        slug, ranking, mime, zip, secrets, sessão
```

Cada app gera sua **própria imagem Docker**. Os quatro que leem o catálogo
falam **direto com o Postgres** — não há um serviço de API intermediário; a
`homepage` não abre conexão com o banco.

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

O mascote é **o Mago Roxo**, e o roxo é a cor de tudo. Homepage, site e painel
compartilham o mesmo sistema de design — tokens de cor em CSS, tema claro e
escuro, tipografia Aeonik + JetBrains Mono e os diagramas em SVG da homepage.

Onde mexer em cada peça está em
[`docs/04-design-system.md`](docs/04-design-system.md). Resumo do que importa:
`tokens.css`, `base.css`, `chrome.css` e `markdown.css` são **idênticos** entre
os apps que os usam e precisam ser copiados juntos ao mudar um deles.

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

### Por onde cada skill é publicada

`is_public` é o **interruptor global**: com ela desligada a skill não aparece
no site, na API REST nem em superfície nenhuma do MCP público. Com ela ligada,
três flags independentes dizem por quais superfícies do protocolo a skill sai —
qualquer combinação vale, inclusive nenhuma:

| Flag | Padrão | Como aparece no cliente |
|------|--------|-------------------------|
| `use_as_skill` | **ligada** | a skill fica ao alcance das cinco ferramentas — `search_skills`, `get_skill`, `get_skill_file`, `download_skill` e a contagem de `list_tags`. Desligada, some das cinco |
| `use_as_prompt` | desligada | a skill entra em `prompts/list` com o **slug** como nome; `prompts/get` devolve o corpo do SKILL.md, sem frontmatter e sem argumentos. Na maioria dos clientes vira um slash-command |
| `use_as_resource` | desligada | a skill ganha a URI `skill://<slug>`; `resources/read` devolve o SKILL.md canônico (`text/markdown`), idêntico ao do `.zip` |

As três superfícies **contam acesso** (`view_count`). Numa skill privada as
flags ficam guardadas e nada aparece; uma skill fora de uma superfície responde
por ela o mesmo "não encontrada" de um slug inexistente. As listas de prompts e
resources são montadas por requisição, então publicar uma skill a faz aparecer
sem reiniciar o servidor nem reabrir a sessão; não há `listChanged`, o cliente
re-lista quando quiser.

Desligar `use_as_skill` não tira a skill do site nem da API REST: ela continua
com página, `.zip` e tudo mais — só sai do alcance da busca do agente. O
desenho está em [`docs/06-publicacao-mcp.md`](docs/06-publicacao-mcp.md) e
[`docs/07-superficie-de-ferramentas.md`](docs/07-superficie-de-ferramentas.md).

### Ferramentas do MCP público

| Ferramenta | Descrição |
|-----------|-----------|
| `search_skills(query?, tag?, limit?, offset?)` | Busca full-text nas skills públicas com `use_as_skill` |
| `get_skill(slug)` | SKILL.md completo + metadados. **Conta um acesso** |
| `get_skill_file(slug, path)` | Lê um arquivo auxiliar da skill |
| `download_skill(slug)` | Devolve a URL do pacote `.zip` |
| `list_tags()` | Tags disponíveis, com contagem |

A autenticação do servidor principal é escolhida por `MCP_PUBLIC_AUTH`:
`open` (sem autenticação), `key` (só a `MCP_PUBLIC_KEY`) ou `managed` (chaves
`psp_…` emitidas por administradores no painel, e também a `MCP_PUBLIC_KEY`
se estiver definida). Sem a variável, o modo é `key` quando há
`MCP_PUBLIC_KEY` e `open` quando não há — o comportamento de sempre. O
`GET /` anuncia o modo.

### MCPs virtuais: um servidor por time

Um **MCP virtual** é um recorte do catálogo servido pelo mesmo mcp-public em
`/virtual/<slug>/mcp` (e `/mcp/stateless`, `/sse` + `/messages`), com
endereço, chaves e dono próprios. Serve para um time ou projeto conectar o
agente só às skills que lhe interessam — **inclusive skills privadas**, que
nunca aparecem no MCP principal nem no site.

- Cria quem é `editor` ou `admin`, no painel (seção "MCPs virtuais") ou pelo
  MCP administrativo. Quem cria é o dono; o dono e os administradores mexem
  nele, ninguém mais. Admin transfere o dono.
- Para cada skill vinculada escolhem-se as **três superfícies** (ferramentas,
  prompt, resource) **naquele servidor** — as flags `use_as_*` da skill valem
  só para o MCP principal.
- O acesso é por chave `psv_…`, emitida por MCP e sem expiração; a
  `MCP_PUBLIC_KEY` não abre um virtual e a chave de um virtual não abre outro.
  Um MCP pode ser marcado **aberto** (sem chave) — com skill privada dentro,
  isso a torna pública naquele endereço, e o sistema pede confirmação.
- `download_skill` e os arquivos binários apontam para o próprio servidor,
  atrás da mesma chave. Cada MCP tem contadores próprios por skill; o total da
  skill também soma.
- Desligar (`ligado` no painel) faz tudo sob `/virtual/<slug>` responder 404
  sem apagar nada; slug inexistente também é 404, chave errada é 401.

```json
{
  "mcpServers": {
    "time-a": {
      "type": "http",
      "url": "https://mcp.example.com/virtual/time-a/mcp",
      "headers": { "Authorization": "Bearer psv_…" }
    }
  }
}
```

O desenho está em [`docs/08-mcp-virtual.md`](docs/08-mcp-virtual.md).

### Ferramentas do MCP administrativo

Exige sempre `Authorization: Bearer <credencial>`, que pode ser o
`MCP_ADMIN_TOKEN` (papel `admin`, ator `token-global` na auditoria) ou uma
chave `psk_…` emitida por um usuário no painel — nesse caso valem o **papel** e
o **nome** do dono: uma chave de `leitor` só executa as ferramentas de leitura,
e `delete_skill` exige `admin`.

| Ferramenta | Descrição |
|-----------|-----------|
| `list_skills(includePrivate?, query?, tag?, limit?, offset?)` | Lista tudo, inclusive privadas |
| `get_skill(slug)` / `get_file(slug, path)` | Leitura |
| `create_skill(name, description?, skill_md_content, tags?, slug?, is_public?, use_as_skill?, use_as_prompt?, use_as_resource?)` | Cria a skill e o SKILL.md na mesma transação. `skill_md_content` é só o **corpo** |
| `edit_skill(slug, {name?, description?, tags?, new_slug?, use_as_skill?, use_as_prompt?, use_as_resource?})` | Edita metadados — é por aqui que muda o frontmatter e as três flags de publicação |
| `set_visibility(slug, "public" \| "private")` | Publica/despublica |
| `set_file(slug, path, content)` | Cria ou sobrescreve um arquivo. Em `SKILL.md`, grava só o corpo |
| `set_files_bulk(slug, zip_base64, replace?)` | Importa uma árvore inteira de um `.zip` — por padrão o zip é o **estado completo** (omitidos são removidos, `SKILL.md` preservado) |
| `delete_file(slug, path)` | Remove um arquivo (**bloqueado** para `SKILL.md`) |
| `delete_skill(slug, confirm)` | Remove a skill (exige `confirm: true`) |
| `list_tags()` / `get_stats()` | Navegação e métricas |
| `list_virtual_mcps()` / `get_virtual_mcp(slug)` / `create_virtual_mcp(…)` / `update_virtual_mcp(…)` / `delete_virtual_mcp(slug, confirm)` | MCPs virtuais — alcance por dono |
| `set_virtual_mcp_skills(slug, [{slug, asSkill, asPrompt, asResource}], confirm_open?)` | Substitui a lista inteira de skills do MCP virtual |
| `list_virtual_mcp_keys(slug)` / `create_virtual_mcp_key(slug, name)` / `revoke_virtual_mcp_key(slug, key_id)` | Chaves `psv_` do MCP virtual |
| `list_public_mcp_keys()` / `create_public_mcp_key(name)` / `revoke_public_mcp_key(key_id)` | Chaves `psp_` do MCP principal (`MCP_PUBLIC_AUTH=managed`); só admin |

## API REST pública

A API do site é aberta (CORS `*`) e serve como alternativa ao MCP:

```
GET  /api/skills?q=&tag=&sort=&limit=&offset=   lista/busca (só públicas)
GET  /api/skills/:slug                          detalhe + corpo do SKILL.md (conta acesso)
GET  /api/skills/:slug/files/<caminho>          arquivo avulso
GET  /api/tags                                  tags com contagem
GET  /skills/:slug/download                     pacote .zip        (conta download)
GET  /healthz                                   saúde do serviço
```

## Metadados e o `SKILL.md`

Slug, nome, descrição e tags são **campos da skill**, não texto do arquivo. O
frontmatter é gerado a partir deles toda vez que o `SKILL.md` é entregue — no
download `.zip`, na leitura crua do arquivo e nas ferramentas MCP:

```yaml
---
name: revisao-de-codigo          # o slug: nome oficial da skill
description: Revisa PRs pequenos: foco em risco, teste e legibilidade.
metadata:
  title: Revisão de Código       # nome de exibição no catálogo
  tags: code-review, qa
---
```

O que fica gravado é só o corpo do prompt: qualquer frontmatter enviado no
conteúdo é descartado na escrita, e o formulário do painel é a fonte da
verdade. Renomear a skill atualiza o arquivo sozinho, sem reescrever o texto.

## Contadores e ranking

Cada skill tem `view_count` e `download_count`. O ranking do site é a **soma
simples** dos dois (`ORDER BY view_count + download_count DESC`), calculada em
tempo de query.

O incremento é atômico e acontece em **qualquer superfície de acesso** — página
do site, API REST e, no MCP, `get_skill`, `resources/read` e `prompts/get`.
Acesso direto a arquivos auxiliares **não** conta; apenas o `SKILL.md` e o
download do pacote.

## Contas, papéis e acesso

O painel usa **contas**. Numa instalação nova a tabela nasce vazia: a
`ADMIN_PASSWORD` ainda entra sozinha e o painel oferece criar o primeiro
administrador. A partir da primeira conta, ela fica **inerte** — o acesso passa
a ser sempre por e-mail e senha.

| Ação | admin | editor | leitor |
|------|:-----:|:------:|:------:|
| Ver skills, inclusive privadas | ✅ | ✅ | ✅ |
| Criar / editar skill e arquivos | ✅ | ✅ | ❌ |
| Publicar / despublicar | ✅ | ✅ | ❌ |
| Apagar skill | ✅ | ❌ | ❌ |
| Gerenciar contas e papéis | ✅ | ❌ | ❌ |
| Ver a trilha de auditoria | ✅ | ❌ | ❌ |
| Emitir chaves de API para si | ✅ | ✅ | ✅ |

Os papéis são **globais**: não há dono por skill. O papel limita a ação, nunca
o escopo.

- **Chaves de API** (`psk_<prefixo>_<segredo>`) substituem o token global ao
  configurar um agente: carregam o papel do dono e aparecem na auditoria com o
  nome dele. O texto completo é mostrado **uma única vez**, na emissão.
- **Revogação** é individual: trocar senha, mudar papel ou desativar a conta
  invalida na hora todos os cookies e sessões daquela pessoa. Contas não são
  apagadas — são desativadas, para a auditoria continuar fazendo sentido.
- **Login por SSO** (OIDC) é opcional. Ligue com `OIDC_ISSUER` +
  `OIDC_CLIENT_ID` + `OIDC_CLIENT_SECRET` e registre no provedor o
  `redirect_uri` `<ADMIN_PUBLIC_URL>/api/auth/oidc/callback`. **Defina
  `OIDC_ALLOWED_DOMAINS`**: com a lista vazia, o auto-provisionamento fica
  desligado de propósito — um `leitor` enxerga as skills privadas, e sem
  allowlist qualquer conta do provedor entraria.
- **Redefinição de senha por e-mail** exige `SMTP_URL` + `SMTP_FROM`. Sem SMTP
  o painel continua completo: o administrador gera uma senha temporária, e a
  pessoa é obrigada a trocá-la no primeiro acesso.
- **Rate limiting no login** em duas camadas: janela em memória por IP e trava
  da conta (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_SECONDS`).

O desenho completo, com as decisões e o que ficou de fora, está em
[`docs/05-accounts-and-roles.md`](docs/05-accounts-and-roles.md).

> **Mudança de comportamento na série beta.** A `ADMIN_PASSWORD` deixa de
> logar assim que existir a primeira conta. Instalações existentes sobem sem
> intervenção — quem não passar pelo setup continua entrando com ela
> indefinidamente.

## Configuração

Todas as variáveis estão documentadas em [`.env.example`](.env.example). Todo
segredo aceita `<NOME>` ou `<NOME>_FILE`:

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `DATABASE_URL` | sim* | Conexão com o Postgres (senha percent-encodada). *Alternativa sem escape: `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` — é o que o compose usa |
| `ADMIN_PASSWORD` / `_FILE` | sim (admin) | Senha de **bootstrap**: cria o primeiro administrador e depois fica inerte |
| `ADMIN_SESSION_SECRET` / `_FILE` | recomendada | Chave do cookie de sessão (derivada da senha com scrypt se ausente) |
| `MCP_ADMIN_TOKEN` / `_FILE` | sim (mcp-admin) | Bearer token administrativo |
| `MCP_PUBLIC_AUTH` | não | `open`, `key` ou `managed` para o MCP público **principal**; vazio = `key` com `MCP_PUBLIC_KEY`, `open` sem |
| `MCP_PUBLIC_KEY` / `_FILE` | com `key` | A chave dos modos `key` e `managed` (não abre os virtuais) |
| `SITE_BASE_URL` | recomendada | Base das URLs de download geradas pelo MCP |
| `MCP_PUBLIC_URL`, `MCP_ADMIN_URL`, `ADMIN_URL` | não | Endereços mostrados na seção "Endereços de acesso" do site; vazio = o cartão some. `MCP_PUBLIC_URL` é também a base dos MCPs virtuais no painel e nas URLs de download do mcp-public |
| `ADMIN_PUBLIC_URL` | recomendada (SSO) | Base do `redirect_uri` do OIDC e do link de redefinição de senha |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` / `_FILE` | não | Ligam o login por SSO (os três juntos) |
| `OIDC_ALLOWED_DOMAINS` | sim, com SSO | Domínios de e-mail autorizados; vazia desliga o auto-provisionamento |
| `SMTP_URL` / `_FILE`, `SMTP_FROM` | não | Ligam a redefinição de senha por e-mail |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_SECONDS` | não | Trava da conta após tentativas erradas (padrão: 8 / 900s) |

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
- Sem versionamento de arquivos (apenas um log de auditoria, sem restore).
- `audit_log` sem política de retenção.
- Busca vetorial deixada para uma versão futura.
- Com SSO ligado, a vinculação a uma conta local é sempre pelo e-mail: confie
  no provedor que você configurar e restrinja `OIDC_ALLOWED_DOMAINS`.
- Um MCP virtual aberto com skill privada dentro é publicação: o painel e a
  tool pedem confirmação, e só.

## Licença

[MIT](LICENSE).
