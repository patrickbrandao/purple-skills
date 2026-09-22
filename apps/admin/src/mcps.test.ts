/**
 * A permissão do canvas e dos vínculos de um vMCP no painel
 * (`docs/12-acesso-granular.md` §3.2 e decisões 6 e 7; `docs/10` §4.4).
 *
 * Os comportamentos que mais custariam caro se mudassem sem querer:
 *
 * 1. **o corte é `edit`, não "dono ou admin".** Arrastar um nó, ligar uma
 *    porta e acrescentar uma skill são ações de `edit`; nome, slug, abertura
 *    e chaves continuam em `manage`. Apertar isto para `manage` trancaria
 *    quem recebeu `edit` justamente para publicar; afrouxar para `view`
 *    entregaria publicação a quem só devia ler;
 * 2. **quem não alcança o nível recebe 403 com o motivo**, não uma falha
 *    calada: a mensagem diz o nível que a conta tem e o que a ação exige;
 * 3. **abrir um vMCP não pede confirmação**, nem com skill dentro: o
 *    `confirm_open` do `08` saiu no PR2 do `09` (decisão 9 e `§4.4`), e o que
 *    informa é o aviso inline do painel (`12`, decisão 15).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accessLevel, type AccessLevel } from '@purple-skills/shared';
import type { AuthUser } from './auth.js';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const { lerMcp, gravarCanvas, gravarSkills, atualizar, lerSkill } = vi.hoisted(() => ({
  lerMcp: vi.fn(),
  gravarCanvas: vi.fn(),
  gravarSkills: vi.fn(),
  atualizar: vi.fn(),
  lerSkill: vi.fn(),
}));

/** O resto do banco que os casos de vínculo, chave, concessão e nome tocam — pelo nome da função. */
const banco = vi.hoisted(() => ({
  cloneVirtualMcp: vi.fn(),
  createVirtualMcp: vi.fn(),
  listVirtualMcps: vi.fn(),
  linkSkill: vi.fn(),
  unlinkSkill: vi.fn(),
  getSkillDetail: vi.fn(),
  createVirtualMcpKey: vi.fn(),
  revokeVirtualMcpKey: vi.fn(),
  listVirtualMcpKeys: vi.fn(),
  recordAccountAudit: vi.fn(),
  getUserByUsername: vi.fn(),
  setVirtualMcpGrant: vi.fn(),
  removeVirtualMcpGrant: vi.fn(),
}));

// Só as funções destes caminhos são trocadas: o resto do pacote entra de
// verdade (`AppError`, `notFound`, `badRequest`) e nada nele abre conexão em
// tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...banco,
  getVirtualMcp: lerMcp,
  setVirtualMcpCanvas: gravarCanvas,
  setVirtualMcpSkills: gravarSkills,
  updateVirtualMcp: atualizar,
  getSkillSummary: lerSkill,
}));

const {
  NAME_MAX,
  clone,
  create,
  detail,
  issueKey,
  linkSkill,
  listKeys,
  listMine,
  revokeKey,
  setCanvas,
  setSkills,
  share,
  unlinkSkill,
  unshare,
  update,
} = await import('./mcps.js');
// O `AppError` de verdade, para o caso do 409 que o banco levanta.
const { conflict } = await import('@purple-skills/db');

const DONO = 'uuid-dono';

const sessao = (role: AuthUser['role'], uuid: string | null): AuthUser => ({
  uuid,
  username: uuid ?? 'bootstrap',
  avatarUpdatedAt: null,
  // Ver a nota em `access.test.ts`: a sessão vê o próprio e-mail.
  email: uuid ? `${uuid}@exemplo.dev` : '',
  name: role,
  role,
  mustChangePassword: false,
  legacy: false,
});

const dono = sessao('editor', DONO);
const admin = sessao('admin', 'uuid-admin');
const convidado = sessao('membro', 'uuid-convidado');
/** A mesma conta convidada, com papel que pode criar: clonar precisa dos dois lados. */
const convidadoEditor = sessao('editor', 'uuid-convidado');

/** A concessão que o banco encontraria para a conta convidada. */
let concedido: AccessLevel | null = null;

/**
 * O que a consulta com `viewer` devolveria (`docs/12` §3.1): o `access` sai do
 * mesmo `accessLevel` do `shared`, então admin e dono chegam aqui como `owner`.
 */
function mcpVisto(viewer: { role: AuthUser['role']; userUuid: string | null }) {
  return {
    uuid: 'uuid-mcp',
    slug: 'time-a',
    name: 'Time A',
    ownerUserUuid: DONO,
    // De propósito sem o uuid dentro: os casos do relatório 011 procuram o uuid no JSON.
    ownerUsername: 'dona',
    isOpen: true,
    isActive: true,
    skills: [],
    catalogs: [],
    grants: [],
    access: accessLevel(viewer.role, DONO, viewer.userUuid === convidado.uuid ? concedido : null, viewer.userUuid),
  };
}

const CANVAS = { positions: [{ slug: 'alfa', x: 24, y: 48 }] };
const VINCULO = { skills: [{ slug: 'alfa', asSkill: true, asPrompt: false, asResource: false }] };

beforeEach(() => {
  vi.clearAllMocks();
  concedido = null;
  lerMcp.mockImplementation((_slug: string, options: { viewer: { role: AuthUser['role']; userUuid: string | null } }) =>
    Promise.resolve(mcpVisto(options.viewer)),
  );
  lerSkill.mockResolvedValue({ slug: 'alfa', access: 'view' });
  gravarSkills.mockImplementation(() => Promise.resolve(mcpVisto({ role: 'admin', userUuid: 'uuid-admin' })));
  atualizar.mockImplementation(() => Promise.resolve(mcpVisto({ role: 'admin', userUuid: 'uuid-admin' })));
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

describe('permissão do canvas e dos vínculos (docs/12 §3.2)', () => {
  it('`edit` concedido move nós e vincula skill, mas não muda propriedades', async () => {
    concedido = 'edit';

    await setCanvas(convidado, 'time-a', CANVAS);
    expect(gravarCanvas).toHaveBeenCalledWith('uuid-mcp', expect.objectContaining({ positions: CANVAS.positions }));

    await setSkills(convidado, 'time-a', VINCULO);
    expect(gravarSkills).toHaveBeenCalledOnce();

    const erro = await recusa(update(convidado, 'time-a', { name: 'Outro nome' }));
    expect(erro.status).toBe(403);
    expect(erro.message).toContain('administrar');
    expect(atualizar).not.toHaveBeenCalled();
  });

  it('`view` só lê: recusa com 403 dizendo o nível que tem e o que falta', async () => {
    concedido = 'view';

    const canvas = await recusa(setCanvas(convidado, 'time-a', CANVAS));
    expect(canvas.status).toBe(403);
    expect(canvas.message).toContain('visualizar');
    expect(canvas.message).toContain('editar');
    expect(gravarCanvas).not.toHaveBeenCalled();

    expect((await recusa(setSkills(convidado, 'time-a', VINCULO))).status).toBe(403);
    expect(gravarSkills).not.toHaveBeenCalled();
  });

  it('sem concessão nenhuma, o vMCP não existe para a conta: 404', async () => {
    expect((await recusa(setCanvas(convidado, 'time-a', CANVAS))).status).toBe(404);
  });

  it('o dono e o admin não ficam trancados por lugar nenhum', async () => {
    for (const user of [dono, admin]) {
      await setCanvas(user, 'time-a', CANVAS);
      await setSkills(user, 'time-a', VINCULO);
      await update(user, 'time-a', { name: 'Outro nome' });
    }
    expect(gravarCanvas).toHaveBeenCalledTimes(2);
    expect(gravarSkills).toHaveBeenCalledTimes(2);
    expect(atualizar).toHaveBeenCalledTimes(2);
  });
});

/**
 * A confirmação de abertura existiu — `confirm_open_required` e `confirmOpen`
 * entraram com o `08` e saíram no PR2 do `09`, junto com o
 * `privateSkillCount`. Hoje abrir é uma caixa como outra qualquer (`09`
 * decisão 9), e quem informa é o painel (`12` decisão 15). O caso abaixo
 * existe para que ressuscitar a checagem no backend seja uma decisão, e não um
 * acidente de quem lê a `§3.3` do `08` sem a marca de revogação.
 */
describe('abrir um vMCP (docs/09 decisão 9)', () => {
  it('liga is_open sem confirmação, mesmo com skill vinculada', async () => {
    lerMcp.mockImplementation((_slug: string, options: { viewer: { role: AuthUser['role']; userUuid: string | null } }) =>
      Promise.resolve({ ...mcpVisto(options.viewer), isOpen: false, skills: [{ slug: 'alfa' }] }),
    );

    await update(dono, 'time-a', { isOpen: true });

    expect(atualizar).toHaveBeenCalledWith('uuid-mcp', { isOpen: true }, 'web-admin', expect.objectContaining({ userUuid: DONO }));
  });
});

/**
 * Clonar um MCP virtual (`docs/16-clonagem.md`).
 *
 * Os comportamentos que mais custariam caro se mudassem sem querer:
 *
 * 1. **o corte é `manage`, e não o `edit` da skill e do catálogo.** O clone
 *    leva a ACL do original junto, e ler a lista de concessões já é poder de
 *    `manage` (`docs/12` decisão 11): com `edit` bastando, quem só publica no
 *    servidor descobriria pela cópia com quem ele é dividido;
 * 2. **o papel também é exigido**, porque a cópia é uma criação — e o objeto
 *    vem primeiro, então quem não enxerga o vMCP recebe 404 antes disso;
 * 3. **o desempate do slug é do banco**: corpo sem `slug` nunca dá 409; o
 *    slug pedido que já existe volta de lá com o 409 inteiro.
 */
describe('clonar um vMCP', () => {
  /** O que `cloneVirtualMcp` devolve: um servidor novo, fechado, de quem clonou. */
  const COPIA = { ...mcpVisto({ role: 'admin', userUuid: 'uuid-admin' }), uuid: 'uuid-copia', slug: 'time-a-2', isOpen: false };

  beforeEach(() => {
    banco.cloneVirtualMcp.mockResolvedValue(COPIA);
  });

  it('o dono clona, e o corpo vazio chega ao banco só com o dono da cópia', async () => {
    const copia = await clone(dono, 'time-a', {});

    expect(copia).toMatchObject({ slug: 'time-a-2', isOpen: false, access: 'owner' });
    expect(banco.cloneVirtualMcp).toHaveBeenCalledWith('uuid-mcp', { ownerUserUuid: DONO }, 'web-admin', expect.objectContaining({ userUuid: DONO }));
  });

  it('nome e slug pedidos chegam aparados, e o teto do nome vale como na criação', async () => {
    await clone(dono, 'time-a', { name: ' Time A copiado ', slug: ' time-a-copia ' });
    expect(banco.cloneVirtualMcp).toHaveBeenCalledWith(
      'uuid-mcp',
      { name: 'Time A copiado', slug: 'time-a-copia', ownerUserUuid: DONO },
      'web-admin',
      expect.anything(),
    );

    expect((await recusa(clone(dono, 'time-a', { name: 'x'.repeat(NAME_MAX + 1) }))).status).toBe(400);
    expect(banco.cloneVirtualMcp).toHaveBeenCalledOnce();
  });

  it('`manage` concedido basta para quem pode criar', async () => {
    concedido = 'manage';

    const copia = await clone(convidadoEditor, 'time-a', {});

    expect(copia).toMatchObject({ slug: 'time-a-2' });
    expect(banco.cloneVirtualMcp).toHaveBeenCalledWith('uuid-mcp', { ownerUserUuid: 'uuid-convidado' }, 'web-admin', expect.anything());
  });

  it('403 para quem tem só `edit`: o clone leva a ACL, e ler a ACL é de `manage`', async () => {
    concedido = 'edit';

    const erro = await recusa(clone(convidadoEditor, 'time-a', {}));

    expect(erro.status).toBe(403);
    expect(erro.message).toContain('administrar');
    expect(banco.cloneVirtualMcp).not.toHaveBeenCalled();
  });

  it('403 para papel membro, mesmo com `manage` no original', async () => {
    concedido = 'manage';

    expect(await recusa(clone(convidado, 'time-a', {}))).toEqual({
      status: 403,
      message: 'Seu papel não permite criar no acervo',
    });
    expect(banco.cloneVirtualMcp).not.toHaveBeenCalled();
  });

  it('404 para slug que a sessão não enxerga, antes de conferir papel', async () => {
    expect((await recusa(clone(convidado, 'time-a', {}))).status).toBe(404);
    expect(banco.cloneVirtualMcp).not.toHaveBeenCalled();
  });

  it('o 409 do slug pedido que já existe volta inteiro', async () => {
    banco.cloneVirtualMcp.mockRejectedValue(conflict('Já existe um MCP virtual com o slug "time-a-copia"'));

    expect(await recusa(clone(dono, 'time-a', { slug: 'time-a-copia' }))).toEqual({
      status: 409,
      message: 'Já existe um MCP virtual com o slug "time-a-copia"',
    });
  });
});

// --------------------------------------------- auditoria de 2026-09-19 ---

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

const vmcpRef = (slug: string) => ({
  uuid: `ref-${slug}`,
  slug,
  name: slug,
  isOpen: false,
  isActive: true,
  isDefault: false,
  ...FLAGS,
  direct: true,
  catalogs: [],
});

/** O que a escrita do banco devolve: a ficha na visão do admin (`'all'`). */
const FICHA_DO_ADMIN = {
  uuid: 'skill-alfa',
  slug: 'alfa',
  name: 'Alfa',
  skillMd: '# alfa',
  files: [],
  isPublic: true,
  ownerUserUuid: 'uuid-ana',
  ownerUsername: 'ana',
  access: 'owner',
  grants: [CONCESSAO],
  mcps: [vmcpRef('time-a'), vmcpRef('fechado-da-ana')],
  catalogs: [{ uuid: 'cat-1', slug: 'privado-da-ana', name: 'Privado', isActive: true, memberActive: true }],
};

/** O que a leitura com `viewer` devolve a quem só lê: o banco manda a ACL inteira, e o app é que a esconde. */
const FICHA_DO_LEITOR = { ...FICHA_DO_ADMIN, access: 'view', mcps: [vmcpRef('time-a')], catalogs: [] };

/** O vMCP com a skill `alfa` já vinculada direto. */
const comAlfa = () =>
  lerMcp.mockImplementation((_slug: string, options: { viewer: { role: AuthUser['role']; userUuid: string | null } }) =>
    Promise.resolve({ ...mcpVisto(options.viewer), skills: [{ slug: 'alfa' }] }),
  );

/**
 * O vínculo pelo lado da skill devolve a ficha dela — e a escrita relê na visão
 * do admin: `access: 'owner'`, a ACL inteira e todo contêiner, inclusive o
 * fechado de terceiros. A ação exige só `edit` em **algum** vMCP e `view` na
 * skill, então a resposta tem de ser a de quem chamou (relatório 009 da
 * auditoria de 2026-09-19; `docs/12` decisão 11).
 */
describe('vínculo pelo lado da skill: a resposta é a ficha de quem chamou', () => {
  beforeEach(() => {
    banco.linkSkill.mockResolvedValue(FICHA_DO_ADMIN);
    banco.unlinkSkill.mockResolvedValue(FICHA_DO_ADMIN);
    banco.getSkillDetail.mockResolvedValue(FICHA_DO_LEITOR);
  });

  it('PUT: quem só lê a skill recebe o próprio `access`, sem concessões nem contêiner alheio', async () => {
    concedido = 'edit';

    const ficha = await linkSkill(convidado, 'time-a', 'alfa', FLAGS);

    expect(banco.linkSkill).toHaveBeenCalledOnce();
    expect(banco.getSkillDetail).toHaveBeenCalledWith('alfa', { viewer: { role: 'membro', userUuid: 'uuid-convidado' } });
    expect(ficha).toMatchObject({ slug: 'alfa', access: 'view', grants: [], catalogs: [] });
    expect(ficha?.mcps.map((mcp) => mcp.slug)).toEqual(['time-a']);
    expect(JSON.stringify(ficha)).not.toContain('bia');
    expect(JSON.stringify(ficha)).not.toContain('fechado-da-ana');
  });

  it('PUT: quem administra a skill continua recebendo as concessões', async () => {
    concedido = 'edit';
    banco.getSkillDetail.mockResolvedValue({ ...FICHA_DO_ADMIN, access: 'manage' });

    const ficha = await linkSkill(convidado, 'time-a', 'alfa', FLAGS);

    expect(ficha?.access).toBe('manage');
    expect(ficha?.grants.map((grant) => grant.username)).toEqual(['bia']);
  });

  // O banco distingue "Skill não encontrada" de "não está vinculada" — os dois
  // 404, com textos diferentes: quem edita um servidor qualquer confirmaria a
  // existência de slug privado alheio. O app responde antes, pelo que já leu.
  it('DELETE: skill que não existe e skill que não está aqui dão a mesma resposta, sem ir ao banco', async () => {
    lerSkill.mockResolvedValue(null);
    const inexistente = await recusa(unlinkSkill(dono, 'time-a', 'alfa'));
    lerSkill.mockResolvedValue({ slug: 'alfa', access: 'view' });
    const foraDaqui = await recusa(unlinkSkill(dono, 'time-a', 'alfa'));

    expect(inexistente).toEqual({ status: 404, message: 'A skill "alfa" não está vinculada a este MCP virtual' });
    expect(foraDaqui).toEqual(inexistente);
    expect(banco.unlinkSkill).not.toHaveBeenCalled();
  });

  it('DELETE: devolve a ficha de quem chamou', async () => {
    comAlfa();
    concedido = 'edit';

    const ficha = await unlinkSkill(convidado, 'time-a', 'alfa');

    expect(banco.unlinkSkill).toHaveBeenCalledWith('alfa', 'uuid-mcp', 'web-admin', expect.objectContaining({ userUuid: 'uuid-convidado' }));
    expect(ficha).toMatchObject({ access: 'view', grants: [] });
    expect(JSON.stringify(ficha)).not.toContain('fechado-da-ana');
  });

  // Skill privada que só chegava à conta por este vMCP: desfeito o vínculo, a
  // releitura com `viewer` é nula — e isso é "deu certo", não 404.
  it('DELETE: a skill pode sair do alcance de quem chamou — nulo, não erro', async () => {
    comAlfa();
    concedido = 'edit';
    banco.getSkillDetail.mockResolvedValue(null);

    await expect(unlinkSkill(convidado, 'time-a', 'alfa')).resolves.toBeNull();
    expect(banco.unlinkSkill).toHaveBeenCalledOnce();
  });
});

/**
 * A trilha rotulava a emissão pelo nome e a revogação pelo uuid da chave — que
 * não aparece em tela nenhuma e some com o vMCP (`ON DELETE CASCADE`). O banco
 * passou a devolver `{ name, prefix }` na revogação (relatório 040 da auditoria
 * de 2026-09-19); o prefixo desempata chaves de mesmo nome.
 */
describe('chaves psv_: a auditoria rotula pelo nome, na emissão e na revogação', () => {
  const ID = '7c3f9e12-0000-4000-8000-00000000a41b';

  it('revogar audita `<slug>: <nome> (<prefixo>)`, não o uuid da chave', async () => {
    banco.revokeVirtualMcpKey.mockResolvedValue({ name: 'CI do projeto X', prefix: 'AbCd1234' });

    await revokeKey(dono, 'time-a', ID);

    expect(banco.revokeVirtualMcpKey).toHaveBeenCalledWith(ID, 'uuid-mcp');
    expect(banco.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mcp.key.revoke', targetLabel: 'time-a: CI do projeto X (AbCd1234)' }),
    );
    expect(JSON.stringify(banco.recordAccountAudit.mock.calls)).not.toContain(ID);
  });

  it('chave de outro servidor, ou já revogada, é 404 e não audita', async () => {
    banco.revokeVirtualMcpKey.mockResolvedValue(null);

    expect((await recusa(revokeKey(dono, 'time-a', ID))).status).toBe(404);
    expect(banco.recordAccountAudit).not.toHaveBeenCalled();
  });

  it('emitir audita com o mesmo rótulo que a revogação vai usar', async () => {
    banco.createVirtualMcpKey.mockImplementation((input: { name: string; prefix: string }) =>
      Promise.resolve({ id: ID, name: input.name, prefix: input.prefix, createdByUserUuid: DONO }),
    );

    const { key } = await issueKey(dono, 'time-a', '  CI do projeto X ');

    expect(banco.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mcp.key.create', targetLabel: `time-a: CI do projeto X (${key.prefix})` }),
    );
  });
});

/**
 * Nome de vMCP e de chave `psv_` não tinha teto nenhum, e os dois são copiados
 * em cada linha de `skill_accesses`, que nunca é podada (relatório 042 da
 * auditoria de 2026-09-19). O teto vale para quem **cria ou renomeia**: nome
 * antigo mais longo continua válido até alguém mexer nele — o Salvar do painel
 * reenvia o nome, e travar a edição de um objeto por causa do nome que ele já
 * tem seria defeito novo.
 */
describe('teto de nome de vMCP e de chave', () => {
  const LONGO = 'n'.repeat(NAME_MAX + 1);

  beforeEach(() => {
    banco.createVirtualMcp.mockImplementation((input: { name: string }) =>
      Promise.resolve({ ...mcpVisto({ role: 'admin', userUuid: 'uuid-admin' }), name: input.name }),
    );
  });

  it('criar acima do teto é 400 com o número, antes do banco; no teto passa', async () => {
    const erro = await recusa(create(dono, { name: LONGO }));
    expect(erro.status).toBe(400);
    expect(erro.message).toContain(String(NAME_MAX));
    expect(banco.createVirtualMcp).not.toHaveBeenCalled();

    await create(dono, { name: ` ${'n'.repeat(NAME_MAX)} ` });
    expect(banco.createVirtualMcp).toHaveBeenCalledWith(expect.objectContaining({ name: 'n'.repeat(NAME_MAX) }), 'web-admin', expect.anything());
  });

  it('renomear acima do teto é 400', async () => {
    expect((await recusa(update(dono, 'time-a', { name: LONGO }))).status).toBe(400);
    expect(atualizar).not.toHaveBeenCalled();
  });

  it('o nome antigo, mesmo acima do teto, volta no Salvar sem travar a edição', async () => {
    lerMcp.mockImplementation((_slug: string, options: { viewer: { role: AuthUser['role']; userUuid: string | null } }) =>
      Promise.resolve({ ...mcpVisto(options.viewer), name: LONGO }),
    );

    await update(dono, 'time-a', { name: LONGO, description: 'nova' });

    expect(atualizar).toHaveBeenCalledWith('uuid-mcp', { name: LONGO, description: 'nova' }, 'web-admin', expect.anything());
  });

  it('chave psv_: nome acima do teto é 400, antes de gerar a chave', async () => {
    expect((await recusa(issueKey(dono, 'time-a', LONGO))).status).toBe(400);
    expect(banco.createVirtualMcpKey).not.toHaveBeenCalled();
  });
});

/**
 * `String(valor ?? '')` sobre um campo JSON que é objeto com `toString` que não
 * é função lança `TypeError` — 500 e uma linha de "erro inesperado" no log por
 * um corpo que é erro de quem chamou (achado do relatório 007 da auditoria de
 * 2026-09-19). Nome que não é texto é 400, como o `skillMd` de tipo errado.
 */
describe('`name` que não é texto é 400, não 500', () => {
  it.each([[{ toString: 1 }], [123], [['a']], [true]])('criar com name %j', async (name) => {
    expect(await recusa(create(dono, { name }))).toMatchObject({ status: 400, message: 'O campo "name" deve ser uma string' });
    expect(banco.createVirtualMcp).not.toHaveBeenCalled();
  });

  it.each([[{ toString: 1 }], [123]])('emitir chave com name %j', async (name) => {
    expect(await recusa(issueKey(dono, 'time-a', name))).toMatchObject({ status: 400, message: 'O campo "name" deve ser uma string' });
    expect(banco.createVirtualMcpKey).not.toHaveBeenCalled();
  });

  it('sem nome continua sendo "dê um nome", não erro de tipo', async () => {
    expect((await recusa(issueKey(dono, 'time-a', undefined))).message).toContain('Dê um nome');
  });
});

/**
 * `manage` revoga **qualquer** concessão (`docs/12` decisão 10), inclusive a de
 * conta desativada depois de recebê-la: a linha fica, inerte, e reativar a
 * conta devolve o acesso. O e-mail era resolvido por um funil que exigia conta
 * ativa, então a linha não saía por superfície nenhuma (relatório 039 da
 * auditoria de 2026-09-19). A revogação passou a procurar a conta na própria
 * lista de concessões; conceder e transferir continuam exigindo conta ativa.
 */
describe('concessões: revogar não exige conta ativa', () => {
  const DESATIVADA = { ...CONCESSAO, userUuid: 'uuid-saiu', username: 'saiu', name: 'Saiu', isActive: false };

  beforeEach(() => {
    lerMcp.mockImplementation((_slug: string, options: { viewer: { role: AuthUser['role']; userUuid: string | null } }) =>
      Promise.resolve({ ...mcpVisto(options.viewer), grants: [CONCESSAO, DESATIVADA] }),
    );
    banco.getUserByUsername.mockImplementation((username: string) =>
      Promise.resolve(username === 'saiu' ? { uuid: 'uuid-saiu', username, isActive: false } : null),
    );
  });

  it('revoga a concessão de conta desativada', async () => {
    await unshare(dono, 'time-a', '  Saiu  ');

    expect(banco.removeVirtualMcpGrant).toHaveBeenCalledWith('time-a', 'uuid-saiu', 'web-admin', expect.objectContaining({ userUuid: DONO }));
  });

  it('conceder — e mudar o nível — de conta desativada continua recusado', async () => {
    const erro = await recusa(share(dono, 'time-a', 'saiu', 'view'));

    expect(erro).toEqual({ status: 404, message: 'Conta não encontrada ou desativada: saiu' });
    expect(banco.setVirtualMcpGrant).not.toHaveBeenCalled();
  });

  // Revogar não consulta `users`: a resposta não pode separar "não existe conta
  // com este e-mail" de "existe, e não tem concessão aqui" — nem para conta
  // desativada, que a busca de contas não revela (`docs/12` decisão 13).
  it('e-mail sem concessão aqui é o mesmo 404, exista a conta ou não', async () => {
    const semConta = await recusa(unshare(dono, 'time-a', 'ninguem'));
    banco.getUserByUsername.mockResolvedValue({ uuid: 'uuid-outra', username: 'ninguem', isActive: false });
    const comConta = await recusa(unshare(dono, 'time-a', 'ninguem'));

    expect(semConta).toEqual({ status: 404, message: 'A conta não tem concessão neste MCP virtual' });
    expect(comConta).toEqual(semConta);
    expect(banco.getUserByUsername).not.toHaveBeenCalled();
    expect(banco.removeVirtualMcpGrant).not.toHaveBeenCalled();
  });

  it('e-mail torto é 400', async () => {
    expect((await recusa(unshare(dono, 'time-a', 'a'))).status).toBe(400);
  });
});

/**
 * O `uuid` da conta é o `sub` do cookie de sessão, e a busca de contas já não o
 * entrega (`withoutUuid`). Ele continuava saindo ao lado do e-mail em toda
 * ficha e lista — `ownerUserUuid`, os dois uuids de cada concessão, o dono dos
 * catálogos aninhados e quem emitiu cada chave (relatório 011 da auditoria de
 * 2026-09-19). Na borda da REST a conta se identifica pelo e-mail.
 */
describe('nenhuma resposta de vMCP carrega uuid de conta alheia', () => {
  const UUIDS_DE_CONTA = [DONO, 'uuid-bia', 'uuid-ana', 'uuid-dona-do-catalogo'];

  const mcpCheio = (viewer: { role: AuthUser['role']; userUuid: string | null }) => ({
    ...mcpVisto(viewer),
    grants: [CONCESSAO],
    catalogs: [{ uuid: 'cat-1', slug: 'dados', name: 'Dados', ownerUserUuid: 'uuid-dona-do-catalogo', ...FLAGS }],
  });

  const semUuidDeConta = (payload: unknown) => {
    const json = JSON.stringify(payload);
    for (const uuid of UUIDS_DE_CONTA) expect(json).not.toContain(uuid);
  };

  beforeEach(() => {
    lerMcp.mockImplementation((_slug: string, options: { viewer: { role: AuthUser['role']; userUuid: string | null } }) =>
      Promise.resolve(mcpCheio(options.viewer)),
    );
    atualizar.mockImplementation(() => Promise.resolve(mcpCheio({ role: 'admin', userUuid: 'uuid-admin' })));
    gravarSkills.mockImplementation(() => Promise.resolve(mcpCheio({ role: 'admin', userUuid: 'uuid-admin' })));
    banco.createVirtualMcp.mockImplementation(() => Promise.resolve(mcpCheio({ role: 'admin', userUuid: 'uuid-admin' })));
    banco.listVirtualMcps.mockImplementation(() => Promise.resolve([mcpVisto({ role: 'admin', userUuid: 'uuid-admin' })]));
  });

  it('a ficha sai com o dono e as concessões pelo e-mail, e sem o dono dos catálogos', async () => {
    const ficha = await detail(admin, 'time-a');

    semUuidDeConta(ficha);
    expect(ficha).toMatchObject({ ownerUserUuid: 'dona', ownerUsername: 'dona' });
    expect(ficha.grants).toEqual([{ ...CONCESSAO, userUuid: 'bia', grantedByUserUuid: 'ana' }]);
    expect(ficha.catalogs[0]).not.toHaveProperty('ownerUserUuid');
    expect(ficha.catalogs[0]).toMatchObject({ slug: 'dados', asSkill: true });
  });

  it('lista, criação e escritas também', async () => {
    semUuidDeConta(await listMine(admin));
    semUuidDeConta(await create(admin, { name: 'Novo' }));
    semUuidDeConta(await update(admin, 'time-a', { description: 'x' }));
    semUuidDeConta(await setSkills(admin, 'time-a', VINCULO));
  });

  it('sem dono continua nulo, e quem concedeu removido também', async () => {
    lerMcp.mockImplementation((_slug: string, options: { viewer: { role: AuthUser['role']; userUuid: string | null } }) =>
      Promise.resolve({
        ...mcpCheio(options.viewer),
        ownerUserUuid: null,
        ownerUsername: null,
        grants: [{ ...CONCESSAO, grantedByUserUuid: null, grantedByUsername: null }],
      }),
    );

    const ficha = await detail(admin, 'time-a');

    expect(ficha.ownerUserUuid).toBeNull();
    expect(ficha.grants[0]?.grantedByUserUuid).toBeNull();
  });

  it('conceder devolve a concessão pelo e-mail', async () => {
    banco.getUserByUsername.mockResolvedValue({ uuid: 'uuid-bia', username: 'bia', isActive: true });
    banco.setVirtualMcpGrant.mockResolvedValue(CONCESSAO);

    const concessao = await share(admin, 'time-a', 'bia', 'edit');

    semUuidDeConta(concessao);
    expect(concessao).toMatchObject({ username: 'bia', userUuid: 'bia', level: 'edit' });
  });

  it('chaves: quem emitiu só aparece quando é a própria sessão', async () => {
    banco.listVirtualMcpKeys.mockResolvedValue([
      { id: 'k1', name: 'minha', prefix: 'aaaaaaaa', createdByUserUuid: DONO },
      { id: 'k2', name: 'da ana', prefix: 'bbbbbbbb', createdByUserUuid: 'uuid-ana' },
      { id: 'k3', name: 'do bootstrap', prefix: 'cccccccc', createdByUserUuid: null },
    ]);

    const chaves = await listKeys(dono, 'time-a');

    expect(chaves.map((chave) => chave.createdByUserUuid)).toEqual([DONO, null, null]);
    expect(chaves.map((chave) => chave.name)).toEqual(['minha', 'da ana', 'do bootstrap']);
  });
});
