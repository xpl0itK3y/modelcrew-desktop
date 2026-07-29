import { beforeEach, describe, expect, it, vi } from "vitest";

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
  classifyTerminalNotification,
  clearAgentAttention,
  createAgentAlertTracker,
  createAttentionScanState,
  formatAgentAlertDetail,
  getAgentAttentionCount,
  markAgentPanelEngaged,
  muteAlertsAfterSpawn,
  scanTerminalAttention,
  setPanelTailResolver,
  setWorkspaceNameResolver,
  subscribeAgentAttention,
  trackAgentOutput,
} from "./agentAlerts";
import { saveAgentAlertDetailMode } from "./preferences";

// Ожидание микрозадач: raiseAgentAlert асинхронно спрашивает фокус окна.
async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("scanTerminalAttention", () => {
  it("counts plain bells", () => {
    const result = scanTerminalAttention(
      "hello\x07world\x07",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(2);
    expect(result.notifications).toEqual([]);
    expect(result.state.mode).toBe(0);
  });

  it("ignores the BEL that terminates an OSC title sequence", () => {
    // Смена заголовка окна: OSC 0;title BEL — это не «звонок».
    const result = scanTerminalAttention(
      "\x1b]0;my title\x07after",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(0);
    expect(result.notifications).toEqual([]);
    expect(result.state.mode).toBe(0);
  });

  it("handles ST-terminated OSC and real bell after it", () => {
    const result = scanTerminalAttention(
      "\x1b]8;;link\x1b\\text\x07",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(1);
    expect(result.notifications).toEqual([]);
    expect(result.state.mode).toBe(0);
  });

  it("keeps state across chunk boundaries", () => {
    // OSC разорван между чанками: BEL из второго чанка — терминатор, не звонок.
    const first = scanTerminalAttention(
      "\x1b]0;par",
      createAttentionScanState(),
    );
    expect(first.bells).toBe(0);
    expect(first.state.mode).toBe(2);
    const second = scanTerminalAttention("tial\x07\x07", first.state);
    expect(second.bells).toBe(1);
    expect(second.notifications).toEqual([]);
    expect(second.state.mode).toBe(0);
  });

  it("does not treat CSI sequences as OSC", () => {
    const result = scanTerminalAttention(
      "\x1b[31mred\x07",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(1);
  });

  it("resyncs when a CSI interrupts an unterminated OSC", () => {
    // Оборванная гиперссылка (OSC 8 без ST): сканер обязан выйти из OSC на
    // первой же CSI, иначе он съест следующий звонок агента как терминатор.
    const opened = scanTerminalAttention(
      "\x1b]8;;https://example.com",
      createAttentionScanState(),
    );
    expect(opened.state.mode).toBe(2);

    const redrawn = scanTerminalAttention("\x1b[0m text \x1b[1m\r\n", opened.state);
    expect(redrawn.state.mode).toBe(0);

    expect(scanTerminalAttention("\x07", redrawn.state).bells).toBe(1);
  });

  it("starts over when a new OSC begins inside an unterminated one", () => {
    const result = scanTerminalAttention(
      "\x1b]0;title\x1b]9;Agent waiting\x07",
      createAttentionScanState(),
    );
    expect(result.bells).toBe(0);
    expect(result.notifications).toEqual([
      { protocol: "osc9", title: "Agent waiting", body: "", types: [] },
    ]);
  });

  it("decodes UTF-8 text out of the raw PTY bytes", () => {
    // PTY отдаёт байты: без декодирования кириллица в теле уведомления
    // рассыпается на «Ð°Ð½Ð°Ð»Ð¾Ð³» — по символу на байт.
    const bytes = new TextEncoder().encode(
      "\x1b]777;notify;Codex;Odysseus — аналог ChatGPT с агентами\x07",
    ).buffer;

    const result = scanTerminalAttention(bytes, createAttentionScanState());

    expect(result.notifications).toEqual([
      {
        protocol: "osc777",
        title: "Codex",
        body: "Odysseus — аналог ChatGPT с агентами",
        types: [],
      },
    ]);
  });

  it("keeps a multi-byte character split across chunks", () => {
    const bytes = new TextEncoder().encode("\x1b]9;Готово\x07");
    // Разрез приходится на середину первой кириллической буквы.
    const state = createAttentionScanState();
    scanTerminalAttention(bytes.slice(0, 5).buffer, state);

    const result = scanTerminalAttention(bytes.slice(5).buffer, state);

    expect(result.notifications[0]?.title).toBe("Готово");
  });

  it("survives any chunk split of a realistic stream", () => {
    // Перерисовка TUI, смена заголовка и само уведомление в одном потоке:
    // PTY может разрезать его в любом месте, включая середину буквы.
    const stream =
      "\x1b[?25l\x1b[2K\x1b[38;5;39m▌\x1b[0m работаю…\r\n" +
      "\x1b]0;codex — odysseus\x07" +
      "\x1b]777;notify;Codex;Odysseus — аналог ChatGPT с агентами\x07" +
      "\x1b[?25h";
    const bytes = new TextEncoder().encode(stream);
    const failures: number[] = [];

    for (let cut = 0; cut <= bytes.length; cut += 1) {
      const state = createAttentionScanState();
      const first = scanTerminalAttention(bytes.slice(0, cut).buffer, state);
      const second = scanTerminalAttention(bytes.slice(cut).buffer, state);
      const found = [...first.notifications, ...second.notifications];
      if (
        found.length !== 1 ||
        found[0].body !== "Odysseus — аналог ChatGPT с агентами"
      ) {
        failures.push(cut);
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps working with a state that predates the decoder", () => {
    // Состояние живёт в панели дольше модуля: после hot reload в dev-режиме
    // сюда приходит объект, собранный прежней версией кода.
    const stale = createAttentionScanState() as Record<string, unknown>;
    delete stale.decoder;

    const result = scanTerminalAttention(
      new TextEncoder().encode("\x1b]9;Готово\x07").buffer,
      stale as ReturnType<typeof createAttentionScanState>,
    );

    expect(result.notifications[0]?.title).toBe("Готово");
  });

  it("scans binary chunks too", () => {
    const bytes = new Uint8Array([104, 7, 105]).buffer;
    expect(scanTerminalAttention(bytes, createAttentionScanState()).bells).toBe(
      1,
    );
  });

  it("extracts OSC 9 and OSC 777 notifications", () => {
    const state = createAttentionScanState();
    const result = scanTerminalAttention(
      "\x1b]9;Agent turn complete\x1b\\" +
        "\x1b]777;notify;Permission needed;Approve Bash\x07",
      state,
    );
    expect(result.bells).toBe(0);
    expect(result.notifications).toEqual([
      {
        protocol: "osc9",
        title: "Agent turn complete",
        body: "",
        types: [],
      },
      {
        protocol: "osc777",
        title: "Permission needed",
        body: "Approve Bash",
        types: [],
      },
    ]);
    expect(classifyTerminalNotification(result.notifications[0])).toBe(
      "completed",
    );
    expect(classifyTerminalNotification(result.notifications[1])).toBe(
      "permission",
    );
  });

  it("assembles chunked OSC 99 title, body, and notification type", () => {
    const state = createAttentionScanState();
    const first = scanTerminalAttention(
      "\x1b]99;i=turn-1:d=0:p=title;Codex\x1b\\",
      state,
    );
    expect(first.notifications).toEqual([]);
    const second = scanTerminalAttention(
      "\x1b]99;i=turn-1:p=body:t=cXVlc3Rpb24=;Waiting for input\x1b\\",
      first.state,
    );
    expect(second.notifications).toEqual([
      {
        protocol: "osc99",
        title: "Codex",
        body: "Waiting for input",
        types: ["question"],
      },
    ]);
    expect(classifyTerminalNotification(second.notifications[0])).toBe(
      "question",
    );
  });

  it("drops oversized OSC payloads without turning their terminator into BEL", () => {
    const result = scanTerminalAttention(
      `\x1b]9;${"x".repeat(20_000)}\x07`,
      createAttentionScanState(),
    );
    expect(result.bells).toBe(0);
    expect(result.notifications).toEqual([]);
    expect(result.state.mode).toBe(0);
  });
});

describe("formatAgentAlertDetail", () => {
  it("prefers the body, collapses whitespace, and caps long text", () => {
    expect(
      formatAgentAlertDetail({
        protocol: "osc777",
        title: "Permission needed",
        body: "  Run\n\n npm   test  ",
        types: [],
      }),
    ).toBe("Run npm test");

    const formatted = formatAgentAlertDetail({
      protocol: "osc9",
      title: "x".repeat(250),
      body: "",
      types: [],
    });
    expect(Array.from(formatted)).toHaveLength(200);
    expect(formatted.endsWith("...")).toBe(true);
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
    localStorage.clear();
    mocks.windowFocused.value = false;
    mocks.record.value = { agentId: "claude", command: "claude" };
    setPanelTailResolver(() => null);
    clearAgentAttention("panel-1");
    clearAgentAttention("panel-2");
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
    clearAgentAttention("tail-panel");
    vi.useRealTimers();
  });

  it("keeps the brief mode free of the panel tail", async () => {
    saveAgentAlertDetailMode("brief");
    setWorkspaceNameResolver(() => "ModelCrew");
    setPanelTailResolver(() => "Готово: обновил 3 файла");

    trackAgentOutput(engaged("brief-panel"), "brief-panel", "\x07", () => hidden);
    await settle();

    expect(mocks.systemNotification).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.stringContaining("Готово"),
    );
    clearAgentAttention("brief-panel");
    vi.useRealTimers();
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
    clearAgentAttention("permission-panel");
    vi.useRealTimers();
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
    clearAgentAttention("detailed-panel");
    vi.useRealTimers();
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
    clearAgentAttention("sanitized-detail-panel");
    vi.useRealTimers();
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
    clearAgentAttention("detailed-bell-panel");
    vi.useRealTimers();
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
    clearAgentAttention("precise-restored-panel");
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
