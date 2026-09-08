import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  getSkillDetail,
  getSkillSummary,
  incrementViewCount,
  listPublishedSkills,
  listSkills,
  listTags,
  readFile,
} from '@purple-skills/db';
import {
  composeSkillMd,
  isSkillMd,
  normalizeRelativePath,
  stripFrontmatter,
  type SkillDetail,
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
 * O recorte de toda leitura das ferramentas: pública **e** flagada para esta
 * superfície, a primeira das três do MCP público
 * (`docs/07-superficie-de-ferramentas.md` §3.2).
 *
 * Sem `use_as_skill` a skill continua pública no site e na API REST, mas some
 * daqui — inclusive de `list_tags`, cuja contagem não pode somar skill que
 * nenhuma ferramenta mostra.
 *
 * O filtro é da consulta e não daqui: `search_skills` pagina, e um descarte
 * pós-consulta furaria o `total` e a página.
 */
const RECORTE_DAS_FERRAMENTAS = { includePrivate: false, onlyAsSkill: true } as const;

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
      ...RECORTE_DAS_FERRAMENTAS,
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
    const detail = await getSkillDetail(args.slug, RECORTE_DAS_FERRAMENTAS);
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
    const skill = await getSkillSummary(args.slug, RECORTE_DAS_FERRAMENTAS);
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
    const skill = await getSkillSummary(args.slug, RECORTE_DAS_FERRAMENTAS);
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
    const tags = await listTags(RECORTE_DAS_FERRAMENTAS);
    if (tags.length === 0) return text('Nenhuma tag cadastrada.');
    return asJson({ tags });
  },
};

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
 * A skill pública flagada para a superfície, ou nada.
 *
 * Sem `onlyAsSkill` de propósito: as três superfícies são independentes, e uma
 * skill publicada **só** como prompt ou resource — `use_as_skill` desligada —
 * precisa continuar legível por aqui. O que ela tem em comum com as
 * ferramentas é só `is_public`, conferida na consulta.
 */
async function skillPublicada(
  slug: string,
  flag: 'useAsPrompt' | 'useAsResource',
): Promise<SkillDetail | null> {
  const detail = await getSkillDetail(slug, { includePrivate: false });
  return detail?.[flag] ? detail : null;
}

/**
 * As duas superfícies em que uma skill pública flagada é oferecida além das
 * ferramentas: *prompt* (pelo slug) e *resource* (`skill://<slug>`). Nenhuma
 * delas depende de `use_as_skill`: uma skill pode viver só aqui.
 *
 * As listas saem do banco a **cada requisição**. Não há `listChanged` para
 * avisar o cliente, então uma skill publicada agora precisa aparecer na
 * listagem seguinte, mesmo numa sessão aberta antes dela existir.
 */
export const surfaces = {
  async listPrompts() {
    const skills = await listPublishedSkills('prompt');

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
    const detail = await skillPublicada(name, 'useAsPrompt');
    if (!detail) throw naoEncontrado(`Prompt não encontrado: "${name}"`);

    await incrementViewCount(detail.uuid);

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
    const skills = await listPublishedSkills('resource');

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
    const detail = slug ? await skillPublicada(slug, 'useAsResource') : null;
    if (!detail) throw naoEncontrado(`Resource não encontrado: "${uri}"`);

    await incrementViewCount(detail.uuid);

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
