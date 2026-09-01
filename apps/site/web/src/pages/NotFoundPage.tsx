import { Link } from 'react-router-dom';
import { ArrowLeftIcon } from '../components/Icons.js';

export function NotFoundPage() {
  return (
    <div className="py-32 text-center">
      <p className="text-6xl font-bold text-purple-500/30">404</p>
      <h1 className="mt-4 text-2xl font-semibold text-purple-100">Página não encontrada</h1>
      <Link
        to="/"
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-purple-500"
      >
        <ArrowLeftIcon /> Voltar ao catálogo
      </Link>
    </div>
  );
}
