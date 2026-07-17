import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  windowFocused: { value: false },
  record: { value: null as { agentId: string; command: string } | null },
  playSound: vi.fn(),
  systemNotification: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: async () => mocks.windowFocused.value,
  }),
}));
vi.mock("../agents", () => ({
  AGENTS: [{ id: "claude", label: "Claude Code" }],
  getAgentRecord: () => mocks.record.value,
}));
vi.mock("../sound", () => ({ playNotificationSound: mocks.playSound }));
vi.mock("../notifications", () => ({
  sendSystemNotification: mocks.systemNotification,
}));

import {
  AGENT_IDLE_MIN_BYTES,
  AGENT_IDLE_QUIET_MS,
  SPAWN_ALERT_MUTE_MS,
  acknowledgeAgentPanel,
  clearAgentAttention,
  createAgentAlertTracker,
  getAgentAttentionCount,
  markAgentPanelEngaged,
  muteAlertsAfterSpawn,
  scanTerminalAttention,
  setWorkspaceNameResolver,
  subscribeAgentAttention,
  trackAgentOutput,
} from "./agentAlerts";

// Ожидание микрозадач: raiseAgentAlert асинхронно спрашивает фокус окна.
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("scanTerminalAttention", () => {
  it("counts plain bells", () => {
    const result = scanTerminalAttention("hello\x07world\x07", 0);
    expect(result).toEqual({ bells: 2, state: 0 });
  });

  it("ignores the BEL that terminates an OSC title sequence", () => {
    // Смена заголовка окна: OSC 0;title BEL — это не «звонок».
    const result = scanTerminalAttention("\x1b]0;my title\x07after", 0);
    expect(result).toEqual({ bells: 0, state: 0 });
  });

  it("handles ST-terminated OSC and real bell after it", () => {
    const result = scanTerminalAttention("\x1b]8;;link\x1b\\text\x07", 0);
    expect(result).toEqual({ bells: 1, state: 0 });
  });

  it("keeps state across chunk boundaries", () => {
    // OSC разорван между чанками: BEL из второго чанка — терминатор, не звонок.
    const first = scanTerminalAttention("\x1b]0;par", 0);
    expect(first.bells).toBe(0);
    expect(first.state).toBe(2);
    const second = scanTerminalAttention("tial\x07\x07", first.state);
    expect(second).toEqual({ bells: 1, state: 0 });
  });

  it("does not treat CSI sequences as OSC", () => {
    const result = scanTerminalAttention("\x1b[31mred\x07", 0);
    expect(result.bells).toBe(1);
  });

  it("scans binary chunks too", () => {
    const bytes = new Uint8Array([104, 7, 105]).buffer;
    expect(scanTerminalAttention(bytes, 0).bells).toBe(1);
  });
});

describe("agent attention store", () => {
  it("notifies subscribers and clears acknowledged panels", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeAgentAttention((count) => seen.push(count));
    expect(seen).toEqual([getAgentAttentionCount()]);
    // Прямых add снаружи нет — проверяем идемпотентность clear.
    clearAgentAttention("missing-panel");
    expect(seen).toHaveLength(1);
    unsubscribe();
  });
});

describe("trackAgentOutput", () => {
  const hidden = { visible: false, workspaceId: "ws-1" };
  const shown = { visible: true, workspaceId: "ws-1" };

  // Панель, с которой пользователь уже работал: только для таких сигналы
  // вообще имеют смысл.
  function engaged(id: string) {
    const tracker = createAgentAlertTracker();
    markAgentPanelEngaged(tracker, id);
    return tracker;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.windowFocused.value = false;
    mocks.record.value = { agentId: "claude", command: "claude" };
    clearAgentAttention("panel-1");
    clearAgentAttention("panel-2");
  });

  it("stays silent for a restored panel the user has not touched", async () => {
    // Корень фантомного бейджа: восстановленный агент дорисовал транскрипт
    // и замолк — с ним не работали, это не событие.
    const restored = createAgentAlertTracker();
    trackAgentOutput(
      restored,
      "restored-panel",
      `\x07${"a".repeat(AGENT_IDLE_MIN_BYTES)}`,
      () => hidden,
    );
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_QUIET_MS + 1_000);
    await settle();
    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(getAgentAttentionCount()).toBe(0);

    // Пользователь напечатал — панель «живая», дальше сигналы работают.
    markAgentPanelEngaged(restored, "restored-panel");
    trackAgentOutput(restored, "restored-panel", "\x07", () => hidden);
    await settle();
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
    clearAgentAttention("restored-panel");
    vi.useRealTimers();
  });

  it("rings immediately on a terminal bell and marks attention", async () => {
    setWorkspaceNameResolver((id) =>
      id === "ws-1" ? "Crypto-Sentiment-Pulse" : null,
    );
    const tracker = engaged("bell-panel");
    trackAgentOutput(tracker, "bell-panel", "работаю…\x07", () => shown);
    await settle();

    expect(mocks.playSound).toHaveBeenCalledTimes(1);
    // Заголовок называет агента, тело — проект-источник.
    expect(mocks.systemNotification).toHaveBeenCalledWith(
      expect.stringContaining("Claude Code"),
      expect.stringContaining("Crypto-Sentiment-Pulse"),
    );
    expect(getAgentAttentionCount()).toBe(1);

    // Ответ пользователя гасит сигнал.
    acknowledgeAgentPanel(tracker, "bell-panel");
    expect(getAgentAttentionCount()).toBe(0);
    vi.useRealTimers();
  });

  it("fires an idle alert only after enough output and full silence", async () => {
    const tracker = engaged("idle-panel");
    // Мало вывода — тишина не считается сигналом.
    trackAgentOutput(tracker, "idle-panel", "x".repeat(100), () => shown);
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_QUIET_MS + 1_000);
    expect(mocks.playSound).not.toHaveBeenCalled();

    // Достаточно вывода, но новая порция сбрасывает отсчёт тишины.
    trackAgentOutput(
      tracker,
      "idle-panel",
      "y".repeat(AGENT_IDLE_MIN_BYTES),
      () => shown,
    );
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_QUIET_MS - 500);
    trackAgentOutput(tracker, "idle-panel", "ещё строки", () => shown);
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_QUIET_MS - 500);
    expect(mocks.playSound).not.toHaveBeenCalled();

    // Полная тишина — сигнал.
    await vi.advanceTimersByTimeAsync(600);
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
    expect(getAgentAttentionCount()).toBe(1);
    clearAgentAttention("idle-panel");
    vi.useRealTimers();
  });

  it("stays silent right after spawn, for plain shells and when watched", async () => {
    // Глушение после запуска: даже с engaged-панелью TUI рисует и замолкает.
    const muted = engaged("mute-panel");
    muteAlertsAfterSpawn(muted);
    trackAgentOutput(
      muted,
      "mute-panel",
      `\x07${"z".repeat(AGENT_IDLE_MIN_BYTES)}`,
      () => shown,
    );
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_QUIET_MS + 1_000);
    expect(mocks.playSound).not.toHaveBeenCalled();
    // Окно глушения истекло — сигналы снова работают.
    await vi.advanceTimersByTimeAsync(SPAWN_ALERT_MUTE_MS);
    trackAgentOutput(muted, "mute-panel", "\x07", () => shown);
    await settle();
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
    clearAgentAttention("mute-panel");
    mocks.playSound.mockClear();

    // Панель без агента (обычный шелл) не сигналит, хоть и engaged.
    mocks.record.value = null;
    const shell = engaged("shell-panel");
    trackAgentOutput(shell, "shell-panel", "\x07", () => shown);
    await settle();
    expect(mocks.playSound).not.toHaveBeenCalled();

    // Пользователь смотрит на панель (видна + окно в фокусе) — тихо.
    mocks.record.value = { agentId: "claude", command: "claude" };
    mocks.windowFocused.value = true;
    const watched = engaged("watch-panel");
    trackAgentOutput(watched, "watch-panel", "\x07", () => shown);
    await settle();
    expect(mocks.playSound).not.toHaveBeenCalled();

    // …а если панель скрыта (другая сессия) — сигнал даже при фокусе окна.
    trackAgentOutput(watched, "watch-panel", "\x07", () => hidden);
    await settle();
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
    clearAgentAttention("watch-panel");
    vi.useRealTimers();
  });

  it("throttles repeated bells from the same panel", async () => {
    const tracker = engaged("throttle-panel");
    trackAgentOutput(tracker, "throttle-panel", "\x07", () => shown);
    await settle();
    trackAgentOutput(tracker, "throttle-panel", "\x07", () => shown);
    await settle();
    expect(mocks.playSound).toHaveBeenCalledTimes(1);

    // Спустя тайм-аут — можно снова.
    await vi.advanceTimersByTimeAsync(16_000);
    trackAgentOutput(tracker, "throttle-panel", "\x07", () => shown);
    await settle();
    expect(mocks.playSound).toHaveBeenCalledTimes(2);
    clearAgentAttention("throttle-panel");
    vi.useRealTimers();
  });
});
