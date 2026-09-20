import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom';
import {
  BookOpenCheck,
  ExternalLink,
  KeyRound,
  KeySquare,
  LayoutGrid,
  Library,
  ListChecks,
  LogOut,
  Moon,
  Plug,
  Plus,
  Server,
  ShieldQuestion,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Upload,
  UserPlus,
  UserRound,
  Users,
} from 'lucide-react';
import {
  ApiError,
  SESSION_OPERATION_DEFAULTS,
  canCreate,
  canManageUsers,
  getSession,
  getSkill,
  logout,
  type Session,
  type SessionUser,
} from './api.js';
import { ToastProvider } from './components/Toast.js';
import { ConfirmProvider, Skel, armChord, isChordKey, isTypingTarget, useConfirm } from './components/ui.js';
import { CommandProvider, useRegisterCommands } from './components/commands.js';
import { CommandPalette } from './components/shell/CommandPalette.js';
import { Layout } from './components/shell/Layout.js';
import {
  IMPORT_SKILL_PATH,
  NEW_SKILL_PATH,
  QUARANTINE_IMPORT_PATH,
  SKILL_EDIT_ROUTE,
  SKILL_VIEW_ROUTE,
  isLegacyNewSkillPath,
  legacyNewSkillTarget,
} from './components/shell/routes.js';
import type { OnLogout } from './components/shell/UserMenu.js';
import { useTheme } from './themeStore.js';
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
import { QuarantinePage } from './pages/QuarantinePage.js';
import { QuarantineItemPage } from './pages/QuarantineItemPage.js';
import { ServersPage } from './pages/ServersPage.js';
import { CatalogsPage } from './pages/CatalogsPage.js';
import { CatalogPage } from './pages/CatalogPage.js';
import { CatalogEditorPage } from './pages/CatalogEditorPage.js';
import {
  ConnectSettingsPage,
  DefaultMcpSettingsPage,
  EnvironmentSettingsPage,
  QuarantineSettingsPage,
  RagSettingsPage,
} from './pages/SettingsPage.js';
import { AdminKeysPage } from './pages/AdminKeysPage.js';
import { MyKeysPage } from './pages/MyKeysPage.js';
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
  // Os campos de operação não chegam sem sessão: valem os mesmos padrões que o
  // `getSession` usa para completar a resposta anônima.
  ...SESSION_OPERATION_DEFAULTS,
};

export default function App() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  /** A última saída revogou a conta inteira: o login diz isso a quem voltou. */
  const [revokedAll, setRevokedAll] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSession(await getSession());
    } catch {
      setSession(OFFLINE);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Sai da sessão e volta ao login; com `'setup'`, o login abre já no
   * cadastro do primeiro administrador (`/?setup=1`). O spinner vem antes de
   * tudo porque desmonta o Shell: navegar com ele montado abriria `/mcps`,
   * cuja busca voltaria 401 com o cookie já apagado.
   */
  const signOut = useCallback(
    async (then?: 'setup') => {
      setLoading(true);
      // `revoked` diz que o `token_version` da conta subiu — logo, as sessões
      // dela nos outros aparelhos caíram com esta. Volta `false` na sessão de
      // bootstrap (não há conta) e quando o banco recusou: nada a anunciar.
      const out = await logout().catch(() => null);
      setRevokedAll(out?.revoked === true);
      navigate(then === 'setup' ? '/?setup=1' : '/');
      await refresh();
    },
    [navigate, refresh],
  );

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

  // Cada ramo tem o seu ToastProvider (`key`). Sem ela o React reaproveita o
  // mesmo provider na troca de ramo, e um toast da tela anterior — o 401 de
  // uma busca que terminou depois da saída — aparece na seguinte.
  if (!current.authenticated || !current.user) {
    return (
      <ToastProvider key="login">
        <LoginPage
          session={current}
          onSuccess={refresh}
          notice={revokedAll ? 'Sessão encerrada aqui e nos outros aparelhos desta conta.' : null}
        />
      </ToastProvider>
    );
  }

  // Senha temporária: nenhuma outra tela abre antes da troca — o servidor
  // recusa as demais rotas de qualquer forma.
  if (current.user.mustChangePassword) {
    return (
      <ToastProvider key="password">
        <ChangePasswordPage iconUrl={current.brand.iconUrl} onDone={refresh} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider key="shell">
      <ConfirmProvider>
        <CommandProvider>
          <Shell session={current} user={current.user} onRefresh={refresh} onLogout={signOut} />
          <CommandPalette />
        </CommandProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Shell({
  session,
  user,
  onRefresh,
  onLogout,
}: {
  session: Session;
  user: SessionUser;
  /** Relê a sessão — depois de trocar a senha, por exemplo. */
  onRefresh: () => void;
  onLogout: OnLogout;
}) {
  const stage = Boolean(useMatch('/mcps/:slug/*'));
  const admin = canManageUsers(user.role);
  const confirm = useConfirm();

  /**
   * Sair revoga a conta, não o aparelho: o `token_version` sobe e derruba todas
   * as sessões dela (`docs/05-accounts-and-roles.md` §2.2). Quem clica precisa
   * saber disso **antes** — depois a tela já é o login. A sessão de bootstrap
   * não tem conta para revogar e sai direto, como quem vai criar o primeiro
   * administrador.
   */
  const askLogout = useCallback<OnLogout>(
    (then) => {
      if (then === 'setup' || user.legacy) {
        onLogout(then);
        return;
      }
      void confirm({
        title: 'Sair de todos os aparelhos?',
        description:
          'Sair encerra esta sessão e também as desta conta em outros navegadores e aparelhos — o mesmo efeito de trocar a própria senha.',
        confirmLabel: 'Sair',
        cancelLabel: 'Ficar',
      }).then((ok) => {
        if (ok) onLogout();
      });
    },
    [confirm, onLogout, user.legacy],
  );

  return (
    <Layout session={session} user={user} onLogout={askLogout} stage={stage}>
      <GlobalCommands session={session} user={user} onLogout={askLogout} />
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
        <Route path="/skills" element={<SkillsPage key="all" user={user} />} />
        {/* A criação fica FORA de `/skills/…`: ali, uma rota estática ganharia do
            `:slug` em qualquer ordem, e a skill de slug `new` não abriria (`routes.ts`). */}
        <Route
          path={NEW_SKILL_PATH}
          element={canCreate(user.role) ? <NewSkillPage /> : <Navigate to="/skills" replace />}
        />
        {/* As fichas têm guias em rotas próprias (`/propriedades`, `/acessos`); a edição fica sob `/editar`. */}
        {/* Sem trava de papel: o editor já trava o que o acesso não permite. */}
        <Route path={SKILL_EDIT_ROUTE} element={<SkillEditorPage session={session} user={user} />} />
        <Route path={SKILL_VIEW_ROUTE} element={<SkillRoute session={session} user={user} />} />
        {/* A quarentena (`docs/15-quarentena.md`). O endereço é o uuid: envio não
            tem slug, e dois envios podem ter o mesmo nome. */}
        <Route path="/quarentena" element={<QuarantinePage user={user} />} />
        <Route path="/quarentena/:uuid" element={<QuarantineItemPage />} />
        <Route path="/catalogos" element={<CatalogsPage key="all" user={user} />} />
        <Route path="/catalogos/:slug/editar/*" element={<CatalogEditorPage user={user} />} />
        <Route path="/catalogos/:slug/*" element={<CatalogPage session={session} user={user} />} />
        <Route
          path="/auditoria/*"
          element={admin ? <AuditPage session={session} /> : <Navigate to="/mcps" replace />}
        />
        {/* A sessão de bootstrap não tem conta: não há senha para trocar nem chave para emitir. */}
        <Route
          path="/account"
          element={user.legacy ? <Navigate to="/mcps" replace /> : <AccountPage user={user} onChanged={onRefresh} />}
        />
        <Route
          path="/account/chaves-adm"
          element={user.legacy ? <Navigate to="/mcps" replace /> : <AdminKeysPage user={user} />}
        />
        {/* Ela lista também as `psv_` que a conta emitiu: a sessão de bootstrap entra. */}
        <Route path="/account/chaves-emitidas" element={<MyKeysPage user={user} />} />
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
        {/* Meu espaço: as listas recortadas no que é da conta. */}
        <Route path="/meu-espaco" element={<Navigate to="/meu-espaco/skills" replace />} />
        <Route path="/meu-espaco/skills" element={<SkillsPage key="mine" user={user} mine />} />
        <Route path="/meu-espaco/catalogos" element={<CatalogsPage key="mine" user={user} mine />} />
        <Route path="/meu-espaco/chaves" element={<Navigate to="/account/chaves-emitidas" replace />} />
        {/* Uma tela por assunto da instalação; a raiz leva à primeira. */}
        <Route
          path="/configuracoes"
          element={<Navigate to={admin ? '/configuracoes/mcp-padrao' : '/mcps'} replace />}
        />
        <Route
          path="/configuracoes/mcp-padrao"
          element={admin ? <DefaultMcpSettingsPage session={session} /> : <Navigate to="/mcps" replace />}
        />
        <Route
          path="/configuracoes/busca-semantica"
          element={admin ? <RagSettingsPage /> : <Navigate to="/mcps" replace />}
        />
        <Route
          path="/configuracoes/quarentena"
          element={admin ? <QuarantineSettingsPage /> : <Navigate to="/mcps" replace />}
        />
        <Route
          path="/configuracoes/ambiente"
          element={admin ? <EnvironmentSettingsPage session={session} /> : <Navigate to="/mcps" replace />}
        />
        <Route
          path="/configuracoes/conectar"
          element={admin ? <ConnectSettingsPage session={session} /> : <Navigate to="/mcps" replace />}
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

/**
 * A ficha da skill — e, em `/skills/new`, o desempate. Esse endereço já foi o
 * do formulário de criação (hoje `NEW_SKILL_PATH`) e continua em favoritos e
 * links de fora; ele é também, como o de qualquer skill, o da que tem o slug
 * `new`. Vence a skill quando ela existe para esta sessão; sem ela, o endereço
 * segue levando ao formulário, como sempre levou. Os outros slugs passam
 * direto, sem consulta nenhuma.
 */
function SkillRoute({ session, user }: { session: Session; user: SessionUser }) {
  const { slug, '*': rest } = useParams();
  const location = useLocation();
  const legacy = isLegacyNewSkillPath(slug, rest);
  // `null` = ainda não se sabe se a skill de slug `new` existe.
  const [exists, setExists] = useState<boolean | null>(null);

  useEffect(() => {
    if (!legacy || exists !== null) return;
    let active = true;
    getSkill(slug ?? '')
      .then(() => active && setExists(true))
      // Só o 404 diz "não existe". Qualquer outra falha fica com a ficha, que
      // já sabe avisar e voltar para a lista, como faz com toda skill.
      .catch((err) => active && setExists(!(err instanceof ApiError && err.status === 404)));
    return () => {
      active = false;
    };
  }, [legacy, exists, slug]);

  if (legacy && exists === null) {
    return (
      <div className="page">
        <Skel h={32} w={320} className="mb-5" />
        <Skel h="50vh" />
      </div>
    );
  }
  if (legacy && !exists) return <Navigate to={legacyNewSkillTarget(location.search)} replace />;
  return <SkillViewPage session={session} user={user} />;
}

/** Os comandos que valem em qualquer tela: criar, navegar, conta. */
function GlobalCommands({ session, user, onLogout }: { session: Session; user: SessionUser; onLogout: OnLogout }) {
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
              run: () => navigate(NEW_SKILL_PATH),
            },
            {
              id: 'import-skill',
              label: 'Importar pacote para produção',
              group: 'Criar' as const,
              icon: <Upload />,
              keywords: ['zip', 'skill', 'importar', 'upload', 'pacote'],
              run: () => navigate(IMPORT_SKILL_PATH),
            },
            {
              id: 'import-quarantine',
              label: 'Importar pacote para a quarentena',
              group: 'Criar' as const,
              icon: <ShieldQuestion />,
              keywords: ['zip', 'skill', 'importar', 'quarentena', 'aprovar', 'pacote'],
              run: () => navigate(QUARANTINE_IMPORT_PATH),
            },
          ]
        : []),
      { id: 'go-mcps', label: 'Servidores MCP', group: 'Ir para', icon: <LayoutGrid />, shortcut: 'g s', run: () => navigate('/mcps') },
      { id: 'go-skills', label: 'Skills', group: 'Ir para', icon: <BookOpenCheck />, shortcut: 'g k', run: () => navigate('/skills') },
      { id: 'go-my-skills', label: 'Minhas Skills', group: 'Ir para', icon: <BookOpenCheck />, keywords: ['meu espaço', 'dono'], run: () => navigate('/meu-espaco/skills') },
      { id: 'go-my-catalogs', label: 'Meus catálogos', group: 'Ir para', icon: <Library />, keywords: ['meu espaço', 'dono'], run: () => navigate('/meu-espaco/catalogos') },
      { id: 'go-my-keys', label: 'Chaves emitidas', group: 'Ir para', icon: <KeySquare />, keywords: ['configurações', 'api', 'psk', 'psv'], run: () => navigate('/account/chaves-emitidas') },
      { id: 'go-catalogs', label: 'Catálogos', group: 'Ir para', icon: <Library />, shortcut: 'g c', keywords: ['catalogo'], run: () => navigate('/catalogos') },
      ...(canCreate(user.role)
        ? [
            { id: 'go-quarantine', label: 'Quarentena', group: 'Ir para' as const, icon: <ShieldQuestion />, keywords: ['aprovar', 'envio', 'importado'], run: () => navigate('/quarentena') },
          ]
        : []),
      ...(admin
        ? [
            { id: 'go-audit', label: 'Auditoria', group: 'Ir para' as const, icon: <ListChecks />, shortcut: 'g a', run: () => navigate('/auditoria') },
            { id: 'go-settings', label: 'Configurações: MCP padrão', group: 'Ir para' as const, icon: <Server />, keywords: ['mcp padrão', 'instalação'], run: () => navigate('/configuracoes/mcp-padrao') },
            { id: 'go-settings-rag', label: 'Configurações: busca semântica', group: 'Ir para' as const, icon: <Sparkles />, keywords: ['rag', 'embeddings', 'instalação'], run: () => navigate('/configuracoes/busca-semantica') },
            { id: 'go-settings-env', label: 'Configurações: ambiente', group: 'Ir para' as const, icon: <SlidersHorizontal />, keywords: ['env', 'variáveis', 'instalação'], run: () => navigate('/configuracoes/ambiente') },
            { id: 'go-settings-connect', label: 'Configurações: conectar ao MCP público', group: 'Ir para' as const, icon: <Plug />, keywords: ['mcp.json', 'instalação'], run: () => navigate('/configuracoes/conectar') },
          ]
        : []),
      ...(admin && !user.legacy
        ? [{ id: 'go-users', label: 'Usuários', group: 'Ir para' as const, icon: <Users />, shortcut: 'g u', run: () => navigate('/users') }]
        : []),
      ...(user.legacy
        ? [{ id: 'setup-admin', label: 'Sair e criar o primeiro administrador', group: 'Conta' as const, icon: <UserPlus />, keywords: ['bootstrap', 'setup', 'conta', 'admin'], run: () => onLogout('setup') }]
        : [
            { id: 'go-account', label: 'Minha conta', group: 'Conta' as const, icon: <UserRound />, keywords: ['senha'], run: () => navigate('/account') },
            { id: 'go-admin-keys', label: 'Adm MCP Keys', group: 'Conta' as const, icon: <KeyRound />, keywords: ['chave', 'api', 'psk', 'token', 'emitir'], run: () => navigate('/account/chaves-adm') },
          ]),
      { id: 'site', label: 'Ver o site do catálogo', group: 'Conta', icon: <ExternalLink />, run: () => {
          window.open(session.siteBaseUrl, '_blank', 'noreferrer');
        },
      },
      { id: 'theme', label: theme === 'dark' ? 'Tema claro' : 'Tema escuro', group: 'Conta', icon: theme === 'dark' ? <Sun /> : <Moon />, keywords: ['tema', 'dark', 'light'], run: toggleTheme },
      { id: 'logout', label: 'Sair', group: 'Conta', icon: <LogOut />, run: () => onLogout() },
    ],
    [user.role, user.legacy, theme, session.siteBaseUrl],
  );

  // Atalhos "g + tecla", fora de campos de texto. O acorde é estado
  // compartilhado (`ui.tsx`) porque quem tem atalho de uma letra só — o palco,
  // por exemplo — precisa saber que esta tecla já é a segunda de um acorde.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'g') {
        armChord();
        return;
      }
      if (!isChordKey(event)) return;
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
