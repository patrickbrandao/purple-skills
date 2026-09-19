import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
}));

vi.mock('@purple-skills/db', () => ({ ...db, AppError }));

const { createMcpServer } = await import('./server.js');

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
    expect((await client.listResources()).resources[0].uri).toBe('skill://minha-skill');
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

    await expect(client.readResource({ uri: 'skill://nao-existe' })).rejects.toThrow(
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
  it('anuncia o corte na descrição do argumento', async () => {
    const { tools } = await (await conectar()).listTools();
    const busca = tools.find((tool) => tool.name === 'search_skills');

    expect(JSON.stringify(busca?.inputSchema)).toContain('200 caracteres');
  });

  it('aceita consulta longa e busca só o trecho cortado, em vez de recusar a chamada', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0, mode: 'text' });
    const client = await conectar();

    const resposta = await client.callTool({
      name: 'search_skills',
      arguments: { query: 'padronizar a mensagem de commit '.repeat(20) },
    });

    expect(resposta.isError).toBeFalsy();
    expect((db.listSkills.mock.calls[0][0].query as string).length).toBeLessThanOrEqual(200);
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
      .readResource({ uri: 'skill://minha-skill' })
      .catch((err: Error) => err);

    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).not.toContain('skills_slug_lower_uniq');
    expect((erro as Error).message).toMatch(/Erro interno do servidor \(ref [0-9a-f]{8}\)/);

    log.mockRestore();
  });
});
