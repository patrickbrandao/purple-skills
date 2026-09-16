import { useMemo } from 'react';
import type { VirtualMcpSummary } from '../api.js';

/* ============================================================
   A COLMEIA DO CARD DE SERVIDOR
   Cada skill com vínculo direto é um hexágono teal; cada catálogo
   vinculado, um hexágono roxo. Sem ícone nem texto: a cor diz o
   tipo, o tooltip diz o nome. A colmeia tem 19 células (1 + 6 +
   12, preenchidas em espiral do centro para fora); passando disso,
   a última vira um hexágono neutro "+N" com o que não coube.
   ============================================================ */

/** Células da colmeia: o centro, o anel de 6 e o anel de 12. */
export const HONEYCOMB_CELLS = 19;

/** Raio do hexágono (centro ao vértice), em unidades do viewBox. */
const R = 14;
/** Folga entre células: o hexágono é desenhado um pouco menor que a célula. */
const INSET = 0.86;

type Cell =
  | { kind: 'skill'; slug: string; name: string }
  | { kind: 'catalog'; slug: string; name: string; isActive: boolean }
  | { kind: 'more'; count: number };

/** Os seis vizinhos de uma célula, em coordenadas axiais (q, r). */
const DIRECTIONS: [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** As 19 posições em espiral: o centro, depois cada anel a partir do canto inferior esquerdo. */
function spiral(rings: number): [number, number][] {
  const cells: [number, number][] = [[0, 0]];
  for (let k = 1; k <= rings; k += 1) {
    let q = -k;
    let r = k;
    for (const [dq, dr] of DIRECTIONS) {
      for (let step = 0; step < k; step += 1) {
        cells.push([q, r]);
        q += dq;
        r += dr;
      }
    }
  }
  return cells;
}

const POSITIONS = spiral(2);

/** Centro de uma célula axial, num hexágono de topo pontudo. */
const centerOf = ([q, r]: [number, number]) => ({
  x: R * Math.sqrt(3) * (q + r / 2),
  y: R * 1.5 * r,
});

/** O caminho de um hexágono de topo pontudo centrado na origem. */
function hexPath(radius: number): string {
  const points: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    points.push(`${(radius * Math.cos(angle)).toFixed(2)},${(radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join('L')}Z`;
}

const HEX = hexPath(R * INSET);

/** A caixa que envolve as 19 células, com margem de meio hexágono. */
const BOUNDS = (() => {
  const centers = POSITIONS.map(centerOf);
  const minX = Math.min(...centers.map((c) => c.x)) - R;
  const maxX = Math.max(...centers.map((c) => c.x)) + R;
  const minY = Math.min(...centers.map((c) => c.y)) - R;
  const maxY = Math.max(...centers.map((c) => c.y)) + R;
  return { minX, minY, width: maxX - minX, height: maxY - minY };
})();

/**
 * Monta as células a partir do resumo do servidor: catálogos primeiro (são
 * poucos e são o que agrupa), depois as skills diretas, por nome — a ordem
 * em que o banco já devolve as duas listas. `skillCount` e `catalogCount`
 * contam tudo, então o "+N" sabe quanto ficou de fora mesmo quando as
 * listas do resumo vieram truncadas.
 */
export function honeycombCells(mcp: Pick<VirtualMcpSummary, 'preview' | 'previewCatalogs' | 'skillCount' | 'catalogCount'>): Cell[] {
  const items: Cell[] = [
    ...mcp.previewCatalogs.map((catalog) => ({ kind: 'catalog' as const, ...catalog })),
    ...mcp.preview.map((skill) => ({ kind: 'skill' as const, slug: skill.slug, name: skill.name })),
  ];
  const total = mcp.skillCount + mcp.catalogCount;
  if (total <= HONEYCOMB_CELLS) return items.slice(0, HONEYCOMB_CELLS);
  const shown = items.slice(0, HONEYCOMB_CELLS - 1);
  return [...shown, { kind: 'more', count: total - shown.length }];
}

export function Honeycomb({ mcp, className = '' }: { mcp: Pick<VirtualMcpSummary, 'preview' | 'previewCatalogs' | 'skillCount' | 'catalogCount'>; className?: string }) {
  const cells = useMemo(() => honeycombCells(mcp), [mcp]);

  return (
    <svg
      className={`honeycomb ${className}`.trim()}
      viewBox={`${BOUNDS.minX} ${BOUNDS.minY} ${BOUNDS.width} ${BOUNDS.height}`}
      role="img"
      aria-label={`${mcp.skillCount} skill(s) e ${mcp.catalogCount} catálogo(s)`}
    >
      {cells.map((cell, index) => {
        const { x, y } = centerOf(POSITIONS[index]!);
        const title =
          cell.kind === 'more'
            ? `mais ${cell.count}`
            : cell.kind === 'catalog'
              ? `catálogo: ${cell.name}${cell.isActive ? '' : ' (desligado)'}`
              : `skill: ${cell.name}`;
        const key = cell.kind === 'more' ? 'more' : `${cell.kind}:${cell.slug}`;
        return (
          <g key={key} className={`cell ${cell.kind}${cell.kind === 'catalog' && !cell.isActive ? ' off' : ''}`} transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`}>
            <title>{title}</title>
            <path d={HEX} />
            {cell.kind === 'more' && (
              <text textAnchor="middle" dominantBaseline="central">
                +{cell.count}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
