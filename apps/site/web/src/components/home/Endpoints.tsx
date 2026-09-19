import { useMeta } from '../../useMeta.js';
import { CopyButton } from '../CopyButton.js';
import { ExternalLinkIcon, GlobeIcon, ShieldIcon } from '../Icons.js';
import type { ReactNode } from 'react';

type Endpoint = {
  id: string;
  title: string;
  auth: string;
  text: string;
  url: string | null;
  icon: ReactNode;
};

const McpIcon = () => <img src="/assets/images/icon-mcp-64.png" alt="" />;

export function Endpoints() {
  const meta = useMeta();

  // O MCP público é o MCP virtual padrão: o que o cartão diz sobre chave e
  // disponibilidade vem dele, e não de uma configuração do site.
  const mcp = meta?.mcp;
  const mcpAuth = !meta?.mcpUrl
    ? 'não divulgado'
    : mcp?.status === 'ok'
      ? mcp.requiresKey
        ? 'leitura · chave psv_'
        : 'leitura · sem token'
      : 'sem MCP padrão';
  const mcpText =
    mcp?.status === 'ok'
      ? `Endpoint que os agentes consultam para buscar, ler e baixar as skills do MCP virtual "${mcp.name}", o padrão desta instalação.`
      : mcp?.status === 'inactive'
        ? 'O MCP virtual escolhido como padrão está desligado: este endereço responde 404 até ser religado.'
        : mcp?.status === 'deleted'
          ? 'O MCP virtual escolhido como padrão foi removido: este endereço responde 404 até outro ser escolhido.'
          : 'Nenhum MCP virtual foi escolhido como padrão: este endereço responde 404 até um administrador escolher.';

  const endpoints: Endpoint[] = [
    {
      id: 'mcp',
      title: 'MCP público',
      auth: mcpAuth,
      text: mcpText,
      url: meta?.mcpUrl ?? null,
      icon: <McpIcon />,
    },
    {
      id: 'mcp-admin',
      title: 'MCP administrativo',
      auth: 'Authorization: Bearer',
      text: 'A administração pelo agente: cria e edita skills e catálogos, importa .zip e decide o que fica público.',
      url: meta?.mcpAdminUrl ?? null,
      icon: <McpIcon />,
    },
    {
      id: 'admin',
      title: 'Painel administrativo',
      auth: 'senha',
      text: 'A mesma administração pelo navegador. É lá que ficam, para quem tem acesso, as skills e os catálogos privados.',
      url: meta?.adminUrl ?? null,
      icon: <ShieldIcon />,
    },
    {
      id: 'api',
      title: 'API REST pública',
      auth: 'leitura · CORS aberto',
      text: 'Alternativa ao MCP para scripts e integrações: a mesma busca e os mesmos downloads das skills públicas, em JSON.',
      url: `${meta?.baseUrl ?? ''}/api/skills`,
      icon: <GlobeIcon />,
    },
  ];

  return (
    <section className="endpoints" id="enderecos">
      <div className="wrap">
        <div className="head reveal">
          <h2 className="display">
            Endereços <span className="grad-text">de acesso</span>
          </h2>
          <p>
            As portas desta instalação. Os dois MCPs configuram seus agentes; o painel é onde você
            publica skills e catálogos novos.
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
                  <a
                    href={endpoint.url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-ghost btn-sm"
                    title={`Abrir ${endpoint.url} em uma nova guia`}
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
