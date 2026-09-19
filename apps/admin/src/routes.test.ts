import type { RequestHandler } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';
// A rota de redefinição só chega à montagem do link com SMTP ligado.
process.env.SMTP_FROM ??= 'painel@teste.local';
process.env.SMTP_URL ??= 'smtp://localhost:1025';

const { requireAdmin, requireCreate, requireSettingsAdmin } = await import('./auth.js');
const { config, isInternalAddress, resetLinkBaseUrl } = await import('./config.js');
const { ownerFrom, withoutUuid } = await import('./access.js');
const { api, sessionPayload } = await import('./api.js');

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
    ['post', '/api/skills/:slug/upload'],
    ['post', '/api/skills/:slug/files'],
    ['put', '/api/skills/:slug/access/:email'],
    ['delete', '/api/skills/:slug/access/:email'],
    ['put', '/api/skills/:slug/mcps/:mcp'],
    ['delete', '/api/skills/:slug/mcps/:mcp'],
    ['get', '/api/mcps/:slug'],
    ['patch', '/api/mcps/:slug'],
    ['delete', '/api/mcps/:slug'],
    ['put', '/api/mcps/:slug/skills'],
    ['post', '/api/mcps/:slug/keys'],
    ['put', '/api/mcps/:slug/access/:email'],
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
    ['put', '/api/catalogs/:slug/access/:email'],
    ['put', '/api/mcps/:slug/catalogs'],
    ['put', '/api/mcps/:slug/catalogs/:catalog'],
    ['delete', '/api/mcps/:slug/catalogs/:catalog'],
    ['get', '/api/users/lookup'],
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
 * crachá forjar. Aqui a conta se identifica pelo e-mail, e o `uuid` que sai é
 * apelido dele — o do banco não passa da camada do app.
 */
describe('GET /api/users/lookup: o uuid da conta não sai', () => {
  const doBanco = {
    uuid: '3f2b8c4e-1a6d-4b7f-9c0e-8d5a2f1b6c37',
    email: 'ana@exemplo.dev',
    name: 'Ana',
    role: 'admin' as const,
  };

  it('troca o uuid pelo e-mail e mantém nome e papel', () => {
    expect(withoutUuid(doBanco)).toEqual({
      email: 'ana@exemplo.dev',
      name: 'Ana',
      role: 'admin',
      uuid: 'ana@exemplo.dev',
    });
  });

  it('o uuid do banco não aparece em nenhum campo do payload', () => {
    expect(JSON.stringify(withoutUuid(doBanco))).not.toContain(doBanco.uuid);
  });
});

/**
 * Transferir dono chega por `ownerUserUuid`, e o painel manda ali o que a busca
 * devolveu: o e-mail. O UUID cru continua aceito para quem integra pela REST,
 * mas nada além dos dois entra — antes, qualquer texto ia ao banco e voltava 500.
 */
describe('ownerFrom', () => {
  const DONA = {
    uuid: '3f2b8c4e-1a6d-4b7f-9c0e-8d5a2f1b6c37',
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

  it.each([['uuid-editor'], ['ana'], ['  '], [42], [{}]])(
    'recusa %j com 400, sem chegar ao banco',
    async (raw) => {
      await expect(ownerFrom(DONA, 'owner', raw, 'skill')).rejects.toMatchObject({
        status: 400,
        code: 'bad_request',
      });
    },
  );

  it('sem ser dono, a transferência para antes de resolver a conta', async () => {
    await expect(ownerFrom(DONA, 'manage', 'outra@exemplo.dev', 'skill')).rejects.toMatchObject({ status: 403 });
  });
});

/** Resposta mínima que os handlers usam: status e JSON. */
function fakeResponse() {
  return {
    statusCode: 0,
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
  async function pedirRedefinicao(host: string | undefined, ip: string | undefined) {
    const pilha = handlers('post', '/api/password-reset/request');
    const handler = pilha[pilha.length - 1]!;
    const res = fakeResponse();

    await handler(
      {
        protocol: 'https',
        ip,
        body: {},
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
      { uuid: 'u-1', email: 'admin@teste.local', name: 'Admin', role: 'admin', mustChangePassword: false, legacy: false },
      3,
    ) as Record<string, unknown>;

    expect(body.authenticated).toBe(true);
    for (const campo of OPERACAO) expect(body).toHaveProperty(campo);
  });
});
