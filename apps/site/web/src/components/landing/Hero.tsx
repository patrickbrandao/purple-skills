export function Hero() {
  return (
    <header className="hero" id="top">
      <div className="wrap">
        <div className="hero-copy">
          <img
            className="hero-fig wiz"
            src="/assets/images/icon-purple-right-137x158.png"
            alt="O Mago Roxo, mascote do Purple Skills"
            width={137}
            height={158}
          />
          <h1 className="display">
            <span className="line">
              <span>Skills que seus</span>
            </span>
            <span className="line">
              <span>agentes podem</span>
            </span>
            <span className="line">
              <span className="grad-text">invocar.</span>
            </span>
          </h1>
          <p className="sub">
            O Purple-MCP é um catalogo privado e centralizado de skills que seus agentes espalhados pelo mundo podem consultar.
            Publique no painel, e todos os agentes conectados aprendem na mesma hora.
            Seu agente orquestrador pode editar e criar novas skills que orientarão seus processos em tempo real.
          </p>
          <div className="hero-cta">
            <a href="#catalogo" className="btn btn-primary btn-lg">
              Explorar o catálogo →
            </a>
            <a href="#comecar" className="btn btn-ghost btn-lg">
              Conectar um agente
            </a>
          </div>
          <div className="hero-trust">
            <span>
              <b>&lt;60s</b> para conectar
            </span>
            <span>
              <b>100%</b> software livre (MIT)
            </span>
            <span>
              <b>MCP</b> nativo · sem lock-in
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
