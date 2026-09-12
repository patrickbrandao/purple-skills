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
  setFile: vi.fn(),
  setFiles: vi.fn(),
  deleteFile: vi.fn(),
  deleteSkill: vi.fn(),
  listSkills: vi.fn(),
  listTags: vi.fn(),
  getSkillDetail: vi.fn(),
  readFile: vi.fn(),
  stats: vi.fn(),
}));

vi.mock('@purple-skills/db', () => ({ ...db, AppError }));

const { guard, createHandlers } = await import('./tools.js');

const caller = (role: 'admin' | 'editor' | 'leitor') => ({
  actor: { userUuid: role === 'admin' ? null : `uuid-${role}`, label: `${role}@exemplo.com` },
  role,
  identity: `teste:${role}`,
});

/** Chamador padrão dos testes: o token global, com papel admin. */
const handlers = createHandlers(caller('admin'));
/** Ator gravado no audit quando quem chama é o token global. */
const ADMIN_ACTOR = { userUuid: null, label: 'admin@exemplo.com' };

const detail = {
  uuid: 'uuid-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  mcps: [],
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

beforeEach(() => {
  vi.clearAllMocks();
});

/** Um vMCP do editor: quem administra publica nele; outro editor, não. */
const timeA = {
  uuid: 'mcp-1',
  slug: 'time-a',
  name: 'Time A',
  description: '',
  isActive: true,
  isOpen: true,
  ownerUserUuid: 'uuid-editor',
  ownerEmail: 'editor@exemplo.com',
  skillCount: 0,
  activeKeyCount: 0,
  isDefault: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  skills: [],
};

describe('create_skill', () => {
  it('encaminha o conteúdo do SKILL.md e marca a origem mcp-admin', async () => {
    db.createSkill.mockResolvedValue(detail);

    const result = await handlers.create_skill({
      name: 'Minha Skill',
      skill_md_content: '# Minha Skill',
      tags: ['git'],
    });

    expect(db.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Minha Skill', skillMd: '# Minha Skill', mcps: [] }),
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
  // permissão é a do vMCP — o dono ou um admin.
  it('publica nos vMCPs pedidos, com a permissão de quem os administra', async () => {
    db.getVirtualMcp.mockResolvedValue(timeA);
    db.createSkill.mockResolvedValue({
      ...detail,
      mcps: [{ ...timeA, asSkill: true, asPrompt: false, asResource: false }],
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

  it('recusa um vMCP de outra conta, ou sem superfície, sem criar nada', async () => {
    db.getVirtualMcp.mockResolvedValue({ ...timeA, ownerUserUuid: 'uuid-outra' });

    const alheio = await guard(() =>
      createHandlers(caller('editor')).create_skill({
        name: 'X',
        skill_md_content: '# X',
        mcps: [{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }],
      }),
    );
    expect(alheio.isError).toBe(true);
    expect(alheio.content[0].text).toMatch(/pertence a outra conta/);

    db.getVirtualMcp.mockResolvedValue(timeA);
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
    db.getSkillDetail.mockResolvedValue(detail);
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
    db.getSkillDetail.mockResolvedValue(detail);
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
});

describe('list_skills', () => {
  it('lê o catálogo inteiro, inclusive skills sem vínculo, e mostra onde cada uma está', async () => {
    db.listSkills.mockResolvedValue({
      items: [{ ...detail, mcps: [{ ...timeA, asSkill: true, asPrompt: true, asResource: false }] }],
      total: 1,
      limit: 50,
      offset: 0,
    });

    const payload = JSON.parse((await handlers.list_skills({})).content[0].text);

    expect(db.listSkills).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'all' }));
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
      },
    ]);
    expect(payload.skills[0]).not.toHaveProperty('visibility');
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

describe('papel da credencial', () => {
  it('leitor lê o catálogo inteiro, inclusive skills sem vínculo', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });
    await createHandlers(caller('leitor')).list_skills({});
    expect(db.listSkills).toHaveBeenCalledWith(expect.objectContaining({ visibility: 'all' }));
  });

  it('leitor não escreve nada', async () => {
    const leitor = createHandlers(caller('leitor'));

    for (const result of [
      await leitor.create_skill({ name: 'X', skill_md_content: '# X' }),
      await leitor.edit_skill({ slug: 'minha-skill', name: 'Y' }),
      await leitor.set_file({ slug: 'minha-skill', path: 'a.md', content: 'a' }),
      await leitor.set_files_bulk({ slug: 'minha-skill', zip_base64: makeZip({ 'a.md': 'a' }) }),
      await leitor.delete_file({ slug: 'minha-skill', path: 'a.md' }),
      await leitor.delete_skill({ slug: 'minha-skill', confirm: true }),
    ]) {
      expect(result.isError).toBe(true);
    }

    expect(db.createSkill).not.toHaveBeenCalled();
    expect(db.setFile).not.toHaveBeenCalled();
    expect(db.deleteSkill).not.toHaveBeenCalled();
  });

  it('editor escreve mas não apaga skill', async () => {
    db.createSkill.mockResolvedValue(detail);
    const editor = createHandlers(caller('editor'));

    expect((await editor.create_skill({ name: 'X', skill_md_content: '# X' })).isError).toBeUndefined();

    const denied = await editor.delete_skill({ slug: 'minha-skill', confirm: true });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('admin');
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
