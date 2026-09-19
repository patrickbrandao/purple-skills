# Changelog

Registro das mudanças relevantes do Purple Skills. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[versionamento semântico](https://semver.org/lang/pt-BR/).

Este arquivo existe para evitar retrabalho: quando uma correção foi discutida,
aplicada ou **deliberadamente recusada**, ela fica registrada aqui com o motivo.
Os relatórios que originaram cada entrada são **locais e não versionados** (o
diretório `tasks/` está no `.gitignore`), então nada aqui depende deles: quando
uma entrada precisa citar a origem, ela diz "relatório NNN da auditoria de
2026-09-18" e o motivo fica escrito aqui mesmo, que é a única cópia que viaja
com o repositório.

## [Não publicado]

Auditoria de 2026-09-18: 53 relatórios de problema foram reverificados no código
— não na descrição do relatório —, corrigidos quando procediam e anotados um a
um, mais alguns desdobramentos encontrados no caminho. O que **não** foi mudado
está em "Decidido e não mudado", com o motivo; o que ficou para depois está em
"Pendente".

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

- **MCP administrativo**
  - `set_files_bulk` **recusa** a chamada que removeria arquivos: responde com a
    lista do que sairia e exige `confirm_deletions` com o número exato de
    arquivos a remover. Se o número não corresponder ao que sairia naquele
    instante, nada é removido. *Faça, quem automatiza:* repetir com
    `confirm_deletions`, ou usar `replace: false` para envio parcial — um `.zip`
    que não remove nada continua passando de primeira (relatório 011).
  - `get_skill_file` não devolve mais inline arquivo de texto acima de
    `MCP_MAX_FILE_TEXT_BYTES` (4 MiB): responde com a URL de download, que serve
    o arquivo sem as cópias que o JSON-RPC exigiria (relatório 044).
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
    `"./SKILL.md"` escapava da limpeza e gravava metadados forjados na linha do
    `SKILL.md` — e mexer em metadados é `manage`, não `edit` (relatório 050).
  - O registro de acessos e o `audit_log` gravam o IP e o agente **da
    requisição** que fez a leitura, em vez de repetirem os da primeira chamada
    da sessão (relatório 006).

- **Banco**
  - Salvar uma skill grava **só** o que a chamada informou: dois salvamentos
    simultâneos não se desfazem mais, e o `is_public` de quem acabou de tornar a
    skill privada não volta a `true` por um salvamento de texto. Renomeação
    concorrente sobrevive (a skill volta pelo slug gravado) e skill apagada no
    meio da escrita é 404 em vez de erro interno (relatório 005).
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
    link não é, necessariamente, o dono da conta (relatório 030; a linha só
    chega ao banco depois do pedido ao dba, ver "Pendente").
  - A criação do primeiro administrador confere a tabela de contas dentro da
    própria gravação: a janela em que dois `POST /api/setup` simultâneos criavam
    dois administradores — e com isso desligavam a adoção de órfãos, que exige
    uma única conta admin ativa — deixa de conter o scrypt da senha (relatório
    049).
  - Arquivo de skill é servido com `Cache-Control: private`, para nenhum cache
    compartilhado continuar entregando o que acabou de ser despublicado
    (relatório 045).
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
    drivers, indexador em perfil próprio), e as decisões "sem busca vetorial no
    v1" ficaram marcadas como revogadas, sem apagar. O documento não sabia que o
    sétimo container existe, em quatro lugares. Também ficou escrito o que a
    entrega **não** trouxe: recusa de texto só em memória, sem apagar vetores de
    um espaço, sem limpeza de órfãos, sem índice vetorial e sem recorte de
    escopo da indexação (relatório 019).
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
  mantenedor** (relatório 047). A divergência existe só na cópia de trabalho: o
  estado versionado é coerente no compose, no comentário e no README. Restaurar
  a linha derrubaria o indexador da stack local dele sem que tenha pedido;
  documentar a linha comentada transformaria uma conveniência local em política
  do projeto e apagaria o **opt-in explícito** do envio de conteúdo a terceiros.
  *Atenção de quem fechar o commit:* três agentes editaram esse arquivo, e um
  `git add` leva a linha comentada junto — se ela for commitada, toda instalação
  passa a subir o indexador sem ter pedido.
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
  job de imagem (041); o perfil `rag` comentado (047); a retenção de sessões e
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
