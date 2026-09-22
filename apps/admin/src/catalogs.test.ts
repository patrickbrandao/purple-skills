/**
 * O que a ficha de um catálogo devolve no painel, e a quem
 * (`docs/12-acesso-granular.md` §3.1 e decisões 10, 11 e 13).
 *
 * Os comportamentos que mais custariam caro se mudassem sem querer:
 *
 * 1. **a resposta de uma escrita é a de quem chamou, não a do admin.** As
 *    escritas do banco releem sem `viewer`; o que volta para quem só tem `edit`
 *    não pode trazer o servidor fechado de terceiros que o `GET` esconde;
 * 2. **revogar não depende do estado da conta**, e a resposta não diz se existe
 *    conta com aquele e-mail;
 * 3. **nenhuma conta sai pelo uuid**: o dono e as concessões vão pelo e-mail.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accessLevel, type AccessLevel } from '@purple-skills/shared';
import type { AuthUser } from './auth.js';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

/** As funções do banco que estes caminhos tocam, pelo nome. */
const banco = vi.hoisted(() => ({
  getCatalog: vi.fn(),
  listCatalogs: vi.fn(),
  cloneCatalog: vi.fn(),
  createCatalog: vi.fn(),
  updateCatalog: vi.fn(),
  setCatalogSkills: vi.fn(),
  addCatalogSkill: vi.fn(),
  setCatalogSkillActive: vi.fn(),
  removeCatalogSkill: vi.fn(),
  setCatalogGrant: vi.fn(),
  removeCatalogGrant: vi.fn(),
  getSkillSummary: vi.fn(),
  getUserByUsername: vi.fn(),
}));

// Só estas são trocadas: o resto do pacote entra de verdade (`AppError`,
// `notFound`, `badRequest`) e nada nele abre conexão em tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...banco,
}));

const { NAME_MAX } = await import('./mcps.js');
const { clone, create, detail, listMine, putSkill, removeSkill, setSkills, share, unshare, update } = await import('./catalogs.js');
// O `AppError` de verdade, para o caso do 409 que o banco levanta.
const { conflict } = await import('@purple-skills/db');

type Viewer = { role: AuthUser['role']; userUuid: string | null };

const DONA = 'uuid-dona';

const sessao = (role: AuthUser['role'], uuid: string): AuthUser => ({
  uuid,
  username: role,
  avatarUpdatedAt: null,
  // O e-mail continua na sessão — é a própria conta se vendo (`docs/19` decisão
  // 8). O que saiu das superfícies é o e-mail de **outra** pessoa.
  email: `${role}@exemplo.dev`,
  name: role,
  role,
  mustChangePassword: false,
  legacy: false,
});

const dona = sessao('editor', DONA);
const admin = sessao('admin', 'uuid-admin');
const convidado = sessao('membro', 'uuid-convidado');
/** A mesma conta convidada, com papel que pode criar: clonar precisa dos dois lados. */
const convidadoEditor = sessao('editor', 'uuid-convidado');

/** A concessão que o banco encontraria para a conta convidada. */
let concedido: AccessLevel | null = null;

const FLAGS = { asSkill: true, asPrompt: false, asResource: false };

const CONCESSAO = {
  userUuid: 'uuid-bia',
  username: 'bia',
  name: 'Bia',
  role: 'membro',
  isActive: true,
  level: 'edit',
  grantedByUserUuid: 'uuid-ana',
  grantedByUsername: 'ana',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const DESATIVADA = { ...CONCESSAO, userUuid: 'uuid-saiu', username: 'saiu', name: 'Saiu', isActive: false };

const mcpRef = (slug: string, ownerUserUuid: string) => ({
  uuid: `ref-${slug}`,
  slug,
  name: slug,
  isOpen: slug === 'aberto',
  isActive: true,
  isDefault: false,
  ownerUserUuid,
  ...FLAGS,
});

const ABERTO = mcpRef('aberto', 'uuid-ana');
const FECHADO_ALHEIO = mcpRef('fechado-do-bruno', 'uuid-bruno');

/**
 * O que `getCatalog` devolve: com `viewer` que não é admin, `mcps` já vem
 * recortado pelo banco (só os servidores que a conta vê); sem `viewer` — é
 * assim que as escritas releem — vem tudo.
 */
function catalogoVisto(viewer?: Viewer) {
  const todos = !viewer || viewer.role === 'admin';
  return {
    uuid: 'uuid-catalogo',
    slug: 'dados',
    name: 'Dados',
    description: '',
    isActive: true,
    isPublic: true,
    ownerUserUuid: DONA,
    // De propósito sem o uuid dentro: os casos do relatório 011 procuram o uuid no JSON.
    ownerUsername: 'dona',
    skillCount: 1,
    activeSkillCount: 1,
    mcpCount: 2,
    skills: [{ uuid: 'skill-1', slug: 'alfa', name: 'Alfa', isActive: true, skillIsActive: true }],
    mcps: todos ? [ABERTO, FECHADO_ALHEIO] : [ABERTO],
    grants: [CONCESSAO, DESATIVADA],
    access: viewer
      ? accessLevel(viewer.role, DONA, viewer.userUuid === convidado.uuid ? concedido : null, viewer.userUuid) ?? 'view'
      : 'owner',
  };
}

const ESCRITAS = ['updateCatalog', 'setCatalogSkills', 'addCatalogSkill', 'setCatalogSkillActive', 'removeCatalogSkill', 'createCatalog', 'cloneCatalog'] as const;

beforeEach(() => {
  vi.clearAllMocks();
  concedido = null;
  banco.getCatalog.mockImplementation((_slug: string, options?: { viewer?: Viewer }) => Promise.resolve(catalogoVisto(options?.viewer)));
  // A lista é de resumos: sem membros, vínculos nem concessões.
  banco.listCatalogs.mockImplementation(() => {
    const { skills: _skills, mcps: _mcps, grants: _grants, ...resumo } = catalogoVisto();
    return Promise.resolve([resumo]);
  });
  banco.getSkillSummary.mockResolvedValue({ slug: 'alfa', access: 'view' });
  // Toda escrita relê na visão do admin.
  for (const escrita of ESCRITAS) banco[escrita].mockImplementation(() => Promise.resolve(catalogoVisto()));
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

const slugs = (ficha: { mcps: { slug: string }[] }) => ficha.mcps.map((mcp) => mcp.slug);

/**
 * A ficha do catálogo revelava a qualquer leitor todo vMCP vinculado, inclusive
 * o fechado de terceiros; o banco passou a recortar a leitura com `viewer`. As
 * escritas releem **sem** `viewer`, então a resposta de quem só tem `edit` traria
 * a lista inteira de volta (relatório 010 da auditoria de 2026-09-19).
 */
describe('a resposta de uma escrita não devolve o vMCP fechado que a leitura esconde', () => {
  beforeEach(() => {
    concedido = 'edit';
  });

  it('a leitura repassa o recorte do banco', async () => {
    expect(slugs(await detail(convidado, 'dados'))).toEqual(['aberto']);
    expect(banco.getCatalog).toHaveBeenCalledWith('dados', { viewer: { role: 'membro', userUuid: 'uuid-convidado' } });
  });

  it.each([
    ['definir a lista de skills', () => setSkills(convidado, 'dados', { skills: [{ slug: 'alfa' }] })],
    ['adicionar uma skill', () => putSkill(convidado, 'dados', 'beta', undefined)],
    ['desativar a participação', () => putSkill(convidado, 'dados', 'alfa', { isActive: false })],
    ['remover uma skill', () => removeSkill(convidado, 'dados', 'alfa')],
  ])('%s', async (_caso, escrever) => {
    const ficha = await escrever();

    expect(slugs(ficha)).toEqual(['aberto']);
    expect(JSON.stringify(ficha)).not.toContain('fechado-do-bruno');
    // O contador continua global, de propósito: a diferença é o "e mais N que você não vê".
    expect(ficha.mcpCount).toBe(2);
    expect(ficha).toMatchObject({ access: 'edit', grants: [] });
  });

  it('alterar propriedades, por quem tem `manage`', async () => {
    concedido = 'manage';

    const ficha = await update(convidado, 'dados', { description: 'nova' });

    expect(slugs(ficha)).toEqual(['aberto']);
    expect(ficha.access).toBe('manage');
  });

  it('o admin continua recebendo todos', async () => {
    expect(slugs(await update(admin, 'dados', { description: 'nova' }))).toEqual(['aberto', 'fechado-do-bruno']);
  });
});

/**
 * `manage` revoga **qualquer** concessão (`docs/12` decisão 10), inclusive a de
 * conta desativada depois de recebê-la (relatório 039 da auditoria de
 * 2026-09-19). Conceder e transferir continuam exigindo conta ativa.
 */
describe('concessões: revogar não exige conta ativa', () => {
  beforeEach(() => {
    banco.getUserByUsername.mockImplementation((username: string) =>
      Promise.resolve(username === 'saiu' ? { uuid: 'uuid-saiu', username, isActive: false } : null),
    );
  });

  it('revoga a concessão de conta desativada', async () => {
    await unshare(dona, 'dados', 'Saiu');

    expect(banco.removeCatalogGrant).toHaveBeenCalledWith('dados', 'uuid-saiu', 'web-admin', expect.objectContaining({ userUuid: DONA }));
  });

  it('conceder — e mudar o nível — de conta desativada continua recusado', async () => {
    expect(await recusa(share(dona, 'dados', 'saiu', 'view'))).toEqual({
      status: 404,
      message: 'Conta não encontrada ou desativada: saiu',
    });
    expect(banco.setCatalogGrant).not.toHaveBeenCalled();
  });

  it('e-mail sem concessão aqui é 404 sem consultar a conta', async () => {
    expect(await recusa(unshare(dona, 'dados', 'ninguem'))).toEqual({
      status: 404,
      message: 'A conta não tem concessão neste catálogo',
    });
    expect(banco.getUserByUsername).not.toHaveBeenCalled();
    expect(banco.removeCatalogGrant).not.toHaveBeenCalled();
  });

  it('quem só edita não revoga', async () => {
    concedido = 'edit';

    expect((await recusa(unshare(convidado, 'dados', 'saiu'))).status).toBe(403);
    expect(banco.removeCatalogGrant).not.toHaveBeenCalled();
  });
});

/**
 * Nome de catálogo não tinha teto, e é copiado em cada linha de
 * `skill_accesses` (relatório 042 da auditoria de 2026-09-19). Vale para quem
 * cria ou renomeia; o nome antigo continua válido até alguém mexer nele.
 */
describe('teto de nome de catálogo', () => {
  const LONGO = 'n'.repeat(NAME_MAX + 1);

  it('criar acima do teto é 400 com o número, antes do banco; no teto passa', async () => {
    const erro = await recusa(create(dona, { name: LONGO }));
    expect(erro.status).toBe(400);
    expect(erro.message).toContain(String(NAME_MAX));
    expect(banco.createCatalog).not.toHaveBeenCalled();

    await create(dona, { name: 'n'.repeat(NAME_MAX) });
    expect(banco.createCatalog).toHaveBeenCalledOnce();
  });

  it('renomear acima do teto é 400; o nome antigo, mesmo longo, volta no Salvar', async () => {
    expect((await recusa(update(dona, 'dados', { name: LONGO }))).status).toBe(400);
    expect(banco.updateCatalog).not.toHaveBeenCalled();

    banco.getCatalog.mockImplementation((_slug: string, options?: { viewer?: Viewer }) =>
      Promise.resolve({ ...catalogoVisto(options?.viewer), name: LONGO }),
    );
    await update(dona, 'dados', { name: LONGO, description: 'nova' });
    expect(banco.updateCatalog).toHaveBeenCalledWith('uuid-catalogo', { name: LONGO, description: 'nova' }, 'web-admin', expect.anything());
  });

  // `String(valor ?? '')` num objeto cujo `toString` não é função lançava
  // `TypeError`: 500 por um corpo que é erro de quem chamou (achado do relatório 007).
  it.each([[{ toString: 1 }], [123], [['a']]])('criar com name %j é 400, não 500', async (name) => {
    expect(await recusa(create(dona, { name }))).toMatchObject({ status: 400, message: 'O campo "name" deve ser uma string' });
    expect(banco.createCatalog).not.toHaveBeenCalled();
  });
});

/**
 * Clonar um catálogo (`docs/16-clonagem.md`).
 *
 * Os comportamentos que mais custariam caro se mudassem sem querer:
 *
 * 1. **são duas exigências, nesta ordem**: `edit` no original — o mesmo corte
 *    da lista de membros — e papel que possa criar. Quem não enxerga o
 *    catálogo recebe 404 antes das duas;
 * 2. **o corte não é `manage`**, como no vMCP: a cópia do catálogo não leva a
 *    ACL do original, então quem recebeu `edit` para mexer na lista pode
 *    levá-la para uma cópia sua;
 * 3. **o desempate do slug é do banco**: corpo sem `slug` nunca dá 409; o
 *    slug pedido que já existe volta de lá com o 409 inteiro.
 */
describe('clonar um catálogo', () => {
  /** O que `cloneCatalog` devolve: um catálogo novo, fechado, de quem clonou. */
  const COPIA = { ...catalogoVisto(), uuid: 'uuid-copia', slug: 'dados-2', isPublic: false };

  beforeEach(() => {
    banco.cloneCatalog.mockResolvedValue(COPIA);
  });

  it('o dono clona, e o corpo vazio chega ao banco só com o dono da cópia', async () => {
    const copia = await clone(dona, 'dados', {});

    expect(copia).toMatchObject({ slug: 'dados-2', isPublic: false, access: 'owner' });
    expect(banco.cloneCatalog).toHaveBeenCalledWith('uuid-catalogo', { ownerUserUuid: DONA }, 'web-admin', expect.objectContaining({ userUuid: DONA }));
  });

  it('nome e slug pedidos chegam aparados, e o teto do nome vale como na criação', async () => {
    await clone(dona, 'dados', { name: ' Dados copiados ', slug: ' dados-copia ' });
    expect(banco.cloneCatalog).toHaveBeenCalledWith(
      'uuid-catalogo',
      { name: 'Dados copiados', slug: 'dados-copia', ownerUserUuid: DONA },
      'web-admin',
      expect.anything(),
    );

    expect((await recusa(clone(dona, 'dados', { name: 'x'.repeat(NAME_MAX + 1) }))).status).toBe(400);
    expect(banco.cloneCatalog).toHaveBeenCalledOnce();
  });

  it('`edit` concedido basta para quem pode criar', async () => {
    concedido = 'edit';

    const copia = await clone(convidadoEditor, 'dados', {});

    expect(copia).toMatchObject({ slug: 'dados-2' });
    expect(banco.cloneCatalog).toHaveBeenCalledWith('uuid-catalogo', { ownerUserUuid: 'uuid-convidado' }, 'web-admin', expect.anything());
  });

  it('403 para papel membro, mesmo com `edit` no original', async () => {
    concedido = 'edit';

    expect(await recusa(clone(convidado, 'dados', {}))).toEqual({
      status: 403,
      message: 'Seu papel não permite criar no acervo',
    });
    expect(banco.cloneCatalog).not.toHaveBeenCalled();
  });

  it('403 para quem só vê o catálogo: copiar a lista inteira é `edit`', async () => {
    concedido = 'view';

    const erro = await recusa(clone(convidadoEditor, 'dados', {}));

    expect(erro.status).toBe(403);
    expect(erro.message).toContain('editar');
    expect(banco.cloneCatalog).not.toHaveBeenCalled();
  });

  it('404 para slug que a sessão não enxerga, antes de conferir papel', async () => {
    banco.getCatalog.mockResolvedValue(null);

    expect((await recusa(clone(convidado, 'sumido', {}))).status).toBe(404);
    expect(banco.cloneCatalog).not.toHaveBeenCalled();
  });

  it('o 409 do slug pedido que já existe volta inteiro', async () => {
    banco.cloneCatalog.mockRejectedValue(conflict('Já existe um catálogo com o slug "dados-copia"'));

    expect(await recusa(clone(dona, 'dados', { slug: 'dados-copia' }))).toEqual({
      status: 409,
      message: 'Já existe um catálogo com o slug "dados-copia"',
    });
  });
});

/**
 * O `uuid` da conta é o `sub` do cookie de sessão. Saía em `ownerUserUuid`, nos
 * dois uuids de cada concessão e no dono de cada vMCP vinculado (relatório 011 da
 * auditoria de 2026-09-19). Na borda da REST a conta se identifica pelo e-mail.
 */
describe('nenhuma resposta de catálogo carrega uuid de conta', () => {
  const UUIDS_DE_CONTA = [DONA, 'uuid-bia', 'uuid-ana', 'uuid-saiu', 'uuid-bruno'];

  const semUuidDeConta = (payload: unknown) => {
    const json = JSON.stringify(payload);
    for (const uuid of UUIDS_DE_CONTA) expect(json).not.toContain(uuid);
  };

  it('a ficha sai com o dono e as concessões pelo e-mail, e sem o dono dos vMCPs', async () => {
    const ficha = await detail(admin, 'dados');

    semUuidDeConta(ficha);
    expect(ficha).toMatchObject({ ownerUserUuid: 'dona', ownerUsername: 'dona' });
    expect(ficha.grants[0]).toEqual({ ...CONCESSAO, userUuid: 'bia', grantedByUserUuid: 'ana' });
    expect(ficha.grants[1]).toMatchObject({ username: 'saiu', isActive: false });
    expect(ficha.mcps[1]).not.toHaveProperty('ownerUserUuid');
    expect(ficha.mcps[1]).toMatchObject({ slug: 'fechado-do-bruno', asSkill: true });
  });

  it('lista, criação e escritas também', async () => {
    semUuidDeConta(await listMine(admin));
    semUuidDeConta(await create(admin, { name: 'Novo' }));
    semUuidDeConta(await update(admin, 'dados', { description: 'x' }));
    semUuidDeConta(await setSkills(admin, 'dados', { skills: [{ slug: 'alfa' }] }));
  });

  it('conceder devolve a concessão pelo e-mail', async () => {
    banco.getUserByUsername.mockResolvedValue({ uuid: 'uuid-bia', username: 'bia', isActive: true });
    banco.setCatalogGrant.mockResolvedValue(CONCESSAO);

    const concessao = await share(admin, 'dados', 'bia', 'edit');

    semUuidDeConta(concessao);
    expect(concessao).toMatchObject({ username: 'bia', userUuid: 'bia', level: 'edit' });
  });
});
