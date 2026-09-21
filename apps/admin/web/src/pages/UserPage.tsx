import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, History, KeyRound, ListChecks, Pencil, UserRound } from 'lucide-react';
import {
  ROLE_HINT,
  ROLE_LABEL,
  formatDateTime,
  formatRelative,
  getUser,
  getUserAccesses,
  getUserKeys,
  type ApiKeySummary,
  type SessionUser,
  type UserSummary,
} from '../api.js';
import { Badge, EmptyRow, Panel, Skel, Status, Tabs } from '../components/ui.js';
import { AccessLog } from '../components/AccessLog.js';
import { ActorTrail } from '../components/ActorTrail.js';
import { initials } from '../components/SkillIcon.js';
import { useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';

type Tab = 'account' | 'keys' | 'accesses' | 'activity';

/**
 * A ficha de uma conta, só leitura (`docs/13-fichas-e-acessos.md` §3.4): o
 * título com o avatar, os selos e o botão Editar, e quatro guias — Conta (o
 * que a conta é), Chaves (as `psk_` dela), Acessos (as leituras de skill
 * feitas por essas chaves) e Atividade (a trilha de auditoria filtrada por
 * ela). Nada aqui grava: papel, estado, senha e chaves se mudam em Editar.
 * Só admin chega aqui.
 */
export function UserPage({ me }: { me: SessionUser }) {
  const { uuid = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [user, setUser] = useState<UserSummary | null>(null);

  const tab: Tab = location.pathname.endsWith('/keys')
    ? 'keys'
    : location.pathname.endsWith('/accesses')
      ? 'accesses'
      : location.pathname.endsWith('/activity')
        ? 'activity'
        : 'account';

  // Fora de um data router, `navigate` muda a cada troca de caminho: se a carga
  // dependesse dele, cada troca de guia buscaria a conta de novo e piscaria o
  // esqueleto da ficha inteira.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Uma carga por conta. O cleanup descarta a resposta atrasada: trocando de
  // conta com a ficha montada, a da anterior podia chegar por último.
  useEffect(() => {
    let active = true;
    setUser(null);
    getUser(uuid)
      .then((fresh) => active && setUser(fresh))
      .catch((err) => {
        if (!active) return;
        toast.error((err as Error).message);
        navigateRef.current('/users');
      });
    return () => {
      active = false;
    };
  }, [uuid, toast]);

  const loadAccesses = useCallback(
    (query: Parameters<typeof getUserAccesses>[1]) => getUserAccesses(uuid, query),
    [uuid],
  );

  useRegisterCommands(
    user ? [{ id: 'user-edit', label: `Editar "${user.name}"`, group: 'Recurso', icon: <Pencil />, shortcut: 'e', run: () => navigate(`/users/${user.uuid}/edit`) }] : [],
    [user?.uuid],
  );

  if (!user) {
    return (
      <div className="page">
        <Skel h={20} w={120} className="mb-3" />
        <Skel h={40} w={360} className="mb-6" />
        <Skel h={320} />
      </div>
    );
  }

  const base = `/users/${user.uuid}`;

  return (
    <div className="page wide">
      <div className="page-head">
        <div className="min-w-0">
          <Link to="/users" className="back-link">
            <ArrowLeft /> Usuários
          </Link>
          <UserTitle user={user} me={me} />
        </div>
        <div className="page-actions">
          <Link to={`${base}/edit`} className="btn btn-primary">
            <Pencil /> Editar
          </Link>
        </div>
      </div>

      <UserAlerts user={user} />

      <Tabs
        value={tab}
        items={[
          { key: 'account', label: 'Conta', icon: <UserRound />, to: base },
          { key: 'keys', label: 'Chaves', icon: <KeyRound />, to: `${base}/keys` },
          { key: 'accesses', label: 'Acessos', icon: <History />, to: `${base}/accesses` },
          { key: 'activity', label: 'Atividade', icon: <ListChecks />, to: `${base}/activity` },
        ]}
      />

      <Routes>
        <Route index element={<AccountTab user={user} me={me} />} />
        <Route path="keys" element={<KeysTab user={user} />} />
        <Route path="accesses" element={<AccessLog load={loadAccesses} showSkill />} />
        <Route path="activity" element={<ActorTrail actor={user.email} />} />
      </Routes>
    </div>
  );
}

// ---------------------------------------------------- pedaços partilhados ---

/** Bloqueio de login em vigor (`docs/05` §2.7): a data está no futuro. */
export const isLocked = (user: UserSummary) => user.lockedUntil !== null && new Date(user.lockedUntil) > new Date();

/** O título da ficha: avatar, nome com os selos e a linha com e-mail, papel e datas. */
export function UserTitle({ user, me, name }: { user: UserSummary; me: SessionUser; name?: string }) {
  const self = user.uuid === me.uuid;
  return (
    <div className="flex items-center gap-3">
      <span className="avatar lg">{initials(name || user.name)}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate">{name || user.name}</h1>
          {self && <Badge>você</Badge>}
          <Badge tone={user.role === 'admin' ? 'accent' : 'outline'} title={ROLE_HINT[user.role]}>
            {ROLE_LABEL[user.role]}
          </Badge>
          {!user.isActive && <Badge tone="danger">desativada</Badge>}
          {user.mustChangePassword && <Badge tone="warn">senha temporária</Badge>}
          {user.oidcIssuer && <Badge tone="info">SSO</Badge>}
          {isLocked(user) && <Badge tone="danger">bloqueada</Badge>}
        </div>
        <p className="sub mono flex flex-wrap items-center gap-x-3">
          <span>{user.email}</span>
          <span>· último acesso: {user.lastLoginAt ? formatRelative(user.lastLoginAt) : 'nunca entrou'}</span>
          <span>· criada em {formatDateTime(user.createdAt)}</span>
          <span>· atualizada em {formatDateTime(user.updatedAt)}</span>
        </p>
      </div>
    </div>
  );
}

/** Os avisos de estado, acima das guias, nas duas fichas. */
export function UserAlerts({ user }: { user: UserSummary }) {
  return (
    <>
      {!user.isActive && (
        <p className="notice warn mb-4">
          Esta conta está <strong>desativada</strong>: não entra no painel nem pelo MCP administrativo, e as chaves dela não
          valem. O que ela possui continua existindo; reative-a em Editar.
        </p>
      )}
      {isLocked(user) && (
        <p className="notice danger mb-4">
          Login bloqueado até {formatDateTime(user.lockedUntil!)} por tentativas erradas demais. Gerar uma senha temporária em Editar
          destrava na hora.
        </p>
      )}
    </>
  );
}

/** A tabela de chaves `psk_`, a mesma nas duas fichas; em Editar ganha o revogar. */
export function KeysTable({ keys, onRevoke }: { keys: ApiKeySummary[] | null; onRevoke?: (key: ApiKeySummary) => void }) {
  if (keys === null) return <Skel h={160} />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Chave</th>
            <th className="hidden sm:table-cell">Último uso</th>
            <th className="hidden md:table-cell">Estado</th>
            {onRevoke && <th />}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className={key.revokedAt ? 'is-off' : undefined}>
              <td>
                <span className="row-title">{key.name}</span>
                <span className="row-sub">
                  psk_{key.prefix}_… · emitida em {formatDateTime(key.createdAt)}
                </span>
              </td>
              <td className="hidden sm:table-cell">
                <span className="row-sub">{key.lastUsedAt ? formatDateTime(key.lastUsedAt) : 'nunca usada'}</span>
              </td>
              <td className="hidden md:table-cell">
                {key.revokedAt ? (
                  <Badge tone="danger" title={`Revogada em ${formatDateTime(key.revokedAt)}`}>
                    revogada
                  </Badge>
                ) : (
                  <Status tone="ok">ativa</Status>
                )}
              </td>
              {onRevoke && (
                <td className="num">
                  {!key.revokedAt && (
                    <button type="button" className="link-action" onClick={() => onRevoke(key)}>
                      Revogar
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
          {keys.length === 0 && <EmptyRow colSpan={onRevoke ? 4 : 3}>Nenhuma chave ainda</EmptyRow>}
        </tbody>
      </table>
    </div>
  );
}

/** Carrega as chaves de uma conta; as duas fichas usam. */
export function useUserKeys(uuid: string) {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);

  const reload = useCallback(async () => {
    try {
      setKeys((await getUserKeys(uuid)).items);
    } catch (err) {
      toast.error((err as Error).message);
      setKeys([]);
    }
  }, [uuid, toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { keys, reload };
}

// ------------------------------------------------------------------ guias ---

function AccountTab({ user, me }: { user: UserSummary; me: SessionUser }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
      <Panel title="Conta" icon={<UserRound />}>
        <dl className="kv props-kv">
          <dt>Nome</dt>
          <dd>{user.name}</dd>
          <dt>E-mail</dt>
          <dd className="mono">{user.email}</dd>
          <dt>Papel</dt>
          <dd>
            <Badge tone={user.role === 'admin' ? 'accent' : 'outline'}>{ROLE_LABEL[user.role]}</Badge>
            <span className="hint block">{ROLE_HINT[user.role]}</span>
          </dd>
          <dt>Estado</dt>
          <dd>{user.isActive ? <Status tone="ok">ativa</Status> : <Status tone="off">desativada</Status>}</dd>
          <dt>Autenticação</dt>
          <dd>
            {user.oidcIssuer ? `SSO (${user.oidcIssuer})${user.hasPassword ? ' e senha' : ', sem senha local'}` : user.hasPassword ? 'senha' : 'sem senha'}
            {user.mustChangePassword && <span className="hint block">Senha temporária: a pessoa é obrigada a trocá-la no próximo acesso.</span>}
          </dd>
          <dt>Bloqueio</dt>
          <dd>{isLocked(user) ? `até ${formatDateTime(user.lockedUntil!)}` : 'nenhum'}</dd>
          <dt>Último acesso</dt>
          <dd>{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'nunca entrou'}</dd>
          <dt>Criada em</dt>
          <dd>{formatDateTime(user.createdAt)}</dd>
          <dt>Atualizada em</dt>
          <dd>{formatDateTime(user.updatedAt)}</dd>
          <dt>Identificador</dt>
          <dd className="mono">{user.uuid}</dd>
        </dl>
      </Panel>

      <Panel title="O que o papel decide" icon={<ListChecks />}>
        <p className="panel-hint">
          O papel vale para o acervo inteiro e decide só quem <strong>cria</strong> e quem administra a instalação. O
          escopo é por objeto: a conta administra o que é dela ou lhe foi concedido, e lê o que é público.
        </p>
        <dl className="kv">
          <dt>Cria</dt>
          <dd>{user.role === 'membro' ? 'nada' : 'skills, catálogos e servidores (e vira dona)'}</dd>
          <dt>Instalação</dt>
          <dd>{user.role === 'admin' ? 'contas, auditoria e o MCP padrão' : 'não'}</dd>
          <dt>Chaves psk_</dt>
          <dd>carregam este papel e aparecem na auditoria com o nome dela</dd>
        </dl>
        {user.uuid === me.uuid && <p className="hint mt-3">É a sua conta: o papel e o estado se mudam por outro administrador.</p>}
      </Panel>
    </div>
  );
}

function KeysTab({ user }: { user: UserSummary }) {
  const { keys } = useUserKeys(user.uuid);
  return (
    <Panel title="Chaves do MCP administrativo" icon={<KeyRound />}>
      <p className="panel-hint">
        As chaves <code>psk_</code> que esta conta emitiu em Adm MCP Keys. Cada uma carrega o papel dela e aparece na
        auditoria com o nome dela; revogar é em Editar → Chaves. Só a própria pessoa emite.
      </p>
      <KeysTable keys={keys} />
    </Panel>
  );
}
