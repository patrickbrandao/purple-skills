import { useState, type FormEvent } from 'react';
import { changePassword, logout } from '../api.js';
import { Button } from '../components/ui.js';
import { LockIcon } from '../components/Icons.js';

/**
 * Tela obrigatória de quem entrou com senha temporária.
 *
 * Enquanto `mustChangePassword` estiver ligado, o servidor recusa todas as
 * outras rotas — esta tela é a única saída além do logout.
 */
export function ChangePasswordPage({ onDone }: { onDone: () => void }) {
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
      <div className="atmos" aria-hidden />

      <form onSubmit={submit} className="login-card">
        <img className="wiz" src="/assets/images/icon-purple-right-137x158.png" alt="" />
        <h1 className="display">Escolha uma senha</h1>
        <p className="sub">Você entrou com uma senha temporária.</p>

        <div className="login-field">
          <LockIcon />
          <span className="sr-only">Senha temporária</span>
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
          <LockIcon />
          <span className="sr-only">Nova senha</span>
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
