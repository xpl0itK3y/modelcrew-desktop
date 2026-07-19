import { describe, expect, it } from "vitest";
import { computeCommitGraph } from "./commitGraph";

// Узел каждой строки — где стоит точка коммита.
const cols = (commits: { hash: string; parents: string[] }[]) =>
  computeCommitGraph(commits).map((row) => row.col);

describe("computeCommitGraph", () => {
  it("keeps a linear history in one column", () => {
    const rows = computeCommitGraph([
      { hash: "C", parents: ["B"] },
      { hash: "B", parents: ["A"] },
      { hash: "A", parents: [] },
    ]);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.width)).toEqual([1, 1, 1]);
    // Средний коммит соединён линией сверху и снизу в своей колонке.
    expect(rows[1].top).toEqual([{ fromCol: 0, toCol: 0, color: 0 }]);
    expect(rows[1].bottom).toEqual([{ fromCol: 0, toCol: 0, color: 0 }]);
    // Корневой коммит: линия сверху есть, снизу нет.
    expect(rows[2].bottom).toEqual([]);
    // Вершина: линия снизу есть, сверху нет.
    expect(rows[0].top).toEqual([]);
  });

  it("lays out a feature branch and its merge", () => {
    // M сливает main(C) и feature(F); обе ветки расходятся из B.
    const commits = [
      { hash: "M", parents: ["C", "F"] },
      { hash: "C", parents: ["B"] },
      { hash: "F", parents: ["B"] },
      { hash: "B", parents: ["A"] },
      { hash: "A", parents: [] },
    ];
    expect(cols(commits)).toEqual([0, 0, 1, 0, 0]);

    const rows = computeCommitGraph(commits);
    // Слияние M: две линии вниз — основная (col0) и ветка (col1).
    expect(rows[0].bottom).toEqual([
      { fromCol: 0, toCol: 0, color: 0 },
      { fromCol: 0, toCol: 1, color: 1 },
    ]);
    // Feature F (col1): его родитель B уже в col0, поэтому линия узла уходит
    // влево в col0, а сама дорожка B (col0) при этом проходит насквозь.
    expect(rows[2].bottom).toEqual(
      expect.arrayContaining([
        { fromCol: 0, toCol: 0, color: 0 },
        { fromCol: 1, toCol: 0, color: 0 },
      ]),
    );
    // Пока F не слился (строка C), его дорожка проходит через col1.
    expect(rows[1].bottom).toEqual(
      expect.arrayContaining([{ fromCol: 1, toCol: 1, color: 1 }]),
    );
  });

  it("opens a lane per parent of an octopus merge", () => {
    const rows = computeCommitGraph([
      { hash: "X", parents: ["A", "B", "C"] },
      { hash: "A", parents: [] },
      { hash: "B", parents: [] },
      { hash: "C", parents: [] },
    ]);
    expect(rows[0].col).toEqual(0);
    expect(rows[0].bottom).toEqual([
      { fromCol: 0, toCol: 0, color: 0 },
      { fromCol: 0, toCol: 1, color: 1 },
      { fromCol: 0, toCol: 2, color: 2 },
    ]);
    // Три параллельные дорожки — три колонки.
    expect(rows.every((row) => row.width === 3)).toBe(true);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 1, 2]);
  });

  it("places unrelated branch tips in separate lanes", () => {
    const rows = computeCommitGraph([
      { hash: "A", parents: ["P"] },
      { hash: "B", parents: ["Q"] },
      { hash: "P", parents: [] },
      { hash: "Q", parents: [] },
    ]);
    // A и B не связаны — разные колонки; P под A, Q под B.
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 1]);
  });

  it("returns an empty layout for no commits", () => {
    expect(computeCommitGraph([])).toEqual([]);
  });

  // Точка ветвления (разъединение): B — общий родитель C и F, слияния нет
  // (как в режиме «все ветки»). Обе дорожки сходятся в узел B.
  it("draws a fork point where two branches share a parent", () => {
    const commits = [
      { hash: "C", parents: ["B"] },
      { hash: "F", parents: ["B"] },
      { hash: "B", parents: ["A"] },
      { hash: "A", parents: [] },
    ];
    const rows = assertLanesConnect(commits);
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 0]);
    // C держит дорожку общего родителя (col0), поэтому вторая ветка F (col1)
    // сходится к ней уже на своей строке: линия её узла уходит вниз-влево в
    // col0, а к узлу B остаётся одна дорожка.
    expect(rows[1].bottom).toEqual(
      expect.arrayContaining([{ fromCol: 1, toCol: 0, color: 0 }]),
    );
    expect(rows[2].top).toEqual([{ fromCol: 0, toCol: 0, color: 0 }]);
  });

  // Слияние во «уже существующую» дорожку: второй родитель M — это G, чья
  // дорожка уже открыта (её ждёт H). Линия узла присоединяется к ней, новой
  // колонки не создаётся.
  it("merges into a lane that is already open", () => {
    const commits = [
      { hash: "H", parents: ["G"] }, // держит дорожку G открытой (col1)
      { hash: "M", parents: ["P", "G"] }, // сливает P и уже открытый G
      { hash: "P", parents: ["G"] },
      { hash: "G", parents: [] },
    ];
    const rows = assertLanesConnect(commits);
    // M на col0; его связь со вторым родителем G идёт в уже занятую колонку H.
    const gCol = rows[0].col; // H в col0? нет — H первый → col0
    expect(gCol).toBe(0);
    // У M два родителя → две связи узла вниз, обе на существующие дорожки.
    const mBottomNode = rows[1].bottom.filter((e) => e.fromCol === rows[1].col);
    expect(mBottomNode).toHaveLength(2);
    // Ширина не раздувается сверх двух дорожек.
    expect(rows.every((r) => r.width <= 2)).toBe(true);
  });

  // Освободившуюся после слияния дорожку переиспользует более старая ветка.
  it("reuses a lane freed by a merged branch", () => {
    const commits = [
      { hash: "M", parents: ["C", "F"] }, // слияние: занят col1 под F
      { hash: "C", parents: ["B"] },
      { hash: "F", parents: ["B"] }, // F вливается в B → col1 освобождается
      { hash: "B", parents: ["A", "G"] }, // B — merge, второй родитель G займёт col1
      { hash: "A", parents: ["R"] },
      { hash: "G", parents: ["R"] },
      { hash: "R", parents: [] },
    ];
    const rows = assertLanesConnect(commits);
    // Граф не расползается: максимум две дорожки одновременно.
    expect(Math.max(...rows.map((r) => r.width))).toBe(2);
  });

  // Перекрёстные слияния: две ветки сливаются друг в друга «крест-накрест».
  it("keeps lanes connected through criss-cross merges", () => {
    const commits = [
      { hash: "M1", parents: ["A1", "B1"] },
      { hash: "M2", parents: ["B1", "A1"] },
      { hash: "A1", parents: ["A0"] },
      { hash: "B1", parents: ["B0"] },
      { hash: "A0", parents: ["R"] },
      { hash: "B0", parents: ["R"] },
      { hash: "R", parents: [] },
    ];
    assertLanesConnect(commits);
  });

  // Обрыв истории: родители самых старых загруженных коммитов не подгружены.
  it("survives commits whose parents are not loaded", () => {
    const commits = [
      { hash: "C", parents: ["B"] },
      { hash: "D", parents: ["E"] }, // E не загружен
      { hash: "B", parents: ["X"] }, // X не загружен
    ];
    const rows = assertLanesConnect(commits);
    // Дорожки к неподгруженным родителям остаются открытыми (уходят «вниз»).
    expect(rows.length).toBe(3);
  });

  // Фаззинг: случайные валидные DAG (родитель всегда старше = ниже в списке).
  // Проверяем только инвариант связности — он ловит любой разрыв линий.
  it("keeps lanes connected for random DAG histories", () => {
    let seed = 1234567;
    const rand = () => {
      // Детерминированный ГПСЧ (mulberry32) — падение воспроизводимо.
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let trial = 0; trial < 300; trial += 1) {
      const n = 3 + Math.floor(rand() * 40);
      const commits: { hash: string; parents: string[] }[] = [];
      for (let i = 0; i < n; i += 1) {
        const parents: string[] = [];
        // 0..3 родителей, каждый — строго более старый коммит (индекс больше).
        const older = n - i - 1;
        if (older > 0) {
          const count = Math.min(older, 1 + Math.floor(rand() * rand() * 3));
          const picks = new Set<number>();
          while (picks.size < count) {
            picks.add(i + 1 + Math.floor(rand() * older));
          }
          for (const p of picks) {
            parents.push(`c${p}`);
          }
        }
        commits.push({ hash: `c${i}`, parents });
      }
      assertLanesConnect(commits);
    }
  });
});

// Инвариант корректного графа: между любыми соседними строками множество
// дорожек, выходящих снизу (bottom.toCol), совпадает с входящими сверху в
// следующую (top.fromCol) — иначе линия ветки рвётся. Плюс узлы и все рёбра
// лежат в пределах ширины. Возвращает строки для дополнительных проверок.
function assertLanesConnect(commits: { hash: string; parents: string[] }[]) {
  const rows = computeCommitGraph(commits);
  const uniqSorted = (values: number[]) =>
    [...new Set(values)].sort((a, b) => a - b);
  for (let i = 0; i < rows.length - 1; i += 1) {
    const exiting = uniqSorted(rows[i].bottom.map((edge) => edge.toCol));
    const entering = uniqSorted(rows[i + 1].top.map((edge) => edge.fromCol));
    expect({ row: i, entering }).toEqual({ row: i, entering: exiting });
  }
  for (const row of rows) {
    expect(row.col).toBeGreaterThanOrEqual(0);
    expect(row.col).toBeLessThan(row.width);
    for (const edge of [...row.top, ...row.bottom]) {
      expect(edge.fromCol).toBeGreaterThanOrEqual(0);
      expect(edge.fromCol).toBeLessThan(row.width);
      expect(edge.toCol).toBeGreaterThanOrEqual(0);
      expect(edge.toCol).toBeLessThan(row.width);
    }
  }
  return rows;
}
