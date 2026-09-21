import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { HomePage } from './pages/HomePage.js';
import { SkillPage } from './pages/SkillPage.js';
import { CatalogPage } from './pages/CatalogPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/skills/:slug" element={<SkillPage />} />
        <Route path="/catalogs/:slug" element={<CatalogPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}
