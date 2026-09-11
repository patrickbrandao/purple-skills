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
  createVirtualMcp: vi.fn(),
  updateVirtualMcp: vi.fn(),
  deleteVirtualMcp: vi.fn(),
  setVirtualMcpSkills: vi.fn(),
  getSkillSummary: vi.fn(),
  listVirtualMcpKeys: vi.fn(),
  createVirtualMcpKey: vi.fn(),
  revokeVirtualMcpKey: vi.fn(),
  recordAccountAudit: vi.fn(),
  listPublicMcpKeys: vi.fn(),
  createPublicMcpKey: vi.fn(),
  revokePublicMcpKey: vi.fn(),
  notFound: (message: string) => new AppError(message, 404, 'not_found'),
  badRequest: (message: string) => new AppError(message, 400, 'bad_request'),
}));

vi.mock('@purple-skills/db', () => ({ ...db, AppError }));

const { createMcpHandlers } = await import('./mcps.js');
const { guard } = await import('./tools.js');

const caller = (role: 'admin' | 'editor' | 'leitor', userUuid: string | null = `uuid-${role}`) => ({
  actor: { userUuid, label: userUuid ? `${role}@exemplo.com` : 'token-global' },
  role,
  identity: `teste:${role}`,
});

const mcp = {
  uuid: 'mcp-1',
  slug: 'time-a',
  name: 'Time A',
  description: '',
  isActive: true,
  isOpen: false,
  ownerUserUuid: 'uuid-editor',
  ownerEmail: 'editor@exemplo.com',
  skillCount: 1,
  privateSkillCount: 1,
  activeKeyCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  skills: [
    {
      uuid: 'skill-1',
      slug: 'privada',
      name: 'Privada',
      description: '',
      isPublic: false,
      asSkill: true,
      asPrompt: false,
      asResource: false,
      viewCount: 0,
      downloadCount: 0,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  db.getVirtualMcp.mockResolvedValue(mcp);
  db.recordAccountAudit.mockResolvedValue(undefined);
});

describe('alcance por dono', () => {
  it('o token global lista todos; a chave de um usuário lista os dele', async () => {
    db.listVirtualMcps.mockResolvedValue([]);

    await createMcpHandlers(caller('admin', null)).list_virtual_mcps();
    await createMcpHandlers(caller('editor')).list_virtual_mcps();

    expect(db.listVirtualMcps).toHaveBeenNthCalledWith(1, undefined);
    expect(db.listVirtualMcps).toHaveBeenNthCalledWith(2, { ownerUserUuid: 'uuid-editor' });
  });

  it('o dono e o admin administram; outro editor é recusado', async () => {
    const dono = createMcpHandlers(caller('editor'));
    const admin = createMcpHandlers(caller('admin', null));
    const outro = createMcpHandlers(caller('editor', 'uuid-outro'));

    expect((await dono.get_virtual_mcp({ slug: 'time-a' })).isError).toBeUndefined();
    expect((await admin.get_virtual_mcp({ slug: 'time-a' })).isError).toBeUndefined();

    const result = await guard(() => outro.get_virtual_mcp({ slug: 'time-a' }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/pertence a outra conta/);
  });

  it('leitor não cria MCP virtual', async () => {
    const result = await createMcpHandlers(caller('leitor')).create_virtual_mcp({ name: 'X' });

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
});

describe('abrir com skill privada', () => {
  const handlers = createMcpHandlers(caller('editor'));

  it('exige confirm_open ao ligar is_open num MCP com privada dentro', async () => {
    const result = await handlers.update_virtual_mcp({ slug: 'time-a', is_open: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/confirm_open/);
    expect(db.updateVirtualMcp).not.toHaveBeenCalled();
  });

  it('com confirm_open, abre', async () => {
    db.updateVirtualMcp.mockResolvedValue({ ...mcp, isOpen: true });

    const result = await handlers.update_virtual_mcp({ slug: 'time-a', is_open: true, confirm_open: true });

    expect(result.isError).toBeUndefined();
    expect(db.updateVirtualMcp).toHaveBeenCalledWith(
      'mcp-1',
      expect.objectContaining({ isOpen: true }),
      'mcp-admin',
      caller('editor').actor,
    );
  });

  it('num MCP aberto, vincular skill privada exige confirm_open', async () => {
    db.getVirtualMcp.mockResolvedValue({ ...mcp, isOpen: true });
    db.getSkillSummary.mockResolvedValue({ slug: 'privada', isPublic: false });

    const result = await handlers.set_virtual_mcp_skills({
      slug: 'time-a',
      skills: [{ slug: 'privada', asSkill: true, asPrompt: false, asResource: false }],
    });

    expect(result.isError).toBe(true);
    expect(db.setVirtualMcpSkills).not.toHaveBeenCalled();
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
    expect(result.content[0].text).toContain('privada (privada): skill');
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

describe('delete_virtual_mcp', () => {
  it('exige confirm', async () => {
    const handlers = createMcpHandlers(caller('editor'));

    const result = await handlers.delete_virtual_mcp({ slug: 'time-a', confirm: false });

    expect(result.isError).toBe(true);
    expect(db.deleteVirtualMcp).not.toHaveBeenCalled();
  });
});

describe('chaves do MCP principal', () => {
  it('só admin lista, emite e revoga', async () => {
    const editor = createMcpHandlers(caller('editor'));

    expect((await editor.list_public_mcp_keys()).isError).toBe(true);
    expect((await editor.create_public_mcp_key({ name: 'x' })).isError).toBe(true);
    expect((await editor.revoke_public_mcp_key({ key_id: 'k' })).isError).toBe(true);
    expect(db.createPublicMcpKey).not.toHaveBeenCalled();
    expect(db.revokePublicMcpKey).not.toHaveBeenCalled();
  });

  it('admin emite uma psp_ e audita com o nome', async () => {
    db.createPublicMcpKey.mockImplementation(async (input: { name: string; prefix: string }) => ({
      id: 'chave-p',
      name: input.name,
      prefix: input.prefix,
      createdByUserUuid: null,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const admin = createMcpHandlers(caller('admin', null));

    const payload = JSON.parse((await admin.create_public_mcp_key({ name: 'agentes' })).content[0].text);

    expect(payload.token).toMatch(/^psp_[A-Za-z0-9_-]{8}_/);
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'public.key.create', targetLabel: 'agentes' }),
    );
  });

  it('admin revoga e sinaliza quando não achou', async () => {
    db.revokePublicMcpKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const admin = createMcpHandlers(caller('admin', null));

    expect((await admin.revoke_public_mcp_key({ key_id: 'a' })).isError).toBeUndefined();
    expect((await admin.revoke_public_mcp_key({ key_id: 'b' })).isError).toBe(true);
    expect(db.recordAccountAudit).toHaveBeenCalledTimes(1);
  });
});
