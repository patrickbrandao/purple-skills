/**
 * Espelha `packages/shared/src/frontmatter.ts` — o servidor é quem decide.
 *
 * O pacote compartilhado é Node (zip, streams, Buffer) e não entra no bundle
 * do navegador; aqui fica o pedaço que as telas precisam: tirar o frontmatter
 * do prompt, montar as primeiras linhas a partir dos metadados e remontar o
 * SKILL.md inteiro para quem quiser copiar.
 *
 * Cópia idêntica em `apps/site/web/src/frontmatter.ts` — ao mexer, copie.
 */

// Daqui até o `stripFrontmatter`, o texto é o do pacote: mesmo padrão, mesma
// regra para dizer o que é frontmatter, mesmo laço. O teste do espelho
// (`apps/site/web/src/frontmatter.test.ts`) compara os dois caso a caso.
//
// O `---` só fecha o bloco quando é a linha inteira (até a quebra ou o fim do
// texto): sem essa âncora, `---abc` e uma régua `----------` fechavam. A
// abertura tolera espaço à direita, como o fechamento sempre tolerou.
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Par `chave: valor`. Em YAML os dois-pontos pedem espaço ou fim de linha depois — `https://…` não é par. */
const PAIR = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*))?$/;
const LIST_ITEM = /^-(?:[ \t]|$)/;

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Diz se o trecho entre os dois `---` tem cara de mapa YAML: a primeira linha
 * com conteúdo é um par `chave: valor`, e toda linha na indentação dele é
 * outro par ou um item de lista. Mais indentado que isso pode ser qualquer
 * coisa; linha em branco e comentário não contam.
 *
 * É o que separa frontmatter de **régua horizontal**: um prompt que abre com
 * `---`, tem prosa e outra régua adiante casava com o padrão, e o trecho entre
 * as duas era apagado antes de o Salvar mandar o texto — sem aviso na tela.
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
 * Remove o bloco de metadados do início do texto. Idempotente: o espaço em
 * branco sai antes de procurar o bloco, e blocos de frontmatter empilhados
 * saem todos de uma vez — o texto passa por aqui ao abrir e de novo ao salvar.
 */
export function stripFrontmatter(source: string): string {
  let text = source.replace(/^\uFEFF/, '').replace(/^\s+/, '');
  for (let match = matchFrontmatter(text); match; match = matchFrontmatter(text)) {
    text = text.slice(match[0].length).replace(/^\s+/, '');
  }
  return text;
}

export type SkillMeta = {
  slug: string;
  name?: string;
  description?: string;
  tags?: readonly string[];
};

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

/** As primeiras linhas do SKILL.md, montadas a partir do formulário. */
export function buildFrontmatter(meta: SkillMeta): string {
  const slug = meta.slug.trim();
  const name = meta.name?.trim() ?? '';
  const tags = (meta.tags ?? []).map((tag) => tag.trim()).filter(Boolean);

  const lines = [
    '---',
    `name: ${yamlScalar(slug)}`,
    `description: ${yamlScalar(meta.description ?? '')}`,
  ];

  if (name || tags.length > 0) {
    lines.push('metadata:');
    if (name) lines.push(`  title: ${yamlScalar(name)}`);
    if (tags.length > 0) lines.push(`  tags: ${yamlScalar(tags.join(', '))}`);
  }

  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/**
 * O SKILL.md como ele é materializado no download, na leitura crua e no MCP:
 * frontmatter gerado a partir dos metadados + corpo do prompt. Um frontmatter
 * que porventura esteja no corpo é descartado, para não sair duplicado.
 */
export function composeSkillMd(meta: SkillMeta, body: string): string {
  const content = stripFrontmatter(body);
  return content ? `${buildFrontmatter(meta)}\n${content}` : buildFrontmatter(meta);
}

/** Lista de tags a partir do campo separado por vírgulas. */
export function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}
