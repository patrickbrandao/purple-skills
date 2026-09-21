import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronRight, Moon, PanelLeftOpen, Search, Sun } from 'lucide-react';
import type { Session, SessionUser } from '../../api.js';
import { usePalette } from '../commands.js';
import { Badge, Kbd, useStored } from '../ui.js';
import { useTheme } from '../../themeStore.js';
import { SETTINGS_SECTIONS } from '../../pages/SettingsPage.js';
import { Notifications } from './Notifications.js';
import { isNewSkillPath } from './routes.js';
import { NARROW, Sidebar } from './Sidebar.js';
import type { OnLogout } from './UserMenu.js';

type Crumb = { label: string; to?: string };

/** Trilha da barra superior, derivada da URL. */
function crumbsFor(pathname: string): Crumb[] {
  // A criação de skill tem endereço próprio, fora de `/skills/` (`routes.ts`).
  if (isNewSkillPath(pathname)) return [{ label: 'Skills', to: '/skills' }, { label: 'nova skill' }];
  const parts = pathname.split('/').filter(Boolean);
  const [head, second, third] = parts;
  switch (head) {
    case 'mcps':
      return second
        ? [{ label: 'Servidores MCP', to: '/mcps' }, { label: second, to: `/mcps/${second}` }, ...(third ? [{ label: third }] : [])]
        : [{ label: 'Servidores MCP' }];
    case 'skills':
      // Tudo sob `/skills/` é de uma skill — inclusive a de slug `new`.
      return second
        ? [{ label: 'Skills', to: '/skills' }, { label: second, to: `/skills/${second}` }, ...(third ? [{ label: third }] : [])]
        : [{ label: 'Skills' }];
    case 'catalogs':
      return second ? [{ label: 'Catálogos', to: '/catalogs' }, { label: second }] : [{ label: 'Catálogos' }];
    // O segundo nível é o uuid do envio: não há slug legível para pôr na trilha.
    case 'quarantine':
      return second ? [{ label: 'Quarentena', to: '/quarantine' }, { label: 'envio' }] : [{ label: 'Quarentena' }];
    // Só a raiz: a guia `activity` da ficha de usuário é `/users/:uuid/activity`,
    // e cai no `case 'users'` — o switch olha o **primeiro** segmento.
    case 'activity':
      return [{ label: 'Atividade' }];
    case 'audit':
      return [{ label: 'Auditoria', to: '/audit' }, ...(second ? [{ label: 'sessões MCP' }] : [{ label: 'trilha' }])];
    case 'users':
      return [{ label: 'Usuários' }];
    case 'settings': {
      const section = SETTINGS_SECTIONS.find((item) => item.path === second);
      return [{ label: 'Configurações' }, ...(section ? [{ label: section.label.toLowerCase() }] : [])];
    }
    case 'my-space': {
      const label = { skills: 'minhas skills', catalogs: 'meus catálogos' }[second ?? ''];
      return [{ label: 'Meu espaço' }, ...(label ? [{ label }] : [])];
    }
    // As telas de chave são `/account/…`: o submenu delas é o mesmo "Configurações".
    case 'account': {
      const label = { 'admin-keys': 'adm mcp keys', 'issued-keys': 'chaves emitidas' }[second ?? ''] ?? 'minha conta';
      return [{ label: 'Configurações' }, { label }];
    }
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
  const [theme, toggleTheme] = useTheme();
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
        <button
          type="button"
          className="icon-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          aria-label={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
        <Notifications session={session} user={user} onLogout={onLogout} />
      </header>

      <main className="main">
        <div className={`main-panel${stage ? ' stage' : ''}`}>{children}</div>
      </main>
    </div>
  );
}
