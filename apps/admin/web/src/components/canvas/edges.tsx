import { memo, useMemo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { PORT_LABEL, type PortEdge, type TrafficEdge } from './types.js';

/*
 * Duas arestas, uma por relação. A de porta é estática e colorida pela porta;
 * a de tráfego (Internet → servidor) é a única viva: brilho, partículas e o
 * contador de clientes online no meio.
 */

function PortEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected }: EdgeProps<PortEdge>) {
  // Bézier, a mesma curva da linha de conexão em andamento.
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={16} />
      <EdgeLabelRenderer>
        <div
          className={`edge-label port nodrag nopan${selected ? ' show' : ''}`}
          style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, opacity: selected ? 1 : undefined }}
        >
          <span>{data ? PORT_LABEL[data.port] : ''}</span>
          {data && !data.saving && (
            <button
              type="button"
              className="x"
              title="Desligar esta porta"
              onClick={(event) => {
                event.stopPropagation();
                window.dispatchEvent(new CustomEvent('canvas:remove-edge', { detail: { id } }));
              }}
            >
              <X />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const PARTICLE_MAX = 8;

function TrafficEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<TrafficEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 });
  const online = data?.online ?? 0;
  const live = online > 0;

  // Partículas: uma por cliente até o teto, com atraso aleatório — sem ele
  // marcham em bloco e viram um tracejado. Desligadas em prefers-reduced-motion.
  const particles = useMemo(() => {
    const count = Math.min(PARTICLE_MAX, Math.max(0, online));
    const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return [];
    return Array.from({ length: count }, (_, index) => ({
      key: index,
      delay: -(Math.random() * 4).toFixed(2),
      duration: (3.6 + Math.random() * 1.2).toFixed(2),
    }));
  }, [online]);

  return (
    <>
      {live && (
        <g className="edge-traffic-glow" aria-hidden>
          <path d={path} className="glow" />
        </g>
      )}
      <BaseEdge id={id} path={path} />
      {particles.map((particle) => (
        <circle
          key={particle.key}
          r={2.2}
          className="particle"
          style={{
            offsetPath: `path("${path}")`,
            offsetRotate: '0deg',
            animation: `flow-in ${particle.duration}s linear ${particle.delay}s infinite`,
          }}
        />
      ))}
      <EdgeLabelRenderer>
        <button
          type="button"
          className={`edge-label nodrag nopan${live ? ' live' : ''}`}
          style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title="Clientes conectados agora — clique para ver as sessões"
          onClick={() => window.dispatchEvent(new CustomEvent('canvas:open-sessions'))}
        >
          <span className="dot" />
          <span className="n">{online}</span> {online === 1 ? 'sessão online' : 'sessões online'}
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const PortEdgeView = memo(PortEdgeImpl);
export const TrafficEdgeView = memo(TrafficEdgeImpl);

export const edgeTypes = {
  port: PortEdgeView,
  traffic: TrafficEdgeView,
};
