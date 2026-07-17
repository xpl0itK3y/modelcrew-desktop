import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  playSound: vi.fn(),
  systemNotification: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false }),
}));
vi.mock("../sound", () => ({ playNotificationSound: mocks.playSound }));
vi.mock("../notifications", () => ({
  sendSystemNotification: mocks.systemNotification,
}));

import { getAgentRecord, rememberAgentProcess } from "../agents";
import {
  AGENT_IDLE_MIN_BYTES,
  AGENT_IDLE_QUIET_MS,
  clearAgentAttention,
  createAgentAlertTracker,
  markAgentPanelEngaged,
  trackAgentOutput,
} from "./agentAlerts";

describe("title watcher to agent alert integration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    clearAgentAttention("watcher-panel");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not attribute shell output to an agent after agent -> zsh", async () => {
    const terminalId = "watcher-panel";
    rememberAgentProcess(terminalId, "claude");
    expect(getAgentRecord(terminalId)?.agentId).toBe("claude");

    const tracker = createAgentAlertTracker();
    markAgentPanelEngaged(tracker, terminalId);

    // spawn_title_watcher emits only on a name change. One zsh event must be
    // enough to clear identity; waiting for repeated zsh events leaves it stale.
    rememberAgentProcess(terminalId, "zsh");
    expect(getAgentRecord(terminalId)).toBeNull();

    trackAgentOutput(
      tracker,
      terminalId,
      "ordinary shell output\n".repeat(AGENT_IDLE_MIN_BYTES),
      () => ({ visible: false, workspaceId: "workspace-1" }),
    );
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_QUIET_MS + 1);

    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.systemNotification).not.toHaveBeenCalled();
    clearAgentAttention(terminalId);
  });
});
