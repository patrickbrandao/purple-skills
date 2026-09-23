# Changelog

Registro das mudanças relevantes do Purple Skills. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[versionamento semântico](https://semver.org/lang/pt-BR/).

Este arquivo existe para evitar retrabalho: quando uma correção foi discutida,
aplicada ou **deliberadamente recusada**, ela fica registrada aqui com o motivo.
Os relatórios que originaram cada entrada são **locais e não versionados** (o
diretório `tasks/` está no `.gitignore`), então nada aqui depende deles: quando
uma entrada precisa citar a origem, ela diz "relatório NNN da auditoria de
`<data>`" e o motivo fica escrito aqui mesmo, que é a única cópia que viaja com
o repositório. **A data importa:** cada auditoria renumerou os relatórios do
zero, então o mesmo número designa problemas diferentes em cada uma. Vale manter
esse cuidado em qualquer texto novo.

## [1.0.0-beta.28] — 2026-09-23

### Adicionado

- **`purple-admin`: contas pela linha de comando do container do painel.**
  `docker compose exec admin purple-admin <comando>` lista, mostra e cria
  contas (`user add --username --email --role [--password]`), define a senha
  por username ou e-mail (`user passwd`, que sorteia uma temporária quando a
  senha é omitida), muda o papel, desativa, reativa, destrava o login e derruba
  as sessões. É a volta para quando ninguém consegue entrar no painel — o único
  admin sem senha e sem SMTP, a instalação sem administrador —, que antes era SQL
  à mão. Desenho em [`docs/21-cli-admin.md`](docs/21-cli-admin.md). Sem
  migration.
- **A CLI passa pelas mesmas funções das rotas de conta**, não por uma cópia
  delas: validação, derrubada de sessões, proteção do último administrador e
  trilha de auditoria são as do painel. Na trilha o ator é `cli`, sem conta,
  com origem `web-admin` — o `CHECK` de `audit_log.source` não conhece outra,
  e uma origem nova pediria migration sem dizer nada que o ator já não diga.
- **Com a tabela `users` vazia, `user add` só cria `admin`**, e esse admin adota
  os órfãos como o do `/api/setup`: a primeira conta continua sendo sempre de
  administrador (relatório 001 da auditoria de 2026-09-19).

### Alterado

- **A redefinição de senha pelo painel virou um invólucro de
  `setAccountPassword`**, a função que a CLI também usa. O contrato de
  `POST /api/users/:uuid/reset-password` não mudou.
- **O `docs/05` §2.3 foi revogado em dois pontos** ("escolhido em vez de CLI" e
  "a primeira conta é sempre o admin do `/setup`"), marcados no lugar. O
  `/api/setup` continua sendo o caminho do primeiro administrador.

## [1.0.0-beta.27] — 2026-09-22

### Adicionado

- **Perfil de usuário: nome de exibição, foto e um bloco público opcional.**
  A conta ganha uma foto e — se quiser — descrição, site e até oito links, com
  página própria no site em `/u/<username>`. O nome de exibição é o
  `users.name` que já existia; o que mudou é que o próprio dono passa a
  editá-lo. Desenho e o porquê de cada regra em
  [`docs/20-perfil.md`](docs/20-perfil.md). Migration `034-perfil.sql`.
- **A foto é upload guardado no banco, não uma URL.** Parece detalhe e não é:
  um `<img src>` apontando para host externo **entrega o IP de cada visitante**
  ao dono daquele host, e a página do perfil é anônima por definição. O tipo é
  decidido pelos **bytes iniciais** — nunca pela extensão nem pelo
  `Content-Type`, que são texto que quem envia escolhe —, o teto é 512 KB, e
  **SVG é recusado**: ele é XML com `<script>` dentro, e servi-lo na origem do
  site seria execução de código de terceiro na página.
- **`/u/<username>`, a quarta rota pública do site**, com as skills e os
  catálogos **já públicos** da pessoa — estar no perfil não torna nada
  visível. O `por @fulano` da ficha da skill vira link quando o dono publicou o
  perfil, e continua em texto quando não.
- **O perfil público é opt-in, desligado por padrão.** A migration não liga
  nada e não cria linha nenhuma: a linha nasce no primeiro salvamento, e quem
  nunca abriu a tela não tem perfil. Perfil privado, conta desativada e
  username inexistente respondem o **mesmo 404** no site — distingui-los diria
  "esta conta existe, mas não quer ser vista", que é o que o opt-in existe para
  não dizer.
- **"Limpar perfil", na ficha de conta: a única coisa que um admin faz num
  perfil alheio.** Apaga descrição, site, links e foto, e tira do ar — com
  linha na trilha (`user.profile`). Moderar é tirar do ar, não reescrever com
  outras palavras: **não existe** caminho em que um admin publique texto
  assinado por outra pessoa. A edição do próprio perfil não entra na trilha,
  pelo mesmo critério que mantém o login fora dela.
- **O e-mail não tem campo no perfil, em superfície nenhuma** — nem como
  "e-mail de contato público". Ele acabou de sair de circulação na `033`, e um
  campo desses o traria de volta pela porta da frente. Quem quiser dar contato
  usa um link.

- **`username`: a conta passa a ter um identificador público, e o e-mail volta
  a ser privado.** Coluna nova `users.username`, obrigatória e única por
  `lower(username)`, que ocupa exatamente o lugar que o e-mail ocupava em toda
  superfície que nomeia uma pessoa: dono de skill, catálogo e servidor; lista de
  concessões e "concedido por"; guia **Acessos**; busca de "compartilhar com…";
  rótulos da trilha de auditoria; e — pela primeira vez — a ficha pública do
  site, que passa a creditar `@dono`. Desenho e o porquê de cada regra em
  [`docs/19-username.md`](docs/19-username.md). Migration `033-username.sql`.
- **Login por usuário *ou* e-mail, num campo só.** Tem `@`, o servidor lê como
  e-mail; não tem, como username. A regra só é decidível porque nenhum username
  válido pode conter `@` (`normalizeUsername`, em
  `packages/shared/src/username.ts`) — não é heurística. O erro continua
  genérico e o mesmo no tempo: dizer "esse usuário não existe" contra "esse
  e-mail não existe" devolveria de graça a informação de que um endereço tem
  conta aqui.
- **`user.username` na trilha.** Trocar o username é de admin, e a linha grava
  `<antigo> -> <novo>` — a mesma gramática da clonagem (`031`). É ela que liga a
  trilha anterior à troca, onde o rótulo congelado ainda diz o nome antigo.

### Alterado

- **"Minha conta" virou ficha e editor, como as contas de admin.** `/account`
  agora **só mostra** o perfil, com um botão Editar que leva a `/account/edit`,
  onde os campos ficam em três guias: **Perfil** (foto, nome de exibição,
  username), **Dados públicos** (descrição, site, links e o publicar) e
  **Trocar senha**. A tela que se abre todo dia deixou de ser um formulário
  aberto com três painéis empilhados. As guias da edição são estado de tela e
  não rotas, de propósito: o formulário do perfil é **um** só nas duas
  primeiras, e trocar de guia por rota o desmontaria — quem escrevesse a bio e
  fosse conferir o nome perderia o que digitou. Detalhes em
  [`docs/20-perfil.md`](docs/20-perfil.md) §7.1.
- **A ficha ganhou o quadro "O que é seu":** quantos servidores vMCP, skills e
  catálogos a conta **possui**, cada número levando à lista que o produziu.
  Sem rota nova — são as três listas que já existem, no recorte `mine`. É posse,
  não acesso: o que foi compartilhado com a pessoa não entra na conta.
- **O quadro "Chaves do MCP administrativo" saiu do perfil.** Ele já não
  emitia nada desde que as `psk_` ganharam tela própria (Adm MCP Keys, com item
  de menu direto): o que restava era um ponteiro ocupando a largura da página.
- **O e-mail deixou de ser exibido para outras contas.** Ele continua
  obrigatório e único — o link de redefinição vai por ele e o vínculo OIDC casa
  por ele (`docs/05` §2.4 e §2.6) —, mas só a **própria pessoa** e um **admin**
  o veem. O que motivou: numa instalação com dez colaboradores, uma conta
  `membro` recém-criada lia o endereço de todo mundo digitando duas letras na
  busca de contas, e o dono de qualquer skill via na guia Acessos o e-mail de
  quem a tinha lido — essa guia é de `manage`, não de admin.
- **O histórico que já havia congelado e-mail foi reescrito.**
  `audit_log.actor_label`/`target_label` e `skill_accesses.user_email` guardavam
  endereços em texto. A `033` troca por username onde a conta ainda existe (por
  ocorrência e em ordem decrescente de comprimento, senão `ana@x.com` seria
  substituído dentro de `mariana@x.com`), marca o que não resolve como
  `conta removida` e **apaga** a coluna `skill_accesses.user_email`. A varredura
  final é restrita às ações cujo rótulo sabidamente é uma conta: `target_label`
  de quarentena é nome de envio escrito por gente e fica de fora.
- **Username abandonado nunca volta a circular** (tabela `usernames`, uma linha
  por nome já usado nesta instalação). Sem isso, o `@joao` de uma trilha de 2025
  poderia ser outra pessoa em 2026 — a trilha guarda texto congelado justamente
  para sobreviver à remoção da conta, e reciclar o nome desfaria essa garantia.
- **O backfill sai do campo `name`**, nunca da parte antes do `@`. Derivar do
  local part era o caminho óbvio e teria publicado metade do endereço de todo
  mundo para o painel inteiro — exatamente o que esta mudança existe para
  fechar. Nome que não dá username utilizável cai em `user-<8 hex>`. O mesmo
  vale para a conta provisionada por SSO, inclusive no caso em que o provedor
  não manda nome e o `name` da conta **é** o e-mail.
- **`@purple-skills/shared` ganhou um export por subpath**,
  `@purple-skills/shared/username`. O bundle do painel não importa a raiz do
  pacote (ela reexporta módulos que falam com `node:fs` e `node:crypto`), mas a
  regra do username tem de ser uma só: ela já existe duas vezes — no TypeScript
  e em SQL, na `033`, que roda uma vez e some — e uma terceira cópia viva no
  navegador divergiria na primeira mudança. O módulo não importa nada e entra no
  bundle sozinho.

### Quebra de compatibilidade

- `POST /api/login` recebe `identifier` no lugar de `email`.
- As rotas de concessão viraram `/api/skills/:slug/access/:username` (idem
  catálogo e vMCP) e **recusam** e-mail. Aceitá-lo manteria o endereço na URL,
  e daí no log do proxy e no histórico do navegador.
- As nove tools de compartilhamento do mcp-admin trocaram o parâmetro `email`
  por `username`.
- `ownerEmail`, `grants[].email`, `grants[].grantedByEmail` e
  `SkillAccessEntry.userEmail` saíram dos corpos de resposta; no lugar entram os
  campos `*Username`. Os apelidos que já existiam — `ownerUserUuid`,
  `grants[].userUuid`, `grants[].grantedByUserUuid` e o `userUuid` da guia
  Acessos — continuam, apontando agora para o username.
- `GET /api/users/lookup` deixou de devolver e-mail **e de casar por e-mail**.
  Só a saída não bastaria: quem casasse por endereço descobriria a qual username
  ele corresponde, digitando-o.

Não há período de convivência: manter o e-mail aceito na entrada, ou devolvido
em paralelo, seria manter aberto o vazamento que esta mudança fecha.

## [1.0.0-beta.26] — 2026-09-21

### Adicionado

- **A tela de Atividade: a grade do ano e o relatório agregado do dia.** Item
  novo na sidebar, acima de Auditoria e com a mesma permissão — **só admin**.
  Uma célula por dia, colorida pela soma do que aconteceu naquele dia (sessões
  abertas + chamadas MCP + leituras de skill + eventos da trilha); clicar num
  dia abre, abaixo, o relatório dele. Esta instalação carimba a hora de quase
  tudo em três tabelas — `mcp_sessions` (`015`), `skill_accesses` (`018`) e
  `audit_log` (`001`) —, e **nenhuma delas tinha sido lida por dia**: as três
  respondiam "o que aconteceu com este objeto", e "esta instalação está sendo
  usada, mais ou menos do que no mês passado?" não tinha tela nenhuma. Desenho,
  e o porquê de cada regra, em [`docs/18-atividade.md`](docs/18-atividade.md).
- **Um número que não existia: quantas chamadas o MCP público atendeu.**
  `mcp_sessions.request_count` conta requisições por sessão sem dizer o quê, e
  `skill_accesses` só registra leitura de skill — `initialize`, `tools/list`,
  `ping` e `search_skills` não deixavam rastro nenhum, então um dia com mil
  chamadas e um dia com dez eram iguais em toda tela existente. A contagem nova
  é um **contador agregado em balde de 15 minutos** (`MCP_CALL_BUCKET_MS`) por
  vMCP, transporte e método, acumulado em memória pelo rastreador do mcp-public
  e despejado no mesmo flush agrupado que já grava `last_seen_at` e
  `request_count`: nenhum timer novo, nenhuma escrita por chamada.
- **Quinze minutos, e não uma hora nem um dia.** É o maior balde que ainda
  permite recortar o dia em **qualquer** fuso: todo deslocamento da base IANA é
  múltiplo de 15 minutos (o `+05:45` do Nepal é o caso extremo, e existe), então
  a meia-noite de qualquer lugar cai numa borda de balde. Com balde de uma hora,
  um relatório em Katmandu somaria 45 minutos do dia vizinho — erro pequeno,
  permanente e invisível; com balde diário, o fuso teria de ser congelado na
  **gravação** e o número nunca fecharia com o das outras três fontes, que são
  instantes exatos. E é contador, e não uma linha por chamada, porque
  `tools/list` e `ping` são o caminho quente e as tabelas vizinhas são "nunca
  apagar" por decisão: uma terceira tabela de histórico, com uma linha por
  mensagem JSON-RPC, seria a maior da instalação guardando o dado de menor
  valor unitário que existe aqui.
- **As famílias de chamada são classificadas por prefixo** — `tools`,
  `resources`, `prompts`, `skills`, `session` e `other` —, e não por uma lista
  fechada de métodos: o protocolo ganha método novo (a SEP-2640 acabou de
  fazer isso), e um `tools/algo` que ainda não existe é mais honesto dentro de
  `tools` do que sumido da conta. `resources/directory/read` é a exceção que a
  extensão criou: pelo prefixo seria `resources`, mas o que ele lê é a árvore de
  uma skill, então conta como `skills`. Um `other` que cresce é o sinal de que
  algo novo chegou.
- **O dia é o do calendário de quem olha**, e a conversão de dia em instantes é
  a **mesma** `auditRange` da trilha, não uma cópia: quando o painel teve duas
  convenções de data, "Desde" saiu em UTC e "Até" em hora local, e num fuso
  UTC-3 "hoje" pedia 27 horas de eventos — o erro não aparece como erro, aparece
  como um número maior do que devia. O fuso IANA vai ao SQL **só** na série da
  grade, que é onde o `GROUP BY` recorta o dia; o relatório recebe dois
  instantes já calculados e devolve contagens, e o `day`/`timezone` do corpo são
  eco do que foi pedido. Dois lugares para a mesma verdade é como nasce a
  divergência de um dia entre a grade e o relatório dela.
- **Nada na tela identifica ninguém.** A contagem nova **não guarda** nome de
  tool, argumento, IP, e-mail nem `session_id`, e o relatório inteiro é
  agregado: a menor unidade é "quantas vezes". Identidades distintas são
  contadas sem serem nomeadas, os agentes aparecem pelo nome declarado no
  `initialize` (sem versão, sem IP) e os atores da trilha são contados sem
  serem identificados. Quem precisa do evento a evento continua tendo a trilha,
  as sessões e a guia Auditoria da skill, do catálogo e da conta, com a
  permissão de sempre — esta tela não substitui nenhuma delas.
- **Os limites dos números estão escritos**, para ninguém ler a tela como ela
  não é: chamada **recebida** não é chamada bem-sucedida (o rastreador é
  avisado antes do despacho); o que é recusado antes dele — 429 do limite de
  taxa, 400 do lote acima de `MCP_MAX_BATCH`, 403 de sessão de outra credencial,
  404 de sessão desconhecida — não entra; o agrupamento do stateless por IP +
  agente + credencial + vMCP faz a contagem de clientes ser um **piso**; com o
  mapa de identidades stateless cheio (`MCP_MAX_STATELESS_SESSIONS`, padrão
  5 000) a requisição segue **atendida** e não vira nem sessão nem chamada
  contada — o único caso em que tráfego bem-sucedido não aparece na grade; o
  mcp-admin não tem rastreador de sessões, então "clientes conectados" fala só
  do MCP público; `get_skill` de um `SKILL.md` grande demais e `get_skill_file`
  contam como chamada e **não** como leitura; e a contagem de chamadas só existe
  a partir desta migration, então a grade tem um degrau visível nos dias
  anteriores. Nada disso tem conserto — é o que contar no transporte custa.
- **Migration `032-atividade.sql`**: a tabela `mcp_call_counters` e **quatro**
  índices — `mcp_call_counters_bucket_idx` (`bucket DESC`), que é a faixa das
  duas leituras; `mcp_call_counters_virtual_mcp_idx`, que serve à varredura do
  `ON DELETE SET NULL` quando um vMCP é apagado (a PK começa por `bucket` e não
  acha as linhas de um servidor); e os dois que faltavam em `mcp_sessions`:
  `mcp_sessions_started_at_idx`, para as sessões **abertas** no dia, e
  `mcp_sessions_ended_at_idx`, para as **encerradas** nele, que o relatório
  ainda quebra por motivo. Os índices da `015` olham `last_seen_at`, a sessão
  aberta e a chave, porque até agora ninguém tinha perguntado quantas sessões
  **começaram** num dia. Três funções em `@purple-skills/db`:
  `bumpMcpCallCounters`, `listActivityDays` e `activityOfDay`. **Sem poda
  automática**, como as duas tabelas vizinhas.
- **A armadilha fechada, porque não quebraria — só ficaria lento para sempre**:
  o `AT TIME ZONE` vem **depois** do filtro por instante. Escrever a conversão
  no `WHERE` transforma a coluna em expressão, o planejador larga o índice por
  data e varre inteiras três tabelas que, por decisão, nunca são podadas — e
  não há índice de expressão que salve, porque o fuso é de quem está olhando.
- **A armadilha de concorrência, esta medida contra um Postgres de verdade: o
  UPSERT dos contadores precisava de ordem determinística.** O `ON CONFLICT DO
  UPDATE` trava as linhas de `mcp_call_counters` uma a uma, na ordem em que
  saem do `VALUES`, e cada uma fica travada até o COMMIT de quem a tocou. O
  rastreador do mcp-public despeja **todas** as sessões num `Promise.all`, e
  duas sessões do mesmo vMCP, mesmo transporte e mesmo balde de 15 minutos
  trazem os mesmos métodos em ordens diferentes — a ordem em que cada uma viu
  cada método pela primeira vez. Elas travavam em cruz, o Postgres matava uma
  (deadlock, `40P01`) e o erro era engolido pelo "melhor esforço" da gravação
  **depois** de a colheita já ter esvaziado o mapa da sessão: as chamadas do
  despejo morto sumiam sem deixar rastro, e o dia mais movimentado é justamente
  o mais subcontado. Medido com os 8 métodos ordinários: 6 sessões no mesmo
  servidor davam 37 mortes em 90 despejos e **41,1 % das chamadas perdidas**;
  10 sessões, 173 mortes em 250 despejos e 69,2 % perdidas; com as linhas
  ordenadas, nenhuma morte e nenhuma perda nos dois casos. A gravação agora
  ordena pela própria chave de conflito (comparada por unidade de código, nunca
  `localeCompare`, que depende da locale do processo) e o SELECT leva um
  `ORDER BY`: ordenar só em JavaScript não bastava, porque o plano é um join
  com `virtual_mcps` e o que sai de um join não tem ordem prometida nenhuma.
  É a mesma lição que `replaceTagsTx` já registrava desde as tags — quem grava
  várias linhas em paralelo grava em ordem fixa —, e registrá-la de novo aqui é
  o que impede a terceira vez.
- **Revoga o "fora do escopo" de quatro documentos**, cada um marcado no ponto e
  no topo, pela regra do [`AGENTS.md`](AGENTS.md): estatística de uso derivada
  das sessões no [`docs/10`](docs/10-admin-canvas-e-sessoes.md), "leituras por
  dia" no [`docs/13`](docs/13-fichas-e-acessos.md) e estatística por vMCP no
  [`docs/08`](docs/08-mcp-virtual.md) e no
  [`docs/09`](docs/09-mcp-padrao-e-skills-flutuantes.md). O alcance de cada
  marca é estreito, e está escrito lá.
- **Recusado de propósito, e dito para ninguém procurar**: nome de tool e
  argumentos na contagem (saber *qual* skill foi pedida é o registro de acessos,
  que já existe, tem dono e tem permissão própria; e argumento seria guardar o
  termo que alguém buscou numa tabela que promete ser agregada); poda ou
  retenção automática; teste de ponta a ponta da tela; série por hora e número
  por cliente — os dois recortes que o item revogado do `docs/10` nomeava —;
  recorte por vMCP e tela para quem não é admin; e comparar períodos, projetar
  tendência ou exportar a série.

- **A extensão de skills do MCP (SEP-2640) no servidor público.** O mcp-public
  passou a declarar `io.modelcontextprotocol/skills` e a responder `skills/list`,
  `skills/get` e `resources/directory/read`, com cada arquivo da skill
  endereçável como resource. Antes, um agente que chegava aqui tinha de aprender
  quatro ferramentas próprias para fazer o que o host dele já sabe fazer com
  skill de disco, e o `SKILL.md` que mandasse "escolha o modelo em `templates/`"
  era instrução morta — o único jeito de ler aquele arquivo era uma ferramenta
  que o host não sabia amarrar àquela skill. Agora a entrada de `skills/list`
  traz o frontmatter e o inventário completo com digest e tamanho de cada
  arquivo, que é o que deixa o host verificar o que leu e prender a aprovação ao
  conteúdo. **A URI mudou**: `skill://<slug>` era o SKILL.md e passou a ser o
  **diretório** da skill (`skill://<slug>/SKILL.md` é o arquivo) — não havia como
  conviver, porque sob a SEP a mesma URI significaria arquivo numa porta e
  diretório na outra. A extensão ficou na porta `as_skill`, que já entrega todo
  arquivo por `get_skill_file`, então **nenhuma exposição foi ampliada** e não há
  flag nova; `as_resource` continua servindo só o `SKILL.md`. Binário passou a
  sair em `blob` base64 no `resources/read` — sob a SEP o arquivo está no
  manifesto e recusá-lo é falha de verificação. As cinco ferramentas ficaram
  intactas, para o cliente que não implementa a extensão. **Sem migration**: o
  hash por arquivo veio de graça da `020` e o tamanho, da `001`. A armadilha
  fechada, porque quebraria em silêncio: o `content_sha256` da linha do
  `SKILL.md` é o hash do corpo **sem** frontmatter, e o que a leitura devolve é
  o composto — publicar aquele hash faria toda skill falhar na verificação de
  todo host, e nada neste repositório lê o digest de volta para perceber.
  Desenho em `docs/17-skills-extension.md`.

- **Clonar uma skill, um catálogo ou um MCP virtual.** Botão "Clonar" na ficha
  e na linha da lista, com um diálogo de nome e slug preenchidos e editáveis;
  confirmar cria a cópia e abre a ficha dela. Os três objetos são montados peça
  por peça e depois quase nunca mudam de forma, e não havia caminho curto para
  um segundo parecido: a skill só se "copiava" baixando o pacote e
  reimportando — o que bate em 409 em produção e, pela quarentena, cria uma
  skill num portão feito para pacote de terceiro (§6 do
  [`docs/15`](docs/15-quarentena.md)) —, e catálogo e servidor não têm pacote
  nenhum, então se refaziam membro a membro, porta a porta, nó a nó. Desenho, e
  o porquê de cada regra, em [`docs/16-clonagem.md`](docs/16-clonagem.md).
- **A cópia nasce fechada.** `is_public` em skill e catálogo e `is_open` no
  vMCP são **falsos** mesmo quando o original é público ou aberto; `is_active`
  é copiado. Um clone que nascesse aberto publicaria o conteúdo do original num
  endereço novo — `/virtual/<slug>-2/mcp` — sem passar pelo aviso de exposição
  da decisão 15 do [`docs/12`](docs/12-acesso-granular.md), que é a pior forma
  de vazar: ninguém está olhando para ele. Pelo mesmo motivo o clone de vMCP
  **não** toca `settings.default_virtual_mcp`.
- **O que cada tipo leva.** Skill: propriedades, arquivos e tags — nasce
  flutuante, sem catálogo, sem servidor e sem concessão. Catálogo: propriedades
  e membros, preservando o `is_active` de **cada** participação, porque copiar
  o grupo e perder o recorte entregaria um catálogo diferente com o mesmo nome.
  vMCP: propriedades, vínculos de skill e de catálogo (as três portas e as
  posições do canvas), o `layout` e as **concessões**. Contadores zerados nos
  três, inclusive os do vínculo em `virtual_mcp_skills`.
- **As chaves `psv_` não são copiadas** — e não é escolha de gosto, é
  aritmética: o banco guarda o `prefix` e o **hash scrypt** do segredo, nunca o
  segredo, e o `prefix` é `UNIQUE` global. Duplicar a linha daria uma chave que
  ninguém consegue apresentar numa requisição e ainda gastaria um prefixo. A
  cópia nasce sem chave, e quem precisa emite uma.
- **Quem clona precisa de `edit` no original e do papel de criar** (`editor` ou
  `admin`) — clonar *é* criar, então um `membro` não clona nem o que é dele,
  pela mesma razão pela qual `POST /api/skills` lhe responde 403. **No vMCP o
  mínimo sobe para `manage`**: a cópia leva a lista de concessões, e quem tem
  `edit` não pode nem *ler* essa lista (decisão 11 do
  [`docs/12`](docs/12-acesso-granular.md)) — deixar o `edit` clonar entregaria
  pela guia Acesso da cópia, onde a pessoa é dona, o que a ficha do original
  nega.
- **O dono é quem clonou**, e o dono do original não ganha nada na cópia.
  Como dono não tem linha na ACL (decisão 10 do
  [`docs/12`](docs/12-acesso-granular.md)), não há o que copiar: quando outra
  pessoa clona o servidor dele, todo mundo que ele havia convidado entra na
  cópia e ele, não. Consequência aceita de propósito e registrada. Nas
  concessões copiadas, `granted_by_user_uuid` passa a ser quem clonou, e a
  concessão da própria pessoa que clonou não é copiada — conceder ao dono é
  redundante. Ator sem conta (`MCP_ADMIN_TOKEN`, bootstrap) gera clone órfão,
  como na criação normal.
- **Slug pelo desempate de sempre**: `-2`, `-3`… pelo `uniqueSlug` do
  `shared`, o mesmo caminho derivado da promoção da quarentena, e o `name` não
  muda sozinho. Slug **pedido** que colide responde **409**, como em qualquer
  criação; slug **derivado** desempata sozinho e nunca conflita. O painel só
  manda o campo quando a pessoa o edita, e por isso o caminho comum não tem
  como dar 409 — nem com duas pessoas clonando o mesmo objeto ao mesmo tempo.
  O `SKILL.md` da cópia já sai com `name: <slug novo>` sem migrar conteúdo: o
  frontmatter é gerado na leitura por `composeSkillMd`, não guardado.
- **Clonar não custa embedding.** A skill clonada nasce `rag_stale = true` como
  toda skill nova, mas passar pelo indexador não é pagar: `rag_vectors` é
  endereçado por `(space_uuid, text_sha256)` e o texto vive uma vez só em
  `rag_texts`, com o hash como chave — o mesmo texto em duas skills são duas
  linhas de `rag_skill_texts` apontando para um hash só. O texto de metadados é
  **nome, descrição e tags**, não o slug, então a clonagem pelo caminho comum
  não gera texto novo nenhum; só há um, o de metadados, se a pessoa mudar o
  nome no diálogo. Refatiar é de graça.
- **Três ações de auditoria novas** — `skill.clone`, `catalog.clone` e
  `mcp.clone` —, com a linha no objeto **novo** e `target_label` em
  `<slug de origem> -> <slug da cópia>`, a gramática que
  `quarantine.promote` já usa: é o único formato do projeto em que os dois
  lados de uma passagem cabem numa coluna só, e repeti-lo evita um segundo
  formato para decorar. Uma clonagem deixa **uma** linha, e não a sequência
  que a mesma cópia feita à mão deixaria; nenhum `mcp.key.create` nem `update`
  de exposição a acompanha, porque a cópia nasce sem chave e fechada.
- **Migration `031-clonagem.sql`**, que **não cria tabela nem coluna**: o CHECK
  de `audit_log.action` cresce com as três ações, e é só isso — uma cópia é uma
  linha nova nas tabelas que já existem. A cópia inteira (objeto, filhos e a
  linha de auditoria) é **uma transação**, e os arquivos da skill são copiados
  dentro do banco, sem materializar bytes no app: os dois lados já estão no
  Postgres, e passar um pacote de 200 MB pelo processo do painel seria pagar
  memória por nada.
- **REST**: `POST /api/skills/:slug/clone`, `POST /api/catalogs/:slug/clone` e
  `POST /api/mcps/:slug/clone`, com corpo `{ name?, slug? }` — os dois campos
  opcionais. **mcp-admin**: `clone_skill`, `clone_catalog` e
  `clone_virtual_mcp`, com os mesmos argumentos. O `:slug` da rota é o do
  **original**, e é sobre ele que o nível de acesso é conferido; quem não
  enxerga o original recebe o 404 de sempre.
- **"Clonar" fica fora da paleta de comandos**, por escolha do mantenedor. Ela
  lista os comandos que a tela registra e caberia ali sem esforço; a decisão é
  de superfície, não de implementação — clonar é sempre sobre um objeto
  determinado, e o gesto certo para isso é o botão que está em cima dele.
- **Fora do escopo, e dito para ninguém procurar**: clonagem profunda (clonar
  um servidor não duplica as skills dentro dele), clonar um envio da
  quarentena, clonar em lote, e qualquer vínculo entre original e cópia depois
  do `INSERT` — renomear, editar ou apagar um não afeta o outro, e a única
  memória da origem é a linha de auditoria.

### Alterado

- **As descrições das tools dos dois MCPs passam a ser em inglês.** Título,
  descrição e descrição de cada argumento das 5 tools do MCP público (e de todo
  vMCP) e das 43 do administrativo, mais as `instructions` que os dois servidores
  mandam no `initialize` — é o texto que o agente lê antes de decidir qual
  ferramenta chamar, e ele viaja para clientes e modelos que não são deste
  repositório. Mensagem de erro, log, comentário e documentação **continuam em
  português** (`AGENTS.md`): o que mudou é só a superfície declarada do
  protocolo.
- **Os endereços do painel, do site e da homepage passam a ser em inglês.**
  `/catalogos` → `/catalogs`, `/auditoria` → `/audit`, `/quarentena` →
  `/quarantine`, `/configuracoes/mcp-padrao` → `/settings/default-mcp`,
  `/nova-skill` → `/new-skill`, `/meu-espaco` → `/my-space`,
  `/account/chaves-adm` → `/account/admin-keys`, as guias (`…/arquivos`,
  `…/propriedades`, `…/acesso`, `…/editar`…) e a query string (`?novo=1` →
  `?new=1`, `?modo=zip` → `?mode=zip`, `?filtro=todas` → `?filter=all`). O
  `/api/…` e os transportes MCP já eram inglês; o SPA era a metade que
  destoava. A tabela completa está em
  [`docs/03`](docs/03-implementation-notes.md#endereços-em-inglês).
- **Sem redirecionamento do endereço antigo.** Favorito ou link de fora
  apontando para um endereço em português cai na rota `*` — `/mcps` no painel,
  404 no site. O desempate de `/skills/new` (a skill de slug `new` × o
  formulário) não foi tocado, e o legado `…/accesses → …/audit` continua,
  agora com o nome em inglês.

## [1.0.0-beta.25] — 2026-09-20

### Adicionado

- **Importar um pacote com várias skills de uma vez ("bundle").** Quem decide o
  caso é a **raiz** do pacote: com um `SKILL.md` nela, o pacote é uma skill só e
  tudo o mais é conteúdo dela, em qualquer profundidade (decisão 27 — é o que
  mantém inteiro o template de skill, que guarda um `SKILL.md` de exemplo em
  `references/`). Sem `SKILL.md` na raiz, skill passa a ser cada diretório que
  tenha um; os arquivos daquele diretório e das subpastas dele vão junto, menos
  as subpastas que são, elas próprias, skills. Diretório sem `SKILL.md` é
  ignorado por inteiro. O caso que o recurso veio atender: baixar o `.zip` do
  repositório `obra/superpowers` no GitHub e importá-lo traz todas as skills
  dele para a fila, uma por diretório, ignorando `.github/`, `docs/` e o resto.
  Desenho, com o porquê de cada regra, em
  [`docs/15-quarentena.md`](docs/15-quarentena.md) §10 e decisões 19 a 27.
- **Um bundle vai sempre para a quarentena.** Um pacote com duas ou mais skills
  mandado para `production` é recusado com **400**, dizendo quantas foram
  encontradas e apontando a fila. O portão existe para o pacote de terceiro
  (decisão 1); criar N skills direto no acervo multiplicaria por N, sem revisão
  nenhuma, a publicação e o fatiamento pelo RAG. Isso revisa a decisão 2 do
  [`docs/15`](docs/15-quarentena.md) e o ponto correspondente da §12.6 do
  [`docs/02`](docs/02-architecture-decisions.md), marcados nos dois.
- **`POST /api/skills/import` passou a responder dois formatos** com
  `destination: quarantine`. Uma skill e nada de fora: a ficha do envio, o mesmo
  corpo de antes. Duas ou mais, **ou** alguma pulada pelo teto ao lado de outra
  que entrou: o resumo, com `bundle: true`, `sourceFilename`, a lista `imported`
  (`uuid`, `name`, `path`, `fileCount`) e a lista `skipped` (`path`, `reason`,
  `fileCount`). Quando **nenhuma** skill entra na fila — a única do pacote passou
  do teto — a resposta é **400** com a lista do que foi pulado, e não o resumo:
  um `201` ali seria "Created" sem recurso criado, que o painel mostra como
  importação bem sucedida de coisa nenhuma. Quem lê discrimina por
  `'bundle' in body`. Duas rotas separadas cobrariam de quem importa saber
  quantas skills o pacote tem **antes** de abri-lo. No painel, o resumo é uma
  tela — "Pacote importado" —, e não um aviso que some: conferir quarenta
  envios contra o pacote enviado não cabe em quatro segundos de toast.
- **Formatos novos na importação**: `.tar`, `.tar.gz`/`.tgz`, `.gz` e
  `.tar.zst`/`.tzst`/`.zst`, além do `.zip`/`.skill` de sempre. O formato é
  decidido pela **assinatura** do arquivo, não pela extensão — um `.skill` é um
  ZIP e um `.tgz` é um tar em gzip, e um arquivo renomeado não deve enganar a
  leitura nem escapar da recusa abaixo.
- **`.rar`, `.7z`, `.xz` e `.bz2` são recusados com mensagem própria**, com o
  nome do formato e a lista do que é aceito, em vez do erro genérico de arquivo
  inválido. Não é esquecimento: a única via para RAR em Node é um WASM do
  UnRAR, cuja licença proíbe usar o fonte para construir um arquivador
  compatível com RAR — uma cláusula que não combina com a MIT deste
  repositório, para uma dependência binária que entraria em `packages/shared`
  e, com ele, nas seis imagens.
- **Dois tetos novos em `.env.example` e no `docker-compose.yml`**:
  `BUNDLE_MAX_ENTRIES` (padrão
  `20000`), o teto de entradas do pacote **inteiro**, e `BUNDLE_MAX_SKILLS`
  (padrão `200`), quantas skills pode trazer o pacote cuja raiz **não** é skill
  — o único que vira várias; com um `SKILL.md` na raiz o pacote é uma skill só,
  e esse teto nem chega a ser conferido (ver "Corrigido"). `BUNDLE_MAX_ENTRIES`
  não é o 512 de `ZIP_MAX_ENTRIES` porque o `.zip` de um repositório do GitHub
  passa das 512 entradas só de código e documentação, e esse teto fecharia a
  porta justamente para o caso novo. O teto **por skill** continua sendo
  `ZIP_MAX_ENTRIES`: o diretório acima dele é **pulado e reportado** em
  `skipped`, e as irmãs entram — recusar o pacote inteiro obrigaria a editar o
  `.zip` de terceiro para conseguir importar qualquer coisa dele, e truncar a
  skill faria o envio mentir sobre o pacote de origem. As duas são lidas como
  inteiro: valor inválido derruba o boot com mensagem explícita, como os
  outros tetos — e derruba o dos **cinco** serviços, não só o do painel, porque
  quem lê as duas é o `@purple-skills/shared` no carregamento do módulo e o
  `@purple-skills/db` arrasta esse barril para todos (medido: com
  `BUNDLE_MAX_ENTRIES=abc`, `import '@purple-skills/db'` já morre). As duas
  entraram no `x-app-env` do compose ao lado das irmãs `ZIP_MAX_*`: sem essa
  linha elas não chegavam a container nenhum — o `.env` do compose só interpola
  o próprio arquivo —, os dois tetos ficavam travados no padrão no deploy
  publicado e o ajuste do operador era ignorado em silêncio, inclusive o valor
  inválido que a promessa acima diz que derruba o boot. Há ainda um teto fixo de
  **duas** camadas de compressão encadeadas — um `.gz` dentro de `.gz` dentro de
  `.gz` é bomba, não pacote.
- **O orçamento de bytes descomprimidos passou a ser único para o pacote**, e
  não um por camada de envelope: cada `.gz`/`.zst` aberto desconta do mesmo
  `ZIP_MAX_UNCOMPRESSED_BYTES` e o leitor de dentro fica com o que sobrou.
  Medido com maxRSS no Node 26, 250 MB de conteúdo custavam 346 MB em `.zip`,
  653 MB em `.tar.gz` e 871 MB em gzip(gzip(tar)) — com `mem_limit` de 1536m e
  sem swap, três envios de 264 KB em paralelo bastavam para o OOM killer.
- **O piso de Node subiu de `>=22` para `>=22.15`** (`engines` do
  `package.json`, e o README junto). O `zstdDecompressSync` do `node:zlib` só
  existe a partir dessa versão, e o que falha num 22.0–22.14 não é o caminho
  `.zst`: é a **ligação** do módulo ESM, que resolve os imports nomeados antes
  de rodar linha nenhuma — o `@purple-skills/shared` inteiro deixa de carregar,
  e com ele todo serviço que o importa. As imagens publicadas nunca sentiram
  (os sete Dockerfiles são `node:24-alpine`, e o CI roda no 24); quem roda fora
  do Docker, sim.
- **`source_filename` diz de onde a skill veio** quando ela chegou de um
  diretório do pacote: `pacote.zip (skills/brainstorming)` — o nome do arquivo
  enviado mais o diretório de origem. É o que deixa conferir a fila contra o
  pacote sem abrir envio por envio; só com o nome do arquivo, quarenta envios
  ficariam indistinguíveis na lista. A skill na raiz do pacote, e o pacote de
  uma skill só, continuam com o nome do arquivo sozinho. **Sem coluna nova**:
  `source_filename` já é TEXT livre.
- **Cada envio é a sua própria transação.** Uma falha no meio do pacote não
  desfaz o que já entrou: a quarentena é uma fila, não um lote atômico, e um
  pacote de quarenta skills que morresse na trigésima nona devolveria o
  operador ao ponto de partida, sem nada para olhar.
- **O pacote sem `SKILL.md` nenhum também responde ao teto de 512 por envio**,
  com **400**. Ele entra como um envio só, então é um envio, e o teto do envio
  vale para ele igual: o `splitBundle` mede por skill e ali não há skill para
  medir, enquanto a leitura do pacote vai até `BUNDLE_MAX_ENTRIES`. Sem a
  guarda, o mesmo conteúdo que é recusado **com** um `SKILL.md` dentro entrava
  **sem** ele — medido, 600 arquivos e nenhum `SKILL.md` gravavam um envio de
  600. Antes do bundle o caso era impossível, porque a importação lia com o
  `extractZip`, cujo teto padrão já era 512.
- **O `._<nome>` do `tar` do macOS é descartado** na importação, pela
  **assinatura** AppleDouble (`00 05 16 07`) e nunca pelo nome — `._config` é
  nome legítimo, e descartar por prefixo apagaria arquivo do usuário. Medido:
  **27 dos 41 membros** de um `.tar` feito num Mac eram esse metadado, metade
  deles binário ilegível, consumindo o teto de 512 por envio. O `tar -tf` do
  próprio macOS **esconde** esses membros ao listar, então o problema é fácil
  de não enxergar. No `.zip` ele não aparece: o `zip` junta o metadado em
  `__MACOSX/`, que já era descartado. Ele continua contando para
  `BUNDLE_MAX_ENTRIES`, que é conferido antes do descarte; o que ele não consome
  mais é o teto de 512 por skill nem o `fileCount` do envio.

### Mudado

- **O pacote cuja única skill está numa subpasta perdeu os arquivos de fora
  dela.** Medido, um `.zip` com `README.md`, `LICENSE` e
  `skills/foo/SKILL.md`: antes do bundle ele gravava um envio com os **quatro**
  arquivos, nos caminhos em que vieram, e importar para produção era **400**
  ("precisa conter um SKILL.md", porque a busca olhava só a raiz). Hoje grava um
  envio com os arquivos de `skills/foo/` e mais nada — `README.md` e `LICENSE`
  ficam de fora, sem aviso — e importar para produção cria a skill. É a decisão
  19 aplicada até o fim, e não um descuido: não há sinal confiável que diga que
  o `README.md` da raiz de um repositório é documentação de uma skill três
  pastas abaixo. Quem quer os arquivos de fora põe um `SKILL.md` na raiz do
  pacote, e aí vale a decisão 27 — uma skill só, com tudo dentro. O pacote com
  `SKILL.md` **na raiz** volta a dar um envio com os mesmos arquivos, nos mesmos
  caminhos e com os mesmos bytes, **com uma exceção medida**: o `._<nome>`
  AppleDouble solto, que agora é descartado. O filtro mora no leitor de ZIP,
  então alcança o `.zip` de uma skill também (ver a entrada dele em
  "Adicionado") — dizer "não mudou, byte a byte" seria errado nesse arquivo.
- **O `source_filename` do envio único não leva o diretório de origem**, mesmo
  quando a skill veio de uma subpasta. O sufixo `(skills/foo)` da decisão 25 só
  aparece no ramo que grava vários envios, que é onde ele serve para desempatar.

### Corrigido

A entrega passou por uma verificação e por uma reverificação independentes. O
que caiu está separado em duas contas, porque não é a mesma coisa para quem
atualiza: um dos defeitos **já estava publicado** e é conserto de comportamento
antigo; os outros nunca chegaram a uma versão e são do recurso novo.

**Comportamento antigo, anterior a este branch:**

- **O teto de entradas do `.zip` era conferido tarde demais para proteger.** O
  `extractZip` comparava `entries.length` com `ZIP_MAX_ENTRIES` **depois** de
  chamar `getEntries()` — e o `getEntries()` do `adm-zip` 0.6.0 dimensiona a
  lista pelo número declarado no fim do diretório central e cria um `ZipEntry`
  por registro, medidos 9 a 10 KB de RSS cada. O número não para nos 65.535 de
  16 bits, porque o `adm-zip` lê o EOCD ZIP64: um `.zip` de 9 MB declarando
  200.000 entradas (registros de 47 bytes, todos podendo apontar para o mesmo
  cabeçalho local) consumia 1,8 GB e 1,6 s **antes** de a comparação acontecer,
  e o teto de bytes descomprimidos não socorria — nada tinha sido descomprimido
  ainda. O teto passou a ser conferido sobre o `getEntryCount()`, que devolve o
  `diskEntries` do cabeçalho sem carregar entrada nenhuma; a contagem do que
  voltou materializado continua valendo depois dele, porque o número declarado é
  do arquivo enviado e serve para recusar, nunca como medida do que existe. Vale
  para **todo** `.zip` que entra pela importação, e não só para o bundle.

**Defeito do recurso novo, apanhado antes de sair:**

- **`BUNDLE_MAX_SKILLS` recusava o pacote que é uma skill só.** A contagem de
  diretórios com `SKILL.md` acontecia antes de a regra da raiz (decisão 27)
  juntar tudo num envio, então um pacote com `SKILL.md` na raiz e mais exemplos
  em subpastas do que o teto era recusado com "O pacote tem skills demais (202
  diretórios com SKILL.md); o limite é 200." — a decisão 27 prometia **uma**
  skill enquanto o teto contava 202 diretórios. Com a raiz sendo a skill, a
  divisão deixou de acontecer: o `fatiarPacote` monta o envio direto das
  entradas, sem chamar o `splitBundle` nem desligar teto nenhum, e quem mede
  aquele pacote é o `ZIP_MAX_ENTRIES` por envio; `BUNDLE_MAX_SKILLS` volta a valer só
  onde a variável promete, no pacote cuja raiz **não** é skill. A §10 do
  [`docs/15`](docs/15-quarentena.md) e o `.env.example` foram reescritos sobre o
  que a rota faz, e o trecho que registrava a recusa como se fosse desenho ficou
  riscado onde estava.
- **`BZh` sozinho não é bzip2.** A detecção de formato pela assinatura, que
  entrou com os formatos novos e por isso nunca foi comportamento publicado,
  recusava como bzip2 um `.tar` íntegro cujo primeiro membro se chamasse
  `BZh-notas.md`: o nome do arquivo abre o cabeçalho tar e casava com a
  assinatura curta. Passou a exigir também o dígito de nível (1 a 9) e o magic
  do bloco.

## [1.0.0-beta.24] — 2026-09-20

### Adicionado

- **Quarentena de skills** — um espaço de espera para pacotes importados que
  precisam de aprovação antes de virar skill
  ([`docs/15-quarentena.md`](docs/15-quarentena.md), migration `030`,
  tabelas `quarantine_skills` e `quarantine_files`). Ao importar um
  `.zip`/`.skill` no painel, quem importa escolhe o destino: **produção** (o
  comportamento de sempre) ou **quarentena**. Um envio na quarentena não é
  publicado, não entra na busca, não é fatiado pelo RAG e não aparece no site:
  são arquivos crus com dono e data, endereçados pelo `uuid`.
- O espaço é pobre **de propósito**: sem slug, tag, ícone, `is_active`,
  `is_public`, contador, vínculo com vMCP ou catálogo, `search_vector`,
  `rag_stale` nem concessões por objeto. **Não há colisão de nome** — dois
  envios do mesmo pacote convivem. E não há metadado separado do arquivo: o
  `SKILL.md` fica com o frontmatter dentro dele, e é esse arquivo cru que a
  tela mostra e grava. A alternativa considerada, "skill em estado rascunho",
  obrigaria cada coluna, trigger e tela do acervo a conviver com meia skill.
- **Aprovar** cria a skill no acervo com os arquivos do envio, com o **dono do
  envio** (quem aprovou fica em `created_by_user_uuid`), flutuante — sem
  servidor, sem catálogo e não pública —, e apaga a linha da quarentena. Slug
  ocupado ganha sufixo (`-2`), como já acontece quando o slug vem do nome.
  Pacote **sem** `SKILL.md` entra na fila (consertar o que veio torto é para o
  que a quarentena serve), mas a aprovação dele é recusada sem apagar nada.
- **Quem aprova é configuração da instalação**, em Configurações → Quarentena
  (`quarantine.approvers`): `admin`, `admin+owner` (o padrão) ou
  `admin+editor`. Revisar e corrigir os arquivos continua sendo de quem
  enxerga a fila — o dono, os administradores e os editores —, e quem não
  enxerga um envio recebe 404, não 403. Auditoria: `quarantine.create`,
  `quarantine.update`, `quarantine.delete`, `quarantine.promote` e
  `quarantine.settings`.
- Rotas novas sob `/api/quarantine` (lista, ficha, descarte, download do
  pacote, promoção e CRUD de arquivo com `?raw`), mais
  `GET`/`PUT /api/settings/quarantine`. `POST /api/skills/import` ganhou o
  campo `destination` (`production`, o padrão, ou `quarantine`).

### Mudanças incompatíveis

- **`POST /api/skills/:slug/upload` foi removida** — o `.zip` numa skill já
  cadastrada. O pacote passou a ter um caminho só, a importação, que decide
  entre produção e quarentena. Quem chamava a rota recebe 404. No painel
  sumiram o "Importar .zip", o "Substituir a árvore por um .zip" e o comando
  correspondente da paleta. O que não tem substituto direto é a **troca da
  árvore inteira de uma vez**: quem precisa dela importa o pacote de novo e
  trabalha na skill nova. O `set_files_bulk` do MCP administrativo **não
  mudou**.
- **`POST /api/skills/:slug/files` aceita só texto.** A régua é a mesma do
  banco e do `extractZip` (`isTextualContent`: mime textual pelo nome, sem
  byte nulo e UTF-8 válido). Um `.png`, um `.pdf` ou um `.csv` em
  Windows-1252 é recusado com 400, com o nome do arquivo na mensagem, e o
  lote inteiro fica de fora — antes o binário entrava e o banco o guardava em
  `bytea`. Binário continua chegando ao acervo pela importação do pacote.
  Isso revoga, nos pontos marcados lá, a §3.2 do
  [`docs/13-fichas-e-acessos.md`](docs/13-fichas-e-acessos.md) e a §4 do
  [`docs/02-architecture-decisions.md`](docs/02-architecture-decisions.md).

### Corrigido — validação da quarentena (2026-09-20)

Uma validação multiagente conferiu a entrega contra o checklist de requisitos,
sem receber a descrição do que havia sido implementado: seis validadores
independentes, refutação adversarial de cada achado e um crítico de completude.
Dos 21 problemas apontados, 12 caíram na refutação. O que sobrou, e o que o
crítico achou fora do checklist, está abaixo. **Cada item foi medido.**

- **Quem aprovava um envio alheio perdia a skill que acabara de criar.** Com a
  política `admin+editor`, o editor promovia, a skill nascia com o dono do
  **envio**, privada, flutuante e sem concessão — e `skillVisibleTo` deixava de
  alcançá-lo no mesmo instante, com `loadSkill` virando **404**. O painel ainda
  o mandava para essa página. Três saídas eram possíveis (conceder acesso a quem
  aprova, não navegar, inverter o dono) e o mantenedor escolheu a terceira: **a
  skill promovida nasce com quem aprovou como dono**, e quem submeteu fica
  registrado em `quarantine.promote`. Revisa a decisão 7 do
  [`docs/15`](docs/15-quarentena.md), marcada lá.
- **As rotas de arquivo por JSON gravavam binário ilegível.**
  `PUT /api/skills/:slug/files/ref/logo.png` com `{"content":"oi"}` respondia
  **200** e gravava uma linha binária com os bytes do texto — toda leitura
  devolvia `content: null`, e uma imagem vinda do pacote era sobrescrita sem
  aviso. As quatro rotas JSON (skill e envio, `PUT` e `POST`) passaram a recusar
  extensão de binário com 400. Comportamento antigo, exposto pela regra nova de
  "só texto na edição"; o explorador do painel também barra o nome antes do
  envio.
- **A quarentena recusava justamente o pacote que ela existe para receber.** Um
  `SKILL.md` em Windows-1252 ou UTF-16 era barrado pelo `extractZip` **antes** de
  o destino ser lido, nos dois destinos. `extractZip` ganhou
  `allowBinarySkillMd`, que só a importação para a quarentena liga; produção
  continua recusando, e a cobrança da codificação passou para a aprovação.
- **Tag em lista YAML de bloco era descartada.** `tags:` seguida de `- alfa` — a
  forma mais comum da especificação Agent Skills — resultava em skill **sem tag
  nenhuma**, contra o que a caixa de confirmação da aprovação promete. O parser
  de frontmatter passou a ler a lista nas duas indentações válidas; `chave: x`
  seguida de `- y`, que é YAML inválido, continua ignorada.
- **Envio sem teto de arquivos:** medido, 600 chamadas gravaram 602 arquivos num
  envio, enquanto o mesmo conteúdo em `.zip` teria parado em 512. O envio passou
  a ter o teto do pacote (`DEFAULT_MAX_ZIP_ENTRIES`).
- **A nota que prometia um substituto inexistente.** O comentário da rota
  removida e a §6 do `docs/15` diziam que quem precisasse trocar a árvore de uma
  skill "importa o pacote de novo e promove". Medido: importar para produção dá
  **409** (o import manda o slug do frontmatter explicitamente) e importar para a
  quarentena e aprovar cria uma **segunda** skill. O texto passou a dizer o que é
  verdade — não há substituto no painel, e o caminho que resta é o
  `set_files_bulk` do MCP administrativo.
- **Escalada de privilégio pela quarentena.** Uma conta rebaixada a `membro`
  depois de enviar continuava aprovando o próprio envio na política padrão e,
  como dona da skill que nascia, podia marcá-la como pública — enquanto
  `POST /api/skills` e `POST /api/skills/import` lhe devolviam **403**. Promover
  passou a exigir também `canCreate`, porque promover *é* criar no acervo
  (`docs/12` decisão 12). O envio dela continua visível e editável.
- **`canPromote` ficou no tipo compartilhado** (`QuarantineSheet`), em vez de
  declarado solto nas duas pontas, e deixou de ser opcional: um `undefined` de um
  servidor antigo desenharia o botão "Aprovar" para quem não pode.
- **`docs/03-implementation-notes.md` ficou sem as marcas de revogação** que o
  `AGENTS.md` exige, com dois trechos descrevendo como vigentes o `.zip` do
  painel e o checkbox de substituir a árvore. Marcados, mais a nota no topo; o
  cabeçalho do `docs/15` passou a enumerar os três documentos que ele revoga.

### Decidido e não mudado

- **A quarentena não varre o conteúdo do pacote.** Ela atrasa a publicação
  para que uma pessoa leia; não há análise automática, e não haverá por ora.
- **Sem prazo, cota ou notificação.** Envio esquecido fica na fila. Podar por
  idade exigiria decidir o que é "velho" sem saber o que a instalação faz, e
  apagar trabalho alheio por relógio é pior que uma lista comprida; avisar
  alguém depende de saber a quem, o que só a política de aprovação em uso
  responde.
- **O envio não tem concessão por objeto** (`*_grants`). Quem enxerga também
  edita e descarta. Um nível intermediário traria de volta exatamente a
  complexidade que o espaço foi desenhado para evitar.

## [1.0.0-beta.23] — 2026-09-20

Auditoria de 2026-09-19 (segunda rodada). 87 relatórios, reverificados **no
código** — não na descrição do relatório —, corrigidos quando procediam e
anotados um a um. Dos 87: a grande maioria
procedia, um punhado procedia em parte, e o que foi **mantido de propósito**
está em "Decidido e não mudado (2026-09-19)", com a medição que fundamentou a
decisão. Nenhum diff proposto foi aplicado sem antes ser reproduzido ou medido;
vários foram trocados por uma correção diferente porque a proposta criava outro
defeito, e esses casos estão nomeados abaixo.

Resultado medido no fim: `npm run typecheck` limpo — agora **cobrindo também os
arquivos de teste** — e, com `TEST_DATABASE_URL` num banco recriado do zero,
**93 arquivos e 1782 testes, zero falhas e zero pulados** (a linha de base eram
70 arquivos e 1084 testes). Quatro migrations novas, renumeradas no fecho para
uma sequência contígua: `026-auditoria-de-vinculo-e-reativacao`,
`027-rag-stale-na-troca-de-tipo`, `028-reserva-de-skills-com-prazo` e
`029-arquivos-de-texto-antigos` — nesta ordem de propósito, porque a conversão
depende da correção do trigger.

### Mudanças incompatíveis (2026-09-19)

Cada item diz o que o operador — ou quem integra — faz a respeito.

- **Instalação e boot**
  - `ADMIN_COOKIE_SECURE` e `OIDC_AUTO_PROVISION` passaram a ser lidas por um
    leitor estrito: aceitam `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off` em
    qualquer caixa, e **valor irreconhecível derruba o boot** nomeando a
    variável. Antes, `TRUE` ou `yes` viravam `false` em silêncio — ou seja,
    destravavam o cookie de sessão que o operador quis travar. *Faça:* confira
    as duas no `.env`.
  - O teto do corpo JSON ganhou **um nome por serviço**:
    `MCP_PUBLIC_JSON_LIMIT` e `MCP_ADMIN_JSON_LIMIT`. O nome único levava o teto
    generoso do administrativo para a superfície anônima. `MCP_JSON_LIMIT`
    continua valendo como queda do **administrativo**. *Faça:* quem apertava o
    MCP público por `MCP_JSON_LIMIT` precisa escrever `MCP_PUBLIC_JSON_LIMIT`;
    sem isso o público volta ao padrão de `1mb`. Valor fora do formato (`48m`,
    `64 megas`) passou a derrubar o boot: o `bytes` os lia como **48 bytes** e o
    serviço subia respondendo 413 a tudo.
  - As três variáveis do antigo MCP principal (`MCP_PUBLIC_AUTH`,
    `MCP_PUBLIC_KEY`, `MCP_PUBLIC_KEY_FILE`) voltaram ao `environment` do
    `mcp-public` no compose — ver "Segurança". *Faça:* quem ainda tem uma delas
    **preenchida** no `.env` verá o `mcp-public` recusar o boot até removê-la;
    antes disso, feche o MCP padrão ou emita chaves `psv_` no painel.
  - O runner de migrations **recusa reaplicação retroativa**: histórico truncado
    (restauração sem `schema_migrations`) ou arquivo novo com número menor que o
    último aplicado saem com 1 e explicam o caminho. Era o que deixava o `012`
    reaplicado derrubar `skills.is_public` em silêncio. *Faça:* a saída
    deliberada é `MIGRATE_ALLOW_RETRO=1`.
  - Com a busca semântica ligada, os anexos antigos de extensão textual
    (`.conf`, `.ini`, `.log`, `.tf`…) passam a ir ao provedor de embeddings no
    ciclo seguinte: a migration `029-arquivos-de-texto-antigos` converte para
    texto as linhas gravadas como binário antes da beta.22. *Faça:* em base com
    muitos anexos, aplique em janela.
- **Painel e API**
  - **Nenhuma resposta do painel carrega o uuid de uma conta.** Dono,
    concessões e quem leu saem pelo **e-mail**; `mcps[].ownerUserUuid` (na ficha
    do catálogo) e `catalogs[].ownerUserUuid` (na do vMCP) sumiram. *Faça, quem
    integra:* trate `ownerUserUuid` e `grants[].userUuid` como e-mail.
  - A checagem anti-CSRF compara a origem **inteira** — esquema, nome e porta —
    e `ADMIN_ALLOWED_ORIGINS` passou a casar do mesmo jeito. *Faça:* painel
    atrás de proxy numa porta que **não** chega no `Host` (nginx com
    `Host $host` em `:8443`) precisa de `ADMIN_PUBLIC_URL`, senão as escritas
    respondem 403.
  - `POST /api/users` com a **sessão de bootstrap** passou de 201 a 400: a
    primeira conta é sempre o administrador do `/api/setup`. Campo de texto que
    não é texto (`{"name":123}`) responde 400 em vez de 500 ou de gravar
    `"[object Object]"`.
  - O teto de texto inline vale agora nas **quatro** leituras do MCP público e,
    no administrativo, em `get_file` e `get_skill`; leitura recusada não conta
    acesso. `MCP_ADMIN_MAX_FILE_TEXT_BYTES` permite subir só o administrativo.
  - Nome de vMCP, catálogo e chave `psv_` ganhou teto de **200 caracteres** na
    criação e na renomeação; nome antigo mais longo continua editável.
  - Envio avulso de um `SKILL.md` que não é UTF-8 válido responde 400 em vez de
    gravar o prompt corrompido, e um `.zip` cujo `SKILL.md` não é texto é
    recusado em vez de gravar corpo vazio.

### Corrigido (2026-09-19)

- **Contas, sessão e acesso**
  - A primeira conta é sempre o administrador: com a tabela vazia o SSO não
    auto-provisiona ninguém, e a recusa aponta "Criar o primeiro
    administrador". Um membro criado antes do setup fechava o setup e o login
    pela `ADMIN_PASSWORD` **sem existir administrador**.
  - O primeiro acesso por SSO a uma conta pré-criada descarta a senha
    temporária, em vez de cobrá-la: a conta vira só-SSO e as sessões abertas com
    a temporária caem.
  - Gerar a senha temporária zera a trava de login no mesmo `UPDATE`: a
    temporária certa era recusada com 429 até a trava vencer, e a ficha
    prometia o contrário.
  - Reativar conta e vincular identidade OIDC entram na trilha (`user.activate`
    e `user.link`, com o ator `oidc:<issuer>`), pela migration
    `026-auditoria-de-vinculo-e-reativacao`.
  - Revogar a concessão de uma **conta desativada** voltou a funcionar nas seis
    superfícies, e a guia Acesso marca a linha em vez de oferecer mudança de
    nível.
  - A revogação de chave `psk_`/`psv_` audita `<dono ou slug>: <nome>
    (<prefixo>)` — o mesmo rótulo da emissão — em vez do uuid da chave.
  - O "Sair" deixou de carimbar `users.updated_at`: movimento de sessão não é
    alteração da conta.
  - O limitador por IP do login passou a ser o do pacote compartilhado, que
    conta IPv6 por **/64**; a cópia local, que contava por endereço, saiu.
- **Conteúdo da skill**
  - Anexo de extensão textual que **não** é UTF-8 válido (o `.csv` do Excel em
    Windows-1252) é guardado byte a byte como binário, em vez de ter os bytes
    inválidos trocados por `�` sem aviso. A régua é uma só, no pacote e no banco.
  - `PUT …/files/*path` normaliza o caminho antes de decidir sobre o
    frontmatter: `.%5CSKILL.md` gravava o bloco enviado na linha do `SKILL.md`,
    fora da vista e **dentro da busca**.
  - `stripFrontmatter` só descarta bloco com cara de mapa YAML e virou
    idempotente (medido em 400 mil documentos aleatórios: a função antiga não
    era, em 4,8% deles): o prompt que abre com uma régua `---` não perde mais o
    trecho até a régua seguinte.
  - A importação lê `description` em escalar de bloco (`>-`, `|`) e em texto que
    continua na linha de baixo; antes a skill nascia com a descrição `">-"`.
  - Upload de `.zip` e `set_files_bulk` não achatam mais um envio parcial de
    subpasta: a raiz única só é removida quando **contém o `SKILL.md`**.
  - Nome de arquivo com acento deixou de ser lido como Latin-1
    (`descriÃ§Ã£o.md`), e o teto de upload passou a valer também para envio
    `chunked` — a soma é conferida a cada pedaço, com 413 no que estoura, em vez
    de bufferizar até 50× o teto.
  - A prévia de remoção do `set_files_bulk` usa o mesmo predicado do `DELETE` no
    banco; a conta refeita em JavaScript discordava em `İ` e levava a um 409
    sem saída.
- **Concorrência no banco** (tudo medido em container descartável)
  - Toda escrita de arquivo de uma skill entra numa fila por advisory lock, como
    **primeira** statement: o deadlock entre salvar a skill com o `SKILL.md` e
    gravar arquivo era 500 em ~40% dos pares concorrentes, e foi a zero.
  - Ordem única de travas no recorte do vMCP — travar o servidor com
    `FOR NO KEY UPDATE`, mexer nos vínculos, gravar no servidor por último.
    Zera os deadlocks de vínculo × canvas × recorte × registro de acesso e o de
    duas criações publicando nos mesmos servidores (149 de 150 pares). O remédio
    "óbvio" (adiantar o `UPDATE` do vMCP) foi medido e **recusado**: abria um
    ciclo novo com a chave estrangeira do registro de acesso.
  - A skill apagada no meio de uma escrita responde 404 em vez de 500.
  - O slug gerado perto do teto de 96 caracteres deixou de responder 409 a
    partir do terceiro homônimo, nas três tabelas.
  - Toda ordenação de `listSkills` termina em chave única: sem isso a paginação
    não era partição do conjunto (medido: 481 skills distintas em 720 lidas).
  - Offset além da faixa do `bigint` **satura** em vez de virar 500 na lista
    anônima do site.
- **RAG e indexador**
  - O lote que falha por motivo que **não** é o conteúdo devolve a reserva na
    hora, com os lotes que nem saíram; antes ficava dez minutos reservado e o
    painel alternava entre "chave recusada" e "aceita, sem erro".
  - Recusa permanente só depois de confirmar, com um texto-sonda, que o provedor
    aceita outro conteúdo: um 400 que atinge tudo (proxy na URL base, contrato
    da API, conta) vira erro de configuração, não marca nada e faz o `--once`
    sair com 1. O painel ganhou "Tentar de novo" os textos recusados.
  - `SIGTERM`/`SIGINT` viraram parada educada, também no `--once`: o ciclo
    devolve à fila as skills e os textos que reservou e não começou, com teto de
    8 s. A reserva de skills ganhou prazo, então o lote de um indexador morto
    (OOM, banco reiniciando) volta à fila em vez de ficar "feito" para sempre.
  - A pendência do RAG enxerga a troca binário ↔ texto com o conteúdo igual: um
    `.ini` reenviado igual virava texto sem entrar na busca semântica.
  - A semeadura deixou de conferir `RAG_MODEL` contra o `RAG_DRIVER` do `.env`
    quando o banco já decidiu o driver — o par inválido fazia o indexador
    recusar a cada ciclo e a busca cair para o modo textual.
  - O painel decide o estado da chave por uma **classe** de erro, não por
    pedaços do texto da última falha: conta sem crédito, IP recusado e provedor
    fora do ar apareciam como "aceita pelo provedor".
- **Painel (interface)**
  - O tema tem um estado só: trocar pelo menu da conta não deixa mais o comando
    da paleta com o rótulo invertido e o primeiro clique sem efeito.
  - No canvas, dois gestos rápidos no mesmo item não se desfazem: cada gesto
    parte do que está gravado **mais** o que está em andamento, e as escritas
    saem uma por vez. Se a recarga falha depois de uma escrita que passou, o
    diálogo fecha e o painel avisa que gravou, em vez de travar em
    "Adicionando…".
  - Trocar de guia nas fichas de catálogo, conta e servidor não recarrega a
    ficha — o que apagava, sem aviso, o que ainda não tinha sido salvo. O
    "Salvar" da skill só sai do editor quando a skill ficou fora de alcance
    (404); em sessão vencida, 5xx ou queda de rede a página fica com as
    pendências de pé.
  - A tabela de sessões volta à primeira página quando o servidor escolhido
    muda, descarta resposta atrasada e consulta uma vez na montagem.
  - A paleta de comandos busca servidores e catálogos a cada abertura: catálogo
    criado na sessão aparece sem precisar de F5 (que descartava rascunhos).
  - A criação de skill saiu de `/skills/new` para `/nova-skill`: uma skill de
    slug `new` abre a ficha, e o endereço antigo continua levando ao formulário
    quando essa skill não existe.
  - A trilha e o sino nomeiam `rag.settings` e `rag.reindex`, e o período da
    auditoria usa o **dia do calendário de quem olha** nas duas bordas (o
    "Desde" saía em UTC e o "Até" em hora local).
- **Site, homepage e MCP público**
  - `HEAD` não conta visualização nem download e devolve só os cabeçalhos:
    cada `HEAD` anônimo gravava acesso, mexia na ordem da vitrine e gerava o
    `.zip` inteiro para descartar.
  - O registro de acessos grava o IP e o agente da requisição que **leu**, em
    vez de repetir os de quem abriu a sessão.
  - O caminho de uma leitura registrada olha a porta: o catálogo vinculado só
    com Prompts deixa de entrar na linha de um `get_skill`.
  - A seção "Via MCP" da página da skill só ensina `get_skill("<slug>")` quando
    algum vMCP aberto publica a skill por essa porta; o cartão da API REST diz
    "CORS aberto" ou "restrito" conforme a instalação.
  - A homepage voltou a dizer o que o código faz (a receita de 60 segundos
    manda trocar os **quatro** `CHANGE_ME`, e ganhou o `cd` que faltava), com um
    teste que confere esses números contra o código e os composes.
- **Build e ferramentas**
  - A raiz declara `vite ^7.1.5` junto do Vitest: sem isso o lock instalava o
    Vite **8** na raiz e o 7 aninhado por app, os plugins hasteados resolviam
    para o 8, e o `vite dev` morria com *Missing field `moduleType`*. Com a
    declaração há um `vite` só (7.3.6), sem `rolldown` na árvore — e o
    `vite dev` voltou a subir.
  - `npm run typecheck` passou a cobrir os **arquivos de teste** (um
    `tsconfig.typecheck.json` por workspace; o `build` continua sem eles).
    Ligar a conferência achou sete erros de tipo reais, dois em asserções que
    nunca haviam sido verificadas por recaírem sobre um valor `unknown`.
  - O `release-images.sh` só move `latest` no fim, por um segundo laço com
    `docker buildx imagetools create`, começando pela imagem do banco: build que
    falha no meio deixa `latest` inteira na versão anterior, em vez de
    repartida. Ao abortar, inclusive por Ctrl-C, ele diz em que estado o Hub
    ficou.
  - `npm run migrate` deixou de sair com 0 sem fazer nada quando a cópia de
    trabalho tem espaço, acento ou symlink no caminho.

### Segurança (2026-09-19)

- **Um lote JSON-RPC deixou de furar o limite de taxa do MCP público.** Um POST
  só comprava milhares de `tools/call` por uma marca do porteiro — medido em
  2 000 execuções numa requisição. Array com mais de `MCP_MAX_BATCH` mensagens
  (padrão 20) responde 400, e cada mensagem do lote gasta uma marca; chave
  `psv_` segue sem gastar cota.
- **`clientInfo` sem corte retinha a memória do processo.** 400 identidades
  stateless com nome de 1 MB seguravam **+400 MB** de heap, porque o corte por
  `slice` mantém viva a string original; com cópia, +1,4 MB. O rótulo é saneado
  e cortado em 512 caracteres antes de entrar na memória e no banco — e um byte
  nulo no nome do cliente, que fazia a leitura sumir da guia "Acessos" e dos
  contadores, não derruba mais a gravação.
- **A trava de boot do antigo MCP principal estava inerte sob o compose.** Da
  beta.15 à beta.22 as três variáveis não chegavam ao container, então o `/mcp`
  de quem protegia o servidor com `MCP_PUBLIC_KEY` abria em silêncio ao subir de
  versão. Elas voltaram ao `environment`, com padrão vazio, e um teste de guarda
  falha se a próxima faxina as tirar de lá.
- **A ficha devolvida pelas escritas vazava o que a conta não vê.** O vínculo de
  skill a vMCP, o `PATCH` da skill e as escritas de catálogo reliam na visão do
  administrador: nome, uuid e dono de servidores fechados e catálogos privados
  de terceiros chegavam a qualquer conta logada. Agora a resposta é recortada
  como o `GET`, e a ficha diz "e mais N que você não vê".
- **A mensagem de erro do provedor de embeddings não leva mais a chave** ao log,
  ao banco nem ao "Último erro": o 401 da OpenAI ecoa a chave, e ela sai como
  "[chave omitida]" nos três drivers.
- **O `.gitleaks.toml` dispensava segredo em interpolação.** `${VAR:-valor}`
  passava nas três regras do projeto, e a dispensa por linha calava também as
  regras padrão — provado com um token no formato de PAT do GitHub. A dispensa
  passou a ser ancorada no fim, o allowlist por linha saiu, e
  `INSPECTOR_API_TOKEN` e `PGPASSWORD` entraram na regra.
- **Guarda nova no CI: nenhum byte de controle literal em fonte.** Três arquivos
  da árvore tinham um — e quando o byte é o nulo, o git trata o blob como
  binário, o diff vira "Binary files differ" e o `gitleaks`, que lê o histórico
  por diffs, **nunca enxerga aquelas linhas**. A guarda olha os bytes, não o
  veredito do git: ele procura o nulo só nos primeiros 8 000 bytes, e num dos
  três o nulo estava no byte 274 217.
- O pedido de redefinição de senha não espera mais a gravação do link nem o
  envio: tempo e status da resposta deixaram de revelar se o e-mail tem conta.
- "Abrir cru" serve `.js` e `.css` como `text/plain` com `nosniff` — o `'self'`
  da CSP aceitava o arquivo cru como sub-recurso da própria origem (verificado
  num navegador real: com `text/javascript` o script executava) — e manda
  `Cache-Control: private, no-cache`.
- Endereço com `%00` responde 400 na entrada dos roteadores do painel, do site e
  do MCP público; antes virava o erro 22021 do Postgres e um 500.

### Desempenho (2026-09-19)

- O recorte de membros da ficha do catálogo usa a condição barata: com 1 000
  membros mede ~6 ms sem JIT, contra 54–112 ms da forma proposta pelo relatório.
- A escolha de slug perto do teto mantém o índice: o terceiro padrão `LIKE` que
  o diff proposto acrescentava trocava o `BitmapOr` por `Seq Scan` (2,7 → 6,3 ms
  em 52 mil skills).

### Documentação (2026-09-19)

- `docs/14` e o comentário do cliente HTTP do RAG descreviam o RAG **anterior**
  à fila com reserva: fila sem reserva, recusa só em memória, coleta de órfãos
  inexistente, indexador sem prazo. Corrigidos, com o texto antigo riscado sob
  "Era, até a fila de textos" e marca no topo do documento.
- O `docs/02` §7.7 afirmava limite de taxa em "site, mcp-public e mcp-admin": o
  **administrativo nunca teve limitador** — a terceira superfície é o login do
  painel. Corrigido, com a orientação de limitar no proxy.
- O `docs/05` deixou de prometer que a chave `psk_` de um membro "só executa as
  tools de leitura": o papel barra apenas criar; o resto é o acesso ao objeto.
  Quem entrega uma `psk_` a um agente entrega o alcance inteiro da conta.
- O README parou de mandar copiar os quatro CSS "juntos" entre os apps — o
  painel **nunca** é destino dos três primeiros, e sobrescrevê-los destrói o
  console —, e o cabeçalho dos dois `SkillDoc.tsx` parou de mandar copiar um
  sobre o outro.
- A documentação do indexador foi alinhada ao compose: ele sobe no
  `docker compose up -d` comum desde a beta.22, porque o perfil `rag` está
  comentado de propósito. *Consequência para quem atualiza:* quem mantinha o
  indexador parado com driver escolhido volta a enviar o acervo.
- Marcas de revogação que faltavam em `docs/08`, `09` e `11`, e quatro pontos do
  `docs/08` acertados (o teto global de sessões recusa com 503, não 429; a raiz
  reusa a identidade do vMCP padrão; o `.zip` sai em fluxo; a "tabela de
  eventos" existe).
- A seção "Armadilhas medidas" ganhou as lições desta rodada: a fila por
  advisory lock, a ordem única de travas do vMCP, e o byte de controle literal
  em fonte — com o aviso de que a ferramenta de edição recria o U+0000 ao
  gravar, e que a forma certa é montar o caractere em código.

### Decidido e não mudado (2026-09-19)

- **`skills_score_idx` fica.** Ele faz de todo incremento de contador um
  `UPDATE` não-HOT — medido: 0% de HOT, 49 315 bytes de WAL por incremento,
  índices de 7 para 68 MB —, e `fillfactor` não muda nada. Mas derrubá-lo deixa
  a listagem padrão 2 a 3,5 vezes mais lenta (0,6 → 396 ms em 52 mil skills). O
  desenho que atende os dois lados (tabela estreita mantida por trigger, ~560
  bytes por incremento) está medido e **não** aplicado: é tarefa própria, porque
  mexe no `FROM` da consulta principal.
- **O balde de sessões de um vMCP aberto continua único para todos os
  anônimos.** A variante barata — "reciclar primeiro a sessão do próprio
  endereço" — foi implementada, medida e **revertida**: com o balde cheio de
  sessões abandonadas, duas janelas do mesmo usuário deram 10 reaberturas em 10
  chamadas, e um NAT inteiro vira uma sessão só. O que mudou foi a
  documentação e o 404, que agora diz o que fazer.
- **A memoização de embeddings por consulta não entrou.** Ela era o
  "complemento" do relatório do lote JSON-RPC, mas embedding por requisição sem
  cache já fora decidido na rodada anterior como custo, não defeito — e a
  correção principal (cobrar por mensagem) resolve o abuso.
- **A terceira frente do relatório de concessões continua recusada:** mudar o
  **nível** de uma concessão de conta desativada segue proibido; revogar, que é
  o que estava quebrado, voltou a funcionar.
- **`RENAMED` não recebeu entrada** pelas migrations renumeradas: nenhuma delas
  foi publicada, e a tabela existe para migration que já saiu da cópia de
  trabalho.
- **O runner de migrations continua sem advisory lock** e a **bisseção do driver
  do RAG** continua descartando lotes já pagos — as duas decisões vêm da rodada
  anterior e foram respeitadas.

### Pendente (2026-09-19)

Nada aqui é especulação: cada item vem de um relato.

- **Decisões que dependem do mantenedor:** se o link de redefinição por e-mail
  também deve destravar a conta (hoje só a senha temporária gerada pelo
  administrador destrava); se o dono de uma skill deve ver vMCP fechado de
  terceiro na ficha (hoje não vê em nenhum dos dois lados); se os tipos de
  arquivo recém-convertidos (`.conf`, `.ini`, `.log`) devem mesmo ir ao provedor
  de embeddings; o teto de nome para a **skill** (o de vMCP, catálogo e chave
  entrou); e o balde por endereço no vMCP aberto.
- **Pedidos ao dba ainda abertos:** aplicar a parte negativa da consulta também
  na perna semântica da busca híbrida — hoje a exclusão com hífen vale só na
  perna textual, e a descrição da tool deixou de prometer o que não cumpre; e a
  tabela estreita da ordenação por pontuação.
- **Etapa 2 do e-mail no lugar do uuid:** os campos ainda existem no tipo
  compartilhado e na projeção do banco, agora sem consumidor.
- **Diagnóstico de dados já danificados**, que nenhuma correção desfaz: linhas
  de arquivo com `U+FFFD` de decodificação errada, `SKILL.md` gravado com
  frontmatter dentro do corpo, descrições que nasceram como `">-"` e
  `relative_path` com nome corrompido em Latin-1. As consultas estão nos
  relatórios.
- **Duas vulnerabilidades altas em `nodemailer`**, pré-existentes e não
  introduzidas por esta rodada: o conserto é `nodemailer@10`, troca de major.
- **A CI continua sem serviço `postgres` e sem `TEST_DATABASE_URL`**, então as
  suítes de integração seguem sem rodar lá — nesta rodada foram executadas à
  mão. O `typecheck` da CI, esse sim, passou a **compilar** os testes de
  integração, o que já pega erro de tipo sem executá-los.
- **Republicar as imagens** continua pendente da rodada anterior: as que estão
  no Docker Hub seguem só `arm64`.

---

## [1.0.0-beta.22] — 2026-09-19

Auditoria de 2026-09-18 (primeira rodada). 53 relatórios de problema foram
reverificados no código — não na descrição do relatório —, corrigidos quando
procediam e anotados um a um, mais alguns desdobramentos encontrados no caminho.
O que **não** foi mudado está em "Decidido e não mudado", com o motivo; o que
ficou para depois está em "Pendente". **Os números de relatório citados daqui
para baixo são os desta rodada**, e não os da de 2026-09-19.

*Esta seção saiu na beta.22 rotulada como "Não publicado": o rótulo foi
acertado na beta.23, junto com o cabeçalho de versão que faltava.*

### Mudanças incompatíveis

Esta seção vem primeiro porque é a que evita retrabalho: cada item diz o que o
operador (ou quem integra) faz a respeito.

- **Instalação e boot**
  - O boot **recusa** o placeholder do `.env.example` em
    `ADMIN_SESSION_SECRET`, `ADMIN_PASSWORD` e `MCP_ADMIN_TOKEN`: `CHANGE_ME`
    (e `PLACEHOLDER`, `EXEMPLO`, `undefined` e afins) derruba o serviço. Era
    exatamente isso que deixava a instalação aberta — o segredo que assina o
    cookie do painel é público no repositório. *Faça antes de atualizar:* trocar
    os quatro `CHANGE_ME` do `.env.example` por valores reais
    (`openssl rand -hex 32`); uma instalação que hoje roda com o placeholder não
    sobe mais (relatório 001).
  - O padrão do `TRUST_PROXY` ficou mais estreito: sem a variável, os cinco
    serviços confiam no `X-Forwarded-For` de **um salto** e só quando quem abre
    a conexão está em loopback ou faixa privada. *Faça:* instalação com **dois
    proxies internos em sequência** precisa declarar `TRUST_PROXY` (contagem de
    saltos, endereço ou CIDR do proxy); sem isso o proxy de dentro passa a ser
    "o cliente" — todos num balde só do limitador de taxa, e o link de
    redefinição voltando a aceitar o `Host` (relatório 026).
  - Os containers de aplicação passaram a ter teto de memória (`APP_MEM_LIMIT`,
    1,5 GB; `HOMEPAGE_MEM_LIMIT`, 256 MB). O teto foi dimensionado pelo pior
    import legítimo, mas *faça:* quem importa skill grande confere o número
    antes — uma importação de 200 MB descomprimidos custa cerca de 400 MB de
    RSS, e um teto apertado passa a matar import legítimo (relatórios 010, 004).
  - Os containers do banco também ganharam teto: 2 GB no `postgres`
    (`POSTGRES_MEM_LIMIT`) e 512 MB nos passos `migrate`/`seed`
    (`DB_JOB_MEM_LIMIT`), com área de troca desligada e sem teto de CPU. O
    número do banco é dimensionado pelo que o kernel **não** consegue recuperar
    quando o cgroup enche — áreas compartilhadas, os 50 backends que o pool dos
    cinco apps abre e os três autovacuum. Medido com o schema aplicado do zero,
    são 227 MiB com 50 sessões aquecidas e pico patológico de ~1,9 GB, então 1 GB
    ficaria **abaixo** do pico: um teto apertado deixa o OOM killer derrubar o
    `postmaster` e passa a ser a causa da queda, não a proteção. *Faça:* quem
    subir `shared_buffers`, `work_mem`, `max_connections` ou `DB_POOL_MAX` sobe o
    teto na mesma conta (relatório DBA-COMPOSE, corrigindo a sugestão de ~1 GB do
    relatório 010).
  - **Nenhum teto de memória — nem dos apps, nem do banco — vale numa stack que
    já está de pé:** eles entram no próximo `docker compose up -d`, que recria os
    containers. *Faça:* planejar a recriação — o `pgdata` é volume nomeado, então
    não há perda de dado, mas o banco cai por alguns segundos e os pools dos apps
    reconectam (relatório DBA-COMPOSE).
  - A porta do Postgres saiu do `BIND_ADDR` global e ficou no loopback
    (`POSTGRES_BIND_ADDR`, padrão `127.0.0.1`): o botão de alcançar o painel de
    outra máquina não publica mais na rede um banco sem limite de tentativa de
    login, sem trava de conta e com a senha que o `.env.example` traz como
    placeholder. Nenhum app usa essa porta — todos falam com o banco pela rede
    interna do compose —, e o override do Traefik já a despublicava. *Faça:* quem
    usa `BIND_ADDR=0.0.0.0` e precisava do banco de fora passa a declarar
    `POSTGRES_BIND_ADDR=0.0.0.0` (e não com a senha de exemplo). A forma
    aninhada, que preservaria o comportamento antigo como padrão, foi recusada:
    funciona, mas uma variável de proteção presente e **vazia** deixaria de
    proteger (relatório DBA-COMPOSE, sobre o pedido do relatório 012).
  - A porta do MCP Inspector muda de `:3010` para **`:6274`** — a que a imagem
    expõe, a do healthcheck dela e a que o `.env.example` e o manual sempre
    disseram. *Faça:* na próxima recriação do container, apontar navegador,
    bookmark e proxy para `:6274`; `INSPECTOR_PORT=3010` no `.env` mantém o
    antigo (relatório 039).
  - O Inspector saiu do `BIND_ADDR` global e ficou no loopback
    (`INSPECTOR_BIND_ADDR`), e o override do Traefik despublica a porta dele: o
    botão de "alcançar os serviços de outra máquina" não publica mais na rede a
    única ferramenta sem autenticação com rota até o MCP administrativo.
    *Faça:* quem precisa da UI de fora define `INSPECTOR_BIND_ADDR` **e** liga a
    autenticação (`INSPECTOR_OMIT_AUTH=false` + `INSPECTOR_API_TOKEN`)
    (relatório 012).
  - O Inspector está fixado em `2.7.0` com `pull_policy: missing`. *Faça:* para
    mudar de versão, editar a tag — o `docker compose up` não a atualiza mais
    sozinho (relatório 053).

- **Painel**
  - "Sair" passa a **encerrar a sessão em todos os aparelhos** da conta: o
    logout incrementa o `token_version`, como já acontecia ao trocar a própria
    senha, e não só apaga o cookie. Uma cópia do cookie feita antes deixa de
    entrar na requisição seguinte. *Faça:* avise quem usa o painel em vários
    navegadores; a tela avisa antes, e quem foi revogado lê isso na volta ao
    login (relatório 029).
  - A rota de redefinição de senha responde **503** (`public_url_required`) a
    pedido vindo de fora quando `ADMIN_PUBLIC_URL` está vazia: antes, quem
    pedia o reset escolhia o domínio do link que chegava ao e-mail da vítima e
    recebia o token no clique. *Faça:* configurar `ADMIN_PUBLIC_URL` em
    qualquer instalação alcançável pela Internet; sem ela, só pedido de rede
    interna monta o link e os demais são redefinidos por um administrador. A
    instalação local segue com o "esqueci a senha" funcionando sem configurar
    nada (relatório 003).
  - Vale **um** link de redefinição por conta: emitir um novo fecha os vivos, e
    trocar a senha fecha os vivos (por link, pelo reset do administrador ou pela
    troca do próprio dono). A migration aplica a regra retroativamente. *Faça:*
    quem estiver com um e-mail de redefinição aberto na hora da atualização pede
    outro link (relatório 027).
  - Um login por SSO só assume conta local **já existente** com
    `email_verified` do provedor: sem a confirmação de posse, um IdP com
    autocadastro entregava a conta do administrador a quem digitasse o e-mail
    dele. Identidade já vinculada entra como antes, e conta nova continua sendo
    criada como `membro`. *Faça:* instalação cujo IdP não emite o claim e que
    pré-cria contas esperando entrada por SSO passa a entregar a senha
    temporária da criação de conta (relatório 013).
  - `GET /api/users/lookup` não devolve mais o `uuid` da conta — o `uuid` é o
    sujeito do cookie de sessão e a busca é aberta a qualquer conta logada.
    Contas são identificadas pelo e-mail, e o `ownerUserUuid` do `PATCH` de
    skill, catálogo e servidor aceita e-mail. *Faça, quem integra:* trocar
    leitura de `uuid` por `email` (relatório 025).
  - `GET /api/session` sem cookie devolve apenas o que a tela de login usa: os
    endereços da instalação, a janela de online, o driver do RAG e a versão
    saem da resposta anônima. *Faça, quem integra:* autenticar antes de ler
    esses campos (relatório 024).
  - Os números do painel e do `get_stats` são recortados pelo que a sessão
    enxerga, e as contagens de contas **saem do corpo** para quem não é
    administrador. *Faça, quem integra:* tratar esses campos como opcionais
    (relatório 023).
  - `PATCH /api/users/:uuid` recusa `isActive` que não seja `true` ou `false`:
    antes `"true"` (string) **desativava** a conta em silêncio, derrubava as
    sessões dela e registrava a desativação na trilha como se fosse o pedido.
    *Faça, quem integra:* mandar booleano JSON (relatório 046).
  - Páginas do site, da homepage e do painel passaram a mandar
    `Content-Security-Policy` e `frame-ancestors 'none'`. *Faça:* quem embutia o
    catálogo público num portal interno perde o iframe — hoje não há variável
    para afrouxar, é decisão de produto (relatório 045).

- **Site e MCP público**
  - O site **parou de devolver** campos que um cliente podia estar lendo: o
    e-mail e o UUID do dono, a lista de quem tem acesso (nome, e-mail, papel,
    nível e quem concedeu) e o estado interno `isPublic`/`isActive` de cada
    skill saíram da lista, da página da skill e da página de catálogo; a
    resposta também parou de nomear o catálogo **privado** por onde uma skill
    chega a um servidor MCP aberto. *Faça, quem integra:* o que precisar desses
    campos passa a exigir login (relatório 002).
  - `/api/meta` não traz mais a `description` do MCP virtual padrão: um padrão
    fechado entregava texto livre — nome de cliente, de projeto, de time — ao
    visitante anônimo, e a página não a usava. Slug e nome ficam (relatório
    050).
  - O `total` da busca cresce e a ordem da primeira página pode mudar: a perna
    textual não entra mais cortada em 100 skills, então o `total` deixa de parar
    em 100 + vizinhos e a skill que casa nas **duas** pernas sobe mesmo quando o
    texto dela casa abaixo da centésima posição. No A/B das cinco primeiras
    páginas o conjunto foi o mesmo e quatro skills de 120 mudaram de posição.
    *Faça, quem integra:* atualizar teste ou expectativa com número fixo de
    resultados (relatório 035).
  - Na busca, o que se digita é **texto**, não curinga: `%` casava o acervo
    inteiro (e a trilha de auditoria inteira) e `snake_case` casava
    `snake case`. *Faça:* quem usava `%` para listar tudo passa a procurar o
    caractere `%`; caixa, acento e palavra parcial não mudaram (relatório 036).
  - Limite de taxa por IP nas superfícies anônimas: 240 requisições por minuto
    no site e 600 no MCP público, com 429 e `Retry-After`
    (`SITE_RATE_LIMIT_MAX`, `MCP_RATE_LIMIT_MAX`; `0` desliga). `/healthz` e
    estáticos não contam, e quem chega autenticado por chave `psv_` não gasta a
    cota do endereço. *Faça:* NAT muito grande, ou orquestrador que dispare
    centenas de chamadas paralelas do mesmo IP, mede e sobe o número — o
    download de arquivo de vMCP conta contra o teto (relatório 014).
  - `get_skill_file` não devolve mais inline arquivo de texto acima de
    `MCP_MAX_FILE_TEXT_BYTES` (4 MiB): responde com a URL de download, que serve
    o arquivo sem as cópias que o JSON-RPC exigiria (relatório 044). *Esta
    entrada estava no grupo "MCP administrativo"; a tool é do MCP **público** —
    corrigido pelo relatório 032 da auditoria de 2026-09-19, que estendeu o
    mesmo teto às outras três leituras do público e, no administrativo, a
    `get_file` e `get_skill`.*

- **MCP administrativo**
  - `set_files_bulk` **recusa** a chamada que removeria arquivos: responde com a
    lista do que sairia e exige `confirm_deletions` com o número exato de
    arquivos a remover. Se o número não corresponder ao que sairia naquele
    instante, nada é removido. *Faça, quem automatiza:* repetir com
    `confirm_deletions`, ou usar `replace: false` para envio parcial — um `.zip`
    que não remove nada continua passando de primeira (relatório 011).
  - As sessões MCP têm teto **por credencial**, além do teto do processo:
    estourado o limite, fecha a sessão parada há mais tempo **da mesma
    credencial** em vez de recusar a nova, e a sessão SSE ociosa passa a
    expirar. *Faça, quem automatiza:* um stream aberto e parado pode ser
    encerrado — reconectar. A recusa por lotação soma os dois transportes,
    responde com `Retry-After` e aponta `POST /mcp/stateless` (relatório 007).
  - As ferramentas obedecem à credencial **da requisição**, não à do
    `initialize`: rebaixar uma conta no painel vale na chamada seguinte, mesmo
    com a sessão MCP aberta (relatório 006).

### Corrigido

- **Painel**
  - A lista de Skills alcança o acervo inteiro: "Carregar mais" acrescenta a
    página seguinte, e filtros, ordenação por nome e contadores passam a olhar
    tudo o que já foi carregado. O resumo não mistura mais escalas — enquanto
    faltar página, diz "100 de 250 skills carregadas · nelas: …" em vez de somar
    o total do servidor às contagens das cem primeiras (relatório 033).
  - Resposta atrasada não sobrescreve mais a nova nas listas de Skills e de
    Usuários, nas guias Acessos e Auditoria e na guia Atividade da ficha de uma
    conta: trocar de página, de conta ou de filtro deixava a tabela com a
    trilha anterior e o rodapé descrevendo outra faixa de linhas (relatórios
    032, 033, 024).
  - Filtrar Acessos ou a trilha da Auditoria fora da primeira página faz **uma**
    consulta, não duas, e o rodapé das duas telas diz "não foi possível
    carregar" quando a primeira carga falha, em vez de ficar em "Carregando…"
    para sempre (relatório 032).
  - Salvar uma skill envia nome, descrição e tags só quando mudaram: o que não
    foi tocado no formulário não volta por cima de quem salvou no meio
    (relatório 033).
  - Os números que o painel mostra a quem não é administrador deixam de virar
    "0" quando o servidor não os manda: o aviso de skills sem vínculo e a
    contagem de skills publicadas somem em vez de mentir (relatório 024).
  - Os dois teclados do painel foram separados: dentro de um servidor, `g c` e
    `g a` só navegam e `c`/`a` sozinhos só agem no palco — antes `g c`
    navegava **e** abria "adicionar catálogo" (relatório 051).
  - O diálogo de adicionar skill (ou catálogo) ao servidor reabre sempre com só
    a porta Tools marcada, em vez de repetir as portas da vez anterior
    (relatório 051).
  - As janelas do painel viraram janelas de verdade para quem usa teclado ou
    leitor de tela: título anunciado, foco levado para dentro, `Tab` circulando
    por dentro e foco devolvido a quem abriu (relatório 051).
  - Nas telas de acesso, a busca de contas volta a esconder o dono e quem já tem
    concessão, e escolher o dono atual deixa de gravar uma transferência dele
    para ele mesmo (desdobramento do relatório 025 no painel web).
  - O painel avisa — sem pedir confirmação — que vincular a um servidor MCP
    aberto publica a skill privada: no diálogo do canvas, na ficha da skill e no
    "Publicar em" da skill nova (desdobramento do relatório 021 no painel web).
  - `ownerUserUuid` aceitando e-mail também recusa conta desativada, o que o
    UUID cru não conferia; valor que não é e-mail nem UUID responde 400 em vez
    de virar erro do banco (relatório 025).
  - Login por SSO com `OIDC_ALLOWED_DOMAINS` vazia recusa com mensagem própria,
    nomeando a variável, em vez de culpar o domínio de quem tentou entrar
    (relatório 018).
  - Segredo lido de arquivo (`<NOME>_FILE`, padrão do Docker secrets) é aparado
    nas duas pontas, e arquivo em branco vale como ausente: uma linha em branco
    no fim do arquivo fazia o MCP administrativo recusar todo token e a senha de
    bootstrap ficar impossível de digitar (relatório 046).
  - A lista de skills do painel aceita `?limit=`/`?offset=` com lixo ou
    repetidos sem erro interno, como já era no site; e o slug gerado quando há
    colisão de nome cabe no teto de 96 caracteres, então o painel não recebe
    mais "slug inválido" num campo que ninguém digitou (relatório 046).

- **Site e MCP público**
  - A home do site pede os metadados **uma** vez, não seis (relatório 051).
  - A skill marcada pública recebe o link da página do site mesmo sem MCP
    virtual aberto: as duas superfícies MCP ainda usavam uma regra revogada
    (relatório 050).

- **MCP administrativo**
  - `set_file` normaliza o caminho antes de decidir sobre o frontmatter:
    `"./SKILL.md"` escapava da limpeza e gravava o frontmatter enviado na linha
    do `SKILL.md`, que guarda só o corpo. O bloco não redefinia metadado nenhum
    — eles moram em colunas e o frontmatter é gerado na leitura —, mas ficava
    fora da vista e dentro do índice de busca. Mudar metadados é `edit_skill`:
    nome, descrição, ícone e tags com `edit`; slug, estado e público com
    `manage` (`docs/12` §3.2). Esta entrada dizia "mexer em metadados é
    `manage`, não `edit`", o que nunca foi regra do projeto (relatório 050;
    texto corrigido pelo relatório 079 da auditoria de 2026-09-19).
  - O registro de acessos e o `audit_log` gravam o IP e o agente **da
    requisição** que fez a leitura, em vez de repetirem os da primeira chamada
    da sessão (relatório 006).

- **Banco**
  - Salvar uma skill grava **só** o que a chamada informou: dois salvamentos
    simultâneos não se desfazem mais, e o `is_public` de quem acabou de tornar a
    skill privada não volta a `true` por um salvamento de texto. Renomeação
    concorrente sobrevive (a skill volta pelo slug gravado) e skill apagada no
    meio da escrita é 404 em vez de erro interno (relatório 005).
  - A ação `user.password` entrou no `CHECK` de `audit_log.action` pela
    migration `024-auditoria-de-troca-de-senha.sql`, **nesta mesma rodada**, o
    que é o que faz a linha de troca de senha gravar de verdade (o detalhe do
    que ela registra está em "Segurança → Painel"; relatórios 030 e 079).
  - O `schema.ts` volta a descrever o banco: três chaves estrangeiras (duas
    `SET NULL`), nove índices, dois `UNIQUE` e seis `DESC` existiam só no SQL.
    Nada muda em tempo de execução — muda o que uma ferramenta de migração
    proporia apagar. Uma suíte de integração nova confere a tipagem contra um
    banco migrado do zero, nos dois sentidos (relatório 037).

- **RAG e indexador**
  - A busca do site e do MCP responde dentro de `RAG_QUERY_TIMEOUT_MS` mesmo
    quando o provedor pede minutos no `Retry-After`: a espera entre tentativas
    acorda no cancelamento, e nenhuma espera passa de 60 segundos — antes era o
    provedor quem decidia por quanto tempo a instalação ficava parada. Medido:
    com prazo de 120 ms e o provedor pedindo `Retry-After: 4`, a busca levava
    **4015 ms**; com a correção, e mesmo com o provedor pedindo
    `Retry-After: 300`, ela volta em **121 ms**, caindo na busca textual
    (relatório 008).
  - A indexação grava os vetores lote a lote: um lote que falha não joga mais
    fora o que os anteriores já custaram (relatório 009).
  - O texto que o provedor recusa de vez sai da fila em vez de ser repetido a
    cada ciclo: o lote recusado volta um texto por vez para achar o culpado, o
    log registra hash e tamanho e `rag.indexer.status` publica `refusedTexts`.
    A recusa é gravada **no banco**, não na memória do processo: reiniciar o
    container não manda o texto recusado ao provedor de novo, e a fila não fica
    parada atrás dele (relatório 009 e o desdobramento que o fechou).
  - Cada lote da indexação tem prazo (`RAG_INDEX_TIMEOUT_MS`, padrão 2 min):
    provedor que aceita a conexão e não responde não segura mais a rodada
    (relatório 048).
  - O log diz a variável de chave do driver **em uso**, em vez de citar sempre a
    do Google, e o registro de opções do RAG recusa valor torto nos campos
    numéricos (relatório 048).
  - O `--once` conta os textos que a fila processou, não os vetores que gravou:
    a réplica que perde a corrida não encerra mais com a fila cheia (relatório
    048).
  - A coleta de textos órfãos roda no fim de cada ciclo do indexador: texto
    canônico sem nenhuma ocorrência sai, e com ele os vetores que foram pagos
    por ele (relatórios 048 e DBA-RAG).
  - A fila **reserva** o que entrega, por dez minutos: duas réplicas do
    indexador deixam de pagar o mesmo embedding. Medido: sem a reserva, duas
    réplicas pegam os mesmos quatro textos; com ela, nenhum (relatórios 048 e
    DBA-RAG).

- **Build e instalação**
  - Cada imagem é publicada com duas tags, `:VERSÃO` e `:latest`, em
    `linux/amd64` **e** `linux/arm64`. Correção de quebra real: o que estava no
    Docker Hub era só `arm64`, então nenhum servidor amd64 rodava o que o
    `docker compose pull` baixava. Voltar de uma release ruim passou a ser
    `TAG=<versão anterior> docker compose up -d`, e a versão e o commit ficam
    gravados na imagem em labels OCI. O script de release pede confirmação antes
    do primeiro build, mostrando versão, tags, plataformas e commit — e avisa
    quando a árvore está suja (relatório 015).
  - As imagens do painel e dos dois MCPs anunciam a versão da release quando
    rodam fora do compose, em vez do `1.0.0-beta.1` congelado no código
    (relatório 015).
  - O compose repassa aos containers tudo o que os apps leem: o teto do corpo
    JSON dos dois MCPs (`MCP_JSON_LIMIT`, documentado e que não chegava a
    ninguém), os tetos de sessão por credencial, de taxa por IP, de identidades
    stateless e de texto devolvido inline, o CORS do site, o pool do banco e a
    versão anunciada no handshake — todas vazias, para o padrão derivado de cada
    uma continuar valendo (relatório 039).
  - A allow-list de origens do MCP Inspector era chave sem valor:
    `INSPECTOR_ALLOWED_ORIGINS` não chegava ao container e a UI atrás de porta
    remapeada ou de proxy ficava barrada sem explicação (relatório 039).
  - O guia de desenvolvimento ensina `npm run build:packages`: a receita antiga
    compilava só `shared` e `db`, e quem seguia o README batia em
    `ERR_MODULE_NOT_FOUND` de `@purple-skills/rag` no primeiro `npm run dev:*`.
    A ordem `shared → rag → db` passou a viver numa única string (relatório
    020).
  - `npm run build` na raiz compila também o `@purple-skills/indexer`, que tinha
    script, Dockerfile e imagem no CI mas ficava fora do encadeamento
    (relatório 052).
  - O CI reprova o arquivo copiado que divergiu do par: `tokens.css`, `base.css`
    e `chrome.css` entre site e homepage, `markdown.css` entre site e painel, e
    os cinco módulos da árvore e do prompt. Reprova também o par incompleto
    (renomear ou apagar um lado é o mesmo defeito) e a cópia do CSS do site por
    cima do painel, que apaga o visual do console; a mensagem de falha nomeia
    origem e cópia e imprime o `cp` na direção certa (desdobramento do relatório
    043).
  - Os manifests declaram as bibliotecas que os testes já usavam por içamento do
    npm (`adm-zip` no painel, `pg` no MCP público e no indexador): remover uma
    delas de outro workspace deixa de quebrar testes por um caminho não óbvio
    (relatório 053).

### Segurança

- **Painel**
  - O tempo de resposta do login foi igualado: sem conta para conferir, o painel
    gasta o mesmo scrypt contra um hash descartável. Medido nesta árvore, e-mail
    sem conta respondia em 1,18 ms e e-mail com conta em 70,33 ms — **59× de
    diferença**, uma única tentativa dizia quais endereços têm cadastro apesar
    da mensagem genérica. Depois, as faixas se sobrepõem e sobram ~3,9 ms
    (**5%**). Vale também para conta desativada e conta só-OIDC (relatório 028).
  - A redefinição de senha feita pelo administrador entra na trilha de
    auditoria: a linha diz quem pediu (e-mail do admin, ou `bootstrap`) e em
    quem, e registra que toda sessão daquela conta caiu; nem a senha temporária
    nem hash nenhum vão para o registro. Trocar a senha por um link de e-mail
    também deixa rastro, com o ator `link-de-redefinicao` — quem chegou pelo
    link não é, necessariamente, o dono da conta (relatório 030; a ação
    `user.password` entrou no `CHECK` de `audit_log.action` pela migration
    `024-auditoria-de-troca-de-senha.sql`, nesta mesma rodada: a linha grava de
    verdade. Esta entrada ainda dizia que ela só chegaria ao banco depois de um
    pedido ao dba e mandava ver "Pendente", onde o item não está — o pedido foi
    atendido na própria rodada; texto corrigido pelo relatório 079 da auditoria
    de 2026-09-19).
  - A criação do primeiro administrador confere a tabela de contas dentro da
    própria gravação: a janela em que dois `POST /api/setup` simultâneos criavam
    dois administradores — e com isso desligavam a adoção de órfãos, que exige
    uma única conta admin ativa — deixa de conter o scrypt da senha (relatório
    049).
  - Arquivo de skill servido **pelo site** vai com `Cache-Control: private`,
    para nenhum cache compartilhado continuar entregando o que acabou de ser
    despublicado (relatório 045). *Esta entrada estava no grupo "Painel" e
    descrevia o site; o "Abrir cru" do painel só ganhou o cabeçalho na auditoria
    de 2026-09-19 (relatório 014), e está registrado lá.*
  - A política de cabeçalhos (`Content-Security-Policy`, `X-Frame-Options`,
    `Referrer-Policy`, `Cross-Origin-Opener-Policy`) é montada uma vez só no
    pacote compartilhado, e o hash do `<script>` de tema sai do próprio
    `index.html` servido — não há hash fixo para desatualizar. O site aceita
    `SITE_CORS_ORIGIN` (`*` segue o padrão) para uma instalação interna fechar a
    API (relatório 045).

- **Site e MCP público**
  - Entrada de `.zip` que declara tamanho descomprimido zero é recusada quando
    os bytes comprimidos podem inflar além do que resta do limite: medido, um
    pacote forjado de 255 KB declarando zero custava **+515 MB de RSS** com o
    teto configurado em 1 KB, e depois da correção o mesmo ataque custa
    **0,4 MB** (o zero é o valor que desliga o limite do zlib). O teto passa a
    valer antes
    de a entrada ir para a memória, sem recusar arquivo vazio gravado como
    DEFLATE — o que o `zipfile` do Python faz. A conta usa a expansão máxima do
    DEFLATE, 1032×; medido, 256 MB de zeros comprimem a 261 KB (relatório 004).
  - A consulta da busca é cortada em 200 caracteres **antes** das duas pernas:
    o provedor de embeddings passa a receber o mesmo texto que a busca textual,
    e não mais a consulta inteira escolhida pelo cliente. O corte cai na última
    palavra inteira, conta caractere (não byte) e nunca deixa sozinha a metade
    de um par surrogate; `search_skills` anuncia o corte na descrição do
    argumento e ecoa a consulta que realmente buscou, em vez de recusar a
    chamada longa (relatório 022).
  - Falha inesperada não vaza detalhe ao cliente anônimo do MCP público: as
    cinco ferramentas e os métodos de prompt e resource respondem
    `Erro interno do servidor (ref xxxxxxxx)` e o erro cru fica no log, com a
    mesma referência nos dois lados. Erro de negócio continua chegando inteiro
    (desdobramento do relatório 031 / auditoria 01).
  - O IPv6 é contado por /64 no limitador: trocar de endereço dentro do mesmo
    prefixo não rende cota nova. E há teto de identidades stateless
    contabilizadas (`MCP_MAX_STATELESS_SESSIONS`) — atingido o teto, a
    requisição é atendida sem virar linha na tabela de sessões, que nunca é
    podada (relatório 014).

- **MCP administrativo**
  - Falha inesperada nas ferramentas responde ao agente
    `Erro interno do servidor (ref xxxxxxxx)`, com o erro cru no log do
    servidor; erros de negócio (400, 403, 404, 409) continuam chegando com a
    mensagem inteira, que é o que deixa quem opera corrigir a chamada
    (relatório 031).
  - Toda resposta leva `X-Content-Type-Options: nosniff`, alinhando o MCP
    administrativo ao público (auditoria 01).

- **RAG e indexador**
  - A busca semântica deixa de mandar ao provedor a imagem que por acaso é
    texto: o `.svg` é pulado como "não é texto de skill", pelo mesmo critério de
    mime que decide gravar o arquivo como texto, e o log do indexador diz que
    ele não saiu (relatório 017).

- **Build e instalação**
  - A varredura de segredos cobre o segredo do SSO, as chaves do provedor de
    embeddings e as URLs com credencial embutida (`smtp`/`smtps` além de
    `postgres`); a dispensa de placeholder casa o valor inteiro, e não só o
    começo, então uma senha como `Exemplo2024!` deixa de ser silenciada. A
    guarda do CI reprova qualquer arquivo versionado cujo nome comece por
    `.env`, inclusive as formas com hífen, e o `.gitignore` passou a ignorar
    `.env-*` em vez de listar cada arquivo um a um (relatório 040).
  - O CI declara `permissions: contents: read` — o `GITHUB_TOKEN` da esteira não
    pode mais escrever no repositório, e isso vale também em fork ou
    organização cujo padrão seja escrita — e confere o gitleaks antes de
    instalar: pacote e arquivo de checksums do mesmo release são baixados no
    diretório temporário do runner, conferidos com `sha256sum -c`, e só então o
    binário entra no `PATH` (relatório 041).
  - `.claude` saiu do contexto de build (cerca de 1 GB numa máquina com
    worktrees), e qualquer arquivo começando por `.env` é ignorado em qualquer
    nível: os Dockerfiles copiam diretórios inteiros de `apps/`, então um `.env`
    dentro de um app entrava na imagem publicada (relatório 053).

### Desempenho

- **Banco e busca**
  - Busca híbrida: a página e o `total` saem de **uma** consulta. A perna
    vetorial, que é varredura exata sem índice, rodava duas vezes por busca —
    no banco de teste com 12 mil vetores de 3072 dimensões, a mediana caiu de
    **1093 ms para 128 ms** (com `jit` desligado, de 152 ms para 63 ms). A ordem
    e o recall não mudaram: a expressão de fusão é a mesma byte a byte, e o
    total passou a ser lido no mesmo snapshot da página (relatório 034).
  - Busca por substring: entraram os índices de trigrama que faltavam.
    `ILIKE '%termo%'` não usa B-tree, e num `OR` o planejador só usa índice se
    **todos** os ramos tiverem um — havia índice só para o nome da skill, e
    nenhum para Auditoria e Acessos, as duas tabelas que nunca são podadas.
    Medido com 52 mil skills e 200 mil linhas de histórico: busca de skills
    **104 → 14,7 ms**, auditoria 101,9 → 16,6 ms, acessos 278 → 45,7 ms, e o
    pior caso (padrão de 60 curingas) **1230 → 2,5 ms** nos acessos, 811,6 → 2,2
    ms na auditoria e 478,5 → 3,7 ms nas skills. O escape e os índices são
    **uma** mudança: escapar sem indexar piora o pior caso (relatório 036).
  - O download de skill é gerado em fluxo de verdade: o site e o MCP público
    leem um arquivo por vez e só seguem quando o compactador consome a entrada
    anterior, em vez de carregar a skill inteira antes do primeiro byte. Medido
    com servidor HTTP real: **338 → 144 MB** de pico acima do baseline numa
    skill de 256 MB, e **788 → 113 MB** numa de 768 MB — o pico do caminho
    antigo acompanhava o tamanho da skill, o do fluxo não. O pacote passou a ser
    compactado no nível padrão do zlib: no conteúdo típico de uma skill, o nível
    máximo devolve 0,34% de tamanho e cobra 38% mais CPU (relatório 044).

### Documentação

- **Arquitetura e decisões**
  - A busca semântica foi reconhecida na arquitetura: decisão nova (duas pernas
    fundidas por RRF, espaço de embedding, ambiente semeia e banco decide, três
    drivers, ~~indexador em perfil próprio~~), e as decisões "sem busca vetorial
    no v1" ficaram marcadas como revogadas, sem apagar. O documento não sabia que
    o sétimo container existe, em quatro lugares. Também ficou escrito o que a
    entrega **não** trouxe: ~~recusa de texto só em memória,~~ sem apagar vetores
    de um espaço, ~~sem limpeza de órfãos,~~ sem índice vetorial e sem recorte de
    escopo da indexação (relatório 019). *Os três trechos riscados saíram
    errados desta rodada:* o indexador sobe no `up -d` (o perfil `rag` está
    comentado no compose — ver "Decidido e não mudado"), e a recusa gravada no
    banco e a coleta de órfãos foram entregues pela `025`, como a seção
    "Corrigido" registra. Os documentos foram alinhados ao código na auditoria
    de 2026-09-19 (relatórios 020 e 059).
  - O inventário de segredos ganhou as três `RAG_*_API_KEY`/`_FILE` — as únicas
    chaves de terceiro com custo por uso — e o registro de que elas nunca vão
    para o painel (relatório 019).
  - Ficou documentado o que sai da instalação pela busca semântica: a perna
    textual indexa só o `SKILL.md`, a semântica indexa todo arquivo de texto da
    skill — inclusive de skill privada — e binário e imagem ficam de fora
    (relatório 017).
  - `OIDC_ALLOWED_DOMAINS` vazia recusa **todo** login por SSO, inclusive de
    conta que já existe e já está vinculada — não apenas o
    auto-provisionamento, como o README e a spec diziam (relatório 018).
  - O README manda trocar os quatro `CHANGE_ME` do `.env.example`, não só dois:
    o `ADMIN_SESSION_SECRET` estava fora da lista e é ele que assina a sessão
    (relatório 001).
  - O `.env.example` e o README passaram a documentar as variáveis que existiam
    só no código: os nomes dos dois servidores MCP (um por serviço, para não
    ficarem com o mesmo nome no `mcp.json`), os tetos de memória dos
    containers, a tag das imagens, o pool do banco e o chaveiro do Inspector
    (relatório 039).
  - O `.env.example` e a tabela de variáveis do README documentam os tetos de
    memória dos containers do banco e o `POSTGRES_BIND_ADDR`, com a conta que
    dimensiona o teto e o motivo de a porta ficar no loopback; o parágrafo do
    `BIND_ADDR` deixou de chamar o Inspector de **única** exceção — o Postgres é
    a outra (relatório DBA-COMPOSE).
  - A estrutura do monorepo está descrita num lugar só — nove workspaces, seis
    imagens de app mais a do banco, e por que a ordem das bibliotecas vive
    apenas no `build:packages` —, e `apps/indexer/` e `packages/rag/` entraram
    na árvore do repositório no README (relatórios 052, 020).

- **Permissões e MCP virtual**
  - A permissão do canvas e dos vínculos de um vMCP está escrita como é: nível
    `edit`, não "dono ou admin", e a seção diz o alcance — num servidor aberto,
    acrescentar uma skill a publica (relatório 016).
  - A descrição de `link_skill` no MCP administrativo diz a regra certa
    (`edit` no servidor e `view` na skill, não "dono ou admin") e o alcance da
    ação (relatório 042).
  - As regras de permissão que a documentação ainda descrevia pelo regime
    anterior ao acesso granular ficaram marcadas como revogadas: publicar em
    vMCP, vincular catálogo↔servidor e o escopo das listas. Também ficou
    registrado que `skills.is_public` voltou com outro sentido (decide quem lê,
    não o que o MCP serve), que o papel `leitor` virou `membro` em todo o
    documento de contas — inclusive no OIDC — e que "Público" na edição da skill
    é pendência do Salvar, não escrita imediata (relatório 042).
  - A confirmação de abertura (`confirm_open`) ficou marcada como revogada nos
    três pontos em que o documento do MCP virtual ainda a prometia, e o
    comentário do código que prometia pedir confirmação ao vincular a primeira
    skill privada a um servidor aberto foi corrigido (relatório 021).

- **Design e instruções de agente**
  - A regra de cópia de CSS está certa nas instruções de agente: `tokens.css`,
    `base.css` e `chrome.css` são cópias byte a byte entre a **homepage e o
    site**, e `markdown.css` entre o **site e o painel** — o painel tem paleta e
    primitivos próprios e nunca é destino dos três primeiros. A sincronia virou
    tabela por par, com comando de conferência e o motivo de não extrair para um
    pacote compartilhado; `SkillDoc.tsx` saiu do `cp` publicado, porque copiá-lo
    quebrava o build do painel (relatório 043).
  - Ficou esclarecido que *override* de compose não é declaração de serviço:
    despublicar a porta do banco atrás do proxy é permitido (relatório 052).

### Decidido e não mudado

Estas entradas existem para ninguém reabrir o assunto como achado novo.

- **`confirm_open` foi removido de propósito e não volta** (relatório 021). Ele
  existiu entre dois PRs e saiu no segundo, com todas as letras. Ressuscitar o
  `400 confirm_open_required` contraria três coisas vigentes — "abrir um vMCP é
  uma caixa como outra qualquer", "aviso inline, **sem** confirmação" e o risco
  que a spec assume por escrito ("o aviso informa, não impede") — e quebraria
  clientes que hoje passam. O regime é avisar e deixar gravar; se o mantenedor
  quiser a barreira de API de volta, é reabrir decisão de produto em três
  documentos.
- **A permissão do canvas é `edit`, não `manage`** (relatório 016). O código já
  estava certo; era o documento do console que descrevia o regime anterior.
  Exigir `manage` trancaria o caso que a própria spec de acesso granular
  desenhou (o vMCP aberto e órfão que se torna compartilhável quando o admin
  concede `edit` a quem deve publicar nele), divergiria do MCP administrativo e
  contrariaria a decisão do aviso sem confirmação. Dono e admin nunca ficam
  trancados. A regra virou teste.
- **As actions do CI não foram fixadas por SHA, e não há `dependabot`**
  (relatórios 041 e 053). Fixar cinco actions por SHA sem automação troca "tag
  móvel" por bytes que envelhecem em CVE — e com automação viraria PR semanal
  aprovado sem leitura, que é pior porque parece revisão. Hoje o workflow roda
  com `contents: read`, sem segredo nenhum, e a publicação de imagem é manual e
  local: o CI não participa da cadeia de suprimento do artefato distribuído.
  Ordem certa, se a política mudar: criar `.github/dependabot.yml` (ecossistema
  `github-actions`) e **depois** fixar os SHAs. Gatilho para reabrir: o dia em
  que esse workflow ganhar segredo (push de registry, `id-token` para
  proveniência).
- **As bases `node:24-alpine` ficam por tag** (relatório 053). O ponto fixo de
  rollback é a tag `:VERSÃO` publicada no Hub, não o digest, porque ninguém aqui
  re-deriva imagem a partir do commit. Major do Node é decisão manual, junto com
  `engines`; regressão de base aparece como build vermelho no CI, que constrói
  as sete imagens em todo PR. O que entra nas imagens — os pacotes npm — já está
  fixado por versão e integridade no `package-lock.json`. O Inspector é a
  exceção fixada, por ser imagem de terceiro, sem autenticação e com rota até o
  MCP administrativo.
- **`#profiles: [rag]` comentado no `docker-compose.yml` é decisão do
  mantenedor** (relatório 047). Restaurar a linha derrubaria o indexador da
  stack dele sem que tenha pedido. **A linha comentada é o estado versionado
  desde a `beta.22`:** o indexador **sobe no `up -d`** em toda instalação, e o
  que liga o envio de conteúdo a terceiros é só o `rag.driver` do painel, com a
  chave no ambiente — com o driver `off`, que é o padrão, o indexador publica o
  próprio estado e não fala com provedor nenhum. Quem quer de volta o opt-in de
  dois passos descomenta a linha e sobe com `docker compose --profile rag up -d
  indexer`. ~~A divergência existe só na cópia de trabalho: o estado versionado
  é coerente no compose, no comentário e no README. […] documentar a linha
  comentada transformaria uma conveniência local em política do projeto e
  apagaria o opt-in explícito do envio de conteúdo a terceiros. *Atenção de
  quem fechar o commit:* […] se ela for commitada, toda instalação passa a
  subir o indexador sem ter pedido.~~ Era o texto desta entrada até a auditoria
  de 2026-09-19 (relatório 020): a premissa deixou de valer no mesmo commit que
  a publicou — a linha **foi** commitada com a `beta.22` —, e o compose dizia
  uma coisa enquanto o README e os `docs/02`, `03` e `14` diziam outra. Os
  textos foram alinhados ao compose, com a decisão antiga ("perfil `rag`, subir
  é uma escolha") marcada como revogada em `docs/02` §10.
- **A poda de `mcp_sessions` e `skill_accesses` ficou para o mantenedor**
  (relatório 014). Apagar linha revisita a decisão "nunca apagar" escrita nas
  duas migrations, então é decisão de produto antes de ser técnica. Com o limite
  por IP e o teto de identidades stateless, o crescimento passou de ilimitado a
  proporcional ao tráfego aceito.
- **A derivação do segredo de sessão a partir de `ADMIN_PASSWORD` foi mantida**
  (relatório 001). Removê-la derrubaria quem sobe só com `ADMIN_PASSWORD`, e um
  salt por instalação teria de vir do banco, que a configuração do painel não
  acessa por regra. O que o salt público permitia era pré-computar uma tabela
  reutilizável entre instalações; com o placeholder recusado, não há mais
  entrada conhecida para pré-computar. Aposentar a derivação segue sendo decisão
  do mantenedor. Pelo mesmo motivo a guarda de placeholder fica **fora** da
  leitura genérica de segredos: as chaves do RAG também saem do `.env.example`
  com `CHANGE_ME` e derrubariam o boot do site, do MCP público e do indexador
  por uma variável que ninguém usa.
- **Nenhum binário nem anexo saía da instalação pela busca semântica**
  (relatório 017). O leitor de skill do RAG só devolve arquivo com conteúdo
  textual, e o `.png`/`.pdf`/`.zip` vive noutra coluna. O achado real era de
  documentação; o único arquivo que o código mandava e não devia era a imagem
  que por acaso é texto (o `.svg`), e isso foi corrigido.
- **`get_default_virtual_mcp` continua dizendo qual vMCP responde em `/mcp`**
  (relatório 050). A informação é a mesma que o `GET /` do MCP público dá ao
  anônimo, e é decisão registrada em spec. Mudar exige decidir contra o
  documento e contra o teste que fixa a regra.
- **A reescrita da escolha de slug por faixa (`>=`/`<`) foi recusada**
  (relatório 049). Na coleção do cluster, a faixa devolveu 0 linhas onde o
  `LIKE` de prefixo devolveu 2, porque a comparação ignora o hífen no nível
  primário — a busca passaria a reoferecer slug ocupado, e o efeito seria 409
  espúrio ou violação de unicidade crua. Nas skills o `LIKE` de prefixo já usa o
  índice de trigramas; nas outras duas tabelas a escala é de dezenas de linhas
  numa instalação real, então a decisão razoável é não fazer nada.
- **`TRUST_PROXY=1` como padrão foi recusado** (relatório 026). Contagem de
  saltos confia no peer seja quem for; o padrão novo cobra que o peer esteja em
  loopback ou faixa privada. O que nenhum padrão resolve, e está registrado:
  quem alcança a porta do serviço direto, já de dentro de uma faixa privada,
  segue declarando o IP que quiser.
- **O link de redefinição substituído não ganha mensagem própria** (relatório
  027). "Inválido, expirado ou já usado" é deliberado: uma mensagem específica
  contaria a quem porta o link antigo — possivelmente um atacante — que a vítima
  pediu outro, e a frase atual já manda usar o e-mail mais recente.
- **Os testes de integração do banco continuam importando por caminho
  relativo** (relatório 052). Eles moram dentro do próprio pacote, e importar
  pelo pacote passaria a depender do `dist/` compilado para rodar o próprio
  teste.
- **`SkillDoc.tsx` e `FileTree.tsx` ficaram fora da guarda de cópia byte a
  byte** (desdobramento do relatório 043). Divergem de propósito, na linha dos
  ícones; um teste "estes dois têm de continuar diferentes" não previne estrago
  nenhum (copiar `SkillDoc.tsx` quebra o build, que já falha visivelmente) e
  amarraria o painel à biblioteca de ícones que o próprio relatório 043 quer
  reavaliar.
- **A terceira frente do relatório 036 (poda e cursor da busca por substring)
  ficou de fora**, assim como o teto do conjunto fundido na busca híbrida: quem
  mexer nele precisa manter a consulta única, contando só o predicado textual e
  somando os vizinhos, sem reexecutar a fusão (relatórios 036 e 034).
- **Nenhuma variável nova para afrouxar o `email_verified` do SSO** (relatório
  013). A política por caminho já não tranca instalação legítima: identidade
  vinculada entra, conta nova é criada como `membro`, e só o `false` explícito
  recusa também a criação. Se o mantenedor quiser a válvula, o ponto de
  aplicação é uma linha.

### Pendente

O que esta rodada **não** fez. Nada aqui é especulação: cada item vem de um
relato, e o que foi fechado depois saiu desta lista.

- **Colisão de migrations entre cópias de trabalho — resolva antes de commitar.**
  Há **três** migrations numeradas `022`, cada uma numa cópia diferente, todas
  ainda sem commit e todas partindo do mesmo commit (`32cffdf`, beta.21): esta
  cópia tem `022-busca-por-substring.sql` (os índices de trigrama do relatório
  036), o worktree `competent-goodall-e78104` tem
  `022-arquivos-de-texto-antigos.sql` (a conversão do leitor de arquivos) e o
  worktree `vigorous-murdock-fc8953` tem `022-descricao-do-vmcp-public.sql`. Esta
  rodada ainda empilhou `023`, `024` e `025` sobre a sua. Quem commitar depois
  precisa renumerar — e, como **o nome do arquivo é a identidade da migration na
  tabela `schema_migrations`**, renumerar uma que já foi aplicada em algum banco
  exige entrada em `RENAMED`, em `database/src/migrate.ts`. Decidir a ordem é do
  mantenedor; o risco de não decidir é duas migrations diferentes com o mesmo
  número no histórico.
- **Pedidos ao agente dba que continuam abertos**, nenhum bloqueante: o recorte
  de `stats()` por `viewer` (relatório 023) — enquanto não existir, os números
  que a conta não pode ver ficam **omitidos** em vez de recortados, que é o
  comportamento seguro; a contagem de skills privadas no resumo do MCP virtual
  (021 e o desdobramento do painel), sem a qual o aviso de exposição é
  qualitativo e não numérico; o campo derivado para a regra "está no site" (050),
  que apagaria três cópias da mesma regra espalhadas pelos apps e ficou de fora
  por depender de uma linha no pacote compartilhado; e `lookupUsers` deixar de
  selecionar `uuid`, no mesmo commit em que o campo sai do tipo compartilhado
  (025) — a condição escrita no tipo já foi cumprida, o painel usa o e-mail.
- **Uma consulta a rodar no banco do mantenedor** (relatório 046): se existir
  slug gravado com mais de 96 caracteres, ele falha na edição. O SQL está no
  relato; o agente não abriu o banco de produção e não renomeia dado sem pedido.
- **Decisões que dependem do mantenedor**, todas com o motivo escrito acima:
  criar o `dependabot` e então fixar as actions por SHA, e o `needs: test` no
  job de imagem (041); ~~o perfil `rag` comentado (047)~~ (decidido: o indexador
  sobe no `up -d` — ver "Decidido e não mudado"); a retenção de sessões e
  acessos (014); subir o teto de 200 caracteres da busca, que é o único lugar
  onde o número deve mudar (022); aposentar a derivação do segredo por
  `ADMIN_PASSWORD` (001); devolver a barreira de API da abertura de vMCP, e se
  publicar skill alheia num servidor aberto segue sendo ação de `edit`, avisada
  e não impedida (021, 016); aceitar o resíduo de 5% no tempo do login ou pôr
  piso de tempo fixo na resposta de falha — e o fato de o scrypt bloquear o
  laço de eventos por ~70 ms em toda tentativa, inclusive as de e-mail
  desconhecido (028); a válvula para IdP sem `email_verified` (013);
  auto-hospedar as fontes de terceiro e tornar `frame-ancestors` uma opção
  (045); dar garantia de memória por serviço com `mem_reservation`, já que a soma
  dos tetos passa da RAM da VM — teto é limite, não reserva, e o alvo é conter
  **um** serviço em espiral (DBA-COMPOSE); e, para quem usa o compose de builder
  local, que não é do repositório e duplica o serviço do banco em vez de incluir
  o do `database/`: ele mantém o padrão antigo, então com `BIND_ADDR=0.0.0.0` a
  porta do Postgres continua publicada lá (DBA-COMPOSE).
- **Republicar as imagens.** O `release-images.sh` passou a construir para
  `linux/amd64` e `linux/arm64`, mas **as imagens que estão no Docker Hub
  continuam só `arm64` até alguém publicar de novo** — quem subir a stack num
  servidor amd64 hoje ainda recebe o que não roda (relatório 015).
- **A CI não roda os testes de integração.** Ela não tem serviço `postgres` nem
  `TEST_DATABASE_URL`, e é por isso que 167 testes — as 14 suítes que tocam o
  banco — nunca rodaram lá. Nesta rodada eles foram executados à mão, verdes; sem
  mexer na CI, seguem fora de todo `push` (campanha de teste A).
- **Achado fora do escopo desta rodada, sem relatório próprio:** cerca de 87% do
  tempo de uma busca com termo é compilação `jit` — 596 ms de 668 ms na busca
  híbrida e 445 ms de ~450 ms na textual, no banco de teste; medido de novo numa
  massa 20× menor deu 67,7 ms contra 7,1 ms com `jit=off`. A causa é o custo
  *estimado* das subconsultas de visibilidade, que o planejador acha caríssimas
  e nunca executa; ele também explica a regressão medida em termo de uma ou duas
  letras. Consertar a estimativa conserta os dois, e isso merece relatório
  próprio (relatórios 035 e 036, campanha de teste D).
