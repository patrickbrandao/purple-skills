import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, LogOut, Moon, Sun, UserRound } from 'lucide-react';
import { logout, type Session, type SessionUser } from '../../api.js';
import { Menu, MenuHeading, MenuItem, MenuSeparator } from '../ui.js';
import { useTheme } from '../../useTheme.js';

/** O mesmo menu atrás do bloco do usuário no topo da sidebar e do ⋮ do rodapé. */
export function UserMenu({
  session,
  user,
  onLogout,
  trigger,
  align = 'left',
  up,
}: {
  session: Session;
  user: SessionUser;
  onLogout: () => void;
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  align?: 'left' | 'right';
  up?: boolean;
}) {
  const navigate = useNavigate();
  const [theme, toggleTheme] = useTheme();

  async function handleLogout() {
    await logout().catch(() => void 0);
    navigate('/');
    onLogout();
  }

  return (
    <Menu trigger={trigger} align={align} up={up}>
      <MenuHeading>{user.legacy ? 'sessão de bootstrap' : user.email}</MenuHeading>
      {!user.legacy && (
        <MenuItem to="/account" icon={<UserRound />}>
          Minha conta
        </MenuItem>
      )}
      <MenuItem onSelect={toggleTheme} icon={theme === 'dark' ? <Sun /> : <Moon />}>
        {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
      </MenuItem>
      <MenuItem href={session.siteBaseUrl} icon={<ExternalLink />}>
        Ver o site
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => void handleLogout()} icon={<LogOut />}>
        Sair
      </MenuItem>
    </Menu>
  );
}
