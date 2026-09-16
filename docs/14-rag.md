# Busca semântica: espaços de embedding e os três drivers

**Status: implementado**, em seis PRs (`feat/rag-*`, depois
`feat/rag-tres-drivers`). Migration `020-rag.sql`, pacote `packages/rag/`,
container `apps/indexer/`.

Este documento registra o desenho fechado nas entrevistas de 15/09/2026 (o
driver `google`) e de 16/09/2026 (a generalização para três provedores). Ele é
a referência de *por que* cada peça é assim; o resumo do que está no ar entra
em [`02-architecture-decisions.md`](02-architecture-decisions.md) e os desvios
em [`03-implementation-notes.md`](03-implementation-notes.md). O que é do
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

## 5. Configuração: o ambiente semeia, o banco decide

Cinco containers leem a configuração do RAG. Se o ambiente valesse sempre, um
container com a variável diferente divergiria dos outros em silêncio. Então:

1. **o admin semeia no boot**: para cada chave, grava o valor do ambiente só
   quando o banco ainda não tem linha, com o ator `ambiente` na auditoria;
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

A política de tentativas mora uma vez só, em `packages/rag/src/http.ts`: ela
não vem da API, vem do que o indexador precisa, e é igual nos três.

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

Quatro armadilhas que custaram comentário no código:

- **google: um item de `requests[]` por texto, sempre.** Mandar vários textos
  nas `parts` de um mesmo `content` é aceito pela API e devolve **um vetor
  agregado** dos textos somados — silenciosamente errado, e só perceptível
  quando a busca começa a trazer coisa sem sentido;
- **openai e voyage: a resposta é casada pelo `index`**, não pela ordem de
  chegada. As duas mandam um `index` em cada item justamente porque a ordem não
  é promessa; confiar nela gravaria o vetor de um texto sob o hash de outro, e
  o estrago só apareceria como busca ruim, meses depois;
- **openai: `insufficient_quota` é 429 mas não é limite de taxa.** É conta sem
  crédito: vira `RagConfigError`, que encerra o ciclo, em vez de queimá-lo todo
  no recuo tentando de novo o que nunca vai passar;
- **voyage: 403 é o IP, não a chave.** A mensagem diz isso, senão quem a lê
  troca a chave à toa.

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

Container `apps/indexer`, perfil `rag`, com um modo contínuo e um `--once`. O
ciclo separa duas coisas de propósito:

1. **refatiar** as skills marcadas em `skills.rag_stale` — não custa nada e não
   precisa de chave nenhuma;
2. **embutir** os textos sem vetor no espaço ativo — isso sim chama o provedor
   e custa dinheiro.

É essa separação que faz "Reindexar" no painel ser **de graça**: marcar tudo
como pendente refaz as divisões, e os textos que não mudaram continuam com o
vetor que já tinham, porque o endereço deles é o hash do conteúdo.

O ciclo **nunca derruba o processo** por causa do ambiente: sem a migration ele
espera, sem chave refatia e avisa, com o driver `off` só publica o estado em
`rag.indexer.status`. Mais de uma réplica pode rodar — a reserva usa
`SKIP LOCKED` e a gravação de vetores ignora conflito.

## 8. A busca

Por requisição: ler a configuração (cache de 10 s), resolver o driver, achar o
espaço, embutir a consulta com prazo, e fundir com a busca textual por RRF com
`k = 60` — perna textual limitada a 100 skills, 20 vizinhos na perna vetorial,
sem corte por distância. O recorte de visibilidade vale **nas duas pernas**:
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
- **estado da chave** — presente, ausente, recusada, cota esgotada ou
  desconhecido. O painel **não recebe a chave**: tudo que ele sabe vem de
  `rag.indexer.status`, e "desconhecido" é o estado honesto de quando o
  indexador ainda não rodou;
- **cobertura e pendências** do espaço ativo, e o último erro;
- **Reindexar**, que marca o acervo e não apaga vetor nenhum.

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

- **dados no nível gratuito do Google:** conteúdo e consultas são usados para
  melhorar produtos, e revisores humanos podem lê-los. No Espaço Econômico
  Europeu, na Suíça e no Reino Unido, só o nível pago é permitido para quem
  oferece o serviço a usuários dessas regiões;
- **ruído:** sem corte por distância, a perna vetorial acrescenta vizinhos
  pouco relacionados;
- **rotação de chave:** exige recriar os containers do indexador, do mcp-public
  e do site;
- **ambiente ignorado:** depois que o banco tem um valor, mudar o `.env` não
  altera a configuração — só gera aviso;
- **crescimento:** vetores e textos órfãos se acumulam até existir a limpeza;
- **visão do admin:** um erro de chave no mcp-public ou no site aparece no log
  desses containers, não no painel;
- **limites não publicados:** o tamanho máximo de lote do Google não é
  documentado; os valores usados são um teto nosso, conservador.
