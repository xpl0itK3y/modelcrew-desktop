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
});
