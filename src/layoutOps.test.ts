import { describe, expect, it } from "vitest";
import type { DockviewApi } from "dockview";
import {
  dockFloatingGroups,
  planTerminalPlacement,
  type TerminalGridGroup,
} from "./layoutOps";
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

// Соседство: новый терминал встал вплотную к предыдущему — рядом в той же
// строке или в соседней строке, если предыдущая закончилась.
function adjacent(rows: Grid, previous: string, next: string): boolean {
  for (const cells of rows) {
    const from = cells.indexOf(previous);
    const to = cells.indexOf(next);
    if (from >= 0 && to >= 0) {
      return Math.abs(from - to) === 1;
    }
  }
  const rowOf = (id: string) => rows.findIndex((cells) => cells.includes(id));
  return Math.abs(rowOf(previous) - rowOf(next)) === 1;
}

describe("terminal placement planning", () => {
  it("keeps the row-major strategy as the default", () => {
    expect(planTerminalPlacement(single(), "balanced")).toEqual({
      referenceGroupId: "only",
      direction: "right",
    });

    // В строке ещё есть место — панель остаётся в ней, следом за последней.
    expect(
      planTerminalPlacement(geometry([["a", "b"]], 1400, 800), "balanced"),
    ).toEqual({ referenceGroupId: "b", direction: "right" });

    // Строка добрала колонок — следующая уходит новой строкой вниз.
    expect(
      planTerminalPlacement(geometry([["a", "b", "c"]], 1400, 800), "balanced"),
    ).toEqual({ direction: "below" });

    expect(simulate("balanced", 6)).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("fills every other row backwards in snake mode", () => {
    expect(simulate("snake", 6)).toEqual([
      ["1", "2", "3"],
      ["6", "5", "4"],
    ]);
  });

  it("puts each new terminal next to the one before it", () => {
    // То, ради чего всё и считается: нажал плюс — панель появилась там, куда
    // смотришь. Прыжок через полсетки читается как чужое действие.
    for (const mode of ["balanced", "snake"] as TerminalSpawnMode[]) {
      for (const [width, height] of [
        [1400, 800],
        [900, 900],
        [700, 1200],
      ]) {
        for (let count = 2; count <= 12; count += 1) {
          const rows = simulate(mode, count, width, height);
          const total = rows.reduce((sum, row) => sum + row.length, 0);
          if (total < count) {
            break;
          }
          expect(
            adjacent(rows, String(count - 1), String(count)),
            `${mode} ${width}x${height}: ${count} не рядом с ${count - 1} в ${JSON.stringify(rows)}`,
          ).toBe(true);
        }
      }
    }
  });

  it("keeps both orders growing along the same row", () => {
    const rows = geometry(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      1400,
      800,
    );

    // Обе раскладки продолжают ту строку, которую наполняют, — и различаются
    // только концом, с которого встают.
    expect(planTerminalPlacement(rows, "balanced")).toEqual({
      referenceGroupId: "d",
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
      planTerminalPlacement(geometry([["a", "b", "c"]], 1400, 800), "centerOut"),
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
    ).toEqual({ referenceGroupId: "a", direction: "left" });

    expect(simulate("centerOut", 6)).toEqual([
      ["5", "4", "6"],
      ["2", "1", "3"],
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

  it("follows the shape of the window, not a bare square", () => {
    // Шесть терминалов в широком окне ложатся строками, в узком — колонкой:
    // иначе в широком выходили бы узкие высокие панели, в узком плоские.
    const wide = simulate("balanced", 6, 1600, 700);
    const tall = simulate("balanced", 6, 700, 1400);
    expect(Math.max(...wide.map((row) => row.length))).toBeGreaterThan(
      Math.max(...tall.map((row) => row.length)),
    );
    expect(tall.length).toBeGreaterThan(wide.length);
  });

  it("refuses placement when no split respects the minimum panel size", () => {
    for (const mode of TERMINAL_SPAWN_MODES) {
      expect(
        planTerminalPlacement(single({ width: 479, height: 319 }), mode),
      ).toBeNull();
    }
  });
});

// Сетка dockview в том объёме, который нужен возврату вытащенных панелей: у
// группы есть место обитания и список панелей, у панели — перенос.
function fakeApi(
  groups: readonly { location: "grid" | "floating"; panels: string[] }[],
) {
  const moved: string[] = [];
  const api = {
    groups: groups.map((group) => ({
      api: { location: { type: group.location } },
      panels: group.panels.map((id) => ({
        id,
        api: {
          moveTo: (options: { position?: string }) => {
            moved.push(`${id}:${options.position}`);
          },
        },
      })),
    })),
  } as unknown as DockviewApi;
  return { api, moved };
}

describe("returning floating panels to the grid", () => {
  it("docks every panel that was pulled out of the grid", () => {
    const { api, moved } = fakeApi([
      { location: "grid", panels: ["ostalsya"] },
      { location: "floating", panels: ["claude"] },
      { location: "floating", panels: ["codex"] },
    ]);

    expect(dockFloatingGroups(api)).toBe(2);
    // Каждая встаёт своей ячейкой, а панель из сетки никто не трогает.
    expect(moved).toEqual(["claude:right", "codex:right"]);
  });

  it("gives a floating group's panels a cell each", () => {
    // Иначе они уехали бы в одну группу вкладками, а вкладок здесь нет:
    // на экране осталась бы одна панель, остальные — за ней.
    const { api, moved } = fakeApi([
      { location: "grid", panels: ["odna"] },
      { location: "floating", panels: ["claude", "codex"] },
    ]);

    expect(dockFloatingGroups(api)).toBe(2);
    expect(moved).toEqual(["claude:right", "codex:right"]);
  });

  it("leaves a layout that never left the grid alone", () => {
    const { api, moved } = fakeApi([
      { location: "grid", panels: ["odna"] },
      { location: "grid", panels: ["dve"] },
    ]);

    expect(dockFloatingGroups(api)).toBe(0);
    expect(moved).toEqual([]);
  });
});
