import type { ReactNode } from 'react';
import { ExternalLink, LogOut, UserPlus, UserRound } from 'lucide-react';
import type { Session, SessionUser } from '../../api.js';
import { Menu, MenuHeading, MenuItem, MenuSeparator } from '../ui.js';

/**
 * Pede a saída da sessão. Com `'setup'`, o login abre já no cadastro do
 * primeiro administrador — o único destino útil para a sessão de bootstrap.
 */
export type OnLogout = (then?: 'setup') => void;

/** O menu da conta, aberto pelo botão do rodapé da sidebar. */
export function UserMenu({
  session,
  user,
  onLogout,
  trigger,
  align = 'left',
  up,
  className,
}: {
  session: Session;
  user: SessionUser;
  onLogout: OnLogout;
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu' }) => ReactNode;
  align?: 'left' | 'right';
  up?: boolean;
  className?: string;
}) {
  return (
    <Menu trigger={trigger} align={align} up={up} className={className}>
      <MenuHeading>{user.legacy ? 'sessão de bootstrap' : user.email}</MenuHeading>
      {/* A sessão de bootstrap não tem conta: no lugar de "Minha conta", o caminho para criá-la. */}
      {user.legacy ? (
        <MenuItem onSelect={() => onLogout('setup')} icon={<UserPlus />}>
          Criar o primeiro admin
        </MenuItem>
      ) : (
        <MenuItem to="/account" icon={<UserRound />}>
          Minha conta
        </MenuItem>
      )}
      <MenuItem href={session.siteBaseUrl} icon={<ExternalLink />}>
        Ver o site
      </MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => onLogout()} icon={<LogOut />}>
        Sair
      </MenuItem>
    </Menu>
  );
}
