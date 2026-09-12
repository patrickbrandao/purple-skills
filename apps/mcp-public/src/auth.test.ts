import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VIRTUAL_KEY_SCHEME, generateApiKey } from '@purple-skills/shared';

const db = vi.hoisted(() => ({
  resolveVirtualMcp: vi.fn(),
  resolveDefaultVirtualMcp: vi.fn(),
  getVirtualMcpKeyByPrefix: vi.fn(),
  touchVirtualMcpKey: vi.fn(),
}));

vi.mock('@purple-skills/db', () => db);

const { resolveRootCaller, resolveVirtualCaller, ROOT_REFUSAL_MESSAGE } = await import('./auth.js');

/** Requisição mínima: só o slug da URL e o header Authorization. */
const request = (slug: string, authorization?: string) =>
  ({
    params: { slug },
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  }) as never;

const fechado = {
  uuid: 'mcp-1',
  slug: 'time-a',
  name: 'Time A',
  description: '',
  isOpen: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.touchVirtualMcpKey.mockResolvedValue(undefined);
});

/** Na raiz não há slug: o vMCP vem de `settings`. */
const raiz = (authorization?: string) => request('', authorization);

describe('a raiz é o vMCP padrão', () => {
  it('sem padrão, padrão removido ou desligado: recusa com a causa, sem olhar credencial', async () => {
    for (const refusal of [
      { status: 'none', mcp: null, uuid: null, slug: null },
      { status: 'deleted', mcp: null, uuid: null, slug: null },
      { status: 'inactive', mcp: null, uuid: 'mcp-1', slug: 'time-a' },
    ] as const) {
      db.resolveDefaultVirtualMcp.mockResolvedValue(refusal);

      expect(await resolveRootCaller(raiz('Bearer psv_x'))).toEqual(refusal);
    }
    expect(db.getVirtualMcpKeyByPrefix).not.toHaveBeenCalled();
  });

  it('as três causas têm mensagens distintas, e todas apontam para o painel', () => {
    const mensagens = Object.values(ROOT_REFUSAL_MESSAGE);

    expect(new Set(mensagens).size).toBe(3);
    for (const mensagem of mensagens) expect(mensagem).toMatch(/Configurações/);
  });

  it('padrão aberto entra sem chave, com a mesma identidade que tem em /virtual', async () => {
    db.resolveDefaultVirtualMcp.mockResolvedValue({ status: 'ok', mcp: { ...fechado, isOpen: true } });
    db.resolveVirtualMcp.mockResolvedValue({ ...fechado, isOpen: true });

    const naRaiz = await resolveRootCaller(raiz());
    const noVirtual = await resolveVirtualCaller(request('time-a'));

    expect(naRaiz).toEqual({ mcp: { ...fechado, isOpen: true }, identity: 'virtual:mcp-1:open' });
    expect(noVirtual).toEqual(naRaiz);
  });

  it('padrão fechado exige uma chave psv_ do próprio vMCP', async () => {
    const key = generateApiKey(VIRTUAL_KEY_SCHEME);
    db.resolveDefaultVirtualMcp.mockResolvedValue({ status: 'ok', mcp: fechado });
    db.getVirtualMcpKeyByPrefix.mockResolvedValue({
      id: 'chave-1',
      virtualMcpUuid: 'mcp-1',
      name: 'ci',
      prefix: key.prefix,
      keyHash: key.keyHash,
      revokedAt: null,
    });

    expect(await resolveRootCaller(raiz())).toBeNull();
    expect(await resolveRootCaller(raiz(`Bearer ${key.token}`))).toEqual({
      mcp: fechado,
      identity: 'virtual:mcp-1:key:chave-1',
    });

    // A chave de outro vMCP não abre a raiz, mesmo válida.
    db.getVirtualMcpKeyByPrefix.mockResolvedValue({
      id: 'chave-2',
      virtualMcpUuid: 'mcp-2',
      name: 'outra',
      prefix: key.prefix,
      keyHash: key.keyHash,
      revokedAt: null,
    });
    expect(await resolveRootCaller(raiz(`Bearer ${key.token}`))).toBeNull();
  });
});

describe('resolução do MCP virtual', () => {
  it('slug desconhecido ou desligado é "não encontrado", antes de olhar credencial', async () => {
    db.resolveVirtualMcp.mockResolvedValue(null);

    expect(await resolveVirtualCaller(request('nao-existe', 'Bearer psv_x'))).toBe('not-found');
    expect(db.getVirtualMcpKeyByPrefix).not.toHaveBeenCalled();
  });

  it('MCP aberto entra sem chave, com identidade só do MCP', async () => {
    db.resolveVirtualMcp.mockResolvedValue({ ...fechado, isOpen: true });

    const caller = await resolveVirtualCaller(request('time-a'));

    expect(caller).toEqual({ mcp: { ...fechado, isOpen: true }, identity: 'virtual:mcp-1:open' });
    expect(db.getVirtualMcpKeyByPrefix).not.toHaveBeenCalled();
  });

  it('MCP fechado exige uma chave psv_ e prende a sessão a ela', async () => {
    const key = generateApiKey(VIRTUAL_KEY_SCHEME);
    db.resolveVirtualMcp.mockResolvedValue(fechado);
    db.getVirtualMcpKeyByPrefix.mockResolvedValue({
      id: 'chave-1',
      virtualMcpUuid: 'mcp-1',
      name: 'ci',
      prefix: key.prefix,
      keyHash: key.keyHash,
      revokedAt: null,
    });

    const caller = await resolveVirtualCaller(request('time-a', `Bearer ${key.token}`));

    expect(caller).toEqual({ mcp: fechado, identity: 'virtual:mcp-1:key:chave-1' });
    expect(db.touchVirtualMcpKey).toHaveBeenCalledWith('chave-1');
  });

  it('recusa chave ausente, de outro esquema, revogada ou com segredo errado', async () => {
    const key = generateApiKey(VIRTUAL_KEY_SCHEME);
    db.resolveVirtualMcp.mockResolvedValue(fechado);
    const record = {
      id: 'chave-1',
      virtualMcpUuid: 'mcp-1',
      name: 'ci',
      prefix: key.prefix,
      keyHash: key.keyHash,
      revokedAt: null,
    };

    expect(await resolveVirtualCaller(request('time-a'))).toBeNull();
    // Uma psk_ do mcp-admin não abre um virtual: o esquema decide a tabela.
    expect(
      await resolveVirtualCaller(request('time-a', `Bearer ${key.token.replace(/^psv_/, 'psk_')}`)),
    ).toBeNull();

    db.getVirtualMcpKeyByPrefix.mockResolvedValue({ ...record, revokedAt: '2026-01-01T00:00:00Z' });
    expect(await resolveVirtualCaller(request('time-a', `Bearer ${key.token}`))).toBeNull();

    db.getVirtualMcpKeyByPrefix.mockResolvedValue(record);
    expect(
      await resolveVirtualCaller(request('time-a', `Bearer psv_${key.prefix}_segredo-errado-xx`)),
    ).toBeNull();
    expect(db.touchVirtualMcpKey).not.toHaveBeenCalled();
  });

  it('a chave de um virtual não abre outro, mesmo válida', async () => {
    const key = generateApiKey(VIRTUAL_KEY_SCHEME);
    db.resolveVirtualMcp.mockResolvedValue({ ...fechado, uuid: 'mcp-2', slug: 'time-b' });
    db.getVirtualMcpKeyByPrefix.mockResolvedValue({
      id: 'chave-1',
      virtualMcpUuid: 'mcp-1',
      name: 'ci',
      prefix: key.prefix,
      keyHash: key.keyHash,
      revokedAt: null,
    });

    expect(await resolveVirtualCaller(request('time-b', `Bearer ${key.token}`))).toBeNull();
  });
});
