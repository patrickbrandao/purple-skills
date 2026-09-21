# Catálogos: grupos de skills com dono, vinculados a um vMCP de uma vez

**Status: implementado**, num PR (`feat/catalogs`), sobre o `10`.
Migration `016-catalogos.sql`.

> **Parcialmente revogado por [`12`](12-acesso-granular.md):** a decisão 6
> (só admin transfere) e a decisão 7 e a `§3.4` (vincular exige administrar
> **os dois** lados) viraram acesso por níveis — vincular é `edit` no vMCP e
> `view` no catálogo; dono e admin transferem. O item "um catálogo listado
> no site" da `§9` entrou no escopo do `12` (catálogo público). Pelo mesmo
> motivo estão marcados no ponto a decisão 18 e a `§6.3` (o "alcance por dono"
> do mcp-admin), o detalhe e o `PATCH` da `§6.2` e o "trabalho do admin,
> sempre" da `§8`.
>
> **E, num ponto, por [`13`](13-fichas-e-acessos.md):** a `§3.3` dizia "sem
> tabela de eventos" — `skill_accesses` existe desde a migration `018`.

Este documento registra o desenho fechado na entrevista de 13/09/2026 e é a
referência de *por que* cada peça é assim; o resumo do que está no ar entra em
[`02-architecture-decisions.md`](02-architecture-decisions.md) e os desvios em
[`03-implementation-notes.md`](03-implementation-notes.md).

## 1. Por que

Depois do `09`, publicar uma skill é vinculá-la a um MCP virtual, uma a uma,
com as três portas escolhidas por vínculo. Funciona para um servidor com dez
skills; não funciona para o time que mantém trinta skills de um mesmo domínio
e quer oferecê-las a três servidores diferentes — cada servidor novo é trinta
vínculos, e cada skill nova é três.

Faltava uma unidade entre a skill e o servidor: um **grupo** de skills que se
publica de uma vez, com uma escolha de portas só, e que continua valendo
quando o grupo muda. É o catálogo.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | O que é | Um grupo nomeado de skills; uma skill pode estar em vários catálogos |
| 2 | Vínculo com vMCP | **Muitos-para-muitos**: um catálogo em vários vMCPs, um vMCP com vários catálogos, além das skills diretas |
| 3 | Portas | **Do vínculo catálogo↔vMCP**, uma escolha só para todo membro (`as_skill`/`as_prompt`/`as_resource`, obrigatórias e sem default, como em `virtual_mcp_skills`) |
| 4 | Precedência | O vínculo **direto** da skill com o vMCP **sobrescreve** qualquer catálogo: as portas dele valem sozinhas |
| 5 | Vários catálogos | Sem vínculo direto, as portas são a **união** dos catálogos que chegam ao vMCP com a skill |
| 6 | Dono | Como o vMCP: quem cria (editor+) é o dono; admin manda em todos; admin transfere |
| 7 | Permissão do vínculo | ~~Vincular ou desvincular catálogo↔vMCP exige administrar **os dois** — na prática, o dono comum ou um admin~~ — **revogada pela decisão 7 do [`12`](12-acesso-granular.md)**: vincular é `edit` no vMCP + `view` no catálogo; desvincular, só o `edit` do vMCP |
| 8 | Participação | `catalog_skills.is_active`: desativar a skill no catálogo sem removê-la, **reversível** |
| 9 | Catálogo ligado | `catalogs.is_active`: desligar o catálogo inteiro sem apagar membros nem vínculos, como o vMCP |
| 10 | Skill desligada | **Global**, campo novo `skills.is_active`: some de todo vMCP (direto ou por catálogo) e do site; o painel continua vendo |
| 11 | Contador | **Um por catálogo**, global (`view_count`/`download_count` em `catalogs`): cada acesso a uma skill que chegou ao vMCP **pelo catálogo** soma nele e no global da skill |
| 12 | Canvas | Um catálogo é **um nó só**, com as mesmas três portas de um nó de skill e o mesmo gesto; dentro, o número de skills ativas |
| 13 | O número do nó | Membros com participação ativa e skill ativa, **excluindo** quem já tem nó próprio por vínculo direto ao mesmo vMCP |
| 14 | Clique no nó | Abre a gaveta de detalhe (resumo + link para a tela do catálogo), sem sair do canvas |
| 15 | Site | Skill que chega a um vMCP aberto e ligado só por catálogo aparece no site como qualquer outra |
| 16 | Painel | Item **"Catálogos"** na sidebar; lista, criar, excluir; a página do catálogo é o CRUD de skills (adicionar, remover, desativar/reativar) com alerta de skill desligada |
| 17 | Página da skill | A exposição indireta aparece na lista "Publicada em" como linha somente-leitura "via catálogo X"; os catálogos de que participa aparecem num painel próprio, só leitura |
| 18 | mcp-admin | Tools de catálogo com o mesmo alcance do painel — ~~por dono~~, **revogado pela `§3.2` do [`12`](12-acesso-granular.md)**: por nível de acesso (dono, concessão ou admin; os públicos, em leitura) |
| 19 | Auditoria | `catalog.create` / `catalog.update` / `catalog.delete`, `target_label` = slug do catálogo; o vínculo com vMCP é `mcp.update` no servidor |

## 3. Semântica

### 3.1 Duas desativações, três motivos para uma skill não sair

Uma skill dentro de um catálogo vinculado a um vMCP **não** é entregue quando:

- a **skill** está desligada (`skills.is_active = false`, decisão 10) — vale
  em tudo, inclusive no vínculo direto;
- a **participação** está desativada (`catalog_skills.is_active = false`,
  decisão 8) — vale só naquele catálogo;
- o **catálogo** está desligado (`catalogs.is_active = false`, decisão 9) —
  vale em todo vMCP a que ele está vinculado.

As três são reversíveis e nenhuma apaga vínculo. A tela do catálogo mostra as
duas primeiras de forma diferente: a participação é uma caixa que o próprio
administrador do catálogo liga e desliga ali; a skill desligada é um **alerta**
— foi decidido em outro lugar (na página da skill) e explica por que o membro
não sai.

### 3.2 Precedência: o vínculo direto sobrescreve

Para um par (vMCP, skill), a regra em SQL é uma só, e mora na consulta pelo
mesmo motivo de `08` §3.2 — `total` e a contagem de tags não têm conserto
depois:

```
s.is_active AND (
  -- vínculo direto: as portas dele, e nada mais
  EXISTS (SELECT 1 FROM virtual_mcp_skills v
          WHERE v.skill_uuid = s.uuid AND v.virtual_mcp_uuid = $1 AND v.as_<porta>)
  OR (
    -- sem vínculo direto: a união dos catálogos
    NOT EXISTS (SELECT 1 FROM virtual_mcp_skills v
                WHERE v.skill_uuid = s.uuid AND v.virtual_mcp_uuid = $1)
    AND EXISTS (SELECT 1 FROM catalog_skills cs
                JOIN catalogs c ON c.uuid = cs.catalog_uuid AND c.is_active
                JOIN virtual_mcp_catalogs vc ON vc.catalog_uuid = c.uuid
                                            AND vc.virtual_mcp_uuid = $1
                WHERE cs.skill_uuid = s.uuid AND cs.is_active AND vc.as_<porta>)
  )
)
```

"Sobrescreve" é literal: um vínculo direto só com Prompts numa skill que um
catálogo entrega como Tools tira a skill das ferramentas daquele vMCP. É a
forma de um administrador dizer "esta skill, aqui, é diferente do grupo" sem
tirá-la do grupo. A alternativa — a união com o direto — foi descartada
porque não daria como *restringir* uma skill num servidor sem removê-la do
catálogo.

Entre catálogos não há precedência: se dois chegam ao mesmo vMCP com a mesma
skill, as portas somam (decisão 5). Cada catálogo é só mais um caminho.

### 3.3 Contadores

`incrementViewCount(skill, mcp)` / `incrementDownloadCount` continuam somando
na skill e, quando há vínculo direto, no vínculo. Sem vínculo direto, somam
na skill e em **cada catálogo** que contribuiu (ativo, com a participação
ativa e vinculado ao vMCP **pela porta da superfície lida** — a segunda nota
abaixo guarda a definição anterior, sem a porta). O catálogo responde "quanto o
que eu agrupo é usado"; a skill continua sendo o total real. ~~Sem tabela de
eventos, como sempre~~ (`02` §13).

> **Revogado neste ponto por [`13`](13-fichas-e-acessos.md)** (decisão 13 e
> `§5`): a tabela de eventos existe desde a migration `018` — `skill_accesses`,
> uma linha por leitura, com os catálogos por onde a skill chegou ao vMCP. Os
> apps gravam por `recordSkillAccess`, que soma os contadores na mesma escrita e
> pela **mesma regra de caminho** descrita acima; `incrementViewCount` e
> `incrementDownloadCount` continuam no `@purple-skills/db`, só somando, sem
> chamador nos apps. O que continua valendo é o contador ser inteiro, sem dedup.

> **"Contribuiu" passou a olhar a porta** (relatório 041 da auditoria de
> 2026-09-19). **Era**, até ali, só o que o parágrafo de cima diz — catálogo
> ativo, participação ativa e vínculo com o vMCP, **por qualquer porta** —, e o
> código seguia essa definição: com dois catálogos no mesmo servidor por portas
> diferentes (A só `as_skill`, B só `as_prompt`), uma leitura pela tool gravava
> `[A, B]` na linha de `skill_accesses` e somava nos dois, e quem administra B
> via IP, chave e cliente de uma leitura que B não entregou. Hoje contribui o
> catálogo vinculado **pela porta da superfície lida**, a regra da `§3.2`
> (`vc.as_<porta>`): `tool`, `file` e `download` entram pela porta de skill;
> `prompt` e `resource`, pela de mesmo nome (`accessPort`, em
> `database/src/queries.ts`). A precedência do vínculo direto continua **sem**
> porta, como na `§3.2`. Ficam dois regimes na guia Auditoria do catálogo: a
> linha gravada antes traz todo catálogo vinculado, e o que já foi somado fica
> somado — a porta do vínculo na hora de cada leitura passada não foi guardada.
> `incrementViewCount` e `incrementDownloadCount` não recebem a superfície e
> seguem somando sem olhar a porta; nenhum app as chama.

### 3.4 Dono nos dois lados

O catálogo tem dono pelo mesmo motivo do vMCP (`08` §3.1): um grupo "do time
A" é administrado pelo time A. `canCreateCatalog(role)` é editor+;
`canManageCatalog(role, owner, user)` é admin ou o dono.

O vínculo catálogo↔vMCP toca dois objetos com dono, e a decisão 7 exige
administrar os dois. Não há fluxo de convite ou aprovação no projeto, e não
entra aqui: um editor que administra o vMCP mas não o catálogo simplesmente
não vê o catálogo na paleta, e vice-versa. Quem cruza times é o admin. É
mais restritivo do que o vínculo de skill (que não tem dono) de propósito —
um catálogo é uma lista que alguém mantém, e vinculá-lo a um servidor é
tornar essa pessoa responsável pelo que aquele servidor entrega.

## 4. O banco

Migration `016-catalogos.sql`:

- `skills.is_active BOOLEAN NOT NULL DEFAULT true`;
- `catalogs` — `uuid`, `slug` (único, `isValidSlug`), `name`, `description`,
  `is_active`, `owner_user_uuid` (`ON DELETE SET NULL`, como `virtual_mcps`),
  `view_count`, `download_count`, `created_at`, `updated_at`;
- `catalog_skills` — `catalog_uuid`, `skill_uuid` (ambos `ON DELETE
  CASCADE`), `is_active` (participação, `DEFAULT true`), `created_at`; PK
  composta e índice reverso por skill;
- `virtual_mcp_catalogs` — `virtual_mcp_uuid`, `catalog_uuid` (ambos
  `CASCADE`), `as_skill`/`as_prompt`/`as_resource` (`NOT NULL` sem default),
  `pos_x`/`pos_y` (o nó no canvas daquele vMCP, com o mesmo CHECK de par do
  `014`), `created_at`; PK composta e índice reverso por catálogo;
- o CHECK de `audit_log.action` cresce com `catalog.create`, `catalog.update`
  e `catalog.delete`.

Efeito sobre dados existentes: nenhum — toda skill nasce ligada e as três
tabelas nascem vazias.

## 5. O canvas

O nó de catálogo é o quarto tipo, ao lado de servidor, skill e Internet: um
card com o ícone de catálogo, nome, slug e o número da decisão 13 em
destaque, com três handles de destino à esquerda, um por porta, na mesma
ordem do servidor. As arestas são as mesmas de skill, e os gestos também
(`10` §4.2): arrastar liga a porta, ✕ desliga, tirar a última tira o catálogo
do servidor, com confirmação. A posição vai em `virtual_mcp_catalogs.pos_x`/
`pos_y` pelo mesmo `PUT /api/mcps/:slug/canvas`, agora com `catalogPositions`.

"Adicionar catálogo" é um segundo botão fixo do palco e um segundo comando
da paleta, com a mesma página "escolher" — filtrada aos catálogos que a
sessão **vê**. O nó de um catálogo desligado, ou sem nenhum
membro ativo, aparece esmaecido com o motivo no rodapé.

> **Revogado neste ponto por [`12`](12-acesso-granular.md):** ~~filtrada aos
> catálogos que a sessão administra (decisão 7)~~. A paleta é alimentada por
> `GET /api/catalogs` sem recorte (`CommandPalette` → `getCatalogs()`), que
> devolve o que a sessão enxerga — os seus, os concedidos e os **públicos**
> —, porque vincular passou a exigir só `view` no catálogo (decisão 7 do `12`).

O número do nó exclui os membros com nó próprio de propósito: no palco, uma
skill que é nó e também estaria "dentro" do catálogo seria contada duas
vezes, e o total do servidor deixaria de bater com o que se vê.

## 6. O painel e o mcp-admin

### 6.1 Telas

| Rota | O que é |
|------|---------|
| `/catalogs` | Lista (~~todos para admin, os próprios para os demais~~ — **revogado pelo [`12`](12-acesso-granular.md) `§3.1`:** tudo para admin; para os demais, os seus, os concedidos **e os públicos**, com o filtro meus / compartilhados comigo / públicos): nome, dono, membros ativos/total, vMCPs, acessos, estado; "Novo catálogo" num modal com nome, slug e descrição |
| `/catalogs/:slug/*` | A ficha só leitura (`13` §3.3): guias Catálogo (descrição), Skills (os membros com o estado), Propriedades (configuração, "Vinculado em" com os vMCPs e as portas, acesso) e Acessos |
| `/catalogs/:slug/edit/*` | A ficha de edição, mesmas guias: a tabela de skills com a participação como caixa e "Remover", a busca "Adicionar skill" (paleta), a configuração (nome, slug, descrição, ligado), o acesso e a zona de perigo |

Na página da skill, o painel "Publicada em" ganha as linhas indiretas: um
vMCP alcançado só por catálogo aparece com as portas em selos e "via
catálogo X", sem caixas — a edição é no catálogo. Um painel novo, "Nos
catálogos", lista os catálogos de que a skill participa, com a participação
e o estado de cada um, e o link. A ficha da skill ganha a caixa "Skill
ligada", e a lista de skills, o filtro "desligadas".

### 6.2 API REST

```
GET    /api/catalogs                      lista
POST   /api/catalogs                      cria (editor+)
GET    /api/catalogs/:slug                detalhe (view)
PATCH  /api/catalogs/:slug                nome, slug, descrição, isActive, isPublic (manage); dono (dono e admin)
DELETE /api/catalogs/:slug
PUT    /api/catalogs/:slug/skills         declarativa: [{ slug, isActive? }]
PUT    /api/catalogs/:slug/skills/:skill  adiciona (ou { isActive } para ligar/desligar a participação)
DELETE /api/catalogs/:slug/skills/:skill  remove
PUT    /api/mcps/:slug/catalogs           declarativa: [{ slug, asSkill, asPrompt, asResource }]
PUT    /api/mcps/:slug/catalogs/:catalog  vincula/reescreve as portas (+ position)
DELETE /api/mcps/:slug/catalogs/:catalog  desvincula
PUT    /api/mcps/:slug/canvas             ganha catalogPositions
PATCH  /api/skills/:slug                  ganha isActive
```

> **Revogado neste ponto por [`12`](12-acesso-granular.md)** (decisão 7 e
> `§5.3`): ~~as rotas de vínculo passam por `loadManaged` do vMCP **e** do
> catálogo~~. `loadManaged` não existe mais. Vincular é `load(user, mcpSlug,
> 'edit')` no vMCP **e** `load(user, catalogSlug, 'view')` no catálogo
> (`apps/admin/src/catalogs.ts`, `linkToMcp` e `setMcpCatalogs`); desvincular
> exige só o `edit` do vMCP — tirar da lista é mexer no servidor, não no
> catálogo.
>
> **Também revogado aqui** (`12` `§3.2` e decisão 9), e a tabela acima já vai
> corrigida: o `GET` do detalhe era ~~"detalhe (quem administra)"~~ e hoje é
> `view` (`catalogs.detail` → `load(user, slug, 'view')`); o `PATCH` era
> ~~"nome, slug, descrição, isActive, dono (admin)"~~ e hoje exige `manage`,
> ganhou `isPublic`, e a transferência é de **dono e admin** (`ownerFrom`, em
> `apps/admin/src/access.ts`) — só deixar o catálogo **sem** dono continua
> sendo do admin.

### 6.3 mcp-admin

`list_catalogs`, `get_catalog`, `create_catalog`, `update_catalog`,
`delete_catalog(confirm)`, `set_catalog_skills` (declarativa),
`set_virtual_mcp_catalogs` (declarativa, no vMCP). `edit_skill` ganha
`is_active`. ~~Mesmo alcance por dono do painel~~; o token global cria
catálogos órfãos.

> **Revogado neste ponto por [`12`](12-acesso-granular.md) `§3.2`:** o alcance
> é o do painel, mas por **nível de acesso**, não por dono — o token global e
> uma chave de admin veem e administram qualquer catálogo; a chave de um
> usuário, os seus, os concedidos (no nível da concessão) e os públicos, em
> leitura (`createCatalogHandlers`, em `apps/mcp-admin/src/catalogs.ts`). O
> `12` acrescentou `share_catalog`, `unshare_catalog` e `transfer_catalog`.

## 7. Auditoria

Três ações novas, sem skill, com `target_label` = slug do catálogo:
`catalog.create`, `catalog.update` (inclui nome, estado, dono e a lista de
skills) e `catalog.delete`. Vincular um catálogo a um vMCP é `mcp.update` no
servidor, exatamente como vincular uma skill: a trilha do servidor conta o
que mudou nele. Ligar ou desligar uma skill é `update` na skill.

## 8. Riscos aceitos

- **A sobrescrita esconde.** Uma skill com vínculo direto restrito e também
  num catálogo do mesmo servidor sai com menos portas do que o catálogo
  promete; a página da skill mostra o vínculo direto, não o catálogo, e é
  o único lugar que explica.
- **O contador do catálogo é por caminho.** Um acesso à skill por vínculo
  direto não soma no catálogo mesmo que ela esteja nele: o catálogo não foi
  o caminho.
- **Sem convite.** ~~Cruzar dono de catálogo com dono de vMCP é trabalho do
  admin, sempre.~~ — **revogado neste ponto pela decisão 7 do
  [`12`](12-acesso-granular.md)**: quem tem `edit` no vMCP e `view` no
  catálogo vincula sozinho, sem admin no meio. O "sem convite" continua
  valendo — convite, pedido de acesso e aprovação seguem fora do escopo (`12`
  `§11`); o que caiu foi o "trabalho do admin, sempre".
- **Desligar a skill não avisa ninguém.** Ela some dos vMCPs na requisição
  seguinte, sem confirmação — é reversível, e é o mesmo comportamento de
  desligar um vMCP.

## 9. Fora do escopo

- Catálogo dentro de catálogo.
- Portas por membro dentro de um catálogo (é o vínculo direto que faz isso).
- Contador por vínculo catálogo×vMCP.
- Um catálogo listado no site como tal — o site continua listando skills e
  vMCPs.
