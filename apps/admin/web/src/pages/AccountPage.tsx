import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound, Lock } from 'lucide-react';
import { ROLE_LABEL, changePassword, type SessionUser } from '../api.js';
import { Button, Field, Panel } from '../components/ui.js';
import { useToast } from '../components/Toast.js';

/**
 * Minha conta: a troca de senha. As chaves `psk_` saíram daqui para a tela
 * própria, Configurações → Adm MCP Keys (`/account/admin-keys`) — a caixa já não
 * cabia ao lado do formulário e a tabela pedia a largura da página.
 */
export function AccountPage({ user, onChanged }: { user: SessionUser; onChanged: () => void }) {
  const toast = useToast();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitPassword(event: FormEvent) {
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
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Minha conta</h1>
          <p className="sub">
            {user.email || 'sessão de bootstrap'} · {ROLE_LABEL[user.role]}
          </p>
        </div>
      </div>

      <div className="grid max-w-[760px] content-start gap-4">
        <Panel title="Trocar senha" icon={<Lock />}>
          <form onSubmit={submitPassword} className="grid gap-4">
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

        <Panel title="Chaves do MCP administrativo" icon={<KeyRound />}>
          <p className="panel-hint">
            As chaves <code>psk_</code> desta conta ganharam tela própria: emitir e revogar agora é em
            Adm MCP Keys, no mesmo submenu.
          </p>
          <Link to="/account/admin-keys" className="btn btn-ghost btn-sm">
            Abrir Adm MCP Keys
          </Link>
        </Panel>
      </div>
    </div>
  );
}
