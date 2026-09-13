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

const { createHandlers, createSurfaces } = await import('./tools.js');

/** O vínculo com o vMCP padrão, aberto: é o que põe a skill no site. */
const noPublic = {
  uuid: 'mcp-1',
  slug: 'public',
  name: 'Public',
  isOpen: true,
  isActive: true,
  isDefault: true,
  asSkill: true,
  asPrompt: false,
  asResource: false,
};

const summary = {
  uuid: 'uuid-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  mcps: [noPublic],
  viewCount: 10,
  downloadCount: 3,
  score: 13,
  icon: null,
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

/**
 * O vMCP padrão, chamado pela raiz: `baseUrl` é a origem do servidor, sem
 * prefixo. É o mesmo servidor que responde em `/virtual/public`.
 */
const publico = { uuid: 'mcp-1', slug: 'public', name: 'Public', description: '', isOpen: true };
const raiz = { mcp: publico, baseUrl: 'https://mcp.exemplo.dev' };
const handlers = createHandlers(raiz);
const surfaces = createSurfaces(raiz);

/** O recorte que toda leitura das ferramentas pede: o vínculo com `as_skill`. */
const recorte = { virtualMcp: { uuid: 'mcp-1', surface: 'skill' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('search_skills', () => {
  it('devolve resultados em JSON com slug, score e URL da página', async () => {
    db.listSkills.mockResolvedValue({ items: [summary], total: 1, limit: 10, offset: 0 });

    const result = await handlers.search_skills({ query: 'git' });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.total).toBe(1);
    expect(payload.results[0].slug).toBe('minha-skill');
    expect(payload.results[0].url).toBe('http://localhost:3000/skills/minha-skill');
    expect(result.isError).toBeUndefined();
  });

  it('lê só pelo vínculo do vMCP: nenhuma visibilidade além dele', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });

    await handlers.search_skills({ query: 'x' });

    expect(db.listSkills).toHaveBeenCalledWith(expect.objectContaining(recorte));
    expect(db.listSkills.mock.calls[0][0]).not.toHaveProperty('visibility');
  });

  it('responde com texto amigável quando não há resultados', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });

    const result = await handlers.search_skills({ query: 'inexistente' });

    expect(result.content[0].text).toContain('Nenhuma skill encontrada');
    expect(result.isError).toBeUndefined();
  });
});

describe('get_skill', () => {
  it('retorna o SKILL.md e incrementa o contador no vínculo e na skill', async () => {
    db.getSkillDetail.mockResolvedValue(detail);

    const result = await handlers.get_skill({ slug: 'minha-skill' });

    expect(db.getSkillDetail).toHaveBeenCalledWith('minha-skill', recorte);
    expect(db.incrementViewCount).toHaveBeenCalledWith('uuid-1', 'mcp-1');
    expect(result.content[0].text).toContain('Conteúdo.');
    expect(result.content[0].text).toContain('ref/extra.md');
    // Na raiz, o download é do próprio servidor, sem prefixo /virtual.
    expect(result.content[0].text).toContain(
      'download (zip): https://mcp.exemplo.dev/skills/minha-skill/download',
    );
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

  it('sinaliza erro sem incrementar quando a skill não está no vMCP', async () => {
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

    expect(db.getSkillSummary).toHaveBeenCalledWith('minha-skill', recorte);
    expect(result.content[0].text).toBe('extra');
    expect(db.incrementViewCount).not.toHaveBeenCalled();
  });

  it('devolve a URL de download do próprio servidor para arquivos binários', async () => {
    db.getSkillSummary.mockResolvedValue(summary);
    db.readFile.mockResolvedValue({
      relativePath: 'img/logo.png',
      mimeType: 'image/png',
      sizeBytes: 120,
      isText: false,
      buffer: Buffer.from([1, 2, 3]),
    });

    const result = await handlers.get_skill_file({ slug: 'minha-skill', path: 'img/logo.png' });

    expect(result.content[0].text).toContain(
      'https://mcp.exemplo.dev/skills/minha-skill/files/img/logo.png',
    );
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
  it('devolve a URL do pacote no próprio servidor, sem gerar o zip', async () => {
    db.getSkillSummary.mockResolvedValue(summary);

    const result = await handlers.download_skill({ slug: 'minha-skill' });
    const payload = JSON.parse(result.content[0].text);

    expect(db.getSkillSummary).toHaveBeenCalledWith('minha-skill', recorte);
    expect(payload.downloadUrl).toBe('https://mcp.exemplo.dev/skills/minha-skill/download');
    expect(payload.format).toBe('zip');
    // vMCP aberto: a dica não pede chave.
    expect(payload.hint).not.toContain('Authorization');
  });

  it('sinaliza erro para skill fora do vMCP', async () => {
    db.getSkillSummary.mockResolvedValue(null);

    expect((await handlers.download_skill({ slug: 'x' })).isError).toBe(true);
  });
});

describe('list_tags', () => {
  it('conta só as skills vinculadas nas ferramentas', async () => {
    db.listTags.mockResolvedValue([{ name: 'git', count: 2 }]);

    const result = await handlers.list_tags();

    expect(db.listTags).toHaveBeenCalledWith(recorte);
    expect(JSON.parse(result.content[0].text).tags).toEqual([{ name: 'git', count: 2 }]);
  });
});

describe('a skill fora das ferramentas', () => {
  // A skill vinculada só como prompt ou resource chega como nulo — a query já
  // a recortou — e a recusa fica indistinta da de um slug inexistente.
  it('responde o mesmo "não encontrada" de um slug inexistente', async () => {
    db.getSkillDetail.mockResolvedValue(null);
    db.getSkillSummary.mockResolvedValue(null);

    expect((await handlers.get_skill({ slug: 'minha-skill' })).isError).toBe(true);
    expect((await handlers.download_skill({ slug: 'minha-skill' })).isError).toBe(true);
    expect(
      (await handlers.get_skill_file({ slug: 'minha-skill', path: 'ref/extra.md' })).isError,
    ).toBe(true);
    expect(db.incrementViewCount).not.toHaveBeenCalled();
  });

  // O caso que a feature existe para permitir: vinculada só como prompt e como
  // resource. As duas superfícies pedem a flag da própria superfície.
  it('continua legível como prompt e como resource, pela flag do vínculo', async () => {
    db.getSkillDetail.mockResolvedValue(detail);

    const prompt = await surfaces.getPrompt('minha-skill');
    const resource = await surfaces.readResource('skill://minha-skill');

    expect(prompt.messages[0].content.text).toContain('Conteúdo.');
    expect(resource.contents[0].text).toBe(composeSkillMd(detail, detail.skillMd));
    expect(db.getSkillDetail).toHaveBeenNthCalledWith(1, 'minha-skill', {
      virtualMcp: { uuid: 'mcp-1', surface: 'prompt' },
    });
    expect(db.getSkillDetail).toHaveBeenNthCalledWith(2, 'minha-skill', {
      virtualMcp: { uuid: 'mcp-1', surface: 'resource' },
    });
  });
});

// ------------------------------------------- prompts e resources -----------

/** O que a query enxuta da listagem devolve — só três colunas. */
const publicada = { slug: 'minha-skill', name: 'Minha Skill', description: 'Faz coisas' };

describe('prompts/list e resources/list', () => {
  it('listam pelo vínculo do vMCP, cada uma pedindo a sua superfície', async () => {
    db.listPublishedSkills.mockResolvedValue([publicada]);

    const prompts = await surfaces.listPrompts();
    const resources = await surfaces.listResources();

    expect(db.listPublishedSkills).toHaveBeenNthCalledWith(1, 'prompt', 'mcp-1');
    expect(db.listPublishedSkills).toHaveBeenNthCalledWith(2, 'resource', 'mcp-1');
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

  it('ficam vazias quando nenhuma skill está vinculada na superfície', async () => {
    db.listPublishedSkills.mockResolvedValue([]);

    expect((await surfaces.listPrompts()).prompts).toEqual([]);
    expect((await surfaces.listResources()).resources).toEqual([]);
    expect(db.listSkills).not.toHaveBeenCalled();
  });
});

describe('resources/read', () => {
  it('devolve o SKILL.md canônico e conta um acesso no vínculo', async () => {
    db.getSkillDetail.mockResolvedValue(detail);

    const result = await surfaces.readResource('skill://minha-skill');

    expect(db.incrementViewCount).toHaveBeenCalledWith('uuid-1', 'mcp-1');
    expect(result.contents[0].uri).toBe('skill://minha-skill');
    expect(result.contents[0].mimeType).toBe('text/markdown');
    // Byte a byte o mesmo do .zip e do /files/SKILL.md.
    expect(result.contents[0].text).toBe(composeSkillMd(detail, detail.skillMd));
  });

  it('recusa skill fora do vínculo ou sem a flag com um erro só', async () => {
    db.getSkillDetail.mockResolvedValue(null);

    await expect(surfaces.readResource('skill://minha-skill')).rejects.toThrow(/não encontrado/);
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
      skillMd: '---\nname: legado\ndescription: metadados velhos\n---\n# Minha Skill\n',
    });

    const result = await surfaces.getPrompt('minha-skill');

    expect(db.incrementViewCount).toHaveBeenCalledWith('uuid-1', 'mcp-1');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content.text).toBe('# Minha Skill\n');
    expect(result.messages[0].content.text).not.toContain('---');
  });

  it('recusa skill fora do vínculo ou sem a flag com um erro só', async () => {
    db.getSkillDetail.mockResolvedValue(null);

    await expect(surfaces.getPrompt('minha-skill')).rejects.toThrow(/não encontrado/);
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

// ------------------------------------------------------- outro vMCP ---

/**
 * Sob `/virtual/<slug>` são as mesmas ferramentas com outro escopo: o vínculo
 * daquele vMCP e as URLs de download com o prefixo do caminho por onde ele foi
 * chamado (`docs/08-mcp-virtual.md` §3, §4).
 */
describe('escopo de outro MCP virtual', () => {
  const mcp = { uuid: 'mcp-2', slug: 'time-a', name: 'Time A', description: '', isOpen: false };
  const scope = { mcp, baseUrl: 'https://mcp.exemplo.dev/virtual/time-a' };
  const virtual = createHandlers(scope);
  // Só neste vMCP fechado: não existe no site.
  const privada = {
    ...summary,
    mcps: [{ ...noPublic, uuid: 'mcp-2', slug: 'time-a', name: 'Time A', isOpen: false, isDefault: false }],
  };

  it('toda leitura passa o recorte do próprio vínculo', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0 });
    db.listTags.mockResolvedValue([]);
    db.getSkillSummary.mockResolvedValue(null);
    db.getSkillDetail.mockResolvedValue(null);

    await virtual.search_skills({ query: 'x' });
    await virtual.list_tags();
    await virtual.get_skill({ slug: 's' });
    await virtual.download_skill({ slug: 's' });

    const proprio = { virtualMcp: { uuid: 'mcp-2', surface: 'skill' } };
    expect(db.listSkills).toHaveBeenCalledWith(expect.objectContaining(proprio));
    expect(db.listTags).toHaveBeenCalledWith(proprio);
    expect(db.getSkillDetail).toHaveBeenCalledWith('s', proprio);
    expect(db.getSkillSummary).toHaveBeenCalledWith('s', proprio);
  });

  it('get_skill numa skill privada conta acesso no vínculo e devolve download com o prefixo, sem página', async () => {
    db.getSkillDetail.mockResolvedValue({ ...detail, ...privada });

    const result = await virtual.get_skill({ slug: 'minha-skill' });

    expect(db.incrementViewCount).toHaveBeenCalledWith('uuid-1', 'mcp-2');
    expect(result.content[0].text).toContain(
      'download (zip): https://mcp.exemplo.dev/virtual/time-a/skills/minha-skill/download',
    );
    expect(result.content[0].text).not.toContain('página:');
  });

  it('mantém a página do site quando a skill também está num vMCP aberto', async () => {
    db.listSkills.mockResolvedValue({ items: [summary, privada], total: 2, limit: 10, offset: 0 });

    const payload = JSON.parse((await virtual.search_skills({})).content[0].text);

    expect(payload.results[0].url).toBe('http://localhost:3000/skills/minha-skill');
    expect(payload.results[1].url).toBeUndefined();
  });

  it('download_skill e arquivo binário apontam para o prefixo do virtual, com a dica da chave', async () => {
    db.getSkillSummary.mockResolvedValue(privada);
    db.readFile.mockResolvedValue({
      relativePath: 'img/logo.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      isText: false,
      buffer: Buffer.from([1, 2, 3]),
    });

    const download = JSON.parse((await virtual.download_skill({ slug: 'minha-skill' })).content[0].text);
    const file = await virtual.get_skill_file({ slug: 'minha-skill', path: 'img/logo.png' });

    expect(download.downloadUrl).toBe(
      'https://mcp.exemplo.dev/virtual/time-a/skills/minha-skill/download',
    );
    expect(download.hint).toContain('Authorization: Bearer');
    expect(file.content[0].text).toContain(
      'https://mcp.exemplo.dev/virtual/time-a/skills/minha-skill/files/img/logo.png',
    );
  });

  it('prompts e resources listam e leem pelo vínculo daquele vMCP', async () => {
    const surfacesVirtual = createSurfaces(scope);
    db.listPublishedSkills.mockResolvedValue([{ slug: 'minha-skill', name: 'Minha Skill', description: '' }]);
    db.getSkillDetail.mockResolvedValue({ ...detail, ...privada });

    await surfacesVirtual.listPrompts();
    await surfacesVirtual.listResources();
    await surfacesVirtual.getPrompt('minha-skill');
    await surfacesVirtual.readResource('skill://minha-skill');

    expect(db.listPublishedSkills).toHaveBeenNthCalledWith(1, 'prompt', 'mcp-2');
    expect(db.listPublishedSkills).toHaveBeenNthCalledWith(2, 'resource', 'mcp-2');
    expect(db.getSkillDetail).toHaveBeenNthCalledWith(1, 'minha-skill', {
      virtualMcp: { uuid: 'mcp-2', surface: 'prompt' },
    });
    expect(db.getSkillDetail).toHaveBeenNthCalledWith(2, 'minha-skill', {
      virtualMcp: { uuid: 'mcp-2', surface: 'resource' },
    });
    expect(db.incrementViewCount).toHaveBeenCalledWith('uuid-1', 'mcp-2');
  });
});
