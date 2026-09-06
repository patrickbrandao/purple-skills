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

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;

/** Remove o bloco de metadados do início do texto. */
export function stripFrontmatter(source: string): string {
  return source.replace(/^﻿/, '').replace(FRONTMATTER, '').replace(/^\s+/, '');
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
