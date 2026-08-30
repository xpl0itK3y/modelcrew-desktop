import { describe, expect, it } from "vitest";
import { APP_THEMES, terminalMinimumContrast } from "./theme";

describe("readability floor for the terminal", () => {
  it("holds text to WCAG AA on every light theme", () => {
    const light = APP_THEMES.filter((theme) => theme.scheme === "light");
    expect(light.length).toBeGreaterThan(0);
    for (const theme of light) {
      expect(terminalMinimumContrast(theme.id)).toBe(4.5);
    }
  });

  // На тёмных темах палитра уже написана под свой фон, и поднимать её значит
  // стирать разницу между приглушённым текстом и обычным.
  it("leaves the dark palettes untouched", () => {
    const dark = APP_THEMES.filter((theme) => theme.scheme === "dark");
    expect(dark.length).toBeGreaterThan(0);
    for (const theme of dark) {
      expect(terminalMinimumContrast(theme.id)).toBe(1);
    }
  });
});
