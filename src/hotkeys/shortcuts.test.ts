import { describe, expect, it } from "vitest";
import {
  SHORTCUTS,
  detectPlatform,
  shortcutKeys,
  shortcutLabel,
} from "./shortcuts";

describe("detectPlatform", () => {
  it("tells the three keyboards apart", () => {
    expect(
      detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
    ).toBe("mac");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(
      "windows",
    );
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
    // Неизвестная система ведёт себя как PC: Ctrl вместо ⌘ — меньшее зло.
    expect(detectPlatform("")).toBe("linux");
  });
});

describe("shortcut labels", () => {
  it("uses the mac symbols and glues them together", () => {
    expect(shortcutKeys(["mod", "shift", "w"], "mac")).toEqual(["⌘", "⇧", "W"]);
    expect(shortcutLabel(["mod", "enter"], "mac")).toBe("⌘↩");
  });

  it("spells the modifiers out on Windows and Linux", () => {
    expect(shortcutKeys(["mod", "shift", "w"], "windows")).toEqual([
      "Ctrl",
      "Shift",
      "W",
    ]);
    expect(shortcutLabel(["mod", "enter"], "linux")).toBe("Ctrl+Enter");
  });

  it("keeps the key ranges readable on every platform", () => {
    expect(shortcutLabel(["mod", "alt", "digits"], "mac")).toBe("⌘⌥1–9");
    expect(shortcutLabel(["mod", "shift", "arrows"], "windows")).toBe(
      "Ctrl+Shift+←↑↓→",
    );
  });

  it("keeps every listed shortcut printable", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcutKeys(shortcut.keys, "mac").join("")).not.toContain(
        undefined,
      );
      expect(shortcutLabel(shortcut.keys, "windows").length).toBeGreaterThan(2);
    }
  });
});
