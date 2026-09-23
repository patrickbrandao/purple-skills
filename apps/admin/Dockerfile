# syntax=docker/dockerfile:1
# Purple Skills — painel administrativo (Express + SPA React/Tailwind)
# Build a partir da raiz do monorepo:
#   docker build -f apps/admin/Dockerfile -t purple-skills-admin .

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
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
# Só o cliente do banco: o SQL de database/schema/ é aplicado pela imagem do DBA.
COPY database ./database
COPY apps/admin ./apps/admin

RUN npm run build -w @purple-skills/shared \
 && npm run build -w @purple-skills/rag \
 && npm run build -w @purple-skills/db \
 && npm run build -w @purple-skills/admin \
 && npm prune --omit=dev

# ------------------------------------------------------------- runtime ------
FROM node:24-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0

# `purple-admin`: a gerência de contas pela linha de comando
# (docs/21-cli-admin.md) — `docker compose exec admin purple-admin help`.
RUN apk add --no-cache tini \
 && printf '#!/bin/sh\nexec node /app/apps/admin/dist/admin-cli.js "$@"\n' > /usr/local/bin/purple-admin \
 && chmod 0755 /usr/local/bin/purple-admin

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/rag/package.json ./packages/rag/package.json
COPY --from=build --chown=node:node /app/packages/rag/dist ./packages/rag/dist
COPY --from=build --chown=node:node /app/database/package.json ./database/package.json
COPY --from=build --chown=node:node /app/database/dist ./database/dist
COPY --from=build --chown=node:node /app/apps/admin/package.json ./apps/admin/package.json
COPY --from=build --chown=node:node /app/apps/admin/dist ./apps/admin/dist
COPY --from=build --chown=node:node /app/apps/admin/dist-web ./apps/admin/dist-web

# Versão que o app anuncia em tempo de execução (aqui, o rodapé de Configurações
# do painel). Quem a passa é o `release-images.sh`, a partir do package.json da
# raiz; num `docker build` comum ela sai vazia e o app cai no padrão compilado,
# como antes. Depois dos COPY de propósito: mudar só a versão não invalida as
# camadas acima. Atenção: o `docker-compose.yml` da raiz manda
# `APP_VERSION: ${APP_VERSION:-}` e, vazio, esse valor SOBRESCREVE o daqui.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/admin/dist/index.js"]
