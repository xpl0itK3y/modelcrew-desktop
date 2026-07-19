import { describe, expect, it } from "vitest";
import { computeCommitGraph, type GraphInput } from "./commitGraph";
import {
  GRAPH_LOCAL_REF_COLOR,
  GRAPH_REMOTE_REF_COLOR,
} from "./graphGeometry";

// Эти merge-fixtures адаптированы из официальных тестов SCM History Graph
// VS Code 1.129.1. Ссылка и MIT-лицензия находятся в THIRD_PARTY_NOTICES.md.
const below = (rows: ReturnType<typeof computeCommitGraph>, index: number) =>
  rows[index].lanesBelow.map((lane) => `${lane.targetHash}@${lane.color}`);

describe("computeCommitGraph", () => {
  it("keeps a linear history in one swimlane", () => {
    const rows = checked([
      { hash: "a", parents: ["b"] },
      { hash: "b", parents: ["c"] },
      { hash: "c", parents: ["d"] },
      { hash: "d", parents: ["e"] },
      { hash: "e", parents: [] },
    ]);

    expect(rows.map((row) => row.col)).toEqual([0, 0, 0, 0, 0]);
    expect(rows.map((row) => row.width)).toEqual([1, 1, 1, 1, 1]);
    expect(below(rows, 0)).toEqual(["b@0"]);
    expect(below(rows, 1)).toEqual(["c@0"]);
    expect(below(rows, 2)).toEqual(["d@0"]);
    expect(below(rows, 3)).toEqual(["e@0"]);
    expect(below(rows, 4)).toEqual([]);
  });

  it("keeps duplicate parent lanes until the shared commit", () => {
    // * a(b)
    // * b(c,d)
    // | * d(c)
    // |/
    // * c(e)
    const rows = checked([
      { hash: "a", parents: ["b"] },
      { hash: "b", parents: ["c", "d"] },
      { hash: "d", parents: ["c"] },
      { hash: "c", parents: ["e"] },
      { hash: "e", parents: ["f"] },
    ]);

    expect(below(rows, 1)).toEqual(["c@0", "d@1"]);
    // Ключевое поведение Cursor/VS Code: d не присоединяется к уже живой c,
    // а продолжает отдельную c-lane своего цвета.
    expect(below(rows, 2)).toEqual(["c@0", "c@1"]);
    expect(rows[3].lanesAbove.map((lane) => lane.targetHash)).toEqual([
      "c",
      "c",
    ]);
    expect(below(rows, 3)).toEqual(["e@0"]);
    expect(rows[3].top.map((edge) => edge.fromCol)).toEqual([0, 1]);
  });

  it("preserves lane order through a longer topic branch", () => {
    const rows = checked([
      { hash: "a", parents: ["b", "c"] },
      { hash: "c", parents: ["d"] },
      { hash: "b", parents: ["e"] },
      { hash: "e", parents: ["f"] },
      { hash: "f", parents: ["d"] },
      { hash: "d", parents: ["g"] },
    ]);

    expect(below(rows, 0)).toEqual(["b@0", "c@1"]);
    expect(below(rows, 1)).toEqual(["b@0", "d@1"]);
    expect(below(rows, 2)).toEqual(["e@0", "d@1"]);
    expect(below(rows, 3)).toEqual(["f@0", "d@1"]);
    expect(below(rows, 4)).toEqual(["d@0", "d@1"]);
    expect(below(rows, 5)).toEqual(["g@0"]);
  });

  it("allocates a fresh color after lanes converge at a merge", () => {
    const rows = checked([
      { hash: "a", parents: ["b", "c"] },
      { hash: "c", parents: ["b"] },
      { hash: "b", parents: ["d", "e"] },
      { hash: "e", parents: ["f"] },
      { hash: "f", parents: ["g"] },
      { hash: "d", parents: ["h"] },
    ]);

    expect(below(rows, 1)).toEqual(["b@0", "b@1"]);
    // color1 исчез вместе со второй b-lane; новая merge-ветка получает
    // следующий round-robin color2, как в VS Code.
    expect(below(rows, 2)).toEqual(["d@0", "e@2"]);
    expect(below(rows, 5)).toEqual(["h@0", "g@2"]);
  });

  it("collapses several branches only at their common commit", () => {
    const rows = checked([
      { hash: "a", parents: ["b", "c"] },
      { hash: "c", parents: ["d"] },
      { hash: "b", parents: ["e", "f"] },
      { hash: "f", parents: ["g"] },
      { hash: "e", parents: ["g"] },
      { hash: "d", parents: ["g"] },
      { hash: "g", parents: ["h"] },
    ]);

    expect(below(rows, 2)).toEqual(["e@0", "d@1", "f@2"]);
    expect(below(rows, 3)).toEqual(["e@0", "d@1", "g@2"]);
    expect(below(rows, 4)).toEqual(["g@0", "d@1", "g@2"]);
    expect(below(rows, 5)).toEqual(["g@0", "g@1", "g@2"]);
    expect(rows[6].top.map((edge) => edge.fromCol)).toEqual([0, 1, 2]);
    expect(below(rows, 6)).toEqual(["h@0"]);
  });

  it("appends extra merge parents without moving existing lanes", () => {
    const rows = checked([
      { hash: "tip", parents: ["kept"] },
      { hash: "merge", parents: ["main", "topic"] },
      { hash: "main", parents: ["root"] },
      { hash: "topic", parents: ["root"] },
      { hash: "kept", parents: ["root"] },
      { hash: "root", parents: [] },
    ]);

    expect(below(rows, 0)).toEqual(["kept@0"]);
    // merge отсутствует в input и рисуется в col1; оба parent добавлены после
    // уже существующей kept-lane, а не вставлены рядом со сдвигом survivors.
    expect(rows[1].col).toBe(1);
    expect(below(rows, 1).map((lane) => lane.split("@")[0])).toEqual([
      "kept",
      "main",
      "topic",
    ]);
    expect(rows[1].through).toEqual([
      {
        fromCol: 0,
        toCol: 0,
        color: 0,
        kind: "through",
        targetHash: "kept",
      },
    ]);
  });

  it("uses local and upstream reference colors like VS Code", () => {
    const rows = checked(
      [
        { hash: "a", parents: ["b"], refs: ["dev"], isHead: true },
        { hash: "b", parents: ["c"] },
        { hash: "c", parents: ["d"], refs: ["origin/dev"] },
        { hash: "d", parents: [] },
      ],
      { currentBranch: "dev" },
    );

    expect(rows.map((row) => row.color)).toEqual([
      GRAPH_LOCAL_REF_COLOR,
      GRAPH_LOCAL_REF_COLOR,
      GRAPH_REMOTE_REF_COLOR,
      GRAPH_REMOTE_REF_COLOR,
    ]);
    expect(below(rows, 0)).toEqual([`b@${GRAPH_LOCAL_REF_COLOR}`]);
    expect(below(rows, 2)).toEqual([`d@${GRAPH_REMOTE_REF_COLOR}`]);
  });

  it("preserves another disconnected history after reaching a root", () => {
    const rows = checked([
      { hash: "a", parents: ["root-a"] },
      { hash: "b", parents: ["root-b"] },
      { hash: "root-a", parents: [] },
      { hash: "root-b", parents: [] },
    ]);

    expect(rows.map((row) => row.col)).toEqual([0, 1, 0, 0]);
    expect(below(rows, 2).map((lane) => lane.split("@")[0])).toEqual([
      "root-b",
    ]);
  });

  it("handles octopus merges and truncated history", () => {
    const rows = checked([
      { hash: "merge", parents: ["a", "b", "missing"] },
      { hash: "a", parents: ["root"] },
      { hash: "b", parents: ["root"] },
      { hash: "root", parents: [] },
    ]);

    expect(below(rows, 0).map((lane) => lane.split("@")[0])).toEqual([
      "a",
      "b",
      "missing",
    ]);
    expect(rows[0].bottom).toHaveLength(3);
    expect(
      rows[rows.length - 1]?.lanesBelow.map((lane) => lane.targetHash),
    ).toEqual(["missing"]);
  });

  it("keeps every lane connected for random topological DAG histories", () => {
    let seed = 1234567;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value =
        (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };

    for (let trial = 0; trial < 300; trial += 1) {
      const count = 3 + Math.floor(rand() * 40);
      const commits: GraphInput[] = [];
      for (let index = 0; index < count; index += 1) {
        const parents: string[] = [];
        const older = count - index - 1;
        if (older > 0) {
          const parentCount = Math.min(
            older,
            1 + Math.floor(rand() * rand() * 3),
          );
          const picks = new Set<number>();
          while (picks.size < parentCount) {
            picks.add(index + 1 + Math.floor(rand() * older));
          }
          for (const parent of picks) {
            parents.push(`c${parent}`);
          }
        }
        commits.push({ hash: `c${index}`, parents });
      }
      checked(commits);
    }
  });
});

function checked(
  commits: GraphInput[],
  options: Parameters<typeof computeCommitGraph>[1] = {},
) {
  const rows = computeCommitGraph(commits, options);
  const ensure = (condition: boolean, message: string) => {
    if (!condition) {
      throw new Error(message);
    }
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const commit = commits[rowIndex];
    ensure(
      row.col >= 0 && row.col <= row.width,
      `row ${rowIndex}: node ${row.col} outside width ${row.width}`,
    );
    ensure(
      row.lanesAbove.every((lane, index) => lane.col === index) &&
        row.lanesBelow.every((lane, index) => lane.col === index),
      `row ${rowIndex}: swimlanes are not ordered densely`,
    );

    if (rowIndex > 0) {
      expect(row.lanesAbove).toEqual(rows[rowIndex - 1].lanesBelow);
    }

    const inputSources = [...row.through, ...row.top]
      .map((edge) => edge.fromCol)
      .sort((left, right) => left - right);
    expect(inputSources).toEqual(row.lanesAbove.map((lane) => lane.col));

    const outputTargets = [...row.through, ...row.bottom]
      .map((edge) => edge.toCol)
      .sort((left, right) => left - right);
    expect(outputTargets).toEqual(row.lanesBelow.map((lane) => lane.col));

    for (const edge of row.through) {
      expect(row.lanesAbove[edge.fromCol]?.targetHash).toBe(edge.targetHash);
      expect(row.lanesBelow[edge.toCol]?.targetHash).toBe(edge.targetHash);
    }
    for (const edge of row.top) {
      expect(row.lanesAbove[edge.fromCol]?.targetHash).toBe(commit.hash);
      expect(edge.toCol).toBe(row.col);
    }
    expect(row.bottom.map((edge) => edge.targetHash)).toEqual(commit.parents);
    for (const edge of row.bottom) {
      expect(row.lanesBelow[edge.toCol]?.targetHash).toBe(edge.targetHash);
    }
  }

  return rows;
}
