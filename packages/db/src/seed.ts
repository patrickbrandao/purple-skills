#!/usr/bin/env node
/** Popula o banco com skills de exemplo — útil para demo/desenvolvimento. */
import { closeDb } from './client.js';
import { createSkill, getSkillSummary, setFile } from './queries.js';

type Seed = {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  isPublic: boolean;
  skillMd: string;
  extraFiles?: { path: string; content: string }[];
};

const SEEDS: Seed[] = [
  {
    slug: 'commit-conventional',
    name: 'Conventional Commits',
    description:
      'Escreve mensagens de commit no padrão Conventional Commits a partir do diff em staging.',
    tags: ['git', 'workflow', 'produtividade'],
    isPublic: true,
    skillMd: `---
name: Conventional Commits
description: Escreve mensagens de commit no padrão Conventional Commits a partir do diff em staging.
---

# Conventional Commits

Gere mensagens de commit consistentes seguindo a especificação
[Conventional Commits](https://www.conventionalcommits.org/).

## Quando usar

Sempre que houver mudanças em staging e o usuário pedir um commit.

## Passos

1. Rode \`git diff --staged\` e leia todas as mudanças.
2. Classifique a mudança em um tipo:
   - \`feat\` — nova funcionalidade
   - \`fix\` — correção de bug
   - \`docs\` — apenas documentação
   - \`refactor\` — mudança sem alterar comportamento
   - \`test\` — testes
   - \`chore\` — build, deps, tooling
3. Escolha um escopo curto (o módulo/pasta afetado).
4. Escreva o assunto no imperativo, com no máximo 72 caracteres.

## Formato

\`\`\`
<tipo>(<escopo>): <assunto>

<corpo opcional explicando o porquê>
\`\`\`

## Exemplos

\`\`\`
feat(auth): adiciona login por token de sessão
fix(db): corrige contador de downloads em transações concorrentes
\`\`\`
`,
    extraFiles: [
      {
        path: 'reference/types.md',
        content: `# Tabela de tipos

| tipo | quando usar |
|------|-------------|
| feat | nova funcionalidade visível ao usuário |
| fix | correção de comportamento incorreto |
| perf | melhoria de performance |
| docs | somente documentação |
| style | formatação, sem mudança de código |
| refactor | reorganização sem mudança de comportamento |
| test | adição/ajuste de testes |
| build | sistema de build ou dependências |
| ci | pipelines de integração contínua |
| chore | tarefas de manutenção |
`,
      },
    ],
  },
  {
    slug: 'code-review-checklist',
    name: 'Code Review Checklist',
    description:
      'Revisa um diff procurando bugs de correção, casos de borda e simplificações possíveis.',
    tags: ['review', 'qualidade', 'workflow'],
    isPublic: true,
    skillMd: `---
name: Code Review Checklist
description: Revisa um diff procurando bugs de correção, casos de borda e simplificações.
---

# Code Review Checklist

## Correção

- [ ] Casos de borda: entrada vazia, \`null\`, listas de um elemento
- [ ] Erros são tratados ou propagados de forma explícita
- [ ] Operações assíncronas têm \`await\` e tratamento de rejeição
- [ ] Concorrência: leitura-modificação-escrita virou operação atômica?

## Segurança

- [ ] Entrada do usuário é validada antes de chegar ao banco
- [ ] Consultas SQL são parametrizadas
- [ ] Segredos não aparecem em logs

## Simplicidade

- [ ] Existe função utilitária que já faz isso no projeto?
- [ ] Alguma abstração introduzida tem menos de dois usos reais?
- [ ] O nome revela a intenção?

## Testes

- [ ] Cada bug corrigido ganhou um teste que falha sem a correção
- [ ] Os testes descrevem comportamento, não implementação
`,
  },
  {
    slug: 'postgres-full-text-search',
    name: 'Busca Full-Text no PostgreSQL',
    description:
      'Modela busca textual em PostgreSQL com tsvector, pesos por coluna, índices GIN e ranking.',
    tags: ['postgres', 'banco-de-dados', 'busca'],
    isPublic: true,
    skillMd: `---
name: Busca Full-Text no PostgreSQL
description: Modela busca textual com tsvector, pesos por coluna, índices GIN e ranking.
---

# Busca Full-Text no PostgreSQL

## Coluna indexada

Mantenha uma coluna \`tsvector\` materializada e atualizada por trigger:

\`\`\`sql
ALTER TABLE artigos ADD COLUMN search_vector tsvector;

CREATE INDEX artigos_search_idx ON artigos USING GIN (search_vector);
\`\`\`

## Pesos

Combine colunas com pesos diferentes (A é o mais relevante):

\`\`\`sql
setweight(to_tsvector('simple', coalesce(titulo, '')), 'A') ||
setweight(to_tsvector('simple', coalesce(corpo, '')), 'B')
\`\`\`

## Consulta

Prefira \`websearch_to_tsquery\` — aceita a sintaxe que o usuário já conhece
(\`"frase exata"\`, \`-excluir\`, \`or\`):

\`\`\`sql
SELECT titulo, ts_rank(search_vector, q) AS rank
FROM artigos, websearch_to_tsquery('simple', $1) q
WHERE search_vector @@ q
ORDER BY rank DESC
LIMIT 20;
\`\`\`

## Dicas

- \`'simple'\` evita stemming preso a um idioma — bom para conteúdo misto.
- Combine com \`pg_trgm\` (\`ILIKE\`) como fallback para termos parciais.
- Só reindexe quando as colunas de origem mudarem, não a cada \`UPDATE\`.
`,
  },
  {
    slug: 'dockerfile-node-multi-stage',
    name: 'Dockerfile Node.js multi-stage',
    description:
      'Escreve Dockerfiles Node.js enxutos com build multi-stage, usuário sem privilégios e healthcheck.',
    tags: ['docker', 'nodejs', 'deploy'],
    isPublic: true,
    skillMd: `---
name: Dockerfile Node.js multi-stage
description: Dockerfiles Node.js enxutos com build multi-stage, usuário sem privilégios e healthcheck.
---

# Dockerfile Node.js multi-stage

## Estrutura

\`\`\`dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
\`\`\`

## Regras

1. Copie \`package*.json\` antes do código — a camada de dependências fica em cache.
2. Use \`npm ci\`, nunca \`npm install\`, em imagens.
3. Rode como usuário sem privilégios (\`USER node\`).
4. Fixe a versão base (\`node:22-alpine\`), não use \`latest\`.
5. Adicione \`HEALTHCHECK\` quando o serviço expuser HTTP.
`,
  },
  {
    slug: 'mcp-server-typescript',
    name: 'Servidor MCP em TypeScript',
    description:
      'Cria servidores MCP com o SDK TypeScript, cobrindo stdio, SSE e Streamable HTTP.',
    tags: ['mcp', 'typescript', 'agentes'],
    isPublic: true,
    skillMd: `---
name: Servidor MCP em TypeScript
description: Cria servidores MCP com o SDK TypeScript, cobrindo stdio, SSE e Streamable HTTP.
---

# Servidor MCP em TypeScript

## Definindo o servidor

\`\`\`ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const server = new McpServer({ name: 'meu-servidor', version: '1.0.0' });

server.registerTool(
  'somar',
  {
    title: 'Somar',
    description: 'Soma dois números',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
);
\`\`\`

## Transportes

| transporte | uso |
|------------|-----|
| \`StdioServerTransport\` | servidor local, lançado pelo cliente |
| \`StreamableHTTPServerTransport\` | HTTP moderno, com ou sem sessão |
| \`SSEServerTransport\` | HTTP legado (\`GET /sse\` + \`POST /messages\`) |

## Modo stateless

Para escalar horizontalmente, crie servidor e transporte **por requisição**,
com \`sessionIdGenerator: undefined\`, e feche ambos quando a resposta terminar.

## Erros

Retorne \`{ isError: true, content: [...] }\` para erros de domínio; deixe as
exceções para falhas realmente inesperadas.
`,
  },
  {
    slug: 'rascunho-interno',
    name: 'Rascunho interno (privado)',
    description: 'Exemplo de skill privada — visível apenas no painel administrativo.',
    tags: ['interno'],
    isPublic: false,
    skillMd: `# Rascunho interno

Esta skill está marcada como **privada**: não aparece no site público, na API
REST pública nem no MCP público. Serve para demonstrar o controle de
visibilidade do painel administrativo.
`,
  },
];

async function main() {
  for (const seed of SEEDS) {
    const existing = await getSkillSummary(seed.slug, { includePrivate: true });
    if (existing) {
      console.log(`[seed] já existe: ${seed.slug}`);
      continue;
    }

    await createSkill(
      {
        slug: seed.slug,
        name: seed.name,
        description: seed.description,
        skillMd: seed.skillMd,
        tags: seed.tags,
        isPublic: seed.isPublic,
      },
      'web-admin',
    );

    for (const file of seed.extraFiles ?? []) {
      await setFile(seed.slug, file.path, file.content, 'web-admin');
    }

    console.log(`[seed] criada: ${seed.slug}`);
  }
}

main()
  .then(async () => {
    await closeDb();
    console.log('[seed] concluído');
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[seed] erro:', err.message);
    await closeDb();
    process.exit(1);
  });
