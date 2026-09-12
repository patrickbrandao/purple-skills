# O MCP público é o vMCP padrão, e as skills flutuam

**Status: PR1 implementado; PR2 em andamento.** Dois PRs, como o `08`:

- **PR1 — "o MCP público é o vMCP padrão"** (`§3`): o servidor principal
  hard-coded em `/mcp` deixa de existir; o que responde ali é o MCP virtual
  escolhido em `settings`. Migration `011-mcp-padrao.sql`.
- **PR2 — "skills flutuantes"** (`§4`): `is_public` e as três `use_as_*`
  saem do banco; uma skill só é exibida — no MCP e no site — quando está
  vinculada a um vMCP. Migration `012`.

Este documento registra o desenho fechado na entrevista de 12/09/2026 e é a
referência de *por que* cada peça é assim; o resumo do que está no ar entra em
[`02-architecture-decisions.md`](02-architecture-decisions.md) e os desvios em
[`03-implementation-notes.md`](03-implementation-notes.md). Ele **revoga**
partes de [`06`](06-publicacao-mcp.md), [`07`](07-superficie-de-ferramentas.md)
e [`08`](08-mcp-virtual.md), marcadas em cada um.

## 1. Por que

Depois do `08`, o mcp-public servia dois modelos para a mesma coisa. O
**principal** (`/mcp`) lia por `is_public AND use_as_*` da skill, autenticava
por `MCP_PUBLIC_AUTH` (aberto, `MCP_PUBLIC_KEY` ou chaves `psp_`) e devolvia
downloads do site. O **virtual** (`/virtual/<slug>/mcp`) lia pelo vínculo,
autenticava por `is_open` ou chaves `psv_` e servia os próprios downloads. Uma
skill carregava quatro colunas que só o principal lia, e o vínculo carregava
três flags que só o virtual lia.

Três consequências pediam uma coisa só:

- **dois sistemas de publicação.** "Onde esta skill aparece?" tinha duas
  respostas com regras diferentes, e o painel mostrava as duas lado a lado;
- **o principal era o único servidor sem dono, sem recorte e sem chaves
  próprias**, e por isso tinha uma tabela de chaves só dele (`010`) e três
  variáveis de ambiente só dele;
- **a skill não flutuava.** Ela nascia "publicada" ou "privada" por uma coluna
  própria, em vez de ser um elemento que existe e aparece onde alguém a
  colocou.

O desenho unifica: **só existem vMCPs**, um deles responde também em `/mcp`,
e uma skill aparece onde está vinculada.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | `is_public` | Cai junto com as três `use_as_*` (PR2). Visibilidade é vínculo |
| 2 | Onde mora o padrão | Tabela `settings` chave-valor; a chave guarda o uuid, sem FK |
| 3 | Auth da raiz | Só a regra do próprio vMCP (`is_open` ou `psv_`); `public_mcp_keys`, `psp_`, `MCP_PUBLIC_AUTH` e `MCP_PUBLIC_KEY` saem |
| 4 | Migração | Cria o vMCP `public`, sem dono e **aberto**, com toda skill pública vinculada e as flags copiadas; marca como padrão. O mcp-public recusa subir com as variáveis antigas definidas |
| 5 | Site | Lista toda skill vinculada a um vMCP aberto e ligado; a página diz em quais e por quais portas; o site lista os vMCPs abertos com endereço (PR2) |
| 6 | Quem vincula | Só dono ou admin, em qualquer vMCP, sem exceção. `public` nasce órfão: só admin publica nele |
| 7 | Lado do vínculo | Pelos dois lados: página da skill, skill nova e import ganham "Publicar em"; `link_skill` / `unlink_skill` no mcp-admin (PR2). Revoga a decisão 12 de `08` |
| 8 | Ciclo de vida do padrão | Nenhum tratamento especial: pode ser fechado, desligado ou apagado. A raiz responde 404 com a causa |
| 9 | Confirmação de abertura | Removida nos dois sentidos, com a contagem de privadas (PR2). Revoga a decisão 6 e a `§3.3` de `08` |
| 10 | Listagem no site | Todo vMCP aberto e ligado é listado, sem opt-out (PR2). Revoga o item de `08 §9` |
| 11 | Seletor no painel | Página "Configurações", só admin; a lista de MCPs mostra o selo "padrão" |
| 12 | Entrega | Dois PRs |

Fechadas por derivação:

- **Regra do site (PR2).** O que conta é existir o vínculo com um vMCP aberto
  e ligado; as três flags do vínculo governam só as portas do MCP. A
  migração copia as flags como estão, e uma skill pública sem nenhuma
  superfície sumiria do site se a regra olhasse as flags.
- **Três causas de 404 na raiz.** Chave ausente em `settings` é "nenhum
  configurado"; uuid sem linha é "removido"; linha desligada é "desligado".
  `GET /` anuncia o slug do padrão ou a causa.
- **A raiz serve os próprios downloads.** `/skills/<slug>/download`, `.skill`
  e `/files/*` na raiz, espelhando `/virtual/`, atrás da mesma autenticação.
- **Servidor uniforme.** Nome `<MCP_SERVER_NAME>-<slug>` e as mesmas
  instruções em `/mcp` e em `/virtual/<slug>/mcp`.
- **Auditoria.** Ação nova `mcp.default`, com o slug ou `"nenhum"` como alvo.
  Os valores `public.key.*` ficam no CHECK porque há linhas gravadas.
- **Slug `public` ocupado.** A migração usa `public-2` em diante.
- **Seed.** Cria `public` aberto com as skills públicas de exemplo e o marca
  como padrão. Instalação nova sem seed começa com 404 na raiz.

## 3. O MCP padrão (PR1)

### 3.1 `settings`

Uma tabela chave-valor (`key`, `value`, `updated_at`), e uma chave por ora:
`default_virtual_mcp`, com o uuid do vMCP como texto. **Sem FK**, de
propósito: apagar o vMCP deixa o valor pendurado, e é isso que permite dizer
"o padrão foi removido" em vez de "nenhum padrão". A alternativa — coluna
`is_default` em `virtual_mcps` com índice único parcial — perderia essa
distinção e espalharia configuração da instalação por uma tabela de entidade.

### 3.2 A raiz é um ponto de montagem do vMCP padrão

`createHttpApp` já recebia dois *mounts* (`08 §4.1`). O da raiz deixa de ter
`auth`, `createServer` e rotas próprias: passa a usar **os mesmos** do mount
virtual, só que resolvendo o vMCP por `settings` em vez de pelo slug da URL.
`rootAuth` chama `resolveDefaultVirtualMcp()` a cada requisição, sem cache,
como `virtualAuth` chama `resolveVirtualMcp(slug)`; a partir daí a
autenticação é uma função só, `authenticateAgainst(mcp, req)`.

Consequências, todas deliberadas:

- **identidade da sessão.** A raiz reusa `virtual:<uuid>:open` /
  `virtual:<uuid>:key:<id>`: é o mesmo servidor em dois caminhos. Trocar o
  padrão no painel faz as sessões abertas na raiz deixarem de casar com a
  identidade nova e responderem 403 até o cliente reconectar — o mesmo que
  já acontece ao trocar de chave;
- **downloads.** As URLs que as ferramentas devolvem são montadas de
  `MCP_PUBLIC_URL` (ou da requisição) mais `req.baseUrl`, o prefixo do mount
  já resolvido: vazio na raiz, `/virtual/<slug>` no outro. O mesmo vMCP ganha
  URLs sob o caminho por onde foi chamado, e a raiz passa a servir
  `/skills/<skill>/download`, `.skill` e `/files/*` — antes ela apontava para
  o site, que só serve skill pública, e o padrão pode carregar privada;
- **nome e instruções.** `<MCP_SERVER_NAME>-<slug>` e as instruções do
  virtual, com a descrição do vMCP, em qualquer mount. A frase "o catálogo
  completo vive no MCP principal" sai: não existe mais esse lugar;
- **`GET /`.** Os metadados fixos ganham um bloco calculado por requisição:
  `defaultMcp: { status, slug, name, auth }`, com `auth` = `open` | `key`, ou
  `status` = `none` | `deleted` | `inactive` quando não há servidor.

### 3.3 Recusas

| Situação | Resposta |
|----------|----------|
| chave ausente ou nula em `settings` | 404 "Nenhum MCP padrão configurado: escolha um MCP virtual em Configurações, no painel" |
| valor sem linha em `virtual_mcps` | 404 "O MCP padrão foi removido: escolha outro…" |
| vMCP com `is_active = false` | 404 "O MCP padrão está desligado: religue-o ou escolha outro…" |
| vMCP fechado sem chave `psv_` dele | 401, como em `/virtual/` |

Distintas de propósito, e por isso 404 e não 503: quem configura um
`mcp.json` precisa saber se falta escolher o padrão, se ele foi apagado ou se
está desligado, e onde resolver. Um 503 faria alguns clientes ficarem
tentando de novo como se fosse transitório. Vale para `/mcp`, `/mcp/stateless`,
`/sse` e os downloads da raiz.

### 3.4 Fim das chaves `psp_` e das variáveis

Com a raiz autenticando pela regra do vMCP, `public_mcp_keys` (`010`) não tem
mais o que abrir: a tabela é removida no `011`, com o card "Chaves do MCP
principal" do painel, as três tools `*_public_mcp_key` e o esquema `psp` de
`apikey.ts`. Quem as usava emite chaves `psv_` na página do vMCP padrão. Os
valores `public.key.create` / `public.key.revoke` continuam no CHECK de
`audit_log` e no tipo `AuditAction` porque a trilha carrega linhas com eles.

`MCP_PUBLIC_AUTH`, `MCP_PUBLIC_KEY` e `MCP_PUBLIC_KEY_FILE` saem do
`.env.example` e do compose. O mcp-public **recusa subir** enquanto qualquer
uma estiver definida (`assertNoLegacyAuthEnv`), com uma mensagem que diz o que
fazer. Ignorá-las com um aviso no log abriria em silêncio um servidor que o
operador protegia, porque o `public` do backfill nasce aberto (`§3.5`).

### 3.5 Migração e trava de boot

Numa instalação que já tem skills, o `011` cria o vMCP `public` (ou
`public-N`, se o slug estiver em uso): sem dono, ligado, **aberto**, com toda
skill `is_public` vinculada e `as_skill`/`as_prompt`/`as_resource` copiadas de
`use_as_skill`/`use_as_prompt`/`use_as_resource`. Assim o `/mcp` de quem sobe
de versão publica exatamente o que publicava. Numa instalação sem skills nada
é criado — a raiz começa em 404, e o `seed` cria o `public`.

Por que aberto: é o padrão do `.env.example` e o estado da maioria das
instalações, e o site (que no PR2 só lista o que está em vMCP aberto) não
esvazia depois da migração. O caso raro — quem protegia o principal com
`MCP_PUBLIC_KEY` — é coberto pela trava de boot: o operador lê a mensagem antes
de o servidor responder qualquer coisa, fecha o `public` (ou emite chaves
`psv_` para ele) no painel, e só então remove a variável. A alternativa,
criar fechado, faria toda instalação aberta responder 401 e o site esvaziar
até um clique do admin; nasce aberto porque o custo do erro é maior do outro
lado, e a trava cobre o lado que importa.

Contadores do vínculo nascem em zero; o total da skill continua. O bloco é
idempotente: só roda quando `settings` ainda não tem a chave. Uma skill
pública sem nenhuma superfície entra com as três flags desligadas — continua
no vínculo, sem porta no MCP, como estava.

### 3.6 Painel, mcp-admin e site

- **Painel.** Página `/configuracoes` (só admin) com o seletor e o snippet de
  `mcp.json` resultante; `GET /api/settings` e `PUT /api/settings/default-mcp`
  atrás de `requireSettingsAdmin`. A lista e a página de cada MCP mostram o
  selo "padrão", e a página avisa, ao desligar ou remover o padrão, que `/mcp`
  passa a responder 404 — sem impedir. `VirtualMcpSummary.isDefault` vem da
  query.
- **mcp-admin.** `get_default_virtual_mcp()` (qualquer credencial) e
  `set_default_virtual_mcp(slug | null)` (só admin), no lugar das três tools de
  chave `psp_`. `list_virtual_mcps` e `get_virtual_mcp` mostram `isDefault`.
- **Site.** `/api/meta` ganha `mcp: { status, slug, name, description,
  requiresKey }`, resolvido a cada chamada. O cartão "MCP público" diz
  "leitura · sem token" ou "leitura · chave psv_", e explica o 404 quando não
  há padrão em pé; o `mcp.json` da seção de conexão inclui o header
  `Authorization` quando o padrão exige chave.

### 3.7 Estado intermediário: `is_public` e `use_as_*` ainda existem

O PR1 deixa as quatro colunas no banco e nas telas, mas **nenhum MCP as lê**:
a raiz recorta pelo vínculo. Até o PR2, `is_public` governa só o site e a API
REST; as três `use_as_*` não governam nada, e o painel e o mcp-admin dizem
isso onde as mostram. Uma skill privada vinculada ao `public` fica legível em
`/mcp` e fora do site — é o estado de dois sistemas que o PR2 elimina, aceito
para manter cada PR revisável e `main` com typecheck e testes passando.

## 4. Skills flutuantes (PR2)

### 4.1 Fim das colunas

Migration `012`: caem `skills.is_public`, `use_as_skill`, `use_as_prompt`,
`use_as_resource`, os índices parciais de `007` e o `skills_public_score_idx`
de `001`. `SkillSummary` perde os quatro campos e ganha `mcps` (em quais vMCPs
a skill está e por quais portas), o que quebra o typecheck de toda fixture e
das duas cópias manuais em `apps/*/web/src/api.ts`. `setVisibility`, a rota
`/visibility`, a tool `set_visibility` e a leitura de flags do frontmatter no
import saem; `create_skill` / `edit_skill` perdem `is_public` e `use_as_*`.

### 4.2 Site = vMCPs abertos

`listSkills`, `getSkillSummary`, `getSkillDetail` e `listTags` trocam
`includePrivate` por uma visibilidade `'open'` (padrão, o site) ou `'all'`
(painel e mcp-admin): a cláusula vira um `EXISTS` sobre `virtual_mcp_skills`
com `virtual_mcps.is_open AND is_active`, e o mesmo filtro vale para os
downloads. A página da skill lista os vMCPs abertos em que ela está, com as
portas; o site ganha uma seção com os vMCPs abertos e ligados, cada um com
endereço e snippet, e `/api/mcps` os expõe. `stats` troca públicas/privadas
por "em vMCP aberto" e "sem vínculo".

### 4.3 Vínculo pelos dois lados

A página da skill ganha um painel "Publicada em" editável, com os vMCPs que a
sessão pode administrar (dono ou admin, decisão 6) e as três caixas por linha;
o formulário de skill nova e o import ganham "Publicar em". `createSkill`
aceita `mcps` na mesma transação; `linkSkill` / `unlinkSkill` entram no
`@purple-skills/db`, e `link_skill` / `unlink_skill` no mcp-admin. A escolha
das superfícies continua obrigatória e sem default no banco; na tela, a caixa
`skill` já vem marcada ao acrescentar.

### 4.4 Fim de `confirm_open`

Sem `is_public` não há "skill privada" para contar: a confirmação de `08 §3.3`
sai nos dois sentidos, com `privateSkillCount` e o código
`confirm_open_required`. Abrir um vMCP é uma caixa como outra qualquer, e o
aviso ao lado dela diz que o site passa a listá-lo.

## 5. Riscos aceitos

- O `public` do backfill nasce aberto; a proteção de quem tinha
  `MCP_PUBLIC_KEY` é a trava de boot, que exige ler a mensagem (`§3.5`).
- Trocar o padrão derruba as sessões abertas na raiz com 403 até reconectar.
- No PR1, `is_public` e `use_as_*` existem sem efeito no MCP (`§3.7`).
- Todo vMCP aberto vira público de fato e listado no site (PR2); endereço
  obscuro nunca foi proteção, e o aviso ao abrir passa a dizer isso.

## 6. Fora do escopo

- Mais de uma chave em `settings` (nome do site, tagline…): a tabela aceita,
  a tela não oferece.
- Um vMCP que herde de outro, ou uma skill "publicada em todos".
- Estatísticas por vMCP além dos contadores do vínculo.
