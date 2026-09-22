# Acesso granular: dono, concessões por objeto e "público"

**Status: implementado**, num PR, sobre o `11`. Entrevista de 14/09/2026.
Migration `017-acesso-granular.sql`.

Este documento registra *por que* cada peça é assim. O resumo do que está no
ar está em [`02-architecture-decisions.md`](02-architecture-decisions.md)
§12.3, os desvios em [`03-implementation-notes.md`](03-implementation-notes.md),
e os trechos de [`05`](05-accounts-and-roles.md), [`08`](08-mcp-virtual.md),
[`09`](09-mcp-padrao-e-skills-flutuantes.md), [`10`](10-admin-canvas-e-sessoes.md)
e [`11`](11-catalogos.md) que ele revoga levam a marca de revogação, como o
`09` fez com o `08`.

## 1. Por que

Depois do `11`, o modelo de acesso é: papéis globais que limitam a **ação** e
nunca o **escopo** (`05` §2.1), com uma exceção deliberada — vMCP e catálogo
têm dono, e só o dono ou um admin os administram. Skill não tem dono; todo
editor mexe em qualquer skill, e todo leitor enxerga todas, inclusive as
flutuantes.

Isso serve a uma equipe pequena que confia em si mesma. Deixa de servir
quando a instalação abriga vários times:

- **não há como dar a alguém uma skill sem dar todas.** Um editor edita o
  acervo inteiro; um leitor lê o acervo inteiro. Não existe "esta skill é do
  time A, e o time B só lê";
- **a única forma de colaborar num vMCP ou catálogo é ser o dono.** Um
  servidor mantido por três pessoas precisa de três contas admin ou de uma
  conta compartilhada;
- **"público" não é um estado que se marca.** Desde o `09`, uma skill é
  visível no site só quando está num vMCP aberto; uma skill que o time quer
  oferecer ao mundo sem servi-la por MCP não tem como ser marcada assim.

O desenho dá dono às skills, uma lista de concessões por objeto (quem pode
ver, editar ou administrar), um flag "público" em skill e catálogo, e faz o
que uma conta enxerga ser a união do que é dela, do que lhe foi concedido e
do que é público.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Escopo de quem não é admin | **Privado por padrão**: vê o que é seu, o que lhe foi concedido e o que é público (ou está em contêiner aberto/público). Revoga o "leitor enxerga skills privadas" de `05` §2.1 |
| 2 | Níveis de concessão | **Cumulativos**, uma coluna: `view` < `edit` < `manage`. Apagar e transferir dono ficam **fora** do `manage`: só dono e admin |
| 3 | O que cada nível cobre | Tabela da `§3.2` |
| 4 | "Público" | **Flag novo** `is_public` em `skills` e `catalogs`: qualquer conta logada e o site anônimo leem. **Não** decide exposição no MCP — isso continua sendo vínculo (`09`). vMCP não ganha flag: "público" é o `is_open` que já existe |
| 5 | Contêiner expõe | Quem vê um vMCP (aberto, por chave ou por concessão) ou um catálogo (público ou por concessão) lê **todas** as skills dentro, sem concessão na skill. Uma regra só para pessoa e máquina — é o que a chave `psv_` já faz |
| 6 | Vincular skill a contêiner | Exige `view` na skill **e** `edit` no contêiner. O vínculo persiste se o `view` for revogado depois; a alavanca do dono da skill é desligá-la (`is_active`) |
| 7 | Vincular catálogo a vMCP | `edit` no vMCP **e** `view` no catálogo. Revoga a decisão 7 do `11` ("administrar os dois") |
| 8 | Dono de skill | Coluna nova `skills.owner_user_uuid`, backfill de `created_by_user_uuid`; nulo = órfã, só admin. `created_by` continua informativo |
| 9 | Transferência | **Dono e admin** transferem, nos três tipos, com confirmação no painel. Revoga "só admin transfere" (`08` decisão 9, `11` decisão 6) |
| 10 | Delegação | `manage` concede `view`/`edit`/`manage` e revoga qualquer concessão, inclusive a própria. Não transfere nem apaga. Dono não tem linha na ACL; conceder ao dono ou a um admin é recusado como redundante |
| 11 | Quem vê a ACL | Só `manage`, dono e admin. `view` e `edit` veem o dono e o flag público, não a lista de contas |
| 12 | Papel `leitor` | **Renomeado para `membro`.** A única diferença para `editor` passa a ser **criar** (skill, catálogo, vMCP). Membro administra o que possui ou lhe foi concedido, inclusive emitir chaves `psv_` e conceder poderes |
| 13 | Escolher a conta | Busca por nome/e-mail aberta a qualquer conta logada, só contas ativas, mínimo de 2 caracteres. Instalação de colaboradores, não SaaS multi-tenant |
| 14 | Site | Lista skills públicas mesmo sem vMCP aberto; ganha seção de **catálogos públicos**, com página listando os membros ativos — todos, pela decisão 5. vMCPs abertos como hoje |
| 15 | Aviso ao expor | **Inline, sem confirmação**, mantendo a decisão 9 do `09`: o painel diz quantas skills privadas ficam públicas por aquele vínculo ou por ligar o flag |
| 16 | Armazenamento | **Três tabelas** com FK e `CASCADE`: `skill_grants`, `catalog_grants`, `virtual_mcp_grants` |
| 17 | Auditoria | Seis ações novas: `skill.share`, `catalog.share`, `mcp.share` e `skill.unshare`, `catalog.unshare`, `mcp.unshare`; `target_label` leva `email:nível` (e o slug, em catálogo e vMCP — `§8`). Transferência e flag público são `update` do objeto |
| 18 | mcp-admin | Nove tools: `share_<tipo>`, `unshare_<tipo>`, `transfer_<tipo>` para skill, catalog e mcp. A REST segue o mesmo formato |
| 19 | UI | Seção **"Acesso"** na página da skill, do catálogo e do vMCP; listas ganham filtro **Meus / Compartilhados comigo / Públicos** e selo de origem |
| 20 | Entrega | **Um PR**, como catálogos |

Fechadas por derivação:

- **Admin não é afetado pela ACL.** Vê e administra tudo; as concessões só
  existem para `editor` e `membro`. Promover alguém a admin deixa as
  concessões dele no banco, inertes.
- **`MCP_ADMIN_TOKEN` e a sessão de bootstrap** continuam valendo como admin
  sem conta (`uuid` nulo): criam objetos órfãos, como hoje.
- **Chave `psk_` do mcp-admin** carrega o papel e as concessões do dono da
  chave; chave de `membro` faz o que o membro faz no painel.
- **Chave `psv_` do mcp-public** lê a árvore inteira do vMCP (diretas e
  catálogos), ignorando a política de cada skill — decisão 5. Nada muda no
  mcp-public além do que o site já lia.
- **O vMCP `public` órfão** (`09`) passa a ser compartilhável: o admin concede
  `edit` a quem deve publicar nele, em vez de publicar por eles.
- **Skill desligada** (`skills.is_active = false`) continua invisível para o
  site e para todo MCP, pública ou não; o painel a mostra a quem a vê.
- **Conta desativada** mantém as linhas de concessão, inertes; reativar
  devolve o acesso. Remover a conta apaga as linhas (`CASCADE`) e deixa os
  objetos dela órfãos (`SET NULL`, como hoje). Transferir para conta
  desativada é recusado. **Revogar não é**: a decisão 10 diz "qualquer
  concessão", e a de conta desativada é justamente a que alguém vai querer tirar
  antes de uma reativação. A guia Acesso marca a linha ("conta desativada") e as
  tools de leitura do mcp-admin trazem `isActive` em cada concessão; conceder e
  mudar o **nível** — a mesma chamada — continuam exigindo conta ativa. Até o
  relatório 039 da auditoria de 2026-09-19 a revogação era recusada também, por
  arrasto: as seis superfícies resolviam o e-mail pelo funil de conceder, que
  exige conta ativa, e a linha não tinha por onde sair.
- **Transferir para quem já tem concessão** apaga a linha dele: o dono é
  implícito.
- **OIDC** auto-provisiona como `membro`.

## 3. Semântica

### 3.1 O que uma conta enxerga

Para uma conta `U` que não é admin, uma skill `S` é visível quando **qualquer**
uma vale:

```
S.is_public
OR S.owner_user_uuid = U
OR EXISTS (skill_grants g WHERE g.skill_uuid = S AND g.user_uuid = U)
OR S está em vMCP aberto e ligado                     -- OPEN_EXPOSURE, já existe
OR S está (participação ativa) em catálogo público e ligado
OR S está em vMCP que U vê (dono, concessão)          -- decisão 5
OR S está em catálogo que U vê (dono, concessão)      -- decisão 5
```

Catálogo e vMCP têm a forma curta: público/aberto, meu, ou concedido. O
filtro mora no SQL pelo motivo de sempre (`07` §4.1, `11` §3.2): o `total`
de `listSkills` e a contagem de tags não têm conserto depois. `@purple-skills/db`
ganha uma opção de leitura `viewer: { role, userUuid }` ao lado de
`visibility`; `'all'` fica reservada ao admin, ao token global e ao bootstrap,
e o site continua com `'open'`, agora ampliada pelas duas linhas de "público".

**As listas dentro de uma ficha seguem a mesma regra.** "Publicada em" e os
catálogos, na ficha da skill, e "Vinculado em" e os membros, na ficha do
catálogo, trazem só o que a conta vê — o servidor fechado de terceiros não é
nomeado em nenhuma das duas, nem para o dono do objeto. Vale também para a
**resposta de uma escrita**: o banco relê sem `viewer`, na visão do admin, e o
app responde com o recorte de quem chamou (relatórios 009 e 010 da auditoria de
2026-09-19). Os contadores do catálogo (`mcpCount`, `skillCount`) são a exceção
registrada ao parágrafo seguinte: continuam globais, porque são o número que a
confirmação de exclusão mostra ao dono — ali subestimar é pior —, e a ficha diz
"e mais N que você não vê" em vez de anunciar 3 e listar 1.

**Número agregado também é alcance.** `stats()` é a última leitura sem `viewer`, e
o app a recorta até o banco recortar (`023`): admin recebe os totais da instalação,
e as outras credenciais só `totalSkills`, `totalTags` e `openSkills` — o número que
o site mostra a um anônimo. O que não dá para recortar fora do banco é **omitido**,
nunca devolvido global.

### 3.2 Os níveis

Cumulativos: `manage` inclui `edit`, que inclui `view`. O dono e o admin têm
tudo, mais o que nenhum nível dá.

| | `view` | `edit` | `manage` | dono / admin |
|---|---|---|---|---|
| **Skill** | ler SKILL.md e arquivos, baixar, vincular nos contêineres que edito | SKILL.md, arquivos, nome, descrição, ícone, tags | slug, ligada/desligada, público, concessões | apagar, transferir |
| **Catálogo** | ver a lista e ler os membros | membros: adicionar, remover, ligar/desligar participação | nome, slug, descrição, ligado, público, concessões | apagar, transferir |
| **vMCP** | ver o canvas, o endereço e ler as skills dentro | vínculos de skill e catálogo, portas, posições do canvas | nome, slug, descrição, aberto, ligado, **chaves**, concessões (escolher o vMCP padrão da instalação continua só admin) | apagar, transferir |

Chaves ficam em `manage`, não em `edit`, porque emitir uma chave entrega a
árvore inteira a uma máquina fora da instalação: é ampliar acesso, o mesmo
que conceder. Nome, descrição, ícone e tags da skill ficam em `edit` porque
são conteúdo (vivem no frontmatter); slug e estado ficam em `manage` porque
mudam endereço e exposição.

### 3.3 Papéis depois disto

| Ação | admin | editor | membro |
|------|:-----:|:------:|:------:|
| Ver tudo | ✅ | ❌ | ❌ |
| Criar skill, catálogo, vMCP (e virar dono) | ✅ | ✅ | ❌ |
| Editar / administrar o que é seu ou lhe foi concedido | ✅ | ✅ | ✅ |
| Apagar e transferir o que é seu | ✅ | ✅ | ✅ |
| Emitir chaves `psv_` de vMCP que administra | ✅ | ✅ | ✅ |
| Gerenciar contas, auditoria, MCP padrão | ✅ | ❌ | ❌ |
| Emitir chaves `psk_` para si | ✅ | ✅ | ✅ |

O papel voltou a ser o que `05` prometeu — limita a ação (criar, gerenciar a
instalação) — e o escopo passou a ser da ACL. `leitor` foi renomeado porque
o nome mentia: um membro edita o que é seu.

`roles.ts` troca `canManageVirtualMcp(role, owner, user)` e
`canManageCatalog` por uma função só,
`accessLevel(role, ownerUserUuid, grant, userUuid)` → `'owner' | 'manage' |
'edit' | 'view' | null`, e por predicados `canView`/`canEdit`/`canManage`/
`canOwn` sobre o resultado. Admin e `uuid` nulo com papel admin recebem
`'owner'` em tudo. `canWrite(role)` passa a significar só **criar**;
`canDelete(role)` deixa de existir — apagar é do dono.

### 3.4 Contêiner expõe, e por isso vincular exige só `view`

A chave `psv_` já lê tudo o que está no vMCP, direto ou por catálogo, sem
olhar skill por skill. Fazer a pessoa com `view` no mesmo vMCP ver menos que
a máquina seria uma segunda regra para a mesma pergunta. Então `view` num
contêiner lê a árvore, e `view` numa skill significa "posso usá-la nos meus
contêineres": quem concede `view` aceita que a skill seja servida por
servidores alheios, com o aviso da decisão 15 no momento em que isso vira
exposição pública.

O vínculo não é reavaliado depois. Revogar o `view` não desfaz vínculos já
feitos — desfazer exigiria varrer contêineres alheios, e o dono da skill não
os edita. A alavanca dele é `is_active = false`, que some de tudo na
requisição seguinte (`11` decisão 10), mais a lista "Publicada em" da página
da skill, que já mostra onde ela está.

### 3.5 "Público" não é "publicado"

Desde o `09`, uma skill aparece no MCP onde está vinculada, e só lá. Isso não
muda. O flag novo responde outra pergunta — **quem pode ler** — e vale para o
painel (qualquer conta logada) e para o site (anônimo). Uma skill pública sem
vínculo com vMCP aberto aparece no site com download e a frase "em nenhum MCP
aberto"; uma skill privada num vMCP aberto aparece no site como hoje, porque
o contêiner a expõe. O `09` chamou isso de "privada deixa de ser um estado da
skill"; o `12` reintroduz o estado com outro significado, e o texto da 012 e
do `09` ganham a marca.

Para o vMCP não há flag: um servidor aberto é legível por qualquer um por
definição, e "listado mas exige chave" não é um caso que alguém pediu.

## 4. O banco

Migration `017-acesso-granular.sql`, domínio do dba:

- `users.role`: o CHECK troca `'leitor'` por `'membro'` e um `UPDATE` migra
  as linhas. É a primeira migration do projeto que reescreve um valor de
  enumeração; o CHECK é DROP + ADD como sempre;
- `skills.owner_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL`,
  preenchida com `created_by_user_uuid`, índice por dono como em
  `virtual_mcps`;
- `skills.is_public` e `catalogs.is_public`, `BOOLEAN NOT NULL DEFAULT false`
  — nada nasce público; o que já está em vMCP aberto continua visível pela
  regra de exposição;
- `skill_grants`, `catalog_grants`, `virtual_mcp_grants` — cada uma com
  `(<objeto>_uuid, user_uuid)` como PK, os dois `ON DELETE CASCADE`,
  `level TEXT NOT NULL CHECK (level IN ('view','edit','manage'))`,
  `granted_by_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL`,
  `created_at`; índice reverso por `user_uuid` (a listagem "compartilhados
  comigo");
- o CHECK de `audit_log.action` cresce com as seis ações da decisão 17.

Sem tabela polimórfica: FK real nos dois lados é o que garante que apagar um
objeto ou uma conta não deixa concessão pendurada, e é o padrão de
`virtual_mcp_skills` e `catalog_skills`.

Efeito sobre dados existentes: toda skill ganha dono (quem a criou) ou fica
órfã; nada fica público; leitores viram membros e **deixam de ver** o que não
é deles, público ou exposto — ver `§9`.

## 5. O painel

### 5.1 A seção "Acesso"

Na página da skill, do catálogo e do vMCP, uma seção com:

- o **dono**, com "Transferir" para dono e admin (busca de conta,
  confirmação, e o aviso de que quem transfere perde o controle);
- a caixa **"Público"** (skill e catálogo) ou **"Aberto"** (vMCP, a que já
  existe), com o aviso inline de quantas skills privadas ficam públicas;
- a **tabela de concessões** — conta, nível, quem concedeu, quando, remover —
  e a busca "Compartilhar com…" que escolhe a conta e o nível. Só para
  `manage`, dono e admin; os demais veem só o dono e o flag.

### 5.2 Listas e ações

As listas de skills, catálogos e vMCPs ganham o filtro **Meus /
Compartilhados comigo / Públicos** e um selo de origem em cada linha (dono,
nível concedido, público, ou "via vMCP X" / "via catálogo Y" quando a skill
chega por contêiner). Admin vê tudo, com o dono em cada linha, como hoje.

Ações que o nível não permite **somem**, como hoje com o leitor: um `view`
não vê "Editar"; um `edit` não vê a seção de concessões nem "Apagar". A
paleta "Adicionar skill" do canvas lista as skills que a sessão vê; a
"Adicionar catálogo", os catálogos que ela vê (decisão 7); "Publicar em", na
página da skill, lista os vMCPs em que a sessão tem `edit`.

### 5.3 API REST

> **Onde se lê "e-mail" daqui até o fim da seção, leia "username".** O
> [`19`](19-username.md) trocou o identificador público da conta: as rotas são
> `/access/:username`, a busca devolve `username` e **deixou de casar por
> e-mail**, e os apelidos descritos abaixo apontam para o username. O raciocínio
> de cada regra — por que a conta não sai pelo `uuid`, por que o apelido existe —
> continua valendo inteiro; só o rótulo que ele carrega deixou de ser dado
> pessoal. O e-mail **não é aceito** nem na entrada (decisão 9 do `19`).

```
GET    /api/users/lookup?q=            nome, e-mail e papel de contas ativas (qualquer logado)

PUT    /api/skills/:slug/access/:email     { level }        concede ou muda o nível
DELETE /api/skills/:slug/access/:email                      revoga
PATCH  /api/skills/:slug                   ganha isPublic e ownerUserUuid
(o mesmo para /api/catalogs/:slug e /api/mcps/:slug)

GET    /api/skills, /api/catalogs, /api/mcps   ganham ?scope=mine|shared|public
```

> **Na resposta, a conta é o e-mail** (relatório 011 da auditoria de
> 2026-09-19). O `uuid` de uma conta é o `sub` do cookie de sessão, e a busca de
> contas já não o entregava; em toda ficha e lista ele continuava ao lado do
> e-mail. `ownerUserUuid`, `grants[].userUuid` e `grants[].grantedByUserUuid`
> saem como **apelido do e-mail** (nulo continua nulo); o `ownerUserUuid` dos
> contêineres aninhados sai omitido; `createdByUserUuid` de chave `psv_` emitida
> por outra conta, nulo; e o `userUuid` de quem leu, na guia Auditoria de skill e
> de catálogo, é o e-mail. Vale para toda sessão, admin inclusive — o uuid de
> verdade está em `/api/users`. A **entrada** `ownerUserUuid` do `PATCH` não
> mudou: e-mail ou uuid. *Quem integra pela REST e lia esses campos esperando um
> uuid passa a receber o e-mail* — a mesma quebra do `GET /api/users/lookup`.
>
> `PUT` e `DELETE /api/skills/:slug/mcps/:mcp` respondem com a ficha da skill
> **como quem chamou a vê** — o mesmo corpo do `GET` —, e não mais com a visão
> do admin (relatório 009 da mesma auditoria). O `DELETE` pode responder `200
> { "unlinked": true }`: desfeito o vínculo, a skill privada que só chegava à
> sessão por aquele servidor deixa de ser visível para ela.

`loadManaged(user, slug)` dos vMCPs e catálogos vira `loadWithLevel(user,
slug, minimo)`, e as rotas de skill — que hoje só têm `requireWrite` /
`requireDelete` — passam a carregar a skill com o nível exigido. `requireWrite`
fica só em `POST` (criar, importar).

> **Na implementação os nomes ficaram outros** — quem procurar os de cima não
> acha. `loadWithLevel` é `load(user, slug, minimum)`, em
> `apps/admin/src/mcps.ts` e `catalogs.ts`, e `loadSkill` / `loadSkillSummary`,
> em `access.ts`; `requireWrite` é `requireCreate` (`auth.ts`), nos quatro
> `POST` que criam — `/api/skills`, `/api/skills/import`, `/api/catalogs` e
> `/api/mcps`; `requireDelete` deixou de existir, porque apagar é do dono
> (`'owner'`). O mcp-admin tem os equivalentes: `loadSkill` (`access.ts`) e
> `managed` (`mcps.ts`, `catalogs.ts`).

## 6. O mcp-admin

> **O parâmetro `email` virou `username`** nas nove tools, pelo [`19`](19-username.md)
> (decisão 9). Nesta superfície a troca é mais que cosmética: quem preenche o
> argumento é um agente, e nenhuma tool devolve e-mail — ele não teria de onde
> tirar um endereço.

`share_skill(slug, email, level)`, `unshare_skill(slug, email)`,
`transfer_skill(slug, email)`, e os pares para `catalog` e `mcp`. Cada tool
grava uma linha de auditoria. `list_skills`, `list_catalogs` e
`list_virtual_mcps` devolvem o que a credencial vê e ganham o `scope` das
listas; `search_skills` idem. `link_skill` e `set_virtual_mcp_skills` passam
a exigir `view` na skill e `edit` no vMCP; `set_virtual_mcp_catalogs`, `edit`
no vMCP e `view` no catálogo. O token global continua admin.

## 7. O site

- A lista de skills e a busca passam a incluir as públicas sem vMCP aberto; a
  página da skill diz onde ela está e, quando não está em nenhum, oferece só
  o download. O exemplo `get_skill("<slug>")` da seção "Via MCP" só aparece
  quando algum vMCP aberto a publica pela porta `skill` — a única que as
  ferramentas do mcp-public enxergam; publicada só como prompt ou resource, a
  página diz por qual porta ela sai (`viaMcp.ts`, no site).
- Seção nova **"Catálogos"**: os públicos e ligados, com nome, descrição e
  membros ativos; a página do catálogo lista os membros — todos os ativos,
  pela decisão 5 — com link para a página de cada um. Revoga o item "um
  catálogo listado no site" de `11` §9.
- A regra do site (`'open'`) vira: skill ligada **e** (pública, ou em vMCP
  aberto e ligado, ou com participação ativa em catálogo público e ligado).

## 8. Auditoria

Seis ações novas. `skill.share` e `skill.unshare` levam `skill_uuid`, como
`update`; as de catálogo e vMCP levam o slug em `target_label` **e** o e-mail
— o formato é `<slug> <email>:<nível>` e `<slug> <email>`, porque a coluna é
uma só e a trilha precisa dos dois. Transferência e flag público são `update`
/ `catalog.update` / `mcp.update` do objeto, com o e-mail do novo dono no
label. Não há ação própria de transferência: a trilha do objeto já conta o
que mudou nele, e "quem virou dono" se lê no label.

## 9. Quebra de compatibilidade

- **Leitores perdem visão.** Uma instalação que usava `leitor` como "vê tudo,
  não edita" acorda com membros que veem só o que é deles, público ou exposto.
  É o propósito da mudança e precisa de nota no README: o admin marca públicas
  as skills que devem continuar visíveis, ou concede `view`.
- **Editores perdem alcance.** Um editor deixa de editar skills que não são
  dele. O backfill por `created_by` cobre quem criou; o resto é concessão ou
  transferência pelo admin.
- **`leitor` some** do CHECK, do `Role`, dos rótulos e da documentação. Chaves
  `psk_` e sessões de leitores continuam valendo — o papel é relido do banco a
  cada requisição — mas o payload da sessão com `role: 'leitor'` é rejeitado
  por `isRole`, e essas sessões pedem novo login.
- **Vincular catálogo a vMCP** fica mais permissivo (decisão 7): um `edit` no
  vMCP com `view` no catálogo faz o que antes só o dono comum fazia.

## 10. Riscos aceitos

- **`view` é publicação em potencial.** Quem tem `view` numa skill pode
  vinculá-la a um vMCP aberto seu e torná-la pública. O aviso da decisão 15
  informa, não impede. Quem não quer isso não concede `view` — ou desliga a
  skill.
- **Contêiner expõe também no site.** Marcar um catálogo como público publica
  membros privados para o anônimo. É a mesma regra do vMCP aberto e o aviso
  é o mesmo.
- ~~**A busca de contas expõe e-mails** a qualquer conta logada. Aceito por ser
  uma instalação de colaboradores.~~ **Revogado pelo [`19`](19-username.md)**
  (decisões 8 e 10): a busca devolve o **username** e deixou de casar por
  e-mail — devolver só o username e continuar casando por endereço deixaria
  qualquer conta logada descobrir a qual username um e-mail corresponde. O
  endereço passou a ser visível só para a própria pessoa e para um admin.
- **Vínculos sobrevivem à revogação.** Revogar `view` não tira a skill dos
  contêineres alheios; a página da skill mostra onde ela está, e desligar
  resolve.
- **Sem grupos.** Um time de dez pessoas são dez concessões por objeto.

## 11. Fora do escopo

- Grupos ou times como sujeito de concessão.
- Convite, pedido de acesso ou aprovação.
- Expiração de concessão.
- "Listado mas exige chave" para vMCP (um `is_public` separado de `is_open`).
- Herança de concessão de catálogo para skill (a exposição por contêiner é
  leitura, não concessão: não dá `edit`).
- Papel vindo de grupo do IdP, como antes.
