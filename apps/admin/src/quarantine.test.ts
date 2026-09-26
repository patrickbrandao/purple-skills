import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

type Papel = 'admin' | 'editor' | 'membro';

const { SESSAO, db } = vi.hoisted(() => ({
  // Trocado por teste: a sessão que entra em toda requisição.
  SESSAO: {
    atual: {
      uuid: 'uuid-admin',
      username: 'admin',
      avatarUpdatedAt: null,
      email: 'admin@exemplo.dev',
      name: 'Admin',
      role: 'admin' as Papel,
      mustChangePassword: false,
      legacy: false,
    },
  },
  db: {
    listQuarantine: vi.fn(),
    getQuarantine: vi.fn(),
    deleteQuarantine: vi.fn(),
    promoteQuarantine: vi.fn(),
    readQuarantineFile: vi.fn(),
    readAllQuarantineFiles: vi.fn(),
    setQuarantineFile: vi.fn(),
    createQuarantineFile: vi.fn(),
    deleteQuarantineFile: vi.fn(),
    getQuarantineApprovers: vi.fn(),
    setQuarantineTargets: vi.fn(),
    listCatalogs: vi.fn(),
    listVirtualMcps: vi.fn(),
    getCatalog: vi.fn(),
    getVirtualMcp: vi.fn(),
  },
}));

vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...db,
}));

vi.mock('./auth.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = SESSAO.atual;
    next();
  },
}));

const { REFERRER_POLICY_PRIVATE, securityHeaders } = await import('@purple-skills/shared');
const { api } = await import('./api.js');
const { MAX_FILES_POR_ENVIO } = await import('./quarantine.js');
const { onError } = await import('./errors.js');

/**
 * As rotas da quarentena (`docs/15-quarentena.md`), por HTTP de verdade — é o
 * que mostra o recorte de quem enxerga (404, não 403), o portão de aprovação e
 * os cabeçalhos do "abrir cru", que são os mesmos cuidados da rota da skill
 * com conteúdo de terceiro.
 */

const UUID = '018f3b2c-7a1e-7c3d-9b4a-5e6f70812345';
const DONO = 'uuid-dono';

const envio = {
  uuid: UUID,
  name: 'Revisor de PR',
  description: 'Revisa pull requests.',
  sourceFilename: 'revisor.zip',
  ownerUserUuid: DONO,
  ownerUsername: 'dono@exemplo.dev',
  fileCount: 2,
  sizeBytes: 120,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  files: [
    { relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 100, isText: true },
    { relativePath: 'ref/logo.png', mimeType: 'image/png', sizeBytes: 20, isText: false },
  ],
  targets: { catalogs: [], mcps: [] },
};

let running: Server | undefined;
let porta = 0;

function comoSessao(role: Papel, uuid: string | null = 'uuid-sessao') {
  SESSAO.atual = { ...SESSAO.atual, role, uuid: uuid as string, username: role, email: `${role}@exemplo.dev` };
}

beforeEach(async () => {
  vi.clearAllMocks();
  comoSessao('admin', 'uuid-admin');
  db.getQuarantine.mockImplementation(async (uuid: string) => (uuid === UUID ? envio : null));
  db.listQuarantine.mockResolvedValue({ items: [envio], total: 1, limit: 50, offset: 0 });
  db.getQuarantineApprovers.mockResolvedValue('admin+owner');
  db.deleteQuarantine.mockResolvedValue(undefined);
  db.deleteQuarantineFile.mockResolvedValue(undefined);

  const app = express();
  // Os mesmos cabeçalhos de página que o `index.ts` põe em toda resposta: o
  // `nosniff` do "abrir cru" vem de lá, não da rota.
  const pageHeaders = securityHeaders({ referrerPolicy: REFERRER_POLICY_PRIVATE });
  app.use((_req, res, next) => {
    for (const [nome, valor] of Object.entries(pageHeaders)) res.setHeader(nome, valor);
    next();
  });
  app.use(api);
  app.use(onError);

  await new Promise<void>((resolve) => {
    running = app.listen(0, '127.0.0.1', () => {
      porta = (running!.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(() => {
  running?.close();
  running = undefined;
  vi.restoreAllMocks();
});

type Resposta = { status: number; headers: IncomingHttpHeaders; body: Buffer };

function pedir(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: Buffer } = {},
): Promise<Resposta> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: porta,
        method,
        path,
        headers: {
          ...options.headers,
          ...(options.body ? { 'content-length': String(options.body.byteLength) } : {}),
        },
      },
      (res) => {
        const pedacos: Buffer[] = [];
        res.on('data', (chunk: Buffer) => pedacos.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(pedacos) }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const json = (res: Resposta) => JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;

const comCorpo = (method: string, path: string, corpo: unknown) =>
  pedir(method, path, {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(corpo), 'utf8'),
  });

describe('GET /api/quarantine — o recorte da fila', () => {
  it('admin e editor pedem a fila inteira, sem filtro de dono', async () => {
    for (const papel of ['admin', 'editor'] as Papel[]) {
      db.listQuarantine.mockClear();
      comoSessao(papel);
      const res = await pedir('GET', '/api/quarantine');

      expect(res.status).toBe(200);
      expect(db.listQuarantine.mock.calls[0]![0]).not.toHaveProperty('ownerUserUuid');
    }
  });

  it('o membro só pede o que é dele', async () => {
    comoSessao('membro', 'uuid-membro');
    const res = await pedir('GET', '/api/quarantine');

    expect(res.status).toBe(200);
    expect(db.listQuarantine.mock.calls[0]![0]).toMatchObject({ ownerUserUuid: 'uuid-membro' });
  });

  // O dono sai pelo e-mail em toda ficha e lista do painel (`access.ownerByUsername`).
  it('o uuid do dono não sai na lista', async () => {
    const res = await pedir('GET', '/api/quarantine');
    const [item] = json(res).items as Record<string, unknown>[];

    expect(item!.ownerUserUuid).toBe('dono@exemplo.dev');
    expect(item!.ownerUsername).toBe('dono@exemplo.dev');
  });
});

describe('GET /api/quarantine/:uuid — quem enxerga', () => {
  it('quem não enxerga recebe 404, não 403: envio alheio não se confirma', async () => {
    comoSessao('membro', 'uuid-membro');
    const res = await pedir('GET', `/api/quarantine/${UUID}`);

    expect(res.status).toBe(404);
  });

  it('o dono enxerga o que submeteu, mesmo sendo membro', async () => {
    comoSessao('membro', DONO);
    const res = await pedir('GET', `/api/quarantine/${UUID}`);

    expect(res.status).toBe(200);
    expect(json(res).name).toBe('Revisor de PR');
  });

  it('uuid inexistente é 404', async () => {
    const res = await pedir('GET', '/api/quarantine/nao-existe');

    expect(res.status).toBe(404);
  });

  it('a ficha diz se esta sessão pode aprovar', async () => {
    comoSessao('editor', DONO);
    expect(json(await pedir('GET', `/api/quarantine/${UUID}`)).canPromote).toBe(true);

    comoSessao('editor', 'uuid-outro');
    expect(json(await pedir('GET', `/api/quarantine/${UUID}`)).canPromote).toBe(false);
  });
});

describe('POST /api/quarantine/:uuid/promote — o portão', () => {
  beforeEach(() => {
    db.promoteQuarantine.mockResolvedValue({
      uuid: 'uuid-skill',
      slug: 'revisor-de-pr',
      name: 'Revisor de PR',
      skillMd: '# Corpo\n',
      files: [],
      grants: [],
      access: 'owner',
      ownerUserUuid: DONO,
      ownerUsername: 'dono@exemplo.dev',
      mcps: [],
      catalogs: [],
      tags: [],
    });
  });

  it('com "admin+owner", o dono aprova o dele', async () => {
    comoSessao('editor', DONO);
    const res = await pedir('POST', `/api/quarantine/${UUID}/promote`);

    expect(res.status).toBe(201);
    expect(db.promoteQuarantine).toHaveBeenCalledWith(UUID, 'web-admin', expect.anything(), {
      expectedTargets: { catalogs: [], mcps: [] },
    });
  });

  it('com "admin+owner", o editor que não é dono recebe 403 com a política na mensagem', async () => {
    comoSessao('editor', 'uuid-outro');
    const res = await pedir('POST', `/api/quarantine/${UUID}/promote`);

    expect(res.status).toBe(403);
    expect(json(res).message).toMatch(/administradores e o dono do envio/);
    expect(db.promoteQuarantine).not.toHaveBeenCalled();
  });

  it('com "admin", nem o dono aprova', async () => {
    db.getQuarantineApprovers.mockResolvedValue('admin');
    comoSessao('editor', DONO);
    const res = await pedir('POST', `/api/quarantine/${UUID}/promote`);

    expect(res.status).toBe(403);
    expect(db.promoteQuarantine).not.toHaveBeenCalled();
  });

  it('com "admin+editor", qualquer editor aprova', async () => {
    db.getQuarantineApprovers.mockResolvedValue('admin+editor');
    comoSessao('editor', 'uuid-outro');

    expect((await pedir('POST', `/api/quarantine/${UUID}/promote`)).status).toBe(201);
  });

  // A política amplia o portão, nunca o acesso: quem não vê o envio para antes.
  it('quem não enxerga o envio recebe 404, e a política nem é consultada', async () => {
    db.getQuarantineApprovers.mockResolvedValue('admin+editor');
    comoSessao('membro', 'uuid-membro');
    const res = await pedir('POST', `/api/quarantine/${UUID}/promote`);

    expect(res.status).toBe(404);
    expect(db.getQuarantineApprovers).not.toHaveBeenCalled();
  });
});

describe('arquivos do envio', () => {
  beforeEach(() => {
    db.readQuarantineFile.mockImplementation(async (_uuid: string, path: string) =>
      path === 'SKILL.md'
        ? {
            relativePath: 'SKILL.md',
            mimeType: 'text/markdown',
            isText: true,
            buffer: Buffer.from('---\nname: revisor\n---\n# Corpo\n', 'utf8'),
          }
        : null,
    );
    db.setQuarantineFile.mockImplementation(async (_uuid: string, relativePath: string, content: string) => ({
      relativePath,
      mimeType: 'text/markdown',
      sizeBytes: Buffer.byteLength(content),
      isText: true,
    }));
  });

  /*
   * O contrário da rota da skill: lá o SKILL.md é remontado dos metadados na
   * leitura e tem o frontmatter tirado na gravação. Na quarentena não existe
   * metadado em coluna — o arquivo é a única verdade até a aprovação.
   */
  it('o SKILL.md sai cru, com o frontmatter dentro', async () => {
    const res = await pedir('GET', `/api/quarantine/${UUID}/files/SKILL.md`);

    expect(res.status).toBe(200);
    expect(json(res).content).toBe('---\nname: revisor\n---\n# Corpo\n');
  });

  it('o SKILL.md entra cru: o frontmatter enviado é gravado', async () => {
    const texto = '---\nname: outro\n---\n# Novo\n';
    const res = await comCorpo('PUT', `/api/quarantine/${UUID}/files/SKILL.md`, { content: texto });

    expect(res.status).toBe(200);
    expect(db.setQuarantineFile.mock.calls[0]![2]).toBe(texto);
  });

  it('?raw desce como texto, sob CSP de sandbox e sem cache compartilhado', async () => {
    const res = await pedir('GET', `/api/quarantine/${UUID}/files/SKILL.md?raw`);

    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cache-control']).toBe('private, no-cache');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.toString('utf8')).toContain('# Corpo');
  });

  it('arquivo que não existe é 404', async () => {
    expect((await pedir('GET', `/api/quarantine/${UUID}/files/nada.md`)).status).toBe(404);
  });

  it('gravar sem "content" é 400, e o envio nem é lido', async () => {
    const res = await comCorpo('PUT', `/api/quarantine/${UUID}/files/SKILL.md`, {});

    expect(res.status).toBe(400);
    expect(db.getQuarantine).not.toHaveBeenCalled();
  });

  it('quem não enxerga o envio não lê nem grava arquivo dele', async () => {
    comoSessao('membro', 'uuid-membro');

    expect((await pedir('GET', `/api/quarantine/${UUID}/files/SKILL.md`)).status).toBe(404);
    expect(
      (await comCorpo('PUT', `/api/quarantine/${UUID}/files/SKILL.md`, { content: 'x' })).status,
    ).toBe(404);
    expect((await pedir('DELETE', `/api/quarantine/${UUID}/files/SKILL.md`)).status).toBe(404);
    expect(db.setQuarantineFile).not.toHaveBeenCalled();
    expect(db.deleteQuarantineFile).not.toHaveBeenCalled();
  });
});

describe('as duas guardas da criação de arquivo', () => {
  beforeEach(() => {
    db.createQuarantineFile.mockImplementation(async (_uuid: string, relativePath: string) => ({
      relativePath,
      mimeType: 'text/markdown',
      sizeBytes: 0,
      isText: true,
    }));
  });

  /*
   * A rota grava `content: string`, e quem decide texto × binário é a
   * **extensão**. Sem esta guarda, criar `logo.png` respondia 201 com uma linha
   * binária que toda leitura devolvia como `content: null` — arquivo que a
   * própria tela não abre e cuja única saída é remover.
   */
  it('extensão de binário é 400, e nem o envio é lido', async () => {
    const res = await comCorpo('POST', `/api/quarantine/${UUID}/files/ref/logo.png`, { content: '' });

    expect(res.status).toBe(400);
    expect(json(res).message).toMatch(/extensão de arquivo binário/);
    expect(db.getQuarantine).not.toHaveBeenCalled();
    expect(db.createQuarantineFile).not.toHaveBeenCalled();
  });

  it('a mesma guarda vale para gravar por cima', async () => {
    const res = await comCorpo('PUT', `/api/quarantine/${UUID}/files/ref/logo.png`, { content: 'oi' });

    expect(res.status).toBe(400);
    expect(db.setQuarantineFile).not.toHaveBeenCalled();
  });

  it('texto passa, inclusive o nome sem extensão', async () => {
    expect((await comCorpo('POST', `/api/quarantine/${UUID}/files/notas.md`, { content: '' })).status).toBe(201);
    expect((await comCorpo('POST', `/api/quarantine/${UUID}/files/Dockerfile`, { content: '' })).status).toBe(201);
  });

  /*
   * O envio é o retrato de um `.zip`, e o `.zip` para em 512 entradas. Sem o
   * teto, a criação um a um não tinha limite nenhum.
   */
  it('envio no teto recusa arquivo novo, sem gravar', async () => {
    const cheio = {
      ...envio,
      files: Array.from({ length: MAX_FILES_POR_ENVIO }, (_, i) => ({
        relativePath: `f${i}.md`,
        mimeType: 'text/markdown',
        sizeBytes: 1,
        isText: true,
      })),
    };
    db.getQuarantine.mockResolvedValue(cheio);

    const res = await comCorpo('POST', `/api/quarantine/${UUID}/files/mais.md`, { content: '' });

    expect(res.status).toBe(400);
    expect(json(res).message).toMatch(/limite por envio/);
    expect(db.createQuarantineFile).not.toHaveBeenCalled();
  });

  it('o teto não atrapalha gravar por cima de um arquivo que já existe', async () => {
    const cheio = {
      ...envio,
      files: Array.from({ length: MAX_FILES_POR_ENVIO }, (_, i) => ({
        relativePath: `f${i}.md`,
        mimeType: 'text/markdown',
        sizeBytes: 1,
        isText: true,
      })),
    };
    db.getQuarantine.mockResolvedValue(cheio);

    expect((await comCorpo('PUT', `/api/quarantine/${UUID}/files/f0.md`, { content: 'x' })).status).toBe(200);
  });
});

describe('DELETE /api/quarantine/:uuid', () => {
  it('o dono descarta o que é dele', async () => {
    comoSessao('membro', DONO);
    const res = await pedir('DELETE', `/api/quarantine/${UUID}`);

    expect(res.status).toBe(200);
    expect(db.deleteQuarantine).toHaveBeenCalledWith(UUID, 'web-admin', expect.anything());
  });

  /*
   * Descartar **não** passa pela política de aprovação: ela decide quem cria a
   * skill, não quem limpa a própria fila. Editor revisa e descarta o que não
   * presta sem depender de um admin.
   */
  it('o editor descarta envio alheio mesmo sem poder aprová-lo', async () => {
    comoSessao('editor', 'uuid-outro');
    const res = await pedir('DELETE', `/api/quarantine/${UUID}`);

    expect(res.status).toBe(200);
    expect(db.deleteQuarantine).toHaveBeenCalled();
  });

  it('quem não enxerga não descarta', async () => {
    comoSessao('membro', 'uuid-membro');

    expect((await pedir('DELETE', `/api/quarantine/${UUID}`)).status).toBe(404);
    expect(db.deleteQuarantine).not.toHaveBeenCalled();
  });
});

describe('GET /api/quarantine/:uuid/download', () => {
  it('o pacote sai com o nome do envio em forma de slug, sem remontar nada', async () => {
    db.readAllQuarantineFiles.mockResolvedValue([
      { relativePath: 'SKILL.md', mimeType: 'text/markdown', isText: true, buffer: Buffer.from('---\nname: x\n---\n# a\n') },
    ]);
    const res = await pedir('GET', `/api/quarantine/${UUID}/download`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="revisor-de-pr.zip"');
  });
});

/**
 * O destino do envio (`docs/15-quarentena.md` §11). Três catálogos e dois
 * servidores de terceiros, cada um num nível diferente para a sessão: o que ela
 * edita, o que só vê e o que nem enxerga.
 */
describe('o destino do envio', () => {
  const catEditavel = { uuid: 'cat-edit', slug: 'meu', name: 'Meu catálogo', isActive: true };
  const catVisto = { uuid: 'cat-view', slug: 'do-time', name: 'Do time', isActive: true };
  const catOculto = { uuid: 'cat-oculto', slug: 'segredo', name: 'Catálogo secreto', isActive: true };
  const mcpEditavel = {
    uuid: 'mcp-edit',
    slug: 'prod',
    name: 'Produção',
    isActive: true,
    asSkill: true,
    asPrompt: false,
    asResource: false,
  };
  const comDestino = (targets: object) => ({ ...envio, targets });

  beforeEach(() => {
    comoSessao('editor', DONO);
    db.listCatalogs.mockResolvedValue([
      { ...catEditavel, access: 'edit', ownerUserUuid: null },
      { ...catVisto, access: 'view', ownerUserUuid: null },
    ]);
    db.listVirtualMcps.mockResolvedValue([{ ...mcpEditavel, access: 'edit', ownerUserUuid: null }]);
    db.getCatalog.mockImplementation(async (slug: string) =>
      slug === 'meu' ? { ...catEditavel, access: 'edit' } : slug === 'do-time' ? { ...catVisto, access: 'view' } : null,
    );
    db.getVirtualMcp.mockImplementation(async (slug: string) => (slug === 'prod' ? { ...mcpEditavel, access: 'edit' } : null));
    db.setQuarantineTargets.mockImplementation(async () => envio);
    db.promoteQuarantine.mockResolvedValue({
      uuid: 'uuid-skill',
      slug: 'revisor-de-pr',
      name: 'Revisor de PR',
      skillMd: '# Corpo\n',
      files: [],
      grants: [],
      access: 'owner',
      ownerUserUuid: DONO,
      ownerUsername: 'dono@exemplo.dev',
      mcps: [],
      catalogs: [],
      tags: [],
    });
  });

  it('a ficha mostra só o que a sessão enxerga, dizendo o que ela edita, e conta o resto sem nome', async () => {
    db.getQuarantine.mockResolvedValue(
      comDestino({ catalogs: [catEditavel, catVisto, catOculto], mcps: [mcpEditavel] }),
    );
    const res = await pedir('GET', `/api/quarantine/${UUID}`);
    const corpo = json(res);

    expect(res.status).toBe(200);
    expect(corpo.targets).toEqual({
      catalogs: [
        { ...catEditavel, editable: true },
        { ...catVisto, editable: false },
      ],
      mcps: [{ ...mcpEditavel, editable: true }],
    });
    expect(corpo.hiddenTargetCount).toBe(1);
    expect(res.body.toString('utf8')).not.toContain('secreto');
  });

  it('sem destino, a ficha nem lista catálogos e servidores', async () => {
    const res = await pedir('GET', `/api/quarantine/${UUID}`);

    expect(json(res).hiddenTargetCount).toBe(0);
    expect(db.listCatalogs).not.toHaveBeenCalled();
    expect(db.listVirtualMcps).not.toHaveBeenCalled();
  });

  it('acrescentar um catálogo que a sessão edita grava, e o oculto fica como estava', async () => {
    db.getQuarantine.mockResolvedValue(comDestino({ catalogs: [catOculto], mcps: [] }));
    const res = await comCorpo('PUT', `/api/quarantine/${UUID}/targets`, { catalogs: ['meu'], mcps: [] });

    expect(res.status).toBe(200);
    expect(db.setQuarantineTargets).toHaveBeenCalledWith(
      UUID,
      { catalogs: ['cat-edit', 'cat-oculto'], mcps: [] },
      'web-admin',
      expect.anything(),
    );
  });

  it('"dropHidden" tira o que a sessão não enxerga, sem ela saber o que era', async () => {
    db.getQuarantine.mockResolvedValue(comDestino({ catalogs: [catOculto], mcps: [] }));
    await comCorpo('PUT', `/api/quarantine/${UUID}/targets`, { catalogs: [], mcps: [], dropHidden: true });

    expect(db.setQuarantineTargets.mock.calls[0]![1]).toEqual({ catalogs: [], mcps: [] });
  });

  it('acrescentar um catálogo que a sessão só vê é 403, sem gravar', async () => {
    const res = await comCorpo('PUT', `/api/quarantine/${UUID}/targets`, { catalogs: ['do-time'], mcps: [] });

    expect(res.status).toBe(403);
    expect(db.setQuarantineTargets).not.toHaveBeenCalled();
  });

  it('manter um destino que a sessão só vê não cobra de novo: ela pode revisar sem tirá-lo', async () => {
    db.getQuarantine.mockResolvedValue(comDestino({ catalogs: [catVisto], mcps: [] }));
    const res = await comCorpo('PUT', `/api/quarantine/${UUID}/targets`, { catalogs: ['do-time'], mcps: [] });

    expect(res.status).toBe(200);
    expect(db.getCatalog).not.toHaveBeenCalled();
    expect(db.setQuarantineTargets.mock.calls[0]![1]).toEqual({ catalogs: ['cat-view'], mcps: [] });
  });

  it('mudar a porta de um servidor do destino é publicar de outro jeito, e cobra "edit" de novo', async () => {
    db.getQuarantine.mockResolvedValue(comDestino({ catalogs: [], mcps: [mcpEditavel] }));
    await comCorpo('PUT', `/api/quarantine/${UUID}/targets`, {
      catalogs: [],
      mcps: [{ slug: 'prod', asSkill: true, asPrompt: true, asResource: false }],
    });

    expect(db.getVirtualMcp).toHaveBeenCalledTimes(1);
    expect(db.setQuarantineTargets.mock.calls[0]![1]).toEqual({
      catalogs: [],
      mcps: [{ virtualMcpUuid: 'mcp-edit', asSkill: true, asPrompt: true, asResource: false }],
    });
  });

  it('quem não enxerga o envio não troca o destino', async () => {
    comoSessao('membro', 'uuid-membro');
    const res = await comCorpo('PUT', `/api/quarantine/${UUID}/targets`, { catalogs: ['meu'], mcps: [] });

    expect(res.status).toBe(404);
    expect(db.setQuarantineTargets).not.toHaveBeenCalled();
  });

  it('aprovar publica o destino conferido: o banco recebe o que foi checado, para comparar', async () => {
    db.getQuarantine.mockResolvedValue(comDestino({ catalogs: [catEditavel], mcps: [mcpEditavel] }));
    const res = await pedir('POST', `/api/quarantine/${UUID}/promote`);

    expect(res.status).toBe(201);
    expect(db.promoteQuarantine).toHaveBeenCalledWith(UUID, 'web-admin', expect.anything(), {
      expectedTargets: {
        catalogs: ['cat-edit'],
        mcps: [{ virtualMcpUuid: 'mcp-edit', asSkill: true, asPrompt: false, asResource: false }],
      },
    });
  });

  it('quem aprova e só vê um catálogo do destino recebe 403 com o nome dele, e nada é criado', async () => {
    db.getQuarantine.mockResolvedValue(comDestino({ catalogs: [catVisto], mcps: [] }));
    const res = await pedir('POST', `/api/quarantine/${UUID}/promote`);

    expect(res.status).toBe(403);
    expect(json(res).message).toMatch(/"Do time"/);
    expect(db.promoteQuarantine).not.toHaveBeenCalled();
  });

  it('quem aprova e não enxerga um destino recebe 403 sem o nome dele', async () => {
    db.getQuarantine.mockResolvedValue(comDestino({ catalogs: [catOculto], mcps: [] }));
    const res = await pedir('POST', `/api/quarantine/${UUID}/promote`);

    expect(res.status).toBe(403);
    expect(res.body.toString('utf8')).not.toContain('secreto');
    expect(db.promoteQuarantine).not.toHaveBeenCalled();
  });

  it('a política vem antes do destino: quem não pode aprovar nem tem o destino conferido', async () => {
    comoSessao('editor', 'uuid-outro');
    db.getQuarantine.mockResolvedValue(comDestino({ catalogs: [catEditavel], mcps: [] }));
    const res = await pedir('POST', `/api/quarantine/${UUID}/promote`);

    expect(res.status).toBe(403);
    expect(db.listCatalogs).not.toHaveBeenCalled();
  });
});
