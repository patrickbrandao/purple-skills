import { useEffect, useState, type FormEvent } from 'react';
import { AtSign, Lock, Mail, ShieldCheck, UserRound } from 'lucide-react';
import {
  confirmPasswordReset,
  login,
  requestPasswordReset,
  setup,
  type Session,
} from '../api.js';
import { normalizeUsername, usernameFromName } from '@purple-skills/shared/username';
import { Button } from '../components/ui.js';

/**
 * Tudo o que acontece **antes** de existir sessão: entrar, criar o primeiro
 * administrador, pedir e confirmar a redefinição de senha. Uma tela só,
 * porque as quatro dividem o mesmo cartão e o mesmo estado de erro.
 */
type Mode = 'login' | 'setup' | 'forgot' | 'reset';

export function LoginPage({
  session,
  onSuccess,
  notice: arrival,
}: {
  session: Session;
  onSuccess: () => void;
  /** Recado de quem acabou de chegar aqui — a saída que revogou a conta, por exemplo. */
  notice?: string | null;
}) {
  const params = new URLSearchParams(window.location.search);
  const resetToken = params.get('reset');
  const ssoError = params.get('sso_error');
  // `?setup=1` vem de quem sai da sessão de bootstrap para criar a conta; com
  // a conta já criada, o cadastro fechou e vale o login de sempre.
  const openSetup = params.get('setup') === '1' && session.needsSetup;

  const [mode, setMode] = useState<Mode>(resetToken ? 'reset' : openSetup ? 'setup' : 'login');
  /**
   * O campo único do login (`docs/19-username.md` decisão 3): username **ou**
   * e-mail, e quem decide é o `@` — do lado do servidor, em `getUserByLogin`. O
   * formulário não escolhe nem avisa qual dos dois foi lido: dizer "esse usuário
   * não existe" contra "esse e-mail não existe" devolveria de graça a informação
   * de que um endereço tem conta aqui.
   */
  const [identifier, setIdentifier] = useState('');
  /** Só no setup e no "esqueci minha senha": o link de redefinição vai por e-mail. */
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  /**
   * O username do primeiro admin. Nasce derivado do nome e vira "escolhido à
   * mão" no primeiro toque — daí o `touched`: sem ele, continuar digitando o
   * nome sobrescreveria o que a pessoa acabou de escrever aqui.
   */
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [error, setError] = useState<string | null>(ssoError);
  const [notice, setNotice] = useState<string | null>(arrival ?? null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (ssoError) window.history.replaceState(null, '', window.location.pathname);
  }, [ssoError]);

  /** Enquanto não existe conta nenhuma, a ADMIN_PASSWORD ainda entra sozinha. */
  const legacy = session.legacyLogin && mode === 'login';

  /**
   * O username que o setup vai mandar: o digitado, ou o derivado do nome
   * enquanto ninguém tocou no campo (`docs/19-username.md` decisão 12).
   *
   * Vazio é legítimo — o servidor deriva do nome e resolve a colisão
   * (`usernameParaConta`, em `admin/src/accounts.ts`). Nome que não dá username
   * nenhum (só pontuação, só ideogramas) cai justamente nesse caminho, em vez de
   * travar o formulário do primeiro administrador.
   */
  const sugestao = usernameTouched ? username : (usernameFromName(name) ?? '');
  /** Só avisa quando há o que avisar: campo vazio não é erro. */
  const usernameInvalido = sugestao !== '' && normalizeUsername(sugestao) === null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      if (mode === 'setup') {
        await setup({ adminPassword, username: sugestao, email, name, password });
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
        await login(legacy ? { password } : { identifier, password });
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
      ? adminPassword && email && name && password && !usernameInvalido
      : mode === 'forgot'
        ? Boolean(email)
        : mode === 'reset'
          ? Boolean(password)
          : legacy
            ? Boolean(password)
            : Boolean(identifier && password);

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
              autoFocus
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

        {/*
          O username do primeiro administrador, derivado do nome e editável.
          `type="text"` e não `email`: são coisas diferentes, e o teclado de
          e-mail do celular atrapalharia.
        */}
        {mode === 'setup' && (
          <div className="login-field">
            <AtSign />
            <input
              type="text"
              className="field"
              value={sugestao}
              onChange={(event) => {
                setUsernameTouched(true);
                setUsername(event.target.value);
              }}
              placeholder="Usuário (como as outras contas vão te ver)"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-label="Usuário"
            />
          </div>
        )}

        {/*
          O e-mail só aparece onde ele é usado de fato: criar a conta e pedir o
          link de redefinição. No login ele deixou de ser um campo próprio —
          quem quiser entrar por e-mail digita no campo único acima
          (`docs/19-username.md` decisão 3).
        */}
        {(mode === 'setup' || mode === 'forgot') && (
          <div className="login-field">
            <Mail />
            <input
              type="email"
              className="field"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="E-mail (privado: só você e os administradores veem)"
              autoFocus={mode === 'forgot'}
              autoComplete="email"
              aria-label="E-mail"
            />
          </div>
        )}

        {mode === 'login' && !legacy && (
          <div className="login-field">
            <UserRound />
            <input
              type="text"
              className="field"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="Usuário ou e-mail"
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-label="Usuário ou e-mail"
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

        {usernameInvalido && (
          <p className="form-error">
            O usuário aceita de 3 a 32 caracteres — letras sem acento, números, ponto, hífen e
            sublinhado —, começa e termina em letra ou número e não repete pontuação. Em branco,
            ele é derivado do seu nome.
          </p>
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
            acesso ao painel passa a ser sempre por conta e senha — o usuário ou o e-mail, no mesmo
            campo.
          </p>
        )}
      </form>
    </div>
  );
}
