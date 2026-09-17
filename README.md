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
| **admin** | Painel de administração: canvas dos servidores MCP, sessões, contas e papéis | `3001` |
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

### Imagens no Docker Hub

As imagens ficam no Docker Hub, na conta
[`tmsoftbrasil`](https://hub.docker.com/u/tmsoftbrasil), como
`tmsoftbrasil/purple-skills-<nome>`: `homepage`, `site`, `admin`,
`mcp-public`, `mcp-admin`, `indexer` e `db` (a do `migrate` e do `seed`) —
sempre como `latest`, sem tag por versão. **A publicação não é automática:**
nenhum workflow de CI tem credencial de registry. Depois de criar a tag da
release, quem mantém builda e publica à mão, de uma máquina já autenticada
(`docker login`) na conta:

```bash
./release-images.sh              # builda e publica as 7 imagens
./release-images.sh site admin   # só as passadas por nome
```

O compose usa a tag de `TAG` no `.env` (padrão `latest`); se a imagem não
existir no Hub, ele a gera a partir do código, como o `docker compose build`
faz sempre.

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
| mcp-public | `http://mcp-public:3002/mcp` | A do MCP virtual padrão: nenhuma se ele está aberto, `Authorization: Bearer psv_…` se exige chave |
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

Os testes de integração — as queries de `database/`, o indexador e a busca —
exigem um Postgres real **com a extensão `vector`** e ficam desligados por
padrão. Para rodá-los, aponte `TEST_DATABASE_URL` para um banco
**descartável** — o schema é recriado do zero a cada execução:

```bash
TEST_DATABASE_URL=postgres://postgres:CHANGE_ME@127.0.0.1:5432/purple_skills_test \
  npx vitest run database/src/files.integration.test.ts
```

Com a variável definida, `npm test` roda a suíte inteira, integração incluída.

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

### Onde uma skill é exibida

Uma skill é **flutuante**: existe no catálogo e só é exibida — no site e nos
servidores MCP — onde estiver **vinculada a um MCP virtual**. Não há mais
"pública" ou "privada": o site lista o que está em ao menos um MCP virtual
**aberto e ligado**, e uma skill sem vínculo fica visível só no painel. Cada
vínculo escolhe por quais portas a skill sai **naquele servidor**:

| Porta | O que faz |
|-------|-----------|
| `skill` | a skill fica ao alcance das cinco ferramentas — `search_skills`, `get_skill`, `get_skill_file`, `download_skill` e a contagem de `list_tags` |
| `prompt` | a skill entra em `prompts/list` com o **slug** como nome; `prompts/get` devolve o corpo do SKILL.md, sem frontmatter e sem argumentos. Na maioria dos clientes vira um slash-command |
| `resource` | a skill ganha a URI `skill://<slug>`; `resources/read` devolve o SKILL.md canônico (`text/markdown`), idêntico ao do `.zip` |

As três portas **contam acesso** (`view_count`), no vínculo e no total da
skill. Uma skill fora de uma porta responde por ela o mesmo "não encontrada"
de um slug inexistente. As listas de prompts e resources são montadas por
requisição, então vincular uma skill a faz aparecer sem reiniciar o servidor
nem reabrir a sessão; não há `listChanged`, o cliente re-lista quando quiser.

O vínculo se faz pelos dois lados: na página da skill ("Publicada em") ou na
do MCP virtual, e por `link_skill` / `set_virtual_mcp_skills` no mcp-admin.
Publicar em um MCP virtual exige administrá-lo — o dono ou um admin. O
desenho está em
[`docs/09-mcp-padrao-e-skills-flutuantes.md`](docs/09-mcp-padrao-e-skills-flutuantes.md).

Uma skill pode ser **desligada** na ficha dela: some de todo servidor e do
site, direto ou por catálogo, sem perder vínculo nenhum — e volta quando for
religada.

### Catálogos: um grupo de skills de uma vez

Um **catálogo** agrupa skills e, vinculado a um MCP virtual, entrega todas as
que estiverem ativas pelas portas escolhidas no vínculo — uma escolha só para
o grupo, que continua valendo quando o grupo muda. Uma skill pode estar em
vários catálogos; um catálogo pode estar em vários servidores.

- Cria quem é `editor` ou `admin`, em Catálogos no painel ou por
  `create_catalog`. Quem cria é o dono; vincular a um servidor exige
  administrar **o servidor e o catálogo** (dono ou admin dos dois).
- Se uma skill do catálogo também tem **vínculo direto** com o mesmo
  servidor, o vínculo direto vale sozinho — é o jeito de restringir uma
  skill num servidor sem tirá-la do grupo. Sem vínculo direto, as portas são
  a união dos catálogos.
- Na página do catálogo cada skill tem a **participação** (desmarcar tira da
  entrega sem remover do catálogo), e uma skill desligada aparece com alerta.
  O catálogo inteiro também liga e desliga.
- No canvas o catálogo é um nó só, com o número de skills ativas que ele
  entrega àquele servidor. Cada catálogo tem o próprio contador de acessos.

O desenho está em [`docs/11-catalogos.md`](docs/11-catalogos.md).

### Ferramentas do MCP público

| Ferramenta | Descrição |
|-----------|-----------|
| `search_skills(query?, tag?, limit?, offset?)` | Busca full-text nas skills vinculadas ao servidor como `skill` |
| `get_skill(slug)` | SKILL.md completo + metadados. **Conta um acesso** |
| `get_skill_file(slug, path)` | Lê um arquivo auxiliar da skill |
| `download_skill(slug)` | Devolve a URL do pacote `.zip` |
| `list_tags()` | Tags disponíveis, com contagem |

### O MCP público é o MCP virtual padrão

Não existe mais um servidor "principal" à parte: o que responde em `/mcp` é o
**MCP virtual escolhido como padrão** em Configurações, no painel (ou por
`set_default_virtual_mcp` no mcp-admin, só admin). Ele continua respondendo
em `/virtual/<slug>/mcp`, e não tem nenhum tratamento especial — pode ser
fechado, desligado ou apagado como qualquer outro. Quem decide o acesso a
`/mcp` é ele: aberto, ou chaves `psv_` emitidas na página dele. `GET /`
anuncia qual é o padrão, e sem um em pé `/mcp` responde 404 dizendo a causa
(nenhum escolhido, removido ou desligado).

Quem sobe de versão recebe o MCP virtual `public`, aberto, com toda skill
pública vinculada nas mesmas superfícies de antes. `MCP_PUBLIC_AUTH`,
`MCP_PUBLIC_KEY` e as chaves `psp_` deixaram de existir; o mcp-public recusa
subir enquanto as variáveis estiverem no `.env`, para quem protegia o servidor
fechar o `public` (ou emitir chaves `psv_` para ele) antes de removê-las. O
desenho está em
[`docs/09-mcp-padrao-e-skills-flutuantes.md`](docs/09-mcp-padrao-e-skills-flutuantes.md).

### MCPs virtuais: um servidor por time

Um **MCP virtual** é um recorte do catálogo servido pelo mesmo mcp-public em
`/virtual/<slug>/mcp` (e `/mcp/stateless`, `/sse` + `/messages`), com
endereço, chaves e dono próprios. Serve para um time ou projeto conectar o
agente só às skills que lhe interessam — inclusive skills que não estão em
nenhum servidor aberto, e por isso não aparecem no site. Um deles é o
**padrão**, e responde também em `/mcp`.

- Cria quem é `editor` ou `admin`, no painel (Servidores MCP) ou pelo
  MCP administrativo. Quem cria é o dono; o dono e os administradores mexem
  nele, ninguém mais. Admin transfere o dono.
- Para cada skill vinculada escolhem-se as **três superfícies** (ferramentas,
  prompt, resource) **naquele servidor**. Vincular é o único jeito de uma
  skill ser exibida.
- O acesso é por chave `psv_…`, emitida por MCP e sem expiração; a chave de
  um virtual não abre outro.
  Um MCP pode ser marcado **aberto** (sem chave): aberto é público — o site o
  lista, com suas skills.
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
chave `psk_…` emitida por um usuário no painel — nesse caso valem o **papel**,
o **acesso por objeto** e o **nome** do dono: a chave vê e faz exatamente o
que a conta faria no painel (ver [Contas, papéis e acesso](#contas-papéis-e-acesso)).

| Ferramenta | Descrição |
|-----------|-----------|
| `list_skills(query?, tag?, limit?, offset?, scope?)` | Lista o que a credencial enxerga, inclusive skills sem vínculo, cada uma com o dono, o acesso e `mcps`; `scope` = `mine` / `shared` / `public` |
| `get_skill(slug)` / `get_file(slug, path)` | Leitura |
| `create_skill(name, description?, skill_md_content, tags?, slug?, mcps?, is_public?)` | Cria a skill (quem cria é o dono) e o SKILL.md na mesma transação, já publicada nos MCPs de `mcps` (só os que a credencial edita). `skill_md_content` é só o **corpo** |
| `edit_skill(slug, {name?, description?, tags?, new_slug?, is_active?, is_public?})` | Edita metadados — é por aqui que muda o frontmatter. Nome, descrição, ícone e tags exigem `edit`; slug, `is_active` e `is_public`, `manage` |
| `link_skill(skill, mcp, asSkill, asPrompt, asResource)` / `unlink_skill(skill, mcp)` | Publica e despublica pelo lado da skill: `edit` no MCP virtual e `view` na skill |
| `set_file(slug, path, content)` | Cria ou sobrescreve um arquivo. Em `SKILL.md`, grava só o corpo |
| `set_files_bulk(slug, zip_base64, replace?)` | Importa uma árvore inteira de um `.zip` — por padrão o zip é o **estado completo** (omitidos são removidos, `SKILL.md` preservado) |
| `delete_file(slug, path)` | Remove um arquivo (**bloqueado** para `SKILL.md`) |
| `delete_skill(slug, confirm)` | Remove a skill (exige `confirm: true`; só o dono ou um admin) |
| `share_skill(slug, email, level)` / `unshare_skill(slug, email)` / `transfer_skill(slug, email)` | Concede (`view`, `edit`, `manage`), revoga e transfere o dono; o mesmo para `*_catalog` e `*_mcp` |
| `list_tags()` / `get_stats()` | Navegação e métricas |
| `list_virtual_mcps(scope?)` / `get_virtual_mcp(slug)` / `create_virtual_mcp(…)` / `update_virtual_mcp(…)` / `delete_virtual_mcp(slug, confirm)` | MCPs virtuais — alcance pelo acesso por objeto |
| `set_virtual_mcp_skills(slug, [{slug, asSkill, asPrompt, asResource}])` | Substitui a lista inteira de skills do MCP virtual |
| `list_virtual_mcp_keys(slug)` / `create_virtual_mcp_key(slug, name)` / `revoke_virtual_mcp_key(slug, key_id)` | Chaves `psv_` do MCP virtual |
| `get_default_virtual_mcp()` / `set_default_virtual_mcp(slug \| null)` | Qual MCP virtual responde em `/mcp`; escolher é só admin |
| `list_catalogs()` / `get_catalog(slug)` / `create_catalog(…)` / `update_catalog(…)` / `delete_catalog(slug, confirm)` | Catálogos — alcance por dono |
| `set_catalog_skills(slug, [{slug, isActive?}])` | Substitui a lista inteira de skills do catálogo; `isActive: false` mantém sem entregar |
| `set_virtual_mcp_catalogs(slug, [{slug, asSkill, asPrompt, asResource}])` | Substitui a lista de catálogos do MCP virtual; exige administrar o MCP e cada catálogo |

## Busca semântica (opcional)

Além da busca full-text de sempre, o catálogo pode buscar **por significado**:
"como padronizar mensagem de commit" acha `conventional-commits` mesmo sem a
palavra "padronizar" no texto. As duas pernas são fundidas por RRF, e a
resposta traz `mode` — `text` ou `hybrid` — para o cliente saber o que leu.

**Ela vem desligada.** Sem `RAG_DRIVER`, sem chave, sem a migration `020` ou
com o provedor fora do ar, tudo responde exatamente como antes, em modo `text`
— e isso não é erro.

Três provedores, um modelo por vez:

| `RAG_DRIVER` | Modelos | Dimensões |
|---|---|---|
| `google` | `gemini-embedding-2` | 3072 |
| `openai` | `text-embedding-3-small`, `text-embedding-3-large` | 1536 / 3072 |
| `voyage` | `voyage-4-lite`, `voyage-4`, `voyage-4-large` | 1024 |

Para ligar:

```bash
docker compose run --rm migrate                 # a 020 cria as tabelas rag_*
docker compose --profile rag up -d indexer      # o indexador fica fora do up -d normal
```

Depois, no painel, em **Configurações → Busca semântica**, escolha o driver e o
modelo. O `.env` só semeia esses dois valores no primeiro boot: dali em diante
quem manda é o painel, e mudar a variável vira só um aviso no log. As **chaves**,
essas sim, são do `.env` — e dá para deixar mais de uma configurada, o que
permite trocar de provedor pelo painel sem recriar container nenhum.

Trocar de driver ou de modelo cria outro espaço de embedding: o acervo é
reindexado nele e os vetores do anterior ficam onde estão, prontos para quando
alguém voltar atrás. **Nada é apagado numa troca**, e o botão "Reindexar" não
gasta embedding com texto que não mudou.

> **Aviso, e é só do Google.** No nível gratuito da Gemini API o conteúdo
> enviado — inclusive o de skills privadas — é usado para melhorar produtos, e
> revisores humanos podem lê-lo. Para que não seja, gere a chave num projeto com
> faturamento ativo. No Espaço Econômico Europeu, na Suíça e no Reino Unido, só
> o nível pago é permitido para quem oferece o serviço a usuários dessas
> regiões. OpenAI e Voyage não treinam sobre o tráfego da API.

O desenho está em [`docs/14-rag.md`](docs/14-rag.md).

## API REST pública

A API do site é aberta (CORS `*`) e serve como alternativa ao MCP:

```
GET  /api/mcps                                  MCPs virtuais abertos, com endereço
GET  /api/skills?q=&tag=&sort=&limit=&offset=   lista/busca (o que está em MCP virtual aberto)
                                                a resposta traz `mode`: text ou hybrid
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

Cada uma dessas leituras também deixa **um registro** (`skill_accesses`): quem
leu — a chave `psv_` do servidor, a conta por trás de uma chave `psk_` do MCP
administrativo, ou ninguém —, por qual servidor e catálogo, de que IP e com que
cliente. O painel mostra os últimos na guia **Auditoria** da skill e do
catálogo, para quem os administra
([`docs/13-fichas-e-acessos.md`](docs/13-fichas-e-acessos.md)). O registro
nunca é apagado.

## Contas, papéis e acesso

O painel usa **contas**. Numa instalação nova a tabela nasce vazia: a
`ADMIN_PASSWORD` ainda entra sozinha e o painel oferece criar o primeiro
administrador. A partir da primeira conta, ela fica **inerte** — o acesso passa
a ser sempre por e-mail e senha.

| Ação | admin | editor | membro |
|------|:-----:|:------:|:------:|
| Ver tudo | ✅ | ❌ | ❌ |
| Criar skill, catálogo e servidor MCP (e virar dono) | ✅ | ✅ | ❌ |
| Editar / administrar o que é seu ou lhe foi concedido | ✅ | ✅ | ✅ |
| Apagar e transferir o que é seu | ✅ | ✅ | ✅ |
| Gerenciar contas e papéis | ✅ | ❌ | ❌ |
| Ver a trilha de auditoria | ✅ | ❌ | ❌ |
| Emitir chaves de API para si | ✅ | ✅ | ✅ |

O papel decide só quem **cria** e quem administra a instalação. O **escopo** é
por objeto ([`docs/12-acesso-granular.md`](docs/12-acesso-granular.md)):

- **Skills, catálogos e servidores MCP têm dono.** Quem cria é o dono e faz
  tudo, inclusive apagar e transferir. Admin é dono de tudo.
- **Concessões por objeto**, cumulativas: `view` (ler; num servidor ou
  catálogo, ler também as skills dentro), `edit` (conteúdo da skill, membros
  do catálogo, vínculos e canvas do servidor) e `manage` (slug, estado,
  público/aberto, chaves e as próprias concessões). Quem tem `manage` concede
  a outros; quem tem `view` numa skill pode vinculá-la aos servidores e
  catálogos que edita.
- **Público**: uma skill ou um catálogo marcado como público é legível por
  qualquer conta e pelo site, sem concessão. Um servidor aberto (`is_open`) já
  é público por definição. Um catálogo público ou um servidor aberto **expõe
  o que está dentro**, mesmo skills privadas — o painel avisa.
- Quem não é admin só lista o que é seu, o que lhe foi concedido e o que é
  público; as listas do painel têm o filtro *Meus / Compartilhados comigo /
  Públicos*.

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
  desligado de propósito — sem allowlist qualquer conta do provedor entraria
  como `membro` e leria tudo o que é público.
- **Redefinição de senha por e-mail** exige `SMTP_URL` + `SMTP_FROM`. Sem SMTP
  o painel continua completo: o administrador gera uma senha temporária, e a
  pessoa é obrigada a trocá-la no primeiro acesso.
- **Rate limiting no login** em duas camadas: janela em memória por IP e trava
  da conta (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_SECONDS`).

O desenho completo, com as decisões e o que ficou de fora, está em
[`docs/05-accounts-and-roles.md`](docs/05-accounts-and-roles.md).

> **Mudança de comportamento na série beta (acesso granular).** O papel
> `leitor` virou `membro` e deixou de ver o acervo inteiro: um membro (e um
> editor) vê só o que é seu, o que lhe foi concedido e o que é público ou está
> em servidor aberto. Skills existentes ganham como dono quem as criou; nada
> nasce público. Depois de atualizar, marque como públicas as skills que devem
> continuar visíveis a todos, ou conceda acesso na seção *Acesso* de cada uma.
> Sessões abertas com o papel antigo pedem novo login.
>
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
| `ADMIN_DOCS_URL`, `ADMIN_SUPPORT_URL`, `ADMIN_CHAT_URL` | não | Links externos da sidebar do painel; vazio some do menu (a documentação aponta para este README por padrão) |
| `ADMIN_BRAND_NAME`, `ADMIN_BRAND_ICON_URL` | não | Marca do painel: nome e ícone da sidebar, do login e da aba. O nome cai em `SITE_NAME`; o ícone aceita URL http(s) ou caminho do painel, e valor inválido derruba o boot |
| `MCP_SESSION_ONLINE_WINDOW_MS` | não | Janela em que um cliente do MCP público conta como online no painel (padrão 2 min); agrupa as requisições stateless de um mesmo cliente numa sessão |
| `ADMIN_SESSION_SECRET` / `_FILE` | recomendada | Chave do cookie de sessão (derivada da senha com scrypt se ausente) |
| `MCP_ADMIN_TOKEN` / `_FILE` | sim (mcp-admin) | Bearer token administrativo |
| `SITE_BASE_URL` | recomendada | Base da URL da página de uma skill pública, devolvida pelo MCP |
| `MCP_PUBLIC_URL`, `MCP_ADMIN_URL`, `ADMIN_URL` | não | Endereços mostrados na seção "Endereços de acesso" do site; vazio = o cartão some. `MCP_PUBLIC_URL` é a **base**, sem `/mcp` — o site acrescenta o sufixo ao mostrar o MCP público, e a mesma base monta os MCPs virtuais no painel e as URLs de download do mcp-public |
| `ADMIN_PUBLIC_URL` | recomendada (SSO) | Base do `redirect_uri` do OIDC e do link de redefinição de senha |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` / `_FILE` | não | Ligam o login por SSO (os três juntos) |
| `OIDC_ALLOWED_DOMAINS` | sim, com SSO | Domínios de e-mail autorizados; vazia desliga o auto-provisionamento |
| `SMTP_URL` / `_FILE`, `SMTP_FROM` | não | Ligam a redefinição de senha por e-mail |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_SECONDS` | não | Trava da conta após tentativas erradas (padrão: 8 / 900s) |
| `RAG_DRIVER`, `RAG_MODEL` | não | Ligam a [busca semântica](#busca-semântica-opcional): `google`, `openai`, `voyage` ou `off`. Lidas **só pelo admin**, que as semeia no banco no primeiro boot — depois quem manda é o painel. Sem `RAG_MODEL`, vale o padrão do driver |
| `RAG_GOOGLE_API_KEY`, `RAG_OPENAI_API_KEY`, `RAG_VOYAGE_API_KEY` / `_FILE` | sim, com o driver ligado | A chave de cada provedor. Vão para o indexer, o mcp-public e o site; **nunca** para o painel. Mais de uma configurada permite trocar de driver sem recriar container |
| `RAG_GOOGLE_BASE_URL`, `RAG_OPENAI_BASE_URL`, `RAG_VOYAGE_BASE_URL` | não | URL base de cada provedor, já com a versão da API. Usada como está |
| `RAG_QUERY_TIMEOUT_MS`, `RAG_INDEX_INTERVAL_SECONDS` | não | Prazo do embedding da consulta (padrão 2000 ms) e intervalo do indexador (padrão 30 s) |

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
- Um MCP virtual aberto é público: o site o lista, com suas skills, sem
  confirmação. Endereço obscuro nunca foi proteção; quem não quer aparecer
  fecha o servidor e emite chaves.

## Licença

[MIT](LICENSE).
