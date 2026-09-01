import { useState, type FormEvent } from 'react';
import { login } from '../api.js';
import { Button, inputClass } from '../components/ui.js';
import { LockIcon, SparkIcon } from '../components/Icons.js';

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
    <div className="flex min-h-screen items-center justify-center px-5">
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            'radial-gradient(50% 50% at 50% 40%, rgba(147,51,234,0.22) 0%, rgba(11,7,22,0) 70%)',
        }}
        aria-hidden
      />

      <form
        onSubmit={submit}
        className="relative w-full max-w-sm rounded-2xl border border-purple-400/15 bg-ink-850/90 p-7 shadow-2xl shadow-purple-950/40 backdrop-blur"
      >
        <div className="flex flex-col items-center text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-400 to-purple-700 text-white shadow-lg shadow-purple-950/50">
            <SparkIcon className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-xl font-semibold text-purple-50">Purple Skills</h1>
          <p className="mt-1 text-sm text-slate-500">Painel administrativo</p>
        </div>

        <label className="mt-7 block">
          <span className="sr-only">Senha de administrador</span>
          <div className="relative">
            <LockIcon className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-slate-600" />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Senha de administrador"
              autoFocus
              autoComplete="current-password"
              className={`${inputClass} pl-10`}
            />
          </div>
        </label>

        {error && (
          <p className="mt-3 rounded-lg border border-red-500/25 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        <Button type="submit" disabled={submitting || !password} className="mt-5 w-full">
          {submitting ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>
    </div>
  );
}
