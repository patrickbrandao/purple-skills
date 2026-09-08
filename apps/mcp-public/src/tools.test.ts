import { beforeEach, describe, expect, it, vi } from 'vitest';
import { composeSkillMd } from '@purple-skills/shared';

const db = vi.hoisted(() => ({
  listSkills: vi.fn(),
  listPublishedSkills: vi.fn(),
  getSkillDetail: vi.fn(),
  getSkillSummary: vi.fn(),
  incrementViewCount: vi.fn(),
  listTags: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('@purple-skills/db', () => db);

const { handlers, surfaces } = await import('./tools.js');

const summary = {
  uuid: 'uuid-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  isPublic: true,
  useAsSkill: true,
  useAsPrompt: false,
  useAsResource: false,
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

  it('nunca expõe skills privadas nem as que estão fora das ferramentas', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });

    await handlers.search_skills({ query: 'x' });

    expect(db.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({ includePrivate: false, onlyAsSkill: true }),
    );
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

  it('não repete o frontmatter — o cabeçalho já traz os metadados', async () => {
    db.getSkillDetail.mockResolvedValue({
      ...detail,
      skillMd: '---\nname: legado\ndescription: metadados velhos\n---\n# Minha Skill\n',
    });

    const result = await handlers.get_skill({ slug: 'minha-skill' });

    expect(result.content[0].text).not.toContain('metadados velhos');
    expect(result.content[0].text).toContain('# Minha Skill');
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

  it('monta o frontmatter do SKILL.md a partir dos metadados da skill', async () => {
    db.getSkillSummary.mockResolvedValue(summary);
    db.readFile.mockResolvedValue({
      relativePath: 'SKILL.md',
      mimeType: 'text/markdown',
      sizeBytes: 24,
      isText: true,
      buffer: Buffer.from('# Minha Skill\n\nConteúdo.'),
    });

    const result = await handlers.get_skill_file({ slug: 'minha-skill', path: 'SKILL.md' });

    expect(result.content[0].text).toBe(
      '---\nname: minha-skill\ndescription: Faz coisas\nmetadata:\n  title: Minha Skill\n' +
        '  tags: git\n---\n\n# Minha Skill\n\nConteúdo.',
    );
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

    expect(db.listTags).toHaveBeenCalledWith({ includePrivate: false, onlyAsSkill: true });
    expect(JSON.parse(result.content[0].text).tags).toEqual([{ name: 'git', count: 2 }]);
  });
});

describe('use_as_skill', () => {
  // O recorte é da consulta, não daqui: os handlers que recebem slug precisam
  // pedi-lo, senão uma skill fora das ferramentas continuaria legível por quem
  // já souber o slug — e o slug sai do site, que segue mostrando ela.
  it('as três leituras por slug pedem o recorte da superfície de ferramentas', async () => {
    db.getSkillDetail.mockResolvedValue(detail);
    db.getSkillSummary.mockResolvedValue(summary);
    db.readFile.mockResolvedValue(null);

    await handlers.get_skill({ slug: 'minha-skill' });
    await handlers.get_skill_file({ slug: 'minha-skill', path: 'ref/extra.md' });
    await handlers.download_skill({ slug: 'minha-skill' });

    const recorte = { includePrivate: false, onlyAsSkill: true };
    expect(db.getSkillDetail).toHaveBeenCalledWith('minha-skill', recorte);
    expect(db.getSkillSummary).toHaveBeenNthCalledWith(1, 'minha-skill', recorte);
    expect(db.getSkillSummary).toHaveBeenNthCalledWith(2, 'minha-skill', recorte);
  });

  // A skill sem a flag chega como nulo — a query já a recortou — e a recusa
  // fica indistinta da de um slug inexistente, como na §5.5.
  it('a skill fora das ferramentas responde o mesmo "não encontrada" de um slug inexistente', async () => {
    db.getSkillDetail.mockResolvedValue(null);
    db.getSkillSummary.mockResolvedValue(null);

    expect((await handlers.get_skill({ slug: 'minha-skill' })).isError).toBe(true);
    expect((await handlers.download_skill({ slug: 'minha-skill' })).isError).toBe(true);
    expect(
      (await handlers.get_skill_file({ slug: 'minha-skill', path: 'ref/extra.md' })).isError,
    ).toBe(true);
    expect(db.incrementViewCount).not.toHaveBeenCalled();
  });

  // O caso que a feature existe para permitir: publicada só como prompt e como
  // resource. As duas superfícies não podem enxergar `use_as_skill`.
  it('não alcança prompt nem resource: uma skill pode viver só neles', async () => {
    const soPromptEResource = {
      ...detail,
      useAsSkill: false,
      useAsPrompt: true,
      useAsResource: true,
    };
    db.getSkillDetail.mockResolvedValue(soPromptEResource);

    const prompt = await surfaces.getPrompt('minha-skill');
    const resource = await surfaces.readResource('skill://minha-skill');

    expect(prompt.messages[0].content.text).toContain('Conteúdo.');
    expect(resource.contents[0].text).toBe(composeSkillMd(soPromptEResource, detail.skillMd));
    // Sem `onlyAsSkill`: aqui o recorte é só o de visibilidade.
    expect(db.getSkillDetail).toHaveBeenCalledWith('minha-skill', { includePrivate: false });
  });
});

// ------------------------------------------- prompts e resources -----------

/** O que a query enxuta da listagem devolve — só três colunas. */
const publicada = { slug: 'minha-skill', name: 'Minha Skill', description: 'Faz coisas' };

describe('prompts/list e resources/list', () => {
  it('listam pelo slug, cada uma pedindo a sua superfície', async () => {
    db.listPublishedSkills.mockResolvedValue([publicada]);

    const prompts = await surfaces.listPrompts();
    const resources = await surfaces.listResources();

    expect(db.listPublishedSkills).toHaveBeenNthCalledWith(1, 'prompt');
    expect(db.listPublishedSkills).toHaveBeenNthCalledWith(2, 'resource');
    expect(prompts.prompts).toEqual([
      { name: 'minha-skill', title: 'Minha Skill', description: 'Faz coisas' },
    ]);
    expect(resources.resources).toEqual([
      {
        uri: 'skill://minha-skill',
        name: 'minha-skill',
        title: 'Minha Skill',
        description: 'Faz coisas',
        mimeType: 'text/markdown',
      },
    ]);
  });

  it('não declaram argumentos: a skill é instrução estática', async () => {
    db.listPublishedSkills.mockResolvedValue([publicada]);

    const [prompt] = (await surfaces.listPrompts()).prompts;

    expect(prompt).not.toHaveProperty('arguments');
  });

  // A skill privada e a pública sem a flag são recortadas na query — o que se
  // garante aqui é que a lista não é montada de outra fonte, mais frouxa.
  it('ficam vazias quando nenhuma skill está flagada', async () => {
    db.listPublishedSkills.mockResolvedValue([]);

    expect((await surfaces.listPrompts()).prompts).toEqual([]);
    expect((await surfaces.listResources()).resources).toEqual([]);
    expect(db.listSkills).not.toHaveBeenCalled();
  });
});

describe('resources/read', () => {
  it('devolve o SKILL.md canônico e conta um acesso', async () => {
    db.getSkillDetail.mockResolvedValue({ ...detail, useAsResource: true });

    const result = await surfaces.readResource('skill://minha-skill');

    expect(db.getSkillDetail).toHaveBeenCalledWith('minha-skill', { includePrivate: false });
    expect(db.incrementViewCount).toHaveBeenCalledWith('uuid-1');
    expect(result.contents[0].uri).toBe('skill://minha-skill');
    expect(result.contents[0].mimeType).toBe('text/markdown');
    // Byte a byte o mesmo do .zip e do /files/SKILL.md.
    expect(result.contents[0].text).toBe(composeSkillMd(detail, detail.skillMd));
  });

  it('recusa skill inexistente, privada e pública sem a flag com o mesmo erro', async () => {
    // Privada e inexistente chegam iguais: `includePrivate: false` devolve nulo.
    db.getSkillDetail.mockResolvedValue(null);
    const ausente = await surfaces.readResource('skill://minha-skill').catch((err: Error) => err);

    db.getSkillDetail.mockResolvedValue({ ...detail, useAsResource: false });
    const semFlag = await surfaces.readResource('skill://minha-skill').catch((err: Error) => err);

    expect(ausente).toBeInstanceOf(Error);
    expect((semFlag as Error).message).toBe((ausente as Error).message);
    expect(db.incrementViewCount).not.toHaveBeenCalled();
  });

  it('recusa uma URI de outro esquema sem nem consultar o banco', async () => {
    await expect(surfaces.readResource('https://exemplo.dev/minha-skill')).rejects.toThrow();

    expect(db.getSkillDetail).not.toHaveBeenCalled();
  });
});

describe('prompts/get', () => {
  it('devolve o corpo sem frontmatter numa mensagem do usuário, e conta um acesso', async () => {
    db.getSkillDetail.mockResolvedValue({
      ...detail,
      useAsPrompt: true,
      skillMd: '---\nname: legado\ndescription: metadados velhos\n---\n# Minha Skill\n',
    });

    const result = await surfaces.getPrompt('minha-skill');

    expect(db.incrementViewCount).toHaveBeenCalledWith('uuid-1');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content.text).toBe('# Minha Skill\n');
    expect(result.messages[0].content.text).not.toContain('---');
  });

  it('recusa skill inexistente, privada e pública sem a flag com o mesmo erro', async () => {
    db.getSkillDetail.mockResolvedValue(null);
    const ausente = await surfaces.getPrompt('minha-skill').catch((err: Error) => err);

    db.getSkillDetail.mockResolvedValue({ ...detail, useAsPrompt: false });
    const semFlag = await surfaces.getPrompt('minha-skill').catch((err: Error) => err);

    expect(ausente).toBeInstanceOf(Error);
    expect((semFlag as Error).message).toBe((ausente as Error).message);
    expect(db.incrementViewCount).not.toHaveBeenCalled();
  });
});

describe('resources/templates/list', () => {
  // Responder vazio é diferente de não responder: um cliente que sonda o método
  // na inicialização não leva "method not found".
  it('responde com lista vazia', () => {
    expect(surfaces.listResourceTemplates()).toEqual({ resourceTemplates: [] });
  });
});
