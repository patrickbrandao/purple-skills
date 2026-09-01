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
  setVisibility: vi.fn(),
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

const { guard, handlers } = await import('./tools.js');

const detail = {
  uuid: 'uuid-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  isPublic: false,
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

describe('create_skill', () => {
  it('encaminha o conteúdo do SKILL.md e marca a origem mcp-admin', async () => {
    db.createSkill.mockResolvedValue({ ...detail, isPublic: true });

    const result = await handlers.create_skill({
      name: 'Minha Skill',
      skill_md_content: '# Minha Skill',
      tags: ['git'],
      is_public: true,
    });

    expect(db.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Minha Skill', skillMd: '# Minha Skill', isPublic: true }),
      'mcp-admin',
    );
    expect(result.content[0].text).toContain('Skill criada');
  });

  it('cria como privada quando is_public é omitido', async () => {
    db.createSkill.mockResolvedValue(detail);

    await handlers.create_skill({ name: 'X', skill_md_content: '# X' });

    expect(db.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ isPublic: false }),
      'mcp-admin',
    );
  });
});

describe('set_visibility', () => {
  it('traduz "public"/"private" para o booleano do banco', async () => {
    db.setVisibility.mockResolvedValue({ ...detail, isPublic: true });

    await handlers.set_visibility({ slug: 'minha-skill', visibility: 'public' });
    expect(db.setVisibility).toHaveBeenCalledWith('minha-skill', true, 'mcp-admin');

    db.setVisibility.mockResolvedValue({ ...detail, isPublic: false });
    await handlers.set_visibility({ slug: 'minha-skill', visibility: 'private' });
    expect(db.setVisibility).toHaveBeenCalledWith('minha-skill', false, 'mcp-admin');
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

    expect(db.deleteFile).toHaveBeenCalledWith('minha-skill', 'ref/extra.md', 'mcp-admin');
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

    expect(db.deleteSkill).toHaveBeenCalledWith('minha-skill', 'mcp-admin');
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
});

describe('list_skills', () => {
  it('inclui skills privadas por padrão', async () => {
    db.listSkills.mockResolvedValue({ items: [detail], total: 1, limit: 50, offset: 0 });

    await handlers.list_skills({});

    expect(db.listSkills).toHaveBeenCalledWith(expect.objectContaining({ includePrivate: true }));
  });

  it('respeita includePrivate: false', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });

    await handlers.list_skills({ includePrivate: false });

    expect(db.listSkills).toHaveBeenCalledWith(expect.objectContaining({ includePrivate: false }));
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
