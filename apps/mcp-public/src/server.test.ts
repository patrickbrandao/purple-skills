import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const db = vi.hoisted(() => ({
  listSkills: vi.fn(),
  listPublishedSkills: vi.fn(),
  getSkillDetail: vi.fn(),
  getSkillSummary: vi.fn(),
  incrementViewCount: vi.fn(),
  listTags: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@purple-skills/db', () => db);

const { createMcpServer } = await import('./server.js');

/** Cliente ligado a um servidor novo pelo transporte em memória. */
async function conectar(scope?: Parameters<typeof createMcpServer>[0]) {
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

describe('servidor de um MCP virtual', () => {
  const scope = {
    mcp: { uuid: 'mcp-1', slug: 'time-a', name: 'Time A', description: 'Skills do projeto X.', isOpen: false },
    baseUrl: 'https://mcp.exemplo.dev/virtual/time-a',
  };

  it('sufixa o nome do servidor com o slug e leva a descrição às instruções', async () => {
    const client = await conectar(scope);

    expect(client.getServerVersion()?.name).toBe('purple-skills-time-a');
    expect(client.getInstructions()).toContain('Skills do projeto X.');
    expect(client.getInstructions()).toContain('search_skills');
  });

  it('oferece as mesmas ferramentas e superfícies do principal', async () => {
    const client = await conectar(scope);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['search_skills', 'get_skill', 'get_skill_file', 'download_skill', 'list_tags']),
    );
    expect(client.getServerCapabilities()?.prompts).toEqual({});
  });
});
