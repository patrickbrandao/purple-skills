# Contas, papéis e credenciais de agente

**Status: implementado.** Este documento registra o desenho que substituiu a
senha única do painel por contas de usuário com papéis, e continua sendo a
referência de *por que* cada peça é assim.

> **Parcialmente revogado por [`12`](12-acesso-granular.md).** As decisões 5
> e 6 (papéis globais que limitam a ação e nunca o escopo; sem ownership) e a
> matriz da `§2.1` deixaram de valer: skills, catálogos e vMCPs têm dono e
> concessões por objeto, o papel `leitor` virou `membro` e só a criação e a
> administração da instalação continuam sendo decididas pelo papel. O resto —
> contas locais e OIDC, sessão com `token_version`, bootstrap, recuperação de
> senha, rate limiting e auditoria — continua como está aqui. Das chaves `psk_`
> continuam como aqui a **emissão, o formato e a resolução pelo prefixo**; o
> **alcance** delas é o do `12` — a frase da `§2.5` ("chave de `leitor` só
> executa as tools de leitura") e os ecos dela na tabela da `§4` estão marcados
> no ponto. O item "ownership por skill" da `§5` entrou no escopo do `12` (dono
> e concessões por skill).
>
> **A troca do nome do papel não isenta o OIDC.** Onde este documento escreve
> `leitor` — a decisão 5, a decisão 9, a matriz da `§2.1`, a `§2.4`, a `§2.5`,
> o `CHECK` da `§3` e a tabela da `§4` —, leia **`membro`**: o `017` fez
> `UPDATE users SET role = 'membro' WHERE role = 'leitor'` e trocou o `CHECK`,
> e `ROLES` em `packages/shared/src/roles.ts` é `['admin', 'editor',
> 'membro']`. Gravar `leitor` hoje é recusado pelo banco. **Trocar o nome não
> ressuscita a regra:** o que a matriz da `§2.1`, a `§2.5` e a tabela da `§4`
> dizem que o `leitor` *não faz* caiu com o `12` — um `membro` edita,
> compartilha, apaga e transfere o que é seu ou lhe foi concedido; só não cria.

O resumo do que está no ar está na `§7.1` de
[`02-architecture-decisions.md`](02-architecture-decisions.md); os desvios e as
decisões que esta spec deixou em aberto, em
[`03-implementation-notes.md`](03-implementation-notes.md).

O plano de execução das três fases era um arquivo de trabalho em `tasks/`, que o
repositório **não versiona** (`.gitignore`) — quem clona não o recebe. O que as
três fases entregaram está descrito aqui mesmo, seção por seção, e resumido na
`§7.1` do `02`.

## 1. Por que

Antes desta entrega o painel tinha uma senha única (`ADMIN_PASSWORD`) e o MCP
administrativo um token único (`MCP_ADMIN_TOKEN`). Consequências práticas:

- O `audit_log` registra a **superfície** (`web-admin` / `mcp-admin`), nunca o
  **ator**. "Quem apagou essa skill?" não tem resposta.
- Não existe revogação individual: tirar o acesso de uma pessoa significa
  trocar a senha de todo mundo.
- Não existe grau de poder — quem entra pode tudo, inclusive apagar o catálogo.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Público-alvo | Colaboradores com poderes diferentes (não é cadastro aberto ao público) |
| 2 | Origem da identidade | Contas locais **e** OIDC opcional |
| 3 | `ADMIN_PASSWORD` | Só bootstrap do primeiro admin; depois **inerte** |
| 4 | `MCP_ADMIN_TOKEN` | **Mantido** como credencial de máquina, papel `admin` |
| 5 | Papéis | `admin`, `editor`, `leitor` — globais |
| 6 | Alcance do editor | Mexe em **todas** as skills; o papel limita ação, não escopo |
| 7 | Sessão | Cookie stateless + `token_version` (sem tabela de sessões) |
| 8 | MCP admin | Chaves de API por usuário, além do token global |
| 9 | OIDC | Auto-provisiona como ~~`leitor`~~ **`membro`** (o `017` renomeou o papel), com allowlist de domínio **obrigatória** — vazia, ela recusa todo login por SSO (`§2.4`) |
| 10 | Vinculação OIDC ↔ conta local | Sempre pelo e-mail, **dentro dos domínios autorizados** |
| 11 | Recuperação de senha | Link por e-mail quando há SMTP; sem SMTP, reset pelo admin |
| 12 | Escopo extra | Rate limiting no login, `created_by` nas skills, desativar em vez de deletar, auditoria dos eventos críticos de conta |

### 2.1 Papéis

> **Revogado neste ponto por [`12`](12-acesso-granular.md)** (decisões 1, 8 e
> 12): o papel continua global, mas **há ownership** — skill, catálogo e vMCP
> têm dono e concessões por objeto —, e a matriz abaixo deixou de valer. A que
> vale é a da `§3.3` do `12`: o papel decide só **criar** (`editor`+) e
> administrar a instalação (`admin`); ver, editar, publicar e apagar são do
> acesso a cada objeto. O que segue é o texto de antes.

Papéis são **globais**, não por skill. ~~Não há ownership: um editor mexe em
qualquer skill.~~ O que separa os três é a ação permitida.

| Ação | admin | editor | leitor |
|------|:-----:|:------:|:------:|
| Ver skills (inclusive privadas) | ✅ | ✅ | ✅ |
| Criar / editar skill e arquivos | ✅ | ✅ | ❌ |
| Publicar / despublicar | ✅ | ✅ | ❌ |
| Apagar skill | ✅ | ❌ | ❌ |
| Gerenciar usuários e papéis | ✅ | ❌ | ❌ |
| Ver a trilha de auditoria | ✅ | ❌ | ❌ |
| Emitir chaves de API para si | ✅ | ✅ | ✅ |

A ausência de ownership é o que mantém a mudança barata: sem
`skill_collaborators`, sem JOIN de permissão em toda leitura, sem "transferir
dono" quando alguém sai. `skills.created_by_user_uuid` existe, mas é
**informativo** — não autoriza nada.

> ~~**Leitor enxerga skills privadas.** É o propósito do papel: dar visibilidade
> a quem não edita.~~ Isso torna crítica a allowlist da `§2.4`.
>
> **Revogado neste ponto pela decisão 1 do [`12`](12-acesso-granular.md):** o
> `membro` vê o que é dele, o que lhe foi concedido e o que é público ou está
> em contêiner aberto ou público. A allowlist da `§2.4` continua obrigatória.

### 2.2 Sessão e revogação

O cookie continua stateless e assinado por HMAC
([`session.ts`](../packages/shared/src/session.ts)), mas o payload passa de
`{ sub: 'admin', exp }` para:

```ts
type SessionPayload = { sub: string; role: Role; ver: number; exp: number };
```

`users.token_version` é a alavanca de revogação. Trocar senha, mudar papel,
desativar a conta — e, desde o `029`, **sair** — incrementa a versão, e todo
cookie emitido antes deixa de valer na requisição seguinte. Com cookie stateless
não existe revogação por dispositivo, então sair encerra **todas** as sessões
daquela conta, o mesmo contrato da troca da própria senha: é por isso que o painel
pergunta ("Sair de todos os aparelhos?") e que a tela de login mostra o recado. A
sessão de bootstrap não tem conta e sai apagando só o cookie.

Duas consequências assumidas:

- O middleware precisa **ler o usuário a cada requisição autenticada** para
  conferir `token_version` e `is_active`. O painel passa a tocar o banco em
  rotas que hoje não tocam. É um `SELECT` por chave primária num app de baixo
  volume; em troca, não há linhas de sessão para expirar e limpar.
- A verificação de versão **não** entra em `@purple-skills/shared` — ele não
  fala com o banco, e essa fronteira se mantém. `shared` assina e valida o
  formato; o middleware do admin decide se a sessão ainda vale.

Isto revogou a decisão "sessão stateless, sem session store" da `§7.1`: ela
continua stateless, mas não é mais autossuficiente. Ver `§7.6` das decisões.

### 2.3 Bootstrap e o fim da `ADMIN_PASSWORD`

Enquanto a tabela `users` estiver **vazia**, a rota `/setup` aceita a
`ADMIN_PASSWORD` e cria o primeiro `admin`. A partir da primeira conta:

- `/setup` responde 404;
- o login por `ADMIN_PASSWORD` é **recusado** no painel.

**A primeira conta é sempre o `admin` do `/setup`** (relatório 001 da auditoria
de 2026-09-19). As duas regras acima fecham com **qualquer** conta, não com o
primeiro administrador, então o painel não deixa a primeira nascer por outro
caminho: com `users` vazia o SSO **não auto-provisiona** ninguém — o login volta
à tela de entrada apontando "Criar o primeiro administrador" — e a sessão de
bootstrap **não cria contas** por `POST /api/users` (400; a tela de contas já não
aparecia nela). Sem isso, um `membro` criado antes do setup deixava a instalação
com conta, sem administrador e sem caminho para criar um. Nenhuma das duas
conferências precisa de lock: conta nunca é apagada, então "já existe conta" não
deixa de ser verdade entre a leitura e a escrita. O portão continua sendo "tabela
vazia", e não "nenhum admin ativo" — trocá-lo reabriria a `ADMIN_PASSWORD` com
contas já existentes, e é decisão de produto ainda aberta. A instalação que já
caiu nesse estado sai dele pela receita de
[`database/README.md`](../database/README.md), "Instalação sem administrador".

Escolhido em vez de CLI (exige shell no host — ruim em PaaS, e um entrypoint
novo na imagem) e em vez de env vars aplicadas no `migrate` (colocaria senha de
pessoa em variável de ambiente e faria o passo do dba criar dados de aplicação,
cruzando a fronteira de `database/`).

**`MCP_ADMIN_TOKEN` não fica inerte.** Continua válido como credencial de
máquina com papel `admin`, registrado no audit como ator `token-global`. Sem
isso, criar o primeiro usuário derrubaria todo agente MCP já configurado — a
instalação ficaria viva pela web e morta pelo MCP.

**O administrador solitário adota o que nasceu órfão** (pedido de
17/09/2026). A sessão de bootstrap e o `MCP_ADMIN_TOKEN` não são contas, e o
que criam — skills e catálogos — fica sem dono. No `/setup` e a cada login
(senha ou SSO) de uma conta `admin` que seja a **única admin ativa**, o painel
chama `adoptOrphans` (`@purple-skills/db`): toda skill e todo catálogo sem
dono passam a ser dela, cada um auditado como uma transferência (`update` /
`catalog.update` com o e-mail no label; no setup, com o ator `bootstrap`).
Com dois ou mais admins ativos nada acontece — não há como escolher o dono.
vMCPs ficam de fora: o `public`/padrão nasce órfão de propósito (`09`,
decisão 6). A adoção é melhor esforço: uma falha vai para o log e não impede
a entrada.

### 2.4 OIDC

Opcional, ligado por `OIDC_ISSUER`. Fluxo authorization code + PKCE via
`openid-client` (discovery automático; não escrever o fluxo à mão).

- **Auto-provisionamento** cria o usuário como ~~`leitor`~~ **`membro`** no
  primeiro login (`resolveOidcUser` em `apps/admin/src/accounts.ts`; o papel
  foi renomeado pelo `017`). Conta que já existe mantém o papel que tem.
- **`OIDC_ALLOWED_DOMAINS` é obrigatória para o SSO inteiro**, não só para o
  auto-provisionamento. Vazia, **nenhum login OIDC passa** — nem o de uma conta
  que já existe e já está vinculada, porque `resolveOidcUser` confere a
  allowlist **antes** de procurar a conta. É a falha fechada: uma instalação mal
  configurada não vaza o catálogo privado a qualquer conta do provedor. Quem
  recupera é o login local, e o 401 nomeia a variável para o operador não
  procurar o erro no domínio de quem tentou entrar.
- A allowlist vale nos **três** caminhos: autenticar, provisionar e **vincular**.
  E-mail fora dos domínios autorizados não faz nenhum dos três.
- **Vinculação é sempre pelo e-mail.** Um login OIDC cujo e-mail bate com uma
  conta local assume aquela conta, com o papel que ela já tem. O vínculo entra
  na trilha como `user.link` (`§2.8`).
- **O primeiro acesso por SSO descarta a senha temporária** (relatório 002 da
  auditoria de 2026-09-19). Conta criada em "Nova conta" nasce com senha
  temporária e `must_change_password` — é o "convite" de quem usa
  `OIDC_AUTO_PROVISION=false`. Ao vincular, se a flag ainda está ligada, a
  temporária **morre junto**: `password_hash` vira nulo (a conta passa a ser
  só-SSO), a flag cai e `token_version` sobe. Quem chegou ali provou a posse do
  e-mail pelo provedor (`email_verified`), a mesma força do link de redefinição;
  a tela de troca cobrava um segredo que só o administrador viu, e desligar só a
  flag deixaria a temporária valendo para sempre. A pessoa define uma senha
  depois, em Minha conta, sem precisar da anterior. Senha escolhida pela própria
  pessoa não é tocada. A identidade **já vinculada** cujo administrador gera uma
  temporária continua devendo a troca: ali houve um ato explícito de quem
  administra, e a temporária foi entregue a quem a pediu.
- **Com `users` vazia o SSO não cria a primeira conta** (`§2.3`): autenticar e
  vincular exigem conta que já existe, e provisionar espera o `/setup`.
- O papel **nunca** vem de claim ou grupo do provedor; é sempre definido no
  painel.

> **Risco residual (`§13`):** com vinculação sempre pelo e-mail, um IdP que
> permita a alguém declarar um e-mail arbitrário *dentro de um domínio
> autorizado* consegue assumir a conta correspondente, inclusive a de um admin.
> A mitigação é operacional: só configure `OIDC_ISSUER` apontando para um
> provedor que você controla ou confia, e restrinja
> `OIDC_ALLOWED_DOMAINS` a domínios sob sua administração.
>
> **Desde o `013` isto deixou de valer para a vinculação:** vincular a uma conta
> local que já existe exige `email_verified` verdadeiro, porque vincular é assumir
> papel, posse e concessões, e a allowlist de domínio só responde de onde vem o
> endereço, não quem é o dono dele. A mitigação operacional continua valendo para
> os outros dois caminhos — autenticar e provisionar — e para o IdP que não emite o
> claim, que hoje simplesmente não vincula (ver
> [`03`](03-implementation-notes.md), "Contas, papéis e credenciais").

### 2.5 Chaves de API e o MCP administrativo

`requireBearer` ([`mcp-admin/auth.ts`](../apps/mcp-admin/src/auth.ts)) passa a
aceitar dois formatos:

| Credencial | Ator no audit | Papel |
|------------|---------------|-------|
| `MCP_ADMIN_TOKEN` | `token-global` | `admin` |
| `psk_<prefixo>_<segredo>` | o usuário dono | o papel do dono |

A chave é resolvida pelo **prefixo** (indexado) e conferida por hash do segredo.
~~Chave de usuário `leitor` só executa as tools de leitura~~; chave de usuário
desativado não autentica. As tools de `tools.ts` passam a receber o ator para
gravá-lo no `audit_log`.

> **Revogado neste ponto por [`12`](12-acesso-granular.md)** (decisão 12, a
> derivação "chave `psk_`" da `§2` e a tabela da `§3.3`): a chave carrega o
> papel **e as concessões** do dono, e "faz o que o membro faz no painel". O
> papel barra só **criar** — `create_skill`, `create_catalog` e
> `create_virtual_mcp` exigem `editor`+ (`canCreate`, em
> `packages/shared/src/roles.ts`) — e escolher o MCP padrão, que é do `admin`.
> Todo o resto é o nível de acesso **ao objeto**: `set_file`, `set_files_bulk`
> e `delete_file` pedem `edit`; `share_*`, `unshare_*` e as chaves `psv_` de um
> vMCP, `manage`; `delete_*` e `transfer_*`, ser o dono (`loadSkill` e
> `assertAccess`, em `apps/mcp-admin/src/access.ts`). Uma chave de `membro` que
> é dono ou tem concessão **escreve, compartilha, apaga e transfere**; sem
> posse nem concessão, não vê nem o que tentaria escrever (404 antes de 403).
> Quem entrega uma `psk_` a um agente entrega o alcance inteiro da conta.

O texto completo da chave aparece **uma vez**, no momento da emissão. O banco
guarda só o hash e o prefixo.

### 2.6 Recuperação de senha

SMTP é **opcional**:

- Configurado → "esqueci a senha" envia link de uso único (`reset_tokens`,
  com expiração).
- Ausente → o botão explica que o admin precisa resetar. O admin gera senha
  temporária no painel e a conta entra com `must_change_password` — e sem a
  trava de login, se havia uma (`§2.7`).

Assim o `docker compose up` continua funcionando sem infraestrutura de e-mail,
e quem configurar SMTP ganha a experiência completa.

Vale **um** link vivo por conta de cada vez (`027`): emitir fecha os anteriores, e
**qualquer troca de senha** fecha os vivos — por trigger em `users`, então valem
igual o link consumido, a redefinição pelo admin e a troca pelo próprio dono. A
redefinição pelo admin também é **auditada**, como `user.password` com o e-mail da
conta afetada em `target_label` (`030`).

Sem `ADMIN_PUBLIC_URL`, o link só é montado para pedido vindo de rede interna; de
fora, a rota responde `503 public_url_required` e manda procurar o administrador
(`003`, `02` §7.1).

### 2.7 Rate limiting no login

Duas camadas, porque nenhuma sozinha resolve:

- **Janela em memória por IP** — absorve o ruído sem tocar o banco. IPv6 conta
  por **/64**, não por endereço — quem tem um prefixo roteado trocaria de origem
  a cada tentativa —, e `::ffff:a.b.c.d` divide o balde com o IPv4: é o limitador
  de `@purple-skills/shared`, o mesmo do site e do MCP público (relatório 008 da
  auditoria de 2026-09-19).
- **`users.locked_until`** — sobrevive a restart e vale para múltiplos
  containers do painel.

Fecha o risco "login sem rate limiting" da `§13` justamente quando ele cresce:
com contas nomeadas, o atacante passa a conhecer o usuário.

A trava da conta vence sozinha (`LOGIN_LOCK_SECONDS`) ou sai junto com a **senha
temporária gerada por um administrador**: a redefinição zera `failed_attempts` e
`locked_until` no mesmo `UPDATE` da senha (relatório 005 da auditoria de
2026-09-19). O login confere a trava **antes** da senha, então sem isso a
temporária certa era recusada com 429 até o prazo vencer — e a ficha da conta
prometia o contrário. A troca pelo próprio dono não mexe na trava. No **link de
redefinição por e-mail** a trava continua como está: destravar ali devolve oito
tentativas contra uma senha que acabou de mudar, e é decisão do mantenedor, ainda
aberta.

### 2.8 Auditoria

`audit_log` ganha `actor_user_uuid` e `actor_label` (para `token-global` e para
o bootstrap), e o `CHECK` de `action` é ampliado para incluir `user.create`,
`user.role`, `user.deactivate`, `key.create`, `key.revoke` e — desde o `030` —
`user.password`, a troca da senha de uma conta por quem não é ela. Essas linhas não
têm `skill_uuid` — a coluna já é nula.

Desde o relatório 003 da auditoria de 2026-09-19 entram também os outros dois
eventos que mudam **quem consegue entrar** numa conta:

- `user.activate`, o par de `user.deactivate`: reativar devolve de uma vez o
  login, as concessões e as chaves `psk_` da conta. Ator = quem reativou;
  `target_label` = e-mail da conta. Só grava quando o estado mudou de fato.
- `user.link`, a identidade OIDC que passa a abrir uma conta local que já existia
  (`§2.4`). O ator é o **caminho** — `oidc:<issuer>`, sem conta, o mesmo rótulo
  do `user.create` por SSO —, e `target_label` leva o e-mail da conta e o
  `subject` que a assumiu, mais a nota "senha temporária descartada" quando o
  vínculo a levou junto. Acontece **uma vez por conta**: não é login, e a entrada
  seguinte pela identidade já vinculada não grava nada. É melhor esforço, como
  `user.password` — quando a linha é escrita o vínculo já foi gravado, e derrubar
  o login ali deixaria a conta vinculada e a trilha igualmente sem a linha.

Login e falha de login **não** são auditados: o rate limiting já os trata, e
incluí-los faria o log crescer numa ordem de grandeza diferente da atual, o que
traria uma discussão de retenção que este projeto ainda não tem.

Ler a trilha é privilégio de `admin`. `actor_label` e `target_label` guardam
e-mails de contas, então `GET /api/audit` fica atrás do mesmo guarda de
`/api/users*`; o painel esconde o cartão de auditoria para os demais papéis.

## 3. Modelo de dados

Domínio do agente dba, em `database/schema/004-contas.sql`.

> **Revogado neste ponto por [`12`](12-acesso-granular.md):** o `CHECK` abaixo
> é o do `004`, como foi escrito. O `017` o trocou por
> `CHECK (role IN ('admin', 'editor', 'membro'))`, depois de um
> `UPDATE users SET role = 'membro' WHERE role = 'leitor'` — quem copiar o
> `CHECK` daqui grava um papel que o banco recusa.

```
users
  uuid                  UUID PK DEFAULT uuidv7()
  email                 TEXT NOT NULL         -- único por lower(email)
  name                  TEXT NOT NULL
  password_hash         TEXT                  -- NULL = conta só-OIDC
  role                  TEXT NOT NULL CHECK (role IN ('admin','editor','leitor'))
  is_active             BOOLEAN NOT NULL DEFAULT true
  token_version         INTEGER NOT NULL DEFAULT 0
  must_change_password  BOOLEAN NOT NULL DEFAULT false
  oidc_issuer           TEXT
  oidc_subject          TEXT                  -- único com oidc_issuer
  locked_until          TIMESTAMPTZ
  failed_attempts       INTEGER NOT NULL DEFAULT 0
  last_login_at         TIMESTAMPTZ
  created_at / updated_at

api_keys
  id            UUID PK DEFAULT uuidv7()
  user_uuid     UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE
  name          TEXT NOT NULL
  prefix        TEXT NOT NULL UNIQUE   -- indexado; é por ele que a busca começa
  key_hash      TEXT NOT NULL
  last_used_at  TIMESTAMPTZ
  revoked_at    TIMESTAMPTZ
  created_at

reset_tokens
  id          UUID PK DEFAULT uuidv7()
  user_uuid   UUID NOT NULL REFERENCES users(uuid) ON DELETE CASCADE
  token_hash  TEXT NOT NULL
  expires_at  TIMESTAMPTZ NOT NULL
  used_at     TIMESTAMPTZ
  created_at

skills     + created_by_user_uuid UUID REFERENCES users(uuid) ON DELETE SET NULL
audit_log  + actor_user_uuid      UUID REFERENCES users(uuid) ON DELETE SET NULL
           + actor_label          TEXT
           • CHECK de action ampliado (ver §2.8)
```

Hash de senha e de chave por **scrypt** do `node:crypto` — o projeto já o usa
para derivar o segredo de sessão em
[`admin/config.ts`](../apps/admin/src/config.ts), e evita uma dependência
nativa como argon2. Na implementação os dois custos ficaram diferentes, pelo
motivo registrado em [`03-implementation-notes.md`](03-implementation-notes.md).

A implementação acrescentou `audit_log.target_label` ao que está acima: sem
ele, um evento de conta não registra sobre **quem** foi.

## 4. Impacto por área

| Área | Mudança |
|------|---------|
| `database/` | `004-contas.sql`; queries novas em `@purple-skills/db` (`getUserByEmail`, `getUserByUuid`, `createUser`, `setRole`, `deactivate`, `bumpTokenVersion`, `resolveApiKey`, `createApiKey`, `revokeApiKey`, `consumeResetToken`). **Todas de responsabilidade do dba** — nenhum app escreve SQL |
| `packages/shared` | Payload de sessão com `role`/`ver`; hash de senha; geração e hash de chave `psk_`; normalização de e-mail |
| `apps/admin` | `requireAuth` carrega o usuário; **era**, até o [`12`](12-acesso-granular.md): novo `requireRole()` nas ~19 rotas de `api.ts` — hoje `requireRole` não existe: o guarda de papel é `requireCreate`, só nos `POST` que criam, mais `requireAdmin` e `requireSettingsAdmin`, e o resto é o acesso ao objeto; rotas `/api/setup`, `/api/users*`, `/api/me/password`, `/api/me/keys`, `/api/auth/oidc/{start,callback}`, `/api/password-reset/*` |
| `apps/admin/web` | Telas de setup, usuários e chaves; troca de senha; badge de papel; botão OIDC condicional; **era**, até o [`12`](12-acesso-granular.md): UI de leitor sem ações de escrita — hoje o papel esconde só o "criar", e o resto da tela segue o acesso a cada objeto |
| `apps/mcp-admin` | `requireBearer` com dois formatos; ator propagado até o `audit_log`; **era**, até o [`12`](12-acesso-granular.md): tools de escrita recusam `leitor` — hoje só as `create_*` (e `set_default_virtual_mcp`, do admin) olham o papel (`§2.5`) |
| `apps/mcp-public`, `apps/site`, `apps/homepage` | **Não mudam** |
| Dependências | `openid-client` e `nodemailer` — as duas primeiras dependências externas de peso do projeto |
| `.env.example` | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET(_FILE)`, `OIDC_ALLOWED_DOMAINS`, `OIDC_AUTO_PROVISION`, `SMTP_URL(_FILE)`, `SMTP_FROM`, `ADMIN_PUBLIC_URL`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_SECONDS` |
| Docs | `§7.1`/`§7.2` reescritas, `§7.6` registrando o que foi revogado, `§13` revisada; desvios em `03-implementation-notes.md`; README com seção de contas |
| Testes | `shared`: hash, chaves, payload. `admin`: middleware de papel, `/setup` fechado com `users` não vazia, `token_version` derrubando sessão. `mcp-admin`: chave resolve ator e — **era**, até o [`12`](12-acesso-granular.md) — leitor não escreve; hoje `tools.test.ts` fixa o contrário: "membro edita e apaga o que é seu; view só lê". Integração dba: `users` e `api_keys` |

### 4.1 Quebra de compatibilidade

`ADMIN_PASSWORD` muda de significado: deixa de logar assim que existir o
primeiro usuário. Instalações existentes sobem normalmente (a tabela `users`
nasce vazia e `/setup` fica disponível), mas quem não passar pelo setup fica
com a senha antiga funcionando indefinidamente — o que é o comportamento
desejado para quem não quer contas.

O projeto está em `1.0.0-beta.7`; a mudança cabe na série beta, com nota
explícita no README.

## 5. O que ficou de fora

- **Ownership por skill** e `skill_collaborators` — decisão 6.
- **Fluxo de revisão** (rascunho → em revisão → publicada) — exigiria uma
  máquina de estados no lugar do booleano `is_public`.
- **RBAC com permissões compostas** — desproporcional; três papéis fixos cobrem
  o caso.
- **Tabela de sessões** e lista de dispositivos — decisão 7.
- **Auditoria de login/falha de login** — `§2.8`.
- **Papel vindo de grupo do IdP** — `§2.4`.
