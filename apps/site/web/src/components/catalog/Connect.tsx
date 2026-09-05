import { useState } from 'react';
import { useMeta } from '../../useMeta.js';
import { CopyButton } from '../CopyButton.js';
import { ArrowRightIcon } from '../Icons.js';

type Mode = 'publico' | 'admin';

const MODES = [
  { value: 'publico', label: 'MCP público' },
  { value: 'admin', label: 'MCP administrativo' },
] as const;

/** Colore um JSON de configuração: chaves em roxo, valores de texto em âmbar. */
function JsonBlock({ text }: { text: string }) {
  const parts = text.split(/("(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*")/g);
  return (
    <>
      {parts.map((part, index) => {
        if (part.endsWith(':')) {
          return (
            <span className="k" key={index}>
              {part}
            </span>
          );
        }
        if (part.startsWith('"')) {
          return (
            <span className="s" key={index}>
              {part}
            </span>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </>
  );
}

export function Connect() {
  const meta = useMeta();
  const [mode, setMode] = useState<Mode>('publico');

  // Sem URL configurada, mostramos um endereço de exemplo em vez de um campo
  // vazio: a configuração continua servindo de modelo para copiar e ajustar.
  const publicUrl = meta?.mcpUrl ?? 'https://mcp.seu-dominio.dev/mcp';
  const adminUrl = meta?.mcpAdminUrl ?? 'https://mcp-admin.seu-dominio.dev/mcp';

  const config =
    mode === 'publico'
      ? { mcpServers: { 'purple-skills': { type: 'http', url: publicUrl } } }
      : {
          mcpServers: {
            'purple-skills-admin': {
              type: 'http',
              url: adminUrl,
              headers: { Authorization: 'Bearer SEU_TOKEN_ADMINISTRATIVO' },
            },
          },
        };

  const json = JSON.stringify(config, null, 4);

  return (
    <section className="how-connect-sec" id="comecar">
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Configure o seu <span className="grad-text">mcp.json</span>
          </h2>
          <p>
            Cole o bloco abaixo no arquivo de configuração MCP do seu agente. O servidor público é
            só de leitura e serve para consumir o catálogo; o administrativo cria e edita skills, e
            exige o token no cabeçalho <code className="mono">Authorization</code>.
          </p>
        </div>

        <div className="mt-6 flex justify-center reveal d1">
          <div className="segmented">
            {MODES.map((option) => (
              <button
                key={option.value}
                type="button"
                className={mode === option.value ? 'active' : ''}
                onClick={() => setMode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="connect-diagram reveal d2">
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
              <span>
                mcp.json —{' '}
                {mode === 'publico'
                  ? 'search_skills · get_skill · download_skill'
                  : 'create_skill · set_file · set_visibility'}
              </span>
            </div>
            <div className="code-body">
              <JsonBlock text={json} />
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-center reveal d3">
          <CopyButton value={json} label="Copiar configuração" className="btn btn-ghost" />
        </div>
      </div>
    </section>
  );
}
