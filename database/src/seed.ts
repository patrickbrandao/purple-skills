#!/usr/bin/env node
/** Popula o banco com skills de exemplo — útil para demo/desenvolvimento. */
import { closeDb } from './client.js';
import {
  createCatalog,
  createSkill,
  createVirtualMcp,
  getCatalog,
  getSkillSummary,
  getVirtualMcp,
  resolveDefaultVirtualMcp,
  setCatalogSkills,
  setDefaultVirtualMcp,
  setFile,
  setVirtualMcpSkills,
} from './queries.js';

/** Quem assina as linhas de auditoria do seed — não é uma conta. */
const SEED_ACTOR = { userUuid: null, label: 'seed' };

type Seed = {
  slug: string;
  name: string;
  /** Um emoji coerente com o tema: é o que o canvas e os cards do painel desenham. */
  icon: string;
  description: string;
  tags: string[];
  /**
   * Entra no vMCP `public`, nas ferramentas. Uma skill só é exibida onde está
   * vinculada, então a que fica de fora é a demonstração da skill flutuante:
   * existe no painel e em lugar nenhum mais.
   */
  inPublicMcp: boolean;
  skillMd: string;
  extraFiles?: { path: string; content: string }[];
};

const SEEDS: Seed[] = [
  {
    slug: 'commit-conventional',
    name: 'Conventional Commits',
    icon: '📝',
    description:
      'Escreve mensagens de commit no padrão Conventional Commits a partir do diff em staging.',
    tags: ['git', 'workflow', 'produtividade'],
    inPublicMcp: true,
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
    icon: '🔍',
    description:
      'Revisa um diff procurando bugs de correção, casos de borda e simplificações possíveis.',
    tags: ['review', 'qualidade', 'workflow'],
    inPublicMcp: true,
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
    icon: '🐘',
    description:
      'Modela busca textual em PostgreSQL com tsvector, pesos por coluna, índices GIN e ranking.',
    tags: ['postgres', 'banco-de-dados', 'busca'],
    inPublicMcp: true,
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
    icon: '🐳',
    description:
      'Escreve Dockerfiles Node.js enxutos com build multi-stage, usuário sem privilégios e healthcheck.',
    tags: ['docker', 'nodejs', 'deploy'],
    inPublicMcp: true,
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
    icon: '🔌',
    description:
      'Cria servidores MCP com o SDK TypeScript, cobrindo stdio, SSE e Streamable HTTP.',
    tags: ['mcp', 'typescript', 'agentes'],
    inPublicMcp: true,
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
    name: 'Rascunho interno (sem vínculo)',
    icon: '🗒️',
    description: 'Exemplo de skill flutuante — sem vínculo com servidor nenhum, visível só no painel.',
    tags: ['interno'],
    inPublicMcp: false,
    skillMd: `# Rascunho interno

Esta skill **não está vinculada a nenhum MCP virtual**: não aparece no site,
na API REST nem em servidor MCP algum. Serve para demonstrar que uma skill só
é exibida onde alguém a publicou — vincule-a a um MCP virtual no painel para
ela aparecer.
`,
  },
];

async function main() {
  for (const seed of SEEDS) {
    const existing = await getSkillSummary(seed.slug, { visibility: 'all' });
    if (existing) {
      console.log(`[seed] já existe: ${seed.slug}`);
      continue;
    }

    await createSkill(
      {
        slug: seed.slug,
        name: seed.name,
        icon: seed.icon,
        description: seed.description,
        skillMd: seed.skillMd,
        tags: seed.tags,
      },
      'web-admin',
    );

    for (const file of seed.extraFiles ?? []) {
      await setFile(seed.slug, file.path, file.content, 'web-admin');
    }

    console.log(`[seed] criada: ${seed.slug}`);
  }

  await seedDefaultMcp();
  await seedCatalog();
}

/**
 * Um catálogo de demonstração (`docs/11-catalogos.md`) com todas as skills de
 * exemplo como membros ativos, ligado e **sem vínculo com vMCP nenhum**: ele
 * existe para o painel mostrar o que é um catálogo e para alguém vinculá-lo
 * a um servidor com um gesto só. Sem o vínculo, não publica nada — o
 * rascunho continua invisível fora do painel. Idempotente pelo slug, como as
 * skills.
 */
async function seedCatalog() {
  if (await getCatalog('exemplos')) {
    console.log('[seed] já existe: catálogo exemplos');
    return;
  }

  const catalog = await createCatalog(
    {
      slug: 'exemplos',
      name: 'Skills de exemplo',
      description: 'Todas as skills de exemplo desta instalação, num grupo só.',
      ownerUserUuid: null,
    },
    'web-admin',
    SEED_ACTOR,
  );
  await setCatalogSkills(
    catalog.uuid,
    SEEDS.map((seed) => ({ slug: seed.slug })),
    'web-admin',
    SEED_ACTOR,
  );
  console.log('[seed] criado catálogo: exemplos (com as skills de exemplo, sem vínculo com vMCP)');
}

/**
 * O `/mcp` só responde quando há um vMCP padrão
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md`), então a demo cria o `public`:
 * aberto, sem dono, com as skills de exemplo nas ferramentas. O rascunho fica
 * de fora — é a skill flutuante. Se a instalação já escolheu um padrão, ele é
 * respeitado.
 */
async function seedDefaultMcp() {
  let mcp = await getVirtualMcp('public');
  if (mcp) {
    console.log('[seed] já existe: MCP virtual public');
  } else {
    mcp = await createVirtualMcp(
      {
        slug: 'public',
        name: 'Public',
        description: 'Catálogo público desta instalação, com as skills de exemplo.',
        isOpen: true,
        ownerUserUuid: null,
      },
      'web-admin',
      SEED_ACTOR,
    );
    await setVirtualMcpSkills(
      mcp.uuid,
      SEEDS.filter((seed) => seed.inPublicMcp).map((seed) => ({
        slug: seed.slug,
        asSkill: true,
        asPrompt: false,
        asResource: false,
      })),
      'web-admin',
      SEED_ACTOR,
    );
    console.log('[seed] criado MCP virtual: public (aberto, com as skills públicas)');
  }

  if ((await resolveDefaultVirtualMcp()).status === 'none') {
    await setDefaultVirtualMcp(mcp.uuid, 'web-admin', SEED_ACTOR);
    console.log('[seed] MCP padrão: public');
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
