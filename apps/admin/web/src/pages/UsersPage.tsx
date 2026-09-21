import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, Search, UserPlus, Users } from 'lucide-react';
import {
  ROLES,
  ROLE_HINT,
  ROLE_LABEL,
  createUser,
  formatRelative,
  getUsers,
  num,
  type Role,
  type SessionUser,
  type UserSummary,
} from '../api.js';
import { Badge, Button, CopyButton, EmptyRow, Field, Menu, MenuItem, Modal, Status, Skel, useDebounced } from '../components/ui.js';
import { initials } from '../components/SkillIcon.js';
import { useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';

type Filter = 'all' | 'active' | 'disabled' | 'temporary';
const FILTER_LABEL: Record<Filter, string> = {
  all: 'Todas',
  active: 'Ativas',
  disabled: 'Desativadas',
  temporary: 'Com senha temporária',
};

/**
 * A lista de contas (`docs/13-fichas-e-acessos.md` §3.4): só navega. Clicar
 * numa conta abre a ficha dela, só leitura; papel, estado, senha e chaves
 * se mudam em Editar. "Nova conta" é um modal, como nos servidores e nos
 * catálogos. Só admin chega aqui.
 */
export function UsersPage({ me }: { me: SessionUser }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const dq = useDebounced(query, 200);
  const filter = (params.get('filter') as Filter | null) ?? 'all';
  const creating = params.get('new') === '1';

  // O cleanup descarta a resposta atrasada: com duas buscas no ar — a da
  // montagem e a recarga de "Nova conta" —, a antiga podia chegar por último e
  // apagar da lista a conta recém-criada. Quem quer recarregar mexe em
  // `reload`, e não chama a busca por fora.
  useEffect(() => {
    let active = true;
    getUsers()
      .then((data) => {
        if (active) setUsers(data.items);
      })
      .catch((err) => {
        if (!active) return;
        toast.error((err as Error).message);
        setUsers([]);
      });
    return () => {
      active = false;
    };
  }, [reload, toast]);

  useRegisterCommands(
    [{ id: 'new-user', label: 'Nova conta', group: 'Criar', icon: <UserPlus />, keywords: ['usuário', 'convidar', 'conta'], run: () => setParams({ new: '1' }) }],
    [],
  );

  const visible = useMemo(() => {
    let list = users ?? [];
    const needle = dq.trim().toLowerCase();
    if (needle) list = list.filter((user) => user.name.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle));
    if (filter === 'active') list = list.filter((user) => user.isActive);
    if (filter === 'disabled') list = list.filter((user) => !user.isActive);
    if (filter === 'temporary') list = list.filter((user) => user.mustChangePassword);
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [users, dq, filter]);

  const active = (users ?? []).filter((user) => user.isActive).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Usuários</h1>
        <div className="page-actions">
          <label className="search-bar">
            <Search />
            <input
              type="search"
              className="field"
              style={{ minWidth: 240 }}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Procurar conta"
            />
          </label>
          <Button onClick={() => setParams({ new: '1' })}>
            <UserPlus /> Nova conta
          </Button>
        </div>
      </div>

      <div className="meta-line">
        <span className="stat">
          <Users />
          {users ? `${num(users.length)} conta${users.length === 1 ? '' : 's'}, ${num(active)} ativa${active === 1 ? '' : 's'}` : 'Carregando…'}
        </span>
        <span className="sep" />
        <Menu
          trigger={(props) => (
            <button type="button" className="sort" {...props}>
              Filtro: <b>{FILTER_LABEL[filter]}</b> <ChevronDown />
            </button>
          )}
        >
          {(Object.keys(FILTER_LABEL) as Filter[]).map((key) => (
            <MenuItem key={key} onSelect={() => setParams(key === 'all' ? {} : { filter: key })}>
              {FILTER_LABEL[key]}
            </MenuItem>
          ))}
        </Menu>
        <span className="end text-xs" style={{ color: 'var(--text-faint)' }}>
          O papel vale para o acervo inteiro; o escopo é por objeto.
        </span>
      </div>

      {users === null && <Skel h={220} />}

      {users !== null && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Pessoa</th>
                <th>Papel</th>
                <th>Estado</th>
                <th className="hidden md:table-cell">Último acesso</th>
                <th className="hidden lg:table-cell">Criada</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => {
                const self = user.uuid === me.uuid;
                return (
                  <tr key={user.uuid} className={user.isActive ? undefined : 'is-off'}>
                    <td>
                      <Link to={`/users/${user.uuid}`} className="flex items-center gap-3 no-underline">
                        <span className="avatar">{initials(user.name)}</span>
                        <span className="min-w-0">
                          <span className="row-title">
                            {user.name}
                            {self && <Badge className="ml-2">você</Badge>}
                          </span>
                          <span className="row-sub">
                            {user.email}
                            {user.oidcIssuer && ' · SSO'}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <Badge tone={user.role === 'admin' ? 'accent' : 'outline'} title={ROLE_HINT[user.role]}>
                        {ROLE_LABEL[user.role]}
                      </Badge>
                    </td>
                    <td>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Status tone={user.isActive ? 'ok' : 'off'}>{user.isActive ? 'Ativa' : 'Desativada'}</Status>
                        {user.mustChangePassword && <Badge tone="warn">senha temporária</Badge>}
                        {user.lockedUntil && new Date(user.lockedUntil) > new Date() && <Badge tone="danger">bloqueada</Badge>}
                      </div>
                    </td>
                    <td className="hidden md:table-cell">
                      <span className="row-sub whitespace-nowrap">{user.lastLoginAt ? formatRelative(user.lastLoginAt) : 'nunca entrou'}</span>
                    </td>
                    <td className="hidden lg:table-cell">
                      <span className="row-sub whitespace-nowrap">{formatRelative(user.createdAt)}</span>
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <EmptyRow colSpan={5}>{dq || filter !== 'all' ? 'Nenhuma conta com esse filtro' : 'Nenhuma conta ainda'}</EmptyRow>
              )}
            </tbody>
          </table>
        </div>
      )}

      {users !== null && users.length > 0 && (
        <p className="panel-hint mt-5">
          Contas nunca são apagadas — quem sai é desativado na ficha, para a auditoria continuar fazendo sentido.
        </p>
      )}

      <NewUserModal
        open={creating}
        onClose={() => setParams({})}
        onCreated={(user) => {
          setReload((current) => current + 1);
          navigate(`/users/${user.uuid}`);
        }}
      />
    </div>
  );
}

/**
 * "Nova conta": e-mail, nome e papel. A conta nasce com uma senha
 * temporária, mostrada uma única vez aqui mesmo — o modal só fecha depois
 * de quem criou dizer que anotou.
 */
function NewUserModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (user: UserSummary) => void }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ user: UserSummary; password: string | null } | null>(null);

  function reset() {
    setEmail('');
    setName('');
    setRole('editor');
    setCreated(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await createUser({ email, name, role });
      toast.success(`Conta criada para ${result.user.email}.`);
      setCreated({ user: result.user, password: result.temporaryPassword });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    const user = created?.user;
    reset();
    if (user) onCreated(user);
    else onClose();
  }

  return (
    <Modal
      open={open}
      title={created ? 'Conta criada' : 'Nova conta'}
      onClose={() => {
        if (created) finish();
        else {
          reset();
          onClose();
        }
      }}
    >
      {created ? (
        <div className="mt-3 grid gap-4">
          {created.password ? (
            <div className="key-reveal" style={{ marginTop: 0 }}>
              <p className="t">
                Senha temporária de <strong>{created.user.email}</strong> — anote agora, ela não volta a aparecer. No
                primeiro acesso a pessoa é obrigada a trocá-la.
              </p>
              <div className="row">
                <code>{created.password}</code>
                <CopyButton text={created.password} />
              </div>
            </div>
          ) : (
            <p className="hint">A conta nasceu com a senha informada.</p>
          )}
          <div className="actions">
            <Button onClick={finish}>Já anotei, abrir a conta</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-3 grid gap-4">
          <Field label="E-mail">
            <input type="email" className="field" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="pessoa@exemplo.com" autoFocus />
          </Field>
          <Field label="Nome">
            <input className="field" value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome de quem vai usar" />
          </Field>
          <Field label="Papel" hint={ROLE_HINT[role]}>
            <select className="field" value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {ROLES.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABEL[option]}
                </option>
              ))}
            </select>
          </Field>
          <p className="hint">
            A conta nasce com uma senha temporária, mostrada uma vez ao criar. Contas nunca são apagadas — quem sai é
            desativado.
          </p>
          <div className="actions">
            <Button
              variant="ghost"
              onClick={() => {
                reset();
                onClose();
              }}
              disabled={busy}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || !email.trim() || !name.trim()}>
              {busy ? 'Criando…' : 'Criar conta'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
