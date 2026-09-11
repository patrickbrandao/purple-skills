import type { RequestHandler } from 'express';
import { describe, expect, it } from 'vitest';

process.env.ADMIN_PASSWORD ??= 'senha-de-teste';

const { requireAdmin, requireDelete, requireVirtualMcpCreate, requireWrite } = await import('./auth.js');
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
    // Uma chave do principal abre o catálogo público inteiro: só admin.
    ['get', '/api/public-mcp/keys'],
    ['post', '/api/public-mcp/keys'],
    ['delete', '/api/public-mcp/keys/:id'],
  ])('%s %s exige admin', (method, path) => {
    expect(handlers(method, path)).toContain(requireAdmin);
  });

  it.each([
    ['post', '/api/skills'],
    ['post', '/api/skills/import'],
    ['patch', '/api/skills/:slug'],
    ['post', '/api/skills/:slug/visibility'],
    ['post', '/api/skills/:slug/upload'],
    ['post', '/api/skills/:slug/files'],
  ])('%s %s exige papel de escrita', (method, path) => {
    expect(handlers(method, path)).toContain(requireWrite);
  });

  it('apagar skill exige admin', () => {
    expect(handlers('delete', '/api/skills/:slug')).toContain(requireDelete);
  });

  it('criar MCP virtual exige papel de escrita; o resto é decidido pelo dono', () => {
    expect(handlers('post', '/api/mcps')).toContain(requireVirtualMcpCreate);
    // Sem guarda de papel de propósito: `loadManaged` deixa passar o dono ou
    // um admin, e um leitor que virou dono por transferência administra o seu.
    for (const [method, path] of [
      ['patch', '/api/mcps/:slug'],
      ['put', '/api/mcps/:slug/skills'],
      ['post', '/api/mcps/:slug/keys'],
    ] as const) {
      expect(handlers(method, path)).not.toContain(requireWrite);
      expect(handlers(method, path)).not.toContain(requireAdmin);
    }
  });

  it('leitura do catálogo não exige papel além da sessão', () => {
    const lista = handlers('get', '/api/skills');

    expect(lista).not.toContain(requireWrite);
    expect(lista).not.toContain(requireAdmin);
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
