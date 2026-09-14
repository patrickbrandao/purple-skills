# Notas de implementação

Complementa `02-architecture-decisions.md` registrando **as decisões tomadas
durante a implementação** — pontos em que a especificação era omissa e uma
escolha teve de ser feita, mais os desvios conscientes.

## Versões fixadas

| Item | Versão | Motivo |
|------|--------|--------|
| Node.js (imagens) | `node:24-alpine` | LTS ativa no momento da implementação |
| Postgres | `pgvector/pgvector:pg18-trixie` | definido na ideia original; `uuidv7()` nativo |
| Express | 5.x | rotas com wildcard nomeado (`/files/*path`) |
| React / Vite / Tailwind | 19 / 8 / 4 | Tailwind 4 via `@tailwindcss/vite`, sem `tailwind.config.js` |
| MCP SDK | `@modelcontextprotocol/sdk` 1.x | `McpServer` + os três transportes |

## Migrations

A spec pede "migrations em SQL" com um passo dedicado. Em vez de `drizzle-kit`,
o projeto usa um **runner próprio** (`database/src/migrate.ts`): lê
`database/schema/*.sql` em ordem, aplica cada uma em transação e registra em
`schema_migrations`. Motivo: zero dependência extra em runtime, arquivos SQL
legíveis e revisáveis, e o mesmo binário serve para o passo `migrate` do
compose. O Drizzle continua sendo usado como schema + query builder.

## `database/` como fronteira

A camada de dados saiu de `packages/db` para `database/`, na raiz, e passou a
concentrar também os containers (`postgres`, `migrate`, `seed`) e um Dockerfile
próprio. Três consequências práticas:

- **Compose por `include`.** `database/docker-compose.yml` é a única definição
  dos serviços de banco; a raiz o consome com
  `include: [{ path: database/docker-compose.yml, project_directory: . }]`. O
  `project_directory` explícito faz os caminhos relativos e o `.env` resolverem
  a partir da raiz, e não de `database/` — sem ele o `${POSTGRES_PASSWORD}`
  chegaria vazio.
- **Imagem separada para o schema.** `migrate` e `seed` deixaram de reaproveitar
  a imagem do site e passaram a usar `database/Dockerfile`, a única que carrega
  os `.sql`. As imagens dos apps recebem só o `dist/` do cliente — nenhum app
  chama `runMigrations`.
- **Arquivos renomeados.** `nnnn_nome.sql` virou `nnn-nome.sql`. Como o runner
  identifica cada migration pelo nome do arquivo, um banco já migrado veria os
  arquivos renomeados como novos; a tabela `RENAMED` em `migrate.ts` atualiza o
  histórico uma vez, antes de decidir o que aplicar.

## Busca full-text

- Configuração **`simple`** (sem stemming) em vez de `portuguese`/`english`: o
  conteúdo do catálogo é misto (pt + en + trechos de código) e um stemmer
  específico degradaria metade dos casos.
- Pesos: `name` = A, `description` = B, `SKILL.md` = C.
- Consulta com `websearch_to_tsquery` (aceita `"frase exata"`, `-excluir`,
  `or`), com **fallback `ILIKE`** em nome/descrição/slug para termos parciais —
  a extensão `pg_trgm` e um índice GIN trigram tornam isso barato.
- O trigger de reindexação **pula** updates que não alteram `name`,
  `description` nem `search_vector` — o caso dos contadores —, evitando
  recalcular o `tsvector` a cada acesso. Mudanças no `SKILL.md` reindexam
  explicitamente pelo trigger de `files` (migration `0002`). O atalho original
  se baseava em `updated_at`, mas `now()` é constante dentro da transação, o
  que fazia a criação da skill indexar sem o corpo do SKILL.md.

## Contadores

Implementados exatamente como a seção 6 pede — incremento atômico, sem dedup.
A regra "só o SKILL.md conta" foi aplicada de forma literal:

| Superfície | Conta? |
|------------|--------|
| `GET /api/skills/:slug` (página/detalhe) | `view_count` +1 |
| `GET /skills/:slug/files/SKILL.md` | `view_count` +1 |
| `GET /skills/:slug/files/<outro>` | não conta |
| `GET /skills/:slug/download` e `…/download.skill` | `download_count` +1 |
| admin `GET /api/skills/:slug/download` e `…/download.skill` | não conta (operador baixando a própria skill) |
| MCP `get_skill` | `view_count` +1 |
| MCP `resources/read` de `skill://<slug>` | `view_count` +1 |
| MCP `prompts/get` | `view_count` +1 |
| MCP `get_skill_file` | não conta |
| MCP `download_skill` | não conta (só devolve a URL; quem seguir o link conta) |

## Ferramentas MCP além do contrato da spec

A seção 8 lista o contrato mínimo. Foram adicionadas, por serem lacunas
práticas evidentes:

- **público**: `get_skill_file(slug, path)` — sem ela, `get_skill` anuncia os
  arquivos anexados mas o agente não tem como lê-los; e `list_tags()`, que
  torna o filtro por tag descobrível.
- **admin**: `get_skill`, `get_file`, `list_tags` e `get_stats` — leitura,
  necessária para o agente editar com contexto.

`delete_skill` ganhou um parâmetro **`confirm: true` obrigatório**: é a única
operação irreversível do conjunto e um agente não deveria conseguir disparar
por engano.

## Onde publicar, no import de `.zip`

Nada de publicação vem do frontmatter: `skillMetaFromMarkdown` lê nome,
descrição, slug e tags, e ignora qualquer `is_public` ou `use_as_*` que um
`.zip` de terceiro traga — desde o `012` essas colunas não existem, e onde a
skill aparece é o vínculo com um MCP virtual, escolhido por quem importa. O
formulário manda a lista `mcps` como JSON num campo do multipart, e a rota a
resolve por `loadManaged` antes de criar qualquer coisa: um vMCP que a sessão
não administra é 403, e a skill não é criada. É o que impede um `.zip` de se
publicar sozinho, e o que faz o import e o formulário terem exatamente a mesma
regra.

## Semântica de `set_files_bulk`

Segue a seção 4 à risca: **por padrão o zip é o estado desejado completo** e
caminhos omitidos são removidos. O `SKILL.md` é sempre preservado (a seção 3.2
exige que ele exista). `replace: false` desliga a remoção, para o caso de só
querer adicionar arquivos.

No painel web o upload de `.zip` faz o oposto — **adiciona/sobrescreve por
padrão**, com um checkbox explícito para substituir a árvore inteira. É uma
superfície diferente (um humano clicando, sem descrição de ferramenta para
ler antes), e o comportamento destrutivo fica visível na tela.

## Caminho de arquivo é único sem diferenciar caixa

A escrita comparava `relative_path` byte a byte e a leitura comparava por
`lower(...)`. `skill.md` gravado numa skill que já tinha `SKILL.md` inseria uma
segunda linha "principal", e a partir dali o conteúdo exibido, indexado e
empacotado saía de um `LIMIT 1` sem ordem. Duas travas, nas duas pontas:

- `normalizeRelativePath` canoniza qualquer variante de caixa do arquivo
  principal para `SKILL.md`, então as escritas caem sempre na mesma linha.
- A migration `0003` troca a constraint `UNIQUE (skill_uuid, relative_path)` por
  um índice funcional `UNIQUE (skill_uuid, lower(relative_path))`, e
  `upsertFileTx` infere o conflito por ele. Vale para qualquer arquivo, não só o
  `SKILL.md`: `Notas.md` sobrescreve `notas.md` em vez de duplicar.

A migration consolida o que já tinha duplicado mantendo a linha mais recente —
o mesmo resultado que o `ON CONFLICT` novo produziria. `deleteFile` passou a
apagar pelo caminho exato da linha lida; com o filtro `lower(...)` anterior,
remover `a.md` levava junto um eventual `A.md`.

## Sessão do painel

- Cookie assinado com HMAC-SHA256, `httpOnly`, `SameSite=Lax`, TTL de 12h
  (configurável por `ADMIN_SESSION_TTL`). Sem session store, como pedido.
- O payload passou a ser `{ sub, role, ver, exp }` com a entrega de contas
  (§7.1 das decisões). `role` e `ver` são **opcionais no tipo**: a sessão da
  senha única não os tem, e o middleware trata a ausência como "sessão legada",
  válida só enquanto `users` estiver vazia. `packages/shared` continua sem
  falar com o banco — ele assina e valida o formato; quem decide se a sessão
  ainda vale é `apps/admin/src/auth.ts`.
- `ADMIN_SESSION_SECRET` é **opcional**: se ausente, é derivado da senha com
  **scrypt** (`N=2^15`), uma vez por processo. O serviço sobe sem configuração
  extra e trocar a senha invalida as sessões antigas — que é o comportamento
  desejado. A KDF lenta é o que impede que um cookie capturado vire um teste
  offline barato da senha do painel; mesmo assim, em produção vale definir o
  segredo explicitamente.
- A flag `Secure` **acompanha o protocolo da requisição** (respeitando
  `X-Forwarded-Proto` via `trust proxy`) em vez de `NODE_ENV`. Fixá-la em
  produção quebraria qualquer deploy HTTP interno; `ADMIN_COOKIE_SECURE`
  permite forçar.

## Contas, papéis e credenciais

Decisões que a spec (`05-accounts-and-roles.md`) deixou em aberto:

- **`audit_log.target_label`.** A §3 previa só `actor_user_uuid` e
  `actor_label`. Sem um terceiro campo, um evento de conta não diz *sobre quem*
  foi — `skill_slug` e `file_path` são nulos nessas linhas. A coluna guarda o
  e-mail do alvo, o `email → papel` de uma troca ou o nome da chave.
- **Dois custos de scrypt.** A spec diz "hash de senha e de chave por scrypt".
  Senha de pessoa usa `N=2^15` (~32 MB, ~100 ms); segredo de chave de API usa
  `N=2^12`. O segredo tem 32 bytes aleatórios: não há busca offline a
  encarecer, e o custo alto só somaria latência a cada requisição do MCP. Os
  parâmetros ficam gravados no próprio hash (`scrypt$N$r$p$salt$hash`), então
  aumentá-los depois não invalida o que já está no banco.
- **Prefixo da chave lido por posição, não por `split('_')`.** O alfabeto
  base64url inclui `_`, então o segredo quase sempre tem underscores e a
  divisão ingênua recusaria uma chave legítima. Como o prefixo tem comprimento
  fixo, a posição do separador é determinística.
- **Sessão MCP presa à credencial.** O servidor MCP é criado uma vez por
  sessão, com o papel e o ator daquele momento. Sem amarrar, quem descobrisse
  um `mcp-session-id` alheio herdaria o papel dele — daí o 403 quando a
  identidade da requisição não bate com a que abriu a sessão. Vale para os dois
  transportes com sessão: o Streamable HTTP (`mcp-session-id` no header) e o
  SSE legado (`?sessionId=` na query do `POST /messages`), que por ficar fora do
  header é ainda mais fácil de vazar em log e histórico de proxy.
- **Trilha de auditoria só para admin.** `GET /api/audit` devolve `actor_label`
  e `target_label`, que são e-mails — a mesma classe de dado de `/api/users*`.
  O painel esconde o cartão de auditoria para quem não é admin em vez de
  mostrá-lo vazio.
- **Teto de upload é por requisição, não por arquivo.** `limits.fileSize` do
  multer vale por arquivo; com `upload.array('files', 50)` uma requisição
  bufferizava até 50 × o teto em memória. A recusa vem do `Content-Length`,
  antes do multer, com folga para o envelope multipart; quem envia sem
  `Content-Length` ainda esbarra na soma conferida depois do upload.
- **Reemissão do cookie na troca de senha.** Trocar a senha incrementa
  `token_version`, o que derrubaria a sessão de quem acabou de trocá-la. A rota
  reemite o cookie com a versão nova.
- **Nada de auto-desativação nem último admin.** Um admin não muda o próprio
  papel nem se desativa, e a última conta de administrador ativa não pode ser
  rebaixada ou desligada: o caminho de volta seria editar o banco à mão.
- **A tela de contas some na sessão de bootstrap.** Criar uma conta por ali
  invalidaria a própria sessão na requisição seguinte (a legada só vale com
  `users` vazia). O caminho oferecido é sair e passar pelo `/setup`.
- **Token de redefinição em SHA-256, não scrypt.** São 32 bytes aleatórios e a
  busca é por igualdade exata do hash; não há entropia baixa a compensar.
- **`registerFailedLogin`/`registerSuccessfulLogin` não tocam `updated_at`**
  (decisão do DBA): o campo continua significando "última alteração
  administrativa da conta", não "última tentativa de login".

## Armazenamento de arquivos

- Texto vs. binário é decidido pelo **mime detectado por extensão** mais uma
  checagem de bytes nulos — um `.md` com bytes nulos vai para `bytea`, não
  para `text` (Postgres rejeitaria `\0` em `text`).
- Caminhos passam por `normalizeRelativePath`, que rejeita `..`, caminhos
  absolutos e prefixos de drive do Windows.
- Zips com uma **única pasta raiz** (o padrão de `zip -r skill.zip skill/`) têm
  essa pasta removida; `__MACOSX`, `.DS_Store` e `Thumbs.db` são descartados.

## Homepage separada do site

A apresentação do projeto vive em `apps/homepage`, um app próprio:

- **Sem banco e sem API.** O servidor é um Express que só serve `dist-web/` e
  responde `/healthz` — não importa `@purple-skills/db`, não abre pool e não
  chama rota nenhuma. Nada do que ela mostra depende de haver skills
  cadastradas, o que a torna publicável sozinha (vitrine, CDN, outro domínio).
- **O site perdeu as seções de apresentação.** Ele é a página de quem já usa a
  instalação: cabeçalho curto, catálogo, o `mcp.json` para copiar e os
  endereços de acesso. Quem quer entender o projeto vai para a homepage.
- **Endereços vêm do ambiente, não do `Host`.** `MCP_PUBLIC_URL`,
  `MCP_ADMIN_URL` e `ADMIN_URL` são devolvidos por `/api/meta`; cada um que
  ficar vazio some da página, em vez de virar um endereço adivinhado que não
  responde.
- **CSS.** `chrome.css` (nav + rodapé) saiu do antigo `landing.css` e virou
  cópia idêntica nos dois apps, junto de `tokens.css` e `base.css`. O que
  sobrou de `landing.css` ficou só na homepage; o site levou o cabeçalho, a
  seção de `mcp.json` e a de endereços para o seu `app.css`. As imagens de
  agentes, IDEs e modelos também ficaram só na homepage.

## Frontend

- **Dark mode fixo** com paleta roxa. Um tema claro dobraria a superfície de
  ajuste visual sem ganho para um v1 — a decisão é revisável.
- O frontmatter YAML do `SKILL.md` é **removido antes da renderização**: nome,
  descrição e tags já aparecem no cabeçalho da página.
- `react-markdown` sem `rehype-raw`: HTML cru no `SKILL.md` não é renderizado,
  então conteúdo vindo do painel não injeta script.

## O prompt em duas guias

Na visualização — no site e no painel — o prompt fica numa caixa com duas
guias. **"Skill"** é a leitura: o markdown renderizado, sem o bloco de
metadados, que já aparece no cabeçalho. **"SKILL.md"** é o arquivo inteiro,
frontmatter e corpo, do jeito que o download materializa — para quem quer
copiar e colar num `SKILL.md` próprio. Um botão "Copiar" acompanha a segunda.

O frontmatter é montado **no navegador**, porque o que trafega no JSON é só o
corpo: os metadados moram em colunas do banco. Isso significa duas
implementações do mesmo formato — `packages/shared/src/frontmatter.ts`, que
serve o download, a leitura crua e o MCP, e o espelho
`apps/*/web/src/frontmatter.ts`, que serve a guia. Se as duas divergirem, o
usuário copia uma coisa e baixa outra, então `apps/site/web/src/frontmatter.test.ts`
compara as duas saídas caso a caso, incluindo o que o YAML leria errado sem
aspas, o BOM e o CRLF. O pacote não entra no bundle do navegador (é Node: zip,
streams, `Buffer`), só no teste.

## Leitura antes da edição no painel

Clicar numa skill na lista abre `/skills/:slug`, a **tela de leitura**: o
`SKILL.md` renderizado com a árvore de arquivos ao lado, como o visitante vê no
site. O editor mora em `/skills/:slug/editar` e só se chega nele pelo botão
"Editar" — abrir uma skill deixou de significar estar prestes a mudá-la, e o
caminho de volta é o botão "Visualizar" ou o link do cabeçalho.

A rota do editor **não** tem trava de papel, como antes: quem não pode escrever
já não recebe os botões de salvar e remover, e é assim que a tela se comporta
desde que existe. O que muda é que o botão "Editar" só aparece para quem pode.

A árvore e os ícones por extensão são os mesmos do site — `fileTree.ts` e
`FileTypeIcon.tsx` são cópias idênticas nos dois apps, no mesmo espírito do
`useTheme.ts`. O `FileTree.tsx` é que difere: no painel ele também escolhe o
arquivo a editar e oferece o botão de remover.

## Editor de skill no painel

A tela do `SKILL.md` traz, numa aba só, o formulário de metadados (slug, nome,
descrição, tags, visibilidade) e, abaixo dele, o prompt em markdown com a
pré-visualização renderizada ao lado, em tempo real.

- O rótulo do slug diz o que ele é: **nome oficial da skill** — vai no `name:`
  do frontmatter, na URL e nas ferramentas MCP. O outro campo é o nome de
  exibição do catálogo.
- Entre o formulário e o prompt fica um bloco somente-leitura com as
  **primeiras linhas que serão geradas**, para o operador ver o efeito dos
  campos sem precisar baixar o arquivo.
- O prompt é enviado por `stripFrontmatter` antes de sair do navegador e de
  novo no servidor: as duas pontas garantem o que a §3.5 das decisões exige.
- O `SKILL.md` **aparece** na árvore da aba "Arquivos", porque escondê-lo
  deixava a árvore mentindo sobre o pacote — mas clicar nele leva para a aba do
  formulário, não para o editor cru. Ali a edição não passaria pelo formulário,
  e gravar metadados por lá seria gravar o que a primeira leitura descarta. A
  contagem da aba segue sendo só a dos anexos, e o botão de remover não existe
  para ele.
- `apps/admin/web/src/frontmatter.ts` e `slug.ts` espelham
  `packages/shared`: o pacote é Node (zip, streams, `Buffer`) e não entra no
  bundle do navegador. O servidor continua sendo quem decide.

### Rolagem sincronizada

Rolar um painel move o outro, nos dois sentidos. O que se espelha é a **fração
rolada**, não a posição: fonte e render não têm a mesma altura — um `##`
renderizado ocupa o triplo da linha que o gerou, um bloco de código ocupa o
mesmo. A conta está isolada em `scrollsync.ts`, testada sem DOM.

- Só o painel com que o operador interagiu por último comanda (`leader`).
  Espelhar os dois sentidos ao mesmo tempo faria um puxar o outro em laço: a
  rolagem que o handler provoca no seguidor volta como evento. Digitar também
  reivindica o comando para o markdown, mesmo com o ponteiro parado do lado.
- A sincronia na rolagem é **síncrona**, sem `requestAnimationFrame`: esperar
  um quadro deixaria o seguidor visivelmente atrasado.
- O realinhamento depois de digitar e ao voltar de "Escrever"/"Visualizar"
  roda em `useLayoutEffect` — ler as alturas ali força o cálculo do layout já
  atualizado e o ajuste entra antes do desenho.
- Limite conhecido: a fração acerta começo, meio e fim, e escorrega no meio
  conforme a mistura de títulos, listas e código muda ao longo do documento.
  Medido no painel: num prompt de mistura uniforme o desvio máximo foi 21px
  (~3% da altura do painel); num caso construído para ser desfavorável — 60
  linhas de código seguidas de 20 títulos — chegou a 351px, 0,58 de uma tela.
  Ancorar cada bloco renderizado na linha que o gerou resolveria, ao custo de
  um plugin rehype e de um espelho do textarea para achar a linha visível.

## Conexão com o banco

O compose passa `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`, lidos
nativamente pelo driver, em vez de montar uma `DATABASE_URL`. Motivo: numa URL,
`/`, `?` e `#` na senha encerram a autoridade e quebram o parse, e `%XY` é
percent-decodificado em silêncio — a senha que chega ao Postgres deixa de ser a
configurada. Senha gerada aleatoriamente cai nisso com frequência.
`DATABASE_URL` continua aceita (é o caminho para rodar fora do compose) e é
validada no boot, com uma mensagem que explica o percent-encoding.

## Configuração numérica

Limites vindos do ambiente passam por `readIntEnv` (`packages/shared`), que
trata vazio como ausente e **derruba o boot** quando o valor não é um inteiro na
faixa. `Number('25MB')` é `NaN`, e como toda comparação com `NaN` é falsa, um
sufixo distraído desligaria justamente a proteção que a variável configura — o
teto de descompressão de zip, o teto de sessões MCP, o tamanho máximo de upload.
Para um limite de segurança, falhar alto é melhor que relaxar em silêncio.

O mesmo vale para strings: `readTextEnv` trata vazio como ausente, porque o
compose repassa variáveis não preenchidas como string vazia e `??` só cobre
`undefined`.

## Ordem dos middlewares

O parser JSON é montado **depois** da autenticação, não no topo do app:

- MCP: `express.json` entra por rota, sempre após `options.auth`, com o teto
  declarado por serviço (`jsonLimit`) — 1 MB no público, cujas ferramentas
  trocam poucos bytes, e 48 MB no admin, que recebe o `.zip` em base64.
- Painel: um parser de 4 KB só para `/api/login`, e o de 32 MB depois de
  `requireAuth`.

Ler megabytes antes de saber quem está chamando entrega memória de graça a
qualquer anônimo — no MCP público, que roda aberto por padrão, isso bastava para
derrubar o processo.

Cada app tem um tratador de erros no fim da cadeia. Sem ele, o que os
middlewares lançam (upload acima do limite, JSON malformado) escapa do
`route()`/`guard()` e sai como HTML — numa API JSON, o cliente vê apenas
"Erro 500" para o que é erro dele, com o status errado.

## Slug e concorrência

`resolveSlug` consulta os slugs ocupados e o INSERT vem depois, então duas
criações simultâneas podem escolher o mesmo. A constraint `UNIQUE` do banco
resolve o empate; o código traduz o `23505` resultante: com slug gerado a partir
do nome, escolhe outro e tenta de novo (a intenção é "qualquer slug livre"); com
slug pedido explicitamente, devolve 409.

## MCP virtual

Decisões de implementação que [`08-mcp-virtual.md`](08-mcp-virtual.md) deixou
em aberto:

- **Dois pontos de montagem, um mapa de sessões.** `createHttpApp` do
  mcp-public passou a receber `mounts`; os transportes são registrados num
  `Router({ mergeParams: true })` por mount, para o `:slug` do prefixo chegar
  às rotas de dentro. As sessões (Streamable e SSE) vivem num mapa só, com a
  amarração por identidade portada do mcp-admin — a identidade do virtual
  embute MCP e chave. O `http.ts` do mcp-admin continua com a forma antiga
  (um mount implícito): os dois arquivos são cópias por app, como sempre foram.
- **Base das URLs de download.** `MCP_PUBLIC_URL` no mcp-public; sem ela, a
  origem da requisição (`req.protocol://host`, respeitando `trust proxy`). O
  painel recebe a mesma variável para o snippet de `mcp.json`.
- **`setVirtualMcpSkills` trava o MCP** (`SELECT … FOR UPDATE`) dentro da
  transação: dois salvamentos concorrentes da lista não se sobrescrevem.
- **Sem `.skill` nem página no site para skill fora do site.** O virtual serve
  `download` e `download.skill`; a `url` da página só sai quando a skill está
  em algum vMCP aberto e ligado (`mcps` da própria leitura).
- **Downloads sem cache** (`Cache-Control: no-store`): a resposta depende da
  credencial, e o site continua sendo o único lugar com `max-age`.
- **O painel enxerga todos os vínculos, inclusive com MCP desligado ou
  fechado** — `SkillSummary.mcps` numa leitura `'all'` traz tudo, com o estado
  de cada vMCP: o vínculo existe, e o painel é sobre o vínculo. Numa leitura
  pública a lista só traz os abertos e ligados.

## MCP padrão

Decisões de implementação que
[`09-mcp-padrao-e-skills-flutuantes.md`](09-mcp-padrao-e-skills-flutuantes.md)
deixou em aberto:

- **Um `auth` por mount, uma autenticação.** `rootAuth` e `virtualAuth`
  diferem só em como acham o vMCP (`settings` vs. slug da URL); a conferência
  de `is_open` e da chave `psv_` é a mesma função, `authenticateAgainst`. As
  rotas de download recebem o `auth` do mount por parâmetro
  (`registrarDownloads(auth)`), em vez de importar `virtualAuth` fixo.
- **Prefixo das URLs vem de `req.baseUrl`.** É o prefixo do mount já
  resolvido pelo Express (`''` na raiz, `/virtual/<slug>` no outro), então o
  mesmo vMCP ganha URLs sob o caminho por onde foi chamado, sem um segundo
  parâmetro para dizer "estou na raiz".
- **`GET /` calcula por requisição.** `createHttpApp` ganhou `describe`, uma
  função assíncrona mesclada aos metadados fixos; uma falha nela devolve só
  os fixos, para o endpoint de descoberta nunca depender do banco.
- **A trava de boot olha as três variáveis crua**, não por `readTextEnv`:
  vazia é ausente, qualquer outra coisa derruba, e a mensagem nomeia todas as
  que encontrou.
- **O seed audita como `seed`.** `createVirtualMcp` e `setDefaultVirtualMcp`
  exigem ator; o seed passa `{ userUuid: null, label: 'seed' }`, no mesmo
  espírito de `bootstrap` e `token-global`.
- **`DefaultMcpResolution.inactive` carrega `uuid` e `slug`.** O painel
  precisa pré-selecionar o vMCP desligado no seletor e dizer qual é; `deleted`
  não tem linha para apontar.

## Skills flutuantes

Decisões de implementação do PR2 de
[`09-mcp-padrao-e-skills-flutuantes.md`](09-mcp-padrao-e-skills-flutuantes.md):

- **`mcps` vem na mesma consulta.** `skillColumns` agrega os vínculos em
  `json_agg` por linha, com o filtro de visibilidade da própria leitura:
  `'all'` traz todos, o resto só os abertos e ligados. Uma segunda consulta
  por skill dobraria o custo da listagem do painel, e uma lista sem filtro
  revelaria ao site em que servidor fechado uma skill está.
- **`visibility` padrão é `'open'`.** O restritivo: quem esquece a opção
  mostra de menos. `requireSkill` e todas as escritas passam `'all'`
  explicitamente.
- **`createSkill({ mcps })` resolve os vínculos antes da transação**
  (`resolveLinks`): uuid torto, desconhecido, repetido ou flag ausente é 400
  sem nada gravado. Cada vínculo audita `mcp.update` no vMCP, como
  `setVirtualMcpSkills`, e não uma ação própria — o painel do MCP mostra a
  mesma trilha independente de qual lado vinculou.
- **A permissão fica no app.** `resolveLinks` do banco não sabe quem chama;
  o painel (`mcps.resolveLinks` → `loadManaged`) e o mcp-admin
  (`canManageVirtualMcp`) recusam antes de chamar.
- **`unlinkSkill` de um vínculo inexistente é 404**, e nada é auditado — um
  `DELETE` repetido não cria linha de trilha.
- **O painel "Publicada em" salva por linha**, não a página inteira: cada
  vMCP é um `PUT`/`DELETE` próprio, com a permissão daquele vMCP. O picker da
  skill nova e do import é controlado e vai no corpo da criação.
- **`skills_score_idx`** substitui o índice prefixado por `is_public`: é a
  ordenação padrão de toda listagem, com ou sem vínculo.

## Painel: canvas e sessões

Desenho em [`10-admin-canvas-e-sessoes.md`](10-admin-canvas-e-sessoes.md).
O que ficou diferente do que a skill `admin-canvas-ui` prescreve, e por quê:

- **Sidebar com rótulos, não trilho de 56px.** A referência visual tinha
  rótulos; ela venceu a skill.
- **Recolher a sidebar anima a coluna do grid.** `grid-template-columns` vai
  de 220px a 0, e o conteúdo mora num `.sidebar-inner` de largura fixa: a
  borda corta os rótulos em vez de espremê-los. `visibility: hidden` entra
  só no fim da animação, e é o que tira a navegação recolhida do Tab. O
  menu da conta abre dentro da própria sidebar (que tem `overflow: hidden`),
  por isso ocupa a largura do rodapé em vez dos 210px mínimos dos menus.
- **Stack mínima.** Só `@xyflow/react`, `cmdk` e `lucide-react` entraram.
  react-router e Tailwind v4 continuam; a rampa espelhada foi mapeada por
  `@theme inline`, sem voltar ao v3. A filtragem da paleta é nossa
  (`fuzzyScore`), porque parte dos itens vem do servidor já filtrada.
- **Grade de 24px, nó de skill de 264×66.** O cartão de 288×144 da skill
  serve a recursos com três linhas de status; a skill só precisa de ícone,
  nome, slug e os três handles de porta, a 25/50/75% da altura.
- **Arestas do servidor para a skill**, com handles à direita e à esquerda
  (a skill manda topo/base). O grafo é horizontal: Internet → servidor →
  skills.
- **Nós reaproveitados, nunca recriados.** O efeito que reconcilia o palco
  com o detalhe do servidor roda a cada contagem de online (5 s). Recriar o
  objeto do nó apaga `measured` e `dragging`: o React Flow mede de novo e o
  arraste em curso cai. Por isso quem já existe só recebe `data` nova, e a
  seleção da gaveta mexe só em `selected`.
- **Clique abre a gaveta, arraste não.** `selectNodesOnDrag` ligado (o
  padrão) seleciona o nó no começo do arraste, e a gaveta abria no meio do
  gesto. Com ele desligado, a gaveta abre por `onNodeClick`, e o d3-drag
  descarta o clique que encerra um arraste.
- **Rótulo de aresta com `z-index: 2`.** Cada aresta é um `<svg>` com o
  próprio `z-index` (1 aqui), e os rótulos moram num portal irmão sem
  `z-index`: sem ele a linha passa por cima do contador. Com 2 o rótulo fica
  acima das arestas e abaixo dos nós, que vêm depois no DOM.
- **Hover do handle repete o `translate`.** O React Flow centraliza o handle
  com `transform: translate(...)`; um `scale` sozinho no hover descartava o
  deslocamento e o handle pulava para longe do cursor.
- **Sem `parentId`, sem grupos, sem undo.** Fora do escopo do `10`.
- **O `remove-edge` do rótulo da aresta chega por `CustomEvent`.** O
  componente da aresta é memoizado e não recebe callbacks por props (o
  React Flow os recriaria a cada render); um evento no `window` mantém a
  aresta pura.
- **Recarga do detalhe depois de cada escrita.** `linkSkill` devolve o
  detalhe da skill, não o do servidor; o canvas refaz `GET /api/mcps/:slug`
  depois de cada gesto, o que também traz os contadores por porta.
- **Sessões: o `onclose` do transporte pode disparar depois do `timeout`.**
  O rastreador só conhece uma sessão até o primeiro `closed`; o segundo
  motivo é ignorado, e é por isso que o TTL avisa `timeout` **antes** de
  fechar o transporte, e o desligamento chama `shutdown` antes de fechar os
  transportes.
- **`req.ip` como IP de origem.** O Express já resolve o `X-Forwarded-For`
  pelo `trust proxy` (`TRUST_PROXY`); o rastreador não reimplementa isso.
- **Vite em dev usa `ADMIN_API_PORT`.** O proxy do `/api` aponta para a
  porta do servidor do painel (`3001` por padrão), configurável para rodar um
  segundo painel ao lado do do compose.

## Catálogos

Desenho em [`11-catalogos.md`](11-catalogos.md). O que ficou de
implementação:

- **Um só alvo de aresta no canvas.** Skill e catálogo viram um `Target =
  { kind, slug }`; `pending`, `busy`, a seleção da gaveta, o id da aresta
  (`edge:<kind>:<porta>:<slug>`) e o id do nó (`skill:` / `catalog:`)
  carregam o `kind`, e só `runLink`/`runUnlink` escolhem o `PUT`. O nó de
  catálogo reaproveita a moldura e os três handles do nó de skill
  (`.node-skill.node-catalog`), com o número em destaque à direita.
- **As portas do servidor contam arestas, não vínculos diretos.** No palco
  `counts` soma skills e catálogos por porta; `toolCount` &co. do resumo
  continuam sendo só vínculos diretos, e é isso que o card e o mcp-admin
  mostram — o `catalogCount` fica ao lado.
- **`catalogPositions` no mesmo `PUT /canvas`.** A fila de posições tem dois
  mapas; o `relayout` grava skills e catálogos de uma vez.
- **"Publicada em" mostra o indireto e ainda deixa publicar direto.** Um
  vMCP alcançado só por catálogo aparece com "via catálogo X"; quem
  administra o vMCP vê as caixas com as portas do catálogo e "Publicar" cria
  o vínculo direto, que passa a valer sozinho. "Tirar" só existe para vínculo
  direto — o catálogo se edita na página dele.
- **`noSite` e `McpChips` olham `isActive`.** Uma skill desligada nunca
  está "no site", por mais vínculos que tenha; o selo "desligada" entra na
  frente dos demais.
- **A rota declarativa `PUT /api/mcps/:slug/catalogs` confere quem sai.**
  Além de cada catálogo da lista, os vinculados hoje que ficaram de fora
  passam por `loadManaged`: tirar um catálogo alheio é mexer nele.
- **O mcp-public não mudou.** Toda a precedência mora em `@purple-skills/db`
  (`visibilityClause`, `listPublishedSkills`, `incrementViewCount`); o
  servidor continua chamando as mesmas funções com o mesmo recorte.

## Acesso granular

Desenho em [`12-acesso-granular.md`](12-acesso-granular.md). O que a
implementação decidiu além dele:

- **`viewer` em vez de `visibility`.** As leituras de `@purple-skills/db`
  ganharam `viewer: { role, userUuid }`; `visibility: 'all'` continua
  existindo para o token global e o bootstrap (admin sem conta) e `'open'`
  para o site, agora ampliada pelas duas regras de "público". Cada linha
  devolve `access`, calculado no SQL, e o app só compara níveis
  (`assertAccess`).
- **Escritas devolvem o objeto sem conhecer o leitor.** Uma escrita não
  recebe `viewer`, então o detalhe que ela devolve traz `access: 'owner'`;
  os handlers reaplicam o `access` de quem chamou antes de responder, e
  escondem `grants` de quem não tem `manage` (`withGrants`).
- **404 para quem não vê, 403 para quem vê pouco.** Um objeto fora do
  escopo da conta não existe para ela (a consulta devolve nulo); um objeto
  visível com nível insuficiente responde 403 dizendo o nível que a conta
  tem e o exigido.
- **Upload confere o nível antes do multer** (`requireSkillAccess`), para
  não ler um `.zip` que seria recusado.
- **Sessões de um vMCP são `manage`**, como as chaves: a lista traz IPs e
  nomes de chave. O contador do globo é `view`.
- **Desvincular um catálogo de um vMCP** exige só `edit` no vMCP: tirar da
  lista é mexer no servidor, não no catálogo. Vincular exige também `view`
  no catálogo, como no doc.
- **Deixar um objeto sem dono** (`ownerUserUuid: null`) continua sendo só de
  admin: um dono comum não pode abandonar o objeto num estado em que só o
  admin o alcança. Transferir para outra conta é do dono e do admin.
- **`canWrite` ficou como alias de `canCreate`** em `shared`, marcado
  `@deprecated`, e `canManageVirtualMcp`/`canManageCatalog` como atalhos de
  `accessLevel` + `canOwn`; `canDelete` saiu.
- **O selo de origem** do painel (`AccessBadge`) some para admin: ele é dono
  de tudo e o selo não diria nada.

## Portas

| Serviço | Porta |
|---------|-------|
| site | 3000 |
| admin | 3001 |
| mcp-public | 3002 |
| mcp-admin | 3003 |
| homepage | 3004 |

## O que foi verificado

- Testes unitários (Vitest, `npm test`) em `packages/shared` e nos handlers das
  duas famílias de ferramentas MCP, com o banco mockado.
- Verificação em runtime da ordem autenticação → parser nos servidores MCP:
  POST anônimo com corpo grande é recusado com 401 antes de o corpo ser lido, e
  corpo acima do teto responde 413 em JSON-RPC.
- Smoke test manual contra o stack em Docker: os **três transportes** (
  Streamable HTTP com sessão, stateless e SSE legado) nos **dois** servidores
  MCP, CRUD completo pelo MCP admin, propagação de visibilidade para o site,
  reindexação da busca por trigger, contadores, download `.zip` com binários
  preservados, autenticação do painel e do MCP admin.
- Testes de integração com Postgres real (`TEST_DATABASE_URL`, desligados por
  padrão) cobrindo `users`, `api_keys` e `reset_tokens`.
- Smoke test do frontmatter gerado contra um banco de testes: criar/salvar pelo
  painel e pela API com um bloco `---` colado no prompt (descartado nas duas
  pontas), `PUT` direto em `/files/SKILL.md`, importação de `.zip` no padrão
  Agent Skills (slug vindo do `name:`), troca de slug refletida no arquivo sem
  reescrever o corpo, e `Content-Length` do arquivo servido batendo com o
  documento montado.
- Smoke test do fluxo de contas contra o stack em Docker: bootstrap do primeiro
  admin, senha única ficando inerte depois dele, matriz de papéis nas rotas do
  painel, revogação por `token_version`, trava do login por tentativas, e chave
  `psk_` autenticando no MCP administrativo com o papel do dono.
- Smoke test do MCP virtual contra um Postgres descartável (migration `009`
  aplicada duas vezes; suíte de integração `virtual-mcps`): cliente MCP real
  em `/virtual/<slug>/mcp` com chave `psv_` (serverInfo sufixado, instruções
  com a descrição, `search_skills` só o vínculo com uma privada, `get_skill`
  da privada com download no próprio servidor, `.zip` e `SKILL.md` com e sem
  chave, `prompts/list` e `resources/list` obedecendo `as_prompt`/`as_resource`,
  401/404 conforme a `§4.5` de `08`, virtual aberto sem chave, principal sem a
  privada, SSE anunciando o endpoint com prefixo, contadores no vínculo e no
  global); a API do painel (`/api/mcps*`: papel para criar, alcance por dono,
  `PUT` declarativo, confirmação de abertura nos dois sentidos, transferência
  de dono, chave emitida abrindo o virtual e revogada respondendo 401, selo na
  skill, rename, 409, delete, auditoria `mcp.*`); e as nove tools do
  mcp-admin com o token global.
