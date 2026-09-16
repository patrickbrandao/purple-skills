import type { RequestHandler } from 'express';
import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const { criar, lerMcp } = vi.hoisted(() => ({ criar: vi.fn(), lerMcp: vi.fn() }));

// Só `createSkill` e `getVirtualMcp` são trocados: o resto do pacote entra de
// verdade, e nada nele abre conexão em tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createSkill: criar,
  getVirtualMcp: lerMcp,
}));

const { api } = await import('./api.js');

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] };
};

/** O último handler da rota — depois dos guardas e do multer. */
function rota(method: string, path: string): RequestHandler {
  const layers = (api as unknown as { stack: Layer[] }).stack;
  const found = layers.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  if (!found?.route) throw new Error(`rota não registrada: ${method.toUpperCase()} ${path}`);
  return found.route.stack[found.route.stack.length - 1]!.handle;
}

function zipCom(skillMd: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf8'));
  return zip.toBuffer();
}

const admin = { uuid: 'uuid-admin', email: 'admin@exemplo.dev', name: 'Admin', role: 'admin', mustChangePassword: false, legacy: false };
const editor = { ...admin, uuid: 'uuid-editor', email: 'editor@exemplo.dev', role: 'editor' };

const timeA = {
  uuid: 'mcp-1',
  slug: 'time-a',
  name: 'Time A',
  description: '',
  isActive: true,
  isOpen: false,
  ownerUserUuid: 'uuid-editor',
  ownerEmail: 'editor@exemplo.dev',
  skillCount: 0,
  activeKeyCount: 0,
  isDefault: false,
  toolCount: 0,
  promptCount: 0,
  resourceCount: 0,
  onlineSessions: 0,
  preview: [],
  catalogCount: 0,
  previewCatalogs: [],
  layout: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  skills: [],
  grants: [],
  access: 'owner' as const,
};

async function importar(skillMd: string, campos: Record<string, string> = {}, user = admin) {
  const req = { file: { buffer: zipCom(skillMd), originalname: 'pacote.zip' }, body: campos, user };
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  await rota('post', '/api/skills/import')(req as never, res as never, (() => {}) as never);
  await new Promise((resolve) => setImmediate(resolve));

  // A última chamada, não a primeira: um teste que importa mais de um .zip
  // compara cada resultado com a importação que acabou de fazer.
  return { input: criar.mock.calls.at(-1)?.[0], res };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `skillMd` entra porque a rota passa o retorno por `bodyOnly` antes de
  // responder: sem ele cada importação despeja um TypeError no stderr do teste.
  criar.mockResolvedValue({ slug: 'minha-skill', skillMd: '', files: [] });
  lerMcp.mockResolvedValue(timeA);
});

describe('POST /api/skills/import', () => {
  // Onde a skill aparece é decidido pelo vínculo, escolhido por quem importa:
  // um .zip de terceiro não se publica sozinho, por flag nenhuma.
  it('ignora qualquer flag de publicação do frontmatter e nasce flutuante', async () => {
    const { input } = await importar(
      '---\nname: minha-skill\nis_public: true\nuse_as_prompt: true\n---\n# Corpo\n',
    );

    expect(input).toMatchObject({ slug: 'minha-skill', mcps: [] });
    expect(input).not.toHaveProperty('isPublic');
    expect(input).not.toHaveProperty('useAsPrompt');
  });

  it('publica nos vMCPs do formulário, resolvendo o slug em uuid', async () => {
    const { input } = await importar('# Corpo\n', {
      mcps: JSON.stringify([{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }]),
    });

    // A leitura leva a janela de "online" do painel (docs/10) e quem está
    // olhando (docs/12): o banco decide o que a sessão enxerga.
    expect(lerMcp).toHaveBeenCalledWith('time-a', {
      onlineWindowMs: expect.any(Number),
      viewer: { role: 'admin', userUuid: 'uuid-admin' },
    });
    expect(input.mcps).toEqual([
      { virtualMcpUuid: 'mcp-1', asSkill: true, asPrompt: false, asResource: false },
    ]);
  });

  // Vincular é editar o vMCP (docs/12 §3.2): quem só visualiza é barrado, e
  // quem nem enxerga recebe o mesmo 404 de um slug inexistente.
  it('recusa um vMCP que a sessão só visualiza, sem criar a skill', async () => {
    const outro = { ...editor, uuid: 'uuid-outro' };
    lerMcp.mockResolvedValue({ ...timeA, access: 'view' });

    const { res } = await importar(
      '# Corpo\n',
      { mcps: JSON.stringify([{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }]) },
      outro,
    );

    expect(res.statusCode).toBe(403);
    expect(criar).not.toHaveBeenCalled();
  });

  it('trata como inexistente um vMCP que a sessão não enxerga', async () => {
    const outro = { ...editor, uuid: 'uuid-outro' };
    lerMcp.mockResolvedValue(null);

    const { res } = await importar(
      '# Corpo\n',
      { mcps: JSON.stringify([{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }]) },
      outro,
    );

    expect(res.statusCode).toBe(404);
    expect(criar).not.toHaveBeenCalled();
  });

  it('recusa um vínculo sem nenhuma superfície', async () => {
    const { res } = await importar('# Corpo\n', {
      mcps: JSON.stringify([{ slug: 'time-a', asSkill: false, asPrompt: false, asResource: false }]),
    });

    expect(res.statusCode).toBe(400);
    expect(criar).not.toHaveBeenCalled();
  });
});
