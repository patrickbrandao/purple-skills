import type { RequestHandler } from 'express';
import { describe, expect, it } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const { requireAdmin, requireCreate, requireSettingsAdmin } = await import('./auth.js');
const { api } = await import('./api.js');

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

  it.each([
    ['get', '/api/users'],
    ['post', '/api/users'],
    ['patch', '/api/users/:uuid'],
    ['post', '/api/users/:uuid/reset-password'],
  ])('%s %s exige admin', (method, path) => {
    expect(handlers(method, path)).toContain(requireAdmin);
  });

  // O vMCP padrão responde em /mcp para a instalação inteira: só admin escolhe.
  it.each([
    ['get', '/api/settings'],
    ['put', '/api/settings/default-mcp'],
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
    ['patch', '/api/skills/:slug'],
    ['delete', '/api/skills/:slug'],
    ['put', '/api/skills/:slug/files/*path'],
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

describe('POST /api/skills com corpo de tipo errado', () => {
  it('recusa `skillMd` não-string com 400, sem chegar ao banco', async () => {
    // `stripFrontmatter` é a primeira coisa a tocar o valor: sem o guarda,
    // `(123).replace` estourava `TypeError` e virava 500.
    const pilha = handlers('post', '/api/skills');
    const handler = pilha[pilha.length - 1]!;

    const res = {
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

    await handler({ body: { name: 'Teste', skillMd: 123 } } as never, res as never, (() => {}) as never);
    // O handler é síncrono até a resposta; o `route()` só encaminha rejeições.
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'bad_request', message: 'O campo "skillMd" deve ser uma string' });
  });
});
