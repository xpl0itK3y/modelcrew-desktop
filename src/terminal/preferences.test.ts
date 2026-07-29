import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_SPAWN_MODE,
  loadAgentAlertDetailMode,
  loadTerminalSpawnMode,
  saveAgentAlertDetailMode,
  saveTerminalSpawnMode,
} from "./preferences";

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
