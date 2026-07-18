// Раскладка графа коммитов (дорожки/ветвления/слияния) как в VS Code.
// Чистая функция без DOM: по списку коммитов с их родителями строит для
// каждой строки колонку узла, цвет и рёбра в верхней и нижней половине
// строки — их и рисует SVG-жёлоб рядом с историей.

export type GraphEdge = {
  fromCol: number;
  toCol: number;
  color: number;
};

export type GraphRow = {
  // Колонка точки коммита и её цвет (индекс в палитре).
  col: number;
  color: number;
  // Сколько колонок занимает граф (одинаково по всем строкам — для align).
  width: number;
  // Рёбра верхней половины (из строки выше в узел/сквозные) и нижней
  // (из узла к родителям/сквозные).
  top: GraphEdge[];
  bottom: GraphEdge[];
};

export type GraphInput = {
  hash: string;
  parents: string[];
};

const COLOR_COUNT = 7;

function firstFreeColumn(lanes: (string | null)[]): number {
  const index = lanes.indexOf(null);
  if (index !== -1) {
    return index;
  }
  lanes.push(null);
  return lanes.length - 1;
}

export function computeCommitGraph(commits: GraphInput[]): GraphRow[] {
  // lanes[col] — хеш коммита, которого «ждёт» дорожка сверху вниз.
  const lanes: (string | null)[] = [];
  const laneColor: number[] = [];
  let nextColor = 0;
  const allocColor = () => nextColor++ % COLOR_COUNT;

  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes.slice();
    const beforeColor = laneColor.slice();

    // Колонка узла: первая дорожка, ждущая этот коммит; иначе новая (вершина
    // ветки без видимого потомка).
    let col = before.findIndex((hash) => hash === commit.hash);
    let color: number;
    if (col === -1) {
      col = firstFreeColumn(lanes);
      color = allocColor();
      laneColor[col] = color;
    } else {
      color = laneColor[col];
    }

    // Верхние рёбра: сквозные дорожки продолжаются в своей колонке,
    // дорожки, ждавшие этот коммит, сходятся в узел.
    const top: GraphEdge[] = [];
    for (let c = 0; c < before.length; c += 1) {
      const hash = before[c];
      if (hash == null) {
        continue;
      }
      if (hash === commit.hash) {
        top.push({ fromCol: c, toCol: col, color: beforeColor[c] });
      } else {
        top.push({ fromCol: c, toCol: c, color: beforeColor[c] });
      }
    }

    // Дорожки, ждавшие этот коммит (в т.ч. узла), освобождаем — их продолжат
    // родители.
    for (let c = 0; c < lanes.length; c += 1) {
      if (lanes[c] === commit.hash) {
        lanes[c] = null;
      }
    }

    // Размещаем родителей, не дублируя уже существующие дорожки.
    const parentCols: number[] = [];
    commit.parents.forEach((parent, index) => {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        // Первый родитель продолжает линию узла в его колонке, если та
        // свободна; иначе (её заняла сходящаяся ветка) — новая колонка.
        if (index === 0 && lanes[col] == null) {
          target = col;
          laneColor[col] = color;
        } else {
          target = firstFreeColumn(lanes);
          laneColor[target] = index === 0 ? color : allocColor();
        }
        lanes[target] = parent;
      }
      parentCols.push(target);
    });

    // Нижние рёбра: сквозные продолжения плюс связи узла с родителями.
    const bottom: GraphEdge[] = [];
    for (let c = 0; c < before.length; c += 1) {
      const hash = before[c];
      // Дорожка проходит насквозь: была до коммита, это не он, и в этой
      // колонке всё ещё та же дорожка.
      if (hash != null && hash !== commit.hash && lanes[c] === hash) {
        bottom.push({ fromCol: c, toCol: c, color: beforeColor[c] });
      }
    }
    for (const target of parentCols) {
      bottom.push({ fromCol: col, toCol: target, color: laneColor[target] });
    }

    rows.push({ col, color, width: lanes.length, top, bottom });
  }

  // Единая ширина по максимуму — колонки не «скачут» между строками.
  const maxWidth = rows.reduce((max, row) => Math.max(max, row.width), 1);
  for (const row of rows) {
    row.width = maxWidth;
  }
  return rows;
}
