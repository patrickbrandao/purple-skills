import { parseArgs } from 'node:util';
import {
  countUsers,
  getUserByLogin,
  getUserByUuid,
  listUsers,
  updateUser,
  type UserRecord,
} from '@purple-skills/db';
import { type UserSummary, isRole } from '@purple-skills/shared';
import {
  adoptOrphansFor,
  createAccount,
  setAccountPassword,
  toPublicUser,
  updateAccount,
} from './accounts.js';
import type { AuthUser } from './auth.js';

/**
 * `purple-admin` — a gerência de contas pela linha de comando do container do
 * painel (`docs/21-cli-admin.md`).
 *
 * É a porta de quem administra o **servidor** e não tem, ou perdeu, acesso ao
 * painel: a senha do único admin esquecida, sem SMTP; a instalação que ficou sem
 * administrador; a conta travada. Quem tem shell no container já tem o banco,
 * então a CLI não abre poder novo — ela troca o SQL à mão por um caminho que
 * passa pelas **mesmas funções** das rotas de `/api/users*`: a validação, a
 * derrubada de sessões, a proteção do último admin e a trilha de auditoria são
 * as do painel, e não uma cópia delas.
 *
 * Na trilha, o ator é `cli` (sem conta, como `bootstrap` e `token-global`) e a
 * origem é `web-admin`, o serviço em que a CLI roda — o `CHECK` de
 * `audit_log.source` não conhece outra, e a linha não precisa de uma.
 */

/** O ator das escritas da CLI. Não é conta: não tem uuid nem sessão. */
export const CLI_ACTOR: AuthUser = {
  uuid: null,
  username: 'cli',
  avatarUpdatedAt: null,
  email: '',
  name: 'Linha de comando',
  role: 'admin',
  mustChangePassword: false,
  legacy: false,
};

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Lê a entrada padrão inteira — só é chamado com `--password-stdin`. */
  readStdin: () => Promise<string>;
};

/** Erro de uso: comando, opção ou argumento que não faz sentido. Sai com 2. */
class UsageError extends Error {}

export const HELP = `Uso: purple-admin <comando> [opções]

Contas do painel (<usuário> = username, @username, e-mail ou uuid):

  user list [--all] [--json]
      Lista as contas ativas; --all inclui as desativadas.
  user show <usuário> [--json]
      Mostra uma conta.
  user add --username <u> --email <e> --role <admin|editor|membro>
           [--name <nome>] [--password <s> | --password-stdin] [--temporary]
      Cria uma conta. Sem senha, sorteia uma temporária e a imprime.
  user passwd <usuário> [--password <s> | --password-stdin] [--temporary]
      Define a senha. Sem senha, sorteia uma temporária e a imprime.
      Derruba as sessões da conta e tira a trava de login.
  user role <usuário> <admin|editor|membro>
      Muda o papel. Derruba as sessões da conta.
  user disable <usuário>
      Desativa a conta (contas não são apagadas).
  user enable <usuário>
      Reativa a conta.
  user unlock <usuário>
      Tira a trava de login por excesso de tentativas.
  user logout <usuário>
      Derruba todas as sessões e cookies da conta.
  help
      Mostra esta ajuda.

--temporary  a conta terá de trocar a senha no próximo acesso (a senha
             sorteada é sempre temporária).
--password   fica no histórico do shell e na lista de processos; prefira
             --password-stdin ou a senha sorteada.

Saída: 0 = ok, 1 = a operação foi recusada, 2 = erro de uso.`;

// ------------------------------------------------------------ utilitários ---

/** Acha a conta por username, e-mail ou uuid. Não achar é erro. */
async function resolveUser(identifier: string | undefined): Promise<UserRecord> {
  // `@ana` é como a conta aparece em toda tela (`docs/19`); sem isto o `@` o
  // faria ser lido como e-mail. Um `@` só no começo não é endereço nenhum.
  const wanted = identifier?.trim().replace(/^@(?=[^@]+$)/, '');
  if (!wanted) throw new UsageError('Informe o usuário, o e-mail ou o uuid da conta');
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted);
  const user = uuidLike ? await getUserByUuid(wanted) : await getUserByLogin(wanted);
  if (!user) throw Object.assign(new Error(`Conta não encontrada: ${wanted}`), { status: 404 });
  return user;
}

/**
 * A senha pedida na linha de comando: `--password` ou `--password-stdin`, nunca
 * os dois. `undefined` = nenhuma, e quem chama sorteia. Da entrada padrão sai só
 * a quebra de linha final — o `echo` e o `printf '%s\n'` a acrescentam, e ela não
 * faz parte da senha; espaço, sim, faz.
 */
async function passwordFrom(
  values: { password?: string; 'password-stdin'?: boolean },
  io: CliIo,
): Promise<string | undefined> {
  if (values.password !== undefined && values['password-stdin']) {
    throw new UsageError('Use --password ou --password-stdin, não os dois');
  }
  if (values['password-stdin']) {
    const raw = (await io.readStdin()).replace(/\r?\n$/, '');
    if (!raw) throw new UsageError('A entrada padrão veio vazia: nenhuma senha para definir');
    return raw;
  }
  if (values.password !== undefined && values.password === '') {
    throw new UsageError('--password vazio: omita a opção para sortear uma senha');
  }
  return values.password;
}

function status(user: UserSummary): string {
  if (!user.isActive) return 'desativada';
  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) return 'travada';
  return 'ativa';
}

function login(user: UserSummary): string {
  const parts: string[] = [];
  if (user.hasPassword) parts.push(user.mustChangePassword ? 'senha temporária' : 'senha');
  if (user.oidcIssuer) parts.push('sso');
  return parts.join(' + ') || 'nenhum';
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd());
}

function describe(user: UserSummary): string[] {
  return [
    `usuário:        @${user.username}`,
    `e-mail:         ${user.email}`,
    `nome:           ${user.name}`,
    `papel:          ${user.role}`,
    `estado:         ${status(user)}${user.lockedUntil && status(user) === 'travada' ? ` até ${user.lockedUntil}` : ''}`,
    `acesso:         ${login(user)}`,
    `último acesso:  ${user.lastLoginAt ?? 'nunca'}`,
    `criada em:      ${user.createdAt}`,
    `uuid:           ${user.uuid}`,
  ];
}

/** A senha sorteada é mostrada uma vez, aqui — como no painel. */
function printPassword(io: CliIo, password: string, generated: boolean, temporary: boolean): void {
  if (generated) {
    io.out(`senha temporária: ${password}`);
    io.out('(anote agora: ela não é mostrada de novo; a troca é exigida no primeiro acesso)');
  } else if (temporary) {
    io.out('a troca da senha será exigida no primeiro acesso');
  }
}

// --------------------------------------------------------------- comandos ---

type Handler = (args: string[], io: CliIo) => Promise<void>;

const userCommands: Record<string, Handler> = {
  async list(args, io) {
    const { values } = parseArgs({
      args,
      options: { all: { type: 'boolean' }, json: { type: 'boolean' } },
      strict: true,
    });
    const users = (await listUsers()).filter((user) => values.all || user.isActive);
    if (values.json) {
      io.out(JSON.stringify(users.map(toPublicUser), null, 2));
      return;
    }
    if (users.length === 0) {
      io.out(values.all ? 'Nenhuma conta cadastrada.' : 'Nenhuma conta ativa.');
      return;
    }
    const rows = [['USUÁRIO', 'E-MAIL', 'PAPEL', 'ESTADO', 'ACESSO', 'NOME']];
    for (const user of users) {
      rows.push([`@${user.username}`, user.email, user.role, status(user), login(user), user.name]);
    }
    for (const line of table(rows)) io.out(line);
  },

  async show(args, io) {
    const { values, positionals } = parseArgs({
      args,
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
      strict: true,
    });
    const user = toPublicUser(await resolveUser(positionals[0]));
    if (values.json) io.out(JSON.stringify(user, null, 2));
    else for (const line of describe(user)) io.out(line);
  },

  async add(args, io) {
    const { values } = parseArgs({
      args,
      options: {
        username: { type: 'string' },
        email: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string' },
        password: { type: 'string' },
        'password-stdin': { type: 'boolean' },
        temporary: { type: 'boolean' },
      },
      strict: true,
    });
    if (!values.username) throw new UsageError('Informe --username');
    if (!values.email) throw new UsageError('Informe --email');
    if (!values.role) throw new UsageError('Informe --role (admin, editor ou membro)');
    if (!isRole(values.role)) throw new UsageError('Papel inválido: use admin, editor ou membro');

    // A primeira conta é sempre admin (`docs/05` §2.3): o `/api/setup` e o login
    // pela `ADMIN_PASSWORD` fecham com **qualquer** conta, e um membro criado
    // aqui deixaria a instalação sem ninguém que pudesse promover ninguém.
    if (values.role !== 'admin' && (await countUsers()) === 0) {
      throw Object.assign(
        new Error('Esta instalação ainda não tem contas: a primeira tem de ser --role admin'),
        { status: 400 },
      );
    }

    const password = await passwordFrom(values, io);
    const { user, temporaryPassword } = await createAccount(
      { userUuid: null, label: CLI_ACTOR.username },
      {
        username: values.username,
        email: values.email,
        name: values.name ?? values.username,
        role: values.role,
        password,
      },
    );

    // `createAccount` não conhece `--temporary`: com senha escolhida a conta nasce
    // sem exigir troca, e o pedido de troca é um segundo passo.
    let summary = user;
    if (password !== undefined && values.temporary) {
      summary = toPublicUser(await updateUser(user.uuid, { mustChangePassword: true }));
    }

    // Mesma adoção do `/api/setup`: se esta é a única admin ativa, o que nasceu
    // sem dono passa a ser dela. Com outras admins o banco não faz nada.
    await adoptOrphansFor(summary, { userUuid: null, label: CLI_ACTOR.username });

    io.out(`conta criada: @${summary.username} <${summary.email}> (${summary.role})`);
    printPassword(io, temporaryPassword ?? '', temporaryPassword !== null, values.temporary === true);
  },

  async passwd(args, io) {
    const { values, positionals } = parseArgs({
      args,
      options: {
        password: { type: 'string' },
        'password-stdin': { type: 'boolean' },
        temporary: { type: 'boolean' },
      },
      allowPositionals: true,
      strict: true,
    });
    const target = await resolveUser(positionals[0]);
    const password = await passwordFrom(values, io);
    const result = await setAccountPassword(CLI_ACTOR, target.uuid, {
      password,
      temporary: values.temporary === true,
    });
    io.out(`senha de @${result.user.username} definida; as sessões da conta foram encerradas`);
    printPassword(io, result.password, result.generated, values.temporary === true);
  },

  async role(args, io) {
    const [identifier, role, ...rest] = args;
    if (rest.length > 0 || !role) throw new UsageError('Uso: user role <usuário> <admin|editor|membro>');
    if (!isRole(role)) throw new UsageError('Papel inválido: use admin, editor ou membro');
    const target = await resolveUser(identifier);
    if (target.role === role) {
      io.out(`@${target.username} já é ${role}`);
      return;
    }
    const updated = await updateAccount(CLI_ACTOR, target.uuid, { role });
    io.out(`@${updated.username} agora é ${updated.role}; as sessões da conta foram encerradas`);
  },

  async disable(args, io) {
    const target = await resolveUser(single(args, 'disable'));
    if (!target.isActive) {
      io.out(`@${target.username} já está desativada`);
      return;
    }
    const updated = await updateAccount(CLI_ACTOR, target.uuid, { isActive: false });
    io.out(`@${updated.username} desativada; as sessões e as chaves de API dela deixam de valer`);
  },

  async enable(args, io) {
    const target = await resolveUser(single(args, 'enable'));
    if (target.isActive) {
      io.out(`@${target.username} já está ativa`);
      return;
    }
    const updated = await updateAccount(CLI_ACTOR, target.uuid, { isActive: true });
    io.out(`@${updated.username} reativada`);
  },

  async unlock(args, io) {
    const target = await resolveUser(single(args, 'unlock'));
    await updateUser(target.uuid, { clearLoginLock: true });
    io.out(`trava de login de @${target.username} removida`);
  },

  async logout(args, io) {
    const target = await resolveUser(single(args, 'logout'));
    await updateUser(target.uuid, { bumpTokenVersion: true });
    io.out(`sessões de @${target.username} encerradas`);
  },
};

function single(args: string[], command: string): string {
  if (args.length !== 1) throw new UsageError(`Uso: user ${command} <usuário>`);
  return args[0];
}

/**
 * Roda um comando e devolve o código de saída. Não fecha o banco nem encerra o
 * processo: quem faz isso é o `admin-cli.ts`, e é isso que deixa este módulo
 * testável.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [group, command, ...rest] = argv;

  if (!group || group === 'help' || group === '--help' || group === '-h') {
    io.out(HELP);
    return 0;
  }

  try {
    if (group !== 'user') throw new UsageError(`Comando desconhecido: ${group}`);
    const handler = command ? userCommands[command] : undefined;
    if (!handler || !Object.hasOwn(userCommands, command)) {
      throw new UsageError(command ? `Subcomando desconhecido: user ${command}` : 'Falta o subcomando de "user"');
    }
    await handler(rest, io);
    return 0;
  } catch (err) {
    // `parseArgs` lança `TypeError` com `code` ERR_PARSE_ARGS_* para opção
    // desconhecida ou sem valor — é erro de uso, como os nossos.
    const code = (err as { code?: unknown }).code;
    if (err instanceof UsageError || (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))) {
      io.err(`erro: ${(err as Error).message}`);
      io.err('veja "purple-admin help"');
      return 2;
    }
    // Recusa das regras de conta (`AppError` do db, com `status`): a mensagem já
    // é a que o painel mostraria.
    if (err instanceof Error && typeof (err as { status?: unknown }).status === 'number') {
      io.err(`erro: ${err.message}`);
      return 1;
    }
    throw err;
  }
}
