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

const { callerAtual, comCaller, resolveCaller } = await import('./auth.js');

/** Requisição mínima: `resolveCaller` lê o header Authorization e, para o registro de acessos, o IP e o agente. */
const request = (authorization?: string) =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
    get: (name: string) => (name.toLowerCase() === 'user-agent' ? 'agente-de-teste/1.0' : undefined),
    ip: '203.0.113.7',
  }) as never;

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
      ip: '203.0.113.7',
      userAgent: 'agente-de-teste/1.0',
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
    // A chave, o IP e o agente vão junto: é o que o registro de acessos grava.
    expect(caller).toEqual({
      actor: { userUuid: user.uuid, label: user.email },
      role: 'editor',
      identity: 'key:id-da-chave',
      apiKeyId: 'id-da-chave',
      ip: '203.0.113.7',
      userAgent: 'agente-de-teste/1.0',
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

/**
 * O servidor de uma sessão MCP é criado uma única vez, no `initialize`. Quem
 * autoriza cada tool tem de ser a credencial revalidada na requisição — senão
 * rebaixar a conta no painel não tira o poder de quem já está conectado.
 */
describe('credencial da requisição em curso', () => {
  const doInitialize = {
    actor: { userUuid: 'uuid-do-dono', label: 'maria@exemplo.com' },
    role: 'admin' as const,
    identity: 'key:id-da-chave',
    apiKeyId: 'id-da-chave',
    ip: '203.0.113.7',
    userAgent: 'agente-de-teste/1.0',
  };

  it('fora de uma requisição vale o caller do initialize', () => {
    expect(callerAtual(doInitialize)).toBe(doInitialize);
  });

  it('a mesma chave rebaixada no meio da sessão passa a valer como membro', async () => {
    // Mesma identidade (a chave não foi revogada), papel e IP novos.
    const rebaixado = { ...doInitialize, role: 'membro' as const, ip: '198.51.100.9' };
    let visto: typeof doInitialize | undefined;

    await comCaller({ caller: rebaixado } as never, async () => {
      visto = callerAtual(doInitialize);
    });

    expect(visto?.role).toBe('membro');
    expect(visto?.ip).toBe('198.51.100.9');
    // Terminada a requisição, nada fica pendurado no contexto.
    expect(callerAtual(doInitialize)).toBe(doInitialize);
  });

  it('requisição sem credencial não contamina o contexto', async () => {
    let visto: typeof doInitialize | undefined;

    await comCaller({} as never, async () => {
      visto = callerAtual(doInitialize);
    });

    expect(visto).toBe(doInitialize);
  });
});
