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
o projeto usa um **runner próprio** (`packages/db/src/migrate.ts`, ~60 linhas):
lê `packages/db/migrations/*.sql` em ordem, aplica cada uma em transação e
registra em `schema_migrations`. Motivo: zero dependência extra em runtime,
arquivos SQL legíveis e revisáveis, e o mesmo binário serve para o passo
`migrate` do compose. O Drizzle continua sendo usado como schema + query
builder.

## Busca full-text

- Configuração **`simple`** (sem stemming) em vez de `portuguese`/`english`: o
  conteúdo do catálogo é misto (pt + en + trechos de código) e um stemmer
  específico degradaria metade dos casos.
- Pesos: `name` = A, `description` = B, `SKILL.md` = C.
- Consulta com `websearch_to_tsquery` (aceita `"frase exata"`, `-excluir`,
  `or`), com **fallback `ILIKE`** em nome/descrição/slug para termos parciais —
  a extensão `pg_trgm` e um índice GIN trigram tornam isso barato.
- O trigger de reindexação **pula** updates que só mexem nos contadores
  (`view_count`/`download_count` mudam sem tocar `updated_at`), evitando
  recalcular o `tsvector` a cada acesso.

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

## Sessão do painel

- Cookie assinado com HMAC-SHA256, `httpOnly`, `SameSite=Lax`, TTL de 12h
  (configurável por `ADMIN_SESSION_TTL`). Sem session store, como pedido.
- `ADMIN_SESSION_SECRET` é **opcional**: se ausente, é derivado da senha. O
  serviço sobe sem configuração extra e trocar a senha invalida as sessões
  antigas — que é o comportamento desejado.
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

## Portas

| Serviço | Porta |
|---------|-------|
| site | 3000 |
| admin | 3001 |
| mcp-public | 3002 |
| mcp-admin | 3003 |

## O que foi verificado

- 78 testes unitários (Vitest) em `packages/shared` e nos handlers das duas
  famílias de ferramentas MCP.
- Smoke test manual contra o stack em Docker: os **três transportes** (
  Streamable HTTP com sessão, stateless e SSE legado) nos **dois** servidores
  MCP, CRUD completo pelo MCP admin, propagação de visibilidade para o site,
  reindexação da busca por trigger, contadores, download `.zip` com binários
  preservados, autenticação do painel e do MCP admin.
