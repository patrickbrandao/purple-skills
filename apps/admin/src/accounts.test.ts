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

/**
 * Mutável de propósito: o caso da allowlist vazia troca `oidcAllowedDomains` e o
 * da tabela vazia desliga `oidcAutoProvision`. O `beforeEach` repõe os dois.
 */
const cfg = vi.hoisted(() => ({
  loginMaxAttempts: 5,
  loginLockSeconds: 60,
  resetTtlSeconds: 3600,
  oidcAllowedDomains: ['exemplo.com'] as string[],
  oidcAutoProvision: true,
}));

vi.mock('./config.js', () => ({ config: cfg }));

/** O envio do link de redefinição: o `requestPasswordReset` o importa sob demanda. */
const mailer = vi.hoisted(() => ({ sendMail: vi.fn(), passwordResetMessage: vi.fn() }));

vi.mock('./mailer.js', () => mailer);

const {
  bootstrapAdmin,
  changeOwnPassword,
  confirmPasswordReset,
  createAccount,
  issueKey,
  loginWithPassword,
  requestPasswordReset,
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
  cfg.oidcAutoProvision = true;
  db.badRequest.mockImplementation(erro);
  db.conflict.mockImplementation(erro);
  db.unauthorized.mockImplementation(erro);
  db.adoptOrphans.mockResolvedValue({ adopted: true, skills: 2, catalogs: 1 });
  // `clearAllMocks` limpa as chamadas, não a implementação: sem isto a trilha
  // "fora do ar" de um caso de melhor esforço vaza para os testes seguintes.
  db.recordAccountAudit.mockResolvedValue(undefined);
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
    // O primeiro admin já existe: com a tabela vazia o SSO não provisiona
    // ninguém (ver "a primeira conta é o admin do setup", mais abaixo).
    db.countUsers.mockResolvedValue(1);
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
 * A primeira conta é o admin do `/api/setup` (relatório 001 da auditoria de
 * 2026-09-19). O setup e o login pela `ADMIN_PASSWORD` fecham quando aparece
 * **qualquer** conta, então um `membro` auto-provisionado com a tabela vazia
 * deixava a instalação com conta, sem administrador e sem caminho para criar
 * um — a volta era SQL à mão. A outra porta que produzia o estado, o
 * `POST /api/users` na sessão de bootstrap, está em `routes.test.ts`.
 */
describe('a primeira conta é o admin do setup', () => {
  const sso = (extra: Record<string, unknown> = {}) =>
    resolveOidcUser({
      issuer: 'https://idp',
      subject: 'sub-9',
      email: 'novo@exemplo.com',
      emailVerified: true,
      ...extra,
    } as never);

  beforeEach(() => {
    db.getUserByOidc.mockResolvedValue(null);
    db.getUserByEmail.mockResolvedValue(null);
    db.countUsers.mockResolvedValue(0);
  });

  it('com a tabela vazia, o SSO não provisiona ninguém e aponta o cadastro do primeiro administrador', async () => {
    await expect(sso()).rejects.toThrow(/primeiro administrador/);

    expect(db.createUser).not.toHaveBeenCalled();
    expect(db.recordAccountAudit).not.toHaveBeenCalled();
    expect(db.registerSuccessfulLogin).not.toHaveBeenCalled();
  });

  it('a recusa vem antes da do auto-provisionamento desligado: não há administrador a quem pedir convite', async () => {
    cfg.oidcAutoProvision = false;

    await expect(sso()).rejects.toThrow(/primeiro administrador/);
  });

  it('com o primeiro admin criado, o auto-provisionamento volta a valer', async () => {
    db.countUsers.mockResolvedValue(1);
    db.createUser.mockResolvedValue(conta('membro'));

    await sso();

    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'novo@exemplo.com', role: 'membro' }));
  });

  it('autenticar e vincular não pagam a contagem: os dois exigem conta que já existe', async () => {
    const vinculada = { ...conta('editor'), oidcIssuer: 'https://idp', oidcSubject: 'sub-9' };

    db.getUserByOidc.mockResolvedValue(vinculada);
    await sso({ email: 'editor@exemplo.com' });

    db.getUserByOidc.mockResolvedValue(null);
    db.getUserByEmail.mockResolvedValue(conta('editor'));
    db.updateUser.mockResolvedValue(vinculada);
    await sso({ email: 'editor@exemplo.com' });

    expect(db.countUsers).not.toHaveBeenCalled();
  });
});

/**
 * Conta pré-criada que chega por SSO (relatório 002 da auditoria de 2026-09-19).
 * Toda conta criada em "Nova conta" nasce com senha temporária e
 * `mustChangePassword`; o vínculo não tocava a flag, e quem entrava por SSO caía
 * na tela que cobra a senha temporária — que só o administrador viu. Desligar só
 * a flag deixaria a temporária valendo para sempre (`requirePasswordChanged`),
 * então ela morre junto com o vínculo e a conta vira só-SSO.
 */
describe('senha temporária no vínculo por SSO', () => {
  const sso = () =>
    resolveOidcUser({
      issuer: 'https://idp',
      subject: 'sub-9',
      email: 'editor@exemplo.com',
      emailVerified: true,
    } as never);

  const vinculada = { ...conta('editor'), oidcIssuer: 'https://idp', oidcSubject: 'sub-9' };

  beforeEach(() => {
    db.getUserByOidc.mockResolvedValue(null);
  });

  it('a conta pré-criada vira só-SSO: a temporária é descartada e as sessões abertas com ela caem', async () => {
    db.getUserByEmail.mockResolvedValue({ ...conta('editor'), mustChangePassword: true });
    db.updateUser.mockResolvedValue({ ...vinculada, passwordHash: null, hasPassword: false, tokenVersion: 1 });

    const user = await sso();

    expect(db.updateUser).toHaveBeenCalledWith('uuid-editor', {
      oidcIssuer: 'https://idp',
      oidcSubject: 'sub-9',
      passwordHash: null,
      mustChangePassword: false,
      bumpTokenVersion: true,
    });
    // A rota emite o cookie com a versão que volta daqui, já incrementada.
    expect(user).toMatchObject({ mustChangePassword: false, tokenVersion: 1 });
  });

  it('senha escolhida pela própria pessoa não é tocada: a conta fica com SSO e senha', async () => {
    db.getUserByEmail.mockResolvedValue(conta('editor'));
    db.updateUser.mockResolvedValue(vinculada);

    await sso();

    expect(db.updateUser).toHaveBeenCalledWith('uuid-editor', { oidcIssuer: 'https://idp', oidcSubject: 'sub-9' });
  });

  it('identidade já vinculada não descarta nada: ali a temporária veio de um ato do administrador', async () => {
    db.getUserByOidc.mockResolvedValue({ ...vinculada, mustChangePassword: true });

    const user = await sso();

    expect(db.updateUser).not.toHaveBeenCalled();
    expect(user.mustChangePassword).toBe(true);
  });
});

/**
 * Vínculo e reativação na trilha (relatório 003 da auditoria de 2026-09-19): os
 * dois mudam **quem consegue entrar** na conta e não deixavam linha. O vínculo
 * acontece uma vez por conta — não é login, que segue fora da trilha
 * (`docs/05-accounts-and-roles.md` §2.8) — e é melhor esforço: quando a linha é
 * escrita o vínculo já foi gravado.
 */
describe('auditoria do vínculo por SSO', () => {
  const sso = () =>
    resolveOidcUser({
      issuer: 'https://idp',
      subject: 'sub-9',
      email: 'editor@exemplo.com',
      emailVerified: true,
    } as never);

  const vinculada = { ...conta('editor'), oidcIssuer: 'https://idp', oidcSubject: 'sub-9' };

  beforeEach(() => {
    db.getUserByOidc.mockResolvedValue(null);
    db.getUserByEmail.mockResolvedValue(conta('editor'));
    db.updateUser.mockResolvedValue(vinculada);
  });

  it('grava user.link com o caminho como ator e o subject no alvo', async () => {
    await sso();

    expect(db.recordAccountAudit).toHaveBeenCalledTimes(1);
    expect(db.recordAccountAudit).toHaveBeenCalledWith({
      action: 'user.link',
      source: 'web-admin',
      actor: { userUuid: null, label: 'oidc:https://idp' },
      targetLabel: 'editor@exemplo.com (sub sub-9)',
    });
  });

  it('o vínculo que descarta a senha temporária diz isso na mesma linha', async () => {
    db.getUserByEmail.mockResolvedValue({ ...conta('editor'), mustChangePassword: true });

    await sso();

    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.link',
        targetLabel: 'editor@exemplo.com (sub sub-9; senha temporária descartada)',
      }),
    );
  });

  it('a entrada seguinte, já vinculada, não grava nada: login fica fora da trilha', async () => {
    db.getUserByOidc.mockResolvedValue(vinculada);

    await sso();

    expect(db.recordAccountAudit).not.toHaveBeenCalled();
  });

  it('uma falha na trilha não derruba o login: o vínculo já foi gravado', async () => {
    db.recordAccountAudit.mockRejectedValue(new Error('CHECK recusou a ação'));

    await expect(sso()).resolves.toHaveProperty('uuid', 'uuid-editor');

    expect(db.registerSuccessfulLogin).toHaveBeenCalledWith('uuid-editor');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('editor@exemplo.com'),
      expect.objectContaining({ message: 'CHECK recusou a ação' }),
    );
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

  // Relatório 003 da auditoria de 2026-09-19: desativar entrava na trilha e
  // reativar não — e reativar devolve de uma vez o login, as concessões e as
  // chaves `psk_` da conta.
  it('true reativa, derruba as sessões antigas e grava user.activate com quem reativou', async () => {
    db.getUserByUuid.mockResolvedValue({ ...conta('editor'), isActive: false });

    await updateAccount(admin, 'uuid-editor', { isActive: true });

    expect(db.updateUser).toHaveBeenCalledWith('uuid-editor', { isActive: true, bumpTokenVersion: true });
    expect(db.recordAccountAudit).toHaveBeenCalledTimes(1);
    expect(db.recordAccountAudit).toHaveBeenCalledWith({
      action: 'user.activate',
      source: 'web-admin',
      actor: { userUuid: 'uuid-admin', label: 'admin@exemplo.com' },
      targetLabel: 'editor@exemplo.com',
    });
  });

  it('true numa conta que já está ativa não é reativação: nada na trilha', async () => {
    await updateAccount(admin, 'uuid-editor', { isActive: true });

    expect(db.updateUser).toHaveBeenCalledWith('uuid-editor', {});
    expect(db.recordAccountAudit).not.toHaveBeenCalled();
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

/**
 * A trava de login por tentativas erradas (relatório 005 da auditoria de
 * 2026-09-19). A ficha da conta promete que gerar a senha temporária "destrava
 * na hora", mas o login confere `locked_until` **antes** da senha: a temporária
 * certa era recusada com 429 até a trava vencer. O destrave vai no mesmo UPDATE
 * (`clearLoginLock`, do dba). A troca pelo próprio dono não mexe na trava — quem
 * está logado não está trancado do lado de fora.
 */
describe('a senha temporária destrava a conta', () => {
  const admin = {
    uuid: 'uuid-admin',
    email: 'admin@exemplo.com',
    name: 'Admin',
    role: 'admin' as const,
    mustChangePassword: false,
    legacy: false,
  };

  beforeEach(() => {
    db.getUserByUuid.mockResolvedValue({ ...conta('editor'), lockedUntil: '2999-01-01T00:00:00Z' });
    db.updateUser.mockResolvedValue(conta('editor'));
  });

  it('a redefinição pelo admin zera a trava junto com a senha', async () => {
    const { user } = await resetAccountPassword(admin, 'uuid-editor');

    expect(db.updateUser).toHaveBeenCalledWith('uuid-editor', {
      passwordHash: expect.stringMatching(/^scrypt\$/),
      mustChangePassword: true,
      bumpTokenVersion: true,
      clearLoginLock: true,
    });
    // A ficha repinta com o que volta daqui: o aviso de bloqueio some na hora.
    expect(user.lockedUntil).toBeNull();
  });

  it('a troca pelo próprio dono não mexe na trava', async () => {
    const editor = { ...admin, uuid: 'uuid-editor', email: 'editor@exemplo.com', role: 'editor' as const };

    await changeOwnPassword(editor, { currentPassword: SENHA, newPassword: 'outra-senha-bem-longa' });

    expect(db.updateUser).toHaveBeenCalledWith('uuid-editor', {
      passwordHash: expect.stringMatching(/^scrypt\$/),
      mustChangePassword: false,
      bumpTokenVersion: true,
    });
  });
});

/**
 * O pedido de link por e-mail. A rota não espera esta função (o tempo dela
 * depende de haver conta), então o que acontece aqui dentro só aparece no log:
 * a falha de envio precisa dizer de qual conta era, porque o link anterior já
 * foi fechado pelo `createResetToken` e a pessoa ficou sem nenhum.
 */
describe('pedido de redefinição de senha', () => {
  const linkFor = (token: string) => `https://painel.exemplo.com/?reset=${token}`;

  beforeEach(() => {
    mailer.passwordResetMessage.mockReturnValue({ subject: 'assunto', text: 'texto' });
    mailer.sendMail.mockResolvedValue(true);
    db.createResetToken.mockResolvedValue(undefined);
  });

  it('com conta ativa grava o hash do token e envia o link para o e-mail da conta', async () => {
    db.getUserByEmail.mockResolvedValue(conta('editor'));

    await requestPasswordReset(' Editor@Exemplo.com ', linkFor);

    expect(db.getUserByEmail).toHaveBeenCalledWith('editor@exemplo.com');
    expect(db.createResetToken).toHaveBeenCalledWith(
      expect.objectContaining({ userUuid: 'uuid-editor', tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    );
    expect(mailer.sendMail).toHaveBeenCalledWith({ to: 'editor@exemplo.com', subject: 'assunto', text: 'texto' });
    // O token vai só no link; o banco fica com o hash.
    const link = mailer.passwordResetMessage.mock.calls[0]![1] as string;
    expect(link).not.toContain(db.createResetToken.mock.calls[0]![0].tokenHash);
  });

  it.each([
    ['sem conta', null],
    ['com conta desativada', { ...conta('editor'), isActive: false }],
  ])('%s não grava nem envia nada', async (_caso, user) => {
    db.getUserByEmail.mockResolvedValue(user);

    await requestPasswordReset('editor@exemplo.com', linkFor);

    expect(db.createResetToken).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('e-mail inválido nem consulta o banco', async () => {
    await requestPasswordReset(undefined, linkFor);
    await requestPasswordReset('não é e-mail', linkFor);

    expect(db.getUserByEmail).not.toHaveBeenCalled();
  });

  it('falha de envio não propaga: vira log com o e-mail da conta, que ficou sem link nenhum', async () => {
    db.getUserByEmail.mockResolvedValue(conta('editor'));
    mailer.sendMail.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:25'));

    await expect(requestPasswordReset('editor@exemplo.com', linkFor)).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/editor@exemplo\.com.*envio falhou.*link anterior/s),
      expect.objectContaining({ message: 'connect ECONNREFUSED 127.0.0.1:25' }),
    );
  });
});

/**
 * Campo de texto que não é texto (achado do relatório 007 da auditoria de
 * 2026-09-19). `String(valor ?? '')` estourava `TypeError` no objeto cujo
 * `toString` não é função — `{"name":{"toString":1}}` —, que a rota devolvia
 * como 500 com linha de "erro inesperado" no log; e aceitava o resto em
 * silêncio: `{"name":{}}` criava a conta "[object Object]" e `{"name":null}`
 * rebatizava a conta de "null". Presente e não-texto é 400.
 */
describe('campo de texto que não é texto', () => {
  const admin = {
    uuid: 'uuid-admin',
    email: 'admin@exemplo.com',
    name: 'Admin',
    role: 'admin' as const,
    mustChangePassword: false,
    legacy: false,
  };
  const ator = { userUuid: 'uuid-admin', label: 'admin@exemplo.com' };
  /** O que o `JSON.parse` entrega para `{"toString":1}`: `String()` dele lança. */
  const semToString = () => ({ toString: 1 });

  beforeEach(() => {
    db.getUserByUuid.mockResolvedValue(conta('editor'));
    db.updateUser.mockResolvedValue(conta('editor'));
  });

  it('setup: o nome torto é 400, antes do scrypt e do banco', async () => {
    await expect(
      bootstrapAdmin({ email: 'admin@exemplo.com', name: semToString(), password: SENHA }),
    ).rejects.toThrow(/"name" deve ser uma string/);

    expect(db.countUsers).not.toHaveBeenCalled();
    expect(db.createUser).not.toHaveBeenCalled();
  });

  it.each([
    ['objeto sem toString', semToString()],
    ['objeto', {}],
    ['lista', ['a', 'b']],
    ['número', 123],
    ['booleano', true],
  ] as [string, unknown][])('nova conta: nome que é %s é 400, e a conta não nasce com ele', async (_caso, name) => {
    await expect(createAccount(ator, { email: 'novo@exemplo.com', name, role: 'membro' })).rejects.toThrow(
      /"name" deve ser uma string/,
    );

    expect(db.createUser).not.toHaveBeenCalled();
  });

  it('nova conta: nome ausente ou nulo continua sendo "Informe o nome"', async () => {
    await expect(createAccount(ator, { email: 'novo@exemplo.com', role: 'membro' })).rejects.toThrow(/Informe o nome/);
    await expect(createAccount(ator, { email: 'novo@exemplo.com', name: null, role: 'membro' })).rejects.toThrow(
      /Informe o nome/,
    );
  });

  it('editar conta: nome torto é 400 e nulo é nome vazio — nunca a conta "null"', async () => {
    await expect(updateAccount(admin, 'uuid-editor', { name: semToString() })).rejects.toThrow(
      /"name" deve ser uma string/,
    );
    await expect(updateAccount(admin, 'uuid-editor', { name: null })).rejects.toThrow(/não pode ficar vazio/);

    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('emitir chave: nome torto é 400, sem gerar chave', async () => {
    await expect(issueKey(admin, semToString())).rejects.toThrow(/"name" deve ser uma string/);

    expect(db.createApiKey).not.toHaveBeenCalled();
  });

  it('trocar a própria senha: senha atual torta é 400, não "senha incorreta" nem 500', async () => {
    await expect(
      changeOwnPassword(admin, { currentPassword: semToString(), newPassword: 'outra-senha-bem-longa' }),
    ).rejects.toThrow(/"currentPassword" deve ser uma string/);

    expect(db.updateUser).not.toHaveBeenCalled();
  });

  it('SSO: claim `name` que não é texto não derruba o login — a conta nasce com o e-mail', async () => {
    db.countUsers.mockResolvedValue(1);
    db.getUserByOidc.mockResolvedValue(null);
    db.getUserByEmail.mockResolvedValue(null);
    db.createUser.mockResolvedValue(conta('membro'));

    await resolveOidcUser({
      issuer: 'https://idp',
      subject: 'sub-9',
      email: 'novo@exemplo.com',
      name: semToString(),
    } as never);

    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({ name: 'novo@exemplo.com' }));
  });
});

/**
 * A emissão de uma chave `psk_` rotula a trilha com `<nome> (<prefixo>)`; a
 * revogação gravava o **uuid** da chave — pelado em "as minhas chaves", depois
 * do e-mail na ficha da conta —, que não aparece em tela nenhuma. A revogação do
 * banco passou a devolver nome, prefixo e o e-mail do dono (relatório 040 da
 * auditoria de 2026-09-19).
 */
const { revokeAccountKey, revokeKey } = await import('./accounts.js');

describe('revogar chave psk_: a trilha rotula pelo nome, não pelo uuid da chave', () => {
  const ID = '7c3f9e12-0000-4000-8000-00000000a41b';
  const REVOGADA = { name: 'notebook do trabalho', prefix: 'AbCd1234', userUuid: 'uuid-editor', userEmail: 'editor@exemplo.com' };
  const sessao = (role: 'admin' | 'editor') => ({ ...conta(role), legacy: false });

  beforeEach(() => {
    db.notFound.mockImplementation((message: string) => Object.assign(new Error(message), { status: 404 }));
  });

  it('a própria chave: `<e-mail>: <nome> (<prefixo>)`, restrita ao dono', async () => {
    db.revokeApiKey.mockResolvedValue(REVOGADA);

    await revokeKey(sessao('editor'), ID);

    expect(db.revokeApiKey).toHaveBeenCalledWith(ID, 'uuid-editor');
    expect(db.recordAccountAudit).toHaveBeenCalledWith({
      action: 'key.revoke',
      source: 'web-admin',
      actor: { userUuid: 'uuid-editor', label: 'editor@exemplo.com' },
      targetLabel: 'editor@exemplo.com: notebook do trabalho (AbCd1234)',
    });
  });

  // Com o escopo aberto, o admin chega pela API à chave de outra conta: o rótulo
  // leva o e-mail do **dono**, que veio do próprio UPDATE — não o de quem revogou.
  it('admin revogando chave alheia: o rótulo diz de quem ela era', async () => {
    db.revokeApiKey.mockResolvedValue(REVOGADA);

    await revokeKey(sessao('admin'), ID);

    expect(db.revokeApiKey).toHaveBeenCalledWith(ID, null);
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { userUuid: 'uuid-admin', label: 'admin@exemplo.com' },
        targetLabel: 'editor@exemplo.com: notebook do trabalho (AbCd1234)',
      }),
    );
  });

  it('pela ficha da conta, o mesmo rótulo', async () => {
    db.getUserByUuid.mockResolvedValue(conta('editor'));
    db.revokeApiKey.mockResolvedValue(REVOGADA);

    await revokeAccountKey(sessao('admin'), 'uuid-editor', ID);

    expect(db.revokeApiKey).toHaveBeenCalledWith(ID, 'uuid-editor');
    expect(db.recordAccountAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'key.revoke', targetLabel: 'editor@exemplo.com: notebook do trabalho (AbCd1234)' }),
    );
    expect(JSON.stringify(db.recordAccountAudit.mock.calls)).not.toContain(ID);
  });

  it('chave que não existe, de outra conta ou já revogada é 404 e não audita', async () => {
    db.revokeApiKey.mockResolvedValue(null);

    await expect(revokeKey(sessao('editor'), ID)).rejects.toMatchObject({ status: 404 });
    expect(db.recordAccountAudit).not.toHaveBeenCalled();
  });
});
