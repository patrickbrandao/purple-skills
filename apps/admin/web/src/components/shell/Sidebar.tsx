import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  BookOpen,
  Bot,
  ChevronDown,
  ExternalLink,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  MoreVertical,
  Settings,
  SlidersHorizontal,
  Table2,
  UserRound,
  Users,
} from 'lucide-react';
import { ROLE_LABEL, canManageUsers, type Session, type SessionUser } from '../../api.js';
import { initials } from '../SkillIcon.js';
import { UserMenu } from './UserMenu.js';

/**
 * A sidebar da referência: marca, quem está logado, a navegação em dois
 * blocos (o que se administra; os links externos) e o rodapé com o menu da
 * conta. Abaixo de 900px vira uma gaveta aberta pelo botão da barra superior.
 */
export function Sidebar({
  session,
  user,
  onLogout,
  open,
  onClose,
}: {
  session: Session;
  user: SessionUser;
  onLogout: () => void;
  open: boolean;
  onClose: () => void;
}) {
  const location = useLocation();
  const admin = canManageUsers(user.role);
  const inConfig = location.pathname.startsWith('/configuracoes') || location.pathname.startsWith('/account');
  const [configOpen, setConfigOpen] = useState(inConfig);

  useEffect(() => {
    if (inConfig) setConfigOpen(true);
  }, [inConfig]);

  // Fecha a gaveta ao navegar (só importa no mobile).
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const links = session.links;
  const hasExternal = Boolean(links.docs || links.support || links.chat);

  const userTrigger = (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => (
    <button type="button" className="sidebar-user" {...props}>
      <span className="avatar">{initials(user.name)}</span>
      <span className="min-w-0 flex-1">
        <span className="nm">{user.name}</span>
        <span className="role">{user.legacy ? 'bootstrap' : ROLE_LABEL[user.role]}</span>
      </span>
      <ChevronDown className="chev" />
    </button>
  );

  const footTrigger = (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => (
    <button type="button" className="icon-btn" title="Menu da conta" {...props}>
      <MoreVertical />
    </button>
  );

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <Link to="/mcps" className="sidebar-brand">
        <img src="/assets/images/purple-hat-256.png" alt="" />
        <span>
          {session.siteName} <span className="sub">- Admin</span>
        </span>
      </Link>

      <UserMenu session={session} user={user} onLogout={onLogout} trigger={userTrigger} />

      <nav className="nav" aria-label="Principal">
        <NavLink to="/mcps" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <LayoutGrid /> Servidores MCP
        </NavLink>
        <NavLink to="/skills" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
          <Table2 /> Skills
        </NavLink>

        <div className="nav-sep" />

        {admin && (
          <NavLink to="/auditoria" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <ListChecks /> Auditoria
          </NavLink>
        )}
        {admin && !user.legacy && (
          <NavLink to="/users" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Users /> Usuários
          </NavLink>
        )}
        <button
          type="button"
          className={`nav-item${inConfig ? ' active' : ''}`}
          aria-expanded={configOpen}
          onClick={() => setConfigOpen((o) => !o)}
        >
          <Settings /> Configurações
          <ChevronDown className="chev" />
        </button>
        {configOpen && (
          <div className="nav-sub">
            {admin && (
              <NavLink to="/configuracoes" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                <SlidersHorizontal /> Instalação
              </NavLink>
            )}
            {!user.legacy && (
              <NavLink to="/account" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                <UserRound /> Minha conta
              </NavLink>
            )}
          </div>
        )}

        {hasExternal && <div className="nav-sep" />}
        {links.docs && (
          <a className="nav-item ext" href={links.docs} target="_blank" rel="noreferrer">
            <BookOpen /> Documentação <ExternalLink className="out" />
          </a>
        )}
        {links.support && (
          <a className="nav-item ext" href={links.support} target="_blank" rel="noreferrer">
            <Bot /> Agente de suporte <ExternalLink className="out" />
          </a>
        )}
        {links.chat && (
          <a className="nav-item ext" href={links.chat} target="_blank" rel="noreferrer">
            <MessageSquare /> Chat with skills <ExternalLink className="out" />
          </a>
        )}
      </nav>

      <div className="sidebar-foot">
        <span className="avatar">{initials(user.name)}</span>
        <span className="nm" title={user.email || 'sessão de bootstrap'}>
          {user.name}
        </span>
        <UserMenu session={session} user={user} onLogout={onLogout} trigger={footTrigger} align="right" up />
      </div>
    </aside>
  );
}
