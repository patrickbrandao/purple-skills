import {
  AppError,
  createSkill,
  deleteFile,
  deleteSkill,
  getSkillDetail,
  getVirtualMcp,
  listSkills,
  listTags,
  readFile,
  removeSkillGrant,
  setFile,
  setFiles,
  setSkillGrant,
  stats,
  updateSkill,
} from '@purple-skills/db';
import {
  ACCESS_LABEL,
  SKILL_MD,
  ZipError,
  canCreate,
  canManage,
  composeSkillMd,
  extractZip,
  isSkillMd,
  normalizeRelativePath,
  isAccessScope,
  readIntEnv,
  stripFrontmatter,
  type AccessLevel,
  type SkillSummary,
} from '@purple-skills/shared';
import { accountByEmail, assertAccess, levelFrom, loadSkill, viewerOf } from './access.js';
import { TOKEN_CALLER, type Caller } from './auth.js';
import { config } from './config.js';

/** Teto do payload base64 do `set_files_bulk` (~32 MB codificados). */
const MAX_ZIP_BASE64_CHARS = readIntEnv('MCP_MAX_ZIP_BASE64', 32 * 1024 * 1024, { min: 1024 });

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

/** A página no site existe quando a skill está ligada e em algum vMCP aberto e ligado. */
const pageUrl = (skill: SkillSummary): string | undefined =>
  skill.isActive && skill.mcps.some((mcp) => mcp.isOpen && mcp.isActive)
    ? `${config.siteBaseUrl}/skills/${skill.slug}`
    : undefined;

/**
 * Os vínculos de uma skill, como as tools os mostram. `direct: false` é um
 * vMCP alcançado só por catálogo (`viaCatalogs`), com as portas do catálogo —
 * o vínculo direto, quando existe, sobrescreve (`docs/11-catalogos.md` §3.2).
 */
const mcpsOf = (skill: SkillSummary) =>
  skill.mcps.map((mcp) => ({
    slug: mcp.slug,
    name: mcp.name,
    isOpen: mcp.isOpen,
    isActive: mcp.isActive,
    isDefault: mcp.isDefault,
    asSkill: mcp.asSkill,
    asPrompt: mcp.asPrompt,
    asResource: mcp.asResource,
    direct: mcp.direct,
    viaCatalogs: mcp.catalogs.map((catalog) => catalog.slug),
  }));

/** Os catálogos de que a skill participa: o catálogo e a participação, ligados ou não. */
const catalogsOf = (skill: SkillSummary) =>
  skill.catalogs.map((catalog) => ({
    slug: catalog.slug,
    name: catalog.name,
    isActive: catalog.isActive,
    memberActive: catalog.memberActive,
  }));

/** Entrada de `create_skill.mcps`: o vMCP pelo slug e as três portas. */
type McpLinkArg = { slug: string; asSkill: boolean; asPrompt: boolean; asResource: boolean };

/** O que a tool mostra do acesso: o dono, se é pública e o que a credencial pode. */
const accessOf = (skill: SkillSummary) => ({
  owner: skill.ownerEmail,
  isPublic: skill.isPublic,
  access: skill.access,
});

/**
 * Handlers das ferramentas administrativas, testáveis sem transporte HTTP.
 *
 * São criados **por chamador**: o papel decide se ele cria, o acesso por
 * objeto (`docs/12-acesso-granular.md`) decide o resto, e o ator vai junto
 * para o `audit_log`. Uma chave de `membro` vê o que é seu, o que lhe foi
 * concedido e o que é público, e administra o que é seu.
 */
export function createHandlers(caller: Caller = TOKEN_CALLER) {
  const actor = caller.actor;
  const viewer = viewerOf(caller);

  /** `null` quando pode criar; um `ToolResult` de recusa quando não. */
  const denyCreate = (): ToolResult | null =>
    canCreate(caller.role)
      ? null
      : fail(
          `Criar skill exige papel "editor" ou "admin"; sua credencial é "${caller.role}". ` +
            'Um membro edita o que é seu ou lhe foi concedido, mas não cria.',
        );

  /** A skill com o nível mínimo da ação; 404 se a credencial não a vê. */
  const skillWith = (slug: string, minimum: AccessLevel | 'owner') => loadSkill(caller, slug, minimum);

  /**
   * Resolve a lista "publicar em" de `create_skill`: cada vMCP pelo slug, com
   * a mesma permissão de `set_virtual_mcp_skills` — `edit` no servidor. Um
   * que a credencial não edite recusa a criação inteira.
   */
  async function resolveLinks(entries: McpLinkArg[] | undefined) {
    const links = [];
    for (const entry of entries ?? []) {
      const mcp = await getVirtualMcp(entry.slug, { viewer });
      if (!mcp) throw new AppError(`MCP virtual não encontrado: "${entry.slug}"`, 404, 'not_found');
      assertAccess(mcp.access, 'edit', 'MCP virtual');
      if (!entry.asSkill && !entry.asPrompt && !entry.asResource) {
        throw new AppError(
          `"${entry.slug}": escolha ao menos uma superfície (asSkill, asPrompt ou asResource)`,
          400,
          'bad_request',
        );
      }
      links.push({
        virtualMcpUuid: mcp.uuid,
        asSkill: entry.asSkill,
        asPrompt: entry.asPrompt,
        asResource: entry.asResource,
      });
    }
    return links;
  }

  return {
    async list_skills(args: {
      query?: string;
      tag?: string;
      limit?: number;
      offset?: number;
      scope?: string;
    }): Promise<ToolResult> {
      const result = await listSkills({
        query: args.query ?? null,
        tag: args.tag ?? null,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
        // O que a credencial enxerga, inclusive as flutuantes e desligadas:
        // é o painel do agente (`docs/12` §3.1).
        viewer,
        ...(isAccessScope(args.scope) ? { scope: args.scope } : {}),
        sort: args.query ? undefined : 'recent',
      });

      return asJson({
        total: result.total,
        // O teto real de `limit` é aplicado na query; devolvê-lo evita que o
        // agente calcule a paginação com um valor que não foi o usado.
        limit: result.limit,
        offset: result.offset,
        skills: result.items.map((skill) => ({
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          isActive: skill.isActive,
          ...accessOf(skill),
          mcps: mcpsOf(skill),
          catalogs: catalogsOf(skill),
          tags: skill.tags,
          files: skill.fileCount,
          views: skill.viewCount,
          downloads: skill.downloadCount,
          updatedAt: skill.updatedAt,
        })),
      });
    },

    async get_skill(args: { slug: string }): Promise<ToolResult> {
      const detail = await getSkillDetail(args.slug, { viewer });
      if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

      return asJson({
        slug: detail.slug,
        name: detail.name,
        description: detail.description,
        isActive: detail.isActive,
        ...accessOf(detail),
        // A lista de concessões só para quem as administra (decisão 11).
        grants: canManage(detail.access)
          ? detail.grants.map((grant) => ({ email: grant.email, name: grant.name, level: grant.level }))
          : undefined,
        mcps: mcpsOf(detail),
        catalogs: catalogsOf(detail),
        tags: detail.tags,
        views: detail.viewCount,
        downloads: detail.downloadCount,
        url: pageUrl(detail),
        files: detail.files.map((file) => ({
          path: file.relativePath,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          isText: file.isText,
        })),
        // Os metadados estão nos campos acima; aqui vai só o corpo do prompt.
        skillMd: stripFrontmatter(detail.skillMd),
      });
    },

    async get_file(args: { slug: string; path: string }): Promise<ToolResult> {
      const detail = await getSkillDetail(args.slug, { viewer });
      if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

      const path = normalizeRelativePath(args.path);
      if (!path) return fail(`Caminho inválido: "${args.path}"`);

      const file = await readFile(detail.uuid, path);
      if (!file) return fail(`Arquivo não encontrado em "${args.slug}": ${path}`);
      if (!file.isText) {
        return fail(`"${path}" é binário (${file.mimeType}, ${file.sizeBytes} bytes) e não pode ser lido como texto.`);
      }

      // O SKILL.md é montado na hora: o frontmatter sai dos metadados da skill.
      const content = file.buffer.toString('utf8');
      return text(isSkillMd(path) ? composeSkillMd(detail, content) : content);
    },

    async create_skill(args: {
      name: string;
      description?: string;
      icon?: string;
      skill_md_content: string;
      tags?: string[];
      slug?: string;
      mcps?: McpLinkArg[];
      is_public?: boolean;
    }): Promise<ToolResult> {
      const denied = denyCreate();
      if (denied) return denied;

      const detail = await createSkill(
        {
          name: args.name,
          slug: args.slug,
          description: args.description,
          icon: args.icon,
          isPublic: args.is_public === true,
          // Os metadados vêm dos campos; um frontmatter no corpo é descartado.
          skillMd: stripFrontmatter(args.skill_md_content),
          tags: args.tags,
          mcps: await resolveLinks(args.mcps),
        },
        SOURCE,
        actor,
      );

      const onde =
        detail.mcps.length > 0
          ? `publicada em ${detail.mcps.map((mcp) => mcp.slug).join(', ')}`
          : 'sem vínculo — use link_skill para publicá-la em um MCP virtual';
      const page = pageUrl(detail);
      return text(`Skill criada: "${detail.name}" (slug: ${detail.slug}, ${onde}).${page ? `\n${page}` : ''}`);
    },

    async edit_skill(args: {
      slug: string;
      name?: string;
      description?: string;
      icon?: string;
      tags?: string[];
      new_slug?: string;
      is_active?: boolean;
      is_public?: boolean;
    }): Promise<ToolResult> {
      // Nome, descrição, ícone e tags são `edit`; slug, estado e público são
      // `manage` (`docs/12` §3.2).
      const touchesProperties =
        args.new_slug !== undefined || args.is_active !== undefined || args.is_public !== undefined;
      const current = await skillWith(args.slug, touchesProperties ? 'manage' : 'edit');

      const detail = await updateSkill(
        current.slug,
        {
          name: args.name,
          description: args.description,
          // Omitido não mexe; vazio limpa. A forma (emoji ou URL) é conferida no banco.
          icon: args.icon === undefined ? undefined : args.icon.trim() || null,
          tags: args.tags,
          slug: args.new_slug,
          isActive: args.is_active,
          isPublic: args.is_public,
        },
        SOURCE,
        actor,
      );

      return text(
        `Skill atualizada: "${detail.name}" (slug: ${detail.slug}${detail.isActive ? '' : ', desligada — não é entregue em servidor nenhum'}${
          detail.isPublic ? ', pública' : ''
        }).`,
      );
    },

    async set_file(args: { slug: string; path: string; content: string }): Promise<ToolResult> {
      await skillWith(args.slug, 'edit');

      // Gravar o SKILL.md não redefine os metadados da skill (isso é
      // edit_skill): o frontmatter enviado é descartado.
      const content = isSkillMd(args.path) ? stripFrontmatter(args.content) : args.content;
      const file = await setFile(args.slug, args.path, content, SOURCE, actor);
      return text(`Arquivo gravado em "${args.slug}": ${file.relativePath} (${file.sizeBytes} bytes).`);
    },

    async set_files_bulk(args: {
      slug: string;
      zip_base64: string;
      replace?: boolean;
    }): Promise<ToolResult> {
      await skillWith(args.slug, 'edit');

      // Recusa antes de decodificar: o único teto até aqui era o limite do corpo
      // JSON (64 MB), e um .zip desse tamanho descomprime para muito mais.
      if (args.zip_base64.length > MAX_ZIP_BASE64_CHARS) {
        return fail(
          `zip_base64 grande demais (limite de ~${Math.round(MAX_ZIP_BASE64_CHARS / (1024 * 1024))} MB codificados).`,
        );
      }

      // `Buffer.from(..., 'base64')` nunca lança: bytes inválidos simplesmente
      // produzem um ZIP ilegível, tratado logo abaixo como erro de formato.
      const buffer = Buffer.from(args.zip_base64, 'base64');

      let extracted: ReturnType<typeof extractZip>;
      try {
        extracted = extractZip(buffer);
      } catch (err) {
        // Limite estourado ou arquivo ilegível são erros do payload enviado pelo
        // agente, não falhas do servidor: devolvemos a mensagem para ele corrigir.
        if (err instanceof ZipError) return fail(err.message);
        throw err;
      }
      if (extracted.length === 0) return fail('O .zip não contém nenhum arquivo aproveitável.');

      const files = await setFiles(
        args.slug,
        extracted.map((file) => ({
          relativePath: file.relativePath,
          // Um SKILL.md vindo do .zip entra só com o corpo: os metadados da
          // skill já cadastrada mandam.
          content: isSkillMd(file.relativePath)
            ? Buffer.from(stripFrontmatter(file.textContent ?? ''), 'utf8')
            : (file.binaryContent ?? Buffer.from(file.textContent ?? '', 'utf8')),
        })),
        SOURCE,
        // O zip representa o estado desejado completo da árvore (seção 4 das
        // decisões de arquitetura); passe replace: false para só adicionar.
        { replace: args.replace !== false },
        actor,
      );

      return text(
        `${extracted.length} arquivo(s) importado(s) para "${args.slug}".\n` +
          `Árvore final (${files.length} arquivos):\n` +
          files.map((file) => `- ${file.relativePath}`).join('\n'),
      );
    },

    async delete_file(args: { slug: string; path: string }): Promise<ToolResult> {
      await skillWith(args.slug, 'edit');

      if (isSkillMd(args.path)) {
        return fail(`O arquivo ${SKILL_MD} não pode ser removido — use set_file para sobrescrevê-lo.`);
      }
      await deleteFile(args.slug, args.path, SOURCE, actor);
      return text(`Arquivo removido de "${args.slug}": ${args.path}`);
    },

    async delete_skill(args: { slug: string; confirm: boolean }): Promise<ToolResult> {
      // Apagar é do dono e do admin: nenhum nível de concessão chega lá.
      await skillWith(args.slug, 'owner');

      if (args.confirm !== true) {
        return fail('Passe confirm: true para confirmar a remoção definitiva da skill.');
      }
      await deleteSkill(args.slug, SOURCE, actor);
      return text(`Skill "${args.slug}" removida, junto com todos os seus arquivos.`);
    },

    // ---------------------------------------------------------- acesso ---

    async share_skill(args: { slug: string; email: string; level: string }): Promise<ToolResult> {
      const skill = await skillWith(args.slug, 'manage');
      const target = await accountByEmail(args.email);
      const grant = await setSkillGrant(skill.slug, target.uuid, levelFrom(args.level), SOURCE, actor);
      return text(`${grant.email} agora pode ${ACCESS_LABEL[grant.level]} a skill "${skill.slug}".`);
    },

    async unshare_skill(args: { slug: string; email: string }): Promise<ToolResult> {
      const skill = await skillWith(args.slug, 'manage');
      const target = await accountByEmail(args.email);
      await removeSkillGrant(skill.slug, target.uuid, SOURCE, actor);
      return text(`${target.email} perdeu o acesso à skill "${skill.slug}".`);
    },

    async transfer_skill(args: { slug: string; email: string }): Promise<ToolResult> {
      const skill = await skillWith(args.slug, 'owner');
      const target = await accountByEmail(args.email);
      await updateSkill(skill.slug, { ownerUserUuid: target.uuid }, SOURCE, actor);
      return text(`A skill "${skill.slug}" agora é de ${target.email}.`);
    },

    async list_tags(): Promise<ToolResult> {
      return asJson({ tags: await listTags({ viewer }) });
    },

    async get_stats(): Promise<ToolResult> {
      return asJson(await stats());
    },
  };
}

export type Handlers = ReturnType<typeof createHandlers>;
