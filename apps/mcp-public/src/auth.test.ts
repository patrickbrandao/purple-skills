import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_KEY_SCHEME, VIRTUAL_KEY_SCHEME, generateApiKey } from '@purple-skills/shared';

const db = vi.hoisted(() => ({
  resolveVirtualMcp: vi.fn(),
  getVirtualMcpKeyByPrefix: vi.fn(),
  touchVirtualMcpKey: vi.fn(),
  getPublicMcpKeyByPrefix: vi.fn(),
  touchPublicMcpKey: vi.fn(),
}));

const cfg = vi.hoisted(() => ({
  mode: 'open' as 'open' | 'key' | 'managed',
  key: undefined as string | undefined,
}));

vi.mock('@purple-skills/db', () => db);
vi.mock('./config.js', () => ({
  publicKey: () => cfg.key,
  publicAuthMode: () => cfg.mode,
  config: { siteBaseUrl: 'http://localhost:3000', publicUrl: '' },
}));

const { resolvePublicCaller, resolveVirtualCaller } = await import('./auth.js');

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
  db.touchPublicMcpKey.mockResolvedValue(undefined);
  cfg.mode = 'open';
  cfg.key = undefined;
});

const principal = (authorization?: string) => request('', authorization);

describe('MCP principal por MCP_PUBLIC_AUTH', () => {
  it('open: entra sem nada e ignora a chave da env', async () => {
    cfg.key = 'chave-env';

    expect(await resolvePublicCaller(principal())).toEqual({ identity: undefined });
    expect(await resolvePublicCaller(principal('Bearer qualquer'))).toEqual({ identity: undefined });
  });

  it('key: só a MCP_PUBLIC_KEY, com identidade compartilhada', async () => {
    cfg.mode = 'key';
    cfg.key = 'chave-env';

    expect(await resolvePublicCaller(principal('Bearer chave-env'))).toEqual({ identity: 'public:env' });
    expect(await resolvePublicCaller(principal('Bearer outra'))).toBeNull();
    expect(await resolvePublicCaller(principal())).toBeNull();
    // Uma psp_ válida não é consultada neste modo.
    expect(await resolvePublicCaller(principal('Bearer psp_AAAAAAAA_bbbbbbbbbbbbbbbbbbbb'))).toBeNull();
    expect(db.getPublicMcpKeyByPrefix).not.toHaveBeenCalled();
  });

  it('managed: aceita psp_ do banco e também a chave da env, se houver', async () => {
    cfg.mode = 'managed';
    cfg.key = 'chave-env';
    const key = generateApiKey(PUBLIC_KEY_SCHEME);
    db.getPublicMcpKeyByPrefix.mockResolvedValue({
      id: 'chave-1',
      name: 'ci',
      prefix: key.prefix,
      keyHash: key.keyHash,
      revokedAt: null,
    });

    expect(await resolvePublicCaller(principal(`Bearer ${key.token}`))).toEqual({
      identity: 'public:key:chave-1',
    });
    expect(db.touchPublicMcpKey).toHaveBeenCalledWith('chave-1');
    expect(await resolvePublicCaller(principal('Bearer chave-env'))).toEqual({ identity: 'public:env' });
  });

  it('managed: recusa sem chave, revogada, de outro esquema e segredo errado', async () => {
    cfg.mode = 'managed';
    const key = generateApiKey(PUBLIC_KEY_SCHEME);
    const record = { id: 'chave-1', name: 'ci', prefix: key.prefix, keyHash: key.keyHash, revokedAt: null };

    expect(await resolvePublicCaller(principal())).toBeNull();
    // psv_ e psk_ não abrem o principal: o esquema decide a tabela.
    expect(await resolvePublicCaller(principal(`Bearer ${key.token.replace(/^psp_/, 'psv_')}`))).toBeNull();
    expect(db.getPublicMcpKeyByPrefix).not.toHaveBeenCalled();

    db.getPublicMcpKeyByPrefix.mockResolvedValue({ ...record, revokedAt: '2026-01-01T00:00:00Z' });
    expect(await resolvePublicCaller(principal(`Bearer ${key.token}`))).toBeNull();

    db.getPublicMcpKeyByPrefix.mockResolvedValue(record);
    expect(await resolvePublicCaller(principal(`Bearer psp_${key.prefix}_segredo-errado-xxxx`))).toBeNull();
    expect(db.touchPublicMcpKey).not.toHaveBeenCalled();
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
