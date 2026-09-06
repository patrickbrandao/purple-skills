# Contas, papéis e credenciais de agente

**Status: implementado.** Este documento registra o desenho que substituiu a
senha única do painel por contas de usuário com papéis, e continua sendo a
referência de *por que* cada peça é assim. O resumo do que está no ar está na
`§7.1` de [`02-architecture-decisions.md`](02-architecture-decisions.md); os
desvios e as decisões que esta spec deixou em aberto, em
[`03-implementation-notes.md`](03-implementation-notes.md).

O plano de execução, com as três fases marcadas como entregues, está em
[`../tasks/contas-e-papeis.md`](../tasks/contas-e-papeis.md).

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
| 9 | OIDC | Auto-provisiona como `leitor`, com allowlist de domínio **obrigatória** |
| 10 | Vinculação OIDC ↔ conta local | Sempre pelo e-mail, **dentro dos domínios autorizados** |
| 11 | Recuperação de senha | Link por e-mail quando há SMTP; sem SMTP, reset pelo admin |
| 12 | Escopo extra | Rate limiting no login, `created_by` nas skills, desativar em vez de deletar, auditoria dos eventos críticos de conta |

### 2.1 Papéis

Papéis são **globais**, não por skill. Não há ownership: um editor mexe em
qualquer skill. O que separa os três é a ação permitida.

| Ação | admin | editor | leitor |
|------|:-----:|:------:|:------:|
| Ver skills (inclusive privadas) | ✅ | ✅ | ✅ |
| Criar / editar skill e arquivos | ✅ | ✅ | ❌ |
| Publicar / despublicar | ✅ | ✅ | ❌ |
| Apagar skill | ✅ | ❌ | ❌ |
| Gerenciar usuários e papéis | ✅ | ❌ | ❌ |
| Emitir chaves de API para si | ✅ | ✅ | ✅ |

A ausência de ownership é o que mantém a mudança barata: sem
`skill_collaborators`, sem JOIN de permissão em toda leitura, sem "transferir
dono" quando alguém sai. `skills.created_by_user_uuid` existe, mas é
**informativo** — não autoriza nada.

> **Leitor enxerga skills privadas.** É o propósito do papel: dar visibilidade
> a quem não edita. Isso torna crítica a allowlist da `§2.4`.

### 2.2 Sessão e revogação

O cookie continua stateless e assinado por HMAC
([`session.ts`](../packages/shared/src/session.ts)), mas o payload passa de
`{ sub: 'admin', exp }` para:

```ts
type SessionPayload = { sub: string; role: Role; ver: number; exp: number };
```

`users.token_version` é a alavanca de revogação. Trocar senha, mudar papel ou
desativar a conta **incrementa** a versão, e todo cookie emitido antes deixa de
valer na requisição seguinte.

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

Escolhido em vez de CLI (exige shell no host — ruim em PaaS, e um entrypoint
novo na imagem) e em vez de env vars aplicadas no `migrate` (colocaria senha de
pessoa em variável de ambiente e faria o passo do dba criar dados de aplicação,
cruzando a fronteira de `database/`).

**`MCP_ADMIN_TOKEN` não fica inerte.** Continua válido como credencial de
máquina com papel `admin`, registrado no audit como ator `token-global`. Sem
isso, criar o primeiro usuário derrubaria todo agente MCP já configurado — a
instalação ficaria viva pela web e morta pelo MCP.

### 2.4 OIDC

Opcional, ligado por `OIDC_ISSUER`. Fluxo authorization code + PKCE via
`openid-client` (discovery automático; não escrever o fluxo à mão).

- **Auto-provisionamento** cria o usuário como `leitor` no primeiro login.
- **`OIDC_ALLOWED_DOMAINS` é obrigatória** para que o auto-provisionamento
  funcione. Vazia, ele fica desligado e só entra quem já foi convidado — falha
  fechado: uma instalação mal configurada não vaza o catálogo privado.
- A allowlist vale nos **três** caminhos: autenticar, provisionar e **vincular**.
  E-mail fora dos domínios autorizados não faz nenhum dos três.
- **Vinculação é sempre pelo e-mail.** Um login OIDC cujo e-mail bate com uma
  conta local assume aquela conta, com o papel que ela já tem.
- O papel **nunca** vem de claim ou grupo do provedor; é sempre definido no
  painel.

> **Risco residual (`§13`):** com vinculação sempre pelo e-mail, um IdP que
> permita a alguém declarar um e-mail arbitrário *dentro de um domínio
> autorizado* consegue assumir a conta correspondente, inclusive a de um admin.
> A mitigação é operacional: só configure `OIDC_ISSUER` apontando para um
> provedor que você controla ou confia, e restrinja
> `OIDC_ALLOWED_DOMAINS` a domínios sob sua administração.

### 2.5 Chaves de API e o MCP administrativo

`requireBearer` ([`mcp-admin/auth.ts`](../apps/mcp-admin/src/auth.ts)) passa a
aceitar dois formatos:

| Credencial | Ator no audit | Papel |
|------------|---------------|-------|
| `MCP_ADMIN_TOKEN` | `token-global` | `admin` |
| `psk_<prefixo>_<segredo>` | o usuário dono | o papel do dono |

A chave é resolvida pelo **prefixo** (indexado) e conferida por hash do segredo.
Chave de usuário `leitor` só executa as tools de leitura; chave de usuário
desativado não autentica. As tools de `tools.ts` passam a receber o ator para
gravá-lo no `audit_log`.

O texto completo da chave aparece **uma vez**, no momento da emissão. O banco
guarda só o hash e o prefixo.

### 2.6 Recuperação de senha

SMTP é **opcional**:

- Configurado → "esqueci a senha" envia link de uso único (`reset_tokens`,
  com expiração).
- Ausente → o botão explica que o admin precisa resetar. O admin gera senha
  temporária no painel e a conta entra com `must_change_password`.

Assim o `docker compose up` continua funcionando sem infraestrutura de e-mail,
e quem configurar SMTP ganha a experiência completa.

### 2.7 Rate limiting no login

Duas camadas, porque nenhuma sozinha resolve:

- **Janela em memória por IP** — absorve o ruído sem tocar o banco.
- **`users.locked_until`** — sobrevive a restart e vale para múltiplos
  containers do painel.

Fecha o risco "login sem rate limiting" da `§13` justamente quando ele cresce:
com contas nomeadas, o atacante passa a conhecer o usuário.

### 2.8 Auditoria

`audit_log` ganha `actor_user_uuid` e `actor_label` (para `token-global` e para
o bootstrap), e o `CHECK` de `action` é ampliado para incluir `user.create`,
`user.role`, `user.deactivate`, `key.create` e `key.revoke`. Essas linhas não
têm `skill_uuid` — a coluna já é nula.

Login e falha de login **não** são auditados: o rate limiting já os trata, e
incluí-los faria o log crescer numa ordem de grandeza diferente da atual, o que
traria uma discussão de retenção que este projeto ainda não tem.

## 3. Modelo de dados

Domínio do agente dba, em `database/schema/004-contas.sql`.

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
| `apps/admin` | `requireAuth` carrega o usuário; novo `requireRole()` nas ~19 rotas de `api.ts`; rotas `/api/setup`, `/api/users*`, `/api/me/password`, `/api/me/keys`, `/api/auth/oidc/{start,callback}`, `/api/password-reset/*` |
| `apps/admin/web` | Telas de setup, usuários e chaves; troca de senha; badge de papel; botão OIDC condicional; UI de leitor sem ações de escrita |
| `apps/mcp-admin` | `requireBearer` com dois formatos; ator propagado até o `audit_log`; tools de escrita recusam `leitor` |
| `apps/mcp-public`, `apps/site`, `apps/homepage` | **Não mudam** |
| Dependências | `openid-client` e `nodemailer` — as duas primeiras dependências externas de peso do projeto |
| `.env.example` | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET(_FILE)`, `OIDC_ALLOWED_DOMAINS`, `OIDC_AUTO_PROVISION`, `SMTP_URL(_FILE)`, `SMTP_FROM`, `ADMIN_PUBLIC_URL`, `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCK_SECONDS` |
| Docs | `§7.1`/`§7.2` reescritas, `§7.6` registrando o que foi revogado, `§13` revisada; desvios em `03-implementation-notes.md`; README com seção de contas |
| Testes | `shared`: hash, chaves, payload. `admin`: middleware de papel, `/setup` fechado com `users` não vazia, `token_version` derrubando sessão. `mcp-admin`: chave resolve ator, leitor não escreve. Integração dba: `users` e `api_keys` |

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
