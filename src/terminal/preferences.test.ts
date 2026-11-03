import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_FONTS,
  DEFAULT_TERMINAL_SPAWN_MODE,
  dropRetiredPreferences,
  loadAgentAlertDetailMode,
  loadTerminalFontFamily,
  loadTerminalSpawnMode,
  normalizeTerminalFontFamily,
  saveAgentAlertDetailMode,
  saveTerminalFontFamily,
  saveTerminalSpawnMode,
  terminalFontFamilyCss,
  terminalFonts,
} from "./preferences";

describe("retired preferences", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("drops the key of a setting that no longer exists", () => {
    localStorage.setItem("modelcrew.eagerSessionRestore", "off");

    dropRetiredPreferences();

    expect(localStorage.getItem("modelcrew.eagerSessionRestore")).toBeNull();
  });

  it("leaves every live preference alone", () => {
    saveTerminalSpawnMode("snake");
    saveAgentAlertDetailMode("detailed");

    dropRetiredPreferences();

    expect(loadTerminalSpawnMode()).toBe("snake");
    expect(loadAgentAlertDetailMode()).toBe("detailed");
  });

  it("stays quiet when the storage refuses to cooperate", () => {
    const removeItem = localStorage.removeItem;
    localStorage.removeItem = () => {
      throw new Error("storage is locked down");
    };

    try {
      expect(() => dropRetiredPreferences()).not.toThrow();
    } finally {
      localStorage.removeItem = removeItem;
    }
  });
});

describe("agent alert detail preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to brief and persists an explicit detailed mode", () => {
    expect(loadAgentAlertDetailMode()).toBe("brief");

    saveAgentAlertDetailMode("detailed");

    expect(loadAgentAlertDetailMode()).toBe("detailed");

    localStorage.setItem("modelcrew.agentAlertDetail", "unexpected");
    expect(loadAgentAlertDetailMode()).toBe("brief");
  });
});

describe("terminal spawn mode preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps balanced as the default and persists another valid mode", () => {
    expect(loadTerminalSpawnMode()).toBe(DEFAULT_TERMINAL_SPAWN_MODE);

    saveTerminalSpawnMode("centerOut");

    expect(loadTerminalSpawnMode()).toBe("centerOut");
  });

  it("falls back to balanced for a mode that no longer exists", () => {
    localStorage.setItem("modelcrew.terminalSpawnMode", "clockwise");

    expect(loadTerminalSpawnMode()).toBe("balanced");
  });
});

describe("terminal font preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("puts the user's fonts first and keeps the defaults behind them", () => {
    expect(terminalFonts("")).toEqual([...DEFAULT_TERMINAL_FONTS]);
    expect(terminalFonts("Claude Dials 4, menlo")).toEqual([
      "Claude Dials 4",
      "menlo",
      "SF Mono",
      "Cascadia Mono",
      "JetBrains Mono",
      "Consolas",
      "monospace",
    ]);
  });

  it("strips quotes, control characters and duplicates from the typed list", () => {
    expect(
      normalizeTerminalFontFamily(
        ` "Claude Dials 4", 'JetBrains\tMono' ,,claude dials 4,\u001b[31m `,
      ),
    ).toBe("Claude Dials 4, JetBrains Mono, [31m");
  });

  it("quotes every family name except the generic keywords", () => {
    // Без кавычек «Claude Dials 4» — ошибка разбора, и весь список молча
    // игнорировался бы.
    expect(terminalFontFamilyCss(["Claude Dials 4", "Menlo", "Monospace"])).toBe(
      '"Claude Dials 4", "Menlo", monospace',
    );
  });

  it("saves the normalized list and forgets an empty one", () => {
    saveTerminalFontFamily("  Fira Code ,Menlo ");
    expect(localStorage.getItem("modelcrew.terminalFontFamily")).toBe(
      "Fira Code, Menlo",
    );
    expect(loadTerminalFontFamily()).toBe("Fira Code, Menlo");

    saveTerminalFontFamily(" , ");
    expect(localStorage.getItem("modelcrew.terminalFontFamily")).toBeNull();
    expect(loadTerminalFontFamily()).toBe("");
  });
});
