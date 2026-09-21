# A extensão de skills do MCP: a skill servida como resource conformante

**Status: em implementação**, num PR. Entrevista de 21/09/2026.
**Sem migration** — ver `§9`.

Este documento registra *por que* cada peça é assim; o resumo do que entrar no
ar vai para [`02-architecture-decisions.md`](02-architecture-decisions.md)
§12.8, e os desvios para
[`03-implementation-notes.md`](03-implementation-notes.md).

A referência normativa é a
[SEP-2640](https://modelcontextprotocol.io/seps/2640-skills-extension), em
status **Final**, que define como servir skills do padrão
[agentskills.io](https://agentskills.io/specification) sobre a primitiva
Resources do MCP.

> **Revoga dois pontos de [`06`](06-publicacao-mcp.md):** a decisão 5 (a URI do
> resource é `skill://<slug>`) e a decisão 15 (anexos como resource, fora do
> v1), com o item correspondente da `§9` dele. Os dois estão marcados lá, e o
> cabeçalho daquele documento leva a marca. A `§1`, a `§3.3` e a `§5.6` também,
> porque citam a URI antiga.
>
> **E um ponto de [`07`](07-superficie-de-ferramentas.md):** o item da `§7` que
> punha `skill://{slug}/{path}` fora do escopo. A revogação é **parcial**, e a
> parte que fica de pé importa: o endereço passou a existir, mas a "quarta
> superfície" que aquele item descrevia continua não existindo — quem governa o
> endereço novo é a porta `as_skill` (`§4.2`).
>
> **Não revoga mais nada.** A checagem foi ponto a ponto em
> [`08`](08-mcp-virtual.md),
> [`09`](09-mcp-padrao-e-skills-flutuantes.md), [`11`](11-catalogos.md),
> [`12`](12-acesso-granular.md), [`13`](13-fichas-e-acessos.md) e
> [`15`](15-quarentena.md): o recorte por vínculo, a precedência do vínculo
> direto sobre o catálogo, as três portas, a recusa indistinta, o registro de
> acessos e a quarentena continuam valendo inteiros. Registrar a ausência é
> parte da regra de [`AGENTS.md`](../AGENTS.md): quem revoga enumera, e quem
> não revoga diz que conferiu.

Os fatos do SDK citados aqui foram verificados contra
`@modelcontextprotocol/sdk` **1.30.0**, a versão instalada. Os fatos do
protocolo, contra a revisão **2026-07-28**, que é a corrente — e que o SDK
ainda não fala (`§8`).

## 1. Por que

Este projeto serve skills desde o primeiro dia, mas de um jeito que só ele
entende. Um agente que chega no MCP público precisa aprender **quatro
ferramentas próprias** — `search_skills`, `get_skill`, `get_skill_file`,
`download_skill` — para fazer o que o host dele já sabe fazer com skill de
disco: listar, ler o `SKILL.md`, abrir um arquivo de apoio.

Enquanto isso, o `06` publicou a skill como resource numa URI inventada,
`skill://<slug>`, e a SEP-2640 registra que várias implementações fizeram
exatamente a mesma coisa, cada uma com uma estrutura diferente, e que todas
terão de se ajustar. O custo de não se ajustar é concreto:

- **o host não reconhece a skill como skill.** Ele lê um markdown num endereço
  opaco; não monta registro, não pede aprovação por skill, não marca a origem
  no contexto do modelo. Tudo o que a SEP exige do host depende de a skill
  chegar identificada;
- **os arquivos de apoio não existem para o host.** Um `SKILL.md` que diz
  "escolha o modelo certo em `templates/`" é uma instrução morta, porque o
  único jeito de ler `templates/x.md` é a ferramenta proprietária
  `get_skill_file`, que o host não sabe amarrar àquela skill;
- **não há integridade.** O host não tem como saber se o que ele leu é o que
  foi anunciado, e a SEP faz disso a base da aprovação ligada a conteúdo.

A extensão resolve os três com três chamadas e uma convenção de endereço. E o
que ela pede, este projeto quase todo já tem: o hash por arquivo veio de graça
com a `020`, o tamanho existe desde a `001`, e o recorte por vínculo já é
exatamente a pergunta "que skills este servidor serve".

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Papel | Só servidor. Consumir skills de MCP externo fica fora do v1 |
| 2 | Porta do vínculo | `as_skill` governa `skills/*`, a leitura por arquivo e o `directory/read` |
| 3 | Manifesto | Real: `{uri, digest, size}` por arquivo, não `"dynamic"` |
| 4 | Skill acima dos tetos da SEP | Servida assim mesmo; o painel avisa |
| 5 | `as_resource` | Repontada para `skill://<slug>/SKILL.md`. A URI antiga morre |
| 6 | Digest do `SKILL.md` | Calculado por requisição, pelo mesmo `composeSkillMd` que serve o conteúdo |
| 7 | `skills/list` | Sem cursor e sem teto, como as outras duas listagens |
| 8 | `resources/list` | Uma entrada por skill (o `SKILL.md`), governada **só** por `as_resource` |
| 9 | Binário | `blob` base64 no `resources/read`, sob o teto de texto |
| 10 | `directoryRead` | Implementado no v1; `true` na capability |
| 11 | Origem da listagem de diretório | Derivada em TypeScript de `listFiles`; nenhum SQL novo |
| 12 | Escopo do `directory/read` | Só `as_skill`; o resto é `-32602` |
| 13 | Contadores | Só o `SKILL.md` conta. Auxiliar, `skills/list` e `skills/get` não contam |
| 14 | `frontmatter` da entrada | Espelho exato do `buildFrontmatter` atual, `tags` como string |
| 15 | `license` / `allowed-tools` / `compatibility` | Fora do v1, e `allowed-tools` **nunca** é emitido |
| 16 | Skills aninhadas | Não publicadas; `SKILL.md` em subdiretório é arquivo de apoio |
| 17 | `resultType` | Emitido, `"complete"` |
| 18 | `ttlMs` | Emitido, **`0`** |
| 19 | `cacheScope` | Derivado de `is_open`: `"public"` aberto, `"private"` fechado |
| 20 | Alcance dos campos de 2026-07-28 | Handlers próprios mais `skills/*`; `tools/list` fica fora |
| 21 | Manifesto no banco | Função nova dedicada, no precedente do `listPublishedSkills` |
| 22 | Ferramentas atuais | Intactas; muda só o texto das `instructions` |
| 23 | mcp-admin | Não declara a extensão |
| 24 | Cache do digest | Nível de módulo, com teto, chave `(uuid, updated_at)` |
| 25 | `SKILL.md` acima do teto de leitura | `"resources": "dynamic"` naquela entrada |
| 26 | Entrega | PR único, quatro donos |

Fechadas por derivação:

- **Nenhuma migration.** `files.content_sha256` veio da `020`, `size_bytes` da
  `001`, e nenhuma decisão acima cria coluna, CHECK ou valor de enum. A decisão
  13 é o que garante isso do lado dos acessos: contar o `SKILL.md` como
  `view`/`resource` reusa o valor que já existe no CHECK da `018`.
- **`-32602` já é o erro do projeto.** `naoEncontrado`
  ([`tools.ts`](../apps/mcp-public/src/tools.ts)) monta um
  `McpError(ErrorCode.InvalidParams)`, que é o código que a SEP manda usar — e
  com a recusa indistinta da `§5.5` do `06`, que não entrega slug a quem sonda
  um servidor aberto.
- **O slug já serve de `reg-name`.** A SEP pede que o primeiro segmento do
  caminho seja um `reg-name` válido de RFC 3986; o slug é `a-z0-9-` com teto de
  96 caracteres.
- **`resources/templates/list` continua vazia.** O motivo da `§5.4` do `06`
  ficou mais forte, não mais fraco: agora `skill://` qualquer é ainda menos
  legível, porque só arquivo de skill `as_skill` responde.
- **A capability é declarada incondicionalmente**, antes do `connect`, na mesma
  chamada de `registerCapabilities` das duas atuais — a fábrica é síncrona e
  não consulta o banco, e a SEP admite listagem vazia.
- **O servidor já declara `resources`**, que a SEP exige de quem declara a
  extensão.

## 3. O que a SEP-2640 exige

Em uma página, para quem for implementar sem reler a SEP inteira:

1. **Endereço.** Cada arquivo da skill é um resource. A URI é
   `skill://<caminho-da-skill>/<caminho-do-arquivo>`, e o último segmento do
   caminho da skill **tem de ser** o `name` do frontmatter. A raiz da skill é a
   mesma URI sem `/SKILL.md`, sem barra final, e é um **diretório**
   (`mimeType: inode/directory`).
2. **`skills/list`.** Obrigatório para quem declara a extensão. Devolve as
   entradas; cada uma traz `uri` (a do `SKILL.md`), `frontmatter` (cópia
   verbatim, como JSON) e `resources` — a lista completa de `{uri, digest,
   size}` de **todos** os arquivos, ou a string `"dynamic"`.
3. **`skills/get`.** Obrigatório. Recebe `uri` e devolve a mesma entrada,
   inclusive para skill ausente da listagem. URI que o servidor não serve é
   `-32602`.
4. **`resources/directory/read`.** Opcional, atrás de `directoryRead: true`.
   Recebe a URI de um diretório e devolve os filhos **diretos**, com
   subdiretório marcado como `inode/directory`.
5. **Integridade.** `digest` é `sha256:<64 hex minúsculos>` dos bytes crus.
   O host **tem de** verificar toda leitura contra a entrada, e uma leitura
   cujo tamanho difere do `size` já é falha, antes mesmo do hash. O
   `frontmatter` do JSON tem de bater campo a campo com o do `SKILL.md` lido.
6. **Tetos.** 512 arquivos e 16 MiB somados por skill. São `SHOULD NOT` para o
   servidor e `MUST` para o host, que precisa aguentar até ali.
7. **O que a SEP não faz.** Não define forma empacotada de retirada — arquivo
   único, um por vez, e o apêndice de recursos adiados explica que os archives
   foram removidos na revisão por serem superfície de ataque no
   desempacotamento. Também não redefine o formato da skill: isso é
   agentskills.io, e muda por lá.

A parte da SEP dirigida ao **host** — origem visível ao modelo, aprovação por
skill, `allowed-tools` ignorado, cache isolado da descoberta de skills locais —
não é trabalho deste projeto no v1 (decisão 1), mas é o que explica a decisão
15: um servidor que nunca emite `allowed-tools` é um servidor que nunca pede
elevação de privilégio no host de quem o consome.

## 4. URIs, portas e recorte

### 4.1 O endereço

```
skill://<slug>/SKILL.md
skill://<slug>/references/exemplos.md
skill://<slug>/scripts/extrai.py
skill://<slug>                        (o diretório-raiz)
```

**Sem prefixo organizacional.** A SEP permite qualquer profundidade antes do
nome da skill, e a tentação é usar o slug do vMCP. Não vale a pena: cada vMCP
já **é** um servidor MCP distinto — ponto de montagem próprio
(`/virtual/<slug>/mcp`) e `serverInfo.name` sufixado pelo slug (`09`) — e a SEP
é explícita em que a identidade de uma skill é o par *(identidade do servidor,
URI)*, nunca a URI sozinha. O prefixo só acrescentaria segmento sem
acrescentar distinção. E o slug é único na instalação, então não há colisão a
desempatar.

O último segmento é o slug, e o `name` do frontmatter composto é o slug
([`buildFrontmatter`](../packages/shared/src/frontmatter.ts)): a exigência da
SEP de que os dois coincidam é atendida por construção, não por checagem.

### 4.2 Qual porta serve o quê

| | `as_skill` | `as_resource` |
|---|---|---|
| entrada em `skills/list` e `skills/get` | sim | não |
| entrada em `resources/list` | não | sim |
| `resources/read` de `skill://<slug>/SKILL.md` | lê | lê |
| `resources/read` de um arquivo de apoio | lê | `-32602` |
| `resources/directory/read` de `skill://<slug>` | lista | `-32602` |

A linha que importa é a terceira: o `SKILL.md` é legível pelas **duas** portas,
senão `skills/list` anunciaria uma URI que o `resources/read` recusa. As duas
últimas linhas são o motivo de a extensão ter ficado em `as_skill` e não em
`as_resource`: `as_resource` hoje expõe **só o `SKILL.md`**, e pendurar a SEP
nela ampliaria em silêncio a exposição de toda base que já tem a flag ligada —
a árvore inteira passaria a ser legível sem ninguém ter pedido. Em `as_skill`
não há ampliação nenhuma: aquela porta já entrega todo arquivo por
`get_skill_file` e pela URL de download. A extensão é uma segunda porta,
conformante, sobre o mesmo conjunto.

`resources/read` de `skill://<slug>` — o diretório — é `-32602`. Diretório se
lê por `resources/directory/read`; a SEP não define leitura de diretório pelo
método comum.

### 4.3 `resources/list` deixa de repetir `skills/list`

Governado só por `as_resource`, e com uma entrada por skill: o `SKILL.md`. Os
arquivos de apoio **não** entram, e a SEP autoriza — resource é endereçável
esteja ou não listado, e o manifesto da entrada já é o inventário completo.

Isso preserva a decisão 13 do `06` (`resources/list` sem cursor e sem teto), e
evita o pior caso óbvio: listar N skills vezes M arquivos numa resposta sem
paginação. Quem quer a árvore tem duas portas melhores — o manifesto de
`skills/list` ou o `directory/read`.

O efeito colateral é bom: as duas listagens param de dizer a mesma coisa. Uma
skill só-`as_skill` aparece em `skills/list`, que a SEP chama de "registro
autoritativo das skills que um servidor publica"; uma skill só-`as_resource`
aparece em `resources/list`, como documento avulso. Um host que implementa a
extensão não deve concluir que algo é skill só porque a URI começa com
`skill://` — a SEP diz isso com todas as letras —, e aqui isso é literalmente
verdade.

## 5. O manifesto

### 5.1 Os anexos vêm prontos do banco

`files.content_sha256` é `BYTEA NOT NULL`, mantido pelo trigger
`files_content_sha256_trg` da `020`, que hashea
`COALESCE(convert_to(text_content,'UTF8'), binary_content)` — ou seja, os bytes
gravados, texto ou binário, que são os mesmos bytes que `size_bytes` conta e
que a leitura devolve. É exatamente o `digest` da SEP, sem nenhum trabalho
novo. Ele nasceu para o RAG reaproveitar vetor sem reler arquivo; serve aqui
sem uma linha de SQL a mais.

Um cuidado que já está garantido e convém não desfazer: um arquivo só é
gravado como texto quando é UTF-8 válido sem byte nulo
([`isTextualContent`](../packages/shared/src/paths.ts)), então
`text_content.toString('utf8')` devolve os mesmos bytes que o hash cobre. Se
um dia a régua afrouxar, o digest do texto para de bater.

### 5.2 O `SKILL.md` não vem, e esse é o ponto perigoso

O `SKILL.md` é gravado **sem frontmatter** — o `stripFrontmatter` roda na
escrita ([`apps/admin/src/api.ts`](../apps/admin/src/api.ts)) — e o frontmatter
é remontado das colunas na leitura, por `composeSkillMd`. Logo o
`content_sha256` daquela linha é o hash **do corpo**, e o que o
`resources/read` devolve é **corpo mais frontmatter**.

Publicar aquele hash faria **toda** skill falhar na verificação de **todo**
host — e de um jeito que este repositório não pegaria sozinho, porque nada
aqui lê o digest de volta. Por isso a decisão 6: o digest e o `size` do
`SKILL.md` saem de `composeSkillMd`, na hora, pelo mesmo caminho que serve o
conteúdo. Correto por construção: se a composição mudar, as duas pontas mudam
juntas.

As alternativas e por que não: coluna mantida por trigger exigiria
`buildFrontmatter` reescrito em PL/pgSQL, uma segunda cópia de uma regra que
vive em TypeScript e que divergiria em silêncio; coluna escrita pelo app
transferiria a invalidação para cada caminho de escrita, inclusive os que ainda
não existem; e parar de tirar o frontmatter na gravação revogaria o desenho
inteiro de metadados em coluna (`02` §3.5).

**Invariante para quem escrever a consulta:** as tags têm de sair
`array_agg(t.name ORDER BY t.name)`, como em
[`queries.ts`](../database/src/queries.ts). O `buildFrontmatter` escreve
`metadata.tags` na ordem que recebe; tag fora de ordem faria o frontmatter
composto — e portanto o digest — mudar entre duas chamadas, de forma
intermitente e praticamente irreproduzível.

### 5.3 O cache

Sem cache, `skills/list` lê o corpo de todo `SKILL.md` do vMCP a cada chamada.
Isso não é um problema de escala, é de amplificação: um vMCP `is_open` não
exige credencial, a SEP manda o host montar o registro na conexão e a cada
mudança de conexão, e o rate limit padrão é 600 requisições por minuto por IP.
A listagem mais cara do servidor hoje (`resources/list`) lê **três colunas** por
skill.

A chave é `(uuid, updated_at)`, e ela é sólida por dois motivos verificados:

- `planSkillUpdate` empurra `updated_at = now()` **sempre**, em qualquer
  `updateSkill` — inclusive numa troca só de tags, que muda o frontmatter;
- o trigger `files_reindex_skill_tg` da `001` faz
  `UPDATE skills SET updated_at = now()` quando a linha alterada é o `SKILL.md`
  (`lower(path) = 'skill.md'`), em INSERT, UPDATE e DELETE.

A listagem lê `(uuid, updated_at)` de todas — barato, como hoje — e busca o
corpo só das que mudaram. Em regime, quase nada.

**Mora no módulo, não na instância.** `createMcpServer` roda por sessão e, no
transporte stateless, por requisição: um cache dentro da instância nasceria
frio em toda chamada stateless, isto é, não existiria. E é compartilhado por
todos os vMCPs, porque a composição do `SKILL.md` não depende do vMCP — a chave
é global e correta. Com teto de entradas: sem ele o processo acabaria com todo
`SKILL.md` já listado na memória.

### 5.4 Quando a entrada vira `"dynamic"`

O teto `MCP_MAX_FILE_TEXT_BYTES` (4 MiB) é de **leitura**, não de
armazenamento: nada impede um `SKILL.md` de 200 MB no banco. Hashear esse
conteúdo para publicar um digest de algo que o `resources/read` vai recusar em
seguida é carregar 200 MB na memória para nada — e num vMCP aberto, a pedido de
quem quiser.

A regra é uma só: **a entrada é `"dynamic"` quando o `SKILL.md` composto passa
do teto.** Na prática, duas verificações: `files.size_bytes` acima do teto
dispensa a leitura (o corpo sozinho já não cabe); abaixo dele, lê-se, compõe-se
e mede-se o resultado, porque o frontmatter acrescenta bytes.

Isso é **quase** o mesmo que "quando o `resources/read` recusaria", e a folga
entre os dois é de propósito. A leitura mede o corpo gravado, não o composto
(é o teto que já existia, e mexer nele mudaria também o `prompts/get`), então
há uma faixa estreita — corpo que cabe, composto que não — em que a entrada sai
`"dynamic"` e a leitura ainda entrega o arquivo. A divergência só acontece
nessa direção, que é a segura: o inverso seria publicar digest de conteúdo que
a leitura recusa, e esse nunca ocorre.

É conformante e é honesto: a SEP criou o marcador justamente para distinguir
"deliberadamente não verificável" de "entrada malformada", e prevê que o host
possa declinar a skill. Uma skill nesse estado está inutilizável de qualquer
forma.

### 5.5 Os tetos da SEP

512 arquivos e 16 MiB somados por skill. O projeto já limita entradas de `.zip`
em 512 (`ZIP_MAX_ENTRIES`), mas o total descomprimido em **256 MB**
(`ZIP_MAX_UNCOMPRESSED_BYTES`) — dezesseis vezes o teto da SEP.

Uma skill que estoura continua sendo servida, com manifesto completo. O teto é
`SHOULD NOT` para o servidor, a instalação é self-hosted, e omitir da listagem
em silêncio é precisamente o que a decisão 13 do `06` recusa. O que muda é que
o painel avisa (`§11.2`), porque senão o dono da skill descobre o problema pela
recusa de um host, sem nenhuma pista de onde ela veio.

## 6. Os três métodos

Todos por `server.server.setRequestHandler`, em `registrarSuperficies`
([`server.ts`](../apps/mcp-public/src/server.ts)), com schemas Zod escritos à
mão: o SDK 1.30.0 não tem nada de skills. O `assertRequestHandlerCapability` do
SDK é um `switch` sem `default` que lance, então método desconhecido passa sem
checagem de capability.

**Não registre nada por `registerResource`/`registerPrompt` neste servidor** —
o aviso da `§5.1` do `06` continua valendo e agora com mais superfícies para
esbarrar.

### 6.1 `skills/list`

Sem cursor e sem teto, como as outras duas listagens, pelo mesmo argumento da
`§5.3` do `06`: truncar em silêncio esconde skill de quem a vinculou. O custo
que isso normalmente traria é o que o cache da decisão 24 resolve.

Ordem estável por slug, como `listPublishedSkills` — a lista é recomputada a
cada requisição, e lista embaralhada é ruído.

Cada entrada:

```
{
  "uri": "skill://<slug>/SKILL.md",
  "frontmatter": { "name": "<slug>", "description": "...",
                   "metadata": { "title": "...", "tags": "a, b" } },
  "resources": [ { "uri": "...", "digest": "sha256:...", "size": 1234 } ]
}
```

O `frontmatter` é o espelho exato do que `buildFrontmatter` escreve — `name` é
o slug, `description` sempre presente (a coluna é `NOT NULL DEFAULT ''`), e
`metadata` só existe quando há nome de exibição ou tag. **`tags` é string
separada por vírgula, não lista**, porque é assim que o YAML servido a escreve,
e a SEP exige identidade entre os dois, não elegância. Transformar em lista
mudaria os bytes do `SKILL.md` que o `.zip`, o `GET /files/SKILL.md` e o RAG já
entregam.

### 6.2 `skills/get`

Mesma entrada, por URI. Como a listagem é completa — sem cursor, sem omissão —
ele responde exatamente pelo mesmo conjunto que `skills/list`; a cláusula da
SEP sobre "skill ausente de uma listagem parcial" não tem caso aqui.

`params.uri` tem de ser a URI de um `SKILL.md`. Qualquer outra coisa — o
diretório, um arquivo de apoio, skill de outro vMCP, skill sem `as_skill`,
skill inativa, slug inexistente — é o **mesmo** `-32602`, com a mesma
mensagem.

### 6.3 `resources/directory/read`

Filhos diretos, não recursivo, com subdiretório marcado `inode/directory`. Sem
cursor: o teto de arquivos por skill é 512, e a resposta é metadado.

**A listagem é derivada em TypeScript**, a partir do `listFiles` que já existe:
carregar os caminhos da skill e extrair o próximo segmento é barato sob aquele
teto, e evita uma consulta por prefixo — que, neste repositório, é terreno de
uma armadilha registrada: os 409 de árvore do `createFile` comparam com
`lower()`, `=` e `starts_with`, **nunca `LIKE`**, porque `_` e `%` num nome de
arquivo são literais (a tabela está em
[`database/README.md`](../database/README.md), nos 409 de `createFile`).

Só responde por skill `as_skill`. Sem isso, uma skill só-`as_resource` teria a
árvore revelada por leitura de diretório enquanto os arquivos dela seguem
irrecuperáveis — vazamento de estrutura sem nenhuma contrapartida.

## 7. Leitura

### 7.1 Binário passa a sair em `blob`

Hoje o MCP recusa binário e devolve uma URL de download. Sob a SEP isso não
funciona: o arquivo está no manifesto, o host vai lê-lo, e uma recusa é falha
de verificação — a skill chega quebrada.

`resources/read` passa a devolver `{ uri, mimeType, blob }` com base64, sob o
mesmo `MCP_MAX_FILE_TEXT_BYTES`. As ferramentas **não** mudam: `get_skill_file`
continua devolvendo a URL para binário, porque ali o consumidor é um agente que
pode baixar, e não um host montando uma skill.

### 7.2 O teto de texto fica

Arquivo de texto acima do teto continua sendo `-32602`. Isso é defendido pela
própria SEP: o `size` existe na entrada justamente para o host "decidir se vale
a pena buscar o arquivo" antes de buscá-lo. O host vê o número, sabe o que vem,
e a recusa não é surpresa.

## 8. Capability e os campos de 2026-07-28

```ts
server.server.registerCapabilities({
  prompts: {},
  resources: {},
  extensions: { 'io.modelcontextprotocol/skills': { directoryRead: true } },
});
```

`ServerCapabilities` do SDK 1.30.0 já tipa `extensions` como
`Record<string, object>` (é a negociação de extensões da SEP-2133), então isso
passa sem truque.

O que **não** passa é o resto. O SDK 1.30.0 tem
`LATEST_PROTOCOL_VERSION = '2025-11-25'`, e os campos que a SEP-2640 mostra nos
exemplos — `resultType` — vieram da revisão **2026-07-28**, junto com
`ttlMs`/`cacheScope` e com a troca do erro de resource inexistente de `-32002`
para `-32602`. Nenhum deles existe no SDK; os três vão escritos à mão, no
objeto de resultado dos handlers próprios.

- `resultType: "complete"` — aditivo e inofensivo para cliente antigo.
- `ttlMs: 0`. O valor não é detalhe: a `§5.2` do `06` recusou declarar
  `listChanged` com o argumento de que um cliente que confia na promessa cacheia
  a lista pela sessão inteira e nunca vê uma skill nova. `ttlMs` é a mesma
  promessa com número. Zero é conformante e é verdade — a lista é recomputada
  a cada requisição, e é por isso que um vínculo criado há um segundo aparece
  na chamada seguinte.
- `cacheScope` sai de `scope.mcp.isOpen`: `"public"` em vMCP aberto, onde a
  listagem já é pública por construção; `"private"` em vMCP fechado, onde um
  intermediário compartilhado não pode servi-la a quem não tem chave.

**`tools/list` fica de fora**, e é limitação conhecida, não esquecimento: ele é
montado pelo `McpServer` a partir do `registerTool`, e o SDK lança se
registrarmos um handler para um método que já tem um. Cobri-lo exigiria descer
as cinco ferramentas para handler de baixo nível, perdendo a validação Zod
automática — reescrita, não acréscimo.

## 9. O banco

**Nenhuma migration.** Todas as colunas necessárias existem. O que falta são
duas funções em `@purple-skills/db`:

- `listSkillsManifest(virtualMcpUuid)` — por skill `as_skill` exposta naquele
  vMCP: `uuid`, `slug`, `name`, `description`, `tags` (com
  `ORDER BY t.name`), `updatedAt`, e os arquivos como
  `{relativePath, sizeBytes, sha256}`. **Sem corpo.**
- `readSkillMdBodies(uuids)` — os corpos, em lote, só para os furos do cache.

As duas passam por `exposedIn` com `surface: 'skill'`, como toda leitura do
servidor: a precedência do vínculo direto sobre o catálogo e a exigência de
`skills.is_active` não são reimplementadas aqui.

**Por que função nova e não estender `listFiles`.** O precedente é
`listPublishedSkills`, que nasceu porque reusar `listSkills` clampava em 100 e
carregava por linha agregações que a listagem descartava. Aqui vale o mesmo, e
mais um motivo: `SkillFileMeta` é tipo do `shared`, lido pelo painel e pelo
site, que não têm o que fazer com um hash — acrescentar `sha256` ali é pagar em
três lugares por um consumidor.

## 10. Contadores

`resources/read` do `SKILL.md` conta um acesso, `view`/`resource`, como já
conta hoje. Arquivo de apoio **não** conta; `skills/list` e `skills/get`
**não** contam nada — são catálogo, não leitura, e a `§6` do `02` fala em
acesso a conteúdo.

Isso espelha o par que já existe nas ferramentas: `get_skill` conta,
`get_skill_file` não. Contar o arquivo de apoio transformaria um único
carregamento de skill em N linhas na ficha, afogando o número que a ficha
existe para mostrar.

Fica registrada, sem correção neste PR, a assimetria herdada: a rota HTTP
`GET /skills/:slug/files/*` conta `view`/`file`
([`downloads.ts`](../apps/mcp-public/src/downloads.ts)) enquanto a ferramenta
equivalente não conta. Uniformizar é trabalho de outro documento — mexer nisso
aqui mudaria número de ficha por um motivo que não é este.

## 11. As outras superfícies

### 11.1 Ferramentas e `instructions`

As cinco ferramentas ficam **intactas**. Cliente que não implementa a extensão
— hoje, quase todos — continua com o catálogo inteiro, e a SEP não cobre
`search_skills` nem o `.zip`.

O que muda é o `FLUXO` das `instructions`
([`server.ts`](../apps/mcp-public/src/server.ts)), **em inglês**, pela regra de
[`AGENTS.md`](../AGENTS.md): o parágrafo que hoje aponta prompt e resource passa
a dizer também que o servidor declara a extensão de skills e que um host que a
suporte deve preferir `skills/list`. Esse texto continua sendo o único ponteiro
que o agente tem para as portas que não são ferramenta.

### 11.2 Painel

Uma coisa só: na guia **Arquivos** da ficha da skill, o aviso de que a skill
passa dos tetos da SEP — número de arquivos acima de 512 ou soma acima de
16 MiB —, dizendo que hosts conformantes podem recusá-la.

É ali e não no vínculo porque o estouro é propriedade **da skill**: repeti-lo
em cada vMCP e cada catálogo que a carrega seria a mesma verdade dita N vezes,
e a guia Arquivos já mostra caminho, tamanho e contagem.

### 11.3 Site e mcp-admin

O site **não muda**. Ele é a página do usuário da instalação, e a negociação
de extensão acontece entre cliente e servidor; um visitante não tem o que fazer
com essa informação.

O mcp-admin **não declara a extensão**, mantendo a decisão 2 do `06`: ele é
100% ferramentas, superfície de escrita autenticada por conta (`psk_`). Quem lê
skill é agente, e agente conecta no mcp-public.

## 12. Riscos aceitos

- **A URI antiga morre sem convivência.** Instalação que já publica
  `skill://<slug>` quebra qualquer cliente que tenha guardado aquele endereço.
  Conviver não era opção: sob a SEP, `skill://<slug>` é o **diretório** da
  skill, então a mesma URI significaria arquivo numa porta e diretório na
  outra. O projeto está em `1.0.0-beta`, e é o momento barato para isso.
- **Sem cursor, o custo da listagem cresce com o vMCP.** O cache amortiza o
  regime, não o pico: uma importação de bundle com dezenas de skills deixa
  dezenas de furos, e a listagem seguinte paga todos de uma vez.
- **`"dynamic"` custa a skill inteira.** Um `SKILL.md` grande demais tira a
  verificabilidade também dos arquivos de apoio, que teriam digest perfeito. A
  SEP não admite manifesto parcial, e a alternativa — omitir a skill — é o
  truncar em silêncio que a decisão 4 recusa.
- **Emitimos campos de 2026-07-28 anunciando 2025-11-25.** A spec diz que
  cliente deve tratar resultado sem `resultType`, vindo de servidor anterior,
  como `"complete"` — então omitir seria igualmente correto, e mais modesto. A
  escolha foi pela compatibilidade para a frente; o preço é declarar
  conformidade parcial com uma revisão que o resto do servidor não cumpre, e
  `tools/list` é a prova visível disso.
- **Skill acima dos tetos é servida, e alguns hosts vão recusá-la.** O aviso do
  painel é o que evita que isso seja um mistério.
- **Arquivo de texto acima de 4 MiB está no manifesto e falha na leitura.**
  Para o host isso é falha de verificação, não "arquivo grande". O `size` na
  entrada é o que torna a recusa previsível.

## 13. Fora do escopo

- **O lado cliente** — importar skills de um servidor MCP externo para a
  quarentena, com verificação de digest, consentimento por skill e cache
  isolado. Casa bem com a [`15`](15-quarentena.md) e é diferencial real, mas é
  projeto próprio, não acréscimo a este.
- **`license` e `compatibility` como colunas.** Hoje eles são parseados e
  descartados na ingestão, e **backfill é impossível**: o frontmatter original
  só sobrevive em `quarantine_files` ainda não promovidos. Exigiria coluna,
  extração em `skillMetaFromMarkdown`, emissão em `buildFrontmatter` e as
  cópias de parser do painel e do site andando junto.
- **`allowed-tools` — não por falta de tempo, por escolha.** A SEP manda o host
  ignorá-lo em skill vinda de MCP, tratando-o como pedido de elevação de
  privilégio. Um catálogo que nunca o emite é um catálogo que nunca faz esse
  pedido.
- **Skills aninhadas.** `SKILL.md` em subdiretório é gravável hoje (o
  `isSkillMd` compara o caminho inteiro, então só a raiz é canonizada) e entra
  no manifesto como arquivo de apoio qualquer. Publicá-lo como entrada própria
  exigiria parsear e validar um frontmatter que o projeto descarta.
- **Paginação de `skills/list`** — decisão 7, revisável se o cache não bastar.
- **O protocolo 2026-07-28.** Ele remove as sessões de protocolo e o header
  `Mcp-Session-Id`, remove o handshake `initialize` em favor de
  `server/discover`, e deprecia o transporte HTTP+SSE. Isso derruba
  `sessions.ts`, a tabela `mcp_sessions`, o `MCP_SESSION_TTL_MS` e a amarração
  403 de sessão por credencial. É projeto próprio, disparado pela subida do
  SDK, não por esta extensão.
- **`_meta` de proveniência.** A SEP reserva o prefixo
  `io.modelcontextprotocol.skills/` e admite que intermediários anexem
  anotações sob prefixo próprio. Não há o que anexar aqui.
