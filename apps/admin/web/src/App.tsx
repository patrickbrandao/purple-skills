import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { canManageUsers, canWrite, getSession, type Session } from './api.js';
import { ToastProvider } from './components/Toast.js';
import { Layout } from './components/Layout.js';
import { LoginPage } from './pages/LoginPage.js';
import { ChangePasswordPage } from './pages/ChangePasswordPage.js';
import { AccountPage } from './pages/AccountPage.js';
import { UsersPage } from './pages/UsersPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { SkillViewPage } from './pages/SkillViewPage.js';
import { SkillEditorPage } from './pages/SkillEditorPage.js';
import { NewSkillPage } from './pages/NewSkillPage.js';

/** Estado assumido quando `/api/session` não responde — só serve ao login. */
const OFFLINE: Session = {
  authenticated: false,
  user: null,
  needsSetup: false,
  legacyLogin: false,
  oidc: { enabled: false },
  passwordResetByEmail: false,
  siteName: 'Purple Skills',
  siteBaseUrl: '/',
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

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
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
        <ChangePasswordPage onDone={refresh} />
      </ToastProvider>
    );
  }

  const user = current.user;

  return (
    <ToastProvider>
      <Layout session={current} user={user} onLogout={refresh}>
        <Routes>
          <Route path="/" element={<DashboardPage user={user} />} />
          <Route path="/skills" element={<SkillsPage user={user} />} />
          <Route
            path="/skills/new"
            element={canWrite(user.role) ? <NewSkillPage /> : <Navigate to="/skills" replace />}
          />
          <Route path="/skills/:slug" element={<SkillViewPage session={current} user={user} />} />
          {/* Sem trava de papel: o editor já esconde o que o papel não permite,
              e é assim que ele se comporta desde antes da tela de leitura. */}
          <Route
            path="/skills/:slug/editar"
            element={<SkillEditorPage session={current} user={user} />}
          />
          <Route path="/account" element={<AccountPage user={user} onChanged={refresh} />} />
          <Route
            path="/users"
            element={canManageUsers(user.role) ? <UsersPage me={user} /> : <Navigate to="/" replace />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </ToastProvider>
  );
}
