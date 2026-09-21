import { beforeEach, describe, expect, it, vi } from 'vitest';
import { composeSkillMd } from '@purple-skills/shared';

/** O erro de negócio do `@purple-skills/db`, como o `guard` o reconhece. */
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
  // A busca semântica lê estas três; sem elas o módulo `rag.ts` nem carrega.
  ragSchemaReady: vi.fn(async () => false),
  getRagSettings: vi.fn(async () => ({})),
  findRagSpace: vi.fn(async () => null),
  listSkills: vi.fn(),
  listPublishedSkills: vi.fn(),
  getSkillDetail: vi.fn(),
  getSkillSummary: vi.fn(),
  recordSkillAccess: vi.fn(),
  listTags: vi.fn(),
  readFile: vi.fn(),
  listFiles: vi.fn(),
  listSkillsManifest: vi.fn(),
  readSkillMdBodies: vi.fn(),
}));

// O teto da consulta é valor, não função, e o `tools.ts` o importa do pacote
// (relatório 037 da auditoria de 2026-09-19): sem ele no mock não há o que
// importar. O 200 aqui é o da fixture — os casos de corte abaixo contam com ele.
vi.mock('@purple-skills/db', () => ({ ...db, AppError, SEARCH_QUERY_MAX_LENGTH: 200 }));

const { createHandlers, createSurfaces, guard, guardSurface } = await import('./tools.js');

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

/** O que as leituras recortadas recebem, para o mock saber por qual porta perguntaram. */
type RecorteDeLeitura = { virtualMcp: { uuid: string; surface: string } };

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

  /**
   * O critério de aceite do PR 4 (`docs/14-rag.md` §12): com a busca
   * semântica indisponível, os resultados são **idênticos aos de hoje**.
   *
   * Aqui `ragSchemaReady` devolve `false` (é o mock do topo), que é o caso de
   * quem ainda não rodou a migration `020` — o mais comum numa instalação que
   * acabou de atualizar.
   */
  it('sem a busca semântica, a consulta sai igual à de antes do RAG', async () => {
    db.listSkills.mockResolvedValue({ items: [summary], total: 1, limit: 10, offset: 0, mode: 'text' });

    const result = await handlers.search_skills({ query: 'git' });
    const payload = JSON.parse(result.content[0].text);

    // Nenhuma opção `semantic` foi para a consulta...
    expect(db.listSkills.mock.calls[0][0]).not.toHaveProperty('semantic');
    // ...e o espaço nem chegou a ser procurado, porque o schema não está pronto.
    expect(db.findRagSpace).not.toHaveBeenCalled();

    expect(payload.mode).toBe('text');
    expect(payload.results[0].slug).toBe('minha-skill');
  });

  it('o modo vai na resposta, para o cliente saber o que leu', async () => {
    db.listSkills.mockResolvedValue({ items: [summary], total: 1, limit: 10, offset: 0, mode: 'text' });

    const payload = JSON.parse((await handlers.search_skills({ query: 'git' })).content[0].text);
    expect(payload).toMatchObject({ mode: 'text', total: 1, limit: 10, offset: 0 });
  });

  it('a distância não vaza para o cliente', async () => {
    db.listSkills.mockResolvedValue({
      items: [summary],
      total: 1,
      limit: 10,
      offset: 0,
      mode: 'hybrid',
      neighbors: [{ slug: 'minha-skill', distance: 0.12 }],
    });

    const bruto = (await handlers.search_skills({ query: 'git' })).content[0].text;
    expect(bruto).not.toContain('distance');
    expect(bruto).not.toContain('neighbors');
    expect(JSON.parse(bruto).mode).toBe('hybrid');
  });

  it('consulta vazia não procura espaço nenhum', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0, mode: 'text' });

    await handlers.search_skills({});
    expect(db.getRagSettings).not.toHaveBeenCalled();
  });

  /**
   * O corte da consulta, antes das duas pernas: `listSkills` sempre cortou em
   * 200 caracteres, mas o embedding era resolvido com o texto cru — a perna
   * vetorial embutia uma pergunta que a textual nunca leu, e quem escolhia o
   * tamanho do que ia ao provedor era o cliente.
   */
  it('corta a consulta longa na última palavra inteira, e as duas pernas leem o mesmo texto', async () => {
    db.listSkills.mockResolvedValue({ items: [summary], total: 1, limit: 10, offset: 0, mode: 'text' });
    const { buscaSemantica } = await import('./rag.js');
    const espiao = vi.spyOn(buscaSemantica, 'resolver');

    const longa = 'padronizar a mensagem de commit em português '.repeat(10);
    await handlers.search_skills({ query: longa });

    const cortada = db.listSkills.mock.calls[0][0].query as string;
    expect(cortada.length).toBeLessThanOrEqual(200);
    expect(cortada.length).toBeGreaterThan(180);
    // Prefixo da consulta, sem palavra partida e sem espaço sobrando no fim.
    expect(longa.startsWith(cortada)).toBe(true);
    expect(cortada).toMatch(/\S$/);
    expect(longa.slice(cortada.length, cortada.length + 1)).toMatch(/\s/);
    // E é esse texto — não o cru — que iria ao provedor.
    expect(espiao).toHaveBeenCalledWith(cortada);

    espiao.mockRestore();
  });

  it('consulta de uma palavra só é cortada no limite, sem partir par surrogate', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 10, offset: 0, mode: 'text' });

    // 199 caracteres, um emoji (dois) e o resto: nenhum espaço onde cortar.
    const result = await handlers.search_skills({ query: `${'x'.repeat(199)}\u{1F44D}${'x'.repeat(400)}` });

    expect(db.listSkills.mock.calls[0][0].query).toBe('x'.repeat(199));
    // A mensagem ecoa o que foi procurado: é assim que o cliente vê o corte.
    expect(result.content[0].text).toContain('x'.repeat(199));
  });
});

describe('get_skill', () => {
  it('retorna o SKILL.md e incrementa o contador no vínculo e na skill', async () => {
    db.getSkillDetail.mockResolvedValue(detail);

    const result = await handlers.get_skill({ slug: 'minha-skill' });

    expect(db.getSkillDetail).toHaveBeenCalledWith('minha-skill', recorte);
    expect(db.recordSkillAccess).toHaveBeenCalledWith(expect.objectContaining({ skillUuid: 'uuid-1', virtualMcpUuid: 'mcp-1', origin: 'mcp' }));
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
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
  });
});

/**
 * O teto do texto inline (`MCP_MAX_FILE_TEXT_BYTES`, 4 MiB) nasceu só em
 * `get_skill_file`: o mesmo SKILL.md que ela recusava pelo caminho saía inteiro
 * por `get_skill`, `prompts/get` e `resources/read` — três portas sem catraca na
 * superfície anônima (relatório 032 da auditoria de 2026-09-19).
 */
describe('o teto do texto inline vale nas quatro leituras', () => {
  const TETO = 4 * 1024 * 1024;
  const GRANDE = `# Minha Skill\n\n${'a'.repeat(TETO)}`;
  const registroAssentou = () => new Promise((resolve) => setImmediate(resolve));

  it('get_skill: acima do teto vão os metadados e o link do SKILL.md, sem o corpo e sem contar acesso', async () => {
    db.getSkillDetail.mockResolvedValue({ ...detail, skillMd: GRANDE });

    const result = await handlers.get_skill({ slug: 'minha-skill' });
    await registroAssentou();
    const texto = result.content[0].text;

    expect(result.isError).toBeUndefined();
    expect(texto).toContain('https://mcp.exemplo.dev/skills/minha-skill/files/SKILL.md');
    expect(texto).toContain(`${Buffer.byteLength(GRANDE)} bytes; o teto é ${TETO}`);
    // O cabeçalho continua vindo: é por ele que o agente sabe o que a skill é.
    expect(texto).toContain('slug: minha-skill');
    expect(texto).toContain('ref/extra.md');
    // O corpo não: seriam mais duas cópias de 4 MiB no processo.
    expect(texto).not.toContain('aaaa');
    // Quem seguir o link conta a leitura na rota do arquivo; contar aqui daria duas.
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
  });

  it('no teto exato o SKILL.md ainda vem inteiro; a régua é byte, não caractere', async () => {
    const noTeto = 'a'.repeat(TETO);
    db.getSkillDetail.mockResolvedValue({ ...detail, skillMd: noTeto });
    expect((await handlers.get_skill({ slug: 'minha-skill' })).content[0].text.endsWith(noTeto)).toBe(true);

    // Metade dos caracteres, e passa do teto: cada `ã` são dois bytes em UTF-8.
    db.getSkillDetail.mockResolvedValue({ ...detail, skillMd: 'ã'.repeat(TETO / 2 + 1) });
    expect((await handlers.get_skill({ slug: 'minha-skill' })).content[0].text).toContain('grande demais');
  });

  it('prompts/get e resources/read recusam com erro de protocolo — e o link, se a skill está nas ferramentas', async () => {
    db.getSkillDetail.mockResolvedValue({ ...detail, skillMd: GRANDE });
    db.getSkillSummary.mockResolvedValue(summary);

    const recusa = {
      code: -32602,
      message: expect.stringContaining('Baixe pela URL: https://mcp.exemplo.dev/skills/minha-skill/files/SKILL.md'),
    };
    await expect(surfaces.getPrompt('minha-skill')).rejects.toMatchObject(recusa);
    await expect(surfaces.readResource('skill://minha-skill/SKILL.md')).rejects.toMatchObject(recusa);
    await registroAssentou();

    // O link só vale para o vínculo `as_skill`: é por ele que a recusa pergunta.
    expect(db.getSkillSummary).toHaveBeenCalledWith('minha-skill', recorte);
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
    // E o `guardSurface` deixa a recusa passar inteira, como o "não encontrado".
    await expect(guardSurface(() => surfaces.getPrompt('minha-skill'))).rejects.toMatchObject(recusa);
  });

  it('skill só de prompt ou resource: a recusa não manda para uma URL que responderia 404', async () => {
    // Fora das ferramentas: a porta de skill não a enxerga, nem para o link.
    db.getSkillDetail.mockImplementation(async (_slug: string, options: RecorteDeLeitura) =>
      options.virtualMcp.surface === 'skill' ? null : { ...detail, skillMd: GRANDE },
    );
    db.getSkillSummary.mockResolvedValue(null);

    const erro = await surfaces.readResource('skill://minha-skill/SKILL.md').catch((err: Error) => err);

    expect((erro as Error).message).toContain('grande demais para vir na resposta');
    expect((erro as Error).message).toContain('não há URL de download aqui');
    expect((erro as Error).message).not.toContain('/files/');
  });

  it('abaixo do teto as três seguem como antes', async () => {
    db.getSkillDetail.mockResolvedValue(detail);

    expect((await handlers.get_skill({ slug: 'minha-skill' })).content[0].text).toContain('Conteúdo.');
    expect((await surfaces.getPrompt('minha-skill')).messages[0].content.text).toContain('Conteúdo.');
    expect((await surfaces.readResource('skill://minha-skill/SKILL.md')).contents[0].text).toBe(
      composeSkillMd(detail, detail.skillMd),
    );
    // Nenhuma consulta a mais fora da recusa.
    expect(db.getSkillSummary).not.toHaveBeenCalled();
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
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
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

  it('manda baixar pela URL o texto que passa do teto do resultado', async () => {
    db.getSkillSummary.mockResolvedValue(summary);
    const grande = 'a'.repeat(4 * 1024 * 1024 + 1);
    db.readFile.mockResolvedValue({
      relativePath: 'ref/gigante.md',
      mimeType: 'text/markdown',
      sizeBytes: grande.length,
      isText: true,
      buffer: Buffer.from(grande, 'utf8'),
    });

    const result = await handlers.get_skill_file({ slug: 'minha-skill', path: 'ref/gigante.md' });

    expect(result.content[0].text).toContain(
      'https://mcp.exemplo.dev/skills/minha-skill/files/ref/gigante.md',
    );
    // O conteúdo não vai junto: seriam mais duas cópias no processo.
    expect(result.content[0].text).not.toContain('aaaa');
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
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
  });

  // O caso que a feature existe para permitir: vinculada só como prompt e como
  // resource. O prompt pede a flag dele; o SKILL.md tenta as duas portas que o
  // leem (§4.2 do `docs/17`), a de skill primeiro.
  it('continua legível como prompt e como resource, pela flag do vínculo', async () => {
    db.getSkillDetail.mockImplementation(async (_slug: string, options: RecorteDeLeitura) =>
      options.virtualMcp.surface === 'skill' ? null : detail,
    );

    const prompt = await surfaces.getPrompt('minha-skill');
    const resource = await surfaces.readResource('skill://minha-skill/SKILL.md');

    expect(prompt.messages[0].content.text).toContain('Conteúdo.');
    expect(resource.contents[0].text).toBe(composeSkillMd(detail, detail.skillMd));
    expect(db.getSkillDetail).toHaveBeenNthCalledWith(1, 'minha-skill', {
      virtualMcp: { uuid: 'mcp-1', surface: 'prompt' },
    });
    expect(db.getSkillDetail).toHaveBeenNthCalledWith(2, 'minha-skill', {
      virtualMcp: { uuid: 'mcp-1', surface: 'skill' },
    });
    expect(db.getSkillDetail).toHaveBeenNthCalledWith(3, 'minha-skill', {
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
        uri: 'skill://minha-skill/SKILL.md',
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

    const result = await surfaces.readResource('skill://minha-skill/SKILL.md');

    expect(db.recordSkillAccess).toHaveBeenCalledWith(expect.objectContaining({ skillUuid: 'uuid-1', virtualMcpUuid: 'mcp-1', origin: 'mcp' }));
    expect(result.contents[0].uri).toBe('skill://minha-skill/SKILL.md');
    expect(result.contents[0].mimeType).toBe('text/markdown');
    // Byte a byte o mesmo do .zip e do /files/SKILL.md.
    expect(result.contents[0].text).toBe(composeSkillMd(detail, detail.skillMd));
  });

  it('recusa skill fora do vínculo ou sem a flag com um erro só', async () => {
    db.getSkillDetail.mockResolvedValue(null);

    await expect(surfaces.readResource('skill://minha-skill/SKILL.md')).rejects.toThrow(
      /não encontrado/,
    );
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
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

    expect(db.recordSkillAccess).toHaveBeenCalledWith(expect.objectContaining({ skillUuid: 'uuid-1', virtualMcpUuid: 'mcp-1', origin: 'mcp' }));
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content.text).toBe('# Minha Skill\n');
    expect(result.messages[0].content.text).not.toContain('---');
  });

  it('recusa skill fora do vínculo ou sem a flag com um erro só', async () => {
    db.getSkillDetail.mockResolvedValue(null);

    await expect(surfaces.getPrompt('minha-skill')).rejects.toThrow(/não encontrado/);
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
  });
});

describe('resources/templates/list', () => {
  // Responder vazio é diferente de não responder: um cliente que sonda o método
  // na inicialização não leva "method not found".
  it('responde com lista vazia', () => {
    expect(surfaces.listResourceTemplates().resourceTemplates).toEqual([]);
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

    expect(db.recordSkillAccess).toHaveBeenCalledWith(expect.objectContaining({ skillUuid: 'uuid-1', virtualMcpUuid: 'mcp-2', origin: 'mcp' }));
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

  /**
   * A skill marcada pública está no site sem vMCP aberto nenhum (`docs/12` §7,
   * que revoga a regra do `09` §4.1 — a antiga olhava só o vínculo aberto).
   * Sem isto, o agente deixava de receber o link de uma página que abre.
   */
  it('dá a página do site à skill pública, mesmo só num vMCP fechado', async () => {
    db.listSkills.mockResolvedValue({
      items: [{ ...privada, isPublic: true }],
      total: 1,
      limit: 10,
      offset: 0,
    });
    db.getSkillDetail.mockResolvedValue({ ...detail, ...privada, isPublic: true });

    const payload = JSON.parse((await virtual.search_skills({})).content[0].text);
    const ficha = await virtual.get_skill({ slug: 'minha-skill' });

    expect(payload.results[0].url).toBe('http://localhost:3000/skills/minha-skill');
    expect(ficha.content[0].text).toContain('página: http://localhost:3000/skills/minha-skill');
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
    await surfacesVirtual.readResource('skill://minha-skill/SKILL.md');

    expect(db.listPublishedSkills).toHaveBeenNthCalledWith(1, 'prompt', 'mcp-2');
    expect(db.listPublishedSkills).toHaveBeenNthCalledWith(2, 'resource', 'mcp-2');
    expect(db.getSkillDetail).toHaveBeenNthCalledWith(1, 'minha-skill', {
      virtualMcp: { uuid: 'mcp-2', surface: 'prompt' },
    });
    expect(db.getSkillDetail).toHaveBeenNthCalledWith(2, 'minha-skill', {
      virtualMcp: { uuid: 'mcp-2', surface: 'skill' },
    });
    expect(db.recordSkillAccess).toHaveBeenCalledWith(expect.objectContaining({ skillUuid: 'uuid-1', virtualMcpUuid: 'mcp-2', origin: 'mcp' }));
  });
});

/**
 * O embrulho das ferramentas e das superfícies. Sem ele a exceção sobe ao SDK,
 * que monta o `isError` (e o erro do JSON-RPC) com a `message` crua — e aqui o
 * cliente é anônimo por padrão.
 */
describe('guard', () => {
  it('deixa passar inteira a mensagem de erro de negócio', async () => {
    const result = await guard(async () => {
      throw new AppError('Uuid de espaço inválido: x', 400, 'bad_request');
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Uuid de espaço inválido: x');
  });

  it('não derruba a ferramenta nem vaza o detalhe interno do erro inesperado', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await guard(async () => {
      throw new Error('relation "skill_accesses" does not exist');
    });

    expect(result.isError).toBe(true);
    // Mensagem de driver descreve o esquema: ela sai no log, não na resposta.
    expect(result.content[0].text).not.toContain('skill_accesses');
    const ref = /ref ([0-9a-f]{8})/.exec(result.content[0].text)?.[1];
    expect(ref).toBeDefined();
    // A mesma referência nos dois lados é o que liga a reclamação ao detalhe.
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`ref ${ref}`), expect.any(Error));

    log.mockRestore();
  });

  it('nas superfícies, mantém a recusa de protocolo e embrulha só o imprevisto', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.getSkillDetail.mockResolvedValue(null);

    // A recusa de `naoEncontrado` é escrita para o cliente: passa inteira.
    await expect(
      guardSurface(() => surfaces.readResource('skill://nao-existe/SKILL.md')),
    ).rejects.toThrow(/Resource não encontrado/);

    const erro = await guardSurface(async () => {
      throw new Error('duplicate key value violates unique constraint "tags_name_key"');
    }).catch((err: Error) => err);

    expect(erro.message).not.toContain('tags_name_key');
    expect(erro.message).toMatch(/Erro interno do servidor \(ref [0-9a-f]{8}\)/);

    log.mockRestore();
  });
});
