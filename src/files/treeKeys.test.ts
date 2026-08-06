// Ходьба по дереву с клавиатуры.

import { describe, expect, it } from "vitest";
import { treeKeyAction, type KeyRow } from "./treeKeys";

// src/
//   panels/
//     Tree.tsx
//   main.rs
// README.md
const ROWS: KeyRow[] = [
  { path: "src", isDir: true, depth: 0 },
  { path: "src/panels", isDir: true, depth: 1 },
  { path: "src/panels/Tree.tsx", isDir: false, depth: 2 },
  { path: "src/main.rs", isDir: false, depth: 1 },
  { path: "README.md", isDir: false, depth: 0 },
];
const OPEN = new Set(["src", "src/panels"]);

describe("treeKeyAction", () => {
  it("walks down and up the rows as they are shown", () => {
    expect(treeKeyAction("ArrowDown", ROWS, "src", OPEN)).toEqual({
      kind: "move",
      path: "src/panels",
    });
    expect(treeKeyAction("ArrowUp", ROWS, "src/panels", OPEN)).toEqual({
      kind: "move",
      path: "src",
    });
  });

  it("stays put at the ends instead of wrapping around", () => {
    // Перескок с последней строки на первую в дереве читается как сбой: глаз
    // теряет место, и его приходится искать заново.
    expect(treeKeyAction("ArrowUp", ROWS, "src", OPEN)).toEqual({
      kind: "move",
      path: "src",
    });
    expect(treeKeyAction("ArrowDown", ROWS, "README.md", OPEN)).toEqual({
      kind: "move",
      path: "README.md",
    });
  });

  it("starts from the top when nothing is focused yet", () => {
    // Иначе первое нажатие пропадает впустую, и кажется, что клавиши не
    // работают вовсе.
    expect(treeKeyAction("ArrowDown", ROWS, null, OPEN)).toEqual({
      kind: "move",
      path: "src",
    });
  });

  it("opens a folder with the right arrow and steps into an open one", () => {
    expect(treeKeyAction("ArrowRight", ROWS, "src", new Set())).toEqual({
      kind: "expand",
      path: "src",
    });
    // Раскрытая пропускает внутрь: так одной клавишей проходят вглубь, не
    // переключаясь на стрелку вниз.
    expect(treeKeyAction("ArrowRight", ROWS, "src", OPEN)).toEqual({
      kind: "move",
      path: "src/panels",
    });
  });

  it("does nothing with the right arrow on a file", () => {
    expect(treeKeyAction("ArrowRight", ROWS, "README.md", OPEN)).toBeNull();
  });

  it("closes an open folder with the left arrow", () => {
    expect(treeKeyAction("ArrowLeft", ROWS, "src/panels", OPEN)).toEqual({
      kind: "collapse",
      path: "src/panels",
    });
  });

  it("leaves for the parent when there is nothing to close", () => {
    // Из файла и из закрытой папки левая стрелка выводит наверх — иначе из
    // глубины пришлось бы выбираться стрелкой вверх по всем соседям.
    expect(treeKeyAction("ArrowLeft", ROWS, "src/panels/Tree.tsx", OPEN)).toEqual(
      { kind: "move", path: "src/panels" },
    );
    expect(treeKeyAction("ArrowLeft", ROWS, "src/main.rs", OPEN)).toEqual({
      kind: "move",
      path: "src",
    });
    // На верхнем уровне выходить некуда.
    expect(treeKeyAction("ArrowLeft", ROWS, "README.md", OPEN)).toBeNull();
  });

  it("jumps to the ends with Home and End", () => {
    expect(treeKeyAction("Home", ROWS, "src/main.rs", OPEN)).toEqual({
      kind: "move",
      path: "src",
    });
    expect(treeKeyAction("End", ROWS, "src", OPEN)).toEqual({
      kind: "move",
      path: "README.md",
    });
  });

  it("opens with Enter and with a space", () => {
    for (const key of ["Enter", " "]) {
      expect(treeKeyAction(key, ROWS, "README.md", OPEN)).toEqual({
        kind: "open",
        path: "README.md",
      });
    }
  });

  it("keeps its hands off keys that are not its own", () => {
    // Печатаемые символы уйдут поиску по дереву, а Tab — переходу дальше.
    for (const key of ["Tab", "a", "Escape", "PageDown"]) {
      expect(treeKeyAction(key, ROWS, "src", OPEN)).toBeNull();
    }
  });

  it("does nothing at all while the tree is empty", () => {
    expect(treeKeyAction("ArrowDown", [], null, new Set())).toBeNull();
  });
});
