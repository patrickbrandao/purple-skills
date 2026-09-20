import type { RequestHandler } from 'express';
import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const { criar, criarEnvio, lerMcp } = vi.hoisted(() => ({
  criar: vi.fn(),
  criarEnvio: vi.fn(),
  lerMcp: vi.fn(),
}));

// Só `createSkill`, `createQuarantine` e `getVirtualMcp` são trocados: o resto
// do pacote entra de verdade, e nada nele abre conexão em tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createSkill: criar,
  createQuarantine: criarEnvio,
  getVirtualMcp: lerMcp,
}));

const { api } = await import('./api.js');

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] };
};

/** O último handler da rota — depois dos guardas e do multer. */
function rota(method: string, path: string): RequestHandler {
  const layers = (api as unknown as { stack: Layer[] }).stack;
  const found = layers.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  if (!found?.route) throw new Error(`rota não registrada: ${method.toUpperCase()} ${path}`);
  return found.route.stack[found.route.stack.length - 1]!.handle;
}

function zipCom(skillMd: string | Buffer): Buffer {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.isBuffer(skillMd) ? skillMd : Buffer.from(skillMd, 'utf8'));
  return zip.toBuffer();
}

function zipDe(entradas: Record<string, Buffer | string>): Buffer {
  const zip = new AdmZip();
  for (const [nome, conteudo] of Object.entries(entradas)) {
    zip.addFile(nome, Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'utf8'));
  }
  return zip.toBuffer();
}

const admin = { uuid: 'uuid-admin', email: 'admin@exemplo.dev', name: 'Admin', role: 'admin', mustChangePassword: false, legacy: false };
const editor = { ...admin, uuid: 'uuid-editor', email: 'editor@exemplo.dev', role: 'editor' };

const timeA = {
  uuid: 'mcp-1',
  slug: 'time-a',
  name: 'Time A',
  description: '',
  isActive: true,
  isOpen: false,
  ownerUserUuid: 'uuid-editor',
  ownerEmail: 'editor@exemplo.dev',
  skillCount: 0,
  activeKeyCount: 0,
  isDefault: false,
  toolCount: 0,
  promptCount: 0,
  resourceCount: 0,
  onlineSessions: 0,
  preview: [],
  catalogCount: 0,
  previewCatalogs: [],
  layout: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  skills: [],
  grants: [],
  access: 'owner' as const,
};

async function importar(skillMd: string | Buffer, campos: Record<string, string> = {}, user = admin) {
  return importarPacote(zipCom(skillMd), campos, user);
}

async function importarPacote(
  pacote: Buffer,
  campos: Record<string, string> = {},
  user = admin,
  originalname = 'pacote.zip',
) {
  const req = { file: { buffer: pacote, originalname }, body: campos, user };
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };

  await rota('post', '/api/skills/import')(req as never, res as never, (() => {}) as never);
  await new Promise((resolve) => setImmediate(resolve));

  // A última chamada, não a primeira: um teste que importa mais de um .zip
  // compara cada resultado com a importação que acabou de fazer.
  return { input: criar.mock.calls.at(-1)?.[0], res };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `skillMd` entra porque a rota passa o retorno por `bodyOnly` antes de
  // responder: sem ele cada importação despeja um TypeError no stderr do teste.
  criar.mockResolvedValue({ slug: 'minha-skill', skillMd: '', files: [] });
  criarEnvio.mockResolvedValue({ uuid: 'envio-1', name: 'Revisor', ownerUserUuid: 'uuid-admin', ownerEmail: 'admin@exemplo.dev' });
  lerMcp.mockResolvedValue(timeA);
});

describe('POST /api/skills/import', () => {
  // Onde a skill aparece é decidido pelo vínculo, escolhido por quem importa:
  // um .zip de terceiro não se publica sozinho, por flag nenhuma.
  it('ignora qualquer flag de publicação do frontmatter e nasce flutuante', async () => {
    const { input } = await importar(
      '---\nname: minha-skill\nis_public: true\nuse_as_prompt: true\n---\n# Corpo\n',
    );

    expect(input).toMatchObject({ slug: 'minha-skill', mcps: [] });
    expect(input).not.toHaveProperty('isPublic');
    expect(input).not.toHaveProperty('useAsPrompt');
  });

  it('publica nos vMCPs do formulário, resolvendo o slug em uuid', async () => {
    const { input } = await importar('# Corpo\n', {
      mcps: JSON.stringify([{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }]),
    });

    // A leitura leva a janela de "online" do painel (docs/10) e quem está
    // olhando (docs/12): o banco decide o que a sessão enxerga.
    expect(lerMcp).toHaveBeenCalledWith('time-a', {
      onlineWindowMs: expect.any(Number),
      viewer: { role: 'admin', userUuid: 'uuid-admin' },
    });
    expect(input.mcps).toEqual([
      { virtualMcpUuid: 'mcp-1', asSkill: true, asPrompt: false, asResource: false },
    ]);
  });

  // Vincular é editar o vMCP (docs/12 §3.2): quem só visualiza é barrado, e
  // quem nem enxerga recebe o mesmo 404 de um slug inexistente.
  it('recusa um vMCP que a sessão só visualiza, sem criar a skill', async () => {
    const outro = { ...editor, uuid: 'uuid-outro' };
    lerMcp.mockResolvedValue({ ...timeA, access: 'view' });

    const { res } = await importar(
      '# Corpo\n',
      { mcps: JSON.stringify([{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }]) },
      outro,
    );

    expect(res.statusCode).toBe(403);
    expect(criar).not.toHaveBeenCalled();
  });

  it('trata como inexistente um vMCP que a sessão não enxerga', async () => {
    const outro = { ...editor, uuid: 'uuid-outro' };
    lerMcp.mockResolvedValue(null);

    const { res } = await importar(
      '# Corpo\n',
      { mcps: JSON.stringify([{ slug: 'time-a', asSkill: true, asPrompt: false, asResource: false }]) },
      outro,
    );

    expect(res.statusCode).toBe(404);
    expect(criar).not.toHaveBeenCalled();
  });

  it('recusa um vínculo sem nenhuma superfície', async () => {
    const { res } = await importar('# Corpo\n', {
      mcps: JSON.stringify([{ slug: 'time-a', asSkill: false, asPrompt: false, asResource: false }]),
    });

    expect(res.statusCode).toBe(400);
    expect(criar).not.toHaveBeenCalled();
  });

  /**
   * Ponta a ponta do relatório 064 da auditoria de 2026-09-19: a `description`
   * em escalar de bloco (`>-`, `|`) é como boa parte das skills publicadas a
   * escreve — o `skill-creator` inclusive. O parser lia só a primeira linha, e
   * com o formulário em branco a skill nascia com a descrição `">-"`.
   */
  describe('descrição em escalar de bloco, com o formulário em branco', () => {
    const CORPO = '\n# Revisor de PR\n\nPrimeiro parágrafo do corpo, que não é a descrição.\n';

    it('`description: >-` (dobrado) nasce com a descrição inteira, numa linha só', async () => {
      const { input, res } = await importar(
        '---\nname: revisor-de-pr\ndescription: >-\n' +
          '  Revisa pull requests em busca de bugs de concorrência, vazamento de\n' +
          '  recurso e erro de borda. Use quando pedirem revisão de código,\n' +
          '  mesmo que não digam "PR".\n' +
          'metadata:\n  title: Revisor de PR\n  tags: revisao, git\n---\n' +
          CORPO,
      );

      expect(res.statusCode).toBe(201);
      expect(input).toMatchObject({
        name: 'Revisor de PR',
        slug: 'revisor-de-pr',
        description:
          'Revisa pull requests em busca de bugs de concorrência, vazamento de recurso e erro de borda. ' +
          'Use quando pedirem revisão de código, mesmo que não digam "PR".',
        tags: ['revisao', 'git'],
        // O que é gravado é só o corpo: o bloco inteiro sai, não só a 1ª linha.
        skillMd: '# Revisor de PR\n\nPrimeiro parágrafo do corpo, que não é a descrição.\n',
      });
    });

    it('`description: |` (literal) mantém as quebras de linha', async () => {
      const { input } = await importar(
        '---\nname: revisor-de-pr\ndescription: |\n  Revisa pull requests.\n  Use quando pedirem revisão.\n---\n' + CORPO,
      );

      expect(input.description).toBe('Revisa pull requests.\nUse quando pedirem revisão.');
    });

    it('o que o formulário traz continua vencendo o frontmatter', async () => {
      const { input } = await importar('---\nname: revisor-de-pr\ndescription: >-\n  Do arquivo.\n---\n' + CORPO, {
        description: '  Do formulário  ',
      });

      expect(input.description).toBe('Do formulário');
    });
  });

  // Quem recusa é o `extractZip` (`ZipContentError`, relatório 015 da auditoria
  // de 2026-09-19): `toString('utf8')` trocaria cada byte inválido por U+FFFD,
  // e a skill nasceria com o prompt corrompido, sem aviso.
  it('SKILL.md fora de UTF-8 é 400 com a causa, e a skill não é criada', async () => {
    // `# Instruções` em Windows-1252: o `ç` e o `õ` são um byte cada.
    const windows1252 = Buffer.from([0x23, 0x20, 0x49, 0x6e, 0x73, 0x74, 0x72, 0x75, 0xe7, 0xf5, 0x65, 0x73, 0x0a]);

    const { res } = await importar(windows1252);

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/UTF-8 válido/) });
    expect(criar).not.toHaveBeenCalled();
  });
});

/**
 * O destino do pacote (`docs/15-quarentena.md`). Importar é o **único** caminho
 * para a quarentena — o formulário de nova skill vai sempre para produção — e a
 * escolha é de quem importa, nunca de algo dentro do pacote.
 */
describe('POST /api/skills/import — destino', () => {
  const PACOTE = {
    'SKILL.md': '---\nname: revisor-de-pr\ndescription: Revisa PRs.\n---\n# Revisor de PR\n',
    'ref/notas.md': '# Notas\n',
    'ref/logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  };

  it('sem o campo, o pacote vai para produção, como sempre foi', async () => {
    await importarPacote(zipDe(PACOTE));

    expect(criar).toHaveBeenCalledTimes(1);
    expect(criarEnvio).not.toHaveBeenCalled();
  });

  it('"production" é o mesmo caminho', async () => {
    await importarPacote(zipDe(PACOTE), { destination: 'production' });

    expect(criar).toHaveBeenCalledTimes(1);
    expect(criarEnvio).not.toHaveBeenCalled();
  });

  it('destino desconhecido é 400, e nada é gravado em lugar nenhum', async () => {
    const { res } = await importarPacote(zipDe(PACOTE), { destination: 'producao' });

    expect(res.statusCode).toBe(400);
    expect(criar).not.toHaveBeenCalled();
    expect(criarEnvio).not.toHaveBeenCalled();
  });

  describe('quarantine', () => {
    it('grava o envio em vez da skill, com o nome e a descrição do SKILL.md', async () => {
      const { res } = await importarPacote(zipDe(PACOTE), { destination: 'quarantine' });

      expect(res.statusCode).toBe(201);
      expect(criar).not.toHaveBeenCalled();
      expect(criarEnvio.mock.calls[0]![0]).toMatchObject({
        // O rótulo é o nome **legível** do SKILL.md (`skillMetaFromMarkdown`):
        // com `name:` já em forma de slug, quem dá o título é o heading.
        name: 'Revisor de PR',
        description: 'Revisa PRs.',
        sourceFilename: 'pacote.zip',
      });
    });

    /*
     * A diferença que define a quarentena: em produção o SKILL.md entra sem o
     * frontmatter (os metadados vão para colunas) e ele sai da lista de anexos.
     * Aqui os arquivos entram como chegaram, o principal junto com os demais.
     */
    it('os arquivos entram crus, com o SKILL.md e o frontmatter dentro dele', async () => {
      await importarPacote(zipDe(PACOTE), { destination: 'quarantine' });

      const arquivos = criarEnvio.mock.calls[0]![0].files as { relativePath: string; content: Buffer }[];
      expect(arquivos.map((file) => file.relativePath).sort()).toEqual(['SKILL.md', 'ref/logo.png', 'ref/notas.md']);
      const principal = arquivos.find((file) => file.relativePath === 'SKILL.md')!;
      expect(principal.content.toString('utf8')).toBe(PACOTE['SKILL.md']);
    });

    it('o binário chega byte a byte: a quarentena não peneira tipo', async () => {
      await importarPacote(zipDe(PACOTE), { destination: 'quarantine' });

      const arquivos = criarEnvio.mock.calls[0]![0].files as { relativePath: string; content: Buffer }[];
      const png = arquivos.find((file) => file.relativePath === 'ref/logo.png')!;
      expect(png.content.equals(PACOTE['ref/logo.png'] as Buffer)).toBe(true);
    });

    /*
     * Ao contrário da importação para produção, aqui a falta do SKILL.md não
     * barra: consertar o pacote torto é justamente o que a quarentena serve.
     * Quem cobra o arquivo é a aprovação, que sem ele não sabe que skill criar.
     */
    it('pacote sem SKILL.md entra, e o nome sai do arquivo enviado', async () => {
      const { res } = await importarPacote(
        zipDe({ 'ref/notas.md': '# Notas\n' }),
        { destination: 'quarantine' },
        admin,
        'revisor.skill',
      );

      expect(res.statusCode).toBe(201);
      expect(criarEnvio.mock.calls[0]![0]).toMatchObject({ name: 'revisor', description: '' });
    });

    it('pacote vazio é 400', async () => {
      const { res } = await importarPacote(zipDe({}), { destination: 'quarantine' });

      expect(res.statusCode).toBe(400);
      expect(criarEnvio).not.toHaveBeenCalled();
    });

    // Na quarentena não há metadado separado do arquivo: o formulário não tem
    // onde encostar, e o painel nem o mostra nesse destino.
    it('nome e descrição do formulário são ignorados', async () => {
      await importarPacote(zipDe(PACOTE), {
        destination: 'quarantine',
        name: 'Do formulário',
        description: 'Do formulário',
      });

      expect(criarEnvio.mock.calls[0]![0]).toMatchObject({ name: 'Revisor de PR', description: 'Revisa PRs.' });
    });

    /*
     * O pacote que a quarentena mais precisa receber: `SKILL.md` em
     * Windows-1252 ou UTF-16, o que sai de um editor Windows. Antes ele era
     * recusado nos **dois** destinos pelo `extractZip`, e o espaço criado para
     * consertar pacote torto era justamente o que não o aceitava. A cobrança da
     * codificação passou para a aprovação.
     */
    it('SKILL.md fora de UTF-8 entra, byte a byte', async () => {
      // `# Instruções` em Windows-1252: o `ç` e o `õ` são um byte cada.
      const windows1252 = Buffer.from([0x23, 0x20, 0x49, 0x6e, 0x73, 0x74, 0x72, 0x75, 0xe7, 0xf5, 0x65, 0x73, 0x0a]);
      const { res } = await importarPacote(
        zipDe({ 'SKILL.md': windows1252, 'ref/notas.md': '# Notas\n' }),
        { destination: 'quarantine' },
      );

      expect(res.statusCode).toBe(201);
      const arquivos = criarEnvio.mock.calls[0]![0].files as { relativePath: string; content: Buffer }[];
      expect(arquivos.find((file) => file.relativePath === 'SKILL.md')!.content.equals(windows1252)).toBe(true);
      // Sem metadados legíveis, o rótulo cai para o nome do arquivo enviado.
      expect(criarEnvio.mock.calls[0]![0]).toMatchObject({ name: 'pacote', description: '' });
    });

    it('o mesmo pacote continua recusado quando o destino é produção', async () => {
      const windows1252 = Buffer.from([0x23, 0x20, 0x49, 0x6e, 0x73, 0x74, 0x72, 0x75, 0xe7, 0xf5, 0x65, 0x73, 0x0a]);
      const { res } = await importarPacote(zipDe({ 'SKILL.md': windows1252 }), { destination: 'production' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ message: expect.stringMatching(/UTF-8 válido/) });
      expect(criar).not.toHaveBeenCalled();
      expect(criarEnvio).not.toHaveBeenCalled();
    });

    it('o uuid do dono não sai na resposta — sai o e-mail, como em toda ficha', async () => {
      const { res } = await importarPacote(zipDe(PACOTE), { destination: 'quarantine' });

      expect(res.body).toMatchObject({ ownerUserUuid: 'admin@exemplo.dev' });
    });
  });
});
