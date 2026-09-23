import { beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyPassword } from '@purple-skills/shared';

/**
 * O `purple-admin` (`docs/21-cli-admin.md`): o que importa aqui é que a CLI
 * passa pelas mesmas funções do painel — validação, sessões derrubadas, último
 * admin e trilha com o ator `cli` — e que os códigos de saída distinguem uso
 * errado (2) de recusa (1).
 */

const erro = (status: number) => (message: string) => Object.assign(new Error(message), { status });

const db = vi.hoisted(() => ({
  adoptOrphans: vi.fn(),
  badRequest: vi.fn(),
  conflict: vi.fn(),
  unauthorized: vi.fn(),
  notFound: vi.fn(),
  countUsers: vi.fn(),
  createApiKey: vi.fn(),
  createResetToken: vi.fn(),
  createUser: vi.fn(),
  consumeResetToken: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByLogin: vi.fn(),
  getUserByOidc: vi.fn(),
  getUserByUuid: vi.fn(),
  listApiKeys: vi.fn(),
  listUsers: vi.fn(),
  nextFreeUsername: vi.fn(),
  recordAccountAudit: vi.fn(),
  registerFailedLogin: vi.fn(),
  registerSuccessfulLogin: vi.fn(),
  revokeApiKey: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock('@purple-skills/db', () => db);
vi.mock('./config.js', () => ({ config: { loginMaxAttempts: 5, loginLockSeconds: 60 } }));

const { runCli } = await import('./cli.js');

const UUID = '11111111-2222-3333-4444-555555555555';

function conta(extra: Record<string, unknown> = {}) {
  return {
    uuid: UUID,
    username: 'ana',
    avatarUpdatedAt: null,
    email: 'ana@exemplo.com',
    name: 'Ana',
    role: 'membro',
    isActive: true,
    hasPassword: true,
    passwordHash: 'x',
    mustChangePassword: false,
    oidcIssuer: null,
    oidcSubject: null,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  };
}

function io(stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), readStdin: async () => stdin },
  };
}

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.badRequest.mockImplementation(erro(400));
  db.notFound.mockImplementation(erro(404));
  db.conflict.mockImplementation(erro(409));
  db.getUserByLogin.mockResolvedValue(conta());
  db.getUserByUuid.mockResolvedValue(conta());
  db.updateUser.mockImplementation(async (_uuid: string, changes: Record<string, unknown>) =>
    conta(changes),
  );
  db.recordAccountAudit.mockResolvedValue(undefined);
  db.adoptOrphans.mockResolvedValue({ skills: 0, catalogs: 0 });
});

describe('uso', () => {
  it('sem argumentos mostra a ajuda e sai com 0', async () => {
    const t = io();
    expect(await runCli([], t.io)).toBe(0);
    expect(t.out.join('\n')).toContain('user passwd');
  });

  it('comando, subcomando ou opção desconhecidos saem com 2', async () => {
    for (const argv of [['foo'], ['user'], ['user', 'constructor'], ['user', 'list', '--nada']]) {
      const t = io();
      expect(await runCli(argv, t.io)).toBe(2);
      expect(t.err[0]).toMatch(/^erro: /);
    }
  });
});

describe('user passwd', () => {
  it('sem senha sorteia uma temporária, imprime e exige a troca', async () => {
    const t = io();
    expect(await runCli(['user', 'passwd', 'ana'], t.io)).toBe(0);

    expect(db.getUserByLogin).toHaveBeenCalledWith('ana');
    const [, changes] = db.updateUser.mock.calls[0];
    expect(changes).toMatchObject({ mustChangePassword: true, bumpTokenVersion: true, clearLoginLock: true });
    const printed = t.out.find((l) => l.startsWith('senha temporária: '))!.slice(18);
    expect(verifyPassword(printed, changes.passwordHash)).toBe(true);
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.password', actor: { userUuid: null, label: 'cli' }, targetLabel: 'ana' }),
    );
  });

  it('com --password-stdin usa a senha informada, sem a quebra de linha final e sem exigir troca', async () => {
    const t = io('uma senha bem longa\n');
    expect(await runCli(['user', 'passwd', 'ana@exemplo.com', '--password-stdin'], t.io)).toBe(0);
    const [, changes] = db.updateUser.mock.calls[0];
    expect(verifyPassword('uma senha bem longa', changes.passwordHash)).toBe(true);
    expect(changes.mustChangePassword).toBe(false);
    expect(t.out.join('\n')).not.toContain('uma senha bem longa');
  });

  it('--temporary com senha escolhida exige a troca', async () => {
    const t = io();
    await runCli(['user', 'passwd', 'ana', '--password', 'outra-senha-longa', '--temporary'], t.io);
    expect(db.updateUser.mock.calls[0][1].mustChangePassword).toBe(true);
  });

  it('aceita @username como username', async () => {
    await runCli(['user', 'passwd', '@ana'], io().io);
    expect(db.getUserByLogin).toHaveBeenCalledWith('ana');
  });

  it('aceita o uuid da conta', async () => {
    await runCli(['user', 'passwd', UUID], io().io);
    expect(db.getUserByUuid).toHaveBeenCalledWith(UUID);
    expect(db.getUserByLogin).not.toHaveBeenCalled();
  });

  it('senha curta é recusada com 1, e nada é gravado', async () => {
    const t = io();
    expect(await runCli(['user', 'passwd', 'ana', '--password', 'curta'], t.io)).toBe(1);
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('conta inexistente sai com 1', async () => {
    db.getUserByLogin.mockResolvedValue(null);
    const t = io();
    expect(await runCli(['user', 'passwd', 'ninguem'], t.io)).toBe(1);
    expect(t.err[0]).toContain('Conta não encontrada');
  });

  it('--password e --password-stdin juntos é erro de uso', async () => {
    expect(await runCli(['user', 'passwd', 'ana', '--password', 'x', '--password-stdin'], io().io)).toBe(2);
  });
});

describe('user add', () => {
  beforeEach(() => {
    db.countUsers.mockResolvedValue(3);
    db.createUser.mockImplementation(async (input: Record<string, unknown>) => conta(input));
  });

  it('cria a conta com os dados informados e a trilha com o ator cli', async () => {
    const t = io();
    const argv = ['user', 'add', '--username', 'bruno', '--email', 'bruno@exemplo.com', '--role', 'editor', '--password', 'senha-do-bruno'];
    expect(await runCli(argv, t.io)).toBe(0);
    const input = db.createUser.mock.calls[0][0];
    expect(input).toMatchObject({ username: 'bruno', email: 'bruno@exemplo.com', name: 'bruno', role: 'editor', mustChangePassword: false });
    expect(verifyPassword('senha-do-bruno', input.passwordHash)).toBe(true);
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.create', actor: { userUuid: null, label: 'cli' } }),
    );
  });

  it('sem senha imprime a temporária', async () => {
    const t = io();
    await runCli(['user', 'add', '--username', 'bruno', '--email', 'b@exemplo.com', '--role', 'membro'], t.io);
    expect(db.createUser.mock.calls[0][0].mustChangePassword).toBe(true);
    expect(t.out.some((l) => l.startsWith('senha temporária: '))).toBe(true);
  });

  it('papel inválido ou campo faltando é erro de uso', async () => {
    expect(await runCli(['user', 'add', '--username', 'b', '--email', 'b@e.com', '--role', 'dono'], io().io)).toBe(2);
    expect(await runCli(['user', 'add', '--email', 'b@e.com', '--role', 'admin'], io().io)).toBe(2);
    expect(db.createUser).not.toHaveBeenCalled();
  });

  it('com a tabela vazia, só aceita admin — e o admin adota os órfãos', async () => {
    db.countUsers.mockResolvedValue(0);
    expect(await runCli(['user', 'add', '--username', 'b', '--email', 'b@e.com', '--role', 'membro'], io().io)).toBe(1);
    expect(db.createUser).not.toHaveBeenCalled();

    expect(await runCli(['user', 'add', '--username', 'chefe', '--email', 'c@e.com', '--role', 'admin'], io().io)).toBe(0);
    expect(db.adoptOrphans).toHaveBeenCalledWith(UUID, 'web-admin', { userUuid: null, label: 'cli' });
  });
});

describe('papel e estado', () => {
  it('user role promove e derruba as sessões', async () => {
    expect(await runCli(['user', 'role', 'ana', 'admin'], io().io)).toBe(0);
    expect(db.updateUser).toHaveBeenCalledWith(UUID, expect.objectContaining({ role: 'admin', bumpTokenVersion: true }));
  });

  it('não rebaixa a última admin ativa', async () => {
    db.getUserByLogin.mockResolvedValue(conta({ role: 'admin' }));
    db.getUserByUuid.mockResolvedValue(conta({ role: 'admin' }));
    db.listUsers.mockResolvedValue([conta({ role: 'admin' })]);
    const t = io();
    expect(await runCli(['user', 'role', 'ana', 'membro'], t.io)).toBe(1);
    expect(t.err[0]).toContain('última conta de administrador');
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('disable e enable passam por updateAccount', async () => {
    await runCli(['user', 'disable', 'ana'], io().io);
    expect(db.updateUser).toHaveBeenLastCalledWith(UUID, expect.objectContaining({ isActive: false }));
    db.getUserByLogin.mockResolvedValue(conta({ isActive: false }));
    db.getUserByUuid.mockResolvedValue(conta({ isActive: false }));
    await runCli(['user', 'enable', 'ana'], io().io);
    expect(db.updateUser).toHaveBeenLastCalledWith(UUID, expect.objectContaining({ isActive: true }));
  });

  it('unlock limpa a trava e logout só derruba as sessões', async () => {
    await runCli(['user', 'unlock', 'ana'], io().io);
    expect(db.updateUser).toHaveBeenLastCalledWith(UUID, { clearLoginLock: true });
    await runCli(['user', 'logout', 'ana'], io().io);
    expect(db.updateUser).toHaveBeenLastCalledWith(UUID, { bumpTokenVersion: true });
  });
});

describe('user list', () => {
  it('omite as desativadas sem --all', async () => {
    db.listUsers.mockResolvedValue([conta(), conta({ username: 'velha', isActive: false })]);
    const t = io();
    await runCli(['user', 'list'], t.io);
    expect(t.out.join('\n')).toContain('@ana');
    expect(t.out.join('\n')).not.toContain('@velha');

    const all = io();
    await runCli(['user', 'list', '--all', '--json'], all.io);
    const parsed = JSON.parse(all.out.join('\n'));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).not.toHaveProperty('passwordHash');
  });
});
