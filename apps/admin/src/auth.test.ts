import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signSession } from '@purple-skills/shared';

const SECRET = 'segredo-de-teste-do-painel';

const db = vi.hoisted(() => ({
  countUsers: vi.fn(),
  getUserByUuid: vi.fn(),
}));

vi.mock('@purple-skills/db', () => db);
vi.mock('./config.js', () => ({
  SESSION_COOKIE: 'ps_admin',
  OIDC_COOKIE: 'ps_oidc',
  config: { sessionTtlSeconds: 3600, cookieSecure: undefined },
  getAdminPassword: () => 'senha-de-bootstrap',
  getSessionSecret: () => SECRET,
}));

const {
  LEGACY_ADMIN,
  checkBootstrapPassword,
  issueLegacySession,
  requireAdmin,
  requirePasswordChanged,
  requireWrite,
  requireDelete,
  resolveUser,
} = await import('./auth.js');

const future = () => Math.floor(Date.now() / 1000) + 3600;

const request = (cookie?: string) => ({ cookies: cookie ? { ps_admin: cookie } : {} }) as never;

const account = {
  uuid: 'uuid-1',
  email: 'maria@exemplo.com',
  name: 'Maria',
  role: 'editor' as const,
  isActive: true,
  tokenVersion: 3,
  mustChangePassword: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolução da sessão', () => {
  it('carrega o usuário quando papel e versão conferem', async () => {
    db.getUserByUuid.mockResolvedValue(account);
    const token = signSession({ sub: account.uuid, role: 'editor', ver: 3, exp: future() }, SECRET);

    expect(await resolveUser(request(token))).toEqual({
      uuid: 'uuid-1',
      email: 'maria@exemplo.com',
      name: 'Maria',
      role: 'editor',
      mustChangePassword: false,
      legacy: false,
    });
  });

  it('token_version diferente derruba a sessão — é a alavanca de revogação', async () => {
    db.getUserByUuid.mockResolvedValue({ ...account, tokenVersion: 4 });
    const token = signSession({ sub: account.uuid, role: 'editor', ver: 3, exp: future() }, SECRET);

    expect(await resolveUser(request(token))).toBeNull();
  });

  it('conta desativada ou inexistente não entra', async () => {
    const token = signSession({ sub: account.uuid, role: 'editor', ver: 3, exp: future() }, SECRET);

    db.getUserByUuid.mockResolvedValue({ ...account, isActive: false });
    expect(await resolveUser(request(token))).toBeNull();

    db.getUserByUuid.mockResolvedValue(null);
    expect(await resolveUser(request(token))).toBeNull();
  });

  it('o papel vem do banco, não do cookie', async () => {
    db.getUserByUuid.mockResolvedValue(account);
    // Cookie legítimo, assinado, mas pedindo admin: o banco diz editor.
    const token = signSession({ sub: account.uuid, role: 'admin', ver: 3, exp: future() }, SECRET);

    expect((await resolveUser(request(token)))?.role).toBe('editor');
  });

  it('cookie sem assinatura válida é ignorado', async () => {
    const forjado = signSession({ sub: account.uuid, role: 'admin', ver: 3, exp: future() }, 'outro');
    expect(await resolveUser(request(forjado))).toBeNull();
    expect(await resolveUser(request(undefined))).toBeNull();
    expect(db.getUserByUuid).not.toHaveBeenCalled();
  });
});

describe('sessão legada da ADMIN_PASSWORD', () => {
  /** Emitida pelo próprio código, não por um payload montado à mão. */
  function legacyToken(): string {
    let token = '';
    const res = {
      cookie: (_name: string, value: string) => {
        token = value;
      },
    };
    issueLegacySession({ secure: false } as never, res as never);
    return token;
  }

  it('sai sem papel e sem versão — é isso que a marca como legada', () => {
    const payload = JSON.parse(
      Buffer.from(legacyToken().split('.')[0], 'base64url').toString('utf8'),
    );
    expect(payload.sub).toBe('admin');
    expect(payload.role).toBeUndefined();
    expect(payload.ver).toBeUndefined();
  });

  it('vale como admin enquanto não existe conta', async () => {
    db.countUsers.mockResolvedValue(0);
    expect(await resolveUser(request(legacyToken()))).toEqual(LEGACY_ADMIN);
    // Não vai ao banco procurar um usuário chamado "admin".
    expect(db.getUserByUuid).not.toHaveBeenCalled();
  });

  it('para de valer assim que existe a primeira conta', async () => {
    db.countUsers.mockResolvedValue(1);
    expect(await resolveUser(request(legacyToken()))).toBeNull();
  });
});

describe('senha temporária', () => {
  const run = (path: string, mustChange: boolean) => {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    requirePasswordChanged(
      { path, user: { mustChangePassword: mustChange } } as never,
      res as never,
      next as never,
    );
    return { next, res };
  };

  // Os caminhos chegam sem o prefixo `/api`: o roteador já o removeu.
  it('deixa passar a troca de senha e o estado da sessão', () => {
    for (const path of ['/me', '/me/password', '/session', '/logout']) {
      expect(run(path, true).next).toHaveBeenCalled();
    }
  });

  it('barra o resto enquanto a senha não muda', () => {
    for (const path of ['/skills', '/users', '/stats']) {
      expect(run(path, true).res.status).toHaveBeenCalledWith(403);
    }
  });

  it('não atrapalha quem já trocou', () => {
    expect(run('/skills', false).next).toHaveBeenCalled();
  });
});

describe('senha de bootstrap', () => {
  it('confere a senha configurada e recusa o resto', () => {
    expect(checkBootstrapPassword('senha-de-bootstrap')).toBe(true);
    expect(checkBootstrapPassword('outra')).toBe(false);
    expect(checkBootstrapPassword('')).toBe(false);
    expect(checkBootstrapPassword(undefined)).toBe(false);
    expect(checkBootstrapPassword(42)).toBe(false);
  });
});

describe('guardas de papel', () => {
  const run = (guard: (req: never, res: never, next: never) => void, role?: string) => {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    guard({ user: role ? { role } : undefined } as never, res as never, next as never);
    return { next, res };
  };

  it('leitor não escreve, não apaga e não gerencia contas', () => {
    for (const guard of [requireWrite, requireDelete, requireAdmin]) {
      const { next, res } = run(guard, 'leitor');
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  it('editor escreve, mas não apaga nem gerencia contas', () => {
    expect(run(requireWrite, 'editor').next).toHaveBeenCalled();
    expect(run(requireDelete, 'editor').res.status).toHaveBeenCalledWith(403);
    expect(run(requireAdmin, 'editor').res.status).toHaveBeenCalledWith(403);
  });

  it('admin passa em tudo', () => {
    for (const guard of [requireWrite, requireDelete, requireAdmin]) {
      expect(run(guard, 'admin').next).toHaveBeenCalled();
    }
  });

  it('sem sessão, nada passa', () => {
    for (const guard of [requireWrite, requireDelete, requireAdmin]) {
      expect(run(guard, undefined).res.status).toHaveBeenCalledWith(403);
    }
  });
});
