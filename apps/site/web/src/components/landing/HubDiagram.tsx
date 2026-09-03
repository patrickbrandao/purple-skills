import { useEffect, useRef, type RefObject } from 'react';
import { BoxIcon, DownloadIcon, SearchIcon } from '../Icons.js';

const AGENTS = [
  { file: 'icon-agent-claude-code-64.png', alt: 'Claude Code' },
  { file: 'icon-cursor-64.png', alt: 'Cursor' },
  { file: 'icon-antigravity-64.png', alt: 'Antigravity' },
  { file: 'icon-agent-opencode-64.png', alt: 'OpenCode' },
  { file: 'icon-agent-hermes-64.png', alt: 'Hermes' },
  { file: 'icon-agent-openclaw-64.png', alt: 'OpenClaw' },
];

const TOOLS = [
  {
    cls: 't1',
    name: 'search_skills',
    desc: 'Acha a skill pela tarefa, não pela palavra-chave',
    Icon: SearchIcon,
  },
  {
    cls: 't2',
    name: 'get_skill',
    desc: 'Entrega o SKILL.md e a lista de anexos',
    Icon: BoxIcon,
  },
  {
    cls: 't3',
    name: 'download_skill',
    desc: 'Empacota a skill inteira em um .zip',
    Icon: DownloadIcon,
  },
];

const NS = 'http://www.w3.org/2000/svg';

/**
 * Desenha, em SVG, um fio curvo de cada agente até o hub MCP.
 *
 * As posições vêm do layout real (getBoundingClientRect), então o desenho é
 * refeito a cada resize e depois que fontes e imagens assentam.
 */
function useHubWires(
  stageRef: RefObject<HTMLDivElement | null>,
  svgRef: RefObject<SVGSVGElement | null>,
  hubRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const stage = stageRef.current;
    const svg = svgRef.current;
    const hub = hubRef.current;
    if (!stage || !svg || !hub) return;

    const draw = () => {
      if (window.matchMedia('(max-width: 820px)').matches) {
        svg.innerHTML = '';
        return;
      }

      const stageBox = stage.getBoundingClientRect();
      if (!stageBox.width) return;

      const hubBox = hub.getBoundingClientRect();
      const hx = hubBox.left + hubBox.width / 2 - stageBox.left;
      const hy = hubBox.top + hubBox.height / 2 - stageBox.top;

      const fragment = document.createDocumentFragment();
      const flows: SVGPathElement[] = [];

      stage.querySelectorAll<HTMLElement>('.agents-col .diag-agent').forEach((agent) => {
        const box = agent.getBoundingClientRect();
        const sx = box.left + box.width / 2 - stageBox.left;
        const sy = box.top + box.height / 2 - stageBox.top;
        const midX = sx + (hx - sx) * 0.5;
        const d = `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${hy}, ${hx} ${hy}`;

        const wire = document.createElementNS(NS, 'path');
        wire.setAttribute('class', 'wire');
        wire.setAttribute('d', d);
        fragment.appendChild(wire);

        const flow = document.createElementNS(NS, 'path');
        flow.setAttribute('class', 'flow');
        flow.setAttribute('d', d);
        flows.push(flow);
      });

      flows.forEach((flow) => fragment.appendChild(flow));
      svg.innerHTML = '';
      svg.appendChild(fragment);
    };

    draw();
    const timer = window.setTimeout(draw, 400);
    window.addEventListener('resize', draw, { passive: true });
    document.fonts?.ready.then(draw).catch(() => void 0);

    const observer = 'ResizeObserver' in window ? new ResizeObserver(draw) : null;
    observer?.observe(stage);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', draw);
      observer?.disconnect();
    };
  }, [stageRef, svgRef, hubRef]);
}

export function HubDiagram() {
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const hubRef = useRef<HTMLDivElement>(null);

  useHubWires(stageRef, svgRef, hubRef);

  return (
    <section className="diag" id="como-funciona">
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Um servidor, <span className="grad-text">todo o catálogo.</span>
          </h2>
          <p>
            Seus agentes falam com um único endpoint MCP. De lá eles descobrem skills, leem o
            SKILL.md renderizado, abrem os arquivos auxiliares e baixam o pacote completo.
          </p>
          <p>
            São cinco ferramentas MCP no total — as três principais estão à direita, mais{' '}
            <code className="mono">get_skill_file</code> e <code className="mono">list_tags</code>.
          </p>
        </div>

        <div className="diag-stage reveal" ref={stageRef}>
          <svg className="diag-wires" ref={svgRef} aria-hidden preserveAspectRatio="none" />

          <div className="diag-col agents-col">
            {AGENTS.map((agent) => (
              <span className="diag-agent" key={agent.file}>
                <img src={`/assets/images/${agent.file}`} alt={agent.alt} />
              </span>
            ))}
          </div>

          <div className="diag-link in" aria-hidden />

          <div className="diag-col hub-col">
            <div className="diag-hub" ref={hubRef}>
              <img src="/assets/images/icon-mcp-64.png" alt="Servidor MCP" />
              <span className="hub-lbl">/mcp</span>
            </div>
          </div>

          <div className="diag-link out" aria-hidden>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
              <path className="wire" d="M0 50 C45 50,45 16.67,100 16.67" />
              <path className="wire" d="M0 50 C45 50,45 50,100 50" />
              <path className="wire" d="M0 50 C45 50,45 83.33,100 83.33" />
              <path className="flow" d="M0 50 C45 50,45 16.67,100 16.67" />
              <path className="flow" d="M0 50 C45 50,45 50,100 50" />
              <path className="flow" d="M0 50 C45 50,45 83.33,100 83.33" />
            </svg>
          </div>

          <div className="diag-col">
            {TOOLS.map(({ cls, name, desc, Icon }) => (
              <div className={`diag-tool ${cls}`} key={name}>
                <span className="ico">
                  <Icon />
                </span>
                <span className="wz">
                  {name}
                  <small>{desc}</small>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
