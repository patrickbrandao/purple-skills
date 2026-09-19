# Fichas de skill e catálogo, a colmeia e o registro de acessos

**Status: implementado**, num PR (`feat/fichas-e-acessos`), sobre o `12`.
Migration `018-acessos-por-skill.sql`. Revisão de 16/09/2026: a edição da
skill troca a guia Acessos pela guia **Arquivos** (decisões 17 a 20).
Revisão de 17/09/2026: **Acesso** vira guia própria nas três fichas,
**Acessos** passa a se chamar **Auditoria**, a skill ganha a guia
**Catálogos** e o Salvar da edição da skill fica sempre ativo e grava tudo
(decisões 21 a 24).

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
| 5 | Guias da skill | **Skill** (descrição na largura da guia; abaixo, a caixa Skill/SKILL.md com a árvore de arquivos à direita), **Propriedades** (metadados, "Publicada em", "Nos catálogos", "Acesso") e **Acessos**. Em Editar, desde a decisão 17: Skill, **Arquivos** e Propriedades |
| 6 | Guias do catálogo | **Catálogo** (a descrição), **Skills** (os membros), **Propriedades** (configuração, "Vinculado em", "Acesso") e **Acessos** |
| 7 | O que sai da visualização | Publicar/tirar de servidor, transferir dono, marcar público, conceder/revogar e **Remover** vão todos para **Editar → Propriedades**; Remover fica numa **zona de perigo** no fim, não no cabeçalho |
| 8 | Quem vê o botão Editar | **Quem edita a skill ou administra algum servidor** (tem `edit` em algum vMCP). Vincular exige só `view` na skill (`12` §3.4), e quem só administra o servidor precisa de um caminho pela página da skill. Em Editar, cada seção habilita conforme a permissão |
| 9 | Onde se edita um arquivo | ~~No lugar da caixa Skill/SKILL.md~~ — **substituída pela 18**. Era: clicar num arquivo da árvore trocava a caixa por um editor com o caminho, "Abrir cru" e "Salvar arquivo"; upload, importar .zip e remover ficavam na árvore |
| 10 | Onde ficam os metadados em Editar | **Propriedades**, com um único **Salvar** no cabeçalho (e ⌘S) que grava descrição, SKILL.md, metadados e o estado "ligada". A guia Skill tem só a descrição e o SKILL.md |
| 11 | "Público" em Editar | Só na seção **Acesso**. ~~Gravado na hora, como no `12` §5.1~~ — **substituída pela 24**: virou **pendência do Salvar** e vai junto do formulário (`isPublic` em `SkillEditorPage.tsx`). A caixa duplicada do formulário antigo saiu: dois controles para o mesmo flag numa tela era um convite a confusão |
| 12 | Lixeira na lista de skills | **Fica**, para quem pode apagar (o dono e o admin) |
| 13 | Registro de acessos: quem grava | **MCP público** (get_skill, resources/read, prompts/get, o SKILL.md avulso e o pacote), **site** (detalhe, SKILL.md e pacote) e **mcp-admin** (`get_skill` por chave `psk_`). O painel **não** grava: é o operador olhando o próprio acervo |
| 14 | Registro de acessos: retenção | **Nunca apagar**, como `mcp_sessions` (`10`, decisão 8): a tabela é o histórico |
| 15 | Registro de acessos: quem vê | **Quem administra** a skill ou o catálogo (dono, `manage`, admin). A lista traz IPs, clientes e nomes de chave de servidores que a conta pode não administrar — o mesmo critério das concessões e das sessões de um vMCP |
| 16 | Usuários | **O mesmo princípio** (pedido de 14/09/2026, depois da entrega): a lista só navega, "Nova conta" vira modal, a ficha é só leitura e Editar tem as mesmas guias — Conta, Chaves, Acessos, Atividade. Papel, estado, senha temporária e revogação de chave saem da lista e vão para Editar |
| 17 | Guias da skill em Editar | **Skill, Arquivos e Propriedades** (pedido de 16/09/2026). **Acessos sai de Editar**: quem lê o registro é quem abre a ficha para consultá-la, não quem está editando. `/editar/acessos` leva a `/acessos`. Só a skill mudou: catálogo e conta continuam com Acessos em Editar |
| 18 | Onde se edita um arquivo | **Na guia Arquivos** (substitui a 9): a árvore à esquerda, com largura arrastável e guardada no navegador, e o arquivo aberto no resto da largura, na altura da janela. A árvore cria **arquivo vazio** e **pasta** — na raiz (a linha do slug) ou numa pasta (as ações da linha, ou a barra, que age na pasta escolhida) —, envia arquivos (botão ou arrastando para a pasta), importa `.zip` e remove. Texto abre num editor com numeração e é gravado por "Salvar arquivo" (⌘S na guia); binário mostra a imagem ou os dados; o SKILL.md abre o corpo do formulário, com o frontmatter travado, e é gravado pelo Salvar do cabeçalho. A guia Skill mantém a árvore ao lado do SKILL.md, como na leitura; clicar num arquivo o abre em Arquivos |
| 19 | Pasta nova | **Vive na página até receber o primeiro arquivo.** O banco só guarda arquivos — uma pasta existe porque há arquivo dentro — e o pacote não leva pasta vazia. A árvore a mostra com o selo "vazia"; se a página fechar antes, ela some. A pasta que perde o último arquivo continua à vista, vazia, até sair da página. Sem migration e sem arquivo-marcador (`.gitkeep`) no pacote |
| 20 | Criar não sobrescreve | "Novo arquivo" é `POST /api/skills/:slug/files/*path` (`createFile`): caminho ocupado em qualquer caixa, prefixo que é arquivo, pasta com o mesmo nome e o SKILL.md são **409**, conferidos numa transação. As outras escritas continuam upsert e sobrescrevem de propósito: salvar (`PUT …/files/*path`) e enviar (`POST …/files`, multipart — que pede confirmação quando o nome já existe) |
| 21 | Acesso | **Guia própria** (pedido de 17/09/2026) na skill, no catálogo e no servidor, na leitura e na edição — antes era uma caixa à direita de Propriedades (e de Configurações, no servidor). A tela tem, à esquerda, "Quem tem acesso" (o dono e as concessões, com "Compartilhar com") e, à direita, Dono (com transferir), Visibilidade e o que cada nível permite. No servidor, a visibilidade é o "aberto", que continua em Configurações. Rotas `/acesso` e `/editar/acesso`; no servidor, `/mcps/:slug/acesso` |
| 22 | Auditoria | A guia **Acessos** (o registro de leituras) passa a se chamar **Auditoria**, em `/auditoria`; `/acessos` leva para lá (e, na skill, `/editar/acessos` e `/editar/auditoria` levam à leitura, como na 17). A ficha de conta continua com Acessos — lá a guia são as leituras **feitas** pela conta, ao lado de Atividade |
| 23 | Catálogos da skill | **Guia própria** na leitura (os catálogos de que participa, com estado, servidores e dono) e, na edição, a mesma tabela como CRUD da participação: "Adicionar a um catálogo" (a paleta, só com os catálogos que a sessão **edita**), a caixa que liga e desliga a participação e "Tirar do catálogo". Catálogo que a sessão não edita fica em leitura. A permissão é a do catálogo (`edit`), como na ficha dele |
| 24 | Salvar da edição da skill | **Sempre ativo, e grava tudo** (pedido de 17/09/2026: desmarcar um vínculo ou mudar o acesso não ativava o botão). Portas por servidor, participação nos catálogos, visibilidade, concessões e dono deixam de gravar na hora e viram **pendências**; o Salvar envia, nesta ordem, os arquivos alterados, o formulário (com a visibilidade junto), as portas, os catálogos, as concessões e, por último, a transferência (com confirmação). O que falhar continua pendente e o erro diz qual foi. Sem pendência, o Salvar relê a skill do servidor. Uma faixa acima das guias lista o que vai ser gravado, com Descartar; o botão mostra quantas são. Desmarcar todas as portas de um servidor tira a skill dele. Só a skill mudou: catálogo e servidor continuam gravando membros e acesso na hora |
| 25 | Arquivos na leitura da skill | **Guia própria, logo depois de Skill** (pedido de 17/09/2026): a mesma árvore e o mesmo layout da guia de Editar (decisão 18), sem nada que grave — só recolher as pastas e recarregar a árvore. O arquivo escolhido abre num **leitor** com as cores da linguagem (o `lowlight` que o markdown já usa, com as classes `sx-*` e os tokens `--syn-*` nos dois temas), numeração que não entra na seleção, quebra de linhas ligável (guardada no navegador), Copiar, Abrir cru e Baixar. A linguagem sai do nome do arquivo e, sem nome que diga, do shebang; o que não se reconhece fica em texto puro. O SKILL.md aparece inteiro, como sai no pacote, com o frontmatter colorido como YAML. Mais de 10 mil linhas mostram as primeiras, com aviso; acima de 250 mil caracteres o trecho sai sem cores. Na guia Skill, clicar num arquivo da árvore o abre aqui (antes abria o cru em outra aba do navegador). Editar e Visualizar levam à mesma guia e, em Arquivos, ao mesmo arquivo. Em Editar, quem não grava o conteúdo vê o mesmo leitor no lugar do editor travado |

Fechadas por derivação:

- **Guias em rotas.** `/skills/:slug`, `/skills/:slug/arquivos` (decisão
  25), `/skills/:slug/catalogos`,
  `/skills/:slug/propriedades`, `/skills/:slug/acesso`,
  `/skills/:slug/auditoria`, e o mesmo sob `/editar` — na skill, desde as
  decisões 17 e 21 a 23, `/editar/arquivos`, `/editar/catalogos`,
  `/editar/propriedades` e `/editar/acesso`; no catálogo, mais `/skills`. Uma guia tem endereço e sobrevive a um recarregamento, como as
  abas do servidor. O arquivo aberto em Arquivos não entra no endereço: ele
  é estado da página, como os rascunhos.
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
  de arquivos à direita — cada arquivo abre na guia Arquivos.
- **Arquivos** — a árvore à esquerda e o arquivo escolhido à direita, no
  leitor com as cores da linguagem (decisão 25). Sem ações que gravem.
- **Catálogos** — os catálogos de que participa, com o estado (participa,
  participação desativada, catálogo desligado, público), quantos servidores
  cada um alcança e o dono (decisão 23).
- **Propriedades** — "Propriedades" (nome, slug, ícone, tags, estado,
  visibilidade e dono, catálogos, arquivos, contadores com a pontuação,
  datas) e "Publicada em" (os servidores em que está, com as portas em selos
  e "via catálogo X").
- **Acesso** — a guia da decisão 21, só texto: o dono, as concessões (para
  quem administra), a visibilidade e os níveis.
- **Auditoria** (só para quem administra) — a tabela da §5.

### 3.2 Skill: editar (`/skills/:slug/editar`)

O mesmo cabeçalho, com **Visualizar** e **Salvar** no lugar de Editar. Cinco
guias — Skill, Arquivos, Catálogos, Propriedades e Acesso (decisões 17, 21 e
23). O Salvar está sempre ativo e grava tudo o que está pendente (decisão 24);
a faixa acima das guias lista as pendências, com Descartar:

- **Skill** — a descrição vira um campo; a caixa ganha, na guia SKILL.md, o
  frontmatter gerado (travado) sobre o corpo (livre); a guia Skill renderiza
  o rascunho. A árvore fica ao lado, como na leitura, e só navega: escolher
  um arquivo o abre na guia Arquivos.
- **Arquivos** — a árvore à esquerda e o arquivo aberto no resto (decisão
  18). Na barra da árvore: novo arquivo, nova pasta e enviar, na pasta
  escolhida (a do arquivo aberto, a última pasta clicada ou a raiz), e o
  menu com importar `.zip`, "substituir a árvore por um .zip", recolher as
  pastas e recarregar a árvore; ao pé, `.zip` e `.skill`. Cada pasta — e a
  raiz — tem as mesmas três ações ao passar o mouse, e a pasta vazia, a de
  tirá-la; cada arquivo, a de remover. O nome do que se cria é digitado na
  própria árvore (Enter cria, Esc desiste, `a/b.md` cria a pasta junto), com
  a conferência de nome e de ocupação antes de ir ao servidor. O editor de
  texto numera as linhas, indenta com Tab e grava com "Salvar arquivo" ou
  ⌘S; "Descartar" relê o que está gravado. Trocar de arquivo ou de guia não
  perde rascunho — a árvore marca os pendentes —, e recarregar ou fechar a
  aba com algo pendente pede confirmação ao navegador.
- **Catálogos** — a tabela da leitura como CRUD da participação (decisão
  23), em pendências.
- **Propriedades** — o formulário de metadados (slug, nome, tags, ícone) e a
  caixa "Skill ligada"; "Publicada em" com as caixas de porta por servidor
  (desmarcar todas tira a skill do servidor; "Publicar" e a lixeira são
  atalhos); tudo em pendências. Para o dono, a **zona de perigo** com
  Remover, que continua imediata.
- **Acesso** — a guia da decisão 21 completa (transferir, público,
  conceder, mudar o nível, revogar), em pendências: cada linha alterada
  ganha um selo ("nova", "nível muda", "revogada ao salvar") e desfazer.

O ⌘S grava o que está à frente: na guia Arquivos, o arquivo aberto; no
resto — e com o SKILL.md aberto em Arquivos —, o mesmo que o Salvar. Os comandos da
paleta acompanham: salvar, novo arquivo, nova pasta, enviar, importar
`.zip`, remover o arquivo aberto e "Arquivos da skill".

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
  servidores, visibilidade e dono, contadores, datas; em Editar, o
  formulário, `manage`, gravado pelo Salvar) e "Vinculado em" (leitura nas
  duas fichas: o vínculo é no canvas do servidor); em Editar, a zona de
  perigo para o dono.
- **Acesso** — a guia da decisão 21; em Editar, cada ação grava na hora.
- **Auditoria** (só para quem administra) — a tabela da §5 com a coluna da
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
  emitir é da própria pessoa, em Adm MCP Keys.
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

`AccessLog`, a mesma tabela nas quatro fichas (na skill e no catálogo, a
guia Auditoria; na conta, Acessos): quando (relativo e absoluto),
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

POST   /api/skills/:slug/files/*path  { content? } cria sem sobrescrever  edit na skill
```

`q` é `ILIKE` em e-mail, nome de chave `psk_`, nome de chave `psv_`, IP,
cliente e id de sessão; `origin` e `kind` fora dos valores válidos são 400.

O `POST` de arquivo (decisão 20) responde 201 com o `SkillFileMeta`;
`content` é opcional (sem ele o arquivo nasce vazio) e, quando vem, tem de
ser texto — o tipo é conferido antes do acesso, e um 400 não diz nada sobre
a skill. Caminho inválido é 400; ocupado, 409 `conflict` com a grafia
gravada na mensagem. Criar audita `create`. De carona, o envio avulso
(`POST /api/skills/:slug/files`) passou a gravar só o corpo de um `SKILL.md`
na raiz, como o `.zip` já fazia.

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
- **Pasta nova é da página** (decisão 19). Quem cria uma pasta e sai sem pôr
  arquivo nela não a encontra na volta, e outro operador nunca a vê. A árvore
  avisa com o selo "vazia" e o tooltip.
- **Rascunho de arquivo é da página.** Ele sobrevive à troca de arquivo e de
  guia, e o navegador pergunta antes de recarregar ou fechar; sair do editor
  por um link do próprio painel descarta sem perguntar — o roteador do
  painel não é um *data router* e não bloqueia a navegação. O mesmo já valia
  para o formulário.
- **Editor de texto simples.** Numeração, indentação e desfazer do
  navegador, sem realce de sintaxe nem busca: um editor de código de verdade
  pesaria no pacote do painel mais do que a guia justifica hoje.

## 8. Fora do escopo

- Estatísticas derivadas do registro (leituras por dia, por cliente, por
  servidor); uma lista global de acessos em Auditoria.
- Registrar o que o painel lê.
- Um canvas na página da skill.
