import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, PanelLeftOpen, Search } from 'lucide-react';
import type { Session, SessionUser } from '../../api.js';
import { usePalette } from '../commands.js';
import { Badge, Kbd, useStored } from '../ui.js';
import { Notifications } from './Notifications.js';
import { NARROW, Sidebar } from './Sidebar.js';
import type { OnLogout } from './UserMenu.js';

type Crumb = { label: string; to?: string };

/** Trilha da barra superior, derivada da URL. */
function crumbsFor(pathname: string): Crumb[] {
  const parts = pathname.split('/').filter(Boolean);
  const [head, second, third] = parts;
  switch (head) {
    case 'mcps':
      return second
        ? [{ label: 'Servidores MCP', to: '/mcps' }, { label: second, to: `/mcps/${second}` }, ...(third ? [{ label: third }] : [])]
        : [{ label: 'Servidores MCP' }];
    case 'skills':
      if (second === 'new') return [{ label: 'Skills', to: '/skills' }, { label: 'nova skill' }];
      return second
        ? [{ label: 'Skills', to: '/skills' }, { label: second, to: `/skills/${second}` }, ...(third ? [{ label: third }] : [])]
        : [{ label: 'Skills' }];
    case 'catalogos':
      return second ? [{ label: 'Catálogos', to: '/catalogos' }, { label: second }] : [{ label: 'Catálogos' }];
    case 'auditoria':
      return [{ label: 'Auditoria', to: '/auditoria' }, ...(second ? [{ label: 'sessões MCP' }] : [{ label: 'trilha' }])];
    case 'users':
      return [{ label: 'Usuários' }];
    case 'configuracoes':
      return [{ label: 'Configurações' }, { label: 'instalação' }];
    case 'account':
      return [{ label: 'Configurações' }, { label: 'minha conta' }];
    default:
      return [];
  }
}

export function Layout({
  children,
  session,
  user,
  onLogout,
  stage,
}: {
  children: ReactNode;
  session: Session;
  user: SessionUser;
  onLogout: OnLogout;
  /** A página é um palco: o painel não rola nem tem padding. */
  stage?: boolean;
}) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // Recolher é preferência de quem usa, por navegador; na tela estreita não se aplica.
  const [collapsed, setCollapsed] = useStored('purple-skills-admin:sidebar-collapsed', false);
  const { open: openPalette } = usePalette();
  const crumbs = crumbsFor(location.pathname);

  return (
    <div className={`shell${collapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar
        session={session}
        user={user}
        onLogout={onLogout}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onCollapse={() => setCollapsed(true)}
      />
      {menuOpen && <div className="overlay" style={{ zIndex: 45 }} onClick={() => setMenuOpen(false)} />}

      <header className="topbar">
        <button
          type="button"
          className="icon-btn menu-btn"
          onClick={() => (window.matchMedia(NARROW).matches ? setMenuOpen(true) : setCollapsed(false))}
          title="Exibir o menu"
          aria-label="Exibir o menu"
        >
          <PanelLeftOpen />
        </button>
        <nav className="crumbs" aria-label="Trilha">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="contents">
              {index > 0 && <ChevronRight />}
              {crumb.to && index < crumbs.length - 1 ? (
                <Link to={crumb.to}>{crumb.label}</Link>
              ) : (
                <span className="cur">{crumb.label}</span>
              )}
            </span>
          ))}
          {user.legacy && (
            <Badge tone="warn" title="Sessão aberta com a senha de bootstrap (ADMIN_PASSWORD). Saia e crie o primeiro administrador">
              bootstrap
            </Badge>
          )}
        </nav>
        <button type="button" className="icon-btn" onClick={() => openPalette()} title="Paleta de comandos (⌘K)">
          <Search />
        </button>
        <span className="hidden items-center gap-1 pr-1 md:inline-flex" aria-hidden>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
        </span>
        <Notifications session={session} user={user} onLogout={onLogout} />
      </header>

      <main className="main">
        <div className={`main-panel${stage ? ' stage' : ''}`}>{children}</div>
      </main>
    </div>
  );
}
