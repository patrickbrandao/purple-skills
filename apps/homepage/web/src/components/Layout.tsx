import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from '../useTheme.js';
import { GithubIcon, MoonIcon, SunIcon } from './Icons.js';

const REPO = 'https://github.com/patrickbrandao/purple-skills';

const NAV = [
  { hash: '#comecar', label: 'Começar' },
  { hash: '#como-funciona', label: 'Como funciona' },
  { hash: '#servicos', label: 'Serviços' },
  { hash: '#self-host', label: 'Instalar' },
];

export function Layout({ children }: { children: ReactNode }) {
  const [theme, toggleTheme] = useTheme();
  const [scrolled, setScrolled] = useState(false);

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

  return (
    <>
      <div className="progress" aria-hidden />
      <div className="atmos" aria-hidden />

      <nav className={`nav${scrolled ? ' scrolled' : ''}`}>
        <div className="nav-inner">
          <a href="#top" className="brand" aria-label="Purple Skills">
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
          </a>

          <div className="nav-links">
            {NAV.map((item) => (
              <a key={item.hash} href={item.hash}>
                {item.label}
              </a>
            ))}
            <a
              href={REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="gh btn btn-ghost"
              aria-label="Repositório no GitHub"
            >
              <GithubIcon />
            </a>
            <button
              type="button"
              className="icon-btn"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            <a
              href={REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Ver no GitHub
            </a>
          </div>
        </div>
      </nav>

      <main>{children}</main>

      <footer className="site-foot">
        <div className="wrap">
          <div className="foot-grid">
            <div className="foot-brand">
              <a href="#top" className="brand" style={{ fontSize: '1.4rem', color: 'var(--text)' }}>
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
              </a>
              <p>
                Catálogo aberto de skills para agentes de IA. Escreva uma vez, publique no seu
                servidor MCP e deixe que todos os seus agentes invoquem para sempre.
              </p>
            </div>

            <div className="foot-col">
              <h5>O projeto</h5>
              <a href="#como-funciona">Como funciona</a>
              <a href="#pecas">As três peças</a>
              <a href="#servicos">Serviços</a>
              <a href="#recursos">Recursos</a>
            </div>

            <div className="foot-col">
              <h5>Referências</h5>
              <a href={`${REPO}#readme`} target="_blank" rel="noreferrer">
                Documentação
              </a>
              <a href="https://agentskills.io" target="_blank" rel="noreferrer">
                Formato Agent Skills
              </a>
              <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">
                Model Context Protocol
              </a>
            </div>

            <div className="foot-col">
              <h5>Código</h5>
              <a href={REPO} target="_blank" rel="noreferrer">
                GitHub
              </a>
              <a href={`${REPO}/releases`} target="_blank" rel="noreferrer">
                Releases
              </a>
              <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
                Licença MIT
              </a>
              <a href={`${REPO}/issues`} target="_blank" rel="noreferrer">
                Reportar um problema
              </a>
            </div>
          </div>

          <div className="foot-bottom">
            <span>© {new Date().getFullYear()} Purple Skills — software livre sob licença MIT.</span>
            <span className="mono" style={{ fontSize: '.78rem' }}>
              MCP nativo · self-hosted · sem lock-in
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
