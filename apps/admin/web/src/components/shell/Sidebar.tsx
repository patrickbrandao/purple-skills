import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import {
  BookOpen,
  BookOpenCheck,
  Bot,
  ChevronDown,
  ExternalLink,
  KeyRound,
  KeySquare,
  LayoutGrid,
  Library,
  ListChecks,
  MessageSquare,
  MoreVertical,
  PanelLeftClose,
  Plug,
  Server,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquareUser,
  UserRound,
  Users,
} from 'lucide-react';
import { ROLE_LABEL, canManageUsers, type Session, type SessionUser } from '../../api.js';
import { initials } from '../SkillIcon.js';
import { UserMenu, type OnLogout } from './UserMenu.js';
import { SETTINGS_SECTIONS } from '../../pages/SettingsPage.js';

const SETTINGS_ICON: Record<(typeof SETTINGS_SECTIONS)[number]['path'], ReactNode> = {
  'mcp-padrao': <Server />,
  'busca-semantica': <Sparkles />,
  ambiente: <SlidersHorizontal />,
  conectar: <Plug />,
};

/** Mesma quebra do CSS: abaixo dela a sidebar é gaveta, não coluna. */
export const NARROW = '(max-width: 900px)';

/**
 * A sidebar da referência: a marca, a navegação em dois blocos (o que se
 * administra, com o "Meu espaço" recortado na conta e as chaves em
 * "Configurações"; os links externos) e, no rodapé, a conta com o seu menu. O
 * botão ao lado da marca recolhe a sidebar para a esquerda; abaixo de 900px
 * ela vira uma gaveta, e o mesmo botão a fecha.
 */
export function Sidebar({
  session,
  user,
  onLogout,
  open,
  onClose,
  onCollapse,
}: {
  session: Session;
  user: SessionUser;
  onLogout: OnLogout;
  open: boolean;
  onClose: () => void;
  onCollapse: () => void;
}) {
  const location = useLocation();
  const admin = canManageUsers(user.role);
  const inConfig = location.pathname.startsWith('/configuracoes') || location.pathname.startsWith('/account');
  const [configOpen, setConfigOpen] = useState(inConfig);
  const inMine = location.pathname.startsWith('/meu-espaco');
  const [mineOpen, setMineOpen] = useState(inMine);

  useEffect(() => {
    if (inConfig) setConfigOpen(true);
  }, [inConfig]);

  useEffect(() => {
    if (inMine) setMineOpen(true);
  }, [inMine]);

  // Fecha a gaveta ao navegar (só importa no mobile).
  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const links = session.links;
  const hasExternal = Boolean(links.docs || links.support || links.chat);

  // O rodapé inteiro é o botão: avatar, nome, papel e o ⋮ abrem o mesmo menu.
  const accountTrigger = (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => (
    <button type="button" className="sidebar-account" title={user.email || 'sessão de bootstrap'} {...props}>
      <span className="avatar">{initials(user.name)}</span>
      <span className="min-w-0 flex-1">
        <span className="nm">{user.name}</span>
        <span className="role">{user.legacy ? 'bootstrap' : ROLE_LABEL[user.role]}</span>
      </span>
      <MoreVertical className="more" />
    </button>
  );

  return (
    <aside className={`sidebar${open ? ' open' : ''}`}>
      <div className="sidebar-inner">
        <div className="sidebar-head">
          <Link to="/mcps" className="sidebar-brand">
            <img src={session.brand.iconUrl} alt="" />
            <span className="nm">{session.brand.name}</span>
          </Link>
          <button
            type="button"
            className="icon-btn sidebar-collapse"
            title="Recolher o menu"
            aria-label="Recolher o menu"
            onClick={() => (window.matchMedia(NARROW).matches ? onClose() : onCollapse())}
          >
            <PanelLeftClose />
          </button>
        </div>

        <nav className="nav" aria-label="Principal">
          <NavLink to="/mcps" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <LayoutGrid /> Servidores MCP
          </NavLink>
          <NavLink to="/skills" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <BookOpenCheck /> Skills
          </NavLink>
          <NavLink to="/catalogos" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Library /> Catálogos
          </NavLink>
          <button
            type="button"
            className={`nav-item${inMine ? ' active' : ''}`}
            aria-expanded={mineOpen}
            onClick={() => setMineOpen((o) => !o)}
          >
            <SquareUser /> Meu espaço
            <ChevronDown className="chev" />
          </button>
          {mineOpen && (
            <div className="nav-sub">
              <NavLink to="/meu-espaco/skills" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                <BookOpenCheck /> Minhas Skills
              </NavLink>
              <NavLink to="/meu-espaco/catalogos" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                <Library /> Meus catálogos
              </NavLink>
            </div>
          )}

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
              {admin &&
                SETTINGS_SECTIONS.map((section) => (
                  <NavLink
                    key={section.path}
                    to={`/configuracoes/${section.path}`}
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                  >
                    {SETTINGS_ICON[section.path]} {section.label}
                  </NavLink>
                ))}
              {/* `end` em "Minha conta": sem ele o item acenderia junto com as telas de chave, que são `/account/…`. */}
              {!user.legacy && (
                <>
                  <NavLink to="/account" end className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                    <UserRound /> Minha conta
                  </NavLink>
                  <NavLink to="/account/chaves-adm" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                    <KeyRound /> Adm MCP Keys
                  </NavLink>
                </>
              )}
              <NavLink to="/account/chaves-emitidas" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                <KeySquare /> Chaves emitidas
              </NavLink>
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

        <UserMenu session={session} user={user} onLogout={onLogout} trigger={accountTrigger} up className="sidebar-foot" />
      </div>
    </aside>
  );
}
