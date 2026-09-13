import { useEffect, useState } from 'react';
import { fetchOpenMcps, type PublicVirtualMcp } from '../../api.js';
import { CopyButton } from '../CopyButton.js';
import { ExternalLinkIcon } from '../Icons.js';

const McpIcon = () => <img src="/assets/images/icon-mcp-64.png" alt="" />;

/**
 * Os servidores MCP abertos desta instalação
 * (`docs/09-mcp-padrao-e-skills-flutuantes.md` §4.2). Aberto é público: cada
 * um responde sem chave em `/virtual/<slug>/mcp`, e o padrão também em
 * `/mcp`. As skills do catálogo acima são a união do que está neles.
 */
export function OpenMcps() {
  const [items, setItems] = useState<PublicVirtualMcp[] | null>(null);

  useEffect(() => {
    let active = true;
    fetchOpenMcps()
      .then((data) => active && setItems(data.items))
      .catch(() => active && setItems([]));
    return () => {
      active = false;
    };
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <section className="endpoints" id="servidores">
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Servidores MCP <span className="grad-text">abertos.</span>
          </h2>
          <p>
            Cada um publica um recorte do catálogo e responde sem chave. Aponte o agente para o que
            interessa ao seu time; o padrão é o mesmo endereço do MCP público.
          </p>
        </div>

        <div className="endpoint-grid">
          {items.map((mcp, index) => (
            <article className={`endpoint-card reveal d${(index % 3) + 1}`} key={mcp.uuid}>
              <div className="ep-top">
                <span className="ep-ico">
                  <McpIcon />
                </span>
                <span>
                  <h3>{mcp.name}</h3>
                  <span className="ep-auth">
                    {mcp.skillCount} skill{mcp.skillCount === 1 ? '' : 's'} · sem token
                    {mcp.isDefault && ' · padrão (/mcp)'}
                  </span>
                </span>
              </div>

              <p>{mcp.description || `Skills publicadas no servidor "${mcp.slug}".`}</p>

              <code className={`ep-url${mcp.url ? '' : ' off'}`}>
                {mcp.url ?? `/virtual/${mcp.slug}/mcp`}
              </code>

              {mcp.url && (
                <div className="ep-foot">
                  <CopyButton value={mcp.url} label="Copiar URL" className="btn btn-ghost btn-sm" />
                  <a
                    href={mcp.url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-ghost btn-sm"
                    title={`Abrir ${mcp.url} em uma nova guia`}
                  >
                    <ExternalLinkIcon /> Abrir
                  </a>
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
