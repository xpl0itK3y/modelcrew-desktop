import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { type GitChangesSummary } from "./gitChanges";

describe("subscribeGitChanges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
  });

  it("notifies subscribers only when the summary actually changes", async () => {
    vi.resetModules();
    const { subscribeGitChanges } = await import("./gitChanges");
    let summary: GitChangesSummary = {
      isRepo: true,
      branch: "main",
      files: [],
    };
    // Вотчер «не поднялся» — стор остаётся на быстром поллинге.
    mocks.invoke.mockImplementation(async (command) =>
      command === "git_changes_summary" ? summary : false,
    );
    const listener = vi.fn();
    const unsubscribe = subscribeGitChanges("ws-1", listener);

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.invoke).toHaveBeenCalledWith("git_changes_summary", {
      workspaceId: "ws-1",
    });
    expect(listener).toHaveBeenCalledTimes(1);

    // Тот же ответ — слушатель молчит; изменение — новое уведомление.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(listener).toHaveBeenCalledTimes(1);

    summary = { ...summary, branch: "dev" };
    await vi.advanceTimersByTimeAsync(3_000);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    // После отписки остаётся только git_changes_unwatch, поллинг остановлен.
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "git_changes_summary",
      ),
    ).toHaveLength(0);
    vi.useRealTimers();
  });
});
