import { useCatalogSummary } from '../../useCatalogSummary.js';
import { useMeta } from '../../useMeta.js';

/**
 * Chamada curta do catálogo.
 *
 * Não explica o projeto — quem quer saber o que é o Purple Skills vai para a
 * homepage. Aqui só o nome da instalação, o que ela tem e por onde começar.
 */
export function Masthead() {
  const meta = useMeta();
  const summary = useCatalogSummary();

  return (
    <header className="masthead" id="top">
      <div className="wrap masthead-grid">
        <div className="masthead-copy">
          <h1 className="display">
            {meta?.name ?? 'Purple Skills'}
            <br />
            <span className="grad-text">o seu catálogo de skills.</span>
          </h1>
          <p className="sub">
            {meta?.tagline ?? 'Catálogo aberto de skills para agentes de IA'}. Procure a skill que
            precisa, leia o SKILL.md e baixe o pacote — ou conecte seu agente ao MCP e deixe que ele
            faça tudo isso sozinho.
          </p>

          <div className="masthead-cta">
            <a href="#catalogo" className="btn btn-primary btn-lg">
              Explorar o catálogo →
            </a>
            <a href="#comecar" className="btn btn-ghost btn-lg">
              Conectar um agente
            </a>
          </div>

          <div className="masthead-facts">
            <span>
              <b>{summary?.total ?? '—'}</b> skills publicadas
            </span>
            <span>
              <b>{summary?.tags.length ?? '—'}</b> tags
            </span>
          </div>
        </div>

        <img
          className="masthead-fig wiz"
          src="/assets/images/icon-purple-right-137x158.png"
          alt="O Mago Roxo, mascote do Purple Skills"
          width={137}
          height={158}
        />
      </div>
    </header>
  );
}
