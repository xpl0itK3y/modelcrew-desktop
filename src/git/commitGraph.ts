// Раскладка графа коммитов (дорожки/ветвления/слияния) как в Cursor.
// Чистая функция без DOM: по списку коммитов с их родителями строит для
// каждой строки колонку узла, цвет и рёбра в верхней и нижней половине
// строки — их и рисует SVG-жёлоб рядом с историей.

import { GRAPH_COLORS } from "./graphGeometry";

export type GraphEdge = {
  fromCol: number;
  toCol: number;
  color: number;
  // Сквозная дорожка либо связь с точкой текущего коммита.
  kind: "through" | "commit";
  // Для связей с точкой — hash коммита на соответствующем конце.
  targetHash?: string;
};

export type GraphLane = {
  col: number;
  color: number;
};

export type GraphRow = {
  // Колонка точки коммита и её цвет (индекс в палитре).
  col: number;
  color: number;
  // Локальная ширина строки. Cursor не резервирует место под самый широкий
  // участок всей истории: текст следует сразу за видимыми дорожками.
  width: number;
  // Рёбра верхней половины (из строки выше в узел/сквозные) и нижней
  // (из узла к родителям/сквозные).
  top: GraphEdge[];
  bottom: GraphEdge[];
  // Состояние дорожек на нижней границе строки. Нужно, в частности, чтобы
  // продолжать их через раскрытую карточку деталей.
  lanesBelow: GraphLane[];
};

export type GraphInput = {
  hash: string;
  parents: string[];
};

type Lane = {
  id: number;
  targetHash: string;
  color: number;
};

export function computeCommitGraph(commits: GraphInput[]): GraphRow[] {
  // Вход обязан быть обратным топологическим порядком: каждый загруженный
  // потомок расположен выше любого своего загруженного родителя. Backend
  // гарантирует это через `git log --topo-order`; без этого уже показанный
  // родитель нельзя честно соединить с появившимся ниже потомком.
  // lanes[col] — плотный фронтир дорожек. Объект сохраняет идентичность при
  // сдвиге колонки, поэтому такой сдвиг всегда получает явное SVG-ребро.
  let lanes: Lane[] = [];
  let nextLaneId = 0;
  let nextColor = 0;
  const allocColor = (active: readonly Lane[], reserved: number[] = []) => {
    const activeColors = new Set(active.map((lane) => lane.color));
    for (const color of reserved) {
      activeColors.add(color);
    }
    for (let offset = 0; offset < GRAPH_COLORS.length; offset += 1) {
      const candidate = (nextColor + offset) % GRAPH_COLORS.length;
      if (!activeColors.has(candidate)) {
        nextColor = (candidate + 1) % GRAPH_COLORS.length;
        return candidate;
      }
    }
    // Одновременно открыто больше дорожек, чем цветов в палитре: повтор
    // неизбежен, но продолжаем round-robin, а не залипаем на одном цвете.
    const candidate = nextColor;
    nextColor = (nextColor + 1) % GRAPH_COLORS.length;
    return candidate;
  };

  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes;

    // Колонка узла: первая дорожка, ждущая этот коммит; иначе новая (вершина
    // несвязанной ветки без видимого потомка) справа от активного фронтира.
    const awaitedIndex = before.findIndex(
      (lane) => lane.targetHash === commit.hash,
    );
    const col = awaitedIndex === -1 ? before.length : awaitedIndex;
    const color =
      awaitedIndex === -1 ? allocColor(before) : before[awaitedIndex].color;

    // Верхние рёбра: сквозные дорожки продолжаются в своей колонке,
    // дорожки, ждавшие этот коммит, сходятся в узел.
    // Сквозные линии кладём первыми: цветные входы в узел будут нарисованы
    // поверх них в точках пересечения.
    const top: GraphEdge[] = [
      ...before.flatMap((lane, fromCol) =>
        lane.targetHash === commit.hash
          ? []
          : [
              {
                fromCol,
                toCol: fromCol,
                color: lane.color,
                kind: "through" as const,
              },
            ],
      ),
      ...before.flatMap((lane, fromCol) =>
        lane.targetHash !== commit.hash
          ? []
          : [
              {
                fromCol,
                toCol: col,
                color: lane.color,
                kind: "commit" as const,
                targetHash: commit.hash,
              },
            ],
      ),
    ];

    // Удаление обработанного узла сжимает фронтир. Сохраняем относительный
    // порядок остальных дорожек, чтобы свести число пересечений к минимуму.
    const survivors = before.filter(
      (lane) => lane.targetHash !== commit.hash,
    );
    const after = survivors.slice();
    let insertionIndex = Math.min(col, after.length);

    // Размещаем отсутствующих родителей рядом с колонкой узла. Уже открытые
    // дорожки переиспользуем: несколько потомков честно сходятся в одну точку.
    const parentEdges: {
      lane: Lane;
      color: number;
      targetHash: string;
    }[] = [];
    commit.parents.forEach((parent, index) => {
      let lane = after.find((candidate) => candidate.targetHash === parent);
      if (!lane) {
        lane = {
          id: nextLaneId,
          targetHash: parent,
          color: index === 0 ? color : allocColor(after, [color]),
        };
        nextLaneId += 1;
        after.splice(insertionIndex, 0, lane);
        insertionIndex += 1;
      }
      // Первый родитель продолжает цвет самого узла до точки присоединения к
      // уже открытой дорожке. Дополнительные merge-родители используют цвет
      // своих дорожек, чтобы ветви слияния различались сразу от узла.
      parentEdges.push({
        lane,
        color: index === 0 ? color : lane.color,
        targetHash: parent,
      });
    });

    // Нижние рёбра: сначала все сквозные переходы (включая сдвиги при
    // уплотнении), затем связи узла с его родителями.
    const beforeIndex = new Map(before.map((lane, index) => [lane.id, index]));
    const afterIndex = new Map(after.map((lane, index) => [lane.id, index]));
    const bottom: GraphEdge[] = survivors.map((lane) => ({
      fromCol: beforeIndex.get(lane.id)!,
      toCol: afterIndex.get(lane.id)!,
      color: lane.color,
      kind: "through",
    }));
    for (const edge of parentEdges) {
      bottom.push({
        fromCol: col,
        toCol: afterIndex.get(edge.lane.id)!,
        color: edge.color,
        kind: "commit",
        targetHash: edge.targetHash,
      });
    }

    lanes = after;
    const usedColumns = [
      col,
      ...top.flatMap((edge) => [edge.fromCol, edge.toCol]),
      ...bottom.flatMap((edge) => [edge.fromCol, edge.toCol]),
    ];
    rows.push({
      col,
      color,
      width: Math.max(...usedColumns) + 1,
      top,
      bottom,
      lanesBelow: after.map((lane, laneCol) => ({
        col: laneCol,
        color: lane.color,
      })),
    });
  }
  return rows;
}
