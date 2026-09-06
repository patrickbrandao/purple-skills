import { useEffect, useState, type FormEvent } from 'react';
import {
  confirmPasswordReset,
  login,
  requestPasswordReset,
  setup,
  type Session,
} from '../api.js';
import { Button } from '../components/ui.js';
import { LockIcon, MailIcon, ShieldIcon, UserIcon } from '../components/Icons.js';

/**
 * Tudo o que acontece **antes** de existir sessão: entrar, criar o primeiro
 * administrador, pedir e confirmar a redefinição de senha.
 *
 * Vive numa tela só porque as quatro dividem o mesmo cartão e o mesmo estado
 * de erro — separá-las em rotas exigiria um roteador antes da autenticação.
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

  // A mensagem do SSO chega pela querystring; limpar a URL evita que um F5
  // reapresente um erro já lido.
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
        setNotice(
          'Se existir uma conta com esse e-mail, o link de redefinição já está a caminho.',
        );
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
    login: 'Painel administrativo',
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
      <div className="atmos" aria-hidden />

      <form onSubmit={submit} className="login-card">
        <img className="wiz" src="/assets/images/icon-purple-right-137x158.png" alt="" />
        <h1 className="display">
          Purple<span style={{ color: 'var(--brand)' }}>Skills</span>
        </h1>
        <p className="sub">{title[mode]}</p>

        {mode === 'setup' && (
          <div className="login-field">
            <ShieldIcon />
            <span className="sr-only">ADMIN_PASSWORD</span>
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
            <UserIcon />
            <span className="sr-only">Seu nome</span>
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
            <MailIcon />
            <span className="sr-only">E-mail</span>
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
            <LockIcon />
            <span className="sr-only">Senha</span>
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
          <a className="btn btn-ghost mt-3 w-full" href="/api/auth/oidc/start">
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
              Esqueceu a senha? Este catálogo não envia e-mail — peça a redefinição a um
              administrador.
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
            A <code>ADMIN_PASSWORD</code> só serve para criar esta primeira conta. A partir dela,
            o acesso ao painel passa a ser sempre por e-mail e senha.
          </p>
        )}
      </form>
    </div>
  );
}
