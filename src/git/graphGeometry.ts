// Геометрия графа вынесена из React-компонента: так SVG-пути можно проверять
// отдельно от тяжёлой панели истории.
export const GRAPH_COLORS = [
  "#b180e5",
  "#f0a900",
  "#e52b7a",
  "#c56a00",
  "#43b8ae",
  "#3794ff",
  "#4fbd72",
] as const;

export const GRAPH_LANE_WIDTH = 11;
export const GRAPH_ROW_HEIGHT = 22;
export const GRAPH_DOT_RADIUS = 3.8;
export const GRAPH_RING_RADIUS = 4.8;
export const GRAPH_STROKE_WIDTH = 1.25;
export const GRAPH_RING_STROKE_WIDTH = 1.45;

export type GraphEdgeHalf = "top" | "bottom";

// Cursor-подобный переход: один ортогональный поворот со скруглением.
// Верхняя половина сначала идёт по дорожке вертикально и входит в узел
// горизонтально; нижняя — выходит из узла горизонтально и затем идёт вниз.
export function graphEdgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  half: GraphEdgeHalf,
): string {
  if (x1 === x2) {
    return `M${x1} ${y1}V${y2}`;
  }

  const horizontalDirection = Math.sign(x2 - x1);
  const verticalDirection = Math.sign(y2 - y1) || 1;
  const radius = Math.min(5, Math.abs(x2 - x1), Math.abs(y2 - y1));

  if (half === "top") {
    const turnY = y2 - verticalDirection * radius;
    const turnEndX = x1 + horizontalDirection * radius;
    return `M${x1} ${y1}V${turnY}Q${x1} ${y2} ${turnEndX} ${y2}H${x2}`;
  }

  const turnX = x2 - horizontalDirection * radius;
  const turnEndY = y1 + verticalDirection * radius;
  return `M${x1} ${y1}H${turnX}Q${x2} ${y1} ${x2} ${turnEndY}V${y2}`;
}
