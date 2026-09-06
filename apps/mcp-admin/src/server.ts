import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOKEN_CALLER, type Caller } from './auth.js';
import { config } from './config.js';
import { createHandlers, guard } from './tools.js';

const INSTRUCTIONS = `Servidor MCP administrativo do Purple Skills.

Permite gerenciar o catálogo inteiro: criar, editar, publicar/despublicar e
remover skills, além de gravar e apagar arquivos.

Regras importantes:
- Toda skill tem obrigatoriamente um SKILL.md; ele não pode ser apagado,
  apenas sobrescrito com set_file.
- set_files_bulk com replace=true trata o zip como o estado desejado completo:
  arquivos ausentes no zip são removidos (o SKILL.md é sempre preservado).
- Skills recém-criadas nascem privadas, a menos que is_public=true.
- delete_skill é irreversível e exige confirm=true.
- As ferramentas de escrita dependem do papel da credencial: uma chave de
  usuário "leitor" só lê, e apagar skill exige papel "admin".`;

/**
 * Cria uma instância do servidor MCP administrativo para um chamador.
 *
 * O `caller` chega da autenticação (token global ou chave `psk_`) e viaja com
 * os handlers: é ele que decide quais ferramentas podem ser executadas e quem
 * aparece no `audit_log`.
 */
export function createMcpServer(caller: Caller = TOKEN_CALLER): McpServer {
  const handlers = createHandlers(caller);

  const server = new McpServer(
    { name: config.serverName, version: config.version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_skills',
    {
      title: 'Listar skills',
      description: 'Lista as skills do catálogo, incluindo as privadas por padrão.',
      inputSchema: {
        includePrivate: z.boolean().describe('Inclui skills privadas (padrão true).').optional(),
        query: z.string().describe('Filtro por texto livre.').optional(),
        tag: z.string().describe('Filtro por tag.').optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe('Máximo de resultados por página (padrão 50, teto 100).')
          .optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    (args) => guard(() => handlers.list_skills(args)),
  );

  server.registerTool(
    'get_skill',
    {
      title: 'Ler skill',
      description: 'Retorna metadados, lista de arquivos e o conteúdo do SKILL.md.',
      inputSchema: { slug: z.string().describe('Slug da skill.') },
    },
    (args) => guard(() => handlers.get_skill(args)),
  );

  server.registerTool(
    'get_file',
    {
      title: 'Ler arquivo',
      description: 'Lê o conteúdo textual de um arquivo da skill.',
      inputSchema: {
        slug: z.string(),
        path: z.string().describe('Caminho relativo, ex: "reference/exemplos.md".'),
      },
    },
    (args) => guard(() => handlers.get_file(args)),
  );

  server.registerTool(
    'create_skill',
    {
      title: 'Criar skill',
      description:
        'Cria uma skill nova. O conteúdo do SKILL.md é obrigatório. A skill nasce privada ' +
        'a menos que is_public seja true.',
      inputSchema: {
        name: z.string().describe('Nome legível da skill.'),
        description: z.string().describe('Resumo de uma linha.').optional(),
        skill_md_content: z.string().describe('Conteúdo completo do SKILL.md (markdown).'),
        tags: z.array(z.string()).describe('Tags livres para navegação/filtro.').optional(),
        slug: z.string().describe('Slug desejado. Gerado a partir do nome se omitido.').optional(),
        is_public: z.boolean().describe('Publicar imediatamente (padrão false).').optional(),
      },
    },
    (args) => guard(() => handlers.create_skill(args)),
  );

  server.registerTool(
    'edit_skill',
    {
      title: 'Editar metadados',
      description: 'Altera nome, descrição, tags ou slug de uma skill existente.',
      inputSchema: {
        slug: z.string().describe('Slug atual da skill.'),
        name: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).describe('Substitui a lista de tags inteira.').optional(),
        new_slug: z.string().describe('Novo slug (muda a URL pública).').optional(),
      },
    },
    (args) => guard(() => handlers.edit_skill(args)),
  );

  server.registerTool(
    'set_visibility',
    {
      title: 'Definir visibilidade',
      description: 'Torna a skill pública (visível no site e no MCP público) ou privada.',
      inputSchema: {
        slug: z.string(),
        visibility: z.enum(['public', 'private']),
      },
    },
    (args) => guard(() => handlers.set_visibility(args)),
  );

  server.registerTool(
    'set_file',
    {
      title: 'Gravar arquivo',
      description:
        'Cria ou sobrescreve um arquivo da skill. Use path="SKILL.md" para trocar o conteúdo principal.',
      inputSchema: {
        slug: z.string(),
        path: z.string().describe('Caminho relativo dentro da skill.'),
        content: z.string().describe('Conteúdo textual completo do arquivo.'),
      },
    },
    (args) => guard(() => handlers.set_file(args)),
  );

  server.registerTool(
    'set_files_bulk',
    {
      title: 'Importar árvore de arquivos',
      description:
        'Importa um .zip (base64) com a árvore de arquivos da skill, preservando os caminhos. ' +
        'Por padrão o zip representa o estado desejado completo: arquivos ausentes nele são ' +
        'removidos da skill (o SKILL.md é sempre preservado). Passe replace=false para apenas ' +
        'adicionar e sobrescrever, sem remover nada.',
      inputSchema: {
        slug: z.string(),
        zip_base64: z.string().describe('Conteúdo do .zip codificado em base64.'),
        replace: z
          .boolean()
          .describe('false mantém os arquivos omitidos no zip (padrão true).')
          .optional(),
      },
    },
    (args) => guard(() => handlers.set_files_bulk(args)),
  );

  server.registerTool(
    'delete_file',
    {
      title: 'Remover arquivo',
      description: 'Remove um arquivo da skill. O SKILL.md não pode ser removido.',
      inputSchema: { slug: z.string(), path: z.string() },
    },
    (args) => guard(() => handlers.delete_file(args)),
  );

  server.registerTool(
    'delete_skill',
    {
      title: 'Remover skill',
      description: 'Remove a skill e todos os seus arquivos. Irreversível.',
      inputSchema: {
        slug: z.string(),
        confirm: z.boolean().describe('Precisa ser true para a remoção acontecer.'),
      },
    },
    (args) => guard(() => handlers.delete_skill(args)),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'Listar tags',
      description: 'Lista todas as tags do catálogo com a contagem de skills.',
      inputSchema: {},
    },
    () => guard(() => handlers.list_tags()),
  );

  server.registerTool(
    'get_stats',
    {
      title: 'Estatísticas',
      description: 'Totais do catálogo: skills, arquivos, acessos, downloads e tags.',
      inputSchema: {},
    },
    () => guard(() => handlers.get_stats()),
  );

  return server;
}
