import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import AdmZip from 'adm-zip';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const { ADMIN, db } = vi.hoisted(() => ({
  ADMIN: {
    uuid: 'uuid-admin',
    email: 'admin@exemplo.dev',
    name: 'Admin',
    role: 'admin',
    mustChangePassword: false,
    legacy: false,
  },
  db: {
    getSkillSummary: vi.fn(),
    getSkillDetail: vi.fn(),
    getVirtualMcp: vi.fn(),
    listSkills: vi.fn(),
    readFile: vi.fn(),
    setFile: vi.fn(),
    setFiles: vi.fn(),
  },
}));

// Só o que estas rotas leem e gravam é trocado: o resto do pacote entra de
// verdade, e nada nele abre conexão em tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  ...db,
}));

// A sessão não é o assunto daqui: toda requisição entra como o admin acima. O
// resto do roteador é o de verdade — guardas, `express.json`, multer e rota.
vi.mock('./auth.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = ADMIN;
    next();
  },
}));

const { REFERRER_POLICY_PRIVATE, securityHeaders } = await import('@purple-skills/shared');
const { api, nulGuard } = await import('./api.js');
const { onError } = await import('./errors.js');

/**
 * As rotas de arquivo da skill, por HTTP de verdade. Chamar o handler direto não
 * mostra o que decide estes casos: como o Express 5 entrega o curinga `*path`
 * (segmentos já decodificados), o que `res.send` faz com o `Content-Type` e o
 * `ETag`, e os cabeçalhos que o `index.ts` aplica a toda resposta.
 */

const skill = {
  uuid: '3f2b8c4e-1a6d-4b7f-9c0e-8d5a2f1b6c37',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  icon: null,
  tags: ['git'],
  isActive: true,
  isPublic: false,
  ownerUserUuid: 'uuid-admin',
  ownerEmail: 'admin@exemplo.dev',
  access: 'owner',
  mcps: [],
  catalogs: [],
};

let running: Server | undefined;
let porta = 0;

beforeEach(async () => {
  vi.clearAllMocks();
  db.getSkillSummary.mockImplementation(async (slug: string) => (slug === skill.slug ? skill : null));
  db.setFile.mockImplementation(async (_slug: string, relativePath: string, content: string) => ({
    relativePath,
    mimeType: 'text/markdown',
    sizeBytes: Buffer.byteLength(content),
    isText: true,
  }));
  db.setFiles.mockResolvedValue([]);

  const app = express();
  // Os mesmos cabeçalhos de página que o `index.ts` põe em toda resposta.
  const pageHeaders = securityHeaders({ referrerPolicy: REFERRER_POLICY_PRIVATE });
  app.use((_req, res, next) => {
    for (const [nome, valor] of Object.entries(pageHeaders)) res.setHeader(nome, valor);
    next();
  });
  app.use(api);
  app.use(onError);

  await new Promise<void>((resolve) => {
    running = app.listen(0, '127.0.0.1', () => {
      porta = (running!.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(() => {
  running?.close();
  running = undefined;
  vi.restoreAllMocks();
});

type Resposta = { status: number; headers: IncomingHttpHeaders; body: Buffer };

/**
 * `path` vai como está para a linha da requisição: `http.request(url)` e
 * `fetch` passam pelo `URL`, que resolve `./` e troca `\` por `/` antes de
 * enviar — justamente as grafias que estes testes precisam mandar cruas.
 */
function pedir(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: Buffer } = {},
): Promise<Resposta> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: porta,
        method,
        path,
        headers: {
          ...options.headers,
          ...(options.body ? { 'content-length': String(options.body.byteLength) } : {}),
        },
      },
      (res) => {
        const pedacos: Buffer[] = [];
        res.on('data', (chunk: Buffer) => pedacos.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(pedacos) }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const json = (res: Resposta) => JSON.parse(res.body.toString('utf8')) as Record<string, unknown>;

const gravar = (path: string, content: string) =>
  pedir('PUT', `/api/skills/minha-skill/files/${path}`, {
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ content }), 'utf8'),
  });

const LIMITE = 'limiteDoTeste';

/** Corpo `multipart/form-data` montado à mão: arquivos em `campo`, mais campos de texto. */
function multipart(campo: string, arquivos: [string, Buffer][], campos: Record<string, string> = {}) {
  const partes: Buffer[] = [];
  for (const [nome, valor] of Object.entries(campos)) {
    partes.push(Buffer.from(`--${LIMITE}\r\nContent-Disposition: form-data; name="${nome}"\r\n\r\n${valor}\r\n`, 'utf8'));
  }
  for (const [filename, content] of arquivos) {
    partes.push(
      Buffer.from(
        `--${LIMITE}\r\nContent-Disposition: form-data; name="${campo}"; filename="${filename}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
      ),
      content,
      Buffer.from('\r\n'),
    );
  }
  partes.push(Buffer.from(`--${LIMITE}--\r\n`));
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${LIMITE}` },
    body: Buffer.concat(partes),
  };
}

function zipDe(entradas: Record<string, Buffer | string>): Buffer {
  const zip = new AdmZip();
  for (const [nome, conteudo] of Object.entries(entradas)) {
    zip.addFile(nome, Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'utf8'));
  }
  return zip.toBuffer();
}

/** `preço;ação\n` como o Excel exporta: Windows-1252, 11 bytes, UTF-8 inválido. */
const CSV_1252 = Buffer.from([0x70, 0x72, 0x65, 0xe7, 0x6f, 0x3b, 0x61, 0xe7, 0xe3, 0x6f, 0x0a]);
/** `# Instruções\n` em Windows-1252: o `ç` e o `õ` são um byte cada. */
const SKILL_MD_1252 = Buffer.from([0x23, 0x20, 0x49, 0x6e, 0x73, 0x74, 0x72, 0x75, 0xe7, 0xf5, 0x65, 0x73, 0x0a]);

type Gravado = { relativePath: string; content: Buffer };
const gravados = () => db.setFiles.mock.calls[0]![1] as Gravado[];

/**
 * "Abrir cru" serve conteúdo de terceiro **na origem do painel** (relatório 014
 * da auditoria de 2026-09-19). A CSP com `sandbox` e o `Content-Disposition`
 * só valem quando o arquivo é aberto como documento; carregado como
 * sub-recurso por uma página do painel, quem decide é a CSP **da página**
 * (`script-src 'self'`), e o que barra o script é o par `text/plain` + `nosniff`.
 */
describe('GET /api/skills/:slug/files/*path?raw — "abrir cru"', () => {
  const arquivo = (relativePath: string, mimeType: string, conteudo: Buffer | string) => ({
    relativePath,
    mimeType,
    isText: typeof conteudo === 'string',
    sizeBytes: Buffer.byteLength(conteudo),
    buffer: Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'utf8'),
  });

  it.each([
    ['scripts/run.js', 'text/javascript', 'alert(document.cookie)'],
    ['scripts/run.mjs', 'text/javascript', 'export default 1'],
    ['tema.css', 'text/css', 'body{display:none}'],
    ['pagina.html', 'text/html', '<script>alert(1)</script>'],
    ['logo.svg', 'image/svg+xml', '<svg onload="alert(1)"/>'],
  ])('%s desce como text/plain, com nosniff: o navegador não o executa como sub-recurso', async (path, mime, conteudo) => {
    db.readFile.mockResolvedValue(arquivo(path, mime, conteudo));

    const res = await pedir('GET', `/api/skills/minha-skill/files/${path}?raw`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Aberto como documento, numa aba: a CSP da resposta, não a das páginas.
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    // O texto continua lá: "abrir cru" mostra o arquivo, só não o roda.
    expect(res.body.toString('utf8')).toBe(conteudo);
  });

  it('imagem e markdown mantêm o tipo: a pré-visualização usa esta rota como <img src>', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    db.readFile.mockResolvedValue(arquivo('img/logo.png', 'image/png', png));
    const imagem = await pedir('GET', '/api/skills/minha-skill/files/img/logo.png?raw');

    expect(imagem.headers['content-type']).toBe('image/png');
    expect(imagem.body.equals(png)).toBe(true);

    db.readFile.mockResolvedValue(arquivo('ref/a.md', 'text/markdown', '# A'));
    const texto = await pedir('GET', '/api/skills/minha-skill/files/ref/a.md?raw');

    expect(texto.headers['content-type']).toBe('text/markdown; charset=utf-8');
  });

  // Conteúdo de skill privada: nenhum cache compartilhado guarda, e o navegador
  // revalida a cada uso — com o `ETag`, a imagem que não mudou volta como 304.
  it('manda Cache-Control: private, no-cache e revalida pelo ETag', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    db.readFile.mockResolvedValue(arquivo('img/logo.png', 'image/png', png));

    const primeira = await pedir('GET', '/api/skills/minha-skill/files/img/logo.png?raw');
    expect(primeira.headers['cache-control']).toBe('private, no-cache');
    expect(primeira.headers.etag).toBeTruthy();

    const segunda = await pedir('GET', '/api/skills/minha-skill/files/img/logo.png?raw', {
      headers: { 'if-none-match': String(primeira.headers.etag) },
    });
    expect(segunda.status).toBe(304);
    expect(segunda.body.byteLength).toBe(0);
    expect(segunda.headers['cache-control']).toBe('private, no-cache');
  });
});

/**
 * O `PUT` decidia "é o SKILL.md?" com o caminho **cru**, e o banco canoniza
 * depois: uma grafia torta do arquivo principal escapava do `stripFrontmatter`
 * e o bloco enviado ia para a linha do `SKILL.md` — invisível em toda leitura,
 * mas dentro do índice de busca e do texto do RAG (relatório 016 da auditoria
 * de 2026-09-19). É o mesmo defeito que o `set_file` do MCP administrativo já
 * tinha corrigido.
 */
describe('PUT /api/skills/:slug/files/*path', () => {
  const COM_FRONTMATTER = '---\nname: outra\ndescription: palavras escondidas\n---\n# Corpo\n';

  it.each([
    ['.%5CSKILL.md', 'barra invertida codificada: um segmento só, que vira "./SKILL.md"'],
    ['./SKILL.md', 'ponto-segmento literal'],
    ['.//SKILL.md', 'segmento vazio no meio'],
    ['skill.MD', 'outra caixa'],
    ['SKILL.md', 'a grafia canônica'],
  ])('%s (%s) grava só o corpo, na linha do SKILL.md', async (path) => {
    const res = await gravar(path, COM_FRONTMATTER);

    expect(res.status).toBe(200);
    expect(db.setFile).toHaveBeenCalledTimes(1);
    const [slug, relativePath, content] = db.setFile.mock.calls[0]!;
    expect(slug).toBe('minha-skill');
    expect(relativePath).toBe('SKILL.md');
    expect(content).toBe('# Corpo\n');
  });

  it('arquivo comum que começa por "---" é gravado inteiro: a limpeza é só do SKILL.md', async () => {
    const res = await gravar('docs/a.md', COM_FRONTMATTER);

    expect(res.status).toBe(200);
    expect(db.setFile.mock.calls[0]!.slice(1, 3)).toEqual(['docs/a.md', COM_FRONTMATTER]);
  });

  it('SKILL.md de subpasta não é o principal: entra inteiro, no caminho dele', async () => {
    await gravar('exemplos/SKILL.md', COM_FRONTMATTER);

    expect(db.setFile.mock.calls[0]!.slice(1, 3)).toEqual(['exemplos/SKILL.md', COM_FRONTMATTER]);
  });

  it.each([['..%2Ffora.md'], ['ref%2F..%2F..%2FSKILL.md'], ['C:%5Cfora.md']])(
    'caminho que não normaliza (%s) é 400, sem chegar ao banco',
    async (path) => {
      const res = await gravar(path, 'x');

      expect(res.status).toBe(400);
      expect(json(res)).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/^Caminho inválido: /) });
      expect(db.setFile).not.toHaveBeenCalled();
    },
  );
});

/**
 * O envio avulso é o único caminho que decodifica o `SKILL.md` **antes** do
 * banco, e `toString('utf8')` não falha com byte inválido: troca cada um por
 * U+FFFD, sem erro e sem volta (relatório 015 da auditoria de 2026-09-19). O
 * banco recebia um texto já "consertado" e não tinha como recusar.
 */
describe('POST /api/skills/:slug/files — envio avulso', () => {
  const enviar = (arquivos: [string, Buffer][], campos: Record<string, string> = {}) =>
    pedir('POST', '/api/skills/minha-skill/files', multipart('files', arquivos, campos));

  it('SKILL.md em Windows-1252 é 400, e nada é gravado — nem os vizinhos do lote', async () => {
    const res = await enviar([
      ['notas.md', Buffer.from('# ok\n', 'utf8')],
      ['SKILL.md', SKILL_MD_1252],
    ]);

    expect(res.status).toBe(400);
    expect(json(res)).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/UTF-8 válido/) });
    expect(db.setFiles).not.toHaveBeenCalled();
  });

  it('SKILL.md com byte nulo é 400: binário, viraria corpo vazio para o MCP e a busca', async () => {
    const res = await enviar([['skill.md', Buffer.from([0x23, 0x20, 0x61, 0x00, 0x62])]]);

    expect(res.status).toBe(400);
    expect(db.setFiles).not.toHaveBeenCalled();
  });

  it('SKILL.md em UTF-8 entra só com o corpo, acentos intactos', async () => {
    const res = await enviar([['SKILL.md', Buffer.from('---\nname: outra\n---\n# Instruções\n', 'utf8')]]);

    expect(res.status).toBe(200);
    expect(gravados()).toHaveLength(1);
    expect(gravados()[0]!.relativePath).toBe('SKILL.md');
    expect(gravados()[0]!.content.toString('utf8')).toBe('# Instruções\n');
  });

  it('anexo que não é UTF-8 segue com os bytes que chegaram: texto × binário é do banco', async () => {
    const res = await enviar([['dados.csv', CSV_1252]], { prefix: 'ref' });

    expect(res.status).toBe(200);
    expect(gravados()[0]!.relativePath).toBe('ref/dados.csv');
    expect(gravados()[0]!.content.equals(CSV_1252)).toBe(true);
  });

  it('SKILL.md dentro de pasta é arquivo comum: não é decodificado nem recusado', async () => {
    const res = await enviar([['SKILL.md', SKILL_MD_1252]], { prefix: 'exemplos' });

    expect(res.status).toBe(200);
    expect(gravados()[0]!.relativePath).toBe('exemplos/SKILL.md');
    expect(gravados()[0]!.content.equals(SKILL_MD_1252)).toBe(true);
  });
});

describe('POST /api/skills/:slug/upload — .zip numa skill existente', () => {
  const enviar = (zip: Buffer, query = '') =>
    pedir('POST', `/api/skills/minha-skill/upload${query}`, multipart('file', [['pacote.zip', zip]]));

  // Quem recusa é o `extractZip` (`ZipContentError`): sem isso o `SKILL.md`
  // chegava sem `textContent` e a rota gravava corpo vazio por cima do prompt.
  it('SKILL.md do .zip em Windows-1252 é 400, e o prompt gravado não muda', async () => {
    const res = await enviar(zipDe({ 'SKILL.md': SKILL_MD_1252, 'ref/a.md': '# a' }));

    expect(res.status).toBe(400);
    expect(json(res)).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/UTF-8 válido/) });
    expect(db.setFiles).not.toHaveBeenCalled();
  });

  it('anexo em Windows-1252 chega ao banco byte a byte igual ao do .zip', async () => {
    const res = await enviar(zipDe({ 'SKILL.md': '# Corpo\n', 'dados.csv': CSV_1252 }));

    expect(res.status).toBe(200);
    const csv = gravados().find((file) => file.relativePath === 'dados.csv');
    expect(csv?.content.equals(CSV_1252)).toBe(true);
  });

  /**
   * Relatório 075 da auditoria de 2026-09-19: raiz única **sem** `SKILL.md` é
   * subpasta, não embrulho. Antes o envio parcial de `scripts/` caía achatado na
   * raiz da skill, ao lado dos `scripts/…` antigos.
   */
  it('envio parcial de uma subpasta preserva a pasta nos caminhos', async () => {
    const res = await enviar(zipDe({ 'scripts/run.py': 'x', 'scripts/util.py': 'y' }));

    expect(res.status).toBe(200);
    expect(gravados().map((file) => file.relativePath).sort()).toEqual(['scripts/run.py', 'scripts/util.py']);
    // Importar sem "substituir a árvore": nada é removido.
    expect(db.setFiles.mock.calls[0]![3]).toEqual({ replace: false });
  });

  it('o pacote baixado (<slug>/SKILL.md) continua entrando sem o embrulho', async () => {
    const res = await enviar(
      zipDe({ 'minha-skill/SKILL.md': '---\nname: minha-skill\n---\n# Corpo\n', 'minha-skill/scripts/run.py': 'x' }),
      '?replace=1',
    );

    expect(res.status).toBe(200);
    expect(gravados().map((file) => file.relativePath).sort()).toEqual(['SKILL.md', 'scripts/run.py']);
    expect(gravados().find((file) => file.relativePath === 'SKILL.md')?.content.toString('utf8')).toBe('# Corpo\n');
    expect(db.setFiles.mock.calls[0]![3]).toEqual({ replace: true });
  });
});

/**
 * O Postgres não guarda U+0000 em `text`: um `%00` no slug, no caminho ou na
 * busca chegava ao driver e voltava como o erro 22021 cru — 500, com o SQL no
 * log (achado do relatório 038 da auditoria de 2026-09-19). Nenhum endereço do
 * painel tem uso legítimo para ele, então a recusa é uma só, na entrada.
 */
describe('caractere nulo na URL', () => {
  it('o guarda está montado antes de qualquer rota de /api, inclusive as anônimas', () => {
    const layers = (api as unknown as { stack: { handle?: unknown; route?: { path: string } }[] }).stack;
    const guarda = layers.findIndex((layer) => layer.handle === nulGuard);
    const primeiraRota = layers.findIndex((layer) => layer.route?.path.startsWith('/api/'));

    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(primeiraRota);
  });

  it.each([
    ['/api/skills/a%00b'],
    ['/api/skills/minha-skill/files/ref/a%00.md'],
    ['/api/skills?tag=a%00b'],
    ['/api/skills?q=x&tag=ok&tag=a%00b'],
    ['/api/mcps/time%00a'],
  ])('%s é 400, sem chegar ao banco', async (path) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await pedir('GET', path);

    expect(res.status).toBe(400);
    expect(json(res)).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/caractere nulo/) });
    expect(db.getSkillDetail).not.toHaveBeenCalled();
    expect(db.getSkillSummary).not.toHaveBeenCalled();
    expect(db.getVirtualMcp).not.toHaveBeenCalled();
    expect(db.listSkills).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('vale também para escrita', async () => {
    const res = await gravar('ref/a%00.md', 'x');

    expect(res.status).toBe(400);
    expect(db.setFile).not.toHaveBeenCalled();
  });

  it('o resto passa: "%2500" é o texto "%00", não o caractere', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });

    const res = await pedir('GET', '/api/skills?q=100%2500');

    expect(res.status).toBe(200);
    expect(db.listSkills).toHaveBeenCalledWith(expect.objectContaining({ query: '100%00' }));
  });
});
