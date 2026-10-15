import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENTS,
  agentChatClaimedNearby,
  bindAgentSession,
  bindAgentSessionFromHook,
  bindAgentSessionFromTurn,
  boundAgentSessionIds,
  buildAgentResume,
  getAgentRecord,
  hydrateAgentSessions,
  discardAgentRecord,
  isShellProcess,
  loadAgentResumeMode,
  matchAgent,
  noteAgentTurn,
  noteResumedAgentSession,
  noteSessionWorkspace,
  pruneAgentRecords,
  rememberAgentProcess,
  rememberedSessionId,
  retryAgentSessionBinding,
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
    // Настоящий invoke всегда возвращает промис — иначе долговечное зеркало
    // привязок падало бы на .catch там, где тест о нём и не думает.
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
  });

  it("matches known agent processes case-insensitively", () => {
    expect(matchAgent("claude")?.agent.id).toBe("claude");
    expect(matchAgent("Codex")?.agent.id).toBe("codex");
    expect(matchAgent("COPILOT")?.agent.id).toBe("copilot");
    expect(matchAgent(" opencode ")?.agent.id).toBe("opencode");
    // Снятые с поддержки опознаваться не должны: половинчатая поддержка хуже
    // отсутствия — панель считалась бы агентской, а канала у неё нет.
    for (const gone of [
      "qwen",
      "amp",
      "aider",
      "kilo",
      "kilocode",
      "kimi",
      "kimi-code",
      "grok",
      "cursor-agent",
      "agy",
    ]) {
      expect(matchAgent(gone)).toBeNull();
    }
    expect(matchAgent("zsh")).toBeNull();
    expect(matchAgent("vim")).toBeNull();
    expect(AGENTS.map((agent) => agent.id)).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
    ]);
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

  it("keeps the resumed chat when the watcher rebuilds the record", () => {
    // Полный перезапуск приложения: панель возобновляется в своём чате, но
    // watcher успевает увидеть оболочку раньше, чем поднимется агент, — запись
    // стирается и пересоздаётся уже без id. Панель при этом сидит в известном
    // разговоре, и локатору её искать нечего: без этой заметки он считал бы её
    // ничьей и мог отдать ей чат соседки.
    rememberAgentProcess("panel-1", "codex");
    bindAgentSession("panel-1", "01a060ed-d936-7471-8504-125f981fd64a", "ws-1");

    noteResumedAgentSession("panel-1", "01a060ed-d936-7471-8504-125f981fd64a");
    rememberAgentProcess("panel-1", "zsh");
    expect(getAgentRecord("panel-1")).toBeNull();
    rememberAgentProcess("panel-1", "codex");

    expect(getAgentRecord("panel-1")?.sessionId).toBe(
      "01a060ed-d936-7471-8504-125f981fd64a",
    );
  });

  it("does not stamp the resumed chat onto one started later by hand", () => {
    // Заметка одноразовая: она про один переход «оболочка → агент» сразу после
    // возобновления. Если потом агент вышел в prompt и пользователь запустил
    // его заново, это уже новый разговор — id ему приписывать нельзя, иначе
    // после перезапуска панель откроет не тот чат.
    rememberAgentProcess("panel-1", "codex");
    bindAgentSession("panel-1", "01a060ed-d936-7471-8504-125f981fd64a", "ws-1");

    noteResumedAgentSession("panel-1", "01a060ed-d936-7471-8504-125f981fd64a");
    rememberAgentProcess("panel-1", "zsh");
    rememberAgentProcess("panel-1", "codex");

    rememberAgentProcess("panel-1", "zsh");
    rememberAgentProcess("panel-1", "codex");
    expect(getAgentRecord("panel-1")?.sessionId).toBeUndefined();
  });

  it("does not hand the resumed chat to a panel that lost it to a neighbour", () => {
    // Чат числится за соседкой — заметка устарела, и повторять ею старую
    // ошибку нельзя: две панели в одном разговоре мешают друг другу.
    rememberAgentProcess("panel-1", "codex");
    rememberAgentProcess("panel-2", "codex");
    bindAgentSession("panel-2", "01a060ed-d936-7471-8504-125f981fd64a", "ws-1");

    noteResumedAgentSession("panel-1", "01a060ed-d936-7471-8504-125f981fd64a");
    rememberAgentProcess("panel-1", "zsh");
    rememberAgentProcess("panel-1", "codex");

    expect(getAgentRecord("panel-1")?.sessionId).toBeUndefined();
    expect(getAgentRecord("panel-2")?.sessionId).toBe(
      "01a060ed-d936-7471-8504-125f981fd64a",
    );
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

    rememberAgentProcess("panel-3", "opencode");
    const opencode = getAgentRecord("panel-3")!;
    expect(buildAgentResume(opencode, false)).toBe("opencode --continue");
    // Выбирать диалог при запуске opencode нечем: вместо чужого чата — свой,
    // чистый.
    expect(buildAgentResume(opencode, true)).toBe("opencode");

    rememberAgentProcess("panel-copilot", "copilot");
    const copilot = getAgentRecord("panel-copilot")!;
    expect(buildAgentResume(copilot, false)).toBe("copilot --continue");
    expect(buildAgentResume(copilot, true)).toBe("copilot --resume");
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

    rememberAgentProcess("panel-opencode", "opencode");
    bindAgentSession("panel-opencode", "ses_5f1c2d3e4a5b6c7d");
    expect(buildAgentResume(getAgentRecord("panel-opencode")!, false)).toBe(
      "opencode --session ses_5f1c2d3e4a5b6c7d",
    );

    rememberAgentProcess("panel-copilot", "copilot");
    bindAgentSession(
      "panel-copilot",
      "3a659d2e-1bb9-4814-8525-cb190c8d6e77",
    );
    expect(buildAgentResume(getAgentRecord("panel-copilot")!, false)).toBe(
      "copilot --resume 3a659d2e-1bb9-4814-8525-cb190c8d6e77",
    );

    // Многословная команда возобновления собирается по порядку аргументов.
    expect(
      buildAgentResume(
        { agentId: "codex", command: "codex", sessionId: "T-1" },
        false,
      ),
    ).toBe("codex resume T-1");
    // Снятый с поддержки агент команды не даёт — панель просто останется
    // обычным терминалом.
    expect(
      buildAgentResume(
        { agentId: "aider", command: "aider", sessionId: "ignored" },
        false,
      ),
    ).toBeNull();
  });

  it("never hands two panels the same chat through the fallback", () => {
    // Единственная команда возобновления без «кроме этих» — «продолжить
    // последний». Ни один агент не должен получать её, когда чат в этой папке
    // уже за кем-то числится: у кого есть список диалогов — покажет список, у
    // кого нет — начнёт с чистого.
    for (const agent of AGENTS) {
      const line = buildAgentResume(
        { agentId: agent.id, command: agent.processNames[0]! },
        true,
      );
      expect(line, `${agent.id}: нет запасного варианта`).not.toBeNull();
      expect(
        line,
        `${agent.id}: список диалогов совпал с «продолжить последний»`,
      ).not.toBe(
        buildAgentResume(
          { agentId: agent.id, command: agent.processNames[0]! },
          false,
        ),
      );
    }
  });

  it("takes the agent's own word over a locator guess", () => {
    // Локатор угадал чужой диалог для panel-1 — окно времени широкое, файлы
    // соседей рядом. Потом хук самой panel-2 назвал этот диалог своим: два
    // процесса в один чат не пишут, значит догадка была неверной.
    rememberAgentProcess("panel-1", "claude");
    rememberAgentProcess("panel-2", "claude");
    bindAgentSession("panel-1", "chat-x", "ws-1");
    // Обычная привязка отступила бы: id занят.
    expect(bindAgentSession("panel-2", "chat-x", "ws-1")).toBe(false);

    expect(bindAgentSessionFromHook("panel-2", "chat-x", "ws-1")).toBe(true);
    expect(getAgentRecord("panel-2")!.sessionId).toBe("chat-x");
    expect(rememberedSessionId("panel-2", "claude")).toBe("chat-x");
    // У ошибшейся панели догадка снята — она перепривяжется к своему.
    expect(getAgentRecord("panel-1")!.sessionId).toBeUndefined();
    expect(rememberedSessionId("panel-1", "claude")).toBeUndefined();
  });

  it("ignores a hook binding for a panel with no agent yet", () => {
    expect(bindAgentSessionFromHook("panel-unknown", "chat-x", "ws-1")).toBe(
      false,
    );
    expect(rememberedSessionId("panel-unknown", "claude")).toBeUndefined();
  });

  it("refuses a malformed id from a hook", () => {
    rememberAgentProcess("panel-1", "claude");
    expect(bindAgentSessionFromHook("panel-1", "bad id; rm -rf /", "ws-1")).toBe(
      false,
    );
    expect(getAgentRecord("panel-1")!.sessionId).toBeUndefined();
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

  it("keeps a chat claimed by a panel that stepped out to the shell", () => {
    // Ровно состояние из отчёта: у первой панели агент вышел в оболочку, и её
    // запись потеряла id, хотя диалог остался за ней. Пока владение считали по
    // одним записям, чат становился ничьим.
    rememberAgentProcess("panel-1", "claude");
    bindAgentSession("panel-1", "chat-of-panel-1", "ws-1");
    rememberAgentProcess("panel-1", "zsh");
    expect(getAgentRecord("panel-1")).toBeNull();

    rememberAgentProcess("panel-2", "claude");
    // Локатор соседки обязан пропустить этот чат.
    expect(boundAgentSessionIds("claude", "panel-2")).toEqual([
      "chat-of-panel-1",
    ]);
    // И привязать его к соседке нельзя даже напрямую.
    expect(bindAgentSession("panel-2", "chat-of-panel-1", "ws-1")).toBe(false);
    // А своя панель этот чат по-прежнему продолжает.
    expect(rememberedSessionId("panel-1", "claude")).toBe("chat-of-panel-1");
  });

  it("refuses the last chat when a neighbour in the folder owns one", () => {
    rememberAgentProcess("panel-1", "claude");
    bindAgentSession("panel-1", "chat-of-panel-1", "ws-1");

    // Панель без своей привязки в той же папке: «продолжить последний» открыл
    // бы самый свежий чат папки — тот самый, что займёт panel-1.
    expect(agentChatClaimedNearby("claude", "panel-2", "ws-1")).toBe(true);
    // В другой папке чужой чат не мешает: --continue там свой.
    expect(agentChatClaimedNearby("claude", "panel-2", "ws-2")).toBe(false);
    // Другой агент — другой список диалогов.
    expect(agentChatClaimedNearby("codex", "panel-2", "ws-1")).toBe(false);
    // Своя же привязка себе не соседка.
    expect(agentChatClaimedNearby("claude", "panel-1", "ws-1")).toBe(false);
  });

  it("treats a session remembered without a folder as a neighbour", () => {
    // Записи прежних версий папку не помнят. Ошибаемся в сторону списка
    // диалогов: он хуже точного возобновления, но лучше двух панелей в одном
    // разговоре.
    localStorage.setItem(
      "modelcrew.agentSessions",
      JSON.stringify({
        "panel-1": { agentId: "claude", sessionId: "chat-from-old-version" },
      }),
    );
    expect(agentChatClaimedNearby("claude", "panel-2", "ws-1")).toBe(true);
    expect(agentChatClaimedNearby("claude", "panel-2", "ws-9")).toBe(true);
  });

  it("fills the folder in for a chat bound before the field existed", async () => {
    vi.useFakeTimers();
    try {
      // Панель обновилась с привязанным чатом. Локатор к ней больше не зайдёт —
      // у записи есть id, — так что дописать папку может только watcher.
      rememberAgentProcess("panel-1", "claude");
      bindAgentSession("panel-1", "old-chat");
      localStorage.setItem(
        "modelcrew.agentSessions",
        JSON.stringify({ "panel-1": { agentId: "claude", sessionId: "old-chat" } }),
      );
      // Без папки соседкой считается любая панель в любом проекте.
      expect(agentChatClaimedNearby("claude", "panel-2", "ws-2")).toBe(true);

      scheduleAgentSessionBinding("panel-1", "/tmp/proj", "ws-1");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(rememberedSessionId("panel-1", "claude")).toBe("old-chat");
      // Чужой проект больше не заложник давней привязки.
      expect(agentChatClaimedNearby("claude", "panel-2", "ws-2")).toBe(false);
      expect(agentChatClaimedNearby("claude", "panel-2", "ws-1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a duplicate chat with the panel whose record holds it", () => {
    // Наследие: агент panel-a вышел в оболочку и запись потерял, а чат числится
    // за panel-b. Ключи сортируются в пользу panel-a — но право у записи.
    rememberAgentProcess("panel-b", "claude");
    localStorage.setItem(
      "modelcrew.terminalAgents",
      JSON.stringify({
        "panel-b": {
          agentId: "claude",
          command: "claude",
          detectedAt: 1,
          sessionId: "one-chat",
        },
      }),
    );
    localStorage.setItem(
      "modelcrew.agentSessions",
      JSON.stringify({
        "panel-a": { agentId: "claude", sessionId: "one-chat", workspaceId: "ws-1" },
        "panel-b": { agentId: "claude", sessionId: "one-chat", workspaceId: "ws-1" },
      }),
    );
    pruneAgentRecords(["panel-a", "panel-b"]);

    expect(rememberedSessionId("panel-b", "claude")).toBe("one-chat");
    expect(rememberedSessionId("panel-a", "claude")).toBeUndefined();
    // И panel-a видит, что чат в этой папке занят: список диалогов, а не
    // --continue, который открыл бы тот же самый разговор.
    expect(agentChatClaimedNearby("claude", "panel-a", "ws-1")).toBe(true);
  });

  it("keeps the folder a session already knows", () => {
    rememberAgentProcess("panel-1", "claude");
    bindAgentSession("panel-1", "chat-1", "ws-1");
    noteSessionWorkspace("panel-1", "ws-9");
    expect(agentChatClaimedNearby("claude", "panel-2", "ws-1")).toBe(true);
    expect(agentChatClaimedNearby("claude", "panel-2", "ws-9")).toBe(false);
  });

  it("strips duplicate remembered chats during pruning", () => {
    localStorage.setItem(
      "modelcrew.agentSessions",
      JSON.stringify({
        "panel-1": { agentId: "claude", sessionId: "one-chat" },
        "panel-2": { agentId: "claude", sessionId: "one-chat" },
        "panel-3": { agentId: "codex", sessionId: "one-chat" },
      }),
    );
    pruneAgentRecords(["panel-1", "panel-2", "panel-3"]);
    // Диалог остаётся за первой панелью, у второй запасного варианта больше
    // нет — она возобновится списком и перепривяжется к своему.
    expect(rememberedSessionId("panel-1", "claude")).toBe("one-chat");
    expect(rememberedSessionId("panel-2", "claude")).toBeUndefined();
    // У другого агента id из своего пространства имён — его не трогаем.
    expect(rememberedSessionId("panel-3", "codex")).toBe("one-chat");
  });

  it("strips duplicate session bindings during pruning", () => {
    rememberAgentProcess("panel-1", "opencode");
    rememberAgentProcess("panel-2", "opencode");
    rememberAgentProcess("panel-3", "claude");
    bindAgentSession("panel-1", "conv-1");
    // Дубль в хранилище имитирует наследие старой гонки локаторов.
    localStorage.setItem(
      "modelcrew.terminalAgents",
      JSON.stringify({
        "panel-1": { agentId: "opencode", command: "opencode", detectedAt: 1, sessionId: "conv-1" },
        "panel-2": { agentId: "opencode", command: "opencode", detectedAt: 2, sessionId: "conv-1" },
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
    rememberAgentProcess("panel-1", "opencode");
    rememberAgentProcess("panel-2", "opencode");
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

      scheduleAgentSessionBinding("panel-1", "/tmp/proj", "ws-1");
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
      // По имени команды, а не по счёту вызовов: этим путём ходит не один
      // локатор, и очередь ответов доставалась бы кому попало.
      let attempt = 0;
      invokeMock.mockImplementation((command: string) => {
        if (command !== "agent_session_locate") {
          return Promise.resolve(null);
        }
        attempt += 1;
        return Promise.resolve(attempt === 1 ? null : "late-id");
      });

      scheduleAgentSessionBinding("panel-1", "/tmp/proj", "ws-1");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(getAgentRecord("panel-1")!.sessionId).toBeUndefined();
      await vi.advanceTimersByTimeAsync(7_000);

      expect(getAgentRecord("panel-1")!.sessionId).toBe("late-id");
    } finally {
      vi.useRealTimers();
    }
  });

  it("searches around the retry, not around the launch", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      rememberAgentProcess("panel-late", "codex");
      invokeMock.mockResolvedValue(null);
      scheduleAgentSessionBinding("panel-late", "/tmp/proj", "ws-1");
      await vi.advanceTimersByTimeAsync(30_000);
      // При обнаружении отсчёт идёт от запуска агента.
      expect(invokeMock).toHaveBeenCalledWith(
        "agent_session_locate",
        expect.objectContaining({ sinceEpochMs: 1_000_000 }),
      );

      // Пользователь написал через полчаса: окно бэкенда вокруг запуска давно
      // закрылось, и искать надо вокруг этой минуты.
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      invokeMock.mockClear();
      invokeMock.mockResolvedValue("late-session");
      retryAgentSessionBinding("panel-late");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(invokeMock).toHaveBeenCalledWith(
        "agent_session_locate",
        expect.objectContaining({ sinceEpochMs: 1_000_000 + 30_000 + 30 * 60_000 }),
      );
      expect(getAgentRecord("panel-late")!.sessionId).toBe("late-session");
    } finally {
      vi.useRealTimers();
    }
  });

  it("binds the session when the user writes long after the panel opened", async () => {
    vi.useFakeTimers();
    try {
      rememberAgentProcess("panel-late", "codex");
      // Пользователь открыл панель, почитал код и написал через минуту: пока
      // сообщения не было, файла сессии не существует, и все попытки после
      // запуска уходят впустую.
      invokeMock.mockResolvedValue(null);
      scheduleAgentSessionBinding("panel-late", "/tmp/proj", "ws-1");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getAgentRecord("panel-late")!.sessionId).toBeUndefined();

      // Первое сообщение создало файл — привязка обязана состояться, иначе
      // после перезапуска панель откроет список диалогов вместо своего.
      invokeMock.mockResolvedValue("session-after-first-message");
      retryAgentSessionBinding("panel-late");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(getAgentRecord("panel-late")!.sessionId).toBe(
        "session-after-first-message",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("costs nothing for a panel that is already bound", async () => {
    vi.useFakeTimers();
    try {
      rememberAgentProcess("panel-bound", "codex");
      bindAgentSession("panel-bound", "already-bound");
      invokeMock.mockClear();

      retryAgentSessionBinding("panel-bound");
      await vi.advanceTimersByTimeAsync(60_000);

      // Ввод в такую панель идёт постоянно — ходить за локатором на каждую
      // букву было бы расточительно.
      expect(invokeMock).not.toHaveBeenCalled();
      expect(getAgentRecord("panel-bound")!.sessionId).toBe("already-bound");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts watching an agent store the first time that agent appears", async () => {
    // Каталог разговоров создаёт сам агент: пока он ни разу не запускался,
    // следить не за чем. Поэтому проба повторяется на каждого нового агента.
    // Модуль берём свежий: список уже опрошенных агентов живёт ровно один
    // запуск приложения, а в файле тестов их много.
    vi.resetModules();
    const agents = await import("./agents");
    const watchCalls = () =>
      invokeMock.mock.calls.filter(
        ([command]) => command === "agent_sessions_watch",
      ).length;

    agents.rememberAgentProcess("panel-1", "codex");
    invokeMock.mockClear();
    agents.scheduleAgentSessionBinding("panel-1", "/project", "ws-1");
    expect(watchCalls()).toBe(1);

    // Тот же агент во второй панели — повторять незачем.
    agents.rememberAgentProcess("panel-2", "codex");
    invokeMock.mockClear();
    agents.scheduleAgentSessionBinding("panel-2", "/project", "ws-1");
    expect(watchCalls()).toBe(0);

    // Новый агент — новая проба: его каталог мог появиться только что.
    agents.rememberAgentProcess("panel-3", "claude");
    invokeMock.mockClear();
    agents.scheduleAgentSessionBinding("panel-3", "/project", "ws-1");
    expect(watchCalls()).toBe(1);
  });

  it("writes every binding through to the durable store", async () => {
    // Хранилище вебвью — рабочая копия, а не дом: чистка данных сайта, другая
    // сборка, переустановка — и разговоров нет. В файл уходит каждое движение.
    rememberAgentProcess("panel-1", "codex");
    invokeMock.mockClear();

    bindAgentSession("panel-1", "01a060ed-d936", "ws-1");
    expect(invokeMock).toHaveBeenCalledWith("agent_sessions_remember", {
      panelId: "panel-1",
      agentId: "codex",
      sessionId: "01a060ed-d936",
      workspaceId: "ws-1",
    });

    invokeMock.mockClear();
    discardAgentRecord("panel-1");
    expect(invokeMock).toHaveBeenCalledWith("agent_sessions_forget", {
      panelId: "panel-1",
    });
  });

  it("does not rewrite the store when nothing about the binding changed", async () => {
    rememberAgentProcess("panel-1", "codex");
    bindAgentSession("panel-1", "01a060ed-d936", "ws-1");
    invokeMock.mockClear();

    // Та же привязка ещё раз — и папка та же: писать в файл нечего.
    bindAgentSession("panel-1", "01a060ed-d936", "ws-1");
    noteSessionWorkspace("panel-1", "ws-1");

    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "agent_sessions_remember",
      ),
    ).toEqual([]);
  });

  it("brings conversations back from the store when the webview store is empty", async () => {
    // Ровно тот случай, ради которого всё затевалось: пользователь открыл
    // приложение, у вебвью пусто — а разговоры на месте.
    invokeMock.mockImplementation((command: string) =>
      command === "agent_sessions_all"
        ? Promise.resolve([
            {
              panelId: "panel-1",
              agentId: "codex",
              sessionId: "01a060ed-d936",
              workspaceId: "ws-1",
              updatedAt: 1,
            },
            {
              panelId: "panel-gone",
              agentId: "claude",
              sessionId: "closed-panel-chat",
              updatedAt: 2,
            },
          ])
        : Promise.resolve(null),
    );

    await hydrateAgentSessions(["panel-1"]);

    rememberAgentProcess("panel-1", "codex");
    expect(rememberedSessionId("panel-1", "codex")).toBe("01a060ed-d936");
    // Панели больше нет — воскрешать её разговор незачем, и файл об этом
    // узнает тем же заходом.
    expect(rememberedSessionId("panel-gone", "claude")).toBeUndefined();
    expect(invokeMock).toHaveBeenCalledWith("agent_sessions_keep", {
      keep: ["panel-1"],
    });
  });

  it("carries bindings from an older version into the store", async () => {
    // До этой версии привязки жили только в вебвью. Первый запуск обязан их
    // перенести, иначе «фишка» у всех разом начнётся с чистого листа.
    rememberAgentProcess("panel-1", "codex");
    bindAgentSession("panel-1", "01a060ed-d936", "ws-1");
    invokeMock.mockClear();
    invokeMock.mockImplementation((command: string) =>
      command === "agent_sessions_all"
        ? Promise.resolve([])
        : Promise.resolve(null),
    );

    await hydrateAgentSessions(["panel-1"]);

    expect(invokeMock).toHaveBeenCalledWith("agent_sessions_remember", {
      panelId: "panel-1",
      agentId: "codex",
      sessionId: "01a060ed-d936",
      workspaceId: "ws-1",
    });
  });

  it("keeps the working copy when the store cannot be read", async () => {
    rememberAgentProcess("panel-1", "codex");
    bindAgentSession("panel-1", "01a060ed-d936", "ws-1");
    invokeMock.mockRejectedValue(new Error("файл недоступен"));

    await hydrateAgentSessions(["panel-1"]);

    expect(rememberedSessionId("panel-1", "codex")).toBe("01a060ed-d936");
  });

  it("stays quiet for a panel without an agent", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockClear();

      retryAgentSessionBinding("panel-plain-shell");
      await vi.advanceTimersByTimeAsync(60_000);

      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the session id after the agent quits to the shell", () => {
    rememberAgentProcess("panel-1", "codex");
    bindAgentSession("panel-1", "session-kept");

    // Вышли из агента в оболочку: запись стёрта, но диалог панели никуда не
    // делся — и в следующий раз она должна открыть именно его.
    rememberAgentProcess("panel-1", "zsh");
    expect(getAgentRecord("panel-1")).toBeNull();

    expect(rememberedSessionId("panel-1", "codex")).toBe("session-kept");
    // Другой агент в той же панели чужую сессию не получает.
    expect(rememberedSessionId("panel-1", "claude")).toBeUndefined();
  });

  it("does not let two panels end up in one chat", () => {
    rememberAgentProcess("panel-1", "codex");
    bindAgentSession("panel-1", "shared-session");
    rememberAgentProcess("panel-1", "zsh");

    // Соседка тянется к тому же диалогу. Раньше захват проходил, а чат потом
    // отбирали у обеих; теперь его отклоняют сразу — владелец остаётся один.
    rememberAgentProcess("panel-2", "codex");
    expect(bindAgentSession("panel-2", "shared-session")).toBe(false);

    expect(rememberedSessionId("panel-1", "codex")).toBe("shared-session");
    expect(rememberedSessionId("panel-2", "codex")).toBeUndefined();
    expect(getAgentRecord("panel-2")!.sessionId).toBeUndefined();
  });

  it("forgets the remembered session together with the panel", () => {
    rememberAgentProcess("panel-1", "codex");
    bindAgentSession("panel-1", "session-gone");
    rememberAgentProcess("panel-2", "codex");
    bindAgentSession("panel-2", "session-stays");

    discardAgentRecord("panel-1");
    expect(rememberedSessionId("panel-1", "codex")).toBeUndefined();
    expect(rememberedSessionId("panel-2", "codex")).toBe("session-stays");

    pruneAgentRecords([]);
    expect(rememberedSessionId("panel-2", "codex")).toBeUndefined();
  });

  it("persists the resume mode and defaults to auto", () => {
    expect(loadAgentResumeMode()).toBe("auto");
    saveAgentResumeMode("insert");
    expect(loadAgentResumeMode()).toBe("insert");
    localStorage.setItem("modelcrew.agentResumeMode", "garbage");
    expect(loadAgentResumeMode()).toBe("auto");
  });
});

describe("binding a codex panel by the turn its Enter started", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Ответы по имени команды: локатор по свежести бежит рядом и спрашивает о
  // своём, а сюда должны приходить только вопросы про ход.
  function answerTurns(answers: (string | null)[]): void {
    invokeMock.mockImplementation((command: string) => {
      if (command !== "agent_session_locate_turn") {
        return Promise.resolve(null);
      }
      return Promise.resolve(answers.length > 0 ? answers.shift() : null);
    });
  }

  function turnCalls(): unknown[][] {
    return invokeMock.mock.calls.filter(
      ([command]) => command === "agent_session_locate_turn",
    );
  }

  function openCodex(panel: string): void {
    rememberAgentProcess(panel, "codex");
    scheduleAgentSessionBinding(panel, "/tmp/proj", "ws-1");
  }

  it("gives a free panel the conversation its turn began in", async () => {
    vi.setSystemTime(5_000_000);
    openCodex("turn-free");
    answerTurns(["chat-mine"]);

    noteAgentTurn("turn-free");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(turnCalls()).toEqual([
      [
        "agent_session_locate_turn",
        { agent: "codex", cwd: "/tmp/proj", turnEpochMs: 5_000_000 },
      ],
    ]);
    expect(getAgentRecord("turn-free")!.sessionId).toBe("chat-mine");
    // Привязка запомнена вместе с папкой — переживёт и выход агента.
    rememberAgentProcess("turn-free", "zsh");
    expect(rememberedSessionId("turn-free", "codex")).toBe("chat-mine");
    expect(agentChatClaimedNearby("codex", "someone-else", "ws-1")).toBe(true);
  });

  it("asks again while the turn is not in the journal yet, then stops", async () => {
    openCodex("turn-late");
    answerTurns([null, null, "chat-late"]);

    noteAgentTurn("turn-late");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAgentRecord("turn-late")!.sessionId).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(getAgentRecord("turn-late")!.sessionId).toBe("chat-late");

    // Три вопроса на нажатие, и больше ни одного.
    openCodex("turn-silent");
    invokeMock.mockClear();
    answerTurns([]);
    noteAgentTurn("turn-silent");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(turnCalls()).toHaveLength(3);
  });

  it("listens to the latest Enter only", async () => {
    vi.setSystemTime(7_000_000);
    openCodex("turn-twice");
    answerTurns([]);

    noteAgentTurn("turn-twice");
    await vi.advanceTimersByTimeAsync(1_000);
    noteAgentTurn("turn-twice");
    await vi.advanceTimersByTimeAsync(2_000);

    // Первый вопрос так и не ушёл: его ход сошёл бы за второй голос.
    expect(turnCalls()).toEqual([
      [
        "agent_session_locate_turn",
        expect.objectContaining({ turnEpochMs: 7_001_000 }),
      ],
    ]);
  });

  it("leaves agents whose hook names the session alone", async () => {
    rememberAgentProcess("turn-claude", "claude");
    scheduleAgentSessionBinding("turn-claude", "/tmp/proj", "ws-1");

    noteAgentTurn("turn-claude");
    await vi.advanceTimersByTimeAsync(15_000);

    expect(turnCalls()).toEqual([]);
  });

  it("forgets a pending question when the panel is closed", async () => {
    openCodex("turn-closed");
    noteAgentTurn("turn-closed");
    discardAgentRecord("turn-closed");
    await vi.advanceTimersByTimeAsync(15_000);

    expect(turnCalls()).toEqual([]);
  });

  it("takes a neighbour's chat only on a second independent turn", () => {
    rememberAgentProcess("turn-a", "codex");
    rememberAgentProcess("turn-b", "codex");
    // Догадка по свежести отдала соседке чужой чат.
    bindAgentSession("turn-b", "chat-x", "ws-1");

    // Один Enter мог и не начать ход: в окно попал ход самой соседки.
    expect(bindAgentSessionFromTurn("turn-a", "chat-x", 1_000, "ws-1")).toBe(
      false,
    );
    expect(getAgentRecord("turn-b")!.sessionId).toBe("chat-x");
    // Окна пересекаются — это тот же ход, а не второй.
    expect(bindAgentSessionFromTurn("turn-a", "chat-x", 6_000, "ws-1")).toBe(
      false,
    );

    expect(bindAgentSessionFromTurn("turn-a", "chat-x", 12_000, "ws-1")).toBe(
      true,
    );
    expect(getAgentRecord("turn-a")!.sessionId).toBe("chat-x");
    expect(getAgentRecord("turn-b")!.sessionId).toBeUndefined();
    expect(rememberedSessionId("turn-b", "codex")).toBeUndefined();
  });

  it("follows the panel into another conversation opened inside the agent", () => {
    rememberAgentProcess("turn-switch", "codex");
    bindAgentSession("turn-switch", "chat-old", "ws-1");

    expect(
      bindAgentSessionFromTurn("turn-switch", "chat-new", 0, "ws-1"),
    ).toBe(false);
    // Голос за другой чат начинает счёт заново.
    expect(
      bindAgentSessionFromTurn("turn-switch", "chat-other", 20_000, "ws-1"),
    ).toBe(false);
    expect(
      bindAgentSessionFromTurn("turn-switch", "chat-new", 40_000, "ws-1"),
    ).toBe(false);
    expect(getAgentRecord("turn-switch")!.sessionId).toBe("chat-old");

    expect(
      bindAgentSessionFromTurn("turn-switch", "chat-new", 60_000, "ws-1"),
    ).toBe(true);
    expect(getAgentRecord("turn-switch")!.sessionId).toBe("chat-new");
    expect(rememberedSessionId("turn-switch", "codex")).toBe("chat-new");
  });

  it("refuses an id that could not be a session", () => {
    rememberAgentProcess("turn-hostile", "codex");
    expect(
      bindAgentSessionFromTurn("turn-hostile", "; rm -rf ~", 0, "ws-1"),
    ).toBe(false);
    expect(getAgentRecord("turn-hostile")!.sessionId).toBeUndefined();
  });
});
