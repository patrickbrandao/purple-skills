import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SEARCH_QUERY_MAX_LENGTH } from '@purple-skills/db';
import { config } from './config.js';
import { createHandlers, createSurfaces, guard, guardSurface, type VirtualScope } from './tools.js';

const FLUXO = `Recommended flow:
1. search_skills("describe the task") to discover relevant skills — the search
   understands natural language, not just words that appear in the text.
2. get_skill("<slug>") to read the full SKILL.md of the chosen skill.
3. get_skill_file("<slug>", "<path>") to read auxiliary files.
4. download_skill("<slug>") when the user wants the .zip package.

This server also declares the MCP skills extension
(io.modelcontextprotocol/skills): a host that supports it should prefer
skills/list, which returns each skill's frontmatter and the digest of every one
of its files, and read those files with resources/read at
skill://<slug>/SKILL.md and skill://<slug>/<path>. The tools above stay
available for hosts that do not.

Some skills are also published as a prompt — under their own slug — and as a
resource, at the URI skill://<slug>/SKILL.md. The tools above do not say which
ones: prompts/list and resources/list do. The surfaces are independent, so a
skill may be published only as a prompt or only as a resource and never show up
in search_skills or skills/list — check the listings before concluding that a
skill does not exist here.`;

/**
 * As instruções de um vMCP: o fluxo, mais o que o dono escreveu na descrição
 * — é por ela que ele contextualiza o agente ("skills do projeto X") sem um
 * campo de instruções à parte (`08`, decisão 15). O mesmo texto vale na raiz,
 * que é o vMCP padrão: não há mais um "catálogo completo" em outro lugar.
 */
const instrucoes = (scope: VirtualScope) =>
  `MCP server "${scope.mcp.name}" — a catalog of skills (reusable instructions)
for AI agents, served by Purple Skills. The skills here were chosen by whoever
administers this server.

${FLUXO}

Downloads (download_skill and binary files) point to this same server and accept
the same credential used to connect.${
    scope.mcp.description ? `\n\nAbout this server:\n${scope.mcp.description}` : ''
  }`;

/**
 * Cria uma instância do servidor MCP de um vMCP, com as ferramentas e as
 * superfícies registradas.
 *
 * O nome do servidor é sufixado pelo slug em qualquer ponto de montagem —
 * inclusive na raiz — para o cliente que conecta a vários vMCPs distingui-los
 * no `serverInfo`.
 */
export function createMcpServer(scope: VirtualScope): McpServer {
  const server = new McpServer(
    { name: `${config.serverName}-${scope.mcp.slug}`, version: config.version },
    { instructions: instrucoes(scope) },
  );

  // O registro de acessos quer saber que cliente leu e em que sessão: os
  // dois só existem depois do `initialize`, por isso chegam como getters.
  const scoped: VirtualScope = scope.access
    ? {
        ...scope,
        access: {
          ...scope.access,
          client: () => server.server.getClientVersion(),
          transportSessionId: () => server.server.transport?.sessionId,
        },
      }
    : scope;
  const handlers = createHandlers(scoped);
  const surfaces = createSurfaces(scoped);

  registrarSuperficies(server, surfaces);

  server.registerTool(
    'search_skills',
    {
      title: 'Search skills',
      // A exclusão com hífen é só da perna textual: a vetorial filtra por
      // visibilidade e tag, não por texto, e sem corte por distância devolve a
      // skill excluída entre os vizinhos (relatório 062 da auditoria de
      // 2026-09-19; `docs/14-rag.md` §12). A frase antiga — "continuam valendo"
      // — prometia a um agente, que age sobre o que lê, o que a híbrida não
      // cumpre. O `mode` da resposta é como ele sabe em qual caso está.
      description:
        'Searches the skills of this server by meaning and by text. Describe the task in ' +
        'natural language, in any language. Quoted terms and exclusion with a hyphen apply to ' +
        'the text search; when the response comes with mode "hybrid", the meaning search also ' +
        'ran and may bring back a skill that the hyphen excluded. Returns the slugs to use in ' +
        'get_skill.',
      inputSchema: {
        // Sem `.max()`: passar do teto não é erro, é corte (`consultaDaBusca`,
        // em tools.ts). Recusar a chamada deixaria sem resposta justamente quem
        // descreveu a tarefa com folga — o que esta ferramenta pede — e o corte
        // já protege o provedor. O teto vai na descrição para o cliente saber, e
        // sai da mesma constante que o aplica: número escrito aqui à mão era a
        // quarta cópia dele (relatório 037).
        query: z
          .string()
          .describe(
            'The task in natural language, or terms. Empty lists the most accessed ones. ' +
              `Above ${SEARCH_QUERY_MAX_LENGTH} characters the query is cut at the last whole word: ` +
              'describe the task, do not paste the file.',
          )
          .optional(),
        tag: z.string().describe('Filters by an exact tag.').optional(),
        limit: z.number().int().min(1).max(50).describe('Maximum number of results (default 10).').optional(),
        // Sem `.max()` também aqui, e de propósito: `1e20` passa pelo `.int()`
        // (`Number.isInteger` não exige inteiro seguro), mas quem tem o teto é o
        // banco — `pageOffset` satura em `MAX_SAFE_INTEGER` e a resposta é a
        // página vazia de quem paginou além do fim (relatório 086). Um `maximum`
        // no schema só trocaria essa página por um erro de validação.
        offset: z.number().int().min(0).describe('Offset for pagination.').optional(),
      },
    },
    (args) => guard(() => handlers.search_skills(args)),
  );

  server.registerTool(
    'get_skill',
    {
      title: 'Read skill',
      description:
        'Returns the full content of SKILL.md, the metadata and the list of attached files. ' +
        'Counts one access for the skill. A SKILL.md too large for the result comes back as a ' +
        'download URL, like binary files do.',
      inputSchema: { slug: z.string().describe('Skill slug, obtained from search_skills.') },
    },
    (args) => guard(() => handlers.get_skill(args)),
  );

  server.registerTool(
    'get_skill_file',
    {
      title: 'Read skill file',
      description:
        'Reads an auxiliary file of the skill (e.g. "reference/examples.md"), listed by get_skill.',
      inputSchema: {
        slug: z.string().describe('Skill slug.'),
        path: z.string().describe('Relative path of the file inside the skill.'),
      },
    },
    (args) => guard(() => handlers.get_skill_file(args)),
  );

  server.registerTool(
    'download_skill',
    {
      title: 'Download skill',
      description:
        'Returns the download URL of the skill .zip package, with all of its files.',
      inputSchema: { slug: z.string().describe('Skill slug.') },
    },
    (args) => guard(() => handlers.download_skill(args)),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description: 'Lists the tags available on this server, with the number of skills in each one.',
      inputSchema: {},
    },
    () => guard(() => handlers.list_tags()),
  );

  return server;
}

/**
 * Os três métodos da extensão de skills do MCP (SEP-2640), em schemas Zod
 * escritos à mão: o SDK 1.30.0 não tem nada de skills, e o
 * `assertRequestHandlerCapability` dele é um `switch` sem `default` que lance,
 * então método desconhecido passa sem checagem de capability.
 *
 * `params` é tolerante (`.passthrough()`) porque a revisão que define estes
 * métodos é mais nova que a que o SDK fala: campo novo que um cliente mande não
 * pode virar erro de validação de uma requisição que sabemos responder.
 */
const ListSkillsRequestSchema = z.object({
  method: z.literal('skills/list'),
  // O `cursor` é aceito e ignorado: a listagem é completa (decisão 7), e não há
  // segunda página para apontar. Recusá-lo seria pior — um cliente que pagina
  // por hábito perderia a primeira.
  params: z.object({ cursor: z.string().optional() }).passthrough().optional(),
});

const GetSkillRequestSchema = z.object({
  method: z.literal('skills/get'),
  params: z.object({ uri: z.string() }).passthrough(),
});

const ReadDirectoryRequestSchema = z.object({
  method: z.literal('resources/directory/read'),
  params: z.object({ uri: z.string(), cursor: z.string().optional() }).passthrough(),
});

/**
 * Prompts e resources em handlers de baixo nível.
 *
 * `prompts/list` do `McpServer` é montado de um registro estático: uma lista
 * vinda do banco exigiria um `registerPrompt` por skill na criação do servidor,
 * o que tornaria esta fábrica assíncrona — três call sites em cada `http.ts` —
 * e congelaria a lista pelo tempo da sessão (`MCP_SESSION_TTL_MS`, 30 min por
 * padrão). Aqui ela é computada por requisição, e uma skill vinculada agora
 * aparece na chamada seguinte, mesmo em sessão antiga. Resources vão pelo mesmo
 * caminho por simetria: um estilo só no arquivo.
 *
 * **Não registre prompt nem resource por `registerPrompt`/`registerResource`
 * neste servidor**: o SDK lança quando um handler do mesmo método já existe, e
 * o processo cairia no boot.
 */
function registrarSuperficies(server: McpServer, surfaces: ReturnType<typeof createSurfaces>) {
  // Na mão e sem `listChanged`: o SDK o declara fixo como `true` ao registrar
  // resources, mas admin e mcp-public são containers separados — não há evento
  // em processo para disparar a notificação, e um cliente que confiasse na
  // promessa cacharia a lista pela sessão inteira. Precisa vir antes do
  // `connect`, depois do qual o SDK recusa. Vale mesmo sem nenhuma skill
  // vinculada: a fábrica é síncrona e não consulta o banco — e a SEP-2640
  // admite listagem vazia, então a extensão é declarada do mesmo jeito.
  server.server.registerCapabilities({
    prompts: {},
    resources: {},
    extensions: { 'io.modelcontextprotocol/skills': { directoryRead: true } },
  });

  // Embrulhadas como as tools, pelo mesmo motivo: o SDK monta o erro do JSON-RPC
  // com a `message` da exceção, então uma falha do banco iria crua ao cliente.
  // `listResourceTemplates` fica de fora porque devolve literal — não consulta
  // nada e não tem como falhar.
  server.server.setRequestHandler(ListPromptsRequestSchema, () =>
    guardSurface(() => surfaces.listPrompts()),
  );
  server.server.setRequestHandler(GetPromptRequestSchema, (request) =>
    guardSurface(() => surfaces.getPrompt(request.params.name)),
  );
  server.server.setRequestHandler(ListResourcesRequestSchema, () =>
    guardSurface(() => surfaces.listResources()),
  );
  server.server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    guardSurface(() => surfaces.readResource(request.params.uri)),
  );
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
    surfaces.listResourceTemplates(),
  );

  // Os três da extensão, pelo mesmo caminho e com o mesmo `guardSurface`.
  //
  // `tools/list` fica **de fora** dos campos de 2026-07-28, e é limitação
  // conhecida, não esquecimento: ele é montado pelo `McpServer` a partir do
  // `registerTool`, e o SDK lança se registrarmos um handler para um método que
  // já tem um. Cobri-lo exigiria descer as cinco ferramentas para handler de
  // baixo nível, perdendo a validação Zod automática — reescrita, não acréscimo.
  server.server.setRequestHandler(ListSkillsRequestSchema, () =>
    guardSurface(() => surfaces.listSkills()),
  );
  server.server.setRequestHandler(GetSkillRequestSchema, (request) =>
    guardSurface(() => surfaces.getSkill(request.params.uri)),
  );
  server.server.setRequestHandler(ReadDirectoryRequestSchema, (request) =>
    guardSurface(() => surfaces.readDirectory(request.params.uri)),
  );
}
