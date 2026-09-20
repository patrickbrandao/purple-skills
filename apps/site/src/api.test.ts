import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type RequestHandler, type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * O site responde a quem não tem login: o JSON dele é **lista de permissão**
 * (`skillPublica` do `api.ts`). Estes testes cobram a lista campo por campo —
 * falham quando um campo novo de `SkillSummary` chega ao visitante anônimo sem
 * que alguém tenha decidido que pode, que é como o e-mail do dono e as
 * concessões vazaram (`tasks/002`).
 */

/** O erro de negócio do `@purple-skills/db`, como o `fail` o reconhece. */
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
  getSkillDetail: vi.fn(),
  getSkillSummary: vi.fn(),
  getPublicCatalog: vi.fn(),
  listPublicCatalogs: vi.fn(),
  listOpenVirtualMcps: vi.fn(),
  resolveDefaultVirtualMcp: vi.fn(),
  recordSkillAccess: vi.fn(async () => undefined),
  readAllFiles: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  listTags: vi.fn(),
  healthCheck: vi.fn(async () => true),
}));

// O teto da consulta é valor, não função, e o `api.ts` o importa do pacote
// (relatório 037 da auditoria de 2026-09-19): sem ele no mock não há o que
// importar. De propósito **não** é o 200 de produção: é o que prova que o corte
// sai da constante do `@purple-skills/db`, e não de um número escrito aqui.
const { TETO_DA_CONSULTA } = vi.hoisted(() => ({ TETO_DA_CONSULTA: 80 }));

vi.mock('@purple-skills/db', () => ({ ...db, AppError, SEARCH_QUERY_MAX_LENGTH: TETO_DA_CONSULTA }));

const { api } = await import('./api.js');

/**
 * Um vMCP como o banco o devolve na visibilidade do site: aberto e ligado, com
 * o caminho do vínculo (`direct`) e o catálogo por onde a skill chega — que
 * pode ser privado, basta estar ligado.
 */
const VMCP = {
  uuid: 'mcp-1',
  slug: 'public',
  name: 'Público',
  isOpen: true,
  isActive: true,
  isDefault: true,
  asSkill: true,
  asPrompt: false,
  asResource: false,
  direct: false,
  catalogs: [{ uuid: 'cat-9', slug: 'clientes-acme', name: 'Clientes Acme' }],
};

/** `SkillSummary` inteira, como `skillColumns` a monta — inclusive o dono. */
const SUMMARY = {
  uuid: 'skill-1',
  slug: 'minha-skill',
  name: 'Minha Skill',
  description: 'Faz coisas',
  icon: '🛠️',
  isActive: true,
  isPublic: true,
  ownerUserUuid: '11111111-1111-4111-8111-111111111111',
  ownerEmail: 'dona@exemplo.dev',
  access: null,
  mcps: [VMCP],
  catalogs: [],
  viewCount: 10,
  downloadCount: 3,
  score: 13,
  tags: ['git'],
  fileCount: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

/** Uma concessão, que `getSkillDetail` anexa em qualquer visibilidade. */
const GRANT = {
  userUuid: '22222222-2222-4222-8222-222222222222',
  email: 'colega@exemplo.dev',
  name: 'Colega',
  role: 'membro',
  level: 'manage',
  grantedByUserUuid: '11111111-1111-4111-8111-111111111111',
  grantedByEmail: 'dona@exemplo.dev',
  createdAt: '2026-01-03T00:00:00.000Z',
};

const DETAIL = {
  ...SUMMARY,
  skillMd: '---\nname: minha-skill\ndescription: Faz coisas\n---\n\n# Minha Skill\n',
  files: [{ relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 24, isText: true }],
  grants: [GRANT],
};

/** Exatamente o que o anônimo vê de uma skill. */
const CAMPOS_DA_SKILL = [
  'createdAt',
  'description',
  'downloadCount',
  'fileCount',
  'icon',
  'mcps',
  'name',
  'score',
  'slug',
  'tags',
  'updatedAt',
  'uuid',
  'viewCount',
];

/** E de cada vMCP: sem `direct` nem `catalogs`. */
const CAMPOS_DO_VMCP = [
  'asPrompt',
  'asResource',
  'asSkill',
  'isActive',
  'isDefault',
  'isOpen',
  'name',
  'slug',
  'uuid',
];

/** Os campos que não podem sair em nenhuma das rotas anônimas. */
const PROIBIDOS = ['ownerUserUuid', 'ownerEmail', 'grants', 'access', 'isPublic', 'isActive', 'catalogs'];

type Rota = { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] };

/**
 * O handler final da rota, pela pilha do Router (como em `admin/src/routes.test.ts`).
 * `router` só muda nos testes que reimportam o `api.ts` com outro ambiente.
 */
function handler(path: string, router: unknown = api): RequestHandler {
  const camadas = (router as { stack: { route?: Rota }[] }).stack;
  const achada = camadas.find((camada) => camada.route?.path === path && camada.route.methods.get);
  if (!achada?.route) throw new Error(`rota não registrada: GET ${path}`);
  const pilha = achada.route.stack;
  return pilha[pilha.length - 1]!.handle;
}

/**
 * Chama a rota e devolve o JSON — o `asyncRoute` não devolve promessa. `extra`
 * entra por cima da requisição falsa: a query string, quando o teste precisa dela.
 */
function chamar(
  path: string,
  params: Record<string, string> = {},
  router: unknown = api,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const res = {
      status: (code: number) => {
        reject(new Error(`resposta inesperada: ${code}`));
        return res;
      },
      json: (body: unknown) => {
        resolve(body as Record<string, unknown>);
        return res;
      },
    };
    const req = { params, query: {}, ip: '203.0.113.7', get: () => undefined, ...extra } as unknown as Request;
    handler(path, router)(req, res as unknown as Response, () => {});
  });
}

describe('o JSON anônimo do site', () => {
  // Sem esta guarda a suíte passaria com uma amostra anêmica: é o objeto do
  // banco, com dono, concessões e catálogo privado, que a projeção precisa cortar.
  it('a amostra do banco carrega tudo o que não pode sair', () => {
    for (const campo of PROIBIDOS) expect(DETAIL).toHaveProperty(campo);
    expect(VMCP.catalogs.length).toBeGreaterThan(0);
  });

  it('a lista de skills leva só os campos da página', async () => {
    db.listSkills.mockResolvedValue({
      items: [SUMMARY],
      total: 1,
      limit: 24,
      offset: 0,
      mode: 'text',
      neighbors: [],
    });

    const body = await chamar('/api/skills');
    const item = (body.items as Record<string, unknown>[])[0]!;

    expect(Object.keys(item).sort()).toEqual(CAMPOS_DA_SKILL);
    expect(Object.keys((item.mcps as Record<string, unknown>[])[0]!).sort()).toEqual(CAMPOS_DO_VMCP);
    // `neighbors` é do servidor (`docs/14-rag.md` §8.1).
    expect(body).not.toHaveProperty('neighbors');
    expect(body.mode).toBe('text');
    expect(body.total).toBe(1);
  });

  it('o detalhe da skill não leva dono nem concessões', async () => {
    db.getSkillDetail.mockResolvedValue(DETAIL);

    const body = await chamar('/api/skills/:slug', { slug: 'minha-skill' });

    expect(Object.keys(body).sort()).toEqual([...CAMPOS_DA_SKILL, 'files', 'skillMd'].sort());
    for (const campo of PROIBIDOS) expect(body).not.toHaveProperty(campo);
    // O frontmatter sai do corpo: os metadados já são campos do JSON.
    expect(body.skillMd).toBe('# Minha Skill\n');
    // A leitura conta, como antes.
    expect(body.viewCount).toBe(11);
    expect(body.score).toBe(14);
  });

  /**
   * O padrão pode ser um vMCP **fechado** — `resolveDefaultVirtualMcp` não
   * filtra visibilidade, porque `/mcp` responde nele com chave. A descrição é
   * texto livre e saía por aqui para quem não tem login (`tasks/050`); o `GET /`
   * do mcp-public, que é a superfície de referência, anuncia só status, slug,
   * nome e auth (`docs/09` §3.2).
   */
  it('o /api/meta não leva a descrição do vMCP padrão, nem quando ele é fechado', async () => {
    db.resolveDefaultVirtualMcp.mockResolvedValue({
      status: 'ok',
      mcp: {
        uuid: 'mcp-9',
        slug: 'clientes',
        name: 'Clientes',
        description: 'Skills da conta Acme, contato joana@acme.example',
        isOpen: false,
      },
    });

    const body = await chamar('/api/meta');
    const mcp = body.mcp as Record<string, unknown>;

    expect(Object.keys(mcp).sort()).toEqual(['name', 'requiresKey', 'slug', 'status']);
    expect(mcp.requiresKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain('Acme');
  });

  it('os membros do catálogo público passam pela mesma projeção', async () => {
    db.getPublicCatalog.mockResolvedValue({
      uuid: 'cat-1',
      slug: 'meu-catalogo',
      name: 'Meu catálogo',
      description: 'Uma prateleira',
      skillCount: 1,
      skills: [SUMMARY],
    });

    const body = await chamar('/api/catalogs/:slug', { slug: 'meu-catalogo' });
    const membro = (body.skills as Record<string, unknown>[])[0]!;

    expect(Object.keys(membro).sort()).toEqual(CAMPOS_DA_SKILL);
    for (const campo of PROIBIDOS) expect(membro).not.toHaveProperty(campo);
    expect(body.skillCount).toBe(1);
  });
});

/**
 * O corte da consulta (`consultaDaBusca`) não tinha teste nenhum no site, e o
 * teto era uma cópia local do 200 do banco — a outra vivia no mcp-public. Agora
 * o número vem do `@purple-skills/db`, e o mock dele é outro de propósito
 * (relatório 037 da auditoria de 2026-09-19).
 */
describe('o corte da consulta em GET /api/skills', () => {
  const VAZIO = { items: [], total: 0, limit: 24, offset: 0, mode: 'text', neighbors: [] };
  const ultimaConsulta = () => db.listSkills.mock.calls.at(-1)![0].query as string;

  it('corta no teto do banco, na última palavra inteira, e as duas pernas leem o mesmo texto', async () => {
    db.listSkills.mockResolvedValue(VAZIO);
    const { buscaSemantica } = await import('./rag.js');
    const espiao = vi.spyOn(buscaSemantica, 'resolver');
    const longa = 'padronizar a mensagem de commit em português '.repeat(10);

    await chamar('/api/skills', {}, api, { query: { q: longa } });

    const cortada = ultimaConsulta();
    expect(cortada.length).toBeLessThanOrEqual(TETO_DA_CONSULTA);
    expect(cortada.length).toBeGreaterThan(TETO_DA_CONSULTA - 16);
    // Prefixo da consulta, sem palavra partida e sem espaço sobrando no fim.
    expect(longa.startsWith(cortada)).toBe(true);
    expect(cortada).toMatch(/\S$/);
    expect(longa.slice(cortada.length, cortada.length + 1)).toMatch(/\s/);
    // E é esse texto — não o cru — que iria ao provedor de embeddings.
    expect(espiao).toHaveBeenCalledWith(cortada);

    espiao.mockRestore();
  });

  it('consulta sem espaço é cortada no limite, sem deixar meio par surrogate', async () => {
    db.listSkills.mockResolvedValue(VAZIO);
    // O emoji ocupa duas unidades e cai bem em cima do limite.
    const blob = `${'x'.repeat(TETO_DA_CONSULTA - 1)}${String.fromCodePoint(0x1f44d)}${'x'.repeat(300)}`;

    await chamar('/api/skills', {}, api, { query: { q: blob } });

    expect(ultimaConsulta()).toBe('x'.repeat(TETO_DA_CONSULTA - 1));
  });

  it('consulta curta passa inteira, e a vazia vira nula', async () => {
    db.listSkills.mockResolvedValue(VAZIO);

    await chamar('/api/skills', {}, api, { query: { q: '  commits convencionais  ' } });
    expect(ultimaConsulta()).toBe('commits convencionais');

    await chamar('/api/skills', {}, api, { query: { q: '   ' } });
    expect(ultimaConsulta()).toBeNull();
  });
});

/**
 * `limit` e `offset` entram pelo `asInt`: lixo vale o padrão, nunca `NaN`. O
 * **teto** é do banco — `clamp` no limite e, desde o relatório 086 da auditoria
 * de 2026-09-19, `pageOffset` saturando o deslocamento. Um `?offset=` de 20
 * dígitos cabe num double, passa por aqui inteiro e era 500 (`OFFSET` é `bigint`);
 * hoje é a página vazia de quem paginou além do fim. Não há teto aqui de
 * propósito: seria a terceira cópia de uma regra que é do banco.
 */
describe('a paginação de GET /api/skills', () => {
  const VAZIO = { items: [], total: 0, limit: 24, offset: 0, mode: 'text', neighbors: [] };
  const paginaPedida = () => db.listSkills.mock.calls.at(-1)![0] as { limit: number; offset: number };

  it('lixo, vazio e parâmetro repetido caem no padrão ou no primeiro valor', async () => {
    db.listSkills.mockResolvedValue(VAZIO);

    await chamar('/api/skills', {}, api, { query: { limit: 'abc', offset: '' } });
    expect(paginaPedida()).toMatchObject({ limit: 24, offset: 0 });

    await chamar('/api/skills', {}, api, { query: { limit: ['12', '99'], offset: { a: '1' } } });
    expect(paginaPedida()).toMatchObject({ limit: 12, offset: 0 });
  });

  it('o offset gigante chega ao banco como número finito — quem satura é o pageOffset de lá', async () => {
    db.listSkills.mockResolvedValue(VAZIO);

    await chamar('/api/skills', {}, api, { query: { offset: '99999999999999999999' } });

    expect(paginaPedida().offset).toBe(1e20);
    expect(Number.isFinite(paginaPedida().offset)).toBe(true);
  });
});

/**
 * O cartão "API REST pública" da home dizia "CORS aberto" como literal fixo,
 * igual em toda instalação, enquanto `SITE_CORS_ORIGIN` fecha exatamente isso
 * (`tasks/078`). O dado que faltava na rota é o `corsOpen` — um booleano, e só
 * ele: a lista de origens nomeia a intranet de quem fechou, e não sai.
 *
 * O `config.ts` lê o ambiente na carga do módulo, então cada caso reimporta o
 * `api.ts` com a variável já no lugar.
 */
describe('o corsOpen do /api/meta', () => {
  const MCP_PADRAO = {
    status: 'ok',
    mcp: { uuid: 'mcp-1', slug: 'public', name: 'Público', description: '', isOpen: true },
  };

  /** O `/api/meta` de uma instalação com este `SITE_CORS_ORIGIN` (`undefined` = sem a variável). */
  async function metaCom(corsOrigin: string | undefined): Promise<Record<string, unknown>> {
    db.resolveDefaultVirtualMcp.mockResolvedValue(MCP_PADRAO);
    vi.resetModules();
    if (corsOrigin !== undefined) vi.stubEnv('SITE_CORS_ORIGIN', corsOrigin);
    try {
      const { api: outro } = await import('./api.js');
      return await chamar('/api/meta', {}, outro);
    } finally {
      vi.unstubAllEnvs();
    }
  }

  it('sem a variável, o padrão do projeto: aberto', async () => {
    const body = await metaCom(undefined);

    expect(body.corsOpen).toBe(true);
    // A rota inteira sai para o anônimo: campo novo entra aqui de propósito.
    expect(Object.keys(body).sort()).toEqual([
      'adminUrl',
      'baseUrl',
      'corsOpen',
      'mcp',
      'mcpAdminUrl',
      'mcpUrl',
      'name',
      'tagline',
    ]);
  });

  // É o que o compose repassa quando ninguém preenche: `SITE_CORS_ORIGIN: ${SITE_CORS_ORIGIN:-}`.
  it('vazia ou `*` continuam abertos', async () => {
    expect((await metaCom('')).corsOpen).toBe(true);
    expect((await metaCom('*')).corsOpen).toBe(true);
  });

  it('com origens, diz restrito — e não diz quais', async () => {
    const body = await metaCom('https://intranet.exemplo.local, https://wiki.exemplo.local');

    expect(body.corsOpen).toBe(false);
    expect(JSON.stringify(body)).not.toContain('exemplo.local');
  });

  it('o `origin` do cors() sai da mesma leitura', async () => {
    const { corsOrigins } = await import('./config.js');

    expect(corsOrigins('*')).toBe('*');
    expect(corsOrigins('https://intranet.exemplo.local')).toEqual(['https://intranet.exemplo.local']);
    expect(corsOrigins('https://a.exemplo.local , https://b.exemplo.local')).toEqual([
      'https://a.exemplo.local',
      'https://b.exemplo.local',
    ]);
  });
});

/**
 * `HEAD` é "só me diga o que teria aí": `wget --spider`, o gerenciador de
 * download que pergunta nome e tamanho antes do `GET`, o monitor de
 * disponibilidade. Nenhuma rota registra `head`, e o Express 5 manda o `HEAD`
 * para o handler de `GET` — então cada um contava como visita ou download de
 * verdade: linha permanente em `skill_accesses` e +1 no score que ordena a
 * vitrine. No pacote era pior: o servidor lia e comprimia a skill inteira para
 * jogar fora, sem a contrapressão de um corpo que ninguém recebe (relatório 066
 * da auditoria de 2026-09-19).
 *
 * O despacho faz parte do que se testa, por isso aqui o roteador sobe numa porta
 * e o pedido vai por `fetch`: o `req` falso de `chamar()` nem tem `method`.
 */
describe('HEAD não conta acesso nem gera o pacote', () => {
  const ARQUIVOS = [
    { relativePath: 'SKILL.md', mimeType: 'text/markdown', sizeBytes: 13, isText: true },
    { relativePath: 'ref/extra.md', mimeType: 'text/markdown', sizeBytes: 5, isText: true },
  ];
  const CONTEUDO: Record<string, string> = { 'SKILL.md': '# Minha Skill', 'ref/extra.md': 'extra' };

  let servidor: Server | undefined;

  function subir(): Promise<string> {
    db.recordSkillAccess.mockClear();
    db.listFiles.mockReset().mockResolvedValue(ARQUIVOS);
    db.readFile.mockReset().mockImplementation(async (_uuid: string, path: string) =>
      path in CONTEUDO
        ? { relativePath: path, mimeType: 'text/markdown', sizeBytes: 5, isText: true, buffer: Buffer.from(CONTEUDO[path]!) }
        : null,
    );
    db.getSkillSummary.mockResolvedValue(SUMMARY);
    db.getSkillDetail.mockResolvedValue(DETAIL);

    const app = express();
    app.use(api);
    return new Promise((resolve) => {
      servidor = app.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`);
      });
    });
  }

  /** O registro é disparado fora do caminho da resposta: dá a ele a vez de rodar. */
  const registroAssentou = () => new Promise((resolve) => setTimeout(resolve, 20));

  afterEach(async () => {
    await new Promise<void>((resolve) => (servidor ? servidor.close(() => resolve()) : resolve()));
    servidor = undefined;
  });

  it.each([
    ['/skills/minha-skill/download', 'zip'],
    ['/api/skills/minha-skill/download', 'zip'],
    ['/skills/minha-skill/download.skill', 'skill'],
    ['/api/skills/minha-skill/download.skill', 'skill'],
  ])('HEAD %s devolve os cabeçalhos do pacote, sem ler arquivo nenhum e sem contar download', async (rota, ext) => {
    const base = await subir();

    const res = await fetch(`${base}${rota}`, { method: 'HEAD' });
    await registroAssentou();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="minha-skill.${ext}"`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Nem a lista de arquivos: o pacote não chega a começar.
    expect(db.readFile).not.toHaveBeenCalled();
    expect(db.listFiles).not.toHaveBeenCalled();
    expect(db.recordSkillAccess).not.toHaveBeenCalled();
  });

  it.each([['/api/skills/minha-skill'], ['/skills/minha-skill/files/SKILL.md'], ['/api/skills/minha-skill/files/SKILL.md']])(
    'HEAD %s responde 200 sem contar visualização',
    async (rota) => {
      const base = await subir();

      const res = await fetch(`${base}${rota}`, { method: 'HEAD' });
      await registroAssentou();

      expect(res.status).toBe(200);
      expect(db.recordSkillAccess).not.toHaveBeenCalled();
    },
  );

  it('HEAD numa skill que o site não mostra continua 404', async () => {
    const base = await subir();
    db.getSkillSummary.mockResolvedValue(null);

    expect((await fetch(`${base}/skills/nao-existe/download`, { method: 'HEAD' })).status).toBe(404);
  });

  it('o GET equivalente segue contando: um download pelo pacote, uma visualização pela ficha e pelo SKILL.md', async () => {
    const base = await subir();

    const pacote = await fetch(`${base}/skills/minha-skill/download`);
    const zip = Buffer.from(await pacote.arrayBuffer());
    await registroAssentou();
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(db.readFile).toHaveBeenCalledTimes(ARQUIVOS.length);
    expect(db.recordSkillAccess).toHaveBeenCalledTimes(1);
    expect(db.recordSkillAccess).toHaveBeenLastCalledWith(
      expect.objectContaining({ skillUuid: 'skill-1', kind: 'download', surface: 'download', origin: 'site' }),
    );

    await (await fetch(`${base}/api/skills/minha-skill`)).json();
    await registroAssentou();
    expect(db.recordSkillAccess).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'view', surface: 'page' }));

    await (await fetch(`${base}/skills/minha-skill/files/SKILL.md`)).text();
    await registroAssentou();
    expect(db.recordSkillAccess).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'view', surface: 'file' }));
    expect(db.recordSkillAccess).toHaveBeenCalledTimes(3);
  });
});

/**
 * O `text` do Postgres recusa U+0000 com 22021, e o slug chega cru à consulta:
 * `GET /api/skills/a%00b` era 500 na superfície anônima, com a SQL no log a cada
 * tentativa (achado do relatório 038 da auditoria de 2026-09-19; medido no site
 * de verdade: ficha, download, catálogo e `?tag=` davam 500). A guarda é uma só,
 * na entrada do roteador, e o teste vai pelo Express porque é o despacho — e a
 * decodificação do `%00` — que está em jogo.
 */
describe('caractere nulo na URL é 400, sem chegar ao banco', () => {
  let servidor: Server | undefined;

  const subir = (): Promise<string> => {
    const app = express();
    app.use(api);
    return new Promise((resolve) => {
      servidor = app.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`);
      });
    });
  };

  afterEach(async () => {
    await new Promise<void>((resolve) => (servidor ? servidor.close(() => resolve()) : resolve()));
    servidor = undefined;
  });

  it.each([
    ['/api/skills/a%00b'],
    ['/api/skills/a%00b/download'],
    ['/skills/a%00b/download.skill'],
    ['/skills/minha-skill/files/ref/a%00b.md'],
    ['/api/catalogs/a%00b'],
    ['/api/skills?tag=%00'],
    ['/api/skills?q=commit&tag=git%00'],
  ])('GET %s', async (rota) => {
    for (const consulta of [db.getSkillDetail, db.getSkillSummary, db.getPublicCatalog, db.listSkills]) consulta.mockClear();
    const base = await subir();

    const res = await fetch(`${base}${rota}`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request', message: 'O endereço não pode conter o caractere nulo (%00)' });
    for (const consulta of [db.getSkillDetail, db.getSkillSummary, db.getPublicCatalog, db.listSkills]) {
      expect(consulta).not.toHaveBeenCalled();
    }
  });

  it('a URL comum não é tocada pela guarda — inclusive com `%` codificado e zeros', async () => {
    db.listSkills.mockResolvedValue({ items: [], total: 0, limit: 24, offset: 0, mode: 'text', neighbors: [] });
    const base = await subir();

    // `%2500` é o texto "%00", não o nulo; `100%` e `00` são só caracteres.
    const res = await fetch(`${base}/api/skills?q=${encodeURIComponent('100% %00 00')}`);

    expect(res.status).toBe(200);
    expect(db.listSkills.mock.calls.at(-1)![0].query).toBe('100% %00 00');
  });
});
