# syntax=docker/dockerfile:1
# Purple Skills — imagem do banco de dados (migrations + dados de exemplo).
#
# É a única imagem que escreve DDL: aplica os arquivos de `database/schema/` e,
# sob demanda, popula o catálogo de exemplo. Os quatro apps recebem só o cliente
# (`dist/`), nunca o SQL.
#
# Build a partir da raiz do monorepo:
#   docker build -f database/Dockerfile -t purple-skills-db .
#
# Uso:
#   docker run --rm --env-file .env purple-skills-db                     # migrate
#   docker run --rm --env-file .env purple-skills-db node database/dist/seed.js

# --------------------------------------------------------------- build ------
FROM node:24-alpine AS build
WORKDIR /app

# Manifests primeiro: a camada de dependências fica em cache entre builds.
# Todos os workspaces precisam existir para o `npm ci` da raiz resolver.
COPY package.json package-lock.json ./
COPY database/package.json database/
COPY packages/shared/package.json packages/shared/
COPY apps/site/package.json apps/site/
COPY apps/admin/package.json apps/admin/
COPY apps/mcp-public/package.json apps/mcp-public/
COPY apps/mcp-admin/package.json apps/mcp-admin/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY database ./database

RUN npm run build -w @purple-skills/shared \
 && npm run build -w @purple-skills/db \
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
COPY --from=build --chown=node:node /app/database/package.json ./database/package.json
COPY --from=build --chown=node:node /app/database/dist ./database/dist
COPY --from=build --chown=node:node /app/database/schema ./database/schema

USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "database/dist/migrate.js"]
