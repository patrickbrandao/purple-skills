import {
  AppError,
  createSkill,
  deleteFile,
  deleteSkill,
  getSkillDetail,
  listSkills,
  listTags,
  readFile,
  setFile,
  setFiles,
  setVisibility,
  stats,
  updateSkill,
} from '@purple-skills/db';
import { SKILL_MD, extractZip, isSkillMd, normalizeRelativePath } from '@purple-skills/shared';
import { config } from './config.js';

const SOURCE = 'mcp-admin' as const;

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const asJson = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * Converte erros de domínio em resultados `isError` (o agente consegue ler a
 * mensagem e corrigir a chamada) e deixa falhas inesperadas propagarem.
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AppError) return fail(err.message);
    console.error('[mcp-admin] erro inesperado:', err);
    return fail(`Erro inesperado: ${(err as Error).message}`);
  }
}

const pageUrl = (slug: string) => `${config.siteBaseUrl}/skills/${slug}`;

/** Handlers das ferramentas administrativas, testáveis sem transporte HTTP. */
export const handlers = {
  async list_skills(args: {
    includePrivate?: boolean;
    query?: string;
    tag?: string;
    limit?: number;
    offset?: number;
  }): Promise<ToolResult> {
    const result = await listSkills({
      query: args.query ?? null,
      tag: args.tag ?? null,
      limit: args.limit ?? 50,
      offset: args.offset ?? 0,
      includePrivate: args.includePrivate !== false,
      sort: args.query ? undefined : 'recent',
    });

    return asJson({
      total: result.total,
      skills: result.items.map((skill) => ({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        visibility: skill.isPublic ? 'public' : 'private',
        tags: skill.tags,
        files: skill.fileCount,
        views: skill.viewCount,
        downloads: skill.downloadCount,
        updatedAt: skill.updatedAt,
      })),
    });
  },

  async get_skill(args: { slug: string }): Promise<ToolResult> {
    const detail = await getSkillDetail(args.slug, { includePrivate: true });
    if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

    return asJson({
      slug: detail.slug,
      name: detail.name,
      description: detail.description,
      visibility: detail.isPublic ? 'public' : 'private',
      tags: detail.tags,
      views: detail.viewCount,
      downloads: detail.downloadCount,
      url: pageUrl(detail.slug),
      files: detail.files.map((file) => ({
        path: file.relativePath,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        isText: file.isText,
      })),
      skillMd: detail.skillMd,
    });
  },

  async get_file(args: { slug: string; path: string }): Promise<ToolResult> {
    const detail = await getSkillDetail(args.slug, { includePrivate: true });
    if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

    const path = normalizeRelativePath(args.path);
    if (!path) return fail(`Caminho inválido: "${args.path}"`);

    const file = await readFile(detail.uuid, path);
    if (!file) return fail(`Arquivo não encontrado em "${args.slug}": ${path}`);
    if (!file.isText) {
      return fail(`"${path}" é binário (${file.mimeType}, ${file.sizeBytes} bytes) e não pode ser lido como texto.`);
    }

    return text(file.buffer.toString('utf8'));
  },

  async create_skill(args: {
    name: string;
    description?: string;
    skill_md_content: string;
    tags?: string[];
    slug?: string;
    is_public?: boolean;
  }): Promise<ToolResult> {
    const detail = await createSkill(
      {
        name: args.name,
        slug: args.slug,
        description: args.description,
        skillMd: args.skill_md_content,
        tags: args.tags,
        isPublic: args.is_public === true,
      },
      SOURCE,
    );

    return text(
      `Skill criada: "${detail.name}" (slug: ${detail.slug}, ${
        detail.isPublic ? 'pública' : 'privada'
      }).\n${pageUrl(detail.slug)}`,
    );
  },

  async edit_skill(args: {
    slug: string;
    name?: string;
    description?: string;
    tags?: string[];
    new_slug?: string;
  }): Promise<ToolResult> {
    const detail = await updateSkill(
      args.slug,
      {
        name: args.name,
        description: args.description,
        tags: args.tags,
        slug: args.new_slug,
      },
      SOURCE,
    );

    return text(`Skill atualizada: "${detail.name}" (slug: ${detail.slug}).`);
  },

  async set_visibility(args: { slug: string; visibility: 'public' | 'private' }): Promise<ToolResult> {
    const summary = await setVisibility(args.slug, args.visibility === 'public', SOURCE);
    return text(`"${summary.name}" agora é ${summary.isPublic ? 'pública' : 'privada'}.`);
  },

  async set_file(args: { slug: string; path: string; content: string }): Promise<ToolResult> {
    const file = await setFile(args.slug, args.path, args.content, SOURCE);
    return text(`Arquivo gravado em "${args.slug}": ${file.relativePath} (${file.sizeBytes} bytes).`);
  },

  async set_files_bulk(args: {
    slug: string;
    zip_base64: string;
    replace?: boolean;
  }): Promise<ToolResult> {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(args.zip_base64, 'base64');
    } catch {
      return fail('zip_base64 não é um base64 válido.');
    }

    const extracted = extractZip(buffer);
    if (extracted.length === 0) return fail('O .zip está vazio ou não pôde ser lido.');

    const files = await setFiles(
      args.slug,
      extracted.map((file) => ({
        relativePath: file.relativePath,
        content: file.binaryContent ?? Buffer.from(file.textContent ?? '', 'utf8'),
      })),
      SOURCE,
      // O zip representa o estado desejado completo da árvore (seção 4 das
      // decisões de arquitetura); passe replace: false para só adicionar.
      { replace: args.replace !== false },
    );

    return text(
      `${extracted.length} arquivo(s) importado(s) para "${args.slug}".\n` +
        `Árvore final (${files.length} arquivos):\n` +
        files.map((file) => `- ${file.relativePath}`).join('\n'),
    );
  },

  async delete_file(args: { slug: string; path: string }): Promise<ToolResult> {
    if (isSkillMd(args.path)) {
      return fail(`O arquivo ${SKILL_MD} não pode ser removido — use set_file para sobrescrevê-lo.`);
    }
    await deleteFile(args.slug, args.path, SOURCE);
    return text(`Arquivo removido de "${args.slug}": ${args.path}`);
  },

  async delete_skill(args: { slug: string; confirm: boolean }): Promise<ToolResult> {
    if (args.confirm !== true) {
      return fail('Passe confirm: true para confirmar a remoção definitiva da skill.');
    }
    await deleteSkill(args.slug, SOURCE);
    return text(`Skill "${args.slug}" removida, junto com todos os seus arquivos.`);
  },

  async list_tags(): Promise<ToolResult> {
    return asJson({ tags: await listTags({ includePrivate: true }) });
  },

  async get_stats(): Promise<ToolResult> {
    return asJson(await stats());
  },
};
