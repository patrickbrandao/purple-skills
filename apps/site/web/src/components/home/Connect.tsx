import { useMeta } from '../../useMeta.js';
import { CopyButton } from '../CopyButton.js';
import { ArrowRightIcon } from '../Icons.js';

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

  // Sem URL configurada, mostramos um endereço de exemplo em vez de um campo
  // vazio: a configuração continua servindo de modelo para copiar e ajustar.
  const publicUrl = meta?.mcpUrl ?? 'https://mcp.seu-dominio.dev/mcp';

  // O MCP público é o MCP virtual padrão: se ele exige chave, o snippet já
  // traz o header, com um placeholder para a chave psv_ que o dono emite.
  const requiresKey = meta?.mcp.status === 'ok' && meta.mcp.requiresKey;
  const config = {
    mcpServers: {
      'purple-skills': {
        type: 'http',
        url: publicUrl,
        ...(requiresKey ? { headers: { Authorization: 'Bearer SUA_CHAVE_PSV' } } : {}),
      },
    },
  };

  const json = JSON.stringify(config, null, 4);

  return (
    <section className="how-connect-sec" id="comecar">
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Skills no agente: configure o <span className="grad-text">mcp.json</span>
          </h2>
          <p>
            Cole o bloco abaixo na configuração MCP do seu agente. O MCP público é só de leitura: o
            agente busca as skills publicadas nele e lê o SKILL.md sozinho.
            {requiresKey &&
              ' Este servidor exige uma chave: troque o placeholder pela chave psv_ que o administrador emitiu para você.'}
          </p>
        </div>

        <div className="connect-diagram reveal d2">
          <figure className="connect-agent">
            <img
              src="/assets/images/bot-right-walk-01_512.png"
              alt="Um agente de IA"
              width={120}
              height={120}
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
              <JsonBlock text={json} />
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-center reveal d3">
          <CopyButton value={json} label="Copiar configuração" className="btn btn-ghost" />
        </div>

        <div className="connect-surfaces reveal d3">
          <p>
            Cada servidor publica suas skills por até três portas, escolhidas por quem o administra —
            a página de cada skill diz quais:
          </p>
          <ul>
            <li>
              <span className="s-tag">skill</span> — as ferramentas: o agente a encontra por{' '}
              <code>search_skills</code> e a lê com <code>get_skill</code>.
            </li>
            <li>
              <span className="s-tag">prompt</span> — a skill vira um prompt com o próprio slug: na
              maioria dos clientes, um comando que você invoca direto, sem o agente ter de buscá-la.
            </li>
            <li>
              <span className="s-tag">resource</span> — a skill ganha o endereço{' '}
              <code>skill://&lt;slug&gt;</code>, que o cliente anexa à conversa como um documento.
            </li>
          </ul>
          <p>
            As portas são independentes: uma skill só como prompt não aparece em{' '}
            <code>search_skills</code>, mas continua aqui, com download. Os outros servidores abertos
            estão logo abaixo, cada um com o próprio endereço.
          </p>
        </div>
      </div>
    </section>
  );
}
