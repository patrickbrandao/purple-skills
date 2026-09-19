import type { Request, RequestHandler, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

/**
 * O site responde a quem não tem login: o JSON dele é **lista de permissão**
 * (`skillPublica` do `api.ts`). Estes testes cobram a lista campo por campo —
 * falham quando um campo novo de `SkillSummary` chega ao visitante anônimo sem
 * que alguém tenha decidido que pode, que é como o e-mail do dono e as
 * concessões vazaram (`tasks/002`).
 */

/** O erro de negócio do `@purple-skills/db`, como o `fail` o reconhece. */
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
  getSkillDetail: vi.fn(),
  getSkillSummary: vi.fn(),
  getPublicCatalog: vi.fn(),
  listPublicCatalogs: vi.fn(),
  listOpenVirtualMcps: vi.fn(),
  resolveDefaultVirtualMcp: vi.fn(),
  recordSkillAccess: vi.fn(async () => undefined),
  readAllFiles: vi.fn(),
  readFile: vi.fn(),
  listTags: vi.fn(),
  healthCheck: vi.fn(async () => true),
}));

vi.mock('@purple-skills/db', () => ({ ...db, AppError }));

const { api } = await import('./api.js');

/**
 * Um vMCP como o banco o devolve na visibilidade do site: aberto e ligado, com
 * o caminho do vínculo (`direct`) e o catálogo por onde a skill chega — que
 * pode ser privado, basta estar ligado.
 */
const VMCP = {
  uuid: 'mcp-1',
  slug: 'public',
  name: 'Público',
  isOpen: true,
  isActive: true,
  isDefault: true,
  asSkill: true,
  asPrompt: false,
  asResource: false,
  direct: false,
  catalogs: [{ uuid: 'cat-9', slug: 'clientes-acme', name: 'Clientes Acme' }],
};

/** `SkillSummary` inteira, como `skillColumns` a monta — inclusive o dono. */
const SUMMARY = {
  uuid: 'skill-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  icon: '🛠️',
  isActive: true,
  isPublic: true,
  ownerUserUuid: '11111111-1111-4111-8111-111111111111',
  ownerEmail: 'dona@exemplo.dev',
  access: null,
  mcps: [VMCP],
  catalogs: [],
  viewCount: 10,
  downloadCount: 3,
  score: 13,
  tags: ['git'],
  fileCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

/** Uma concessão, que `getSkillDetail` anexa em qualquer visibilidade. */
const GRANT = {
  userUuid: '22222222-2222-4222-8222-222222222222',
  email: 'colega@exemplo.dev',
  name: 'Colega',
  role: 'membro',
  level: 'manage',
  grantedByUserUuid: '11111111-1111-4111-8111-111111111111',
  grantedByEmail: 'dona@exemplo.dev',
  createdAt: '2026-01-03T00:00:00.000Z',
};

const DETAIL = {
  ...SUMMARY,
  skillMd: '---\nname: minha-skill\ndescription: Faz coisas\n---\n\n# Minha Skill\n',
  files: [{ relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 24, isText: true }],
  grants: [GRANT],
};

/** Exatamente o que o anônimo vê de uma skill. */
const CAMPOS_DA_SKILL = [
  'createdAt',
  'description',
  'downloadCount',
  'fileCount',
  'icon',
  'mcps',
  'name',
  'score',
  'slug',
  'tags',
  'updatedAt',
  'uuid',
  'viewCount',
];

/** E de cada vMCP: sem `direct` nem `catalogs`. */
const CAMPOS_DO_VMCP = [
  'asPrompt',
  'asResource',
  'asSkill',
  'isActive',
  'isDefault',
  'isOpen',
  'name',
  'slug',
  'uuid',
];

/** Os campos que não podem sair em nenhuma das rotas anônimas. */
const PROIBIDOS = ['ownerUserUuid', 'ownerEmail', 'grants', 'access', 'isPublic', 'isActive', 'catalogs'];

type Rota = { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] };

/** O handler final da rota, pela pilha do Router (como em `admin/src/routes.test.ts`). */
function handler(path: string): RequestHandler {
  const camadas = (api as unknown as { stack: { route?: Rota }[] }).stack;
  const achada = camadas.find((camada) => camada.route?.path === path && camada.route.methods.get);
  if (!achada?.route) throw new Error(`rota não registrada: GET ${path}`);
  const pilha = achada.route.stack;
  return pilha[pilha.length - 1]!.handle;
}

/** Chama a rota e devolve o JSON — o `asyncRoute` não devolve promessa. */
function chamar(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const res = {
      status: (code: number) => {
        reject(new Error(`resposta inesperada: ${code}`));
        return res;
      },
      json: (body: unknown) => {
        resolve(body as Record<string, unknown>);
        return res;
      },
    };
    const req = { params, query: {}, ip: '203.0.113.7', get: () => undefined } as unknown as Request;
    handler(path)(req, res as unknown as Response, () => {});
  });
}

describe('o JSON anônimo do site', () => {
  // Sem esta guarda a suíte passaria com uma amostra anêmica: é o objeto do
  // banco, com dono, concessões e catálogo privado, que a projeção precisa cortar.
  it('a amostra do banco carrega tudo o que não pode sair', () => {
    for (const campo of PROIBIDOS) expect(DETAIL).toHaveProperty(campo);
    expect(VMCP.catalogs.length).toBeGreaterThan(0);
  });

  it('a lista de skills leva só os campos da página', async () => {
    db.listSkills.mockResolvedValue({
      items: [SUMMARY],
      total: 1,
      limit: 24,
      offset: 0,
      mode: 'text',
      neighbors: [],
    });

    const body = await chamar('/api/skills');
    const item = (body.items as Record<string, unknown>[])[0]!;

    expect(Object.keys(item).sort()).toEqual(CAMPOS_DA_SKILL);
    expect(Object.keys((item.mcps as Record<string, unknown>[])[0]!).sort()).toEqual(CAMPOS_DO_VMCP);
    // `neighbors` é do servidor (`docs/14-rag.md` §8.1).
    expect(body).not.toHaveProperty('neighbors');
    expect(body.mode).toBe('text');
    expect(body.total).toBe(1);
  });

  it('o detalhe da skill não leva dono nem concessões', async () => {
    db.getSkillDetail.mockResolvedValue(DETAIL);

    const body = await chamar('/api/skills/:slug', { slug: 'minha-skill' });

    expect(Object.keys(body).sort()).toEqual([...CAMPOS_DA_SKILL, 'files', 'skillMd'].sort());
    for (const campo of PROIBIDOS) expect(body).not.toHaveProperty(campo);
    // O frontmatter sai do corpo: os metadados já são campos do JSON.
    expect(body.skillMd).toBe('# Minha Skill\n');
    // A leitura conta, como antes.
    expect(body.viewCount).toBe(11);
    expect(body.score).toBe(14);
  });

  /**
   * O padrão pode ser um vMCP **fechado** — `resolveDefaultVirtualMcp` não
   * filtra visibilidade, porque `/mcp` responde nele com chave. A descrição é
   * texto livre e saía por aqui para quem não tem login (`tasks/050`); o `GET /`
   * do mcp-public, que é a superfície de referência, anuncia só status, slug,
   * nome e auth (`docs/09` §3.2).
   */
  it('o /api/meta não leva a descrição do vMCP padrão, nem quando ele é fechado', async () => {
    db.resolveDefaultVirtualMcp.mockResolvedValue({
      status: 'ok',
      mcp: {
        uuid: 'mcp-9',
        slug: 'clientes',
        name: 'Clientes',
        description: 'Skills da conta Acme, contato joana@acme.example',
        isOpen: false,
      },
    });

    const body = await chamar('/api/meta');
    const mcp = body.mcp as Record<string, unknown>;

    expect(Object.keys(mcp).sort()).toEqual(['name', 'requiresKey', 'slug', 'status']);
    expect(mcp.requiresKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain('Acme');
  });

  it('os membros do catálogo público passam pela mesma projeção', async () => {
    db.getPublicCatalog.mockResolvedValue({
      uuid: 'cat-1',
      slug: 'meu-catalogo',
      name: 'Meu catálogo',
      description: 'Uma prateleira',
      skillCount: 1,
      skills: [SUMMARY],
    });

    const body = await chamar('/api/catalogs/:slug', { slug: 'meu-catalogo' });
    const membro = (body.skills as Record<string, unknown>[])[0]!;

    expect(Object.keys(membro).sort()).toEqual(CAMPOS_DA_SKILL);
    for (const campo of PROIBIDOS) expect(membro).not.toHaveProperty(campo);
    expect(body.skillCount).toBe(1);
  });
});
