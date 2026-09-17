import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '@purple-skills/shared';

/**
 * A adoção dos órfãos (`docs/05-accounts-and-roles.md` §2.3): o setup e cada
 * login chamam `adoptOrphans`, só para admin, e uma falha nela não impede a
 * entrada. Quem decide se a conta é a única admin é o banco — coberto pela
 * integração do dba.
 */

const erro = (message: string) => Object.assign(new Error(message), { status: 400 });

const db = vi.hoisted(() => ({
  adoptOrphans: vi.fn(),
  badRequest: vi.fn(),
  conflict: vi.fn(),
  unauthorized: vi.fn(),
  notFound: vi.fn(),
  createApiKey: vi.fn(),
  createResetToken: vi.fn(),
  createUser: vi.fn(),
  consumeResetToken: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByOidc: vi.fn(),
  getUserByUuid: vi.fn(),
  listApiKeys: vi.fn(),
  listUsers: vi.fn(),
  recordAccountAudit: vi.fn(),
  registerFailedLogin: vi.fn(),
  registerSuccessfulLogin: vi.fn(),
  revokeApiKey: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('@purple-skills/db', () => db);
vi.mock('./config.js', () => ({
  config: {
    loginMaxAttempts: 5,
    loginLockSeconds: 60,
    resetTtlSeconds: 3600,
    oidcAllowedDomains: ['exemplo.com'],
    oidcAutoProvision: true,
  },
}));

const { bootstrapAdmin, loginWithPassword, resolveOidcUser } = await import('./accounts.js');

const SENHA = 'uma-senha-longa-o-bastante';

const conta = (role: 'admin' | 'editor' | 'membro') => ({
  uuid: `uuid-${role}`,
  email: `${role}@exemplo.com`,
  name: role,
  role,
  isActive: true,
  hasPassword: true,
  passwordHash: hashPassword(SENHA),
  mustChangePassword: false,
  oidcIssuer: null,
  oidcSubject: null,
  lockedUntil: null,
  lastLoginAt: null,
  tokenVersion: 0,
  createdAt: '2026-09-17T00:00:00Z',
  updatedAt: '2026-09-17T00:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  db.badRequest.mockImplementation(erro);
  db.conflict.mockImplementation(erro);
  db.unauthorized.mockImplementation(erro);
  db.adoptOrphans.mockResolvedValue({ adopted: true, skills: 2, catalogs: 1 });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('adoção dos órfãos', () => {
  it('o setup passa ao primeiro admin o que o bootstrap criou, com o ator bootstrap', async () => {
    db.createUser.mockResolvedValue(conta('admin'));

    await bootstrapAdmin({ email: 'admin@exemplo.com', name: 'Admin', password: SENHA });

    expect(db.adoptOrphans).toHaveBeenCalledWith('uuid-admin', 'web-admin', { userUuid: null, label: 'bootstrap' });
  });

  it('o login de um admin adota, com a própria conta como ator', async () => {
    db.getUserByEmail.mockResolvedValue(conta('admin'));

    const outcome = await loginWithPassword({ email: 'admin@exemplo.com', password: SENHA });

    expect(outcome).toHaveProperty('user');
    expect(db.adoptOrphans).toHaveBeenCalledWith('uuid-admin', 'web-admin', { userUuid: 'uuid-admin', label: 'admin@exemplo.com' });
  });

  it('quem não é admin não chega a consultar', async () => {
    db.getUserByEmail.mockResolvedValue(conta('editor'));

    expect(await loginWithPassword({ email: 'editor@exemplo.com', password: SENHA })).toHaveProperty('user');
    expect(db.adoptOrphans).not.toHaveBeenCalled();
  });

  it('senha errada não adota nada', async () => {
    db.getUserByEmail.mockResolvedValue(conta('admin'));

    expect(await loginWithPassword({ email: 'admin@exemplo.com', password: 'outra-senha-qualquer' })).toHaveProperty('error');
    expect(db.adoptOrphans).not.toHaveBeenCalled();
  });

  it('uma falha na adoção não impede a entrada', async () => {
    db.getUserByEmail.mockResolvedValue(conta('admin'));
    db.adoptOrphans.mockRejectedValue(new Error('banco fora do ar'));

    expect(await loginWithPassword({ email: 'admin@exemplo.com', password: SENHA })).toHaveProperty('user');
    expect(console.error).toHaveBeenCalled();
  });

  it('o login por SSO de um admin também adota', async () => {
    db.getUserByOidc.mockResolvedValue({ ...conta('admin'), oidcIssuer: 'https://idp', oidcSubject: 'sub-1' });

    await resolveOidcUser({ issuer: 'https://idp', subject: 'sub-1', email: 'admin@exemplo.com' } as never);

    expect(db.adoptOrphans).toHaveBeenCalledWith('uuid-admin', 'web-admin', { userUuid: 'uuid-admin', label: 'admin@exemplo.com' });
  });
});
