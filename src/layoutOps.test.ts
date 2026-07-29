import { describe, expect, it } from "vitest";
import { planTerminalPlacement, type TerminalGridGroup } from "./layoutOps";
import {
  TERMINAL_SPAWN_MODES,
  type TerminalSpawnMode,
} from "./terminal/preferences";

// Раскладка описывается списком строк с их ячейками: dockview добавляет панели
// с Sizing.Distribute, поэтому строки равны по высоте, а ячейки внутри строки —
// по ширине. Этого достаточно, чтобы прогнать планировщик по шагам.
type Grid = string[][];

function geometry(rows: Grid, width: number, height: number) {
  const rowHeight = height / rows.length;
  return rows.flatMap((cells, rowIndex) =>
    cells.map((id, cellIndex) => ({
      id,
      left: (cellIndex * width) / cells.length,
      top: rowIndex * rowHeight,
      width: width / cells.length,
      height: rowHeight,
    })),
  );
}

function place(
  rows: Grid,
  id: string,
  mode: TerminalSpawnMode,
  width: number,
  height: number,
): Grid | null {
  const plan = planTerminalPlacement(geometry(rows, width, height), mode);
  if (!plan) {
    return null;
  }
  const reference = plan.referenceGroupId;
  if (!reference) {
    return plan.direction === "above" ? [[id], ...rows] : [...rows, [id]];
  }
  return rows.map((cells) => {
    const at = cells.indexOf(reference);
    if (at < 0) {
      return cells;
    }
    const next = [...cells];
    next.splice(plan.direction === "left" ? at : at + 1, 0, id);
    return next;
  });
}

// Сетка после `count` терминалов: ячейки перечислены в визуальном порядке
// слева направо, строки — сверху вниз.
function simulate(
  mode: TerminalSpawnMode,
  count: number,
  width = 1400,
  height = 800,
): Grid {
  let rows: Grid = [["1"]];
  for (let index = 2; index <= count; index += 1) {
    const next = place(rows, String(index), mode, width, height);
    if (!next) {
      break;
    }
    rows = next;
  }
  return rows;
}

function single(
  overrides: Partial<TerminalGridGroup> = {},
): TerminalGridGroup[] {
  return [
    { id: "only", left: 0, top: 0, width: 960, height: 640, ...overrides },
  ];
}

describe("terminal placement planning", () => {
  it("keeps the row-major strategy as the default", () => {
    expect(planTerminalPlacement(single(), "balanced")).toEqual({
      referenceGroupId: "only",
      direction: "right",
    });

    // Строка добрала колонок — следующая панель уходит новой строкой вниз.
    expect(
      planTerminalPlacement(geometry([["a", "b"]], 1400, 800), "balanced"),
    ).toEqual({ direction: "below" });

    expect(simulate("balanced", 6)).toEqual([
      ["1", "2", "5"],
      ["3", "4", "6"],
    ]);
  });

  it("fills every other row backwards in snake mode", () => {
    expect(simulate("snake", 6)).toEqual([
      ["1", "2", "6"],
      ["5", "4", "3"],
    ]);
  });

  it("keeps the snake growing along the bottom row instead of backfilling", () => {
    const rows = geometry(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      1400,
      800,
    );

    // Порядок «по строкам» вернулся бы в верхнюю строку, змейка продолжает
    // нижнюю — и следующий терминал встаёт рядом с предыдущим.
    expect(planTerminalPlacement(rows, "balanced")).toEqual({
      referenceGroupId: "b",
      direction: "right",
    });
    expect(planTerminalPlacement(rows, "snake")).toEqual({
      referenceGroupId: "c",
      direction: "left",
    });
  });

  it("alternates sides in center-out mode so the first terminals stay in the middle", () => {
    expect(planTerminalPlacement(single(), "centerOut")).toEqual({
      referenceGroupId: "only",
      direction: "left",
    });
    // Строки тоже чередуются: первая новая строка встаёт сверху, вторая снизу.
    expect(
      planTerminalPlacement(geometry([["a", "b"]], 1400, 800), "centerOut"),
    ).toEqual({ direction: "above" });
    expect(
      planTerminalPlacement(
        geometry(
          [
            ["a", "b", "c"],
            ["d", "e", "f"],
          ],
          1400,
          800,
        ),
        "centerOut",
      ),
    ).toEqual({ direction: "below" });

    expect(simulate("centerOut", 6)).toEqual([
      ["4", "3", "5"],
      ["2", "1", "6"],
    ]);
  });

  it("grows the same grid shape in every mode", () => {
    for (const [width, height] of [
      [1400, 800],
      [900, 600],
    ]) {
      for (let count = 1; count <= 12; count += 1) {
        const shapes = TERMINAL_SPAWN_MODES.map((mode) =>
          simulate(mode, count, width, height)
            .map((row) => row.length)
            .sort((a, b) => a - b),
        );
        for (const shape of shapes) {
          expect(shape).toEqual(shapes[0]);
        }
      }
    }
  });

  it("refuses placement when no split respects the minimum panel size", () => {
    for (const mode of TERMINAL_SPAWN_MODES) {
      expect(
        planTerminalPlacement(single({ width: 479, height: 319 }), mode),
      ).toBeNull();
    }
  });
});
