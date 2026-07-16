import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  aggregateCounts,
  parseUnifiedDiff,
  type GitChangesSummary,
} from "./gitChanges";

const SAMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,5 @@ function main() {
 context line
-removed line
+added line
+another added
 tail context
\\ No newline at end of file
`;

describe("parseUnifiedDiff", () => {
  it("numbers old and new lines per hunk and skips headers", () => {
    const lines = parseUnifiedDiff(SAMPLE_DIFF);
    expect(lines).toEqual([
      { kind: "hunk", text: "@@ -10,4 +10,5 @@ function main() {" },
      { kind: "context", oldLine: 10, newLine: 10, text: "context line" },
      { kind: "del", oldLine: 11, text: "removed line" },
      { kind: "add", newLine: 11, text: "added line" },
      { kind: "add", newLine: 12, text: "another added" },
      { kind: "context", oldLine: 12, newLine: 13, text: "tail context" },
    ]);
  });

  it("handles multiple hunks and synthetic new-file diffs", () => {
    const multi = parseUnifiedDiff(
      "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n",
    );
    expect(multi).toEqual([
      { kind: "hunk", text: "@@ -0,0 +1,2 @@" },
      { kind: "add", newLine: 1, text: "one" },
      { kind: "add", newLine: 2, text: "two" },
    ]);
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("aggregateCounts", () => {
  it("sums additions and deletions treating binaries as zero", () => {
    const summary: GitChangesSummary = {
      isRepo: true,
      branch: "main",
      files: [
        { path: "a.ts", status: "modified", additions: 10, deletions: 2 },
        { path: "logo.png", status: "modified" },
        { path: "b.ts", status: "untracked", additions: 5, deletions: 0 },
      ],
    };
    expect(aggregateCounts(summary)).toEqual({
      additions: 15,
      deletions: 2,
      files: 3,
    });
    expect(aggregateCounts(null)).toEqual({
      additions: 0,
      deletions: 0,
      files: 0,
    });
  });
});

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
    const summary: GitChangesSummary = {
      isRepo: true,
      branch: "main",
      files: [],
    };
    mocks.invoke.mockResolvedValue(summary);
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

    mocks.invoke.mockResolvedValue({ ...summary, branch: "dev" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    mocks.invoke.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.invoke).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
