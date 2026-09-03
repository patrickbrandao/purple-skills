import { useState, type FormEvent } from 'react';
import { login } from '../api.js';
import { Button } from '../components/ui.js';
import { LockIcon } from '../components/Icons.js';

export function LoginPage({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await login(password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="atmos" aria-hidden />

      <form onSubmit={submit} className="login-card">
        <img className="wiz" src="/assets/images/icon-purple-right-137x158.png" alt="" />
        <h1 className="display">
          Purple<span style={{ color: 'var(--brand)' }}>Skills</span>
        </h1>
        <p className="sub">Painel administrativo</p>

        <div className="login-field">
          <LockIcon />
          <span className="sr-only">Senha de administrador</span>
          <input
            type="password"
            className="field"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Senha de administrador"
            autoFocus
            autoComplete="current-password"
            aria-label="Senha de administrador"
          />
        </div>

        {error && <p className="form-error">{error}</p>}

        <Button type="submit" disabled={submitting || !password} className="mt-5 w-full">
          {submitting ? 'Abrindo…' : 'Entrar'}
        </Button>
      </form>
    </div>
  );
}
