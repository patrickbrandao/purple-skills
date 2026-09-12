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
- Uma skill é um elemento flutuante: existe no catálogo e só é exibida — no
  site e nos servidores MCP — onde está vinculada a um MCP virtual. Skill
  recém-criada nasce sem vínculo, a menos que create_skill receba mcps; depois,
  link_skill / unlink_skill publicam e despublicam pelo lado da skill, e
  set_virtual_mcp_skills define a lista inteira pelo lado do MCP. Cada vínculo
  escolhe as três superfícies (asSkill, asPrompt, asResource). Publicar em um
  MCP virtual exige administrá-lo: o dono, ou um admin.
- O site lista o que está em ao menos um MCP virtual aberto e ligado; list_skills
  e get_skill mostram, em mcps, onde cada skill está.
- delete_skill é irreversível e exige confirm=true.
- As ferramentas de escrita dependem do papel da credencial: uma chave de
  usuário "leitor" só lê, e apagar skill exige papel "admin".
- MCPs virtuais (tools *_virtual_mcp*): servidores de leitura em
  /virtual/<slug>/mcp com chaves próprias (psv_…), ou abertos (is_open) — um
  MCP aberto é público: o site o lista, com suas skills. O MCP virtual tem
  dono: quem cria é o dono, e só o dono ou um admin o administra.
- O MCP público (/mcp) é o MCP virtual escolhido como padrão
  (get_default_virtual_mcp / set_default_virtual_mcp, só admin). Ele continua
  respondendo em /virtual/<slug>/mcp e não tem tratamento especial: pode ser
  fechado, desligado ou apagado como qualquer um, e aí /mcp responde 404.
  Sem MCP padrão, /mcp responde 404.`;

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
      description:
        'Lista o catálogo inteiro, inclusive skills sem vínculo. Cada uma traz em mcps os MCPs virtuais em que está.',
      inputSchema: {
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
        'Cria uma skill nova. O conteúdo do SKILL.md é obrigatório. Sem mcps a skill nasce sem ' +
        'vínculo, exibida em lugar nenhum. O frontmatter é gerado a partir dos campos abaixo.',
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
        mcps: z
          .array(
            z.object({
              slug: z.string().describe('Slug do MCP virtual.'),
              asSkill: z.boolean().describe('Nas ferramentas (search_skills, get_skill…).'),
              asPrompt: z.boolean().describe('Como prompt, pelo slug.'),
              asResource: z.boolean().describe('Como resource skill://<slug>.'),
            }),
          )
          .describe(
            'Onde publicar já na criação. Só em MCPs virtuais que a credencial administra; omitido, a skill nasce sem vínculo.',
          )
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
        'o frontmatter do SKILL.md, gerado a partir destes campos. Onde ela aparece é link_skill.',
      inputSchema: {
        slug: z.string().describe('Slug atual da skill.'),
        name: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).describe('Substitui a lista de tags inteira.').optional(),
        new_slug: z
          .string()
          .describe('Novo nome oficial (muda a URL pública e o `name:` do frontmatter).')
          .optional(),
      },
    },
    (args) => guard(() => handlers.edit_skill(args)),
  );

  server.registerTool(
    'link_skill',
    {
      title: 'Publicar skill em um MCP virtual',
      description:
        'Vincula a skill ao MCP virtual, escolhendo as três superfícies; um vínculo existente é ' +
        'reescrito. Exige administrar o MCP (dono ou admin).',
      inputSchema: {
        skill: z.string().describe('Slug da skill.'),
        mcp: z.string().describe('Slug do MCP virtual.'),
        asSkill: z.boolean().describe('Nas ferramentas (search_skills, get_skill…).'),
        asPrompt: z.boolean().describe('Como prompt, pelo slug.'),
        asResource: z.boolean().describe('Como resource skill://<slug>.'),
      },
    },
    (args) => guard(() => mcps.link_skill(args)),
  );

  server.registerTool(
    'unlink_skill',
    {
      title: 'Tirar skill de um MCP virtual',
      description:
        'Desfaz o vínculo. Uma skill sem vínculo nenhum deixa de ser exibida no site e em qualquer MCP.',
      inputSchema: {
        skill: z.string().describe('Slug da skill.'),
        mcp: z.string().describe('Slug do MCP virtual.'),
      },
    },
    (args) => guard(() => mcps.unlink_skill(args)),
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
        'Altera nome, slug, descrição, is_open ou is_active. Aberto (is_open), o MCP é público: o site o lista, com suas skills.',
      inputSchema: {
        slug: z.string().describe('Slug atual.'),
        name: z.string().optional(),
        new_slug: z.string().describe('Novo slug — muda o endereço de todo cliente configurado.').optional(),
        description: z.string().optional(),
        is_open: z.boolean().optional(),
        is_active: z.boolean().describe('false desliga: tudo sob /virtual/<slug> responde 404.').optional(),
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
        'está nela sai. Cada entrada escolhe as três superfícies. Para uma skill só, use link_skill.',
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

  // ------------------------------------------------------- MCP padrão ---

  server.registerTool(
    'get_default_virtual_mcp',
    {
      title: 'Ler o MCP padrão',
      description:
        'Qual MCP virtual responde em /mcp — o MCP público desta instalação — ou por que nenhum responde.',
      inputSchema: {},
    },
    () => guard(() => mcps.get_default_virtual_mcp()),
  );

  server.registerTool(
    'set_default_virtual_mcp',
    {
      title: 'Escolher o MCP padrão',
      description:
        'Faz um MCP virtual responder também em /mcp, com as próprias skills, chaves e regra de acesso. ' +
        'slug null limpa: /mcp passa a responder 404. Só admin.',
      inputSchema: {
        slug: z.string().nullable().describe('Slug do MCP virtual, ou null para nenhum.'),
      },
    },
    (args) => guard(() => mcps.set_default_virtual_mcp(args)),
  );

  return server;
}
