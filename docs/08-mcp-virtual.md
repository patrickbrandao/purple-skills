# MCP virtual: um servidor de leitura por time

**Status: implementado**, em dois PRs: o MCP virtual completo e, em seguida,
as chaves gerenciadas do MCP principal (`MCP_PUBLIC_AUTH=managed`, `§7`).

> **Parcialmente revogado por [`09`](09-mcp-padrao-e-skills-flutuantes.md).**
> Não existe mais um "MCP principal": o que responde em `/mcp` é o vMCP
> escolhido como padrão. Deixaram de valer a decisão 2 (o "universal" por
> `is_public AND use_as_skill`), a decisão 7 e a `§7` inteira (`MCP_PUBLIC_AUTH`
> e as chaves `psp_`, removidas no `011`), e a decisão 12 e a `§3.3` caem no
> PR2 de `09` (vínculo pelos dois lados, fim de `confirm_open`). O item "listar
> virtuais abertos no site" da `§9` entra no escopo do PR2. O resto — recorte
> pelo vínculo, chaves `psv_`, dono, identidade da sessão, downloads próprios,
> 404/401 — continua sendo o desenho de **todo** ponto de montagem, inclusive
> a raiz.
>
> **Também parcialmente revogado por [`12`](12-acesso-granular.md):** a
> decisão 9 e a `§3.1` ("admin manda em todos; o dono, no seu; ninguém mais";
> só admin transfere) viraram o acesso por níveis — `view`, `edit`, `manage`
> — com dono e admin transferindo. `canManageVirtualMcp` ficou como atalho
> de `accessLevel` + `canOwn`.

Este documento registra o desenho do **MCP virtual**: um servidor MCP de
leitura em `/virtual/<slug>/mcp` que publica um recorte do catálogo — inclusive
skills privadas — para um time ou projeto, com chaves e dono próprios. É a
referência de *por que* cada peça é assim; o resumo do que está no ar entra em
[`02-architecture-decisions.md`](02-architecture-decisions.md) (`§7.3`, `§8.1`,
`§8.2`) e os desvios em [`03-implementation-notes.md`](03-implementation-notes.md).

O schema saiu na migration `009-mcp-virtual.sql`; o servidor, em
[`apps/mcp-public/src/http.ts`](../apps/mcp-public/src/http.ts) (pontos de
montagem), [`auth.ts`](../apps/mcp-public/src/auth.ts) (resolução do virtual),
[`tools.ts`](../apps/mcp-public/src/tools.ts) (handlers por escopo) e
[`downloads.ts`](../apps/mcp-public/src/downloads.ts).

## 1. Por que

O MCP público é um só e publica o catálogo inteiro sob uma única regra:
`is_public` mais as flags `use_as_*` da skill. Isso deixa de fora dois casos:

- **o time que quer só as suas.** Um agente conectado ao catálogo inteiro
  acha, em `search_skills`, skills de todos os projetos da casa — ruído que
  compete com o que ele deveria achar;
- **a skill que não é pública, mas é do time.** Hoje o único jeito de um
  agente ler uma skill privada é o MCP administrativo, que também escreve.
  Não há um servidor de leitura para "as skills a que este time tem acesso".

O MCP virtual resolve os dois com uma entidade nova, sem mexer no que o MCP
principal já faz: `is_public AND use_as_skill` continua sendo a regra da
universalidade.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Skills no virtual | **Qualquer** skill, pública ou privada |
| 2 | O que é "universal" | `is_public AND use_as_skill`, como hoje — o principal não muda |
| 3 | Superfícies no virtual | Três flags **do vínculo** (`as_skill`, `as_prompt`, `as_resource`), escolha obrigatória; as `use_as_*` da skill são ignoradas |
| 4 | Path | `/virtual/<slug>/mcp` — namespace fixo, sem lista de slugs reservados |
| 5 | Downloads de skill privada | Servidos pelo próprio mcp-public sob `/virtual/<slug>/skills/<skill>/…`, com a mesma credencial |
| 6 | Acesso | Chave obrigatória por padrão; `is_open` por MCP. Abrir com skill privada dentro **exige confirmação explícita** |
| 7 | Modo do principal | `MCP_PUBLIC_AUTH=open\|key\|managed`; ausente = deduzido da `MCP_PUBLIC_KEY` |
| 8 | Aceitação cruzada | **Nenhuma**: cada servidor só aceita as próprias chaves |
| 9 | Dono | `editor`+ cria; dono = criador; admin manda em todos e transfere; conta desativada não desliga o MCP |
| 10 | Chaves | Tabela própria `virtual_mcp_keys`, esquema `psv_`; sem expiração, só revogação |
| 11 | Tools do mcp-admin | `set_virtual_mcp_skills` declarativa mais CRUD e chaves |
| 12 | Painel | Vínculo só pelo lado do MCP; a skill mostra um selo somente-leitura |
| 13 | Auditoria | Ações `mcp.create/update/delete`, `mcp.key.create/revoke`; `target_label` = slug |
| 14 | Ciclo de vida | `is_active` desliga sem apagar; slug renomeável com aviso; delete em cascata com `confirm` |
| 15 | Identidade do servidor | `name = <MCP_SERVER_NAME>-<slug>`; instruções = texto base + `description` |
| 16 | Contadores | No vínculo **e** no global da skill |
| 17 | Recusas | 404 para slug inexistente ou desligado; 401 para chave ausente ou inválida |
| 18 | Entrega | Dois PRs: o virtual completo, depois o modo `managed` do principal |

## 3. Semântica

### 3.1 Uma entidade com dono

`docs/05` §2.1 decidiu que **não há ownership**: o papel limita a ação, nunca
o escopo. O MCP virtual é a primeira exceção, e deliberada: um servidor "do
time A" precisa ser administrado pelo time A, não por qualquer editor da
casa. A regra, em [`roles.ts`](../packages/shared/src/roles.ts):

- `canCreateVirtualMcp(role)` — `editor` e `admin`. Criar um virtual é
  publicar (ele pode expor skill privada), e publicar é o que separa `editor`
  de `leitor`;
- `canManageVirtualMcp(role, ownerUserUuid, userUuid)` — `admin` em qualquer
  um; o dono no seu; ninguém mais. Vale para editar, vincular skills, emitir e
  revogar chaves e apagar.

Só admin **transfere** o dono. Um `leitor` que recebeu um MCP por
transferência administra o seu — por isso as rotas depois de `POST /api/mcps`
não levam guarda de papel, só `loadManaged`. O dono é `NULL` quando a conta
foi removida (`ON DELETE SET NULL`) ou quando quem criou foi a sessão de
bootstrap ou o `MCP_ADMIN_TOKEN`, que não são contas; um MCP órfão é
administrável só por admin e continua servindo.

**Ownership de skill continua não existindo.** O virtual é dono de um
recorte, não das skills; `skills.created_by_user_uuid` segue informativo.

### 3.2 O vínculo decide as superfícies, não a skill

As flags `use_as_skill` / `use_as_prompt` / `use_as_resource` são decisões
sobre o **catálogo universal**: "esta skill, quando pública, sai por onde no
MCP principal". Um virtual é outro contexto — a skill que é só-prompt para o
mundo pode ser ferramenta para o time — e por isso o vínculo carrega as três
flags **próprias** (`as_skill`, `as_prompt`, `as_resource`), sem default e
com escolha obrigatória: um default esconderia a decisão, e a skill privada
que só existe no virtual não tem `use_as_skill` que valha para ela.

`is_public` também não entra: o recorte é o vínculo, e só ele. Em SQL, toda
leitura do virtual é

```sql
EXISTS (SELECT 1 FROM virtual_mcp_skills v
        WHERE v.skill_uuid = s.uuid AND v.virtual_mcp_uuid = $1 AND v.as_<superfície>)
```

no lugar de `is_public AND use_as_*`. O filtro mora na consulta pelo motivo
da `§4.1` de [`07`](07-superficie-de-ferramentas.md): `total` e a contagem
de `list_tags` não têm conserto depois.

### 3.3 Aberto é publicação

`is_open = true` dispensa chave. Com skill privada dentro, isso é **tornar a
skill pública neste endereço**, e o sistema permite — mas só com confirmação
explícita, nas duas portas: o painel devolve `400 confirm_open_required` e
reenvia com `confirmOpen: true` depois de a pessoa aceitar o aviso; a tool
recusa até receber `confirm_open: true`. A confirmação é exigida nos dois
sentidos: ao abrir um MCP que já tem privada, e ao vincular privada a um MCP
que já está aberto. Fica na auditoria como `mcp.update`.

A alternativa — proibir a combinação — foi descartada na entrevista: há casos
legítimos (uma rede interna, um recorte que o time considera público) e a
regra cruzada custaria duas validações que se contradizem.

### 3.4 Contadores em dois lugares

`get_skill`, `prompts/get`, `resources/read`, o `SKILL.md` avulso e o `.zip`
incrementam **o vínculo** (`virtual_mcp_skills.view_count` /
`download_count`) **e a skill**. O painel do MCP responde "quanto este time
usa cada skill"; o ranking do site e `get_stats` continuam vendo o total
real. Não há tabela de eventos: o projeto já aceitou que contadores são
inteiros sem dedup (`02` §13).

## 4. O servidor

### 4.1 Pontos de montagem

`createHttpApp` recebe uma lista de **mounts**, cada um com prefixo, `auth`,
`createServer(req)`, `identityOf(req)` e rotas próprias. O mcp-public monta
dois: a raiz (o principal, como sempre) e `/virtual/:slug`. Os três
transportes — Streamable HTTP com sessão, stateless e SSE legado — são
registrados em cada um; no SSE, o endpoint anunciado ao cliente leva o
prefixo resolvido (`/virtual/time-a/messages?sessionId=…`), porque
`req.baseUrl` já é o slug real.

Um mapa de sessões só, um teto só (`MCP_MAX_SESSIONS`): é um processo e um
orçamento de memória. O que impede uma sessão aberta em `/virtual/a` de
responder em `/virtual/b` ou na raiz é a **identidade**, portada do
mcp-admin: `virtual:<uuid>:key:<id>` ou `virtual:<uuid>:open`. A raiz tem
identidade `undefined` — com ou sem `MCP_PUBLIC_KEY`, todo cliente é o mesmo
cliente, como antes.

### 4.2 Resolução por requisição

`virtualAuth` consulta o MCP pelo slug (`resolveVirtualMcp`, só
`is_active`) e, se ele exige chave, a chave pelo prefixo — dois `SELECT` por
chave primária ou índice único, mais um scrypt de `KEY_COST` (~10 ms). Sem
cache, como toda leitura do MCP público (`06` §5.1): desligar o MCP ou
revogar a chave vale na requisição seguinte, inclusive numa sessão aberta.

A chave é conferida **contra o MCP da URL** (`record.virtualMcpUuid ===
mcp.uuid`): uma `psv_` válida de outro virtual é recusada. É a decisão 8 no
código.

### 4.3 Downloads

`download_skill` e `get_skill_file` (binário) devolvem URLs; no principal
elas apontam para o site, que só serve skill pública. No virtual apontam para
o próprio mcp-public — `/virtual/<slug>/skills/<skill>/download` e
`…/files/<path>` — atrás do mesmo `virtualAuth`, e a dica de `download_skill`
inclui o header quando o MCP exige chave. O `.zip` sai de `writeZip` do
`shared`, com o `SKILL.md` montado dos metadados, como o do site. Só a
superfície de ferramentas (`as_skill`) tem download, como no principal.

A `url` da página do site só é devolvida quando a skill é pública; numa
privada o campo é omitido.

### 4.4 Identidade e instruções

`serverInfo.name` é `<MCP_SERVER_NAME>-<slug>` — o cliente que conecta a
vários virtuais os distingue. As instruções repetem o fluxo do principal
(`search_skills → get_skill → …`) e acrescentam a `description` do MCP, que é
o campo com que o dono contextualiza o agente sem um campo de instruções à
parte.

### 4.5 Recusas

404 para slug que não existe ou MCP desligado; 401 para chave ausente,
revogada, de outro esquema ou de outro virtual. É **distinto** de propósito,
ao contrário da `§5.5` de `06`: quem configura um `mcp.json` precisa saber se
errou o endereço ou a chave, e o que a diferença revela — que um slug existe —
é o nome de um time, não conteúdo.

## 5. Chaves `psv_`

Mesmo formato das `psk_` (`<esquema>_<prefixo de 8>_<segredo de 32 bytes>`,
prefixo indexado, hash scrypt, revogação por `revoked_at`, sem expiração),
com duas diferenças: o **esquema** e o **dono**. `psv_` diz em que tabela
procurar — cada servidor consulta uma só — e torna uma chave vazada
identificável de cara. A chave pertence ao **servidor**, não a um usuário:
não carrega papel, e `created_by_user_uuid` é só informativo. `generateApiKey`
e `parseApiKey` ganharam o esquema como parâmetro.

O texto completo aparece uma vez, na emissão — no painel e na resposta de
`create_virtual_mcp_key`.

## 6. Administração

### 6.1 Painel

Seção "MCPs virtuais": a lista (todos para admin, os próprios para os
demais), a página do MCP com a tabela de skills vinculadas — cada linha com
as três caixas e os contadores do vínculo — e uma busca para acrescentar,
o painel de chaves, o snippet de `mcp.json` (montado de `MCP_PUBLIC_URL`, que
o painel passa a receber) e a configuração (nome, slug, descrição, aberto,
ligado, dono para admin, remover). A página da skill mostra um selo
somente-leitura "publicada nos MCPs virtuais: …" — o vínculo é feito de um
lado só.

### 6.2 mcp-admin

Nove tools, com o mesmo alcance por dono do painel:
`list_virtual_mcps`, `get_virtual_mcp`, `create_virtual_mcp`,
`update_virtual_mcp`, `delete_virtual_mcp(confirm)`,
`set_virtual_mcp_skills` (a lista é o estado desejado, como `set_files_bulk`),
`list_virtual_mcp_keys`, `create_virtual_mcp_key`, `revoke_virtual_mcp_key`.
O token global cria MCPs órfãos; uma `psk_` cria com o dono da chave.

### 6.3 Auditoria

Cinco ações novas no CHECK de `audit_log.action`: `mcp.create`,
`mcp.update` (inclui `is_open`, `is_active`, dono e a lista de skills),
`mcp.delete`, `mcp.key.create`, `mcp.key.revoke`. Linhas sem skill, com
`target_label` = slug do MCP (nas chaves, `"<slug>: <nome>"`). Ver a trilha
continua sendo de admin.

## 7. Chaves gerenciadas do MCP principal

O MCP principal ganhou uma terceira forma de acesso, escolhida por
`MCP_PUBLIC_AUTH`:

| Modo | Aceita |
|------|--------|
| `open` | qualquer um; `MCP_PUBLIC_KEY` é ignorada (com aviso no log) |
| `key` | só `MCP_PUBLIC_KEY` — obrigatória neste modo, o boot falha sem ela |
| `managed` | chaves `psp_` de `public_mcp_keys` **e também** `MCP_PUBLIC_KEY`, se definida |

A env explícita é o que evita a surpresa de emitir a primeira chave e trancar
um servidor que estava aberto: uma chave no banco só vale quando o operador
ligou `managed`. `GET /` anuncia o modo em `auth`.

**Padrão quando a variável está ausente: deduzido, não `open`.** A entrevista
fechou `open` como padrão, mas um padrão fixo abriria, em silêncio, toda
instalação que hoje protege o principal com `MCP_PUBLIC_KEY` e sobe de versão
sem tocar no `.env`. Sem `MCP_PUBLIC_AUTH`, o modo é `key` quando há
`MCP_PUBLIC_KEY` e `open` quando não há — exatamente o comportamento
anterior. Quem quer `open` com a chave ainda definida escreve `open`.

As chaves `psp_` são só de admin — abrem o catálogo público inteiro e não há
dono a quem delegar — e não carregam papel; `created_by_user_uuid` é
informativo. Emissão e revogação no painel (card "Chaves do MCP principal" na
seção de MCPs) e por `list/create/revoke_public_mcp_key` no mcp-admin;
auditoria `public.key.create` / `public.key.revoke`. O painel não sabe em que
modo o mcp-public roda, e o card diz isso.

Sessões no principal ficam presas à identidade como nos virtuais:
`public:env` para a chave da env (todo portador é o mesmo cliente),
`public:key:<id>` para uma `psp_`, nenhuma no modo aberto. A migration é a
`010-public-mcp-keys.sql`.

## 8. Riscos aceitos

- Um virtual `is_open` com skill privada é publicação de fato, protegida só
  pela confirmação (`§3.3`).
- 404 vs 401 permite enumerar slugs de MCPs (`§4.5`).
- Ownership entra no modelo pela primeira vez, restrito a MCPs virtuais.
- Os downloads sob `/virtual/` **não** passam pelos contadores do site nem
  pelo cache dele; são servidos com `Cache-Control: no-store`.

## 9. Fora do escopo

- Estatísticas por MCP além dos contadores do vínculo (sem tabela de eventos).
- Listar virtuais abertos no site — são privados do time.
- Chaves com expiração.
- Um virtual que agregue outros virtuais, ou que herde do principal.
