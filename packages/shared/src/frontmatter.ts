import { isValidSlug } from './slug.js';

export type Frontmatter = {
  data: Record<string, string>;
  body: string;
};

// O `---` só fecha o bloco quando é a linha inteira (até a quebra ou o fim do
// texto): sem essa âncora, `---abc` e uma régua `----------` fechavam. A
// abertura tolera espaço à direita, como o fechamento sempre tolerou.
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Par `chave: valor`. Em YAML os dois-pontos pedem espaço ou fim de linha depois — `https://…` não é par. */
const PAIR = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^-(?:[ \t]|$)/;
/** O mesmo item, com o valor: `- alfa` em lista de bloco. */
const LIST_VALUE = /^-(?:[ \t]+(.*))?$/;
/** `|` ou `>`, com os indicadores de corte e de indentação em qualquer ordem, e comentário opcional. */
const BLOCK_SCALAR = /^([|>])(?:[+-][1-9]?|[1-9][+-]?)?(?:[ \t]+#.*)?$/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Diz se o trecho entre os dois `---` tem cara de mapa YAML: a primeira linha
 * com conteúdo é um par `chave: valor`, e toda linha na indentação dele é
 * outro par ou um item de lista. Mais indentado que isso pode ser qualquer
 * coisa (bloco `metadata:`, escalar de bloco, continuação); linha em branco e
 * comentário não contam.
 *
 * É o que separa frontmatter de **régua horizontal**: um corpo que abre com
 * `---`, tem prosa e outra régua adiante casava com o padrão, e o trecho entre
 * as duas era descartado como se fosse metadado — em toda leitura e em toda
 * gravação. O erro que sobra é para o lado seguro: frontmatter escrito de um
 * jeito que isto não reconhece fica visível no corpo, em vez de sumir.
 */
function isFrontmatterBlock(block: string): boolean {
  let root = -1;
  for (const line of block.split(/\r?\n/)) {
    const content = line.trim();
    if (content === '' || content.startsWith('#')) continue;

    const indent = indentOf(line);
    if (root < 0) {
      if (!PAIR.test(content)) return false;
      root = indent;
    } else if (indent < root || (indent === root && !PAIR.test(content) && !LIST_ITEM.test(content))) {
      return false;
    }
  }
  return root >= 0;
}

/** O bloco do início do texto, quando ele é frontmatter de verdade. */
function matchFrontmatter(text: string): RegExpExecArray | null {
  const match = FRONTMATTER.exec(text);
  return match && isFrontmatterBlock(match[1]) ? match : null;
}

/**
 * Parser mínimo de frontmatter YAML (`---` … `---`) com pares `chave: valor`.
 * Suficiente para ler `name`/`description` de um SKILL.md — sem dependência
 * de um parser YAML completo. Linhas indentadas (o bloco `metadata:`) entram
 * no mesmo mapa raso: `title` e `tags` são lidos direto, sem hierarquia.
 *
 * O valor pode vir nas linhas de baixo, mais indentadas que a chave: escalar
 * de bloco (`description: >-` ou `|`, como o js-yaml escreve texto longo) e
 * escalar simples ou entre aspas que continua (como o PyYAML escreve). Essas
 * linhas são valor, não par — nem quando têm forma de `chave: valor` dentro de
 * um escalar de bloco. Comentário segue ignorado.
 *
 * **Lista de bloco** (`tags:` e os itens abaixo, nas duas indentações que o
 * YAML aceita) vira o mesmo texto separado por vírgula que a lista em linha
 * (`[a, b]`) deixaria — o mapa continua raso. **Era**, até a quarentena: os
 * itens eram descartados, e o pacote escrito na forma mais comum da
 * especificação Agent Skills chegava sem tag nenhuma.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const text = source.replace(/^\uFEFF/, '');
  const match = matchFrontmatter(text);
  if (!match) return { data: {}, body: text };

  const data: Record<string, string> = {};
  // Valores que ainda podem continuar na linha de baixo: as aspas só saem no
  // fim, porque podem abrir numa linha e fechar em outra.
  const open = new Set<string>();
  // Itens da lista de bloco de cada chave (`tags:` seguida de `- alfa`). Ficam
  // à parte até o fim porque viram um valor só, separado por vírgula.
  const lists = new Map<string, string[]>();
  let last: { key: string; indent: number; empty: boolean } | null = null;

  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const content = lines[i].trim();
    if (content === '' || content.startsWith('#')) continue;

    const indent = indentOf(lines[i]);
    const kv = PAIR.exec(content);
    if (!kv) {
      if (!last || !open.has(last.key)) continue;

      const item = LIST_VALUE.exec(content);
      if (item) {
        // Lista de bloco do YAML. Só conta quando a chave veio **sem valor na
        // linha dela** (`tags:` e os itens abaixo) e quando os itens estão na
        // indentação da chave ou mais fundo — as duas grafias que o YAML
        // aceita. `chave: x` seguida de `- y` é YAML inválido; juntar os dois
        // inventaria um valor, então ali o item continua ignorado, como era.
        if (!last.empty || indent < last.indent) continue;
        const parsed = unquote((item[1] ?? '').trim());
        if (parsed) lists.set(last.key, [...(lists.get(last.key) ?? []), parsed]);
        continue;
      }

      if (indent > last.indent) data[last.key] = `${data[last.key]} ${content}`.trim();
      continue;
    }

    const [, key, value = ''] = kv;
    last = { key, indent, empty: value.trim() === '' };

    const block = BLOCK_SCALAR.exec(value);
    if (!block) {
      data[key] = value.trim();
      open.add(key);
      continue;
    }

    // Escalar de bloco: o valor são as linhas SEGUINTES, enquanto estiverem em
    // branco ou mais indentadas que a chave.
    const scalar: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || indentOf(lines[i + 1]) > indent)) {
      i += 1;
      scalar.push(lines[i]);
    }
    data[key] = blockScalar(block[1], scalar);
    open.delete(key);
  }

  for (const key of open) data[key] = unquote(data[key]);

  // A lista de bloco vira o mesmo texto que a lista em linha (`[alfa, beta]`)
  // deixaria: o mapa é raso de propósito, e quem lê `tags` já separa por
  // vírgula. Só sobrescreve chave que ficou vazia — é a condição que a coletou.
  for (const [key, items] of lists) if (!data[key]) data[key] = items.join(', ');

  return { data, body: text.slice(match[0].length) };
}

/**
 * Junta as linhas de um escalar de bloco: o literal (`|`) preserva as quebras
 * e a indentação interna; o dobrado (`>`) troca a quebra simples por espaço e
 * a linha em branco por quebra. O corte (`-`/`+`) não muda nada aqui — quebra
 * no fim de metadado não interessa a ninguém e sai sempre.
 */
function blockScalar(style: string, lines: string[]): string {
  const filled = lines.filter((line) => line.trim() !== '');
  const indent = Math.min(...filled.map(indentOf));
  const text = lines
    .map((line) => line.slice(indent).trimEnd())
    .join('\n')
    .trim();

  if (style === '|') return text;
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' '))
    .join('\n');
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  return value;
}

/**
 * Remove o frontmatter do início do texto.
 *
 * Os metadados moram em colunas do banco e são a fonte da verdade; o que fica
 * gravado no SKILL.md é só o corpo do prompt. Aplicado em toda escrita e em
 * toda leitura, também limpa o frontmatter de skills gravadas antes desta
 * regra — sem precisar de migração de dados.
 *
 * "Em toda leitura" só é seguro porque a função é **idempotente**: o texto
 * passa por até quatro passes num abrir-e-salvar do painel, e o segundo não
 * pode tirar mais nada. Daí as três regras daqui: só sai o que é frontmatter
 * de verdade (`isFrontmatterBlock` — régua horizontal e prosa ficam); o espaço
 * em branco do início sai **antes** de procurar o bloco, e não depois; e
 * blocos de frontmatter empilhados saem todos de uma vez, porque o que sobrasse
 * seria comido pelo passe seguinte.
 */
export function stripFrontmatter(source: string): string {
  let text = source.replace(/^\uFEFF/, '').replace(/^\s+/, '');
  for (let match = matchFrontmatter(text); match; match = matchFrontmatter(text)) {
    text = text.slice(match[0].length).replace(/^\s+/, '');
  }
  return text;
}

/** Metadados que viram as primeiras linhas do SKILL.md. */
export type SkillMeta = {
  /** Nome oficial da skill: vai no `name:` do frontmatter e na URL. */
  slug: string;
  /** Nome legível, exibido no catálogo. */
  name?: string;
  description?: string;
  tags?: readonly string[];
};

/**
 * Escreve um valor como escalar YAML, citando quando o texto puder ser lido
 * como outra coisa (`chave: valor`, comentário, lista, número, vazio…).
 */
function yamlScalar(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  const ambiguous =
    flat === '' ||
    /[:#]/.test(flat) ||
    /^[-?,[\]{}&*!|>'"%@`]/.test(flat) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(flat);

  if (!ambiguous) return flat;
  return `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Monta o frontmatter canônico da skill, no formato Agent Skills: `name` é o
 * slug (o nome oficial, `a-z0-9-`) e `description` diz o que a skill faz. O
 * nome legível e as tags — que a especificação não define — vão em `metadata`.
 */
export function buildFrontmatter(meta: SkillMeta): string {
  const slug = meta.slug.trim();
  const name = meta.name?.trim() ?? '';
  const tags = (meta.tags ?? []).map((tag) => tag.trim()).filter(Boolean);

  const lines = ['---', `name: ${yamlScalar(slug)}`, `description: ${yamlScalar(meta.description ?? '')}`];

  if (name || tags.length > 0) {
    lines.push('metadata:');
    if (name) lines.push(`  title: ${yamlScalar(name)}`);
    if (tags.length > 0) lines.push(`  tags: ${yamlScalar(tags.join(', '))}`);
  }

  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/**
 * SKILL.md completo: frontmatter gerado a partir dos metadados + corpo do
 * prompt. Usado sempre que o arquivo é materializado (download, leitura crua,
 * MCP); o frontmatter que porventura esteja no corpo é descartado.
 */
export function composeSkillMd(meta: SkillMeta, body: string): string {
  const content = stripFrontmatter(body);
  return content ? `${buildFrontmatter(meta)}\n${content}` : buildFrontmatter(meta);
}

/** Metadados lidos de um SKILL.md — usados ao importar um `.zip`. */
export type MarkdownSkillMeta = {
  /** Nome legível: `metadata.title`, um `name` não-slug ou o primeiro heading. */
  name: string | null;
  description: string | null;
  /** `name` do frontmatter, quando já é um slug válido. */
  slug: string | null;
  tags: string[];
};

/** Deriva os metadados de um SKILL.md, com heurísticas de fallback. */
export function skillMetaFromMarkdown(source: string): MarkdownSkillMeta {
  const { data, body } = parseFrontmatter(source);

  const frontName = data.name?.trim() || null;
  const slug = frontName && isValidSlug(frontName) ? frontName : null;

  // `name` é o nome oficial (slug) desde que os metadados saíram do markdown;
  // o nome legível vem de `metadata.title`. Um `name` antigo, com maiúsculas e
  // espaços, continua valendo como título.
  const name =
    data.title?.trim() ||
    (slug ? null : frontName) ||
    firstHeading(body) ||
    frontName;

  // "Primeiro valor útil", não "primeiro não-nulo": o `??` só pulava a chave
  // ausente, e uma `description:` presente e vazia vencia o `summary` e o
  // primeiro parágrafo — a skill nascia sem descrição.
  const description = firstUseful(data.description, data.summary, firstParagraph(body));

  return {
    name: name?.trim() || null,
    description: description?.slice(0, 500) || null,
    slug,
    tags: splitTags(data.tags),
    // Nada de publicação vem do frontmatter: onde a skill aparece é decidido
    // pelo vínculo a um vMCP, escolhido por quem importa — um `.zip` de
    // terceiro nunca se publica sozinho.
  };
}

/** O primeiro candidato com texto, já aparado. */
function firstUseful(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return null;
}

function splitTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((tag) => tag.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function firstHeading(body: string): string | null {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : null;
}

function firstParagraph(body: string): string | null {
  // Título e régua horizontal (`---`, `***`, `___`) não são parágrafo. A régua
  // entrou aqui junto com o `isFrontmatterBlock`: o corpo que abre com `---`
  // passou a chegar inteiro, e a descrição derivada seria o próprio "---".
  const withoutHeadings = body
    .replace(/^#.*$/gm, '')
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t\r]*$/gm, '')
    .trim();
  const paragraph = withoutHeadings.split(/\r?\n\s*\r?\n/)[0];
  return paragraph ? paragraph.replace(/\s+/g, ' ').trim() : null;
}
