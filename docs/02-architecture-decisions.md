# Decisões de Arquitetura

Este documento registra as decisões de design resolvidas a partir da ideia
original (`01-idea.md`), organizadas por tópico. Serve como referência para
a implementação.

## 1. Estrutura do repositório

- **Monorepo** usando **npm workspaces**.
- Layout de pastas:
  - `database` — **toda** a camada de dados: arquivos de schema
    (`database/schema/nnn-nome.sql`), cliente e queries (`@purple-skills/db`),
    e os containers `postgres`, `migrate` e `seed`
  - `apps/homepage` — página de apresentação do projeto, estática (Express
    servindo uma SPA React/Vite + Tailwind, **sem banco**)
  - `apps/site` — catálogo do usuário (Express + React/Vite + Tailwind)
  - `apps/admin` — painel administrativo (Express + React/Vite + Tailwind)
  - `apps/mcp-public` — servidor MCP público
  - `apps/mcp-admin` — servidor MCP administrativo
  - `apps/indexer` — indexador da busca semântica (`020`, §12.5): o único app
    que não fala HTTP nem escuta porta
  - `packages/shared` — tipos e utilitários compartilhados (ex: geração de
    slug, cálculo de rating, geração de zip)
  - `packages/rag` — o único lugar que fala com o provedor de embeddings:
    recebe texto, devolve vetor, não abre banco (§12.5)
- Cada `app` exporta sua própria imagem Docker (**6 imagens**). Cinco delas
  conectam diretamente ao Postgres via `@purple-skills/db` — **sem** um serviço
  de API interno intermediário; a `homepage` não abre conexão nenhuma.
  `database` exporta uma **sétima** imagem, usada só pelos passos `migrate` e
  `seed`. **Era**, antes do `020`: ~~5 imagens de app, quatro ligadas ao
  Postgres, e uma sexta de `database`~~ — o `indexer` entrou com a busca
  semântica (§11 já contava as sete).
- **A homepage é separada do site de propósito.** A apresentação do projeto não
  depende de banco nem de instalação: pode ir para o ar sozinha, num CDN ou num
  domínio de vitrine, enquanto o `site` é a página de quem já tem um catálogo
  rodando e só quer consultá-lo e conectar seus agentes.
- `database` é uma **fronteira de responsabilidade**, não só uma pasta: é o
  domínio do agente dba, e nenhum app escreve SQL, migration ou container de
  banco. O contrato está em `database/README.md`; a divisão entre agentes, em
  `AGENTS.md`.

## 2. Frontend (site + admin)

- **SPA em React**, build com **Vite**, estilizado com **Tailwind CSS**.
- Express em cada app serve os assets estáticos da SPA e expõe uma API
  **REST JSON** própria (`/api/...`) consumida pelo frontend.
- A API REST do **site** é pública (CORS aberto), podendo ser usada por
  terceiros como alternativa ao MCP público — ver seção 6 sobre
  contabilização de acessos.
- A API REST do **admin** continua interna (mesma origem), protegida por
  sessão de login.

## 3. Banco de dados

- **Postgres 18** (`pgvector/pgvector:pg18-trixie`), pelos recursos
  relacionais/full-text **e**, desde a `020`, pela busca vetorial: a migration
  cria a extensão `vector` e as quatro tabelas `rag_*` (§12.5,
  [`14-rag.md`](14-rag.md); a quinta, `rag_text_status`, veio com a `025`). Ela
  roda em **toda** instalação, então a extensão e as tabelas existem mesmo com a
  busca semântica desligada, que é o padrão.
  **Era**, do `001` ao `019`: ~~"usado apenas por seus recursos
  relacionais/full-text no v1 (busca vetorial fica para o futuro)"~~.
- Acesso via **Drizzle ORM** (query builder + migrations em SQL).
- Migrations aplicadas por um **passo dedicado `migrate`** no
  docker-compose (`docker compose run migrate`), nunca pelos serviços
  simultaneamente no boot.
- Os arquivos de schema ficam em `database/schema/`, nomeados `nnn-nome.sql`
  (3 dígitos, zeros à esquerda), aplicados em ordem lexicográfica. São a fonte
  de verdade do banco: `database/src/schema.ts` é só tipagem.

### 3.1 Tabela `skills`

| coluna          | tipo                    | notas                                   |
|------------------|-------------------------|------------------------------------------|
| `uuid`           | UUID (default `uuidv7()` nativo do PG18) | PK |
| `slug`           | text, unique            | identificador legível usado em URLs/MCP |
| `name`           | text                    |                                          |
| `description`    | text                    |                                          |
| `view_count`     | bigint, default 0       | incrementado a cada acesso ao SKILL.md   |
| `download_count` | bigint, default 0       | incrementado a cada download do pacote   |
| `search_vector`  | tsvector                | mantido por trigger (ver seção 5)        |
| `created_at` / `updated_at` | timestamptz  |                                          |

- **Ranking/"votação de acesso"**: `ORDER BY (view_count + download_count) DESC`
  — soma simples, sem pesos, calculada em tempo de query (sem coluna de
  score armazenada).
- **O que um MCP serve é o vínculo, não uma coluna.** A skill é servida nos
  servidores MCP onde está vinculada a um MCP virtual (`virtual_mcp_skills`),
  e o vínculo carrega as três portas (`as_skill`, `as_prompt`, `as_resource`);
  o desenho está em
  [`09-mcp-padrao-e-skills-flutuantes.md`](09-mcp-padrao-e-skills-flutuantes.md).
  As `use_as_*` existiram entre `001` e `012` e **não** voltaram.
  **`is_public` voltou no `017`** (§12.3), com outro sentido: decide quem
  *lê* a skill — qualquer conta e o site —, nunca o que um MCP serve. O site
  mostra a skill ligada que é pública **ou** está em vMCP aberto e ligado
  **ou** em catálogo público e ligado (`PUBLIC_REACH` em
  `database/src/queries.ts`, [`12`](12-acesso-granular.md) §7).
  **Era**, entre o `012` e o `017`: ~~"a skill é flutuante: não há coluna de
  visibilidade", e o site mostrava só o que estava em ao menos um MCP virtual
  aberto e ligado~~.

### 3.2 Tabela `files`

| coluna           | tipo         | notas                                                   |
|-------------------|--------------|-----------------------------------------------------------|
| `id`              | UUID (uuidv7)| PK                                                          |
| `skill_uuid`      | UUID         | FK → `skills.uuid`                                         |
| `relative_path`   | text         | ex: `SKILL.md`, `examples/foo.md`                          |
| `text_content`    | text, nullable |                                                            |
| `binary_content`  | bytea, nullable |                                                          |
| `mime_type`       | text         | detectado por extensão no servidor                          |
| `size_bytes`      | bigint       |                                                              |
| `created_at` / `updated_at` | timestamptz | |

- `CHECK`: exatamente uma das colunas `text_content`/`binary_content` deve
  ser não-nula.
- **Sem histórico de versões** — edição de arquivo é um `UPDATE` in-place.
  Renomear caminho = delete + insert (sem rastreamento de rename).
- Toda skill deve ter no mínimo um arquivo com `relative_path = 'SKILL.md'`.
  Isso é garantido **na camada de aplicação**: criar uma skill (painel web
  ou MCP admin) exige o conteúdo do SKILL.md como campo obrigatório, e a
  criação da skill + do arquivo SKILL.md ocorre na mesma transação. As
  ferramentas de edição nunca expõem uma opção de deletar o arquivo
  `SKILL.md` (apenas sobrescrever seu conteúdo).
- Sem limite **por skill** (soma dos arquivos) no v1, risco aceito. Há tetos
  por requisição — upload, corpo JSON e descompressão de zip — configuráveis
  por env var e documentados no `.env.example`.

### 3.3 Tabela `tags` / `skill_tags`

- Tags são **livres**, definidas pelo admin por skill (criadas na primeira
  vez que são usadas, sugeridas por autocomplete depois).
- Relação muitos-para-muitos (`skill_tags`).
- Tags servem **apenas para filtro/navegação** no site e como parâmetro de
  filtro no MCP público — não influenciam o ranking de busca/rating.

### 3.4 Tabela `audit_log`

- Log simples de auditoria (sem funcionalidade de restore):
  - `skill_uuid`, `file_path`, `action` (`create`/`update`/`delete`),
    `source` (`web-admin` / `mcp-admin`), `previous_content` (snapshot do
    conteúdo anterior, quando aplicável), `created_at`.

## 3.5 Metadados fora do `SKILL.md`

Slug, nome, descrição e tags moram em **colunas de `skills`** e são a única
fonte da verdade. O que fica gravado na linha `SKILL.md` de `files` é só o
**corpo do prompt**, sem frontmatter.

- O frontmatter é **gerado na leitura**, sempre que o arquivo é materializado:
  download do `.zip`, leitura crua em `/files/SKILL.md`, `get_skill_file` do
  MCP público, `get_file` do MCP admin e o `resources/read` de
  `skill://<slug>/SKILL.md`.
  O `prompts/get`, ao contrário, entrega **só o corpo**: nome e descrição já
  viajam nos metadados do `prompts/list`, e repeti-los no texto é ruído que o
  modelo lê como instrução.
- Formato Agent Skills: `name` é o **slug** (o nome oficial, `a-z0-9-`);
  `description` é a descrição; o nome de exibição e as tags — que a spec não
  define — vão em `metadata.title` e `metadata.tags`.
- Toda escrita de conteúdo (`POST/PATCH /api/skills`, `PUT .../files/SKILL.md`,
  upload de `.zip`, `create_skill`/`set_file`/`set_files_bulk` do MCP admin)
  **descarta** o frontmatter que venha no corpo.
- Motivo: com o frontmatter gravado, renomear a skill deixava o arquivo
  mentindo sobre ela, e o painel oferecia duas telas para o mesmo dado —
  campo e texto — que divergiam em silêncio. Gerar na leitura torna o
  desencontro impossível.
- Como tirar o frontmatter também vale na leitura, skills gravadas antes desta
  decisão são limpas sem migração de dados.

## 4. Upload/gestão de arquivos

- Painel admin: upload de **.zip** (extraído no servidor, preservando
  `relative_path`) **ou** formulário para adicionar/edit um arquivo por
  vez. **Era**, até a quarentena
  ([`15-quarentena.md`](15-quarentena.md) §6): o `.zip` entrava também
  ~~dentro da edição de uma skill já cadastrada~~. Hoje o pacote tem um
  caminho só — a importação, que escolhe entre produção e quarentena —, e a
  edição recebe **só arquivo de texto**, um a um. O `set_files_bulk` do MCP
  administrativo não mudou. A única exceção à preservação é o **embrulho do pacote baixado**: um
  .zip cuja pasta raiz única contém o `SKILL.md` (`<slug>/SKILL.md`,
  `<slug>/ref/…`) entra sem essa pasta, no painel e no `set_files_bulk`. Raiz
  única **sem** `SKILL.md` é subpasta de verdade — o envio parcial de
  `scripts/` — e fica nos caminhos (relatório 075 da auditoria de 2026-09-19;
  antes a pasta era removida em qualquer caso, e os arquivos caíam na raiz da
  skill, ao lado dos originais).

  > **Revisado neste ponto pelo [`15`](15-quarentena.md)** (§10): a importação
  > deixou de ser só de `.zip`/`.skill` — aceita também `.tar`,
  > `.tar.gz`/`.tgz`, `.gz` e `.tar.zst`/`.tzst`/`.zst`, e o formato é decidido
  > pela **assinatura**, não pela extensão (`.rar`, `.7z`, `.xz` e `.bz2` são
  > recusados com o nome do formato). E o embrulho deixou de ser a única
  > exceção à preservação dos caminhos: quando a **raiz** do pacote não tem
  > `SKILL.md`, cada diretório que tenha um vira um envio da quarentena e os
  > arquivos dele são rebaseados para a raiz daquele envio — os que estão fora
  > de um diretório de skill não entram em envio nenhum. Com `SKILL.md` na raiz
  > o pacote é uma skill só e os caminhos ficam como vieram (decisão 27 do
  > [`15`](15-quarentena.md)).
- MCP admin: `set_file(slug, path, content)` para um arquivo por vez, mais
  uma variante `set_files_bulk(slug, zip_base64)` para importar uma árvore
  inteira.
- Atualização parcial de conteúdo: o payload de "definir novo conteúdo"
  aceita uma lista de arquivos para *upsert* e trata **omissão de um
  caminho anterior como exclusão implícita** (o payload representa o
  estado desejado completo daquele conjunto de arquivos).

## 5. Busca

- **Full-text search** do Postgres (`tsvector`/`GIN`) é a **perna textual**, e
  responde sozinha por padrão. Desde a `020` existe uma **perna vetorial**
  fundida com ela por RRF (`k = 60`), ligada pelo `rag.driver` do banco — §12.5
  e [`14-rag.md`](14-rag.md). A resposta da busca traz `mode`, `text` ou
  `hybrid`, para o cliente saber o que leu.
  **Era**, do `001` ao `019`: ~~"sem busca vetorial no v1 (deixada para o
  futuro, usando `pgvector` que já está disponível na imagem do Postgres)"~~.
- `skills.search_vector` combina `name + description + texto do SKILL.md`.
- Mantido por **trigger** no Postgres, disparado em updates de `skills` e
  do arquivo `SKILL.md` correspondente.
- Na perna **textual** a regra continua de pé: só o `SKILL.md` entra no
  `search_vector`, e é o que a trigger mantém. **A perna semântica mudou isso**
  (`020`, `packages/rag/`, [`14-rag.md`](14-rag.md) §4.1): ela indexa **todo
  arquivo de texto** da skill, e não só o `SKILL.md`, inclusive em skill
  privada — e o texto vai a um provedor externo, que o lê. Ficam de fora o
  binário e a imagem, `.svg` incluído (`packages/rag/src/chunk.ts`); com
  `rag.driver` desligado, que é o padrão, nada sai da instalação. Ver a §13.
  **Era**, antes do `020`: ~~"apenas o conteúdo do `SKILL.md` entra na busca —
  demais arquivos anexados não são indexados no v1"~~.
- **Busca por substring é servida por um GIN de trigrama por coluna procurada**,
  não por um índice sobre a concatenação das colunas com prefiltro (`036`). As duas
  formas foram medidas e empatam em tempo (6,9 contra 6,4 ms) e em tamanho (18/50
  contra 20/57 MB por 200 mil linhas), e a concatenação ainda escreve 13 % mais
  rápido; perde porque exige que a expressão do índice seja idêntica, caractere a
  caractere, à que `queries.ts` escreve — editar um dos dois lados desliga o índice
  em silêncio. Por coluna, o SQL das consultas não muda.

## 6. Contadores de acesso

- Dois contadores por skill: `view_count` (acesso à página/conteúdo do
  SKILL.md) e `download_count` (download do pacote).
- **Incremento simples e atômico, sem deduplicação** por IP/sessão (sem
  Redis/cache extra) — risco de inflação por refresh-spam aceito no v1.
- **A mesma lógica incrementa os contadores em qualquer superfície de
  acesso**: página do site, API REST pública do site, e MCP público —
  `get_skill`, `resources/read` de `skill://<slug>/SKILL.md` e `prompts/get`
  incrementam
  `view_count`; seguir a URL de download do `download_skill` incrementa
  `download_count`. Ler a skill por resource ou invocá-la por prompt é acesso
  do mesmo jeito que chamar a ferramenta. Não há tentativa de distinguir "SPA"
  de "chamada de API/script" — tecnicamente indistinguíveis sem autenticação,
  então a distinção não é implementada.

## 7. Autenticação e autorização

### 7.1 Painel administrativo (web)

O painel usa **contas com papéis**. O desenho completo, com as doze decisões
que o produziram, está em [`05-accounts-and-roles.md`](05-accounts-and-roles.md);
o que segue é o resumo do que está no ar.

- **Contas locais** em `users`, com senha guardada como hash **scrypt**
  (`packages/shared/src/password.ts`, custo e salt embutidos no próprio hash).
- Três papéis **globais** — `admin`, `editor`, `membro`. Desde o `12`
  (§12.3) o papel decide só **criar** (editor+) e gerenciar a instalação
  (admin); o **escopo** é o acesso por objeto — dono, concessões e o flag
  público. Um `membro` administra o que é seu ou lhe foi concedido e não cria
  nada.
- Sessão em **cookie assinado, httpOnly, stateless**, agora com
  `{ sub, role, ver, exp }`. `ver` é uma cópia de `users.token_version`: o
  middleware relê a conta a cada requisição e recusa a sessão quando a versão
  mudou ou a conta foi desativada. Trocar senha, mudar papel ou desativar
  incrementa a versão — é a revogação individual, sem tabela de sessões.
- **`ADMIN_PASSWORD` virou senha de bootstrap.** Enquanto `users` está vazia
  ela ainda entra sozinha e habilita `POST /api/setup`, que cria o primeiro
  administrador. Depois da primeira conta, `/setup` responde 404 e o login sem
  e-mail é recusado.
- **Rate limiting no login em duas camadas**: janela em memória por IP
  (`LOGIN_IP_*`, absorve a rajada sem tocar o banco) e `users.locked_until`
  (`LOGIN_MAX_ATTEMPTS`/`LOGIN_LOCK_SECONDS`, sobrevive a restart e vale para
  vários containers).
- **OIDC opcional** (`OIDC_ISSUER`), authorization code + PKCE via
  `openid-client`. O papel nunca vem do provedor; conta nova nasce `membro` e
  conta existente mantém o papel que tem. `OIDC_ALLOWED_DOMAINS` vazia recusa
  **todo** login por SSO, inclusive de conta já vinculada — a allowlist é
  conferida antes de procurar a conta; sobra o login local. Ver §13.
- **SMTP opcional** (`SMTP_URL` + `SMTP_FROM`) para o link de redefinição de
  senha. Sem ele, o admin gera uma senha temporária no painel e a conta entra
  com `must_change_password`.
- **O `Host` da requisição serve de base para o `redirect_uri` do OIDC, mas não
  para o link de redefinição de senha** (`003`). No OIDC o provedor compara o
  `redirect_uri` com o endereço registrado; o link de redefinição sai por e-mail
  para a caixa de outra pessoa e não tem segunda conferência. Sem
  `ADMIN_PUBLIC_URL`, esse link só é montado quando o pedido vem de **rede
  interna** (loopback ou faixa privada, o conjunto do `TRUST_PROXY` padrão) — é o
  que mantém a instalação local funcionando sem configuração e nega a dedução a
  quem chega pela Internet, que recebe `503 public_url_required` e é mandado ao
  administrador. Exigir a variável sempre foi descartado: travaria o
  `docker compose up`.
- **Vale um link de redefinição por conta de cada vez** (`027`). Emitir fecha os
  vivos, e **trocar a senha** fecha os vivos. Esta segunda regra mora no banco, num
  trigger em `users` (`AFTER UPDATE OF password_hash`), e não no app, porque são
  três caminhos que trocam senha — link consumido, reset do admin e troca pelo
  próprio dono — e a regra é do dado: senha nova, nenhum link antigo serve. Um
  caminho novo a herda sem precisar lembrar dela.

### 7.2 MCP administrativo

Duas credenciais valem, ambas por `Authorization: Bearer`:

| Credencial | Ator no `audit_log` | Papel |
|------------|---------------------|-------|
| `MCP_ADMIN_TOKEN` | `token-global` | `admin` |
| `psk_<prefixo>_<segredo>` | o usuário dono | o papel do dono |

- O token global **continua valendo**, comparado em tempo constante
  (`safeEqual`): torná-lo inerte ao criar o primeiro usuário derrubaria todo
  agente já configurado.
- A chave de usuário é encontrada pelo **prefixo** (8 caracteres, indexado) e
  conferida por hash scrypt do segredo. O texto completo aparece uma única vez,
  na emissão. Chave revogada ou de conta desativada não autentica.
- As tools seguem o acesso por objeto do painel (§12.3): criar exige papel
  `editor`+, o resto é o nível da credencial em cada skill, catálogo ou vMCP;
  `delete_*` e `transfer_*` são do dono (ou admin).
- Uma sessão Streamable HTTP fica **presa à credencial que a abriu**: reusar um
  `mcp-session-id` com outra credencial responde 403, senão o papel gravado na
  sessão valeria para quem descobrisse o identificador.
- **O servidor da sessão é construído uma vez, no `initialize`, mas os handlers
  nascem por chamada** (`006`), a partir da credencial revalidada na requisição em
  curso: `comCaller` põe o `Caller` num `AsyncLocalStorage` no despacho do
  transporte e `callerAtual(padrao)` o lê dentro das tools. Não custa nada — o
  `requireBearer` já relia a chave e a conta no banco a cada requisição, e o
  resultado era descartado. Papel, ator, IP e agente deixam de ser "a foto do
  `initialize`"; a sessão continua presa à credencial que a abriu e nenhuma
  mudança de papel derruba a sessão do cliente. Revogar a chave segue sendo o corte
  imediato e total; **rebaixar o papel agora também vale**, na próxima requisição.

### 7.3 MCP público

- **Não existe mais um servidor "principal" à parte**
  ([`09-mcp-padrao-e-skills-flutuantes.md`](09-mcp-padrao-e-skills-flutuantes.md)).
  O que responde em `/mcp` é o **MCP virtual escolhido como padrão** na
  tabela `settings` (chave `default_virtual_mcp`), pelo painel ou pelo
  mcp-admin, só por admin. Ele continua respondendo em `/virtual/<slug>/mcp`
  e não tem tratamento especial: pode ser fechado, desligado ou apagado, e
  nesses casos `/mcp` responde 404 dizendo a causa (nenhum padrão, removido,
  desligado).
- A autenticação de `/mcp` é a do próprio vMCP padrão: aberto quando
  `is_open`, senão chave `psv_` dele. `MCP_PUBLIC_AUTH`, `MCP_PUBLIC_KEY` e
  as chaves `psp_` de `public_mcp_keys` deixaram de existir no `011`; o
  mcp-public recusa subir enquanto as variáveis estiverem definidas.
- CORS totalmente aberto (`*`), pois o objetivo é ser consumido por
  qualquer agente externo.
- **MCPs virtuais** (`/virtual/<slug>/mcp`, [`08-mcp-virtual.md`](08-mcp-virtual.md)):
  o mesmo processo monta, sob esse prefixo, um servidor de leitura por MCP
  virtual, com um recorte próprio do catálogo (inclusive skills privadas) e
  autenticação própria — chave `psv_` da tabela `virtual_mcp_keys`, ou
  aberto quando `is_open`. A chave de um virtual não abre outro. Sessões
  ficam presas à identidade (MCP + chave) que as abriu, como no mcp-admin; a
  raiz reusa a identidade do vMCP padrão. Os downloads são servidos pelo
  próprio mcp-public, sob o prefixo por onde o servidor foi chamado (vazio na
  raiz) e com a mesma credencial.
- **O teto de sessões por credencial recicla, não recusa** (`007`). Ao estourar
  `MCP_MAX_SESSIONS_PER_IDENTITY`, cai a sessão **mais parada da própria
  credencial** (gravada com `end_reason: 'timeout'`); o `initialize` só é recusado
  pelo teto global do processo, com `Retry-After` e ponteiro para `/mcp/stateless`.
  O motivo é que cliente MCP reconecta com frequência — o Claude Desktop reabre a
  cada janela — e a sessão abandonada é sempre a mais parada: recusar derrubaria o
  cliente legítimo justamente ao reconectar. E num vMCP aberto todo anônimo
  compartilha a mesma identidade (`virtual:<uuid>:open`), então um 429 por
  identidade viraria negação de serviço contra os anônimos legítimos.
  A consequência, dita por extenso porque ninguém a lia aqui: **num vMCP aberto
  esse teto é um balde só para todos os anônimos** — as 50 vagas são do
  servidor inteiro, não de cada visitante, e quem abre a 51ª derruba a sessão
  mais parada de um desconhecido. A alavanca é `MCP_MAX_SESSIONS` (que leva o
  derivado junto), e `/mcp/stateless` não ocupa vaga; o desenho, o que foi
  medido e recusado, e o que ainda é decisão de capacidade estão em
  [`08-mcp-virtual.md`](08-mcp-virtual.md) §4.1 (relatório 048 da auditoria de
  2026-09-19).

### 7.4 Padrão de secrets (env vars)

Os segredos **lidos pelas aplicações** seguem o padrão `<NOME>` / `<NOME>_FILE`
(a aplicação lê o arquivo se `<NOME>_FILE` estiver definido; senão usa `<NOME>`
direto). Ficam de fora, só com o valor direto, os que não passam pelo
`readSecret`: `POSTGRES_PASSWORD` (quem a lê é o compose), `DATABASE_URL` e
`PGPASSWORD` (lidas pelo driver `pg`) e `INSPECTOR_API_TOKEN` (imagem de
terceiro). Os que seguem o padrão:

- `ADMIN_PASSWORD` / `ADMIN_PASSWORD_FILE` (bootstrap — §7.1)
- `ADMIN_SESSION_SECRET` / `ADMIN_SESSION_SECRET_FILE`
- `MCP_ADMIN_TOKEN` / `MCP_ADMIN_TOKEN_FILE`
- `OIDC_CLIENT_SECRET` / `OIDC_CLIENT_SECRET_FILE`
- `SMTP_URL` / `SMTP_URL_FILE`
- `RAG_GOOGLE_API_KEY`, `RAG_OPENAI_API_KEY`, `RAG_VOYAGE_API_KEY` (cada uma com
  `_FILE`) — uma por provedor de embeddings (§12.5). São as **únicas** chaves
  de terceiro com custo por uso: vão para o `indexer`, o `mcp-public` e o
  `site`, e **nunca** para o painel, que só sabe da chave o que o indexador
  publica em `rag.indexer.status`. Ter mais de uma configurada é o que permite
  trocar de provedor pelo painel, sem recriar container.

**Segredo com valor de placeholder derruba o boot** (`001`): `CHANGE_ME` e as
variações conhecidas são recusadas em `MCP_ADMIN_TOKEN`, `ADMIN_SESSION_SECRET` e
`ADMIN_PASSWORD` — esta última porque é a credencial que cria o primeiro
administrador, e um `CHANGE_ME` ali dava admin a quem abrisse o `/setup`. A guarda
fica em quem **pede** o segredo, não no `readSecret`: o motivo está em
[`03`](03-implementation-notes.md), em "Segredos".

A derivação do segredo de sessão a partir de `ADMIN_PASSWORD` (scrypt, salt
constante) foi **mantida**. Removê-la derrubaria quem sobe só com
`ADMIN_PASSWORD`, e um salt por instalação teria de vir do banco, que
`apps/admin/src/config.ts` não acessa por regra do `AGENTS.md`. O que o salt
público permitia era pré-computar uma tabela reutilizável entre instalações; com o
placeholder recusado, não há mais entrada conhecida para pré-computar. Aposentar a
derivação continua sendo decisão do mantenedor.

### 7.5 Segredos do repositório e do ambiente de testes

O projeto publicado versiona **apenas** o `.env.example`, com `CHANGE_ME` nos
lugares dos segredos. Nenhum valor real é versionado, e o CI reprova qualquer
`.env*` que apareça no índice (job `secrets-scan` + `.gitleaks.toml`).

O `.env.example` **continua com `CHANGE_ME`** em cada segredo, como manda o
`AGENTS.md` e esta seção — a proposta de trocá-los por vazio foi recusada (`001`).
O `.gitleaks.toml` trata `CHANGE_ME` como o placeholder conhecido justamente para
que um segredo real colado ali continue sendo apontado, e o vazio não cumpriria
esse papel. A defesa é a **recusa no boot** (§7.4), que falha mais alto que o vazio
e com mensagem melhor; a lista de placeholders do código é a mesma do
`.gitleaks.toml`, para que as duas não divirjam.

O workflow declara `permissions: contents: read` no topo, em vez de herdar o
padrão do repositório, porque nenhum job escreve pelo `GITHUB_TOKEN` (`041`) —
cache do npm, cache `type=gha` do buildx e resumo do build usam o token de execução
do runner, que esse bloco não governa.

Os arquivos com valores preenchidos — `.env`, `.env-builder`, `run-builder.sh`
e `docker-compose-builder.yml` — pertencem ao **ambiente de testes do
mantenedor**, não ao projeto. Estão no `.gitignore` e no `.dockerignore`, nunca
entraram no repositório nem na imagem, e não descrevem nenhuma implantação de
produção do Purple Skills.

O commit inicial `a01fdaf` publicou o `.env.example` com valores preenchidos em
vez de placeholders; o `7fd36ca` os trocou por `CHANGE_ME`. São credenciais
daquele mesmo ambiente de testes. Continuam no histórico — que é imutável — e
por isso ficam dispensadas no `.gitleaks.toml`, com escopo fechado no commit
**e** no arquivo, para que nenhum outro segredo do mesmo commit seja silenciado.

O mesmo commit trazia, no `docker-compose.yml`, a senha do banco com padrão
embutido `postgres` — solta e dentro do DSN —, removida no `7fd36ca`; ela
também fica dispensada, na mesma forma, fechada no commit **e** no arquivo
(relatório 065 da auditoria de 2026-09-19). São **duas** as exceções deste
commit. Ela passou a ser necessária porque a dispensa de interpolação deixou de
ser o `^\$\{` solto: agora só passam as formas ancoradas que comprovadamente
não carregam valor (`${VAR}`, `${VAR:-}`, `${VAR:?mensagem}`), e a dispensa
pela **linha** saiu de vez — ela valia para todas as regras, inclusive as
padrão, e calava um token de verdade em qualquer linha que apenas mencionasse
`${VAR:-…}`.

> **Quem implanta o Purple Skills gera os próprios segredos.** Nenhum valor
> deste repositório, atual ou histórico, serve como padrão: são exemplos de um
> ambiente de testes, e reaproveitá-los deixa a instalação com credenciais
> públicas.

### 7.6 O que a entrega de contas revogou

Contas e papéis mudaram três decisões que valiam antes desta seção:

| Antes | Agora |
|-------|-------|
| Senha única, comparada sem hashing | Senha por conta, hash scrypt em `users.password_hash` |
| Sessão stateless **autossuficiente** | Continua stateless, mas o middleware lê a conta a cada requisição para conferir `token_version` e `is_active` |
| Sem rate limiting no login | Janela por IP + `users.locked_until` |

A segunda troca é um custo assumido: o painel passa a tocar o banco em rotas
que antes não tocavam. É um `SELECT` por chave primária num app de baixo
volume, e em troca não há linha de sessão para expirar nem limpar.

O que **não** mudou: o `MCP_ADMIN_TOKEN` segue válido como credencial de
máquina, e uma instalação que nunca passe pelo `/setup` continua funcionando
com a senha única indefinidamente (§4.1 da spec).

Ficaram deliberadamente de fora: ownership por skill, fluxo de revisão, RBAC
com permissões compostas, tabela de sessões, auditoria de login e papel vindo
de grupo do IdP. Os motivos estão na §5 de
[`05-accounts-and-roles.md`](05-accounts-and-roles.md).

### 7.7 Limite de taxa

O limitador mora em `packages/shared` e **não conhece Express** (`014`): a janela
deslizante por IP é a mesma nas três superfícies que têm limite — o login do painel
(§2.7 de [`05-accounts-and-roles.md`](05-accounts-and-roles.md)), o site e o
mcp-public — e o corpo da recusa é de cada app. No site e no mcp-public ele entra
**antes** de tudo o que consulta o banco — no mcp-public, antes da autenticação,
porque é ele que protege a consulta que o `auth` faz —, e quem tem credencial é
isentado por devolução da marca depois de o `auth` passar. A conta é **por
processo**: camada barata contra rajada, não quota contábil. Os tetos do site e do
mcp-public (`SITE_RATE_LIMIT_MAX`, `MCP_RATE_LIMIT_MAX`) aceitam `0` como
"desligado", para a instalação que já limita no proxy.

O **mcp-admin não tem limitador de taxa** — nem hoje, nem antes. Toda rota MCP dele
exige `Bearer` e a porta fica no loopback por padrão, mas o caminho que o limitador
protegeria existe: o `auth` faz um `SELECT` por requisição para qualquer
`Bearer psk_…` bem formado e, quando o prefixo existe e a chave não foi revogada,
um `scryptSync`; e o 401 não deixa rastro em log nem em auditoria. Quem publica
esse serviço — `BIND_ADDR` fora do loopback, ou o `docker-compose.traefik.yml`, que
lhe dá FQDN público **sem** middleware de taxa — precisa limitar **no proxy**.
Portar o limitador para o mcp-admin, ou registrar a ausência como risco aceito
(§13), é decisão em aberto.
Este parágrafo corrige o que a §7.7 afirmava desde a `beta.22` — "site, mcp-public
e mcp-admin" —, que nunca foi o estado do código: a terceira superfície sempre foi o
login do painel.

### 7.8 Trust proxy

O padrão do `TRUST_PROXY` é uma **função** `(endereço, salto) => confia?` que
aceita um salto de peer interno (`026`). Confiar na faixa inteira em qualquer
profundidade deixava um cliente privado atrás do proxy escolher o próprio `req.ip`;
confiar por contagem de saltos (`1`) deixaria qualquer cliente fazer o mesmo numa
instalação exposta sem proxy. Nenhum padrão resolve o vizinho que alcança a porta
direto: para esse caso, nomear o proxy em `TRUST_PROXY` ou não publicar a porta.
Com `TRUST_PROXY=true` — que a documentação já desaconselha em produção exposta — o
cliente volta a controlar `req.ip`, e com ele o critério de "rede interna" do link
de redefinição de senha (§7.1).

## 8. Contrato das ferramentas MCP

### 8.1 MCP público (`apps/mcp-public`)

- Todo ponto de montagem — `/mcp` (o vMCP padrão) e `/virtual/<slug>/mcp` —
  serve o mesmo servidor: as cinco ferramentas e as superfícies de prompt e
  resource, lendo pelo vínculo `virtual_mcp_skills` (flags `as_skill` /
  `as_prompt` / `as_resource`). Nome `<MCP_SERVER_NAME>-<slug>` e instruções
  com a descrição do vMCP.
- `search_skills(query, tag?, limit?, offset?)` → lista de
  `{ slug, name, description, tags, score }` das skills vinculadas com
  `as_skill`.
- `get_skill(slug)` → conteúdo completo do SKILL.md + lista de arquivos
  anexados. Incrementa `view_count` no vínculo e na skill.
- `download_skill(slug)` → retorna a **URL** de download servida pelo próprio
  mcp-public sob o prefixo do mount (`/skills/<slug>/download` na raiz,
  `/virtual/<slug>/skills/<skill>/download` nos demais), atrás da mesma
  credencial. Não gera o zip na chamada; a requisição HTTP real incrementa
  `download_count`. A `url` da página do site só sai quando a skill é pública.
- Suporte a todas as versões do protocolo MCP TypeScript SDK: SSE,
  Streamable HTTP e modo stateless.

### 8.2 MCP administrativo (`apps/mcp-admin`)

CRUD completo, espelhando o painel administrativo. A assinatura de cada tool,
argumento a argumento, é a da tabela do
[`README`](../README.md#ferramentas-do-mcp-administrativo) e a do
`apps/mcp-admin/src/server.ts`; aqui fica o que é decisão:

- `create_skill(name, description?, icon?, skill_md_content, tags?, slug?,
  mcps?: [{slug, asSkill, asPrompt, asResource}], is_public?)` — nasce
  publicada onde a credencial edita, ou sem vínculo; `is_public: true` a põe no
  site mesmo sem vínculo (§12.3)
- `edit_skill(slug, { name?, description?, icon?, tags?, new_slug?,
  is_active?, is_public? })` — `is_active: false` desliga a skill em tudo
  ([`11`](11-catalogos.md)); nome, descrição, ícone e tags são `edit`, slug,
  `is_active` e `is_public` são `manage` ([`12`](12-acesso-granular.md) §3.2)
- `get_skill(slug)` / `get_file(slug, path)` — leitura; `list_tags()` /
  `get_stats()` — navegação e números, recortados pelo que a credencial vê
- `link_skill(skill, mcp, asSkill, asPrompt, asResource)` /
  `unlink_skill(skill, mcp)` — o vínculo pelo lado da skill; a permissão é a
  do MCP virtual alvo
- `set_file(slug, path, content)`
- `set_files_bulk(slug, zip_base64, replace?, confirm_deletions?)` — com
  `replace` (o padrão) o que sairia é recusado até vir o número exato em
  `confirm_deletions` (§4)
- `delete_file(slug, path)` (bloqueado para `path = "SKILL.md"`)
- `delete_skill(slug, confirm)` — só o dono ou um admin
- `list_skills(query?, tag?, scope?, limit?, offset?)` — ~~o catálogo inteiro,
  inclusive skills sem vínculo~~, cada uma com `mcps`. **Revogado neste ponto
  por [`12`](12-acesso-granular.md)** (§3.1): o alcance é por conta — as suas,
  as concedidas e as públicas ou expostas, inclusive sem vínculo e desligadas;
  tudo para admin.
- `share_skill(slug, username, level)` / `unshare_skill(slug, username)` /
  `transfer_skill(slug, username)`, e o mesmo para `*_catalog` e `*_mcp`
  ([`12`](12-acesso-granular.md)): conceder e revogar é `manage`, transferir é
  do dono (ou admin). O parâmetro era `email` e virou `username` no
  [`19`](19-username.md) — e-mail não é aceito.
- MCPs virtuais ([`08`](08-mcp-virtual.md) §6.2): `list_virtual_mcps()`,
  `get_virtual_mcp(slug)`, `create_virtual_mcp(name, slug?, description?,
  is_open?)`, `update_virtual_mcp(slug, {name?, new_slug?, description?,
  is_open?, is_active?})`, `delete_virtual_mcp(slug, confirm)`,
  `set_virtual_mcp_skills(slug, [{slug, asSkill, asPrompt, asResource}])`, `list_virtual_mcp_keys(slug)`,
  `create_virtual_mcp_key(slug, name)`, `revoke_virtual_mcp_key(slug, key_id)`.
  ~~Alcance por dono: o token global e as chaves de admin administram qualquer
  um; a chave de um usuário, os MCPs de que ele é dono.~~ **Revogado neste
  ponto por [`12`](12-acesso-granular.md)**: o alcance é por concessão — todos
  para admin; os seus, os concedidos e os abertos para os demais, com o acesso
  (`view`, `edit`, `manage` ou dono) em cada um.
- MCP padrão ([`09`](09-mcp-padrao-e-skills-flutuantes.md) §3.6):
  `get_default_virtual_mcp()` e `set_default_virtual_mcp(slug | null)`, o
  segundo só admin.
- Catálogos ([`11`](11-catalogos.md) §6.3): `list_catalogs()`,
  `get_catalog(slug)`, `create_catalog(name, slug?, description?)`,
  `update_catalog(slug, {name?, new_slug?, description?, is_active?})`,
  `delete_catalog(slug, confirm)`, `set_catalog_skills(slug, [{slug,
  isActive?}])` e, no vMCP, `set_virtual_mcp_catalogs(slug, [{slug, asSkill,
  asPrompt, asResource}])` — este exige `edit` no MCP e `view` em cada
  catálogo (§12.3). Mesmo alcance por objeto dos MCPs virtuais.
  ~~Exige administrar o MCP **e** cada catálogo~~ era a regra do `11`
  (decisão 7), **revogada pelo [`12`](12-acesso-granular.md)** (decisão 6): a
  marca está no topo do `11` e na `§6.2` dele.

## 9. Download de pacotes

- Formato **ZIP**, gerado on-the-fly a partir das linhas da tabela
  `files` (streaming, ex: lib `archiver`), preservando `relative_path`.
- O `SKILL.md` do pacote é montado na hora: frontmatter vindo dos metadados
  da skill + corpo gravado (§3.5).
- O mesmo ZIP é servido também com a extensão **`.skill`** (rota
  `…/download.skill`), o formato aberto de Agent Skills — só muda o nome do
  arquivo baixado, o conteúdo é idêntico.
- O painel admin expõe as duas rotas em `/api/skills/:slug/download[.skill]`
  (atrás de `requireAuth`, servindo também skills privadas); esse download não
  incrementa `download_count`.

## 10. Infraestrutura / Docker

- Node.js: versão **LTS ativa no momento da implementação** (pin explícito
  no Dockerfile — hoje `node:24-alpine` nos sete, atualizado quando a LTS
  mudar). O **piso** é outro número e vive no `engines` do `package.json`:
  `>=22.15`, e não o `>=22` de antes, porque a leitura de pacote importa o
  `zstdDecompressSync` do `node:zlib`, que só existe a partir daquela versão —
  ver [`15-quarentena.md`](15-quarentena.md) §10.
- `docker-compose.yml` local orquestra as imagens de app + Postgres + o passo
  `migrate`, em rede Docker interna. O `indexer` **sobe no `up -d`**, como os
  demais: com `rag.driver` em `off`, que é o padrão, ele só publica o próprio
  estado e não fala com provedor nenhum, então a escolha de gastar dinheiro e
  mandar conteúdo para fora é **uma só** — o driver, no painel, com a chave dele
  no ambiente (§12.5). Consequência assumida: quem liga o driver não tem segunda
  trava, e um `up -d` de atualização volta a iniciar o indexador de quem o
  mantinha parado de propósito. A linha `profiles: [rag]` continua no compose,
  **comentada**: descomentá-la devolve o opt-in de dois passos a quem o quiser.
  **Era**, até a `beta.21`: ~~"O `indexer` fica no perfil `rag`, fora do `up` do
  dia a dia (`docker compose --profile rag up -d indexer`): ele é o único
  serviço que gasta dinheiro e manda conteúdo para fora, então subir é uma
  escolha"~~ — a `beta.22` saiu com a linha do perfil comentada, por decisão
  do mantenedor ([`CHANGELOG`](../CHANGELOG.md), "Decidido e não mudado"), e
  este parágrafo tinha ficado para trás.
  **Era**: ~~"as 4 imagens + Postgres + o passo `migrate`"~~ — hoje são seis de
  app (§1).
- Cada imagem também pode rodar de forma independente/standalone em
  produção, apontando para um Postgres externo via env vars.
- **Variável cujo padrão difere entre serviços não entra no `x-app-env`**
  (`039`): `MCP_JSON_LIMIT` (1 MB no público, 48 MB no admin) e `MCP_SERVER_NAME`
  (`purple-skills` × `purple-skills-admin`) são declaradas serviço por serviço.
  Quando um valor único apagaria a diferença, o nome que o operador escreve no
  `.env` é **por serviço** e o compose o mapeia para o nome que o código lê —
  `MCP_PUBLIC_SERVER_NAME`/`MCP_ADMIN_SERVER_NAME` → `MCP_SERVER_NAME`, como
  `INSPECTOR_OMIT_AUTH` → `DANGEROUSLY_OMIT_AUTH`. É mais barato que uma variável
  nova no código e não deixa dois servidores MCP aparecerem com o mesmo nome no
  `mcp.json` do cliente. O teto do corpo JSON segue a mesma regra desde o
  relatório 029 da auditoria de 2026-09-19:
  `MCP_PUBLIC_JSON_LIMIT`/`MCP_ADMIN_JSON_LIMIT` → `MCP_JSON_LIMIT`. Declarar a
  linha serviço por serviço não bastava enquanto as duas interpolavam a **mesma**
  `${MCP_JSON_LIMIT:-}`: quem a preenchia para mandar `.zip` maior pelo admin
  abria os mesmos megabytes ao MCP público, anônimo num vMCP aberto. O nome antigo
  segue valendo só como queda do admin (`${MCP_ADMIN_JSON_LIMIT:-${MCP_JSON_LIMIT:-}}`),
  e o valor é validado no boot (`readSizeEnv`), como os limites numéricos.
- **Fixação de dependência: fixa-se o que um terceiro pode trocar debaixo de nós
  sem revisão; não se fixam bytes que só uma automação mantém novos** (`053`).
  Aplicada: (a) `node:24-alpine` fica **por tag** — o ponto fixo de rollback é a
  tag `:VERSÃO` publicada no Hub (§11), não o digest, porque ninguém aqui re-deriva
  imagem a partir do commit; digest sem automação envelhece em CVE, e com automação
  vira PR semanal de 14 linhas aprovado sem leitura, que é pior porque *parece*
  revisão. Major do Node é decisão manual, junto com `engines`, e regressão de base
  aparece como build vermelho no CI, que constrói as sete imagens em todo PR. (b) O
  `mcp-inspector` **é** fixado: imagem de terceiro, sem autenticação e com rota até
  o mcp-admin. (c) As actions do CI **não** são fixadas por SHA e não há
  Dependabot — depois do `041` o workflow roda com `contents: read` e sem segredo
  nenhum, e a publicação de imagem é manual e local, então o CI não participa da
  cadeia de suprimento do artefato distribuído e o alcance de uma action
  sequestrada ali é o cache `type=gha` de builds que nunca dão push. **Gatilho para
  reabrir:** no dia em que esse workflow ganhar segredo (push de registry,
  `id-token` para proveniência), fixar por SHA **e** criar
  `.github/dependabot.yml` no mesmo passo. O que entra nas imagens — os pacotes
  npm — já está fixado por versão e integridade no `package-lock.json`.

## 11. Testes e CI/CD

- **Testes**: unitários (Vitest) cobrindo `packages/shared` (rating, slug,
  caminhos, zip, frontmatter, segredos, sessão, leitura de env) e os handlers
  das ferramentas MCP, com `@purple-skills/db` mockado. As queries de
  `database/` têm um teste de integração que exige um Postgres real e fica
  desligado sem `TEST_DATABASE_URL`. Sem E2E no v1.
- **CI/CD** (GitHub Actions):
  - Workflow de PR: lint + testes + build das 7 imagens **sem push** (só
    valida que o Dockerfile de cada app e o de `database/` constroem).
  - **Sem workflow de release.** Nenhum job de CI tem credencial de registry.
    Publicar imagem é passo manual: depois de criar a tag da versão, quem
    mantém roda [`release-images.sh`](../release-images.sh) — um
    `docker buildx build --push` por imagem, das 7 (os 6 apps mais
    `purple-skills-db`), para o Docker Hub, na conta `tmsoftbrasil`
    (`tmsoftbrasil/purple-skills-<nome>`), em `linux/amd64` e `linux/arm64`.
    Cada imagem leva **duas tags**: `:VERSÃO` (a do `package.json` da raiz) e
    `:latest`. A `:VERSÃO` é o ponto fixo de rollback do §10
    (`TAG=<versão anterior> docker compose up -d`), porque `latest` é
    sobrescrita e não deixa cópia. Requer `docker login` prévio nessa conta.
    **Era**, até a `beta.21`: ~~"builda e faz `docker push` das 7 imagens […]
    sempre como `latest`"~~ — o script mudou na `beta.22` (`015`).
    **Era**, até a `beta.22`: ~~as duas tags saíam do mesmo `--push`, imagem por
    imagem~~ — o build publica só `:VERSÃO`, e a `:latest` é promovida depois,
    num segundo laço curto, com `docker buildx imagetools create` (cópia fiel
    dentro do registry: mesmo digest, logo as mesmas arquiteturas e labels).
    `db` vai **primeiro** na lista, e nenhuma `latest` se move enquanto todas as
    pedidas não estiverem no Hub: um build que falha no meio deixava `latest`
    apontando para versões diferentes entre si, com o risco de alguém puxar um
    app novo contra um schema velho. A janela mista cai dos minutos do build
    multi-arquitetura para os segundos da promoção — não zera, e publicar
    subconjunto por nome continua podendo misturar de propósito (relatório 071
    da auditoria de 2026-09-19).
  - **O gate da publicação é uma confirmação informada**, não uma bateria de
    testes (`015`). Typecheck e testes não são repetidos no `release-images.sh`
    porque o CI já os roda em todo push para `main`; e árvore limpa não é exigida
    porque quem mantém trabalha com a árvore suja — 163 arquivos modificados na
    rodada desta correção, e as tags `v*` paradas na `beta.9` com a versão em
    `beta.21`. A trava seria removida, não obedecida. O que substitui a disciplina
    é o **registro**: labels OCI `image.version`, `image.revision` (com sufixo
    `-sujo` quando o build sai de árvore suja) e `image.source`.
  - **O manifesto publicado é multi-arquitetura** (`linux/amd64,linux/arm64`),
    porque quem publica está em arm64 e o servidor comum é amd64; `PLATFORMS=` é a
    saída para publicar uma só. Isso exige `docker buildx … --push`:
    `docker build` + `docker push` não montam manifesto com duas arquiteturas, e a
    imagem multi-plataforma não fica no store local depois do push.

## 12. Licença

- **MIT**.

## 12.1 Painel: console com canvas e sessões

Desenho em [`10-admin-canvas-e-sessoes.md`](10-admin-canvas-e-sessoes.md).

- O painel é um **console**: sidebar de 220px, barra superior com o sino, o
  palco num painel que ocupa a tela. Paleta própria (`tokens.css` do admin,
  escuro primeiro, espelhado no claro), que **diverge** do site e da homepage
  de propósito — ver `04`. Toda ação existe primeiro como comando da paleta
  ⌘K e só depois como botão.
- A home é **Servidores MCP** (cards com miniatura das skills, selos e
  clientes online). A "Visão geral" saiu; a auditoria virou página própria,
  com filtros, paginação e a lista de sessões MCP.
- O servidor MCP virtual é um **canvas** (React Flow): o vMCP com as três
  portas (Tools, Resources, Prompts) à direita, as skills ligadas a uma ou
  mais delas, o globo da Internet à esquerda com o contador de clientes
  online. Cada aresta é um vínculo gravado na hora; a última aresta que sai
  tira a skill do servidor. Posições no banco (`014`), compartilhadas.
- **Sessões do MCP público** em `mcp_sessions` (`015`): uma linha por
  cliente e transporte, com IP resolvido pelo `trust proxy`, `clientInfo`,
  atividade e fim real ou presumido. "Online" = atividade nos últimos
  `MCP_SESSION_ONLINE_WINDOW_MS` (2 min). Sem poda.
- **Ícone da skill** (`013`): emoji ou URL, com monograma como padrão.

## 12.2 Catálogos

Desenho em [`11-catalogos.md`](11-catalogos.md). Migration `016`.

- Um **catálogo** é um grupo de skills com dono (como o vMCP): quem cria
  (editor+) é o dono, admin manda em todos. Uma skill pode estar em vários.
- Vinculado a um vMCP (`virtual_mcp_catalogs`, muitos-para-muitos), entrega
  **todos os membros ativos** pelas portas do vínculo — uma escolha só para
  o grupo. Vincular exige `edit` no vMCP e `view` no catálogo; desvincular,
  só o `edit` do vMCP. Não há convite. (~~Administrar **os dois** lados~~ era
  a regra do `11`, revogada pelo `12` — ver §12.3.)
- **Precedência**: o vínculo direto da skill com o vMCP **sobrescreve** o
  catálogo; sem vínculo direto, as portas são a **união** dos catálogos que
  chegam ao vMCP. A regra mora no SQL (`visibilityClause`), como sempre.
- Três desativações reversíveis: `skills.is_active` (global — some de tudo,
  inclusive do site e do vínculo direto), `catalog_skills.is_active` (a
  participação, só naquele catálogo) e `catalogs.is_active` (o catálogo).
- Contador **por catálogo**, global: cada acesso a uma skill que chegou ao
  vMCP pelo catálogo soma nele e na skill; por vínculo direto, no vínculo.
- No canvas, o catálogo é um **nó só**, com as mesmas portas e gestos da
  skill e o número de skills ativas — excluindo as que já são nó próprio.
- Auditoria: `catalog.create` / `catalog.update` / `catalog.delete`; o
  vínculo com o vMCP é `mcp.update` no servidor.

## 12.3 Acesso granular

Desenho em [`12-acesso-granular.md`](12-acesso-granular.md). Migration `017`.

- **Skill, catálogo e vMCP têm dono** (`owner_user_uuid`; a skill herdou o
  de `created_by`). Dono e admin apagam e transferem; nenhum nível de
  concessão chega lá.
- **Concessões por objeto** em `skill_grants`, `catalog_grants` e
  `virtual_mcp_grants`, um nível cumulativo por conta: `view` < `edit` <
  `manage`. `manage` concede e revoga; a lista de concessões só é visível a
  quem tem `manage`.
- **Escopo por conta**: quem não é admin vê o que é seu, o que lhe foi
  concedido e o que é público (`skills.is_public`, `catalogs.is_public`) ou
  aberto (`virtual_mcps.is_open`). A cláusula mora no SQL (`viewer` nas
  leituras), pelo motivo de sempre. Admin, o token global e o bootstrap veem
  tudo.
- **Contêiner expõe**: ver um vMCP ou um catálogo lê todas as skills dentro,
  para pessoa e máquina; um catálogo público ou um vMCP aberto expõe os
  membros no site, mesmo privados. Vincular exige `view` na skill e `edit`
  no contêiner; catálogo↔vMCP, `edit` no vMCP e `view` no catálogo.
- **`leitor` virou `membro`**: a única diferença para `editor` é criar.
- **Site**: lista também skills públicas sem vMCP aberto e os catálogos
  públicos, com página própria (`/catalogs/<slug>`).
- Auditoria: `skill.share` / `skill.unshare`, `catalog.share` /
  `catalog.unshare`, `mcp.share` / `mcp.unshare`; transferência e flag
  público são `update` do objeto.
- **A conta, quando o painel precisa apontar uma pessoa, é identificada pelo
  username — nunca pelo `uuid`** (`025`; era o e-mail até o
  [`19`](19-username.md)). O `uuid` é o `sub` do cookie de sessão, e a
  busca da decisão 13 é aberta a qualquer conta logada: emitir `uuid` + papel de
  toda conta ativa é entregar o alvo exato de uma falsificação de cookie, e um
  portão de papel não resolveria, porque `membro` também é dono e transfere
  (decisão 9). Não há identificador opaco a inventar: o username existe para ser
  público. Vale para `GET /api/users/lookup` e para o `ownerUserUuid` do `PATCH`,
  que aceita username ou uuid. O e-mail ocupava este lugar e saiu de circulação
  — com ele, o raciocínio dependia de um "risco aceito" (§10 do `12`) que o `19`
  desfez.

## 12.4 Fichas, colmeia e registro de acessos

Desenho em [`13-fichas-e-acessos.md`](13-fichas-e-acessos.md). Migration `018`.

- **Lista → visualizar → editar.** A ficha de uma skill ou de um catálogo é
  só leitura; toda alteração — conteúdo, metadados, publicação, acesso,
  remover — mora em `/edit`, com a mesma organização de guias: Skill,
  Catálogos, Propriedades, Acesso e Auditoria na skill (Editar troca
  Auditoria por Arquivos); Catálogo, Skills, Propriedades, Acesso e
  Auditoria no catálogo. O servidor tem a guia Acesso ao lado de
  Configurações. Guias são rotas.
- **O Salvar da edição da skill grava tudo** (desde 17/09/2026): portas,
  catálogos, visibilidade, concessões e dono são pendências até ele, que
  fica sempre ativo; catálogo e servidor continuam gravando na hora.
- **Registro por leitura** em `skill_accesses`: cada `get_skill`,
  resource, prompt, SKILL.md avulso e pacote do MCP público, o detalhe, o
  SKILL.md e o pacote do site, e o `get_skill` do mcp-admin por chave `psk_`
  viram uma linha com quem leu (chave `psv_`, conta, aberto ou anônimo), o
  servidor, os catálogos por onde a skill chegou, sessão, IP e cliente. Os
  contadores são somados na mesma escrita; nunca é podada; cópias de slug,
  nome, chave e e-mail sobrevivem à remoção do que nomeiam. A guia é de
  quem administra o objeto (`manage`) e se chama **Auditoria**.
- **A colmeia** do card do servidor: um hexágono liso por skill direta
  (`rgb(59, 145, 145)`) e por catálogo (`rgb(112, 59, 145)`), até 19, e um
  "+N" com o resto.
- **Usuários seguem o mesmo princípio**: lista que só navega, "Nova conta"
  num modal, ficha só leitura e edição com as guias Conta, Chaves, Acessos
  (as leituras pelas chaves `psk_` da conta) e Atividade (a auditoria
  filtrada pelo ator). Migration `019` (índice por conta).

## 12.5 Busca semântica

Desenho em [`14-rag.md`](14-rag.md). Migrations `020` e `025` (a fila de
textos: reserva e recusa), pacote `packages/rag`, container `apps/indexer`.

- **Uma decisão do v1 mudou de estado.** "Sem busca vetorial" (§3 e §5) valeu do
  `001` ao `019` e a entrega da `020` a revogou. Não foi troca de gosto: a busca
  `simple` acerta quem já sabe a palavra que a skill usa, e um agente que
  descreve a tarefa em linguagem natural é justamente quem não sabe. A frase
  antiga fica marcada onde estava, como toda revogação neste documento.
- **Duas pernas, uma resposta.** A textual de sempre e a vetorial, fundidas por
  **RRF (`k = 60`)**, sem corte por distância, com o recorte de visibilidade
  valendo nas **duas**. O cliente recebe `mode` (`text` ou `hybrid`) para saber
  o que leu, não para escolher.
- **Nasce desligada, e cair para a textual nunca é erro.** Sem chave, sem a
  migration, com o provedor fora do ar ou com `rag.driver` em `off`, a resposta
  é a mesma de antes do `020`. Valor de ambiente **inválido**, esse sim, derruba
  o boot.
- **A unidade é o espaço de embedding**: driver, modelo, dimensões, prefixo de
  documento e prefixo de consulta — os cinco juntos. Trocar qualquer um aponta a
  busca para outro espaço e **nada é apagado**: o acervo anterior fica inteiro,
  pronto para quem voltar atrás.
- **O ambiente semeia, o banco decide.** `RAG_DRIVER` e `RAG_MODEL` só viram
  linha no primeiro boot do admin; dali em diante quem manda é o painel, e um
  `.env` divergente vira aviso no log. Com as chaves é o contrário: vivem só no
  ambiente (§7.4) e o painel nunca as recebe.
- **Três drivers** — `google`, `openai`, `voyage` —, um provedor cada, descritos
  num registro único no `packages/rag`. O processo monta **todos** os que tiverem
  chave e escolhe entre eles por requisição, pelo `rag.driver` do banco.
  `cohere` é recusado com "ainda não foi implementado", mensagem diferente de
  "driver desconhecido" de propósito.
- **O indexador é container à parte**, que sobe no `up -d` e fica parado com o
  driver `off` (§10 — **era**, até a `beta.21`: ~~"perfil `rag`"~~), com modo
  contínuo e `--once`, e separa **refatiar** (de graça) de **embutir** (pago) —
  é o que faz "Reindexar" no painel não custar nada.
- **Painel "Busca semântica"** em Configurações, só para admin: driver, modelo,
  origem de cada valor, estado da chave pelo que o indexador publicou, cobertura,
  pendências e Reindexar. Auditoria: `rag.settings` e `rag.reindex`.
- **O que a entrega não trouxe**, para ninguém ler "implementado" como
  "completo": não existe apagar os vetores de um espaço; a perna vetorial é
  varredura **exata, sem índice** (o HNSW do pgvector para em 2000 dimensões e
  o modelo do Google tem 3072); e não há recorte de escopo da indexação — ligar
  vale para o acervo inteiro, que é o risco da §13.
  **Era**, até a `025`: ~~"a marca de texto recusado pelo provedor vive em
  memória do processo, porque falta no banco a função que o indexador já espera
  (`markRagTextRefused`)"~~ e ~~"nem limpar texto ou vetor órfão"~~ — a `025`
  trouxe as duas: a recusa é gravada em `rag_text_status` e a própria fila a
  exclui, e `collectOrphanRagTexts` apaga, no fim de cada ciclo, o texto sem
  ocorrência e, por cascata, os vetores dele. A mesma migration deu **reserva**
  à fila de textos, então duas réplicas do indexador deixaram de pagar pelo
  mesmo embedding ([`14-rag.md`](14-rag.md) §7 e §7.1).

## 12.6 Quarentena

Desenho em [`15-quarentena.md`](15-quarentena.md). Migration `030`, tabelas
`quarantine_skills` e `quarantine_files`.

- **Um espaço à parte, e pobre de propósito.** Um envio não tem slug, tag,
  ícone, `is_active`, `is_public`, contador, vínculo com vMCP ou catálogo,
  `search_vector` nem `rag_stale`. É uma pasta de arquivos com dono e data.
  A alternativa — "skill em estado rascunho" — obrigaria cada coluna, trigger e
  tela do acervo a aprender a conviver com meia skill.
- **Só a importação alcança a quarentena**, e o destino é escolha de quem
  importa. O formulário de nova skill continua criando direto em produção.
  **Era**, até a importação de bundle: ~~a escolha de destino valia para
  qualquer pacote~~. Hoje ela vale para o pacote de **uma** skill; o pacote com
  duas ou mais skills vai sempre para a fila, e pedir `production` é **400**,
  com a contagem do que foi encontrado
  ([`15-quarentena.md`](15-quarentena.md) decisão 21 e §10).
- **O arquivo é a única verdade.** Ao contrário da skill de produção, em que os
  metadados moram em colunas e o `SKILL.md` gravado é só o corpo, aqui o
  arquivo fica cru, com o frontmatter dentro, e é isso que se edita. Não há
  dois lugares para o mesmo dado, logo não há como discordarem.
- **Não há colisão de nome.** Dois envios do mesmo pacote convivem; o nome é
  rótulo e a identidade é o `uuid`, que também é o endereço no painel.
- **Aprovar cria a skill com quem aprovou como dono**; a skill nasce
  ~~**flutuante**~~ **no destino do envio** — os catálogos e servidores
  escolhidos no upload ou na ficha, na mesma transação, e flutuante só quando o
  destino está vazio —, slug ocupado ganha sufixo, e a linha da quarentena
  some. **Revogado neste ponto por [`15-quarentena.md`](15-quarentena.md)
  decisão 28 (25/09/2026):** o destino é cobrado com `edit` de quem escolhe e de
  quem aprova, e sem acesso a algum item a aprovação é 403 (decisões 30 e 31). Sem um
  `SKILL.md` legível, a promoção é recusada sem apagar nada. **Era**, até a
  revisão de 20/09/2026: ~~o dono era quem submeteu~~ — e aí o editor que
  aprovava envio alheio deixava de enxergar a skill que acabara de criar (404),
  o que a validação mediu ([`15-quarentena.md`](15-quarentena.md) decisão 7).
- **Pacote torto entra na fila**: sem `SKILL.md` **ou** com um que não é UTF-8.
  A cobrança das duas coisas é da aprovação — é para isso que o espaço existe.
- **A edição de uma skill recebe só texto nas duas portas**, multipart e JSON, e
  o envio tem **teto de arquivos** igual ao do pacote.
- **Quem aprova é configuração da instalação** (`quarantine.approvers`:
  `admin`, `admin+owner` — o padrão — ou `admin+editor`). Revisar é de quem
  enxerga a fila (dono, admin e editor); a política decide só o ato de criar a
  skill. Auditoria: `quarantine.create/update/delete/promote/settings`.
- **A edição de uma skill passou a receber só texto**, e o `.zip` saiu dela
  (revoga a §4 no ponto marcado ali). Pacote tem um caminho só: a importação.
- **O que a entrega não trouxe**: varredura do conteúdo, prazo ou cota da fila,
  notificação de envio pendente, rascunho sem importação e promoção que já
  publica num servidor.

## 12.7 Clonagem

Desenho em [`16-clonagem.md`](16-clonagem.md). Migration `031`, que só
acrescenta três ações ao CHECK de `audit_log.action` — clonar não pediu tabela
nem coluna nova.

- **Três tipos, um botão.** Skill, catálogo e MCP virtual ganham "Clonar" na
  ficha e na linha da lista; o diálogo vem com nome e slug preenchidos e
  editáveis, e confirmar leva à ficha da cópia. Fica **fora** da paleta de
  comandos, por escolha do mantenedor: clonar é sempre sobre um objeto
  determinado.
- **A cópia nasce fechada.** `is_public` e `is_open` são falsos mesmo quando o
  original é público ou aberto; `is_active` é copiado. Um clone que nascesse
  aberto publicaria o conteúdo do original num endereço novo, sem passar pelo
  aviso de exposição da decisão 15 do
  [`12-acesso-granular.md`](12-acesso-granular.md). Pelo mesmo motivo o clone
  de vMCP não toca `settings.default_virtual_mcp`.
- **O que cada tipo leva.** Skill: propriedades, arquivos e tags — nasce
  flutuante e sem concessão. Catálogo: propriedades e membros, com o
  `is_active` de cada participação. vMCP: propriedades, vínculos de skill e de
  catálogo (as três portas e as posições do canvas), o `layout` e as
  **concessões**. Contadores zerados nos três, inclusive os do vínculo em
  `virtual_mcp_skills`.
- **Chave `psv_` não é copiável**, e por isso não é copiada: o segredo nunca
  esteve no banco (só o hash scrypt) e `prefix` é `UNIQUE` global. A cópia
  nasce sem chave.
- **Quem clona precisa de `edit` no objeto e do papel de criar** (`editor` ou
  `admin`) — um `membro` não clona nem o que é dele. No vMCP o mínimo sobe
  para **`manage`**, porque a cópia leva a ACL e ler a ACL é poder de `manage`
  (decisão 11 do [`12-acesso-granular.md`](12-acesso-granular.md)).
- **O dono é quem clonou**, e o dono do original não ganha nada na cópia —
  dono não tem linha na ACL, então não há o que copiar. Consequência aceita:
  quando alguém clona o servidor de outro, os convidados entram na cópia e o
  dono original, não.
- **Slug pelo desempate de sempre** (`-2`, `-3`… pelo `uniqueSlug`, o mesmo da
  promoção da quarentena); slug **pedido** e ocupado é 409, slug **derivado**
  nunca conflita.
- **Clonar não custa embedding.** `rag_vectors` é endereçado por
  `(space_uuid, text_sha256)` e o texto de metadados é nome, descrição e tags:
  conteúdo idêntico reaproveita os vetores que já existem, e a cópia só gera
  texto novo se a pessoa mudar o nome. A skill clonada nasce `rag_stale`
  mesmo assim — refatiar é de graça.
- **Auditoria**: `skill.clone`, `catalog.clone` e `mcp.clone`, a linha no
  objeto **novo**, com `target_label` em `<slug de origem> -> <slug da cópia>`,
  a gramática de `quarantine.promote`.
- **O que a entrega não trouxe**: clonagem profunda (clonar um servidor não
  duplica as skills dentro dele), clonar envio da quarentena, clonagem em
  lote, e qualquer vínculo entre original e cópia depois do `INSERT`.

## 12.8 A extensão de skills do MCP (SEP-2640)

Desenho em [`17-skills-extension.md`](17-skills-extension.md). **Sem
migration**: `files.content_sha256` veio da `020` e `size_bytes` da `001`, e
nenhuma decisão criou coluna, CHECK ou valor de enum.

- **Três métodos novos no mcp-public**, em handlers de baixo nível com schemas
  Zod escritos à mão (o SDK 1.30.0 não tem nada de skills): `skills/list`,
  `skills/get` e `resources/directory/read`. A capability sai como
  `extensions: { 'io.modelcontextprotocol/skills': { directoryRead: true } }`,
  incondicional e antes do `connect`, como as duas atuais.
- **A URI mudou.** `skill://<slug>` era o SKILL.md e passou a ser o
  **diretório** da skill; o arquivo é `skill://<slug>/SKILL.md`, e cada anexo é
  um resource irmão em `skill://<slug>/<caminho>`. Não havia como conviver: sob
  a SEP a mesma URI significaria arquivo numa porta e diretório na outra. Isso
  revoga a decisão 5 do [`06`](06-publicacao-mcp.md).
- **A extensão ficou na porta `as_skill`**, não numa quarta flag. Aquela porta
  já entrega todo arquivo por `get_skill_file` e pela URL de download, então a
  extensão é uma segunda porta, conformante, sobre o mesmo conjunto — nenhuma
  exposição nova. `as_resource` continua servindo **só** o `SKILL.md`, agora no
  endereço novo, e governa sozinha o `resources/list`.
- **O manifesto é real, e o digest do `SKILL.md` é calculado na hora.** O
  `content_sha256` daquela linha é o hash do **corpo gravado, sem frontmatter**,
  e o que a leitura devolve é o composto: publicar aquele hash faria toda skill
  falhar na verificação de todo host, em silêncio. O digest sai do mesmo
  `composeSkillMd` que serve o conteúdo, e o `frontmatter` da entrada, do
  `frontmatterObject` que espelha o `buildFrontmatter`.
- **Um cache de processo** guarda `{digest, size}` por `(uuid, updated_at)`,
  com teto de entradas. Sem ele, `skills/list` leria o corpo de todo `SKILL.md`
  do vMCP a cada chamada — e num vMCP aberto não há credencial que segure a
  repetição.
- **Binário passou a sair em `blob`** base64 no `resources/read`, sob o mesmo
  `MCP_MAX_FILE_TEXT_BYTES`. A URL de download que as ferramentas devolvem não
  serve ali: sob a SEP o arquivo está no manifesto, e recusá-lo é falha de
  verificação.
- **Contadores inalterados na prática**: o `resources/read` do `SKILL.md` conta
  `view`/`resource`, como já contava; arquivo de apoio não conta, e
  `skills/list`/`skills/get` não contam nada — são catálogo, não leitura.
- **Campos da revisão 2026-07-28 escritos à mão**: `resultType: "complete"` em
  todo resultado, mais `ttlMs: 0` e `cacheScope` (`public`/`private` conforme
  `is_open`) nas listagens e leituras que aquela revisão enumera. `ttlMs` é
  zero de propósito — é a mesma promessa que a `§5.2` do `06` recusou ao não
  declarar `listChanged`. `tools/list` fica de fora: é montado pelo `McpServer`
  e o SDK lança se registrarmos um handler para um método que já tem um.
- **O painel avisa** quando a skill passa dos tetos da SEP (512 arquivos ou
  16 MiB somados), na guia Arquivos da ficha. A skill continua sendo servida —
  o teto é `SHOULD NOT` para o servidor —, mas hosts conformantes podem
  recusá-la.
- **Fora do v1**: o lado cliente (importar skills de MCP externo), `license` e
  `compatibility` como colunas, skills aninhadas publicadas, paginação de
  `skills/list`, e a subida para o protocolo 2026-07-28 — que remove as sessões
  de protocolo e é projeto próprio.

## 12.9 Painel: a tela de Atividade

Desenho em [`18-atividade.md`](18-atividade.md). Migration `032-atividade.sql`,
que cria `mcp_call_counters` e **quatro** índices: os dois dela
(`mcp_call_counters_bucket_idx`, a faixa das duas leituras, e
`mcp_call_counters_virtual_mcp_idx`, a varredura do `ON DELETE SET NULL`) e os
dois que faltavam em `mcp_sessions` — `started_at`, para as sessões abertas no
dia, e `ended_at`, para as encerradas nele.

- **Uma grade de dias e o relatório de um deles.** Uma célula por dia, a cor
  pela soma das quatro fontes do dia — sessões abertas, chamadas MCP, leituras
  de skill e eventos da trilha —, e o dia clicado abre abaixo o relatório
  agregado. **Só admin**, como a Auditoria, e no mesmo bloco da sidebar; sem
  recorte por vMCP na v1.
- **Três tabelas que já existiam, lidas por dia pela primeira vez**:
  `mcp_sessions` (`015`), `skill_accesses` (`018`) e `audit_log` (`001`). A
  quarta parcela é nova: nada contava **quantas chamadas** o MCP público
  atendia — `request_count` conta requisições por sessão sem dizer o quê, e
  `initialize`, `tools/list` e `ping` não deixavam rastro nenhum.
- **A escala de cor é relativa ao período**, não absoluta: não existe um
  "muito" que sirva a uma instalação de time e a um MCP aberto ao mesmo tempo,
  e faixas fixas deixariam a grade apagada num caso e saturada no outro. O
  nível é o **quartil da posição** do dia entre os dias com atividade da grade,
  com o maior total sempre no tom cheio — e não a razão pelo maior total, que
  bastaria um pico raro para pintar o ano inteiro de quase-vazio (`18` `§3.2`).
- **O dia é o de quem olha**, e a conversão de dia em instantes é a mesma
  `auditRange` da trilha — uma segunda convenção de data no painel foi o que
  produziu a janela de 27 horas do `tasks/044`. O fuso IANA vai ao SQL **só**
  na série, que é onde o `GROUP BY` recorta o dia; o relatório recebe dois
  instantes e devolve contagens.
- **A contagem de chamadas é um contador agregado em balde de 15 minutos**
  (`MCP_CALL_BUCKET_MS`), acumulado em memória pelo rastreador do mcp-public e
  despejado no mesmo flush que já grava `request_count`. Quinze minutos porque
  todo deslocamento IANA é múltiplo disso (o `+05:45` do Nepal é o extremo):
  a meia-noite de qualquer fuso cai numa borda de balde. Uma linha por chamada
  seria a maior tabela da instalação — `tools/list` e `ping` são o caminho
  quente — numa promessa de "nunca apagar".
- **As famílias são por prefixo** — `tools`, `resources`, `prompts`, `skills`,
  `session`, `other` —, e não por lista fechada: método novo do protocolo tem
  de **aparecer**, não sumir. `resources/directory/read` conta como `skills`,
  porque lê a árvore de uma skill.
- **Nada identifica ninguém.** A contagem nova não guarda nome de tool,
  argumento, IP, e-mail nem `session_id`, e o relatório inteiro é agregado: a
  menor unidade é "quantas vezes". Quem precisa do evento a evento tem a
  trilha, as sessões e a guia Auditoria da skill.
- **Os números têm limites escritos** (`18` §7): chamada recebida não é chamada
  bem-sucedida, o que é recusado antes do rastreador (429, lote, 403/404 de
  sessão) não entra, o agrupamento do stateless faz a contagem de clientes ser
  um piso, o mcp-admin não tem rastreador de sessões e a contagem de chamadas
  só existe a partir da migration.
- **Revoga o "fora do escopo" de quatro documentos**, cada um marcado no ponto:
  o item de estatísticas de uso do [`10`](10-admin-canvas-e-sessoes.md) (`§9`),
  o "leituras por dia" do [`13`](13-fichas-e-acessos.md) (`§8`) e a estatística
  por vMCP do [`08`](08-mcp-virtual.md) (`§9`) e do
  [`09`](09-mcp-padrao-e-skills-flutuantes.md) (`§6`).
- **Fora do escopo**: nome de tool e argumentos na contagem, poda automática,
  E2E da tela, série por hora, número por cliente e recorte por vMCP.

## 12.10 Username: o identificador público, e o e-mail de volta ao privado

Desenho em [`19-username.md`](19-username.md). Migration `033-username.sql`.

- **`users.username`, obrigatório e único** por `lower(username)`, ocupa o lugar
  que o e-mail ocupava em toda superfície que nomeia uma conta: dono, lista de
  concessões, "concedido por", guia Acessos, busca de contas, rótulos da trilha
  e — pela primeira vez — a ficha pública do site, que passa a creditar `@dono`.
- **O e-mail não sumiu: voltou a ser privado.** Continua obrigatório e único,
  porque o link de redefinição vai por ele e o vínculo OIDC casa por ele
  (`05` §2.4 e §2.6). O que mudou é quem o vê: **só a própria conta e um
  admin**. Antes, uma conta `membro` recém-criada lia o endereço de todo mundo
  digitando duas letras na busca de contas.
- **Um campo só no login**, "usuário ou e-mail": tem `@`, é e-mail; não tem, é
  username. A regra só fecha porque `normalizeUsername` recusa `@` — e é isso,
  não uma heurística, que a torna decidível.
- **O e-mail deixou de ser aceito também na entrada.** As rotas de concessão são
  `/access/:username`, as nove tools do mcp-admin recebem `username`, e a busca
  de contas **não casa** mais por endereço: devolver só o username e continuar
  casando por e-mail deixaria qualquer conta logada descobrir a qual username um
  endereço corresponde. Quebra quem integrava pela REST.
- **O histórico congelado foi reescrito.** `audit_log.actor_label`/`target_label`
  e `skill_accesses.user_email` guardavam endereços em texto; a `033` os troca
  por username onde a conta existe e apaga a coluna `user_email`. A guia Acessos
  era o pior caso: é de `manage`, não de admin, então o dono de uma skill via o
  e-mail de todo mundo que a leu.
- **Username abandonado nunca volta a circular** (tabela `usernames`): sem isso,
  o `@joao` de uma trilha de 2025 poderia ser outra pessoa em 2026. Trocar é de
  admin, e a troca entra na trilha como `user.username`, com `<antigo> -> <novo>`.
- **O backfill sai do `name`**, nunca da parte antes do `@`: publicar o local
  part para todo o painel vazaria metade do endereço — exatamente o que esta
  mudança existe para fechar.
- **Revoga**, cada um marcado no ponto: o "a conta é o e-mail" do `§5.3` do
  [`12`](12-acesso-granular.md) (o bloco do relatório 011), a parte "busca por
  nome/e-mail" da decisão 13 e a parte do site da decisão 11. O
  [`05`](05-accounts-and-roles.md) leva a marca no cabeçalho, pelos rótulos de
  auditoria. Conferi o [`13`](13-fichas-e-acessos.md) e o
  [`18`](18-atividade.md): as guias ficam como estão e a tela de Atividade não
  tem recorte por conta — nada a revogar neles.
- **Fora do escopo**: trocar o próprio username (só admin troca), username no
  MCP público, e-mail opcional, e um resultado de busca diferente por papel.

## 12.11 Perfil de usuário

Desenho em [`20-perfil.md`](20-perfil.md). Migration `034-perfil.sql`.

- **O que o perfil é**: o nome de exibição que já existia (`users.name`, que
  passa a ser editável pelo dono), uma **foto**, e um bloco público e opcional
  com descrição, site e até oito links.
- **A foto é upload, guardado no banco** e servido pelo produto — não é URL. Um
  `<img src>` externo numa página anônima entrega o IP de cada visitante ao dono
  daquele host, e a página do perfil é anônima por definição. O tipo sai dos
  **bytes iniciais**, nunca da extensão nem do `Content-Type`: os dois são texto
  que quem envia escolhe. **SVG é recusado** — é XML com `<script>` dentro, e
  servi-lo na origem do site seria execução de código de terceiro na página.
- **Duas tabelas, e a separação é o ponto**: `user_profiles` (texto e flags) e
  `user_avatars` (bytes). Com a imagem na mesma linha, toda leitura de perfil —
  e a ficha de skill lê o dono — arrastaria até 512 KB para descartar.
- **Público é opt-in, desligado por padrão.** Bio, foto e links são
  auto-expressão, não metadado do acervo; a migration não liga nada e não cria
  linha nenhuma — ela nasce no primeiro salvamento.
- **Uma quarta rota pública no site**, `/u/<username>`, com as skills e os
  catálogos **já públicos** da pessoa. Perfil privado, conta desativada e
  username inexistente respondem o **mesmo 404**: distingui-los diria "esta
  conta existe, mas não quer ser vista".
- **Indexa normalmente.** O opt-in é o consentimento; um `noindex` por cima
  dele seria o produto discordando de quem ligou o perfil.
- **Quem escreve é o dono.** O admin tem só "limpar perfil" — apaga os campos
  públicos, desliga o público e apaga a foto, com linha na trilha
  (`user.profile`). Não existe caminho em que um admin escreva texto assinado
  por outra pessoa. A edição do **próprio** perfil não entra na trilha, pelo
  critério que já mantém o login fora dela.
- **`ownerHasProfile` é o único dado de perfil que viaja na ficha da skill**: um
  booleano que diz se o `por @fulano` vira link. Bio, foto e links ficam na
  rota do perfil.
- **Não revoga nada**, e isso foi conferido documento a documento — o `19`, o
  `12`, o `13`, o `05` e o `18` seguem inteiros (`20` no cabeçalho).
- **Fora do escopo**: seguir/curtir/comentar, redimensionar a foto, índice de
  pessoas no site, perfil no MCP e e-mail de contato público.

## 12.12 CLI de contas (`purple-admin`)

Desenho em [`21-cli-admin.md`](21-cli-admin.md). Sem migration.

- **Uma CLI na imagem do painel**, `docker compose exec admin purple-admin
  <comando>`: listar e mostrar contas, criar (`user add`), definir a senha
  (`user passwd`, sorteando uma temporária quando ela é omitida), mudar o papel,
  desativar, reativar, destravar o login e derrubar as sessões.
- **As mesmas funções das rotas de `/api/users*`**: validação, `token_version`,
  proteção do último admin e trilha são as do painel. Na trilha o ator é `cli`,
  sem conta, com origem `web-admin`.
- **A primeira conta continua sendo `admin`**: com `users` vazia, `user add`
  recusa outro papel, e o admin criado adota os órfãos como o do `/setup`.
- **Senha pela entrada padrão** (`--password-stdin`) é o caminho recomendado; a
  `--password` fica no histórico e na lista de processos.
- Revoga em parte o `05` `§2.3` ("escolhido em vez de CLI"); o `/setup` segue
  sendo o caminho do primeiro administrador.

## 13. Riscos aceitos conscientemente (v1)

Para manter o software "simples, bonito e pontual" conforme pedido, as
seguintes limitações foram aceitas deliberadamente e podem ser
endereçadas em versões futuras:

- Contadores de view/download podem ser inflacionados trivialmente (sem
  dedup, sem rate limiting).
- Sem limite por skill (soma dos arquivos) — possível abuso de armazenamento
  no Postgres, dentro dos tetos de cada requisição.
- Sem histórico/versionamento de arquivos — edições sobrescrevem o estado
  atual (apenas um log de auditoria simples, sem restore).
- `audit_log` cresce sem política de retenção. Os eventos de conta acrescentam
  pouco volume (login e falha de login **não** são auditados, §2.8 da spec),
  mas a decisão de quando podar continua em aberto.

**Endereçados pela entrega de contas e papéis** (§7.1): o login ganhou rate
limiting, e o `audit_log` passou a registrar o ator (`actor_user_uuid` /
`actor_label`) além da superfície, com revogação individual por
`token_version`.

**Risco residual introduzido por ela**, documentado na §2.4 da spec: a
vinculação de um login OIDC a uma conta local é sempre **pelo e-mail**. Um
provedor que permita a alguém declarar um endereço arbitrário dentro de um
domínio autorizado consegue assumir a conta correspondente, inclusive a de um
administrador. A mitigação é operacional — aponte `OIDC_ISSUER` para um
provedor que você controla e mantenha `OIDC_ALLOWED_DOMAINS` restrita a
domínios sob sua administração. Com a lista vazia o SSO inteiro é recusado: a
instalação falha fechada e só o login local funciona.

**Riscos introduzidos pelo MCP virtual** ([`08`](08-mcp-virtual.md) §8): um
virtual aberto (`is_open`) com skill privada dentro é publicação de fato —
~~protegida só pela confirmação explícita~~, que o PR2 do `09` removeu de
propósito (decisão 9 e `§4.4`) junto com o `400 confirm_open_required`. O que
vale é o **aviso inline, sem confirmação**, da decisão 15 do
[`12`](12-acesso-granular.md): ele informa, não impede, e a exposição por
`view` é risco aceito em `12` §10. A diferença 404/401 sob `/virtual/`
permite enumerar os slugs dos MCPs; e o virtual é a primeira entidade com dono
— a exceção ao "papel limita a ação, não o escopo" da `§7.1`, que o `12`
generalizou a skills e catálogos.

**Riscos introduzidos pelo painel novo e pelas sessões**
([`10`](10-admin-canvas-e-sessoes.md) §8): cada gesto no canvas é uma
escrita imediata, sem desfazer; o stateless agrupa clientes por IP + agente
+ credencial, então dois clientes iguais atrás do mesmo NAT contam como um;
`mcp_sessions` cresce para sempre, por decisão; as posições do canvas são
compartilhadas, então um administrador reorganiza o canvas de todos.

**Riscos introduzidos pelo MCP padrão e pelas skills flutuantes**
([`09`](09-mcp-padrao-e-skills-flutuantes.md) §5): o vMCP `public` criado na
migração nasce aberto, e quem protegia o principal com `MCP_PUBLIC_KEY` é
avisado só pela trava de boot; trocar o padrão derruba as sessões abertas na
raiz até reconectar; todo MCP virtual aberto é público de fato e listado no
site, sem a confirmação que `08` exigia.

**Riscos introduzidos pelo registro de acessos**
([`13`](13-fichas-e-acessos.md) §7): `skill_accesses` cresce uma linha por
leitura, para sempre, por decisão; as cópias de nome, chave e e-mail
envelhecem (dizem o que aconteceu, não o que é); e quem só administra um
servidor entra na edição da skill com os campos travados, para publicá-la.

**Risco introduzido pela busca semântica** ([`14`](14-rag.md) §4.1 e §12):
com `rag.driver` ligado, o texto de **todo** arquivo de texto de **toda** skill
indexada — inclusive privada — é enviado a um provedor externo, que o lê; no
nível gratuito do Google ele ainda é usado para melhorar produtos e pode ser
lido por revisores humanos. Não há controle de escopo da indexação: a escolha é
ligar ou não ligar, e quem anexa o arquivo não é necessariamente quem liga.
Binário e imagem ficam de fora, e a busca semântica **nasce desligada** — sem
`rag.driver`, nada sai da instalação.
