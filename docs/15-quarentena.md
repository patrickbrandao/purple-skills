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

> **Ampliado em 20/09/2026** com a importação de **bundle** — o pacote que traz
> várias skills. As decisões 19 a 26 e a §10 entraram, e a decisão 2 ganhou o
> limite que o bundle impôs, marcado onde ela está.

> **Corrigido em 20/09/2026**, depois da validação do bundle: a decisão 27
> entrou e delimita as 19 e 20 (`SKILL.md` na raiz quer dizer uma skill só), a
> revisão da decisão 12 deixou de citar uma opção sem chamador, a decisão 25
> ganhou a medida do que a rota faz de fato, e na §10 saíram duas afirmações
> falsas — "o lixo de SO sai antes de qualquer conta" e "o pacote de uma skill
> não mudou de comportamento". ~~Cada trecho está riscado onde estava.~~
> **Aquelas duas estão** — a varredura da §10 não foi completa, e a
> reverificação achou de pé uma terceira, a do `BUNDLE_MAX_SKILLS`.

> **Reverificado em 20/09/2026.** O terceiro trecho caiu junto com a causa: ele
> registrava como desenho medido uma recusa que era **defeito** — o
> `BUNDLE_MAX_SKILLS` não recusa mais o pacote cuja raiz é a skill, e a linha da
> tabela de tetos e o parágrafo dela foram reescritos sobre o que
> `apps/admin/src/api.ts` faz hoje. Entrou também, na mesma tabela, a assimetria
> de orçamento entre `.zip` e `.tar.gz`. Este cabeçalho não promete varredura
> completa da §10: promete que **estes três trechos** estão riscados onde
> estavam.

> **Ampliado em 25/09/2026** com o **destino** do envio (§11): quem importa
> para a quarentena escolhe, já no upload, catálogos e servidores MCP, e a
> aprovação põe a skill neles na mesma transação. As decisões 28 a 34 entraram;
> a decisão 8 e o primeiro item da §9 (fora do escopo) foram **revogados** e
> estão riscados onde estavam, e a §3, a §5 e a §7 ganharam a marca no ponto.
> Migration `035-destino-da-quarentena.sql`.
>
> No mesmo dia entrou a §12 (decisões 35 a 37): aprovar e descartar em lote,
> o arquivo do envio colorido e a aprovação sem diálogo — que revoga um trecho
> da decisão 32, riscado onde estava.

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

   > **Revisado com a importação de bundle (20/09/2026).** A escolha vale para
   > o pacote de **uma** skill. O pacote com duas ou mais vai sempre para a
   > quarentena, e pedir `production` é **400** — decisão 21.
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
8. ~~**A skill nasce flutuante.** Sem servidor, sem catálogo, `is_public` falso.
   Publicar é um ato à parte, depois, na ficha da skill — e é assim que a
   aprovação não vira, por descuido, uma publicação.~~

   > **Revogado neste ponto pela decisão 28 (25/09/2026)**, a pedido do
   > mantenedor. A skill nasce no **destino** do envio (§11) — os catálogos e
   > servidores escolhidos no upload ou na ficha —, e só nasce flutuante quando
   > o destino está vazio. `is_public` continua falso. O "por descuido" que a
   > regra evitava ficou com a confirmação: o diálogo de aprovação diz para
   > onde a skill vai.
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
    > justamente o que não aceitava o caso mais comum.
    >
    > ~~Hoje a importação para a quarentena passa `allowBinarySkillMd`, e
    > produção continua recusando.~~ **Era**, até a importação de bundle (§10):
    > a rota deixou de chamar o `extractZip`, e com ele a opção ficou sem
    > chamador nesse caminho. O que aceita o `SKILL.md` não-UTF-8 hoje é o fato
    > de **ninguém o decodificar** ali: o `extractArchive` devolve `{ path,
    > data }` cru e o `envioDoPacote` grava esses bytes como chegaram. Quem
    > decide texto × binário (`toExtractedFile`) é chamado só no ramo de
    > **produção**, que continua recusando com a mensagem de sempre, e no
    > rótulo do envio — um `SKILL.md` ilegível ali custa apenas o nome, que cai
    > para o do diretório de origem. `allowBinarySkillMd` segue existindo em
    > `extractZip`; o único chamador que restou, o `set_files_bulk` do MCP
    > administrativo, não a liga.
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
19. **Um diretório com `SKILL.md` é uma skill.** É o critério que o próprio
    formato aberto Agent Skills usa, e é o único que não obriga quem importa a
    conhecer a arrumação interna do repositório de terceiro — arrumação que
    muda de projeto para projeto e não é declarada em lugar nenhum. Diretório
    **sem** `SKILL.md` não entra em lugar nenhum: nem como skill, nem como
    anexo de outra. O `.github/`, o `docs/` e o `src/` de um repositório são
    exatamente isso. É decisão de desenho, não conserto de defeito medido: não
    há um segundo sinal confiável para escolher.

    > **Delimitado pela decisão 27 (20/09/2026).** Esta regra vale quando a
    > **raiz** do pacote não tem `SKILL.md`. Com um lá, o pacote é uma skill só
    > e os `SKILL.md` de subpasta são conteúdo dela.
20. **A skill leva a subpasta, menos a subpasta que é skill.** O `ref/` e o
    `scripts/` acompanham a skill acima deles; um `SKILL.md` mais abaixo faz
    nascer uma skill própria, e aqueles arquivos **saem** da mãe — vale sempre
    o diretório de skill mais fundo que contém o arquivo. Sem a segunda metade
    da regra os mesmos arquivos entrariam duas vezes, uma em cada envio, e a
    mãe ainda ganharia um segundo `SKILL.md` no meio da própria árvore — o
    contrário da decisão 3, em que o `SKILL.md` da raiz é a única verdade do
    envio.

    > **Delimitado pela decisão 27 (20/09/2026).** Como a 19: a "subpasta que é
    > skill" só existe quando a raiz do pacote não tem `SKILL.md`. Era
    > justamente aqui que o template de skill se quebrava — o exemplo em
    > `references/` saía da mãe.
21. **O bundle vai sempre para a quarentena.** O pacote com duas ou mais
    skills mandado para `production` é recusado com **400**, dizendo quantas
    foram encontradas e apontando a fila. Criar N skills direto no acervo
    contrariaria a decisão 1 — o portão existe justamente para o pacote de
    terceiro — e multiplicaria por N, sem revisão nenhuma, a publicação e o
    fatiamento pelo RAG. A conta é de quantas o pacote **trazia**, e a pulada
    da decisão 22 entra nela: um pacote de duas em que uma passou do teto
    continua sendo um pacote de duas, e chamá-lo de "uma só" faria a outra
    sumir sem aviso. Revisa a decisão 2 no ponto marcado lá.
22. **A skill grande é pulada, não derruba o pacote.** O teto por skill
    continua sendo o de sempre (`DEFAULT_MAX_ZIP_ENTRIES`, 512 — decisão 14;
    a rota passa o `MAX_FILES_POR_ENVIO` do envio explicitamente, para as duas
    réguas serem uma coisa só): o diretório acima dele fica de fora, a resposta
    diz qual foi e por quê, e as irmãs entram normalmente. Recusar o pacote
    inteiro obrigaria a editar o `.zip` de terceiro para conseguir importar
    qualquer coisa dele; truncar a skill faria o envio mentir sobre o pacote de
    origem, que é o contrário do que a quarentena promete — o envio é o retrato
    do que chegou. Em `production`, o pacote de **uma** skill que passou do
    teto é **400** com o diretório e a contagem, e não com o "precisa conter um
    SKILL.md": ele está lá, e dizer que falta mandaria consertar o que não está
    quebrado.
23. **RAR não é suportado, e isso é dito.** A única via em Node é um WASM do
    UnRAR, cuja licença proíbe usar o fonte para construir um arquivador
    compatível com RAR — uma cláusula que não combina com a MIT deste
    repositório, para uma dependência binária que entraria em
    `packages/shared` e, com ele, nas **seis** imagens. Então o formato é
    **detectado pela assinatura** e recusado com o nome dele e a lista do que é
    aceito, em vez de cair no erro genérico de arquivo inválido: quem manda um
    `.rar` precisa saber que o formato é recusado de propósito, e não ficar
    procurando defeito num arquivo que está inteiro. Vale igual para `.7z`,
    `.xz` e `.bz2`.
24. **O formato sai da assinatura, não da extensão.** Um `.skill` é um ZIP e um
    `.tgz` é um tar em gzip: a extensão já não descrevia o conteúdo. E um
    arquivo renomeado não deve enganar a leitura nem, pior, escapar da recusa
    da decisão 23 — bastaria chamar de `.zip` o que é RAR. A extensão continua
    servindo para uma coisa só: dar nome à entrada quando o pacote é um `.gz`
    de arquivo único.
25. **O envio de bundle registra de onde veio.** `source_filename` passa a
    guardar `pacote.zip (skills/brainstorming)` quando a skill veio de um
    diretório do pacote — o nome do arquivo enviado e o diretório de origem. É
    o que deixa conferir a fila contra o pacote enviado sem abrir envio por
    envio; só com o nome do arquivo, quarenta envios ficariam indistinguíveis
    na lista. A skill que estava na **raiz** do pacote — e o pacote de uma
    skill só, desembrulhado — fica com o nome do arquivo sozinho, como sempre
    foi. Nenhuma coluna nova: `source_filename` já é TEXT livre, e o banco é do
    agente dba.

    > **Precisão medida (20/09/2026).** O diretório entra no `source_filename`
    > só no ramo que grava **vários** envios. O pacote que rende **um** envio
    > fica com o nome do arquivo sozinho mesmo quando a skill dele veio de uma
    > subpasta: um `.zip` com `README.md` e `skills/foo/SKILL.md` grava
    > `pacote.zip`, não `pacote.zip (skills/foo)`. Não é descuido — num envio só
    > não há o que desempatar, que é para o que o sufixo existe —, mas "quando a
    > skill veio de um diretório do pacote" prometia mais do que a rota faz.
26. **Uma falha no meio não desfaz o que já entrou.** Cada envio é a sua
    própria transação; a quarentena é uma **fila**, não um lote atômico. O que
    já foi gravado fica, e o erro sobe. Desfazer tudo trataria o pacote como
    unidade — e o pacote de quarenta skills que morresse na trigésima nona
    devolveria o operador ao ponto de partida, sem nada para olhar. É a mesma
    razão da decisão 22.
27. **`SKILL.md` na raiz do pacote quer dizer uma skill só.** A regra da decisão
    19 é o *segundo* ramo da leitura, não o único: com um `SKILL.md` na raiz (já
    sem o embrulho), o pacote é uma skill e todo o resto é conteúdo dela, em
    qualquer profundidade; os `SKILL.md` de subpasta são arquivos, não irmãs.
    Corrige uma quebra medida: o formato de **template** de skill guarda um
    `SKILL.md` de exemplo em `references/`, e sem esta regra um pacote desses
    contava como **duas** skills — em produção batia no 400 da decisão 21, e na
    quarentena virava um bundle de dois envios em que o principal **perdia** o
    arquivo de exemplo (decisão 20 aplicada onde não cabia). O pacote que o
    próprio painel exporta é exatamente essa forma, então a regra também é o que
    mantém de pé "exportar e reimportar". A raiz sem `SKILL.md` segue na decisão
    19, e é de lá que vem o preço descrito na §10: o que está fora do diretório
    de uma skill não entra em envio nenhum.

## 3. O espaço

Duas tabelas, `quarantine_skills` e `quarantine_files` (o desenho completo está
no README do banco). O envio tem `uuid`, `name`, `description`,
`source_filename`, `owner_user_uuid` e as duas datas; os arquivos são texto
**ou** binário, como os de uma skill, com o caminho único dentro do envio e sem
o `content_sha256`, que só existe para o RAG.

O que **não** existe, e a ausência é o ponto: slug, tags, ícone, `is_active`,
`is_public`, contadores, `search_vector`, `rag_stale`, vínculo com vMCP ou
catálogo e concessões por objeto (`*_grants`).

> **Precisão de 25/09/2026:** o envio ganhou um **destino** (§11), em duas
> tabelas próprias (`quarantine_catalogs` e `quarantine_mcps`). Não é vínculo:
> nada em catálogo nem servidor muda até a aprovação, e nenhuma consulta de
> catálogo ou vMCP enxerga essas tabelas.

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

- **`/quarantine`** — a fila, mais recentes primeiro: nome, arquivo de origem,
  quem enviou, quantos arquivos, tamanho e quando chegou. Daqui se baixa o
  pacote como está e se descarta. Desde 25/09/2026 (decisão 35) há uma coluna
  de marcar, com "marcar todos" no cabeçalho, e **Aprovar** e **Descartar**
  para os marcados.
- **`/quarantine/:uuid`** — os arquivos do envio e o editor **cru**. O
  `SKILL.md` aparece com o frontmatter dentro dele e é gravado assim. Desde
  25/09/2026 (decisão 36) o arquivo abre no **leitor colorido**, o mesmo da
  ficha da skill, e "Editar" passa ao editor, também colorido. Dá para
  criar e remover arquivo — **só texto**, e até o teto da decisão 14; não há
  envio de arquivo aqui — pacote se importa, e um envio é o retrato de um
  pacote. Um binário que veio dentro do pacote abre como binário, para baixar
  ou remover.
- A importação (`/new-skill?mode=zip`) ganhou a escolha de destino. Em
  "Para a quarentena" o formulário de metadados ~~e o seletor de servidores~~
  **some** da tela: ele não teria onde encostar, e mostrá-lo prometeria
  algo que a tela não cumpre. Um pacote com **duas ou mais** skills vai para a
  fila de qualquer jeito (decisão 21), e o que volta é o resumo da §10 — a
  tela "Pacote importado", com quais entraram e quais ficaram de fora, cada
  linha levando ao envio —, não a ficha de um envio.

  > **Revogado neste ponto pela decisão 28 (25/09/2026):** o seletor de
  > servidores **volta** na quarentena, como "Publicar ao aprovar em", junto de
  > um seletor de catálogos. Agora eles têm onde encostar: o destino do envio.
- **Configurações → Quarentena** guarda a política da §4.

O botão **Aprovar** só aparece para quem pode; a rota confere de novo, que é
onde a decisão vale. Sem `SKILL.md` ele fica desligado, com o aviso do que
falta. Desde 25/09/2026 ele age **sem diálogo de confirmação** (decisão 37).

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
| `PUT /api/quarantine/:uuid/targets` | troca o destino (§11) |
| `GET` / `PUT` `/api/settings/quarantine` | a política da §4 (só admin) |

`POST /api/skills/import` ganhou o campo `destination`: `production` (o padrão,
o comportamento de sempre) ou `quarantine`. Com `quarantine`, os campos `mcps`
e `catalogs` (JSON) são o destino do envio (§11); `catalogs` em `production` é
400. É também a porta do **bundle**
(§10): com `quarantine`, o pacote de uma skill e nada de fora responde a ficha
do envio, como sempre, e qualquer outro caso responde o resumo; com
`production`, o pacote de duas ou mais é **400**.

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
- ~~Promover para dentro de um catálogo ou servidor~~, ou devolver uma skill de
  produção para a quarentena.

  > **Revogado neste ponto pela decisão 28 (25/09/2026):** promover para dentro
  > de catálogo e servidor é o destino da §11. Devolver uma skill de produção
  > para a quarentena continua fora.
- Fila por instalação com cota, prioridade ou responsável.

## 10. O bundle

Um pacote pode trazer **várias** skills. Quem decide quais são não é um índice
nem uma convenção de nome: é o `SKILL.md`. A leitura acontece em duas etapas, e
a primeira é a **raiz** do pacote, já sem o embrulho (decisão 27):

- **`SKILL.md` na raiz** → o pacote é **uma** skill, e tudo o mais é conteúdo
  dela, em qualquer profundidade. O `SKILL.md` de exemplo que um template guarda
  em `references/` é arquivo da skill, não uma irmã.
- **sem `SKILL.md` na raiz** → vale a regra de bundle: cada diretório que tem um
  é uma skill, e leva junto os arquivos dele e das subpastas dele — menos as
  subpastas que são, elas próprias, skills (decisões 19 e 20). Diretório que não
  tem `SKILL.md`, e não está dentro de um que tenha, é ignorado por inteiro.

O caso que o recurso veio atender, e vale citá-lo por inteiro: baixar o `.zip`
do repositório `obra/superpowers` no GitHub e importá-lo. Ele chega como o
GitHub o monta — `.github/`, `docs/`, o `README.md` da raiz, o resto —, e o que
entra na fila são as skills de `skills/…`, uma por diretório. Nada mais.

"Nada mais" é literal, e é o preço do segundo ramo: **o que está fora do
diretório de uma skill não entra em envio nenhum**, nem quando o pacote traz uma
skill só. Um `.zip` com `README.md`, `LICENSE` e `skills/foo/SKILL.md` grava um
envio com os arquivos de `skills/foo/` e mais nada — medido, e antes do bundle o
mesmo pacote gravava um envio com os quatro arquivos, nos caminhos em que
vieram. É a decisão 19 aplicada até o fim: não há um segundo sinal confiável
para dizer que o `README.md` da raiz de um repositório é documentação de uma
skill que está três pastas abaixo. Quem quer os arquivos de fora põe um
`SKILL.md` na raiz do pacote, que é o primeiro ramo acima.

Nesse segundo ramo os arquivos são **rebaseados**: o `SKILL.md` da skill fica na
raiz do envio, como em qualquer outro envio da quarentena (no primeiro ramo não
há o que rebasear — a skill já é o pacote). Daí em diante um envio vindo de
bundle é um envio como os outros — a fila, o editor cru, a aprovação e o
descarte não sabem de onde ele veio. Quem sabe é o `source_filename`, que guarda
o arquivo enviado e, nos pacotes que rendem vários envios, o diretório de origem
(decisão 25 e a medida marcada nela).

### Formatos

Aceitos: `.zip`, `.skill` (o mesmo ZIP), `.tar`, `.tar.gz`/`.tgz`, `.gz` e
`.tar.zst`/`.tzst`/`.zst`. Recusados **com o nome do formato na mensagem**, e
não com o erro genérico de arquivo inválido: `.rar`, `.7z`, `.xz` e `.bz2`
(decisão 23). Quem decide qual é qual é a **assinatura** do arquivo, não a
extensão (decisão 24).

Nada disso traz dependência nova: `gzip` e `zstd` saem do `node:zlib`, e só o
`.tar` precisou do `tar-stream`. O `zstd` **cobra um piso de Node**, e por isso
o `engines` do repositório subiu de `>=22` para `>=22.15`: o
`zstdDecompressSync` só existe a partir dessa versão, e o que falha num
22.0–22.14 não é o caminho `.zst` — é a **ligação** do módulo ESM, que resolve
os imports nomeados antes de rodar linha nenhuma. O `archive.ts` deixa de
carregar, o barril do `@purple-skills/shared` vai junto, e com ele todo serviço
que o importa (o `@purple-skills/db` importa, então são os cinco). As imagens
publicadas não sentem — os sete Dockerfiles são `node:24-alpine` —, mas quem
roda fora do Docker, sim.

### Tetos

| Teto | Variável | Padrão | Ao estourar |
|------|----------|--------|-------------|
| entradas do pacote inteiro | `BUNDLE_MAX_ENTRIES` | `20000` | o pacote é recusado (400) |
| diretórios com `SKILL.md`, no pacote **cuja raiz não é skill** | `BUNDLE_MAX_SKILLS` | `200` | o pacote é recusado (400) |
| arquivos de **uma** skill | `ZIP_MAX_ENTRIES` | `512` | **aquela** skill é pulada e reportada (decisão 22); se não sobrar nenhuma, **400** |
| arquivos do pacote **sem `SKILL.md` nenhum** | `ZIP_MAX_ENTRIES` | `512` | o pacote é recusado (400) |
| bytes descomprimidos | `ZIP_MAX_UNCOMPRESSED_BYTES` | 256 MiB | o pacote é recusado (400) |
| envelopes de compressão encadeados | — (fixo) | 2 | o pacote é recusado (400) |

O teto de bytes é **um só para o pacote inteiro**, e não um por camada: cada
envelope aberto desconta do mesmo orçamento e o leitor de dentro fica com o que
sobrou. Enquanto ele valia de novo a cada camada, o mesmo conteúdo de 250 MB
custava (maxRSS, Node 26) 346 MB em `.zip`, 653 MB em `.tar.gz` e 871 MB em
gzip(gzip(tar)) — contra os "~2 × o teto descomprimido + 200 MB" com que o
`docker-compose.yml` dimensiona o container. A mensagem de recusa continua
citando o limite **configurado**, e não o resto da conta: quem a lê precisa
reconhecer o número que ele mesmo pôs na variável.

O orçamento único cobra um preço que o operador precisa conhecer **antes** de
estranhar: o pacote que chega dentro de um envelope — `.tar.gz`, `.tgz`,
`.tar.zst` — gasta o mesmo conteúdo **duas vezes**. O envelope materializa o
`.tar` inteiro, e esses bytes já descontam do teto; só então o leitor de tar
soma os bytes de cada arquivo, começando a conta no que o envelope gastou
(`readTarEntries`, em `packages/shared/src/archive.ts`). Logo o conteúdo útil de
um `.tar.gz` legítimo é **~metade** do teto configurado, enquanto o `.zip`, que
não tem envelope, usa o teto inteiro. É comportamento esperado, e o teste "o
teto é do pacote inteiro: cada camada desconta do mesmo orçamento"
(`archive.test.ts`) o fixa: 3 MB de conteúdo passam crus num teto de 4 MB, são
recusados em `.tar.gz` e voltam a passar com o teto em 8 MB. Com o padrão de
256 MiB, um `.tar.gz` de 200 MB de conteúdo é recusado citando "o limite de
256 MB" — não é defeito, são ~400 MB de orçamento pedidos a um teto de 256. O
que a assimetria compra é o teto valer como teto de **memória do processo**, que
é justamente o que faltava quando três envios de 264 KB em paralelo derrubavam o
container. Quem precisa desse `.tar.gz` sobe `ZIP_MAX_UNCOMPRESSED_BYTES` para
~2 × o conteúdo e sobe o `APP_MEM_LIMIT` na mesma conta (`.env.example`), ou
reempacota em `.zip`.

`BUNDLE_MAX_ENTRIES` não é o 512 de `ZIP_MAX_ENTRIES` de propósito: o `.zip` de
um repositório do GitHub passa das 512 entradas só de código e documentação, e
o teto que protege o pacote de uma skill fecharia a porta justamente para o
caso desta seção. O teto **por skill** não mudou. O teto de skills é conferido
sobre o que o pacote **traz**, não sobre o que sobra: as que seriam puladas por
tamanho contam, senão um pacote com milhares de diretórios inchados passaria
pelo limite só porque nenhum deles entraria.

`BUNDLE_MAX_SKILLS` conta **diretórios com `SKILL.md`**, e vale **só no segundo
ramo** — o pacote que não tem `SKILL.md` na raiz. Quando a raiz é a skill não há
irmã para contar, e o `fatiarPacote` (`apps/admin/src/api.ts`) **não chama o
`splitBundle`**: ele monta o envio direto das entradas (`envioDaRaiz`), sem
fazer a pergunta "quantas skills há aqui" — que é como o teto volta a valer
inteiro no único ramo onde ele significa alguma coisa, em vez de ser desligado
para aquela chamada. O que mede aquele pacote é a linha do
`ZIP_MAX_ENTRIES` por skill, logo abaixo na tabela. É o que faz o número voltar
a dizer o que a variável promete: quantas skills o pacote traz.

~~Medido — um pacote com `SKILL.md` na raiz e 201 exemplos em subpastas é
recusado com "o pacote tem skills demais (202 diretórios com SKILL.md)", embora
fosse virar **uma** skill.~~ — **Era**, até a correção da rota de 20/09/2026, e
era defeito, não desenho: a conferência acontecia antes de a regra da raiz
juntar tudo num envio só, então a decisão 27 prometia **uma** skill enquanto o
teto contava 202. Hoje o pacote entra, e é o que o teste "a skill com mais
subpastas de exemplo que o teto de skills entra"
(`apps/admin/src/import.test.ts`) prende.

No ramo em que ele vale, o teto é de **proteção**: mede o trabalho que o pacote
dá para ser lido, e por isso a mensagem diz "diretórios com SKILL.md" em vez de
prometer outra coisa — os diretórios que seriam pulados por tamanho contam
igual, como diz o parágrafo do `BUNDLE_MAX_ENTRIES` mais acima.

O teto **por skill** também muda de resposta conforme o pacote. Com duas ou mais
skills, a grande é pulada e as irmãs entram (decisão 22). Com uma só — o caso da
decisão 27, em que o pacote inteiro é a skill — não há irmã para entrar, e aí é
**400** nos dois destinos: em `production` com o diretório e a contagem, e na
quarentena com a lista do que foi pulado. O que se soma nessa conta é o envio
inteiro, subpastas incluídas.

O teto de envelopes encadeados não é configurável: dois cobrem tudo que é
legítimo — o `.tar.gz` é um, e o segundo sobra para o `.gz` que alguém
recomprimiu ao baixar. Daí em diante é bomba, porque cada camada multiplica o
que saiu da anterior.

O pacote **sem `SKILL.md` nenhum** — o pacote torto da decisão 12 — responde ao
mesmo teto de 512, e essa linha é a única recusa de tamanho que não pula nada:
ele entra como **um** envio, então é um envio, e a decisão 14 vale para ele
igual. Não é regra nova, é a decisão 14 fechando uma porta dos fundos: o
`splitBundle` mede por skill, e aqui não há skill para medir, enquanto o
`extractArchive` lê até `BUNDLE_MAX_ENTRIES`. Sem a guarda, o mesmo conteúdo
que é recusado **com** um `SKILL.md` dentro entrava **sem** ele — medido, um
pacote de 600 arquivos e nenhum `SKILL.md` gravava um envio de 600. Antes do
bundle o caso era impossível, porque a importação lia com o `extractZip`, cujo
teto padrão já era 512. O que se conta são as **entradas cruas** do pacote, que
é o que o envio gravaria: aqui não há pasta raiz aparada — não há skill para
desembrulhar — e só o lixo de SO já saiu. Truncar está fora de questão pela
razão da decisão 22: o envio mentiria sobre o pacote de origem.

~~O lixo de SO sai antes de qualquer conta~~ — **ele sai antes de quase todas**,
e a diferença importa para quem dimensiona os tetos. A ordem real, medida:
`BUNDLE_MAX_ENTRIES` é conferido **antes** do descarte, sobre tudo o que o
pacote traz — diretórios e lixo incluídos. No `.zip` o número conferido é o que
o fim do diretório central declara, antes de materializar seja o que for; no
`.tar`, cada membro que o leitor abre. Medido: um `.zip` com um `SKILL.md` e
nove entradas de lixo é recusado com o teto em 9, e a mensagem fala em **10
entradas**. Os bytes do `._<nome>` solto contam igual, porque a assinatura só se
prova no conteúdo — ele é lido, somado ao `ZIP_MAX_UNCOMPRESSED_BYTES` e só
então descartado. Daí para a frente o lixo já saiu, e as contas seguintes veem a
lista limpa: o teto por skill, o do pacote sem `SKILL.md` e o `fileCount` do
envio. É onde ele precisava entrar: as duas contas em que o lixo pesa são as de
**proteção do processo**, e quem manda 20 000 entradas de metadado está mandando
20 000 entradas.

No `.tar` isso pesa: além de `__MACOSX`, `.DS_Store` e `Thumbs.db`, o irmão
`._<nome>` que o `tar` do macOS grava para cada arquivo com atributo estendido é
descartado pela **assinatura** (`00 05 16 07`), nunca pelo nome — `._config` é
nome legítimo, e descartar por prefixo apagaria arquivo do usuário. Medido na
verificação deste recurso: **27 dos 41 membros** de um `.tar` feito num Mac eram
esse metadado, metade deles binário ilegível — sem o descarte seriam 27 dos 512
arquivos que um envio pode ter. E não adianta conferir com `tar -tf`: o `tar` do
macOS **esconde** esses membros ao listar, porque os reagrega em atributo
estendido — é fácil não enxergar. No `.zip` o caso não aparece, porque o `zip`
junta o metadado em `__MACOSX/`.

### As duas respostas

A rota é a mesma da §7, e com `destination: quarantine` o corpo tem dois
formatos:

- **uma skill, e nada de fora** → `201` com a ficha do envio
  (`QuarantineDetail`), o mesmo corpo de antes do bundle, e é isso que mantém de
  pé a tela e os testes que já existiam. É também o corpo do pacote **sem**
  `SKILL.md` nenhum, que entra inteiro como um envio só (decisão 12).
- **duas ou mais, ou alguma pulada com outra entrando** → `201` com o resumo
  (`QuarantineBundleResult`): `bundle: true`, o `sourceFilename`, a lista
  `imported` (`uuid`, `name`, `path`, `fileCount`) e a lista `skipped`
  (`path`, `reason`, `fileCount`).

~~O pacote de uma skill não mudou de comportamento, byte a byte como antes.~~
**Não é verdade**, e vale dizer onde: o pacote de **uma** skill cujo `SKILL.md`
está na raiz volta a dar um envio com os mesmos arquivos, nos mesmos caminhos e
com os mesmos bytes (é a decisão 27, e foi ela que consertou o template com
exemplo em `references/`); o pacote cuja única skill está numa **subpasta**
mudou — os arquivos de fora do diretório dela não entram mais, e em `production`
ele passou a criar a skill em vez de recusar por falta de `SKILL.md`. Está medido
e registrado na seção "Mudado" do [`CHANGELOG`](../CHANGELOG.md).

Quando **nenhuma** skill entra na fila — a única do pacote passou do teto da
decisão 22 — a resposta é **400** com a lista do que foi pulado, e não o resumo.
Um `201` ali era "Created" sem recurso criado, que o painel mostra como
importação bem sucedida de coisa nenhuma. A pulada só aparece no resumo quando
alguma **irmã** entrou: aí o resumo é o único corpo com onde dizer o que ficou
de fora, e numa ficha ela viraria silêncio — quem importou um pacote de quarenta
teria de contar a fila para descobrir que falta uma.

Quem lê discrimina por `'bundle' in body`. Duas rotas separadas seria o desenho
alternativo, e cobraria de quem importa saber **antes de abrir o pacote**
quantas skills ele tem — que é justamente o que só se sabe depois de abrir.

A ordem em que a rota decide, para `quarantine`: pacote vazio → **400**; nenhuma
skill entrando e alguma pulada → **400** com a lista; duas ou mais skills, ou
alguma pulada ao lado de outra que entrou → **201** com o resumo; zero skills e
mais de 512 entradas → **400**, o teto desta seção; o resto → envio único.

## 11. O destino

Pedido do mantenedor em 25/09/2026: ao importar para a quarentena, escolher já
no envio os **catálogos** em que a skill vai entrar e os **servidores MCP** em
que ela vai ser publicada, para que aprovar seja também mandar para produção —
os servidores vinculados àqueles catálogos passam a entregá-la no mesmo
instante. As decisões marcadas "mantenedor" foram escolhas dele numa entrevista
direta; as outras são minhas.

28. **Só a quarentena tem destino** (mantenedor). A importação direta para
    produção e o formulário de nova skill continuam como estavam: "Publicar em"
    (servidor), sem catálogo. `catalogs` mandado com `production` é **400**, em
    vez de ignorado — ignorar faria quem mandou achar que a skill entrou no
    catálogo. Revoga a decisão 8 e o primeiro item da §9.
29. **Destino não é vínculo.** Ele mora em `quarantine_catalogs` e
    `quarantine_mcps`, com o envio, e nenhuma consulta de catálogo ou vMCP as
    lê: até a aprovação o envio não aparece em lugar nenhum, e a decisão 4 segue
    de pé. Um catálogo ou servidor apagado antes da aprovação sai do destino
    pela cascata, sem aviso — o destino é intenção, e intenção sobre o que não
    existe mais não tem o que dizer. O servidor leva as três portas do vínculo
    (`as_skill`/`as_prompt`/`as_resource`, ao menos uma), e o que a aprovação
    cria é um **vínculo direto**, que sobrescreve o que um catálogo entrega no
    mesmo servidor (`docs/11` §3.2) — quem escolhe o catálogo e também o
    servidor ao qual ele já está vinculado está pedindo as portas do servidor.
30. **A permissão é cobrada de quem escolhe e de quem aprova** (mantenedor). A
    régua é a de publicar direto: `edit` no catálogo e `edit` no servidor. Quem
    escolhe paga no upload e na ficha; quem aprova paga de novo, porque é ele
    quem vira dono da skill (decisão 7) e responde pela publicação — e porque o
    acesso pode ter mudado entre o envio e a aprovação. Na ficha, só
    **acrescentar** cobra: manter o que já estava não cobra de novo, e tirar não
    cobra nada — reduzir o que a aprovação publica é o gesto de quem revisa.
    Trocar as portas de um servidor que já é destino cobra, porque é publicar de
    outro jeito.
31. **Sem acesso a algum destino, a aprovação é recusada** (mantenedor): **403**
    e nada criado. Aprovar pulando o destino publicaria menos do que o envio
    promete, sem ninguém ter decidido isso. A mensagem nomeia o catálogo ou
    servidor quando quem aprova o enxerga, e não nomeia quando não enxerga. A
    janela entre essa conferência e a gravação é fechada no banco: a rota passa
    o destino conferido (`expectedTargets`) e, se o gravado for outro quando a
    transação trava o envio, a resposta é **409** — ninguém publica o que não
    foi conferido.
32. **O destino é editável na ficha** (mantenedor), num painel "Ao aprovar",
    por quem enxerga o envio (§3.1). ~~O diálogo de aprovação diz para onde a
    skill vai~~, e o botão **Aprovar** fica desligado quando algum destino trava a
    sessão, com o painel dizendo o que fazer.

    > **Revogado neste ponto pela decisão 37 (25/09/2026):** a aprovação não tem
    > mais diálogo. Quem diz para onde a skill vai é o painel "Ao aprovar", que
    > está na tela antes do clique.
33. **Destino que a sessão não enxerga aparece como número, sem nome.** O editor
    que revisa a fila vê envio alheio; o destino não pode ser o caminho para ele
    ficar sabendo de um catálogo privado ou de um servidor fechado de terceiros
    (a régua do relatório 009 da auditoria de 2026-09-19). A ficha diz "1
    destino a que você não tem acesso" e oferece **removê-lo** (`dropHidden`),
    que destrava a aprovação sem revelar o que era. A troca de destino não toca
    no que a sessão não enxerga, a menos que ela peça isso.
34. **Num bundle, o destino vale para cada envio.** O pacote de quarenta skills
    com um catálogo escolhido vira quarenta envios com aquele catálogo; o que for
    diferente se ajusta na ficha de cada um.

O catálogo **público** merece o aviso que o seletor mostra: ele lista os
membros no site, inclusive a skill privada (`docs/12` decisões 4 e 5), então a
skill que nasce `is_public = false` aparece no site pelo catálogo. É o mesmo
aviso que o seletor de servidores já dava para o servidor aberto.

A trilha: trocar o destino audita `quarantine.update`; aprovar audita, além do
`create` da skill e do `quarantine.promote`, um `catalog.update` por catálogo e
um `mcp.update` por servidor — as mesmas linhas de pôr a skill no catálogo e de
publicá-la à mão.

## 12. Aprovar em lote e ler com cores

Pedido do mantenedor em 25/09/2026, na mesma conversa do destino (§11).

35. **A fila aprova e descarta em lote.** Uma coluna de marcar, com "marcar
    todos" no cabeçalho (que fica indeterminado com parte marcada), e uma barra
    com **Aprovar** e **Descartar** para os marcados. O lote **não** tem rota
    própria: o painel chama, um de cada vez, as mesmas rotas da ficha — cada
    envio passa pela política da §4, pela conferência do destino (decisões 30 e
    31) e é a sua própria transação, como a fila da decisão 26. Em paralelo,
    quarenta aprovações disputariam as mesmas travas de catálogo e servidor à
    toa. O que falha **continua marcado**, e um aviso só diz quantos deram certo
    e o primeiro motivo de falha; o que deu certo sai da fila. Só conta o que
    está na tela: trocar a busca não deixa marca escondida, que um "Descartar"
    levaria junto sem a pessoa ver. **Aprovar** do lote aparece só para quem
    pode criar no acervo (decisão 18).
36. **O arquivo do envio abre colorido.** O leitor é o `CodeView` da ficha da
    skill, com a mesma gramática por nome de arquivo (`languageFor`) e o
    frontmatter do `SKILL.md` como YAML; "Editar" passa ao editor, e o editor
    também sai colorido. A cor do editor é uma camada **atrás** do `textarea`,
    com a mesma fonte, recuo e altura de linha, e o texto do campo transparente
    por cima — desfazer, seleção e colar continuam os do navegador. Na camada,
    negrito e itálico são anulados, porque em algumas fontes mono mudam a
    largura da letra e descolariam o cursor. Acima de 60 000 caracteres o
    editor volta a texto puro: a cor é refeita a cada tecla. O `CodeEditor`
    só colore quando recebe `fileName`, então o editor da skill não mudou.
37. **Aprovar age sem confirmação** — na ficha e no lote. O painel "Ao aprovar"
    já mostra o destino antes do clique, e o que a aprovação cria é uma skill,
    que se desfaz apagando-a. **Descartar continua pedindo confirmação**, na
    ficha e no lote: ele apaga os arquivos do envio, e isso não tem volta.
