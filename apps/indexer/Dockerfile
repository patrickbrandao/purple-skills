# syntax=docker/dockerfile:1
# Purple Skills — indexador do RAG (varredura periódica, embeddings por lote)
# Build a partir da raiz do monorepo:
#   docker build -f apps/indexer/Dockerfile -t purple-skills-indexer .

# --------------------------------------------------------------- build ------
FROM node:24-alpine AS build
WORKDIR /app

# Manifests primeiro: a camada de dependências fica em cache entre builds.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/rag/package.json packages/rag/
COPY database/package.json database/
COPY apps/site/package.json apps/site/
COPY apps/admin/package.json apps/admin/
COPY apps/mcp-public/package.json apps/mcp-public/
COPY apps/mcp-admin/package.json apps/mcp-admin/
COPY apps/indexer/package.json apps/indexer/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
# Só o cliente do banco: o SQL de database/schema/ é aplicado pela imagem do DBA.
COPY database ./database
COPY apps/indexer ./apps/indexer

RUN npm run build -w @purple-skills/shared \
 && npm run build -w @purple-skills/rag \
 && npm run build -w @purple-skills/db \
 && npm run build -w @purple-skills/indexer \
 && npm prune --omit=dev

# ------------------------------------------------------------- runtime ------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache tini

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/rag/package.json ./packages/rag/package.json
COPY --from=build --chown=node:node /app/packages/rag/dist ./packages/rag/dist
COPY --from=build --chown=node:node /app/database/package.json ./database/package.json
COPY --from=build --chown=node:node /app/database/dist ./database/dist
COPY --from=build --chown=node:node /app/apps/indexer/package.json ./apps/indexer/package.json
COPY --from=build --chown=node:node /app/apps/indexer/dist ./apps/indexer/dist

USER node

# O indexador não abre porta: não há healthcheck HTTP. Quem diz se ele está
# vivo é `rag.indexer.status`, que ele regrava a cada ciclo e o painel mostra.

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/indexer/dist/index.js"]
