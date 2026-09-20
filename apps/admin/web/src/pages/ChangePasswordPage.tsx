import { useState, type FormEvent } from 'react';
import { Lock } from 'lucide-react';
import { changePassword, logout } from '../api.js';
import { Button } from '../components/ui.js';

/**
 * Tela obrigatória de quem está com senha temporária. Enquanto
 * `mustChangePassword` estiver ligado, o servidor recusa todas as outras rotas.
 *
 * O texto fala da **conta**, não de como a pessoa entrou: quem tem o SSO já
 * vinculado e pediu uma senha ao administrador chega aqui pelo SSO, sem ter
 * digitado a temporária. O primeiro acesso por SSO de uma conta pré-criada não
 * chega aqui — o vínculo descarta a temporária (`resolveOidcUser`, relatório 002
 * da auditoria de 2026-09-19).
 */
export function ChangePasswordPage({ iconUrl, onDone }: { iconUrl: string; onDone: () => void }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await changePassword({ currentPassword, newPassword });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <form onSubmit={submit} className="login-card">
        <div className="brand">
          <img src={iconUrl} alt="" />
          <span>
            <span className="nm">Escolha uma senha</span>
            <br />
            <span className="sb">esta conta está com uma senha temporária</span>
          </span>
        </div>

        <div className="login-field">
          <Lock />
          <input
            type="password"
            className="field"
            value={currentPassword}
            onChange={(event) => setCurrent(event.target.value)}
            placeholder="Senha temporária"
            autoComplete="current-password"
            autoFocus
            aria-label="Senha temporária"
          />
        </div>

        <div className="login-field">
          <Lock />
          <input
            type="password"
            className="field"
            value={newPassword}
            onChange={(event) => setNew(event.target.value)}
            placeholder="Nova senha (mínimo de 10 caracteres)"
            autoComplete="new-password"
            aria-label="Nova senha"
          />
        </div>

        {error && <p className="form-error">{error}</p>}

        <Button type="submit" disabled={busy || !currentPassword || !newPassword} className="mt-5 w-full">
          {busy ? 'Salvando…' : 'Salvar e continuar'}
        </Button>

        <div className="login-links">
          <button
            type="button"
            onClick={() => {
              void logout().finally(onDone);
            }}
          >
            Sair
          </button>
        </div>
      </form>
    </div>
  );
}
