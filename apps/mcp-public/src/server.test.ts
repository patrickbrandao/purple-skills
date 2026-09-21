import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { composeSkillMd, parseFrontmatter } from '@purple-skills/shared';

/** O erro de negócio do `@purple-skills/db`, como o `guard` o reconhece. */
const { AppError } = vi.hoisted(() => ({
  AppError: class AppError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));

const db = vi.hoisted(() => ({
  // A busca semântica lê estas três; sem elas o módulo `rag.ts` nem carrega.
  ragSchemaReady: vi.fn(async () => false),
  getRagSettings: vi.fn(async () => ({})),
  findRagSpace: vi.fn(async () => null),
  listSkills: vi.fn(),
  listPublishedSkills: vi.fn(),
  getSkillDetail: vi.fn(),
  getSkillSummary: vi.fn(),
  recordSkillAccess: vi.fn(),
  listTags: vi.fn(),
  readFile: vi.fn(),
  listFiles: vi.fn(),
  listSkillsManifest: vi.fn(),
  readSkillMdBodies: vi.fn(),
}));

/**
 * O teto da consulta é **valor**, não função: sem ele no mock, o `server.ts` e o
 * `tools.ts` não têm o que importar. E é de propósito um número que **não** é o
 * 200 de produção: é o que prova que a descrição da tool e o corte saem da
 * constante do `@purple-skills/db` — com 200 aqui, o teste passaria igual com o
 * literal escrito à mão de volta no `server.ts` (relatório 037 da auditoria de
 * 2026-09-19).
 */
const { TETO_DA_CONSULTA } = vi.hoisted(() => ({ TETO_DA_CONSULTA: 120 }));

vi.mock('@purple-skills/db', () => ({ ...db, AppError, SEARCH_QUERY_MAX_LENGTH: TETO_DA_CONSULTA }));

const { createMcpServer } = await import('./server.js');
// O cache do digest mora no módulo, não na instância: cada caso parte dele
// vazio, senão a medida de um caso apareceria no seguinte.
const { cacheDeDigesto } = await import('./digest.js');

/** O vMCP padrão, chamado pela raiz. */
const raiz = {
  mcp: { uuid: 'mcp-1', slug: 'public', name: 'Public', description: '', isOpen: true },
  baseUrl: 'https://mcp.exemplo.dev',
};

/** Cliente ligado a um servidor novo pelo transporte em memória. */
async function conectar(scope: Parameters<typeof createMcpServer>[0] = raiz) {
  const [doCliente, doServidor] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'teste', version: '0' });

  await Promise.all([createMcpServer(scope).connect(doServidor), client.connect(doCliente)]);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.listPublishedSkills.mockResolvedValue([]);
});

describe('handshake', () => {
  it('anuncia prompts e resources sem listChanged', async () => {
    const capabilities = (await conectar()).getServerCapabilities();

    expect(capabilities?.prompts).toEqual({});
    expect(capabilities?.resources).toEqual({});
    // O SDK declararia `listChanged: true` sozinho se os handlers viessem de
    // `registerResource`. Não há notificação para cumprir a promessa: admin e
    // mcp-public são processos separados.
    expect(capabilities?.prompts).not.toHaveProperty('listChanged');
    expect(capabilities?.resources).not.toHaveProperty('listChanged');
  });

  it('anuncia as duas mesmo sem nenhuma skill flagada, sem consultar o banco', async () => {
    await conectar();

    expect(db.listPublishedSkills).not.toHaveBeenCalled();
  });

  it('mantém as ferramentas registradas ao lado das superfícies novas', async () => {
    const { tools } = await (await conectar()).listTools();

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['search_skills', 'get_skill', 'download_skill']),
    );
  });
});

describe('métodos das superfícies', () => {
  it('responde prompts/list e resources/list com o catálogo flagado', async () => {
    db.listPublishedSkills.mockResolvedValue([
      { slug: 'minha-skill', name: 'Minha Skill', description: 'Faz coisas' },
    ]);
    const client = await conectar();

    expect((await client.listPrompts()).prompts[0].name).toBe('minha-skill');
    expect((await client.listResources()).resources[0].uri).toBe('skill://minha-skill/SKILL.md');
  });

  // A lista é computada por requisição justamente para isto: não há
  // `listChanged`, e uma lista congelada no `initialize` só voltaria a mudar na
  // sessão seguinte — até 30 minutos depois, pelo TTL padrão.
  it('enxerga uma skill publicada agora, na mesma sessão', async () => {
    const client = await conectar();
    expect((await client.listPrompts()).prompts).toEqual([]);

    db.listPublishedSkills.mockResolvedValue([
      { slug: 'recem-publicada', name: 'Recém-publicada', description: '' },
    ]);

    expect((await client.listPrompts()).prompts[0].name).toBe('recem-publicada');
  });

  it('responde resources/templates/list vazio em vez de "method not found"', async () => {
    const client = await conectar();

    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
  });

  it('devolve erro de protocolo, não um resultado, para skill não publicada', async () => {
    db.getSkillDetail.mockResolvedValue(null);
    const client = await conectar();

    await expect(client.readResource({ uri: 'skill://nao-existe/SKILL.md' })).rejects.toThrow(
      /não encontrado/,
    );
  });
});

describe('identidade do servidor', () => {
  const scope = {
    mcp: { uuid: 'mcp-2', slug: 'time-a', name: 'Time A', description: 'Skills do projeto X.', isOpen: false },
    baseUrl: 'https://mcp.exemplo.dev/virtual/time-a',
  };

  it('sufixa o nome do servidor com o slug e leva a descrição às instruções', async () => {
    const client = await conectar(scope);

    expect(client.getServerVersion()?.name).toBe('purple-skills-time-a');
    expect(client.getInstructions()).toContain('Skills do projeto X.');
    expect(client.getInstructions()).toContain('search_skills');
  });

  // A raiz é o vMCP padrão: mesmo nome sufixado e as mesmas instruções que
  // ele tem em /virtual/<slug>. Não existe mais um "catálogo completo" à parte.
  it('na raiz, o vMCP padrão se apresenta como em /virtual/<slug>', async () => {
    const client = await conectar(raiz);

    expect(client.getServerVersion()?.name).toBe('purple-skills-public');
    expect(client.getInstructions()).not.toMatch(/catálogo completo|MCP principal/);
  });

  it('oferece as mesmas ferramentas e superfícies em qualquer ponto de montagem', async () => {
    const client = await conectar(scope);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['search_skills', 'get_skill', 'get_skill_file', 'download_skill', 'list_tags']),
    );
    expect(client.getServerCapabilities()?.prompts).toEqual({});
  });
});

/**
 * O teto da consulta é corte, não recusa: quem descreve a tarefa com folga —
 * que é o que esta ferramenta pede — continua recebendo resultado, e o schema
 * anuncia o corte para o cliente não supor que a consulta inteira foi buscada.
 */
describe('o teto da consulta de search_skills', () => {
  // O número anunciado é o da constante — aqui, o do mock —, não um literal.
  it('anuncia o corte na descrição do argumento, com o número que o servidor aplica', async () => {
    const { tools } = await (await conectar()).listTools();
    const busca = tools.find((tool) => tool.name === 'search_skills');

    expect(JSON.stringify(busca?.inputSchema)).toContain(`Above ${TETO_DA_CONSULTA} characters`);
    expect(JSON.stringify(busca?.inputSchema)).not.toContain('200 caracteres');
  });

  it('aceita consulta longa e busca só o trecho cortado, em vez de recusar a chamada', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0, mode: 'text' });
    const client = await conectar();

    const resposta = await client.callTool({
      name: 'search_skills',
      arguments: { query: 'padronizar a mensagem de commit '.repeat(20) },
    });

    expect(resposta.isError).toBeFalsy();
    // O corte é no mesmo número que a descrição anunciou.
    const cortada = db.listSkills.mock.calls[0][0].query as string;
    expect(cortada.length).toBeLessThanOrEqual(TETO_DA_CONSULTA);
    expect(cortada.length).toBeGreaterThan(TETO_DA_CONSULTA - 32);
  });
});

/**
 * A exclusão com hífen é só da perna textual: na híbrida o vizinho excluído
 * volta pelo vetor (relatório 062 da auditoria de 2026-09-19; o comportamento
 * está fixado em `search.integration.test.ts`). A descrição da tool é o que um
 * agente lê antes de agir, e dizia "continuam valendo" — hoje, em inglês,
 * "still apply".
 */
describe('a descrição de search_skills não promete o que a busca híbrida não cumpre', () => {
  it('diz que aspas e hífen valem na busca por texto, e o que muda com mode "hybrid"', async () => {
    const { tools } = await (await conectar()).listTools();
    const descricao = tools.find((tool) => tool.name === 'search_skills')?.description ?? '';

    expect(descricao).not.toContain('still apply');
    expect(descricao).toContain('apply to the text search');
    expect(descricao).toContain('mode "hybrid"');
    expect(descricao).toContain('may bring back a skill that the hyphen excluded');
  });
});

/**
 * O caminho completo, pelo transporte: é o `McpServer` do SDK que embrulha a
 * exceção de um handler, e ele monta o `isError` com a `message` crua. Sem o
 * `guard` do `tools.ts`, a mensagem do driver — com tabela, índice e constraint
 * — chega ao cliente, que aqui é anônimo por padrão.
 */
describe('erro inesperado numa chamada', () => {
  it('a ferramenta responde erro genérico com referência, e o detalhe fica no log', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.listTags.mockRejectedValue(new Error('relation "skill_tags" does not exist'));
    const client = await conectar();

    const resposta = await client.callTool({ name: 'list_tags', arguments: {} });
    const corpo = JSON.stringify(resposta.content);

    expect(resposta.isError).toBe(true);
    expect(corpo).not.toContain('skill_tags');
    expect(corpo).not.toContain('does not exist');
    const ref = /ref ([0-9a-f]{8})/.exec(corpo)?.[1];
    expect(ref).toBeDefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`ref ${ref}`), expect.any(Error));

    log.mockRestore();
  });

  it('a superfície de resource devolve erro de protocolo genérico, não a mensagem do driver', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.getSkillDetail.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "skills_slug_lower_uniq"'),
    );
    const client = await conectar();

    const erro = await client
      .readResource({ uri: 'skill://minha-skill/SKILL.md' })
      .catch((err: Error) => err);

    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).not.toContain('skills_slug_lower_uniq');
    expect((erro as Error).message).toMatch(/Erro interno do servidor \(ref [0-9a-f]{8}\)/);

    log.mockRestore();
  });
});

// ------------------------------------------- extensão de skills (SEP-2640) --

/**
 * Os três métodos novos não existem no SDK 1.30.0, então o cliente os chama
 * como qualquer cliente de fora faria: `request` com o método e um schema.
 *
 * Os campos da revisão 2026-07-28 entram aqui **opcionais** de propósito: quem
 * cobra a presença deles é a asserção de cada caso, não o parse — um schema que
 * os exigisse transformaria a ausência num erro de validação do cliente, em vez
 * de um teste que aponta o campo que faltou.
 */
const camposDeCache = {
  resultType: z.string().optional(),
  ttlMs: z.number().optional(),
  cacheScope: z.string().optional(),
};

const EntradaSchema = z.object({
  uri: z.string(),
  frontmatter: z.record(z.unknown()),
  resources: z.union([
    z.array(z.object({ uri: z.string(), digest: z.string(), size: z.number() })),
    z.literal('dynamic'),
  ]),
});

const ListaDeSkillsSchema = z.object({ ...camposDeCache, skills: z.array(EntradaSchema) }).passthrough();
const SkillSchema = z.object({ ...camposDeCache, skill: EntradaSchema }).passthrough();
const DiretorioSchema = z
  .object({
    ...camposDeCache,
    resources: z.array(z.object({ uri: z.string(), name: z.string(), mimeType: z.string() })),
  })
  .passthrough();

const listarSkills = (client: Client) =>
  client.request({ method: 'skills/list', params: {} }, ListaDeSkillsSchema);
const pegarSkill = (client: Client, uri: string) =>
  client.request({ method: 'skills/get', params: { uri } }, SkillSchema);
const lerDiretorio = (client: Client, uri: string) =>
  client.request({ method: 'resources/directory/read', params: { uri } }, DiretorioSchema);

/**
 * O primeiro conteúdo de uma leitura. O SDK tipa `contents` como união de
 * texto e blob, e cada caso abaixo sabe qual dos dois pediu.
 */
const conteudo = (lido: { contents: unknown[] }) =>
  lido.contents[0] as { uri: string; mimeType?: string; text?: string; blob?: string };

const CORPO = '# Minha Skill\n\nConteúdo.';

/** A skill como `listSkillsManifest` a devolve: SKILL.md primeiro, sem corpo. */
const manifesto = {
  uuid: 'uuid-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  tags: ['git', 'ci'],
  updatedAt: '2026-01-02T00:00:00.000Z',
  files: [
    // O sha256 da linha do SKILL.md é o do **corpo gravado**, sem frontmatter:
    // é justamente o que não pode ser publicado (§5.2 do `docs/17`).
    { relativePath: 'SKILL.md', sizeBytes: Buffer.byteLength(CORPO), sha256: 'a'.repeat(64) },
    { relativePath: 'ref/extra.md', sizeBytes: 10, sha256: 'b'.repeat(64) },
  ],
};

/** A mesma skill como `getSkillDetail` a devolve para a leitura — os mesmos metadados. */
const detalhe = {
  uuid: manifesto.uuid,
  slug: manifesto.slug,
  name: manifesto.name,
  description: manifesto.description,
  tags: manifesto.tags,
  skillMd: CORPO,
  mcps: [],
  files: [],
};

const sumario = { uuid: manifesto.uuid, slug: manifesto.slug, name: manifesto.name, mcps: [] };

/** A outra skill do mock: vinculada **só** como resource, para as portas não se confundirem. */
const soResource = { uuid: 'uuid-2', slug: 'so-resource', name: 'Só Resource' };

/** O que uma leitura recortada recebe, para o mock saber por qual porta perguntaram. */
type RecorteDeLeitura = { virtualMcp: { uuid: string; surface: string } };

/**
 * O recorte do banco, no mock, com as duas portas separadas: `minha-skill` está
 * no `mcp-1` com `as_skill`, e `so-resource` está lá **só** como resource.
 *
 * É o que faz os quatro casos de recusa — skill de outro vMCP, skill
 * só-`as_resource`, skill inativa e slug inexistente — caírem todos no mesmo "a
 * consulta não devolveu nada", que é como o banco os entrega; e é o que faz uma
 * troca de porta no recorte aparecer como skill servida onde não devia, em vez
 * de passar.
 */
function recorteNoMock() {
  // `listSkillsManifest` já filtra `as_skill` no SQL: `so-resource` nunca sai.
  db.listSkillsManifest.mockImplementation(async (uuid: string, options: { slug?: string } = {}) => {
    const visiveis = uuid === 'mcp-1' ? [manifesto] : [];
    return options.slug === undefined ? visiveis : visiveis.filter((s) => s.slug === options.slug);
  });
  db.readSkillMdBodies.mockImplementation(async (uuids: readonly string[]) =>
    uuids.includes(manifesto.uuid) ? [{ skillUuid: manifesto.uuid, body: CORPO }] : [],
  );

  const porta = (slug: string, { virtualMcp }: RecorteDeLeitura) =>
    virtualMcp.uuid === 'mcp-1' &&
    ((slug === manifesto.slug && virtualMcp.surface === 'skill') ||
      (slug === soResource.slug && virtualMcp.surface === 'resource'));

  db.getSkillSummary.mockImplementation(async (slug: string, options: RecorteDeLeitura) =>
    porta(slug, options) ? (slug === manifesto.slug ? sumario : { ...soResource, mcps: [] }) : null,
  );
  db.getSkillDetail.mockImplementation(async (slug: string, options: RecorteDeLeitura) =>
    porta(slug, options) ? (slug === manifesto.slug ? detalhe : { ...detalhe, ...soResource }) : null,
  );

  // Os dois respondem a qualquer skill: quem recorta é o passo acima. É o que
  // faz uma leitura pela porta errada **entregar** o arquivo, e o caso morrer.
  db.listFiles.mockResolvedValue([
    { relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 24, isText: true },
    { relativePath: 'ref/extra.md', mimeType: 'text/markdown', sizeBytes: 10, isText: true },
  ]);
  db.readFile.mockResolvedValue({
    relativePath: 'ref/extra.md',
    mimeType: 'text/markdown',
    sizeBytes: 10,
    isText: true,
    buffer: Buffer.from('extra'),
  });
}

beforeEach(() => {
  cacheDeDigesto.limpar();
  recorteNoMock();
});

describe('a capability da extensão', () => {
  it('anuncia a extensão de skills com directoryRead, sem consultar o banco', async () => {
    const capabilities = (await conectar()).getServerCapabilities();

    expect(capabilities?.extensions).toEqual({
      'io.modelcontextprotocol/skills': { directoryRead: true },
    });
    expect(db.listSkillsManifest).not.toHaveBeenCalled();
  });

  /**
   * As `instructions` são o único ponteiro que o agente tem para as portas que
   * não são ferramenta — e as cinco ferramentas continuam anunciadas ali, porque
   * cliente sem a extensão (hoje, quase todo) segue atendido (decisão 22).
   */
  it('as instructions apontam a extensão sem abandonar as ferramentas', async () => {
    const instrucoes = (await conectar()).getInstructions() ?? '';

    expect(instrucoes).toContain('io.modelcontextprotocol/skills');
    expect(instrucoes).toContain('skills/list');
    expect(instrucoes).toContain('skill://<slug>/SKILL.md');
    expect(instrucoes).toContain('search_skills');
  });
});

/**
 * As três invariantes que, se quebrarem, quebram **em silêncio**: nada deste
 * repositório lê o digest nem o frontmatter de volta, e a recusa indistinta é
 * indistinta justamente por não dizer o que aconteceu. Quem perceberia seria o
 * host de outra pessoa — ou ninguém.
 */
describe('as invariantes da extensão', () => {
  it('o digest publicado é o do conteúdo que a leitura entrega, e o tamanho também', async () => {
    const client = await conectar();

    const { skills } = await listarSkills(client);
    const entrada = skills[0];
    const doSkillMd =
      entrada.resources === 'dynamic'
        ? undefined
        : entrada.resources.find((recurso) => recurso.uri === entrada.uri);

    const lido = await client.readResource({ uri: entrada.uri });
    const texto = conteudo(lido).text as string;

    expect(doSkillMd?.digest).toBe(`sha256:${createHash('sha256').update(texto, 'utf8').digest('hex')}`);
    expect(doSkillMd?.size).toBe(Buffer.byteLength(texto, 'utf8'));
    // E não é o hash do corpo gravado, que é o que o banco tem na mão.
    expect(doSkillMd?.digest).not.toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('o frontmatter da entrada é idêntico ao YAML daquele mesmo conteúdo', async () => {
    const client = await conectar();

    const { skills } = await listarSkills(client);
    const frontmatter = skills[0].frontmatter as {
      name: string;
      description: string;
      metadata?: Record<string, string>;
    };

    const lido = await client.readResource({ uri: skills[0].uri });
    const { data } = parseFrontmatter(conteudo(lido).text as string);

    expect(data.name).toBe(frontmatter.name);
    expect(data.description).toBe(frontmatter.description);
    expect(data.title).toBe(frontmatter.metadata?.title);
    expect(data.tags).toBe(frontmatter.metadata?.tags);
    // As tags são string, como o YAML as escreve — não lista (decisão 14).
    expect(frontmatter.metadata?.tags).toBe('git, ci');
  });

  it('o recorte não vaza: os quatro casos respondem a mesma recusa nas três portas', async () => {
    const client = await conectar();
    // Skill de outro vMCP, skill só-`as_resource`, skill inativa e slug
    // inexistente: nenhuma delas existe para este recorte, e nenhuma pode ser
    // distinguida das outras — é o que não entrega slug privado a quem sonda um
    // servidor que pode estar aberto (`§5.5` do `docs/06`).
    const fora = ['de-outro-vmcp', 'so-resource', 'inativa', 'nao-existe'];
    const recusa = (err: Error, slug: string) => err.message.replaceAll(slug, '<slug>');

    const porPorta = await Promise.all(
      fora.map(async (slug) => ({
        skill: await pegarSkill(client, `skill://${slug}/SKILL.md`).catch((err: Error) =>
          recusa(err, slug),
        ),
        arquivo: await client
          .readResource({ uri: `skill://${slug}/ref/extra.md` })
          .catch((err: Error) => recusa(err, slug)),
        diretorio: await lerDiretorio(client, `skill://${slug}`).catch((err: Error) =>
          recusa(err, slug),
        ),
      })),
    );

    expect(porPorta[0]).toEqual({
      skill: expect.stringContaining('-32602: Skill não encontrada: "skill://<slug>/SKILL.md"'),
      arquivo: expect.stringContaining(
        '-32602: Resource não encontrado: "skill://<slug>/ref/extra.md"',
      ),
      diretorio: expect.stringContaining('-32602: Diretório não encontrado: "skill://<slug>"'),
    });
    // Tirado o que o cliente mandou, sobra uma mensagem só por porta.
    for (const resposta of porPorta) expect(resposta).toEqual(porPorta[0]);
  });
});

describe('skills/list', () => {
  it('publica a entrada com a URI do SKILL.md, o frontmatter e o inventário completo', async () => {
    const client = await conectar();

    const { skills } = await listarSkills(client);

    expect(skills).toHaveLength(1);
    expect(skills[0].uri).toBe('skill://minha-skill/SKILL.md');
    expect(skills[0].resources).toEqual([
      { uri: 'skill://minha-skill/SKILL.md', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), size: expect.any(Number) },
      // O arquivo de apoio traz o hash e o tamanho gravados, sem leitura nenhuma.
      { uri: 'skill://minha-skill/ref/extra.md', digest: `sha256:${'b'.repeat(64)}`, size: 10 },
    ]);
  });

  it('não pagina nem trunca, e ignora o cursor que o cliente mandar', async () => {
    const client = await conectar();

    const pagina = await client.request(
      { method: 'skills/list', params: { cursor: 'o-que-for' } },
      ListaDeSkillsSchema,
    );

    expect(pagina.skills).toHaveLength(1);
    expect(pagina).not.toHaveProperty('nextCursor');
  });

  it('deixa de fora a skill sem linha de SKILL.md, que não teria o que servir', async () => {
    db.listSkillsManifest.mockResolvedValue([
      { ...manifesto, uuid: 'uuid-2', slug: 'sem-skill-md', files: [manifesto.files[1]] },
      manifesto,
    ]);
    const client = await conectar();

    const { skills } = await listarSkills(client);

    expect(skills.map((skill) => skill.uri)).toEqual(['skill://minha-skill/SKILL.md']);
  });

  it('mantém a ordem que veio do banco, sem reordenar', async () => {
    db.listSkillsManifest.mockResolvedValue([
      { ...manifesto, uuid: 'uuid-a', slug: 'alfa' },
      { ...manifesto, uuid: 'uuid-b', slug: 'beta' },
    ]);
    db.readSkillMdBodies.mockResolvedValue([
      { skillUuid: 'uuid-b', body: CORPO },
      { skillUuid: 'uuid-a', body: CORPO },
    ]);
    const client = await conectar();

    const { skills } = await listarSkills(client);

    // O lote de corpos volta sem ordem definida (é assim que o banco o
    // documenta): o casamento é pelo uuid, e a listagem segue a ordem do slug.
    expect(skills.map((skill) => skill.uri)).toEqual([
      'skill://alfa/SKILL.md',
      'skill://beta/SKILL.md',
    ]);
  });
});

describe('skills/get', () => {
  it('devolve a mesma entrada de skills/list, pela URI do SKILL.md', async () => {
    const client = await conectar();

    const { skills } = await listarSkills(client);
    const { skill } = await pegarSkill(client, 'skill://minha-skill/SKILL.md');

    expect(skill).toEqual(skills[0]);
    expect(db.listSkillsManifest).toHaveBeenLastCalledWith('mcp-1', { slug: 'minha-skill' });
  });

  it('recusa a URI que não é de um SKILL.md — diretório, arquivo de apoio, outro esquema', async () => {
    const client = await conectar();

    for (const uri of [
      'skill://minha-skill',
      'skill://minha-skill/ref/extra.md',
      'https://exemplo.dev/minha-skill/SKILL.md',
    ]) {
      await expect(pegarSkill(client, uri)).rejects.toThrow(/-32602: Skill não encontrada/);
    }
  });
});

describe('o manifesto do SKILL.md', () => {
  const TETO = 4 * 1024 * 1024;

  it('vira "dynamic" quando o corpo gravado já passa do teto — sem ler o corpo', async () => {
    db.listSkillsManifest.mockResolvedValue([
      { ...manifesto, files: [{ ...manifesto.files[0], sizeBytes: TETO + 1 }, manifesto.files[1]] },
    ]);
    const client = await conectar();

    const { skills } = await listarSkills(client);

    expect(skills[0].resources).toBe('dynamic');
    // O ponto inteiro da verificação por tamanho: não carregar para hashear o
    // que a leitura vai recusar em seguida.
    expect(db.readSkillMdBodies).not.toHaveBeenCalled();
  });

  it('vira "dynamic" também quando é o frontmatter que estoura o teto', async () => {
    const corpoNoTeto = 'a'.repeat(TETO);
    db.listSkillsManifest.mockResolvedValue([
      { ...manifesto, files: [{ ...manifesto.files[0], sizeBytes: TETO }, manifesto.files[1]] },
    ]);
    db.readSkillMdBodies.mockResolvedValue([{ skillUuid: manifesto.uuid, body: corpoNoTeto }]);
    const client = await conectar();

    const { skills } = await listarSkills(client);

    // O corpo cabia; o composto não — e é o composto que a leitura devolve.
    expect(db.readSkillMdBodies).toHaveBeenCalledTimes(1);
    expect(skills[0].resources).toBe('dynamic');
  });
});

describe('o cache do digest', () => {
  it('não relê o corpo enquanto o updatedAt não muda, e relê quando muda', async () => {
    const client = await conectar();

    await listarSkills(client);
    await listarSkills(client);
    expect(db.readSkillMdBodies).toHaveBeenCalledTimes(1);

    // Toda escrita na skill — inclusive uma troca só de tags, que muda o
    // frontmatter — empurra `updated_at`, e é isso que invalida a entrada.
    db.listSkillsManifest.mockResolvedValue([{ ...manifesto, updatedAt: '2026-01-03T00:00:00.000Z' }]);
    await listarSkills(client);

    expect(db.readSkillMdBodies).toHaveBeenCalledTimes(2);
  });

  it('é do processo, não da instância: outro servidor aproveita a medida', async () => {
    await listarSkills(await conectar());
    await listarSkills(await conectar());

    expect(db.readSkillMdBodies).toHaveBeenCalledTimes(1);
  });
});

describe('resources/read por arquivo', () => {
  it('lê o SKILL.md composto e conta um acesso', async () => {
    const client = await conectar();

    const lido = await client.readResource({ uri: 'skill://minha-skill/SKILL.md' });

    expect(conteudo(lido).mimeType).toBe('text/markdown');
    expect(conteudo(lido).text).toBe(composeSkillMd(detalhe, CORPO));
    expect(db.recordSkillAccess).toHaveBeenCalledWith(
      expect.objectContaining({ skillUuid: 'uuid-1', kind: 'view', surface: 'resource' }),
    );
  });

  /**
   * A linha que importa da `§4.2`: o `SKILL.md` é legível pelas **duas** portas
   * — senão `skills/list` anunciaria uma URI que a leitura recusa —, e a porta
   * de resource para exatamente nele. O resto da árvore é `as_skill`.
   */
  it('a skill só-as_resource entrega o SKILL.md, e nada além dele', async () => {
    const client = await conectar();

    const lido = await client.readResource({ uri: 'skill://so-resource/SKILL.md' });
    expect(conteudo(lido).text).toBe(composeSkillMd({ ...detalhe, ...soResource }, CORPO));

    await expect(client.readResource({ uri: 'skill://so-resource/ref/extra.md' })).rejects.toThrow(
      /-32602: Resource não encontrado/,
    );
    await expect(lerDiretorio(client, 'skill://so-resource')).rejects.toThrow(
      /-32602: Diretório não encontrado/,
    );
    // E ela não é skill deste servidor: não aparece na listagem nem por URI.
    expect((await listarSkills(client)).skills.map((skill) => skill.uri)).toEqual([
      'skill://minha-skill/SKILL.md',
    ]);
    await expect(pegarSkill(client, 'skill://so-resource/SKILL.md')).rejects.toThrow(
      /-32602: Skill não encontrada/,
    );
  });

  it('devolve o arquivo binário em blob, e não conta acesso', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    db.readFile.mockResolvedValue({
      relativePath: 'img/logo.png',
      mimeType: 'image/png',
      sizeBytes: bytes.byteLength,
      isText: false,
      buffer: bytes,
    });
    const client = await conectar();

    const lido = await client.readResource({ uri: 'skill://minha-skill/img/logo.png' });

    expect(conteudo(lido).blob).toBe(bytes.toString('base64'));
    expect(conteudo(lido)).not.toHaveProperty('text');
    expect(conteudo(lido).mimeType).toBe('image/png');
    // Arquivo de apoio não conta acesso (decisão 13).
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
  });

  it('recusa travessia de diretório na URI, sem chegar a consultar o banco', async () => {
    const client = await conectar();

    await expect(
      client.readResource({ uri: 'skill://minha-skill/../outra/SKILL.md' }),
    ).rejects.toThrow(/-32602: Resource não encontrado/);
    await expect(lerDiretorio(client, 'skill://minha-skill/..')).rejects.toThrow(
      /-32602: Diretório não encontrado/,
    );

    expect(db.getSkillSummary).not.toHaveBeenCalled();
    expect(db.readFile).not.toHaveBeenCalled();
  });

  it('recusa o diretório: a URI antiga skill://<slug> não é mais o SKILL.md', async () => {
    const client = await conectar();

    await expect(client.readResource({ uri: 'skill://minha-skill' })).rejects.toThrow(
      /-32602: Resource não encontrado/,
    );
    expect(db.getSkillDetail).not.toHaveBeenCalled();
  });

  it('o caminho com caractere especial sobrevive à ida e à volta', async () => {
    db.listFiles.mockResolvedValue([
      { relativePath: 'ref/a b#c?.md', mimeType: 'text/markdown', sizeBytes: 3, isText: true },
    ]);
    db.readFile.mockResolvedValue({
      relativePath: 'ref/a b#c?.md',
      mimeType: 'text/markdown',
      sizeBytes: 3,
      isText: true,
      buffer: Buffer.from('oi'),
    });
    const client = await conectar();

    const [filho] = (await lerDiretorio(client, 'skill://minha-skill/ref')).resources;
    const lido = await client.readResource({ uri: filho.uri });

    expect(filho.uri).toBe('skill://minha-skill/ref/a%20b%23c%3F.md');
    expect(conteudo(lido).text).toBe('oi');
    expect(db.readFile).toHaveBeenCalledWith('uuid-1', 'ref/a b#c?.md');
  });
});

describe('resources/directory/read', () => {
  // Fora de ordem de propósito: quem ordena a resposta é o servidor, e a ordem
  // em que os arquivos chegam não pode decidir a ordem em que eles saem.
  const arquivos = [
    { relativePath: 'templates/regional/eu.md', mimeType: 'text/markdown', sizeBytes: 6, isText: true },
    { relativePath: 'img/logo.png', mimeType: 'image/png', sizeBytes: 4, isText: false },
    { relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 24, isText: true },
    { relativePath: 'templates/invoice.md', mimeType: 'text/markdown', sizeBytes: 5, isText: true },
  ];

  beforeEach(() => {
    db.listFiles.mockResolvedValue(arquivos);
  });

  it('devolve os filhos diretos da raiz, com subdiretório marcado inode/directory', async () => {
    const client = await conectar();

    const { resources } = await lerDiretorio(client, 'skill://minha-skill');

    expect(resources).toEqual([
      { uri: 'skill://minha-skill/SKILL.md', name: 'SKILL.md', mimeType: 'text/markdown' },
      { uri: 'skill://minha-skill/img', name: 'img', mimeType: 'inode/directory' },
      { uri: 'skill://minha-skill/templates', name: 'templates', mimeType: 'inode/directory' },
    ]);
  });

  it('não é recursivo: o neto só aparece quando se desce nele', async () => {
    const client = await conectar();

    const { resources } = await lerDiretorio(client, 'skill://minha-skill/templates');

    expect(resources).toEqual([
      { uri: 'skill://minha-skill/templates/invoice.md', name: 'invoice.md', mimeType: 'text/markdown' },
      { uri: 'skill://minha-skill/templates/regional', name: 'regional', mimeType: 'inode/directory' },
    ]);
    expect(JSON.stringify(resources)).not.toContain('eu.md');
  });

  it('diretório que não existe é a mesma recusa, e a raiz de uma skill válida sempre existe', async () => {
    const client = await conectar();

    await expect(lerDiretorio(client, 'skill://minha-skill/nao-existe')).rejects.toThrow(
      /-32602: Diretório não encontrado/,
    );

    db.listFiles.mockResolvedValue([]);
    expect((await lerDiretorio(client, 'skill://minha-skill')).resources).toEqual([]);
  });

  it('não conta acesso: listar diretório é catálogo, não leitura', async () => {
    const client = await conectar();

    await lerDiretorio(client, 'skill://minha-skill');

    expect(db.recordSkillAccess).not.toHaveBeenCalled();
  });
});

/**
 * Os campos da revisão 2026-07-28 (decisões 17 a 20): eles vão escritos à mão,
 * porque o SDK 1.30.0 fala 2025-11-25 e não os tem.
 */
describe('os campos de cache do protocolo', () => {
  it('estão nas listagens e nas leituras, com ttlMs zero e o escopo do vMCP', async () => {
    const client = await conectar();
    db.listPublishedSkills.mockResolvedValue([
      { slug: 'minha-skill', name: 'Minha Skill', description: 'Faz coisas' },
    ]);

    const respostas = [
      await client.listPrompts(),
      await client.listResources(),
      await client.listResourceTemplates(),
      await client.readResource({ uri: 'skill://minha-skill/SKILL.md' }),
      await listarSkills(client),
      await pegarSkill(client, 'skill://minha-skill/SKILL.md'),
      await lerDiretorio(client, 'skill://minha-skill'),
    ];

    for (const resposta of respostas) {
      // Zero, e não um número qualquer: a lista é recomputada a cada
      // requisição, e prometer validade seria a mesma promessa que o
      // `listChanged` recusou fazer.
      expect(resposta).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'public' });
    }
  });

  it('prompts/get leva só o resultType — ele não é um dos métodos com cache', async () => {
    db.listPublishedSkills.mockResolvedValue([
      { slug: 'minha-skill', name: 'Minha Skill', description: 'Faz coisas' },
    ]);
    db.getSkillDetail.mockResolvedValue(detalhe);
    const client = await conectar();

    const prompt = await client.getPrompt({ name: 'minha-skill' });

    expect(prompt).toMatchObject({ resultType: 'complete' });
    expect(prompt).not.toHaveProperty('ttlMs');
    expect(prompt).not.toHaveProperty('cacheScope');
  });

  it('num vMCP fechado o escopo é privado: chave é chave', async () => {
    const fechado = {
      mcp: { uuid: 'mcp-1', slug: 'time-a', name: 'Time A', description: '', isOpen: false },
      baseUrl: 'https://mcp.exemplo.dev/virtual/time-a',
    };

    expect(await listarSkills(await conectar(fechado))).toMatchObject({ cacheScope: 'private' });
  });
});
