import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentResume,
  getAgentRecord,
  discardAgentRecord,
  loadAgentResumeMode,
  matchAgent,
  pruneAgentRecords,
  rememberAgentProcess,
  saveAgentResumeMode,
} from "./agents";

describe("agent catalog", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("matches known agent processes case-insensitively", () => {
    expect(matchAgent("claude")?.agent.id).toBe("claude");
    expect(matchAgent("Codex")?.agent.id).toBe("codex");
    expect(matchAgent(" agy ")?.agent.id).toBe("antigravity");
    expect(matchAgent("kilo")?.agent.id).toBe("kilocode");
    expect(matchAgent("zsh")).toBeNull();
    expect(matchAgent("vim")).toBeNull();
  });

  it("records the agent while it is in the foreground and clears it after", () => {
    rememberAgentProcess("panel-1", "claude");
    expect(getAgentRecord("panel-1")).toEqual({
      agentId: "claude",
      command: "claude",
    });

    // Агент завершился — foreground снова оболочка.
    rememberAgentProcess("panel-1", "zsh");
    expect(getAgentRecord("panel-1")).toBeNull();
  });

  it("builds resume commands for the latest chat and for the picker", () => {
    rememberAgentProcess("panel-1", "codex");
    const record = getAgentRecord("panel-1")!;
    expect(buildAgentResume(record, false)).toBe("codex resume --last");
    expect(buildAgentResume(record, true)).toBe("codex resume");

    rememberAgentProcess("panel-2", "claude");
    const claude = getAgentRecord("panel-2")!;
    expect(buildAgentResume(claude, false)).toBe("claude --continue");
    expect(buildAgentResume(claude, true)).toBe("claude --resume");
  });

  it("falls back to the canonical binary when the stored command is tampered", () => {
    expect(
      buildAgentResume({ agentId: "claude", command: "rm -rf /" }, false),
    ).toBe("claude --continue");
    expect(buildAgentResume({ agentId: "unknown", command: "x" }, false)).toBe(
      null,
    );
  });

  it("discards and prunes records", () => {
    rememberAgentProcess("panel-1", "claude");
    rememberAgentProcess("panel-2", "opencode");

    discardAgentRecord("panel-1");
    expect(getAgentRecord("panel-1")).toBeNull();
    expect(getAgentRecord("panel-2")).not.toBeNull();

    pruneAgentRecords([]);
    expect(getAgentRecord("panel-2")).toBeNull();
  });

  it("persists the resume mode and defaults to auto", () => {
    expect(loadAgentResumeMode()).toBe("auto");
    saveAgentResumeMode("insert");
    expect(loadAgentResumeMode()).toBe("insert");
    localStorage.setItem("modelcrew.agentResumeMode", "garbage");
    expect(loadAgentResumeMode()).toBe("auto");
  });
});
