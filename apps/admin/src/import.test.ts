import { gzipSync } from 'node:zlib';
import type { RequestHandler } from 'express';
import AdmZip from 'adm-zip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_BUNDLE_SKILLS, type QuarantineBundleResult } from '@purple-skills/shared';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const { criar, criarEnvio, lerMcp, divisor } = vi.hoisted(() => ({
  criar: vi.fn(),
  criarEnvio: vi.fn(),
  lerMcp: vi.fn(),
  divisor: vi.fn(),
}));

// Só `createSkill`, `createQuarantine` e `getVirtualMcp` são trocados: o resto
// do pacote entra de verdade, e nada nele abre conexão em tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createSkill: criar,
  createQuarantine: criarEnvio,
  getVirtualMcp: lerMcp,
}));

/**
 * O `splitBundle` **de verdade**, com um espião em volta: o que a rota faz não
 * muda, e fica visível *se* ela pede a divisão em várias skills e *com que
 * tetos*.
 *
 * É a única forma de fixar por teste o resíduo do teto desligado. O pacote cuja
 * raiz é a skill respondia igual antes e depois — o que estava errado era o
 * caminho: ele pedia a divisão e, para os `SKILL.md` de subpasta não contarem
 * como irmãs, mandava `maxSkills: Number.MAX_SAFE_INTEGER`, ou seja, desligava
 * o `BUNDLE_MAX_SKILLS` que o operador configurou. Pelo corpo da resposta isso
 * é invisível; pela chamada, não.
 */
vi.mock('@purple-skills/shared', async (original) => {
  const real = await original<typeof import('@purple-skills/shared')>();
  const splitBundle: typeof real.splitBundle = (entries, options) => {
    divisor(entries, options);
    return real.splitBundle(entries, options);
  };
  return { ...real, splitBundle };
});

const { MAX_NOME, api } = await import('./api.js');
// Importado como o `api.js`, depois do `ADMIN_PASSWORD` acima: o módulo puxa a
// cadeia que lê a configuração no carregamento.
const { MAX_FILES_POR_ENVIO } = await import('./quarantine.js');

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

/**
 * Um `.tar` montado à mão — cabeçalho ustar de 512 bytes por arquivo, conteúdo
 * alinhado em 512 e dois blocos zerados no fim —, comprimido com gzip.
 *
 * Feito aqui em vez de com uma dependência de teste nova, e de propósito: um
 * tar gerado pela **mesma** biblioteca que o lê não provaria que a rota abre o
 * `.tar.gz` de qualquer lugar.
 */
function tarGzDe(entradas: Record<string, Buffer | string>): Buffer {
  // Sem byte de controle literal no fonte (`AGENTS.md`): o NUL que fecha o
  // campo de checksum é montado aqui.
  const NUL = String.fromCharCode(0);
  const blocos: Buffer[] = [];

  for (const [nome, conteudo] of Object.entries(entradas)) {
    const data = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'utf8');
    const header = Buffer.alloc(512);
    header.write(nome, 0, 100, 'utf8');
    header.write('0000644 ', 100, 8, 'ascii'); // modo
    header.write('0000000 ', 108, 8, 'ascii'); // uid
    header.write('0000000 ', 116, 8, 'ascii'); // gid
    header.write(`${data.length.toString(8).padStart(11, '0')} `, 124, 12, 'ascii');
    header.write('00000000000 ', 136, 12, 'ascii'); // mtime
    // O checksum é a soma dos bytes do cabeçalho com o próprio campo em branco.
    header.write('        ', 148, 8, 'ascii');
    header.write('0', 156, 1, 'ascii'); // arquivo comum
    header.write('ustar', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    const soma = header.reduce((total, byte) => total + byte, 0);
    header.write(`${soma.toString(8).padStart(6, '0')}${NUL} `, 148, 8, 'ascii');

    blocos.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }

  blocos.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocos));
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

  /*
   * O vizinho do teste acima, e o contrário dele: um arquivo **vazio** é UTF-8
   * perfeitamente válido. Quem o acusava de não ser era a condição, que testava
   * a verdade da string (`!textContent`) em vez de testar se ela é `null` — o
   * único valor que quer dizer "estes bytes não são texto". Vazio continua
   * recusado, porque a skill nasceria sem prompt nenhum, mas com o diagnóstico
   * certo: mandar converter para UTF-8 um arquivo de zero byte é mandar
   * consertar o que não está quebrado.
   */
  it('SKILL.md vazio é 400 dizendo que está vazio, não que não é UTF-8', async () => {
    const { res } = await importar('');

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: 'bad_request',
      message: expect.stringMatching(/vazio/),
    });
    expect(res.body).toMatchObject({ message: expect.not.stringMatching(/UTF-8/) });
    expect(criar).not.toHaveBeenCalled();
  });

  /*
   * O terceiro vizinho, e o que a guarda acima deixava passar: o que vira o
   * prompt da skill é o **corpo**, depois de o frontmatter sair
   * (`stripFrontmatter`, na chamada de `createSkill`) — então é o corpo que
   * decide "vazio", e não o texto cru com o bloco dentro.
   *
   * Medido com a guarda sobre o texto cru: este pacote respondia **201** e a
   * skill nascia com `skillMd: ''` — exatamente o "ela nasceria sem prompt
   * nenhum" que a recusa do vizinho existe para evitar, com o agravante de o
   * `name` e a `description` do frontmatter darem à ficha cara de skill
   * completa.
   */
  describe('SKILL.md só com frontmatter', () => {
    const SO_META = '---\nname: so-meta\ndescription: d\n---\n';

    it('é 400, e a skill não é criada sem prompt', async () => {
      const { res } = await importar(SO_META);

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        error: 'bad_request',
        message: expect.stringMatching(/frontmatter/),
      });
      expect(criar).not.toHaveBeenCalled();
    });

    // O `stripFrontmatter` come o espaço da frente, então o bloco seguido de
    // linhas em branco dá no mesmo corpo vazio — e tem de dar na mesma recusa.
    it('com linhas em branco depois do bloco, idem', async () => {
      const { res } = await importar(`${SO_META}\n   \n\n`);

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({ message: expect.stringMatching(/frontmatter/) });
      expect(criar).not.toHaveBeenCalled();
    });

    // O contrapeso, para a guarda não virar "todo SKILL.md com frontmatter é
    // recusado": uma linha de corpo abaixo do bloco basta, e o que é gravado
    // continua sendo só o corpo.
    it('uma linha de corpo abaixo do bloco já entra', async () => {
      const { input, res } = await importar(`${SO_META}# Corpo\n`);

      expect(res.statusCode).toBe(201);
      expect(input).toMatchObject({ slug: 'so-meta', skillMd: '# Corpo\n' });
    });

    /*
     * As três recusas do SKILL.md em produção são três diagnósticos
     * diferentes, e nenhuma pode responder pela outra: mandar converter para
     * UTF-8 um arquivo que é UTF-8, ou dizer que falta o arquivo que está lá,
     * é mandar consertar o que não está quebrado.
     */
    it('a mensagem de ausente, a de não-UTF-8 e a de só-frontmatter são distintas', async () => {
      // `# Instruções` em Windows-1252: o `ç` e o `õ` são um byte cada.
      const windows1252 = Buffer.from([0x23, 0x20, 0x49, 0x6e, 0x73, 0x74, 0x72, 0x75, 0xe7, 0xf5, 0x65, 0x73, 0x0a]);

      const ausente = await importarPacote(zipDe({ 'ref/notas.md': '# Notas\n' }));
      const torto = await importar(windows1252);
      const soMeta = await importar(SO_META);

      const mensagens = [ausente, torto, soMeta].map((caso) => {
        expect(caso.res.statusCode).toBe(400);
        return (caso.res.body as { message: string }).message;
      });

      expect(mensagens[0]).toMatch(/precisa conter um SKILL\.md/);
      expect(mensagens[1]).toMatch(/UTF-8/);
      expect(mensagens[2]).toMatch(/frontmatter/);
      expect(new Set(mensagens).size).toBe(3);
      expect(criar).not.toHaveBeenCalled();
    });
  });
});

/**
 * O teto do rótulo que vem de **dentro** do pacote.
 *
 * A `description` já parava em 500 (`skillMetaFromMarkdown`) e o `name` não: um
 * SKILL.md hostil gravava um rótulo de qualquer tamanho, e ele vai para a lista
 * da fila, para o nome do pacote baixado e para a trilha de auditoria.
 */
describe('POST /api/skills/import — teto do rótulo', () => {
  const gigante = `Rótulo grande${' muito'.repeat(2000)}`;

  it('corta o rótulo do envio, sem deixar espaço na ponta', async () => {
    const { res } = await importarPacote(
      zipDe({ 'SKILL.md': `---\nname: ${gigante}\n---\n# Corpo\n` }),
      { destination: 'quarantine' },
    );

    expect(res.statusCode).toBe(201);
    const nome = criarEnvio.mock.calls[0]![0].name as string;
    expect(nome.length).toBeLessThanOrEqual(MAX_NOME);
    // O corte é no teto, não numa fatia qualquer: o rótulo continua sendo o
    // começo do que o pacote trouxe, e sem o espaço que o corte deixa na ponta.
    expect(nome.length).toBeGreaterThan(MAX_NOME - 10);
    expect(gigante.startsWith(nome)).toBe(true);
    expect(nome).not.toMatch(/\s$/);
  });

  it('corta o mesmo rótulo em produção, onde ele vem do mesmo SKILL.md', async () => {
    const { input } = await importar(`---\nname: ${gigante}\n---\n# Corpo\n`);

    expect((input.name as string).length).toBeLessThanOrEqual(MAX_NOME);
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

    /*
     * O mesmo nome de reserva, nos sufixos que a regex não conhecia: o
     * `archive.ts` aceita `.zstd` e `.gzip` porque é assim que muita gente
     * escreve as duas compressões, e sem elas aqui o rótulo saía `fping.zstd`
     * — a extensão do pacote no meio do nome do envio.
     */
    it('o nome de reserva perde também o `.zstd` e o `.gzip`', async () => {
      const pacote = zipDe({ 'ref/notas.md': '# Notas\n' });

      await importarPacote(pacote, { destination: 'quarantine' }, admin, 'fping.zstd');
      await importarPacote(pacote, { destination: 'quarantine' }, admin, 'fping.gzip');

      expect(criarEnvio.mock.calls.map((call) => call[0].name)).toEqual(['fping', 'fping']);
    });

    /*
     * A regra de bundle pedida no recurso — "ignorando todos os diretórios que
     * não possuem o arquivo SKILL.md" — aplicada ao pacote de **uma** skill que
     * está numa subpasta: o que está solto na raiz não é dela e fica de fora.
     *
     * Fixado aqui porque é um descarte **silencioso**: o corpo deste ramo é o
     * `QuarantineDetail`, que não tem campo para dizer o que ficou de fora
     * (quem tem é o `QuarantineBundleResult`, e este pacote não é bundle).
     * Sem este teste, mudar o descarte sem querer não faria barulho nenhum.
     */
    it('com a skill numa subpasta, o que está solto na raiz fica de fora', async () => {
      const { res } = await importarPacote(
        zipDe({
          'README.md': '# repositório\n',
          'LICENSE': 'MIT\n',
          'skills/alfa/SKILL.md': '---\nname: alfa\n---\n# Alfa\n',
          'skills/alfa/ref/notas.md': '# Notas\n',
        }),
        { destination: 'quarantine' },
      );

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toHaveProperty('bundle');
      const envio = criarEnvio.mock.calls[0]![0];
      expect((envio.files as { relativePath: string }[]).map((file) => file.relativePath).sort()).toEqual([
        'SKILL.md',
        'ref/notas.md',
      ]);
      // Não há onde avisar: a ficha do envio não tem campo de descarte.
      expect(res.body).not.toHaveProperty('skipped');
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

/**
 * O pacote que traz **várias** skills (`docs/15-quarentena.md` §10). Skill é
 * todo diretório com um `SKILL.md`; o que não tem um — o `.github/`, o `docs/`
 * e o `README.md` de um repositório de terceiro — fica de fora inteiro.
 */
describe('POST /api/skills/import — bundle', () => {
  const skillMd = (nome: string, titulo: string) =>
    `---\nname: ${nome}\ndescription: A skill ${titulo}.\n---\n# ${titulo}\n`;

  /** Um repositório de skills como o `.zip` do GitHub o entrega. */
  const REPO: Record<string, Buffer | string> = {
    'README.md': '# superpowers\n',
    '.github/workflows/ci.yml': 'name: ci\n',
    'docs/uso.md': '# Uso\n',
    'skills/brainstorming/SKILL.md': skillMd('brainstorming', 'Brainstorming'),
    'skills/brainstorming/ref/notas.md': '# Notas\n',
    'skills/debugging/SKILL.md': skillMd('debugging', 'Debugging'),
    'skills/testing/SKILL.md': skillMd('testing', 'Testing'),
  };

  beforeEach(() => {
    // O envio devolvido espelha o que a rota mandou gravar: `imported` é o
    // retrato do que foi **gravado**, e com um retorno fixo os três envios
    // sairiam idênticos na resposta, escondendo qualquer troca de ordem.
    let criados = 0;
    criarEnvio.mockImplementation(async (input: { name: string; files?: unknown[] }) => {
      criados += 1;
      return {
        uuid: `envio-${criados}`,
        name: input.name,
        fileCount: input.files?.length ?? 0,
        ownerUserUuid: 'uuid-admin',
        ownerEmail: 'admin@exemplo.dev',
      };
    });
  });

  it('três skills sob `skills/` viram três envios, e o resto do repositório fica de fora', async () => {
    const { res } = await importarPacote(
      zipDe(REPO),
      { destination: 'quarantine' },
      admin,
      'superpowers-main.zip',
    );

    expect(res.statusCode).toBe(201);
    expect(criarEnvio).toHaveBeenCalledTimes(3);
    expect(criar).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ bundle: true, sourceFilename: 'superpowers-main.zip', skipped: [] });

    const corpo = res.body as QuarantineBundleResult;
    expect(corpo.imported.map((skill) => skill.path)).toEqual([
      'skills/brainstorming',
      'skills/debugging',
      'skills/testing',
    ]);
    expect(corpo.imported.map((skill) => skill.name)).toEqual(['Brainstorming', 'Debugging', 'Testing']);
    // O `fileCount` é o do envio gravado: a primeira leva o `ref/notas.md`.
    expect(corpo.imported.map((skill) => skill.fileCount)).toEqual([2, 1, 1]);
  });

  it('cada envio leva só os próprios arquivos, com o SKILL.md na raiz', async () => {
    await importarPacote(zipDe(REPO), { destination: 'quarantine' }, admin, 'superpowers-main.zip');

    const caminhos = criarEnvio.mock.calls.map((call) =>
      (call[0].files as { relativePath: string }[]).map((file) => file.relativePath).sort(),
    );
    expect(caminhos).toEqual([['SKILL.md', 'ref/notas.md'], ['SKILL.md'], ['SKILL.md']]);
  });

  // Decisão 25: só com o nome do arquivo, quarenta envios do mesmo repositório
  // ficariam indistinguíveis na fila.
  it('o `sourceFilename` do envio traz o diretório de origem entre parênteses', async () => {
    await importarPacote(zipDe(REPO), { destination: 'quarantine' }, admin, 'superpowers-main.zip');

    expect(criarEnvio.mock.calls.map((call) => call[0].sourceFilename)).toEqual([
      'superpowers-main.zip (skills/brainstorming)',
      'superpowers-main.zip (skills/debugging)',
      'superpowers-main.zip (skills/testing)',
    ]);
  });

  /*
   * O `.zip` que o GitHub entrega traz tudo dentro de `<repo>-<branch>/`. Esse
   * embrulho é aparado na importação — um nível, e só quando **todas** as
   * entradas começam por ele. Sem o aparo, medido num pacote real, o rótulo de
   * origem saía com o nome do arquivo duas vezes
   * (`superpowers-main.zip (superpowers-main/skills/brainstorming)`) e o `path`
   * mostrado na tela não batia com o caminho do repositório no GitHub.
   */
  describe('embrulho do pacote', () => {
    const EMBRULHADO = Object.fromEntries(
      Object.entries(REPO).map(([nome, conteudo]) => [`superpowers-main/${nome}`, conteudo]),
    );

    it('o embrulho some do `path` e do `sourceFilename`, e o `skills/` fica', async () => {
      const { res } = await importarPacote(
        zipDe(EMBRULHADO),
        { destination: 'quarantine' },
        admin,
        'superpowers-main.zip',
      );

      expect(res.statusCode).toBe(201);
      const corpo = res.body as QuarantineBundleResult;
      // Um nível só: aparado o `superpowers-main/`, o `README.md` volta à raiz
      // e `skills/` deixa de ser o primeiro segmento comum — aparar de novo
      // comeria arrumação de verdade.
      expect(corpo.imported.map((skill) => skill.path)).toEqual([
        'skills/brainstorming',
        'skills/debugging',
        'skills/testing',
      ]);
      expect(criarEnvio.mock.calls.map((call) => call[0].sourceFilename)).toEqual([
        'superpowers-main.zip (skills/brainstorming)',
        'superpowers-main.zip (skills/debugging)',
        'superpowers-main.zip (skills/testing)',
      ]);
    });

    // O contrapeso: sem embrulho não há o que aparar, e nenhum segmento pode
    // sumir do caminho por causa da regra.
    it('pacote sem embrulho mantém os caminhos intactos', async () => {
      const { res } = await importarPacote(
        zipDe(REPO),
        { destination: 'quarantine' },
        admin,
        'superpowers-main.zip',
      );

      const corpo = res.body as QuarantineBundleResult;
      expect(corpo.imported.map((skill) => skill.path)).toEqual([
        'skills/brainstorming',
        'skills/debugging',
        'skills/testing',
      ]);
    });

    /*
     * O pacote que o painel e o site exportam: `<slug>/SKILL.md`. Aparar o
     * embrulho põe a skill na raiz — que é o que o `stripSingleRootDir` do
     * `extractZip` fazia —, então este caminho continua idêntico ao de antes do
     * bundle, resposta e `sourceFilename` inclusive.
     */
    it('pacote de uma skill só com embrulho responde igual ao de hoje', async () => {
      const { res } = await importarPacote(
        zipDe({
          'revisor-de-pr/SKILL.md': skillMd('revisor-de-pr', 'Revisor de PR'),
          'revisor-de-pr/ref/notas.md': '# Notas\n',
        }),
        { destination: 'quarantine' },
      );

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toHaveProperty('bundle');
      expect(res.body).toMatchObject({ uuid: 'envio-1', name: 'Revisor de PR' });

      const envio = criarEnvio.mock.calls[0]![0];
      expect(envio.sourceFilename).toBe('pacote.zip');
      expect((envio.files as { relativePath: string }[]).map((file) => file.relativePath).sort()).toEqual([
        'SKILL.md',
        'ref/notas.md',
      ]);
    });

    // O aparo vale nos dois destinos: em produção o anexo tem que nascer em
    // `ref/notas.md`, não em `revisor-de-pr/ref/notas.md`.
    it('em produção o embrulho também some', async () => {
      const { input, res } = await importarPacote(
        zipDe({
          'revisor-de-pr/SKILL.md': skillMd('revisor-de-pr', 'Revisor de PR'),
          'revisor-de-pr/ref/notas.md': '# Notas\n',
        }),
        { destination: 'production' },
      );

      expect(res.statusCode).toBe(201);
      expect(input).toMatchObject({ slug: 'revisor-de-pr', name: 'Revisor de PR' });
      // O SKILL.md sai da lista de anexos: em produção ele vira o corpo da skill.
      expect((input.files as { relativePath: string }[]).map((file) => file.relativePath)).toEqual([
        'ref/notas.md',
      ]);
    });
  });

  /*
   * Decisão 21: as três nasceriam no acervo sem ninguém ter olhado, prontas
   * para publicar e para o RAG fatiar — o portão da quarentena pelo avesso.
   */
  it('o mesmo pacote em produção é 400, com a contagem na mensagem', async () => {
    const { res } = await importarPacote(
      zipDe(REPO),
      { destination: 'production' },
      admin,
      'superpowers-main.zip',
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: 'bad_request',
      message: expect.stringMatching(/3 skills.*quarentena/s),
    });
    expect(criar).not.toHaveBeenCalled();
    expect(criarEnvio).not.toHaveBeenCalled();
  });

  // O que mantém de pé a tela e os testes anteriores ao bundle: o pacote de uma
  // skill só responde a ficha do envio, sem `bundle` nenhum para discriminar.
  it('pacote de uma skill só continua respondendo a ficha do envio', async () => {
    const { res } = await importarPacote(
      zipDe({ 'SKILL.md': skillMd('revisor-de-pr', 'Revisor de PR'), 'ref/notas.md': '# Notas\n' }),
      { destination: 'quarantine' },
    );

    expect(res.statusCode).toBe(201);
    expect(criarEnvio).toHaveBeenCalledTimes(1);
    expect(res.body).not.toHaveProperty('bundle');
    expect(res.body).toMatchObject({ uuid: 'envio-1', name: 'Revisor de PR' });
    // Sem o diretório entre parênteses: não há o que desempatar num envio só.
    expect(criarEnvio.mock.calls[0]![0].sourceFilename).toBe('pacote.zip');
  });

  /*
   * Decisão do mantenedor: se a raiz do pacote (já sem o embrulho) traz um
   * `SKILL.md`, o pacote é **uma** skill, e os `SKILL.md` de subpasta são
   * conteúdo dela. É a leitura do pedido ("um bundle pode ser uma única skill
   * OU possuir skills em sub-diretórios") e preserva o formato de template de
   * skill, que leva um `SKILL.md` de exemplo em `references/`.
   *
   * Medido antes da regra, com `SKILL.md` na raiz e `references/SKILL.md`: o
   * pacote contava como **duas** skills. Em produção respondia o 400 de
   * "pacote com mais de uma skill"; na quarentena virava um bundle de dois
   * envios, e o envio principal **perdia** o arquivo de exemplo. É a mesma
   * forma que `zip.test.ts` já fixava como pacote legítimo de uma skill só.
   */
  describe('SKILL.md de exemplo numa subpasta da própria skill', () => {
    const TEMPLATE: Record<string, Buffer | string> = {
      'SKILL.md': skillMd('criador-de-skills', 'Criador de Skills'),
      'references/SKILL.md': '# Um SKILL.md de exemplo\n',
      'references/guia.md': '# Guia\n',
    };

    it('a quarentena recebe um envio só, com o exemplo dentro dele', async () => {
      const { res } = await importarPacote(zipDe(TEMPLATE), { destination: 'quarantine' });

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toHaveProperty('bundle');
      expect(criarEnvio).toHaveBeenCalledTimes(1);

      const envio = criarEnvio.mock.calls[0]![0];
      expect(envio).toMatchObject({ name: 'Criador de Skills', sourceFilename: 'pacote.zip' });
      expect((envio.files as { relativePath: string }[]).map((file) => file.relativePath).sort()).toEqual([
        'SKILL.md',
        'references/SKILL.md',
        'references/guia.md',
      ]);
    });

    it('em produção nasce uma skill só, com o exemplo entre os anexos', async () => {
      const { input, res } = await importarPacote(zipDe(TEMPLATE), { destination: 'production' });

      expect(res.statusCode).toBe(201);
      expect(input).toMatchObject({ slug: 'criador-de-skills', name: 'Criador de Skills' });
      // O principal é o da raiz — `isSkillMd` compara o caminho inteiro, e o de
      // `references/` é anexo como qualquer outro arquivo.
      expect((input.files as { relativePath: string }[]).map((file) => file.relativePath).sort()).toEqual([
        'references/SKILL.md',
        'references/guia.md',
      ]);
    });

    // O contrapeso: sem `SKILL.md` na raiz vale a regra de bundle, e cada
    // subpasta que tenha um volta a ser uma skill irmã — é o repositório de
    // terceiro do teste lá de cima, e a regra desta seção não o alcança.
    it('sem SKILL.md na raiz, as subpastas voltam a ser skills irmãs', async () => {
      const { res } = await importarPacote(
        zipDe({
          'README.md': '# repositório\n',
          'primeira/SKILL.md': skillMd('primeira', 'Primeira'),
          'segunda/SKILL.md': skillMd('segunda', 'Segunda'),
        }),
        { destination: 'quarantine' },
      );

      expect(res.statusCode).toBe(201);
      expect(res.body).toMatchObject({ bundle: true });
      expect(criarEnvio).toHaveBeenCalledTimes(2);
    });

    /*
     * O teto de skills do pacote não vale para uma skill só: quem a mede é o
     * teto de arquivos. Sem isso, a skill que leva mais subpastas de exemplo
     * que `BUNDLE_MAX_SKILLS` seria recusada por "ter skills demais" — e ela
     * tem uma.
     */
    it('a skill com mais subpastas de exemplo que o teto de skills entra', async () => {
      const entradas: Record<string, string> = { 'SKILL.md': skillMd('exemplos', 'Exemplos') };
      for (let i = 0; i <= DEFAULT_MAX_BUNDLE_SKILLS; i += 1) {
        entradas[`exemplos/${i}/SKILL.md`] = `# Exemplo ${i}\n`;
      }

      const { res } = await importarPacote(zipDe(entradas), { destination: 'quarantine' });

      expect(res.statusCode).toBe(201);
      expect(criarEnvio).toHaveBeenCalledTimes(1);
      expect((criarEnvio.mock.calls[0]![0].files as unknown[]).length).toBe(
        DEFAULT_MAX_BUNDLE_SKILLS + 2,
      );
    });

    /*
     * A **causa**, e não o efeito do teste acima. A primeira versão desta regra
     * fazia o pacote entrar mandando `maxSkills: Number.MAX_SAFE_INTEGER` ao
     * `splitBundle` — desligava o `BUNDLE_MAX_SKILLS` para contornar uma
     * contagem que não interessava. A resposta é a mesma das duas formas, então
     * o que este teste olha é a chamada: com a raiz sendo a skill, não há
     * divisão a pedir, e o teto nunca chega a ser afrouxado.
     */
    it('a raiz que é skill não pede divisão nenhuma, e nenhum teto é desligado', async () => {
      const entradas: Record<string, string> = { 'SKILL.md': skillMd('exemplos', 'Exemplos') };
      for (let i = 0; i < 300; i += 1) {
        entradas[`exemplos/${i}/SKILL.md`] = `# Exemplo ${i}\n`;
      }

      const { res } = await importarPacote(zipDe(entradas), { destination: 'quarantine' });

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toHaveProperty('bundle');
      expect(criarEnvio).toHaveBeenCalledTimes(1);
      // Um envio com **todos** os arquivos: a raiz e as 300 subpastas.
      expect((criarEnvio.mock.calls[0]![0].files as unknown[]).length).toBe(301);
      // E a recusa por "skills demais" não acontece porque não há o que contar,
      // não porque o teto foi posto de lado.
      expect(divisor).not.toHaveBeenCalled();
    });

    /*
     * O que não pode se perder junto com a divisão: montado do zero, o envio
     * único continua levando **todo** o pacote. O `.github/` e o `docs/` ficam
     * de fora quando eles é que são vizinhos de skills irmãs; com a raiz sendo
     * a skill, eles estão *dentro* dela e entram como qualquer anexo.
     */
    it('o envio único leva todo o pacote, inclusive o que não é de skill nenhuma', async () => {
      const { res } = await importarPacote(
        zipDe({
          'SKILL.md': skillMd('criador-de-skills', 'Criador de Skills'),
          'README.md': '# criador\n',
          '.github/workflows/ci.yml': 'name: ci\n',
          'docs/uso.md': '# Uso\n',
          'references/SKILL.md': '# Um SKILL.md de exemplo\n',
          'scripts/gerar.sh': 'echo oi\n',
        }),
        { destination: 'quarantine' },
      );

      expect(res.statusCode).toBe(201);
      const envio = criarEnvio.mock.calls[0]![0];
      expect((envio.files as { relativePath: string }[]).map((file) => file.relativePath).sort()).toEqual([
        '.github/workflows/ci.yml',
        'README.md',
        'SKILL.md',
        'docs/uso.md',
        'references/SKILL.md',
        'scripts/gerar.sh',
      ]);
      // O `SKILL.md` da raiz abre a lista: é o principal, e é ele que a fila
      // mostra e a promoção lê.
      expect((envio.files as { relativePath: string }[])[0]!.relativePath).toBe('SKILL.md');
    });

    /*
     * A canonização do principal, que a montagem direta tem de continuar
     * fazendo: o `skill.md` da raiz vira `SKILL.md` (o porquê está em
     * `paths.ts`). Aqui ele só chega em minúscula depois do aparo de embrulho —
     * o `extractArchive` canoniza pelo caminho inteiro, e `revisor/skill.md`
     * não é o principal enquanto o `revisor/` está na frente.
     */
    it('o `skill.md` que vira raiz depois do aparo é canonizado', async () => {
      const { res } = await importarPacote(
        zipDe({
          'revisor/skill.md': skillMd('revisor-de-pr', 'Revisor de PR'),
          'revisor/ref/notas.md': '# Notas\n',
        }),
        { destination: 'quarantine' },
      );

      expect(res.statusCode).toBe(201);
      const envio = criarEnvio.mock.calls[0]![0];
      expect(envio).toMatchObject({ name: 'Revisor de PR' });
      expect((envio.files as { relativePath: string }[]).map((file) => file.relativePath)).toEqual([
        'SKILL.md',
        'ref/notas.md',
      ]);
    });

    /*
     * O contrapeso do teste acima, e a razão de ele importar: no bundle de
     * verdade o teto continua recusando o pacote. Se um dia alguém voltar a
     * afrouxá-lo para resolver o caso da raiz, esta recusa cai junto.
     */
    it('sem SKILL.md na raiz, passar do teto de skills continua sendo 400', async () => {
      const entradas: Record<string, string> = { 'README.md': '# repositório\n' };
      for (let i = 0; i <= DEFAULT_MAX_BUNDLE_SKILLS; i += 1) {
        entradas[`skills/${i}/SKILL.md`] = skillMd(`skill-${i}`, `Skill ${i}`);
      }

      const { res } = await importarPacote(zipDe(entradas), { destination: 'quarantine' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        error: 'bad_request',
        message: expect.stringMatching(/skills demais/),
      });
      expect(criarEnvio).not.toHaveBeenCalled();
      // A rota não manda teto de skills nenhum: quem o escolhe é o `shared`,
      // pelo `BUNDLE_MAX_SKILLS`.
      expect(divisor).toHaveBeenCalledTimes(1);
      expect(divisor.mock.calls[0]![1]).not.toHaveProperty('maxSkills');
    });

    /*
     * O teto de arquivos passa a medir a skill **inteira**: a subpasta não é
     * uma skill à parte, então o que está nela conta no mesmo envio. Cada
     * diretório aqui cabe sozinho no teto (1 e 512) e a soma não cabe.
     */
    it('o teto por envio mede a raiz e a subpasta juntas', async () => {
      const entradas: Record<string, string> = {
        'SKILL.md': skillMd('grande', 'Grande'),
        'references/SKILL.md': '# Um SKILL.md de exemplo\n',
      };
      for (let i = 0; i < MAX_FILES_POR_ENVIO - 1; i += 1) {
        entradas[`references/${i}.md`] = `# ${i}\n`;
      }

      const { res } = await importarPacote(zipDe(entradas), { destination: 'quarantine' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        error: 'bad_request',
        message: expect.stringMatching(/raiz do pacote.*513 arquivos.*512/s),
      });
      expect(criarEnvio).not.toHaveBeenCalled();
    });

    /*
     * O mesmo teto sem nenhum `SKILL.md` de subpasta, que é o caso em que o
     * envio único é montado do zero: quem conta os arquivos é a própria rota, e
     * não o `splitBundle`. Exatamente no teto ainda entra; um acima, 400.
     */
    it('o teto por envio vale mesmo sem subpasta de exemplo alguma', async () => {
      const entradas = (quantos: number): Record<string, string> => {
        const saida: Record<string, string> = { 'SKILL.md': skillMd('grande', 'Grande') };
        for (let i = 0; i < quantos - 1; i += 1) saida[`ref/${i}.md`] = `# ${i}\n`;
        return saida;
      };

      const cabe = await importarPacote(zipDe(entradas(MAX_FILES_POR_ENVIO)), {
        destination: 'quarantine',
      });
      expect(cabe.res.statusCode).toBe(201);
      expect((criarEnvio.mock.calls[0]![0].files as unknown[]).length).toBe(MAX_FILES_POR_ENVIO);

      const passa = await importarPacote(zipDe(entradas(MAX_FILES_POR_ENVIO + 1)), {
        destination: 'quarantine',
      });
      expect(passa.res.statusCode).toBe(400);
      expect(passa.res.body).toMatchObject({
        message: expect.stringMatching(
          new RegExp(`raiz do pacote.*${MAX_FILES_POR_ENVIO + 1} arquivos.*${MAX_FILES_POR_ENVIO}`, 's'),
        ),
      });
      expect(criarEnvio).toHaveBeenCalledTimes(1);
      expect(divisor).not.toHaveBeenCalled();
    });
  });

  /*
   * Melhoria intencional sobre o `stripSingleRootDir` do `extractZip`, que só
   * tirava a pasta raiz quando o `SKILL.md` estava **logo** dentro dela: um
   * `.zip` de repositório com `archive/skills/foo/SKILL.md` entrava torto, com
   * `skills/foo/` grudado em todo caminho do envio. Agora quem resolve prefixo
   * é o `splitBundle`, e ele parte do diretório da skill.
   */
  it('a pasta do repositório some dos caminhos, mesmo com a skill mais fundo', async () => {
    await importarPacote(
      zipDe({
        'superpowers-main/skills/foo/SKILL.md': skillMd('foo', 'Foo'),
        'superpowers-main/skills/foo/ref/notas.md': '# Notas\n',
      }),
      { destination: 'quarantine' },
    );

    const arquivos = criarEnvio.mock.calls[0]![0].files as { relativePath: string }[];
    expect(arquivos.map((file) => file.relativePath).sort()).toEqual(['SKILL.md', 'ref/notas.md']);
  });

  // A extensão é dica, a assinatura decide (decisão 24): o que muda de um
  // formato para o outro é o envelope, não o que a rota faz com o conteúdo.
  it('`.tar.gz` com duas skills funciona igual ao `.zip`', async () => {
    const { res } = await importarPacote(
      tarGzDe({
        // O `README.md` da raiz não é enfeite: com ele, `skills/` deixa de ser
        // o primeiro segmento comum a todas as entradas e o aparo de embrulho
        // não o alcança — é o repositório de verdade, não um pacote que é só
        // uma pasta.
        'README.md': '# skills\n',
        'skills/alfa/SKILL.md': skillMd('alfa', 'Alfa'),
        'skills/beta/SKILL.md': skillMd('beta', 'Beta'),
      }),
      { destination: 'quarantine' },
      admin,
      'skills.tar.gz',
    );

    expect(res.statusCode).toBe(201);
    expect(criarEnvio).toHaveBeenCalledTimes(2);
    expect(res.body).toMatchObject({ bundle: true, sourceFilename: 'skills.tar.gz' });
    const corpo = res.body as QuarantineBundleResult;
    expect(corpo.imported.map((skill) => skill.path)).toEqual(['skills/alfa', 'skills/beta']);
  });

  /*
   * Decisão 23: o formato é detectado pela assinatura e recusado com o nome
   * dele, em vez de cair no "arquivo inválido" genérico — quem manda um `.rar`
   * precisa saber que a recusa é de propósito, e não ficar procurando defeito
   * num arquivo que está inteiro.
   */
  it('`.rar` é 400 com o formato na mensagem, e nada é gravado', async () => {
    // A assinatura do RAR 5: `Rar!` seguido de 1A 07 01 00.
    const rar = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, 0x00]);

    const { res } = await importarPacote(rar, { destination: 'quarantine' }, admin, 'pacote.rar');

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/RAR/) });
    expect(criarEnvio).not.toHaveBeenCalled();
    expect(criar).not.toHaveBeenCalled();
  });

  /*
   * Decisão 22: recusar o pacote inteiro obrigaria a editar o `.zip` de
   * terceiro para conseguir importar qualquer coisa dele. A pulada é reportada
   * em `skipped` para não virar silêncio.
   */
  it('a skill acima do teto de arquivos é pulada, e as irmãs entram', async () => {
    const entradas: Record<string, Buffer | string> = {
      'README.md': '# skills\n',
      'skills/alfa/SKILL.md': skillMd('alfa', 'Alfa'),
      'skills/beta/SKILL.md': skillMd('beta', 'Beta'),
      'skills/gigante/SKILL.md': skillMd('gigante', 'Gigante'),
    };
    // Com o próprio SKILL.md, um arquivo acima do teto por envio.
    for (let i = 0; i < MAX_FILES_POR_ENVIO; i += 1) {
      entradas[`skills/gigante/ref/${i}.md`] = `# ${i}\n`;
    }

    const { res } = await importarPacote(zipDe(entradas), { destination: 'quarantine' });

    expect(res.statusCode).toBe(201);
    expect(criarEnvio).toHaveBeenCalledTimes(2);
    const corpo = res.body as QuarantineBundleResult;
    expect(corpo.imported.map((skill) => skill.path)).toEqual(['skills/alfa', 'skills/beta']);
    expect(corpo.skipped).toEqual([
      { path: 'skills/gigante', reason: 'too_many_files', fileCount: MAX_FILES_POR_ENVIO + 1 },
    ]);
  });

  /*
   * A mesma decisão com uma irmã só: o corpo continua sendo o do bundle, ainda
   * que uma única skill tenha entrado — o `QuarantineDetail` não tem onde dizer
   * o que ficou de fora, e a pulada viraria silêncio. É a célula do meio da
   * matriz: 1 entrando, 1 pulada, 201.
   */
  it('com uma entrando e uma pulada, o corpo ainda é o do bundle', async () => {
    const entradas: Record<string, string> = {
      'README.md': '# skills\n',
      'skills/alfa/SKILL.md': skillMd('alfa', 'Alfa'),
      'skills/gigante/SKILL.md': skillMd('gigante', 'Gigante'),
    };
    for (let i = 0; i < MAX_FILES_POR_ENVIO; i += 1) {
      entradas[`skills/gigante/ref/${i}.md`] = `# ${i}\n`;
    }

    const { res } = await importarPacote(zipDe(entradas), { destination: 'quarantine' });

    expect(res.statusCode).toBe(201);
    expect(criarEnvio).toHaveBeenCalledTimes(1);
    const corpo = res.body as QuarantineBundleResult;
    expect(corpo.bundle).toBe(true);
    expect(corpo.imported.map((skill) => skill.path)).toEqual(['skills/alfa']);
    expect(corpo.skipped.map((skill) => skill.path)).toEqual(['skills/gigante']);
  });

  /*
   * Decisão 12 no bundle: o `SKILL.md` que não é UTF-8 entra byte a byte e não
   * derruba o pacote. O rótulo cai para o nome do **diretório**, e não para o
   * do arquivo enviado — num bundle ele é o mesmo para todas as skills.
   */
  it('SKILL.md em Windows-1252 no meio do bundle entra como binário', async () => {
    // `# Instruções` em Windows-1252: o `ç` e o `õ` são um byte cada.
    const windows1252 = Buffer.from([0x23, 0x20, 0x49, 0x6e, 0x73, 0x74, 0x72, 0x75, 0xe7, 0xf5, 0x65, 0x73, 0x0a]);

    const { res } = await importarPacote(
      zipDe({
        'README.md': '# skills\n',
        'skills/alfa/SKILL.md': skillMd('alfa', 'Alfa'),
        'skills/torta/SKILL.md': windows1252,
      }),
      { destination: 'quarantine' },
    );

    expect(res.statusCode).toBe(201);
    expect(criarEnvio).toHaveBeenCalledTimes(2);
    const torta = criarEnvio.mock.calls[1]![0];
    expect(torta).toMatchObject({ name: 'torta', description: '' });
    const arquivos = torta.files as { relativePath: string; content: Buffer }[];
    expect(arquivos[0]!.content.equals(windows1252)).toBe(true);
  });

  /*
   * Decisão 12 sem bundle nenhum: sem `SKILL.md` em lugar nenhum não há o que
   * fatiar, e o pacote entra inteiro, como veio. Quem cobra o arquivo é a
   * aprovação, que sem ele não sabe que skill criar.
   */
  it('pacote sem SKILL.md nenhum entra como um envio só, com os arquivos crus', async () => {
    const { res } = await importarPacote(
      zipDe({ 'ref/notas.md': '# Notas\n', 'src/index.js': 'export default 1;\n' }),
      { destination: 'quarantine' },
    );

    expect(res.statusCode).toBe(201);
    expect(res.body).not.toHaveProperty('bundle');
    expect(criarEnvio).toHaveBeenCalledTimes(1);
    const envio = criarEnvio.mock.calls[0]![0];
    expect(envio).toMatchObject({ name: 'pacote', sourceFilename: 'pacote.zip' });
    expect((envio.files as { relativePath: string }[]).map((file) => file.relativePath).sort()).toEqual([
      'ref/notas.md',
      'src/index.js',
    ]);
  });

  /*
   * O teto por envio (decisão 14) no ramo do pacote torto, que é o único que
   * o `splitBundle` não mede: sem skill não há o que medir por skill, e o
   * `extractArchive` lê até 20 000 entradas contra as 512 de um envio. A
   * regressão era real — com o `extractZip`, cujo `maxEntries` é 512, o pacote
   * torto nunca passava —, e o absurdo dela é que o mesmo conteúdo seria
   * recusado **com** um SKILL.md dentro e entrava **sem** ele.
   */
  describe('teto de arquivos do pacote sem SKILL.md', () => {
    const arquivos = (quantos: number): Record<string, string> =>
      Object.fromEntries(
        Array.from({ length: quantos }, (_, i) => [`pacote/arquivo-${i}.md`, `# ${i}\n`]),
      );

    it('acima do teto é 400, com a contagem e o limite na mensagem', async () => {
      const { res } = await importarPacote(zipDe(arquivos(600)), { destination: 'quarantine' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        error: 'bad_request',
        message: expect.stringMatching(/600 arquivos.*nenhum SKILL\.md.*limite é 512 por envio/s),
      });
      // Truncar faria o envio mentir sobre o pacote: ou entra inteiro, ou não entra.
      expect(criarEnvio).not.toHaveBeenCalled();
    });

    it('exatamente no teto ainda entra', async () => {
      const { res } = await importarPacote(
        zipDe(arquivos(MAX_FILES_POR_ENVIO)),
        { destination: 'quarantine' },
      );

      expect(res.statusCode).toBe(201);
      expect(criarEnvio).toHaveBeenCalledTimes(1);
      expect((criarEnvio.mock.calls[0]![0].files as unknown[]).length).toBe(MAX_FILES_POR_ENVIO);
    });

    it('bem abaixo do teto continua entrando como um envio só, como hoje', async () => {
      const { res } = await importarPacote(zipDe(arquivos(10)), { destination: 'quarantine' });

      expect(res.statusCode).toBe(201);
      expect(res.body).not.toHaveProperty('bundle');
      expect(criarEnvio).toHaveBeenCalledTimes(1);
      expect((criarEnvio.mock.calls[0]![0].files as unknown[]).length).toBe(10);
    });

    /*
     * A guarda é **só** do ramo sem skill: o pacote de uma skill acima do teto
     * é medido pelo `splitBundle`, e cair nesta mensagem ali diria "nenhum
     * SKILL.md" sobre um pacote que tem um.
     *
     * E a recusa é **400**, não o 201 de antes: com a única skill pulada, nada
     * foi criado, e o corpo saía `imported: []` — um "Created" que não criou
     * nada, lido pelo painel como importação bem-sucedida de coisa nenhuma.
     */
    it('a skill acima do teto é 400 pelo `skipped`, não por esta guarda', async () => {
      const gigante: Record<string, string> = {
        'README.md': '# skills\n',
        'skills/gigante/SKILL.md': skillMd('gigante', 'Gigante'),
      };
      for (let i = 0; i < MAX_FILES_POR_ENVIO; i += 1) {
        gigante[`skills/gigante/ref/${i}.md`] = `# ${i}\n`;
      }

      const { res } = await importarPacote(zipDe(gigante), { destination: 'quarantine' });

      expect(res.statusCode).toBe(400);
      expect(res.body).toMatchObject({
        error: 'bad_request',
        message: expect.stringMatching(
          new RegExp(`skills/gigante.*${MAX_FILES_POR_ENVIO + 1} arquivos.*${MAX_FILES_POR_ENVIO}`, 's'),
        ),
      });
      // A mensagem é a da skill pulada, não a do pacote sem SKILL.md.
      expect(res.body).toMatchObject({ message: expect.not.stringMatching(/nenhum SKILL\.md/) });
      expect(criarEnvio).not.toHaveBeenCalled();
    });
  });

  /*
   * Decisão 26: a quarentena é uma fila, não um lote atômico. O que já entrou
   * fica e o erro sobe — desfazer devolveria ao ponto de partida quem viu o
   * pacote de quarenta morrer na trigésima nona, sem nada para olhar.
   */
  it('falha no meio do bundle mantém o que já entrou e propaga o erro', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    criarEnvio
      .mockResolvedValueOnce({ uuid: 'envio-1', name: 'Alfa', fileCount: 1, ownerUserUuid: null, ownerEmail: null })
      .mockRejectedValueOnce(new Error('banco fora do ar'));

    const { res } = await importarPacote(
      zipDe({
        'README.md': '# skills\n',
        'skills/alfa/SKILL.md': skillMd('alfa', 'Alfa'),
        'skills/beta/SKILL.md': skillMd('beta', 'Beta'),
        'skills/gama/SKILL.md': skillMd('gama', 'Gama'),
      }),
      { destination: 'quarantine' },
    );

    expect(res.statusCode).toBe(500);
    // A terceira nem é tentada, e a primeira não é desfeita: não há como.
    expect(criarEnvio).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });

  /*
   * O outro lado da decisão 26, que faltava: não desfazer é uma coisa, deixar
   * quem importou sem saber é outra. Medido, com o banco falhando na 2ª de 3
   * skills: a resposta era `500 {"error":"internal_error","message":"Erro
   * interno"}` — nada que dissesse que a 1ª já estava na fila e que ela
   * precisava ser conferida antes de reenviar o pacote.
   *
   * O formato não muda: continua 500 com `error: 'internal_error'`, porque é o
   * corpo de erro do projeto. Só a `message` passa a dizer o que aconteceu, e a
   * causa interna continua no log — junto com os uuids do que foi gravado, que
   * é por onde se acha o envio no painel.
   */
  it('a falha no meio diz que parte do pacote entrou, e loga o que já foi gravado', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    criarEnvio
      .mockResolvedValueOnce({ uuid: 'envio-1', name: 'Alfa', fileCount: 1, ownerUserUuid: null, ownerEmail: null })
      .mockRejectedValueOnce(new Error('banco fora do ar'));

    const { res } = await importarPacote(
      zipDe({
        'README.md': '# skills\n',
        'skills/alfa/SKILL.md': skillMd('alfa', 'Alfa'),
        'skills/beta/SKILL.md': skillMd('beta', 'Beta'),
        'skills/gama/SKILL.md': skillMd('gama', 'Gama'),
      }),
      { destination: 'quarantine' },
      admin,
      'superpowers-main.zip',
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: 'internal_error' });
    const mensagem = (res.body as { message: string }).message;
    expect(mensagem).toMatch(/parou na skill 2 de 3/);
    expect(mensagem).toMatch(/quarentena/);
    expect(mensagem).toMatch(/confira a fila/);
    // A causa interna não vaza para quem chamou, como em qualquer 500 da rota.
    expect(mensagem).not.toMatch(/banco fora do ar/);

    // O log leva o erro de origem e o uuid do envio que ficou: sem ele o
    // `console.error` do `fail()` some, porque a falha passa a ser um
    // `AppError`.
    const linha = log.mock.calls.find((call) => String(call[0]).includes('falha no meio do pacote'));
    expect(linha).toBeDefined();
    expect(String(linha![0])).toContain('superpowers-main.zip');
    expect(String(linha![0])).toContain('envio-1');
    expect((linha![1] as Error).message).toBe('banco fora do ar');
    log.mockRestore();
  });

  // O contrapeso: falhando na **primeira**, nada entrou, e não há fila a
  // conferir — a resposta continua sendo o 500 mudo de sempre, pelo `fail()`.
  it('falha na primeira skill continua sendo o 500 de sempre', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    criarEnvio.mockRejectedValueOnce(new Error('banco fora do ar'));

    const { res } = await importarPacote(
      zipDe({
        'README.md': '# skills\n',
        'skills/alfa/SKILL.md': skillMd('alfa', 'Alfa'),
        'skills/beta/SKILL.md': skillMd('beta', 'Beta'),
      }),
      { destination: 'quarantine' },
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ error: 'internal_error', message: 'Erro interno' });
    expect(criarEnvio).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
