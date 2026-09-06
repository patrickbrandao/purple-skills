import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateApiKey } from '@purple-skills/shared';

const db = vi.hoisted(() => ({
  getApiKeyByPrefix: vi.fn(),
  getUserByUuid: vi.fn(),
  touchApiKey: vi.fn(),
}));

vi.mock('@purple-skills/db', () => db);
vi.mock('./config.js', () => ({
  adminToken: () => 'token-global-de-teste',
  config: { siteBaseUrl: 'http://localhost:3000' },
}));

const { resolveCaller } = await import('./auth.js');

/** Requisição mínima: `resolveCaller` só lê o header Authorization. */
const request = (authorization?: string) =>
  ({ header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined) }) as never;

const user = {
  uuid: 'uuid-do-dono',
  email: 'maria@exemplo.com',
  role: 'editor' as const,
  isActive: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  db.touchApiKey.mockResolvedValue(undefined);
});

describe('credencial do MCP administrativo', () => {
  it('aceita o token global como admin, ator token-global', async () => {
    const caller = await resolveCaller(request('Bearer token-global-de-teste'));

    expect(caller).toEqual({
      actor: { userUuid: null, label: 'token-global' },
      role: 'admin',
      identity: 'token-global',
    });
  });

  it('recusa token errado e header ausente', async () => {
    expect(await resolveCaller(request('Bearer outro-token'))).toBeNull();
    expect(await resolveCaller(request(undefined))).toBeNull();
    expect(await resolveCaller(request('token-sem-bearer'))).toBeNull();
  });

  it('aceita chave psk_ e assume o papel do dono', async () => {
    const key = generateApiKey();
    db.getApiKeyByPrefix.mockResolvedValue({
      id: 'id-da-chave',
      userUuid: user.uuid,
      name: 'notebook',
      prefix: key.prefix,
      keyHash: key.keyHash,
      revokedAt: null,
    });
    db.getUserByUuid.mockResolvedValue(user);

    const caller = await resolveCaller(request(`Bearer ${key.token}`));

    expect(db.getApiKeyByPrefix).toHaveBeenCalledWith(key.prefix);
    expect(caller).toEqual({
      actor: { userUuid: user.uuid, label: user.email },
      role: 'editor',
      identity: 'key:id-da-chave',
    });
    expect(db.touchApiKey).toHaveBeenCalledWith('id-da-chave');
  });

  it('recusa chave revogada, de usuário desativado ou com segredo errado', async () => {
    const key = generateApiKey();
    const row = {
      id: 'id-da-chave',
      userUuid: user.uuid,
      name: 'notebook',
      prefix: key.prefix,
      keyHash: key.keyHash,
      revokedAt: null,
    };

    db.getApiKeyByPrefix.mockResolvedValue({ ...row, revokedAt: '2026-01-01T00:00:00.000Z' });
    db.getUserByUuid.mockResolvedValue(user);
    expect(await resolveCaller(request(`Bearer ${key.token}`))).toBeNull();

    db.getApiKeyByPrefix.mockResolvedValue(row);
    db.getUserByUuid.mockResolvedValue({ ...user, isActive: false });
    expect(await resolveCaller(request(`Bearer ${key.token}`))).toBeNull();

    // Prefixo certo, segredo de outra chave: o hash não confere.
    db.getUserByUuid.mockResolvedValue(user);
    const outra = generateApiKey();
    expect(await resolveCaller(request(`Bearer psk_${key.prefix}_${outra.token.split('_')[2]}`))).toBeNull();
  });

  it('prefixo desconhecido não vira tentativa contra o token global', async () => {
    db.getApiKeyByPrefix.mockResolvedValue(null);
    const key = generateApiKey();

    expect(await resolveCaller(request(`Bearer ${key.token}`))).toBeNull();
    expect(db.getUserByUuid).not.toHaveBeenCalled();
  });
});
