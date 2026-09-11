import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  getSkillDetail,
  getSkillSummary,
  incrementViewCount,
  listPublishedSkills,
  listSkills,
  listTags,
  readFile,
  type VirtualMcpRuntime,
} from '@purple-skills/db';
import {
  composeSkillMd,
  isSkillMd,
  normalizeRelativePath,
  stripFrontmatter,
  type SkillDetail,
  type SkillSummary,
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

/**
 * O MCP virtual em que as ferramentas estão rodando, quando estão.
 *
 * Ausente, é o MCP principal: leituras com `is_public AND use_as_skill` e URLs
 * do site. Presente, toda leitura passa a ser recortada pelo vínculo
 * `virtual_mcp_skills` — que traz skill privada — e os downloads apontam para
 * o próprio servidor, sob `/virtual/<slug>` (`docs/08-mcp-virtual.md` §3, §4).
 */
export type VirtualScope = {
  mcp: VirtualMcpRuntime;
  /** Base pública deste MCP virtual: `<origem>/virtual/<slug>`, sem barra final. */
  baseUrl: string;
};

export const downloadUrlFor = (slug: string) =>
  `${config.siteBaseUrl}/skills/${encodeURIComponent(slug)}/download`;

export const fileUrlFor = (slug: string, path: string) =>
  `${config.siteBaseUrl}/skills/${encodeURIComponent(slug)}/files/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * As URLs que as ferramentas devolvem, por escopo.
 *
 * No principal, tudo aponta para o site. No virtual, download e arquivo
 * apontam para o mcp-public, que os serve com a mesma chave do MCP — uma
 * skill privada não existe no site. A página continua sendo do site, e só
 * quando a skill é pública.
 */
function urlsFor(scope?: VirtualScope) {
  if (!scope) {
    return {
      page: (skill: SkillSummary): string | undefined => `${config.siteBaseUrl}/skills/${skill.slug}`,
      download: downloadUrlFor,
      file: fileUrlFor,
      downloadHint: 'Baixe com: curl -L -o skill.zip "<downloadUrl>"',
    };
  }

  const base = scope.baseUrl;
  return {
    page: (skill: SkillSummary): string | undefined =>
      skill.isPublic ? `${config.siteBaseUrl}/skills/${skill.slug}` : undefined,
    download: (slug: string) => `${base}/skills/${encodeURIComponent(slug)}/download`,
    file: (slug: string, path: string) =>
      `${base}/skills/${encodeURIComponent(slug)}/files/${encodePath(path)}`,
    downloadHint: scope.mcp.isOpen
      ? 'Baixe com: curl -L -o skill.zip "<downloadUrl>"'
      : 'Baixe com a mesma chave deste MCP: ' +
        'curl -L -H "Authorization: Bearer <chave>" -o skill.zip "<downloadUrl>"',
  };
}

/**
 * O recorte de toda leitura das ferramentas.
 *
 * No principal: pública **e** flagada para esta superfície, a primeira das
 * três do MCP público (`docs/07-superficie-de-ferramentas.md` §3.2). Sem
 * `use_as_skill` a skill continua pública no site e na API REST, mas some
 * daqui — inclusive de `list_tags`, cuja contagem não pode somar skill que
 * nenhuma ferramenta mostra.
 *
 * No virtual: o vínculo com `as_skill`, e nada mais — nem `is_public`, nem
 * as flags da skill (`08` §3.2).
 *
 * O filtro é da consulta e não daqui: `search_skills` pagina, e um descarte
 * pós-consulta furaria o `total` e a página.
 */
const recorteDasFerramentas = (scope?: VirtualScope) =>
  scope
    ? ({ virtualMcp: { uuid: scope.mcp.uuid, surface: 'skill' } } as const)
    : ({ includePrivate: false, onlyAsSkill: true } as const);

/**
 * Handlers das ferramentas do MCP público. Ficam separados do registro no
 * servidor para poderem ser testados sem subir o transporte HTTP, e são
 * criados **por escopo**: o principal e cada MCP virtual têm o seu.
 */
export function createHandlers(scope?: VirtualScope) {
  const recorte = recorteDasFerramentas(scope);
  const urls = urlsFor(scope);
  const mcpUuid = scope?.mcp.uuid;

  return {
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
        ...recorte,
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
          url: urls.page(skill),
        })),
      });
    },

    /** Retorna o SKILL.md completo. Conta um acesso (view_count). */
    async get_skill(args: { slug: string }): Promise<ToolResult> {
      const detail = await getSkillDetail(args.slug, recorte);
      if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

      await incrementViewCount(detail.uuid, mcpUuid);

      const attachments = detail.files.filter(
        (file) => file.relativePath.toLowerCase() !== 'skill.md',
      );
      const page = urls.page(detail);

      const header = [
        `# ${detail.name}`,
        detail.description && `\n${detail.description}`,
        `\nslug: ${detail.slug}`,
        detail.tags.length > 0 && `tags: ${detail.tags.join(', ')}`,
        page && `página: ${page}`,
        `download (zip): ${urls.download(detail.slug)}`,
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
      const skill = await getSkillSummary(args.slug, recorte);
      if (!skill) return fail(`Skill não encontrada: "${args.slug}"`);

      const path = normalizeRelativePath(args.path);
      if (!path) return fail(`Caminho inválido: "${args.path}"`);

      const file = await readFile(skill.uuid, path);
      if (!file) return fail(`Arquivo não encontrado em "${args.slug}": ${path}`);

      if (!file.isText) {
        return text(
          `O arquivo "${path}" é binário (${file.mimeType}, ${file.sizeBytes} bytes). ` +
            `Baixe pela URL: ${urls.file(skill.slug, path)}`,
        );
      }

      // O SKILL.md é montado na hora: o frontmatter sai dos metadados da skill.
      const content = file.buffer.toString('utf8');
      return text(isSkillMd(path) ? composeSkillMd(skill, content) : content);
    },

    /** Devolve a URL de download; o zip é gerado quando ela é seguida. */
    async download_skill(args: { slug: string }): Promise<ToolResult> {
      const skill = await getSkillSummary(args.slug, recorte);
      if (!skill) return fail(`Skill não encontrada: "${args.slug}"`);

      return asJson({
        slug: skill.slug,
        name: skill.name,
        downloadUrl: urls.download(skill.slug),
        format: 'zip',
        files: skill.fileCount,
        hint: urls.downloadHint,
      });
    },

    async list_tags(): Promise<ToolResult> {
      const tags = await listTags(recorte);
      if (tags.length === 0) return text('Nenhuma tag cadastrada.');
      return asJson({ tags });
    },
  };
}

/** Os handlers do MCP principal. */
export const handlers = createHandlers();

export type Handlers = ReturnType<typeof createHandlers>;

// ------------------------------------------- prompts e resources -----------

/**
 * Esquema das URIs de resource. `skill://<slug>` analisa limpo: o slug é o
 * host, o caminho fica vazio e nada é normalizado — por isso o match é um
 * `startsWith` e o resto é o slug, sem `new URL`.
 */
const RESOURCE_SCHEME = 'skill://';

export const resourceUriFor = (slug: string) => `${RESOURCE_SCHEME}${slug}`;

/**
 * Mesma recusa para skill privada, inexistente e pública sem a flag.
 *
 * Distingui-las entregaria os slugs privados a quem sonda um servidor que, por
 * padrão, roda sem autenticação.
 */
const naoEncontrado = (mensagem: string) => new McpError(ErrorCode.InvalidParams, mensagem);

/**
 * As duas superfícies em que uma skill é oferecida além das ferramentas:
 * *prompt* (pelo slug) e *resource* (`skill://<slug>`).
 *
 * No principal, nenhuma delas depende de `use_as_skill`: uma skill pode viver
 * só aqui. No virtual, quem decide é o vínculo (`as_prompt` / `as_resource`).
 *
 * As listas saem do banco a **cada requisição**. Não há `listChanged` para
 * avisar o cliente, então uma skill publicada agora precisa aparecer na
 * listagem seguinte, mesmo numa sessão aberta antes dela existir.
 */
export function createSurfaces(scope?: VirtualScope) {
  const mcpUuid = scope?.mcp.uuid;
  const listOptions = mcpUuid ? { virtualMcpUuid: mcpUuid } : undefined;

  /**
   * A skill oferecida na superfície, ou nada.
   *
   * No principal: pública e flagada — sem `onlyAsSkill` de propósito, porque
   * uma skill publicada **só** como prompt ou resource precisa continuar
   * legível por aqui. O que ela tem em comum com as ferramentas é só
   * `is_public`, conferida na consulta. No virtual, a consulta já filtra pelo
   * vínculo com a flag da superfície.
   */
  async function skillPublicada(
    slug: string,
    surface: 'prompt' | 'resource',
  ): Promise<SkillDetail | null> {
    if (mcpUuid) return getSkillDetail(slug, { virtualMcp: { uuid: mcpUuid, surface } });

    const detail = await getSkillDetail(slug, { includePrivate: false });
    const flag = surface === 'prompt' ? detail?.useAsPrompt : detail?.useAsResource;
    return flag ? detail! : null;
  }

  return {
    async listPrompts() {
      const skills = await listPublishedSkills('prompt', listOptions);

      return {
        prompts: skills.map((skill) => ({
          // O slug já é o nome oficial da skill e já é validado como `a-z0-9-`,
          // que é a forma de que um nome de prompt precisa. Prefixar seria
          // redundante: os clientes qualificam os prompts pelo nome do servidor.
          name: skill.slug,
          title: skill.name,
          // A coluna é `NOT NULL DEFAULT ''`: skill sem descrição vira campo
          // ausente, não uma descrição vazia.
          description: skill.description || undefined,
        })),
      };
    },

    /**
     * O corpo do SKILL.md como uma única mensagem do usuário. Conta um acesso.
     *
     * Sem frontmatter: nome e descrição já viajam nos metadados do
     * `prompts/list`, e repeti-los no texto é ruído que o modelo lê como
     * instrução. Sem argumentos: uma skill é instrução estática.
     */
    async getPrompt(name: string) {
      const detail = await skillPublicada(name, 'prompt');
      if (!detail) throw naoEncontrado(`Prompt não encontrado: "${name}"`);

      await incrementViewCount(detail.uuid, mcpUuid);

      return {
        description: detail.description || undefined,
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: stripFrontmatter(detail.skillMd) },
          },
        ],
      };
    },

    async listResources() {
      const skills = await listPublishedSkills('resource', listOptions);

      return {
        resources: skills.map((skill) => ({
          uri: resourceUriFor(skill.slug),
          name: skill.slug,
          title: skill.name,
          description: skill.description || undefined,
          mimeType: 'text/markdown',
        })),
      };
    },

    /**
     * O SKILL.md canônico — o mesmo byte a byte que o `.zip` e o
     * `/files/SKILL.md` entregam, com o frontmatter gerado dos metadados. Conta
     * um acesso.
     */
    async readResource(uri: string) {
      const slug = uri.startsWith(RESOURCE_SCHEME) ? uri.slice(RESOURCE_SCHEME.length) : '';
      const detail = slug ? await skillPublicada(slug, 'resource') : null;
      if (!detail) throw naoEncontrado(`Resource não encontrado: "${uri}"`);

      await incrementViewCount(detail.uuid, mcpUuid);

      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: composeSkillMd(detail, detail.skillMd),
          },
        ],
      };
    },

    /**
     * Vazia de propósito. Responde ao método — nada de *method not found* para o
     * cliente que sonda na inicialização — sem anunciar que `skill://` qualquer
     * é legível: só as flagadas são, e essas já saem uma a uma em
     * `resources/list`.
     */
    listResourceTemplates() {
      return { resourceTemplates: [] };
    },
  };
}

/** As superfícies do MCP principal. */
export const surfaces = createSurfaces();
