import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENTS,
  agentChatClaimedNearby,
  bindAgentSession,
  boundAgentSessionIds,
  buildAgentResume,
  getAgentRecord,
  discardAgentRecord,
  isShellProcess,
  loadAgentResumeMode,
  matchAgent,
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
    expect(buildAgentResume(opencode, true)).toBe("opencode --continue");

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
      invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce("late-id");

      scheduleAgentSessionBinding("panel-1", "/tmp/proj", "ws-1");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(getAgentRecord("panel-1")!.sessionId).toBeUndefined();
      await vi.advanceTimersByTimeAsync(7_000);

      expect(getAgentRecord("panel-1")!.sessionId).toBe("late-id");
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
