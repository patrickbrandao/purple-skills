import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMeta } from '../useMeta.js';
import { useTheme } from '../useTheme.js';
import { MoonIcon, SunIcon } from './Icons.js';

const NAV = [
  { hash: '#catalogo', label: 'Catálogo' },
  { hash: '#comecar', label: 'mcp.json' },
  { hash: '#enderecos', label: 'Endereços' },
];

export function Layout({ children }: { children: ReactNode }) {
  const meta = useMeta();
  const location = useLocation();
  const [theme, toggleTheme] = useTheme();
  const [scrolled, setScrolled] = useState(false);

  // No topo da home os âncoras são locais; fora dela precisam recarregar a raiz.
  const home = location.pathname === '/';
  const anchor = (hash: string) => (home ? hash : `/${hash}`);

  useEffect(() => {
    const bar = document.querySelector<HTMLElement>('.progress');
    let ticking = false;

    const paint = () => {
      const y = window.scrollY || 0;
      setScrolled(y > 30);
      if (bar) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        bar.style.setProperty('--scroll', `${max > 0 ? (y / max) * 100 : 0}%`);
      }
      ticking = false;
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(paint);
    };

    paint();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  const name = meta?.name ?? 'Purple Skills';

  return (
    <>
      <div className="progress" aria-hidden />
      <div className="atmos" aria-hidden />

      <nav className={`nav${scrolled ? ' scrolled' : ''}`}>
        <div className="nav-inner">
          <Link to="/" className="brand" aria-label={name}>
            <img
              className="brand-mark wiz"
              src="/assets/images/purple-hat-256.png"
              alt=""
              width={30}
              height={30}
            />
            <span>
              Purple<b>Skills</b>
            </span>
          </Link>

          <div className="nav-links">
            {NAV.map((item) => (
              <a key={item.hash} href={anchor(item.hash)}>
                {item.label}
              </a>
            ))}
            <button
              type="button"
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            <a href={anchor('#catalogo')} className="btn btn-primary">
              Explorar skills
            </a>
          </div>
        </div>
      </nav>

      <main>{children}</main>

      <footer className="site-foot">
        <div className="wrap">
          <div className="foot-grid">
            <div className="foot-brand">
              <Link to="/" className="brand" style={{ fontSize: '1.4rem', color: 'var(--text)' }}>
                <img
                  className="brand-mark wiz"
                  src="/assets/images/purple-hat-256.png"
                  alt=""
                  width={34}
                  height={34}
                />
                <span>
                  Purple<b>Skills</b>
                </span>
              </Link>
              <p>
                As skills deste catálogo, prontas para os seus agentes. Configure o mcp.json uma vez
                e todos eles passam a enxergar tudo o que está publicado aqui.
              </p>
            </div>

            <div className="foot-col">
              <h5>Catálogo</h5>
              <a href={anchor('#catalogo')}>Explorar skills</a>
              <a href={anchor('#comecar')}>Configurar o mcp.json</a>
              <a href={anchor('#enderecos')}>Endereços de acesso</a>
            </div>

            <div className="foot-col">
              <h5>Acesso</h5>
              {meta?.mcpUrl && (
                <a href={meta.mcpUrl} target="_blank" rel="noreferrer">
                  MCP público
                </a>
              )}
              {meta?.mcpAdminUrl && (
                <a href={meta.mcpAdminUrl} target="_blank" rel="noreferrer">
                  MCP administrativo
                </a>
              )}
              {meta?.adminUrl && (
                <a href={meta.adminUrl} target="_blank" rel="noreferrer">
                  Painel administrativo
                </a>
              )}
              <a href="/api/skills" target="_blank" rel="noreferrer">
                API pública (JSON)
              </a>
            </div>

            <div className="foot-col">
              <h5>Referências</h5>
              <a href="https://agentskills.io" target="_blank" rel="noreferrer">
                Formato Agent Skills
              </a>
              <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">
                Model Context Protocol
              </a>
              <a href="/healthz" target="_blank" rel="noreferrer">
                Status
              </a>
            </div>
          </div>

          <div className="foot-bottom">
            <span>© {new Date().getFullYear()} {name} — software livre sob licença MIT.</span>
            <span className="mono" style={{ fontSize: '.78rem' }}>
              MCP nativo · self-hosted · sem lock-in
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
