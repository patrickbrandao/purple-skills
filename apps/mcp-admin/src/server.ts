import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOKEN_CALLER, type Caller } from './auth.js';
import { config } from './config.js';
import { createMcpHandlers } from './mcps.js';
import { createHandlers, guard } from './tools.js';

const INSTRUCTIONS = `Servidor MCP administrativo do Purple Skills.

Permite gerenciar o catálogo inteiro: criar, editar, publicar/despublicar e
remover skills, além de gravar e apagar arquivos.

Regras importantes:
- Toda skill tem obrigatoriamente um SKILL.md; ele não pode ser apagado,
  apenas sobrescrito com set_file.
- Os metadados (slug, nome, descrição, tags) moram em campos próprios e são a
  fonte da verdade: o frontmatter das primeiras linhas do SKILL.md é gerado a
  partir deles na leitura. Não escreva frontmatter no conteúdo — ele é
  descartado. Para mudar metadados use create_skill/edit_skill.
- O slug é o nome oficial da skill: é ele que vai no campo name: do frontmatter.
- set_files_bulk com replace=true trata o zip como o estado desejado completo:
  arquivos ausentes no zip são removidos (o SKILL.md é sempre preservado).
- Skills recém-criadas nascem privadas, a menos que is_public=true.
- is_public é o interruptor global da publicação: com ela em false a skill não
  aparece em superfície nenhuma do MCP público.
- Com ela em true, três flags dizem por onde a skill é oferecida, e são
  independentes entre si: use_as_skill (padrão true) a mantém nas ferramentas
  do MCP público — search_skills, get_skill e as demais; use_as_prompt a
  oferece como prompt, pelo slug; use_as_resource, como resource
  skill://<slug>. Desligar use_as_skill publica a skill só nas outras duas.
- delete_skill é irreversível e exige confirm=true.
- As ferramentas de escrita dependem do papel da credencial: uma chave de
  usuário "leitor" só lê, e apagar skill exige papel "admin".
- MCPs virtuais (tools *_virtual_mcp*): servidores de leitura em
  /virtual/<slug>/mcp que publicam um recorte de skills — inclusive privadas —
  com chaves próprias (psv_…). Cada vínculo escolhe as três superfícies
  (asSkill, asPrompt, asResource) por conta própria; as flags use_as_* da
  skill valem só para o MCP principal. O MCP virtual tem dono: quem cria é o
  dono, e só o dono ou um admin o administra. Abrir um MCP (is_open) com
  skill privada dentro exige confirm_open=true.
- Chaves do MCP principal (tools *_public_mcp_key): chaves psp_ que abrem o
  MCP público principal quando ele roda com MCP_PUBLIC_AUTH=managed. Só admin.`;

/**
 * Cria uma instância do servidor MCP administrativo para um chamador.
 *
 * O `caller` chega da autenticação (token global ou chave `psk_`) e viaja com
 * os handlers: é ele que decide quais ferramentas podem ser executadas e quem
 * aparece no `audit_log`.
 */
export function createMcpServer(caller: Caller = TOKEN_CALLER): McpServer {
  const handlers = createHandlers(caller);
  const mcps = createMcpHandlers(caller);

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
      description:
        'Retorna metadados, lista de arquivos e o corpo do SKILL.md (sem o frontmatter, que é ' +
        'gerado a partir dos metadados).',
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
        'a menos que is_public seja true. O frontmatter é gerado a partir dos campos abaixo.',
      inputSchema: {
        name: z.string().describe('Nome legível da skill.'),
        description: z.string().describe('Resumo de uma linha.').optional(),
        skill_md_content: z
          .string()
          .describe('Corpo do SKILL.md (markdown), sem frontmatter — ele é gerado dos metadados.'),
        tags: z.array(z.string()).describe('Tags livres para navegação/filtro.').optional(),
        slug: z
          .string()
          .describe('Nome oficial da skill (a-z, 0-9 e hífen). Gerado a partir do nome se omitido.')
          .optional(),
        is_public: z.boolean().describe('Publicar imediatamente (padrão false).').optional(),
        use_as_skill: z
          .boolean()
          .describe(
            'Mantém a skill nas ferramentas do MCP público — search_skills, get_skill, ' +
              'get_skill_file, download_skill e list_tags (padrão true). Em false, ela só ' +
              'aparece pelas superfícies abaixo que estiverem ligadas.',
          )
          .optional(),
        use_as_prompt: z
          .boolean()
          .describe('Oferece a skill como prompt do MCP público, pelo slug (padrão false).')
          .optional(),
        use_as_resource: z
          .boolean()
          .describe('Oferece a skill como resource skill://<slug> do MCP público (padrão false).')
          .optional(),
      },
    },
    (args) => guard(() => handlers.create_skill(args)),
  );

  server.registerTool(
    'edit_skill',
    {
      title: 'Editar metadados',
      description:
        'Altera nome, descrição, tags ou slug de uma skill existente. É por aqui que se muda ' +
        'o frontmatter do SKILL.md, gerado a partir destes campos.',
      inputSchema: {
        slug: z.string().describe('Slug atual da skill.'),
        name: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).describe('Substitui a lista de tags inteira.').optional(),
        new_slug: z
          .string()
          .describe('Novo nome oficial (muda a URL pública e o `name:` do frontmatter).')
          .optional(),
        use_as_skill: z
          .boolean()
          .describe('Mantém a skill nas ferramentas do MCP público (padrão true).')
          .optional(),
        use_as_prompt: z
          .boolean()
          .describe('Oferece a skill como prompt do MCP público, pelo slug.')
          .optional(),
        use_as_resource: z
          .boolean()
          .describe('Oferece a skill como resource skill://<slug> do MCP público.')
          .optional(),
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
        'Cria ou sobrescreve um arquivo da skill. Use path="SKILL.md" para trocar o conteúdo ' +
        'principal — só o corpo: o frontmatter enviado é descartado.',
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

  // ------------------------------------------------------- MCPs virtuais ---

  server.registerTool(
    'list_virtual_mcps',
    {
      title: 'Listar MCPs virtuais',
      description:
        'Lista os MCPs virtuais que a credencial administra: todos para admin, os próprios para os demais.',
      inputSchema: {},
    },
    () => guard(() => mcps.list_virtual_mcps()),
  );

  server.registerTool(
    'get_virtual_mcp',
    {
      title: 'Ler MCP virtual',
      description: 'Configuração, skills vinculadas (com as superfícies e contadores do vínculo) e chaves ativas.',
      inputSchema: { slug: z.string().describe('Slug do MCP virtual.') },
    },
    (args) => guard(() => mcps.get_virtual_mcp(args)),
  );

  server.registerTool(
    'create_virtual_mcp',
    {
      title: 'Criar MCP virtual',
      description:
        'Cria um MCP virtual vazio em /virtual/<slug>/mcp. Quem cria é o dono. Nasce ligado e exigindo chave.',
      inputSchema: {
        name: z.string().describe('Nome de exibição.'),
        slug: z.string().describe('Slug (a-z, 0-9 e hífen). Gerado do nome se omitido.').optional(),
        description: z
          .string()
          .describe('Vai para as instruções do servidor: é como o agente sabe do que este MCP trata.')
          .optional(),
        is_open: z.boolean().describe('Sem chave (padrão false).').optional(),
      },
    },
    (args) => guard(() => mcps.create_virtual_mcp(args)),
  );

  server.registerTool(
    'update_virtual_mcp',
    {
      title: 'Alterar MCP virtual',
      description:
        'Altera nome, slug, descrição, is_open ou is_active. Abrir (is_open=true) com skill privada dentro exige confirm_open=true.',
      inputSchema: {
        slug: z.string().describe('Slug atual.'),
        name: z.string().optional(),
        new_slug: z.string().describe('Novo slug — muda o endereço de todo cliente configurado.').optional(),
        description: z.string().optional(),
        is_open: z.boolean().optional(),
        is_active: z.boolean().describe('false desliga: tudo sob /virtual/<slug> responde 404.').optional(),
        confirm_open: z.boolean().optional(),
      },
    },
    (args) => guard(() => mcps.update_virtual_mcp(args)),
  );

  server.registerTool(
    'delete_virtual_mcp',
    {
      title: 'Remover MCP virtual',
      description: 'Remove o MCP virtual, seus vínculos e suas chaves. Irreversível.',
      inputSchema: {
        slug: z.string(),
        confirm: z.boolean().describe('Precisa ser true para a remoção acontecer.'),
      },
    },
    (args) => guard(() => mcps.delete_virtual_mcp(args)),
  );

  server.registerTool(
    'set_virtual_mcp_skills',
    {
      title: 'Definir skills do MCP virtual',
      description:
        'Substitui a lista inteira de skills do MCP virtual: a lista é o estado desejado, e quem não ' +
        'está nela sai. Cada entrada escolhe as três superfícies. Num MCP aberto, vincular skill privada ' +
        'exige confirm_open=true.',
      inputSchema: {
        slug: z.string(),
        skills: z
          .array(
            z.object({
              slug: z.string(),
              asSkill: z.boolean().describe('Nas ferramentas (search_skills, get_skill…).'),
              asPrompt: z.boolean().describe('Como prompt, pelo slug.'),
              asResource: z.boolean().describe('Como resource skill://<slug>.'),
            }),
          )
          .describe('Lista completa. Vazia esvazia o MCP.'),
        confirm_open: z.boolean().optional(),
      },
    },
    (args) => guard(() => mcps.set_virtual_mcp_skills(args)),
  );

  server.registerTool(
    'list_virtual_mcp_keys',
    {
      title: 'Listar chaves do MCP virtual',
      description: 'Chaves psv_ do MCP virtual, inclusive revogadas. Nunca mostra o segredo.',
      inputSchema: { slug: z.string() },
    },
    (args) => guard(() => mcps.list_virtual_mcp_keys(args)),
  );

  server.registerTool(
    'create_virtual_mcp_key',
    {
      title: 'Emitir chave do MCP virtual',
      description: 'Emite uma chave psv_ para o MCP virtual. O token aparece uma única vez, na resposta.',
      inputSchema: {
        slug: z.string(),
        name: z.string().describe('Nome da chave (ex.: "CI do projeto X").'),
      },
    },
    (args) => guard(() => mcps.create_virtual_mcp_key(args)),
  );

  server.registerTool(
    'revoke_virtual_mcp_key',
    {
      title: 'Revogar chave do MCP virtual',
      description: 'Revoga uma chave pelo id (de list_virtual_mcp_keys). Quem a usa perde o acesso na hora.',
      inputSchema: { slug: z.string(), key_id: z.string() },
    },
    (args) => guard(() => mcps.revoke_virtual_mcp_key(args)),
  );

  // ------------------------------------------ chaves do MCP principal ---

  server.registerTool(
    'list_public_mcp_keys',
    {
      title: 'Listar chaves do MCP principal',
      description:
        'Chaves psp_ do MCP público principal (só valem com MCP_PUBLIC_AUTH=managed). Só admin. Nunca mostra o segredo.',
      inputSchema: {},
    },
    () => guard(() => mcps.list_public_mcp_keys()),
  );

  server.registerTool(
    'create_public_mcp_key',
    {
      title: 'Emitir chave do MCP principal',
      description: 'Emite uma chave psp_ para o MCP público principal. Só admin. O token aparece uma única vez.',
      inputSchema: { name: z.string().describe('Nome da chave (ex.: "agentes do time X").') },
    },
    (args) => guard(() => mcps.create_public_mcp_key(args)),
  );

  server.registerTool(
    'revoke_public_mcp_key',
    {
      title: 'Revogar chave do MCP principal',
      description: 'Revoga uma chave psp_ pelo id (de list_public_mcp_keys). Só admin.',
      inputSchema: { key_id: z.string() },
    },
    (args) => guard(() => mcps.revoke_public_mcp_key(args)),
  );

  return server;
}
