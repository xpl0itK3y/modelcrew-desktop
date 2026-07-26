import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadAgentAlertDetailMode,
  loadGridOrientation,
  saveAgentAlertDetailMode,
  saveGridOrientation,
  subscribeGridOrientation,
} from "./preferences";

describe("grid orientation preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("notifies the active layout immediately when the orientation changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeGridOrientation(listener);

    saveGridOrientation("rows");

    expect(loadGridOrientation()).toBe("rows");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("rows");

    unsubscribe();
    saveGridOrientation("columns");
    expect(listener).toHaveBeenCalledOnce();
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
