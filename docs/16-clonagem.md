# Clonagem: uma cópia fechada de uma skill, de um catálogo ou de um servidor

**Status: em implementação**, num PR. Entrevista de 21/09/2026.
Migration `031-clonagem.sql`.

Este documento registra *por que* cada peça é assim; o resumo do que está no
ar entra em [`02-architecture-decisions.md`](02-architecture-decisions.md)
§12.7 e os desvios em
[`03-implementation-notes.md`](03-implementation-notes.md).

> **Este documento não revoga nada.** A checagem foi feita ponto a ponto em
> [`08`](08-mcp-virtual.md), [`11`](11-catalogos.md) e
> [`12`](12-acesso-granular.md), e nenhuma decisão deles deixa de valer por
> causa deste recurso: a clonagem é **aditiva** e as decisões 3, 4 e 9 abaixo
> são justamente aquelas regras aplicadas a um objeto que está nascendo. Por
> isso não há marca de revogação em ponto nenhum — nem aqui no cabeçalho, nem
> lá no texto deles. Registrar a ausência é parte da regra de
> [`AGENTS.md`](../AGENTS.md): quem revoga enumera, e quem não revoga diz que
> conferiu.

## 1. Por que

Três objetos deste projeto são montados peça por peça e depois quase nunca
mudam de forma: a skill, o catálogo e o MCP virtual. Quem quer um **segundo
parecido** com um que já existe não tem hoje um caminho curto:

- **para a skill**, o caminho que parece existir não funciona. Baixar o
  pacote e reimportar para produção bate no slug ocupado (**409**: o import
  manda o slug do frontmatter explicitamente); importar para a quarentena e
  aprovar cria uma skill nova, sim, mas por dentro de um portão de revisão
  que existe para pacote de terceiro — e a medida está registrada na §6 do
  [`15`](15-quarentena.md), que foi onde o assunto apareceu pela primeira
  vez;
- **para o catálogo**, não há pacote nenhum. Um grupo de trinta skills se
  refaz membro a membro, e a participação desativada de cada um
  (`catalog_skills.is_active`, decisão 8 do [`11`](11-catalogos.md)) se
  reconstrói de memória;
- **para o vMCP**, o mesmo, multiplicado pelas três portas de cada vínculo e
  pelas posições do canvas. O servidor "igual ao do time A, mas para o time
  B" é uma tarde de arrastar nó.

A clonagem é a resposta curta: uma cópia do objeto, com o conteúdo dele, sem
nada que signifique exposição, segredo ou histórico. O que ela **não** é:
não é versionamento (não há vínculo entre original e cópia depois do
`INSERT`), não é modelo reutilizável e não é clonagem profunda — clonar um
servidor não duplica as skills que estão dentro dele.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Desempate do slug | Sufixo numérico `-2`, `-3`… pelo `uniqueSlug` do `shared` — o **mesmo** desempate da promoção da quarentena. O `name` não muda sozinho |
| 2 | Disparo | Botão **"Clonar"** na ficha e na linha da lista; diálogo com nome e slug preenchidos e editáveis; confirma e navega para a ficha da cópia. **Fora** da paleta de comandos, por escolha do mantenedor |
| 3 | Quem clona | `edit` no objeto **+** papel `editor`/`admin`. O vMCP exige **`manage`**, porque leva a ACL, e ler a ACL é poder de `manage` (decisão 11 do [`12`](12-acesso-granular.md)) |
| 4 | Exposição | A cópia **nasce fechada**: `is_public=false` em skill e catálogo, `is_open=false` no vMCP, mesmo que o original seja público ou aberto. `is_active` é copiado |
| 5 | Skill | Propriedades, arquivos e tags. Sem catálogos, sem vMCPs (nasce flutuante), sem concessões |
| 6 | Catálogo | Propriedades e membros, preservando o `is_active` de **cada** participação. Sem servidores, sem concessões |
| 7 | vMCP | Propriedades, vínculos com skills e catálogos (as três portas e as posições do canvas), o `layout` e as concessões |
| 8 | Chaves `psv_` | **Não são copiadas.** O segredo nunca é guardado (só o hash scrypt) e `prefix` é UNIQUE global: a linha não tem como ser duplicada de forma utilizável. A cópia nasce sem chave |
| 9 | Dono | Quem clonou. O dono do original **não** ganha nada no clone — e, como dono não tem linha na ACL, ele é justamente quem fica de fora quando outra pessoa clona o servidor dele. Consequência aceita de propósito (§4.2) |
| 10 | Auditoria | `skill.clone`, `catalog.clone`, `mcp.clone`, com `target_label` no formato `<slug de origem> -> <slug da cópia>`, a gramática de `quarantine.promote`. Migration `031` |
| 11 | Superfícies | Tools `clone_skill`, `clone_catalog`, `clone_virtual_mcp`; REST `POST /api/{skills,catalogs,mcps}/:slug/clone`, com corpo `{ name?, slug? }` |
| 12 | Escopo e entrega | Só os três tipos — a quarentena fica de fora e não há clonagem profunda. **Um PR** |

Fechadas por derivação:

- **Contadores zerados nos três**, inclusive os do **vínculo** em
  `virtual_mcp_skills` (`view_count` e `download_count` são colunas do
  vínculo desde a decisão 16 do [`08`](08-mcp-virtual.md), não só da skill).
  Uma cópia que nasce com o acesso de outro objeto mentiria no ranking do
  site e na ficha.
- **`created_by_user_uuid` é quem clonou.** Ator sem conta
  (`MCP_ADMIN_TOKEN`, sessão de bootstrap) gera clone **órfão**, exatamente
  como na criação normal — é a regra que já vale desde a `§3.1` do
  [`08`](08-mcp-virtual.md) e que o [`12`](12-acesso-granular.md) repete nas
  derivações dele.
- **Nas concessões copiadas do vMCP, `granted_by_user_uuid` passa a ser quem
  clonou** — quem concedeu no original não respondeu por esta cópia —, e a
  concessão **da própria pessoa que clonou não é copiada**: ela é a dona, e
  conceder ao dono é redundante (decisão 10 do
  [`12`](12-acesso-granular.md)).
- **O clone de vMCP nunca vira o padrão da instalação.**
  `settings.default_virtual_mcp` não é tocado. Escolher o padrão é ato só de
  admin (`§3.2` do [`12`](12-acesso-granular.md)), e uma cópia que assumisse
  `/mcp` trocaria o servidor público da casa por um clique de "Clonar".
- **Slug pedido que colide responde 409**, como na criação; slug **derivado**
  desempata sozinho e nunca conflita. O painel só manda o slug quando a
  pessoa **edita** o campo, e por isso o caminho comum não dá 409 (`§6`).
- **Tudo numa transação.** Os arquivos da skill são copiados **dentro do
  banco**, sem materializar bytes no app: o `INSERT … SELECT` é do agente
  dba, e o painel não precisa ler 200 MB para gravá-los de volta.
- **A skill clonada nasce `rag_stale=true` e não custa embedding** (`§7`).
- **O `SKILL.md` da cópia já sai com `name: <slug novo>`**: o frontmatter é
  gerado na leitura por `composeSkillMd`
  (`packages/shared/src/frontmatter.ts`), não guardado — o que está em
  `files` é só o corpo.
- **Histórico não acompanha**: `skill_accesses`, `mcp_sessions` e a trilha de
  auditoria do original ficam onde estão. A cópia começa com uma linha só na
  trilha, a da própria clonagem.

## 3. O que cada tipo leva

### 3.1 Skill

Vai junto: as **propriedades** (`name`, `description`, `icon`, `is_active`),
os **arquivos** (`files` inteira, texto e binário, com os mesmos caminhos) e
as **tags**.

Não vai: catálogo, vMCP e concessão. A cópia nasce **flutuante**, no sentido
do [`09`](09-mcp-padrao-e-skills-flutuantes.md) — existe no acervo e nenhum
servidor a serve —, e privada. É a mesma forma com que a promoção da
quarentena entrega uma skill (decisão 8 do [`15`](15-quarentena.md)), e pela
mesma razão: publicar é um ato à parte, para que copiar não vire publicar
por descuido.

### 3.2 Catálogo

Vai junto: as propriedades (`name`, `description`, `is_active`) e os
**membros**, cada participação com o `is_active` que ela tinha
(`catalog_skills.is_active`). Um catálogo de trinta skills em que três estão
desativadas vira uma cópia de trinta skills com as mesmas três desativadas —
copiar o grupo e perder o recorte seria entregar um catálogo diferente com o
mesmo nome.

Não vai: os servidores em que o catálogo está vinculado, e as concessões.

### 3.3 vMCP

Vai junto: as propriedades (`name`, `description`, `is_active`, `layout`), os
**vínculos com skills** e os **vínculos com catálogos** — nos dois, as três
portas (`as_skill`, `as_prompt`, `as_resource`) e as posições do canvas
(`pos_x`/`pos_y`) — e as **concessões**.

É o único dos três que leva ACL, e é por isso que é o único que exige
`manage` (`§4.1`). O `layout` acompanha porque ele é a outra metade da
mesma coisa: as posições dos nós de vínculo estão nas linhas de vínculo, e as
dos nós fixos, no JSON de `virtual_mcps.layout`. Copiar metade abriria a
cópia em auto-layout parcial, que é pior do que abrir em auto-layout inteiro.

Não vai: chave `psv_` (decisão 8), o posto de padrão da instalação e o
histórico de sessões.

### 3.4 O que nenhum dos três leva

| O que | Por quê |
|-------|---------|
| Chaves `psv_` | O segredo não está no banco — só o hash scrypt — e `prefix` é `UNIQUE` global (`database/schema/009-mcp-virtual.sql`). Uma linha duplicada seria uma chave que ninguém consegue usar, ocupando um prefixo. A cópia nasce sem chave, e quem precisa emite uma |
| Contadores | `view_count` e `download_count` da skill, do catálogo e do **vínculo** em `virtual_mcp_skills` nascem em zero |
| Histórico | `skill_accesses` (`018`), `mcp_sessions` (`015`) e as linhas de `audit_log` do original |
| Exposição | `is_public`, `is_open` e o `settings.default_virtual_mcp` (§5) |
| Concessões | Em skill e catálogo. No vMCP elas vão, menos a de quem clonou |

## 4. Acesso

### 4.1 Quem clona

Duas condições, e as duas juntas:

- **`edit` no objeto de origem** — ou mais: dono, `manage` e admin também
  passam, porque os níveis são cumulativos (`§3.2` do
  [`12`](12-acesso-granular.md)). Só `view` não clona: clonar lê o objeto
  inteiro, inclusive o que `view` numa skill não dá;
- **papel `editor` ou `admin`** — o `canCreate` de sempre. Clonar **é**
  criar, e o papel limita a ação (decisão 12 do
  [`12`](12-acesso-granular.md)). A consequência vale dizer por extenso: um
  **`membro` não clona nem o que é dele**, pela mesma razão pela qual
  `POST /api/skills` lhe responde 403. É o mesmo portão que a decisão 18 do
  [`15`](15-quarentena.md) fechou na promoção.

**No vMCP o mínimo sobe para `manage`.** Não é rigor por precaução: o clone
de um servidor leva a lista de concessões, e quem tem `edit` não pode nem
**ler** essa lista (decisão 11 do [`12`](12-acesso-granular.md)) — ele vê o
dono e o flag de aberto, não as contas. Deixar o `edit` clonar seria entregar
pela cópia o que a ficha nega: bastaria clonar e abrir a guia Acesso da cópia,
onde a pessoa é dona, para ler quem tinha acesso ao original. O nível exigido
segue o que o tipo copia, e é por isso que ele é diferente nos três.

### 4.2 Quem enxerga a cópia

Quem clonou é o **dono** e enxerga tudo. Depois disso, cada tipo:

- **skill e catálogo** nascem sem concessão e privados: só o dono e os
  administradores;
- **vMCP** nasce com as concessões do original, menos a de quem clonou. Quem
  tinha `view`, `edit` ou `manage` no original tem o mesmo na cópia, e o
  `granted_by_user_uuid` de todas elas passa a ser quem clonou — a coluna
  responde "quem pôs esta pessoa aqui", e nesta linha quem pôs foi ele.

**O dono do original fica de fora**, e isso é decisão, não esquecimento. Ele
não tem linha na ACL — dono é implícito (decisão 10 do
[`12`](12-acesso-granular.md)) —, então não há o que copiar: quando outra
pessoa clona o servidor dele, todo mundo que ele havia convidado entra na
cópia e ele não. É o preço de o dono ser um campo e não uma concessão, e a
alternativa — dar `manage` ao dono do original na cópia — inventaria uma
concessão que ninguém pediu, num objeto que é de outra pessoa.

## 5. A cópia nasce fechada

`is_public` em skill e catálogo, `is_open` no vMCP: **falso nos três**, mesmo
que o original seja público ou aberto. `is_active`, esse sim, é copiado — ele
diz se o objeto está ligado, não quem o alcança.

A razão é o aviso da decisão 15 do [`12`](12-acesso-granular.md): tornar algo
público é um ato que o painel anuncia, dizendo quantas skills privadas ficam
visíveis. Um clone que nascesse aberto publicaria o conteúdo do original **sem
passar por esse aviso** e num endereço novo — `/virtual/<slug>-2/mcp` —, que
é a pior forma de vazar: ninguém está olhando para ele. Ligar a exposição
depois é um clique na guia Acesso da cópia, com o aviso no lugar.

Pelo mesmo motivo o clone de vMCP **não** toca `settings.default_virtual_mcp`.
O padrão é o que responde em `/mcp`, escolher é ato de admin, e uma cópia que
o assumisse trocaria o servidor público da instalação sem ninguém decidir.

## 6. O slug, o nome e o 409

O diálogo abre com **nome e slug preenchidos**, os dois editáveis. O nome vem
igual ao do original — ele não é chave de nada e mudar sozinho seria adivinhar
—, e o slug vem do desempate: `uniqueSlug` (`packages/shared/src/slug.ts`)
acrescenta `-2`, `-3`… à base, **dentro** do teto de 96 caracteres, encurtando
a base quando ela já está no limite. É o mesmo caminho derivado que
`resolveSlug`, `freeCatalogSlug` e `freeVirtualMcpSlug`
(`database/src/queries.ts`) usam, e é o que a promoção da quarentena já faz
(decisão 9 do [`15`](15-quarentena.md)).

Daí sai a assimetria que vale conhecer:

- **slug derivado** (a pessoa não mexeu no campo) nunca conflita — se
  `-2` estiver ocupado, vai `-3`;
- **slug pedido** (a pessoa editou o campo) passa por `isValidSlug` e, se
  estiver ocupado, responde **409**, como em qualquer criação. A intenção é
  outra: quem digita um slug quer *aquele*, e receber outro silenciosamente é
  o defeito que o `resolveSlug` já corrigiu na criação de skill.

O painel só manda o campo `slug` quando ele foi editado. Por isso o caminho
comum — abrir o diálogo, confirmar — não tem como dar 409, mesmo que duas
pessoas cliquem "Clonar" no mesmo objeto ao mesmo tempo: a `UNIQUE` do banco
desempata e o caminho derivado tenta o número seguinte (`§ Slug e
concorrência` do [`03`](03-implementation-notes.md)).

O `SKILL.md` da cópia não precisa de conserto: o frontmatter é **gerado na
leitura** por `composeSkillMd`, então o `name:` já sai com o slug novo em todo
lugar onde o arquivo é entregue — download, leitura crua e as tools MCP.

## 7. Busca semântica: a cópia não custa embedding

A skill clonada nasce `rag_stale = true`, como toda skill nova — o indexador
vai passar por ela. **Passar não é pagar.**

`rag_vectors` é endereçado por `(space_uuid, text_sha256)`
(`database/schema/020-rag.sql`), e o texto é guardado uma vez só em
`rag_texts`, com o hash como chave. Onde o texto aparece é outra tabela,
`rag_skill_texts`, cuja PK é o endereço da ocorrência dentro da skill: o mesmo
texto em duas skills são **duas linhas apontando para um hash só**. Conteúdo
idêntico, portanto, reaproveita os vetores que já existem; o que o indexador
faz na cópia é refatiar, que é de graça.

O texto de metadados é **nome, descrição e tags** — não o slug (`metaText`,
em `packages/rag/src/chunk.ts`). Como a decisão 1 mantém o nome, a clonagem
pelo caminho comum não gera texto novo nenhum: nem o de metadados, nem os dos
arquivos, que são os mesmos bytes. **Só há texto novo se a pessoa mudar o
nome** no diálogo, e aí é um texto, o de metadados.

## 8. O banco e a auditoria

Migration `031-clonagem.sql`, domínio do dba. Ela **não cria tabela nem
coluna**: o CHECK de `audit_log.action` cresce com três ações, e é só isso —
uma cópia é uma linha nova nas tabelas que já existem.

| Ação | Onde a linha fica | `target_label` |
|------|-------------------|----------------|
| `skill.clone` | na skill **nova** | `<slug de origem> -> <slug da cópia>` |
| `catalog.clone` | no catálogo **novo** | idem |
| `mcp.clone` | no servidor **novo** | idem |

A gramática da seta é a de `quarantine.promote`, que já usa
`<nome do envio> -> <slug criado>` (`database/schema/030-quarentena.sql`): é o
único formato do projeto em que os dois lados de uma passagem aparecem juntos
numa coluna só, e repeti-lo é o que deixa a trilha ser lida sem decorar um
segundo formato. O espelho em TypeScript é `AuditAction`
(`packages/shared/src/types.ts`), que anda junto com o CHECK e com o
`AUDIT_ACTIONS` do banco.

Uma clonagem deixa **uma** linha, e não a sequência de linhas que a mesma
cópia feita à mão deixaria (um `create` mais N `mcp.update`). Nada de
`skill.share` acompanha o clone de vMCP: as concessões nascem com o objeto, e
a linha da clonagem é o registro de que elas vieram de lá. E nada de
`mcp.key.create` nem de `update` de exposição acompanha, porque a cópia nasce
sem chave e fechada (`§5`) — se um dia aparecer uma dessas ações logo depois
de um `mcp.clone`, ela é de alguém, não do recurso.

## 9. As superfícies

### 9.1 O painel

Botão **"Clonar"** em dois lugares: na **ficha** do objeto e na **linha da
lista**, ao lado das ações que já estão ali. Ele abre um diálogo com nome e
slug preenchidos e editáveis (`§6`); confirmar cria a cópia e **navega para a
ficha dela** — a cópia é o que a pessoa vai querer editar a seguir, e deixá-la
na lista obrigaria a procurar o que acabou de criar.

O botão some para quem não pode clonar, como toda ação que o nível não
permite (`§5.2` do [`12`](12-acesso-granular.md)).

**Clonar fica fora da paleta de comandos**, por escolha do mantenedor. A
paleta lista os comandos que a tela registra (`§3.2` do
[`10`](10-admin-canvas-e-sessoes.md)), e caberia ali sem esforço; a decisão é
de superfície, não de implementação — clonar é sempre sobre **um objeto
determinado**, e o gesto certo para isso é o botão que está em cima dele.

### 9.2 REST

```
POST /api/skills/:slug/clone      { name?, slug? }
POST /api/catalogs/:slug/clone    { name?, slug? }
POST /api/mcps/:slug/clone        { name?, slug? }
```

Os dois campos são opcionais: sem `name`, o nome do original; sem `slug`, o
derivado. `slug` pedido e ocupado é **409**; `slug` inválido é **400**. A
resposta é **201** com a ficha da cópia, como em qualquer criação, no recorte
de quem chamou — a mesma regra de toda resposta de escrita (`§3.1` do
[`12`](12-acesso-granular.md)), e aqui ela é trivial: quem clonou é dono da
cópia e vê tudo.

O `:slug` da rota é o **do original**, e é sobre ele que o nível de acesso é
conferido. Quem não enxerga o original recebe o 404 de sempre.

### 9.3 mcp-admin

Três tools, no formato das irmãs:

| Ferramenta | O que faz |
|-----------|-----------|
| `clone_skill(slug, name?, new_slug?)` | Copia propriedades, arquivos e tags. A cópia nasce flutuante e privada |
| `clone_catalog(slug, name?, new_slug?)` | Copia propriedades e membros, com o `is_active` de cada participação |
| `clone_virtual_mcp(slug, name?, new_slug?)` | Copia propriedades, vínculos, `layout` e concessões. **Sem** chaves; exige `manage` |

O argumento do slug novo chama-se `new_slug`, e não `slug`, porque `slug` já é
o do original — é a mesma desambiguação que `edit_skill` faz. Na REST o
problema não existe: o original está no caminho, e o corpo fala só da cópia.

O token global (`MCP_ADMIN_TOKEN`) continua admin e clona qualquer coisa — e,
por não ser conta, deixa a cópia **órfã**, como já faz ao criar.

## 10. Riscos aceitos

- **O dono do original não entra no clone do servidor dele.** Registrado na
  decisão 9 e explicado na `§4.2`. Quem clonou passa a deter uma cópia com a
  lista de convidados do outro, e o outro não a vê.
- **Clonar multiplica armazenamento.** Os arquivos são copiados de verdade,
  não compartilhados: uma skill de 40 MB clonada três vezes ocupa 160 MB. Não
  há deduplicação por hash em `files` — o `content_sha256` que existe ali é do
  RAG (`020`) — e inventar uma aqui mudaria a modelagem de arquivos para
  atender um botão.
- **Cópia não sabe de quem veio.** Depois do `INSERT` não há vínculo entre
  original e cópia: renomear, editar ou apagar um não afeta o outro, e a única
  memória da origem é a linha de auditoria. É o contrário de um modelo ou de
  um fork, e é de propósito — um vínculo pediria política de sincronização,
  que ninguém pediu.
- **Duas cópias seguidas viram `-2` e `-3`.** Quem clonar três vezes sem
  renomear fica com uma lista de slugs numerados, que é exatamente o que o
  desempate promete. Nomear na hora é um campo do diálogo.
- **O clone de vMCP pode ampliar alcance sem ampliar concessão.** As
  concessões vão junto, então as mesmas pessoas passam a ver o mesmo conteúdo
  por **dois** servidores, cada um com o seu dono. Vale o risco que a `§10` do
  [`12`](12-acesso-granular.md) já registra para `view`: contêiner expõe, e
  quem não quer isso não concede.

## 11. Fora do escopo

- **Clonagem profunda.** Clonar um vMCP ou um catálogo não duplica as skills
  dentro dele; os vínculos apontam para as mesmas.
- **Clonar um envio da quarentena.** A fila é de passagem, o envio não tem
  slug e a identidade dele é o `uuid` (decisão 5 do
  [`15`](15-quarentena.md)): "de novo" ali é importar o pacote outra vez.
- **Clonar entre instalações.** Isso é exportar e importar, e já existe.
- **Modelo, template ou fork com sincronização** entre original e cópia.
- **Clonar conta, chave ou concessão avulsa.**
- **Clonar em lote** (selecionar cinco skills e clonar as cinco).
