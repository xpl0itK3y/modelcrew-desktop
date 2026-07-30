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
import { raiseAgentAlert } from "./agentAlerts";
import { resetAgentAlertBurst } from "./alertDelivery";
import {
  clearAgentAttention,
  getAgentAttentionCount,
  isAgentPanelWaiting,
} from "./attentionStore";
import { destroyTerminal, getOrCreateTerminal } from "./registry";

const used: string[] = [];

// Панель, придавленная развёрнутым соседом, из DOM не уходит — dockview лишь
// обнуляет её высоту. Раскладку jsdom не считает, поэтому задаём её сами.
function mountPanel(id: string, height: number) {
  used.push(id);
  rememberAgentProcess(id, "claude");
  const entry = getOrCreateTerminal(id);
  document.body.appendChild(entry.container);
  entry.container.getBoundingClientRect = () =>
    ({ height, width: height > 0 ? 800 : 0 }) as DOMRect;
  return entry;
}

// Каретку внутри панели держит собственная textarea xterm; в jsdom её роль
// исполняет любой сфокусированный элемент внутри контейнера.
function focusInside(entry: { container: HTMLElement }) {
  const caret = document.createElement("textarea");
  entry.container.appendChild(caret);
  caret.focus();
}

async function callFor(id: string) {
  await raiseAgentAlert(id, "permission", { visible: true, workspaceId: "ws-1" });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // registry ждёт от каждой команды промис — снимки удаляются через .catch.
  mocks.invoke.mockImplementation(async () => null);
  resetAgentAlertBurst();
});

afterEach(async () => {
  for (const id of used.splice(0)) {
    clearAgentAttention(id);
    await destroyTerminal(id);
  }
  resetAgentAlertBurst();
  document.body.innerHTML = "";
});

describe("window focus and pending agent panels", () => {
  it("keeps the mark on every panel except the one the caret is in", async () => {
    const here = mountPanel("caret-panel", 400);
    mountPanel("other-panel", 400);
    await callFor("caret-panel");
    await callFor("other-panel");
    expect(getAgentAttentionCount()).toBe(2);

    focusInside(here);
    window.dispatchEvent(new Event("focus"));

    // Возврат в окно — ещё не ответ панели: иначе отметки гасли бы раньше,
    // чем их увидят, и вопрос «какая позвала» остался бы без ответа.
    expect(isAgentPanelWaiting("caret-panel")).toBe(false);
    expect(isAgentPanelWaiting("other-panel")).toBe(true);
  });

  it("clears nothing when the caret is outside every panel", async () => {
    mountPanel("untouched-panel", 400);
    await callFor("untouched-panel");

    // Каретка в боковой панели или в настройках — до терминала не дошли.
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    window.dispatchEvent(new Event("focus"));

    expect(isAgentPanelWaiting("untouched-panel")).toBe(true);
  });

  it("leaves a panel squeezed to nothing alone even with the caret in it", async () => {
    const buried = mountPanel("buried-panel", 0);
    await callFor("buried-panel");

    focusInside(buried);
    window.dispatchEvent(new Event("focus"));

    // Придавленную развёрнутым соседом панель не видно, сколько бы фокуса в
    // ней ни было.
    expect(isAgentPanelWaiting("buried-panel")).toBe(true);
  });
});
