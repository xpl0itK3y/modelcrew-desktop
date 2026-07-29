import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // registry читает признак Tauri один раз при импорте модуля.
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  return { invoke: vi.fn(), systemNotification: vi.fn(async () => {}) };
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
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false }),
}));
vi.mock("../sound", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../notifications", () => ({
  sendSystemNotification: mocks.systemNotification,
}));

import { rememberAgentProcess } from "../agents";
import {
  clearAgentAttention,
  getAgentAttentionCount,
  raiseAgentAlert,
  resetAgentAlertBurst,
} from "./agentAlerts";
import { destroyTerminal, getOrCreateTerminal } from "./registry";

const PANELS = ["seen-panel", "buried-panel"];

// Панель, придавленная развёрнутым соседом, из DOM не уходит — dockview лишь
// обнуляет её высоту. Раскладку jsdom не считает, поэтому задаём её сами.
function mountPanel(id: string, height: number) {
  rememberAgentProcess(id, "claude");
  const entry = getOrCreateTerminal(id);
  document.body.appendChild(entry.container);
  entry.container.getBoundingClientRect = () =>
    ({ height, width: height > 0 ? 800 : 0 }) as DOMRect;
  return entry;
}

describe("window focus and pending agent panels", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    // registry ждёт от каждой команды промис — снимки удаляются через .catch.
    mocks.invoke.mockImplementation(async () => null);
    resetAgentAlertBurst();
    for (const id of PANELS) {
      clearAgentAttention(id);
    }
  });

  afterEach(async () => {
    for (const id of PANELS) {
      await destroyTerminal(id);
    }
    resetAgentAlertBurst();
    document.body.innerHTML = "";
  });

  it("clears only the panels the user can actually see", async () => {
    mountPanel("seen-panel", 400);
    mountPanel("buried-panel", 0);

    await raiseAgentAlert("seen-panel", "permission", {
      visible: false,
      workspaceId: "ws-1",
    });
    await raiseAgentAlert("buried-panel", "permission", {
      visible: false,
      workspaceId: "ws-1",
    });
    expect(getAgentAttentionCount()).toBe(2);

    window.dispatchEvent(new Event("focus"));

    // Взгляд дошёл только до открытой панели; свёрнутую пользователь не
    // видел, и напоминание о ней должно остаться.
    expect(getAgentAttentionCount()).toBe(1);
  });
});
