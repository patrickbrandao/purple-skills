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
  cloneSkill: vi.fn(),
  createSkill: vi.fn(),
  recordSkillAccess: vi.fn(),
  updateSkill: vi.fn(),
  getVirtualMcp: vi.fn(),
  getSkillSummary: vi.fn(),
  getUserByUsername: vi.fn(),
  setSkillGrant: vi.fn(),
  removeSkillGrant: vi.fn(),
  listSkillGrants: vi.fn(),
  setFile: vi.fn(),
  setFiles: vi.fn(),
  listFiles: vi.fn(),
  previewSetFilesDeletions: vi.fn(),
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
  actor: { userUuid, label: `${role}` },
  role,
  identity: `teste:${role}`,
});

/** Chamador padrão dos testes: o token global, com papel admin. */
const handlers = createHandlers(caller('admin'));
/** Ator gravado no audit quando quem chama é o token global. */
const ADMIN_ACTOR = { userUuid: null, label: 'admin' };

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
  ownerUsername: 'editor',
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
  ownerUsername: 'editor',
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
  db.getUserByUsername.mockImplementation(async (username: string) =>
    username === 'maria' ? { uuid: 'uuid-maria', username, isActive: true } : null,
  );
  // O que um `replace` removeria, que o `set_files_bulk` pergunta ao banco
  // antes de gravar. Por padrão nada: nada a remover, nada a confirmar.
  db.previewSetFilesDeletions.mockResolvedValue([]);
});

/** Uma linha da árvore que `setFiles` devolve depois de gravar. */
const arquivo = (relativePath: string) => ({
  relativePath,
  mimeType: 'text/markdown',
  sizeBytes: 3,
  isText: true,
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

/**
 * A cópia é de quem clonou, nasce fechada e flutuante e leva propriedades,
 * arquivos e tags — nada de vMCP, catálogo ou concessão. Papel `editor`/`admin`
 * (é uma skill nova) mais `edit` no original.
 */
describe('clone_skill', () => {
  /** O que o banco devolve: a skill nova, com o slug desempatado. */
  const copia = { ...detail, uuid: 'uuid-2', slug: 'minha-skill-2' };

  it('clona pelo uuid do original, com quem clonou como dono, e conta o que foi junto', async () => {
    db.cloneSkill.mockResolvedValue(copia);

    const result = await createHandlers(caller('editor')).clone_skill({ slug: 'minha-skill' });

    expect(db.cloneSkill).toHaveBeenCalledWith(
      'uuid-1',
      { name: undefined, slug: undefined, ownerUserUuid: 'uuid-editor' },
      'mcp-admin',
      caller('editor').actor,
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"Minha Skill" (slug: minha-skill-2)');
    expect(result.content[0].text).toContain('1 arquivo(s) e 1 tag(s)');
    expect(result.content[0].text).toContain('privada');
  });

  it('repassa o nome e o slug da cópia quando vêm; o token global clona para órfã', async () => {
    db.cloneSkill.mockResolvedValue({ ...copia, name: 'Outro nome', slug: 'outro-nome' });

    await handlers.clone_skill({ slug: 'minha-skill', name: 'Outro nome', new_slug: 'outro-nome' });

    expect(db.cloneSkill).toHaveBeenCalledWith(
      'uuid-1',
      { name: 'Outro nome', slug: 'outro-nome', ownerUserUuid: null },
      'mcp-admin',
      ADMIN_ACTOR,
    );
  });

  it('membro não clona: a cópia é uma skill nova, e criar é do papel', async () => {
    const negado = await createHandlers(caller('membro')).clone_skill({ slug: 'minha-skill' });

    expect(negado.isError).toBe(true);
    expect(negado.content[0].text).toContain('Clonar uma skill exige papel "editor" ou "admin"');
    expect(db.cloneSkill).not.toHaveBeenCalled();
  });

  it('skill que a credencial não vê é 404; quem só a lê não a clona', async () => {
    const outro = createHandlers(caller('editor', 'uuid-outro'));

    const invisivel = await guard(() => outro.clone_skill({ slug: 'minha-skill' }));
    expect(invisivel.isError).toBe(true);
    expect(invisivel.content[0].text).toMatch(/Skill não encontrada/);

    grants['uuid-outro'] = 'view';
    const soLe = await guard(() => outro.clone_skill({ slug: 'minha-skill' }));
    expect(soLe.isError).toBe(true);
    expect(soLe.content[0].text).toMatch(/exige "editar"/);

    expect(db.cloneSkill).not.toHaveBeenCalled();
  });

  // Sem `new_slug` o banco desempata sozinho (-2, -3…) e não há 409; com um
  // slug escolhido, quem recusa é o banco — e a mensagem chega inteira.
  it('repassa o 409 de slug em uso, com a mensagem do banco', async () => {
    db.cloneSkill.mockRejectedValue(new AppError('Já existe uma skill com o slug "ocupado"', 409, 'conflict'));

    const result = await guard(() =>
      createHandlers(caller('editor')).clone_skill({ slug: 'minha-skill', new_slug: 'ocupado' }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Já existe uma skill com o slug "ocupado"');
    expect(result.content[0].text).not.toContain('Erro interno');
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

  /**
   * Terceira ocorrência do padrão que o `set_file` já tinha corrigido: decidir
   * com o caminho cru. Aqui não havia dano — o banco normaliza e recusa —, mas a
   * recusa chegava sem dizer a saída (relatório 016 da auditoria de 2026-09-19).
   */
  it('normaliza o caminho antes de decidir: a recusa do SKILL.md é a da tool em qualquer grafia', async () => {
    for (const path of ['./SKILL.md', '.\\SKILL.md', '/skill.md', 'SKILL.md/']) {
      const result = await handlers.delete_file({ slug: 'minha-skill', path });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/use set_file para sobrescrevê-lo/);
    }
    expect(db.deleteFile).not.toHaveBeenCalled();
  });

  it('recusa o caminho que não normaliza, e manda ao banco o caminho já canônico', async () => {
    const torto = await handlers.delete_file({ slug: 'minha-skill', path: '../fora.md' });
    expect(torto.isError).toBe(true);
    expect(torto.content[0].text).toMatch(/Caminho inválido/);
    expect(db.deleteFile).not.toHaveBeenCalled();

    db.deleteFile.mockResolvedValue(undefined);
    const result = await handlers.delete_file({ slug: 'minha-skill', path: './ref//extra.md' });
    expect(db.deleteFile).toHaveBeenCalledWith('minha-skill', 'ref/extra.md', 'mcp-admin', ADMIN_ACTOR);
    expect(result.content[0].text).toBe('Arquivo removido de "minha-skill": ref/extra.md');
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

  /**
   * O caminho não canônico escapava do `stripFrontmatter`: `isSkillMd` compara
   * o texto exato, e `"./SKILL.md"` não bate — mas o banco canoniza na hora de
   * gravar, e o frontmatter forjado ia para a linha do SKILL.md (`tasks/050`).
   * O SKILL.md guarda só o corpo: o bloco não mudava metadado nenhum (eles moram
   * em colunas), mas ficava fora da vista e dentro da busca. Mudar metadados é
   * `edit_skill` — nome, descrição, ícone e tags com `edit`; slug, estado e
   * público com `manage` (`docs/12` §3.2).
   */
  it('normaliza o caminho antes de decidir: nenhuma grafia esconde o frontmatter', async () => {
    db.setFile.mockResolvedValue({
      relativePath: 'SKILL.md',
      mimeType: 'text/markdown',
      sizeBytes: 8,
      isText: true,
    });

    for (const path of ['./SKILL.md', 'skill.md', './skill.MD', '/SKILL.md']) {
      await handlers.set_file({
        slug: 'minha-skill',
        path,
        content: '---\nname: outra\n---\n# Corpo\n',
      });
    }

    for (const chamada of db.setFile.mock.calls) {
      expect(chamada[1]).toBe('SKILL.md');
      expect(chamada[2]).toBe('# Corpo\n');
    }
    expect(db.setFile).toHaveBeenCalledTimes(4);
  });

  it('recusa o caminho que não normaliza, sem chegar ao banco', async () => {
    for (const path of ['../fora.md', 'ref/../SKILL.md', '']) {
      const result = await handlers.set_file({ slug: 'minha-skill', path, content: 'x' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Caminho inválido/);
    }
    expect(db.setFile).not.toHaveBeenCalled();
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
    // `expectedDeletions` refaz a conta dentro da transação (`tasks/011`): zero
    // aqui, porque nada sairia — e zero é conferido como qualquer outro número.
    expect(options).toEqual({ replace: true, expectedDeletions: 0 });
    // A prévia é pedida ao banco com a skill e os caminhos do .zip, como vieram.
    expect(db.previewSetFilesDeletions).toHaveBeenCalledTimes(1);
    const [uuid, enviados] = db.previewSetFilesDeletions.mock.calls[0];
    expect(uuid).toBe('uuid-1');
    expect([...enviados].sort()).toEqual(['SKILL.md', 'ref/a.md']);
  });

  it('respeita replace=false para apenas adicionar/sobrescrever', async () => {
    db.setFiles.mockResolvedValue([]);

    await handlers.set_files_bulk({
      slug: 'minha-skill',
      zip_base64: makeZip({ 'SKILL.md': '# a' }),
      replace: false,
    });

    expect(db.setFiles.mock.calls[0][3]).toEqual({ replace: false, expectedDeletions: 0 });
    // Sem remoção não há o que confirmar — nem por que perguntar ao banco.
    expect(db.previewSetFilesDeletions).not.toHaveBeenCalled();
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

  // O envio parcial é o acidente típico do agente: sem confirmação, apagava o
  // resto da árvore sem deixar como reconstruí-la.
  it('recusa, com a lista e o número, o zip que removeria arquivos', async () => {
    db.previewSetFilesDeletions.mockResolvedValue(['ref/a.md', 'ref/b.md']);

    const result = await handlers.set_files_bulk({
      slug: 'minha-skill',
      zip_base64: makeZip({ 'SKILL.md': '# a' }),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('removeria 2 arquivo(s)');
    expect(result.content[0].text).toContain('- ref/a.md');
    expect(result.content[0].text).toContain('- ref/b.md');
    expect(result.content[0].text).toContain('confirm_deletions: 2');
    expect(result.content[0].text).toContain('replace: false');
    expect(db.setFiles).not.toHaveBeenCalled();
  });

  it('remove quando confirm_deletions traz o número exato', async () => {
    db.previewSetFilesDeletions.mockResolvedValue(['ref/a.md', 'ref/b.md']);
    db.setFiles.mockResolvedValue([arquivo('SKILL.md')]);

    const result = await handlers.set_files_bulk({
      slug: 'minha-skill',
      zip_base64: makeZip({ 'SKILL.md': '# a' }),
      confirm_deletions: 2,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('2 arquivo(s) removido(s)');
    // O número confirmado vai ao banco: é lá, com a árvore travada, que ele vale.
    expect(db.setFiles.mock.calls[0][3]).toEqual({ replace: true, expectedDeletions: 2 });
  });

  // Número errado é o caso do agente que confirmou sem olhar, e o da árvore que
  // mudou entre a recusa e a segunda chamada: nos dois, não se apaga.
  it('recusa de novo quando confirm_deletions não bate com o que sairia', async () => {
    db.previewSetFilesDeletions.mockResolvedValue(['ref/a.md', 'ref/b.md']);

    const result = await handlers.set_files_bulk({
      slug: 'minha-skill',
      zip_base64: makeZip({ 'SKILL.md': '# a' }),
      confirm_deletions: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('confirm_deletions: 1 não corresponde');
    expect(result.content[0].text).toContain('removeria 2 arquivo(s)');
    expect(db.setFiles).not.toHaveBeenCalled();
  });

  /**
   * Quem diz o que sairia é o banco (`previewSetFilesDeletions`), com o mesmo
   * predicado do `DELETE` de `setFiles` — a `lower()` do Postgres dos dois
   * lados, e o SKILL.md fora da conta. A tool refazia a conta com o
   * `toLowerCase()` do JS, que dobra `İ` em dois code points onde o banco (libc)
   * dobra em um: um .zip com `I.md` sobre um `İ.md` gravado anunciava uma
   * remoção que não acontece, e o `expectedDeletions: 1` que ela induzia era 409
   * para sempre (relatório 017 da auditoria de 2026-09-19). A regra da caixa
   * está fixada onde ela mora, em `database/src/files.integration.test.ts`.
   */
  it('pergunta ao banco o que sairia, com os caminhos como vieram — sem refazer a conta no JS', async () => {
    // A árvore que a conta antiga leria: com ela, `İ.md` e `Ref/A.md` "sairiam".
    db.listFiles.mockResolvedValue([arquivo('SKILL.md'), arquivo('İ.md'), arquivo('Ref/A.md')]);
    db.setFiles.mockResolvedValue([arquivo('SKILL.md'), arquivo('I.md'), arquivo('ref/a.md')]);

    const result = await handlers.set_files_bulk({
      slug: 'minha-skill',
      zip_base64: makeZip({ 'I.md': 'x', 'ref/a.md': '# b' }),
    });

    expect(result.isError).toBeUndefined();
    const [uuid, enviados] = db.previewSetFilesDeletions.mock.calls[0];
    expect(uuid).toBe('uuid-1');
    // Sem `toLowerCase()` e sem o SKILL.md acrescentado: as duas coisas são do banco.
    expect([...enviados].sort()).toEqual(['I.md', 'ref/a.md']);
    expect(db.listFiles).not.toHaveBeenCalled();
    expect(db.setFiles.mock.calls[0][3]).toEqual({ replace: true, expectedDeletions: 0 });
  });

  /**
   * O "cenário C" do relatório 075 da auditoria de 2026-09-19. Skill cujos
   * arquivos vivem em `scripts/`; o agente manda só os dois, sem o SKILL.md
   * (que é sempre preservado). Com a raiz única achatada, chegavam `a.py` e
   * `b.py`, e a recusa por remoção listava justamente os arquivos recém-enviados;
   * confirmada, achatava a árvore de verdade.
   */
  it('envio parcial de uma subpasta: os caminhos ficam, e a recusa não acusa o que acabou de chegar', async () => {
    // O que o banco responderia para a árvore gravada: fora da lista, menos o SKILL.md.
    const gravados = ['SKILL.md', 'scripts/a.py', 'scripts/b.py'];
    db.previewSetFilesDeletions.mockImplementation(async (_uuid: string, enviados: readonly string[]) => {
      const ficam = new Set(enviados.map((path) => path.toLowerCase()));
      return gravados.filter((path) => path !== 'SKILL.md' && !ficam.has(path.toLowerCase()));
    });
    db.setFiles.mockResolvedValue(gravados.map(arquivo));

    const result = await handlers.set_files_bulk({
      slug: 'minha-skill',
      zip_base64: makeZip({ 'scripts/a.py': 'print(1)', 'scripts/b.py': 'print(2)' }),
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toContain('removeria');
    const files = db.setFiles.mock.calls[0][1] as { relativePath: string }[];
    expect(files.map((file) => file.relativePath).sort()).toEqual(['scripts/a.py', 'scripts/b.py']);
    expect(db.setFiles.mock.calls[0][3]).toEqual({ replace: true, expectedDeletions: 0 });
  });

  it('o pacote baixado (<slug>/SKILL.md) continua entrando sem o embrulho', async () => {
    db.setFiles.mockResolvedValue([]);

    await handlers.set_files_bulk({
      slug: 'minha-skill',
      zip_base64: makeZip({ 'minha-skill/SKILL.md': '# a', 'minha-skill/scripts/a.py': 'print(1)' }),
    });

    const files = db.setFiles.mock.calls[0][1] as { relativePath: string }[];
    expect(files.map((file) => file.relativePath).sort()).toEqual(['SKILL.md', 'scripts/a.py']);
  });

  /**
   * Relatório 015 da auditoria de 2026-09-19: `toString('utf8')` troca byte
   * inválido por U+FFFD sem erro. O anexo que não é UTF-8 segue como binário,
   * byte a byte; o SKILL.md não tem essa saída — é o `extractZip` que recusa
   * (`ZipContentError`), senão o corpo gravado por cima do prompt seria vazio.
   */
  describe('conteúdo fora de UTF-8', () => {
    /** `preço;ação\n` como o Excel exporta: Windows-1252, 11 bytes. */
    const CSV_1252 = Buffer.from([0x70, 0x72, 0x65, 0xe7, 0x6f, 0x3b, 0x61, 0xe7, 0xe3, 0x6f, 0x0a]);

    function zipDeBytes(entries: Record<string, Buffer>): string {
      const zip = new AdmZip();
      for (const [name, content] of Object.entries(entries)) zip.addFile(name, content);
      return zip.toBuffer().toString('base64');
    }

    it('SKILL.md em Windows-1252 é recusado com a causa, e nada é gravado', async () => {
      const result = await handlers.set_files_bulk({
        slug: 'minha-skill',
        zip_base64: zipDeBytes({
          'SKILL.md': Buffer.from([0x23, 0x20, 0x49, 0x6e, 0x73, 0x74, 0x72, 0x75, 0xe7, 0xf5, 0x65, 0x73, 0x0a]),
          'ref/a.md': Buffer.from('# a', 'utf8'),
        }),
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/UTF-8 válido/);
      expect(db.previewSetFilesDeletions).not.toHaveBeenCalled();
      expect(db.setFiles).not.toHaveBeenCalled();
    });

    it('anexo em Windows-1252 chega ao banco byte a byte igual ao do .zip', async () => {
      db.setFiles.mockResolvedValue([]);

      await handlers.set_files_bulk({
        slug: 'minha-skill',
        zip_base64: zipDeBytes({ 'SKILL.md': Buffer.from('# a', 'utf8'), 'dados.csv': CSV_1252 }),
      });

      const files = db.setFiles.mock.calls[0][1] as { relativePath: string; content: Buffer }[];
      expect(files.find((file) => file.relativePath === 'dados.csv')?.content.equals(CSV_1252)).toBe(true);
    });
  });

  // A prévia e a escrita são idas ao banco distintas: entre elas a árvore pode
  // mudar, e aí quem recusa é a transação. A mensagem dela chega inteira
  // (`tasks/031`), e as tools acrescentam o que fazer em seguida.
  it('explica o que fazer quando a transação recusa o número confirmado', async () => {
    db.previewSetFilesDeletions.mockResolvedValue(['ref/a.md']);
    db.setFiles.mockRejectedValue(
      new AppError(
        'A árvore de arquivos mudou: a chamada confirmou 1 remoção(ões) e 2 arquivo(s) sairiam agora — releia a árvore e tente de novo',
        409,
        'conflict',
      ),
    );

    const result = await guard(() =>
      handlers.set_files_bulk({
        slug: 'minha-skill',
        zip_base64: makeZip({ 'SKILL.md': '# a' }),
        confirm_deletions: 1,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('A árvore de arquivos mudou');
    expect(result.content[0].text).toContain('get_skill');
    expect(result.content[0].text).toContain('replace: false');
    // Erro de negócio não vira referência de log: a mensagem é para o agente.
    expect(result.content[0].text).not.toContain('Erro interno');
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
    const dado = { userUuid: 'uuid-maria', username: 'maria', name: 'Maria', role: 'membro', isActive: true, level: 'view', grantedByUserUuid: null, grantedByUsername: null, createdAt: '2026-01-01T00:00:00.000Z' };
    db.getSkillDetail.mockImplementation(async (_slug: string, options?: { viewer?: Viewer }) =>
      seen({ ...detail, grants: [dado] }, options?.viewer),
    );

    const doDono = JSON.parse((await handlers.get_skill({ slug: 'minha-skill' })).content[0].text);
    expect(doDono).toMatchObject({ owner: 'editor', isPublic: false, access: 'owner' });
    // `isActive` é a conta: desativada, a concessão fica na lista, inerte, até ser revogada.
    expect(doDono.grants).toEqual([{ username: 'maria', name: 'Maria', level: 'view', isActive: true }]);

    grants['uuid-maria'] = 'view';
    const daMaria = JSON.parse(
      (await createHandlers(caller('membro', 'uuid-maria')).get_skill({ slug: 'minha-skill' })).content[0].text,
    );
    expect(daMaria.access).toBe('view');
    expect(daMaria.grants).toBeUndefined();
  });

  /**
   * A página no site: a skill marcada pública está lá sem vMCP aberto nenhum
   * (`docs/12` §7, que revoga a regra do `09` §4.1 — a antiga olhava só o
   * vínculo aberto). Desligada não está, pública ou não.
   */
  it('dá a URL da página à skill pública sem vMCP aberto, e nenhuma à desligada', async () => {
    db.getSkillDetail.mockResolvedValue({ ...detail, isPublic: true });
    const publica = JSON.parse((await handlers.get_skill({ slug: 'minha-skill' })).content[0].text);
    expect(publica.url).toBe('http://localhost:3000/skills/minha-skill');

    db.getSkillDetail.mockResolvedValue({ ...detail, isPublic: true, isActive: false });
    const desligada = JSON.parse((await handlers.get_skill({ slug: 'minha-skill' })).content[0].text);
    expect(desligada.url).toBeUndefined();
  });
});

/**
 * O teto do texto inline (`MCP_MAX_FILE_TEXT_BYTES`, 4 MiB) só existia no
 * `get_skill_file` do mcp-public: aqui `get_file` e `get_skill` devolviam texto
 * de qualquer tamanho, e cada leitura o materializava de novo como string e como
 * JSON-RPC (relatório 032 da auditoria de 2026-09-19). Este servidor não tem
 * rota de download, então a saída é recusar dizendo o tamanho.
 */
describe('o teto do texto inline', () => {
  const TETO = 4 * 1024 * 1024;

  it('get_file recusa o texto acima do teto com tamanho e tipo, sem devolver o conteúdo', async () => {
    const grande = 'a'.repeat(TETO + 1);
    db.readFile.mockResolvedValue({
      relativePath: 'ref/gigante.md',
      mimeType: 'text/markdown',
      // Declarado pequeno de propósito: a régua são os bytes lidos.
      sizeBytes: 10,
      isText: true,
      buffer: Buffer.from(grande, 'utf8'),
    });

    const result = await handlers.get_file({ slug: 'minha-skill', path: 'ref/gigante.md' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`${TETO + 1} bytes (text/markdown)`);
    expect(result.content[0].text).toContain(`teto de ${TETO}`);
    expect(result.content[0].text).not.toContain('aaaa');
  });

  it('get_file no teto exato ainda devolve o arquivo', async () => {
    const noTeto = 'a'.repeat(TETO);
    db.readFile.mockResolvedValue({
      relativePath: 'ref/limite.md',
      mimeType: 'text/markdown',
      sizeBytes: TETO,
      isText: true,
      buffer: Buffer.from(noTeto, 'utf8'),
    });

    const result = await handlers.get_file({ slug: 'minha-skill', path: 'ref/limite.md' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe(noTeto);
  });

  it('get_skill omite o corpo acima do teto e diz o tamanho; o resto da ficha segue inteiro', async () => {
    // Metade dos caracteres do teto, e passa dele: a régua é byte, e `ã` são dois.
    const grande = 'ã'.repeat(TETO / 2 + 1);
    db.getSkillDetail.mockResolvedValue({ ...detail, skillMd: grande });

    const bruto = (await handlers.get_skill({ slug: 'minha-skill' })).content[0].text;
    const payload = JSON.parse(bruto);

    expect(payload).not.toHaveProperty('skillMd');
    expect(payload.skillMdBytes).toBe(TETO + 2);
    expect(payload.skillMdOmitido).toContain(`teto de ${TETO}`);
    expect(payload.slug).toBe('minha-skill');
    expect(payload.files).toHaveLength(detail.files.length);
    expect(bruto.length).toBeLessThan(10_000);
  });

  it('get_skill abaixo do teto não ganha campo novo nenhum', async () => {
    db.getSkillDetail.mockResolvedValue(detail);

    const payload = JSON.parse((await handlers.get_skill({ slug: 'minha-skill' })).content[0].text);

    expect(payload).toHaveProperty('skillMd');
    expect(payload).not.toHaveProperty('skillMdBytes');
    expect(payload).not.toHaveProperty('skillMdOmitido');
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
    expect(payload.skills[0]).toMatchObject({ isActive: true, owner: 'editor', access: 'owner' });
    expect(payload.skills[0]).not.toHaveProperty('visibility');
  });
});

/**
 * Os números da instalação inteira contam skills, arquivos e contas que a
 * credencial não enxerga (`docs/12` §3.1): admin recebe tudo, os demais só o
 * que dá para recortar fora do banco.
 */
describe('get_stats', () => {
  const instalacao = {
    totalSkills: 200,
    openSkills: 7,
    unlinkedSkills: 5,
    totalFiles: 900,
    totalViews: 30,
    totalDownloads: 12,
    totalTags: 40,
    totalUsers: 11,
    activeUsers: 9,
  };

  beforeEach(() => {
    db.stats.mockResolvedValue(instalacao);
    db.listSkills.mockResolvedValue({ items: [], total: 2, limit: 1, offset: 0 });
    db.listTags.mockResolvedValue([{ name: 'git', count: 1 }]);
  });

  it('admin recebe a instalação inteira, sem recorte', async () => {
    const payload = JSON.parse((await handlers.get_stats()).content[0].text);

    expect(payload).toEqual(instalacao);
    expect(db.listSkills).not.toHaveBeenCalled();
  });

  it('membro recebe o que enxerga: nada de contas, arquivos nem acervo alheio', async () => {
    const payload = JSON.parse((await createHandlers(caller('membro')).get_stats()).content[0].text);

    const viewer = { role: 'membro', userUuid: 'uuid-membro' };
    expect(db.listSkills).toHaveBeenCalledWith(expect.objectContaining({ viewer }));
    expect(db.listTags).toHaveBeenCalledWith({ viewer });
    // `openSkills` é o que o site mostra a um anônimo — não revela nada.
    expect(payload).toEqual({ totalSkills: 2, openSkills: 7, totalTags: 1 });
  });
});

describe('acesso: share / unshare / transfer', () => {
  const dono = createHandlers(caller('editor'));

  /** As concessões da skill: uma de conta ativa e uma de conta desativada depois de recebê-la. */
  const CONCESSOES = [
    { userUuid: 'uuid-maria', username: 'maria', name: 'Maria', role: 'membro', isActive: true, level: 'manage' },
    { userUuid: 'uuid-saiu', username: 'saiu', name: 'Saiu', role: 'membro', isActive: false, level: 'view' },
  ];

  it('manage concede e revoga pelo e-mail', async () => {
    db.setSkillGrant.mockResolvedValue({ userUuid: 'uuid-maria', username: 'maria', level: 'manage' });
    db.removeSkillGrant.mockResolvedValue(undefined);
    db.listSkillGrants.mockResolvedValue(CONCESSOES);

    const dado = await dono.share_skill({ slug: 'minha-skill', username: 'maria', level: 'manage' });
    expect(dado.content[0].text).toMatch(/maria agora pode administrar/);
    expect(db.setSkillGrant).toHaveBeenCalledWith('minha-skill', 'uuid-maria', 'manage', 'mcp-admin', caller('editor').actor);

    await dono.unshare_skill({ slug: 'minha-skill', username: 'maria' });
    expect(db.removeSkillGrant).toHaveBeenCalledWith('minha-skill', 'uuid-maria', 'mcp-admin', caller('editor').actor);

    grants['uuid-outro'] = 'edit';
    const negado = await guard(() =>
      createHandlers(caller('membro', 'uuid-outro')).share_skill({ slug: 'minha-skill', username: 'maria', level: 'view' }),
    );
    expect(negado.isError).toBe(true);
    expect(negado.content[0].text).toMatch(/exige "administrar"/);
  });

  it('transferir é do dono; conta inativa é recusada', async () => {
    db.updateSkill.mockResolvedValue(detail);

    await dono.transfer_skill({ slug: 'minha-skill', username: 'maria' });
    expect(db.updateSkill).toHaveBeenCalledWith('minha-skill', { ownerUserUuid: 'uuid-maria' }, 'mcp-admin', caller('editor').actor);

    db.getUserByUsername.mockResolvedValueOnce({ uuid: 'uuid-ninguem', username: 'ninguem', isActive: false });
    const inativa = await guard(() => dono.transfer_skill({ slug: 'minha-skill', username: 'ninguem' }));
    expect(inativa.isError).toBe(true);
    expect(inativa.content[0].text).toMatch(/desativada/);
  });

  /**
   * `manage` revoga **qualquer** concessão (`docs/12` decisão 10), inclusive a
   * de conta desativada depois de recebê-la: a linha fica, inerte, e voltaria a
   * valer se a conta fosse reativada. Revogar passava pelo funil que exige conta
   * ativa, e a linha não saía por tool nenhuma (relatório 039 da auditoria de
   * 2026-09-19). Conceder e transferir continuam exigindo conta ativa.
   */
  it('revoga a concessão de conta desativada; conceder a ela continua recusado', async () => {
    db.listSkillGrants.mockResolvedValue(CONCESSOES);
    db.getUserByUsername.mockResolvedValue({ uuid: 'uuid-saiu', username: 'saiu', isActive: false });

    const tirado = await dono.unshare_skill({ slug: 'minha-skill', username: 'Saiu' });
    expect(tirado.isError).toBeUndefined();
    expect(tirado.content[0].text).toMatch(/saiu perdeu o acesso/);
    expect(db.removeSkillGrant).toHaveBeenCalledWith('minha-skill', 'uuid-saiu', 'mcp-admin', caller('editor').actor);

    const concedido = await guard(() => dono.share_skill({ slug: 'minha-skill', username: 'saiu', level: 'view' }));
    expect(concedido.isError).toBe(true);
    expect(concedido.content[0].text).toMatch(/desativada/);
    expect(db.setSkillGrant).not.toHaveBeenCalled();
  });

  // Revogar não consulta `users`: a resposta não diz se existe conta com aquele
  // e-mail — nem desativada, que a busca de contas não revela (decisão 13).
  it('e-mail sem concessão na skill é recusado sem consultar a conta', async () => {
    db.listSkillGrants.mockResolvedValue(CONCESSOES);

    const nada = await guard(() => dono.unshare_skill({ slug: 'minha-skill', username: 'ninguem' }));

    expect(nada.isError).toBe(true);
    expect(nada.content[0].text).toBe('A conta não tem concessão nesta skill');
    expect(db.getUserByUsername).not.toHaveBeenCalled();
    expect(db.removeSkillGrant).not.toHaveBeenCalled();
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

  it('não derruba a ferramenta nem vaza o detalhe interno do erro inesperado', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await guard(async () => {
      throw new Error('duplicate key value violates unique constraint "files_skill_path_lower_uniq"');
    });

    expect(result.isError).toBe(true);
    // Mensagem de driver descreve o esquema: ela sai no log, não na resposta.
    expect(result.content[0].text).not.toContain('files_skill_path_lower_uniq');
    const ref = /ref ([0-9a-f]{8})/.exec(result.content[0].text)?.[1];
    expect(ref).toBeDefined();
    // A mesma referência nos dois lados é o que liga a reclamação ao detalhe.
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`ref ${ref}`), expect.any(Error));

    log.mockRestore();
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
      label: 'editor',
    });
  });
});
