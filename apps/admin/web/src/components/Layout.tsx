import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { ROLE_LABEL, canManageUsers, logout, type Session, type SessionUser } from '../api.js';
import { useTheme } from '../useTheme.js';
import {
  DashboardIcon,
  ExternalIcon,
  LogoutIcon,
  MoonIcon,
  StackIcon,
  SunIcon,
  UserIcon,
  UsersIcon,
} from './Icons.js';

export function Layout({
  children,
  session,
  user,
  onLogout,
}: {
  children: ReactNode;
  session: Session;
  user: SessionUser;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();

  // A tela de contas só existe para admin. Fica de fora na sessão de
  // bootstrap: criar uma conta por ali invalidaria a própria sessão na
  // requisição seguinte — o caminho certo é sair e passar pelo setup.
  const links = [
    { to: '/', label: 'Visão geral', Icon: DashboardIcon, end: true },
    { to: '/skills', label: 'Skills', Icon: StackIcon, end: false },
    ...(canManageUsers(user.role) && !user.legacy
      ? [{ to: '/users', label: 'Contas', Icon: UsersIcon, end: false }]
      : []),
  ];

  async function handleLogout() {
    await logout().catch(() => void 0);
    navigate('/');
    onLogout();
  }

  return (
    <div className="admin-shell">
      <div className="atmos" aria-hidden />

      <header className="admin-nav">
        <div className="admin-nav-inner">
          <Link to="/" className="admin-brand">
            <img src="/assets/images/purple-hat-256.png" alt="" width={30} height={30} />
            <span>
              <span className="nm">{session.siteName}</span>
              <span className="sub">administração</span>
            </span>
          </Link>

          <nav className="admin-tabs">
            {links.map(({ to, label, Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
                <Icon />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="admin-nav-end">
            {user.legacy ? (
              <span className="who" title="Sessão de bootstrap (ADMIN_PASSWORD)">
                <UserIcon />
                <span className="lbl">
                  <span className="nm">{user.name}</span>
                  <span className="role role-admin">bootstrap</span>
                </span>
              </span>
            ) : (
              <NavLink
                to="/account"
                className={({ isActive }) => `who${isActive ? ' active' : ''}`}
                title={user.email}
              >
                <UserIcon />
                <span className="lbl">
                  <span className="nm">{user.name}</span>
                  <span className={`role role-${user.role}`}>{ROLE_LABEL[user.role]}</span>
                </span>
              </NavLink>
            )}
            <a
              href={session.siteBaseUrl}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost btn-sm"
            >
              <ExternalIcon /> <span className="lbl">Ver site</span>
            </a>
            <button
              type="button"
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
              <LogoutIcon /> <span className="lbl">Sair</span>
            </button>
          </div>
        </div>
      </header>

      {user.legacy && (
        <div className="legacy-banner">
          <span>
            Você entrou com a <code>ADMIN_PASSWORD</code>, e a auditoria não sabe{' '}
            <strong>quem</strong> é você. Crie o primeiro administrador para ganhar contas
            nomeadas, papéis e revogação individual.
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={handleLogout}>
            Criar o primeiro administrador
          </button>
        </div>
      )}

      <main className="admin-main">{children}</main>
    </div>
  );
}
