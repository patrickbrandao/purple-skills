import type { CanvasPoint, VirtualMcpDetail } from '../../api.js';

/**
 * Geometria do palco, em múltiplos de 24 (a grade do `snapGrid`): o servidor
 * fica na origem, o globo à esquerda e as skills numa coluna à direita.
 */
export const GRID = 24;
export const SERVER_WIDTH = 288;
export const SKILL_COLUMN_X = SERVER_WIDTH + 120;
export const SKILL_STEP_Y = 96;
export const DEFAULT_SERVER: CanvasPoint = { x: 0, y: 0 };
export const DEFAULT_INTERNET: CanvasPoint = { x: -336, y: 48 };

export const snap = (value: number) => Math.round(value / GRID) * GRID;

/**
 * Posições das skills: quem tem posição salva fica onde está; as demais
 * entram nos primeiros vãos livres da coluna à direita do servidor.
 */
export function placeSkills(
  detail: Pick<VirtualMcpDetail, 'skills' | 'layout'>,
  known: ReadonlyMap<string, CanvasPoint> = new Map(),
): Map<string, CanvasPoint> {
  const server = detail.layout.server ?? DEFAULT_SERVER;
  const result = new Map<string, CanvasPoint>();
  const occupied: CanvasPoint[] = [];

  for (const skill of detail.skills) {
    const position = known.get(skill.slug) ?? skill.position;
    if (position) {
      result.set(skill.slug, position);
      occupied.push(position);
    }
  }

  let slot = 0;
  for (const skill of detail.skills) {
    if (result.has(skill.slug)) continue;
    let candidate: CanvasPoint;
    do {
      candidate = { x: server.x + SKILL_COLUMN_X, y: server.y + slot * SKILL_STEP_Y };
      slot += 1;
    } while (occupied.some((point) => Math.abs(point.x - candidate.x) < 240 && Math.abs(point.y - candidate.y) < SKILL_STEP_Y - 8));
    result.set(skill.slug, candidate);
    occupied.push(candidate);
  }

  return result;
}

/** Recalcula tudo do zero: servidor na origem, globo à esquerda, skills em coluna por nome. */
export function autoLayout(detail: Pick<VirtualMcpDetail, 'skills'>): {
  server: CanvasPoint;
  internet: CanvasPoint;
  positions: Map<string, CanvasPoint>;
} {
  const sorted = [...detail.skills].sort((a, b) => a.name.localeCompare(b.name));
  const positions = new Map<string, CanvasPoint>();
  sorted.forEach((skill, index) => {
    positions.set(skill.slug, { x: SKILL_COLUMN_X, y: index * SKILL_STEP_Y });
  });
  return { server: DEFAULT_SERVER, internet: DEFAULT_INTERNET, positions };
}

/** Um vão livre para um nó novo: o primeiro slot da coluna sem ninguém. */
export function freeSlot(server: CanvasPoint, taken: Iterable<CanvasPoint>): CanvasPoint {
  const points = [...taken];
  for (let slot = 0; slot < 500; slot += 1) {
    const candidate = { x: server.x + SKILL_COLUMN_X, y: server.y + slot * SKILL_STEP_Y };
    if (!points.some((point) => Math.abs(point.x - candidate.x) < 240 && Math.abs(point.y - candidate.y) < SKILL_STEP_Y - 8)) {
      return candidate;
    }
  }
  return { x: server.x + SKILL_COLUMN_X, y: server.y };
}
