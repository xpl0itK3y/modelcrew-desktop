import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  windowFocused: { value: false },
  record: { value: null as { agentId: string; command: string } | null },
  playSound: vi.fn(),
  systemNotification: vi.fn(async (_title: string, _body: string) => {}),
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
  createAgentAlertTracker,
  markAgentPanelEngaged,
  muteAlertsAfterSpawn,
  raiseAgentAlert,
  raiseAgentHookAlert,
  trackAgentOutput,
} from "./agentAlerts";
import {
  resetAgentAlertBurst,
  setPanelTailResolver,
  setWorkspaceNameResolver,
} from "./alertDelivery";
import { resetAlertThrottle } from "./alertPolicy";
import {
  clearAgentAttention,
  getAgentAttentionCount,
  getWaitingPanelIds,
} from "./attentionStore";
import {
  saveAgentAlertDetailMode,
  saveAgentAlertsEnabled,
} from "./preferences";

// Ожидание микрозадач: raiseAgentAlert асинхронно спрашивает фокус окна.
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

// Состояние сигналов живёт в модулях, а не в объекте теста: множество ждущих
// панелей, окно тишины, копящаяся пачка баннеров и подменённые таймеры. Уборка
// стоит здесь, а не в конце каждого теста, потому что до конца дело доходит не
// всегда: упавшая проверка выбрасывает исключение, и следующий тест получил бы
// чужую отметку и фейковые таймеры — одна поломка превращалась в горсть.
afterEach(() => {
  for (const id of getWaitingPanelIds()) {
    clearAgentAttention(id);
  }
  resetAgentAlertBurst();
  resetAlertThrottle();
  vi.useRealTimers();
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
    localStorage.clear();
    mocks.windowFocused.value = false;
    mocks.record.value = { agentId: "claude", command: "claude" };
    setPanelTailResolver(() => null);
    resetAgentAlertBurst();
    clearAgentAttention("panel-1");
    clearAgentAttention("panel-2");
  });

  it("collapses a burst of agents finishing at once into one extra banner", async () => {
    setWorkspaceNameResolver(() => "ModelCrew");
    for (const id of ["burst-1", "burst-2", "burst-3", "burst-4"]) {
      trackAgentOutput(engaged(id), id, "\x07", () => hidden);
      await settle();
    }

    // Первый баннер пришёл сразу, остальные ждут окна.
    expect(mocks.systemNotification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.systemNotification).toHaveBeenCalledTimes(2);
    expect(mocks.systemNotification).toHaveBeenLastCalledWith(
      "Ждут ответа ещё 3",
      "Claude Code · ModelCrew\nClaude Code · ModelCrew\nClaude Code · ModelCrew",
    );

    for (const id of ["burst-1", "burst-2", "burst-3", "burst-4"]) {
      clearAgentAttention(id);
    }
  });

  it("shows a single straggler as an ordinary alert", async () => {
    setWorkspaceNameResolver(() => null);
    trackAgentOutput(engaged("lone-1"), "lone-1", "\x07", () => hidden);
    await settle();
    trackAgentOutput(engaged("lone-2"), "lone-2", "\x07", () => hidden);
    await settle();

    await vi.advanceTimersByTimeAsync(2_000);

    // Сводка из одного была бы страннее самого уведомления.
    expect(mocks.systemNotification).toHaveBeenCalledTimes(2);
    expect(mocks.systemNotification).toHaveBeenLastCalledWith(
      expect.stringContaining("Claude Code"),
      expect.any(String),
    );
  });

  it("falls back to the panel tail when the agent sent no text of its own", async () => {
    // Звонок и тишина сообщения не несут: без запасного источника «Подробно»
    // ничем не отличалось бы от «Кратко».
    saveAgentAlertDetailMode("detailed");
    setWorkspaceNameResolver(() => "ModelCrew");
    setPanelTailResolver((id) =>
      id === "tail-panel" ? "Готово: обновил 3 файла" : null,
    );

    trackAgentOutput(engaged("tail-panel"), "tail-panel", "\x07", () => hidden);
    await settle();

    expect(mocks.systemNotification).toHaveBeenCalledWith(
      expect.stringContaining("Claude Code"),
      expect.stringContaining("Готово: обновил 3 файла"),
    );
  });

  it("keeps the brief mode free of the panel tail", async () => {
    saveAgentAlertDetailMode("brief");
    setWorkspaceNameResolver(() => "ModelCrew");
    let collected = 0;
    setPanelTailResolver(() => {
      collected += 1;
      return "Готово: обновил 3 файла";
    });

    trackAgentOutput(engaged("brief-panel"), "brief-panel", "\x07", () => hidden);
    await settle();

    expect(mocks.systemNotification).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.stringContaining("Готово"),
    );
    // И сам хвост не собирался: за ним стоит проход по буферу панели, который в
    // кратком режиме уходит в никуда.
    expect(collected).toBe(0);
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
  });

  it("uses a precise permission notification and cancels idle fallback", async () => {
    const tracker = engaged("permission-panel");
    trackAgentOutput(
      tracker,
      "permission-panel",
      `${"x".repeat(AGENT_IDLE_MIN_BYTES)}\x1b]9;Approval requested\x1b\\`,
      () => hidden,
    );
    await settle();

    expect(mocks.systemNotification).toHaveBeenCalledWith(
      expect.stringMatching(/Claude Code.*(permission|разреш)/i),
      expect.not.stringContaining("Approval requested"),
    );
    expect(mocks.playSound).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AGENT_IDLE_QUIET_MS + 1_000);
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
  });

  it("adds the agent message only in detailed mode", async () => {
    saveAgentAlertDetailMode("detailed");
    setWorkspaceNameResolver((id) => (id === "ws-1" ? "ModelCrew" : null));
    const tracker = engaged("detailed-panel");
    trackAgentOutput(
      tracker,
      "detailed-panel",
      "\x1b]777;notify;Permission needed;Approve npm test\x07",
      () => hidden,
    );
    await settle();

    expect(mocks.systemNotification).toHaveBeenCalledWith(
      expect.stringMatching(/Claude Code.*(permission|разреш)/i),
      expect.stringMatching(/(?:Проект|Project): ModelCrew\nApprove npm test/),
    );
  });

  it("cleans and caps the detailed message in the system banner", async () => {
    saveAgentAlertDetailMode("detailed");
    setWorkspaceNameResolver(() => "ModelCrew");
    const tracker = engaged("sanitized-detail-panel");
    trackAgentOutput(
      tracker,
      "sanitized-detail-panel",
      `\x1b]777;notify;Permission needed; Run\n\n${"x".repeat(220)}\x01\x07`,
      () => hidden,
    );
    await settle();

    const body = mocks.systemNotification.mock.calls[0]?.[1] ?? "";
    const [project, detail] = body.split("\n");
    expect(project).toMatch(/(?:Проект|Project): ModelCrew/);
    expect(Array.from(detail)).toHaveLength(200);
    expect(detail).not.toContain("\x01");
    expect(detail).not.toContain("\n");
    expect(detail.endsWith("...")).toBe(true);
  });

  it("never exposes raw terminal output for fallback bells", async () => {
    saveAgentAlertDetailMode("detailed");
    setWorkspaceNameResolver(() => "ModelCrew");
    const tracker = engaged("detailed-bell-panel");
    trackAgentOutput(
      tracker,
      "detailed-bell-panel",
      "secret terminal output\x07",
      () => hidden,
    );
    await settle();

    expect(mocks.systemNotification).toHaveBeenCalledWith(
      expect.stringContaining("Claude Code"),
      expect.not.stringContaining("secret terminal output"),
    );
  });

  it("accepts precise completion after spawn mute without requiring keyboard input", async () => {
    const tracker = createAgentAlertTracker();
    muteAlertsAfterSpawn(tracker);
    await vi.advanceTimersByTimeAsync(SPAWN_ALERT_MUTE_MS + 1);
    trackAgentOutput(
      tracker,
      "precise-restored-panel",
      "\x1b]9;Agent turn complete\x1b\\",
      () => hidden,
    );
    await settle();

    expect(mocks.systemNotification).toHaveBeenCalledWith(
      expect.stringMatching(/Claude Code.*(finished|completed|закончил)/i),
      expect.any(String),
    );
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
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
  });
});

describe("the master switch for agent alerts", () => {
  const hidden = { visible: false, workspaceId: "ws-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    mocks.windowFocused.value = false;
    mocks.record.value = { agentId: "claude", command: "claude" };
  });

  it("silences the sound, the banner and the badge together", async () => {
    saveAgentAlertsEnabled(false);

    void raiseAgentAlert("muted-panel", "permission", hidden);
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.playSound).not.toHaveBeenCalled();
    expect(mocks.systemNotification).not.toHaveBeenCalled();
    // Счётчик тоже молчит: бейдж на иконке — такое же уведомление.
    expect(getAgentAttentionCount()).toBe(0);
  });

  it("silences a hook the agent sent about itself, not only panel output", async () => {
    saveAgentAlertsEnabled(false);

    // Точный сигнал идёт другим путём и мимо этой проверки не должен пройти.
    void raiseAgentHookAlert("muted-hook-panel", "claude", "completed", hidden, {
      protocol: "hook",
      title: "",
      body: "готово",
      types: ["Stop"],
    });
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.systemNotification).not.toHaveBeenCalled();
    expect(getAgentAttentionCount()).toBe(0);
  });

  it("starts working again the moment it is switched back on", async () => {
    saveAgentAlertsEnabled(false);
    void raiseAgentAlert("unmuted-panel", "permission", hidden);
    await settle();
    expect(mocks.systemNotification).not.toHaveBeenCalled();

    saveAgentAlertsEnabled(true);
    void raiseAgentAlert("unmuted-panel", "permission", hidden);
    await settle();

    // Выключенный сигнал не должен был занять окно тишины: иначе включение
    // не действовало бы ещё пятнадцать секунд.
    expect(mocks.systemNotification).toHaveBeenCalledTimes(1);
    expect(getAgentAttentionCount()).toBe(1);
  });
});

describe("alert throttling", () => {
  const hidden = { visible: false, workspaceId: "ws-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    mocks.windowFocused.value = false;
    mocks.record.value = { agentId: "claude", command: "claude" };
  });

  it("lets a more demanding alert through the quiet window", async () => {
    void raiseAgentAlert("escalate-panel", "completed", hidden);
    await settle();
    expect(mocks.systemNotification).toHaveBeenCalledTimes(1);

    // Через три секунды агент упёрся в запрос разрешения: работа встала, и
    // молчание здесь обходится дороже лишнего баннера.
    await vi.advanceTimersByTimeAsync(3_000);
    void raiseAgentAlert("escalate-panel", "permission", hidden);
    await settle();

    expect(mocks.systemNotification).toHaveBeenCalledTimes(2);
    expect(mocks.systemNotification).toHaveBeenLastCalledWith(
      expect.stringMatching(/(permission|разреш)/i),
      expect.any(String),
    );
  });

  it("keeps a less demanding alert inside the quiet window", async () => {
    void raiseAgentAlert("calm-panel", "permission", hidden);
    await settle();
    expect(mocks.systemNotification).toHaveBeenCalledTimes(1);

    // «Закончил» и повтор того же запроса — тот же самый разговор, второй
    // раз дёргать незачем.
    await vi.advanceTimersByTimeAsync(3_000);
    void raiseAgentAlert("calm-panel", "completed", hidden);
    await settle();
    void raiseAgentAlert("calm-panel", "permission", hidden);
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.systemNotification).toHaveBeenCalledTimes(1);

    // Окно истекло — снова можно даже с самым тихим сигналом.
    await vi.advanceTimersByTimeAsync(16_000);
    void raiseAgentAlert("calm-panel", "idle", hidden);
    await settle();
    expect(mocks.systemNotification).toHaveBeenCalledTimes(2);
  });

  it("shows one banner when two alerts race for the same panel", async () => {
    // Хук агента и OSC из того же вывода приходят вместе: пока первый сигнал
    // ждал ответа о фокусе окна, второй успевал пройти ту же проверку.
    void raiseAgentAlert("race-panel", "completed", hidden);
    void raiseAgentAlert("race-panel", "completed", hidden);
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.systemNotification).toHaveBeenCalledTimes(1);
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
  });
});
