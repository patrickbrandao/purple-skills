import { isValidSlug } from './slug.js';

export type Frontmatter = {
  data: Record<string, string>;
  body: string;
};

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

/**
 * Parser mínimo de frontmatter YAML (`---` … `---`) com pares `chave: valor`.
 * Suficiente para ler `name`/`description` de um SKILL.md — sem dependência
 * de um parser YAML completo. Linhas indentadas (o bloco `metadata:`) entram
 * no mesmo mapa raso: `title` e `tags` são lidos direto, sem hierarquia.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const text = source.replace(/^﻿/, '');
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text };

  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    data[kv[1]] = unquote(kv[2].trim());
  }

  return { data, body: text.slice(match[0].length) };
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
 */
export function stripFrontmatter(source: string): string {
  return source.replace(/^﻿/, '').replace(FRONTMATTER, '').replace(/^\s+/, '');
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

  const description = data.description ?? data.summary ?? firstParagraph(body);

  return {
    name: name?.trim() || null,
    description: description?.trim().slice(0, 500) || null,
    slug,
    tags: splitTags(data.tags),
  };
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
  const withoutHeadings = body.replace(/^#.*$/gm, '').trim();
  const paragraph = withoutHeadings.split(/\r?\n\s*\r?\n/)[0];
  return paragraph ? paragraph.replace(/\s+/g, ' ').trim() : null;
}
