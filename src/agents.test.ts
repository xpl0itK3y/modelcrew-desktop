import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindAgentSession,
  boundAgentSessionIds,
  buildAgentResume,
  getAgentRecord,
  discardAgentRecord,
  isShellProcess,
  loadAgentResumeMode,
  matchAgent,
  pruneAgentRecords,
  rememberAgentProcess,
  saveAgentResumeMode,
  scheduleAgentSessionBinding,
} from "./agents";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe("agent catalog", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("matches known agent processes case-insensitively", () => {
    expect(matchAgent("claude")?.agent.id).toBe("claude");
    expect(matchAgent("Codex")?.agent.id).toBe("codex");
    expect(matchAgent(" agy ")?.agent.id).toBe("antigravity");
    expect(matchAgent("kilo")?.agent.id).toBe("kilocode");
    expect(matchAgent("grok")?.agent.id).toBe("grok");
    expect(matchAgent("cursor-agent")?.agent.id).toBe("cursor");
    expect(matchAgent("gemini")?.agent.id).toBe("gemini");
    expect(matchAgent("qwen")?.agent.id).toBe("qwen");
    expect(matchAgent("aider")?.agent.id).toBe("aider");
    expect(matchAgent("amp")?.agent.id).toBe("amp");
    expect(matchAgent("zsh")).toBeNull();
    expect(matchAgent("vim")).toBeNull();
  });

  it("keeps transient subprocesses but clears an explicit shell immediately", () => {
    rememberAgentProcess("panel-1", "claude");
    expect(getAgentRecord("panel-1")).toEqual({
      agentId: "claude",
      command: "claude",
      detectedAt: expect.any(Number),
    });

    // Вспышка подпроцесса (TUI запустил команду) запись не стирает.
    rememberAgentProcess("panel-1", "git");
    rememberAgentProcess("panel-1", "node");
    expect(getAgentRecord("panel-1")).not.toBeNull();
    // Агент вернулся в foreground — счётчик промахов сброшен.
    rememberAgentProcess("panel-1", "claude");
    rememberAgentProcess("panel-1", "cargo");
    rememberAgentProcess("panel-1", "node");
    expect(getAgentRecord("panel-1")).not.toBeNull();

    // Watcher пришлёт только один zsh: этого достаточно.
    rememberAgentProcess("panel-1", "zsh");
    expect(getAgentRecord("panel-1")).toBeNull();
  });

  it("recognizes Unix and Windows shell names from the title watcher", () => {
    expect(isShellProcess("/bin/zsh")).toBe(true);
    expect(isShellProcess("-bash")).toBe(true);
    expect(isShellProcess("fish")).toBe(true);
    expect(isShellProcess("nu")).toBe(true);
    expect(isShellProcess("PowerShell.EXE")).toBe(true);
    expect(isShellProcess("C:\\Windows\\System32\\cmd.exe")).toBe(true);
    expect(isShellProcess("git")).toBe(false);
    expect(isShellProcess("cargo")).toBe(false);
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

  it("resumes an exact session when one is bound", () => {
    rememberAgentProcess("panel-1", "claude");
    bindAgentSession("panel-1", "0195c9a1-1111-4222-8333-444455556666");
    const record = getAgentRecord("panel-1")!;
    expect(buildAgentResume(record, false)).toBe(
      "claude --resume 0195c9a1-1111-4222-8333-444455556666",
    );
    // picker-режим не важен, когда есть точный id.
    expect(buildAgentResume(record, true)).toBe(
      "claude --resume 0195c9a1-1111-4222-8333-444455556666",
    );

    rememberAgentProcess("panel-2", "codex");
    bindAgentSession("panel-2", "abc-123");
    expect(buildAgentResume(getAgentRecord("panel-2")!, false)).toBe(
      "codex resume abc-123",
    );

    // Многословные команды и агент без адресного resume.
    expect(
      buildAgentResume({ agentId: "amp", command: "amp", sessionId: "T-1" }, false),
    ).toBe("amp threads continue T-1");
    expect(
      buildAgentResume(
        { agentId: "aider", command: "aider", sessionId: "ignored" },
        false,
      ),
    ).toBe("aider --restore-chat-history");
  });

  it("rejects malformed session ids everywhere", () => {
    rememberAgentProcess("panel-1", "claude");
    bindAgentSession("panel-1", "bad id; rm -rf /");
    expect(getAgentRecord("panel-1")!.sessionId).toBeUndefined();
    // Подделанный id в хранилище не попадает в команду.
    expect(
      buildAgentResume(
        { agentId: "claude", command: "claude", sessionId: "x; whoami" },
        false,
      ),
    ).toBe("claude --continue");
  });

  it("strips duplicate session bindings during pruning", () => {
    rememberAgentProcess("panel-1", "agy");
    rememberAgentProcess("panel-2", "agy");
    rememberAgentProcess("panel-3", "claude");
    bindAgentSession("panel-1", "conv-1");
    // Дубль в хранилище имитирует наследие старой гонки локаторов.
    localStorage.setItem(
      "modelcrew.terminalAgents",
      JSON.stringify({
        "panel-1": { agentId: "antigravity", command: "agy", detectedAt: 1, sessionId: "conv-1" },
        "panel-2": { agentId: "antigravity", command: "agy", detectedAt: 2, sessionId: "conv-1" },
        "panel-3": { agentId: "claude", command: "claude", detectedAt: 3, sessionId: "conv-1" },
      }),
    );
    pruneAgentRecords(["panel-1", "panel-2", "panel-3"]);
    expect(getAgentRecord("panel-1")!.sessionId).toBe("conv-1");
    expect(getAgentRecord("panel-2")!.sessionId).toBeUndefined();
    // Совпадающий id у другого агента — не дубль.
    expect(getAgentRecord("panel-3")!.sessionId).toBe("conv-1");
  });

  it("refuses to bind a session already taken by another panel", () => {
    rememberAgentProcess("panel-1", "agy");
    rememberAgentProcess("panel-2", "agy");
    expect(bindAgentSession("panel-1", "conv-1")).toBe(true);
    // Гонка локаторов: вторая панель получила тот же id до обновления exclude.
    expect(bindAgentSession("panel-2", "conv-1")).toBe(false);
    expect(getAgentRecord("panel-2")!.sessionId).toBeUndefined();
    // Повторная привязка того же id к той же панели — идемпотентный успех.
    expect(bindAgentSession("panel-1", "conv-1")).toBe(true);
    // Другой агент может использовать совпадающий id — пространства раздельны.
    rememberAgentProcess("panel-3", "codex");
    expect(bindAgentSession("panel-3", "conv-1")).toBe(true);
  });

  it("keeps the bound session across repeated foreground detections", () => {
    rememberAgentProcess("panel-1", "claude");
    bindAgentSession("panel-1", "0195c9a1-1111-4222-8333-444455556666");
    // Watcher видит того же агента снова (после resume) — id не теряется.
    rememberAgentProcess("panel-1", "claude");
    expect(getAgentRecord("panel-1")!.sessionId).toBe(
      "0195c9a1-1111-4222-8333-444455556666",
    );
  });

  it("collects bound session ids of other panels for the exclude list", () => {
    rememberAgentProcess("panel-1", "claude");
    rememberAgentProcess("panel-2", "claude");
    rememberAgentProcess("panel-3", "codex");
    bindAgentSession("panel-1", "session-a");
    bindAgentSession("panel-3", "session-c");

    expect(boundAgentSessionIds("claude", "panel-2")).toEqual(["session-a"]);
    expect(boundAgentSessionIds("claude", "panel-1")).toEqual([]);
  });

  it("binds the located session via the scheduler", async () => {
    vi.useFakeTimers();
    try {
      rememberAgentProcess("panel-1", "claude");
      invokeMock.mockResolvedValue("located-session-id");

      scheduleAgentSessionBinding("panel-1", "/tmp/proj");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(invokeMock).toHaveBeenCalledWith(
        "agent_session_locate",
        expect.objectContaining({ agent: "claude", cwd: "/tmp/proj" }),
      );
      expect(getAgentRecord("panel-1")!.sessionId).toBe("located-session-id");
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the locator until the session file appears", async () => {
    vi.useFakeTimers();
    try {
      rememberAgentProcess("panel-1", "codex");
      invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce("late-id");

      scheduleAgentSessionBinding("panel-1", "/tmp/proj");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(getAgentRecord("panel-1")!.sessionId).toBeUndefined();
      await vi.advanceTimersByTimeAsync(7_000);

      expect(getAgentRecord("panel-1")!.sessionId).toBe("late-id");
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the resume mode and defaults to auto", () => {
    expect(loadAgentResumeMode()).toBe("auto");
    saveAgentResumeMode("insert");
    expect(loadAgentResumeMode()).toBe("insert");
    localStorage.setItem("modelcrew.agentResumeMode", "garbage");
    expect(loadAgentResumeMode()).toBe("auto");
  });
});
