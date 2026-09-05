import { GithubIcon } from '../Icons.js';

const REPO = 'https://github.com/patrickbrandao/purple-skills';

export function Finale() {
  return (
    <section className="finale" id="self-host">
      <div className="wrap">
        <div className="finale-card reveal">
          <h2 className="display">
            Rode o seu <span className="grad-text">Purple Skills.</span>
          </h2>
          <p>
            Cinco containers, um Postgres e nenhuma conta em nuvem. Em menos de um minuto você tem
            homepage, catálogo, painel e os dois servidores MCP de pé — tudo sob o seu domínio.
          </p>

          <div className="code-card">
            <div className="code-top">
              <span className="tl" />
              <span className="tl" />
              <span className="tl" />
              <span>bash — 60 segundos</span>
            </div>
            <div className="code-body">
              <span className="c">{'# clone, configure e suba'}</span>
              {'\n'}
              <span className="k">git</span> clone {REPO}
              {'\n'}
              <span className="k">cp</span> .env.example .env{'   '}
              <span className="c">{'# ADMIN_PASSWORD, MCP_ADMIN_TOKEN'}</span>
              {'\n'}
              <span className="k">docker</span> compose run --rm migrate
              {'\n'}
              <span className="k">docker</span> compose up -d
              {'\n\n'}
              <span className="c">{'# site :3000 · admin :3001 · mcp :3002 e :3003 · homepage :3004'}</span>
            </div>
          </div>

          <div className="finale-cta">
            <a href={REPO} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-lg">
              <GithubIcon /> Ver no GitHub
            </a>
            <a href={`${REPO}#readme`} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-lg">
              Ler a documentação
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
