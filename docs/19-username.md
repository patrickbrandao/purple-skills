# Username: o identificador público da conta, e o e-mail que volta a ser privado

**Status: em implementação**, num PR. Entrevista de 22/09/2026.
Migration `033-username.sql`.

Este documento registra *por que* cada peça é assim; o resumo do que está no ar
entra em [`02-architecture-decisions.md`](02-architecture-decisions.md) e os
desvios em [`03-implementation-notes.md`](03-implementation-notes.md). A
especificação dos dados é a seção `contas` de
`packages/shared/src/types.ts`, e os comentários dela valem tanto quanto este
texto.

> **Revoga o "a conta é o e-mail" do [`12`](12-acesso-granular.md) `§5.3`** — o
> bloco citado do relatório 011 da auditoria de 2026-09-19. A razão daquele
> bloco continua valendo: o `uuid` de uma conta é o `sub` do cookie de sessão e
> não pode sair para outra conta. O que muda é **qual** identificador ocupa o
> lugar dele. O e-mail nunca foi bom para isso: é dado pessoal, e o `§10`
> daquele documento aceitou expô-lo a conta logada com a justificativa
> "instalação de colaboradores, não SaaS". Esta entrevista desfaz essa
> concessão.
>
> **Revoga a decisão 13 do [`12`](12-acesso-granular.md)** na parte "busca por
> nome/e-mail": a busca de contas passa a casar por **username e nome**. O
> resto da decisão (só contas ativas, mínimo de 2 caracteres, aberta a qualquer
> conta logada) fica.
>
> **Revoga a decisão 11 do [`12`](12-acesso-granular.md)** na parte do site: a
> ficha pública da skill e do catálogo passa a creditar o dono pelo
> `@username`. Quem vê a **ACL** continua sendo só `manage`, dono e admin — o
> que muda é o dono virar dado público, o que só é aceitável porque o username
> não é mais o e-mail.
>
> **Não revoga mais nada.** Conferi o [`05`](05-accounts-and-roles.md) inteiro:
> o `§2.4` continua casando identidade OIDC com conta local **pelo e-mail** (é
> o que o provedor entrega), o `§2.2` (`token_version`), o `§2.6`
> (recuperação por e-mail) e o `§2.7` (rate limiting) não mudam de regra — o
> `§2.7` passa a contar tentativas na mesma conta quer ela tenha sido nomeada
> por username ou por e-mail. O [`13`](13-fichas-e-acessos.md) mantém as guias
> como estão: só troca o e-mail de quem leu pelo username. O
> [`18`](18-atividade.md) não tem recorte por conta e não é tocado.

## 1. Por que

O e-mail é, hoje, **o identificador público desta instalação**. Ele aparece:

- como dono de toda skill, catálogo e vMCP, em toda ficha e toda lista;
- na lista de concessões e em "concedido por";
- na guia **Acessos** da skill e do catálogo — que é de `manage`, não de
  admin: o dono de uma skill vê o e-mail de quem a leu;
- na busca "Compartilhar com…", aberta a **qualquer conta logada**, que casa
  por e-mail e devolve e-mail e papel;
- na URL das rotas de concessão (`/api/skills/:slug/access/:email`), o que o
  põe no log do proxy e no histórico do navegador;
- congelado em texto em `audit_log.actor_label`/`target_label` e em
  `skill_accesses.user_email`.

Nenhuma dessas telas precisa de um endereço de e-mail: precisa de um **nome
curto e estável que identifique uma pessoa**. O e-mail está ali por ser o
único identificador legível que a conta tinha.

O custo disso não é hipotético. Numa instalação com dez colaboradores, uma
conta `membro` recém-criada lê, sem nenhuma concessão, o endereço de e-mail de
todo mundo — basta digitar duas letras na busca de contas. E a guia Acessos
entrega a lista de quem leu cada skill, por e-mail, a qualquer dono de skill.

O username resolve os dois: ocupa o lugar do e-mail em todas essas superfícies
e **deixa o e-mail com três usos, todos privados** — entrar, recuperar a senha
e casar com a identidade do OIDC.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | O que o username é | Coluna nova `users.username`, **obrigatória e única** por `lower(username)`. Ocupa exatamente o lugar que o e-mail ocupa hoje na API e no painel |
| 2 | Formato | 3–32 caracteres, `a–z`, `0–9`, `.`, `_` e `-`; caixa baixa normalizada na entrada; não começa nem termina em pontuação; sem duas pontuações seguidas; **sem `@`**; não pode ter forma de uuid. Reservados: `admin`, `api`, `setup`, `me`, `system`, `null`, `none`, `root`, `support`, `purple-skills` |
| 3 | Login | **Um campo só**, "usuário ou e-mail". Tem `@` → e-mail; não tem → username. É a decisão 2 (sem `@`) que torna a regra decidível. Erro continua genérico e o rate limiting do `05` §2.7 não muda |
| 4 | Backfill | Derivado do **campo `name`**, com sufixo numérico em colisão. Nunca da parte antes do `@`: publicar o local part para todo o painel seria vazar metade do e-mail, que é o que esta mudança existe para evitar |
| 5 | Trocar de username | **Só admin.** `PATCH /api/users/:uuid { username }`, auditado como `user.username` |
| 6 | Reciclagem | **Username abandonado nunca volta.** Tabela `usernames`, uma linha por username já usado nesta instalação, com PK em `lower(username)`. Sem isso o `@joao` de uma trilha de 2025 poderia ser outra pessoa em 2026 |
| 7 | Histórico congelado | A migration **reescreve** `audit_log.actor_label`/`target_label` e `skill_accesses.user_email`, trocando e-mail por username onde a conta ainda existe. O que não resolve vira `conta removida`. `skill_accesses.user_email` **deixa de existir** — vira `user_username` |
| 8 | Quem ainda vê o e-mail | **A própria conta** (tela Conta, menu do usuário, `GET /api/session`) e **admin** (`/api/users*`, ficha de conta, `/api/audit`). Nenhuma outra superfície, nenhum outro papel |
| 9 | Entrada da API | **Só username.** `/api/skills/:slug/access/:username`, tools do mcp-admin com parâmetro `username`, `ownerUserUuid` do `PATCH` aceita username ou uuid. E-mail é **recusado** — aceitá-lo manteria o endereço em URL e deixaria sondar se um endereço tem conta |
| 10 | Busca de contas | Casa por **username e nome**; e-mail sai da busca. Casar por e-mail deixaria qualquer conta logada descobrir a qual username um endereço corresponde — sondagem que anula o sigilo mesmo sem exibir o campo |
| 11 | Site público | A ficha pública da skill e do catálogo passa a creditar o dono por `@username`. O username vira dado exposto à internet — mais uma razão para a decisão 4 |
| 12 | Contas novas | `/api/setup` e a criação pelo admin ganham campo username, pré-preenchido a partir do nome e editável. Conta nascida por OIDC deriva do nome, com sufixo em colisão |
| 13 | Entrega | **Um PR**, como catálogos e acesso granular |

Fechadas por derivação:

- **O e-mail continua obrigatório e único.** Sem ele não há recuperação de
  senha (`05` §2.6) nem vínculo OIDC (`05` §2.4, que casa pelo e-mail). Ele só
  deixa de ser **exibido**.
- **`name` continua existindo.** Onde hoje aparece o e-mail sozinho passa a
  aparecer `@username`; onde aparecem os dois, `name` fica em cima e
  `@username` embaixo.
- **Concessão não quebra em troca de username.** A ACL é por `user_uuid` nas
  três tabelas de concessão; o username é rótulo de leitura.
- **`audit_log` não passa a ter coluna de conta.** O rótulo continua congelado
  em texto, que é a razão de ele existir (`004`): ele tem de sobreviver à
  remoção da conta. A decisão 6 é o que o mantém honesto.

## 3. Formato e normalização

`packages/shared/src/username.ts` é o único lugar que decide o que é um
username válido — o mesmo papel que `email.ts` tem para o e-mail.

```
normalizeUsername(raw): string | null
```

Apara, passa para caixa baixa e valida:

- comprimento de 3 a 32;
- só `[a-z0-9._-]`;
- primeiro e último caractere alfanuméricos;
- sem duas pontuações seguidas (`a..b`, `a-_b` são recusados) — é o que impede
  dois usernames visualmente confundíveis;
- não casa com a forma de um uuid (senão `ownerUserUuid`, que aceita username
  **ou** uuid, ficaria ambíguo);
- não está na lista de reservados.

A caixa **não** é preservada, diferente do e-mail: o e-mail é gravado como a
pessoa escreveu porque é o endereço dela, e o username é um identificador
público — `@Joao` e `@joao` sendo a mesma conta com duas grafias na tela é
confusão sem ganho.

### 3.1 Derivar um username de um nome

`usernameFromName(name)` produz o candidato do backfill (decisão 4), da criação
de conta (decisão 12) e do auto-provisionamento OIDC:

1. decompõe em NFD e remove os acentos — `Patrick Brandão` → `Patrick Brandao`;
2. caixa baixa;
3. tudo que não é `[a-z0-9]` vira `-`;
4. colapsa repetições de `-` e apara pontuação das pontas;
5. corta em 32, aparando pontuação de novo;
6. menos de 3 caracteres, ou reservado: devolve `null` e o chamador usa o
   fallback `user-<8 hex do uuid>`.

A colisão é resolvida por quem grava, não aqui: `-2`, `-3`, … truncando o
radical para o sufixo caber em 32.

> **O `user-<8 hex>` não desempata nada — ele é o fallback de *nome
> inutilizável*, e só.** A primeira versão da `§4` mandava a colisão cair nele
> também, o que é impossível: `users.uuid` é `uuidv7()`, e os 8 primeiros hex
> são os 32 bits **altos** do carimbo de milissegundos — mudam a cada ~65 s.
> Duas contas criadas no mesmo minuto cairiam no *mesmo* `user-<8 hex>`, que é
> outra colisão, e o índice único derrubaria a migration. Medido pelo dba ao
> implementá-la. Vale um mecanismo só, o sufixo numérico, e ele resolve também
> dois `user-<8 hex>` iguais.

## 4. O banco

Migration `033-username.sql`, do agente dba. Cinco partes.

**1. A coluna.** `users.username TEXT`, nasce nula.

**2. O backfill.** Deriva de `name` pela regra da `§3.1`, em SQL
(`translate()` com mapa de acentos explícito — esta instalação não tem a
extensão `unaccent`, e a migration não vai passar a exigir uma). Nome
inutilizável e reservado caem no `user-<8 hex>`; **colisão é sufixo numérico**,
inclusive entre dois `user-<8 hex>` iguais (ver a nota da `§3.1`). Depois:
`SET NOT NULL` e
`CREATE UNIQUE INDEX users_username_lower_uniq ON users (lower(username))`.

**3. O livro de usernames** (decisão 6):

```sql
CREATE TABLE usernames (
    username_lower TEXT PRIMARY KEY,
    user_uuid      UUID REFERENCES users(uuid) ON DELETE SET NULL,
    taken_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at    TIMESTAMPTZ
);
```

Tomar um username é **inserir aqui**: a PK é o que torna a reserva atômica e
permanente. `released_at` preenchido diz "não é de ninguém e não volta a ser".
`user_uuid` é anulável porque conta pode ser apagada e a reserva tem de
sobreviver a isso — é a mesma razão de `actor_label` existir. A migration
popula a tabela com o backfill.

**4. A reescrita do histórico** (decisão 7), na ordem:

- `skill_accesses` ganha `user_username TEXT`. Backfill por `user_uuid`; o que
  sobrar com `user_email` não nulo tenta `lower(email)`; o que ainda sobrar
  vira `conta removida`. `DROP COLUMN user_email`, e o índice trigram de `022`
  é recriado sobre `user_username`.
- `audit_log`: para cada conta, em ordem **decrescente de comprimento do
  e-mail** (senão `ana@x.com` seria trocado dentro de `mariana@x.com`),
  substitui o e-mail por username em `actor_label` e `target_label`, com
  fronteira nas duas pontas — o rótulo é composto em vários formatos
  (`email`, `email:nível`, `<slug> email:nível`, `email <subject>`), então é
  substituição por ocorrência, não igualdade.
- a varredura final, que troca o que sobrou com forma de e-mail por
  `conta removida`, é **restrita às ações cujo rótulo sabidamente é um
  e-mail** — `user.*`, `*.share`, `*.unshare` em `target_label`, e
  `actor_label` de qualquer ação. `target_label` de quarentena é nome de envio
  escrito por gente e fica fora: um envio chamado `relatorio@2026` não é conta
  nenhuma.

**5. A ação nova de auditoria**: `user.username` entra no CHECK de
`audit_log.action`. `actor_label` é o admin que trocou; `target_label` é
`<antigo> -> <novo>`, a mesma forma que `031` usa na clonagem.

### 4.1 As funções de `@purple-skills/db`

- `getUserByUsername(username)`, irmã de `getUserByEmail`.
- `getUserByLogin(identifier)`: tem `@` → e-mail, senão → username
  (decisão 3).
- `createUser` ganha `username` obrigatório; grava a linha em `usernames` na
  mesma transação e devolve 409 no conflito (`Já existe uma conta com o
  username "x"` / `O username "x" já foi usado nesta instalação`).
- `updateUser` ganha `username`: na mesma transação, insere o novo em
  `usernames`, marca `released_at` no antigo e atualiza `users`.
- `reserveUsername(candidate, userUuid)` / `nextFreeUsername(base)`: resolve o
  sufixo numérico consultando `usernames`, para o OIDC e para a sugestão do
  painel. **O `userUuid` de `reserveUsername` é obrigatório, e isso não estava
  na primeira versão desta seção:** uma reserva sem dono é indistinguível de uma
  conta apagada — a FK é `ON DELETE SET NULL`, então `user_uuid` nulo com
  `released_at` nulo é o estado das duas —, e adotá-la devolveria à circulação o
  username de quem saiu, contra a decisão 6. O dba escreveu a adoção, o teste
  dele a pegou, e a assinatura mudou.
- `lookupUsers` passa a casar `name ILIKE` **ou** `username ILIKE` e a
  devolver `username` no lugar de `email`.
- Toda projeção que hoje devolve `email` de uma conta como rótulo passa a
  devolver `username`: `ownerEmail` → `ownerUsername`, `grants[].email` →
  `grants[].username`, `grantedByEmail` → `grantedByUsername`,
  `SkillAccessEntry.userEmail` → `userUsername`. `UserSummary` **mantém**
  `email` e ganha `username` — ele só sai em rota de admin e na própria sessão
  (decisão 8).
- `transferOwnerTx` e `grantAudit` passam a congelar username no
  `target_label`.

## 5. A API

```
POST   /api/setup                { username, email, name, password, adminPassword }
POST   /api/auth/login           { identifier, password }      ← era { email, password }
POST   /api/users                { username, email, name, role }
PATCH  /api/users/:uuid          ganha username (só admin)
GET    /api/users/lookup?q=      username, nome e papel — sem e-mail

PUT    /api/skills/:slug/access/:username     { level }
DELETE /api/skills/:slug/access/:username
PATCH  /api/skills/:slug                      ownerUserUuid aceita username ou uuid
(o mesmo para /api/catalogs/:slug e /api/mcps/:slug)
```

O **apelido** continua como está, só muda o que ele aponta: `ownerUserUuid`,
`grants[].userUuid`, `grants[].grantedByUserUuid` e o `userUuid` da guia
Acessos saem como o **username**, não mais como o e-mail. O `uuid` de verdade
continua saindo só em `/api/users`, que é de admin.

`POST /api/auth/login` aceitar `{ identifier }` no lugar de `{ email }` é
quebra de contrato; o painel é o único cliente dessa rota, e quem tiver script
próprio precisa trocar o campo.

## 6. O mcp-admin

`share_<tipo>`, `unshare_<tipo>` e `transfer_<tipo>` trocam o parâmetro `email`
por `username`, nos três tipos. A descrição de cada tool diz "username da
conta" — é o que o agente do outro lado vai preencher, e ele não tem como
adivinhar um e-mail que não aparece em lugar nenhum.

## 7. O site

A ficha pública da skill e do catálogo ganham o dono, por `@username`
(decisão 11). É uma entrada nova na **lista de permissão** de
`apps/site/src/api.ts` — `ownerUsername` — e nada mais sai junto:
`ownerUserUuid` continua fora, `grants` continua fora.

> **Isto move uma garantia de lugar, e vale saber onde ela foi parar.** Antes,
> `skillColumns` **anulava** o dono na visibilidade `'open'`: o banco não
> entregava `ownerUserUuid` ao site nem que o app pedisse. Para o `@username`
> chegar à ficha pública, ele passou a entregar os dois — e o `ownerUserUuid` é
> o `sub` do cookie de sessão do painel (`tasks/001`, `tasks/002`). A partir
> daqui **a lista de permissão de `skillPublica` é a única guarda**: uma
> projeção que volte a espalhar o objeto do banco (`...detail`) vaza o uuid para
> o anônimo. A guarda de teste é `PROIBIDOS` em `apps/site/src/api.test.ts`, com
> a amostra carregando o campo de propósito; e a `ENDERECO`, ao lado, faz o
> mesmo para a forma de e-mail. Levantado pelo dba ao implementar a `§4.1`.
>
> Custo colateral, também medido por ele: uma busca pela PK de `users` por linha
> nas listagens do site, que antes não acontecia.

## 8. Quebra de compatibilidade

- `POST /api/auth/login` passa a receber `identifier`.
- As rotas de concessão mudam de `:email` para `:username`, e **recusam**
  e-mail.
- As nove tools de compartilhamento do mcp-admin trocam o parâmetro.
- `ownerEmail`, `grants[].email`, `grants[].grantedByEmail` e
  `SkillAccessEntry.userEmail` somem dos corpos de resposta; no lugar entram os
  campos `*Username`.
- `GET /api/users/lookup` deixa de devolver e-mail.
- `skill_accesses.user_email` é apagada do banco.

Quem integra pela REST e lia e-mail nesses campos passa a receber username. Não
há período de convivência: manter o e-mail aceito na entrada, ou devolvido em
paralelo, seria manter aberto o vazamento que esta mudança fecha.

## 9. O que ficou de fora

- **Trocar o próprio username.** Só admin troca (decisão 5). Self-service
  precisaria de limite de frequência para o username não virar identidade
  descartável, e isso é decisão para quando houver pedido.
- **Username no MCP público.** Nenhuma tool do `mcp-public` passa a expor
  conta; as skills continuam saindo sem autor por ali.
- **Exibir e-mail para admin na busca de contas** (decisão 10, terceira
  opção): um resultado diferente por papel na mesma URL, para um ganho de
  suporte que `/api/users` já cobre.
- **Apagar o e-mail de instalações que não usam OIDC nem SMTP.** Ele continua
  obrigatório em toda conta; torná-lo opcional abre caminho de exceção no login
  e no vínculo OIDC sem pedido que justifique.
