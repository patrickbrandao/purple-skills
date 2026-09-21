import { ArrowRightIcon } from '../Icons.js';

/** URL de exemplo: a homepage não conhece nenhuma instalação de verdade. */
const MCP_ADMIN_URL = 'https://mcp-admin.seu-dominio.dev/mcp';

export function QuickStartAdmin() {
  return (
    <section className="how-connect-sec" id="administer">
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Administrar Skills via agente. Configure o seu <span className="grad-text">mcp.json</span>
          </h2>
          <p>
            Aponte seu agente para o endpoint administrativo e ele cria, edita e publica skills
            sozinho. O servidor exige o token no cabeçalho <code className="mono">Authorization</code>.
          </p>
        </div>

        <div className="connect-diagram reveal d1">
          <figure className="connect-agent">
            <img
              src="/assets/images/claude-code-up-right-01_512.png"
              alt="Um agente de IA"
              width={172}
              height={172}
            />
            <figcaption>SEU AGENTE<br />PROVISIONADOR</figcaption>
          </figure>

          <div className="connect-link" aria-hidden>
            <span className="cl-line" />
            <ArrowRightIcon />
          </div>

          <div className="code-card connect-code">
            <div className="code-top">
              <span className="tl" />
              <span className="tl" />
              <span className="tl" />
              <span>mcp.json — create_skill · set_file · link_skill</span>
            </div>
            <div className="code-body">
              <span className="c">{'// Adicione o Purple Skills administrativo ao seu agente'}</span>
              {'\n{\n    '}
              <span className="k">"mcpServers"</span>
              {': {\n        '}
              <span className="k">"purple-skills-admin"</span>
              {': {\n            '}
              <span className="k">"type"</span>
              {': '}
              <span className="s">"http"</span>
              {',\n            '}
              <span className="k">"url"</span>
              {': '}
              <span className="s">{`"${MCP_ADMIN_URL}"`}</span>
              {',\n            '}
              <span className="k">"headers"</span>
              {': {\n                '}
              <span className="k">"Authorization"</span>
              {': '}
              <span className="s">"Bearer SEU_TOKEN_ADMINISTRATIVO"</span>
              {'\n            }\n        }\n    }\n}'}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
