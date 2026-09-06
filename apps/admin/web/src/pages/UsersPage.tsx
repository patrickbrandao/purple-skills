import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  ROLE_LABEL,
  createUser,
  formatDateTime,
  getUsers,
  resetUserPassword,
  updateUser,
  type Role,
  type SessionUser,
  type UserSummary,
} from '../api.js';
import { Button, Field, Panel } from '../components/ui.js';
import { CopyIcon, PlusIcon, UsersIcon } from '../components/Icons.js';
import { useToast } from '../components/Toast.js';

const ROLES: Role[] = ['admin', 'editor', 'leitor'];

const ROLE_HINT: Record<Role, string> = {
  admin: 'Faz tudo, inclusive apagar skills e gerenciar contas.',
  editor: 'Cria e edita qualquer skill; não apaga nem gerencia contas.',
  leitor: 'Só lê — inclusive as skills privadas.',
};

export function UsersPage({ me }: { me: SessionUser }) {
  const toast = useToast();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  /** Senha temporária mostrada uma vez, para ser passada à pessoa. */
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers((await getUsers()).items);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await createUser({ email, name, role });
      setEmail('');
      setName('');
      if (created.temporaryPassword) {
        setSecret({ email: created.user.email, password: created.temporaryPassword });
      }
      toast.success(`Conta criada para ${created.user.email}.`);
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(user: UserSummary, changes: { role?: Role; isActive?: boolean }) {
    try {
      await updateUser(user.uuid, changes);
      toast.success(
        changes.role
          ? `${user.email} agora é ${ROLE_LABEL[changes.role]}.`
          : `${user.email} foi ${changes.isActive ? 'reativado' : 'desativado'}.`,
      );
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function reset(user: UserSummary) {
    if (!window.confirm(`Gerar uma senha temporária para ${user.email}? A senha atual deixa de valer.`)) {
      return;
    }
    try {
      const result = await resetUserPassword(user.uuid);
      setSecret({ email: user.email, password: result.temporaryPassword });
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="display">Contas</h1>
          <p className="sub">
            {users.length} conta{users.length === 1 ? '' : 's'} — o papel vale para o catálogo
            inteiro, não por skill.
          </p>
        </div>
      </div>

      {secret && (
        <div className="key-reveal mb-5">
          <p className="t">
            Senha temporária de <strong>{secret.email}</strong> — anote agora, ela não volta a
            aparecer. No primeiro acesso a pessoa é obrigada a trocá-la.
          </p>
          <div className="row">
            <code>{secret.password}</code>
            <button
              type="button"
              className="row-action"
              title="Copiar"
              onClick={() => {
                void navigator.clipboard?.writeText(secret.password);
                toast.success('Senha copiada.');
              }}
            >
              <CopyIcon />
            </button>
          </div>
          <button type="button" className="dismiss" onClick={() => setSecret(null)}>
            Já anotei, pode esconder
          </button>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <Panel title="Quem tem acesso" icon={<UsersIcon />}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Pessoa</th>
                  <th>Papel</th>
                  <th className="hidden md:table-cell">Último acesso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const self = user.uuid === me.uuid;
                  return (
                    <tr key={user.uuid} className={user.isActive ? undefined : 'is-off'}>
                      <td>
                        <span className="row-title">
                          {user.name}
                          {self && <span className="tag ml-2">você</span>}
                          {!user.isActive && <span className="tag ml-2">desativada</span>}
                        </span>
                        <span className="row-sub">
                          {user.email}
                          {user.oidcIssuer && ' · SSO'}
                          {user.mustChangePassword && ' · senha temporária'}
                        </span>
                      </td>
                      <td>
                        <select
                          className="field field-sm"
                          value={user.role}
                          disabled={self}
                          title={self ? 'Você não pode mudar o próprio papel' : ROLE_HINT[user.role]}
                          onChange={(event) =>
                            void patch(user, { role: event.target.value as Role })
                          }
                        >
                          {ROLES.map((option) => (
                            <option key={option} value={option}>
                              {ROLE_LABEL[option]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="hidden md:table-cell">
                        <span className="row-sub">
                          {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'nunca entrou'}
                        </span>
                      </td>
                      <td className="num">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="link-action"
                            onClick={() => void reset(user)}
                          >
                            Resetar senha
                          </button>
                          <button
                            type="button"
                            className="link-action"
                            disabled={self}
                            onClick={() => void patch(user, { isActive: !user.isActive })}
                          >
                            {user.isActive ? 'Desativar' : 'Reativar'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <p className="list-empty">Nenhuma conta ainda.</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Convidar alguém" icon={<PlusIcon />}>
          <form onSubmit={submit} className="grid gap-4">
            <Field label="E-mail">
              <input
                type="email"
                className="field"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="pessoa@exemplo.com"
              />
            </Field>
            <Field label="Nome">
              <input
                className="field"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Nome de quem vai usar"
              />
            </Field>
            <Field label="Papel" hint={ROLE_HINT[role]}>
              <select
                className="field"
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {ROLES.map((option) => (
                  <option key={option} value={option}>
                    {ROLE_LABEL[option]}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" disabled={busy || !email || !name}>
              Criar conta
            </Button>
            <p className="panel-hint">
              A conta nasce com uma senha temporária, mostrada uma vez aqui. Contas nunca são
              apagadas — quem sai é desativado, para a auditoria continuar fazendo sentido.
            </p>
          </form>
        </Panel>
      </div>
    </>
  );
}
