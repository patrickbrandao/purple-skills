import { useMeta } from '../../useMeta.js';
import { ArrowRightIcon } from '../Icons.js';

export function QuickStart() {
  const meta = useMeta();
  const mcpUrl = meta?.mcpUrl ?? 'https://mcp.seu-dominio.dev/mcp';

  return (
    <section className="how-connect-sec" id="comecar">
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Comece a usar <span className="grad-text">agora!</span>
          </h2>
          <p>
            Aponte seu agente para o endpoint MCP do Purple Skills. Cole a configuração e pronto —
            ele já enxerga o catálogo inteiro, busca pelo que precisa e lê o SKILL.md sozinho.
          </p>
        </div>

        <div className="connect-diagram reveal d1">
          <figure className="connect-agent">
            <img
              src="/assets/images/icon-lm-studio-agent-happy-172x158.png"
              alt="Um agente de IA"
              width={172}
              height={158}
            />
            <figcaption>SEU AGENTE</figcaption>
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
              <span>mcp.json — search_skills · get_skill · download_skill</span>
            </div>
            <div className="code-body">
              <span className="c">{'// Adicione o Purple Skills ao seu agente'}</span>
              {'\n{\n    '}
              <span className="k">"mcpServers"</span>
              {': {\n        '}
              <span className="k">"purple-skills"</span>
              {': {\n            '}
              <span className="k">"type"</span>
              {': '}
              <span className="s">"http"</span>
              {',\n            '}
              <span className="k">"url"</span>
              {': '}
              <span className="s">{`"${mcpUrl}"`}</span>
              {'\n        }\n    }\n}'}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
