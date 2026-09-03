import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { logout, type Session } from '../api.js';
import { useTheme } from '../useTheme.js';
import {
  DashboardIcon,
  ExternalIcon,
  LogoutIcon,
  MoonIcon,
  StackIcon,
  SunIcon,
} from './Icons.js';

const LINKS = [
  { to: '/', label: 'Visão geral', Icon: DashboardIcon, end: true },
  { to: '/skills', label: 'Skills', Icon: StackIcon, end: false },
];

export function Layout({
  children,
  session,
  onLogout,
}: {
  children: ReactNode;
  session: Session;
  onLogout: () => void;
}) {
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();

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
            {LINKS.map(({ to, label, Icon, end }) => (
              <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
                <Icon />
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>

          <div className="admin-nav-end">
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

      <main className="admin-main">{children}</main>
    </div>
  );
}
