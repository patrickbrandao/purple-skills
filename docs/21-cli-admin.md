# `purple-admin`: contas pela linha de comando do servidor

**Status: implementado**, num PR. Pedido de 23/09/2026.
Sem migration.

Este documento registra *o que* a CLI faz e *por que* cada peça é assim; o
resumo entra em [`02-architecture-decisions.md`](02-architecture-decisions.md)
(`§12.12`) e os detalhes de implementação em
[`03-implementation-notes.md`](03-implementation-notes.md) ("CLI de contas"). O
código é `apps/admin/src/cli.ts` (comandos) e `apps/admin/src/admin-cli.ts`
(ponto de entrada), e os comentários deles valem tanto quanto este texto.

> **Revoga em parte o [`05`](05-accounts-and-roles.md) `§2.3`**, em dois
> pontos, marcados lá: a frase "Escolhido em vez de CLI" deixou de descrever o
> produto — o `/api/setup` continua sendo o caminho do primeiro administrador,
> mas a CLI passou a existir ao lado dele —, e "a primeira conta é sempre o
> `admin` do `/setup`" vira "a primeira conta é sempre **`admin`**", do `/setup`
> ou da CLI. A invariante que importava (nenhuma instalação nasce com conta e
> sem administrador) continua inteira. Conferi também o
> [`19`](19-username.md) (a CLI nomeia a conta por username, e o e-mail só
> aparece a quem tem shell no servidor — que já lê o banco) e o
> [`12`](12-acesso-granular.md) (papéis e concessões: intocados).

## 1. Por que

O painel resolve quase tudo sobre contas, mas depende de haver alguém que entre
nele. Há situações em que ninguém entra:

- o **único administrador esqueceu a senha** e a instalação não tem SMTP — o
  "esqueci a senha" manda procurar o administrador, que é ele mesmo;
- a instalação ficou **sem administrador ativo** (a primeira conta nasceu
  `membro`, ou o último admin foi desativado por fora do produto);
- a conta de quem administra está **travada** por excesso de tentativas;
- quem opera o servidor quer **criar contas em lote**, por script, sem clicar.

Até aqui, a volta desses casos era SQL à mão no `psql` do container (a receita
"Instalação sem administrador" de [`database/README.md`](../database/README.md)).
Quem tem shell no container **já tem o banco**, então a CLI não abre poder
novo: ela troca o SQL à mão por um caminho que passa pelas mesmas regras do
painel.

## 2. Decisões

1. **Mora na imagem do painel, e não num serviço novo.** É o `admin` que tem as
   regras de conta (`apps/admin/src/accounts.ts`) e o ambiente do banco. A
   imagem instala o atalho `/usr/local/bin/purple-admin`, e o uso é
   `docker compose exec admin purple-admin <comando>`. Com o painel parado (ou
   em reinício), `docker compose run --rm admin purple-admin <comando>` sobe um
   container de uso único com o mesmo ambiente.
2. **As mesmas funções das rotas, não uma cópia.** `user add` é
   `createAccount`; `user role`, `disable` e `enable` são `updateAccount`;
   `user passwd` é `setAccountPassword`, o miolo que a redefinição do painel
   passou a compartilhar. A validação do e-mail, do username, do papel e da
   senha, a derrubada de sessões (`token_version`), a proteção do último
   administrador (inclusive a da transação, `tasks/049`) e a trilha de auditoria
   são as do painel.
3. **O ator na trilha é `cli`**, sem conta (`actor_user_uuid` nulo), como
   `bootstrap` e `token-global`. A origem é `web-admin`, o serviço em que a CLI
   roda: o `CHECK` de `audit_log.source` só conhece `web-admin` e `mcp-admin`, e
   uma origem nova pediria migration sem dar informação que o `cli` do ator já
   não dá.
4. **A primeira conta tem de ser `admin`.** Com a tabela `users` vazia,
   `user add` recusa outro papel: o `/api/setup` e o login pela
   `ADMIN_PASSWORD` fecham com **qualquer** conta, e um `membro` criado aqui
   repetiria o relatório 001 da auditoria de 2026-09-19. O admin criado assim
   **adota os órfãos** como o do `/setup` (`05` `§2.3`).
5. **Senha omitida é sorteada e temporária.** Sem `--password` nem
   `--password-stdin`, `user add` e `user passwd` sorteiam uma senha
   (`generatePassword`), imprimem-na **uma vez** e a conta passa a exigir troca
   no próximo acesso — o mesmo que o botão do painel faz. Senha **escolhida**
   não exige troca, pela regra que o "Nova conta" do painel já seguia; quem
   quiser exigir passa `--temporary`.
6. **`--password-stdin` é o jeito recomendado de informar a senha.** O
   `--password` existe por conveniência, mas o texto fica no histórico do shell
   e na lista de processos do host. Da entrada padrão sai só a quebra de linha
   final (a do `echo`); espaço é parte da senha.
7. **`user passwd` destrava a conta.** Como a redefinição do painel
   (`clearLoginLock`, relatório 005 da auditoria de 2026-09-19): sem isso a
   senha nova, certa, seria recusada com 429 até a trava vencer.
8. **Nada é apagado.** Não existe `user delete`, pela regra do `05`: contas são
   desativadas, para a trilha continuar fazendo sentido.
9. **Códigos de saída distinguem uso de recusa**: `0` deu certo, `1` a operação
   foi recusada por uma regra (conta inexistente, senha curta, e-mail em uso,
   último admin), `2` o comando foi mal escrito. É o que deixa um script decidir
   se vale tentar de novo.

## 3. Comandos

O usuário pode ser nomeado por **username** (`ana` ou `@ana`), **e-mail** ou
**uuid**, pela mesma regra do login (`19`, decisão 3): com `@` é e-mail, sem `@`
é username — um `@` só no começo é descartado —, e o uuid é reconhecido pelo
formato.

| Comando | O que faz | Trilha |
|---------|-----------|--------|
| `user list [--all] [--json]` | Lista as contas ativas (`--all` inclui as desativadas): usuário, e-mail, papel, estado (ativa, travada, desativada), forma de acesso e nome. | — |
| `user show <usuário> [--json]` | Mostra uma conta. | — |
| `user add --username U --email E --role R [--name N] [--password S \| --password-stdin] [--temporary]` | Cria a conta. `--name` omitido vale o username. | `user.create` |
| `user passwd <usuário> [--password S \| --password-stdin] [--temporary]` | Define a senha; sem ela, sorteia uma temporária. Derruba as sessões e tira a trava. | `user.password` |
| `user role <usuário> <admin\|editor\|membro>` | Muda o papel e derruba as sessões. Recusa rebaixar a última admin ativa. | `user.role` |
| `user disable <usuário>` | Desativa: login, sessões, concessões e chaves `psk_` deixam de valer. Recusa a última admin ativa. | `user.deactivate` |
| `user enable <usuário>` | Reativa. | `user.activate` |
| `user unlock <usuário>` | Zera as tentativas e a trava de login. | — |
| `user logout <usuário>` | Derruba todas as sessões e cookies da conta. | — |
| `help` | A ajuda. | — |

`unlock` e `logout` ficam fora da trilha pelo critério que já mantém o login e
o "Sair" fora dela (`05` `§2.8`): são movimento de sessão, não alteração
administrativa da conta. Registrá-los exigiria ações novas no `CHECK` de
`audit_log.action` — trabalho do dba, se um dia fizer falta.

### 3.1 Exemplos

```bash
# O único admin esqueceu a senha: sorteia uma temporária
docker compose exec admin purple-admin user passwd admin@empresa.com

# Senha escolhida, sem ela passar pela linha de comando nem pelo histórico
read -rs SENHA && printf '%s\n' "$SENHA" | docker compose exec -T admin purple-admin user passwd ana --password-stdin; unset SENHA

# Criar uma conta de editor com senha temporária
docker compose exec admin purple-admin user add --username bruno --email bruno@empresa.com --role editor --name "Bruno Lima"

# A instalação ficou sem administrador: promover uma conta
docker compose exec admin purple-admin user role ana admin

# Listar tudo em JSON, para um script
docker compose exec -T admin purple-admin user list --all --json
```

O `-T` do `docker compose exec` desliga o pseudo-terminal: é necessário quando a
senha vem por pipe e útil quando a saída vai para outro programa.

## 4. O que ficou de fora

- **Prompt interativo de senha** (sem eco). `--password-stdin` cobre o caso sem
  depender de TTY, que o `exec -T` e os scripts não têm.
- **Chaves de API pela CLI.** Emitir `psk_` em nome de outra conta é assumir a
  identidade dela no MCP, e o painel deliberadamente só emite para si.
- **Trocar username, e-mail ou nome.** O painel faz, e nenhum dos casos da `§1`
  depende disso.
- **Skills, catálogos e MCPs.** O MCP administrativo e o painel já cobrem; a CLI
  existe para quando **não se consegue entrar**, e isso é assunto de conta.
