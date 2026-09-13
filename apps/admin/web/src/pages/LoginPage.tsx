import { useEffect, useState, type FormEvent } from 'react';
import { Lock, Mail, ShieldCheck, UserRound } from 'lucide-react';
import {
  confirmPasswordReset,
  login,
  requestPasswordReset,
  setup,
  type Session,
} from '../api.js';
import { Button } from '../components/ui.js';

/**
 * Tudo o que acontece **antes** de existir sessão: entrar, criar o primeiro
 * administrador, pedir e confirmar a redefinição de senha. Uma tela só,
 * porque as quatro dividem o mesmo cartão e o mesmo estado de erro.
 */
type Mode = 'login' | 'setup' | 'forgot' | 'reset';

export function LoginPage({ session, onSuccess }: { session: Session; onSuccess: () => void }) {
  const resetToken = new URLSearchParams(window.location.search).get('reset');
  const ssoError = new URLSearchParams(window.location.search).get('sso_error');

  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : 'login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [error, setError] = useState<string | null>(ssoError);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (ssoError) window.history.replaceState(null, '', window.location.pathname);
  }, [ssoError]);

  /** Enquanto não existe conta nenhuma, a ADMIN_PASSWORD ainda entra sozinha. */
  const legacy = session.legacyLogin && mode === 'login';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      if (mode === 'setup') {
        await setup({ adminPassword, email, name, password });
        onSuccess();
      } else if (mode === 'forgot') {
        await requestPasswordReset(email);
        setNotice('Se existir uma conta com esse e-mail, o link de redefinição já está a caminho.');
        setMode('login');
      } else if (mode === 'reset') {
        await confirmPasswordReset(resetToken ?? '', password);
        window.history.replaceState(null, '', window.location.pathname);
        setNotice('Senha redefinida. Entre com a senha nova.');
        setPassword('');
        setMode('login');
      } else {
        await login(legacy ? { password } : { email, password });
        onSuccess();
      }
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  const title: Record<Mode, string> = {
    login: 'Entrar no painel',
    setup: 'Primeiro administrador',
    forgot: 'Recuperar acesso',
    reset: 'Nova senha',
  };

  const cta: Record<Mode, string> = {
    login: submitting ? 'Abrindo…' : 'Entrar',
    setup: submitting ? 'Criando…' : 'Criar conta e entrar',
    forgot: submitting ? 'Enviando…' : 'Enviar link',
    reset: submitting ? 'Salvando…' : 'Redefinir senha',
  };

  const ready =
    mode === 'setup'
      ? adminPassword && email && name && password
      : mode === 'forgot'
        ? Boolean(email)
        : mode === 'reset'
          ? Boolean(password)
          : legacy
            ? Boolean(password)
            : Boolean(email && password);

  return (
    <div className="login-shell">
      <form onSubmit={submit} className="login-card">
        <div className="brand">
          <img src={session.brand.iconUrl} alt="" />
          <span>
            <span className="nm">{session.brand.name}</span>
            <br />
            <span className="sb">administração</span>
          </span>
        </div>
        <h1>{title[mode]}</h1>
        <p className="sub">
          {mode === 'login' && (legacy ? 'Senha única de bootstrap.' : 'Use sua conta do catálogo.')}
          {mode === 'setup' && 'A ADMIN_PASSWORD autoriza criar esta conta.'}
          {mode === 'forgot' && 'Enviamos um link de redefinição para o seu e-mail.'}
          {mode === 'reset' && 'Escolha a senha nova.'}
        </p>

        {mode === 'setup' && (
          <div className="login-field">
            <ShieldCheck />
            <input
              type="password"
              className="field"
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
              placeholder="ADMIN_PASSWORD (do .env)"
              autoComplete="off"
              aria-label="ADMIN_PASSWORD do ambiente"
            />
          </div>
        )}

        {mode === 'setup' && (
          <div className="login-field">
            <UserRound />
            <input
              type="text"
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Seu nome"
              autoComplete="name"
              aria-label="Seu nome"
            />
          </div>
        )}

        {mode !== 'reset' && !legacy && (
          <div className="login-field">
            <Mail />
            <input
              type="email"
              className="field"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="E-mail"
              autoFocus
              autoComplete="username"
              aria-label="E-mail"
            />
          </div>
        )}

        {mode !== 'forgot' && (
          <div className="login-field">
            <Lock />
            <input
              type="password"
              className="field"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={
                mode === 'login'
                  ? legacy
                    ? 'Senha de administrador'
                    : 'Senha'
                  : 'Nova senha (mínimo de 10 caracteres)'
              }
              autoFocus={legacy || mode === 'reset'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              aria-label="Senha"
            />
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
        {notice && <p className="form-notice">{notice}</p>}

        <Button type="submit" disabled={submitting || !ready} className="mt-5 w-full">
          {cta[mode]}
        </Button>

        {mode === 'login' && session.oidc.enabled && (
          <a className="btn btn-ghost mt-2 w-full" href="/api/auth/oidc/start">
            Entrar com {session.oidc.name}
          </a>
        )}

        <div className="login-links">
          {mode === 'login' && session.needsSetup && (
            <button type="button" onClick={() => setMode('setup')}>
              Criar o primeiro administrador
            </button>
          )}
          {mode === 'login' && !legacy && session.passwordResetByEmail && (
            <button type="button" onClick={() => setMode('forgot')}>
              Esqueci minha senha
            </button>
          )}
          {mode === 'login' && !legacy && !session.passwordResetByEmail && (
            <span className="hint">
              Esqueceu a senha? Este catálogo não envia e-mail — peça a redefinição a um administrador.
            </span>
          )}
          {mode !== 'login' && (
            <button type="button" onClick={() => setMode('login')}>
              Voltar para o login
            </button>
          )}
        </div>

        {mode === 'setup' && (
          <p className="login-note">
            A <code>ADMIN_PASSWORD</code> só serve para criar esta primeira conta. A partir dela, o
            acesso ao painel passa a ser sempre por e-mail e senha.
          </p>
        )}
      </form>
    </div>
  );
}
