import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { config } from './config.js';
import { handlers, surfaces } from './tools.js';

const INSTRUCTIONS = `Servidor MCP do Purple Skills — um catálogo de skills (instruções
reutilizáveis) para agentes de IA.

Fluxo recomendado:
1. search_skills("tema") para descobrir skills relevantes pelo conteúdo.
2. get_skill("<slug>") para ler o SKILL.md completo da skill escolhida.
3. get_skill_file("<slug>", "<caminho>") para ler arquivos auxiliares.
4. download_skill("<slug>") quando o usuário quiser o pacote .zip.

Algumas skills também estão publicadas como prompt — pelo próprio slug — e como
resource, na URI skill://<slug>. As ferramentas acima não dizem quais: quem
mostra são prompts/list e resources/list. As três superfícies são independentes,
então uma skill pode estar publicada só como prompt ou só como resource e não
aparecer em search_skills — consulte as três listagens antes de concluir que uma
skill não existe aqui.

Somente skills marcadas como públicas são expostas aqui.`;

/** Cria uma instância do servidor MCP público com as ferramentas registradas. */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: config.serverName, version: config.version },
    { instructions: INSTRUCTIONS },
  );

  registrarSuperficies(server);

  server.registerTool(
    'search_skills',
    {
      title: 'Buscar skills',
      description:
        'Busca skills públicas por texto livre (nome, descrição e conteúdo do SKILL.md), ' +
        'opcionalmente filtrando por tag. Retorna os slugs a usar em get_skill.',
      inputSchema: {
        query: z.string().describe('Termos de busca. Vazio lista as mais acessadas.').optional(),
        tag: z.string().describe('Filtra por uma tag exata.').optional(),
        limit: z.number().int().min(1).max(50).describe('Máximo de resultados (padrão 10).').optional(),
        offset: z.number().int().min(0).describe('Deslocamento para paginação.').optional(),
      },
    },
    (args) => handlers.search_skills(args),
  );

  server.registerTool(
    'get_skill',
    {
      title: 'Ler skill',
      description:
        'Retorna o conteúdo completo do SKILL.md, os metadados e a lista de arquivos anexados. ' +
        'Contabiliza um acesso para a skill.',
      inputSchema: { slug: z.string().describe('Slug da skill, obtido em search_skills.') },
    },
    (args) => handlers.get_skill(args),
  );

  server.registerTool(
    'get_skill_file',
    {
      title: 'Ler arquivo da skill',
      description:
        'Lê um arquivo auxiliar da skill (ex: "reference/exemplos.md"), listado por get_skill.',
      inputSchema: {
        slug: z.string().describe('Slug da skill.'),
        path: z.string().describe('Caminho relativo do arquivo dentro da skill.'),
      },
    },
    (args) => handlers.get_skill_file(args),
  );

  server.registerTool(
    'download_skill',
    {
      title: 'Baixar skill',
      description:
        'Retorna a URL de download do pacote .zip da skill, com todos os seus arquivos.',
      inputSchema: { slug: z.string().describe('Slug da skill.') },
    },
    (args) => handlers.download_skill(args),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'Listar tags',
      description: 'Lista as tags disponíveis no catálogo, com a quantidade de skills em cada uma.',
      inputSchema: {},
    },
    () => handlers.list_tags(),
  );

  return server;
}

/**
 * Prompts e resources em handlers de baixo nível.
 *
 * `prompts/list` do `McpServer` é montado de um registro estático: uma lista
 * vinda do banco exigiria um `registerPrompt` por skill na criação do servidor,
 * o que tornaria esta fábrica assíncrona — três call sites em cada `http.ts` —
 * e congelaria a lista pelo tempo da sessão (`MCP_SESSION_TTL_MS`, 30 min por
 * padrão). Aqui ela é computada por requisição, e uma skill flagada agora
 * aparece na chamada seguinte, mesmo em sessão antiga. Resources vão pelo mesmo
 * caminho por simetria: um estilo só no arquivo.
 *
 * **Não registre prompt nem resource por `registerPrompt`/`registerResource`
 * neste servidor**: o SDK lança quando um handler do mesmo método já existe, e
 * o processo cairia no boot.
 */
function registrarSuperficies(server: McpServer) {
  // Na mão e sem `listChanged`: o SDK o declara fixo como `true` ao registrar
  // resources, mas admin e mcp-public são containers separados — não há evento
  // em processo para disparar a notificação, e um cliente que confiasse na
  // promessa cacharia a lista pela sessão inteira. Precisa vir antes do
  // `connect`, depois do qual o SDK recusa. Vale mesmo sem nenhuma skill
  // flagada: a fábrica é síncrona e não consulta o banco.
  server.server.registerCapabilities({ prompts: {}, resources: {} });

  server.server.setRequestHandler(ListPromptsRequestSchema, () => surfaces.listPrompts());
  server.server.setRequestHandler(GetPromptRequestSchema, (request) =>
    surfaces.getPrompt(request.params.name),
  );
  server.server.setRequestHandler(ListResourcesRequestSchema, () => surfaces.listResources());
  server.server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    surfaces.readResource(request.params.uri),
  );
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
    surfaces.listResourceTemplates(),
  );
}
