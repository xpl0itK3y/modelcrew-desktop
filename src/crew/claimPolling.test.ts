// Разворачивание плоского списка заявок в состояние по панелям.

import { describe, expect, it } from "vitest";
import { claimsByPanel } from "./claimPolling";

function claim(
  path: string,
  panelId: string,
  waiting: string[] = [],
) {
  return { path, panelId, sinceMs: 1_000, waiting };
}

describe("claimsByPanel", () => {
  it("collects every file a panel holds", () => {
    const byPanel = claimsByPanel([
      claim("src/a.ts", "panel-1"),
      claim("src/b.ts", "panel-1"),
      claim("src/c.ts", "panel-2"),
    ]);

    expect(byPanel.get("panel-1")!.held).toEqual(["src/a.ts", "src/b.ts"]);
    expect(byPanel.get("panel-2")!.held).toEqual(["src/c.ts"]);
  });

  it("tells the holder that its file is awaited", () => {
    const byPanel = claimsByPanel([claim("src/a.ts", "panel-1", ["panel-2"])]);

    expect(byPanel.get("panel-1")!.awaited).toBe(true);
  });

  it("tells the waiting panel which file it is stuck on", () => {
    const byPanel = claimsByPanel([claim("src/a.ts", "panel-1", ["panel-2"])]);

    // Ждущая панель заявок не держит, но состояние у неё есть — иначе шапка
    // не покажет, чего она ждёт.
    expect(byPanel.get("panel-2")).toEqual({
      held: [],
      waitingFor: "src/a.ts",
      awaited: false,
    });
  });

  it("keeps the first file a panel got stuck on", () => {
    // Агент мог упереться в несколько файлов подряд; показываем тот, на
    // котором он споткнулся раньше.
    const byPanel = claimsByPanel([
      claim("src/first.ts", "panel-1", ["panel-2"]),
      claim("src/second.ts", "panel-3", ["panel-2"]),
    ]);

    expect(byPanel.get("panel-2")!.waitingFor).toBe("src/first.ts");
  });

  it("lets one panel hold and wait at the same time", () => {
    const byPanel = claimsByPanel([
      claim("src/mine.ts", "panel-1"),
      claim("src/busy.ts", "panel-2", ["panel-1"]),
    ]);

    expect(byPanel.get("panel-1")).toEqual({
      held: ["src/mine.ts"],
      waitingFor: "src/busy.ts",
      awaited: false,
    });
  });

  it("returns nothing for an empty registry", () => {
    expect(claimsByPanel([]).size).toBe(0);
  });
});
