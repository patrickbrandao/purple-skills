/**
 * O que sai do painel sobre **quem** tem acesso, e por quais rotas
 * (`docs/12-acesso-granular.md` decisões 10, 11 e 13).
 *
 * Aqui ficam a camada de `access.ts` e a ligação das rotas de skill que devolvem
 * ficha; os casos de vMCP estão em `mcps.test.ts` e os de catálogo em
 * `catalogs.test.ts`.
 */
import type { RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

/** As funções do banco que estes caminhos tocam, pelo nome. */
const banco = vi.hoisted(() => ({
  getSkillSummary: vi.fn(),
  getSkillDetail: vi.fn(),
  listSkills: vi.fn(),
  listSkillGrants: vi.fn(),
  setSkillGrant: vi.fn(),
  removeSkillGrant: vi.fn(),
  getUserByEmail: vi.fn(),
  getVirtualMcp: vi.fn(),
  linkSkill: vi.fn(),
  unlinkSkill: vi.fn(),
  updateSkillWithContent: vi.fn(),
  listSkillAccesses: vi.fn(),
  getCatalog: vi.fn(),
  createVirtualMcp: vi.fn(),
  createCatalog: vi.fn(),
}));

// Só estas são trocadas: o resto do pacote entra de verdade, e nada nele abre
// conexão em tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...banco,
}));

const { grantByEmail, grantOf, ownerByEmail, shareSkill, unshareSkill, withGrants } = await import('./access.js');
const { api } = await import('./api.js');

afterEach(() => {
  vi.restoreAllMocks();
});

type Viewer = { role: string; userUuid: string | null };

const sessao = (role: 'admin' | 'editor' | 'membro', uuid: string) => ({
  uuid,
  email: `${role}@exemplo.dev`,
  name: role,
  role,
  mustChangePassword: false,
  legacy: false,
});

const ana = sessao('editor', 'uuid-ana');
const leitor = sessao('membro', 'uuid-leitor');

const FLAGS = { asSkill: true, asPrompt: false, asResource: false };

const CONCESSAO = {
  userUuid: 'uuid-bia',
  email: 'bia@exemplo.dev',
  name: 'Bia',
  role: 'membro' as const,
  isActive: true,
  level: 'edit' as const,
  grantedByUserUuid: 'uuid-ana',
  grantedByEmail: 'ana@exemplo.dev',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const DESATIVADA = { ...CONCESSAO, userUuid: 'uuid-saiu', email: 'saiu@exemplo.dev', name: 'Saiu', isActive: false };

const vmcpRef = (slug: string) => ({ uuid: `ref-${slug}`, slug, name: slug, isOpen: false, isActive: true, isDefault: false, ...FLAGS, direct: true, catalogs: [] });

/** A ficha na visão do admin (`'all'`) — o que toda escrita do banco devolve. */
const FICHA_DO_ADMIN = {
  uuid: 'skill-alfa',
  slug: 'alfa',
  name: 'Alfa',
  skillMd: '---\nname: alfa\n---\n# alfa\n',
  files: [],
  isPublic: true,
  ownerUserUuid: 'uuid-ana',
  ownerEmail: 'ana@exemplo.dev',
  access: 'owner' as const,
  grants: [CONCESSAO, DESATIVADA],
  mcps: [vmcpRef('time-a'), vmcpRef('fechado-da-ana')],
  catalogs: [{ uuid: 'cat-1', slug: 'privado-da-ana', name: 'Privado', isActive: true, memberActive: true }],
};

/** A mesma skill como o banco a devolve a quem só a lê: os contêineres recortados, a ACL inteira. */
const FICHA_DO_LEITOR = { ...FICHA_DO_ADMIN, access: 'view' as const, mcps: [vmcpRef('time-a')], catalogs: [] };

const fichaPara = (viewer?: Viewer) =>
  !viewer || viewer.role === 'admin' || viewer.userUuid === 'uuid-ana' ? FICHA_DO_ADMIN : FICHA_DO_LEITOR;

const UUIDS_DE_CONTA = ['uuid-ana', 'uuid-bia', 'uuid-saiu'];

const semUuidDeConta = (payload: unknown) => {
  const json = JSON.stringify(payload);
  for (const uuid of UUIDS_DE_CONTA) expect(json).not.toContain(uuid);
};

beforeEach(() => {
  vi.clearAllMocks();
  banco.getSkillSummary.mockImplementation((_slug: string, options?: { viewer?: Viewer }) => Promise.resolve(fichaPara(options?.viewer)));
  banco.getSkillDetail.mockImplementation((_slug: string, options?: { viewer?: Viewer }) => Promise.resolve(fichaPara(options?.viewer)));
  banco.listSkillGrants.mockResolvedValue([CONCESSAO, DESATIVADA]);
  banco.getUserByEmail.mockImplementation((email: string) =>
    Promise.resolve(email === 'saiu@exemplo.dev' ? { uuid: 'uuid-saiu', email, isActive: false } : null),
  );
});

/** O `AppError` que a rota transforma em resposta. */
const recusa = async (acao: Promise<unknown>): Promise<{ status: number; message: string }> => {
  try {
    await acao;
  } catch (err: unknown) {
    const erro = err as { status: number; message: string };
    return { status: erro.status, message: erro.message };
  }
  throw new Error('a ação deveria ter sido recusada');
};

/**
 * O `uuid` da conta é o `sub` do cookie de sessão, e a busca de contas deixou de
 * entregá-lo (`withoutUuid`) porque `uuid` + papel de toda conta é dizer a um
 * membro qual crachá forjar. Ele continuava saindo ao lado do e-mail em toda
 * ficha (relatório 011 da auditoria de 2026-09-19).
 */
describe('a conta sai pelo e-mail, nunca pelo uuid', () => {
  it('o dono: o campo vira apelido do e-mail; sem dono continua nulo', () => {
    expect(ownerByEmail({ ownerUserUuid: 'uuid-ana', ownerEmail: 'ana@exemplo.dev' })).toEqual({
      ownerUserUuid: 'ana@exemplo.dev',
      ownerEmail: 'ana@exemplo.dev',
    });
    expect(ownerByEmail({ ownerUserUuid: null, ownerEmail: null })).toEqual({ ownerUserUuid: null, ownerEmail: null });
  });

  it('a concessão: a conta e quem concedeu, e o resto intacto', () => {
    expect(grantByEmail(CONCESSAO)).toEqual({ ...CONCESSAO, userUuid: 'bia@exemplo.dev', grantedByUserUuid: 'ana@exemplo.dev' });
    expect(grantByEmail({ ...CONCESSAO, grantedByUserUuid: null, grantedByEmail: null }).grantedByUserUuid).toBeNull();
  });

  it('a ficha de quem administra: nenhum uuid de conta em campo nenhum', () => {
    const ficha = withGrants(FICHA_DO_ADMIN);

    semUuidDeConta(ficha);
    expect(ficha.grants.map((grant) => grant.email)).toEqual(['bia@exemplo.dev', 'saiu@exemplo.dev']);
    // O que não é conta não muda: o uuid da skill e o dos contêineres continuam lá.
    expect(ficha).toMatchObject({ uuid: 'skill-alfa', mcps: FICHA_DO_ADMIN.mcps, catalogs: FICHA_DO_ADMIN.catalogs });
  });

  it('a ficha de quem só lê continua sem a lista de concessões (decisão 11)', () => {
    expect(withGrants(FICHA_DO_LEITOR).grants).toEqual([]);
  });

  it('conceder devolve a concessão pelo e-mail', async () => {
    banco.getUserByEmail.mockResolvedValue({ uuid: 'uuid-bia', email: 'bia@exemplo.dev', isActive: true });
    banco.setSkillGrant.mockResolvedValue(CONCESSAO);

    const concessao = await shareSkill(ana, 'alfa', 'bia@exemplo.dev', 'edit');

    expect(banco.setSkillGrant).toHaveBeenCalledWith('alfa', 'uuid-bia', 'edit', 'web-admin', expect.objectContaining({ userUuid: 'uuid-ana' }));
    semUuidDeConta(concessao);
  });
});

/**
 * `manage` revoga **qualquer** concessão (decisão 10), inclusive a de conta
 * desativada depois de recebê-la: a linha fica, inerte, e reativar a conta
 * devolveria o acesso. Revogar passava pelo funil que exige conta ativa, e a
 * linha não saía por superfície nenhuma (relatório 039 da auditoria de
 * 2026-09-19).
 */
describe('revogar a concessão de uma skill não exige conta ativa', () => {
  it('revoga a de conta desativada, pelo uuid que está na lista', async () => {
    await unshareSkill(ana, 'alfa', ' Saiu@Exemplo.dev ');

    expect(banco.listSkillGrants).toHaveBeenCalledWith('skill-alfa');
    expect(banco.removeSkillGrant).toHaveBeenCalledWith('alfa', 'uuid-saiu', 'web-admin', expect.objectContaining({ userUuid: 'uuid-ana' }));
  });

  it('conceder — e mudar o nível — de conta desativada continua recusado', async () => {
    expect(await recusa(shareSkill(ana, 'alfa', 'saiu@exemplo.dev', 'view'))).toEqual({
      status: 404,
      message: 'Conta não encontrada ou desativada: saiu@exemplo.dev',
    });
    expect(banco.setSkillGrant).not.toHaveBeenCalled();
  });

  // Revogar não consulta `users`: a resposta não separa "não existe conta com
  // este e-mail" de "existe, e não tem concessão aqui" — nem para a conta
  // desativada, que a busca de contas não revela (decisão 13).
  it('e-mail sem concessão é 404 sem consultar a conta', async () => {
    expect(await recusa(unshareSkill(ana, 'alfa', 'ninguem@exemplo.dev'))).toEqual({
      status: 404,
      message: 'A conta não tem concessão nesta skill',
    });
    expect(banco.getUserByEmail).not.toHaveBeenCalled();
    expect(banco.removeSkillGrant).not.toHaveBeenCalled();
  });

  it('quem não administra a skill não chega a ler a lista', async () => {
    expect((await recusa(unshareSkill(leitor, 'alfa', 'saiu@exemplo.dev'))).status).toBe(403);
    expect(banco.listSkillGrants).not.toHaveBeenCalled();
  });

  it('`grantOf`: e-mail torto é 400; a caixa do e-mail não importa', () => {
    expect(() => grantOf([CONCESSAO], 'nao-e-email', 'nesta skill')).toThrow(/Informe o e-mail/);
    expect(grantOf([CONCESSAO], 'BIA@exemplo.dev', 'nesta skill')).toBe(CONCESSAO);
  });
});

// ------------------------------------------------------------------ rotas ---

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] };
};

/** O último handler da rota — depois dos guardas e dos parsers. */
function rota(method: string, path: string): RequestHandler {
  const layers = (api as unknown as { stack: Layer[] }).stack;
  const found = layers.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  if (!found?.route) throw new Error(`rota não registrada: ${method.toUpperCase()} ${path}`);
  return found.route.stack[found.route.stack.length - 1]!.handle;
}

async function chamar(method: string, path: string, req: Record<string, unknown>) {
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
  await rota(method, path)({ query: {}, ...req } as never, res as never, (() => {}) as never);
  await new Promise((resolve) => setImmediate(resolve));
  return res as { statusCode: number; body: Record<string, unknown> };
}

/** Um vMCP que a sessão edita, com a skill `alfa` vinculada direto. */
const TIME_A = { uuid: 'mcp-1', slug: 'time-a', name: 'Time A', access: 'edit', skills: [{ slug: 'alfa' }], catalogs: [], grants: [] };

/**
 * O vínculo pelo lado da skill exige só `edit` em algum vMCP e `view` na skill, e
 * devolvia a ficha que a escrita relê na visão do admin — `access: 'owner'`, a
 * ACL inteira e todo contêiner (relatório 009 da auditoria de 2026-09-19).
 */
describe('PUT e DELETE /api/skills/:slug/mcps/:mcp', () => {
  const params = { slug: 'alfa', mcp: 'time-a' };

  beforeEach(() => {
    banco.getVirtualMcp.mockResolvedValue(TIME_A);
    banco.linkSkill.mockResolvedValue(FICHA_DO_ADMIN);
    banco.unlinkSkill.mockResolvedValue(FICHA_DO_ADMIN);
  });

  it('PUT devolve a ficha de quem chamou: sem a ACL, sem contêiner alheio, sem uuid de conta', async () => {
    const res = await chamar('put', '/api/skills/:slug/mcps/:mcp', { user: leitor, params, body: FLAGS });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ slug: 'alfa', access: 'view', grants: [], catalogs: [], skillMd: '# alfa\n' });
    expect((res.body.mcps as { slug: string }[]).map((mcp) => mcp.slug)).toEqual(['time-a']);
    semUuidDeConta(res.body);
  });

  it('DELETE idem', async () => {
    const res = await chamar('delete', '/api/skills/:slug/mcps/:mcp', { user: leitor, params });

    expect(res.body).toMatchObject({ slug: 'alfa', access: 'view', grants: [] });
    expect(JSON.stringify(res.body)).not.toContain('fechado-da-ana');
  });

  // A skill privada que só chegava à sessão por aquele vMCP some para ela quando
  // o vínculo sai. A operação deu certo: 200 com corpo mínimo, nunca 404.
  it('DELETE responde 200 `{ unlinked: true }` quando a skill sai do alcance de quem chamou', async () => {
    banco.getSkillDetail.mockResolvedValue(null);

    const res = await chamar('delete', '/api/skills/:slug/mcps/:mcp', { user: leitor, params });

    expect(banco.unlinkSkill).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ unlinked: true });
  });

  it('DELETE de skill que não está no servidor é 404 sem ir ao banco — exista ela ou não', async () => {
    const res = await chamar('delete', '/api/skills/:slug/mcps/:mcp', { user: leitor, params: { slug: 'outra', mcp: 'time-a' } });

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'A skill "outra" não está vinculada a este MCP virtual' });
    expect(banco.getSkillSummary).not.toHaveBeenCalled();
    expect(banco.unlinkSkill).not.toHaveBeenCalled();
  });
});

describe('as outras rotas de skill que devolvem ficha', () => {
  it('PATCH: `mcps` e `catalogs` são os da leitura de quem chamou, não os da escrita', async () => {
    banco.getSkillSummary.mockResolvedValue({ ...FICHA_DO_LEITOR, access: 'edit' });
    banco.updateSkillWithContent.mockResolvedValue(FICHA_DO_ADMIN);

    const res = await chamar('patch', '/api/skills/:slug', { user: leitor, params: { slug: 'alfa' }, body: { description: 'nova' } });

    expect(res.body).toMatchObject({ access: 'edit', grants: [], catalogs: [] });
    expect((res.body.mcps as { slug: string }[]).map((mcp) => mcp.slug)).toEqual(['time-a']);
    semUuidDeConta(res.body);
  });

  it('GET /api/skills/:slug e GET /api/skills: o dono pelo e-mail', async () => {
    banco.listSkills.mockResolvedValue({ items: [FICHA_DO_LEITOR], total: 1, limit: 50, offset: 0 });

    const ficha = await chamar('get', '/api/skills/:slug', { user: ana, params: { slug: 'alfa' } });
    const lista = await chamar('get', '/api/skills', { user: leitor });

    semUuidDeConta(ficha.body);
    expect(ficha.body).toMatchObject({ access: 'owner', ownerUserUuid: 'ana@exemplo.dev' });
    expect((ficha.body.grants as unknown[]).length).toBe(2);
    expect(lista.body).toMatchObject({ total: 1, limit: 50, offset: 0, items: [{ slug: 'alfa', ownerUserUuid: 'ana@exemplo.dev' }] });
  });

  // A guia Auditoria de skill e de catálogo é de quem tem `manage`, não só de
  // admin: a conta que leu vai pelo e-mail.
  it('as leituras registradas: quem leu sai pelo e-mail', async () => {
    const pagina = {
      items: [
        { id: 'a1', userUuid: 'uuid-bia', userEmail: 'bia@exemplo.dev', ip: '198.51.100.7' },
        { id: 'a2', userUuid: null, userEmail: null, ip: '198.51.100.8' },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    };
    banco.listSkillAccesses.mockResolvedValue(pagina);
    banco.getCatalog.mockResolvedValue({ uuid: 'cat-1', slug: 'dados', access: 'manage', grants: [], mcps: [], skills: [] });

    const daSkill = await chamar('get', '/api/skills/:slug/accesses', { user: ana, params: { slug: 'alfa' } });
    const doCatalogo = await chamar('get', '/api/catalogs/:slug/accesses', { user: leitor, params: { slug: 'dados' } });

    for (const res of [daSkill, doCatalogo]) {
      semUuidDeConta(res.body);
      expect(res.body.items).toEqual([
        { id: 'a1', userUuid: 'bia@exemplo.dev', userEmail: 'bia@exemplo.dev', ip: '198.51.100.7' },
        { id: 'a2', userUuid: null, userEmail: null, ip: '198.51.100.8' },
      ]);
    }
  });
});

/**
 * `String(valor ?? '')` num objeto cujo `toString` não é função lança
 * `TypeError`: a rota respondia 500 e gravava "erro inesperado" no log por um
 * corpo que é erro de quem chamou (achado do relatório 007 da auditoria de
 * 2026-09-19).
 */
describe('`name` que não é texto é 400 e não suja o log', () => {
  it.each([
    ['post', '/api/mcps', {}],
    ['post', '/api/catalogs', {}],
    ['post', '/api/mcps/:slug/keys', { slug: 'time-a' }],
  ])('%s %s', async (method, path, params) => {
    banco.getVirtualMcp.mockResolvedValue({ ...TIME_A, access: 'owner' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await chamar(method, path, { user: ana, params, body: { name: { toString: 1 } } });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request', message: 'O campo "name" deve ser uma string' });
    expect(log).not.toHaveBeenCalled();
    expect(banco.createVirtualMcp).not.toHaveBeenCalled();
    expect(banco.createCatalog).not.toHaveBeenCalled();
  });
});
