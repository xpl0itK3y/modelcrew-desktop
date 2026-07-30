import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  return {
    invoke: vi.fn(async () => null),
    listeners: new Map<string, (event: { payload: unknown }) => void>(),
    systemNotification: vi.fn(async (_title: string, _body: string) => {}),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage: ((data: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false }),
}));
vi.mock("../sound", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../notifications", () => ({
  sendSystemNotification: mocks.systemNotification,
}));

import { rememberAgentProcess } from "../agents";
import { resetAgentAlertBurst } from "./alertDelivery";
import { clearAgentAttention } from "./attentionStore";
import { destroyTerminal, getOrCreateTerminal } from "./registry";
import { setLocale } from "../i18n";

// Панель у каждой проверки своя: повтор той же попал бы в окно тишины
// предыдущей и второго сигнала не дал.
const PANELS = ["hook-owner-grok", "hook-owner-unknown"];

// Событие приходит из Rust; в тесте дёргаем зарегистрированный слушатель.
async function deliver(panel: string, agent: string) {
  const handler = mocks.listeners.get("agent-event");
  if (!handler) {
    throw new Error("registry не подписался на agent-event");
  }
  handler({
    payload: {
      panelId: panel,
      agent,
      event: "Stop",
      message: "готово",
    },
  });
  // raiseAgentHookAlert асинхронно спрашивает фокус окна.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  localStorage.clear();
  setLocale("ru");
  mocks.systemNotification.mockClear();
  resetAgentAlertBurst();
  for (const panel of PANELS) {
    clearAgentAttention(panel);
  }
});

afterEach(async () => {
  for (const panel of PANELS) {
    await destroyTerminal(panel);
  }
  resetAgentAlertBurst();
});

describe("who a hook event is attributed to", () => {
  it("names the agent running in the panel, not the config the hook came from", async () => {
    const panel = PANELS[0];
    getOrCreateTerminal(panel);
    // Grok читает настройки claude и hooks.json курсора, поэтому событие
    // приходит подписанным именем чужого конфига.
    rememberAgentProcess(panel, "grok");

    await deliver(panel, "claude");

    expect(mocks.systemNotification).toHaveBeenCalledTimes(1);
    const [title] = mocks.systemNotification.mock.calls[0];
    expect(title).toContain("Grok");
    expect(title).not.toContain("Claude");
  });

  it("falls back to the name in the event when the panel has no agent yet", async () => {
    const panel = PANELS[1];
    getOrCreateTerminal(panel);
    rememberAgentProcess(panel, "zsh");

    await deliver(panel, "claude");

    // Watcher ещё не опознал агента — единственное имя, какое есть, из события.
    const [title] = mocks.systemNotification.mock.calls[0] ?? [""];
    expect(title).toContain("Claude");
  });
});
