# Quarentena: o pacote importado que espera aprovação

**Status: implementado.** Migration `030-quarentena.sql`. Ele **revoga** pontos
do [`13`](13-fichas-e-acessos.md) (§3.2), do [`02`](02-architecture-decisions.md)
(§4) e do [`03`](03-implementation-notes.md) (o `.zip` do painel e o envio
avulso): o "Importar .zip" e o "Substituir a árvore por um .zip" da guia
**Arquivos** não existem mais, e o envio avulso daquela guia passou a aceitar
**só texto**. Os trechos estão marcados nos três.

> **Revisado em 20/09/2026**, depois de uma validação multiagente: as decisões
> 7, 12 e 13 mudaram, e as 14 a 17 entraram. Cada ponto revisado está marcado
> onde estava.

Este documento registra o desenho fechado na conversa de 20/09/2026 e é a
referência de *por que* cada peça é assim; o que é do banco — tabelas, queries,
a transação da promoção — está em
[`../database/README.md`](../database/README.md), que é do agente dba.

## 1. Por que

Até aqui havia um caminho só para um pacote de terceiro: importar um `.zip` (ou
`.skill`, que é o mesmo ZIP) e a skill nascia no acervo, pronta, com nome, slug,
tags e — se quem importou marcasse — já publicada num servidor MCP. Quem recebe
pacote de fora nem sempre quer isso: quer olhar o que veio antes de o conteúdo
virar skill, ser fatiado pelo RAG e ficar ao alcance de um agente.

Um "rascunho de skill" resolveria, mas cobraria caro: rascunho é uma skill a
menos de alguma coisa, e cada coluna, índice, trigger e tela do acervo teria de
aprender a conviver com ele. É o caminho que cria uma segunda skill dentro da
primeira.

A quarentena é a escolha oposta: um espaço **separado e pobre**, que não sabe o
que é slug, tag, vínculo nem vetor. Ele guarda arquivos com um dono e uma data.
A única operação que o liga ao acervo é a aprovação — e ela é uma criação de
skill como qualquer outra, com o pacote já conferido.

## 2. Decisões

1. **Só a importação alcança a quarentena.** O formulário de nova skill
   continua criando direto em produção: quem escreve a skill no painel já
   decidiu o que ela é. O portão existe para o pacote que veio de fora.
2. **O destino é de quem importa**, escolhido na tela de importação, e não uma
   propriedade da instalação. A mesma pessoa manda um pacote de confiança
   direto para produção e o pacote de origem duvidosa para a fila.
3. **Nada de metadado separado do arquivo.** Na skill de produção o nome, a
   descrição e as tags moram em colunas, e o `SKILL.md` gravado é só o corpo —
   o frontmatter é remontado na leitura. Na quarentena o arquivo é a **única**
   verdade: o `SKILL.md` fica com o frontmatter dentro, e é ele que se edita.
   Isso é o que torna o espaço simples: não há dois lugares para o mesmo dado,
   logo não há como eles discordarem.
4. **Sem RAG, sem busca, sem site, sem MCP.** Nenhum trigger de `rag_stale`
   alcança as tabelas novas, e nenhuma consulta de skill as enxerga. Um envio
   não é conteúdo publicado: é anexo esperando decisão.
5. **Não há colisão de nome.** Dois envios do mesmo pacote convivem, e o nome
   nem é chave — é rótulo, lido do `name:` do `SKILL.md` ou do arquivo enviado.
   A identidade é o `uuid` (`uuidv7`, como o resto do banco), que também é o
   endereço no painel, porque envio não tem slug. Recusar duplicata obrigaria
   quem recebe dois pacotes parecidos a escolher entre eles **antes** de poder
   abri-los.
6. **O envio pertence a quem o submeteu.** É dele para editar e descartar, e é
   dele o nome que fica na skill quando o envio for aprovado.
7. **Aprovar cria a skill com o dono sendo quem aprovou.**

   ~~**Aprovar cria a skill com o dono do envio**, e registra quem aprovou em
   `created_by_user_uuid`. O admin que passa a mão na fila não toma para si o
   trabalho de quem trouxe o pacote.~~

   > **Revisado em 20/09/2026.** A regra antiga tinha um defeito medido: com a
   > política `admin+editor`, o editor que aprovava o envio de outra pessoa
   > criava uma skill privada, flutuante e sem concessão — e **deixava de
   > enxergá-la no mesmo instante** (`skillVisibleTo` não o alcança, e
   > `loadSkill` vira 404). Ele aprovava, lia o aviso de sucesso e caía numa
   > tela de "Skill não encontrada", sem poder desfazer nem publicar o que
   > acabara de criar. As saídas eram três — conceder acesso a quem aprova, não
   > navegar para a skill, ou inverter o dono —, e o mantenedor escolheu
   > inverter: quem aprova responde pela skill que colocou no acervo, e quem
   > submeteu continua registrado na trilha (`quarantine.promote`).
8. **A skill nasce flutuante.** Sem servidor, sem catálogo, `is_public` falso.
   Publicar é um ato à parte, depois, na ficha da skill — e é assim que a
   aprovação não vira, por descuido, uma publicação.
9. **Slug ocupado ganha sufixo** (`-2`, `-3`), como já acontece quando o slug
   vem do nome. Aprovar não trava por causa de um nome repetido; renomear
   depois é uma edição.
10. **Aprovado some da quarentena.** A fila é o que está pendente, não um
    histórico: o que aconteceu com um envio aprovado está na trilha de
    auditoria (`quarantine.promote`) e na skill que nasceu.
11. **Quem aprova é configuração da instalação** (§4), não regra fixa. Quem
    **revisa** — lê e corrige os arquivos do envio — é sempre quem enxerga a
    fila; a política decide só o ato de criar a skill.
12. **Pacote torto entra na fila**: sem `SKILL.md`, ou com um `SKILL.md` que
    não é texto UTF-8 (Windows-1252, UTF-16 — o que sai de um editor Windows).
    Consertar o que veio torto é para o que a quarentena serve; o arquivo entra
    byte a byte e é editado ali. Quem cobra as duas coisas é a **aprovação**,
    que sem um `SKILL.md` legível não sabe que skill criar — e a recusa não
    apaga nada.

    > **Revisado em 20/09/2026.** A primeira versão só tolerava a *ausência* do
    > arquivo: um `SKILL.md` fora de UTF-8 era recusado pelo `extractZip` antes
    > de o destino ser lido, e o espaço criado para consertar pacote torto era
    > justamente o que não aceitava o caso mais comum. Hoje a importação para a
    > quarentena passa `allowBinarySkillMd`, e produção continua recusando.
13. **A edição de uma skill recebe só texto** (§6), e isso vale para as **duas**
    portas: o envio avulso (multipart) e as rotas de arquivo por JSON. Estas
    carregam `content: string`, mas quem decide texto × binário na gravação é a
    **extensão** — sem a guarda, `PUT …/ref/logo.png` com um texto respondia 200
    e gravava uma linha binária que toda leitura devolvia como `content: null`,
    e uma imagem vinda do pacote era sobrescrita por um punhado de bytes, sem
    aviso. O pacote passou a ter um caminho só, a importação, e esse caminho
    decide entre os dois destinos.
14. **O envio tem teto de arquivos**, o mesmo do pacote
    (`DEFAULT_MAX_ZIP_ENTRIES`, 512): um envio é o retrato de um `.zip`, e o que
    não cabe num não deve caber no outro. Sem ele, a criação um a um não tinha
    limite nenhum — medido, 600 chamadas gravaram 602 arquivos num envio.
15. **A lista de tags em bloco do YAML é lida.** `tags:` seguida de `- alfa` —
    a forma que a especificação Agent Skills usa com mais frequência — era
    descartada pelo parser de frontmatter, e a skill nascia sem tag nenhuma,
    contra o que a caixa de confirmação da aprovação promete. Vale para a
    importação direta também, que usa o mesmo caminho.
16. **`canPromote` é contrato, não improviso.** Ele não é dado do banco: é a
    política aplicada a quem pediu. Mora no tipo compartilhado
    (`QuarantineSheet`) em vez de ser declarado solto nas duas pontas, porque é
    o que decide se o botão "Aprovar" aparece. A decisão que **vale** continua
    sendo a da rota de promover, que confere de novo.
17. **Trocar a árvore de uma skill que já existe não tem substituto no painel**
    (§6). É o que a remoção do `.zip` da edição custou, e está dito assim em vez
    de prometer um caminho que não funciona.
18. **Promover exige o papel de criar** (`canCreate`), além da política. Promover
    *é* criar uma skill, e o papel limita a ação (`docs/12` decisão 12). Sem
    isso, a conta rebaixada a `membro` depois de enviar continuava aprovando o
    próprio envio na política padrão e, como dona da skill que nascia, podia
    torná-la pública — enquanto `POST /api/skills` lhe devolvia 403. O envio
    dela continua visível e editável (§3.1); o que fechou foi o portão.

## 3. O espaço

Duas tabelas, `quarantine_skills` e `quarantine_files` (o desenho completo está
no README do banco). O envio tem `uuid`, `name`, `description`,
`source_filename`, `owner_user_uuid` e as duas datas; os arquivos são texto
**ou** binário, como os de uma skill, com o caminho único dentro do envio e sem
o `content_sha256`, que só existe para o RAG.

O que **não** existe, e a ausência é o ponto: slug, tags, ícone, `is_active`,
`is_public`, contadores, `search_vector`, `rag_stale`, vínculo com vMCP ou
catálogo e concessões por objeto (`*_grants`).

### 3.1 Quem enxerga

O dono do envio, o administrador e o editor. Submeter exige o papel de criar
(`canCreate`, editor para cima), então na prática a fila é dos editores e dos
administradores; o dono continua enxergando o que submeteu mesmo se perder o
papel de editor — sumir com o trabalho dele numa troca de papel seria perder
trabalho sem aviso.

Quem enxerga **também edita e descarta**. Não há nível intermediário: o espaço
não tem concessão por objeto, e inventar uma aqui seria trazer de volta a
complexidade que a §1 recusou. Quem não enxerga recebe **404**, não 403 — a
existência de um envio alheio não se confirma.

## 4. Quem aprova

A chave `quarantine.approvers` em `settings`, com três valores:

| Valor | Quem promove | Quando serve |
|-------|--------------|--------------|
| `admin` | só administradores | o portão fechado: nenhum editor aprova, nem o que ele mesmo trouxe |
| `admin+owner` (**padrão**) | administradores e o dono do envio | quem já podia criar a skill pelo formulário também aprova o próprio envio |
| `admin+editor` | administradores e editores | qualquer editor aprova qualquer envio da fila |

O padrão é o do meio de propósito. O portão existe para o pacote de terceiro,
não para atrapalhar quem já tinha o poder de criar a mesma skill à mão; quem
quiser o portão de verdade fechado escolhe `admin`, e a escolha fica auditada
(`quarantine.settings`).

A política **amplia o portão, nunca o acesso**: quem não enxerga o envio não o
promove em política nenhuma — e para antes disso, no 404.

## 5. O painel

**Quarentena** é um item próprio da barra lateral, ao lado do acervo e não
dentro dele: o que está ali ainda não é skill. Só quem pode criar chega a vê-lo.

- **`/quarentena`** — a fila, mais recentes primeiro: nome, arquivo de origem,
  quem enviou, quantos arquivos, tamanho e quando chegou. Daqui se baixa o
  pacote como está e se descarta.
- **`/quarentena/:uuid`** — os arquivos do envio e o editor **cru**. O
  `SKILL.md` aparece com o frontmatter dentro dele e é gravado assim. Dá para
  criar e remover arquivo — **só texto**, e até o teto da decisão 14; não há
  envio de arquivo aqui — pacote se importa, e um envio é o retrato de um
  pacote. Um binário que veio dentro do pacote abre como binário, para baixar
  ou remover.
- A importação (`/nova-skill?modo=zip`) ganhou a escolha de destino. Em
  "Para a quarentena" o formulário de metadados e o seletor de servidores
  **somem** da tela: eles não teriam onde encostar, e mostrá-los prometeria
  algo que a tela não cumpre.
- **Configurações → Quarentena** guarda a política da §4.

O botão **Aprovar** só aparece para quem pode; a rota confere de novo, que é
onde a decisão vale. Sem `SKILL.md` ele fica desligado, com o aviso do que
falta.

## 6. O que saiu da edição de uma skill

Revoga a §3.2 do [`13`](13-fichas-e-acessos.md) em dois pontos:

- **"Importar .zip" e "Substituir a árvore por um .zip" não existem mais**, nem
  no menu da árvore, nem na paleta de comandos. A rota que os servia
  (`POST /api/skills/:slug/upload`) saiu junto.
- **O envio avulso aceita só texto**: a mesma régua do banco e do `extractZip`
  (`isTextualContent` — mime textual pelo nome, sem byte nulo e UTF-8 válido).
  Um `.png`, um `.pdf` ou um `.csv` em Windows-1252 é recusado com o nome do
  arquivo na mensagem, e o lote inteiro fica de fora.

O que se perdeu, **e não tem substituto no painel**, é trocar a árvore de uma
skill que já existe — inclusive trazer binário para ela. É o preço de ter um
caminho só para pacote; a alternativa era manter dois lugares onde um ZIP de
terceiro entra, e foi justamente isso que este documento veio desfazer.

> ~~Quem precisa dela importa o pacote de novo — para produção ou para a
> quarentena — e trabalha na skill nova.~~ **Revisado em 20/09/2026:** era
> falso, e foi medido. Importar para produção bate no slug ocupado (**409**,
> porque o import manda o slug do frontmatter explicitamente), e importar para
> a quarentena e aprovar cria uma **segunda** skill — a original fica com a
> árvore velha, o uuid, as concessões e os vínculos. Quem precisa disso hoje
> usa o `set_files_bulk` do MCP administrativo, que continua aceitando ZIP com
> binário e `replace`.

Binário continua chegando ao acervo pela importação, que é onde o pacote
inteiro entra de uma vez — e **só** por ela: as rotas de arquivo por JSON
recusam extensão de binário (decisão 13), porque o que elas gravariam ninguém
conseguiria ler de volta.

## 7. API REST

Sob `/api/quarantine`, com a sessão do painel. O endereço é o `uuid`.

| Rota | O que faz |
|------|-----------|
| `GET /api/quarantine` | a fila que a sessão enxerga (`q`, `limit`, `offset`) |
| `GET /api/quarantine/:uuid` | a ficha, com os arquivos e `canPromote` |
| `DELETE /api/quarantine/:uuid` | descarta o envio |
| `GET /api/quarantine/:uuid/download` | o pacote como está, sem remontar nada |
| `POST /api/quarantine/:uuid/promote` | aprova: cria a skill e apaga o envio |
| `GET /api/quarantine/:uuid/files/*path` | o arquivo, cru com `?raw` |
| `PUT` / `POST` / `DELETE` `…/files/*path` | grava, cria e remove |
| `GET` / `PUT` `/api/settings/quarantine` | a política da §4 (só admin) |

`POST /api/skills/import` ganhou o campo `destination`: `production` (o padrão,
o comportamento de sempre) ou `quarantine`.

O `?raw` do arquivo de um envio tem os mesmos cuidados do da skill — `Content-
Type` de texto, `nosniff`, CSP de `sandbox` e `Cache-Control: private` —, e pela
mesma razão, com mais força: é conteúdo de terceiro servido na origem do painel,
e um `.html` ou `.svg` anexado rodaria JavaScript autenticado como o operador.

## 8. Riscos aceitos

- **O envio não é varrido.** A quarentena atrasa a publicação; ela não analisa
  o conteúdo. Quem aprova é quem leu.
- **Não há prazo nem limite de fila.** Envio esquecido fica. Podar por idade
  exigiria decidir o que é "velho" sem saber o que a instalação faz, e apagar
  trabalho de alguém por relógio é pior que uma lista comprida.
- **A aprovação não avisa ninguém.** Não há notificação nem e-mail: quem
  aprova olha a fila. Um aviso depende de saber a quem avisar, e isso é
  assunto da política da §4 depois de ela rodar um tempo.
- **O envio órfão não é adotado.** `owner_user_uuid` é `ON DELETE SET NULL`,
  como em `skills`, mas `adoptOrphans` — que passa skill e catálogo órfãos ao
  admin solitário — não alcança a quarentena. O envio de uma conta removida
  fica visível só para quem vê a fila inteira (admin e editor). Medido na
  validação de 20/09/2026; aceito porque a fila é de passagem e o envio órfão
  pode ser aprovado ou descartado normalmente.
- **A trilha engorda mais rápido aqui.** Toda escrita num arquivo do envio
  audita `quarantine.update` com o conteúdo **anterior** do arquivo de texto —
  paridade com `deleteFile`. Numa skill isso é raro; aqui a revisão repetida do
  `SKILL.md` é o fluxo normal. Medido: 602 criações de arquivo deixaram 603
  linhas em `audit_log`.

## 9. Fora do escopo

- Rascunho de skill própria (sem importação) na quarentena.
- Comentário, revisão em duas etapas ou histórico de versões do envio.
- Promover para dentro de um catálogo ou servidor, ou devolver uma skill de
  produção para a quarentena.
- Fila por instalação com cota, prioridade ou responsável.
