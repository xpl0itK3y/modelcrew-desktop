import { beforeEach, describe, expect, it } from "vitest";
import {
  MIN_DOCK_WIDTH,
  clampWithin,
  fitColumns,
  widthLimits,
  widthLimitsWithin,
  type Column,
} from "./columnWidths";

const ALL: Column[] = ["sidebar", "tree", "editor"];

describe("widthLimitsWithin", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stops the column where the terminal grid would start disappearing", () => {
    // Сетке остаётся ровно столько, сколько ей положено, и ни пикселем меньше:
    // дальше терминал не сжимается, а уходит за правый край окна.
    const limits = widthLimitsWithin("editor", 520, MIN_DOCK_WIDTH + 100);
    expect(limits.max).toBe(620);
    expect(clampWithin("editor", 5_000, 520, MIN_DOCK_WIDTH + 100)).toBe(620);
  });

  it("never lets a column past its own ceiling, however wide the window", () => {
    const own = widthLimits("editor").max;
    expect(widthLimitsWithin("editor", 520, 10_000).max).toBe(own);
  });

  it("leaves only shrinking available once the grid is already too narrow", () => {
    // Окно уже сохранённых ширин: расширять нечего, но сузить колонку —
    // единственный способ вернуть сетку, и его отнимать нельзя.
    const limits = widthLimitsWithin("editor", 900, 40);
    expect(limits.max).toBeLessThan(900);
    expect(clampWithin("editor", 1_000, 900, 40)).toBe(limits.max);
    expect(clampWithin("editor", 400, 900, 40)).toBe(400);
  });

  it("does not squeeze a column below its own minimum to feed the grid", () => {
    // Колонка уже на минимуме, а сетке всё равно мало: отнимать дальше нечего.
    // Схлопнутую в ноль колонку не за что взять обратно.
    const min = widthLimits("editor").min;
    const limits = widthLimitsWithin("editor", min, 40);
    expect(limits.max).toBe(min);
    expect(clampWithin("editor", 10, min, 40)).toBe(min);
  });

  it("keeps the old limits until the grid has been measured", () => {
    // Первый кадр: сетки ещё нет. Один кадр без ограничения безобиднее, чем
    // колонка, схлопнутая в минимум на старте.
    for (const column of ALL) {
      expect(widthLimitsWithin(column, 400, 0)).toEqual(widthLimits(column));
      expect(widthLimitsWithin(column, 400, Number.NaN)).toEqual(
        widthLimits(column),
      );
    }
  });

  it("still refuses a width that is not a number", () => {
    expect(clampWithin("editor", Number.NaN, 520, 800)).toBe(
      widthLimits("editor").fallback,
    );
  });
});

describe("fitColumns", () => {
  it("gives the grid its room back when the window is smaller than last time", () => {
    const widths = { sidebar: 400, tree: 500, editor: 1_100 };
    const fitted = fitColumns(widths, ALL, 100);

    // Не хватало 260 — их отдал редактор, самый широкий и первый в очереди.
    expect(fitted).toEqual({ sidebar: 400, tree: 500, editor: 840 });
  });

  it("moves on to the next column when one has nothing left to give", () => {
    const widths = { sidebar: 400, tree: 500, editor: 400 };
    const fitted = fitColumns(widths, ALL, MIN_DOCK_WIDTH - 200);

    // Редактор дошёл до своего минимума, отдав всё, что мог, — остальное
    // берётся со следующей колонки в очереди.
    expect(fitted.editor).toBe(widthLimits("editor").min);
    expect(fitted.tree).toBe(340);
    expect(fitted.sidebar).toBe(400);
  });

  it("takes nothing from a column that is not on screen", () => {
    // У спрятанной колонки места не отнять: она и так ничего не занимает, а
    // ужать её значит недобрать у видимых.
    const widths = { sidebar: 400, tree: 500, editor: 1_100 };
    const fitted = fitColumns(widths, ["sidebar", "tree"], MIN_DOCK_WIDTH - 100);

    expect(fitted.editor).toBe(1_100);
    expect(fitted.tree).toBe(400);
  });

  it("returns the very same widths when the grid already fits", () => {
    // Тот же объект, а не копия: иначе состояние обновлялось бы на каждое
    // измерение, а колонка прыгала бы туда-обратно.
    const widths = { sidebar: 400, tree: 500, editor: 1_100 };
    expect(fitColumns(widths, ALL, MIN_DOCK_WIDTH)).toBe(widths);
    expect(fitColumns(widths, ALL, 5_000)).toBe(widths);
  });

  it("gives up rather than squeezing columns below their own minimum", () => {
    // Окно бывает просто маленьким. Тогда сетке достаётся меньше положенного,
    // но колонки остаются пригодными к чтению — схлопнутую обратно не вытянуть.
    const widths = { sidebar: 200, tree: 200, editor: 400 };
    const fitted = fitColumns(widths, ALL, 10);

    expect(fitted.sidebar).toBe(widthLimits("sidebar").min);
    expect(fitted.tree).toBe(widthLimits("tree").min);
    expect(fitted.editor).toBe(widthLimits("editor").min);
  });
});
