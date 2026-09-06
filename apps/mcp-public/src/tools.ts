import {
  getSkillDetail,
  getSkillSummary,
  incrementViewCount,
  listSkills,
  listTags,
  readFile,
} from '@purple-skills/db';
import {
  composeSkillMd,
  isSkillMd,
  normalizeRelativePath,
  stripFrontmatter,
} from '@purple-skills/shared';
import { config } from './config.js';

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});
const asJson = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

export const downloadUrlFor = (slug: string) =>
  `${config.siteBaseUrl}/skills/${encodeURIComponent(slug)}/download`;

export const fileUrlFor = (slug: string, path: string) =>
  `${config.siteBaseUrl}/skills/${encodeURIComponent(slug)}/files/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

/**
 * Handlers das ferramentas do MCP público. Ficam separados do registro no
 * servidor para poderem ser testados sem subir o transporte HTTP.
 */
export const handlers = {
  async search_skills(args: {
    query?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<ToolResult> {
    const result = await listSkills({
      query: args.query ?? null,
      tag: args.tag ?? null,
      limit: args.limit ?? 10,
      offset: args.offset ?? 0,
      includePrivate: false,
    });

    if (result.items.length === 0) {
      return text(
        `Nenhuma skill encontrada${args.query ? ` para "${args.query}"` : ''}${
          args.tag ? ` na tag "${args.tag}"` : ''
        }.`,
      );
    }

    return asJson({
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      results: result.items.map((skill) => ({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        score: skill.score,
        files: skill.fileCount,
        url: `${config.siteBaseUrl}/skills/${skill.slug}`,
      })),
    });
  },

  /** Retorna o SKILL.md completo. Conta um acesso (view_count). */
  async get_skill(args: { slug: string }): Promise<ToolResult> {
    const detail = await getSkillDetail(args.slug, { includePrivate: false });
    if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

    await incrementViewCount(detail.uuid);

    const attachments = detail.files.filter(
      (file) => file.relativePath.toLowerCase() !== 'skill.md',
    );

    const header = [
      `# ${detail.name}`,
      detail.description && `\n${detail.description}`,
      `\nslug: ${detail.slug}`,
      detail.tags.length > 0 && `tags: ${detail.tags.join(', ')}`,
      `página: ${config.siteBaseUrl}/skills/${detail.slug}`,
      `download (zip): ${downloadUrlFor(detail.slug)}`,
      attachments.length > 0 &&
        `\nArquivos anexados (use get_skill_file para ler):\n${attachments
          .map((file) => `- ${file.relativePath} (${file.mimeType}, ${file.sizeBytes} bytes)`)
          .join('\n')}`,
      '\n---\n',
    ]
      .filter(Boolean)
      .join('\n');

    return text(`${header}\n${stripFrontmatter(detail.skillMd)}`);
  },

  /** Lê um arquivo anexado da skill. Não conta acesso (só o SKILL.md conta). */
  async get_skill_file(args: { slug: string; path: string }): Promise<ToolResult> {
    const skill = await getSkillSummary(args.slug, { includePrivate: false });
    if (!skill) return fail(`Skill não encontrada: "${args.slug}"`);

    const path = normalizeRelativePath(args.path);
    if (!path) return fail(`Caminho inválido: "${args.path}"`);

    const file = await readFile(skill.uuid, path);
    if (!file) return fail(`Arquivo não encontrado em "${args.slug}": ${path}`);

    if (!file.isText) {
      return text(
        `O arquivo "${path}" é binário (${file.mimeType}, ${file.sizeBytes} bytes). ` +
          `Baixe pela URL: ${fileUrlFor(skill.slug, path)}`,
      );
    }

    // O SKILL.md é montado na hora: o frontmatter sai dos metadados da skill.
    const content = file.buffer.toString('utf8');
    return text(isSkillMd(path) ? composeSkillMd(skill, content) : content);
  },

  /** Devolve a URL de download; o zip é gerado pelo site quando ela é seguida. */
  async download_skill(args: { slug: string }): Promise<ToolResult> {
    const skill = await getSkillSummary(args.slug, { includePrivate: false });
    if (!skill) return fail(`Skill não encontrada: "${args.slug}"`);

    return asJson({
      slug: skill.slug,
      name: skill.name,
      downloadUrl: downloadUrlFor(skill.slug),
      format: 'zip',
      files: skill.fileCount,
      hint: 'Baixe com: curl -L -o skill.zip "<downloadUrl>"',
    });
  },

  async list_tags(): Promise<ToolResult> {
    const tags = await listTags({ includePrivate: false });
    if (tags.length === 0) return text('Nenhuma tag cadastrada.');
    return asJson({ tags });
  },
};
