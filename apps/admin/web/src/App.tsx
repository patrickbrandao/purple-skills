import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { getSession, type Session } from './api.js';
import { ToastProvider } from './components/Toast.js';
import { Layout } from './components/Layout.js';
import { LoginPage } from './pages/LoginPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { SkillsPage } from './pages/SkillsPage.js';
import { SkillEditorPage } from './pages/SkillEditorPage.js';
import { NewSkillPage } from './pages/NewSkillPage.js';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSession(await getSession());
    } catch {
      setSession(null);
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

  return (
    <ToastProvider>
      {!session?.authenticated ? (
        <LoginPage onSuccess={refresh} />
      ) : (
        <Layout session={session} onLogout={refresh}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/skills/new" element={<NewSkillPage />} />
            <Route path="/skills/:slug" element={<SkillEditorPage session={session} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      )}
    </ToastProvider>
  );
}
