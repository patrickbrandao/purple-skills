export type Frontmatter = {
  data: Record<string, string>;
  body: string;
};

/**
 * Parser mínimo de frontmatter YAML (`---` … `---`) com pares `chave: valor`.
 * Suficiente para ler `name`/`description` de um SKILL.md — sem dependência
 * de um parser YAML completo.
 */
export function parseFrontmatter(source: string): Frontmatter {
  const text = source.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
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
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Deriva `{ name, description }` de um SKILL.md, com heurísticas de fallback. */
export function skillMetaFromMarkdown(source: string): { name: string | null; description: string | null } {
  const { data, body } = parseFrontmatter(source);

  const name = data.name ?? data.title ?? firstHeading(body);
  const description = data.description ?? data.summary ?? firstParagraph(body);

  return {
    name: name?.trim() || null,
    description: description?.trim().slice(0, 500) || null,
  };
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
