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
  listVirtualMcps: vi.fn(),
  getVirtualMcp: vi.fn(),
  getSkillSummary: vi.fn(),
  getUserByEmail: vi.fn(),
  createVirtualMcp: vi.fn(),
  updateVirtualMcp: vi.fn(),
  deleteVirtualMcp: vi.fn(),
  setVirtualMcpSkills: vi.fn(),
  setVirtualMcpGrant: vi.fn(),
  removeVirtualMcpGrant: vi.fn(),
  linkSkill: vi.fn(),
  unlinkSkill: vi.fn(),
  listVirtualMcpKeys: vi.fn(),
  createVirtualMcpKey: vi.fn(),
  revokeVirtualMcpKey: vi.fn(),
  recordAccountAudit: vi.fn(),
  resolveDefaultVirtualMcp: vi.fn(),
  setDefaultVirtualMcp: vi.fn(),
  notFound: (message: string) => new AppError(message, 404, 'not_found'),
  badRequest: (message: string) => new AppError(message, 400, 'bad_request'),
}));

vi.mock('@purple-skills/db', () => ({ ...db, AppError }));

const { createMcpHandlers } = await import('./mcps.js');
const { guard } = await import('./tools.js');

type Role = 'admin' | 'editor' | 'membro';
type Viewer = { role: Role; userUuid: string | null };

const caller = (role: Role, userUuid: string | null = `uuid-${role}`) => ({
  actor: { userUuid, label: userUuid ? `${role}@exemplo.com` : 'token-global' },
  role,
  identity: `teste:${role}`,
});

/**
 * O que o banco faria com `viewer` (`docs/12-acesso-granular.md` §3.1): admin
 * e dono veem como `'owner'`; quem tem concessão, no nível dela; aberto é
 * leitura para qualquer um; o resto não vê — a consulta devolve nulo.
 */
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

const mcp = {
  uuid: 'mcp-1',
  slug: 'time-a',
  name: 'Time A',
  description: '',
  isActive: true,
  isOpen: false,
  ownerUserUuid: 'uuid-editor',
  ownerEmail: 'editor@exemplo.com',
  grants: [],
  skillCount: 1,
  activeKeyCount: 0,
  toolCount: 1,
  promptCount: 0,
  resourceCount: 0,
  onlineSessions: 0,
  preview: [{ slug: 'privada', name: 'Privada', icon: null }],
  catalogCount: 0,
  catalogs: [],
  layout: {},
  isDefault: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  skills: [
    {
      uuid: 'skill-1',
      slug: 'privada',
      name: 'Privada',
      description: '',
      asSkill: true,
      asPrompt: false,
      asResource: false,
      viewCount: 0,
      downloadCount: 0,
      icon: null,
      position: null,
    },
  ],
};

/** Uma skill do mesmo editor (visível para ele) e uma de outra conta, privada. */
const skills: Record<string, { ownerUserUuid: string | null; isPublic: boolean }> = {
  privada: { ownerUserUuid: 'uuid-editor', isPublic: false },
  nova: { ownerUserUuid: 'uuid-editor', isPublic: false },
  alheia: { ownerUserUuid: 'uuid-outro', isPublic: false },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(grants)) delete grants[key];
  db.getVirtualMcp.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) =>
    slug === 'time-a' ? seen(mcp, options?.viewer) : null,
  );
  db.getSkillSummary.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) => {
    const skill = skills[slug];
    return skill ? seen({ slug, name: slug, ...skill }, options?.viewer) : null;
  });
  db.getUserByEmail.mockImplementation(async (email: string) =>
    email === 'maria@exemplo.com' ? { uuid: 'uuid-maria', email, isActive: true } : null,
  );
  db.recordAccountAudit.mockResolvedValue(undefined);
});

describe('alcance por acesso', () => {
  it('toda credencial lista com o próprio viewer; scope recorta', async () => {
    db.listVirtualMcps.mockResolvedValue([]);

    await createMcpHandlers(caller('admin', null)).list_virtual_mcps();
    await createMcpHandlers(caller('editor')).list_virtual_mcps({ scope: 'shared' });

    expect(db.listVirtualMcps).toHaveBeenNthCalledWith(1, { viewer: { role: 'admin', userUuid: null } });
    expect(db.listVirtualMcps).toHaveBeenNthCalledWith(2, {
      viewer: { role: 'editor', userUuid: 'uuid-editor' },
      scope: 'shared',
    });
  });

  it('dono, admin e quem tem view leem; quem não vê recebe 404', async () => {
    const dono = createMcpHandlers(caller('editor'));
    const admin = createMcpHandlers(caller('admin', null));
    const outro = createMcpHandlers(caller('editor', 'uuid-outro'));

    expect((await dono.get_virtual_mcp({ slug: 'time-a' })).isError).toBeUndefined();
    expect((await admin.get_virtual_mcp({ slug: 'time-a' })).isError).toBeUndefined();

    const invisivel = await guard(() => outro.get_virtual_mcp({ slug: 'time-a' }));
    expect(invisivel.isError).toBe(true);
    expect(invisivel.content[0].text).toMatch(/não encontrado/);

    grants['uuid-outro'] = 'view';
    const payload = JSON.parse((await outro.get_virtual_mcp({ slug: 'time-a' })).content[0].text);
    expect(payload.access).toBe('view');
    // A lista de concessões é só de quem administra.
    expect(payload.grants).toBeUndefined();
  });

  it('membro não cria MCP virtual', async () => {
    const result = await createMcpHandlers(caller('membro')).create_virtual_mcp({ name: 'X' });

    expect(result.isError).toBe(true);
    expect(db.createVirtualMcp).not.toHaveBeenCalled();
  });

  it('quem cria vira o dono; o token global cria órfão', async () => {
    db.createVirtualMcp.mockResolvedValue(mcp);

    await createMcpHandlers(caller('editor')).create_virtual_mcp({ name: 'Time A' });
    await createMcpHandlers(caller('admin', null)).create_virtual_mcp({ name: 'Time B' });

    expect(db.createVirtualMcp).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ ownerUserUuid: 'uuid-editor', isOpen: false }),
      'mcp-admin',
      caller('editor').actor,
    );
    expect(db.createVirtualMcp).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ ownerUserUuid: null }),
      'mcp-admin',
      caller('admin', null).actor,
    );
  });

  // `docs/12` §3.2: edit mexe nos vínculos; manage muda propriedades e chaves.
  it('edit vincula mas não altera propriedades nem emite chave; manage sim', async () => {
    grants['uuid-outro'] = 'edit';
    const editor = createMcpHandlers(caller('membro', 'uuid-outro'));
    db.setVirtualMcpSkills.mockResolvedValue(mcp);

    const vinculo = await editor.set_virtual_mcp_skills({
      slug: 'time-a',
      skills: [{ slug: 'privada', asSkill: true, asPrompt: false, asResource: false }],
    });
    expect(vinculo.isError).toBeUndefined();

    const props = await guard(() => editor.update_virtual_mcp({ slug: 'time-a', name: 'Outro' }));
    expect(props.isError).toBe(true);
    expect(props.content[0].text).toMatch(/exige "administrar"/);

    const chave = await guard(() => editor.create_virtual_mcp_key({ slug: 'time-a', name: 'ci' }));
    expect(chave.isError).toBe(true);
    expect(db.createVirtualMcpKey).not.toHaveBeenCalled();

    grants['uuid-outro'] = 'manage';
    db.updateVirtualMcp.mockResolvedValue(mcp);
    expect((await editor.update_virtual_mcp({ slug: 'time-a', name: 'Outro' })).isError).toBeUndefined();

    // Apagar é só do dono, mesmo com manage.
    const apagar = await guard(() => editor.delete_virtual_mcp({ slug: 'time-a', confirm: true }));
    expect(apagar.isError).toBe(true);
    expect(apagar.content[0].text).toMatch(/exige "dono"/);
    expect(db.deleteVirtualMcp).not.toHaveBeenCalled();
  });
});

describe('abrir e fechar', () => {
  const handlers = createMcpHandlers(caller('editor'));

  // Sem "skill privada" não há o que confirmar: aberto é uma caixa como
  // outra qualquer, e o site passa a listar o vMCP.
  it('abre sem pedir confirmação', async () => {
    db.updateVirtualMcp.mockResolvedValue({ ...mcp, isOpen: true });

    const result = await handlers.update_virtual_mcp({ slug: 'time-a', is_open: true });

    expect(result.isError).toBeUndefined();
    expect(db.updateVirtualMcp).toHaveBeenCalledWith(
      'mcp-1',
      expect.objectContaining({ isOpen: true }),
      'mcp-admin',
      caller('editor').actor,
    );
  });
});

describe('link_skill / unlink_skill', () => {
  const handlers = createMcpHandlers(caller('editor'));
  const vinculada = {
    uuid: 'skill-1',
    slug: 'privada',
    name: 'Privada',
    description: '',
    isActive: true,
    mcps: [{ uuid: 'mcp-1', slug: 'time-a', name: 'Time A', isOpen: false, isActive: true, isDefault: false, asSkill: true, asPrompt: false, asResource: false, direct: true, catalogs: [] }],
    catalogs: [],
    viewCount: 0,
    downloadCount: 0,
    icon: null,
    score: 0,
    tags: [],
    fileCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    skillMd: '# p',
    files: [],
  };

  it('publica pelo lado da skill: edit no vMCP e view na skill', async () => {
    db.linkSkill.mockResolvedValue(vinculada);

    const result = await handlers.link_skill({
      skill: 'privada',
      mcp: 'time-a',
      asSkill: true,
      asPrompt: false,
      asResource: false,
    });

    expect(db.linkSkill).toHaveBeenCalledWith(
      'privada',
      'mcp-1',
      { asSkill: true, asPrompt: false, asResource: false },
      'mcp-admin',
      caller('editor').actor,
    );
    expect(result.content[0].text).toMatch(/publicada em "time-a" como skill/);
  });

  it('recusa vínculo sem superfície, vMCP que não vê e skill que não vê', async () => {
    const semPorta = await handlers.link_skill({
      skill: 'privada',
      mcp: 'time-a',
      asSkill: false,
      asPrompt: false,
      asResource: false,
    });
    expect(semPorta.isError).toBe(true);

    const outro = createMcpHandlers(caller('editor', 'uuid-outro'));
    const alheio = await guard(() =>
      outro.link_skill({ skill: 'privada', mcp: 'time-a', asSkill: true, asPrompt: false, asResource: false }),
    );
    expect(alheio.isError).toBe(true);
    expect(alheio.content[0].text).toMatch(/MCP virtual não encontrado/);

    // O dono do vMCP não vê a skill de outra conta: não a vincula (decisão 6).
    const invisivel = await guard(() =>
      handlers.link_skill({ skill: 'alheia', mcp: 'time-a', asSkill: true, asPrompt: false, asResource: false }),
    );
    expect(invisivel.isError).toBe(true);
    expect(invisivel.content[0].text).toMatch(/Skill não encontrada/);
    expect(db.linkSkill).not.toHaveBeenCalled();
  });

  it('desvincula e diz se a skill ficou sem vínculo', async () => {
    db.unlinkSkill.mockResolvedValue({ ...vinculada, mcps: [] });

    const result = await handlers.unlink_skill({ skill: 'privada', mcp: 'time-a' });

    expect(db.unlinkSkill).toHaveBeenCalledWith('privada', 'mcp-1', 'mcp-admin', caller('editor').actor);
    expect(result.content[0].text).toMatch(/sem vínculo/);
  });
});

describe('set_virtual_mcp_skills', () => {
  const handlers = createMcpHandlers(caller('editor'));

  it('recusa vínculo sem nenhuma superfície', async () => {
    const result = await handlers.set_virtual_mcp_skills({
      slug: 'time-a',
      skills: [{ slug: 'privada', asSkill: false, asPrompt: false, asResource: false }],
    });

    expect(result.isError).toBe(true);
    expect(db.setVirtualMcpSkills).not.toHaveBeenCalled();
  });

  it('entrega a lista inteira ao banco, como estado desejado', async () => {
    db.setVirtualMcpSkills.mockResolvedValue(mcp);
    const skills = [{ slug: 'privada', asSkill: true, asPrompt: true, asResource: false }];

    const result = await handlers.set_virtual_mcp_skills({ slug: 'time-a', skills });

    expect(db.setVirtualMcpSkills).toHaveBeenCalledWith('mcp-1', skills, 'mcp-admin', caller('editor').actor);
    expect(result.content[0].text).toContain('privada: skill');
  });

  it('quem entra precisa ser visível; quem já está fica', async () => {
    db.setVirtualMcpSkills.mockResolvedValue(mcp);

    const invisivel = await guard(() =>
      handlers.set_virtual_mcp_skills({
        slug: 'time-a',
        skills: [
          { slug: 'privada', asSkill: true, asPrompt: false, asResource: false },
          { slug: 'alheia', asSkill: true, asPrompt: false, asResource: false },
        ],
      }),
    );
    expect(invisivel.isError).toBe(true);
    expect(db.setVirtualMcpSkills).not.toHaveBeenCalled();

    // `privada` já está no vMCP: não é conferida de novo, mesmo que a
    // credencial tenha perdido o acesso a ela.
    skills.privada.ownerUserUuid = 'uuid-outro';
    const ok = await handlers.set_virtual_mcp_skills({
      slug: 'time-a',
      skills: [{ slug: 'privada', asSkill: true, asPrompt: false, asResource: false }],
    });
    skills.privada.ownerUserUuid = 'uuid-editor';
    expect(ok.isError).toBeUndefined();
  });
});

describe('chaves', () => {
  const handlers = createMcpHandlers(caller('editor'));

  it('emite uma psv_, devolve o token uma vez e audita com o nome', async () => {
    db.createVirtualMcpKey.mockImplementation(async (input: { name: string; prefix: string }) => ({
      id: 'chave-1',
      virtualMcpUuid: 'mcp-1',
      name: input.name,
      prefix: input.prefix,
      createdByUserUuid: 'uuid-editor',
      lastUsedAt: null,
      revokedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));

    const payload = JSON.parse(
      (await handlers.create_virtual_mcp_key({ slug: 'time-a', name: 'ci' })).content[0].text,
    );

    expect(payload.token).toMatch(/^psv_[A-Za-z0-9_-]{8}_/);
    expect(db.createVirtualMcpKey).toHaveBeenCalledWith(
      expect.objectContaining({ virtualMcpUuid: 'mcp-1', name: 'ci', createdByUserUuid: 'uuid-editor' }),
    );
    // O hash vai para o banco; o token não.
    expect(db.createVirtualMcpKey.mock.calls[0][0].keyHash).not.toContain(payload.token);
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mcp.key.create', targetLabel: 'time-a: ci' }),
    );
  });

  it('revoga restrito ao MCP e sinaliza quando não achou', async () => {
    db.revokeVirtualMcpKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const ok = await handlers.revoke_virtual_mcp_key({ slug: 'time-a', key_id: 'chave-1' });
    const nao = await handlers.revoke_virtual_mcp_key({ slug: 'time-a', key_id: 'chave-2' });

    expect(db.revokeVirtualMcpKey).toHaveBeenCalledWith('chave-1', 'mcp-1');
    expect(ok.isError).toBeUndefined();
    expect(nao.isError).toBe(true);
    expect(db.recordAccountAudit).toHaveBeenCalledTimes(1);
  });
});

describe('acesso: share / unshare / transfer', () => {
  const dono = createMcpHandlers(caller('editor'));

  it('manage concede e revoga pelo e-mail; conta desconhecida é 404', async () => {
    db.setVirtualMcpGrant.mockResolvedValue({ userUuid: 'uuid-maria', email: 'maria@exemplo.com', level: 'edit' });
    db.removeVirtualMcpGrant.mockResolvedValue(undefined);

    const dado = await dono.share_mcp({ slug: 'time-a', email: 'maria@exemplo.com', level: 'edit' });
    expect(dado.content[0].text).toMatch(/maria@exemplo.com agora pode editar/);
    expect(db.setVirtualMcpGrant).toHaveBeenCalledWith('time-a', 'uuid-maria', 'edit', 'mcp-admin', caller('editor').actor);

    const tirado = await dono.unshare_mcp({ slug: 'time-a', email: 'maria@exemplo.com' });
    expect(tirado.content[0].text).toMatch(/perdeu o acesso/);
    expect(db.removeVirtualMcpGrant).toHaveBeenCalledWith('time-a', 'uuid-maria', 'mcp-admin', caller('editor').actor);

    const ninguem = await guard(() => dono.share_mcp({ slug: 'time-a', email: 'x@exemplo.com', level: 'view' }));
    expect(ninguem.isError).toBe(true);
    expect(ninguem.content[0].text).toMatch(/Conta não encontrada/);

    const nivel = await guard(() => dono.share_mcp({ slug: 'time-a', email: 'maria@exemplo.com', level: 'owner' }));
    expect(nivel.isError).toBe(true);
  });

  it('só dono ou admin transferem; manage não', async () => {
    db.updateVirtualMcp.mockResolvedValue(mcp);

    await dono.transfer_mcp({ slug: 'time-a', email: 'maria@exemplo.com' });
    expect(db.updateVirtualMcp).toHaveBeenCalledWith('mcp-1', { ownerUserUuid: 'uuid-maria' }, 'mcp-admin', caller('editor').actor);

    grants['uuid-outro'] = 'manage';
    const gerente = createMcpHandlers(caller('membro', 'uuid-outro'));
    const negado = await guard(() => gerente.transfer_mcp({ slug: 'time-a', email: 'maria@exemplo.com' }));
    expect(negado.isError).toBe(true);
    expect(negado.content[0].text).toMatch(/exige "dono"/);
  });
});

describe('delete_virtual_mcp', () => {
  it('exige confirm', async () => {
    const handlers = createMcpHandlers(caller('editor'));

    const result = await handlers.delete_virtual_mcp({ slug: 'time-a', confirm: false });

    expect(result.isError).toBe(true);
    expect(db.deleteVirtualMcp).not.toHaveBeenCalled();
  });
});

describe('MCP padrão', () => {
  it('qualquer credencial lê qual responde em /mcp, e por que nenhum', async () => {
    const membro = createMcpHandlers(caller('membro'));
    db.resolveDefaultVirtualMcp.mockResolvedValueOnce({
      status: 'ok',
      mcp: { uuid: 'mcp-1', slug: 'time-a', name: 'Time A', description: '', isOpen: false },
    });
    db.resolveDefaultVirtualMcp.mockResolvedValueOnce({ status: 'none', mcp: null, uuid: null, slug: null });

    const ok = JSON.parse((await membro.get_default_virtual_mcp()).content[0].text);
    const nenhum = JSON.parse((await membro.get_default_virtual_mcp()).content[0].text);

    expect(ok).toMatchObject({ status: 'ok', slug: 'time-a', auth: 'key', path: '/mcp' });
    expect(nenhum).toMatchObject({ status: 'none' });
    expect(nenhum.hint).toMatch(/set_default_virtual_mcp/);
  });

  it('só admin escolhe', async () => {
    const editor = createMcpHandlers(caller('editor'));

    const result = await editor.set_default_virtual_mcp({ slug: 'time-a' });

    expect(result.isError).toBe(true);
    expect(db.setDefaultVirtualMcp).not.toHaveBeenCalled();
  });

  it('admin escolhe pelo slug, limpa com null e é recusado num slug inexistente', async () => {
    const admin = createMcpHandlers(caller('admin', null));
    db.setDefaultVirtualMcp.mockResolvedValueOnce({
      status: 'ok',
      mcp: { uuid: 'mcp-1', slug: 'time-a', name: 'Time A', description: '', isOpen: true },
    });
    db.setDefaultVirtualMcp.mockResolvedValueOnce({ status: 'none', mcp: null, uuid: null, slug: null });

    const escolhido = await admin.set_default_virtual_mcp({ slug: 'time-a' });
    const limpo = await admin.set_default_virtual_mcp({ slug: null });

    expect(db.setDefaultVirtualMcp).toHaveBeenNthCalledWith(1, 'mcp-1', 'mcp-admin', caller('admin', null).actor);
    expect(db.setDefaultVirtualMcp).toHaveBeenNthCalledWith(2, null, 'mcp-admin', caller('admin', null).actor);
    expect(escolhido.content[0].text).toMatch(/time-a.*aberto/);
    expect(limpo.content[0].text).toMatch(/404/);

    const inexistente = await guard(() => admin.set_default_virtual_mcp({ slug: 'nao-existe' }));
    expect(inexistente.isError).toBe(true);
    expect(db.setDefaultVirtualMcp).toHaveBeenCalledTimes(2);
  });
});
