import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  listCatalogs: vi.fn(),
  getCatalog: vi.fn(),
  cloneCatalog: vi.fn(),
  createCatalog: vi.fn(),
  updateCatalog: vi.fn(),
  deleteCatalog: vi.fn(),
  setCatalogSkills: vi.fn(),
  setCatalogGrant: vi.fn(),
  removeCatalogGrant: vi.fn(),
  getVirtualMcp: vi.fn(),
  getSkillSummary: vi.fn(),
  getUserByUsername: vi.fn(),
  setVirtualMcpCatalogs: vi.fn(),
  notFound: (message: string) => new AppError(message, 404, 'not_found'),
  badRequest: (message: string) => new AppError(message, 400, 'bad_request'),
}));

vi.mock('@purple-skills/db', () => ({ ...db, AppError }));

const { createCatalogHandlers } = await import('./catalogs.js');
const { NAME_MAX } = await import('./mcps.js');
const { guard } = await import('./tools.js');

type Role = 'admin' | 'editor' | 'membro';
type Viewer = { role: Role; userUuid: string | null };

const caller = (role: Role, userUuid: string | null = `uuid-${role}`) => ({
  actor: { userUuid, label: userUuid ? `${role}` : 'token-global' },
  role,
  identity: `teste:${role}`,
});

/** O que o banco faria com `viewer` (`docs/12` §3.1); concessões por uuid da conta. */
const grants: Record<string, 'view' | 'edit' | 'manage'> = {};
function seen<T extends { ownerUserUuid: string | null; isOpen?: boolean; isPublic?: boolean }>(
  object: T,
  viewer: Viewer | undefined,
): (T & { access: string }) | null {
  if (!viewer || viewer.role === 'admin') return { ...object, access: 'owner' };
  if (viewer.userUuid !== null && object.ownerUserUuid === viewer.userUuid) return { ...object, access: 'owner' };
  const level = viewer.userUuid ? grants[viewer.userUuid] : undefined;
  if (level) return { ...object, access: level };
  if (object.isOpen || object.isPublic) return { ...object, access: 'view' };
  return null;
}

const catalog = {
  uuid: 'cat-1',
  slug: 'dados',
  name: 'Dados',
  description: '',
  isActive: true,
  isPublic: false,
  ownerUserUuid: 'uuid-editor',
  ownerUsername: 'editor',
  // Uma concessão de conta ativa e uma de conta desativada depois de recebê-la.
  grants: [
    { userUuid: 'uuid-maria', username: 'maria', name: 'Maria', role: 'membro', isActive: true, level: 'view' },
    { userUuid: 'uuid-saiu', username: 'saiu', name: 'Saiu', role: 'membro', isActive: false, level: 'edit' },
  ],
  skillCount: 2,
  activeSkillCount: 1,
  mcpCount: 1,
  viewCount: 0,
  downloadCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  skills: [
    { uuid: 's1', slug: 'a', name: 'A', description: '', icon: null, isActive: true, skillIsActive: true, addedAt: '2026-01-01T00:00:00.000Z' },
    { uuid: 's2', slug: 'b', name: 'B', description: '', icon: null, isActive: false, skillIsActive: false, addedAt: '2026-01-01T00:00:00.000Z' },
  ],
  mcps: [],
};

/** Um catálogo de outra conta, privado; e um público. */
const alheio = { ...catalog, uuid: 'cat-2', slug: 'alheio', name: 'Alheio', ownerUserUuid: 'uuid-outro', ownerUsername: 'outro' };
const publico = { ...catalog, uuid: 'cat-3', slug: 'publico', name: 'Público', ownerUserUuid: 'uuid-outro', ownerUsername: 'outro', isPublic: true };

/** Um vMCP do mesmo editor, com o catálogo alheio já vinculado. */
const mcp = {
  uuid: 'mcp-1',
  slug: 'time-a',
  name: 'Time A',
  ownerUserUuid: 'uuid-editor',
  grants: [],
  catalogs: [
    { uuid: 'cat-2', slug: 'alheio', name: 'Alheio', description: '', isActive: true, ownerUserUuid: 'uuid-outro', asSkill: true, asPrompt: false, asResource: false, skillCount: 1, activeSkillCount: 1, position: null },
  ],
};

const skills: Record<string, { ownerUserUuid: string | null; isPublic: boolean }> = {
  a: { ownerUserUuid: 'uuid-editor', isPublic: false },
  b: { ownerUserUuid: 'uuid-editor', isPublic: false },
  c: { ownerUserUuid: 'uuid-editor', isPublic: false },
  alheia: { ownerUserUuid: 'uuid-outro', isPublic: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(grants)) delete grants[key];
  db.getCatalog.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) => {
    const found = slug === 'dados' ? catalog : slug === 'alheio' ? alheio : slug === 'publico' ? publico : null;
    return found ? seen(found, options?.viewer) : null;
  });
  db.getVirtualMcp.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) =>
    slug === 'time-a' ? seen(mcp, options?.viewer) : null,
  );
  db.getSkillSummary.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) => {
    const skill = skills[slug];
    return skill ? seen({ slug, name: slug, ...skill }, options?.viewer) : null;
  });
  db.getUserByUsername.mockImplementation(async (username: string) =>
    username === 'maria' ? { uuid: 'uuid-maria', username, isActive: true } : null,
  );
});

describe('alcance por acesso', () => {
  it('toda credencial lista com o próprio viewer; scope recorta', async () => {
    db.listCatalogs.mockResolvedValue([]);

    await createCatalogHandlers(caller('admin', null)).list_catalogs();
    await createCatalogHandlers(caller('editor')).list_catalogs({ scope: 'public' });

    expect(db.listCatalogs).toHaveBeenNthCalledWith(1, { viewer: { role: 'admin', userUuid: null } });
    expect(db.listCatalogs).toHaveBeenNthCalledWith(2, {
      viewer: { role: 'editor', userUuid: 'uuid-editor' },
      scope: 'public',
    });
  });

  it('dono e admin leem; quem não vê recebe 404; público é leitura para todos', async () => {
    const dono = createCatalogHandlers(caller('editor'));
    const admin = createCatalogHandlers(caller('admin', null));
    const outro = createCatalogHandlers(caller('membro', 'uuid-terceiro'));

    expect((await dono.get_catalog({ slug: 'dados' })).isError).toBeUndefined();
    expect((await admin.get_catalog({ slug: 'dados' })).isError).toBeUndefined();

    const invisivel = await guard(() => outro.get_catalog({ slug: 'dados' }));
    expect(invisivel.isError).toBe(true);
    expect(invisivel.content[0].text).toMatch(/não encontrado/);

    const lido = JSON.parse((await outro.get_catalog({ slug: 'publico' })).content[0].text);
    expect(lido.access).toBe('view');
    expect(lido.grants).toBeUndefined();

    // view lê, mas não mexe nos membros.
    const negado = await guard(() => outro.set_catalog_skills({ slug: 'publico', skills: [] }));
    expect(negado.isError).toBe(true);
    expect(negado.content[0].text).toMatch(/exige "editar"/);
  });

  it('membro não cria catálogo; quem cria vira o dono; o token global cria órfão', async () => {
    db.createCatalog.mockResolvedValue(catalog);

    const negado = await createCatalogHandlers(caller('membro')).create_catalog({ name: 'X' });
    expect(negado.isError).toBe(true);
    expect(db.createCatalog).not.toHaveBeenCalled();

    await createCatalogHandlers(caller('editor')).create_catalog({ name: 'Dados', is_public: true });
    await createCatalogHandlers(caller('admin', null)).create_catalog({ name: 'Órfão' });

    expect(db.createCatalog).toHaveBeenNthCalledWith(1, expect.objectContaining({ ownerUserUuid: 'uuid-editor', isPublic: true }), 'mcp-admin', caller('editor').actor);
    expect(db.createCatalog).toHaveBeenNthCalledWith(2, expect.objectContaining({ ownerUserUuid: null, isPublic: false }), 'mcp-admin', caller('admin', null).actor);
  });
});

/**
 * A cópia é de quem clonou, nasce privada e leva as propriedades e os membros
 * com o estado de cada participação — nada de vMCP nem de concessão. Papel
 * `editor`/`admin` (é um catálogo novo) mais `edit` no original.
 */
describe('clone_catalog', () => {
  /** O que o banco devolve: o catálogo novo, com o slug desempatado. */
  const copia = { ...catalog, uuid: 'cat-9', slug: 'dados-2' };

  it('clona pelo uuid do original, com quem clonou como dono; o token global clona para órfão', async () => {
    db.cloneCatalog.mockResolvedValue(copia);

    const result = await createCatalogHandlers(caller('editor')).clone_catalog({ slug: 'dados' });
    await createCatalogHandlers(caller('admin', null)).clone_catalog({ slug: 'dados', name: 'Cópia', new_slug: 'copia' });

    expect(db.cloneCatalog).toHaveBeenNthCalledWith(
      1,
      'cat-1',
      { name: undefined, slug: undefined, ownerUserUuid: 'uuid-editor' },
      'mcp-admin',
      caller('editor').actor,
    );
    expect(db.cloneCatalog).toHaveBeenNthCalledWith(
      2,
      'cat-1',
      { name: 'Cópia', slug: 'copia', ownerUserUuid: null },
      'mcp-admin',
      caller('admin', null).actor,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"Dados" (slug: dados-2)');
    expect(result.content[0].text).toContain('2 membro(s)');
    expect(result.content[0].text).toContain('privada');
  });

  it('membro não clona: a cópia é um catálogo novo, e criar é do papel', async () => {
    const negado = await createCatalogHandlers(caller('membro')).clone_catalog({ slug: 'dados' });

    expect(negado.isError).toBe(true);
    expect(negado.content[0].text).toContain('Clonar um catálogo faz nascer um catálogo novo');
    expect(db.cloneCatalog).not.toHaveBeenCalled();
  });

  it('catálogo que a credencial não vê é 404; quem só o lê não o clona', async () => {
    // Nem dono de `dados` nem de `publico` (que é de `uuid-outro`).
    const outro = createCatalogHandlers(caller('editor', 'uuid-terceiro'));

    const invisivel = await guard(() => outro.clone_catalog({ slug: 'dados' }));
    expect(invisivel.isError).toBe(true);
    expect(invisivel.content[0].text).toMatch(/Catálogo não encontrado/);

    // `publico` é de outra conta: view chega pelo flag, e view não clona.
    const soLe = await guard(() => outro.clone_catalog({ slug: 'publico' }));
    expect(soLe.isError).toBe(true);
    expect(soLe.content[0].text).toMatch(/exige "editar"/);

    expect(db.cloneCatalog).not.toHaveBeenCalled();
  });

  // Sem `new_slug` o banco desempata sozinho (-2, -3…) e não há 409; com um
  // slug escolhido, quem recusa é o banco — e a mensagem chega inteira.
  it('repassa o 409 de slug em uso, com a mensagem do banco', async () => {
    db.cloneCatalog.mockRejectedValue(new AppError('Já existe um catálogo com o slug "ocupado"', 409, 'conflict'));

    const result = await guard(() =>
      createCatalogHandlers(caller('editor')).clone_catalog({ slug: 'dados', new_slug: 'ocupado' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Já existe um catálogo com o slug "ocupado"');
    expect(result.content[0].text).not.toContain('Erro interno');
  });
});

describe('set_catalog_skills', () => {
  it('entrega a lista ao banco como estado desejado e relata a participação', async () => {
    db.setCatalogSkills.mockResolvedValue(catalog);
    const skills = [{ slug: 'a' }, { slug: 'b', isActive: false }];

    const result = await createCatalogHandlers(caller('editor')).set_catalog_skills({ slug: 'dados', skills });

    expect(db.setCatalogSkills).toHaveBeenCalledWith('cat-1', skills, 'mcp-admin', caller('editor').actor);
    expect(result.content[0].text).toContain('a: participação ativa');
    expect(result.content[0].text).toContain('b: participação desativada · skill desligada');
  });

  it('quem entra precisa ser visível para a credencial', async () => {
    const editor = createCatalogHandlers(caller('editor'));

    const invisivel = await guard(() => editor.set_catalog_skills({ slug: 'dados', skills: [{ slug: 'a' }, { slug: 'alheia' }] }));
    expect(invisivel.isError).toBe(true);
    expect(invisivel.content[0].text).toMatch(/Skill não encontrada/);
    expect(db.setCatalogSkills).not.toHaveBeenCalled();

    db.setCatalogSkills.mockResolvedValue(catalog);
    const ok = await editor.set_catalog_skills({ slug: 'dados', skills: [{ slug: 'a' }, { slug: 'c' }] });
    expect(ok.isError).toBeUndefined();
  });
});

describe('set_virtual_mcp_catalogs', () => {
  it('recusa catálogo sem nenhuma superfície', async () => {
    const result = await createCatalogHandlers(caller('editor')).set_virtual_mcp_catalogs({
      slug: 'time-a',
      catalogs: [{ slug: 'dados', asSkill: false, asPrompt: false, asResource: false }],
    });

    expect(result.isError).toBe(true);
    expect(db.setVirtualMcpCatalogs).not.toHaveBeenCalled();
  });

  // Decisão 7 de `docs/12`: edit no vMCP e view em cada catálogo que entra.
  // Quem sai não exige nada do catálogo — tirar da lista é mexer no servidor.
  it('exige edit no MCP e view em cada catálogo que entra', async () => {
    const editor = createCatalogHandlers(caller('editor'));
    db.setVirtualMcpCatalogs.mockResolvedValue({ ...mcp, catalogs: [{ ...mcp.catalogs[0], slug: 'dados' }] });

    // Entra `dados` (seu) e sai `alheio` (de outro): passa — o que sai não é conferido.
    const saindo = await editor.set_virtual_mcp_catalogs({
      slug: 'time-a',
      catalogs: [{ slug: 'dados', asSkill: true, asPrompt: false, asResource: false }],
    });
    expect(saindo.isError).toBeUndefined();
    expect(db.setVirtualMcpCatalogs).toHaveBeenCalledWith(
      'mcp-1',
      [{ slug: 'dados', asSkill: true, asPrompt: false, asResource: false }],
      'mcp-admin',
      caller('editor').actor,
    );

    // Manter `alheio` (já vinculado) também passa: quem já está não é conferido.
    const mantendo = await editor.set_virtual_mcp_catalogs({
      slug: 'time-a',
      catalogs: [
        { slug: 'alheio', asSkill: true, asPrompt: false, asResource: false },
        { slug: 'dados', asSkill: true, asPrompt: false, asResource: false },
      ],
    });
    expect(mantendo.isError).toBeUndefined();

    // Um catálogo que a credencial não vê não entra; um público entra (view).
    db.getVirtualMcp.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) =>
      slug === 'time-a' ? seen({ ...mcp, catalogs: [] }, options?.viewer) : null,
    );
    const invisivel = await guard(() =>
      editor.set_virtual_mcp_catalogs({ slug: 'time-a', catalogs: [{ slug: 'alheio', asSkill: true, asPrompt: false, asResource: false }] }),
    );
    expect(invisivel.isError).toBe(true);
    expect(invisivel.content[0].text).toMatch(/Catálogo não encontrado/);

    const publicoOk = await editor.set_virtual_mcp_catalogs({
      slug: 'time-a',
      catalogs: [{ slug: 'publico', asSkill: true, asPrompt: false, asResource: false }],
    });
    expect(publicoOk.isError).toBeUndefined();
  });
});

describe('acesso: share / unshare / transfer', () => {
  it('manage concede e revoga; dono transfere', async () => {
    const dono = createCatalogHandlers(caller('editor'));
    db.setCatalogGrant.mockResolvedValue({ userUuid: 'uuid-maria', username: 'maria', level: 'view' });
    db.removeCatalogGrant.mockResolvedValue(undefined);
    db.updateCatalog.mockResolvedValue(catalog);

    await dono.share_catalog({ slug: 'dados', username: 'maria', level: 'view' });
    await dono.unshare_catalog({ slug: 'dados', username: 'maria' });
    await dono.transfer_catalog({ slug: 'dados', username: 'maria' });

    expect(db.setCatalogGrant).toHaveBeenCalledWith('dados', 'uuid-maria', 'view', 'mcp-admin', caller('editor').actor);
    expect(db.removeCatalogGrant).toHaveBeenCalledWith('dados', 'uuid-maria', 'mcp-admin', caller('editor').actor);
    expect(db.updateCatalog).toHaveBeenCalledWith('cat-1', { ownerUserUuid: 'uuid-maria' }, 'mcp-admin', caller('editor').actor);

    grants['uuid-terceiro'] = 'edit';
    const editor = createCatalogHandlers(caller('membro', 'uuid-terceiro'));
    const negado = await guard(() => editor.share_catalog({ slug: 'dados', username: 'maria', level: 'view' }));
    expect(negado.isError).toBe(true);
    expect(negado.content[0].text).toMatch(/exige "administrar"/);
  });

  /**
   * `manage` revoga **qualquer** concessão (`docs/12` decisão 10), inclusive a
   * de conta desativada depois de recebê-la (relatório 039 da auditoria de
   * 2026-09-19). Conceder e transferir continuam exigindo conta ativa.
   */
  it('revoga a concessão de conta desativada, que a ficha marca; conceder a ela continua recusado', async () => {
    const dono = createCatalogHandlers(caller('editor'));
    db.getUserByUsername.mockImplementation(async (username: string) =>
      username === 'saiu' ? { uuid: 'uuid-saiu', username, isActive: false } : null,
    );

    const ficha = JSON.parse((await dono.get_catalog({ slug: 'dados' })).content[0].text);
    expect(ficha.grants).toEqual([
      { username: 'maria', name: 'Maria', level: 'view', isActive: true },
      { username: 'saiu', name: 'Saiu', level: 'edit', isActive: false },
    ]);

    const tirado = await dono.unshare_catalog({ slug: 'dados', username: 'saiu' });
    expect(tirado.content[0].text).toMatch(/saiu perdeu o acesso/);
    expect(db.removeCatalogGrant).toHaveBeenCalledWith('dados', 'uuid-saiu', 'mcp-admin', caller('editor').actor);

    const concedido = await guard(() => dono.share_catalog({ slug: 'dados', username: 'saiu', level: 'view' }));
    expect(concedido.isError).toBe(true);
    expect(concedido.content[0].text).toMatch(/desativada/);
    expect(db.setCatalogGrant).not.toHaveBeenCalled();
  });

  // Revogar não consulta `users`: a resposta não diz se existe conta com aquele e-mail.
  it('e-mail sem concessão aqui é recusado sem consultar a conta', async () => {
    const nada = await guard(() => createCatalogHandlers(caller('editor')).unshare_catalog({ slug: 'dados', username: 'ninguem' }));

    expect(nada.isError).toBe(true);
    expect(nada.content[0].text).toBe('A conta não tem concessão neste catálogo');
    expect(db.getUserByUsername).not.toHaveBeenCalled();
    expect(db.removeCatalogGrant).not.toHaveBeenCalled();
  });
});

/**
 * A ficha do catálogo revelava todo vMCP vinculado, inclusive o fechado de
 * terceiros; o banco passou a recortar a **leitura** com `viewer`. As escritas
 * releem sem `viewer`, na visão do admin — então nenhuma tool de escrita pode
 * repassar `mcps` do detalhe que a escrita devolve (relatório 010 da auditoria de
 * 2026-09-19).
 */
describe('as tools de escrita não repassam os vMCPs do detalhe da escrita', () => {
  const FECHADO = { uuid: 'mcp-9', slug: 'fechado-de-outro', name: 'Fechado de outro', isOpen: false, isActive: true, isDefault: false, ownerUserUuid: 'uuid-outro', asSkill: true, asPrompt: false, asResource: false };
  const naVisaoDoAdmin = { ...catalog, mcps: [FECHADO] };

  it('get_catalog lê com o viewer da credencial, que é quem recorta', async () => {
    await createCatalogHandlers(caller('membro', 'uuid-terceiro')).get_catalog({ slug: 'publico' });

    expect(db.getCatalog).toHaveBeenCalledWith('publico', { viewer: { role: 'membro', userUuid: 'uuid-terceiro' } });
  });

  it('update_catalog e set_catalog_skills respondem sem citar servidor nenhum', async () => {
    grants['uuid-terceiro'] = 'manage';
    const gerente = createCatalogHandlers(caller('membro', 'uuid-terceiro'));
    db.updateCatalog.mockResolvedValue(naVisaoDoAdmin);
    db.setCatalogSkills.mockResolvedValue(naVisaoDoAdmin);

    const alterado = await gerente.update_catalog({ slug: 'dados', description: 'nova' });
    const membros = await gerente.set_catalog_skills({ slug: 'dados', skills: [{ slug: 'a' }] });

    for (const result of [alterado, membros]) {
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).not.toContain('fechado-de-outro');
      expect(result.content[0].text).not.toContain('Fechado de outro');
    }
  });
});

/**
 * Nome de catálogo não tinha teto, e é copiado em cada linha de
 * `skill_accesses` (relatório 042 da auditoria de 2026-09-19).
 */
describe('teto de nome', () => {
  const LONGO = 'n'.repeat(NAME_MAX + 1);

  it('criar acima do teto é recusado com o limite, antes do banco', async () => {
    const recusado = await guard(() => createCatalogHandlers(caller('editor')).create_catalog({ name: LONGO }));

    expect(recusado.isError).toBe(true);
    expect(recusado.content[0].text).toContain(`o limite é ${NAME_MAX}`);
    expect(db.createCatalog).not.toHaveBeenCalled();
  });

  it('renomear acima do teto é recusado; reenviar o nome que o catálogo já tem, não', async () => {
    const dono = createCatalogHandlers(caller('editor'));

    const recusado = await guard(() => dono.update_catalog({ slug: 'dados', name: LONGO }));
    expect(recusado.isError).toBe(true);
    expect(db.updateCatalog).not.toHaveBeenCalled();

    db.getCatalog.mockImplementation(async (_slug: string, options?: { viewer?: Viewer }) => seen({ ...catalog, name: LONGO }, options?.viewer));
    db.updateCatalog.mockResolvedValue(catalog);
    expect((await dono.update_catalog({ slug: 'dados', name: LONGO, is_active: false })).isError).toBeUndefined();
  });
});

describe('delete_catalog', () => {
  it('exige confirm, e é só do dono', async () => {
    const result = await createCatalogHandlers(caller('editor')).delete_catalog({ slug: 'dados', confirm: false });
    expect(result.isError).toBe(true);

    grants['uuid-terceiro'] = 'manage';
    const gerente = createCatalogHandlers(caller('membro', 'uuid-terceiro'));
    const negado = await guard(() => gerente.delete_catalog({ slug: 'dados', confirm: true }));
    expect(negado.isError).toBe(true);
    expect(db.deleteCatalog).not.toHaveBeenCalled();
  });
});
