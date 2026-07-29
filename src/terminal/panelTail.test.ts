import { describe, expect, it } from "vitest";
import { extractPanelTail } from "./panelTail";

describe("extractPanelTail", () => {
  it("takes the last meaningful lines and drops the TUI chrome", () => {
    const rows = [
      "╭──────────────────────────────╮",
      "│  Codex                       │",
      "╰──────────────────────────────╯",
      "⠋ думаю…",
      "Готово: обновил 3 файла",
      "",
      "❯ ",
    ];

    expect(extractPanelTail(rows)).toBe("думаю… Готово: обновил 3 файла");
  });

  it("keeps the visual order and collapses whitespace", () => {
    expect(
      extractPanelTail(["первая   строка", "вторая\tстрока"], 2),
    ).toBe("первая строка вторая строка");
  });

  it("returns nothing when only decoration is left", () => {
    expect(
      extractPanelTail(["────────────", "▌▌▌▌", "⠴⠦⠧", "❯", "  "]),
    ).toBeNull();
  });

  it("honours the line budget", () => {
    const rows = ["один раз", "два раза", "три раза", "четыре раза"];

    expect(extractPanelTail(rows, 2)).toBe("три раза четыре раза");
  });
});
