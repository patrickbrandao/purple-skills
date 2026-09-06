# Sistema de design

A homepage, o site e o painel compartilham uma única linguagem visual, derivada
da homepage do **LangWizard** e revestida na cor da casa: o roxo do **Mago
Roxo**, mascote do Purple Skills.

Este documento diz onde cada peça mora e como mexer nela sem quebrar as
outras superfícies.

## Onde ficam os arquivos

```
apps/site/web/src/styles/
  tokens.css     variáveis de cor por tema + @font-face + ponte com o Tailwind
  base.css       tipografia, botões, cartões, campos, blocos de código
  chrome.css     nav flutuante e rodapé
  markdown.css   renderização do SKILL.md
  app.css        cabeçalho, mcp.json, endereços, catálogo, página da skill
                 e a árvore de arquivos (com a paleta por tipo de arquivo)

apps/homepage/web/src/styles/
  tokens.css     ← cópia idêntica à do site
  base.css       ← cópia idêntica à do site
  chrome.css     ← cópia idêntica à do site
  landing.css    seções de apresentação (hero, diagramas, ecossistema, finale)

apps/admin/web/src/styles/
  tokens.css     ← cópia idêntica à do site
  base.css       ← cópia idêntica à do site
  markdown.css   ← cópia idêntica à do site
  admin.css      barra, painéis, tabela, abas, dropzone, toasts, login
```

`tokens.css`, `base.css`, `chrome.css` e `markdown.css` são **byte a byte
iguais** entre os apps que os usam. Cada app tem seu próprio root do Vite e não
há um pacote de UI compartilhado, então a duplicação é deliberada — o mesmo
padrão que o projeto já usava para o `index.css`. **Ao mudar um, copie para os
outros:**

```bash
cp apps/site/web/src/styles/{tokens,base,markdown}.css apps/admin/web/src/styles/
cp apps/site/web/src/styles/{tokens,base,chrome}.css apps/homepage/web/src/styles/
```

## Cores

Todas as cores vivem em `tokens.css`, em dois blocos: `:root` (tema claro) e
`:root[data-theme='dark']`. Nenhum componente escreve um hex direto —
sempre `var(--alguma-coisa)`.

| Token | Papel |
|-------|-------|
| `--brand`, `--brand-soft`, `--brand-deep` | roxo, a cor predominante |
| `--gold`, `--gold-deep` | acento quente: downloads, segundo fluxo dos diagramas |
| `--ember` | erros e ações destrutivas |
| `--jade` | sucesso, skills públicas |
| `--bg`, `--bg-2`, `--surface`, `--surface-2`, `--surface-3` | fundos e superfícies |
| `--text`, `--text-dim`, `--text-faint` | hierarquia de texto |
| `--border`, `--border-strong` | traços |
| `--diag-wire`, `--diag-flow`, `--diag-flow-out` | fios dos diagramas |

**Para trocar a cor predominante** basta reescrever os três `--brand-*` nos
dois temas. Os gradientes decorativos (`.grad-text`, `.stat .n`,
`.sol-card::before`) carregam hex literais e precisam de um ajuste à parte.

O Tailwind enxerga esses tokens por um bloco `@theme inline` no fim do
`tokens.css` — `inline` é obrigatório aqui, senão as utilities congelariam o
valor do tema claro em vez de emitir `var(--surface)`. Daí saem utilities
como `bg-surface`, `text-dim` e `border-line`.

## Tema claro e escuro

O tema é um atributo `data-theme` no `<html>`, escrito por um script inline
no `index.html` **antes da primeira pintura** — sem isso a página piscaria
branca no modo escuro. A ordem é: escolha salva em `localStorage`, senão
`prefers-color-scheme`, senão claro.

O botão de alternar usa o hook `useTheme` (um por app, arquivos idênticos),
que grava a escolha de volta no `localStorage`.

## Tipografia

- **Aeonik** (Medium 500 / Bold 700) para títulos — classe `.display`.
  Os `.woff2` ficam em `web/public/assets/fonts/` e são pré-carregados.
- **JetBrains Mono** para código, rótulos técnicos e slugs — classe `.mono`.
  Vem do Google Fonts; a pilha de fallback (`ui-monospace`, Menlo) cobre o
  caso de a fonte não carregar. Se a chamada externa incomodar num deploy
  fechado, basta remover o `<link>` do `index.html`.
- Texto corrido usa a fonte do sistema.

## Imagens

`web/public/assets/images/` guarda:

- `purple-hat-256.png` — favicon, marca da navegação e selo do slug nos
  cartões do catálogo. Derivado do chapéu pixel-art, rotacionado no matiz
  para o roxo.
- `icon-purple-left-64x92.png`, `icon-purple-right-137x158.png` — o Mago
  Roxo, usado no hero e nos estados vazios.
- ícones de agentes, IDEs, modelos e do MCP — só na homepage, na seção de
  ecossistema e nos diagramas. O site guarda apenas os cinco que usa.

## Árvore de arquivos da skill

A caixa **Arquivos** da página da skill (`FileTree`) desenha o pacote como
explorador: a raiz é a pasta com o slug — a mesma que aparece ao descompactar
o `.zip` — e dentro dela vêm o `SKILL.md`, as subpastas e os anexos. Cada
pasta abre e fecha; o estado vive só no componente.

Cada arquivo ganha um ícone conforme a extensão (`FileTypeIcon`): logotipo do
Python para `.py`, selo `JS`/`TS`, chaves para `.json`, a marca do Markdown,
baleia para `Dockerfile` e por aí vai. Extensão desconhecida cai num selo com
as três primeiras letras, então nenhum arquivo fica sem ícone.

As cores desses ícones são a **única paleta que não mora no `tokens.css`**:
elas ficam em `--ft-*`, declaradas no `.file-tree` dentro do `app.css`, com o
bloco escuro logo abaixo. O motivo é que só esta tela usa essas cores e elas
não são da marca — não faria sentido carregá-las para a homepage e o painel,
que copiam o `tokens.css` byte a byte. O ícone recebe a classe `ft-<tipo>` e
os traços herdam a cor por `currentColor`.

## Diagramas

Três diagramas da homepage desenham seus fios em SVG a partir do layout real
(`getBoundingClientRect`), e não com coordenadas fixas:

| Componente | O que mostra |
|------------|--------------|
| `HubDiagram` | agentes → endpoint MCP → as três ferramentas principais |
| `PublishFlow` | criar pelo `mcp-admin` → catálogo → servir pelo `mcp-public` |
| `Services` | quem consome × os cinco serviços e o Postgres |

Cada um redesenha em `resize`, quando as fontes assentam e via
`ResizeObserver`. Abaixo de 820px os fios somem e o layout vira uma pilha
vertical — é a mesma quebra usada no CSS.

## Animação

`.reveal` (+ `.d1`…`.d5` para escalonar) revela blocos conforme entram na
viewport, ligado pelo hook `useReveal`. Tudo é neutralizado por
`prefers-reduced-motion: reduce`, incluindo o fluxo animado dos fios e a
contagem dos números.
