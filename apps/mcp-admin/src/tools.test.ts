import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';

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
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  getVirtualMcp: vi.fn(),
  getSkillSummary: vi.fn(),
  getUserByEmail: vi.fn(),
  setSkillGrant: vi.fn(),
  removeSkillGrant: vi.fn(),
  setFile: vi.fn(),
  setFiles: vi.fn(),
  deleteFile: vi.fn(),
  deleteSkill: vi.fn(),
  listSkills: vi.fn(),
  listTags: vi.fn(),
  getSkillDetail: vi.fn(),
  readFile: vi.fn(),
  stats: vi.fn(),
  notFound: (message: string) => new AppError(message, 404, 'not_found'),
  badRequest: (message: string) => new AppError(message, 400, 'bad_request'),
}));

vi.mock('@purple-skills/db', () => ({ ...db, AppError }));

const { guard, createHandlers } = await import('./tools.js');

type Role = 'admin' | 'editor' | 'membro';
type Viewer = { role: Role; userUuid: string | null };

const caller = (role: Role, userUuid: string | null = role === 'admin' ? null : `uuid-${role}`) => ({
  actor: { userUuid, label: `${role}@exemplo.com` },
  role,
  identity: `teste:${role}`,
});

/** Chamador padrão dos testes: o token global, com papel admin. */
const handlers = createHandlers(caller('admin'));
/** Ator gravado no audit quando quem chama é o token global. */
const ADMIN_ACTOR = { userUuid: null, label: 'admin@exemplo.com' };

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

const detail = {
  icon: null,
  uuid: 'uuid-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  isActive: true,
  isPublic: false,
  ownerUserUuid: 'uuid-editor',
  ownerEmail: 'editor@exemplo.com',
  access: 'owner',
  grants: [],
  mcps: [],
  catalogs: [],
  viewCount: 0,
  downloadCount: 0,
  score: 0,
  tags: ['git'],
  fileCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  skillMd: '# Minha Skill',
  files: [{ relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 14, isText: true }],
};

function makeZip(entries: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer().toString('base64');
}

/** Um vMCP do editor: quem o edita publica nele; outro editor não o vê. */
const timeA = {
  uuid: 'mcp-1',
  slug: 'time-a',
  name: 'Time A',
  description: '',
  isActive: true,
  isOpen: false,
  ownerUserUuid: 'uuid-editor',
  ownerEmail: 'editor@exemplo.com',
  grants: [],
  skillCount: 0,
  activeKeyCount: 0,
  isDefault: false,
  toolCount: 0,
  promptCount: 0,
  resourceCount: 0,
  onlineSessions: 0,
  preview: [],
  catalogCount: 0,
  layout: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  skills: [],
  catalogs: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(grants)) delete grants[key];
  db.getSkillSummary.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) =>
    slug === 'minha-skill' ? seen(detail, options?.viewer) : null,
  );
  db.getSkillDetail.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) =>
    slug === 'minha-skill' ? seen(detail, options?.viewer) : null,
  );
  db.getVirtualMcp.mockImplementation(async (slug: string, options?: { viewer?: Viewer }) =>
    slug === 'time-a' ? seen(timeA, options?.viewer) : null,
  );
  db.getUserByEmail.mockImplementation(async (email: string) =>
    email === 'maria@exemplo.com' ? { uuid: 'uuid-maria', email, isActive: true } : null,
  );
});

describe('create_skill', () => {
  it('encaminha o conteúdo do SKILL.md e marca a origem mcp-admin', async () => {
    db.createSkill.mockResolvedValue(detail);

    const result = await handlers.create_skill({
      name: 'Minha Skill',
      skill_md_content: '# Minha Skill',
      tags: ['git'],
    });

    expect(db.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Minha Skill', skillMd: '# Minha Skill', mcps: [], isPublic: false }),
      'mcp-admin',
      ADMIN_ACTOR,
    );
    expect(result.content[0].text).toContain('Skill criada');
    expect(result.content[0].text).toContain('sem vínculo');
  });

  it('descarta o frontmatter enviado no conteúdo — os campos mandam', async () => {
    db.createSkill.mockResolvedValue(detail);

    await handlers.create_skill({
      name: 'Minha Skill',
      slug: 'minha-skill',
      description: 'Faz coisas',
      skill_md_content: '---\nname: outra\ndescription: mentira\n---\n# Minha Skill\n',
    });

    expect(db.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ skillMd: '# Minha Skill\n' }),
      'mcp-admin',
      ADMIN_ACTOR,
    );
  });

  // Onde a skill aparece é o vínculo: `mcps` resolve o slug em uuid e a
  // permissão é a do vMCP — `edit` nele.
  it('publica nos vMCPs pedidos, com a permissão de quem os edita', async () => {
    db.createSkill.mockResolvedValue({
      ...detail,
      mcps: [{ ...timeA, isOpen: true, asSkill: true, asPrompt: false, asResource: false, direct: true, catalogs: [] }],
    });

    const result = await createHandlers(caller('editor')).create_skill({
      name: 'X',
      skill_md_content: '# X',
      mcps: [{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }],
    });

    expect(db.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        mcps: [{ virtualMcpUuid: 'mcp-1', asSkill: true, asPrompt: false, asResource: false }],
      }),
      'mcp-admin',
      expect.anything(),
    );
    expect(result.content[0].text).toContain('publicada em time-a');
    expect(result.content[0].text).toContain('/skills/minha-skill');
  });

  it('recusa um vMCP que não vê, um que só lê, ou sem superfície, sem criar nada', async () => {
    const outro = createHandlers(caller('editor', 'uuid-outro'));

    const invisivel = await guard(() =>
      outro.create_skill({
        name: 'X',
        skill_md_content: '# X',
        mcps: [{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }],
      }),
    );
    expect(invisivel.isError).toBe(true);
    expect(invisivel.content[0].text).toMatch(/MCP virtual não encontrado/);

    grants['uuid-outro'] = 'view';
    const soLe = await guard(() =>
      outro.create_skill({
        name: 'X',
        skill_md_content: '# X',
        mcps: [{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }],
      }),
    );
    expect(soLe.isError).toBe(true);
    expect(soLe.content[0].text).toMatch(/exige "editar"/);

    const semPorta = await guard(() =>
      handlers.create_skill({
        name: 'X',
        skill_md_content: '# X',
        mcps: [{ slug: 'time-a', asSkill: false, asPrompt: false, asResource: false }],
      }),
    );
    expect(semPorta.isError).toBe(true);
    expect(db.createSkill).not.toHaveBeenCalled();
  });
});

describe('edit_skill', () => {
  it('repassa só os metadados; onde a skill aparece é link_skill', async () => {
    db.updateSkill.mockResolvedValue(detail);

    await handlers.edit_skill({ slug: 'minha-skill', name: 'Novo nome', new_slug: 'novo' });

    expect(db.updateSkill).toHaveBeenCalledWith(
      'minha-skill',
      { name: 'Novo nome', description: undefined, tags: undefined, slug: 'novo' },
      'mcp-admin',
      ADMIN_ACTOR,
    );
  });

  // `docs/12` §3.2: nome, descrição, ícone e tags são edit; slug, estado e
  // público são manage.
  it('edit muda conteúdo; slug, is_active e is_public exigem manage', async () => {
    grants['uuid-outro'] = 'edit';
    const editor = createHandlers(caller('membro', 'uuid-outro'));
    db.updateSkill.mockResolvedValue(detail);

    expect((await editor.edit_skill({ slug: 'minha-skill', name: 'Y' })).isError).toBeUndefined();

    for (const args of [{ new_slug: 'z' }, { is_active: false }, { is_public: true }]) {
      const negado = await guard(() => editor.edit_skill({ slug: 'minha-skill', ...args }));
      expect(negado.isError).toBe(true);
      expect(negado.content[0].text).toMatch(/exige "administrar"/);
    }
    expect(db.updateSkill).toHaveBeenCalledTimes(1);

    grants['uuid-outro'] = 'manage';
    db.updateSkill.mockResolvedValue({ ...detail, isPublic: true });
    const publica = await editor.edit_skill({ slug: 'minha-skill', is_public: true });
    expect(publica.content[0].text).toMatch(/pública/);
  });
});

describe('delete_file', () => {
  it('bloqueia a remoção do SKILL.md em qualquer caixa', async () => {
    for (const path of ['SKILL.md', 'skill.MD']) {
      const result = await handlers.delete_file({ slug: 'minha-skill', path });
      expect(result.isError).toBe(true);
    }
    expect(db.deleteFile).not.toHaveBeenCalled();
  });

  it('remove arquivos comuns', async () => {
    db.deleteFile.mockResolvedValue(undefined);

    const result = await handlers.delete_file({ slug: 'minha-skill', path: 'ref/extra.md' });

    expect(db.deleteFile).toHaveBeenCalledWith(
      'minha-skill',
      'ref/extra.md',
      'mcp-admin',
      ADMIN_ACTOR,
    );
    expect(result.isError).toBeUndefined();
  });
});

describe('delete_skill', () => {
  it('exige confirm: true', async () => {
    const result = await handlers.delete_skill({ slug: 'minha-skill', confirm: false });

    expect(result.isError).toBe(true);
    expect(db.deleteSkill).not.toHaveBeenCalled();
  });

  it('remove quando confirmado', async () => {
    db.deleteSkill.mockResolvedValue(undefined);

    await handlers.delete_skill({ slug: 'minha-skill', confirm: true });

    expect(db.deleteSkill).toHaveBeenCalledWith('minha-skill', 'mcp-admin', ADMIN_ACTOR);
  });
});

describe('set_file', () => {
  it('grava anexos como vieram', async () => {
    db.setFile.mockResolvedValue({
      relativePath: 'ref/a.md',
      mimeType: 'text/markdown',
      sizeBytes: 3,
      isText: true,
    });

    await handlers.set_file({ slug: 'minha-skill', path: 'ref/a.md', content: '---\na: b\n---\nx' });

    expect(db.setFile).toHaveBeenCalledWith(
      'minha-skill',
      'ref/a.md',
      '---\na: b\n---\nx',
      'mcp-admin',
      ADMIN_ACTOR,
    );
  });

  it('tira o frontmatter do SKILL.md — metadados só por edit_skill', async () => {
    db.setFile.mockResolvedValue({
      relativePath: 'SKILL.md',
      mimeType: 'text/markdown',
      sizeBytes: 3,
      isText: true,
    });

    await handlers.set_file({
      slug: 'minha-skill',
      path: 'SKILL.md',
      content: '---\nname: outra\n---\n# Corpo\n',
    });

    expect(db.setFile).toHaveBeenCalledWith(
      'minha-skill',
      'SKILL.md',
      '# Corpo\n',
      'mcp-admin',
      ADMIN_ACTOR,
    );
  });
});

describe('set_files_bulk', () => {
  it('extrai o zip e trata a árvore como estado completo por padrão', async () => {
    db.setFiles.mockResolvedValue([
      { relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 3, isText: true },
      { relativePath: 'ref/a.md', mimeType: 'text/markdown', sizeBytes: 3, isText: true },
    ]);

    const zip = makeZip({ 'SKILL.md': '# a', 'ref/a.md': '# b' });
    await handlers.set_files_bulk({ slug: 'minha-skill', zip_base64: zip });

    const [slug, files, source, options] = db.setFiles.mock.calls[0];
    expect(slug).toBe('minha-skill');
    expect(files.map((file: { relativePath: string }) => file.relativePath).sort()).toEqual([
      'SKILL.md',
      'ref/a.md',
    ]);
    expect(source).toBe('mcp-admin');
    expect(options).toEqual({ replace: true });
  });

  it('respeita replace=false para apenas adicionar/sobrescrever', async () => {
    db.setFiles.mockResolvedValue([]);

    await handlers.set_files_bulk({
      slug: 'minha-skill',
      zip_base64: makeZip({ 'SKILL.md': '# a' }),
      replace: false,
    });

    expect(db.setFiles.mock.calls[0][3]).toEqual({ replace: false });
  });

  it('tira o frontmatter do SKILL.md que vem no zip', async () => {
    db.setFiles.mockResolvedValue([]);

    await handlers.set_files_bulk({
      slug: 'minha-skill',
      zip_base64: makeZip({ 'SKILL.md': '---\nname: outra\n---\n# Corpo\n', 'ref/a.md': '# b' }),
    });

    const files = db.setFiles.mock.calls[0][1] as { relativePath: string; content: Buffer }[];
    const skillMd = files.find((file) => file.relativePath === 'SKILL.md');
    expect(skillMd?.content.toString('utf8')).toBe('# Corpo\n');
  });

  it('recusa um zip vazio', async () => {
    const result = await handlers.set_files_bulk({ slug: 'minha-skill', zip_base64: makeZip({}) });

    expect(result.isError).toBe(true);
    expect(db.setFiles).not.toHaveBeenCalled();
  });
});

describe('get_file', () => {
  it('recusa arquivos binários', async () => {
    db.readFile.mockResolvedValue({
      relativePath: 'img/logo.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      isText: false,
      buffer: Buffer.from([1, 2, 3]),
    });

    expect((await handlers.get_file({ slug: 'minha-skill', path: 'img/logo.png' })).isError).toBe(
      true,
    );
  });

  it('monta o frontmatter do SKILL.md a partir dos metadados da skill', async () => {
    db.readFile.mockResolvedValue({
      relativePath: 'SKILL.md',
      mimeType: 'text/markdown',
      sizeBytes: 14,
      isText: true,
      buffer: Buffer.from('# Minha Skill'),
    });

    const result = await handlers.get_file({ slug: 'minha-skill', path: 'SKILL.md' });

    expect(result.content[0].text).toBe(
      '---\nname: minha-skill\ndescription: Faz coisas\nmetadata:\n  title: Minha Skill\n' +
        '  tags: git\n---\n\n# Minha Skill',
    );
  });
});

describe('get_skill', () => {
  it('devolve o corpo do SKILL.md, sem o frontmatter gravado', async () => {
    db.getSkillDetail.mockResolvedValue({
      ...detail,
      skillMd: '---\nname: legado\ndescription: metadados velhos\n---\n# Minha Skill\n',
    });

    const payload = JSON.parse((await handlers.get_skill({ slug: 'minha-skill' })).content[0].text);

    expect(payload.skillMd).toBe('# Minha Skill\n');
    expect(payload.slug).toBe('minha-skill');
  });

  it('mostra o dono e o acesso; as concessões só para quem administra', async () => {
    const dado = { userUuid: 'uuid-maria', email: 'maria@exemplo.com', name: 'Maria', role: 'membro', level: 'view', grantedByUserUuid: null, grantedByEmail: null, createdAt: '2026-01-01T00:00:00.000Z' };
    db.getSkillDetail.mockImplementation(async (_slug: string, options?: { viewer?: Viewer }) =>
      seen({ ...detail, grants: [dado] }, options?.viewer),
    );

    const doDono = JSON.parse((await handlers.get_skill({ slug: 'minha-skill' })).content[0].text);
    expect(doDono).toMatchObject({ owner: 'editor@exemplo.com', isPublic: false, access: 'owner' });
    expect(doDono.grants).toEqual([{ email: 'maria@exemplo.com', name: 'Maria', level: 'view' }]);

    grants['uuid-maria'] = 'view';
    const daMaria = JSON.parse(
      (await createHandlers(caller('membro', 'uuid-maria')).get_skill({ slug: 'minha-skill' })).content[0].text,
    );
    expect(daMaria.access).toBe('view');
    expect(daMaria.grants).toBeUndefined();
  });
});

describe('list_skills', () => {
  it('lê o que a credencial vê, inclusive skills sem vínculo, e mostra onde cada uma está', async () => {
    db.listSkills.mockResolvedValue({
      items: [
        {
          ...detail,
          mcps: [
            { ...timeA, isOpen: true, asSkill: true, asPrompt: true, asResource: false, direct: true, catalogs: [] },
            // Alcançado só por catálogo: as portas são do catálogo, e a tool diz por qual.
            { ...timeA, isOpen: true, uuid: 'mcp-2', slug: 'time-b', name: 'Time B', asSkill: true, asPrompt: false, asResource: false, direct: false, catalogs: [{ uuid: 'cat-1', slug: 'dados', name: 'Dados' }] },
          ],
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    });

    const payload = JSON.parse((await handlers.list_skills({ scope: 'mine' })).content[0].text);

    expect(db.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({ viewer: { role: 'admin', userUuid: null }, scope: 'mine' }),
    );
    expect(payload.skills[0].mcps).toEqual([
      {
        slug: 'time-a',
        name: 'Time A',
        isOpen: true,
        isActive: true,
        isDefault: false,
        asSkill: true,
        asPrompt: true,
        asResource: false,
        direct: true,
        viaCatalogs: [],
      },
      {
        slug: 'time-b',
        name: 'Time B',
        isOpen: true,
        isActive: true,
        isDefault: false,
        asSkill: true,
        asPrompt: false,
        asResource: false,
        direct: false,
        viaCatalogs: ['dados'],
      },
    ]);
    expect(payload.skills[0]).toMatchObject({ isActive: true, owner: 'editor@exemplo.com', access: 'owner' });
    expect(payload.skills[0]).not.toHaveProperty('visibility');
  });
});

describe('acesso: share / unshare / transfer', () => {
  const dono = createHandlers(caller('editor'));

  it('manage concede e revoga pelo e-mail', async () => {
    db.setSkillGrant.mockResolvedValue({ userUuid: 'uuid-maria', email: 'maria@exemplo.com', level: 'manage' });
    db.removeSkillGrant.mockResolvedValue(undefined);

    const dado = await dono.share_skill({ slug: 'minha-skill', email: 'maria@exemplo.com', level: 'manage' });
    expect(dado.content[0].text).toMatch(/maria@exemplo.com agora pode administrar/);
    expect(db.setSkillGrant).toHaveBeenCalledWith('minha-skill', 'uuid-maria', 'manage', 'mcp-admin', caller('editor').actor);

    await dono.unshare_skill({ slug: 'minha-skill', email: 'maria@exemplo.com' });
    expect(db.removeSkillGrant).toHaveBeenCalledWith('minha-skill', 'uuid-maria', 'mcp-admin', caller('editor').actor);

    grants['uuid-outro'] = 'edit';
    const negado = await guard(() =>
      createHandlers(caller('membro', 'uuid-outro')).share_skill({ slug: 'minha-skill', email: 'maria@exemplo.com', level: 'view' }),
    );
    expect(negado.isError).toBe(true);
    expect(negado.content[0].text).toMatch(/exige "administrar"/);
  });

  it('transferir é do dono; conta inativa é recusada', async () => {
    db.updateSkill.mockResolvedValue(detail);

    await dono.transfer_skill({ slug: 'minha-skill', email: 'maria@exemplo.com' });
    expect(db.updateSkill).toHaveBeenCalledWith('minha-skill', { ownerUserUuid: 'uuid-maria' }, 'mcp-admin', caller('editor').actor);

    db.getUserByEmail.mockResolvedValueOnce({ uuid: 'uuid-x', email: 'x@exemplo.com', isActive: false });
    const inativa = await guard(() => dono.transfer_skill({ slug: 'minha-skill', email: 'x@exemplo.com' }));
    expect(inativa.isError).toBe(true);
    expect(inativa.content[0].text).toMatch(/desativada/);
  });
});

describe('guard', () => {
  it('converte AppError em resultado de erro legível', async () => {
    const result = await guard(async () => {
      throw new AppError('Skill não encontrada: x', 404, 'not_found');
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Skill não encontrada: x');
  });

  it('não deixa erros inesperados derrubarem a ferramenta', async () => {
    const result = await guard(async () => {
      throw new Error('conexão perdida');
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('conexão perdida');
  });
});

// ---------------------------------------------------------------- papéis ---

describe('papel e acesso da credencial', () => {
  it('membro lista com o próprio viewer', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    await createHandlers(caller('membro')).list_skills({});
    expect(db.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({ viewer: { role: 'membro', userUuid: 'uuid-membro' } }),
    );
  });

  it('membro não cria; sem acesso, não vê nem escreve numa skill alheia', async () => {
    const membro = createHandlers(caller('membro'));

    const criar = await membro.create_skill({ name: 'X', skill_md_content: '# X' });
    expect(criar.isError).toBe(true);
    expect(criar.content[0].text).toMatch(/exige papel "editor" ou "admin"/);

    for (const run of [
      () => membro.get_skill({ slug: 'minha-skill' }),
      () => membro.edit_skill({ slug: 'minha-skill', name: 'Y' }),
      () => membro.set_file({ slug: 'minha-skill', path: 'a.md', content: 'a' }),
      () => membro.set_files_bulk({ slug: 'minha-skill', zip_base64: makeZip({ 'a.md': 'a' }) }),
      () => membro.delete_file({ slug: 'minha-skill', path: 'a.md' }),
      () => membro.delete_skill({ slug: 'minha-skill', confirm: true }),
    ]) {
      const result = await guard(run);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/não encontrada/);
    }

    expect(db.createSkill).not.toHaveBeenCalled();
    expect(db.setFile).not.toHaveBeenCalled();
    expect(db.deleteSkill).not.toHaveBeenCalled();
  });

  it('membro edita e apaga o que é seu; view só lê', async () => {
    db.setFile.mockResolvedValue({ relativePath: 'a.md', mimeType: 'text/markdown', sizeBytes: 1, isText: true });
    db.deleteSkill.mockResolvedValue(undefined);
    const dono = createHandlers(caller('membro', 'uuid-editor'));

    expect((await dono.set_file({ slug: 'minha-skill', path: 'a.md', content: 'a' })).isError).toBeUndefined();
    expect((await dono.delete_skill({ slug: 'minha-skill', confirm: true })).isError).toBeUndefined();

    grants['uuid-maria'] = 'view';
    const leitora = createHandlers(caller('membro', 'uuid-maria'));
    expect((await leitora.get_skill({ slug: 'minha-skill' })).isError).toBeUndefined();
    const negado = await guard(() => leitora.set_file({ slug: 'minha-skill', path: 'a.md', content: 'a' }));
    expect(negado.isError).toBe(true);
    expect(negado.content[0].text).toMatch(/exige "editar"/);
  });

  it('editor com edit escreve mas não apaga a skill de outro', async () => {
    grants['uuid-outro'] = 'edit';
    const editor = createHandlers(caller('editor', 'uuid-outro'));
    db.setFile.mockResolvedValue({ relativePath: 'a.md', mimeType: 'text/markdown', sizeBytes: 1, isText: true });

    expect((await editor.set_file({ slug: 'minha-skill', path: 'a.md', content: 'a' })).isError).toBeUndefined();

    const denied = await guard(() => editor.delete_skill({ slug: 'minha-skill', confirm: true }));
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/exige "dono"/);
    expect(db.deleteSkill).not.toHaveBeenCalled();
  });

  it('o ator do chamador vai junto para a auditoria', async () => {
    db.createSkill.mockResolvedValue(detail);
    await createHandlers(caller('editor')).create_skill({ name: 'X', skill_md_content: '# X' });

    expect(db.createSkill).toHaveBeenCalledWith(expect.anything(), 'mcp-admin', {
      userUuid: 'uuid-editor',
      label: 'editor@exemplo.com',
    });
  });
});
