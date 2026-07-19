// Размеры, палитра и SVG-геометрия соответствуют SCM History Graph из
// VS Code 1.129.1 / Cursor. Источник и MIT-лицензия указаны в
// THIRD_PARTY_NOTICES.md.
export const GRAPH_COLORS = [
  // Обычные swimlane: scmGraph.foreground1..5.
  "#ffb000",
  "#dc267f",
  "#994f00",
  "#40b0a6",
  "#b66dff",
  // Семантические цвета: текущая локальная и её удалённая ветка.
  "#59a4f9",
  "#b180d7",
] as const;

export const GRAPH_PALETTE_SIZE = 5;
export const GRAPH_LOCAL_REF_COLOR = 5;
export const GRAPH_REMOTE_REF_COLOR = 6;

export const GRAPH_LANE_WIDTH = 11;
export const GRAPH_ROW_HEIGHT = 22;
export const GRAPH_CURVE_RADIUS = 5;
export const GRAPH_STROKE_WIDTH = 1;

export const GRAPH_DOT_RADIUS = 5;
export const GRAPH_NODE_STROKE_WIDTH = 2;
export const GRAPH_MERGE_OUTER_RADIUS = 6;
export const GRAPH_MERGE_INNER_RADIUS = 3;
export const GRAPH_HEAD_OUTER_RADIUS = 7;
export const GRAPH_HEAD_INNER_RADIUS = 2;
export const GRAPH_HEAD_INNER_STROKE_WIDTH = 4;

export function graphLaneCenter(col: number): number {
  // У VS Code первая lane находится на x=11, а не на половине ширины.
  return GRAPH_LANE_WIDTH * (col + 1);
}

// Вертикальная либо S-образная сквозная дорожка. Сдвиг возникает лишь когда
// несколько одинаковых target hash схлопываются на строке общего commit.
export function graphThroughPath(fromCol: number, toCol: number): string {
  const fromX = graphLaneCenter(fromCol);
  const toX = graphLaneCenter(toCol);
  if (fromX === toX) {
    return `M ${fromX} 0 V ${GRAPH_ROW_HEIGHT}`;
  }

  const middleY = GRAPH_ROW_HEIGHT / 2;
  const upperY = middleY - GRAPH_CURVE_RADIUS;
  const lowerY = middleY + GRAPH_CURVE_RADIUS;
  if (toX < fromX) {
    return [
      `M ${fromX} 0`,
      `V ${upperY}`,
      `A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 1 ${fromX - GRAPH_CURVE_RADIUS} ${middleY}`,
      `H ${toX + GRAPH_CURVE_RADIUS}`,
      `A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 0 ${toX} ${lowerY}`,
      `V ${GRAPH_ROW_HEIGHT}`,
    ].join(" ");
  }

  // Зеркальный вариант нужен для устойчивости на разорванных/частично
  // загруженных историях; штатный VS Code layout обычно сдвигает только влево.
  return [
    `M ${fromX} 0`,
    `V ${upperY}`,
    `A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 0 ${fromX + GRAPH_CURVE_RADIUS} ${middleY}`,
    `H ${toX - GRAPH_CURVE_RADIUS}`,
    `A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 1 ${toX} ${lowerY}`,
    `V ${GRAPH_ROW_HEIGHT}`,
  ].join(" ");
}

// Вход input swimlane в точку commit. Первое вхождение вертикальное, прочие
// одинаковые lanes приходят справа большой четверть-дугой.
export function graphIncomingPath(fromCol: number, nodeCol: number): string {
  const fromX = graphLaneCenter(fromCol);
  const nodeX = graphLaneCenter(nodeCol);
  const middleY = GRAPH_ROW_HEIGHT / 2;
  if (fromX === nodeX) {
    return `M ${fromX} 0 V ${middleY}`;
  }

  const direction = Math.sign(nodeX - fromX);
  const arcEndX = fromX + direction * GRAPH_LANE_WIDTH;
  const sweep = direction < 0 ? 1 : 0;
  return [
    `M ${fromX} 0`,
    `A ${GRAPH_LANE_WIDTH} ${GRAPH_LANE_WIDTH} 0 0 ${sweep} ${arcEndX} ${middleY}`,
    `H ${nodeX}`,
  ].join(" ");
}

// Первый parent продолжает lane вертикально; дополнительные родители
// добавлены справа и входят в них дугой радиуса одной lane.
export function graphParentPath(
  nodeCol: number,
  parentCol: number,
  parentIndex: number,
): string {
  const nodeX = graphLaneCenter(nodeCol);
  const parentX = graphLaneCenter(parentCol);
  const middleY = GRAPH_ROW_HEIGHT / 2;
  if (parentIndex === 0 || parentX === nodeX) {
    return `M ${nodeX} ${middleY} V ${GRAPH_ROW_HEIGHT}`;
  }

  const direction = Math.sign(parentX - nodeX);
  const arcStartX = parentX - direction * GRAPH_LANE_WIDTH;
  const sweep = direction > 0 ? 1 : 0;
  return [
    `M ${arcStartX} ${middleY}`,
    `A ${GRAPH_LANE_WIDTH} ${GRAPH_LANE_WIDTH} 0 0 ${sweep} ${parentX} ${GRAPH_ROW_HEIGHT}`,
    `M ${arcStartX} ${middleY}`,
    `H ${nodeX}`,
  ].join(" ");
}
