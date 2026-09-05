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
| `GET /skills/:slug/download` | `download_count` +1 |
| MCP `get_skill` | `view_count` +1 |
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

## Armazenamento de arquivos

- Texto vs. binário é decidido pelo **mime detectado por extensão** mais uma
  checagem de bytes nulos — um `.md` com bytes nulos vai para `bytea`, não
  para `text` (Postgres rejeitaria `\0` em `text`).
- Caminhos passam por `normalizeRelativePath`, que rejeita `..`, caminhos
  absolutos e prefixos de drive do Windows.
- Zips com uma **única pasta raiz** (o padrão de `zip -r skill.zip skill/`) têm
  essa pasta removida; `__MACOSX`, `.DS_Store` e `Thumbs.db` são descartados.

## Frontend

- **Dark mode fixo** com paleta roxa. Um tema claro dobraria a superfície de
  ajuste visual sem ganho para um v1 — a decisão é revisável.
- O frontmatter YAML do `SKILL.md` é **removido antes da renderização**: nome,
  descrição e tags já aparecem no cabeçalho da página.
- `react-markdown` sem `rehype-raw`: HTML cru no `SKILL.md` não é renderizado,
  então conteúdo vindo do painel não injeta script.

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

## Portas

| Serviço | Porta |
|---------|-------|
| site | 3000 |
| admin | 3001 |
| mcp-public | 3002 |
| mcp-admin | 3003 |

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
