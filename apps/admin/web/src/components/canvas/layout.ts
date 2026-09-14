import type { CanvasPoint, VirtualMcpDetail } from '../../api.js';
import { catalogNodeId, skillNodeId } from './types.js';

/**
 * Geometria do palco, em múltiplos de 24 (a grade do `snapGrid`): o servidor
 * fica na origem, o globo à esquerda e as skills e os catálogos numa coluna à
 * direita.
 */
export const GRID = 24;
export const SERVER_WIDTH = 288;
export const SKILL_COLUMN_X = SERVER_WIDTH + 120;
export const SKILL_STEP_Y = 96;
export const DEFAULT_SERVER: CanvasPoint = { x: 0, y: 0 };
export const DEFAULT_INTERNET: CanvasPoint = { x: -336, y: 48 };

export const snap = (value: number) => Math.round(value / GRID) * GRID;

type Placeable = { id: string; position: CanvasPoint | null };

/** Os nós posicionáveis do detalhe, por id: catálogos primeiro, skills depois. */
function placeables(detail: Pick<VirtualMcpDetail, 'skills' | 'catalogs'>): Placeable[] {
  return [
    ...detail.catalogs.map((catalog) => ({ id: catalogNodeId(catalog.slug), position: catalog.position })),
    ...detail.skills.map((skill) => ({ id: skillNodeId(skill.slug), position: skill.position })),
  ];
}

const collides = (a: CanvasPoint, b: CanvasPoint) => Math.abs(a.x - b.x) < 240 && Math.abs(a.y - b.y) < SKILL_STEP_Y - 8;

/**
 * Posições dos nós de skill e de catálogo, por id de nó: quem tem posição
 * salva fica onde está; os demais entram nos primeiros vãos livres da coluna
 * à direita do servidor.
 */
export function placeNodes(
  detail: Pick<VirtualMcpDetail, 'skills' | 'catalogs' | 'layout'>,
  known: ReadonlyMap<string, CanvasPoint> = new Map(),
): Map<string, CanvasPoint> {
  const server = detail.layout.server ?? DEFAULT_SERVER;
  const result = new Map<string, CanvasPoint>();
  const occupied: CanvasPoint[] = [];
  const items = placeables(detail);

  for (const item of items) {
    const position = known.get(item.id) ?? item.position;
    if (position) {
      result.set(item.id, position);
      occupied.push(position);
    }
  }

  let slot = 0;
  for (const item of items) {
    if (result.has(item.id)) continue;
    let candidate: CanvasPoint;
    do {
      candidate = { x: server.x + SKILL_COLUMN_X, y: server.y + slot * SKILL_STEP_Y };
      slot += 1;
    } while (occupied.some((point) => collides(point, candidate)));
    result.set(item.id, candidate);
    occupied.push(candidate);
  }

  return result;
}

/** Recalcula tudo do zero: servidor na origem, globo à esquerda, catálogos e depois skills em coluna por nome. */
export function autoLayout(detail: Pick<VirtualMcpDetail, 'skills' | 'catalogs'>): {
  server: CanvasPoint;
  internet: CanvasPoint;
  positions: Map<string, CanvasPoint>;
} {
  const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
  const ids = [
    ...byName(detail.catalogs).map((catalog) => catalogNodeId(catalog.slug)),
    ...byName(detail.skills).map((skill) => skillNodeId(skill.slug)),
  ];
  const positions = new Map<string, CanvasPoint>();
  ids.forEach((id, index) => {
    positions.set(id, { x: SKILL_COLUMN_X, y: index * SKILL_STEP_Y });
  });
  return { server: DEFAULT_SERVER, internet: DEFAULT_INTERNET, positions };
}

/** Um vão livre para um nó novo: o primeiro slot da coluna sem ninguém. */
export function freeSlot(server: CanvasPoint, taken: Iterable<CanvasPoint>): CanvasPoint {
  const points = [...taken];
  for (let slot = 0; slot < 500; slot += 1) {
    const candidate = { x: server.x + SKILL_COLUMN_X, y: server.y + slot * SKILL_STEP_Y };
    if (!points.some((point) => collides(point, candidate))) {
      return candidate;
    }
  }
  return { x: server.x + SKILL_COLUMN_X, y: server.y };
}
