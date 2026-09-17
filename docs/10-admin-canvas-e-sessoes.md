# O painel é um console: canvas de servidores e contabilidade de sessões

**Status: implementado**, num PR (`feat/admin-canvas`), sobre o `09`.
Migrations `013-skill-icon.sql`, `014-canvas-do-vmcp.sql` e
`015-mcp-sessions.sql`.

Este documento registra o desenho fechado na entrevista de 12/09/2026 e é a
referência de *por que* cada peça é assim; o resumo do que está no ar entra
em [`02-architecture-decisions.md`](02-architecture-decisions.md) e os
desvios em [`03-implementation-notes.md`](03-implementation-notes.md). O
visual do painel deixa de seguir [`04-design-system.md`](04-design-system.md)
no que diz respeito ao site: a `§3` deste documento e a nota no `04` dizem
onde ele diverge.

## 1. Por que

Depois do `09`, o objeto central do painel passou a ser o **servidor MCP
virtual**: é nele que uma skill é publicada, é dele que saem as chaves e o
endereço, e é ele que responde em `/mcp`. O painel, porém, continuava sendo
um catálogo com formulários: a lista de servidores era uma tabela, o vínculo
de uma skill era uma linha com três caixas, e "quem está usando este
servidor?" não tinha resposta em lugar nenhum — o mcp-public não deixava
rastro dos clientes que atendia.

Três coisas pediam um redesenho:

- **o vínculo é uma relação, não um formulário.** Um servidor com três
  portas (Tools, Resources, Prompts) e skills ligadas a uma ou mais delas é
  um grafo, e um grafo se lê e se edita melhor num canvas do que numa tabela
  de caixas;
- **o servidor é vivo.** Há clientes conectados a ele agora, ou não há. Isso
  precisa aparecer onde o servidor aparece, e precisa de uma tabela que diga
  quem, de onde, por qual transporte e desde quando;
- **a moldura envelheceu.** O painel usava a pílula flutuante e as sombras do
  site; para um console de administração a referência é outra: sidebar com
  rótulos, um palco que ocupa a tela, pouca sombra, uma cor de ação.

A referência visual do redesign é `tmp/admin-page-01.png` (não versionada):
sidebar de 220px à esquerda, barra superior só com o sino, o palco num
painel com fio e raio de 12px, os servidores como cards com a miniatura das
skills e o estado no rodapé.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Escopo | Shell novo e **todas** as telas re-skinadas; os componentes internos do editor de skill (Markdown, árvore de arquivos, rolagem sincronizada, upload) são reaproveitados |
| 2 | Paleta | Extraída da imagem de referência (chassi `#14121B`, card `#1A1924`, roxo de ação `#7934C7`, verde `#3A8963`), completada com cinzas e roxo escuro; escuro é o padrão, claro é a rampa espelhada |
| 3 | Salvamento do vínculo | **Imediato, aresta a aresta**: conectar grava, desconectar grava, sem botão Salvar |
| 4 | Posições dos nós | **No banco, por vMCP, compartilhadas** (`pos_x`/`pos_y` no vínculo, `layout` no servidor) — todo admin vê o mesmo arranjo |
| 5 | Nó sem aresta | **Não existe**: tirar a última aresta tira a skill do servidor; ao adicionar, a paleta pergunta por quais portas ela entra (Tools pré-marcada) |
| 6 | Adicionar skill | Pela paleta ⌘K (busca no catálogo) ou pelo botão "Adicionar skill", que abre a mesma paleta |
| 7 | Janela de "online" | **2 minutos** (`MCP_SESSION_ONLINE_WINDOW_MS`), para sessões com id e para o stateless |
| 8 | Retenção das sessões | **Nunca apagar**: sem poda automática; a tabela é o histórico |
| 9 | Links externos da sidebar | Variáveis de ambiente (`ADMIN_DOCS_URL`, `ADMIN_SUPPORT_URL`, `ADMIN_CHAT_URL`), ocultos quando vazias; a documentação aponta para o GitHub por padrão |
| 10 | O sino | Avisos calculados da instalação **e** os últimos eventos de auditoria (admin), com "não lidos" por `localStorage` |
| 11 | Ícone da skill | Campo novo `skills.icon`: um emoji ou a URL http(s) de uma imagem; sem ícone, monograma pelas iniciais |
| 12 | Visão geral | Removida: Servidores MCP é a home, os números vão para as telas, a auditoria vira página própria |

Fechadas por derivação:

- **Sidebar igual à imagem.** A skill `admin-canvas-ui` prescreve um trilho
  de 56px só com ícones; a referência tem rótulos e ganhou. O resto do
  sistema da skill (rampa espelhada, geometria de 24px, paleta de comandos
  como superfície primária, painel lateral, estados vazios em quatro partes,
  vocabulário de movimento) foi adotado.
- **Lista vazia continua sendo tabela.** Nas telas de lista (servidores,
  skills, catálogos, trilha, sessões, chaves, contas) o cabeçalho fica e uma
  única linha centralizada diz "Nenhum … ainda" (`EmptyRow`). O botão de
  criar não se repete ali: ele já está na barra do título. Nas vistas em
  cards, sem itens, aparece a tabela. O estado vazio em quatro partes ficou
  para o sino.
- **Stack mínima.** Da lista da skill entraram só `@xyflow/react` (o palco),
  `cmdk` (a paleta) e `lucide-react` (ícones). TanStack Router, Jotai,
  TanStack Query, GraphQL, Radix avulso, Virtua, Zod e Tailwind v3 ficaram
  de fora: o painel já tinha react-router e Tailwind v4, é uma SPA de baixo
  volume com API REST própria, e cada dependência a mais é custo sem ganho
  aqui.
- **Sessões em duas telas.** A sidebar não ganha item: as sessões de um
  servidor ficam numa aba dele, e a lista global (com filtro por servidor)
  é a segunda aba de Auditoria. Quem não é admin vê só as dos servidores
  que administra.
- **A estrela do card é favorito**, por navegador (`localStorage`): fixa o
  servidor no topo da lista. O que marca o padrão é o selo "padrão".
- **"Online" no card é `is_active`**; o contador de clientes é outra coisa e
  aparece ao lado quando é maior que zero.

## 3. O painel

### 3.1 Shell

Três zonas: sidebar de 220px sem borda (a marca com o botão de recolher,
navegação, links externos e, no rodapé, a conta — o rodapé inteiro é o
botão que abre o menu da conta), barra superior de 56px (trilha, atalho da
paleta e o sino) e o palco — um painel com fio e raio de 12px que ocupa o
resto e rola por dentro. A página inteira nunca rola.

A sidebar recolhe para a esquerda pelo botão ao lado da marca e volta pelo
botão que aparece no início da barra superior; a escolha fica no
`localStorage` de cada navegador. Abaixo de 900px ela vira gaveta, aberta
pelo mesmo botão da barra e fechada pelo de recolher.

A marca é só o ícone e o nome, sem sufixo, e os dois vêm do servidor
(`ADMIN_BRAND_NAME`, `ADMIN_BRAND_ICON_URL`), junto com o título e o favicon
da aba e o cartão do login.

Os tokens vivem em `apps/admin/web/src/styles/tokens.css`, declarados
**escuro primeiro** e espelhados no claro: `--bg`, `--bg-elev`, `--surface-2`
a `--surface-4`, `--text` a `--text-faint`, `--accent`, `--ok`/`--warn`/
`--danger`/`--info` e as três cores de porta. Nenhum componente escreve hex;
não existe variante `dark:`. O arquivo **diverge de propósito** do
`tokens.css` do site e da homepage, que continuam idênticos entre si — o
painel deixa de ser cópia byte a byte (ver a nota no `04`). Os aliases
`--brand`, `--surface`, `--jade`, `--ember` e `--code-bg` existem só para o
`markdown.css` e a árvore de arquivos, que vieram do site sem mudança.

### 3.2 A paleta de comandos

⌘K abre a paleta em qualquer tela. Ela busca servidores e skills (a busca de
skills é do servidor, por isso a filtragem é nossa e não a do `cmdk`) e lista
os comandos registrados pela tela atual, em grupos de ordem fixa: Criar, Ir
para, Recurso, Conta, Perigo. Cada tela registra os seus ao montar e remove
ao desmontar (`useRegisterCommands`); comandos desabilitados aparecem
esmaecidos com o motivo. A paleta tem uma segunda página, "escolher skill",
usada pelo canvas. Atalhos: `g s`/`g k`/`g a`/`g u` navegam; no palco, `a`
adiciona e `f` enquadra; no editor, ⌘S salva.

### 3.3 O sino

Avisos calculados a partir do que as telas já sabem, cada um com o link para
onde se resolve: sem MCP padrão (ou padrão removido/desligado), skills sem
vínculo, contas com senha temporária, `MCP_PUBLIC_URL` vazia. A sessão de
bootstrap também gera aviso, mas nenhuma tela a resolve: o aviso sai da
sessão e abre o login já no cadastro do primeiro administrador
(`/?setup=1`), a mesma ação do menu da conta e da paleta. Para admin,
seguem os dez eventos mais recentes da trilha; os mais novos que a última
abertura contam como não lidos (`localStorage`). Nada disso é tabela nova.

### 3.4 Telas

| Rota | O que é |
|------|---------|
| `/mcps` | Servidores MCP, a home: cards (ou lista) com a colmeia de skills e catálogos (`13` §4), selos, estado e clientes online; ordenação; "Novo vMCP" num modal |
| `/mcps/:slug` | O servidor: abas Canvas, Sessões, Chaves, Configurações |
| `/skills`, `/skills/:slug/*`, `/skills/:slug/editar/*`, `/skills/new` | O catálogo (cards ou lista, filtro "sem vínculo"/"no site"), a ficha só leitura e a ficha de edição — as duas com as guias Skill, Propriedades e Acessos (`13` §3) — e criação/importação |
| `/auditoria`, `/auditoria/sessoes` | A trilha (filtros por ação, ator, texto e período; paginada) e as sessões MCP de todos os servidores |
| `/users`, `/users/:uuid/*`, `/users/:uuid/editar/*` | Usuários (admin): a lista, a ficha só leitura e a ficha de edição, com as guias Conta, Chaves, Acessos e Atividade (`13` §3.4) |
| `/configuracoes` | Instalação: o MCP padrão e o que veio do ambiente (admin) |
| `/account` | Minha conta: senha e chaves `psk_`; fechada na sessão de bootstrap, que não tem conta |

## 4. O canvas

### 4.1 Nós e arestas

Três tipos de nó, cada um um componente memoizado:

- **servidor** — 288px, com nome, endereço, selos e três portas à direita,
  cada uma com um handle de origem e a contagem de skills que saem por ela;
  um handle de entrada à esquerda, para a Internet;
- **skill** — ícone, nome e slug, com três handles de destino à esquerda,
  um por porta e na mesma ordem do servidor: cheio quando a porta está
  ligada, só o contorno quando não;
- **Internet** — o globo, à esquerda do servidor, com um handle de saída.

Duas arestas, uma por relação. A de **porta** (servidor → skill) é estática,
uma curva Bézier — a mesma da linha de conexão em andamento — que liga a
porta do servidor ao handle da mesma porta na skill, colorida pela porta,
com o rótulo e o ✕ aparecendo quando selecionada. A de **tráfego**
(Internet → servidor) é em ângulos retos com cantos arredondados e é a única
viva: brilho e partículas
proporcionais aos clientes online (desligadas em `prefers-reduced-motion`)
e, no meio, o contador "N sessões online", que abre a aba de sessões. O
contador vem de `GET /api/mcps/:slug/online` a cada 5 s enquanto a aba
estiver visível.

### 4.2 O que cada gesto grava

Toda mudança de aresta é uma escrita imediata pelo vínculo existente
(`PUT`/`DELETE /api/skills/:slug/mcps/:mcp`), com a aresta em estado
"salvando" (tracejada) até a resposta voltar e o detalhe do servidor ser
recarregado:

| Gesto | Efeito |
|-------|--------|
| Arrastar de uma porta até o handle da mesma porta na skill (ou o contrário) | liga a flag daquela porta (`PUT` com as flags atuais + a nova); porta trocada é recusada |
| Clicar num nó | abre a gaveta de detalhe; arrastar não seleciona nem abre a gaveta |
| Delete/Backspace numa aresta, ou o ✕ do rótulo | desliga a flag; se era a última, **tira a skill do servidor** (`DELETE`), com confirmação |
| Delete num nó de skill, ou "Tirar do servidor" na gaveta | `DELETE` do vínculo, com confirmação |
| "Adicionar skill" (botão, paleta ou `a`) | a paleta busca o catálogo; escolher abre o diálogo das portas (Tools pré-marcada) e o `PUT` cria o vínculo já com a posição do vão livre |
| Caixas de porta na gaveta | o mesmo `PUT`/`DELETE` |
| Arrastar um nó | `PUT /api/mcps/:slug/canvas`, agrupado (400 ms), sem auditoria |
| Reorganizar | recalcula tudo (servidor na origem, skills em coluna por nome) e grava |

A regra "nó = ao menos uma aresta" é a decisão 5: não existe vínculo sem
porta a partir do painel, o que mantém a regra atual do app e do mcp-admin
(`flagsFrom`). O banco continua aceitando as três flags desligadas, porque o
backfill do `011` grava assim; o canvas simplesmente não produz esse estado.

### 4.3 Posições

`virtual_mcp_skills.pos_x`/`pos_y` guardam a posição do nó da skill naquele
servidor; nulas = auto-layout (a coluna à direita do servidor, no primeiro
vão livre). `virtual_mcps.layout` (JSONB) guarda as posições do servidor e
do globo. Tudo em múltiplos de 24 (`snapGrid`). A posição cai junto com o
vínculo, e `setVirtualMcpSkills` preserva a de quem ficou. O viewport
(pan/zoom) não é persistido: o palco enquadra ao abrir.

Servidor sem skill abre só com o globo e o servidor: não há estado vazio no
palco, porque o botão "Adicionar skill" já fica fixo no canto.

Mover um nó **não** audita nem toca `updated_at`: é estado de tela, não
publicação. A escolha de gravar no banco, e não no navegador, é a decisão
4: dois administradores precisam ver o mesmo arranjo.

### 4.4 Permissão

A mesma de sempre: o dono do servidor ou um admin (`loadManaged`). Quem
não administra vê o canvas em modo leitura — sem arrastar, conectar ou
adicionar — e a gaveta sem as caixas.

## 5. Sessões do MCP público

### 5.1 A tabela

`mcp_sessions`, uma linha por cliente conectado a um vMCP: `session_id`,
`transport` (`streamable`/`sse`/`stateless`), `mount` (`root` ou
`virtual`), o vMCP (uuid com `ON DELETE SET NULL` **e** o slug copiado, para
o histórico sobreviver à remoção), `auth` (`open`/`key`) e a chave, `ip`,
`user_agent`, `client_name`/`client_version` (o `clientInfo` do
`initialize`), `started_at`, `last_seen_at`, `ended_at` + `end_reason`
(`closed`, `timeout`, `shutdown`) e `request_count`. Detalhes no cabeçalho
da migration `015` e no [README do banco](../database/README.md).

O IP é o `req.ip` do Express com o `trust proxy` já configurado
(`TRUST_PROXY`): atrás do proxy reverso é o primeiro salto confiável do
`X-Forwarded-For`; sem proxy, o endereço do socket.

### 5.2 "Online" é uma expressão, não uma coluna

`ended_at IS NULL AND last_seen_at >= now() - janela`. A janela é
`MCP_SESSION_ONLINE_WINDOW_MS` (2 min), lida pelos dois lados — o painel a
passa em toda consulta, o mcp-public a usa para agrupar o stateless. Uma
coluna envelheceria entre duas varreduras; a expressão é verdadeira no
instante em que se pergunta.

Nos transportes com sessão a linha nasce no `initialize` (Streamable) ou no
`GET /sse`, e termina quando o cliente fecha (`closed`), o TTL vence
(`timeout`, o mesmo TTL do mapa em memória, `MCP_SESSION_TTL_MS`) ou o
processo para (`shutdown`). No stateless não há sessão: o cliente é
reconhecido por IP + agente + credencial + vMCP (uma chave sintética
`sl_<hash>`), e as requisições dele dentro da janela caem na mesma linha;
passada a janela, a próxima abre outra e a varredura fecha a antiga com o
fim **presumido** — `last_seen_at` mais a janela, o instante em que ela
deixou de estar online, e não o instante da varredura.

### 5.3 O rastreador (`apps/mcp-public/src/sessions.ts`)

`http.ts` avisa o rastreador em cada evento de transporte: sessão aberta,
requisição atendida, sessão fechada, requisição stateless. As escritas são
disparadas e o erro vai para o log: um `INSERT` lento ou recusado não atrasa
nem nega uma resposta MCP. Os toques (`last_seen_at`, `request_count`) são
agrupados — um `UPDATE` a cada 10 s por sessão, ou no fechamento — e a
varredura (a cada 60 s) leva os pendentes e chama `expireMcpSessions`.
Depois de um restart, a primeira requisição stateless de um cliente reusa a
linha aberta que ainda estiver na janela (`findOpenMcpSession`).

### 5.4 Sem poda

Decisão 8: a tabela nunca é apagada pelo software. Uma linha por sessão é
barata e o histórico de quem usou cada servidor vale mais do que o espaço.
Se um dia for preciso, é uma migration com a política escrita.

## 6. O ícone da skill

`skills.icon`, opcional: um único emoji (com modificadores, ZWJ, bandeira ou
keycap) ou a URL http(s) de uma imagem, até 512 caracteres
(`isValidSkillIcon` em `packages/shared/src/icon.ts`; o banco recusa o
resto com 400). Aparece nos cards, nos nós do canvas, na miniatura do
servidor e na paleta. Sem ícone — ou com a imagem quebrada — o painel
desenha um monograma pelas iniciais sobre uma cor derivada do slug, estável
para a mesma skill. O campo entra no formulário da skill, no import e nas
tools `create_skill`/`edit_skill` do mcp-admin; **não** vai para o
frontmatter do `SKILL.md`, porque é um atributo do catálogo, não da skill.

## 7. Configuração

| Variável | Quem lê | Padrão |
|----------|---------|--------|
| `MCP_SESSION_ONLINE_WINDOW_MS` | admin e mcp-public | `120000` |
| `ADMIN_DOCS_URL` | admin | o README no GitHub |
| `ADMIN_SUPPORT_URL`, `ADMIN_CHAT_URL` | admin | vazias (somem do menu) |
| `ADMIN_BRAND_NAME` | admin | `SITE_NAME` (`Purple Skills`) |
| `ADMIN_BRAND_ICON_URL` | admin | `/assets/images/purple-hat-256.png`; URL http(s) ou caminho, inválido derruba o boot |
| `APP_VERSION` | admin (só exibição) | vazia |

## 8. Riscos aceitos

- **Uma escrita por gesto.** Conectar e desconectar gravam na hora; não há
  "desfazer" além de refazer o gesto. O canvas mostra o estado salvo, então
  um erro de rede deixa a aresta como estava e avisa.
- **O stateless agrupa por IP + agente.** Dois clientes iguais atrás do mesmo
  NAT, com o mesmo agente e a mesma credencial, contam como um. É o melhor
  que o transporte permite sem sessão.
- **A tabela cresce para sempre**, por decisão. Os índices parciais mantêm
  as consultas de online baratas mesmo com histórico grande.
- **Posições compartilhadas** significam que um administrador reorganiza o
  canvas de todos. É o que se pediu.
- **Toques agrupados** significam que `last_seen_at` pode atrasar até 10 s
  em relação à última requisição.

## 9. Fora do escopo

- Viewport (pan/zoom) persistido, agrupamento de nós, undo/redo no canvas.
- Um canvas na página da skill (a skill no centro e os servidores em volta).
- Estatísticas de uso derivadas das sessões (requisições por hora, por
  cliente).
- Migração do site e da homepage para a rampa espelhada.
