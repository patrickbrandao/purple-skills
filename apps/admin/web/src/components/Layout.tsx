import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { logout, type Session } from '../api.js';
import { DashboardIcon, ExternalIcon, LogoutIcon, SparkIcon, StackIcon } from './Icons.js';

const links = [
  { to: '/', label: 'Visão geral', icon: DashboardIcon, end: true },
  { to: '/skills', label: 'Skills', icon: StackIcon, end: false },
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

  async function handleLogout() {
    await logout().catch(() => void 0);
    navigate('/');
    onLogout();
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-purple-400/10 bg-ink-900/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-fuchsia-400 to-purple-700 text-white shadow-md shadow-purple-950/50">
              <SparkIcon className="h-4 w-4" />
            </span>
            <div className="leading-tight">
              <p className="text-[15px] font-semibold text-purple-50">{session.siteName}</p>
              <p className="text-[10px] tracking-wider text-slate-500 uppercase">Administração</p>
            </div>
          </div>

          <nav className="flex items-center gap-1">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.end}
                className={({ isActive }) =>
                  `inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    isActive
                      ? 'bg-purple-600/20 text-purple-200'
                      : 'text-slate-400 hover:bg-ink-800 hover:text-purple-200'
                  }`
                }
              >
                <link.icon className="h-4 w-4" />
                {link.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1">
            <a
              href={session.siteBaseUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-slate-400 transition hover:bg-ink-800 hover:text-purple-200"
            >
              <ExternalIcon className="h-4 w-4" /> Ver site
            </a>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-slate-400 transition hover:bg-ink-800 hover:text-red-300"
            >
              <LogoutIcon className="h-4 w-4" /> Sair
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-5 py-8">{children}</main>
    </div>
  );
}
