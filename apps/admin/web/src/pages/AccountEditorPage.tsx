import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Globe, Lock, UserRound } from 'lucide-react';
import { ROLE_LABEL, changePassword, type SessionUser } from '../api.js';
import { ProfileForm } from '../components/ProfileForm.js';
import { Button, Field, Panel, Tabs } from '../components/ui.js';
import { useToast } from '../components/Toast.js';

type Tab = 'profile' | 'public' | 'password';

/**
 * A edição da própria conta (`docs/20-perfil.md`), em três guias: **Perfil**
 * (foto, nome de exibição e o username que só admin troca), **Dados públicos**
 * (descrição, site, links e o publicar) e **Trocar senha**. A leitura fica em
 * `/account`, e o botão Editar de lá é o caminho até aqui — a mesma divisão
 * que as contas de admin já têm (`docs/13-fichas-e-acessos.md` §3.4).
 *
 * As guias são estado de tela, e não rotas: o formulário do perfil é **um** só
 * nas duas primeiras (`ProfileForm`), e trocar de guia por rota o
 * desmontaria — quem escrevesse a bio e fosse conferir o nome perderia o que
 * digitou. Pelo mesmo motivo ele fica montado enquanto a senha está à vista,
 * escondido pelo `display`, em vez de sair da árvore.
 */
export function AccountEditorPage({ user, onChanged }: { user: SessionUser; onChanged: () => void }) {
  const location = useLocation();
  const [tab, setTab] = useState<Tab>(location.hash === '#password' ? 'password' : 'profile');

  return (
    <div className="page">
      <div className="page-head">
        <div className="min-w-0">
          <Link to="/account" className="back-link">
            <ArrowLeft /> Minha conta
          </Link>
          <h1>Editar perfil</h1>
          <p className="sub">
            @{user.username} · {ROLE_LABEL[user.role]}
          </p>
        </div>
      </div>

      <Tabs
        value={tab}
        onChange={(key) => setTab(key as Tab)}
        items={[
          { key: 'profile', label: 'Perfil', icon: <UserRound /> },
          { key: 'public', label: 'Dados públicos', icon: <Globe /> },
          { key: 'password', label: 'Trocar senha', icon: <Lock /> },
        ]}
      />

      <div className="grid max-w-[760px] content-start gap-4">
        <div
          className="grid content-start gap-4"
          style={{ display: tab === 'password' ? 'none' : undefined }}
        >
          <ProfileForm section={tab === 'public' ? 'publico' : 'perfil'} onSaved={onChanged} />
        </div>
        {tab === 'password' && <PasswordPanel onChanged={onChanged} />}
      </div>
    </div>
  );
}

/** A troca de senha da própria conta: o servidor encerra as outras sessões ao gravar. */
function PasswordPanel({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setCurrent('');
      setNew('');
      toast.success('Senha alterada. As suas outras sessões foram encerradas.');
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Trocar senha" icon={<Lock />}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label="Senha atual">
          <input
            type="password"
            className="field"
            value={currentPassword}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <Field label="Nova senha" hint="Mínimo de 10 caracteres.">
          <input
            type="password"
            className="field"
            value={newPassword}
            onChange={(event) => setNew(event.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <div>
          <Button type="submit" disabled={busy || !newPassword}>
            Salvar senha
          </Button>
        </div>
      </form>
    </Panel>
  );
}
