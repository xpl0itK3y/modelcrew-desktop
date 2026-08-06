// Что остаётся открытым после удаления.

import { describe, expect, it } from "vitest";
import { closeOne, closeUnder } from "./openFiles";

const OPEN = {
  files: ["src/a.rs", "src/panels/b.tsx", "README.md"],
  active: "src/panels/b.tsx",
};

describe("closeUnder", () => {
  it("closes the tab of the file that was deleted", () => {
    // Вкладка удалённого файла предлагает сохранить его в никуда.
    expect(closeUnder(OPEN, "README.md")).toEqual({
      files: ["src/a.rs", "src/panels/b.tsx"],
      active: "src/panels/b.tsx",
    });
  });

  it("closes everything that lived inside a deleted folder", () => {
    expect(closeUnder(OPEN, "src")).toEqual({
      files: ["README.md"],
      active: "README.md",
    });
  });

  it("does not mistake a neighbour for a child", () => {
    // `src2` не внутри `src`, сколько бы общих букв у них ни было.
    const state = { files: ["src/a.rs", "src2/b.rs"], active: "src2/b.rs" };
    expect(closeUnder(state, "src")).toEqual({
      files: ["src2/b.rs"],
      active: "src2/b.rs",
    });
  });

  it("shows whichever tab took the freed place", () => {
    const state = {
      files: ["первый.txt", "второй.txt", "третий.txt"],
      active: "второй.txt",
    };
    // Взгляд остаётся там же, где был: на месте закрытой вкладки оказывается
    // следующая, а не соседняя слева.
    expect(closeUnder(state, "второй.txt")).toEqual({
      files: ["первый.txt", "третий.txt"],
      active: "третий.txt",
    });
  });

  it("falls back to the one before when the last tab goes", () => {
    const state = { files: ["первый.txt", "второй.txt"], active: "второй.txt" };
    expect(closeUnder(state, "второй.txt").active).toBe("первый.txt");
  });

  it("leaves nothing open when the last file goes", () => {
    expect(closeUnder({ files: ["один.txt"], active: "один.txt" }, "один.txt"))
      .toEqual({ files: [], active: null });
  });

  it("keeps the very same state when nothing matched", () => {
    // Не просто равное, а то же самое: иначе каждое удаление в дереве
    // перерисовывало бы редактор впустую.
    expect(closeUnder(OPEN, "docs")).toBe(OPEN);
  });

  it("closes a single tab the ordinary way too", () => {
    expect(closeOne(OPEN, "src/a.rs").files).toEqual([
      "src/panels/b.tsx",
      "README.md",
    ]);
  });
});
