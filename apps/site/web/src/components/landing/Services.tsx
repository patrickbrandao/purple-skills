import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { GlobeIcon, ServerIcon, ShieldIcon } from '../Icons.js';

type Node = {
  id: string;
  label: string;
  sub?: string;
  icon: ReactNode;
  featured?: boolean;
};

const CLIENTS: Node[] = [
  {
    id: 'browser',
    label: 'Navegador',
    sub: 'quem procura uma skill',
    icon: <GlobeIcon />,
  },
  {
    id: 'voce',
    label: 'Você',
    sub: 'quem cuida do catálogo',
    icon: <img src="/assets/images/purple-hat-256.png" alt="" />,
  },
  {
    id: 'claude',
    label: 'Claude Code',
    sub: 'consome skills',
    icon: <img src="/assets/images/icon-agent-claude-code-64.png" alt="Claude Code" />,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    sub: 'consome skills',
    icon: <img src="/assets/images/icon-agent-opencode-64.png" alt="OpenCode" />,
  },
  {
    id: 'codex',
    label: 'Codex',
    sub: 'escreve skills novas',
    icon: <img src="/assets/images/icon-agent-codex-64.png" alt="Codex" />,
  },
];

const SERVICES: Node[] = [
  { id: 'site', label: 'site', sub: ':3000 — público', icon: <GlobeIcon /> },
  { id: 'admin', label: 'admin', sub: ':3001 — com senha', icon: <ShieldIcon />, featured: true },
  {
    id: 'mcp-public',
    label: 'mcp-public',
    sub: ':3002 — /mcp',
    icon: <img src="/assets/images/icon-mcp-64.png" alt="Servidor MCP" />,
  },
  {
    id: 'mcp-admin',
    label: 'mcp-admin',
    sub: ':3003 — /mcp',
    icon: <img src="/assets/images/icon-mcp-64.png" alt="Servidor MCP" />,
  },
  { id: 'db', label: 'PostgreSQL 18', sub: 'pgvector · tsvector', icon: <ServerIcon /> },
];

const LINKS: [string, string, string][] = [
  ['browser', 'site', ''],
  ['voce', 'admin', 'f-gold'],
  ['claude', 'mcp-public', ''],
  ['opencode', 'mcp-public', ''],
  ['codex', 'mcp-admin', 'f-ember'],
];

const NS = 'http://www.w3.org/2000/svg';

function useServiceWires(
  stageRef: RefObject<HTMLDivElement | null>,
  svgRef: RefObject<SVGSVGElement | null>,
) {
  useEffect(() => {
    const stage = stageRef.current;
    const svg = svgRef.current;
    if (!stage || !svg) return;

    const center = (el: Element, box: DOMRect) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top };
    };

    const draw = () => {
      if (window.matchMedia('(max-width: 820px)').matches) {
        svg.innerHTML = '';
        return;
      }

      const box = stage.getBoundingClientRect();
      if (!box.width) return;

      const fragment = document.createDocumentFragment();
      const flows: SVGPathElement[] = [];

      LINKS.forEach(([from, to, tone]) => {
        const a = stage.querySelector(`.clients [data-node="${from}"] .svc-orb`);
        const b = stage.querySelector(`.servers [data-node="${to}"] .svc-orb`);
        if (!a || !b) return;

        const p1 = center(a, box);
        const p2 = center(b, box);
        const midX = p1.x + (p2.x - p1.x) * 0.5;
        const d = `M ${p1.x} ${p1.y} C ${midX} ${p1.y}, ${midX} ${p2.y}, ${p2.x} ${p2.y}`;

        const wire = document.createElementNS(NS, 'path');
        wire.setAttribute('class', 'wire');
        wire.setAttribute('d', d);
        fragment.appendChild(wire);

        const flow = document.createElementNS(NS, 'path');
        flow.setAttribute('class', `flow ${tone}`.trim());
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
  }, [stageRef, svgRef]);
}

function NodeList({ nodes }: { nodes: Node[] }) {
  return (
    <div className="svc-list">
      {nodes.map((node) => (
        <div
          key={node.id}
          className={`svc-item${node.featured ? ' featured' : ''}`}
          data-node={node.id}
        >
          <span className="svc-orb">{node.icon}</span>
          <span className="svc-lbl">
            <span className="svc-type">{node.label}</span>
            {node.sub && <span className="svc-url">{node.sub}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Services() {
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useServiceWires(stageRef, svgRef);

  return (
    <section className="diag" id="servicos">
      <div className="wrap">
        <div className="head center reveal">
          <h2 className="display">
            Quatro serviços, <span className="grad-text">um só catálogo.</span>
          </h2>
          <p>
            Cada superfície é um container com a sua própria imagem, falando direto com o Postgres —
            não existe uma API intermediária para cair. Suba tudo com um{' '}
            <code className="mono">docker compose up</code>, ou só o que você usa.
          </p>
        </div>

        <div className="svc-stage reveal" ref={stageRef}>
          <svg className="svc-wires" ref={svgRef} aria-hidden preserveAspectRatio="none" />

          <div className="svc-box clients">
            <span className="svc-box-title">
              <GlobeIcon />
              Quem consome
            </span>
            <NodeList nodes={CLIENTS} />
          </div>

          <div className="svc-box servers">
            <span className="svc-box-title">
              <ServerIcon />
              Purple Skills
            </span>
            <NodeList nodes={SERVICES} />
          </div>
        </div>
      </div>
    </section>
  );
}
