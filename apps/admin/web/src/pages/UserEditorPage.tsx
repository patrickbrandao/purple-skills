import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Eye, History, KeyRound, ListChecks, Lock, Save, UserRound } from 'lucide-react';
import {
  ROLES,
  ROLE_HINT,
  ROLE_LABEL,
  getUser,
  getUserAccesses,
  resetUserPassword,
  revokeUserKey,
  updateUser,
  type ApiKeySummary,
  type Role,
  type SessionUser,
  type UserSummary,
} from '../api.js';
import { Button, CopyButton, Field, Panel, Skel, Tabs, useConfirm } from '../components/ui.js';
import { AccessLog } from '../components/AccessLog.js';
import { ActorTrail } from '../components/ActorTrail.js';
import { useRegisterCommands } from '../components/commands.js';
import { useToast } from '../components/Toast.js';
import { KeysTable, UserAlerts, UserTitle, useUserKeys } from './UserPage.js';

type Tab = 'account' | 'keys' | 'accesses' | 'activity';

/**
 * A ficha de uma conta em edição (`docs/13-fichas-e-acessos.md` §3.4): a
 * mesma organização da leitura — Conta, Chaves, Acessos, Atividade — com os
 * campos livres. Nome, papel e estado são gravados pelo Salvar do cabeçalho
 * (e ⌘S); a senha temporária e a revogação de chave gravam na hora, com
 * confirmação. Não há zona de perigo: contas nunca são apagadas
 * (`docs/05-accounts-and-roles.md`), quem sai é desativado. Só admin chega
 * aqui, e ninguém muda o próprio papel nem desativa a própria conta.
 */
export function UserEditorPage({ me }: { me: SessionUser }) {
  const { uuid = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const confirm = useConfirm();

  const [user, setUser] = useState<UserSummary | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);
  /** Senha temporária mostrada uma vez, para ser passada à pessoa. */
  const [secret, setSecret] = useState<string | null>(null);
  const self = user?.uuid === me.uuid;

  const tab: Tab = location.pathname.endsWith('/keys')
    ? 'keys'
    : location.pathname.endsWith('/accesses')
      ? 'accesses'
      : location.pathname.endsWith('/activity')
        ? 'activity'
        : 'account';

  const hydrate = useCallback((fresh: UserSummary) => {
    setUser(fresh);
    setName(fresh.name);
    setRole(fresh.role);
    setIsActive(fresh.isActive);
  }, []);

  // Fora de um data router, `navigate` muda a cada troca de caminho: se a carga
  // dependesse dele, cada troca de guia buscaria a conta de novo e repovoaria o
  // formulário — bastava ir a Chaves e voltar para perder nome, papel e estado.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Uma carga por conta. O cleanup descarta a resposta atrasada: trocando de
  // conta com a ficha montada, a da anterior podia chegar por último e pôr o
  // formulário dela sob o endereço desta.
  useEffect(() => {
    let active = true;
    setUser(null);
    getUser(uuid)
      .then((fresh) => active && hydrate(fresh))
      .catch((err) => {
        if (!active) return;
        toast.error((err as Error).message);
        navigateRef.current('/users');
      });
    return () => {
      active = false;
    };
  }, [uuid, hydrate, toast]);

  const dirty = user !== null && (name !== user.name || role !== user.role || isActive !== user.isActive);

  const save = useCallback(async () => {
    if (!user) return;
    setSaving(true);
    try {
      const saved = await updateUser(user.uuid, {
        name: name !== user.name ? name : undefined,
        role: role !== user.role ? role : undefined,
        isActive: isActive !== user.isActive ? isActive : undefined,
      });
      hydrate(saved);
      toast.success('Conta salva.');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [user, name, role, isActive, hydrate, toast]);

  useRegisterCommands(
    user ? [{ id: 'user-save', label: 'Salvar alterações', group: 'Recurso', icon: <Save />, shortcut: '⌘ S', disabled: dirty ? (false as const) : 'nada a salvar', run: save }] : [],
    [user?.uuid, dirty, save],
  );

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 's' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (dirty && !saving) void save();
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [dirty, saving, save]);

  async function resetPassword() {
    if (!user) return;
    const ok = await confirm({
      title: `Gerar uma senha temporária para ${user.email}?`,
      description: 'A senha atual deixa de valer, as sessões abertas caem e a pessoa é obrigada a trocá-la no primeiro acesso.',
      confirmLabel: 'Gerar senha',
    });
    if (!ok) return;
    try {
      const result = await resetUserPassword(user.uuid);
      setSecret(result.temporaryPassword);
      // O reset mexe só na senha (`resetAccountPassword`, em `admin/src/accounts.ts`):
      // entra o que ele mudou — "senha temporária", as datas — e o formulário fica
      // como está. Era `hydrate`, que repunha os três campos e só devolvia o nome:
      // papel e "conta ativa" em edição sumiam sem aviso. Nome, papel e estado
      // continuam sendo os que o formulário carregou, para o Salvar comparar com
      // eles e não regravar por cima o que outra pessoa tenha mudado no meio.
      setUser({ ...result.user, name: user.name, role: user.role, isActive: user.isActive });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const loadAccesses = useCallback(
    (query: Parameters<typeof getUserAccesses>[1]) => getUserAccesses(uuid, query),
    [uuid],
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
  const editBase = `${base}/edit`;

  return (
    <div className="page wide">
      <div className="page-head">
        <div className="min-w-0">
          <Link to={base} className="back-link">
            <ArrowLeft /> {user.name}
          </Link>
          <UserTitle user={user} me={me} name={name} />
        </div>
        <div className="page-actions">
          <Link to={base} className="btn btn-ghost">
            <Eye /> Visualizar
          </Link>
          <Button onClick={() => void save()} disabled={saving || !dirty}>
            <Save /> {saving ? 'Salvando…' : dirty ? 'Salvar' : 'Salvo'}
          </Button>
        </div>
      </div>

      <UserAlerts user={user} />

      <Tabs
        value={tab}
        items={[
          { key: 'account', label: 'Conta', icon: <UserRound />, to: editBase },
          { key: 'keys', label: 'Chaves', icon: <KeyRound />, to: `${editBase}/keys` },
          { key: 'accesses', label: 'Acessos', icon: <History />, to: `${editBase}/accesses` },
          { key: 'activity', label: 'Atividade', icon: <ListChecks />, to: `${editBase}/activity` },
        ]}
      />

      <Routes>
        <Route
          index
          element={
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
              <Panel title="Conta" icon={<UserRound />}>
                <div className="grid gap-4">
                  <Field label="Nome">
                    <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
                  </Field>
                  <Field label="E-mail" hint="O e-mail é a identidade da conta e não muda; para outro endereço, crie outra conta e desative esta.">
                    <input className="field field-mono" value={user.email} disabled />
                  </Field>
                  <Field label="Papel" hint={self ? 'Você não pode mudar o próprio papel.' : ROLE_HINT[role]}>
                    <select className="field" value={role} disabled={self} onChange={(event) => setRole(event.target.value as Role)}>
                      {ROLES.map((option) => (
                        <option key={option} value={option}>
                          {ROLE_LABEL[option]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <label className="check" title={self ? 'Você não pode desativar a própria conta' : 'Desativada, a conta não entra no painel nem pelo MCP administrativo; o que ela possui fica.'}>
                    <input type="checkbox" checked={isActive} disabled={self} onChange={(event) => setIsActive(event.target.checked)} />
                    Conta ativa: desativada, não entra no painel nem pelo MCP administrativo (o que ela possui fica)
                  </label>
                  <p className="panel-hint mb-0">
                    Estes campos são gravados pelo botão Salvar. Mudar o papel ou desativar derruba as sessões abertas da conta.
                    Contas nunca são apagadas — quem sai é desativado, para a auditoria continuar fazendo sentido.
                  </p>
                </div>
              </Panel>

              <Panel title="Senha" icon={<Lock />}>
                <p className="panel-hint">
                  {user.oidcIssuer && !user.hasPassword
                    ? 'Esta conta entra por SSO e não tem senha local. Gerar uma senha temporária cria o acesso por senha.'
                    : 'Quem esqueceu a senha recebe uma temporária, mostrada uma vez aqui, e é obrigado a trocá-la no primeiro acesso. As sessões abertas caem.'}
                </p>
                {secret && (
                  <div className="key-reveal mb-3" style={{ marginTop: 0 }}>
                    <p className="t">
                      Senha temporária de <strong>{user.email}</strong> — anote agora, ela não volta a aparecer.
                    </p>
                    <div className="row">
                      <code>{secret}</code>
                      <CopyButton text={secret} />
                    </div>
                    <button type="button" className="dismiss" onClick={() => setSecret(null)}>
                      Já anotei, pode esconder
                    </button>
                  </div>
                )}
                <Button variant="ghost" onClick={() => void resetPassword()}>
                  <Lock /> Gerar senha temporária
                </Button>
              </Panel>
            </div>
          }
        />
        <Route path="keys" element={<KeysEditor user={user} />} />
        <Route path="accesses" element={<AccessLog load={loadAccesses} showSkill />} />
        <Route path="activity" element={<ActorTrail actor={user.email} />} />
      </Routes>
    </div>
  );
}

/** As chaves `psk_` da conta, com revogar: só a própria pessoa emite, em Adm MCP Keys. */
function KeysEditor({ user }: { user: UserSummary }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { keys, reload } = useUserKeys(user.uuid);

  async function revoke(key: ApiKeySummary) {
    const ok = await confirm({
      title: `Revogar a chave "${key.name}" de ${user.email}?`,
      description: 'Quem a estiver usando perde o acesso na chamada seguinte. A linha fica como histórico.',
      confirmLabel: 'Revogar',
      danger: true,
    });
    if (!ok) return;
    try {
      await revokeUserKey(user.uuid, key.id);
      toast.success('Chave revogada.');
      await reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Panel title="Chaves do MCP administrativo" icon={<KeyRound />}>
      <p className="panel-hint">
        Só a própria pessoa emite chaves, em Adm MCP Keys. Aqui um administrador revoga uma chave perdida ou de quem saiu;
        revogar grava na hora e entra na auditoria com o seu nome.
      </p>
      <KeysTable keys={keys} onRevoke={revoke} />
    </Panel>
  );
}
