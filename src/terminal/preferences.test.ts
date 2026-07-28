import { beforeEach, describe, expect, it } from "vitest";
import {
  loadAgentAlertDetailMode,
  saveAgentAlertDetailMode,
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
