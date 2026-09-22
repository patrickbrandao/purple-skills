import type { RequestHandler } from 'express';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';
// A rota de redefinição só chega à montagem do link com SMTP ligado.
process.env.SMTP_FROM ??= 'painel@teste.local';
process.env.SMTP_URL ??= 'smtp://localhost:1025';

const db = vi.hoisted(() => ({
  countUsers: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByUsername: vi.fn(),
  nextFreeUsername: vi.fn(),
  createUser: vi.fn(),
  recordAccountAudit: vi.fn(),
  listAuditPage: vi.fn(),
}));

// Só as duas leituras que as rotas anônimas fazem são trocadas — mais as duas
// escritas de `POST /api/users`, para o teste poder cobrar que a conta **não**
// foi criada: o resto do pacote entra de verdade, e nada nele abre conexão em
// tempo de import.
vi.mock('@purple-skills/db', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  countUsers: db.countUsers,
  getUserByEmail: db.getUserByEmail,
  getUserByUsername: db.getUserByUsername,
  nextFreeUsername: db.nextFreeUsername,
  createUser: db.createUser,
  recordAccountAudit: db.recordAccountAudit,
  // A trilha de auditoria: o teste da paginação de `/api/audit` confere o que chega aqui.
  listAuditPage: db.listAuditPage,
}));

const { requireAdmin, requireCreate, requireSettingsAdmin } = await import('./auth.js');
const { config, isInternalAddress, resetLinkBaseUrl } = await import('./config.js');
const { ownerFrom, withoutUuid } = await import('./access.js');
const { api, csrfGuard, sessionPayload } = await import('./api.js');

beforeEach(() => {
  db.countUsers.mockReset();
  db.getUserByEmail.mockReset();
  db.getUserByUsername.mockReset();
  db.nextFreeUsername.mockReset();
  // Sem colisão, o candidato derivado do nome volta como veio.
  db.nextFreeUsername.mockImplementation(async (base: string) => base);
  db.createUser.mockReset();
  db.recordAccountAudit.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * O papel exigido por cada rota é uma linha só no `api.ts` — fácil de esquecer
 * ao acrescentar um endpoint. Estes testes olham a pilha do Router e cobram o
 * guarda por identidade da função, não pelo nome.
 */

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: RequestHandler }[] };
};

function handlers(method: string, path: string): RequestHandler[] {
  const layers = (api as unknown as { stack: Layer[] }).stack;
  const found = layers.find((layer) => layer.route?.path === path && layer.route.methods[method]);
  if (!found?.route) throw new Error(`rota não registrada: ${method.toUpperCase()} ${path}`);
  return found.route.stack.map((entry) => entry.handle);
}

describe('papéis exigidos pelas rotas', () => {
  it('a trilha de auditoria é só de admin: os registros carregam e-mails', () => {
    expect(handlers('get', '/api/audit')).toContain(requireAdmin);
  });

  // A Atividade soma a instalação inteira — sessões, chamadas, leituras e
  // trilha de todo servidor e skill, inclusive os que a sessão não enxerga.
  // Mesma classe de dado da trilha, mesmo papel (`docs/18-atividade.md`,
  // decisão 1); sem recorte por vMCP na v1, um membro leria o movimento do
  // acervo alheio pela soma.
  it.each([
    ['get', '/api/activity'],
    ['get', '/api/activity/:day'],
  ])('%s %s exige admin: a Atividade soma a instalação inteira', (method, path) => {
    expect(handlers(method, path)).toContain(requireAdmin);
  });

  // Os números do painel não são de um objeto, mas também não ganham guarda de
  // papel: o recorte é por `viewer`, dentro do handler (`docs/12` §3.1). Um
  // portão de admin tiraria a tela de quem é membro — e a página de servidores,
  // que engole o 403, passaria a exibir "0 skills publicadas".
  it('os números do painel não têm guarda de papel: quem recorta é o viewer', () => {
    expect(handlers('get', '/api/stats')).not.toContain(requireAdmin);
    expect(handlers('get', '/api/stats')).not.toContain(requireCreate);
  });

  it.each([
    ['get', '/api/users'],
    ['post', '/api/users'],
    ['patch', '/api/users/:uuid'],
    ['post', '/api/users/:uuid/reset-password'],
    ['get', '/api/users/:uuid'],
    ['get', '/api/users/:uuid/keys'],
    ['delete', '/api/users/:uuid/keys/:id'],
    ['get', '/api/users/:uuid/accesses'],
  ])('%s %s exige admin', (method, path) => {
    expect(handlers(method, path)).toContain(requireAdmin);
  });

  // O vMCP padrão responde em /mcp para a instalação inteira: só admin escolhe.
  it.each([
    ['get', '/api/settings'],
    ['put', '/api/settings/default-mcp'],
    // A busca semântica é ajuste da instalação inteira, como o vMCP padrão.
    ['get', '/api/settings/rag'],
    ['put', '/api/settings/rag'],
    ['post', '/api/settings/rag/reindex'],
    ['post', '/api/settings/rag/refusals/clear'],
    ['get', '/api/settings/quarantine'],
    ['put', '/api/settings/quarantine'],
  ])('%s %s exige admin', (method, path) => {
    expect(handlers(method, path)).toContain(requireSettingsAdmin);
  });

  // Criar é o único guarda de papel fora da administração da instalação
  // (`docs/12-acesso-granular.md` decisão 12).
  it.each([
    ['post', '/api/skills'],
    ['post', '/api/skills/import'],
    ['post', '/api/mcps'],
    ['post', '/api/catalogs'],
  ])('%s %s exige papel de criação', (method, path) => {
    expect(handlers(method, path)).toContain(requireCreate);
  });

  // Clonar também é criar, mas o papel **não** entra como guarda na frente:
  // a rota resolve o original primeiro — quem não o enxerga recebe 404 — e
  // só então cobra `canCreate` (`access.assertCanCreate`). O papel continua
  // exigido; o que estes casos travam é o guarda voltar para a frente e
  // transformar o 404 de um slug alheio num 403 de papel.
  it.each([
    ['post', '/api/skills/:slug/clone'],
    ['post', '/api/mcps/:slug/clone'],
    ['post', '/api/catalogs/:slug/clone'],
  ])('%s %s confere o papel dentro do handler, depois do objeto', (method, path) => {
    expect(handlers(method, path)).not.toContain(requireCreate);
    expect(handlers(method, path)).not.toContain(requireAdmin);
  });

  // Tudo o mais é decidido pelo acesso ao objeto, dentro do handler — um
  // membro administra o que é seu ou lhe foi concedido, e nenhum guarda de
  // papel pode estar na frente.
  it.each([
    ['get', '/api/skills'],
    ['get', '/api/skills/:slug'],
    ['get', '/api/skills/:slug/accesses'],
    ['patch', '/api/skills/:slug'],
    ['delete', '/api/skills/:slug'],
    ['put', '/api/skills/:slug/files/*path'],
    ['post', '/api/skills/:slug/files/*path'],
    ['delete', '/api/skills/:slug/files/*path'],
    ['post', '/api/skills/:slug/files'],
    ['put', '/api/skills/:slug/access/:username'],
    ['delete', '/api/skills/:slug/access/:username'],
    ['put', '/api/skills/:slug/mcps/:mcp'],
    ['delete', '/api/skills/:slug/mcps/:mcp'],
    ['get', '/api/mcps/:slug'],
    ['patch', '/api/mcps/:slug'],
    ['delete', '/api/mcps/:slug'],
    ['put', '/api/mcps/:slug/skills'],
    ['post', '/api/mcps/:slug/keys'],
    ['put', '/api/mcps/:slug/access/:username'],
    ['put', '/api/mcps/:slug/canvas'],
    ['get', '/api/mcps/:slug/online'],
    ['get', '/api/mcps/:slug/sessions'],
    ['get', '/api/sessions'],
    ['get', '/api/catalogs/:slug'],
    ['get', '/api/catalogs/:slug/accesses'],
    ['patch', '/api/catalogs/:slug'],
    ['delete', '/api/catalogs/:slug'],
    ['put', '/api/catalogs/:slug/skills'],
    ['put', '/api/catalogs/:slug/skills/:skill'],
    ['delete', '/api/catalogs/:slug/skills/:skill'],
    ['put', '/api/catalogs/:slug/access/:username'],
    ['put', '/api/mcps/:slug/catalogs'],
    ['put', '/api/mcps/:slug/catalogs/:catalog'],
    ['delete', '/api/mcps/:slug/catalogs/:catalog'],
    ['get', '/api/users/lookup'],
    // A quarentena (`docs/15-quarentena.md`) não tem guarda de papel na
    // frente: quem enxerga um envio é decidido dentro do handler (dono, admin
    // e editor), e promover passa pela política da instalação. Submeter é que
    // exige `requireCreate` — mas isso acontece em `/api/skills/import`.
    ['get', '/api/quarantine'],
    ['get', '/api/quarantine/:uuid'],
    ['delete', '/api/quarantine/:uuid'],
    ['get', '/api/quarantine/:uuid/download'],
    ['post', '/api/quarantine/:uuid/promote'],
    ['get', '/api/quarantine/:uuid/files/*path'],
    ['put', '/api/quarantine/:uuid/files/*path'],
    ['post', '/api/quarantine/:uuid/files/*path'],
    ['delete', '/api/quarantine/:uuid/files/*path'],
  ])('%s %s é decidido pelo acesso ao objeto, não pelo papel', (method, path) => {
    expect(handlers(method, path)).not.toContain(requireCreate);
    expect(handlers(method, path)).not.toContain(requireAdmin);
  });

  it('a busca de contas vem antes da rota por uuid, para o Express não a engolir', () => {
    const layers = (api as unknown as { stack: Layer[] }).stack;
    const lookup = layers.findIndex((layer) => layer.route?.path === '/api/users/lookup');
    const byUuid = layers.findIndex((layer) => layer.route?.path === '/api/users/:uuid' && layer.route.methods.get);
    expect(lookup).toBeGreaterThan(-1);
    if (byUuid !== -1) expect(lookup).toBeLessThan(byUuid);
  });
});

/**
 * A busca de contas é aberta a qualquer sessão (decisão 13), então o que ela
 * devolve é superfície de ataque: o `uuid` da conta é o `sub` do cookie de
 * sessão, e entregá-lo com o papel de cada conta ativa diria a um membro qual
 * crachá forjar. Aqui a conta se identifica pelo **username**, e o `uuid` que
 * sai é apelido dele — o do banco não passa da camada do app.
 */
describe('GET /api/users/lookup: o uuid da conta não sai', () => {
  const doBanco = {
    uuid: '3f2b8c4e-1a6d-4b7f-9c0e-8d5a2f1b6c37',
    username: 'ana',
    name: 'Ana',
    role: 'admin' as const,
  };

  it('troca o uuid pelo username e mantém nome e papel', () => {
    expect(withoutUuid(doBanco)).toEqual({
      username: 'ana',
      name: 'Ana',
      role: 'admin',
      uuid: 'ana',
    });
  });

  it('o e-mail não sai por campo nenhum', () => {
    // A busca é aberta a qualquer conta logada: um endereço aqui seria o
    // vazamento que o `docs/19-username.md` fechou (decisão 10).
    expect(JSON.stringify(withoutUuid(doBanco))).not.toMatch(/\@/);
  });

  it('o uuid do banco não aparece em nenhum campo do payload', () => {
    expect(JSON.stringify(withoutUuid(doBanco))).not.toContain(doBanco.uuid);
  });
});

/**
 * Transferir dono chega por `ownerUserUuid`, e o painel manda ali o que a busca
 * devolveu: o **username**. O UUID cru continua aceito para quem integra pela
 * REST, mas nada além dos dois entra — antes, qualquer texto ia ao banco e
 * voltava 500. E-mail tem recusa própria (`docs/19-username.md` decisão 9).
 */
describe('ownerFrom', () => {
  const DONA = {
    uuid: '3f2b8c4e-1a6d-4b7f-9c0e-8d5a2f1b6c37',
    username: 'ana',
    avatarUpdatedAt: null,
    email: 'ana@exemplo.dev',
    name: 'Ana',
    role: 'editor' as const,
    mustChangePassword: false,
    legacy: false,
  };

  it('sem `ownerUserUuid` no corpo, não mexe no dono (nem confere acesso)', async () => {
    await expect(ownerFrom(DONA, null, undefined, 'skill')).resolves.toBeUndefined();
  });

  it('um UUID canônico passa inteiro, sem consultar o banco', async () => {
    await expect(ownerFrom(DONA, 'owner', ` ${DONA.uuid} `, 'skill')).resolves.toBe(DONA.uuid);
  });

  it.each([['a'], ['-ana'], ['ana..silva'], ['  '], [42], [{}]])(
    'recusa %j com 400, sem chegar ao banco',
    async (raw) => {
      await expect(ownerFrom(DONA, 'owner', raw, 'skill')).rejects.toMatchObject({
        status: 400,
        code: 'bad_request',
      });
      expect(db.getUserByUsername).not.toHaveBeenCalled();
    },
  );

  it('e-mail é 400 com mensagem própria, e não cai no formato genérico', async () => {
    // Quem manda um endereço aqui está integrando contra a API anterior: a
    // recusa precisa dizer que o e-mail **parou** de identificar contas, senão
    // "precisa ser o usuário" parece um erro de digitação.
    await expect(ownerFrom(DONA, 'owner', 'ana@exemplo.dev', 'skill')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('deixou de identificar contas'),
    });
    expect(db.getUserByUsername).not.toHaveBeenCalled();
  });

  it('um username de conta ativa vira o uuid dela', async () => {
    db.getUserByUsername.mockResolvedValue({ uuid: 'uuid-bia', username: 'bia', isActive: true });

    await expect(ownerFrom(DONA, 'owner', ' Bia ', 'skill')).resolves.toBe('uuid-bia');
    expect(db.getUserByUsername).toHaveBeenCalledWith('bia');
  });

  it('conta desativada é 404: dar o objeto a quem não entra não faz sentido', async () => {
    db.getUserByUsername.mockResolvedValue({ uuid: 'uuid-saiu', username: 'saiu', isActive: false });

    await expect(ownerFrom(DONA, 'owner', 'saiu', 'skill')).rejects.toMatchObject({ status: 404 });
  });

  it('sem ser dono, a transferência para antes de resolver a conta', async () => {
    await expect(ownerFrom(DONA, 'manage', 'outra', 'skill')).rejects.toMatchObject({ status: 403 });
  });
});

/** Resposta mínima que os handlers usam: status, JSON, cabeçalho e cookie. */
function fakeResponse() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    cookie() {
      return this;
    },
  };
}

/** O último handler da rota — depois dos guardas e dos parsers. */
function ultimo(method: string, path: string): RequestHandler {
  const pilha = handlers(method, path);
  return pilha[pilha.length - 1]!;
}

/** Chama o handler e espera o `route()` encaminhar uma eventual rejeição. */
async function chamar(method: string, path: string, req: Record<string, unknown>) {
  const res = fakeResponse();
  await ultimo(method, path)(req as never, res as never, (() => {}) as never);
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

describe('POST /api/skills com corpo de tipo errado', () => {
  it('recusa `skillMd` não-string com 400, sem chegar ao banco', async () => {
    // `stripFrontmatter` é a primeira coisa a tocar o valor: sem o guarda,
    // `(123).replace` estourava `TypeError` e virava 500.
    const pilha = handlers('post', '/api/skills');
    const handler = pilha[pilha.length - 1]!;
    const res = fakeResponse();

    await handler({ body: { name: 'Teste', skillMd: 123 } } as never, res as never, (() => {}) as never);
    // O handler é síncrono até a resposta; o `route()` só encaminha rejeições.
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request', message: 'O campo "skillMd" deve ser uma string' });
  });
});

describe('POST /api/skills/:slug/files/*path (criar arquivo)', () => {
  it.each([[123], [null], [{ texto: 'x' }]])('recusa `content` %j com 400, antes do acesso e do banco', async (content) => {
    const pilha = handlers('post', '/api/skills/:slug/files/*path');
    const handler = pilha[pilha.length - 1]!;
    const res = fakeResponse();

    // Sem `user`: se o handler passasse do guarda, `loadSkillSummary` estouraria.
    await handler(
      { params: { slug: 'x', path: ['notas.md'] }, body: { content } } as never,
      res as never,
      (() => {}) as never,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request', message: 'O campo "content" deve ser uma string' });
  });
});

/**
 * No Express 5 `req.body` é `undefined` sem corpo ou com `Content-Type` que não
 * é JSON (no 4 era `{}`). As rotas liam `body.campo` direto: `TypeError`, 500 e
 * uma linha de "erro inesperado" no log por requisição — três delas anônimas.
 */
describe('corpo ausente é 400, não 500', () => {
  const ADMIN = { uuid: 'u-1', username: 'admin', email: 'admin@teste.local', name: 'Admin', role: 'admin', mustChangePassword: false, legacy: false };

  const rotas: [string, string, Record<string, unknown>][] = [
    ['post', '/api/setup', { ip: '198.51.100.1' }],
    ['post', '/api/login', { ip: '198.51.100.2' }],
    ['post', '/api/password-reset/confirm', { ip: '198.51.100.3' }],
    ['post', '/api/me/password', { user: ADMIN }],
    ['post', '/api/users', { user: ADMIN }],
    ['patch', '/api/users/:uuid', { user: ADMIN, params: { uuid: 'u-2' } }],
    ['post', '/api/skills', { user: ADMIN }],
    ['patch', '/api/skills/:slug', { user: ADMIN, params: { slug: 'x' } }],
  ];

  it.each(rotas)('%s %s sem corpo responde 400 e não suja o log', async (method, path, req) => {
    db.countUsers.mockResolvedValue(0);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await chamar(method, path, { ...req, body: undefined });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/Content-Type: application\/json/) });
    expect(log).not.toHaveBeenCalled();
  });

  // O parser estrito aceita `[` além de `{`: lista solta também não é corpo.
  it('um array no lugar do objeto também é 400', async () => {
    const res = await chamar('post', '/api/login', { ip: '198.51.100.4', body: [] });

    expect(res.statusCode).toBe(400);
  });

  it('corpo presente segue para a validação de sempre', async () => {
    // E-mail sem senha: `loginWithPassword` recusa antes do banco.
    const res = await chamar('post', '/api/login', { ip: '198.51.100.5', body: { identifier: 'ana@exemplo.dev', password: '' } });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', message: 'Usuário, e-mail ou senha incorretos' });
  });
});

/**
 * O `append-field` do multer transforma campo repetido em array e `campo[x]` em
 * objeto sem protótipo: `.trim()` e até `String()` estouravam neles, como 500.
 */
describe('campo multipart repetido ou aninhado é 400, não 500', () => {
  const ADMIN = { uuid: 'u-1', username: 'admin', email: 'admin@teste.local', name: 'Admin', role: 'admin', mustChangePassword: false, legacy: false };
  const aninhado = () => Object.assign(Object.create(null) as Record<string, unknown>, { a: 'x' });

  function pacote(): Buffer {
    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('---\nname: minha-skill\n---\n# Corpo\n', 'utf8'));
    return zip.toBuffer();
  }

  it.each([
    ['name', ['a', 'b']],
    ['description', aninhado()],
    ['icon', ['🙂', '🙃']],
    ['tags', ['a', 'b']],
    ['mcps', aninhado()],
  ])('import: `%s` fora de texto simples é recusado antes de criar a skill', async (campo, valor) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Sem mock de `createSkill`: se o handler passasse, a ida ao banco viraria 500.
    const res = await chamar('post', '/api/skills/import', {
      user: ADMIN,
      file: { buffer: pacote(), originalname: 'pacote.zip' },
      body: Object.assign(Object.create(null) as Record<string, unknown>, { [campo]: valor }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request', message: expect.stringContaining(`"${campo}"`) });
    expect(log).not.toHaveBeenCalled();
  });

  it('envio avulso: `prefix[a]=x` é recusado antes de gravar', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await chamar('post', '/api/skills/:slug/files', {
      user: ADMIN,
      params: { slug: 'x' },
      files: [{ originalname: 'a.md', size: 2, buffer: Buffer.from('oi') }],
      body: Object.assign(Object.create(null) as Record<string, unknown>, { prefix: aninhado() }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request', message: expect.stringContaining('"prefix"') });
    expect(log).not.toHaveBeenCalled();
  });
});

/**
 * O link de redefinição é o único endereço do painel que sai por e-mail, e quem
 * pede é qualquer visitante: se a base viesse do `Host`, quem pede escolheria o
 * servidor que recebe o token da vítima.
 */
describe('base do link de redefinição de senha', () => {
  const publicUrlOriginal = config.publicUrl;

  beforeEach(() => {
    config.publicUrl = '';
  });

  afterEach(() => {
    config.publicUrl = publicUrlOriginal;
  });

  const enderecos: [string, boolean][] = [
    ['127.0.0.1', true],
    ['::1', true],
    ['::ffff:172.18.0.1', true],
    ['10.0.0.7', true],
    ['192.168.1.10', true],
    ['fd00::1', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['203.0.113.5', false],
    ['2001:db8::1', false],
    ['', false],
  ];

  it.each(enderecos)('isInternalAddress(%j) = %s', (ip, esperado) => {
    expect(isInternalAddress(ip)).toBe(esperado);
  });

  it('ADMIN_PUBLIC_URL tem prioridade e ignora o Host escolhido por quem pede', () => {
    config.publicUrl = 'https://painel.example.com';
    expect(resetLinkBaseUrl('https', 'evil.test', '203.0.113.5')).toBe('https://painel.example.com');
  });

  it('sem ADMIN_PUBLIC_URL, o Host só vale para pedido de rede interna', () => {
    expect(resetLinkBaseUrl('http', 'localhost:3001', '127.0.0.1')).toBe('http://localhost:3001');
    expect(resetLinkBaseUrl('http', 'painel.intranet.br', '::ffff:10.1.2.3')).toBe('http://painel.intranet.br');
    expect(resetLinkBaseUrl('https', 'evil.test', '203.0.113.5')).toBeNull();
    expect(resetLinkBaseUrl('https', 'evil.test', undefined)).toBeNull();
    expect(resetLinkBaseUrl('http', undefined, '127.0.0.1')).toBeNull();
  });

  /** Sem `email` no corpo o fluxo para antes do banco e do envio. */
  async function pedirRedefinicao(host: string | undefined, ip: string | undefined, body: unknown = {}) {
    const pilha = handlers('post', '/api/password-reset/request');
    const handler = pilha[pilha.length - 1]!;
    const res = fakeResponse();

    await handler(
      {
        protocol: 'https',
        ip,
        body,
        get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
      } as never,
      res as never,
      (() => {}) as never,
    );
    await new Promise((resolve) => setImmediate(resolve));
    return res;
  }

  it('pedido de fora sem ADMIN_PUBLIC_URL responde 503, sem montar link nenhum', async () => {
    const res = await pedirRedefinicao('evil.test', '203.0.113.5');
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: 'public_url_required',
      message:
        'Este painel ainda não conhece o próprio endereço público: peça a um ' +
        'administrador para redefinir sua senha',
    });
  });

  it('pedido de rede interna continua atendido (instalação local sem configuração)', async () => {
    const res = await pedirRedefinicao('localhost:3001', '172.18.0.1');
    expect(res.body).toEqual({ requested: true });
  });

  /**
   * A resposta não pode depender de haver conta — nem no tempo. Com conta o
   * pedido grava o link e conversa com o SMTP; sem conta, volta depois de um
   * SELECT. A rota esperava o pedido, e uma requisição bastava para classificar
   * o e-mail; a falha do SMTP ainda virava 500 só para quem tem conta.
   */
  describe('a resposta não espera o trabalho que depende de haver conta', () => {
    it('responde 200 mesmo com a consulta da conta ainda pendente', async () => {
      db.getUserByEmail.mockReturnValue(new Promise(() => {}));

      const res = await pedirRedefinicao('localhost:3001', '172.18.0.1', { email: 'Ana@Exemplo.dev' });

      expect(db.getUserByEmail).toHaveBeenCalledWith('ana@exemplo.dev');
      expect(res.statusCode).toBe(0);
      expect(res.body).toEqual({ requested: true });
    });

    it('uma falha no pedido vira log, não 500 — e não fica rejeição solta', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const soltas = vi.fn();
      process.on('unhandledRejection', soltas);
      db.getUserByEmail.mockRejectedValue(new Error('banco fora do ar'));

      try {
        const res = await pedirRedefinicao('localhost:3001', '172.18.0.1', { email: 'ana@exemplo.dev' });
        await new Promise((resolve) => setImmediate(resolve));

        expect(res.statusCode).toBe(0);
        expect(res.body).toEqual({ requested: true });
        expect(log).toHaveBeenCalledWith(
          '[admin] falha ao processar o pedido de redefinição de senha:',
          expect.objectContaining({ message: 'banco fora do ar' }),
        );
        expect(soltas).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', soltas);
      }
    });

    it('sem corpo nenhum a resposta é a mesma', async () => {
      const res = await pedirRedefinicao('localhost:3001', '172.18.0.1', undefined);
      expect(res.body).toEqual({ requested: true });
    });
  });
});

/**
 * A checagem de origem é a barreira das escritas que o navegador manda sem
 * preflight (multipart e POST sem corpo). Comparava só o nome do host: outra
 * porta da mesma máquina — same-site, com o cookie junto — passava.
 */
describe('csrfGuard: origem das escritas', () => {
  const publicUrlOriginal = config.publicUrl;
  const extrasOriginais = config.extraAllowedOrigins;

  afterEach(() => {
    config.publicUrl = publicUrlOriginal;
    config.extraAllowedOrigins = extrasOriginais;
  });

  function escrever(host: string | undefined, headers: Record<string, string>, method = 'POST') {
    const res = fakeResponse();
    const next = vi.fn();
    const get = (name: string) => headers[name.toLowerCase()];
    csrfGuard({ method, host, get } as never, res as never, next);
    return { res, next };
  }

  it('está montado no roteador, antes de qualquer rota de escrita', () => {
    const layers = (api as unknown as { stack: (Layer & { handle?: unknown })[] }).stack;
    const guarda = layers.findIndex((layer) => layer.handle === csrfGuard);
    const primeiraEscrita = layers.findIndex((layer) => layer.route?.methods.post);

    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeLessThan(primeiraEscrita);
  });

  it.each([
    ['http://localhost:3001', 'localhost:3001'],
    ['http://127.0.0.1:3001', '127.0.0.1:3001'],
    ['http://localhost:8080', 'localhost:8080'],
    ['http://[::1]:3001', '[::1]:3001'],
    ['http://localhost:3001', 'LOCALHOST:3001'],
    // Porta padrão: o navegador a omite no Origin; há proxy que a repassa no Host.
    ['https://painel.exemplo.com', 'painel.exemplo.com'],
    ['https://painel.exemplo.com', 'painel.exemplo.com:443'],
    ['http://painel.intranet.br', 'painel.intranet.br:80'],
  ])('a própria origem passa: Origin %s com Host %s', (origin, host) => {
    const { next } = escrever(host, { origin });
    expect(next).toHaveBeenCalled();
  });

  it.each([
    // O buraco: mesma máquina, outra porta (Inspector, site, dev server alheio).
    ['http://localhost:6274', 'localhost:3001'],
    ['http://localhost:3000', 'localhost:3001'],
    ['http://localhost', 'localhost:3001'],
    ['https://painel.exemplo.com:8443', 'painel.exemplo.com'],
    ['https://painel.exemplo.com', 'painel.exemplo.com:80'],
    ['https://outro.exemplo.com', 'painel.exemplo.com'],
    // Esquema fora de http(s) não é página do painel, mesmo com o host "certo".
    ['chrome-extension://localhost:3001', 'localhost:3001'],
  ])('outra origem é 403: Origin %s com Host %s', (origin, host) => {
    const { res, next } = escrever(host, { origin });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: 'forbidden' });
  });

  it('`Origin: null` (página em sandbox) é 403', () => {
    const { res, next } = escrever('localhost:3001', { origin: 'null' });

    expect(next).not.toHaveBeenCalled();
    expect(res.body).toEqual({ error: 'forbidden', message: 'Origem inválida' });
  });

  it('sem Origin passa: cliente que não é navegador', () => {
    expect(escrever('localhost:3001', {}).next).toHaveBeenCalled();
  });

  it('leitura não é conferida', () => {
    expect(escrever('localhost:3001', { origin: 'http://localhost:6274' }, 'GET').next).toHaveBeenCalled();
  });

  it('ADMIN_PUBLIC_URL vale como origem própria: proxy que não repassa a porta no Host', () => {
    config.publicUrl = 'https://painel.exemplo.com:8443';

    expect(escrever('painel.exemplo.com', { origin: 'https://painel.exemplo.com:8443' }).next).toHaveBeenCalled();
    // Só ela: outra porta do mesmo nome continua de fora.
    expect(escrever('painel.exemplo.com', { origin: 'https://painel.exemplo.com:9000' }).next).not.toHaveBeenCalled();
  });

  it('origem extra casa pela origem inteira: esquema, nome e porta', () => {
    config.extraAllowedOrigins = ['https://portal.exemplo.com:8443', 'app://portal'];

    const passa = (origin: string) =>
      escrever('painel.exemplo.com', { origin, 'sec-fetch-site': 'cross-site' }).next.mock.calls.length > 0;

    expect(passa('https://portal.exemplo.com:8443')).toBe(true);
    expect(passa('https://portal.exemplo.com')).toBe(false);
    expect(passa('http://portal.exemplo.com:8443')).toBe(false);
    // Origem opaca serializa como "null": duas delas não podem "bater".
    expect(passa('outro://qualquer')).toBe(false);
  });

  it('o esquema fica com o Sec-Fetch-Site: http → https do mesmo nome é same-site, não same-origin', () => {
    const origin = 'http://painel.exemplo.com';
    const host = 'painel.exemplo.com';

    expect(escrever(host, { origin, 'sec-fetch-site': 'same-site' }).next).not.toHaveBeenCalled();
    expect(escrever(host, { origin, 'sec-fetch-site': 'cross-site' }).next).not.toHaveBeenCalled();
    expect(escrever(host, { origin, 'sec-fetch-site': 'same-origin' }).next).toHaveBeenCalled();
    // Ausente (HTTP por IP de LAN, navegador antigo) não reprova ninguém.
    expect(escrever(host, { origin }).next).toHaveBeenCalled();
  });
});

/**
 * A janela por IP é o único freio das rotas anônimas de credencial. O painel
 * contava por `req.ip` cru, numa cópia local do limitador: quem tem um /64
 * trocava de endereço a cada tentativa e nunca era barrado.
 */
describe('limitador das rotas de credencial', () => {
  const TETO = config.loginIpMaxAttempts;
  /** E-mail sem senha: 401 de `loginWithPassword`, sem tocar o banco. */
  const tentar = (ip: string | undefined) =>
    chamar('post', '/api/login', { ip, body: { identifier: 'ana@exemplo.dev', password: '' } });

  it('IPv6 conta por /64: trocar de endereço dentro do prefixo não rende cota nova', async () => {
    for (let i = 1; i <= TETO; i += 1) {
      expect((await tentar(`2001:db8:1:2::${i.toString(16)}`)).statusCode).toBe(401);
    }

    const barrado = await tentar('2001:db8:1:2:ffff:ffff:ffff:ffff');
    expect(barrado.statusCode).toBe(429);
    expect(barrado.body).toMatchObject({ error: 'too_many_requests' });
    expect(Number(barrado.headers['retry-after'])).toBeGreaterThan(0);

    // O /64 vizinho é outro assinante.
    expect((await tentar('2001:db8:1:3::1')).statusCode).toBe(401);
  });

  it('IPv4 mapeado em IPv6 divide o balde com o IPv4', async () => {
    for (let i = 0; i < TETO; i += 1) await tentar(i % 2 === 0 ? '::ffff:192.0.2.10' : '192.0.2.10');

    expect((await tentar('192.0.2.10')).statusCode).toBe(429);
    expect((await tentar('::ffff:192.0.2.10')).statusCode).toBe(429);
    expect((await tentar('192.0.2.11')).statusCode).toBe(401);
  });

  it('login bem-sucedido zera o balde do /64 inteiro', async () => {
    // Login legado: sem conta nenhuma, a ADMIN_PASSWORD entra sozinha.
    db.countUsers.mockResolvedValue(0);
    for (let i = 1; i < TETO; i += 1) await tentar(`2001:db8:9:9::${i.toString(16)}`);

    const entrou = await chamar('post', '/api/login', {
      ip: '2001:db8:9:9::bbbb',
      body: { password: process.env.ADMIN_PASSWORD },
    });
    expect(entrou.body).toEqual({ authenticated: true, legacy: true });

    // Sem o `reset` na chave do /64, a primeira daqui já seria a TETO + 1.
    for (let i = 1; i <= TETO; i += 1) {
      expect((await tentar(`2001:db8:9:9::${i.toString(16)}`)).statusCode).toBe(401);
    }
    expect((await tentar('2001:db8:9:9::cccc')).statusCode).toBe(429);
  });
});

/**
 * A revogação em si está em `auth.test.ts`; aqui só a ligação da rota — sem
 * cookie ela não pode tocar o banco nem quebrar a volta ao login.
 */
describe('POST /api/logout', () => {
  it('sem sessão, responde 200 dizendo que não havia o que revogar', async () => {
    const pilha = handlers('post', '/api/logout');
    const handler = pilha[pilha.length - 1]!;
    const res = Object.assign(fakeResponse(), { clearCookie: () => undefined });

    await handler({ cookies: {} } as never, res as never, (() => {}) as never);
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.body).toEqual({ authenticated: false, revoked: false });
  });
});

/**
 * A sessão de bootstrap só existe com `users` vazia: a conta criada por ela
 * seria a **primeira**, e a primeira tem de ser o admin do `/api/setup`. Um
 * `membro` criado ali fechava o setup (404) e o login pela `ADMIN_PASSWORD`
 * (401) sem existir administrador — observado em 16/09/2026, e a volta era SQL à
 * mão (relatório 001 da auditoria de 2026-09-19). O painel já escondia a tela de
 * contas nessa sessão; a guarda era só de interface. A outra porta, o
 * auto-provisionamento por SSO com a tabela vazia, está em `accounts.test.ts`.
 */
describe('POST /api/users na sessão de bootstrap', () => {
  const BOOTSTRAP = { uuid: null, username: '', email: '', name: 'Administrador', role: 'admin', mustChangePassword: false, legacy: true };
  const ADMIN = { uuid: 'u-1', username: 'admin', email: 'admin@teste.local', name: 'Admin', role: 'admin', mustChangePassword: false, legacy: false };

  // Nem como `admin`: a conta nasceria sem o `onlyIfTableEmpty` do setup (a
  // corrida do primeiro administrador) e sem adotar o que a sessão criou.
  it.each([['membro'], ['editor'], ['admin']])('recusa criar a conta %s com 400, sem gravar nada', async (role) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    // O banco aceitaria: sem a guarda da rota, isto é um 201 com a conta criada.
    db.createUser.mockResolvedValue({ uuid: 'u-9', email: 'ana@exemplo.dev', name: 'Ana', role });

    const res = await chamar('post', '/api/users', {
      user: BOOTSTRAP,
      body: { email: 'ana@exemplo.dev', name: 'Ana', role },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request', message: expect.stringMatching(/sessão de bootstrap/) });
    expect(db.createUser).not.toHaveBeenCalled();
    expect(db.recordAccountAudit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('a recusa não depende do corpo: sem ele a resposta é a mesma', async () => {
    const res = await chamar('post', '/api/users', { user: BOOTSTRAP, body: undefined });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ message: expect.stringMatching(/sessão de bootstrap/) });
  });

  it('com conta de verdade, o administrador segue criando contas', async () => {
    db.createUser.mockResolvedValue({ uuid: 'u-2', email: 'ana@exemplo.dev', name: 'Ana', role: 'membro' });

    const res = await chamar('post', '/api/users', {
      user: ADMIN,
      body: { email: 'Ana@Exemplo.dev', name: 'Ana', role: 'membro' },
    });

    expect(res.statusCode).toBe(201);
    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'ana@exemplo.dev', role: 'membro' }));
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.create', actor: { userUuid: 'u-1', label: 'admin' } }),
    );
  });
});

/**
 * Campo de texto que não é texto, nas rotas de conta (achado do relatório 007 da
 * auditoria de 2026-09-19): `String()` de `{"toString":1}` lança `TypeError`, e
 * a rota respondia 500 com linha de "erro inesperado" no log. O resto das
 * combinações está em `accounts.test.ts`; aqui, que a resposta sai no formato de
 * erro do painel e o log fica limpo.
 */
describe('campo de texto que não é texto é 400, não 500', () => {
  const ADMIN = { uuid: 'u-1', username: 'admin', email: 'admin@teste.local', name: 'Admin', role: 'admin', mustChangePassword: false, legacy: false };
  const torto = { toString: 1 };

  const rotas: [string, string, Record<string, unknown>][] = [
    // Depois da `ADMIN_PASSWORD` correta: o setup só chega ao nome com ela.
    ['post', '/api/setup', { ip: '198.51.100.20', body: { adminPassword: process.env.ADMIN_PASSWORD, email: 'ana@exemplo.dev', name: torto, password: 'uma-senha-bem-longa' } }],
    ['post', '/api/users', { user: ADMIN, body: { email: 'ana@exemplo.dev', name: torto, role: 'membro' } }],
    ['post', '/api/me/keys', { user: ADMIN, body: { name: torto } }],
  ];

  it.each(rotas)('%s %s responde 400 com o nome do campo e não suja o log', async (method, path, req) => {
    db.countUsers.mockResolvedValue(0);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await chamar(method, path, req);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request', message: 'O campo "name" deve ser uma string' });
    expect(db.createUser).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

/**
 * `GET /api/session` é registrada **antes** do `requireAuth`, de propósito: a
 * tela de login depende dela. Por isso o corpo anônimo não pode levar o que só
 * as telas de dentro mostram — a de "Ambiente" não faz chamada própria, então
 * a trava de papel dela seria apenas visual.
 */
describe('GET /api/session', () => {
  const OPERACAO = ['siteBaseUrl', 'mcpPublicUrl', 'links', 'onlineWindowMs', 'rag', 'version'];

  it('sem sessão, entrega só o que a tela de login usa', () => {
    const body = sessionPayload(null, 3) as Record<string, unknown>;

    // Lista fechada: um campo novo aqui é uma decisão, não um descuido.
    expect(Object.keys(body).sort()).toEqual([
      'authenticated',
      'brand',
      'legacyLogin',
      'needsSetup',
      'oidc',
      'passwordResetByEmail',
      'siteName',
      'user',
    ]);
    for (const campo of OPERACAO) expect(body).not.toHaveProperty(campo);
  });

  it('com sessão, os campos de operação voltam', () => {
    const body = sessionPayload(
      {
        uuid: 'u-1',
        username: 'admin',
        avatarUpdatedAt: null,
        email: 'admin@teste.local',
        name: 'Admin',
        role: 'admin',
        mustChangePassword: false,
        legacy: false,
      },
      3,
    ) as Record<string, unknown>;

    expect(body.authenticated).toBe(true);
    for (const campo of OPERACAO) expect(body).toHaveProperty(campo);
  });
});

/**
 * `/api/audit` ficou de fora quando o `asInt` entrou nas listas do painel: lia
 * `limit` e `offset` por `Number(...)` cru. `?limit=abc` virava `NaN`, que o
 * `clamp` do banco lê como o **mínimo** — a trilha voltava uma linha, não 50 —,
 * e `?offset=1e30` passava inteiro para o `OFFSET` (relatório 086 da auditoria
 * de 2026-09-19). O teto segue sendo do banco: aqui só se cobra o que chega a ele.
 */
/**
 * O que a Atividade recusa antes de consultar. A camada é coberta por inteiro
 * em `activity.test.ts`; o que estes casos travam é o caminho até o cliente —
 * um `AppError` levantado dentro do handler tem de sair como 400 pelo `route()`,
 * e não virar 500 nem promessa solta.
 */
describe('GET /api/activity: entrada inválida chega ao cliente como 400', () => {
  it('a série sem `since`/`until` não inventa faixa', async () => {
    const res = await chamar('get', '/api/activity', { query: {} });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });

  it.each([['2026-02-31'], ['2026-9-20'], ['hoje']])('o dia %j do caminho é 400', async (day) => {
    const res = await chamar('get', '/api/activity/:day', { params: { day }, query: {} });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });

  it.each([
    ['get', '/api/activity', { since: '2026-09-20T00:00:00Z', until: '2026-09-20T23:59:59Z', tz: 'Marte/Olympus' }],
    ['get', '/api/activity/:day', { tz: 'Marte/Olympus' }],
  ])('%s %s com fuso desconhecido é 400, não o 500 de um RangeError', async (method, path, query) => {
    const res = await chamar(method, path, { params: { day: '2026-09-20' }, query });

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });
});

describe('GET /api/audit: paginação vinda da query string', () => {
  const PAGINA = { items: [], total: 0, limit: 50, offset: 0 };
  const paginaPedida = () => db.listAuditPage.mock.calls.at(-1)![0] as { limit: number; offset: number };

  beforeEach(() => {
    db.listAuditPage.mockReset().mockResolvedValue(PAGINA);
  });

  it('sem os parâmetros, vale o padrão da trilha', async () => {
    const res = await chamar('get', '/api/audit', { query: {} });

    expect(res.body).toEqual(PAGINA);
    expect(paginaPedida()).toMatchObject({ limit: 50, offset: 0 });
  });

  it.each([
    ['lixo', { limit: 'abc', offset: 'xyz' }, { limit: 50, offset: 0 }],
    ['vazio', { limit: '', offset: '' }, { limit: 50, offset: 0 }],
    // `?limit[a]=1` chega como objeto; `?offset=7&offset=9`, como array — e o
    // array vale o primeiro, como no `/api/skills`.
    ['aninhado e repetido', { limit: { a: '1' }, offset: ['7', '9'] }, { limit: 50, offset: 7 }],
  ])('%s nunca chega ao banco como NaN', async (_caso, query, esperado) => {
    await chamar('get', '/api/audit', { query });

    expect(paginaPedida()).toMatchObject(esperado);
  });

  it('número válido passa; notação exponencial e fração são lidas como o inteiro do começo', async () => {
    await chamar('get', '/api/audit', { query: { limit: '25', offset: '100' } });
    expect(paginaPedida()).toMatchObject({ limit: 25, offset: 100 });

    // Com `Number(...)`, `1e30` chegava ao banco como 1e30.
    await chamar('get', '/api/audit', { query: { limit: '10.9', offset: '1e30' } });
    expect(paginaPedida()).toMatchObject({ limit: 10, offset: 1 });
  });
});
