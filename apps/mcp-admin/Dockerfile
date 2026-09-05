# syntax=docker/dockerfile:1
# Purple Skills — servidor MCP administrativo (SSE, Streamable HTTP, stateless)
# Build a partir da raiz do monorepo:
#   docker build -f apps/mcp-admin/Dockerfile -t purple-skills-mcp-admin .

# --------------------------------------------------------------- build ------
FROM node:24-alpine AS build
WORKDIR /app

# Manifests primeiro: a camada de dependências fica em cache entre builds.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY database/package.json database/
COPY apps/site/package.json apps/site/
COPY apps/admin/package.json apps/admin/
COPY apps/mcp-public/package.json apps/mcp-public/
COPY apps/mcp-admin/package.json apps/mcp-admin/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
# Só o cliente do banco: o SQL de database/schema/ é aplicado pela imagem do DBA.
COPY database ./database
COPY apps/mcp-admin ./apps/mcp-admin

RUN npm run build -w @purple-skills/shared \
 && npm run build -w @purple-skills/db \
 && npm run build -w @purple-skills/mcp-admin \
 && npm prune --omit=dev

# ------------------------------------------------------------- runtime ------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3003 \
    HOST=0.0.0.0

RUN apk add --no-cache tini

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/database/package.json ./database/package.json
COPY --from=build --chown=node:node /app/database/dist ./database/dist
COPY --from=build --chown=node:node /app/apps/mcp-admin/package.json ./apps/mcp-admin/package.json
COPY --from=build --chown=node:node /app/apps/mcp-admin/dist ./apps/mcp-admin/dist

USER node
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3003)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/mcp-admin/dist/index.js"]
