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
| **site** | Página pública do usuário: skills e catálogos públicos, busca, SKILL.md renderizado, download e o `mcp.json` | `3000` |
| **admin** | Painel de administração: canvas dos servidores MCP, sessões, contas e papéis | `3001` |
| **mcp-public** | Servidor MCP para agentes descobrirem e baixarem skills | `3002` |
| **mcp-admin** | Servidor MCP para administrar o catálogo (CRUD completo) | `3003` |

**homepage e site são páginas diferentes de propósito.** A homepage explica o
que é o Purple Skills e leva ao GitHub; ela não conhece instalação nenhuma e
pode ir para o ar sozinha. O site é a página de quem já tem uma instalação no
ar: lista as skills e os catálogos tornados públicos, ensina a configurar o
`mcp.json` e mostra os endereços de acesso. O que é privado fica só no painel.

O banco é **PostgreSQL 18** (imagem `pgvector/pgvector:pg18-trixie`). A busca usa
**full-text search nativo** (`tsvector` + GIN) e, com a
[busca semântica](#busca-semântica-opcional) ligada, funde o resultado com a
busca vetorial do `pgvector` por RRF — o campo `mode` da resposta diz qual das
duas o cliente leu.

## Começando em 60 segundos

```bash
cp .env.example .env      # troque TODOS os CHANGE_ME: POSTGRES_PASSWORD,
                          # ADMIN_PASSWORD, ADMIN_SESSION_SECRET e MCP_ADMIN_TOKEN.
                          # O de sessão assina o cookie do painel — quem o deixa
                          # no placeholder entrega o painel a qualquer visitante.
                          # Gere cada um com: openssl rand -hex 32
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
`mcp-public`, `mcp-admin`, `indexer` e `db` (a do `migrate` e do `seed`) — cada
uma com **duas tags**, `latest` e a da versão do `package.json`, e em
**`linux/amd64` e `linux/arm64`**. **A publicação não é automática:** nenhum
workflow de CI tem credencial de registry. Depois de criar a tag da release,
quem mantém builda e publica à mão, de uma máquina já autenticada
(`docker login`) na conta:

```bash
./release-images.sh                        # builda e publica as 7 imagens
./release-images.sh site admin             # só as passadas por nome
PLATFORMS=linux/amd64 ./release-images.sh  # uma arquitetura só, com pressa
```

O script mostra versão, tags, plataformas e commit — e avisa se a árvore está
suja — antes de pedir a única confirmação; a versão e o commit ficam gravados na
própria imagem, em labels OCI (`docker image inspect`).

A `latest` só é movida **no fim**: o build publica cada imagem com a tag de
versão e, depois que todas as pedidas estão no Hub, o script aponta `latest` para
elas de uma vez, começando pela `db` (a do `migrate`). Build que falha no meio
deixa `latest` inteira na versão anterior; aí repita o **mesmo** comando — o que
já foi construído sai do cache —, porque rodar só as que faltam moveria a `latest`
só delas. Se for a promoção que parar, o script imprime os comandos que faltam.

O compose usa a tag de `TAG` no `.env` (padrão `latest`); se a imagem não
existir no Hub, ele a gera a partir do código, como o `docker compose build`
faz sempre. A tag de versão é o caminho de volta quando uma release quebra,
porque `latest` é sobrescrita e não deixa cópia de nada:

```bash
TAG=1.0.0-beta.20 docker compose up -d
```

### Atrás do Traefik

Preencha os `*_FQDN` no `.env` e suba com o override:

```bash
docker compose -f docker-compose.yml -f docker-compose.traefik.yml up -d
```

O override assume um Traefik já rodando na rede externa `traefik`, com o
entrypoint `websecure` e o certresolver `le`.

Ele também **despublica as portas** dos serviços (`ports: !reset []`): quem fala
com os apps passa a ser só o Traefik, e é isso que impede um contêiner vizinho de
chegar direto no app e declarar o `X-Forwarded-For` que quiser. Quem publica as
portas (`BIND_ADDR`) e põe um proxy na frente deve nomeá-lo em `TRUST_PROXY`.

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
só é aceitável porque a porta fica em `127.0.0.1` — e ela **não acompanha o
`BIND_ADDR` global**: publicar os outros serviços na rede não arrasta consigo uma
ferramenta sem credencial que tem caminho até o `mcp-admin`. Para alcançar
a UI de outra máquina, mude as duas metades juntas: `INSPECTOR_BIND_ADDR=0.0.0.0`
**e** `INSPECTOR_OMIT_AUTH=false` com
`INSPECTOR_API_TOKEN=$(openssl rand -hex 32)`. Atrás do Traefik o override não
publica porta nenhuma dele nem lhe dá rota: para abrir a UI no servidor, use um
túnel SSH até o IP do container na rede `internal`.

O Postgres é a outra exceção ao `BIND_ADDR`: a porta dele é publicada em
`POSTGRES_BIND_ADDR`, com padrão `127.0.0.1`, e fica no loopback mesmo com
`BIND_ADDR=0.0.0.0`. Nenhum app usa essa porta — todos chegam ao banco por
`postgres:5432` na rede `internal` —, ela existe para o `psql` de quem
administra a máquina, e publicá-la na rede expõe um servidor sem limite de
tentativa de login nem trava de conta. Precisa mesmo do banco de outra máquina?
`POSTGRES_BIND_ADDR=0.0.0.0`, e não com a senha do `.env.example`.

## Desenvolvimento local

Requer Node.js **22.15+** (LTS) e um Postgres 18 acessível. Não é o `22+` de
antes: a leitura de pacote importa `zstdDecompressSync` do `node:zlib`, que só
existe a partir do 22.15, e um import nomeado que o módulo não exporta é erro de
**ligação** — num 22.0–22.14 não falha o caminho `.zst`, falha o carregamento de
`@purple-skills/shared` inteiro, e com ele todo serviço que o importa. As imagens
não sentem: elas são `node:24-alpine`.

```bash
npm install
npm run build:packages     # shared, rag e db — a lista vive só no package.json
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
  site/          página pública    — Express + React/Vite + Tailwind
  admin/         painel admin      — Express + React/Vite + Tailwind
  mcp-public/    MCP público       — @modelcontextprotocol/sdk
  mcp-admin/     MCP administrativo
  indexer/       indexador do RAG  — worker de embeddings, sem porta; parado com o driver off
packages/
  shared/        slug, rating, mime, zip, frontmatter, segredos, senha, chave de
                 API, e-mail, papéis, sessão, ícone, cabeçalhos de segurança,
                 rate limit
  rag/           drivers de embedding, chunk, hash, busca semântica e o registro
                 único de drivers, modelos e variáveis RAG_*
```

Cada app gera sua **própria imagem Docker** — são **6**, e `database/Dockerfile` é
a sétima, a do `migrate`/`seed`. Os **cinco** que leem o catálogo (`site`,
`admin`, `mcp-public`, `mcp-admin` e `indexer`) falam **direto com o Postgres**,
sem serviço de API intermediário; a `homepage` não abre conexão com o banco.

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
cada arquivo copiado tem **o seu par**, e nenhum é igual nos três apps.
`tokens.css`, `base.css` e `chrome.css` são cópia byte a byte entre a
**homepage e o site**, e só entre esses dois; `markdown.css`, entre o **site e
o painel**. Ao mudar um, copie para o par no mesmo commit — o `npm test`
reprova o par pela metade. O painel é um console com paleta e primitivos
próprios ([`docs/10`](docs/10-admin-canvas-e-sessoes.md)) e nunca é destino
dos três primeiros: sobrescrevê-los com os do site apaga o console.

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

Uma skill é **flutuante**: existe no catálogo, e um servidor MCP só a serve
onde ela estiver **vinculada a um MCP virtual**. No **site** a regra é outra
([`docs/12`](docs/12-acesso-granular.md) §7): ele lista a skill **ligada** que
seja **marcada pública**, ou esteja em ao menos um MCP virtual **aberto e
ligado**, ou participe de um **catálogo público** e ligado. Desvincular uma
skill pública a tira dos servidores, não do site; sem nenhum dos três, ela fica
visível só no painel. Cada vínculo escolhe por quais portas a skill sai
**naquele servidor**:

| Porta | O que faz |
|-------|-----------|
| `skill` | a skill fica ao alcance das cinco ferramentas — `search_skills`, `get_skill`, `get_skill_file`, `download_skill` e a contagem de `list_tags` |
| `prompt` | a skill entra em `prompts/list` com o **slug** como nome; `prompts/get` devolve o corpo do SKILL.md, sem frontmatter e sem argumentos. Na maioria dos clientes vira um slash-command |
| `resource` | a skill ganha a URI `skill://<slug>/SKILL.md`; `resources/read` devolve o SKILL.md canônico (`text/markdown`), idêntico ao do `.zip` |

As três portas **contam acesso** (`view_count`), no vínculo e no total da
skill. Uma skill fora de uma porta responde por ela o mesmo "não encontrada"
de um slug inexistente. As listas de prompts e resources são montadas por
requisição, então vincular uma skill a faz aparecer sem reiniciar o servidor
nem reabrir a sessão; não há `listChanged`, o cliente re-lista quando quiser.

O vínculo se faz pelos dois lados: na página da skill ("Publicada em") ou na
do MCP virtual, e por `link_skill` / `set_virtual_mcp_skills` no mcp-admin.
Publicar em um MCP virtual exige `edit` **nele** e `view` **na skill** — o
dono, um admin ou quem recebeu `edit` no servidor. Quem edita um servidor
publica nele qualquer skill que consiga ler, inclusive de outro dono; se o
servidor for **aberto**, isso torna a skill pública. O desenho está em
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
  `create_catalog`. Quem cria é o dono; vincular a um servidor exige `edit`
  **no servidor** e `view` **no catálogo** — não administrar os dois. Como um
  catálogo público é legível por qualquer conta, quem edita um servidor seu
  pode puxar para dentro dele catálogo público de outro dono. Desvincular
  exige só o `edit` do servidor: tirar da lista é mexer no servidor.
- Se uma skill do catálogo também tem **vínculo direto** com o mesmo
  servidor, o vínculo direto vale sozinho — é o jeito de restringir uma
  skill num servidor sem tirá-la do grupo. Sem vínculo direto, as portas são
  a união dos catálogos.
- Na página do catálogo cada skill tem a **participação** (desmarcar tira da
  entrega sem remover do catálogo), e uma skill desligada aparece com alerta.
  O catálogo inteiro também liga e desliga.
- No canvas o catálogo é um nó só, com o número de skills ativas que ele
  entrega àquele servidor. Cada catálogo tem o próprio contador de acessos.
- **Clonar** um catálogo copia as propriedades e os membros, cada
  participação com o ligado/desligado que tinha — e não os servidores em que
  o original está vinculado. A cópia é de quem clonou e nasce privada
  ([Clonagem](#clonagem-uma-cópia-fechada)).

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
nenhum servidor aberto, e que só aparecem no site se forem marcadas públicas
ou participarem de um catálogo público. Um deles é o **padrão**, e responde
também em `/mcp`.

- Cria quem é `editor` ou `admin`, no painel (Servidores MCP) ou pelo
  MCP administrativo. Quem cria é o dono; mexem nele o dono, os
  administradores e quem recebeu `edit` (vínculos, portas e canvas) ou
  `manage` (nome, slug, aberto, chaves e concessões) no servidor. Apagar e
  transferir são do dono e do admin.
- Para cada skill vinculada escolhem-se as **três superfícies** (ferramentas,
  prompt, resource) **naquele servidor**. Vincular é o único jeito de uma
  skill ser **servida por um MCP**; no site ela entra também marcada pública
  ou por um catálogo público.
- O acesso é por chave `psv_…`, emitida por MCP e sem expiração; a chave de
  um virtual não abre outro.
  Um MCP pode ser marcado **aberto** (sem chave): aberto é público — o site o
  lista, com suas skills.
- `download_skill` e os arquivos binários apontam para o próprio servidor,
  atrás da mesma chave. Cada MCP tem contadores próprios por skill; o total da
  skill também soma.
- Desligar (`ligado` no painel) faz tudo sob `/virtual/<slug>` responder 404
  sem apagar nada; slug inexistente também é 404, chave errada é 401.
- **Clonar** um servidor copia vínculos, posições do canvas e concessões, e
  **não** as chaves `psv_`. A cópia nasce fechada, nunca assume o posto de
  padrão e exige `manage` no original
  ([Clonagem](#clonagem-uma-cópia-fechada)).

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
| `create_skill(name, description?, icon?, skill_md_content, tags?, slug?, mcps?, is_public?)` | Cria a skill (quem cria é o dono) e o SKILL.md na mesma transação, já publicada nos MCPs de `mcps` (só os que a credencial edita). `skill_md_content` é só o **corpo**. Sem `mcps` nenhum MCP a serve; com `is_public: true` ela aparece no site mesmo assim |
| `edit_skill(slug, {name?, description?, icon?, tags?, new_slug?, is_active?, is_public?})` | Edita metadados — é por aqui que muda o frontmatter. Nome, descrição, ícone e tags exigem `edit`; slug, `is_active` e `is_public`, `manage` |
| `link_skill(skill, mcp, asSkill, asPrompt, asResource)` / `unlink_skill(skill, mcp)` | Publica e despublica pelo lado da skill: `edit` no MCP virtual e `view` na skill |
| `set_file(slug, path, content)` | Cria ou sobrescreve um arquivo. Em `SKILL.md`, grava só o corpo |
| `set_files_bulk(slug, zip_base64, replace?, confirm_deletions?)` | Importa uma árvore inteira de um `.zip`, preservando os caminhos (só a pasta raiz única que contém o `SKILL.md` — o formato do pacote baixado — é desembrulhada; uma subpasta enviada sozinha fica como veio) — por padrão o zip é o **estado completo** (omitidos são removidos, `SKILL.md` preservado). Se algo sairia, a chamada é **recusada** com a lista: repita com `confirm_deletions` igual ao **número exato** de arquivos a remover, ou com `replace: false` para só acrescentar e sobrescrever |
| `delete_file(slug, path)` | Remove um arquivo (**bloqueado** para `SKILL.md`) |
| `delete_skill(slug, confirm)` | Remove a skill (exige `confirm: true`; só o dono ou um admin) |
| `share_skill(slug, username, level)` / `unshare_skill(slug, username)` / `transfer_skill(slug, username)` | Concede (`view`, `edit`, `manage`), revoga e transfere o dono; o mesmo para `*_catalog` e `*_mcp`. A conta é o **username**, nunca o e-mail |
| `clone_skill(slug, name?, new_slug?)` / `clone_catalog(slug, name?, new_slug?)` / `clone_virtual_mcp(slug, name?, new_slug?)` | Copia o objeto; quem clona vira o dono e a cópia **nasce fechada** (nunca pública nem aberta). A skill leva arquivos e tags e nasce flutuante; o catálogo leva os membros com a participação de cada um; o servidor leva vínculos, canvas e concessões, **sem** as chaves `psv_`. Sem `name` fica o nome do original, sem `new_slug` o desempate automático (`-2`, `-3`…); `new_slug` já ocupado é 409. Exige `edit` no original e o papel de criar — no servidor, `manage` |
| `list_tags()` / `get_stats()` | Navegação e métricas |
| `list_virtual_mcps(scope?)` / `get_virtual_mcp(slug)` / `create_virtual_mcp(…)` / `update_virtual_mcp(…)` / `delete_virtual_mcp(slug, confirm)` | MCPs virtuais — alcance pelo acesso por objeto |
| `set_virtual_mcp_skills(slug, [{slug, asSkill, asPrompt, asResource}])` | Substitui a lista inteira de skills do MCP virtual |
| `list_virtual_mcp_keys(slug)` / `create_virtual_mcp_key(slug, name)` / `revoke_virtual_mcp_key(slug, key_id)` | Chaves `psv_` do MCP virtual |
| `get_default_virtual_mcp()` / `set_default_virtual_mcp(slug \| null)` | Qual MCP virtual responde em `/mcp`; escolher é só admin |
| `list_catalogs()` / `get_catalog(slug)` / `create_catalog(…)` / `update_catalog(…)` / `delete_catalog(slug, confirm)` | Catálogos — alcance pelo acesso por objeto, como os MCPs virtuais |
| `set_catalog_skills(slug, [{slug, isActive?}])` | Substitui a lista inteira de skills do catálogo; `isActive: false` mantém sem entregar |
| `set_virtual_mcp_catalogs(slug, [{slug, asSkill, asPrompt, asResource}])` | Substitui a lista de catálogos do MCP virtual; exige `edit` no MCP e `view` em cada catálogo (os que saem da lista, só o `edit` do MCP) |

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
docker compose run --rm migrate   # a 020 e a 025 criam as tabelas rag_*
docker compose up -d              # o indexador sobe junto com os demais serviços
```

O indexador faz parte do `up -d` comum e fica **parado** enquanto o driver for
`off`: só publica o próprio estado e não fala com provedor nenhum. A trava do
envio é, portanto, **uma só** — o driver escolhido (no painel, ou semeado por
`RAG_DRIVER` no primeiro boot), com a chave dele no `.env` — e ligá-la vale para
o acervo inteiro, **inclusive as skills privadas**, a partir do ciclo seguinte.
Quem prefere que subir o indexador seja um gesto à parte descomenta
`profiles: [rag]` no serviço `indexer` do
[`docker-compose.yml`](docker-compose.yml) e passa a subi-lo com
`docker compose --profile rag up -d indexer`.

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

A API do site é aberta (CORS `*` por padrão; feche com `SITE_CORS_ORIGIN`) e
serve como alternativa ao MCP. Todas as rotas são `GET`, e todas mostram só o que
está público — skill vinculada a MCP virtual aberto, skill marcada pública ou
skill de catálogo público:

```
GET  /api/meta                                  nome, tagline e endereços da instalação
GET  /api/mcps                                  MCPs virtuais abertos, com endereço
GET  /api/catalogs                              catálogos públicos
GET  /api/catalogs/:slug                        detalhe + os membros ativos do catálogo
GET  /api/skills?q=&tag=&sort=&limit=&offset=   lista/busca
                                                a resposta traz `mode`: text ou hybrid
GET  /api/skills/:slug                          detalhe + corpo do SKILL.md (conta acesso)
GET  /api/tags                                  tags com contagem
GET  /api/skills/:slug/files/<caminho>          arquivo avulso
GET  /skills/:slug/files/<caminho>              o mesmo, sem o prefixo /api
GET  /skills/:slug/download                     pacote .zip        (conta download)
GET  /skills/:slug/download.skill               o mesmo ZIP, extensão do formato
                                                aberto de Agent Skills
GET  /api/skills/:slug/download                 aliases com /api dos dois
GET  /api/skills/:slug/download.skill           downloads; contam igual
GET  /healthz                                   saúde do serviço
```

Fora de `/healthz` e de `/assets/`, tudo aqui entra no limite por IP de
`SITE_RATE_LIMIT_MAX` (240 por minuto; `0` desliga).

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

## Quarentena: aprovar antes de publicar

Um pacote que veio de fora não precisa virar skill na hora. Ao importar um
pacote no painel — `.zip`, `.skill`, `.tar`, `.tar.gz`/`.tgz`, `.gz` ou
`.tar.zst`/`.tzst`/`.zst`, reconhecidos pela **assinatura** do arquivo e não
pela extensão —, quem importa escolhe o destino:

- **Direto para produção** — o comportamento de sempre: a skill nasce com nome,
  slug e tags do `SKILL.md`, e com os servidores que a tela oferecer.
- **Para a quarentena** — os arquivos ficam guardados como chegaram, esperando
  aprovação. Nada é publicado, indexado pela busca semântica nem aparece no
  site; nenhum agente alcança o conteúdo.

Um pacote pode trazer **várias** skills. Quem decide qual caso é o seu é a
**raiz** do pacote: com um `SKILL.md` nela, o pacote é uma skill só e tudo o
mais é conteúdo dela — inclusive o `SKILL.md` de exemplo que um template guarda
em `references/`. Sem `SKILL.md` na raiz, skill passa a ser cada diretório que
tenha um, levando junto os arquivos dele e das subpastas dele; diretório sem
`SKILL.md`, e fora de um que tenha, é ignorado por inteiro. Baixar o `.zip` do
repositório `obra/superpowers` no GitHub e importá-lo põe todas as skills dele
na fila, uma por diretório, ignorando `.github/`, `docs/` e o resto — e
"ignorado" é literal: **o que está fora do diretório de uma skill não entra em
envio nenhum**, nem mesmo quando o pacote traz uma skill só. Um pacote com duas
ou mais skills vai **sempre** para a quarentena: pedir produção é recusado, com
a contagem do que foi encontrado e o apontamento para a fila. `.rar`, `.7z`,
`.xz` e `.bz2` não são suportados, e a recusa diz isso com todas as letras em
vez de reclamar de arquivo inválido.

A quarentena é deliberadamente simples: um envio não tem slug, tag, ícone nem
vínculo, e o `SKILL.md` fica com o **frontmatter dentro dele** — é o arquivo
cru que se lê e se edita, até alguém aprovar. Dois envios podem ter o mesmo
nome; o que os distingue é o identificador e a data.

**Aprovar** cria a skill no acervo, com **quem aprovou** como dono, ainda sem
servidor nem catálogo (publicar é um passo à parte, depois), e tira o envio da
fila. Quem submeteu fica registrado na trilha de auditoria. Quem
pode aprovar é escolha da instalação, em **Configurações → Quarentena**:

| Opção | Quem aprova |
|-------|-------------|
| `admin` | só administradores |
| `admin+owner` (padrão) | administradores e quem submeteu o envio |
| `admin+editor` | administradores e editores |

Revisar e corrigir os arquivos de um envio é de quem o enxerga — o dono, os
administradores e os editores —, independente de quem aprova. Aprovar exige
também o papel de **criar no acervo** (editor para cima): aprovar é criar uma
skill. Criar uma skill **pelo formulário** continua indo direto para produção: o
portão existe para o pacote de terceiro.

Dentro da edição de uma skill já cadastrada entra **só arquivo de texto**, um a
um. Imagens e outros binários chegam pelo pacote, na importação — e **trocar a
árvore de uma skill que já existe** deixou de ter caminho no painel; quem
precisa disso usa o `set_files_bulk` do MCP administrativo. O desenho está em
[`docs/15-quarentena.md`](docs/15-quarentena.md).

## Clonagem: uma cópia fechada

Skill, catálogo e MCP virtual têm um botão **"Clonar"** — na ficha e na linha
da lista —, e as tools `clone_skill`, `clone_catalog` e `clone_virtual_mcp` no
MCP administrativo. O diálogo vem com nome e slug preenchidos e editáveis;
confirmar cria a cópia e abre a ficha dela.

| Tipo | O que a cópia leva |
|------|--------------------|
| **Skill** | Propriedades, arquivos e tags. Nasce **flutuante**: sem servidor, sem catálogo |
| **Catálogo** | Propriedades e os membros, cada participação com o ligado/desligado que tinha |
| **Servidor MCP** | Propriedades, vínculos de skill e de catálogo (as três portas e as posições do canvas) e as **concessões** |

Três regras valem para os três:

- **A cópia nasce fechada.** Nunca pública, nunca aberta, mesmo que o original
  seja — expor é um ato à parte, com o aviso de sempre. Ligado/desligado
  (`is_active`), esse sim, é copiado.
- **Quem clona é o dono**, e os contadores nascem em zero. O dono do original
  não ganha acesso à cópia: dono não é uma concessão, então não há o que
  copiar.
- **Chave `psv_` não é copiada.** O segredo nunca esteve no banco (só o hash),
  então uma chave duplicada não abriria nada. A cópia nasce sem chave.

Clonar exige `edit` no original **e** o papel de criar (`editor` ou `admin`);
no servidor MCP o mínimo é `manage`, porque a cópia leva a lista de concessões
e ler essa lista já é poder de `manage`. Não há clonagem profunda: clonar um
servidor não duplica as skills dentro dele. O desenho está em
[`docs/16-clonagem.md`](docs/16-clonagem.md).

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
a ser sempre por conta e senha.

Cada conta tem um **perfil**: o nome de exibição, uma foto e — se a pessoa
quiser — descrição, site e links. O bloco público é **opt-in**: desligado, nada
dele sai do painel; ligado, ele ganha página própria em `/u/<usuário>` no site,
com as skills e os catálogos que a pessoa já tinha tornado públicos. Quem
escreve é o dono da conta; um administrador só pode **limpar** um perfil, o que
fica na trilha de auditoria. Detalhes em
[`docs/20-perfil.md`](docs/20-perfil.md).

Cada conta tem um **usuário** (`@fulano`) e um **e-mail**, e os dois papéis são
diferentes. O usuário é o identificador público: é por ele que a conta aparece
como dona de uma skill, na lista de quem tem acesso, na trilha de auditoria, na
busca de "compartilhar com…" e na ficha pública do site. O e-mail é **privado** —
só a própria pessoa e os administradores o veem — e serve a três coisas: entrar,
recuperar a senha e casar a conta com uma identidade do SSO. No login, um campo
só aceita os dois: com `@` é lido como e-mail, sem `@` como usuário. O desenho
inteiro está em [`docs/19-username.md`](docs/19-username.md).

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
  `OIDC_ALLOWED_DOMAINS`**: com a lista vazia o SSO recusa **todo** login, até o
  de quem já tem conta e já entrava por ele — é de propósito, porque sem
  allowlist qualquer conta do provedor entraria como `membro` e leria tudo o que
  é público. Enquanto ela não estiver preenchida, só o login local funciona.
- **Redefinição de senha por e-mail** exige `SMTP_URL` + `SMTP_FROM`. Sem SMTP
  o painel continua completo: o administrador gera uma senha temporária, e a
  pessoa é obrigada a trocá-la no primeiro acesso.
- **Rate limiting no login** em duas camadas: janela em memória por IP e trava
  da conta (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_SECONDS`).
- **Linha de comando no servidor** (`purple-admin`), para quando ninguém
  consegue entrar no painel — o único admin esqueceu a senha e não há SMTP, a
  instalação ficou sem administrador, a conta está travada. Roda dentro do
  container do painel e passa pelas mesmas regras e pela mesma trilha de
  auditoria (ator `cli`):

  ```bash
  docker compose exec admin purple-admin help
  docker compose exec admin purple-admin user passwd admin@empresa.com      # sorteia uma temporária
  docker compose exec admin purple-admin user add --username ana --email ana@empresa.com --role editor
  docker compose exec admin purple-admin user role ana admin
  ```

  Também há `user list`, `show`, `disable`, `enable`, `unlock` e `logout`. Para
  informar a senha sem deixá-la no histórico, use `--password-stdin` (com
  `exec -T`). Referência completa em
  [`docs/21-cli-admin.md`](docs/21-cli-admin.md).

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

As variáveis estão documentadas em [`.env.example`](.env.example) — ele é a
lista, e quem passa a ler uma variável nova a acrescenta lá no mesmo commit. Os
segredos marcados com `/ _FILE` na tabela aceitam `<NOME>` ou `<NOME>_FILE`; os
do banco (`POSTGRES_PASSWORD`, `DATABASE_URL`, `PGPASSWORD`) e o
`INSPECTOR_API_TOKEN` só aceitam o valor direto:

| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `DATABASE_URL` | sim* | Conexão com o Postgres (senha percent-encodada). *Alternativa sem escape: `PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` — é o que o compose usa |
| `ADMIN_PASSWORD` / `_FILE` | sim (admin) | Senha de **bootstrap**: cria o primeiro administrador e depois fica inerte |
| `ADMIN_DOCS_URL`, `ADMIN_SUPPORT_URL`, `ADMIN_CHAT_URL` | não | Links externos da sidebar do painel; vazio some do menu (a documentação aponta para este README por padrão) |
| `ADMIN_BRAND_NAME`, `ADMIN_BRAND_ICON_URL` | não | Marca do painel: nome e ícone da sidebar, do login e da aba. O nome cai em `SITE_NAME`; o ícone aceita URL http(s) ou caminho do painel, e valor inválido derruba o boot |
| `MCP_SESSION_ONLINE_WINDOW_MS` | não | Janela em que um cliente do MCP público conta como online no painel (padrão 2 min); agrupa as requisições stateless de um mesmo cliente numa sessão |
| `MCP_MAX_SESSIONS`, `MCP_MAX_SESSIONS_PER_IDENTITY` | não | Sessões MCP em memória: teto do processo (padrão 500) e teto por credencial. Deixe o segundo **vazio** — o padrão dele é um décimo do primeiro (mínimo 10), e um número fixo desfaz essa relação. Estourar o teto da credencial fecha a sessão mais parada dela, e o cliente reabre. Num MCP virtual **aberto** todos os clientes sem chave são a mesma credencial e dividem esse teto (50 no padrão): para dar mais vagas a eles, suba o primeiro — o transporte sem sessão (`/mcp/stateless`) não ocupa vaga |
| `SITE_RATE_LIMIT_MAX`, `MCP_RATE_LIMIT_MAX` | não | Requisições por minuto por IP no site (240) e no MCP público (600); `0` desliga, para quem já limita no proxy. Quem chega com chave `psv_` não gasta a cota do endereço |
| `MCP_MAX_BATCH` | não | Mensagens aceitas num lote JSON-RPC (um POST cujo corpo é um array) no MCP público (padrão 20; `1` recusa todo lote de mais de uma mensagem). Acima disso a resposta é 400, e cada mensagem do lote gasta uma marca de `MCP_RATE_LIMIT_MAX`. Vale mesmo com o limite de taxa em `0`: o proxy também conta requisição, não mensagem |
| `MCP_MAX_STATELESS_SESSIONS` | não | Identidades stateless contabilizadas ao mesmo tempo (padrão 5000, mínimo 1 — aqui `0` não desliga, derruba o boot); atingido o teto, a requisição é atendida sem virar linha em `mcp_sessions` |
| `MCP_PUBLIC_JSON_LIMIT`, `MCP_ADMIN_JSON_LIMIT` | não | Teto do corpo JSON de cada MCP (1mb no público, 48mb no admin, de propósito). São duas para um valor só não levar o teto do admin à superfície anônima; `MCP_JSON_LIMIT`, o nome antigo, ainda vale como queda do admin e não chega mais ao público. Formato `64mb`, `512kb` ou inteiro de bytes — fora disso o serviço não sobe |
| `MCP_MAX_FILE_TEXT_BYTES`, `MCP_ADMIN_MAX_FILE_TEXT_BYTES` | não | Teto do texto que as leituras MCP devolvem **dentro** da resposta (4 MiB), nos dois MCPs; a segunda vale só para o admin e, vazia, acompanha a primeira. No público (`get_skill`, `get_skill_file`, `prompts/get`, `resources/read`) a resposta acima do teto é a URL de download — em `prompts/get` e `resources/read`, um erro que traz a URL, ou só o tamanho quando a skill não está nas ferramentas daquele servidor. No admin (`get_skill`, `get_file`), que não tem rota de download, `get_file` recusa com tamanho e tipo e `get_skill` omite o corpo e informa o tamanho |
| `SITE_CORS_ORIGIN` | não | Origens aceitas na API pública do site (padrão `*`); feche numa instalação que só deve ser lida de dentro. O cartão "API REST pública" da home acompanha ("CORS aberto" ou "CORS restrito"); a lista de origens não é publicada |
| `TRUST_PROXY` | não | Em quais proxies confiar no `X-Forwarded-*`. Vazio: um salto, e só quando quem abre a conexão é loopback ou faixa privada. Dois proxies internos em cadeia precisam declarar o valor |
| `MCP_PUBLIC_SERVER_NAME`, `MCP_ADMIN_SERVER_NAME` | não | Nome de cada MCP no handshake (`purple-skills` e `purple-skills-admin`); são duas para os dois servidores não aparecerem com o mesmo nome no `mcp.json` de quem conecta |
| `TAG`, `APP_VERSION` | não | Tag das imagens que o compose usa (padrão `latest`) e versão que os MCPs anunciam no handshake; preencha as duas com o mesmo valor |
| `APP_MEM_LIMIT`, `HOMEPAGE_MEM_LIMIT` | não | Teto de memória dos containers de aplicação (1536m) e da homepage (256m). Subiu `ZIP_MAX_UNCOMPRESSED_BYTES`? Suba o primeiro na mesma conta |
| `POSTGRES_MEM_LIMIT`, `DB_JOB_MEM_LIMIT` | não | Teto de memória do container do banco (2048m) e dos passos `migrate`/`seed` (512m), em `database/docker-compose.yml`. O do banco cobre as áreas compartilhadas, os 50 backends que o pool dos apps abre (`DB_POOL_MAX` × 5) e três autovacuum: subiu um desses, suba o teto — apertado demais, o OOM killer derruba o `postmaster` |
| `POSTGRES_BIND_ADDR` | não | Endereço em que a porta do Postgres é publicada (padrão `127.0.0.1`). **Não acompanha o `BIND_ADDR`**: nenhum app usa essa porta — todos falam com o banco pela rede interna —, e publicá-la expõe um servidor sem limite de tentativa de login nem trava de conta |
| `DB_POOL_MAX` | não | Conexões simultâneas no pool de cada app (padrão 10) |
| `ADMIN_SESSION_SECRET` / `_FILE` | recomendada | Chave do cookie de sessão (derivada da senha com scrypt se ausente). Gere com `openssl rand -hex 32` |
| `MCP_ADMIN_TOKEN` / `_FILE` | sim (mcp-admin) | Bearer token administrativo |
| `SITE_BASE_URL` | recomendada | Base da URL da página de uma skill pública, devolvida pelo MCP |
| `MCP_PUBLIC_URL`, `MCP_ADMIN_URL`, `ADMIN_URL` | não | Endereços mostrados na seção "Endereços de acesso" do site; vazio = o cartão some. `MCP_PUBLIC_URL` é a **base**, sem `/mcp` — o site acrescenta o sufixo ao mostrar o MCP público, e a mesma base monta os MCPs virtuais no painel e as URLs de download do mcp-public. `MCP_ADMIN_URL` e `ADMIN_URL` são o contrário: o endereço **completo**, mostrado como está — a do MCP administrativo já vem com o caminho do transporte (`https://mcp-admin.example.com/mcp`), porque é ela que vai para o `mcp.json` copiável do site; só com o host, o agente recebe 404 |
| `ADMIN_PUBLIC_URL` | recomendada (SSO e SMTP) | Base do `redirect_uri` do OIDC e do link de redefinição de senha. Sem ela o link só é montado para pedido vindo de rede interna; numa instalação exposta, `POST /api/password-reset/request` responde 503 e a redefinição passa a ser feita por um administrador. Também é a origem do próprio painel na checagem anti-CSRF das escritas, que confere nome **e porta**: necessária quando o proxy publica o painel numa porta que não repassa no `Host` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` / `_FILE` | não | Ligam o login por SSO (os três juntos) |
| `OIDC_ALLOWED_DOMAINS` | sim, com SSO | Domínios de e-mail autorizados; **vazia recusa todo login por SSO**, inclusive de contas que já existem e já estão vinculadas |
| `SMTP_URL` / `_FILE`, `SMTP_FROM` | não | Ligam a redefinição de senha por e-mail |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_SECONDS` | não | Trava da conta após tentativas erradas (padrão: 8 / 900s) |
| `RAG_DRIVER`, `RAG_MODEL` | não | Ligam a [busca semântica](#busca-semântica-opcional): `google`, `openai`, `voyage` ou `off`. Lidas **só pelo admin**, que as semeia no banco no primeiro boot — depois quem manda é o painel. Sem `RAG_MODEL`, vale o padrão do driver |
| `RAG_GOOGLE_API_KEY`, `RAG_OPENAI_API_KEY`, `RAG_VOYAGE_API_KEY` / `_FILE` | sim, com o driver ligado | A chave de cada provedor. Vão para o indexer, o mcp-public e o site; **nunca** para o painel. Mais de uma configurada permite trocar de driver sem recriar container |
| `RAG_GOOGLE_BASE_URL`, `RAG_OPENAI_BASE_URL`, `RAG_VOYAGE_BASE_URL` | não | URL base de cada provedor, já com a versão da API. Usada como está |
| `RAG_QUERY_TIMEOUT_MS`, `RAG_INDEX_INTERVAL_SECONDS`, `RAG_INDEX_TIMEOUT_MS` | não | Prazo do embedding da consulta (padrão 2000 ms), intervalo do indexador (padrão 30 s) e prazo de cada chamada ao provedor durante a indexação, tentativas incluídas (padrão 120000 ms) — nenhuma chamada ao provedor fica sem prazo |

Só o [`.env.example`](.env.example) é versionado, e com `CHANGE_ME` no lugar de
cada segredo — o CI reprova qualquer outro `.env*` que entre no índice. Como o
placeholder é público, as credenciais que autenticam alguém
(`ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, `MCP_ADMIN_TOKEN`) são **recusadas no
boot** enquanto estiverem com ele: o serviço não sobe, com a mensagem dizendo o
comando que gera um valor bom. Os
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
  upload de 64 MB (`ADMIN_MAX_UPLOAD_BYTES`), 256 MB descomprimidos por pacote
  (`ZIP_MAX_UNCOMPRESSED_BYTES` — orçamento **único**, descontado por cada
  camada de compressão aberta, o que deixa um `.tar.gz` com ~metade desse valor
  de conteúdo útil, contra o valor inteiro no `.zip`) e 32 MB de base64 no
  `set_files_bulk` (`MCP_MAX_ZIP_BASE64`). O teto de **entradas** deixou de ser
  um só: ~~512 entradas por requisição (`ZIP_MAX_ENTRIES`)~~ — a importação
  passou a usar `BUNDLE_MAX_ENTRIES` (20 000) para o pacote inteiro e
  `ZIP_MAX_ENTRIES` (512) por skill, com `BUNDLE_MAX_SKILLS` (200) limitando
  quantas skills traz o pacote **cuja raiz não é skill**, que é o único que vira
  várias; o `set_files_bulk`, que não passa por esse caminho, continua nos 512.
  A tabela inteira, com o que acontece ao estourar cada um, está na §10 de
  [`docs/15-quarentena.md`](docs/15-quarentena.md).
- Sem versionamento de arquivos (apenas um log de auditoria, sem restore).
- `audit_log` sem política de retenção.
- **Busca semântica sem índice vetorial.** A perna vetorial é varredura exata: o
  HNSW do `pgvector` para em 2000 dimensões e o modelo do Google tem 3072. Ligar
  a busca vale para o acervo inteiro (não há recorte de escopo), e não há como
  apagar os vetores de um espaço — o texto que fica órfão, esse sim, é coletado
  pelo indexador no fim de cada ciclo, com os vetores dele (migration `025`).
  Ver a §12.5 de
  [`docs/02-architecture-decisions.md`](docs/02-architecture-decisions.md).
- Com SSO ligado, a vinculação a uma conta local é sempre pelo e-mail: confie
  no provedor que você configurar e restrinja `OIDC_ALLOWED_DOMAINS`.
- Um MCP virtual aberto é público: o site o lista, com suas skills, sem
  confirmação. Endereço obscuro nunca foi proteção; quem não quer aparecer
  fecha o servidor e emite chaves.

## Licença

[MIT](LICENSE).
