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
  countUsers: vi.fn(),
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

/** Mutável de propósito: o caso da allowlist vazia troca `oidcAllowedDomains`. */
const cfg = vi.hoisted(() => ({
  loginMaxAttempts: 5,
  loginLockSeconds: 60,
  resetTtlSeconds: 3600,
  oidcAllowedDomains: ['exemplo.com'] as string[],
  oidcAutoProvision: true,
}));

vi.mock('./config.js', () => ({ config: cfg }));

const {
  bootstrapAdmin,
  confirmPasswordReset,
  loginWithPassword,
  resetAccountPassword,
  resolveOidcUser,
  updateAccount,
} = await import('./accounts.js');

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
  cfg.oidcAllowedDomains = ['exemplo.com'];
  db.badRequest.mockImplementation(erro);
  db.conflict.mockImplementation(erro);
  db.unauthorized.mockImplementation(erro);
  db.adoptOrphans.mockResolvedValue({ adopted: true, skills: 2, catalogs: 1 });
  // Tabela vazia é o estado normal do bootstrap.
  db.countUsers.mockResolvedValue(0);
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

/**
 * O primeiro administrador (`tasks/049`): a rota `/api/setup` responde 404 com a
 * tabela não vazia, mas era só ela a conferir — e entre a conferência dela e o
 * INSERT ficava o scrypt da senha (~70 ms). Quem fecha a corrida é o banco, com
 * o `onlyIfTableEmpty` (contagem e INSERT na mesma transação, atrás do advisory
 * lock); a conferência daqui fica como recusa barata, tira o scrypt da janela e
 * faz a função valer o que a docstring dela promete.
 */
describe('bootstrap do primeiro admin', () => {
  it('com a tabela não vazia, recusa sem criar conta, auditar nem adotar', async () => {
    db.countUsers.mockResolvedValue(1);

    await expect(
      bootstrapAdmin({ email: 'admin@exemplo.com', name: 'Admin', password: SENHA }),
    ).rejects.toThrow(/primeiro administrador/);

    expect(db.createUser).not.toHaveBeenCalled();
    expect(db.recordAccountAudit).not.toHaveBeenCalled();
    expect(db.adoptOrphans).not.toHaveBeenCalled();
  });

  it('confere a tabela antes do INSERT, com o hash já pronto', async () => {
    db.createUser.mockResolvedValue(conta('admin'));

    await bootstrapAdmin({ email: 'admin@exemplo.com', name: 'Admin', password: SENHA });

    const [conferencia] = db.countUsers.mock.invocationCallOrder;
    const [insercao] = db.createUser.mock.invocationCallOrder;
    expect(conferencia).toBeLessThan(insercao);
    expect(db.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'admin@exemplo.com', role: 'admin' }),
    );
  });

  it('manda o banco gravar só com a tabela vazia', async () => {
    db.createUser.mockResolvedValue(conta('admin'));

    await bootstrapAdmin({ email: 'admin@exemplo.com', name: 'Admin', password: SENHA });

    // Sem este campo a corrida fica aberta: dois `/api/setup` simultâneos criam
    // dois administradores e a adoção de órfãos, que exige uma admin ativa só,
    // para de acontecer.
    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ onlyIfTableEmpty: true }));
  });

  it('a recusa do banco tem o mesmo texto e não audita nem adota', async () => {
    db.createUser.mockRejectedValue(
      Object.assign(new Error('Este painel já tem contas: o primeiro administrador já foi criado'), {
        status: 409,
      }),
    );

    await expect(
      bootstrapAdmin({ email: 'admin@exemplo.com', name: 'Admin', password: SENHA }),
    ).rejects.toThrow(/já tem contas/);

    expect(db.recordAccountAudit).not.toHaveBeenCalled();
    expect(db.adoptOrphans).not.toHaveBeenCalled();
  });

  it('corpo inválido para antes de gastar scrypt e de consultar o banco', async () => {
    await expect(
      bootstrapAdmin({ email: 'nao-e-email', name: 'Admin', password: SENHA }),
    ).rejects.toThrow(/e-mail/);

    expect(db.countUsers).not.toHaveBeenCalled();
    expect(db.createUser).not.toHaveBeenCalled();
  });
});

/**
 * `email_verified` no SSO: vincular a uma conta local que já existe é assumi-la,
 * e só o claim afirma a posse do endereço. Criar conta nova passa sem o claim
 * (provedor corporativo costuma não emitir) e para no `false` explícito.
 */
describe('email_verified no login por SSO', () => {
  const sso = (extra: Record<string, unknown>) =>
    resolveOidcUser({
      issuer: 'https://idp',
      subject: 'sub-9',
      email: 'admin@exemplo.com',
      ...extra,
    } as never);

  beforeEach(() => {
    db.getUserByOidc.mockResolvedValue(null);
    db.getUserByEmail.mockResolvedValue(null);
  });

  it('sem o claim, a identidade não assume a conta local que já existe', async () => {
    db.getUserByEmail.mockResolvedValue(conta('admin'));

    await expect(sso({})).rejects.toThrow(/email_verified/);
    expect(db.updateUser).not.toHaveBeenCalled();
    expect(db.registerSuccessfulLogin).not.toHaveBeenCalled();
  });

  it('com o claim em false, também não assume', async () => {
    db.getUserByEmail.mockResolvedValue(conta('admin'));

    await expect(sso({ emailVerified: false })).rejects.toThrow(/email_verified/);
    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('com o claim em true, vincula a conta local e mantém o papel', async () => {
    db.getUserByEmail.mockResolvedValue(conta('admin'));
    db.updateUser.mockResolvedValue({ ...conta('admin'), oidcIssuer: 'https://idp', oidcSubject: 'sub-9' });

    const user = await sso({ emailVerified: true });

    expect(db.updateUser).toHaveBeenCalledWith('uuid-admin', {
      oidcIssuer: 'https://idp',
      oidcSubject: 'sub-9',
    });
    expect(user.role).toBe('admin');
  });

  it('a identidade já vinculada entra sem o claim', async () => {
    db.getUserByOidc.mockResolvedValue({ ...conta('editor'), oidcIssuer: 'https://idp', oidcSubject: 'sub-9' });

    expect(await sso({})).toHaveProperty('uuid', 'uuid-editor');
    expect(db.getUserByEmail).not.toHaveBeenCalled();
  });

  it('sem o claim, a conta nova ainda é criada como membro', async () => {
    db.createUser.mockResolvedValue(conta('membro'));

    await sso({ email: 'novo@exemplo.com' });

    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'novo@exemplo.com', role: 'membro' }));
  });

  it('com o claim em false, nem a conta nova é criada', async () => {
    await expect(sso({ email: 'novo@exemplo.com', emailVerified: false })).rejects.toThrow(/não é verificado/);
    expect(db.createUser).not.toHaveBeenCalled();
  });
});

/**
 * O tempo do login também tem de ser o mesmo (`tasks/028`): sem o hash
 * sentinela, e-mail sem conta responde em ~1 ms e e-mail com conta em ~70 ms
 * (o scrypt da senha), e uma única tentativa classifica o endereço.
 *
 * A comparação é por **razão** e pelo **menor** de três amostras, para não
 * depender da velocidade da máquina nem de uma pausa do coletor de lixo. A
 * margem é larga de propósito: o que se quer flagrar é a diferença de duas
 * ordens de grandeza, não os poucos milissegundos do `UPDATE` que só o caminho
 * com conta faz.
 */
describe('tempo do login', () => {
  it('gasta o mesmo scrypt quando a conta não existe', async () => {
    const registro = conta('editor');

    const medir = async (email: string) => {
      db.getUserByEmail.mockResolvedValue(email === registro.email ? registro : null);
      let menor = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i += 1) {
        const inicio = performance.now();
        await loginWithPassword({ email, password: 'senha-errada-qualquer' });
        menor = Math.min(menor, performance.now() - inicio);
      }
      return menor;
    };

    // A primeira tentativa inválida do processo gera o sentinela (dois scrypts).
    await medir('naoexiste@exemplo.com');

    const semConta = await medir('naoexiste@exemplo.com');
    const comConta = await medir(registro.email);

    expect(semConta).toBeGreaterThan(comConta * 0.5);
  });
});

/**
 * Allowlist vazia (`docs/05-accounts-and-roles.md` §2.4): recusa o SSO inteiro,
 * não só o auto-provisionamento — a conferência vem antes de procurar a conta.
 * O que se testa aqui é que a identidade já vinculada também para, e que a
 * mensagem aponta a variável, não o domínio de quem tentou entrar.
 */
describe('allowlist de domínio vazia', () => {
  beforeEach(() => {
    cfg.oidcAllowedDomains = [];
  });

  it('recusa até a identidade já vinculada, sem consultar o banco', async () => {
    db.getUserByOidc.mockResolvedValue({ ...conta('editor'), oidcIssuer: 'https://idp', oidcSubject: 'sub-1' });

    await expect(
      resolveOidcUser({ issuer: 'https://idp', subject: 'sub-1', email: 'editor@exemplo.com', emailVerified: true } as never),
    ).rejects.toThrow(/OIDC_ALLOWED_DOMAINS/);

    expect(db.getUserByOidc).not.toHaveBeenCalled();
    expect(db.getUserByEmail).not.toHaveBeenCalled();
    expect(db.createUser).not.toHaveBeenCalled();
  });
});

/**
 * `isActive` no PATCH da conta (`tasks/046`): o `=== true` de antes fazia de
 * `"true"` uma desativação silenciosa — com as sessões caindo e a trilha
 * registrando `user.deactivate` como se fosse o pedido. O campo só chega quando
 * o cliente quis mexer nele, então o que não é booleano é 400.
 */
describe('isActive no PATCH da conta', () => {
  const admin = {
    uuid: 'uuid-admin',
    email: 'admin@exemplo.com',
    name: 'Admin',
    role: 'admin' as const,
    mustChangePassword: false,
    legacy: false,
  };

  beforeEach(() => {
    db.getUserByUuid.mockResolvedValue(conta('editor'));
    db.updateUser.mockResolvedValue(conta('editor'));
  });

  it.each([
    ['"true"', 'true'],
    ['"false"', 'false'],
    ['1', 1],
    ['nulo', null],
  ] as [string, unknown][])('recusa %s com 400, sem desativar a conta', async (_rotulo, isActive) => {
    await expect(updateAccount(admin, 'uuid-editor', { isActive })).rejects.toThrow(/isActive/);

    expect(db.updateUser).not.toHaveBeenCalled();
    expect(db.recordAccountAudit).not.toHaveBeenCalled();
  });

  it('o booleano continua valendo: false desativa, derruba as sessões e audita', async () => {
    await updateAccount(admin, 'uuid-editor', { isActive: false });

    expect(db.updateUser).toHaveBeenCalledWith('uuid-editor', { isActive: false, bumpTokenVersion: true });
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.deactivate', targetLabel: 'editor@exemplo.com' }),
    );
  });

  it('ausente não mexe na ativação', async () => {
    await updateAccount(admin, 'uuid-editor', { name: 'Editor' });

    expect(db.updateUser).toHaveBeenCalledWith('uuid-editor', { name: 'Editor' });
  });
});

/**
 * A invariante "sempre sobra um administrador" (`tasks/049`).
 *
 * O `assertNotLastAdmin` lê antes de escrever, e a escrita é outra transação:
 * dois PATCH simultâneos rebaixando administradores **diferentes** passavam os
 * dois pela leitura e deixavam a instalação sem nenhum admin ativo — 4 de 5
 * rodadas, medido pelo dba. O que se testa aqui é o repasse do
 * `requireOtherActiveAdmin`, que põe a conferência dentro da transação do
 * UPDATE: sem essa linha a corrida continua aberta, e com ela sobrando nas
 * escritas que **não** tiram ninguém do grupo o banco recusaria PATCH legítimo
 * de instalação com um admin só.
 */
describe('invariante do último administrador', () => {
  const admin = {
    uuid: 'uuid-admin',
    email: 'admin@exemplo.com',
    name: 'Admin',
    role: 'admin' as const,
    mustChangePassword: false,
    legacy: false,
  };

  const outroAdmin = { ...conta('admin'), uuid: 'uuid-outro-admin', email: 'outro@exemplo.com' };

  beforeEach(() => {
    // Duas outras admins ativas: a recusa cedo não dispara e a escrita chega ao
    // banco, que é onde a conferência de verdade acontece.
    db.listUsers.mockResolvedValue([conta('admin'), outroAdmin]);
    db.getUserByUuid.mockResolvedValue(outroAdmin);
    db.updateUser.mockResolvedValue({ ...outroAdmin, role: 'editor' });
  });

  it('rebaixar um admin leva a conferência para dentro da transação', async () => {
    await updateAccount(admin, 'uuid-outro-admin', { role: 'editor' });

    expect(db.updateUser).toHaveBeenCalledWith('uuid-outro-admin', {
      role: 'editor',
      bumpTokenVersion: true,
      requireOtherActiveAdmin: true,
    });
  });

  it('desativar um admin também', async () => {
    db.updateUser.mockResolvedValue({ ...outroAdmin, isActive: false });

    await updateAccount(admin, 'uuid-outro-admin', { isActive: false });

    expect(db.updateUser).toHaveBeenCalledWith('uuid-outro-admin', {
      isActive: false,
      bumpTokenVersion: true,
      requireOtherActiveAdmin: true,
    });
  });

  it('quem não é admin não liga a invariante: promover e desativar seguem sem ela', async () => {
    db.getUserByUuid.mockResolvedValue(conta('editor'));
    db.updateUser.mockResolvedValue(conta('editor'));

    await updateAccount(admin, 'uuid-editor', { role: 'admin' });
    expect(db.updateUser).toHaveBeenLastCalledWith('uuid-editor', {
      role: 'admin',
      bumpTokenVersion: true,
    });

    await updateAccount(admin, 'uuid-editor', { isActive: false });
    expect(db.updateUser).toHaveBeenLastCalledWith('uuid-editor', {
      isActive: false,
      bumpTokenVersion: true,
    });
  });

  it('mudar só o nome de um admin não abre transação nem consulta o grupo', async () => {
    db.updateUser.mockResolvedValue({ ...outroAdmin, name: 'Outro' });

    await updateAccount(admin, 'uuid-outro-admin', { name: 'Outro' });

    expect(db.updateUser).toHaveBeenCalledWith('uuid-outro-admin', { name: 'Outro' });
    expect(db.listUsers).not.toHaveBeenCalled();
  });

  it('a recusa do banco chega com a mesma frase e não deixa linha na trilha', async () => {
    // É a corrida perdida: o outro PATCH venceu, este UPDATE foi desfeito.
    db.updateUser.mockRejectedValue(
      erro('Esta é a última conta de administrador ativa — promova outra antes'),
    );

    await expect(updateAccount(admin, 'uuid-outro-admin', { role: 'editor' })).rejects.toThrow(
      /última conta de administrador ativa/,
    );

    expect(db.recordAccountAudit).not.toHaveBeenCalled();
  });

  it('a recusa cedo continua valendo, sem chegar ao banco', async () => {
    // Uma admin ativa só, que é justamente a que o PATCH quer rebaixar.
    db.listUsers.mockResolvedValue([outroAdmin]);

    await expect(updateAccount(admin, 'uuid-outro-admin', { role: 'editor' })).rejects.toThrow(
      /última conta de administrador ativa/,
    );

    expect(db.updateUser).not.toHaveBeenCalled();
  });
});

/**
 * A senha trocada por quem não é o dono logado entra na trilha (`tasks/030`):
 * era a ação mais forte da tela de contas e a única sem registro. A linha diz
 * quem agiu e em quem, e não carrega segredo nenhum.
 */
describe('auditoria da troca de senha', () => {
  const admin = {
    uuid: 'uuid-admin',
    email: 'admin@exemplo.com',
    name: 'Admin',
    role: 'admin' as const,
    mustChangePassword: false,
    legacy: false,
  };

  beforeEach(() => {
    db.getUserByUuid.mockResolvedValue(conta('editor'));
    db.updateUser.mockResolvedValue(conta('editor'));
  });

  it('a redefinição pelo admin registra quem fez e em quem', async () => {
    const { temporaryPassword } = await resetAccountPassword(admin, 'uuid-editor');

    expect(db.updateUser).toHaveBeenCalledWith('uuid-editor', expect.objectContaining({ bumpTokenVersion: true }));
    expect(db.recordAccountAudit).toHaveBeenCalledWith({
      action: 'user.password',
      source: 'web-admin',
      actor: { userUuid: 'uuid-admin', label: 'admin@exemplo.com' },
      targetLabel: 'editor@exemplo.com',
    });
    // Nem a senha temporária nem o hash dela encostam na trilha.
    const linha = JSON.stringify(db.recordAccountAudit.mock.calls[0]);
    expect(linha).not.toContain(temporaryPassword);
    expect(linha).not.toContain('scrypt');
  });

  it('a sessão de bootstrap aparece como bootstrap, não com e-mail vazio', async () => {
    await resetAccountPassword({ ...admin, uuid: null, email: '', legacy: true }, 'uuid-editor');

    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { userUuid: null, label: 'bootstrap' } }),
    );
  });

  it('o link de e-mail registra o caminho como ator, não a conta', async () => {
    db.consumeResetToken.mockResolvedValue({ userUuid: 'uuid-editor' });

    await confirmPasswordReset('t'.repeat(32), SENHA);

    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.password',
        actor: { userUuid: null, label: 'link-de-redefinicao' },
        targetLabel: 'editor@exemplo.com',
      }),
    );
  });

  it('uma falha na trilha não derruba a redefinição: a senha temporária só existe na resposta', async () => {
    db.recordAccountAudit.mockRejectedValue(new Error('CHECK recusou a ação'));

    await expect(resetAccountPassword(admin, 'uuid-editor')).resolves.toHaveProperty('temporaryPassword');
    expect(console.error).toHaveBeenCalled();
  });
});
