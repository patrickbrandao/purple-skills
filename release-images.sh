#!/bin/sh
# Purple Skills — build local e push das imagens para o Docker Hub.
#
# Publicação de imagem NÃO é automática (nenhum workflow de CI faz login no
# Docker Hub nem tem credencial para isso). Depois de criar uma release —
# `chore: 1.0.0-beta.N` + `git tag vN` + `git push origin vN` — quem publica
# roda este script à mão, de uma máquina já autenticada (`docker login`) na
# conta tmsoftbrasil.
#
# Sempre publica como `latest`, para as sete imagens do projeto (os seis apps
# mais `database`, que gera `purple-skills-db`). Sem tag de versão — é o que
# o `docker-compose.yml` da raiz e o `database/docker-compose.yml` esperam
# por padrão (`${TAG:-latest}`).
#
#   ./release-images.sh              # builda e publica as 7
#   ./release-images.sh site admin   # só os nomes passados
#
# Rode sempre a partir da raiz do repositório.

set -e

NAMESPACE="tmsoftbrasil"

# app:Dockerfile — mesma matriz que ci.yml usa para o build sem push.
APPS="
homepage:apps/homepage/Dockerfile
site:apps/site/Dockerfile
admin:apps/admin/Dockerfile
mcp-public:apps/mcp-public/Dockerfile
mcp-admin:apps/mcp-admin/Dockerfile
indexer:apps/indexer/Dockerfile
db:database/Dockerfile
"

WANTED="$*"

for entry in $APPS; do
    app="${entry%%:*}"
    dockerfile="${entry#*:}"

    if [ -n "$WANTED" ]; then
        match=0
        for w in $WANTED; do
            [ "$w" = "$app" ] && match=1
        done
        [ "$match" = "1" ] || continue
    fi

    image="$NAMESPACE/purple-skills-$app:latest"
    echo "== $image (Dockerfile: $dockerfile)"
    docker build -f "$dockerfile" -t "$image" .
    docker push "$image"
done

echo "== Publicado."
