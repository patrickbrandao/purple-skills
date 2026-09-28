# Instruções do MCP virtual: a mensagem de sistema de cada servidor

**Status: implementado**, num PR. Pedido de 27/09/2026. Migration
`036-instrucoes-do-mcp-virtual.sql`.

Este documento registra *o que* muda e *por que*. O resumo entra em
[`02-architecture-decisions.md`](02-architecture-decisions.md) (`§12.13`), e os
comentários de `apps/mcp-public/src/server.ts` e de
`database/schema/036-instrucoes-do-mcp-virtual.sql` valem tanto quanto este
texto.

> **Revoga a decisão 15 do [`08`](08-mcp-virtual.md)**, na metade das
> instruções, e a frase da `§4.4` que a explicava — marcadas lá. O
> `serverInfo.name = <MCP_SERVER_NAME>-<slug>` da mesma decisão continua
> valendo. Conferi também o [`09`](09-mcp-padrao-e-skills-flutuantes.md) (a
> raiz é o vMCP padrão e recebe as mesmas instruções: intocado) e o
> [`17`](17-skills-extension.md) (a decisão 22, as instructions apontando a
> extensão sem abandonar as ferramentas, continua no texto-base).

## 1. Por que

Até aqui um vMCP tinha um texto só, a `description`, e ele fazia dois
trabalhos: era o que as pessoas liam no painel e no cartão do site, e era o que
o agente recebia no `instructions` do `initialize`, depois do texto-base. Os
dois leitores querem coisas diferentes:

- quem **administra** escreve na descrição para gente — "pedido do time da
  Ana", "servidor do projeto X, não abrir", "em migração" — e não espera que
  isso chegue ao contexto de um modelo;
- quem **orienta o agente** quer dizer outra coisa, em outro tom e, de
  preferência, em inglês: para que o servidor serve, por qual skill começar, o
  que evitar.

Com um campo só, escrever para um estragava o outro. O mantenedor decidiu
separar: a `description` fica para exibição, buscas e comentário geral, e um
campo novo, `instructions`, é a mensagem de sistema do servidor.

## 2. Decisões

| # | Tema | Decisão |
|---|------|---------|
| 1 | Coluna | `virtual_mcps.instructions TEXT NOT NULL DEFAULT ''`; vazio = só o texto-base |
| 2 | Teto | 4 000 caracteres, `VIRTUAL_MCP_INSTRUCTIONS_MAX` do `shared` e CHECK `virtual_mcps_instructions_len_chk` no banco |
| 3 | O que vai ao agente | texto-base + `Instructions from the administrator of this server:` + `instructions`. A `description` não vai mais |
| 4 | Migração dos dados | a `036` copia a `description` de cada vMCP para `instructions` (cortada no teto) |
| 5 | Permissão | como a `description`: mudar é `manage` |
| 6 | Clonagem | a cópia leva as `instructions` |
| 7 | Painel | um campo próprio, desenhado como uma mensagem `system` de transcript, na configuração do servidor e no "Novo servidor"; leitura na gaveta do nó servidor do canvas |
| 8 | Site | no cartão do vMCP **aberto**, fechadas num `<details>` rotulado `system`; o `/api/meta` não as leva, como não leva a descrição |
| 9 | mcp-admin | `create_virtual_mcp` e `update_virtual_mcp` recebem `instructions`; `get_virtual_mcp` as devolve; o texto do próprio mcp-admin explica a diferença |

### 2.1 Por que o texto do dono vai depois do texto-base, e rotulado

O texto-base diz como o servidor funciona (as ferramentas, a extensão de
skills, os downloads) e é igual em toda instalação. A mensagem do dono
contextualiza esse funcionamento — "estas são as skills do projeto X; comece
por…" — e só faz sentido depois dele. O rótulo existe para o agente saber que
ali fala quem administra aquele servidor, e não o Purple Skills: é uma fonte
diferente, e o modelo pode pesar as duas de jeitos diferentes.

### 2.2 Por que copiar a descrição na migração

Sem a cópia, todo vMCP que já tinha descrição passaria a mandar ao agente só o
texto-base, sem ninguém ter mudado nada. Com ela, o agente continua recebendo
exatamente o que recebia. A `description` fica intacta, e quem quiser separar
os dois textos edita cada um no painel. A duplicação é o preço, e é visível:
os dois campos aparecem lado a lado na configuração do servidor.

### 2.3 Por que um teto

As instruções entram inteiras no contexto do agente a cada `initialize`, em
todo cliente. 4 000 caracteres (~1 000 tokens) orientam o uso de um servidor
com folga; mais que isso já é uma skill, e cabe como skill. O número mora no
`shared`; o painel tem uma cópia (o bundle de navegador não importa o pacote)
conferida por `apps/admin/web/src/mcps.test.ts`, e o banco guarda o mesmo
número no CHECK.

### 2.4 Por que o site só mostra as do vMCP aberto

É a mesma regra da `description` (`apps/site/src/api.ts`, `mcpPublico`): as
`instructions` são texto livre e podem citar cliente, projeto ou pessoa. Vão ao
site só por `/api/mcps`, que lista os vMCPs abertos e ligados — o que qualquer
cliente sem chave já receberia no `initialize`. O vMCP padrão **fechado** não
as expõe em lugar nenhum do site.

## 3. O que não muda

- **Sessões abertas não recebem a mudança.** O `instructions` só existe no
  `initialize`; o protocolo não tem notificação para atualizá-lo. Quem edita
  vê o aviso no painel, e a descrição das tools do mcp-admin diz o mesmo.
- **As instruções do mcp-admin** continuam sendo uma constante do código, igual
  para toda credencial: ali não há servidor de usuário.
- **Nenhuma busca lê as `instructions`.** O que identifica o servidor para
  quem procura e lista — nome, slug, descrição — continua sendo o que era.
