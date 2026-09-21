# Atividade: a grade do ano e o relatório agregado do dia

**Status: em implementação**, num PR. Entrevista de 21/09/2026.
Migration `032-atividade.sql`.

Este documento registra *por que* cada peça é assim; o resumo do que está no
ar entra em [`02-architecture-decisions.md`](02-architecture-decisions.md)
§12.9 e os desvios em
[`03-implementation-notes.md`](03-implementation-notes.md). A especificação
dos dados é a seção `atividade` de `packages/shared/src/types.ts`, e os
comentários dela valem tanto quanto este texto.

> **Revoga um ponto de [`10`](10-admin-canvas-e-sessoes.md):** o item
> "Estatísticas de uso derivadas das sessões (requisições por hora, por
> cliente)" da `§9`. A marca está lá, e o alcance dela é estreito: esta tela
> deriva estatística das sessões, sim, mas **por dia e agregada** — os dois
> recortes que aquele parêntese nomeia, a série por hora e o número por
> cliente, continuam não existindo (`§12`).
>
> **E o item de estatísticas de outros três documentos**, cada um marcado no
> ponto: o "leituras por dia" da `§8` do [`13`](13-fichas-e-acessos.md) — as
> leituras passam a ser contadas por dia, somadas; por cliente e por servidor,
> não —, e o "estatísticas por vMCP além dos contadores do vínculo" da `§9`
> do [`08`](08-mcp-virtual.md) e da `§6` do
> [`09`](09-mcp-padrao-e-skills-flutuantes.md), porque o relatório do dia traz
> os servidores mais chamados, que é um número por vMCP.
>
> **Não revoga mais nada.** Conferi ponto a ponto o
> [`12`](12-acesso-granular.md) — a tela é só de admin e não abre recorte
> nenhum por nível de acesso, então nenhuma regra de quem enxerga o quê muda
> —, o resto do [`13`](13-fichas-e-acessos.md) — a guia Auditoria da skill, a
> do catálogo e a guia Acessos da conta continuam sendo o evento a evento, e
> **ninguém passa a gravar leitura nova**: as fontes são as que já existiam —
> e o [`17`](17-skills-extension.md), cujos três métodos esta tela apenas
> classifica (`§6`), sem mexer no que eles fazem. Registrar a ausência é parte
> da regra de [`AGENTS.md`](../AGENTS.md): quem revoga enumera, e quem não
> revoga diz que conferiu.

## 1. Por que

Esta instalação carimba a hora de quase tudo o que acontece nela, em três
tabelas que **nunca tinham sido lidas por dia**:

- `mcp_sessions` (`10`, migration `015`) sabe quem se conectou a cada vMCP, de
  qual transporte e com qual credencial — e é lida só como "quem está online
  agora" e como a lista de sessões;
- `skill_accesses` (`13`, migration `018`) tem uma linha por leitura de skill,
  e é lida só na guia Auditoria de uma skill, de um catálogo ou de uma conta;
- `audit_log` (`001`) tem o que mudou no catálogo, e é lida só como a trilha,
  filtrada por ação, ator ou texto.

As três respondem "o que aconteceu com **este** objeto". Nenhuma respondia "o
que aconteceu **ontem**", e a pergunta que o mantenedor faz de fato — "esta
instalação está sendo usada? mais ou menos do que no mês passado? em que dia
apareceu movimento?" — não tinha tela.

Faltava também um número que nenhuma das três guarda: **quantas chamadas o MCP
público atendeu**. `mcp_sessions.request_count` conta requisições por sessão,
sem dizer o quê; `skill_accesses` só registra leitura de skill, que é uma
fração pequena do tráfego — `initialize`, `tools/list`, `ping` e
`search_skills` não deixam rastro nenhum. Um dia com mil chamadas e um dia com
dez pareciam iguais em toda tela existente.

A tela de Atividade é a resposta: uma **grade de dias** no alto, uma célula por
dia, com a cor pela quantidade de movimento; clicar num dia abre, abaixo, o
**relatório agregado** daquele dia.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Quem vê | **Só admin**, como a Auditoria, e no mesmo bloco da sidebar — o item "Atividade" fica **acima** de "Auditoria" |
| 2 | Recorte por vMCP | **Não existe na v1.** A tela é da instalação inteira; quem administra um servidor continua com as sessões e as chaves dele |
| 3 | O que uma célula mede | A **soma** das quatro fontes do dia: sessões abertas + chamadas MCP + leituras de skill + eventos da trilha (`ActivityDay.total`) |
| 4 | Escala de cor | **Relativa ao período** desenhado, não absoluta: o nível é o **quartil da posição** do dia entre os dias com atividade da grade, e quem soma o maior total fica sempre no tom cheio (`§3.2`) |
| 5 | Qual é o dia | O **dia do calendário de quem olha**. O painel converte o dia em instantes e manda `since`/`until`; o fuso IANA chega ao SQL **só** na série (`§4.2`) |
| 6 | Conversão dia → instante | A **mesma** lógica já testada de `auditRange`/`inicioDoDia` (`apps/admin/web/src/audit.ts`), sem uma segunda convenção de data no painel |
| 7 | Contagem de chamadas | Tabela nova, `mcp_call_counters`: **balde de 15 minutos** (`MCP_CALL_BUCKET_MS`), acumulado em memória pelo rastreador do MCP público e despejado no mesmo flush agrupado que já grava `request_count` |
| 8 | O que o balde guarda | Balde, vMCP (uuid **e** slug), transporte, método e a contagem. **Nada mais** — sem nome de tool, argumento, IP, e-mail ou `session_id` |
| 9 | Famílias | `tools`, `resources`, `prompts`, `skills`, `session`, `other`, classificadas **por prefixo** do método; `resources/directory/read` conta como `skills` |
| 10 | Corpo do relatório | **Agregado**: a menor unidade é "quantas vezes". Nenhum campo identifica uma operação, uma pessoa ou uma máquina |
| 11 | Retenção | **Nenhuma poda automática**, como `mcp_sessions` (decisão 8 do [`10`](10-admin-canvas-e-sessoes.md)) e `skill_accesses` (decisão 14 do [`13`](13-fichas-e-acessos.md)) |
| 12 | Superfícies | Tela `/activity` no painel; `GET /api/activity` (a série) e `GET /api/activity/:day` (o relatório) |

Fechadas por derivação:

- **Dia sem linha é dia sem atividade.** A série devolve só os dias com
  alguma coisa, e é o painel que completa a grade com zeros. É o contrário do
  `Stats`, em que faltar é "não sei": aqui faltar **é** zero, porque as quatro
  fontes gravam sempre que algo acontece.
- **O relatório não leva fuso ao banco.** `activityOfDay` recebe dois
  instantes e devolve contagens; `day` e `timezone` do corpo são eco do que o
  painel pediu (`§4`). Quem agrupa por dia — e portanto precisa do fuso — é só
  a série.
- **Balde sem vMCP resolvido não existe.** `McpCallBucketInput.virtualMcpUuid`
  nunca é nulo: é o mesmo `scopeOf` que já decide de quem é a sessão. Uma
  chamada que não chegou a resolver servidor nenhum não chega ao contador.
- **As listas "mais…" têm teto**, pedido pelo chamador (`top` de
  `activityOfDay`). Elas são um ranking, não um dump: o relatório de um dia
  cheio não pode virar a lista de todos os métodos que existem.
- **Gravar é melhor esforço**, como o registro de acessos e as sessões: um
  `UPDATE` lento ou recusado vai para o log e não atrasa nem nega uma resposta
  MCP.
- **Slug e nome copiados, como em toda tabela de histórico daqui.** O balde
  guarda o slug do vMCP ao lado da uuid, e é isso que deixa o relatório de um
  dia antigo continuar legível depois que o servidor foi removido — a mesma
  regra do `10` `§5.1` e do `13` `§5`.

## 3. A grade

Uma célula por dia, em colunas de semana, com a cor pela quantidade de
movimento. A referência visual é `tmp/activity-01.png` (não versionada, como a
do `10`): a faixa de meses no alto, as iniciais dos dias da semana à esquerda,
uma coluna por semana e a legenda de intensidade ao pé. O que a referência
**não** tem é o relatório — clicar num dia e abrir o detalhe dele abaixo da
grade foi o pedido do mantenedor, e é metade desta entrega.

### 3.1 O que a célula mede

O `total` de `ActivityDay`, que é a soma das quatro parcelas: **sessões**
abertas no dia, **chamadas** JSON-RPC recebidas pelo MCP público, **leituras**
de skill por qualquer superfície e **eventos** da trilha. As quatro aparecem
separadas no relatório; na célula elas viram um número só.

Somar coisas de naturezas diferentes é deliberado e tem um custo, registrado
na `§11`: uma sessão, uma chamada, uma leitura e um evento valem 1 cada, e
chamadas são, de longe, a parcela mais numerosa. A célula responde **"houve
movimento aqui?"**, não "houve tanto trabalho aqui". Quem quer o peso de cada
coisa clica no dia — é para isso que o relatório existe.

A alternativa seria uma grade por fonte (quatro grades) ou uma soma
ponderada. A primeira transforma "como foi o ano" em quatro perguntas; a
segunda inventa pesos que ninguém consegue defender.

### 3.2 Por que a escala é relativa ao período — e por quartil

A cor do dia sai da **posição** dele entre os dias **com atividade** da grade
desenhada: não há faixa fixa de valor absoluto, e não há razão entre o total do
dia e o maior total. A regra é a de `activityLevel`
(`apps/admin/web/src/activity.ts`), nesta ordem:

1. dia sem atividade nenhuma é **nível 0**;
2. se todos os dias ativos do período somam o **mesmo** total — inclusive
   quando há um só —, todos ficam no **nível 2**, o do meio: não há comparação
   a fazer. O 4 diria "pico" sem régua, e o 1 deixaria o único dia com
   movimento de uma instalação nova quase indistinguível do dia vazio ao lado;
3. quem soma o **maior total do período** é **nível 4**, empatado ou não;
4. o resto é o quartil da posição: com `abaixo` = quantos dias ativos somaram
   estritamente menos, o nível é `ceil(4 × (abaixo + 1) ÷ dias ativos)`, preso
   entre 1 e 4.

A posição é a **menor** que o valor ocupa — empate não sobe —, senão quarenta
dias de "1 leitura" e um de mil sairiam todos no tom cheio. E é por isso que o
máximo precisa da garantia do passo 3: pela posição menor, um empate no topo
não chegava ao 4 sozinho, e nove dias de total 2 ao lado de um de total 1 davam
`ceil(4 × 2 ÷ 10) = 1` para os nove — a rampa inteira achatada no degrau mais
fraco, com o dia mais cheio junto.

**Por que não uma escala absoluta.** Ela exigiria saber o que é "muito" nesta
instalação, e não há esse número: uma instalação de time tem dezenas de
chamadas por dia, uma que serve um MCP aberto tem milhares. Com faixas fixas, a
primeira ficaria apagada o ano inteiro e a segunda, saturada o ano inteiro — nos
dois casos a grade não diria nada, que é exatamente o defeito que ela existe
para resolver.

**E por que não a razão pelo maior total**, que parece a escolha natural e é o
que este documento descrevia até a revisão de 21/09: ela é refém do máximo.
Basta um pico raro — o dia em que um agente varreu o catálogo e somou dez mil
chamadas — para todo dia normal de duzentas valer 2 % daquele número e cair no
primeiro degrau: o ano inteiro pintado de quase-vazio justamente onde houve uso
constante, que é o defeito que a escala relativa existia para evitar. Pela
posição, o pico é **um** dia entre os outros: ele fica no alto, e os dias
comuns continuam se distinguindo entre si.

O preço é que a mesma cor significa números diferentes em períodos diferentes,
e que a rampa fala de **ordem**, não de proporção: dois degraus vizinhos podem
estar a uma chamada ou a mil um do outro. É o compromisso de qualquer mapa de
calor de contribuição, e o relatório do dia está a um clique para desfazer a
ambiguidade.

## 4. O dia é o de quem olha

A convenção do painel já existe e é uma só: **dia do calendário de quem
olha**, o mesmo fuso em que a coluna "Quando" da trilha mostra cada evento.
Esta tela não abre uma segunda.

### 4.1 A conversão é a de `auditRange`

O servidor compara instantes; o navegador é quem sabe o fuso. Então é no
painel que o dia vira instante, com `auditRange`/`inicioDoDia`
(`apps/admin/web/src/audit.ts`) — a mesma função da trilha, e não uma cópia.

Repetir a conta à mão custou caro uma vez: na trilha, "Desde" saía em UTC e
"Até", em hora local, e a janela vinha deslocada pelo fuso
(`tasks/044`). Num fuso UTC-3, "hoje" pedia **27 horas** de eventos, três
delas do dia anterior — e o erro não aparece como erro, aparece como um
número maior do que devia. A regra que ficou: **quem precisa de um dia do
navegador em instantes chama `auditRange`**, e o "Até" é o último
milissegundo do dia, calculado pelo calendário (o começo do dia seguinte
menos 1 ms), porque no dia de 25 horas o texto `T23:59:59.999` acontece duas
vezes.

### 4.2 Por que o fuso vai ao SQL na série e não no relatório

As duas consultas precisam do dia, mas em lugares diferentes do trabalho:

- **a série** agrupa: ela precisa dizer a **qual** dia cada carimbo pertence,
  para um ano inteiro de uma vez. Isso é `AT TIME ZONE` dentro do `GROUP BY`,
  e é o SQL que tem a base IANA — fazer no painel obrigaria a trazer as linhas
  cruas de um ano para o navegador;
- **o relatório** não agrupa: ele conta o que está **entre dois instantes**,
  que o painel já calculou. Mandar o fuso junto seria mandar um dado que a
  consulta não usa, e dois lugares para a mesma verdade é como nasce a
  divergência de um dia entre a grade e o relatório dela.

Por isso `listActivityDays` recebe `timezone` e `activityOfDay` não, e por
isso `ActivityReport.day`/`timezone` são eco do pedido: eles dizem **qual dia
o painel pediu**, não qual dia o banco recortou.

A rota do relatório aceita um `tz` assim mesmo, e ele **para na camada do
painel** (`apps/admin/src/activity.ts`): serve para derivar a janela quando
`since`/`until` não vêm — o `:day` sozinho não delimita instante nenhum — e
para ecoar o fuso no corpo. Ao banco ele não chega, e é isso que mantém
verdadeira a frase acima.

## 5. O balde de 15 minutos

`mcp_call_counters` não guarda chamadas: guarda **contagens de chamadas** por
`(balde, vMCP, transporte, método)`. O balde é o piso de 15 minutos do
instante da chamada (`MCP_CALL_BUCKET_MS`).

### 5.1 Por que 15 minutos

Porque é o **maior** balde que ainda permite recortar o dia em qualquer fuso.
Todo deslocamento da base IANA é múltiplo de 15 minutos — o `+05:45` do Nepal
é o caso extremo, e existe —, então a meia-noite de qualquer fuso cai sempre
numa borda de balde, e a soma de um dia é a soma de um conjunto inteiro de
baldes, sem sobra e sem parte.

- **Uma hora** quebraria isso: em Katmandu, o dia começaria no meio de um
  balde, e o relatório somaria 45 minutos do dia vizinho — um erro pequeno,
  permanente e invisível.
- **Um dia** quebraria mais: o fuso teria de ser escolhido na **gravação**,
  congelado para sempre, e o número nunca fecharia com o das outras três
  fontes, que são instantes exatos e se recortam em qualquer fuso na leitura.

### 5.2 Por que contador agregado, e não uma linha por chamada

Porque o caminho quente do MCP é justamente o que não interessa uma a uma.
`tools/list` e `ping` são repetidos por todo cliente conectado, em toda
reconexão; um agente ativo produz chamadas em ordens de grandeza acima do que
produz leitura de skill.

E as duas tabelas vizinhas são **"nunca apagar"** por decisão —
`mcp_sessions` (`10`, decisão 8) e `skill_accesses` (`13`, decisão 14). Uma
terceira tabela de histórico, com uma linha por mensagem JSON-RPC e a mesma
promessa de retenção, seria a maior tabela da instalação por uma ordem de
grandeza, guardando o dado de menor valor unitário que existe aqui: "alguém
chamou `ping`".

O contador troca isso por um `UPDATE` num punhado de linhas: num quarto de
hora, um vMCP num transporte produz **uma linha por método distinto**, e os
métodos que um cliente usa são poucos. O que se perde — a hora exata de cada
chamada e a ordem entre elas — é justamente o que a `§8` não quer guardar.

### 5.3 Onde o balde é somado

No rastreador de sessões do MCP público (`apps/mcp-public/src/sessions.ts`),
que já é avisado a cada mensagem e já agrupa escrita: os toques de
`last_seen_at`/`request_count` saem num `UPDATE` agrupado, e o balde pega
carona no mesmo despejo, no mesmo `sweep` e no mesmo `shutdown`. Não há timer
novo, não há segunda conexão e não há escrita por chamada.

A consequência de o número viver em memória até o despejo está na `§11`.

## 6. As famílias são por prefixo

Um relatório com uma linha por método é uma lista; o que se quer ler primeiro
é a forma do tráfego. Daí as seis famílias de `mcpCallFamily`:

| Família | O que cai nela |
|---------|----------------|
| `tools` | `tools/*` — `tools/list` e o `tools/call` das cinco ferramentas do MCP público |
| `resources` | `resources/*`, menos a exceção abaixo |
| `prompts` | `prompts/*` |
| `skills` | `skills/*` **e** `resources/directory/read`, os três métodos da extensão SEP-2640 ([`17`](17-skills-extension.md)) |
| `session` | `initialize`, `ping`, `notifications/*`, `completion/*` — o que abre e mantém a conversa, e não é consumo de conteúdo |
| `other` | tudo o mais |

**A classificação é por prefixo, e não por uma lista fechada de métodos.** O
protocolo ganha método novo — a SEP-2640 acabou de fazer isso —, e uma lista
fechada faria o método novo **sumir** da conta, ou cair em `other` sem
explicação. Um `tools/algo` que ainda não existe é mais honesto dentro de
`tools`: a família responde "que porta do servidor está sendo usada", e a
porta é o prefixo. `other` existe para o que não tem prefixo conhecido, e um
`other` que cresce é justamente o sinal de que algo novo chegou.

`resources/directory/read` é a exceção que a extensão criou: pelo prefixo ele
seria `resources`, mas o que ele lê é a árvore de uma skill. Ele conta como
`skills` porque é assim que a pergunta "quanto a extensão de skills está sendo
usada?" tem resposta certa.

As famílias também são o vocabulário que o painel já usa: são as três portas
do vMCP do canvas (`--port-tools`, `--port-resources`, `--port-prompts`), mais
as duas que nasceram depois.

## 7. O que os números **não** são

Esta seção existe para que ninguém leia a tela como ela não é. Cada item é uma
diferença conhecida entre o número mostrado e a coisa que ele parece medir.

- **Chamada recebida não é chamada bem-sucedida.** O rastreador é avisado
  **antes** do despacho da mensagem, então uma chamada que terminou em erro de
  aplicação, skill não encontrada ou recusa de permissão conta igual a uma que
  entregou conteúdo. É o preço de contar no transporte, que é o único lugar
  que enxerga toda mensagem, inclusive as que o SDK responde sozinho.
- **O que é recusado antes do rastreador não entra.** O 429 do limite de taxa,
  o 400 do lote acima de `MCP_MAX_BATCH`, o 403 de sessão que pertence a outra
  credencial, o 404 de sessão desconhecida e a recusa por lotação acontecem em
  middleware, antes de qualquer contabilidade. Um ataque de repetição aparece
  no log, não na grade.
- **O teto de identidades stateless deixa de contar tráfego que foi
  atendido.** Com o mapa de identidades do rastreador cheio
  (`MCP_MAX_STATELESS_SESSIONS`, padrão 5 000), uma identidade **nova** não
  entra: o rastreador avisa no log e devolve **antes** de criar a entrada
  (`apps/mcp-public/src/sessions.ts`), enquanto o `http.ts` segue atendendo a
  requisição normalmente. Ela não vira linha em `mcp_sessions` nem chamada em
  `mcp_call_counters` — ao contrário do item acima, aqui o cliente recebeu o que
  pediu e a grade não soube. Quem já está no mapa continua contado, então o que
  some é a ponta nova de uma enxurrada; perder estatística é o preço de não
  deixar um `user-agent` variável encher uma tabela que nunca é podada.
- **`other` na lista de métodos não é um método chamado "other".** Uma entrada
  do rastreador conta no máximo 64 métodos distintos; passado isso, o excedente
  **continua contado**, somado na chave `other` (que cai na família `other`,
  `§6`). O total do dia e as fatias por família ficam certos; o que se perde é
  qual método inventado cada chamada era — e é por isso que este teto não tem
  variável de ambiente: nada deixa de ser contabilizado.
- **Os números de cliente são um piso.** No stateless não há sessão: o cliente
  é reconhecido por IP + agente + credencial + vMCP (`10` `§5.2`), então dois
  clientes iguais atrás do mesmo NAT contam como **um**. `sessions` e
  `distinct` erram para baixo, e não há como fazer melhor sem sessão.
- **E `sessions` conta aberturas, não pessoas.** Uma sessão reciclada pelo
  teto da credencial (`MCP_MAX_SESSIONS_PER_IDENTITY`) fecha e a próxima
  requisição abre outra linha; um cliente que reconecta dez vezes num dia são
  dez sessões.
- **"Clientes conectados" fala só do MCP público.** O mcp-admin não tem
  rastreador de sessões — nunca teve, e esta entrega não criou um. As leituras
  feitas por lá entram em `reads` (origem `mcp-admin`, decisão 13 do
  [`13`](13-fichas-e-acessos.md)); as chamadas dele **não** entram em `calls`,
  e as conexões dele não entram em `clients`.
- **`reads` não é "quantos arquivos saíram".** O `get_skill` de um `SKILL.md`
  grande demais para o resultado devolve os metadados e o link **sem**
  registrar leitura — leitura que não entregou o texto não é visualização, e
  quem seguir o link conta na rota do arquivo —, e `get_skill_file` nunca
  registrou. As duas chamadas contam em `calls`; nenhuma conta em `reads`.
  A diferença entre as duas parcelas é informação, não defeito.
- **O painel não grava leitura** (decisão 13 do
  [`13`](13-fichas-e-acessos.md)): o operador que passa a tarde abrindo fichas
  não mexe em `reads`. O que ele muda aparece em `catalog`, pela trilha.
- **`reads` não fecha com os contadores do acervo.** Ele conta **linhas** de
  `skill_accesses`; `view_count`/`download_count` somam por caminho, na skill
  e no vínculo ou nos catálogos que contribuíram (`11` `§3.3`). São duas
  perguntas diferentes sobre o mesmo evento.
- **A contagem de chamadas começa no dia em que ela subiu.** As três tabelas
  antigas têm histórico; `mcp_call_counters` nasce vazia. Todo dia anterior à
  migration aparece na grade **sem** a parcela de chamadas — e, como chamadas
  são a parcela mais numerosa, a grade tem um degrau visível ali. É assim, e
  passa sozinho com o tempo.

## 8. Privacidade

O corpo do relatório é agregado de ponta a ponta: **nenhum campo de
`ActivityReport` carrega IP, e-mail, `session_id`, nome de chave, nome de
tool ou argumento de chamada.** A menor unidade é "quantas vezes".

Onde dá para confundir, a escolha foi sempre a agregada:

- `clients.distinct` conta identidades distintas **sem nomeá-las** — o
  `session_id`, que no stateless já é um hash de IP + agente + credencial +
  vMCP, é contado e descartado;
- `clients.topAgents` traz o nome de agente declarado no `initialize`
  (`clientInfo.name`), sem versão e sem IP: é "Claude Code", não "quem";
- `catalog.actors` conta atores distintos da trilha **sem identificar** quem
  são — a trilha, essa sim, nomeia cada um, e é o lugar de olhar;
- a contagem de chamadas nem chega a ter o que descartar: pela decisão 8, o
  identificador nunca é gravado. É a única das quatro fontes que **nasce**
  agregada; as outras três guardam a linha e são somadas na leitura.

**Quem precisa do evento a evento continua tendo onde ir**, com a permissão de
sempre: a trilha (`/audit`) para o que mudou, as sessões
(`/audit/sessions`) para quem se conectou, a guia Auditoria da skill e do
catálogo e a guia Acessos da conta (`13` `§5.3`) para quem leu o quê. A tela
de Atividade não substitui nenhuma delas e não é atalho para nenhuma.

## 9. Só admin

Como a Auditoria, e no mesmo bloco da sidebar — o item "Atividade" fica acima
de "Auditoria", porque é a visão de cima e a trilha é o detalhe.

O motivo é o conteúdo: o relatório cruza os quatro cantos da instalação de uma
vez. Não há como entregá-lo a quem enxerga uma parte sem recortar as quatro
fontes pelo nível de acesso de quem pergunta — e `audit_log` não tem recorte
por vMCP nenhum, nem deveria ter.

Um recorte por vMCP é possível e ficou **fora da v1** (decisão 2): das quatro
fontes, três sabem de qual servidor vieram, e a quarta, não. Quem administra
um servidor continua com as sessões dele na aba do próprio servidor, que é o
número que ele de fato pergunta.

## 10. O banco e as rotas

A migration é `032-atividade.sql`, do domínio do dba. Ela cria
`mcp_call_counters` e **quatro** índices:

- `mcp_call_counters_bucket_idx` (`bucket DESC`), a faixa do heatmap e a do
  relatório do dia — as duas filtram `bucket >= … AND bucket <= …`;
- `mcp_call_counters_virtual_mcp_idx` (`virtual_mcp_uuid`), que serve à
  varredura do `ON DELETE SET NULL` quando um vMCP é apagado: a PK começa por
  `bucket` e não acha as linhas de um servidor;
- `mcp_sessions_started_at_idx` e `mcp_sessions_ended_at_idx`, os dois que
  faltavam na tabela de sessões. Os índices que a `015` criou olham
  `last_seen_at` (a pergunta de "online"), a sessão aberta e a chave; contar
  sessões **abertas** num dia (`started_at`, a série) e **encerradas** num dia
  (`ended_at`, o relatório, que ainda as quebra por motivo — uma sessão pode
  ter começado ontem) são perguntas novas sobre a mesma tabela (`03`, "Painel:
  atividade").

Três funções em `@purple-skills/db`, que são o contrato com os apps:

```
bumpMcpCallCounters(items)                    soma os baldes fechados (mcp-public)
listActivityDays({ since, until, timezone })  a série da grade        (admin)
activityOfDay({ since, until, top })          o relatório de um dia   (admin)
```

E duas rotas no painel, além da tela `/activity`:

```
GET /api/activity            ?since=&until=&tz=        a série       admin
GET /api/activity/:day       ?since=&until=&top=&tz=   o relatório   admin
```

**O parâmetro do fuso chama-se `tz` nas duas rotas**, e não `timezone`:
`timezone` é o nome do campo na função do banco (`listActivityDays`) e no corpo
da resposta, mas a query string é curta, como nas outras superfícies daqui.
Escrever `?timezone=` não dá erro nenhum — a rota não enxerga esse parâmetro e
cai no padrão `UTC` —, e o resultado é uma série recortada em UTC para quem
pensa ter pedido outro fuso.

Na **série**, `since` e `until` são obrigatórios: sem os dois é 400, sem
consultar o banco, porque a faixa é o calendário de quem olha e o servidor não
o adivinha. O corpo devolve a faixa que foi de fato lida, já saturada em
`ACTIVITY_RANGE_MAX_DAYS` (400 dias) — quem pede dez anos recebe os últimos
400, sem erro.

No **relatório**, o `:day` é `AAAA-MM-DD` e volta no corpo junto com o fuso,
como eco do que foi pedido (`§4.2`); `since`/`until` são os instantes que o
painel calculou para aquele dia e são **opcionais** — faltando, a camada do
painel deriva a janela do próprio `:day` no `tz` informado, do primeiro
instante do dia ao último milissegundo dele. `top` é o teto das listas "mais…":
padrão 5, preso entre 1 e 50 pelo banco; ausente ou com lixo, vale o padrão de
lá, e não um número repetido aqui.

## 11. Riscos aceitos

- **A célula soma unidades diferentes** (`§3.1`). Uma sessão pesa o mesmo que
  uma chamada de `ping`, e chamadas dominam o total. A cor diz "houve
  movimento", e o relatório do dia diz de quê.
- **A escala relativa muda de significado com o período** (`§3.2`): a mesma
  cor em duas grades diferentes não é o mesmo número, e o quartil ordena sem
  dizer distância — dois degraus vizinhos podem estar a uma chamada ou a mil um
  do outro. O que ela não faz é achatar a grade por causa de um dia atípico:
  isso era o defeito da razão pelo maior total, e é a razão de o nível ser
  posição.
- **O que não foi despejado morre com o processo.** O balde vive em memória
  entre despejos; o desligamento limpo despeja, um `SIGKILL` não. Perde-se, no
  pior caso, o que entrou desde o último despejo — é o mesmo risco que
  `request_count` já corre desde o `10`, e a contabilidade é de tendência, não
  de cobrança.
- **A tabela cresce para sempre**, como as duas vizinhas e pelo mesmo motivo
  (decisão 11). Ela é agregada, então cresce com o número de métodos
  distintos vezes os quartos de hora em que houve tráfego, e não com o número
  de chamadas — mas cresce. Se um dia for preciso podar, é uma migration com a
  política escrita, como o `10` `§5.4` e o `13` `§7` já prometeram para as
  delas.
- **O degrau do primeiro dia** (`§7`): a grade mostra o passado sem a parcela
  de chamadas, e isso não tem conserto retroativo — o dado não existia.
- **A janela de "hoje" está sempre incompleta.** O dia corrente é um dia em
  andamento, e a última fatia dele pode ainda não ter sido despejada.

## 12. Fora do escopo

- **Nome de tool e argumentos na contagem.** Saber **quantas vezes** o dia
  chamou `tools/call` é útil; saber **qual** skill foi pedida a cada vez é o
  registro de acessos, que já existe, tem dono e tem permissão própria (`13`
  `§5`). Guardar
  argumento seria guardar conteúdo de consulta — o termo que alguém buscou em
  `search_skills` — numa tabela que a decisão 10 promete ser agregada.
- **Poda ou retenção automática.** Nenhuma das três tabelas de histórico tem, e
  esta entrega não abre a exceção.
- **Teste de ponta a ponta da tela.** A conta de cada número é testada onde ela
  é feita — a conversão de dia no painel, a agregação no banco —, e um E2E de
  mapa de calor testaria sobretudo o navegador.
- **Série por hora e número por cliente** — os dois recortes que o item
  revogado do [`10`](10-admin-canvas-e-sessoes.md) `§9` nomeava. O primeiro
  pede um segundo eixo na tela; o segundo é identificação, que a `§8` recusa.
- **Recorte por vMCP e tela para quem não é admin** (decisão 2 e `§9`).
- **Comparar dois períodos, projetar tendência ou exportar a série.** A grade é
  para olhar; o relatório é para responder uma pergunta sobre um dia.
