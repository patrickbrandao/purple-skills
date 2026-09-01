import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  listSkills: vi.fn(),
  getSkillDetail: vi.fn(),
  getSkillSummary: vi.fn(),
  incrementViewCount: vi.fn(),
  listTags: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@purple-skills/db', () => db);

const { handlers } = await import('./tools.js');

const summary = {
  uuid: 'uuid-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  isPublic: true,
  viewCount: 10,
  downloadCount: 3,
  score: 13,
  tags: ['git'],
  fileCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const detail = {
  ...summary,
  skillMd: '# Minha Skill\n\nConteúdo.',
  files: [
    { relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 24, isText: true },
    { relativePath: 'ref/extra.md', mimeType: 'text/markdown', sizeBytes: 10, isText: true },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('search_skills', () => {
  it('devolve resultados em JSON com slug, score e URL', async () => {
    db.listSkills.mockResolvedValue({ items: [summary], total: 1, limit: 10, offset: 0 });

    const result = await handlers.search_skills({ query: 'git' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.total).toBe(1);
    expect(payload.results[0].slug).toBe('minha-skill');
    expect(payload.results[0].url).toContain('/skills/minha-skill');
    expect(result.isError).toBeUndefined();
  });

  it('nunca expõe skills privadas', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });

    await handlers.search_skills({ query: 'x' });

    expect(db.listSkills).toHaveBeenCalledWith(expect.objectContaining({ includePrivate: false }));
  });

  it('responde com texto amigável quando não há resultados', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });

    const result = await handlers.search_skills({ query: 'inexistente' });

    expect(result.content[0].text).toContain('Nenhuma skill encontrada');
    expect(result.isError).toBeUndefined();
  });
});

describe('get_skill', () => {
  it('retorna o SKILL.md e incrementa o contador de acessos', async () => {
    db.getSkillDetail.mockResolvedValue(detail);

    const result = await handlers.get_skill({ slug: 'minha-skill' });

    expect(db.incrementViewCount).toHaveBeenCalledWith('uuid-1');
    expect(result.content[0].text).toContain('Conteúdo.');
    expect(result.content[0].text).toContain('ref/extra.md');
  });

  it('sinaliza erro sem incrementar quando a skill não existe', async () => {
    db.getSkillDetail.mockResolvedValue(null);

    const result = await handlers.get_skill({ slug: 'nao-existe' });

    expect(result.isError).toBe(true);
    expect(db.incrementViewCount).not.toHaveBeenCalled();
  });
});

describe('get_skill_file', () => {
  it('devolve o conteúdo textual sem contar acesso', async () => {
    db.getSkillSummary.mockResolvedValue(summary);
    db.readFile.mockResolvedValue({
      relativePath: 'ref/extra.md',
      mimeType: 'text/markdown',
      sizeBytes: 5,
      isText: true,
      buffer: Buffer.from('extra'),
    });

    const result = await handlers.get_skill_file({ slug: 'minha-skill', path: 'ref/extra.md' });

    expect(result.content[0].text).toBe('extra');
    expect(db.incrementViewCount).not.toHaveBeenCalled();
  });

  it('devolve a URL de download para arquivos binários', async () => {
    db.getSkillSummary.mockResolvedValue(summary);
    db.readFile.mockResolvedValue({
      relativePath: 'img/logo.png',
      mimeType: 'image/png',
      sizeBytes: 120,
      isText: false,
      buffer: Buffer.from([1, 2, 3]),
    });

    const result = await handlers.get_skill_file({ slug: 'minha-skill', path: 'img/logo.png' });

    expect(result.content[0].text).toContain('/skills/minha-skill/files/img/logo.png');
  });

  it('rejeita caminhos com travessia de diretório', async () => {
    db.getSkillSummary.mockResolvedValue(summary);

    const result = await handlers.get_skill_file({ slug: 'minha-skill', path: '../../etc/passwd' });

    expect(result.isError).toBe(true);
    expect(db.readFile).not.toHaveBeenCalled();
  });
});

describe('download_skill', () => {
  it('devolve a URL do pacote sem gerar o zip', async () => {
    db.getSkillSummary.mockResolvedValue(summary);

    const result = await handlers.download_skill({ slug: 'minha-skill' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.downloadUrl).toMatch(/\/skills\/minha-skill\/download$/);
    expect(payload.format).toBe('zip');
  });

  it('sinaliza erro para skill inexistente', async () => {
    db.getSkillSummary.mockResolvedValue(null);

    expect((await handlers.download_skill({ slug: 'x' })).isError).toBe(true);
  });
});

describe('list_tags', () => {
  it('lista apenas tags de skills públicas', async () => {
    db.listTags.mockResolvedValue([{ name: 'git', count: 2 }]);

    const result = await handlers.list_tags();

    expect(db.listTags).toHaveBeenCalledWith({ includePrivate: false });
    expect(JSON.parse(result.content[0].text).tags).toEqual([{ name: 'git', count: 2 }]);
  });
});
