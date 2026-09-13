# A superfície de ferramentas como flag: `use_as_skill`

**Status: revogado por [`09`](09-mcp-padrao-e-skills-flutuantes.md).**
`use_as_skill` e `is_public` saíram no `012`. A superfície de ferramentas
continua sendo uma escolha por skill, mas **por vínculo** (`as_skill` de
`virtual_mcp_skills`), e a visibilidade no site passou a ser "está em algum
MCP virtual aberto". O que este documento fecha sobre o recorte morar na
consulta (`§4.1`) e sobre a recusa indistinta (`§3.2`) segue valendo.

Este documento registrava o desenho de
`skills.use_as_skill` — a coluna que decidia se uma skill pública aparecia nas
**ferramentas** do MCP público — e a promoção de `is_public` a interruptor
global dito com todas as letras.

É a continuação de [`06-publicacao-mcp.md`](06-publicacao-mcp.md), que fez o
mesmo pelas outras duas superfícies. **Leia aquele primeiro**: o que ele decide
sobre ortogonalidade (`§3.1`), erro indistinto (`§5.5`), leitura por requisição
(`§5.1`) e canal de mão única do frontmatter (`§6.4`) continua valendo aqui, e
não é repetido.

O schema saiu na migration `008-publicacao-como-skill.sql`; o recorte das
ferramentas, em [`apps/mcp-public/src/tools.ts`](../apps/mcp-public/src/tools.ts).

## 1. Por que

Depois de `06`, uma skill pública podia chegar ao agente por três caminhos —
as cinco ferramentas, o prompt e o resource — mas só dois eram escolha. O
primeiro era implícito: **toda** skill pública está nas ferramentas, sempre, e
não havia como dizer o contrário.

Isso deixava de fora dois casos reais:

- **a skill feita para ser invocada, não descoberta.** Um slash-command que o
  usuário chama pelo nome não precisa aparecer em `search_skills` — lá ela só
  ocupa espaço no resultado de buscas que não são sobre ela, e compete com as
  skills que o agente deveria achar sozinho;
- **o catálogo que expõe ao agente menos do que publica.** Uma instalação pode
  querer a skill visível no site e baixável, mas fora do alcance da busca
  automática do agente — por ser específica demais, por estar em revisão, ou
  por ser material de referência que só faz sentido quando alguém pede.

Fechar isso custa uma coluna, e o resultado é o produto completo: qualquer
combinação das três superfícies, inclusive nenhuma.

## 2. Decisões

| # | Decisão | Escolha |
|---|---------|---------|
| 1 | Nome | `use_as_skill`, na mesma família das outras duas |
| 2 | Valor inicial | `true` — **opt-out**, ao contrário das outras duas |
| 3 | O que a flag recorta | as cinco ferramentas, inteiras — inclusive `list_tags` |
| 4 | Onde o recorte acontece | na consulta do `@purple-skills/db`, não no app |
| 5 | Site, API REST e painel | **não** olham para a flag |
| 6 | `is_public` | interruptor global; nada no MCP público sem ela |
| 7 | Índice | nenhum, deliberadamente |
| 8 | Recusa por slug | a mesma da `§5.5` de `06`, indistinta |
| 9 | Escrita | os caminhos de metadados existentes; sem rota nem tool nova |
| 10 | Frontmatter | lido como as outras, mas só o literal `false` desliga |
| 11 | Painel e site | selo de **ausência**, não de presença |

## 3. Semântica

### 3.1 Opt-out, e por que a assimetria com `06` é correta

`use_as_prompt` e `use_as_resource` nascem `false` porque ligá-las no catálogo
inteiro é exatamente o que aquela feature existe para evitar (`06 §3.2`):
centenas de slash-commands na cara de todo cliente conectado.

`use_as_skill` nasce `true` pelo motivo espelhado. A superfície de ferramentas
**já é** o comportamento de toda skill pública desde o primeiro dia; nascer
`false` despublicaria o catálogo inteiro no `docker compose run migrate`, que é
o pior efeito colateral possível para uma migration. `DEFAULT true` deixa a base
existente exatamente como estava e transforma a coluna no que ela deve ser: um
opt-out, marcado skill a skill por quem tem motivo.

A assimetria é a razão de as três não terem virado uma coluna só (um
`publication_surfaces text[]`, digamos): cada uma tem um padrão diferente, e um
array esconderia isso atrás de "o que estiver na lista".

### 3.2 O que sai, exatamente

Com `use_as_skill = false`, a skill some das **cinco** ferramentas:

| Ferramenta | Efeito |
|-----------|--------|
| `search_skills` | não aparece nos resultados nem na contagem `total` |
| `get_skill` | "Skill não encontrada" |
| `get_skill_file` | "Skill não encontrada" |
| `download_skill` | "Skill não encontrada" |
| `list_tags` | não conta para nenhuma tag |

`list_tags` entra na lista porque uma contagem que soma skills que nenhuma
ferramenta mostra é uma promessa falsa: o agente filtraria por uma tag com "3
skills" e receberia uma.

As três recusas por slug são **indistintas** da recusa de um slug inexistente,
pelo motivo da `§5.5` de `06`: o servidor roda sem autenticação por padrão, e
distinguir "existe, mas não para você" entregaria o catálogo a quem sonda.
Aqui isso é menos crítico que numa skill privada — o slug está publicado no
site — mas manter um comportamento só é o que evita que a diferença vire
informação por acidente.

O que **não** muda: a página no site, a API REST pública, o `.zip`, o painel e
o MCP administrativo. A flag governa uma superfície, não a visibilidade.

### 3.3 `is_public` é o interruptor global

Com `is_public = false` a skill não é publicada em superfície nenhuma do MCP
público — nem como skill, nem como prompt, nem como resource — nem aparece no
site ou na API REST. As três flags de superfície continuam gravadas e inertes,
como decide a `§3.1` de `06`: despublicar e republicar não apaga a configuração.

Isso não é comportamento novo: `listPublishedSkills` já filtrava
`is_public AND …`, e as ferramentas já liam com `includePrivate: false`. O que
mudou é que agora está **dito**, no schema, no painel, nas `INSTRUCTIONS` dos
dois MCPs e aqui — porque com três flags de superfície ficaria fácil ler
`is_public` como só mais uma delas.

A hierarquia, em uma linha: `is_public` decide **se**; as três flags decidem
**por onde**; e nenhuma delas publica nada sozinha.

## 4. Implementação

### 4.1 O recorte mora na consulta

`listSkills`, `getSkillSummary`, `getSkillDetail` e `listTags` ganharam a opção
`onlyAsSkill`, e o `apps/mcp-public` a passa em **toda** leitura das
ferramentas. Não é preferência de estilo: `search_skills` pagina, e descartar
linhas depois da consulta furaria o `total` e deixaria páginas curtas; a
contagem de `list_tags` teria o mesmo problema, sem conserto possível no app.

Quem não passa a opção enxerga tudo — site, painel e MCP administrativo
continuam com as chamadas de antes, o que é o comportamento correto para os
três.

### 4.2 As outras duas superfícies não olham para a flag

`prompts/get` e `resources/read` seguem lendo com `includePrivate: false` e
**sem** `onlyAsSkill`. É o caso que a feature existe para permitir: uma skill
publicada só como prompt precisa continuar legível por ali. O que as três
superfícies têm em comum é `is_public`, e só.

### 4.3 Índice: nenhum

`007` criou índices parciais para as duas flags porque o predicado
(`is_public AND use_as_prompt`) casa com pouquíssimas linhas e com o exato
formato de uma listagem sem teto.

Aqui é o oposto: `use_as_skill` é verdadeira em quase toda linha, então um
índice parcial com esse predicado cobriria quase a tabela inteira, custaria
escrita em todo UPDATE de `skills` e não descartaria nada — as leituras das
ferramentas continuam decididas pelo full-text e pelos índices de `001`. A
pergunta "quais **não** são skill?" também não é feita por ninguém: o painel
lista tudo.

## 5. Escrita

### 5.1 Nenhuma rota nova

Como em `06 §6.1`, a flag entra pelos caminhos de metadados que já existem:
`POST /api/skills`, `PATCH /api/skills/:slug`, o import multipart e
`create_skill` / `edit_skill` do MCP administrativo. Não há
`POST /:slug/publication` nem `set_use_as_skill`.

### 5.2 Painel

Terceira caixa no `SkillMetaForm`, à esquerda das outras duas e marcada por
padrão, editável mesmo em skill privada — pelo mesmo motivo da `§6.2` de `06`.

O aviso abaixo do grupo ganhou um segundo estado: além de "a skill está
privada, nada disso aparece", agora avisa quando a skill é **pública e não tem
nenhuma superfície marcada** — um estado representável, legítimo (a skill vive
no site e na API) e fácil de alcançar sem querer.

Na listagem, o selo é de **ausência**: `sem ferramentas` aparece quando a flag
está desligada, e nada aparece quando está ligada. Um selo por skill flagada
estaria em quase toda linha sem informar nada; a exceção é o que o operador
precisa enxergar. O site segue a mesma regra, com o selo `sem busca` no card.

### 5.3 Frontmatter: o espelho

`skillMetaFromMarkdown` lê `use_as_skill` como lê as outras duas, mas com a
coerção invertida: `data.use_as_skill !== 'false'`. Chave ausente é o padrão do
schema (ligada), e só o literal `false` desliga — um `.zip` calado nunca é
confundido com um `.zip` que pediu para sair das ferramentas.

No import, a combinação com o formulário também espelha a `§`
correspondente de [`03-implementation-notes.md`](03-implementation-notes.md):
onde prompt e resource fazem `formulário || .zip`, esta faz
`formulário && .zip`. Nos dois casos a regra de fundo é a mesma — **o `.zip`
só consegue mover a flag para o lado de menos exposição**, e a visibilidade
continua vindo exclusivamente do formulário.

### 5.4 Auditoria

Sem novidade: `action: 'update'` com `previous_content` nulo, junto com os
demais metadados, como `06 §6.3`.

## 6. Impacto

Nenhum sobre dados existentes: a coluna nasce `true` e todo o catálogo continua
onde estava. `SkillSummary` ganha um campo obrigatório, o que quebra o
typecheck de todo literal que o constrói — as fixtures dos dois MCPs e as
cópias manuais de `apps/admin/web/src/api.ts` e `apps/site/web/src/api.ts`, que
não importam de `shared` por serem bundles de browser.

Testes acrescentados:

- as três leituras por slug das ferramentas pedem `onlyAsSkill`, e
  `search_skills` / `list_tags` também;
- a skill fora das ferramentas responde o mesmo "não encontrada" de um slug
  inexistente, sem contar acesso;
- prompt e resource continuam servindo uma skill com `use_as_skill = false`;
- `create_skill` do MCP administrativo cria dentro das ferramentas quando o
  campo é omitido, e fora quando vem `false`;
- a coerção invertida do frontmatter e a combinação `formulário && .zip` no
  import.

## 7. Fora do escopo

- **Filtro por superfície no `search_skills`.** Continua valendo a decisão 17
  de `06`: a busca não conta ao agente por quais portas cada skill também sai.
- **Uma quarta superfície para anexos** (`skill://{slug}/{path}`) — `06 §9`.
- **Despublicar em massa por tag ou filtro.** A flag é por skill, como as
  outras duas; uma operação em lote é UI, não schema.
