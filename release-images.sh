#!/bin/sh
# Purple Skills — build local e push das imagens para o Docker Hub.
#
# Publicação de imagem NÃO é automática (nenhum workflow de CI faz login no
# Docker Hub nem tem credencial para isso). Depois de criar uma release —
# `chore: 1.0.0-beta.N` + `git tag vN` + `git push origin vN` — quem publica
# roda este script à mão, de uma máquina já autenticada (`docker login`) na
# conta tmsoftbrasil.
#
# São sete imagens (os seis apps mais `database`, que gera `purple-skills-db`),
# e cada uma sai com DUAS tags: a versão do `package.json` da raiz e `latest`.
# A `latest` é o que o `docker-compose.yml` da raiz e o
# `database/docker-compose.yml` esperam por padrão (`${TAG:-latest}`); a de
# versão existe porque `latest` é sobrescrita e não deixa cópia — sem ela, uma
# release ruim não tem para onde voltar. O caminho de volta é
# `TAG=1.0.0-beta.20 docker compose up -d`.
#
# Build multi-plataforma, de propósito. Até aqui o script rodava `docker build`
# sem `--platform`: publicando de um Mac ARM, as sete imagens do Hub ficaram só
# em `linux/arm64` (conferido com `docker buildx imagetools inspect`), e todo
# servidor `amd64` que desse `docker compose pull` recebia "no match for
# platform". Com pressa, uma arquitetura só:
# `PLATFORMS=linux/amd64 ./release-images.sh`.
#
# O gate é UMA confirmação, mostrando o que vai subir: versão, tags, plataformas
# e o commit — com aviso quando a árvore está suja, porque o build sai do disco
# (contexto `.`), não do commit. Typecheck e testes NÃO são rodados aqui de
# propósito: o CI já os roda em todo push para `main`, e script que repete a
# suíte inteira a cada publicação é script que alguém comenta. A procedência vai
# gravada na imagem, nos labels OCI `...image.version` e `...image.revision`
# (`docker image inspect`).
#
# Exige um builder que conheça as duas arquiteturas (o `desktop-linux` do Docker
# Desktop conhece). Faltando, o script recusa antes do primeiro build e diz o
# comando. A arquitetura emulada demora bem mais que a nativa.
#
#   ./release-images.sh              # builda e publica as 7
#   ./release-images.sh site admin   # só os nomes passados
#
# Rode sempre a partir da raiz do repositório.

set -eu

NAMESPACE="tmsoftbrasil"
REPO_URL="https://github.com/patrickbrandao/purple-skills"

# Fonte única da versão: o `package.json` da raiz — o mesmo arquivo que o commit
# `chore: 1.0.0-beta.N` da release muda. Nada de repetir o número aqui.
VERSION="$(node -p 'require("./package.json").version')"

# Arquiteturas do manifesto publicado. Servidor comum é amd64 e quem publica
# costuma estar em arm64: as duas no mesmo manifesto atendem os dois lados sem
# ninguém precisar escolher na hora do `pull`.
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

# Commit de origem, com `-sujo` quando há alteração não commitada. Vai para o
# label da imagem: é a única forma de saber, depois, o que foi distribuído.
REVISION="$(git rev-parse --short HEAD 2>/dev/null || echo desconhecido)"
[ -z "$(git status --porcelain 2>/dev/null)" ] || REVISION="$REVISION-sujo"

# app:Dockerfile — mesma matriz que ci.yml usa para o build sem push.
APPS="
    homepage:apps/homepage/Dockerfile
    site:apps/site/Dockerfile
    admin:apps/admin/Dockerfile
    mcp-public:apps/mcp-public/Dockerfile
    mcp-admin:apps/mcp-admin/Dockerfile
    indexer:apps/indexer/Dockerfile
    db:database/Dockerfile
";

WANTED="$*"

# A seleção é resolvida ANTES da confirmação: o que a confirmação mostra tem de
# ser exatamente o que vai subir.
SELECIONADAS=""
for entry in $APPS; do
    app="${entry%%:*}"

    if [ -n "$WANTED" ]; then
        match=0
        for w in $WANTED; do
            [ "$w" = "$app" ] && match=1
        done
        [ "$match" = "1" ] || continue
    fi

    SELECIONADAS="$SELECIONADAS $entry"
done

if [ -z "$SELECIONADAS" ]; then
    echo "!! nenhuma imagem com esse nome: $WANTED" >&2
    exit 1
fi

# buildx é obrigatório agora: `docker build` + `docker push` não montam
# manifesto com mais de uma arquitetura.
if ! docker buildx inspect >/dev/null 2>&1; then
    echo "!! docker buildx indisponível. Crie um builder e repita:" >&2
    echo "   docker buildx create --use --name purple-skills --driver docker-container" >&2
    exit 1
fi

# Plataforma que o builder não conhece só falha no meio do build, com mensagem
# obscura: melhor recusar antes do primeiro dos sete.
DISPONIVEIS="$(docker buildx inspect | sed -n 's/^ *Platforms: *//p' | tr -d ' ' | tr '\n' ',')"
if [ -n "$DISPONIVEIS" ]; then
    for p in $(echo "$PLATFORMS" | tr ',' ' '); do
        case ",$DISPONIVEIS" in
            *",$p,"*) ;;
            *)
                echo "!! o builder atual não constrói $p (conhece: $DISPONIVEIS)" >&2
                echo "   docker buildx create --use --name purple-skills --driver docker-container" >&2
                exit 1
                ;;
        esac
    done
fi

echo "== versão:      $VERSION  (tags :$VERSION e :latest)"
echo "== commit:      $REVISION"
echo "== plataformas: $PLATFORMS"
echo "== imagens:     $(echo "$SELECIONADAS" | tr ' ' '\n' | sed -n 's/:.*//p' | tr '\n' ' ')"
case "$REVISION" in
    *-sujo)
        echo "!! árvore suja: o build sai do disco, então alteração não commitada"
        echo "!! e não revisada VAI para a imagem publicada."
        ;;
esac
printf '== publicar no Docker Hub (%s)? [s/N] ' "$NAMESPACE"
read -r RESPOSTA || RESPOSTA=""
case "$RESPOSTA" in
    s|S|sim|SIM) ;;
    *) echo "== cancelado."; exit 1 ;;
esac

for entry in $SELECIONADAS; do
    app="${entry%%:*}"
    dockerfile="${entry#*:}"
    image="$NAMESPACE/purple-skills-$app"

    # Só os três que leem APP_VERSION declaram o ARG; passar a variável para os
    # outros quatro renderia aviso de build-arg não usado em todo build.
    case "$app" in
        admin|mcp-public|mcp-admin) VERSAO_ARG="--build-arg APP_VERSION=$VERSION" ;;
        *)                          VERSAO_ARG="" ;;
    esac

    echo "== $image:$VERSION + :latest ($PLATFORMS, Dockerfile: $dockerfile)"
    # Build e push num passo só: a imagem multi-plataforma não cabe no store
    # local do Docker, então não há o que empurrar depois com `docker push`.
    # $VERSAO_ARG sem aspas de propósito: vazio tem de desaparecer da linha.
    # shellcheck disable=SC2086
    docker buildx build \
        --platform "$PLATFORMS" \
        -f "$dockerfile" \
        $VERSAO_ARG \
        --label "org.opencontainers.image.version=$VERSION" \
        --label "org.opencontainers.image.revision=$REVISION" \
        --label "org.opencontainers.image.source=$REPO_URL" \
        -t "$image:$VERSION" \
        -t "$image:latest" \
        --push .
done

echo "== Publicado $VERSION (e latest) em $PLATFORMS."
echo "== Para voltar atrás: TAG=<versão anterior> docker compose up -d"
