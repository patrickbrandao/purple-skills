import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMeta } from '../useMeta.js';
import { SparkIcon } from './Icons.js';

export function Layout({ children }: { children: ReactNode }) {
  const meta = useMeta();

  return (
    <div className="flex min-h-screen flex-col">
      <div
        className="pointer-events-none fixed inset-x-0 top-0 h-[420px] opacity-60"
        style={{
          background:
            'radial-gradient(60% 100% at 50% 0%, rgba(147,51,234,0.28) 0%, rgba(11,7,22,0) 70%)',
        }}
        aria-hidden
      />

      <header className="sticky top-0 z-30 border-b border-purple-400/10 bg-ink-900/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5">
          <Link to="/" className="group flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-purple-400 to-purple-700 text-white shadow-md shadow-purple-900/40">
              <SparkIcon className="h-4 w-4" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-purple-50 transition group-hover:text-purple-200">
              {meta?.name ?? 'Purple Skills'}
            </span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            {meta?.mcpUrl && (
              <a
                href={meta.mcpUrl}
                className="rounded-lg px-3 py-1.5 text-slate-400 transition hover:bg-ink-800 hover:text-purple-200"
                target="_blank"
                rel="noreferrer"
              >
                MCP
              </a>
            )}
            <a
              href="https://github.com/patrickbrandao/purple-skills"
              target="_blank"
              rel="noreferrer"
              className="rounded-lg px-3 py-1.5 text-slate-400 transition hover:bg-ink-800 hover:text-purple-200"
            >
              GitHub
            </a>
          </nav>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-6xl flex-1 px-5 pb-20">{children}</main>

      <footer className="relative z-10 border-t border-purple-400/10 py-7">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-5 text-xs text-slate-500 sm:flex-row">
          <span>
            {meta?.name ?? 'Purple Skills'} — software livre sob licença MIT.
          </span>
          <span>Skills ordenadas por acessos + downloads.</span>
        </div>
      </footer>
    </div>
  );
}
