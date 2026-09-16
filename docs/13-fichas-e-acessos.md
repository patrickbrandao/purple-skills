# Fichas de skill e catálogo, a colmeia e o registro de acessos

**Status: implementado**, num PR (`feat/fichas-e-acessos`), sobre o `12`.
Migration `018-acessos-por-skill.sql`.

Este documento registra o desenho fechado na entrevista de 14/09/2026 e é a
referência de *por que* cada peça é assim; o resumo do que está no ar entra
em [`02-architecture-decisions.md`](02-architecture-decisions.md) e os
desvios em [`03-implementation-notes.md`](03-implementation-notes.md).

## 1. Por que

Depois do `12`, a página de uma skill no painel fazia três coisas ao mesmo
tempo: mostrava o SKILL.md, publicava a skill em servidores (caixas de porta
por linha) e administrava o acesso (dono, público, concessões) — e ainda
tinha o botão de remover no cabeçalho. A página do catálogo era igual: a
tabela de membros com caixas e lixeiras, a configuração num formulário
lateral e a zona de perigo, tudo numa tela só. "Ver" e "mexer" não tinham
fronteira, e quem só queria ler uma skill estava a um clique de tirá-la de
um servidor.

Três pedidos do mantenedor motivam este redesenho:

- **a ficha de leitura não altera nada.** Lista → visualizar → editar, como
  os servidores já fazem com o canvas: a visualização é só leitura, e toda
  alteração mora em Editar, atrás de um botão;
- **as informações se organizam por guia.** Skill (o conteúdo), Propriedades
  (o que a skill é e onde está) e Acessos (quem a leu); no catálogo, mais uma
  guia para os membros;
- **quem leu cada skill.** Os contadores dizem *quantos*; ninguém sabia *quem*
  — com que chave, de qual servidor, de que IP e com qual cliente. A guia
  "Acessos" precisa de um registro por leitura, que não existia.

E um pedido de visual: a miniatura do card do servidor, que era uma fileira
de ícones, vira uma **colmeia** — um hexágono por skill e por catálogo, na
cor do tipo.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Colmeia: o que cada hexágono mostra | **Só a cor**, sem ícone nem texto: `rgb(59, 145, 145)` para skill, `rgb(112, 59, 145)` para catálogo, iguais nos dois temas; o nome vai no tooltip |
| 2 | Colmeia: quantos hexágonos | **Teto fixo de 19** (1 + 6 + 12, em espiral do centro) e um hexágono neutro **"+N"** com o que não coube |
| 3 | Colmeia: o que entra | Catálogos primeiro, depois as skills com **vínculo direto**, por nome. Skill que chega só por catálogo não vira hexágono próprio: o catálogo é o hexágono dela |
| 4 | Fichas | **Lista → visualizar → editar.** A visualização não tem nenhum controle que grave; a edição fica em `/editar`, com a mesma organização de guias |
| 5 | Guias da skill | **Skill** (descrição na largura da guia; abaixo, a caixa Skill/SKILL.md com a árvore de arquivos à direita), **Propriedades** (metadados, "Publicada em", "Nos catálogos", "Acesso") e **Acessos** |
| 6 | Guias do catálogo | **Catálogo** (a descrição), **Skills** (os membros), **Propriedades** (configuração, "Vinculado em", "Acesso") e **Acessos** |
| 7 | O que sai da visualização | Publicar/tirar de servidor, transferir dono, marcar público, conceder/revogar e **Remover** vão todos para **Editar → Propriedades**; Remover fica numa **zona de perigo** no fim, não no cabeçalho |
| 8 | Quem vê o botão Editar | **Quem edita a skill ou administra algum servidor** (tem `edit` em algum vMCP). Vincular exige só `view` na skill (`12` §3.4), e quem só administra o servidor precisa de um caminho pela página da skill. Em Editar, cada seção habilita conforme a permissão |
| 9 | Onde se edita um arquivo | **No lugar da caixa Skill/SKILL.md**: clicar num arquivo da árvore troca a caixa por um editor com o caminho, "Abrir cru" e "Salvar arquivo"; o SKILL.md volta às duas guias. Upload, importar .zip e remover ficam na árvore |
| 10 | Onde ficam os metadados em Editar | **Propriedades**, com um único **Salvar** no cabeçalho (e ⌘S) que grava descrição, SKILL.md, metadados e o estado "ligada". A guia Skill tem só a descrição e o SKILL.md |
| 11 | "Público" em Editar | Só na seção **Acesso**, gravado na hora, como no `12` §5.1. A caixa duplicada do formulário antigo saiu: dois controles para o mesmo flag numa tela era um convite a confusão |
| 12 | Lixeira na lista de skills | **Fica**, para quem pode apagar (o dono e o admin) |
| 13 | Registro de acessos: quem grava | **MCP público** (get_skill, resources/read, prompts/get, o SKILL.md avulso e o pacote), **site** (detalhe, SKILL.md e pacote) e **mcp-admin** (`get_skill` por chave `psk_`). O painel **não** grava: é o operador olhando o próprio acervo |
| 14 | Registro de acessos: retenção | **Nunca apagar**, como `mcp_sessions` (`10`, decisão 8): a tabela é o histórico |
| 15 | Registro de acessos: quem vê | **Quem administra** a skill ou o catálogo (dono, `manage`, admin). A lista traz IPs, clientes e nomes de chave de servidores que a conta pode não administrar — o mesmo critério das concessões e das sessões de um vMCP |
| 16 | Usuários | **O mesmo princípio** (pedido de 14/09/2026, depois da entrega): a lista só navega, "Nova conta" vira modal, a ficha é só leitura e Editar tem as mesmas guias — Conta, Chaves, Acessos, Atividade. Papel, estado, senha temporária e revogação de chave saem da lista e vão para Editar |

Fechadas por derivação:

- **Guias em rotas.** `/skills/:slug`, `/skills/:slug/propriedades`,
  `/skills/:slug/acessos`, e o mesmo sob `/editar`; no catálogo, mais
  `/skills`. Uma guia tem endereço e sobrevive a um recarregamento, como as
  abas do servidor.
- **O token global não entra no registro.** Ele não é uma conta: como o
  painel, é o operador lendo o próprio acervo. Uma chave `psk_` é uma pessoa,
  e entra com o e-mail dela.
- **A linha sobrevive ao que ela nomeia.** Slug e nome da skill, do vMCP e
  dos catálogos, nome da chave e e-mail da conta são **copiados** na
  escrita; as FKs são `ON DELETE SET NULL`. A guia continua legível depois
  que a skill, o servidor, a chave ou a conta sumiram — e a linha do
  catálogo diz por qual catálogo a skill chegou mesmo depois de ele ser
  apagado.
- **Os contadores continuam.** `view_count`/`download_count` (skill,
  vínculo e catálogo) são somados na mesma escrita que grava a linha, pela
  mesma regra de caminho do `11` §3.3. Nenhuma tela mudou de número.
- **Melhor esforço, como sempre.** O registro é disparado sem segurar a
  resposta: um INSERT lento ou recusado vai para o log e não nega nem atrasa
  a leitura. Os contadores já eram assim.

## 3. As fichas

### 3.1 Skill: visualizar (`/skills/:slug`)

Cabeçalho: ícone, nome, slug, contadores (acessos, downloads), datas
(criada, atualizada) e os botões — ver no site (quando está no site), `.zip`,
`.skill` e **Editar** (decisão 8). Um aviso acima das guias quando a skill
está desligada.

- **Skill** — a caixa "Descrição" na largura da guia (com as tags) e, abaixo,
  a caixa com as guias **Skill** (o markdown renderizado) e **SKILL.md** (o
  arquivo inteiro, frontmatter gerado e corpo, com "Copiar"), com a árvore
  de arquivos à direita — cada arquivo abre o conteúdo cru em outra guia.
- **Propriedades** — "Propriedades" (nome, slug, ícone, tags, estado,
  arquivos, contadores com a pontuação, datas), "Publicada em" (os servidores
  em que está, com as portas em selos e "via catálogo X"), "Nos catálogos" e
  "Acesso" (dono, seu acesso, visibilidade e, para quem administra, quem
  mais tem acesso — tudo texto).
- **Acessos** (só para quem administra) — a tabela da §5.

### 3.2 Skill: editar (`/skills/:slug/editar`)

O mesmo cabeçalho, com **Visualizar** e **Salvar** no lugar de Editar. As
mesmas três guias:

- **Skill** — a descrição vira um campo; a caixa ganha, na guia SKILL.md, o
  frontmatter gerado (travado) sobre o corpo (livre); a guia Skill renderiza
  o rascunho. A árvore ganha upload, importar `.zip` (com "substituir toda a
  árvore") e remover; escolher um arquivo abre o editor dele no lugar da
  caixa (decisão 9).
- **Propriedades** — o formulário de metadados (slug, nome, tags, ícone) e a
  caixa "Skill ligada", gravados pelo Salvar; "Publicada em" com as caixas
  de porta por servidor (grava na hora, como antes); "Nos catálogos" (só
  leitura: a edição é no catálogo); "Acesso" completo (transferir, público,
  conceder, revogar — grava na hora); e, para o dono, a **zona de perigo**
  com Remover.
- **Acessos** — a mesma tabela.

Permissões (`12` §3.2): conteúdo, descrição e metadados são `edit`; slug e
"ligada" são `manage`; apagar é do dono; as portas de cada servidor são
`edit` **no servidor**. Quem entra só por administrar um servidor vê um
aviso e os campos travados.

### 3.3 Catálogo: visualizar e editar (`/catalogos/:slug`, `…/editar`)

Cabeçalho: nome com os selos (desligado, público, origem do acesso), a linha
com slug, membros ativos, servidores, contadores, dono e datas, e os botões
— ver no site (quando é público) e **Editar** (`edit`). Os avisos de
catálogo desligado e de skills desligadas ficam acima das guias.

- **Catálogo** — a descrição (campo em Editar, `manage`).
- **Skills** — os membros com o estado (entregue, desativada, skill
  desligada) e a data; em Editar, "Adicionar skill" (a paleta), a caixa de
  participação e remover, gravando na hora (`edit`).
- **Propriedades** — "Propriedades" (nome, slug, estado, membros,
  servidores, contadores, datas; em Editar, o formulário, `manage`, gravado
  pelo Salvar), "Vinculado em" (leitura nas duas fichas: o vínculo é no canvas
  do servidor) e "Acesso"; em Editar, a zona de perigo para o dono.
- **Acessos** (só para quem administra) — a tabela da §5 com a coluna da
  skill.

### 3.4 Usuário: visualizar e editar (`/users/:uuid`, `…/editar`)

Só admin, como a lista. A lista (`/users`) ganha busca por nome ou e-mail, o
filtro de estado e a coluna de estado; os selects e os links de ação que
viviam em cada linha saem. "Nova conta" é um modal: a senha temporária é
mostrada nele, uma vez, e o botão "Já anotei" leva à ficha da conta nova.

Cabeçalho: avatar, nome com os selos (você, papel, desativada, senha
temporária, SSO, bloqueada), e-mail, último acesso e datas; o botão
**Editar**. Avisos de conta desativada e de login bloqueado acima das guias.

- **Conta** — nome, e-mail, papel (com o que ele significa), estado,
  autenticação (senha, SSO, temporária), bloqueio, datas e o identificador;
  ao lado, "O que o papel decide". Em Editar: nome, papel (não o próprio) e
  a caixa "Conta ativa" (não a própria), gravados pelo Salvar; e a seção
  **Senha**, com "Gerar senha temporária" (confirmação, a senha mostrada
  uma vez) — o que era "Resetar senha" na lista.
- **Chaves** — as `psk_` da conta, inclusive as revogadas (histórico), com
  último uso e estado. Em Editar, **Revogar** por chave (confirmação,
  `key.revoke` na auditoria com o nome do admin). Ninguém emite pela ficha:
  emitir é da própria pessoa, em Minha conta.
- **Acessos** — as leituras de skill feitas pelas chaves `psk_` desta conta
  (a mesma tabela da §5.3, com a skill), pelo filtro `userUuid` da listagem.
- **Atividade** — a trilha de auditoria filtrada pelo e-mail: o que a conta
  fez, pelo painel ou pelo mcp-admin. A página de Auditoria continua sendo
  o lugar dos filtros cruzados.

Não há zona de perigo: contas nunca são apagadas
(`05-accounts-and-roles.md`); quem sai é desativado. Nem o próprio papel nem
a própria conta se mudam, como antes — o servidor recusa e a ficha trava.

## 4. A colmeia

`Honeycomb`, em `apps/admin/web/src/components/Honeycomb.tsx`: um SVG com
até 19 células em coordenadas axiais (hexágono de topo pontudo, raio 14,
desenhado a 86 % para a folga), preenchidas em espiral — o centro, o anel de
6, o anel de 12. Os catálogos vêm primeiro, depois as skills diretas; se
`skillCount + catalogCount` passa de 19, a 19.ª célula vira o "+N". Cada
célula tem um `<title>` com o tipo e o nome; catálogo desligado fica a 40 %.

As cores são tokens (`--hex-skill`, `--hex-catalog`, `--hex-more`) em
`tokens.css`, com o mesmo valor nos dois temas — foi o pedido. A listagem de
servidores passa a trazer `preview` com até 19 skills diretas e
`previewCatalogs` com até 19 catálogos (`VIRTUAL_MCP_PREVIEW_SIZE`, em
`packages/shared`).

## 5. O registro de acessos

### 5.1 A tabela

`skill_accesses`, uma linha por leitura: `kind` (`view`/`download`),
`surface` (`tool`, `resource`, `prompt`, `file`, `download`, `page`,
`admin-tool`), `origin` (`mcp`, `site`, `mcp-admin`), `auth` (`open`, `key`,
`user`, `anonymous`), a skill (uuid `SET NULL` + slug e nome copiados), o
vMCP (idem), os catálogos por onde a skill chegou ao vMCP nesta leitura, a
chave `psv_` (id `SET NULL` + nome), a chave `psk_` e a conta (idem, com o
e-mail), `session_id`, `ip`, `user_agent`, `client_name`/`client_version` e
`created_at`. Detalhes no cabeçalho da migration `018` e no
[README do banco](../database/README.md).

### 5.2 Quem grava o quê

| Origem | Superfície | `auth` | Quem |
|--------|------------|--------|------|
| MCP público | `tool` (get_skill), `resource`, `prompt`, `file` (SKILL.md avulso), `download` | `key` ou `open` | a chave `psv_` do vMCP, ou ninguém |
| Site | `page` (detalhe), `file`, `download` | `anonymous` | ninguém — IP e agente |
| mcp-admin | `admin-tool` (get_skill) | `user` | a conta dona da chave `psk_`, e a chave |

O que já contava `view_count`/`download_count` (`03`, "Contadores") é
exatamente o que grava; `get_skill_file`, `download_skill` (que só devolve a
URL) e os arquivos que não são o SKILL.md continuam fora. O `get_skill` do
mcp-admin, que não contava, passa a **registrar sem contar**: `recordSkillAccess`
soma os contadores só quando a origem é o MCP público ou o site, para a
pontuação do acervo não mudar de significado.

No MCP público, o contexto (credencial, IP, agente) nasce com a requisição
autenticada e viaja no escopo do servidor MCP (`VirtualScope.access`); o
`clientInfo` e o id da sessão só existem depois do `initialize`, por isso
chegam por getters ligados ao `McpServer`. No stateless, que não tem sessão,
vai a mesma chave sintética com que a sessão é contabilizada.

### 5.3 A guia

`AccessLog`, a mesma tabela nas quatro fichas: quando (relativo e absoluto),
a skill (no catálogo), quem (a conta com a chave `psk_`, a chave `psv_`,
"sem credencial" num servidor aberto, ou "anônimo" no site), origem (tipo e
superfície), o servidor (com "via catálogo X"), o cliente (o `clientInfo` ou
o agente, e o id da sessão) e o IP. A barra de ferramentas filtra por texto
livre — e-mail, nome de chave, IP, cliente ou sessão —, por origem e por
tipo; 50 por página, mais novos primeiro.

## 6. API REST

```
GET    /api/skills/:slug/accesses     ?q=&origin=&kind=&limit=&offset=   manage na skill
GET    /api/catalogs/:slug/accesses   idem                                 manage no catálogo
GET    /api/mcps                      preview até 19 + previewCatalogs

GET    /api/users/:uuid               a ficha da conta                     admin
GET    /api/users/:uuid/keys          as chaves psk_ dela, com as revogadas admin
DELETE /api/users/:uuid/keys/:id      revoga (key.revoke)                  admin
GET    /api/users/:uuid/accesses      idem às de skill, filtrado pela conta admin
GET    /api/audit?actor=<e-mail>      a guia Atividade (já existia)        admin
```

`q` é `ILIKE` em e-mail, nome de chave `psk_`, nome de chave `psv_`, IP,
cliente e id de sessão; `origin` e `kind` fora dos valores válidos são 400.

## 7. Riscos aceitos

- **A tabela cresce para sempre**, por decisão — uma linha por leitura, e
  não por sessão como em `mcp_sessions`. Os índices por skill, por catálogo
  e por data mantêm a guia barata; se um dia for preciso podar, é uma
  migration com a política escrita.
- **Cópias envelhecem.** O nome de uma chave renomeada, o e-mail de uma
  conta que mudou e o nome de um catálogo renomeado ficam como estavam na
  hora da leitura. É o que aconteceu, não o que é.
- **Quem só administra um servidor entra em Editar.** Vê os campos da skill
  travados e um aviso; é o preço de manter o atalho de publicação pela
  página da skill sem abrir a edição do conteúdo.
- **Colmeia sem ícone** diz menos que a fileira de ícones antiga — foi a
  escolha. O nome está no tooltip e o card continua abrindo o canvas.

## 8. Fora do escopo

- Estatísticas derivadas do registro (leituras por dia, por cliente, por
  servidor); uma lista global de acessos em Auditoria.
- Registrar o que o painel lê.
- Um canvas na página da skill.
