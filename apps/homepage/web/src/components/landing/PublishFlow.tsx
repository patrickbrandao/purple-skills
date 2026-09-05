import { useEffect, useRef, type RefObject } from 'react';
import { PlugIcon, ServerIcon } from '../Icons.js';

const AGENTS = [
  { file: 'icon-agent-hermes-64.png', alt: 'Hermes' },
  { file: 'icon-agent-opencode-64.png', alt: 'OpenCode' },
  { file: 'icon-agent-pi-64.png', alt: 'Pi' },
  { file: 'icon-agent-openclaw-64.png', alt: 'OpenClaw' },
  { file: 'icon-lm-studio-agent-64.png', alt: 'LM Studio Agent' },
  { file: 'icon-lm-studio-app-64.png', alt: 'LM Studio' },
];

function Wire({ tone, bridge }: { tone: 'purple' | 'gold'; bridge?: boolean }) {
  return (
    <div className={`dia2-cell dia2-wire${bridge ? ' dia2-wire--bridge' : ''}`} aria-hidden>
      <svg className="dia2-wire-svg" viewBox="0 0 200 26" preserveAspectRatio="none">
        <path className={`dia2-wtrack dia2-wtrack--${tone}`} d="M0 13 L200 13" />
        <path className={`dia2-wflow dia2-wflow--${tone}`} d="M0 13 L200 13" />
      </svg>
    </div>
  );
}

/** Liga verticalmente o cartão da linha de cima ao da linha de baixo. */
function useVerticalLink(
  boardRef: RefObject<HTMLDivElement | null>,
  topRef: RefObject<HTMLDivElement | null>,
  bottomRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const board = boardRef.current;
    const top = topRef.current;
    const bottom = bottomRef.current;
    if (!board || !top || !bottom) return;

    let svg: SVGSVGElement | null = null;

    const draw = () => {
      const boardBox = board.getBoundingClientRect();
      const topBox = top.getBoundingClientRect();
      const bottomBox = bottom.getBoundingClientRect();

      const x = (topBox.left + topBox.right) / 2 - boardBox.left;
      const y1 = topBox.bottom - boardBox.top + 10;
      const y2 = bottomBox.top - boardBox.top - 10;
      if (y2 <= y1) {
        svg?.replaceChildren();
        return;
      }

      if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'dia2-vert-svg');
        svg.setAttribute('aria-hidden', 'true');
        board.appendChild(svg);
      }
      svg.innerHTML =
        `<line class="dia2-vert-track" x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>` +
        `<line class="dia2-vert-flow" x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>`;
    };

    draw();
    const timers = [window.setTimeout(draw, 400), window.setTimeout(draw, 900)];
    window.addEventListener('resize', draw, { passive: true });

    const observer = 'ResizeObserver' in window ? new ResizeObserver(draw) : null;
    observer?.observe(board);

    return () => {
      timers.forEach(window.clearTimeout);
      window.removeEventListener('resize', draw);
      observer?.disconnect();
      svg?.remove();
    };
  }, [boardRef, topRef, bottomRef]);
}

export function PublishFlow() {
  const boardRef = useRef<HTMLDivElement>(null);
  const topCardRef = useRef<HTMLDivElement>(null);
  const bottomCardRef = useRef<HTMLDivElement>(null);

  useVerticalLink(boardRef, topCardRef, bottomCardRef);

  return (
    <section className="diag" id="publicar" style={{ background: 'var(--bg-2)' }}>
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Publique uma vez. <span className="grad-text">Todos os agentes aprendem.</span>
          </h2>
          <p>
            Seu agente orquestrador escreve a skill e salva pelo MCP administrativo. No instante
            seguinte ela está no catálogo, e qualquer agente conectado ao MCP público já a encontra.
          </p>
        </div>

        <div className="dia2-board reveal" ref={boardRef}>
          {/* quadros de fundo: os agentes de um lado, os serviços do outro */}
          <div className="dia2-frame dia2-frame--agents" aria-hidden>
            <span className="dia2-frame-title">
              <PlugIcon />
              Agentes
            </span>
          </div>
          <div className="dia2-frame dia2-frame--services" aria-hidden>
            <span className="dia2-frame-title">
              <ServerIcon />
              Purple Skills
            </span>
          </div>

          {/* ── cria: agente → mcp-admin → SKILL.md ── */}
          <div className="dia2-row dia2-row--create">
            <div className="dia2-cell dia2-cell--left">
              <div className="dia2-creator">
                <span className="diag-agent">
                  <img src="/assets/images/icon-agent-claude-code-64.png" alt="Claude Code" />
                </span>
                <span className="dia2-create-lbl">
                  criando nova skill
                  <br />
                  <em>'como-abrir-chamados'</em>
                </span>
              </div>
            </div>

            <Wire tone="purple" bridge />

            <div className="dia2-cell dia2-cell--mcp">
              <div className="dia2-mcp">
                <span className="dia2-mcp-orb">
                  <img src="/assets/images/icon-mcp-64.png" alt="Servidor MCP administrativo" />
                </span>
                <span className="dia2-mcp-lbl">Admin MCP</span>
              </div>
            </div>

            <Wire tone="purple" />

            <div className="dia2-cell dia2-cell--right">
              <div className="dia2-target">
                <div className="diag-tool t1" ref={topCardRef}>
                  <img src="/assets/images/icon-purple-left-64x92.png" alt="" />
                  <span className="wz">
                    SKILL.md
                    <small>frontmatter + markdown + anexos</small>
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ── consome: agentes ← mcp-public ← catálogo ── */}
          <div className="dia2-row dia2-row--fetch">
            <div className="dia2-cell dia2-cell--left">
              <div className="dia2-agents-grid">
                {AGENTS.map((agent) => (
                  <span className="diag-agent" key={agent.file}>
                    <img src={`/assets/images/${agent.file}`} alt={agent.alt} />
                  </span>
                ))}
              </div>
            </div>

            <Wire tone="gold" bridge />

            <div className="dia2-cell dia2-cell--mcp">
              <div className="dia2-mcp">
                <span className="dia2-mcp-orb">
                  <img src="/assets/images/icon-mcp-64.png" alt="Servidor MCP público" />
                </span>
                <span className="dia2-mcp-lbl">Agents MCP</span>
              </div>
            </div>

            <Wire tone="gold" />

            <div className="dia2-cell dia2-cell--right">
              <div className="dia2-target">
                <div className="diag-tool t2" ref={bottomCardRef}>
                  <span className="ico">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <ellipse cx="12" cy="6" rx="8" ry="3" />
                      <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" strokeLinecap="round" />
                      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span className="wz">
                    catálogo
                    <small>PostgreSQL 18 · busca full-text</small>
                  </span>
                </div>
                <span className="dia2-create-lbl dia2-create-lbl--gold">
                  servindo a skill
                  <br />
                  <em>'como-abrir-chamados'</em>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
