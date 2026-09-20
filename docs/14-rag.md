# Busca semântica: espaços de embedding e os três drivers

**Status: implementado**, em seis PRs (`feat/rag-*`, depois
`feat/rag-tres-drivers`). Migrations `020-rag.sql` e
`025-fila-de-textos-do-rag.sql`, pacote `packages/rag/`, container
`apps/indexer/`.

> **Parcialmente revogado pela migration `025` e pela `beta.22`** — não por outro
> documento, e por isso a marca está aqui e nos pontos. A `025` deu à fila de
> textos **reserva** e **recusa gravada no banco**, e trouxe a coleta de textos
> órfãos: deixaram de valer "a fila não tem reserva" (§7 e §7.1), "a marca vive
> em memória do processo" (§7.1 e §12) e "a função que apaga ainda não existe"
> (§12). Na mesma entrega o indexador passou a mandar prazo em toda chamada ao
> provedor, o que desmente o "quem chama sem `signal` é o indexador" da §6. E,
> desde a `beta.22`, o indexador **sobe no `up -d`**: o "perfil `rag`" da §7
> deixou de valer. Cada trecho está riscado onde estava, com "**Era**"; o resto
> do desenho continua em vigor.

Este documento registra o desenho fechado nas entrevistas de 15/09/2026 (o
driver `google`) e de 16/09/2026 (a generalização para três provedores). Ele é
a referência de *por que* cada peça é assim; o resumo do que está no ar é a
§12.5 de [`02-architecture-decisions.md`](02-architecture-decisions.md) — que
também marca ali, nas §3 e §5, a decisão "sem busca vetorial no v1" que esta
entrega revogou — e os desvios são a seção "Busca semântica" de
[`03-implementation-notes.md`](03-implementation-notes.md). O que é do
banco — tabelas, índices, queries — está em
[`../database/README.md`](../database/README.md), que é do agente dba.

## 1. Por que

A busca do catálogo era full-text: `tsvector` com configuração `simple`, sobre
nome, descrição e o `SKILL.md`. Ela acerta quando quem procura já sabe a
palavra que a skill usa, e erra quando não sabe — "como padronizar mensagem de
commit" não acha `conventional-commits` se o texto não tiver a palavra
"padronizar". Um agente descrevendo a tarefa em linguagem natural é justamente
o caso em que ela erra.

A busca semântica resolve isso comparando **significados**, não palavras: o
texto vira um vetor, a consulta vira um vetor, e o que está perto aparece. O
preço é depender de um provedor externo, pago, que lê o conteúdo enviado.

Daí as três regras que atravessam o desenho inteiro:

- **desligada, tudo responde exatamente como antes.** A busca semântica é uma
  perna a mais, fundida com a de sempre. Sem chave, sem a migration, com o
  provedor fora do ar ou com o driver `off`, a resposta sai em modo `text` — e
  isso **nunca é erro**, nem para o cliente nem no log;
- **o texto guardado não pertence a driver nenhum.** É o que permite trocar de
  provedor sem reescrever o acervo;
- **nada é apagado numa troca.** Trocar de driver ou de modelo cria outro
  espaço; o anterior fica inteiro, pronto para quando alguém voltar atrás.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | O que identifica um conjunto de vetores | Um **espaço**: driver, modelo, dimensões, prefixo de documento e prefixo de consulta. Os cinco juntos |
| 2 | O que é guardado como texto | O **texto canônico**, sem prefixo nenhum, endereçado pelo próprio SHA-256 |
| 3 | Quem aplica o prefixo | O **driver**, na hora da chamada. Nunca o banco, nunca o indexador |
| 4 | Quem decide o driver em uso | O **banco** (`rag.driver`), editado no painel. O ambiente só semeia no primeiro boot |
| 5 | Onde vivem as chaves | No **ambiente** dos três containers que falam com o provedor. O painel nunca as recebe |
| 6 | Quantos drivers um container monta | **Todos os que tiverem chave.** A escolha entre eles é por requisição |
| 7 | Dimensões | A **nativa** de cada modelo. Nenhum modelo é encurtado |
| 8 | Divisão do acervo em textos | **Igual nos três drivers**: 6.000 caracteres por parte |
| 9 | Fusão das duas pernas | **RRF com `k = 60`**, sem corte por distância |
| 10 | Erro do provedor na busca | Vira **modo textual**, sempre. A distinção de erros existe para o indexador |

## 3. O espaço de embedding

Um vetor só significa alguma coisa ao lado de outros vetores feitos do mesmo
jeito. Comparar um vetor do `gemini-embedding-2` com um do `voyage-4` não dá
erro: dá **resultado sem sentido**, que é pior, porque ninguém percebe.

Por isso existe `rag_spaces`, e a identidade dele é a combinação de cinco
coisas:

| Coluna | Por que entra na identidade |
|---|---|
| `driver` | vetores de provedores diferentes não se comparam |
| `model` | nem de modelos diferentes do mesmo provedor |
| `dimensions` | o `CHECK` de `rag_vectors` prende cada vetor à dimensão do espaço |
| `document_prefix` | o texto realmente enviado muda com ele |
| `query_prefix` | idem, do lado da consulta |

Os prefixos entram porque, no `gemini-embedding-2`, **a tarefa vai escrita no
texto**: não há parâmetro que diga "isto é um documento" ou "isto é uma
busca", então ela vira um prefixo. Mudar esse prefixo muda o vetor, e um
espaço que misturasse os dois estaria comparando coisas diferentes sem avisar.

Na OpenAI não há distinção nenhuma — documento e consulta são a mesma chamada.
Na Voyage a distinção existe, mas é o parâmetro `input_type`. Nos dois casos os
prefixos ficam **vazios**, e é assim que entram na identidade: espaço vazio de
prefixo é uma escolha registrada, não um campo esquecido. (A `020` não dá
`DEFAULT` a essas colunas justamente por isso.)

## 4. O texto canônico, e por que ele não leva o prefixo

`rag_texts` guarda o texto **sem prefixo**, endereçado pelo SHA-256 dos
próprios bytes UTF-8 — e o banco reconfere o hash num `CHECK`.

A regra anterior era guardar "o texto exato enviado ao modelo". Com o Google
esse texto leva o prefixo, e o hash mudaria de um espaço para outro: o mesmo
parágrafo apareceria duas vezes, sob dois hashes, e a troca de prefixo
reescreveria o acervo. Guardando o canônico, um texto tem **uma** linha e um
vetor por espaço.

É a mesma razão pela qual `maxPartChars` é **6.000 nos três drivers**, e não o
que cada provedor permitiria. A divisão decide quais textos existem; se cada
driver dividisse diferente, trocar de driver reescreveria `rag_texts` inteira e
jogaria fora os vetores do driver anterior — que hoje sobrevivem no espaço
deles. O teto por texto de cada provedor continua declarado em
`maxInputTokens`, e todos são folgados para 6.000 caracteres.

### 4.1 O que entra na divisão — e o que sai da instalação

A pergunta que a divisão responde não é "quais arquivos a skill tem", é **o que
vai para o provedor**. Entra (`packages/rag/src/chunk.ts`):

- **o texto de metadados**: nome, descrição e tags;
- **todo arquivo de texto da skill**, e não só o `SKILL.md` — o guia, o
  exemplo, o script, o `.json` de configuração. Inteiro quando cabe nos 6.000
  caracteres; em partes numeradas de 0 em diante quando não cabe.

Fica fora:

- **o binário** (`.png`, `.pdf`, `.zip`, fonte). Ele vive em
  `files.binary_content`, e `readSkillForRag` só pede quem tem `text_content`:
  nunca chega a ser fatiado. É o que a `020` anota como "binário não é
  embutido";
- **a imagem que por acaso é texto**: o `.svg`. Ele é textual *para guardar e
  exibir* — o leitor e o editor do painel abrem o XML —, e não é documentação.
  Embuti-lo pagaria ao provedor por coordenadas de desenho, devolveria um vetor
  que só acrescenta ruído à busca e mandaria para fora um arquivo que quem
  anexou não escreveu para ser lido;
- **arquivo vazio** e **arquivo acima de 256 KB**, pulados com o motivo no log.

O critério de tipo é o **mesmo** que decidiu gravar o arquivo como texto —
`mimeTypeFor` + `isTextualMime` do `shared`, a regra única de `fileColumns` —,
menos as imagens. Não existe segunda lista de extensões de propósito: ampliar a
tabela de mime para o leitor do painel não pode passar a mandar tipo novo para
fora sem ninguém decidir.

Onde cortar um arquivo que não cabe: primeiro nos títulos Markdown, depois nas
linhas em branco, por último no teto, sem sobreposição.

**O alcance é toda skill indexada, inclusive a privada.** A visibilidade recorta
a *busca* (§8), não a indexação — ligar a busca semântica é decisão de quem
opera a instalação, e vale para o acervo inteiro, enquanto anexar o arquivo é
decisão de quem escreve a skill. Não há como indexar só parte do acervo. Com
`rag.driver` desligado, que é o padrão, nada disso sai da máquina.

## 5. Configuração: o ambiente semeia, o banco decide

Quatro containers leem a configuração do RAG: o admin (que semeia e edita), o
indexador, o mcp-public e o site. Se o ambiente valesse sempre, um container com
a variável diferente divergiria dos outros em silêncio. Então:

1. **o admin semeia no boot**: para cada chave, grava o valor do ambiente só
   quando o banco ainda não tem linha, com o ator `ambiente` na auditoria. O
   **modelo** tem uma condição a mais: só vira linha se for do driver que *vai
   valer* — o do banco, quando o banco já decidiu. `RAG_MODEL` de outro driver
   é divergência como qualquer outra: aviso no log, nenhuma linha, e segue
   valendo o padrão do driver gravado. (**Era**, até a beta.22, conferido contra
   o `RAG_DRIVER` do próprio `.env`, que acabara de ser ignorado: o banco ficava
   com `google` + `text-embedding-3-large`, o indexador recusava a configuração
   a cada ciclo e a busca caía para o modo textual.) Um par que **já** esteja
   gravado assim não é consertado sozinho — semeadura nunca sobrescreve linha:
   o boot avisa, e o painel abre com um modelo do driver gravado, para que
   "Salvar" resolva;
2. **daí em diante quem manda é o banco.** Mudar o `.env` não altera o valor em
   uso; o admin registra um aviso no log e o painel mostra o que está sendo
   ignorado;
3. **os leitores releem o banco com cache de 10 segundos.** É o que faz
   desligar no painel valer sem reiniciar nada.

### 5.1 O registro, em dois eixos

As opções são descritas **uma vez**, em `packages/rag/src/settings.ts`:

- `RAG_DRIVERS` — por driver: a variável da chave, a variável e o valor padrão
  da URL base, e os modelos aceitos;
- `RAG_SETTINGS` — por variável de ambiente. O par chave/URL de cada driver
  **deriva** de `RAG_DRIVERS` em vez de ser escrito à mão.

Acrescentar um driver é acrescentar uma linha no registro e um arquivo com a
classe; as variáveis do `.env`, a validação de `RAG_MODEL`, as opções do painel
e a montagem a partir do ambiente saem daí sozinhas.

### 5.2 Variáveis

| Variável | Papel | Vai para o banco | Containers |
|---|---|---|---|
| `RAG_DRIVER` | `google`, `openai`, `voyage`; `off` ou vazio desliga | sim, no primeiro boot | admin |
| `RAG_MODEL` | validada **contra os modelos do driver escolhido** | sim, no primeiro boot | admin |
| `RAG_<DRIVER>_API_KEY` (ou `_FILE`) | a chave de cada provedor | não | indexer, mcp-public, site |
| `RAG_<DRIVER>_BASE_URL` | URL base já com a versão; nos testes aponta para o servidor falso | não | indexer, mcp-public, site |
| `RAG_QUERY_TIMEOUT_MS` | prazo do embedding da consulta (padrão 2000) | não | mcp-public, site |
| `RAG_INDEX_INTERVAL_SECONDS` | intervalo da varredura (padrão 30) | não | indexer |
| `RAG_INDEX_TIMEOUT_MS` | prazo de **um lote** da indexação, tentativas incluídas (padrão 120000) | não | indexer |

Valor inválido **derruba o boot**, como manda a convenção do projeto:
desligar em silêncio é pior que não subir. `cohere` é recusado com "ainda não
foi implementado", que é uma mensagem diferente de "driver desconhecido" de
propósito.

### 5.3 Todos os drivers com chave são montados

O driver em uso vive no banco e muda pelo painel; as chaves vivem no ambiente e
são lidas no boot. `criarDriversDoAmbiente` reconcilia os dois: o processo monta
**todos** os drivers para os quais tem chave, e a busca e o indexador escolhem
entre eles pelo `rag.driver` do banco, a cada uso.

Sem isso, escolher outro driver no painel daria busca textual em silêncio — o
processo teria montado um driver no boot e nunca acharia o espaço do outro. Com
duas chaves no `.env`, a troca vale no ciclo seguinte, sem recriar container.

Um driver que não sobe (URL base inválida, por exemplo) não derruba os outros:
o motivo vai para o log do boot e a busca segue com quem subiu.

## 6. Os drivers

A interface é a mesma para os três, e os erros são divididos pelo **que o
chamador deve fazer com eles**, não pelo código HTTP que os causou:
`RagAuthError` e `RagConfigError` encerram o ciclo; `RagRateLimitError`,
`RagUnavailableError` e `RagTimeoutError` recuam e tentam de novo;
`RagInputTooLongError` faz quem chamou dividir o lote. Na busca essa distinção
não importa — qualquer erro vira modo textual. Ela existe para o indexador.

Cada classe carrega um `kind` — `auth`, `origin`, `quota`, `rate-limit`,
`config`, `input-too-long`, `unavailable`, `timeout` —, que é a classe em uma
palavra para quem não pode usar `instanceof`: o estado que o indexador publica é
JSON, e é por ele que o painel resume a chave (§9). Duas subclasses existem só
por causa disso, `RagQuotaError` (de `RagConfigError`) e `RagOriginError` (de
`RagAuthError`): **herdam a política** e mudam o `kind`. O vocabulário é
publicado no banco e lido por outro container — acrescentar é seguro, renomear
não. A mensagem continua sendo prosa para o operador, livre para ser reescrita.

A política de tentativas mora uma vez só, em `packages/rag/src/http.ts`: ela
não vem da API, vem do que o indexador precisa, e é igual nos três. A falha de
rede que sobra das tentativas — o `TypeError: fetch failed` do `undici`, conexão
recusada, DNS, resposta que não dá para ler — sai de lá como
`RagUnavailableError`, com o erro original em `cause`. (**Era**, até a beta.22,
entregue crua: saía **sem classe**, e o indexador a publicava com
`lastErrorKind: null`, que é o que ele reserva para erro que não veio do
provedor.)

Duas regras de prazo que valem para os três drivers:

- **o `signal` é o orçamento de tempo total da consulta**, não de cada
  tentativa. Ele aborta o `fetch` **e** a espera entre tentativas, que é o que
  faz `RAG_QUERY_TIMEOUT_MS` ser o teto do ciclo inteiro. O indexador faz o
  mesmo com outro orçamento: cada chamada de `embedDocuments` leva o seu
  `AbortSignal.timeout(RAG_INDEX_TIMEOUT_MS)` (§7), e prazo estourado vira
  `RagTimeoutError`, sem tentativa nova. Hoje **nenhum** chamador de produção
  fica sem prazo — até o `runCycle` montado à mão cai em `TIMEOUT_EMBEDDING_MS`;
  quem chama o driver direto sem `signal`, num teste ou num script, dorme as
  esperas inteiras, limitadas ao teto abaixo.
  **Era**, até a `025`: ~~"Quem chama sem `signal` — hoje só o indexador, em
  `embedDocuments` — dorme as esperas inteiras, o que é o certo para ele"~~;
- **nenhuma espera passa de 60 segundos**, inclusive a que o provedor pede no
  `Retry-After`. Sem esse teto, seria o provedor a decidir por quanto tempo esta
  instalação fica parada.

| | google | openai | voyage |
|---|---|---|---|
| Modelos | `gemini-embedding-2` | `text-embedding-3-small`, `text-embedding-3-large` | `voyage-4-lite`, `voyage-4`, `voyage-4-large` |
| Dimensões | 3072 | 1536 e 3072 | 1024 |
| Endereço | `/models/<modelo>:embedContent` e `:batchEmbedContents` | `/embeddings` | `/embeddings` |
| Chave | header `x-goog-api-key` | `Authorization: Bearer` | `Authorization: Bearer` |
| Documento × consulta | **prefixo no texto** | não há distinção | parâmetro `input_type` |
| Teto por texto | 8.192 tokens | 8.192 tokens | 32 mil tokens |
| Teto por requisição | 100 textos, 60 mil caracteres (teto nosso) | 300 mil tokens | 1.000 textos; 1 M, 320 mil e 120 mil tokens |
| Base padrão | `https://generativelanguage.googleapis.com/v1beta` | `https://api.openai.com/v1` | `https://api.voyageai.com/v1` |

Seis armadilhas que custaram comentário no código:

- **google: um item de `requests[]` por texto, sempre.** Mandar vários textos
  nas `parts` de um mesmo `content` é aceito pela API e devolve **um vetor
  agregado** dos textos somados — silenciosamente errado, e só perceptível
  quando a busca começa a trazer coisa sem sentido;
- **openai e voyage: a resposta é casada pelo `index`**, não pela ordem de
  chegada. As duas mandam um `index` em cada item justamente porque a ordem não
  é promessa; confiar nela gravaria o vetor de um texto sob o hash de outro, e
  o estrago só apareceria como busca ruim, meses depois;
- **openai: `insufficient_quota` é 429 mas não é limite de taxa.** É conta sem
  crédito: vira `RagQuotaError` — um `RagConfigError`, que encerra o ciclo, em
  vez de queimá-lo todo no recuo tentando de novo o que nunca vai passar. (**Era**
  `RagConfigError` puro, e o painel, que lia a mensagem, mostrava a conta sem
  crédito como "chave aceita"; ver §9);
- **voyage: 403 é o IP, não a chave.** A mensagem diz isso, senão quem a lê
  troca a chave à toa — e a classe também: `RagOriginError`, um `RagAuthError`
  na política e outro `kind` no painel. O 403 de país ou região sem suporte da
  OpenAI é o mesmo caso;
- **openai: o 401 ecoa a chave recebida.** Mascarada quando tem cara de chave —
  o começo, uma fileira de asteriscos e os quatro últimos caracteres —, e como
  veio quando é curta ou está fora do formato, que é o caso de quem colou o
  segredo errado na variável. A mensagem do provedor vai para o log do indexador,
  para `rag.indexer.status` e daí para o "Último erro" do painel, que nunca
  recebe a chave (§9): por isso ela passa antes por `ocultarChave` (`http.ts`),
  que troca por `[chave omitida]` a chave literal e qualquer palavra com uma
  fileira de asteriscos. Os **três** drivers passam por ali, para o corte não
  depender de quem ecoa hoje;
- **os três: o 400 residual não é só "texto longo demais".** Todo 400 que o
  driver não reconhece vira `RagInputTooLongError`, e esse balde também recebe o
  400 que é da **instalação** — um intermediário na URL base que não entende um
  campo, contrato de API que mudou, erro de conta devolvido como 400. O driver
  não tenta separá-los: dependeria do texto de erro de três provedores, que muda
  sem aviso. Quem confere é o indexador, com o texto-sonda, antes de gravar uma
  recusa (§7.1).

Duas escolhas de dimensão, que parecem contraditórias e não são. Na OpenAI o
parâmetro `dimensions` **encurta** o vetor a partir da nativa, então ele não é
enviado. Na Voyage, 1024 não é a nativa: é a padrão entre 256, 512, 1024 e
2048, e `output_dimension` **vai escrito** — um padrão do provedor pode mudar, a
dimensão do espaço não, e o `CHECK` da `020` recusaria os vetores novos com uma
mensagem longe da causa.

### 6.1 O driver falso e o servidor falso

O `FakeDriver` é determinístico por palavras, sem rede. O servidor falso imita
**os três protocolos** — cada um no seu endereço, no seu header, no seu formato
de corpo e, o que mais importa, no **seu formato de erro**: o Google manda
`error.status` em maiúsculas, a OpenAI manda `error.type` e `error.code`, a
Voyage manda `detail`.

Um driver que leia o campo errado passa no teste de `fetch` simulado, onde a
resposta é o que o próprio teste escreveu, e só falha contra a API real. É isso
que os corpos de erro do servidor falso pegam antes.

As falhas simuladas têm nomes **do projeto**, não do provedor, porque o que
interessa é o que o driver deve fazer com o erro. Nem todo provedor tem todas;
pedir uma que a API não tem responde 500 dizendo isso — um 200 ali deixaria a
asserção passar sem testar nada.

## 7. O indexador

Container `apps/indexer`, com um modo contínuo e um `--once`. Ele **sobe no
`up -d`** como os demais serviços e, com o driver `off`, só publica o estado: a
trava do envio de conteúdo é o driver escolhido no painel, com a chave dele no
ambiente, e nada além disso ([`02`](02-architecture-decisions.md) §10). **Era**,
até a `beta.21`: ~~"Container `apps/indexer`, perfil `rag`"~~ — subir o
indexador era um segundo gesto (`docker compose --profile rag up -d indexer`); a
linha do perfil segue no compose, comentada, para quem quiser esse gesto de
volta. O ciclo separa duas coisas de propósito:

1. **refatiar** as skills marcadas em `skills.rag_stale` — não custa nada e não
   precisa de chave nenhuma;
2. **embutir** os textos sem vetor no espaço ativo — isso sim chama o provedor
   e custa dinheiro.

É essa separação que faz "Reindexar" no painel ser **de graça**: marcar tudo
como pendente refaz as divisões, e os textos que não mudaram continuam com o
vetor que já tinham, porque o endereço deles é o hash do conteúdo.

O ciclo **nunca derruba o processo** por causa do ambiente: sem a migration ele
espera, sem chave refatia e avisa, com o driver `off` só publica o estado em
`rag.indexer.status`. E nenhuma chamada ao provedor fica sem prazo: cada lote
leva o seu (`RAG_INDEX_TIMEOUT_MS`), senão um provedor que aceita a conexão e
nunca responde segura a rodada pelos prazos internos do `undici` multiplicados
pelas tentativas, com o painel mostrando dado velho sem dizer que o ciclo está
pendurado. O lote cortado não se perde: a rodada seguinte retoma de onde parou —
o que foi gravado ficou gravado, e o que não foi é **devolvido à fila** na hora
(abaixo).

Mais de uma réplica pode rodar **sem corromper nada e sem pagar duas vezes** — a
reserva de skills usa `SKIP LOCKED`, a gravação de vetores ignora conflito e a
fila de textos (§7.1) **reserva** o que entrega (`025`): `listPendingRagTexts`
grava a reserva na mesma statement da leitura, por dez minutos (`RESERVA_MS`),
então cada texto sai para um indexador só. A reserva vence sozinha — indexador
morto não estaciona a fila — e `insertRagVectors` a baixa assim que o vetor
entra. **Era**, até a `025`: ~~"Segura não quer dizer econômica: a fila de textos
(§7.1) não tem reserva, então duas réplicas leem a mesma lista e as duas pagam
ao provedor pelo mesmo texto; o banco fica certo, a fatura dobra. Dar reserva à
fila é mudança de `@purple-skills/db` (pedido aberto)"~~. Onde a reserva não
alcança — vencida no meio do caminho —, o indexador continua sem *se enganar*:
quem perde a corrida recebe zero de `insertRagVectors`, e é pelo número de
textos **processados** — não pelo de gravados — que o `--once` decide se a fila
andou. Pelo outro, ele encerraria dizendo "não há mais nada a fazer" logo depois
de ter pago por um lote inteiro.

A reserva tem uma **terceira saída**, além do vetor e do vencimento: o indexador
**vivo** que desiste do lote a devolve (`releaseRagTextReservations`, porta
opcional como as outras da `025`). Quando um lote falha por motivo que não é o
conteúdo — chave, cota, 5xx, prazo estourado, erro ao gravar o vetor —, a etapa
encerra e devolve o que o ciclo reservou e não resolveu: a fatia que falhou **e**
os lotes dos mesmos 64 textos que nem chegaram a sair. **Era**, até a beta.22:
~~o lote ficava reservado por dez minutos por quem já tinha desistido dele~~ — o
ciclo seguinte reservava os 64 seguintes e falhava de novo, e com a fila inteira
reservada ela vinha "vazia": o estado publicado dizia `lastError: null`, o painel
mostrava a chave como aceita com centenas de textos sem vetor, e o `--once`
reexecutado depois de corrigir a chave saía com 0 sem embutir nada. A devolução
é sempre **já**, inclusive no limite de taxa: adiar a volta daqueles textos não
pouparia o provedor (o ciclo seguinte reservaria os textos seguintes) e, com a
fila toda adiada, o sintoma voltaria — quem espera o `Retry-After` é o
`ClienteHttp`, dentro do prazo da chamada. Só **não** devolve a etapa que durou
mais que a própria reserva (provedor segurando as chamadas até o prazo, lote após
lote): a reserva não tem dono, a dela já venceu sozinha, e o que estiver
reservado àquela altura pode ser da réplica vizinha — devolver baixaria a reserva
dela, e as duas pagariam pelo mesmo embedding. Falha ao devolver é engolida com
linha no log, porque roda dentro do tratamento de outro erro; o prazo da reserva
continua sendo a rede de segurança. E o caso que a devolução não alcança —
processo morto no meio do lote, ou a outra réplica trabalhando — deixou de ser
mudo: fila vazia com texto sem vetor que não é recusa vira uma linha no log
dizendo quantos estão reservados e fora da fila.

**A parada é educada.** SIGTERM e SIGINT não fecham mais o pool com o ciclo em
curso: o ciclo consulta o pedido de parada **entre** uma skill e outra e **entre**
um lote de textos e outro, termina o que está em curso e devolve à fila o que
reservou e não começou — as skills com `releaseStaleSkill`, os textos com a
devolução acima. O encerramento espera por isso **com teto** (8 segundos): o
compose não define `stop_grace_period`, o Docker manda SIGKILL 10 segundos depois
do SIGTERM, e um lote no provedor pode levar `RAG_INDEX_TIMEOUT_MS`. Estourado o
teto, nada se perde — as duas reservas têm prazo (a de skills desde a migration
`reserva-de-skills-com-prazo`) e o que ficou volta sozinho; a parada educada é o
que troca "volta em até dez minutos" por "volta no ciclo seguinte" no caso de
todo dia, que é o deploy. O `--once` tem o mesmo tratador, e sai com 128 + o
número do sinal (143, 130): interrompido não é "não há mais pendência". A
devolução de skill que falha — o banco caiu no meio do laço — deixou de ser
engolida em silêncio e vai para o log.

### 7.1 O texto que o provedor recusa

A fila de pendentes é ordenada por `created_at`: ela devolve os textos sem vetor
mais antigos — desde a `025`, só os que não estão **reservados** por outro
indexador nem **recusados** neste espaço (`rag_text_status`). **Era**, até a
`025`: ~~"e **não tem reserva**: ela devolve os textos sem vetor mais antigos,
sempre os mesmos, até eles ganharem vetor"~~ — é o comportamento que explica o
problema abaixo. Um texto que o provedor recusa pelo conteúdo —
`RagInputTooLongError`, que é onde caem os 400 residuais dos três drivers —
nunca ganha vetor. Sem tratamento, ele volta em **todo** ciclo, é pago de novo a
cada intervalo e nada atrás dele chega a ser tentado: basta um texto assim no
acervo para a fila parar de andar, com a fatura crescendo e a cobertura parada
onde estava.

Por isso a etapa de embutir faz quatro coisas (**era** "três", até a beta.22: a
segunda é nova):

1. **grava lote a lote.** Cada lote que volta é gravado antes de o próximo sair;
   um erro adiante não joga fora o que já foi pago;
2. **confere a recusa antes de acreditar nela.** A marca é permanente, e um 400
   só prova que o problema é *aquele conteúdo* se o provedor, com a mesma chave,
   URL, modelo e formato, aceita **outro**. Todo lote recusado passa primeiro pelo
   **texto-sonda** (`TEXTO_SONDA`): fixo, curto, sem conteúdo de skill, enviado
   pelo mesmo `embedDocuments` do ciclo e com o vetor descartado. Sonda aceita, o
   problema é o conteúdo e a caça ao culpado segue. Sonda **também** recusada, o
   problema é da instalação — intermediário na URL base, contrato da API, conta —:
   **nada é marcado**, o lote volta à fila (§7), o ciclo registra um
   `RagConfigError` que cita a resposta do provedor e encerra, o painel mostra o
   erro e o `--once` sai com 1. Sonda que cai por outro motivo (rede, cota, prazo)
   é falha do ciclo, e na dúvida também não se marca nada. A prova vem **depois**
   do 400 e a cada lote recusado, e não de "já aceitou algo neste ciclo": o 400
   sistêmico pode começar no meio dele. Custa uma requisição de poucos tokens por
   lote recusado — em regime normal, uma vez por texto venenoso, que depois de
   marcado não volta;
3. **isola o culpado.** Lote recusado pelo conteúdo volta um texto por vez —
   texto sozinho não deixa o driver dividir o lote outra vez, e é assim que se
   descobre qual deles o provedor não aceita;
4. **marca o recusado.** Ele sai da fila: não é reenviado nos ciclos seguintes,
   o log registra o hash curto e o tamanho (nunca o conteúdo, que pode ser de
   skill privada), e `rag.indexer.status` publica `refusedTexts`.

Sem a segunda, um 400 que atingisse **todo** texto marcava o acervo inteiro como
recusado para sempre, 64 textos a cada ciclo, com `erros === 0`, a chave
"aceita" no painel e o `--once` saindo com 0 — e nada desfazia a marca: nem
"Reindexar" (o texto volta sob o mesmo hash e reencontra a mesma linha), nem
reiniciar o container, nem, no `google`, trocar de modelo. "Lote inteiro recusado
é erro de configuração" não serve no lugar da sonda: um arquivo grande num
alfabeto que gasta mais tokens por caractere rende dez partes genuinamente
recusadas em sequência, e o bloqueio de cabeça de fila voltaria.

Recusa tratada **não** conta como erro do ciclo: o `--once` não pode sair com 1
por causa de um texto que nunca vai passar. Erro que não é de conteúdo, esse sim,
encerra a etapa em vez de seguir para os lotes seguintes — a política de
tentativas de `http.ts` já recuou e tentou de novo antes de ele chegar aqui, e o
que foi gravado ficou gravado.

A marca é gravada **no banco** (`markRagTextRefused`, `025`): a recusa vira linha
em `rag_text_status`, por par (espaço, texto) — outro modelo pode aceitar o que
este recusou —, e é a própria fila que deixa de devolvê-la, inclusive depois de
reiniciar o container e para a réplica vizinha. Por isso a fila pede exatamente
o tamanho do lote (`TEXT_BATCH`, 64): inflar a janela para descartar em memória
deixou de ter motivo, e passaria a **reservar** texto que o ciclo não vai
embutir. A memória do processo (`RecusasRag`) continua atrás disso como **rede
de segurança**: a gravação da marca roda dentro do tratamento de um erro e é
engolida se falhar, e sem a lista o texto voltaria para ser pago de novo. Ela
guarda **só** a recusa que o banco não guardou (**era**, até a beta.22: ~~toda
recusa~~) — guardando todas, passava por cima do reparo do painel (§9):
`clearRagRefusals` apaga as linhas do banco e não alcança o processo do
indexador, que reservava os textos liberados, os descartava em memória e os
segurava por dez minutos a cada ciclo, até alguém reiniciar o container. Efeito
colateral aceito: o texto recusado que fica órfão e é coletado (§12) perde a
marca, e se o mesmo conteúdo voltar ao acervo o provedor o recusa uma vez mais.
**Era**, até a `025`: ~~"A marca vive **em memória do processo**: gravá-la no
banco depende de uma função de `@purple-skills/db` que ainda não existe (a porta
`markRagTextRefused` do indexador já espera por ela). O limite disso é estreito
e conhecido — reiniciar o container tenta o texto recusado uma vez mais, uma vez
por vida em vez de uma vez por ciclo, e acima de algumas centenas de recusas no
mesmo espaço a janela pedida à fila bate no teto de 500 linhas e o bloqueio
volta"~~.

## 8. A busca

O passo zero é **normalizar a consulta**: teto de 200 caracteres, cortado na
fronteira de palavra, pelo mesmo `consultaDaBusca` que alimenta a perna textual
(`022`). É esse recorte que vai ao provedor — o custo e o conteúdo enviados não são
escolhidos pelo cliente — e ele não é variável de ambiente, porque tem de ser o
mesmo número do `normalizeQuery` do banco.

Por requisição: ler a configuração (cache de 10 s), resolver o driver, achar o
espaço, embutir a consulta com prazo, e fundir com a busca textual por RRF com
`k = 60` — a **perna textual entra inteira**, 20 vizinhos na perna vetorial, sem
corte por distância. O teto de 100 skills que a perna textual tinha caiu: ele
travava o conjunto fundido em 100 + vizinhos, e com ele o `total` e a paginação —
ligar o RAG **encolhia** a busca. Quem põe a cauda no lugar dela é o próprio RRF,
que decresce com a posição. O recorte de visibilidade vale **nas duas pernas**:
uma skill que o site não mostra não aparece por ter vetor parecido com a busca.

A resposta traz `mode`, `text` ou `hybrid`, para o cliente saber o que leu —
não para escolher. As distâncias vão para o log e não para o cliente: sem corte
por distância, toda consulta ganha vizinhos, e expor números que ainda não
significam nada convidaria a filtrar por eles.

## 9. O painel

Um painel "Busca semântica" em Configurações, só para administrador:

- **driver e modelo**, com as opções saindo do registro. Trocar de driver leva
  o modelo junto — um modelo do driver anterior não existe no novo, e gravar a
  combinação faria o indexador recusar a configuração no ciclo seguinte;
- **origem de cada valor**: banco, ambiente ou padrão do código, e o que do
  `.env` está sendo ignorado;
- **estado da chave** — presente, ausente, recusada, cota esgotada, sem
  crédito, não confirmada ou desconhecido. O painel **não recebe a chave**: tudo
  que ele sabe vem de `rag.indexer.status`, e "desconhecido" é o estado honesto
  de quando o indexador ainda não rodou. O estado é uma **classificação**, e sai
  da classe do último erro (`lastErrorKind`, o `kind` da §6), que o indexador
  publica ao lado da mensagem: `auth` é recusada, `quota` é sem crédito,
  `rate-limit` é cota esgotada, e todo o resto — provedor fora do ar, prazo,
  configuração, origem recusada, erro que nem veio do provedor — é **não
  confirmada**, porque houve erro e ele não fala da chave. Só ciclo sem erro dá
  "presente". (**Era**, até a beta.22, deduzido por pedaço de texto da mensagem,
  e o que a busca não reconhecia virava "presente": a conta da OpenAI sem
  crédito e o IP recusado pela Voyage apareciam como "aceita pelo provedor",
  logo acima do erro.) Estado gravado por um indexador anterior ao campo cai no
  recuo por mensagem, que também deixou de concluir "presente" diante de erro;
- **cobertura e pendências** do espaço ativo, e o último erro. A pendência
  separa o que o indexador **vai** fazer do que ele não faz sozinho: os textos
  **recusados** pelo provedor saem da conta de "a embutir" e as skills
  **travadas** saem da de "a refatiar", cada uma com a sua linha. Travada é a
  skill cuja leitura começou três vezes e não terminou nenhuma (é a que derruba
  o indexador; o banco deixa de retomá-la sozinho e a conta em
  `ragCoverage().stuckSkills`) — editá-la ou "Reindexar" dá uma chance nova;
- **Reindexar**, que marca o acervo e não apaga vetor nenhum;
- **Tentar de novo** os textos recusados, que aparece só quando há algum. É o
  reparo da marca gravada por engano — um 400 que era da instalação —, e hoje
  também o único jeito de desfazê-la: a recusa é permanente e nenhuma gravação
  automática a toca. **Não** é o "Reindexar", e não foi embutido nele de
  propósito: reindexar é de graça por contrato, e isto custa requisições — o que
  for recusa genuína é recusado uma vez mais e remarcado. Por isso pede
  confirmação. Vale para o espaço **em uso** (o mesmo de onde sai a contagem ao
  lado do botão), e o banco o audita como `rag.reindex` com `"<n> recusas"` no
  alvo. O indexador não precisa ser reiniciado: a memória dele só guarda a recusa
  que o banco não guardou (§7.1).

O **aviso do nível gratuito é só do Google**. Com esse driver ele é sempre
exibido, porque o painel não tem como saber se a chave é gratuita ou paga, e a
consequência de não avisar é conteúdo de skill privada indo para treinamento
sem ninguém ver. OpenAI e Voyage não treinam sobre o tráfego da API: repetir o
aviso ali só ensinaria o operador a ignorá-lo.

## 10. Trocar de driver, de modelo ou de prefixo

Tudo cria espaço novo e **nada é apagado**:

- **desligar** (`off`) volta a busca ao modo textual em até 10 segundos;
  religar retoma o modo híbrido no mesmo espaço, sem reembutir;
- **trocar de modelo ou de driver** aponta a busca para outro espaço. Enquanto
  o indexador não o preenche, a cobertura aparece baixa e a busca responde em
  modo textual — o que é o comportamento certo, não uma falha;
- **mudar um prefixo no código** cria outro espaço e deixa o antigo intacto;
  voltar ao prefixo anterior reaproveita os vetores guardados;
- **apagar os vetores de um espaço** não existe ainda.

## 11. Custos e armazenamento

| | google | openai (small / large) | voyage (lite / 4 / large) |
|---|---|---|---|
| Preço por 1 M tokens | US$ 0,20 | US$ 0,02 / US$ 0,13 | conforme o plano |
| Bytes por vetor | ~12 KB | ~6 KB / ~12 KB | ~4 KB |
| 5 mil textos, por espaço | ~60 MB | ~30 MB / ~60 MB | ~20 MB |

A busca é **exata, sem índice**: o HNSW do pgvector não aceita mais de 2000
dimensões, e o `gemini-embedding-2` tem 3072. Com `voyage` (1024) o índice
passaria a ser possível — mas ele continua fora do escopo enquanto o acervo
couber numa varredura.

## 12. Riscos aceitos

- **conteúdo de skill privada no provedor:** ligar a busca semântica manda a um
  terceiro o texto de **todo** arquivo de texto de **toda** skill indexada,
  privada ou não (§4.1). Quem anexa o arquivo e quem liga o RAG podem ser
  pessoas diferentes, e não há controle de escopo da indexação — a escolha é
  ligar ou não ligar. Desde a `beta.22` essa escolha é **um gesto só**: o
  indexador já está no ar (§7), então escolher o driver no painel, com a chave
  no ambiente, basta para o envio começar no ciclo seguinte;
- **dados no nível gratuito do Google:** conteúdo e consultas são usados para
  melhorar produtos, e revisores humanos podem lê-los. No Espaço Econômico
  Europeu, na Suíça e no Reino Unido, só o nível pago é permitido para quem
  oferece o serviço a usuários dessas regiões;
- **ruído:** sem corte por distância, a perna vetorial acrescenta vizinhos
  pouco relacionados;
- **a exclusão com hífen não atravessa a perna vetorial** (relatório 062 da
  auditoria de 2026-09-19): `-termo` é sintaxe do `websearch_to_tsquery`, e só a
  perna textual o avalia — a CTE `semantica` filtra por visibilidade e tag, não
  por texto. Na busca híbrida a skill excluída pode voltar entre os 20 vizinhos
  (volta **sempre** num acervo de até 20 skills com vetor, porque o `LIMIT` não
  corta nada), empata no RRF com quem só veio do texto e desempata por acessos;
  e o termo excluído ainda vai inteiro ao provedor, dentro da consulta, puxando
  por ela. A descrição de `search_skills` diz isso ao cliente, e o campo `mode`
  é como ele sabe em qual caso está. O conserto de verdade é do banco —
  aplicar à perna vetorial **só a parte negativa** da consulta, nunca o
  predicado textual inteiro, que mataria a busca por significado — e, como toda
  mexida no SQL da híbrida, precisa ser medido antes (o custo estimado das
  subconsultas de visibilidade já é o que dispara o JIT);
- **rotação de chave:** exige recriar os containers do indexador, do mcp-public
  e do site;
- **ambiente ignorado:** depois que o banco tem um valor, mudar o `.env` não
  altera a configuração — só gera aviso;
- **a recusa não diz qual:** o texto que o provedor recusa sai da fila de vez
  (§7.1), mas nada no painel diz *qual* texto foi recusado — só quantos; o hash
  curto e o tamanho ficam no log do indexador, e o motivo, em
  `rag_text_status.reason`. **Era**, até a `025`: ~~"**recusa só em memória:** o
  texto que o provedor recusa sai da fila enquanto o processo viver (§7.1);
  reiniciar o indexador o tenta uma vez mais"~~;
- **a sonda é curta:** o texto-sonda (§7.1) prova que o provedor aceita *alguma
  coisa* nas mesmas condições, não que aceitaria aquele texto sem o que está no
  caminho. Um 400 que dependa do **tamanho** — um intermediário que limita o
  corpo da requisição — passa pela sonda e marca o texto. É recusa de conteúdo
  no sentido que importa (aquele texto não passa por ali), e o reparo é o
  "Tentar de novo" do painel (§9), depois de corrigida a causa. O mesmo vale
  para o 400 sistêmico que começa **entre** a sonda aceita e o fim da caça ao
  culpado do mesmo lote: uma janela de segundos, no máximo um lote;
- **falha persistente bate no provedor a cada ciclo:** com a devolução da
  reserva (§7), o lote que falhou volta no ciclo seguinte, e uma chave recusada
  ou um 400 sistêmico custam algumas requisições recusadas a cada intervalo — o
  comportamento de antes da `025`, e o preço de o erro aparecer em **todo**
  ciclo em vez de sumir com a fila reservada;
- **crescimento:** textos órfãos, e os vetores deles, se acumulam **entre uma
  coleta e outra**. Editar ou apagar uma skill tira as ocorrências e deixa o
  texto canônico: a FK de `rag_skill_texts` é sem cascata de propósito. Quem
  apaga o que ficou é `collectOrphanRagTexts` (`025`), que o ciclo do indexador
  chama no fim de cada rodada — depois de o refatiamento ter commitado, senão
  apagaria um texto que a ocorrência seguinte vai referenciar —, até
  `ORPHAN_BATCH` (500) textos por vez, com os vetores indo pela cascata. Sem
  indexador no ar não há coleta, e os vetores de um **espaço abandonado** não
  são órfãos: apagar um espaço continua não existindo (§10). O custo é de disco,
  não de API: a fila de pendentes exige ocorrência e não manda órfão ao
  provedor. **Era**, até a `025`: ~~"vetores e textos órfãos se acumulam até
  existir a limpeza […] e nada apaga o que ficou […] mas a função que apaga é de
  `@purple-skills/db` e ainda não existe (a porta `collectOrphanRagTexts` espera
  por ela)"~~;
- **visão do admin:** um erro de chave no mcp-public ou no site aparece no log
  desses containers, não no painel;
- **limites não publicados:** o tamanho máximo de lote do Google não é
  documentado; os valores usados são um teto nosso, conservador.
