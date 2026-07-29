import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // registry читает признак Tauri один раз при импорте модуля.
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  return { invoke: vi.fn() };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage: ((data: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async () => () => {},
  }),
}));

import { rememberAgentProcess } from "../agents";
import { destroyTerminal, ensureSpawned, getOrCreateTerminal } from "./registry";

// У каждого теста свой проект: вторая панель того же агента в той же папке
// получила бы команду со списком диалогов, а не «продолжить последний».
async function spawnResumedPanel(id: string, workspaceId: string) {
  rememberAgentProcess(id, "claude");
  const entry = getOrCreateTerminal(id);
  await ensureSpawned(entry, workspaceId);
  return entry;
}

describe("auto-resumed agent panels", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "pty_create") {
        return { title: "zsh" };
      }
      return null;
    });
  });

  afterEach(async () => {
    await destroyTerminal("resumed-panel");
    await destroyTerminal("insert-panel");
  });

  it("counts as engaged, so the agent can still raise alerts", async () => {
    // Команду возобновления вводим мы через pty_write мимо xterm, поэтому
    // onData не срабатывает. Без отметки панель молчала бы и на звонок, и на
    // тишину — до первого нажатия клавиши.
    const entry = await spawnResumedPanel("resumed-panel", "workspace-1");

    expect(entry.pendingResume).toBe("claude --continue\r");
    expect(entry.alerts.engaged).toBe(true);
  });

  it("stays untouched when the command is only typed into the prompt", async () => {
    localStorage.setItem("modelcrew.agentResumeMode", "insert");

    const entry = await spawnResumedPanel("insert-panel", "workspace-2");

    // Enter нажимает пользователь — вот тогда onData и отметит панель.
    expect(entry.pendingResume).toBe("claude --continue");
    expect(entry.alerts.engaged).toBe(false);
  });
});
