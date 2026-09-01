import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from './config.js';
import { handlers } from './tools.js';

const INSTRUCTIONS = `Servidor MCP do Purple Skills — um catálogo de skills (instruções
reutilizáveis) para agentes de IA.

Fluxo recomendado:
1. search_skills("tema") para descobrir skills relevantes pelo conteúdo.
2. get_skill("<slug>") para ler o SKILL.md completo da skill escolhida.
3. get_skill_file("<slug>", "<caminho>") para ler arquivos auxiliares.
4. download_skill("<slug>") quando o usuário quiser o pacote .zip.

Somente skills marcadas como públicas são expostas aqui.`;

/** Cria uma instância do servidor MCP público com as ferramentas registradas. */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: config.serverName, version: config.version },
    { instructions: INSTRUCTIONS },
  );

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
