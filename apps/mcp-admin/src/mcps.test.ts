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

const { NAME_MAX, createMcpHandlers } = await import('./mcps.js');
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
  // Uma concessão de conta ativa e uma de conta desativada depois de recebê-la.
  grants: [
    { userUuid: 'uuid-maria', email: 'maria@exemplo.com', name: 'Maria', role: 'membro', isActive: true, level: 'edit' },
    { userUuid: 'uuid-saiu', email: 'saiu@exemplo.com', name: 'Saiu', role: 'membro', isActive: false, level: 'view' },
  ],
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

/**
 * Em quais vMCPs cada skill está, como `getSkillSummary` devolve: todos para o
 * admin; para os demais, só os que a conta vê (`docs/12` §3.1).
 */
const ondeEsta: Record<string, { todos: string[]; visiveis: string[] }> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(grants)) delete grants[key];
  for (const key of Object.keys(ondeEsta)) delete ondeEsta[key];
  db.getVirtualMcp.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) =>
    slug === 'time-a' ? seen(mcp, options?.viewer) : null,
  );
  db.getSkillSummary.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) => {
    const skill = skills[slug];
    if (!skill) return null;
    const onde = ondeEsta[slug] ?? { todos: [], visiveis: [] };
    const todos = !options?.viewer || options.viewer.role === 'admin';
    const mcps = (todos ? onde.todos : onde.visiveis).map((mcpSlug) => ({ slug: mcpSlug }));
    return seen({ slug, name: slug, mcps, ...skill }, options?.viewer);
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

  it('desvincula; só o admin, que vê tudo, ouve que a skill ficou sem vínculo', async () => {
    db.unlinkSkill.mockResolvedValue({ ...vinculada, mcps: [] });

    const result = await handlers.unlink_skill({ skill: 'privada', mcp: 'time-a' });
    const doAdmin = await createMcpHandlers(caller('admin', null)).unlink_skill({ skill: 'privada', mcp: 'time-a' });

    expect(db.unlinkSkill).toHaveBeenCalledWith('privada', 'mcp-1', 'mcp-admin', caller('editor').actor);
    // Quem não é admin não sabe dos servidores fechados alheios: a frase não afirma o que ele não vê.
    expect(result.content[0].text).toMatch(/nenhum outro MCP virtual que esta credencial veja/);
    expect(doAdmin.content[0].text).toMatch(/sem vínculo/);
  });

  /**
   * A escrita do banco relê a skill na visão do admin. O texto das duas tools
   * saía dela: `unlink_skill` nomeava **todo** servidor em que a skill
   * continuava, inclusive o fechado de terceiros, e `link_skill` dava a contagem
   * global (relatório 009 da auditoria de 2026-09-19).
   */
  it('o texto conta só o que a credencial vê, não o que a escrita devolve', async () => {
    const naVisaoDoAdmin = [vinculada.mcps[0], { ...vinculada.mcps[0], uuid: 'mcp-9', slug: 'fechado-de-outro' }];
    db.linkSkill.mockResolvedValue({ ...vinculada, mcps: naVisaoDoAdmin });
    db.unlinkSkill.mockResolvedValue({ ...vinculada, mcps: [naVisaoDoAdmin[1]] });
    ondeEsta.privada = { todos: ['time-a', 'fechado-de-outro'], visiveis: ['time-a'] };

    const publicada = await handlers.link_skill({ skill: 'privada', mcp: 'time-a', asSkill: true, asPrompt: false, asResource: false });
    expect(publicada.content[0].text).toMatch(/Agora está em 1 MCP\(s\) virtual\(is\) que esta credencial vê/);

    ondeEsta.privada = { todos: ['fechado-de-outro'], visiveis: [] };
    const saiu = await handlers.unlink_skill({ skill: 'privada', mcp: 'time-a' });
    expect(saiu.content[0].text).not.toContain('fechado-de-outro');

    // O admin vê tudo, e a ele a tool continua dizendo onde a skill ficou.
    const doAdmin = await createMcpHandlers(caller('admin', null)).unlink_skill({ skill: 'privada', mcp: 'time-a' });
    expect(doAdmin.content[0].text).toMatch(/Continua em fechado-de-outro/);
  });

  // Skill privada que só chegava à credencial por este vMCP: a releitura é nula.
  it('desvincular pode tirar a skill do alcance de quem chamou: a tool diz isso, não falha', async () => {
    grants['uuid-outro'] = 'edit';
    db.unlinkSkill.mockResolvedValue({ ...vinculada, mcps: [] });
    db.getSkillSummary.mockResolvedValue(null);

    const result = await createMcpHandlers(caller('membro', 'uuid-outro')).unlink_skill({ skill: 'privada', mcp: 'time-a' });

    expect(result.isError).toBeUndefined();
    expect(db.unlinkSkill).toHaveBeenCalledOnce();
    expect(result.content[0].text).toMatch(/deixou de vê-la/);
  });

  // O banco responde "Skill não encontrada" para uma e "não está vinculada" para
  // a outra: quem edita um servidor qualquer confirmaria slug de skill alheia.
  it('skill que não existe e skill que não está aqui dão a mesma resposta, sem ir ao banco', async () => {
    const inexistente = await guard(() => handlers.unlink_skill({ skill: 'nao-existe', mcp: 'time-a' }));
    const foraDaqui = await guard(() => handlers.unlink_skill({ skill: 'alheia', mcp: 'time-a' }));

    expect(inexistente.isError).toBe(true);
    expect(inexistente.content[0].text).toBe('A skill "nao-existe" não está vinculada a este MCP virtual');
    expect(foraDaqui.content[0].text).toBe('A skill "alheia" não está vinculada a este MCP virtual');
    expect(db.getSkillSummary).not.toHaveBeenCalled();
    expect(db.unlinkSkill).not.toHaveBeenCalled();
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
    // `<slug>: <nome> (<prefixo>)` — o rótulo que a revogação vai repetir.
    const prefixo = db.createVirtualMcpKey.mock.calls[0][0].prefix;
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mcp.key.create', targetLabel: `time-a: ci (${prefixo})` }),
    );
  });

  // A revogação gravava o uuid da chave, que some com o vMCP (`ON DELETE
  // CASCADE`) e não aparece em tela nenhuma; o banco passou a devolver nome e
  // prefixo (relatório 040 da auditoria de 2026-09-19).
  it('revoga restrito ao MCP, audita pelo nome da chave e sinaliza quando não achou', async () => {
    db.revokeVirtualMcpKey.mockResolvedValueOnce({ name: 'ci', prefix: 'AbCd1234' }).mockResolvedValueOnce(null);

    const ok = await handlers.revoke_virtual_mcp_key({ slug: 'time-a', key_id: 'chave-1' });
    const nao = await handlers.revoke_virtual_mcp_key({ slug: 'time-a', key_id: 'chave-2' });

    expect(db.revokeVirtualMcpKey).toHaveBeenCalledWith('chave-1', 'mcp-1');
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0].text).toBe('Chave "ci" (psv_AbCd1234_…) revogada.');
    expect(nao.isError).toBe(true);
    expect(db.recordAccountAudit).toHaveBeenCalledTimes(1);
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mcp.key.revoke', targetLabel: 'time-a: ci (AbCd1234)' }),
    );
  });
});

/**
 * Nome de vMCP e de chave `psv_` não tinha teto, e os dois são copiados em cada
 * linha de `skill_accesses` (relatório 042 da auditoria de 2026-09-19). Vale
 * para quem cria ou renomeia; o nome antigo continua válido até alguém mexer.
 */
describe('teto de nome', () => {
  const handlers = createMcpHandlers(caller('editor'));
  const LONGO = 'n'.repeat(NAME_MAX + 1);

  it('criar acima do teto é recusado com o limite, antes do banco; no teto passa', async () => {
    const recusado = await guard(() => handlers.create_virtual_mcp({ name: LONGO }));
    expect(recusado.isError).toBe(true);
    expect(recusado.content[0].text).toContain(`o limite é ${NAME_MAX}`);
    expect(db.createVirtualMcp).not.toHaveBeenCalled();

    db.createVirtualMcp.mockResolvedValue(mcp);
    expect((await handlers.create_virtual_mcp({ name: 'n'.repeat(NAME_MAX) })).isError).toBeUndefined();
  });

  it('renomear acima do teto é recusado; reenviar o nome que o vMCP já tem, não', async () => {
    const recusado = await guard(() => handlers.update_virtual_mcp({ slug: 'time-a', name: LONGO }));
    expect(recusado.isError).toBe(true);
    expect(db.updateVirtualMcp).not.toHaveBeenCalled();

    db.getVirtualMcp.mockImplementation(async (_slug: string, options?: { viewer?: Viewer }) =>
      seen({ ...mcp, name: LONGO }, options?.viewer),
    );
    db.updateVirtualMcp.mockResolvedValue(mcp);
    expect((await handlers.update_virtual_mcp({ slug: 'time-a', name: LONGO, description: 'nova' })).isError).toBeUndefined();
  });

  it('chave psv_: nome acima do teto é recusado, sem gerar chave', async () => {
    const recusado = await guard(() => handlers.create_virtual_mcp_key({ slug: 'time-a', name: LONGO }));

    expect(recusado.isError).toBe(true);
    expect(db.createVirtualMcpKey).not.toHaveBeenCalled();
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

  /**
   * `manage` revoga **qualquer** concessão (`docs/12` decisão 10), inclusive a
   * de conta desativada depois de recebê-la: a linha fica, inerte, e voltaria a
   * valer se a conta fosse reativada. Revogar passava pelo funil que exige conta
   * ativa (relatório 039 da auditoria de 2026-09-19); conceder e transferir
   * continuam exigindo.
   */
  it('revoga a concessão de conta desativada, que a ficha marca; conceder a ela continua recusado', async () => {
    db.getUserByEmail.mockImplementation(async (email: string) =>
      email === 'saiu@exemplo.com' ? { uuid: 'uuid-saiu', email, isActive: false } : null,
    );

    const ficha = JSON.parse((await dono.get_virtual_mcp({ slug: 'time-a' })).content[0].text);
    expect(ficha.grants).toEqual([
      { email: 'maria@exemplo.com', name: 'Maria', level: 'edit', isActive: true },
      { email: 'saiu@exemplo.com', name: 'Saiu', level: 'view', isActive: false },
    ]);

    const tirado = await dono.unshare_mcp({ slug: 'time-a', email: 'Saiu@Exemplo.com' });
    expect(tirado.content[0].text).toMatch(/saiu@exemplo.com perdeu o acesso/);
    expect(db.removeVirtualMcpGrant).toHaveBeenCalledWith('time-a', 'uuid-saiu', 'mcp-admin', caller('editor').actor);

    const concedido = await guard(() => dono.share_mcp({ slug: 'time-a', email: 'saiu@exemplo.com', level: 'edit' }));
    expect(concedido.isError).toBe(true);
    expect(concedido.content[0].text).toMatch(/desativada/);
    expect(db.setVirtualMcpGrant).not.toHaveBeenCalled();
  });

  // Revogar não consulta `users`: a resposta não diz se existe conta com aquele
  // e-mail — nem desativada, que a busca de contas não revela (decisão 13).
  it('e-mail sem concessão aqui é recusado sem consultar a conta', async () => {
    const nada = await guard(() => dono.unshare_mcp({ slug: 'time-a', email: 'x@exemplo.com' }));

    expect(nada.isError).toBe(true);
    expect(nada.content[0].text).toBe('A conta não tem concessão neste MCP virtual');
    expect(db.getUserByEmail).not.toHaveBeenCalled();
    expect(db.removeVirtualMcpGrant).not.toHaveBeenCalled();
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
