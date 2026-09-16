import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate } from 'react-router-dom';
import {
  ExternalLink,
  LayoutGrid,
  Library,
  ListChecks,
  LogOut,
  Moon,
  Plus,
  Server,
  SlidersHorizontal,
  Sun,
  Table2,
  Upload,
  UserRound,
  Users,
} from 'lucide-react';
import {
  canCreate,
  canManageUsers,
  getSession,
  logout,
  type Session,
  type SessionUser,
} from './api.js';
import { ToastProvider } from './components/Toast.js';
import { ConfirmProvider, Skel, isTypingTarget } from './components/ui.js';
import { CommandProvider, useRegisterCommands } from './components/commands.js';
import { CommandPalette } from './components/shell/CommandPalette.js';
import { Layout } from './components/shell/Layout.js';
import { useTheme } from './useTheme.js';
import { LoginPage } from './pages/LoginPage.js';
import { ChangePasswordPage } from './pages/ChangePasswordPage.js';
import { AccountPage } from './pages/AccountPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { UserPage } from './pages/UserPage.js';
import { UserEditorPage } from './pages/UserEditorPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { SkillViewPage } from './pages/SkillViewPage.js';
import { SkillEditorPage } from './pages/SkillEditorPage.js';
import { NewSkillPage } from './pages/NewSkillPage.js';
import { ServersPage } from './pages/ServersPage.js';
import { CatalogsPage } from './pages/CatalogsPage.js';
import { CatalogPage } from './pages/CatalogPage.js';
import { CatalogEditorPage } from './pages/CatalogEditorPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { AuditPage } from './pages/AuditPage.js';

// O palco carrega o React Flow: fica num chunk próprio, pago só por quem abre um servidor.
const ServerPage = lazy(() => import('./pages/ServerPage.js').then((m) => ({ default: m.ServerPage })));

/** Estado assumido quando `/api/session` não responde — só serve ao login. */
const OFFLINE: Session = {
  authenticated: false,
  user: null,
  needsSetup: false,
  legacyLogin: false,
  oidc: { enabled: false },
  passwordResetByEmail: false,
  siteName: 'Purple Skills',
  brand: { name: 'Purple Skills', iconUrl: '/assets/images/purple-hat-256.png' },
  siteBaseUrl: '/',
  mcpPublicUrl: '',
  links: { docs: null, support: null, chat: null },
  onlineWindowMs: 120_000,
  version: '',
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSession(await getSession());
    } catch {
      setSession(OFFLINE);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A aba do navegador acompanha a marca configurada no servidor.
  const brandName = session?.brand.name;
  const brandIcon = session?.brand.iconUrl;
  useEffect(() => {
    if (brandName) document.title = brandName;
    if (brandIcon) document.querySelector('link[rel="icon"]')?.setAttribute('href', brandIcon);
  }, [brandName, brandIcon]);

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="spinner" />
      </div>
    );
  }

  const current = session ?? OFFLINE;

  if (!current.authenticated || !current.user) {
    return (
      <ToastProvider>
        <LoginPage session={current} onSuccess={refresh} />
      </ToastProvider>
    );
  }

  // Senha temporária: nenhuma outra tela abre antes da troca — o servidor
  // recusa as demais rotas de qualquer forma.
  if (current.user.mustChangePassword) {
    return (
      <ToastProvider>
        <ChangePasswordPage iconUrl={current.brand.iconUrl} onDone={refresh} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <ConfirmProvider>
        <CommandProvider>
          <Shell session={current} user={current.user} onLogout={refresh} />
          <CommandPalette />
        </CommandProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Shell({ session, user, onLogout }: { session: Session; user: SessionUser; onLogout: () => void }) {
  const stage = Boolean(useMatch('/mcps/:slug/*'));
  const admin = canManageUsers(user.role);

  return (
    <Layout session={session} user={user} onLogout={onLogout} stage={stage}>
      <GlobalCommands session={session} user={user} onLogout={onLogout} />
      <Routes>
        <Route path="/" element={<Navigate to="/mcps" replace />} />
        <Route path="/mcps" element={<ServersPage session={session} user={user} />} />
        <Route
          path="/mcps/:slug/*"
          element={
            <Suspense fallback={<StageSkeleton />}>
              <ServerPage session={session} user={user} />
            </Suspense>
          }
        />
        <Route path="/skills" element={<SkillsPage user={user} />} />
        <Route
          path="/skills/new"
          element={canCreate(user.role) ? <NewSkillPage /> : <Navigate to="/skills" replace />}
        />
        {/* As fichas têm guias em rotas próprias (`/propriedades`, `/acessos`); a edição fica sob `/editar`. */}
        {/* Sem trava de papel: o editor já trava o que o acesso não permite. */}
        <Route path="/skills/:slug/editar/*" element={<SkillEditorPage session={session} user={user} />} />
        <Route path="/skills/:slug/*" element={<SkillViewPage session={session} user={user} />} />
        <Route path="/catalogos" element={<CatalogsPage user={user} />} />
        <Route path="/catalogos/:slug/editar/*" element={<CatalogEditorPage user={user} />} />
        <Route path="/catalogos/:slug/*" element={<CatalogPage session={session} user={user} />} />
        <Route
          path="/auditoria/*"
          element={admin ? <AuditPage session={session} /> : <Navigate to="/mcps" replace />}
        />
        <Route path="/account" element={<AccountPage user={user} onChanged={onLogout} />} />
        <Route
          path="/users"
          element={admin && !user.legacy ? <UsersPage me={user} /> : <Navigate to="/mcps" replace />}
        />
        <Route
          path="/users/:uuid/editar/*"
          element={admin && !user.legacy ? <UserEditorPage me={user} /> : <Navigate to="/mcps" replace />}
        />
        <Route
          path="/users/:uuid/*"
          element={admin && !user.legacy ? <UserPage me={user} /> : <Navigate to="/mcps" replace />}
        />
        <Route
          path="/configuracoes"
          element={admin ? <SettingsPage session={session} /> : <Navigate to="/mcps" replace />}
        />
        <Route path="*" element={<Navigate to="/mcps" replace />} />
      </Routes>
    </Layout>
  );
}

function StageSkeleton() {
  return (
    <div className="p-6">
      <Skel h={28} w={260} className="mb-4" />
      <Skel h="60vh" />
    </div>
  );
}

/** Os comandos que valem em qualquer tela: criar, navegar, conta. */
function GlobalCommands({ session, user, onLogout }: { session: Session; user: SessionUser; onLogout: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [theme, toggleTheme] = useTheme();
  const admin = canManageUsers(user.role);

  useRegisterCommands(
    [
      ...(canCreate(user.role)
        ? [
            {
              id: 'new-mcp',
              label: 'Novo servidor MCP',
              group: 'Criar' as const,
              icon: <Server />,
              keywords: ['vmcp', 'criar', 'servidor'],
              run: () => navigate('/mcps?novo=1'),
            },
          ]
        : []),
      ...(canCreate(user.role)
        ? [
            {
              id: 'new-catalog',
              label: 'Novo catálogo',
              group: 'Criar' as const,
              icon: <Library />,
              keywords: ['catalogo', 'grupo', 'criar'],
              run: () => navigate('/catalogos?novo=1'),
            },
          ]
        : []),
      ...(canCreate(user.role)
        ? [
            {
              id: 'new-skill',
              label: 'Nova skill',
              group: 'Criar' as const,
              icon: <Plus />,
              keywords: ['criar', 'skill'],
              run: () => navigate('/skills/new'),
            },
            {
              id: 'import-skill',
              label: 'Importar skill (.zip)',
              group: 'Criar' as const,
              icon: <Upload />,
              keywords: ['zip', 'importar', 'upload'],
              run: () => navigate('/skills/new?modo=zip'),
            },
          ]
        : []),
      { id: 'go-mcps', label: 'Servidores MCP', group: 'Ir para', icon: <LayoutGrid />, shortcut: 'g s', run: () => navigate('/mcps') },
      { id: 'go-skills', label: 'Skills', group: 'Ir para', icon: <Table2 />, shortcut: 'g k', run: () => navigate('/skills') },
      { id: 'go-catalogs', label: 'Catálogos', group: 'Ir para', icon: <Library />, shortcut: 'g c', keywords: ['catalogo'], run: () => navigate('/catalogos') },
      ...(admin
        ? [
            { id: 'go-audit', label: 'Auditoria', group: 'Ir para' as const, icon: <ListChecks />, shortcut: 'g a', run: () => navigate('/auditoria') },
            { id: 'go-settings', label: 'Configurações da instalação', group: 'Ir para' as const, icon: <SlidersHorizontal />, keywords: ['mcp padrão', 'instalação'], run: () => navigate('/configuracoes') },
          ]
        : []),
      ...(admin && !user.legacy
        ? [{ id: 'go-users', label: 'Usuários', group: 'Ir para' as const, icon: <Users />, shortcut: 'g u', run: () => navigate('/users') }]
        : []),
      ...(!user.legacy
        ? [{ id: 'go-account', label: 'Minha conta', group: 'Conta' as const, icon: <UserRound />, keywords: ['senha', 'chave', 'api'], run: () => navigate('/account') }]
        : []),
      { id: 'site', label: 'Ver o site do catálogo', group: 'Conta', icon: <ExternalLink />, run: () => {
          window.open(session.siteBaseUrl, '_blank', 'noreferrer');
        },
      },
      { id: 'theme', label: theme === 'dark' ? 'Tema claro' : 'Tema escuro', group: 'Conta', icon: theme === 'dark' ? <Sun /> : <Moon />, keywords: ['tema', 'dark', 'light'], run: toggleTheme },
      {
        id: 'logout',
        label: 'Sair',
        group: 'Conta',
        icon: <LogOut />,
        run: async () => {
          await logout().catch(() => void 0);
          navigate('/');
          onLogout();
        },
      },
    ],
    [user.role, user.legacy, theme, session.siteBaseUrl],
  );

  // Atalhos "g + tecla", fora de campos de texto.
  useEffect(() => {
    let armed = 0;
    const down = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const now = Date.now();
      if (event.key === 'g') {
        armed = now;
        return;
      }
      if (now - armed > 800) return;
      armed = 0;
      const routes: Record<string, string | undefined> = {
        s: '/mcps',
        k: '/skills',
        c: '/catalogos',
        a: admin ? '/auditoria' : undefined,
        u: admin && !user.legacy ? '/users' : undefined,
      };
      const to = routes[event.key];
      if (to && to !== location.pathname) navigate(to);
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [navigate, admin, user.legacy, location.pathname]);

  return null;
}
