import { randomUUID } from 'node:crypto';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  AppError,
  getSkillDetail,
  getSkillSummary,
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
  readIntEnv,
  stripFrontmatter,
  type SkillDetail,
  type SkillSummary,
} from '@purple-skills/shared';
import { logDaBusca } from '@purple-skills/rag';
import { config } from './config.js';
import { buscaSemantica } from './rag.js';
import { registrarAcesso, type AccessContext } from './access.js';

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
 * Loga o detalhe de uma falha imprevista e devolve a mensagem que vai ao
 * cliente, com a **mesma** referência curta nos dois lados.
 *
 * A mensagem de uma exceção não prevista é escrita para quem opera, não para
 * quem chama: a do `pg` cita tabela, índice e constraint. Aqui quem lê é um
 * agente de IA — anônimo por padrão, neste servidor — que pode repetir o texto
 * num resumo, num log ou numa issue pública. Então vale a política do
 * `http.ts`: resposta genérica, detalhe no log, e a referência para o operador
 * casar a reclamação do agente com a linha do log sem expor nada.
 */
function erroInterno(err: unknown): string {
  const ref = randomUUID().slice(0, 8);
  console.error(`[mcp-public] erro inesperado (ref ${ref}):`, err);
  return (
    `Erro interno do servidor (ref ${ref}). Tente de novo; se persistir, passe esta ` +
    'referência a quem opera a instalação — o detalhe está no log do servidor.'
  );
}

/**
 * Embrulha o handler de uma tool. Toda tool é registrada por ele (`server.ts`):
 * sem isso a exceção sobe ao `McpServer`, que monta o `isError` com a `message`
 * crua — é o mesmo defeito que o `guard` do mcp-admin fechou.
 *
 * Nada de útil é engolido. `AppError` é erro de negócio — 400, 403, 404, 409 —
 * escrito para o agente ler, e continua chegando com a mensagem inteira (o
 * `badRequest` do `semanticScope` chega por aqui). As recusas das próprias
 * ferramentas — skill fora do vínculo, caminho inválido, arquivo ausente — já
 * são `fail` dentro do handler, e não exceção; a validação dos argumentos é do
 * Zod e acontece no SDK, antes daqui; e a perna semântica nunca lança, por
 * desenho (`rag.ts`).
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AppError) return fail(err.message);
    return fail(erroInterno(err));
  }
}

/**
 * O mesmo cuidado nas superfícies de prompt e resource, que respondem com erro
 * de protocolo em vez de resultado: o SDK monta o erro do JSON-RPC com a
 * `message` da exceção, então uma falha do banco vazaria pelo mesmo caminho.
 *
 * `McpError` é a recusa escrita para o cliente (`naoEncontrado`) e passa
 * inteira; `AppError` vira `InvalidParams`, que é o que o cliente pode
 * corrigir.
 */
export async function guardSurface<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof McpError) throw err;
    if (err instanceof AppError) throw new McpError(ErrorCode.InvalidParams, err.message);
    throw new McpError(ErrorCode.InternalError, erroInterno(err));
  }
}

/**
 * O MCP virtual em que as ferramentas estão rodando.
 *
 * Sempre há um: a raiz (`/mcp`) é o vMCP padrão da instalação, e
 * `/virtual/<slug>` é qualquer outro (`docs/09-mcp-padrao-e-skills-flutuantes.md`).
 * Toda leitura é recortada pelo vínculo `virtual_mcp_skills` — que traz skill
 * privada — e os downloads apontam para o próprio servidor, sob o caminho por
 * onde ele foi chamado (`docs/08-mcp-virtual.md` §3, §4).
 */
export type VirtualScope = {
  mcp: VirtualMcpRuntime;
  /** Base pública deste ponto de montagem: `<origem>` na raiz, `<origem>/virtual/<slug>` nos demais, sem barra final. */
  baseUrl: string;
  /** Quem está lendo, para o registro de acessos; ausente nos testes e conta como "aberto". */
  access?: AccessContext;
};

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * O site mostra a skill quando ela está ligada **e** é pública, ou está em vMCP
 * aberto e ligado, ou participa de catálogo público e ligado
 * (`docs/12-acesso-granular.md` §7 — revoga a regra do `09` §4.1, que era só o
 * vínculo aberto, de quando `is_public` não existia). Aqui `is_active` é dado:
 * o recorte do vínculo já exige a skill ligada.
 *
 * O terceiro ramo fica sem sinal: nesta visibilidade o `catalogs` da skill vem
 * vazio, e o `catalogs` de cada vMCP diz por qual catálogo ela chega ao
 * servidor, não se esse catálogo é público. Enquanto o banco não expuser um
 * `onSite` derivado de `OPEN_EXPOSURE`, essa skill segue sem link — errar para
 * menos (link ausente) é melhor que errar para mais (link para um 404).
 */
const noSite = (skill: SkillSummary) =>
  skill.isPublic || skill.mcps.some((mcp) => mcp.isOpen && mcp.isActive);

/**
 * As URLs que as ferramentas devolvem.
 *
 * Download e arquivo apontam para o mcp-public, que os serve com a mesma
 * credencial do MCP — uma skill que só existe em vMCP fechado não está no
 * site. A página é do site, e só quando a skill está lá.
 */
function urlsFor(scope: VirtualScope) {
  const base = scope.baseUrl;
  return {
    page: (skill: SkillSummary): string | undefined =>
      noSite(skill) ? `${config.siteBaseUrl}/skills/${skill.slug}` : undefined,
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
 * O recorte de toda leitura das ferramentas: o vínculo com `as_skill`, e nada
 * mais — nem `is_public`, nem qualquer flag da skill (`08` §3.2).
 *
 * O filtro é da consulta e não daqui: `search_skills` pagina, e um descarte
 * pós-consulta furaria o `total` e a página; a contagem de `list_tags` não
 * pode somar skill que nenhuma ferramenta mostra.
 */
const recorteDasFerramentas = (scope: VirtualScope) =>
  ({ virtualMcp: { uuid: scope.mcp.uuid, surface: 'skill' } }) as const;

/**
 * O teto da consulta de busca, em caracteres. É o mesmo do `normalizeQuery` do
 * `@purple-skills/db`, que corta a perna textual; enquanto o `db` não exportar
 * o número, ele vive aqui e em `apps/site/src/api.ts`.
 */
const MAX_QUERY_CHARS = 200;

/**
 * A consulta como as **duas** pernas da busca vão lê-la.
 *
 * `listSkills` já cortava em 200 caracteres, mas o embedding era resolvido
 * antes, com o texto cru: a perna vetorial embutia uma pergunta que a textual
 * nunca leu, e quem escolhia o tamanho do que ia ao provedor — pago, e que no
 * nível gratuito do Google é lido por revisores humanos — era o visitante
 * anônimo. Normalizar aqui, uma vez, resolve as duas coisas.
 *
 * Conta caractere e não byte, pelo mesmo motivo de ser um número só: contar
 * byte encurtaria a consulta a cada acento, e uma frase em português perderia
 * palavras que a mesma frase em inglês manteria.
 *
 * E corta na fronteira de palavra: termo partido é pior que termo ausente —
 * `websearch_to_tsquery` junta os termos com AND, então uma palavra que ninguém
 * escreveu zera a perna textual, além de embutir no vetor um pedaço de palavra.
 */
function consultaDaBusca(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const texto = raw.trim();
  if (texto === '') return null;
  if (texto.length <= MAX_QUERY_CHARS) return texto;

  // O caractere a mais revela se o limite cai dentro de uma palavra; `\S*$`
  // tira a palavra partida e o `trimEnd`, o espaço que sobra.
  const naFronteira = texto.slice(0, MAX_QUERY_CHARS + 1).replace(/\S*$/, '').trimEnd();
  if (naFronteira !== '') return naFronteira;

  // Consulta sem espaço nenhum (um blob colado): corta no limite, sem deixar
  // sozinha a metade alta de um par surrogate — ela viraria U+FFFD no JSON do
  // provedor.
  const duro = texto.slice(0, MAX_QUERY_CHARS);
  const ultimo = duro.charCodeAt(duro.length - 1);
  return ultimo >= 0xd800 && ultimo <= 0xdbff ? duro.slice(0, -1) : duro;
}

/**
 * Teto do que `get_skill_file` devolve **dentro** do resultado da ferramenta.
 *
 * O arquivo já chega inteiro do banco, mas devolvê-lo como texto custa outras
 * duas cópias — a string UTF-16 e o JSON-RPC da resposta —, e um arquivo de
 * skill pode ser enorme (`ZIP_MAX_UNCOMPRESSED_BYTES` são 256 MB). Acima do
 * teto a resposta passa a ser a URL de download, exatamente como já acontece com
 * arquivo binário. Quatro MiB de texto são muitas vezes a janela de qualquer
 * agente: o teto não corta leitura útil, corta o pedido que derruba o processo.
 */
const MAX_TEXTO_INLINE_BYTES = readIntEnv('MCP_MAX_FILE_TEXT_BYTES', 4 * 1024 * 1024, {
  min: 1024,
});

/**
 * Handlers das ferramentas do MCP público. Ficam separados do registro no
 * servidor para poderem ser testados sem subir o transporte HTTP, e são
 * criados **por escopo**: cada vMCP — inclusive o padrão, na raiz — tem o seu.
 */
export function createHandlers(scope: VirtualScope) {
  const recorte = recorteDasFerramentas(scope);
  const urls = urlsFor(scope);

  return {
    async search_skills(args: {
      query?: string;
      tag?: string;
      limit?: number;
      offset?: number;
    }): Promise<ToolResult> {
      // Uma normalização só, antes das duas pernas: o vetor e o texto precisam
      // ler a mesma pergunta (ver `consultaDaBusca`).
      const query = consultaDaBusca(args.query);
      // A perna vetorial é resolvida antes da consulta: falha ou prazo estourado
      // devolvem `undefined` e a busca sai textual, sem erro para o cliente.
      const { semantic } = await buscaSemantica.resolver(query);

      const result = await listSkills({
        query,
        tag: args.tag ?? null,
        limit: args.limit ?? 10,
        offset: args.offset ?? 0,
        ...recorte,
        ...(semantic ? { semantic } : {}),
      });

      // As distâncias vão para o log, não para o cliente (§8.1 item 7).
      if (result.mode === 'hybrid') console.log(logDaBusca(result.mode, result.neighbors));

      if (result.items.length === 0) {
        return text(
          // A consulta ecoada é a normalizada: é o que foi procurado, e é
          // assim que o cliente descobre que a dele foi cortada.
          `Nenhuma skill encontrada${query ? ` para "${query}"` : ''}${
            args.tag ? ` na tag "${args.tag}"` : ''
          }.`,
        );
      }

      return asJson({
        mode: result.mode,
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

    /** Retorna o SKILL.md completo. Conta um acesso no vínculo e na skill. */
    async get_skill(args: { slug: string }): Promise<ToolResult> {
      const detail = await getSkillDetail(args.slug, recorte);
      if (!detail) return fail(`Skill não encontrada: "${args.slug}"`);

      registrarAcesso(scope, detail.uuid, 'view', 'tool');

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

      // Texto grande demais para o resultado da ferramenta: a URL de download
      // serve o arquivo em fluxo, sem as cópias que o JSON-RPC exigiria. O
      // tamanho é o dos bytes lidos, não o `sizeBytes` gravado — a lição do
      // `004` é não decidir limite por número declarado.
      if (file.buffer.byteLength > MAX_TEXTO_INLINE_BYTES) {
        return text(
          `O arquivo "${path}" é grande demais para vir no resultado ` +
            `(${file.buffer.byteLength} bytes; o teto é ${MAX_TEXTO_INLINE_BYTES}). ` +
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
 * Mesma recusa para skill fora do vínculo, inexistente e vinculada sem a flag
 * da superfície: distingui-las entregaria slugs a quem sonda um servidor que
 * pode estar aberto.
 */
const naoEncontrado = (mensagem: string) => new McpError(ErrorCode.InvalidParams, mensagem);

/**
 * As duas superfícies em que uma skill é oferecida além das ferramentas:
 * *prompt* (pelo slug) e *resource* (`skill://<slug>`). Quem decide é o
 * vínculo (`as_prompt` / `as_resource`), independente de `as_skill`: uma
 * skill pode viver só aqui.
 *
 * As listas saem do banco a **cada requisição**. Não há `listChanged` para
 * avisar o cliente, então uma skill vinculada agora precisa aparecer na
 * listagem seguinte, mesmo numa sessão aberta antes dela existir.
 */
export function createSurfaces(scope: VirtualScope) {
  const mcpUuid = scope.mcp.uuid;

  /** A skill oferecida na superfície, ou nada — a consulta já filtra pelo vínculo. */
  const skillPublicada = (slug: string, surface: 'prompt' | 'resource'): Promise<SkillDetail | null> =>
    getSkillDetail(slug, { virtualMcp: { uuid: mcpUuid, surface } });

  return {
    async listPrompts() {
      const skills = await listPublishedSkills('prompt', mcpUuid);

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

      registrarAcesso(scope, detail.uuid, 'view', 'prompt');

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
      const skills = await listPublishedSkills('resource', mcpUuid);

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

      registrarAcesso(scope, detail.uuid, 'view', 'resource');

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
     * é legível: só as vinculadas são, e essas já saem uma a uma em
     * `resources/list`.
     */
    listResourceTemplates() {
      return { resourceTemplates: [] };
    },
  };
}
