import { useMeta } from '../../useMeta.js';
import { CopyButton } from '../CopyButton.js';
import { GlobeIcon, ShieldIcon } from '../Icons.js';
import type { ReactNode } from 'react';

type Endpoint = {
  id: string;
  title: string;
  auth: string;
  text: string;
  url: string | null;
  icon: ReactNode;
  /** Endereço para abrir no navegador; os MCPs só respondem a clientes MCP. */
  open?: boolean;
};

const McpIcon = () => <img src="/assets/images/icon-mcp-64.png" alt="" />;

export function Endpoints() {
  const meta = useMeta();

  const endpoints: Endpoint[] = [
    {
      id: 'mcp',
      title: 'MCP público',
      auth: meta?.mcpUrl ? 'leitura · sem token' : 'não divulgado',
      text: 'Endpoint que os agentes consultam para buscar, ler e baixar as skills públicas do catálogo.',
      url: meta?.mcpUrl ?? null,
      icon: <McpIcon />,
    },
    {
      id: 'mcp-admin',
      title: 'MCP administrativo',
      auth: 'Authorization: Bearer',
      text: 'CRUD completo do catálogo pelo agente: cria, edita, importa .zip e alterna a visibilidade das skills.',
      url: meta?.mcpAdminUrl ?? null,
      icon: <McpIcon />,
    },
    {
      id: 'admin',
      title: 'Painel administrativo',
      auth: 'senha',
      text: 'A mesma administração pelo navegador, para quando é você — e não o agente — quem vai mexer no catálogo.',
      url: meta?.adminUrl ?? null,
      icon: <ShieldIcon />,
      open: true,
    },
    {
      id: 'api',
      title: 'API REST pública',
      auth: 'leitura · CORS aberto',
      text: 'Alternativa ao MCP para scripts e integrações: a mesma busca e os mesmos downloads, em JSON.',
      url: `${meta?.baseUrl ?? ''}/api/skills`,
      icon: <GlobeIcon />,
      open: true,
    },
  ];

  return (
    <section className="endpoints" id="enderecos">
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Endereços <span className="grad-text">de acesso.</span>
          </h2>
          <p>
            As portas desta instalação. Guarde as duas primeiras para configurar seus agentes; a
            terceira é onde você publica skills novas.
          </p>
        </div>

        <div className="endpoint-grid">
          {endpoints.map((endpoint, index) => (
            <article className={`endpoint-card reveal d${(index % 3) + 1}`} key={endpoint.id}>
              <div className="ep-top">
                <span className="ep-ico">{endpoint.icon}</span>
                <span>
                  <h3>{endpoint.title}</h3>
                  <span className="ep-auth">{endpoint.auth}</span>
                </span>
              </div>

              <p>{endpoint.text}</p>

              <code className={`ep-url${endpoint.url ? '' : ' off'}`}>
                {endpoint.url ?? 'não configurado nesta instalação'}
              </code>

              {endpoint.url && (
                <div className="ep-foot">
                  <CopyButton
                    value={endpoint.url}
                    label="Copiar URL"
                    className="btn btn-ghost btn-sm"
                  />
                  {endpoint.open && (
                    <a
                      href={endpoint.url}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-ghost btn-sm"
                    >
                      Abrir
                    </a>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
