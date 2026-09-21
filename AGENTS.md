# Instruções para agentes

Vale para qualquer agente que trabalhe neste repositório (Claude Code, Codex,
Cursor, Gemini CLI, …). O arquivo `CLAUDE.md` aponta para cá.

## Divisão de responsabilidades

| Área | Pasta | Dono |
|------|-------|------|
| Banco de dados | `database/` | **agente dba** |
| Homepage do projeto | `apps/homepage/` | agente da homepage |
| Site do catálogo | `apps/site/` | agente do site |
| Painel administrativo | `apps/admin/` | agente do admin |
| MCP público | `apps/mcp-public/` | agente do mcp-public |
| MCP administrativo | `apps/mcp-admin/` | agente do mcp-admin |
| Utilitários comuns | `packages/shared/` | quem precisar, com cuidado — é usado pelos **seis** apps, pelo `rag` e pelo `database` |
| Busca semântica | `packages/rag/` | agente do rag |
| Indexador do RAG | `apps/indexer/` | agente do indexador |

## Regra do banco de dados

**O banco é do agente dba e vive inteiro em `database/`.** Antes de qualquer
tarefa que leia ou grave dados, leia a especificação:
[`database/README.md`](database/README.md).

O que todo agente **fora** de `database/` deve seguir:

- Acesse o banco **só** pelo pacote `@purple-skills/db`
  (`import { getDb, listSkills, … } from '@purple-skills/db'`). As funções
  disponíveis estão listadas na especificação.
- **Não** escreva SQL, DDL ou migration fora de `database/schema/`.
- **Não** crie `pg.Pool`/`pg.Client` próprio nem leia `DATABASE_URL`/`PG*`
  diretamente — use `getDb()`.
- **Não** declare serviços `postgres`, `migrate` ou `seed` em nenhum compose:
  eles são definidos em `database/docker-compose.yml` e incluídos pela raiz.
  *Override* não é declaração: ajustar um serviço que já existe — como o
  `postgres: ports: !reset []` do `docker-compose.traefik.yml`, que despublica a
  porta do banco atrás do proxy — é permitido, e o nome do serviço tem de
  aparecer para isso. O que a regra proíbe é `image`, `build`, `command`,
  `volumes` ou `environment` de banco fora de `database/`.
- **Não** rode `drizzle-kit generate`/`push`. `database/src/schema.ts` é
  tipagem; a fonte de verdade são os arquivos `database/schema/nnn-nome.sql`.
- Precisa de uma coluna, índice ou query que não existe? É trabalho do dba —
  peça, não improvise no seu app.

O agente dba, por sua vez, fica **confinado a `database/`**: ele não edita
`apps/` nem `packages/`. Quando uma mudança de schema quebra um app, ele
descreve o impacto e a correção fica com o agente daquele app.

## Regra da busca semântica

`packages/rag/` é o único lugar que fala com o provedor de embeddings. Ele não
importa `@purple-skills/db` e não acessa o banco: recebe texto, devolve vetor.
Quem grava é o dba, pelas funções `rag*` de `@purple-skills/db`.

O que todo agente **fora** de `packages/rag/` deve seguir:

- Não chame a API do provedor direto, e não monte `fetch` para ela. Use o
  driver (`criarDriver`, `embedDocuments`, `embedQuery`).
- Não leia `RAG_<DRIVER>_API_KEY` por conta própria — o segredo entra pelo
  `readSecret` do `shared` e vai para o driver, nunca para log ou URL.
- Não repita a lista de variáveis do RAG nem a de drivers e modelos: elas vivem
  uma vez só, nos registros `RAG_SETTINGS` e `RAG_DRIVERS`.
- Não escolha o driver no boot. Quem escolhe é o `rag.driver` do **banco**, a
  cada uso; o container monta todos os que tiverem chave
  (`criarDriversDoAmbiente`) e deixa o painel decidir.
- **O texto guardado no banco nunca leva o prefixo do driver.** Quem aplica o
  prefixo é o driver, na hora da chamada; é isso que deixa o mesmo texto servir
  a espaços diferentes.

O desenho está em [`docs/14-rag.md`](docs/14-rag.md).

## Homepage e site são páginas diferentes

`apps/homepage/` apresenta o **projeto** e leva o visitante ao GitHub. Ela é
estática: não importa `@purple-skills/db`, não chama API nenhuma e não mostra
skill cadastrada — o que estiver lá tem que valer para qualquer instalação.

`apps/site/` é a página **do usuário** de uma instalação: lista as skills e
os catálogos tornados públicos, ensina a configurar o `mcp.json` e mostra os
endereços de acesso (MCP público, MCP administrativo e painel). Ela não explica
o que é o projeto. No site, "skill" e "catálogo" são coisas diferentes — a lista
de skills não é "o catálogo" (ver `docs/03-implementation-notes.md`, "Site:
skills e catálogos públicos").

Ao mexer no visual, saiba **quem copia de quem**, porque copiar para o app
errado apaga uma interface inteira:

- `tokens.css`, `base.css` e `chrome.css` são cópias byte a byte **entre a
  homepage e o site**, e só entre esses dois.
- `markdown.css` é cópia byte a byte **entre o site e o painel**.
- O painel **não** entra na cópia dos três primeiros: desde o
  [`10`](docs/10-admin-canvas-e-sessoes.md) ele é um console com paleta e
  primitivos próprios em `apps/admin/web/src/styles/` (e não tem `chrome.css`).
  Sobrescrever esses arquivos com os do site destrói o console — e "funciona",
  só fica errado.

Mudou um arquivo copiado? Copie para o par no mesmo commit; os comandos e a
lista completa estão em [`docs/04-design-system.md`](docs/04-design-system.md).

## Convenções gerais

- Monorepo com npm workspaces; Node.js **22.15+** e TypeScript estrito. O
  `engines` do `package.json` é `>=22.15`, e não o `22+` de antes: o
  `zstdDecompressSync` do `node:zlib`, que a leitura de pacote importa, só
  existe a partir do 22.15 — e o que falha num 22.0–22.14 não é o caminho
  `.zst`, é a **ligação** do módulo, que derruba o `@purple-skills/shared`
  inteiro e todo serviço que o importa. As imagens não sentem (são
  `node:24-alpine`); quem roda fora do Docker, sim.
- Comentários, mensagens de erro, log e documentação em **português**.
- **Endereço e descrição de tool em inglês.** Caminho e query string de toda
  superfície (painel, site, homepage, MCP público e administrativo) e o
  `title`/`description`/`describe` das tools dos dois MCPs, mais as
  `instructions` que eles mandam no `initialize`, são escritos em inglês: são
  interface de máquina, e o que sai do MCP é lido por cliente e modelo de fora
  deste repositório. A regra acima continua valendo para todo o resto — inclusive
  a mensagem de erro que uma tool devolve. O mapa do que foi renomeado está em
  [`docs/03`](docs/03-implementation-notes.md#endereços-em-inglês).
- `npm run typecheck` e `npm test` precisam passar antes de entregar. O
  `typecheck` **inclui os arquivos de teste**: cada workspace tem um
  `tsconfig.typecheck.json` (o de build mais `"exclude": []`), porque o Vitest
  transpila sem checar tipo e o `tsconfig.json` de build exclui `*.test.ts` — o
  `dist/` das imagens não leva teste, e isso não muda.
- Nenhum `.env*` versionado além de `.env.example`, sempre com `CHANGE_ME` no
  lugar de cada segredo.
- Decisões de arquitetura em [`docs/02-architecture-decisions.md`](docs/02-architecture-decisions.md);
  desvios e detalhes de implementação em [`docs/03-implementation-notes.md`](docs/03-implementation-notes.md);
  design em [`docs/04-design-system.md`](docs/04-design-system.md).
- **Não rode `prettier` (nem `npx prettier --write`) em arquivo deste
  repositório.** Não existe `.prettierrc`, então o que sai da ferramenta é o
  padrão dela, não o estilo do projeto: uma passada num arquivo de `database/`
  reformatou 842 linhas e precisou ser desfeita à mão. Formate igual ao que está
  em volta, no arquivo que você está editando.
- **Nunca deixe um byte de controle literal num arquivo-fonte.** Precisa do
  caractere numa string ou num teste? Monte-o em código
  (`String.fromCharCode(0)`), como `database/src/queries.ts` faz — **escrever o
  escape não basta**: há ferramenta de edição que o "resolve" de volta para o
  byte cru ao gravar, e foi assim que três arquivos deste repositório
  adoeceram. Dentro de uma faixa de regex o escape é a única forma e está
  correto (`/[\x00-\x1f]/`). O que o byte causa: quando é o nulo, o git trata o
  blob como **binário** — o diff vira "Binary files differ" e o `gitleaks`, que
  lê o histórico por diffs, deixa de enxergar aquelas linhas; o `grep` recusa o
  arquivo em qualquer caso. O CI tem uma guarda (`Nenhum byte de controle nos
  fontes`) que olha os **bytes**, e não o veredito do git, porque o git só
  procura o nulo nos primeiros 8 000 bytes. Ao descrever um desses caracteres em
  documento ou relatório, escreva `U+0000`, não o caractere.
- **Regra revogada não se apaga, se marca.** O projeto guarda o histórico de
  decisão de propósito: risque o texto antigo com `~~…~~` e ponha ao lado uma
  citação **Revogado neste ponto por `NN`**, com o link do documento que revogou,
  ou transforme-o num parágrafo "**Era**, até …". Documento com trecho revogado
  leva também a marca no topo, e
  o documento que revoga enumera no cabeçalho os que ele revoga — é o que
  `08`, `09`, `10`, `11` e `12` fazem. Vale para `docs/**` e para os relatórios
  de `tasks/`.
