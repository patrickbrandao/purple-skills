# Perfil: quem é a pessoa por trás do `@username`

**Status: em implementação**, num PR. Entrevista de 22/09/2026.
Migration `034-perfil.sql`.

Este documento registra *por que* cada peça é assim; o resumo do que está no ar
entra em [`02-architecture-decisions.md`](02-architecture-decisions.md) e os
desvios em [`03-implementation-notes.md`](03-implementation-notes.md). A
especificação dos dados é a seção `perfil` de `packages/shared/src/types.ts`, e
os comentários dela valem tanto quanto este texto.

> **Não revoga nada, e isto foi conferido documento a documento.** O
> [`19`](19-username.md) é o alicerce: ele tornou o `@username` o identificador
> público e o pôs na ficha da skill; aqui esse crédito ganha uma página atrás
> dele. A decisão 8 do `19` (e-mail só para a própria conta e para admin)
> continua inteira — **o perfil não tem campo de e-mail, em superfície
> nenhuma**. O [`12`](12-acesso-granular.md) `§7` lista as seções públicas do
> site e ganha uma quarta rota, sem mexer em quem vê o quê: o perfil só mostra
> o que já era público. O [`13`](13-fichas-e-acessos.md) descreve o cabeçalho da
> ficha de conta com "avatar" — é o monograma das iniciais, e ele passa a ceder
> lugar à foto quando existir; o resto da ficha não muda. Conferi também o
> [`05`](05-accounts-and-roles.md) (papéis e credenciais: intocados) e o
> [`18`](18-atividade.md) (sem recorte por conta).

## 1. Por que

Depois do [`19`](19-username.md), a ficha pública de uma skill diz "por
`@patrick`" — e `@patrick` não leva a lugar nenhum. O identificador público
existe, e não há nada atrás dele.

Do lado de dentro é parecido: a conta tem `name` e papel, e mais nada que diga
quem a pessoa é. Numa instalação com vários times, "quem é `@ana-souza` e por
que ela mantém estas quatro skills?" não tem resposta no produto.

O perfil dá três coisas, e **só a primeira é obrigatória**:

- o **nome de exibição**, que já existe (`users.name`) e apenas passa a ser
  editável pelo próprio dono;
- uma **foto**, que substitui o monograma das iniciais no painel;
- um bloco **público e opcional** — descrição, site e links —, com uma página
  no site em `/u/<username>`.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Nome de exibição | **É o `users.name` que já existe.** Coluna nenhuma nasce; o que muda é quem escreve: o próprio dono passa a poder, o que hoje é só de admin |
| 2 | Foto | **Upload, guardado no banco** e servido pelo produto. Não é URL: um `<img src>` externo numa página anônima entrega o IP de cada visitante ao dono daquele host |
| 3 | Onde os dados públicos aparecem | **Página própria no site**, `/u/<username>` — a quarta rota pública. O `por @fulano` da ficha da skill vira link para ela |
| 4 | Público é opt-in | **Desligado por padrão** (`is_public` no perfil). Bio, foto e links são auto-expressão, não metadado do acervo. Nenhuma conta ganha página na migration |
| 5 | Links | **Lista livre** de `rótulo + URL`, até 8. O host conhecido escolhe o ícone; qualquer outro entra com o ícone genérico. Mais o `website`, campo próprio, porque o pedido o nomeou à parte |
| 6 | Quem edita | **A própria conta.** O admin não escreve no perfil de ninguém; ele tem **"limpar perfil"**, que esvazia os campos públicos e desliga o `is_public` — moderação, auditada. Trocar `name` e papel pela tela de contas continua como está (decisão 1) |
| 7 | A página lista o que a pessoa publicou | **Sim**: as skills e os catálogos **já públicos** dela. Nada passa a ser visível por estar no perfil |
| 8 | Descrição | **Texto puro**, com quebras de linha e teto de caracteres. Não é por XSS — o site renderiza markdown com HTML cru desligado —, é porque título, imagem e tabela numa bio quebram o cartão e transformam o perfil em página livre |
| 9 | Indexação | **Indexa normalmente.** O opt-in da decisão 4 **é** o consentimento: ligar o perfil é dizer "quero ser achado", e um `noindex` por cima disso seria o produto discordando da pessoa |
| 10 | Entrega | **Um PR**, como o `19` |

Fechadas por derivação:

- **O perfil não tem e-mail**, em nenhuma das duas superfícies. É a decisão 8
  do [`19`](19-username.md), e é o motivo de esta funcionalidade poder existir.
- **Perfil privado não vira link.** O `por @fulano` da ficha da skill só vira
  âncora quando o perfil é público; senão fica o texto de hoje. Sem isso, o
  site teria links para 404.
- **A foto aparece no painel mesmo com o perfil privado.** Ela é o avatar das
  listas e das fichas, entre contas logadas, como o monograma já é. O
  `is_public` decide o que sai para o **anônimo**, não o que o painel mostra.
- **Conta desativada não tem página pública**, como skill desligada não aparece
  no site. Reativar devolve.
- **Edição do próprio perfil não entra na trilha.** É o mesmo critério que
  mantém o login fora dela (`05` §2.8): mudaria a ordem de grandeza do log. A
  **limpeza pelo admin** entra, porque é ato de um sobre outro.

## 3. Os dados

### 3.1 Descrição, site e links

`packages/shared/src/profile.ts` é o único lugar que decide o que vale — o
mesmo papel de `username.ts` e `email.ts`.

- **bio**: até 500 caracteres depois de normalizada. CRLF vira LF, três ou mais
  linhas em branco viram uma, e espaço à direita de cada linha some. Vazia é
  `''`, nunca nulo: "sem bio" e "bio vazia" são a mesma coisa e um só valor
  evita o `?? ''` espalhado.
- **websiteUrl**: `http(s)` absoluto, até 512 caracteres, sem espaço. Vazio é
  `null` — aqui o nulo é útil, porque a página decide se desenha a linha.
- **links**: até 8 entradas de `{ label, url }`. `label` até 40 caracteres,
  aparado, não vazio; `url` pela mesma regra do `websiteUrl`. Entradas com a
  **mesma URL** são recusadas — duas linhas idênticas no cartão são erro de
  digitação, não intenção.

O limite de 8 não é estético: a lista vai para uma página anônima, e sem teto
ela é um campo de texto livre de 8 KB servido a quem passar.

### 3.2 A foto

- Formatos: **PNG, JPEG e WebP**, decididos pelos **bytes iniciais**, nunca
  pela extensão nem pelo `Content-Type` do cliente — os dois são texto que quem
  envia escolhe.
- **SVG é recusado**, e merece a frase: ele é XML com `<script>` dentro. Servido
  na mesma origem do site, um SVG de avatar é execução de código de terceiro na
  página; nenhum teto de tamanho resolve isso.
- Teto de **512 KB** por imagem, conferido depois de receber os bytes.
- **Sem redimensionar.** Não há biblioteca de imagem no projeto, e trazer uma
  (`sharp`) por causa de um avatar é peso desproporcional. O teto de bytes é o
  que segura; uma imagem de 4000×4000 dentro de 512 KB é problema do navegador
  de quem enviou, não do servidor.
- Uma foto por conta. Enviar de novo substitui.

## 4. O banco

Migration `034-perfil.sql`, do agente dba. **Duas** tabelas, e a separação é o
ponto:

```sql
CREATE TABLE user_profiles (
    user_uuid    UUID PRIMARY KEY REFERENCES users(uuid) ON DELETE CASCADE,
    bio          TEXT NOT NULL DEFAULT '',
    website_url  TEXT,
    links        JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_public    BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_avatars (
    user_uuid  UUID PRIMARY KEY REFERENCES users(uuid) ON DELETE CASCADE,
    bytes      BYTEA NOT NULL,
    mime       TEXT NOT NULL,
    sha256     BYTEA NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Por que duas.** Os bytes da foto não podem viajar junto com a leitura do
perfil: a página `/u/<username>` lê o perfil, e a ficha de skill lê o dono — se
a imagem estivesse na mesma linha, toda leitura arrastaria até 512 KB do banco
para descartá-los. Separadas, `user_avatars` só é lida pela rota que serve a
imagem. É a mesma razão de `files.binary_content` (`001`) existir na linha do
arquivo e não na da skill.

`links` é `JSONB` com `jsonb_typeof(links) = 'array'` e cardinalidade no CHECK,
como o `virtual_mcps.layout` da `014` — não é padrão novo. Tabela própria daria
ordem e constraint por linha; para no máximo 8 entradas que nunca são
consultadas por URL, o array é o que tem o tamanho do problema.

`sha256` existe para o **ETag** da rota que serve a imagem: é o que faz o
navegador revalidar com 304 em vez de baixar de novo, sem cache longo — e cache
longo é justamente o que deixaria um avatar visível depois de o perfil virar
privado.

A linha de `user_profiles` **nasce com o primeiro salvamento**, não na
migration: `034` não cria linha nenhuma, e quem nunca abriu a tela não tem
perfil. Toda leitura trata a ausência como o perfil vazio e privado.

### 4.1 As funções de `@purple-skills/db`

- `getProfile(userUuid)` / `getPublicProfile(username)` — a segunda só devolve
  quando `is_public` **e** a conta está ativa.
- `saveProfile(userUuid, input)` — `INSERT … ON CONFLICT DO UPDATE`, que é o
  que faz a linha nascer no primeiro salvamento.
- `clearProfile(userUuid, source, actor)` — esvazia os campos públicos, desliga
  `is_public`, apaga o avatar e grava `user.profile` na trilha.
- `setAvatar(userUuid, bytes, mime)` / `deleteAvatar(userUuid)` /
  `getAvatar(userUuid)` — a última devolve bytes, mime e sha256.
- `avatarStamp(userUuid)` — só `updated_at`, para o painel montar a URL com
  cache-buster sem ler a imagem.
- `listPublicByOwner(username)` — as skills e os catálogos públicos da pessoa,
  para a decisão 7.
- `user.profile` entra no CHECK de `audit_log.action`.

### 4.2 `ownerHasProfile` é subconsulta escalar, e não `EXISTS`

Parece detalhe de escrita e não é: **`EXISTS` correlacionado degrada a listagem
do site**, que é a página mais quente do produto.

O planejador transforma um `EXISTS` correlacionado por igualdade em *hashed
SubPlan*: ele varre `user_profiles` **inteira, uma vez por consulta**, e ignora
o índice parcial que existe justamente para isso. Medido pelo dba na listagem do
site (5 000 skills, página de 24, mediana de 10–12 execuções):

| forma | 60 perfis | 50 060 perfis |
|---|---|---|
| sem a coluna | ~3,9 ms | 3,9 ms |
| `EXISTS` | ~4,1 ms | **10,9 ms** |
| dois `EXISTS` separados | — | **14,1 ms** |
| subconsulta escalar | ~4,0 ms | **4,2 ms** |

A forma entregue é `COALESCE((SELECT true … LIMIT 1), false)`, que **não pode
ser hasheada**: são 24 buscas em `user_profiles_public_idx`, em Index Only Scan,
com `Heap Fetches: 0`. Custo de +0,24 ms sobre a listagem sem a coluna, e plano
**constante no tamanho da instalação** — que é o que importa, porque o número de
contas cresce e o da página não.

Quem reescrever isso para `EXISTS` "porque fica mais legível" reintroduz a
varredura, e ela não aparece numa instalação de teste com sessenta perfis.

### 4.3 `ownerHasProfile` confere `users.is_active`, não só `is_public`

Uma conta desativada não tem página (`§7`). Sem a conferência, a ficha de uma
skill cujo dono foi desativado viraria link para o 404 que a desativação acabou
de criar — que é exatamente o que este campo existe para evitar. Levantado e
coberto por teste pelo dba.

## 5. A API

```
GET    /api/me/profile                   o próprio perfil (sempre existe, vazio se nunca salvo)
PATCH  /api/me/profile                   { name?, bio?, websiteUrl?, links?, isPublic? }
PUT    /api/me/profile/avatar            multipart, um arquivo
DELETE /api/me/profile/avatar

GET    /api/users/:username/avatar       o avatar, para qualquer sessão logada
DELETE /api/users/:uuid/profile          admin: limpar perfil (decisão 6), auditado
```

No site:

```
GET    /api/profiles/:username           404 se o perfil não é público
GET    /u/:username/avatar               idem
GET    /u/:username                      a página (SPA)
```

`PATCH /api/me/profile` aceita `name` e o grava em `users.name` — a decisão 1.
É a **única** escrita em `users` que não exige admin, e por isso ela não aceita
mais nada: papel, estado e username continuam onde estavam.

## 6. O mcp-admin

**Nada.** Nenhuma tool nova, nenhum campo novo nas existentes. O perfil é
matéria de gente, não de acervo, e o agente do outro lado não tem o que fazer
com a bio de ninguém. O `owner` que as tools já devolvem segue sendo o
`@username`.

## 7. O site

Rota nova `/u/<username>`, com nome, foto, bio, site, links e as duas listas da
decisão 7. Perfil não público, conta desativada ou username inexistente
respondem o mesmo **404** — a página não distingue os três casos, senão ela
responde "esta conta existe, mas não quer ser vista", que é informação que o
opt-in existe para não dar.

O `por @fulano` da ficha da skill e do catálogo vira link quando o perfil é
público. Isso exige que a projeção pública da skill diga **se** o dono tem
perfil público — um booleano a mais na lista de permissão de
`apps/site/src/api.ts` (`ownerHasProfile`), e nada além dele: nem bio, nem
foto, nem links viajam na ficha da skill.

## 7.1 O painel: ficha e edição

"Minha conta" segue a divisão que as contas de admin já têm
([`13`](13-fichas-e-acessos.md) §3.4): `/account` **só mostra**, e o botão
Editar leva a `/account/edit`, onde estão os campos. A tela que se abre todo dia
é a de leitura; escrever é um passo deliberado.

A leitura tem uma guia só, "Perfil", e três painéis: os dados da conta, o quadro
**"O que é seu"** e os dados públicos como estão hoje. A edição tem três guias —
**Perfil** (foto, nome de exibição, o username que só admin troca),
**Dados públicos** (descrição, site, links e o publicar) e **Trocar senha**.

Duas consequências que não são óbvias:

- **As guias da edição são estado de tela, e não rotas.** O formulário do perfil
  é um só nas duas primeiras: rota por guia o desmontaria, e quem escrevesse a
  bio e fosse conferir o nome perderia o que digitou. Pelo mesmo motivo ele fica
  montado — escondido pelo `display` — enquanto a senha está à vista.
- **O quadro "O que é seu" não tem endpoint.** Ele conta servidores vMCP, skills
  e catálogos de que a conta é **dona** pelo recorte `mine` das três listas que
  já existem, e cada número é link para a lista que o produziu. O que foi
  compartilhado com a pessoa não entra: o quadro é de posse, não de acesso.

O painel **não** repete mais o ponteiro para as chaves `psk_`: elas têm tela
própria (Adm MCP Keys) com item de menu direto, e o quadro no perfil só ocupava
a largura da página para dizer isso.

## 8. Quebra de compatibilidade

Nenhuma. Tudo aqui é campo novo, rota nova ou tela nova; `SkillSummary` ganha
`ownerHasProfile`, que quem integra pela REST pode ignorar.

## 8.1 Desvios desta spec, medidos na implementação

Cada um veio do dba ao implementar a `§4`, e todos foram aceitos:

- **`setAvatar(userUuid, bytes, mime?)`**: o `mime` virou **opcional e
  conferência**, não fonte. Informado e diferente do que `sniffAvatarMime` lê
  nos bytes, é 400 com os dois valores. O painel passa o resultado do sniff, e
  nada muda — o ganho é que um caminho futuro que repasse o `Content-Type` do
  cliente recebe recusa em vez de gravar mentira.
- **`getProfile` lança 404** quando a **conta** não existe, em vez de devolver
  `UserProfile | null`. Perfil ausente continua sendo o objeto vazio e privado;
  o nulo só existiria para o caso em que `saveProfile` e `clearProfile` já
  respondem 404.
- **`Avatar.sha256` é `Buffer`**, não hexadecimal: quem serve a imagem já faz
  `.toString('hex')` na linha do ETag, e o hex é responsabilidade do
  `avatarHeaders`.
- **CHECK a mais, não pedido**: `user_profiles_website_len_chk` (≤ 512, o
  `PROFILE_URL_MAX_LENGTH`). É teto, não forma — a mesma divisão que o `013`
  faz para o ícone.
- **`clearProfile` audita sempre**, mesmo sem nada a limpar, e **não cria**
  linha de perfil: esvazia a que existir e apaga a foto, que pode existir sem
  perfil.
- **`saveProfile` aceita `name` e o grava em `users` na mesma transação.** O
  painel optou por um `updateUser` separado (`profile.save`); as duas formas
  funcionam, e a do banco evita nome novo com bio velha se o segundo passo
  falhar. Fica como está — trocar exigiria mover a validação de `name` para
  dentro do banco.
- **`listPublicByOwner` não pagina**, em paridade com `getPublicCatalog`. Quem
  publicar centenas de skills tem uma página grande; é o mesmo limite que o
  catálogo público já tem, e resolver um sem o outro seria inconsistente.
- **O caractere nulo em `links` é conferido nas cadeias, antes de serializar.**
  `JSON.stringify` o escapa em seis caracteres, então procurá-lo no JSON já
  serializado não acha nada — e o `\u0000` escapado é recusado pelo Postgres com
  22P05 no meio da transação, virando 500 com SQL no log.

## 9. O que ficou de fora

- **Seguir alguém, curtir, comentar.** Isto é um catálogo de skills.
- **Redimensionar ou cortar a foto** (`§3.2`).
- **Lista de pessoas no site.** Existe a página de cada um, não o índice de
  todos: um diretório de gente é uma decisão diferente, e não foi pedida.
- **Perfil no MCP público e no mcp-admin** (`§6`).
- **E-mail no perfil**, em qualquer forma, inclusive "e-mail de contato
  público" — quem quiser dar contato usa um link.
