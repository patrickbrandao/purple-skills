# Publicação de skills como prompt e resource do MCP

**Status: implementado.** Este documento registra o desenho fechado para os
dois campos de `skills` — `use_as_prompt` e `use_as_resource` — que controlam
**como** uma skill pública é oferecida no MCP, além de *se* ela aparece. É a
referência de *por que* cada peça é assim; o resumo do que está no ar entra em
[`02-architecture-decisions.md`](02-architecture-decisions.md), e os desvios
de implementação em [`03-implementation-notes.md`](03-implementation-notes.md).

O schema saiu na migration `007-publicacao-mcp.sql`; os cinco handlers e as
capabilities, em [`apps/mcp-public/src/server.ts`](../apps/mcp-public/src/server.ts)
e [`tools.ts`](../apps/mcp-public/src/tools.ts).

Os fatos do SDK citados aqui foram verificados contra
`@modelcontextprotocol/sdk` **1.30.0**, a versão instalada.

## 1. Por que

Hoje a skill tem **uma** dimensão de publicação, `is_public`, e **uma** forma
de ser consumida: as cinco ferramentas do MCP público. Um agente só chega ao
conteúdo chamando `get_skill`.

O protocolo MCP tem duas superfícies melhores para o caso:

- **prompt** — o cliente lista os prompts do servidor e o usuário invoca a
  skill diretamente (na maioria dos clientes, como *slash-command*). O corpo
  entra no contexto sem o agente precisar decidir chamar uma ferramenta.
- **resource** — a skill vira um endereço estável, `skill://<slug>`, que o
  cliente lê e referencia como qualquer outro documento.

Ligar isso para o catálogo inteiro seria pior que não ligar: um catálogo com
centenas de skills entope a lista de slash-commands de todo cliente conectado.
Daí as duas flags serem **opt-in por skill** — essa é a razão de existirem, e
não um detalhe de conveniência.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Flag em skill privada | Colunas ortogonais no banco; efeito só com `is_public` |
| 2 | MCP administrativo | Não expõe prompts nem resources — segue 100% ferramentas |
| 3 | Valor inicial | `false` nas duas, para skill nova, seed e base existente |
| 4 | Nome do prompt | O **slug puro** |
| 5 | URI do resource | `skill://<slug>` |
| 6 | Conteúdo do resource | `composeSkillMd` — o SKILL.md canônico, `text/markdown` |
| 7 | Conteúdo do prompt | Uma mensagem `role=user` com o corpo sem frontmatter |
| 8 | Argumentos do prompt | Nenhum |
| 9 | Contadores | `resources/read` e `prompts/get` incrementam `view_count` |
| 10 | Registro no SDK | Handlers de baixo nível para prompts **e** resources |
| 11 | `createServer` | Continua **síncrona** |
| 12 | `listChanged` | Não declarado — não há notificação |
| 13 | Teto da lista | Sem teto; query dedicada e enxuta no `@purple-skills/db` |
| 14 | `resources/templates/list` | Handler presente, lista vazia |
| 15 | Anexos como resource | Fora do v1 |
| 16 | Erro no `resources/read` | Um só, indistinto |
| 17 | `search_skills` | Inalterado |
| 18 | `INSTRUCTIONS` | Fluxo de ferramentas intacto + parágrafo novo |
| 19 | Escrita das flags | Caminhos de metadados existentes; sem rota nem tool nova |
| 20 | Painel | Checkboxes editáveis mesmo em privada, com aviso |
| 21 | Auditoria | `action: 'update'`, `previous_content` nulo |
| 22 | Frontmatter | Canal de mão única: o import lê, o export não escreve |
| 23 | API pública do site | Campos no payload + selo no card do catálogo |
| 24 | Entrega | PR único atravessando os cinco donos |

## 3. Semântica das flags

### 3.1 Ortogonais no banco, condicionadas na leitura

As duas colunas **não** dependem de `is_public` no banco: nada de CHECK. Quem
condiciona é a consulta do MCP público, que filtra
`is_public AND use_as_prompt` (ou `use_as_resource`).

O motivo é operacional. Com um CHECK, despublicar uma skill flagada falharia
ou exigiria zerar as flags junto — e a intenção do admin ("quando eu publicar,
quero que ela seja um prompt") seria perdida no caminho. Ortogonais, o ciclo
publicar → despublicar → republicar preserva a configuração.

O corolário é que **a flag sozinha nunca publica nada**. `use_as_resource` numa
skill privada não cria um `skill://` legível: não existe segunda porta de
visibilidade além de `is_public`.

### 3.2 Valor inicial

`DEFAULT false` na migration, sem UPDATE de dados. Nem a base existente nem o
seed nascem flagados. Ligar o catálogo inteiro de uma vez é exatamente o que a
`§1` diz que a feature existe para evitar.

### 3.3 Identidade

O prompt é publicado com **o slug puro** (`conventional-commits`), não um nome
prefixado nem o nome de exibição. O slug já é o nome oficial da skill — vai no
`name:` do frontmatter, na URL e nos argumentos das ferramentas — e já é
validado como `a-z0-9-`, que é a forma que um nome de prompt precisa ter.
Prefixar seria redundante: os clientes já qualificam os prompts pelo nome do
servidor.

A URI do resource é `skill://<slug>`. Verificado: `new URL()` do Node analisa
`skill://conventional-commits` sem normalizar nada — host é o slug, path vazio,
nenhuma barra sobrando.

## 4. O que trafega

### 4.1 Resource

O resource **é o arquivo SKILL.md**: `composeSkillMd(skill, corpo)`, com
`mimeType: text/markdown`. Byte a byte o mesmo conteúdo que o download do
`.zip` e o `GET /files/SKILL.md` já entregam, com o frontmatter gerado dos
metadados conforme a `§3.5` de
[`02-architecture-decisions.md`](02-architecture-decisions.md).

O que **não** foi escolhido, e por quê: devolver o cabeçalho navegável que a
ferramenta `get_skill` monta (nome, tags, links, lista de anexos) faria do
resource uma terceira variante do mesmo conteúdo, duplicando em `resources/`
o que a ferramenta já faz.

### 4.2 Prompt

Uma única mensagem, `role=user`, com `stripFrontmatter(skillMd)` — sem
cabeçalho, sem bloco YAML. Nome e descrição já viajam nos metadados do próprio
`prompts/list`; repeti-los no corpo é ruído que o modelo lê como instrução.
Jogar o frontmatter no contexto seria desfazer justamente o que a `§3.5` tira
das leituras de conteúdo.

**Sem argumentos.** Uma skill é instrução estática: `prompts/get` é uma leitura
pura, slug entra e texto sai. Sem `argsSchema` não há `completable`, não há
capability de `completions` para declarar, e não se inventa um contrato que
nenhuma skill do catálogo declara.

### 4.3 Contadores

As duas superfícies **incrementam `view_count`**. A `§6` de
[`02-architecture-decisions.md`](02-architecture-decisions.md) já decide que
todo acesso conta, sem deduplicação, em qualquer superfície — site, API REST e
`get_skill`. Ler a skill por resource ou invocá-la por prompt é acesso do mesmo
jeito, e aquela seção passou a nomear as duas novas.

## 5. Implementação no mcp-public

### 5.1 Por que handlers de baixo nível

`ResourceTemplate` resolveria os resources com elegância: um único
`skill://{slug}` com `list` callback consultando o banco. Prompts **não têm
equivalente** — `prompts/list` é montado do registro estático do `McpServer`,
e uma lista dirigida por dados exigiria `registerPrompt` por skill na criação
do servidor.

Isso custaria caro: `createServer` teria de virar assíncrona, tocando três
call sites em `apps/mcp-public/src/http.ts` e três em
`apps/mcp-admin/src/http.ts` (são cópias divergentes, os dois mudariam), com
uma consulta por sessão no `initialize` e a lista congelada por até
`MCP_SESSION_TTL_MS` — 30 minutos por padrão.

A escolha é `server.server.setRequestHandler` para `ListPrompts`, `GetPrompt`,
`ListResources`, `ReadResource` e `ListResourceTemplates`. A fábrica continua
síncrona, os dois `http.ts` ficam intocados, e a lista é computada por
requisição: uma skill flagada agora aparece na próxima chamada, mesmo em sessão
antiga.

Resources vão pelo mesmo caminho — não por necessidade, mas por simetria e
controle: um estilo só no arquivo, e nada de declarar uma capability para
desdizê-la em seguida (ver `§5.2`). O match de `skill://{slug}` vira um
`startsWith` mais um slug já validado.

**Não misturar.** `assertCanSetRequestHandler` lança erro quando um handler já
existe, então um `registerPrompt` ou `registerResource` esquecido no mesmo
servidor derruba o processo no boot. É falha alta e cedo, e não silenciosa.

### 5.2 Capabilities e `listChanged`

`registerCapabilities({ prompts: {}, resources: {} })` na mão, **sem**
`listChanged`, antes do `connect` (depois o SDK lança).

O SDK declara `listChanged: true` fixo no código, dentro de
`setResourceRequestHandlers`. Como admin e mcp-public são containers separados,
não existe evento em processo para disparar a notificação — e um cliente que
confia na promessa pode cachear a lista pela sessão inteira e nunca ver uma
skill nova. Declarar o que não se cumpre é pior que não declarar.

A alternativa descartada foi `LISTEN/NOTIFY` do Postgres: conexão dedicada no
pool e fanout por sessão, para um ganho que a re-listagem já cobre.

As duas capabilities são declaradas **incondicionalmente**, mesmo sem nenhuma
skill flagada — a fábrica é síncrona e não consulta o banco.

### 5.3 A lista não é paginada

Verificado: o SDK espalha o resultado do `list` num array só e devolve sem
`nextCursor`. `resources/list` e `prompts/list` entregam o catálogo flagado
inteiro numa resposta, e **não há teto**: o catálogo é self-hosted e o admin
liga as flags uma a uma, então truncar em silêncio seria pior que uma resposta
grande.

É justamente por não haver teto que a linha precisa ser barata. A lista sai de
uma **função nova** no `@purple-skills/db` devolvendo só `slug`, `name` e
`description`, apoiada em índices parciais. Reusar `listSkills` seria errado
duas vezes: ela clampa em 100 ([`queries.ts:81`](../database/src/queries.ts))
— escondendo skills flagadas em silêncio — e carrega por linha uma agregação
de tags e uma contagem de arquivos que as duas listas jogam fora.

### 5.4 `resources/templates/list`

Handler presente, devolvendo lista vazia. Responde ao método (nada de *method
not found* para o cliente que sonda na inicialização) sem anunciar que
`skill://qualquer-coisa` é legível — só as flagadas são, e essas já aparecem
uma a uma em `resources/list`.

### 5.5 Erros

`resources/read` numa skill privada, inexistente ou pública sem a flag devolve
**a mesma** mensagem de não encontrado. É o comportamento que `get_skill` já
tem hoje — `getSkillDetail` com `includePrivate: false` devolve nulo nos dois
primeiros casos — e não entrega os slugs privados a quem sonda um servidor que
por padrão roda sem autenticação.

### 5.6 `INSTRUCTIONS`

O fluxo de quatro passos que começa em `search_skills` continua inteiro, e
ganha abaixo um parágrafo dizendo que algumas skills também estão publicadas
como prompt (pelo slug) e como resource `skill://<slug>`, e que `prompts/list`
e `resources/list` mostram quais.

Esse texto carrega mais peso do que parece: `search_skills` fica **inalterado**
(decisão 17), sem mencionar as flags nos resultados. Ferramentas e prompts são
superfícies separadas, cada uma com sua listagem — então as `INSTRUCTIONS` são
o único ponteiro que o agente tem de que as outras duas portas existem.

## 6. Superfície de escrita

### 6.1 Nenhuma rota nova, nenhuma ferramenta nova

As flags entram nos caminhos de metadados que já existem: `PATCH
/api/skills/:slug`, `POST /api/skills` e a ferramenta `edit_skill` /
`create_skill` do MCP administrativo. Não há `POST
/api/skills/:slug/publication` nem `set_publication` espelhando o par
`/visibility` + `set_visibility`.

O par de visibilidade existe porque a listagem do painel alterna público e
privado sem abrir a skill. As flags novas não pedem isso: são configuração
secundária, e o formulário de edição basta. Na listagem elas aparecem como
**selo só-leitura**.

### 6.2 Painel

Dois checkboxes no `SkillMetaForm`, ao lado do de visibilidade, **editáveis
mesmo enquanto a skill for privada**, com uma linha de aviso explicando que
sem "pública" nada aparece no MCP.

Desabilitá-los obrigaria a salvar duas vezes — publicar e depois flagar — e
apagaria da tela a intenção de quem está preparando uma skill para lançar. A
decisão `§3.1` (colunas ortogonais) é o que torna isso coerente: o estado
"privada, mas será prompt quando publicar" é representável.

### 6.3 Auditoria

Mudança de flag grava `action: 'update'` com `previous_content` nulo, que é
exatamente o que `updateSkill` já faz para nome, descrição, tags e slug. Se as
flags mudarem junto com os metadados, sai **uma linha só**, como hoje.

Uma ação própria no log exigiria mais um `ALTER` no `audit_log_action_check` —
constraint já reescrita em `004-contas.sql` — e um valor novo em `AuditAction`,
tipo compartilhado por `shared`, `db`, `admin` e `mcp-admin`.

### 6.4 Frontmatter: canal de mão única

`skillMetaFromMarkdown` passa a **ler** `use_as_prompt` e `use_as_resource`
quando um `.zip` externo os traz. `buildFrontmatter` **não** os escreve: nenhum
`.zip` gerado por este catálogo menciona as flags, e o conteúdo do resource
(`§4.1`) segue com o frontmatter de hoje.

Por que ler é seguro: `is_public` no import vem exclusivamente do formulário,
então um `.zip` de terceiro **não consegue se autopublicar** — ele no máximo
pré-configura flags que ficam inertes até o admin marcar "pública" (`§3.1`). E
o alcance é mínimo: `skillMetaFromMarkdown` é chamado em **um único lugar** do
projeto, o import de `.zip` em [`api.ts`](../apps/admin/src/api.ts).
`set_files_bulk` e `PUT /files/SKILL.md` apenas descartam frontmatter, sem ler
nada dele.

Dois detalhes de implementação:

- **Não há chave a escolher.** `parseFrontmatter` monta um mapa **raso**: uma
  chave na raiz e a mesma chave indentada sob `metadata:` caem no mesmo lugar.
  Ler `data['use_as_prompt']` aceita as duas formas sem código extra.
- **Coerção**: o valor chega como texto. Liga só com `'true'`, espelhando o
  `body.isPublic === 'true'` que o import já usa.

Consequência a não esquecer: `MarkdownSkillMeta` ganha dois campos, e o teste
de round-trip de `packages/shared/src/frontmatter.test.ts` compara com
`toEqual` — ele precisa ser ajustado.

## 7. Site e API pública

Os campos entram no payload de graça, via `toSummary`: é mudança **aditiva** do
contrato da API REST aberta. O card do catálogo ganha um selo `prompt` /
`resource`, e o `Connect.tsx` — que hoje ensina o `mcp.json` — passa a explicar
que essas skills viram slash-command e `skill://` no cliente.

Sem isso a feature ficaria invisível para quem chega pelo site, que é onde o
usuário aprende a conectar o agente.

## 8. Impacto e entrega

### 8.1 Por que um PR só

`SkillSummary` é o tipo compartilhado por `db`, `admin`, `site` e os dois MCPs.
Acrescentar dois campos obrigatórios quebra o typecheck de **todo literal que o
constrói** — inclusive as fixtures de `apps/mcp-public/src/tools.test.ts`,
`apps/mcp-admin/src/tools.test.ts` e `database/src/files.integration.test.ts`.

Um PR só do dba deixaria `main` sem `npm test` passando, que é o que
[`AGENTS.md`](../AGENTS.md) proíbe entregar. A alternativa — campos opcionais
primeiro, apertados depois — trocaria isso por um período com o tipo frouxo e
por um passo fácil de esquecer.

### 8.2 O trabalho, por dono

**`database/` — agente dba, e nada mais começa antes dele**

- Migration `007-…sql`: duas colunas `BOOLEAN NOT NULL DEFAULT false` e índices
  parciais sobre `(is_public, use_as_prompt)` e `(is_public, use_as_resource)`.
- `src/schema.ts` (tipagem), `SKILL_COLUMNS` e `toSummary` em `src/queries.ts`.
- `CreateSkillInput`, `UpdateSkillInput` e **três** statements: o `INSERT` de
  `createSkill` e os dois `UPDATE` — `updateSkill` e `updateSkillWithContent`.
  O segundo é o fácil de esquecer.
- A função de listagem da `§5.3`.
- `src/seed.ts`: as skills de exemplo declaram as duas flags como `false`.

**`packages/shared`** — `SkillSummary` e `MarkdownSkillMeta` ganham os campos;
`skillMetaFromMarkdown` passa a lê-los; `buildFrontmatter` **não** muda.

**`apps/mcp-public`** — o grosso: os cinco handlers, as capabilities, os
contadores e as `INSTRUCTIONS`.

**`apps/mcp-admin`** — os campos em `create_skill` e `edit_skill`, os valores
nos retornos de `list_skills` e `get_skill`, e uma linha nas `INSTRUCTIONS`.

**`apps/admin`** — `POST /api/skills`, `PATCH /api/skills/:slug` e o import
multipart; no painel, `SkillMetaValues`, `SkillMetaForm`, `NewSkillPage`,
`SkillEditorPage` (inclusive a comparação de *dirty*), `SkillViewPage`,
`SkillsPage` e `DashboardPage`.

**`apps/site`** — selo no card e o texto do `Connect.tsx`.

⚠️ `apps/admin/web/src/api.ts` e `apps/site/web/src/api.ts` mantêm **cópias
manuais** de `SkillSummary` — são bundles de browser e não importam de
`shared`. O typecheck não acusa a falta dos campos se eles só forem lidos:
sincronizar é manual.

### 8.3 Testes

Unitários dos handlers novos, no padrão de `tools.test.ts` (com
`@purple-skills/db` mockado):

- `prompts/list` e `resources/list` omitindo skill privada e skill pública sem
  a flag;
- `resources/read` devolvendo o `composeSkillMd` canônico;
- `prompts/get` devolvendo o corpo **sem** frontmatter;
- incremento de `view_count` nas duas superfícies;
- o erro indistinto da `§5.5`.

Mais as fixtures dos dois apps e o teste de round-trip do `shared` (`§6.4`).

## 9. Fora do v1

- **Anexos como resource** (`skill://{slug}/{path}`). A ferramenta
  `get_skill_file` já cobre o caso, e um resource por arquivo multiplicaria a
  listagem — sem teto (`§5.3`), a resposta cresceria rápido. Um segundo
  template somado depois não quebra o primeiro.
- **`notifications/*/list_changed`** — ver `§5.2`.
- **Argumentos de prompt declarados pela skill** — parser, validação, campo no
  banco e UI no painel: é uma feature inteira, não um acréscimo a esta.
- **Filtro por flag no `search_skills`** — decisão 17.
