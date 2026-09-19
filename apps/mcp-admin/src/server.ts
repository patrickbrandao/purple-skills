import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TOKEN_CALLER, callerAtual, type Caller } from './auth.js';
import { config } from './config.js';
import { createCatalogHandlers } from './catalogs.js';
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
  arquivos ausentes no zip são removidos (o SKILL.md é sempre preservado). Essa
  remoção é irreversível e não acontece sem confirmação: a chamada é recusada
  com a lista do que sairia e o número a repetir em confirm_deletions. Num envio
  parcial, use replace=false em vez de confirmar.
- Uma skill é um elemento flutuante: existe no catálogo e só é exibida — no
  site e nos servidores MCP — onde está vinculada a um MCP virtual. Skill
  recém-criada nasce sem vínculo, a menos que create_skill receba mcps; depois,
  link_skill / unlink_skill publicam e despublicam pelo lado da skill, e
  set_virtual_mcp_skills define a lista inteira pelo lado do MCP. Cada vínculo
  escolhe as três superfícies (asSkill, asPrompt, asResource). Publicar em um
  MCP virtual exige "edit" nele e "view" na skill.
- O site lista o que está em ao menos um MCP virtual aberto e ligado, mais as
  skills e catálogos marcados públicos (is_public); list_skills e get_skill
  mostram, em mcps, onde cada skill está.
- delete_skill é irreversível, exige confirm=true e é do dono (ou admin).
- Acesso: skills, catálogos e MCPs virtuais têm dono. O papel da credencial
  decide só quem CRIA (editor e admin; um "membro" não cria). O resto é o
  acesso por objeto: admin tem tudo em tudo; o dono tem tudo no que é seu;
  outras contas têm o nível concedido — "view" (ler; num MCP ou catálogo,
  ler também as skills dentro), "edit" (conteúdo da skill; membros do
  catálogo; vínculos, portas e canvas do MCP) ou "manage" (slug, estado,
  público/aberto, chaves do MCP e as concessões). Apagar e transferir o dono
  são só do dono e do admin. Uma credencial só lista o que é seu, o que lhe
  foi concedido e o que é público/aberto (list_* aceita scope: mine, shared,
  public). share_<tipo>(slug, email, level) / unshare_<tipo> concedem e
  revogam; transfer_<tipo>(slug, email) muda o dono. Uma skill dentro de um
  MCP aberto ou de um catálogo público fica legível por qualquer um, mesmo
  privada — as tools avisam.
- MCPs virtuais (tools *_virtual_mcp*): servidores de leitura em
  /virtual/<slug>/mcp com chaves próprias (psv_…), ou abertos (is_open) — um
  MCP aberto é público: o site o lista, com suas skills. A chave psv_ lê a
  árvore inteira do MCP (skills diretas e catálogos), qualquer que seja o
  acesso de cada skill.
- O MCP público (/mcp) é o MCP virtual escolhido como padrão
  (get_default_virtual_mcp / set_default_virtual_mcp, só admin). Ele continua
  respondendo em /virtual/<slug>/mcp e não tem tratamento especial: pode ser
  fechado, desligado ou apagado como qualquer um, e aí /mcp responde 404.
  Sem MCP padrão, /mcp responde 404.
- Catálogos (tools *_catalog*): um catálogo é um grupo de skills com dono.
  Vinculado a um MCP virtual (set_virtual_mcp_catalogs), entrega todas as
  skills ativas dele de uma vez, pelas portas escolhidas no vínculo — uma
  escolha só para o grupo. Uma skill com vínculo direto ao mesmo MCP segue o
  vínculo direto, que sobrescreve o catálogo; sem vínculo direto, as portas
  são a união dos catálogos. Vincular exige "edit" no MCP e "view" no
  catálogo. Três desligamentos, todos reversíveis: is_active da skill (edit_skill —
  some de todo MCP e do site), isActive da participação em set_catalog_skills
  (só naquele catálogo) e is_active do catálogo (update_catalog).`;

/**
 * Cria uma instância do servidor MCP administrativo para um chamador.
 *
 * O `caller` chega da autenticação (token global ou chave `psk_`) e é ele que
 * decide quais ferramentas podem ser executadas e quem aparece no `audit_log`.
 *
 * Os handlers nascem **a cada chamada**, com a credencial revalidada na
 * requisição em curso (`callerAtual`). Numa sessão este servidor é construído
 * uma única vez, no `initialize`: fechar sobre o `caller` daquele instante
 * congelaria papel, ator, IP e agente até a sessão cair — rebaixar a conta no
 * painel não tiraria o poder de quem já estava conectado. Recriar é barato
 * (só fecha sobre o caller, sem ida ao banco), e o `caller` do `initialize`
 * continua valendo como padrão fora de uma requisição.
 */
export function createMcpServer(caller: Caller = TOKEN_CALLER): McpServer {
  const handlers = () => createHandlers(callerAtual(caller));
  const mcps = () => createMcpHandlers(callerAtual(caller));
  const catalogs = () => createCatalogHandlers(callerAtual(caller));

  const server = new McpServer(
    { name: config.serverName, version: config.version },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'list_skills',
    {
      title: 'Listar skills',
      description:
        'Lista as skills que a credencial enxerga (as suas, as concedidas e as públicas ou expostas; tudo para admin), ' +
        'inclusive sem vínculo e desligadas. Cada uma traz o dono, o seu acesso e, em mcps, os MCPs virtuais em que está.',
      inputSchema: {
        query: z.string().describe('Filtro por texto livre.').optional(),
        tag: z.string().describe('Filtro por tag.').optional(),
        scope: z
          .enum(['mine', 'shared', 'public'])
          .describe('Só as minhas, só as compartilhadas comigo ou só as públicas. Omitido: todas que vejo.')
          .optional(),
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
    (args) => guard(() => handlers().list_skills(args)),
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
    (args) => guard(() => handlers().get_skill(args)),
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
    (args) => guard(() => handlers().get_file(args)),
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
        icon: z
          .string()
          .describe('Ícone no painel: um único emoji (🐘) ou a URL http(s) de uma imagem.')
          .optional(),
        skill_md_content: z
          .string()
          .describe('Corpo do SKILL.md (markdown), sem frontmatter — ele é gerado dos metadados.'),
        tags: z.array(z.string()).describe('Tags livres para navegação/filtro.').optional(),
        slug: z
          .string()
          .describe(
            'Nome oficial da skill: minúsculas a-z, dígitos e hífen simples, sem hífen nas ' +
              'pontas e no máximo 96 caracteres — "commits-convencionais". Valor fora disso é ' +
              'recusado (o servidor não o corrige mais em silêncio), então mande o slug já ' +
              'pronto. Omitido, é gerado a partir do nome.',
          )
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
            'Onde publicar já na criação. Só em MCPs virtuais que a credencial edita; omitido, a skill nasce sem vínculo.',
          )
          .optional(),
        is_public: z
          .boolean()
          .describe('Legível por qualquer conta e pelo site, sem concessão (padrão false). Não a publica em MCP nenhum.')
          .optional(),
      },
    },
    (args) => guard(() => handlers().create_skill(args)),
  );

  server.registerTool(
    'edit_skill',
    {
      title: 'Editar metadados',
      description:
        'Altera nome, descrição, ícone, tags ("edit") ou slug, is_active e is_public ("manage") de uma skill. É por ' +
        'aqui que se muda o frontmatter do SKILL.md, gerado a partir destes campos. Onde ela aparece é link_skill.',
      inputSchema: {
        slug: z.string().describe('Slug atual da skill.'),
        name: z.string().optional(),
        description: z.string().optional(),
        icon: z
          .string()
          .describe('Ícone no painel: um único emoji ou a URL http(s) de uma imagem. Vazio limpa.')
          .optional(),
        tags: z.array(z.string()).describe('Substitui a lista de tags inteira.').optional(),
        new_slug: z
          .string()
          .describe(
            'Novo nome oficial (muda a URL pública e o `name:` do frontmatter). Mesmas regras do ' +
              'slug na criação: minúsculas a-z, dígitos e hífen simples, sem hífen nas pontas, ' +
              'até 96 caracteres; valor fora disso é recusado, não corrigido.',
          )
          .optional(),
        is_active: z
          .boolean()
          .describe('false desliga a skill: some de todo MCP virtual e do site, direto ou por catálogo, sem perder vínculo nenhum.')
          .optional(),
        is_public: z
          .boolean()
          .describe('Legível por qualquer conta e pelo site, sem concessão. Exige "manage", como new_slug e is_active.')
          .optional(),
      },
    },
    (args) => guard(() => handlers().edit_skill(args)),
  );

  server.registerTool(
    'link_skill',
    {
      title: 'Publicar skill em um MCP virtual',
      description:
        'Vincula a skill ao MCP virtual, escolhendo as três superfícies; um vínculo existente é ' +
        'reescrito. Exige "edit" no MCP virtual e "view" na skill: quem edita um servidor publica ' +
        'nele skill alheia que consiga ler, e num servidor aberto isso a torna pública.',
      inputSchema: {
        skill: z.string().describe('Slug da skill.'),
        mcp: z.string().describe('Slug do MCP virtual.'),
        asSkill: z.boolean().describe('Nas ferramentas (search_skills, get_skill…).'),
        asPrompt: z.boolean().describe('Como prompt, pelo slug.'),
        asResource: z.boolean().describe('Como resource skill://<slug>.'),
      },
    },
    (args) => guard(() => mcps().link_skill(args)),
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
    (args) => guard(() => mcps().unlink_skill(args)),
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
    (args) => guard(() => handlers().set_file(args)),
  );

  server.registerTool(
    'set_files_bulk',
    {
      title: 'Importar árvore de arquivos',
      description:
        'Importa um .zip (base64) com a árvore de arquivos da skill, preservando os caminhos. ' +
        'Por padrão o zip representa o estado desejado completo: arquivos ausentes nele são ' +
        'removidos da skill (o SKILL.md é sempre preservado). Passe replace=false para apenas ' +
        'adicionar e sobrescrever, sem remover nada. Quando o zip de fato removeria arquivos, a ' +
        'chamada é recusada com a lista do que sairia: repita com confirm_deletions=<número de ' +
        'arquivos a remover> para confirmar, ou com replace=false para não remover nada.',
      inputSchema: {
        slug: z.string(),
        zip_base64: z.string().describe('Conteúdo do .zip codificado em base64.'),
        replace: z
          .boolean()
          .describe('false mantém os arquivos omitidos no zip (padrão true).')
          .optional(),
        confirm_deletions: z
          .number()
          .int()
          .min(0)
          .describe(
            'Confirma a remoção irreversível dos arquivos ausentes no zip: precisa ser o número ' +
              'exato deles, que a recusa da primeira chamada informa. Só é necessário quando há ' +
              'remoção — não invente o valor.',
          )
          .optional(),
      },
    },
    (args) => guard(() => handlers().set_files_bulk(args)),
  );

  server.registerTool(
    'delete_file',
    {
      title: 'Remover arquivo',
      description: 'Remove um arquivo da skill. O SKILL.md não pode ser removido.',
      inputSchema: { slug: z.string(), path: z.string() },
    },
    (args) => guard(() => handlers().delete_file(args)),
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
    (args) => guard(() => handlers().delete_skill(args)),
  );

  server.registerTool(
    'list_tags',
    {
      title: 'Listar tags',
      description: 'Lista todas as tags do catálogo com a contagem de skills.',
      inputSchema: {},
    },
    () => guard(() => handlers().list_tags()),
  );

  server.registerTool(
    'get_stats',
    {
      title: 'Estatísticas',
      description:
        'Totais recortados pelo que a credencial enxerga: skills e tags que ela vê, mais as skills publicadas no site. ' +
        'Só uma credencial admin recebe os números da instalação inteira (arquivos, visitas, downloads, flutuantes e contas).',
      inputSchema: {},
    },
    () => guard(() => handlers().get_stats()),
  );

  // ------------------------------------------------------- MCPs virtuais ---

  server.registerTool(
    'list_virtual_mcps',
    {
      title: 'Listar MCPs virtuais',
      description:
        'Lista os MCPs virtuais que a credencial enxerga: todos para admin; os seus, os concedidos e os abertos para os demais, com o acesso em cada um.',
      inputSchema: {
        scope: z.enum(['mine', 'shared', 'public']).describe('Só os meus, só os compartilhados comigo ou só os abertos.').optional(),
      },
    },
    (args) => guard(() => mcps().list_virtual_mcps(args)),
  );

  server.registerTool(
    'get_virtual_mcp',
    {
      title: 'Ler MCP virtual',
      description: 'Configuração, skills vinculadas (com as superfícies e contadores do vínculo) e chaves ativas.',
      inputSchema: { slug: z.string().describe('Slug do MCP virtual.') },
    },
    (args) => guard(() => mcps().get_virtual_mcp(args)),
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
    (args) => guard(() => mcps().create_virtual_mcp(args)),
  );

  server.registerTool(
    'update_virtual_mcp',
    {
      title: 'Alterar MCP virtual',
      description:
        'Altera nome, slug, descrição, is_open ou is_active (exige "manage"). Aberto (is_open), o MCP é público: o site o lista, com suas skills — inclusive as privadas.',
      inputSchema: {
        slug: z.string().describe('Slug atual.'),
        name: z.string().optional(),
        new_slug: z.string().describe('Novo slug — muda o endereço de todo cliente configurado.').optional(),
        description: z.string().optional(),
        is_open: z.boolean().optional(),
        is_active: z.boolean().describe('false desliga: tudo sob /virtual/<slug> responde 404.').optional(),
      },
    },
    (args) => guard(() => mcps().update_virtual_mcp(args)),
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
    (args) => guard(() => mcps().delete_virtual_mcp(args)),
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
    (args) => guard(() => mcps().set_virtual_mcp_skills(args)),
  );

  server.registerTool(
    'list_virtual_mcp_keys',
    {
      title: 'Listar chaves do MCP virtual',
      description: 'Chaves psv_ do MCP virtual, inclusive revogadas. Nunca mostra o segredo.',
      inputSchema: { slug: z.string() },
    },
    (args) => guard(() => mcps().list_virtual_mcp_keys(args)),
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
    (args) => guard(() => mcps().create_virtual_mcp_key(args)),
  );

  server.registerTool(
    'revoke_virtual_mcp_key',
    {
      title: 'Revogar chave do MCP virtual',
      description: 'Revoga uma chave pelo id (de list_virtual_mcp_keys). Quem a usa perde o acesso na hora.',
      inputSchema: { slug: z.string(), key_id: z.string() },
    },
    (args) => guard(() => mcps().revoke_virtual_mcp_key(args)),
  );

  // ----------------------------------------------------------- catálogos ---

  server.registerTool(
    'list_catalogs',
    {
      title: 'Listar catálogos',
      description:
        'Lista os catálogos que a credencial enxerga: todos para admin; os seus, os concedidos e os públicos para os demais, com o acesso em cada um.',
      inputSchema: {
        scope: z.enum(['mine', 'shared', 'public']).describe('Só os meus, só os compartilhados comigo ou só os públicos.').optional(),
      },
    },
    (args) => guard(() => catalogs().list_catalogs(args)),
  );

  server.registerTool(
    'get_catalog',
    {
      title: 'Ler catálogo',
      description: 'Configuração, skills (com a participação e se a skill está ligada) e os MCPs virtuais em que o catálogo está.',
      inputSchema: { slug: z.string().describe('Slug do catálogo.') },
    },
    (args) => guard(() => catalogs().get_catalog(args)),
  );

  server.registerTool(
    'create_catalog',
    {
      title: 'Criar catálogo',
      description: 'Cria um catálogo vazio e ligado. Quem cria é o dono.',
      inputSchema: {
        name: z.string().describe('Nome de exibição.'),
        slug: z.string().describe('Slug (a-z, 0-9 e hífen). Gerado do nome se omitido.').optional(),
        description: z.string().describe('Para quem administra: do que este grupo trata.').optional(),
        is_public: z
          .boolean()
          .describe('Legível por qualquer conta e pelo site, que lista os membros — inclusive skills privadas (padrão false).')
          .optional(),
      },
    },
    (args) => guard(() => catalogs().create_catalog(args)),
  );

  server.registerTool(
    'update_catalog',
    {
      title: 'Alterar catálogo',
      description:
        'Altera nome, slug, descrição, is_active ou is_public (exige "manage"). Desligado, o catálogo não entrega nada a MCP nenhum (membros e vínculos ficam); público, o site o lista com todos os membros.',
      inputSchema: {
        slug: z.string().describe('Slug atual.'),
        name: z.string().optional(),
        new_slug: z.string().optional(),
        description: z.string().optional(),
        is_active: z.boolean().optional(),
        is_public: z.boolean().optional(),
      },
    },
    (args) => guard(() => catalogs().update_catalog(args)),
  );

  server.registerTool(
    'delete_catalog',
    {
      title: 'Remover catálogo',
      description: 'Remove o catálogo e os vínculos dele com MCPs virtuais. As skills continuam existindo. Irreversível.',
      inputSchema: {
        slug: z.string(),
        confirm: z.boolean().describe('Precisa ser true para a remoção acontecer.'),
      },
    },
    (args) => guard(() => catalogs().delete_catalog(args)),
  );

  server.registerTool(
    'set_catalog_skills',
    {
      title: 'Definir skills do catálogo',
      description:
        'Substitui a lista inteira de skills do catálogo: a lista é o estado desejado, e quem não está nela sai. ' +
        'isActive é a participação: false mantém a skill no catálogo sem entregá-la; omitido é true para quem entra e não mexe em quem fica.',
      inputSchema: {
        slug: z.string(),
        skills: z
          .array(
            z.object({
              slug: z.string(),
              isActive: z.boolean().describe('Participação no catálogo (padrão true para quem entra).').optional(),
            }),
          )
          .describe('Lista completa. Vazia esvazia o catálogo.'),
      },
    },
    (args) => guard(() => catalogs().set_catalog_skills(args)),
  );

  server.registerTool(
    'set_virtual_mcp_catalogs',
    {
      title: 'Definir catálogos do MCP virtual',
      description:
        'Substitui a lista inteira de catálogos do MCP virtual; cada entrada escolhe as três superfícies, que valem para ' +
        'todas as skills do catálogo. Exige "edit" no MCP e "view" em cada catálogo que entra.',
      inputSchema: {
        slug: z.string().describe('Slug do MCP virtual.'),
        catalogs: z
          .array(
            z.object({
              slug: z.string().describe('Slug do catálogo.'),
              asSkill: z.boolean().describe('Nas ferramentas (search_skills, get_skill…).'),
              asPrompt: z.boolean().describe('Como prompt, pelo slug.'),
              asResource: z.boolean().describe('Como resource skill://<slug>.'),
            }),
          )
          .describe('Lista completa. Vazia tira todos os catálogos do MCP.'),
      },
    },
    (args) => guard(() => catalogs().set_virtual_mcp_catalogs(args)),
  );

  // ------------------------------------------------------------- acesso ---

  const accessInput = {
    slug: z.string().describe('Slug do objeto.'),
    email: z.string().describe('E-mail da conta (ativa) que recebe o acesso.'),
    level: z
      .enum(['view', 'edit', 'manage'])
      .describe('view: ler; edit: conteúdo/membros/vínculos; manage: propriedades, chaves e concessões.'),
  };
  const unshareInput = {
    slug: z.string().describe('Slug do objeto.'),
    email: z.string().describe('E-mail da conta que perde o acesso.'),
  };
  const transferInput = {
    slug: z.string().describe('Slug do objeto.'),
    email: z.string().describe('E-mail da conta (ativa) que vira dona.'),
  };

  server.registerTool(
    'share_skill',
    {
      title: 'Compartilhar skill',
      description:
        'Concede (ou muda) o nível de acesso de uma conta a uma skill. Exige "manage" na skill. ' +
        'Não se concede ao dono nem a um admin — já têm tudo.',
      inputSchema: accessInput,
    },
    (args) => guard(() => handlers().share_skill(args)),
  );

  server.registerTool(
    'unshare_skill',
    {
      title: 'Revogar acesso à skill',
      description: 'Remove a concessão de uma conta a uma skill. Exige "manage". Vínculos já feitos por ela ficam.',
      inputSchema: unshareInput,
    },
    (args) => guard(() => handlers().unshare_skill(args)),
  );

  server.registerTool(
    'transfer_skill',
    {
      title: 'Transferir skill',
      description: 'Muda o dono da skill. Só o dono atual ou um admin; quem transfere deixa de ser dono.',
      inputSchema: transferInput,
    },
    (args) => guard(() => handlers().transfer_skill(args)),
  );

  server.registerTool(
    'share_catalog',
    {
      title: 'Compartilhar catálogo',
      description:
        'Concede (ou muda) o nível de acesso de uma conta a um catálogo. Exige "manage". "view" inclui ler os membros.',
      inputSchema: accessInput,
    },
    (args) => guard(() => catalogs().share_catalog(args)),
  );

  server.registerTool(
    'unshare_catalog',
    {
      title: 'Revogar acesso ao catálogo',
      description: 'Remove a concessão de uma conta a um catálogo. Exige "manage".',
      inputSchema: unshareInput,
    },
    (args) => guard(() => catalogs().unshare_catalog(args)),
  );

  server.registerTool(
    'transfer_catalog',
    {
      title: 'Transferir catálogo',
      description: 'Muda o dono do catálogo. Só o dono atual ou um admin.',
      inputSchema: transferInput,
    },
    (args) => guard(() => catalogs().transfer_catalog(args)),
  );

  server.registerTool(
    'share_mcp',
    {
      title: 'Compartilhar MCP virtual',
      description:
        'Concede (ou muda) o nível de acesso de uma conta a um MCP virtual. Exige "manage". "view" inclui ler as skills dentro.',
      inputSchema: accessInput,
    },
    (args) => guard(() => mcps().share_mcp(args)),
  );

  server.registerTool(
    'unshare_mcp',
    {
      title: 'Revogar acesso ao MCP virtual',
      description: 'Remove a concessão de uma conta a um MCP virtual. Exige "manage".',
      inputSchema: unshareInput,
    },
    (args) => guard(() => mcps().unshare_mcp(args)),
  );

  server.registerTool(
    'transfer_mcp',
    {
      title: 'Transferir MCP virtual',
      description: 'Muda o dono do MCP virtual. Só o dono atual ou um admin.',
      inputSchema: transferInput,
    },
    (args) => guard(() => mcps().transfer_mcp(args)),
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
    () => guard(() => mcps().get_default_virtual_mcp()),
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
    (args) => guard(() => mcps().set_default_virtual_mcp(args)),
  );

  return server;
}
