import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  aggregateCounts,
  changedRange,
  pairDiffLines,
  amendCommit,
  mergeRef,
  publishBranch,
  rebaseOnto,
  authorAvatar,
  commitAction,
  createBranch,
  deleteBranch,
  dropCommit,
  formatRelativeTime,
  gitPull,
  gitPullRebase,
  gitPush,
  parseUnifiedDiff,
  renameBranch,
  resetToCommit,
  resolveAvatarUrl,
  squashCommit,
  type GitChangesSummary,
} from "./gitChanges";

describe("git mutation IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("creates a branch with the expected command arguments", async () => {
    await createBranch("ws-1", "feature/history");

    expect(mocks.invoke).toHaveBeenCalledWith("git_create_branch", {
      workspaceId: "ws-1",
      name: "feature/history",
    });
  });

  it("renames a branch with the expected command arguments", async () => {
    await renameBranch("ws-2", "old-name", "new-name");

    expect(mocks.invoke).toHaveBeenCalledWith("git_rename_branch", {
      workspaceId: "ws-2",
      branch: "old-name",
      newName: "new-name",
    });
  });

  it("deletes a branch with the expected command arguments", async () => {
    await deleteBranch("ws-3", "obsolete", true, "abc123def456");

    expect(mocks.invoke).toHaveBeenCalledWith("git_delete_branch", {
      workspaceId: "ws-3",
      branch: "obsolete",
      force: true,
      expectedTip: "abc123def456",
    });
  });

  it("sends the uncommit action without an optional name", async () => {
    await commitAction("ws-4", "uncommit", "abcdef123456");

    expect(mocks.invoke).toHaveBeenCalledWith("git_commit_action", {
      workspaceId: "ws-4",
      action: "uncommit",
      hash: "abcdef123456",
    });
  });

  it("binds every sync command to the confirmed branch and HEAD", async () => {
    const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await gitPull("ws-5", "main", head);
    await gitPush("ws-5", "main", head);
    await gitPullRebase("ws-5", "main", head);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "git_pull", {
      workspaceId: "ws-5",
      expectedBranch: "main",
      expectedHead: head,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "git_push", {
      workspaceId: "ws-5",
      expectedBranch: "main",
      expectedHead: head,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "git_pull_rebase", {
      workspaceId: "ws-5",
      expectedBranch: "main",
      expectedHead: head,
    });
  });
});

describe("resolveAvatarUrl", () => {
  it("derives GitHub avatars from noreply emails", async () => {
    expect(
      await resolveAvatarUrl("49699333+dependabot[bot]@users.noreply.github.com"),
    ).toBe("https://avatars.githubusercontent.com/u/49699333?s=48&v=4");
    expect(await resolveAvatarUrl("octocat@users.noreply.github.com")).toBe(
      "https://github.com/octocat.png?size=48",
    );
  });

  it("falls back to a Gravatar hash for real emails", async () => {
    const url = await resolveAvatarUrl("Person@Example.com");
    // Хеш от нормализованной (нижний регистр) почты.
    expect(url).toMatch(/^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{64}\?/);
  });

  it("returns null without an email", async () => {
    expect(await resolveAvatarUrl("")).toBeNull();
    expect(await resolveAvatarUrl("not-an-email")).toBeNull();
  });
});

describe("authorAvatar", () => {
  it("takes initials from up to two words", () => {
    expect(authorAvatar("Kenny Van de Maele").initials).toBe("KV");
    expect(authorAvatar("pewdiepie-archdaemon").initials).toBe("PE");
    expect(authorAvatar("Денис").initials).toBe("ДЕ");
    expect(authorAvatar("").initials).toBe("?");
  });

  it("is deterministic and varies by name", () => {
    expect(authorAvatar("Denis").hue).toBe(authorAvatar("Denis").hue);
    expect(authorAvatar("Denis").hue).not.toBe(authorAvatar("Boody").hue);
    expect(authorAvatar("x").hue).toBeGreaterThanOrEqual(0);
    expect(authorAvatar("x").hue).toBeLessThan(360);
  });
});

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

  it("parses single-line hunk headers without counts", () => {
    // git сокращает "@@ -5,1 +7,1 @@" до "@@ -5 +7 @@".
    const lines = parseUnifiedDiff("@@ -5 +7 @@\n-old\n+new\n");
    expect(lines).toEqual([
      { kind: "hunk", text: "@@ -5 +7 @@" },
      { kind: "del", oldLine: 5, text: "old" },
      { kind: "add", newLine: 7, text: "new" },
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

describe("pairDiffLines", () => {
  it("puts a changed block side by side and pads the shorter half", () => {
    const rows = pairDiffLines(parseUnifiedDiff(SAMPLE_DIFF));
    expect(rows).toEqual([
      {
        left: { kind: "context", oldLine: 10, newLine: 10, text: "context line" },
        right: { kind: "context", oldLine: 10, newLine: 10, text: "context line" },
      },
      {
        left: { kind: "del", oldLine: 11, text: "removed line" },
        right: { kind: "add", newLine: 11, text: "added line" },
      },
      // Удалённых строк меньше — вторая добавленная встаёт напротив пустоты.
      { left: undefined, right: { kind: "add", newLine: 12, text: "another added" } },
      {
        left: { kind: "context", oldLine: 12, newLine: 13, text: "tail context" },
        right: { kind: "context", oldLine: 12, newLine: 13, text: "tail context" },
      },
    ]);
  });

  it("leaves the old side empty for a pure addition", () => {
    const rows = pairDiffLines(
      parseUnifiedDiff("@@ -0,0 +1,2 @@\n+one\n+two\n"),
    );
    expect(rows.map((row) => [row.left?.text, row.right?.text])).toEqual([
      [undefined, "one"],
      [undefined, "two"],
    ]);
  });

  it("leaves the new side empty for a pure deletion", () => {
    const rows = pairDiffLines(parseUnifiedDiff("@@ -1,2 +0,0 @@\n-one\n-two\n"));
    expect(rows.map((row) => [row.left?.text, row.right?.text])).toEqual([
      ["one", undefined],
      ["two", undefined],
    ]);
  });

  it("marks a gap between hunks but not before the first one", () => {
    const rows = pairDiffLines(
      parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n"),
    );
    expect(rows.map((row) => row.isGap ?? false)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(pairDiffLines([])).toEqual([]);
  });
});

describe("changedRange", () => {
  it("keeps the shared head and tail outside the highlight", () => {
    const range = changedRange("const value = 1;", "const value = 42;");
    expect(range).not.toBeNull();
    expect("const value = 1;".slice(range!.head, range!.beforeTail)).toBe("1");
    expect("const value = 42;".slice(range!.head, range!.afterTail)).toBe("42");
  });

  it("marks an insertion as an empty range on the old side", () => {
    const range = changedRange("call(a)", "call(a, b)");
    expect("call(a)".slice(range!.head, range!.beforeTail)).toBe("");
    expect("call(a, b)".slice(range!.head, range!.afterTail)).toBe(", b");
  });

  it("has nothing to highlight in identical lines", () => {
    expect(changedRange("same", "same")).toBeNull();
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

describe("formatRelativeTime", () => {
  it("scales units from seconds to years in both locales", () => {
    const now = Date.UTC(2026, 6, 17, 12, 0, 0);
    const minute = 60_000;
    expect(formatRelativeTime(now - 30_000, "ru", now)).toContain("секунд");
    expect(formatRelativeTime(now - 5 * minute, "ru", now)).toContain("минут");
    expect(formatRelativeTime(now - 3 * 60 * minute, "ru", now)).toContain("час");
    expect(formatRelativeTime(now - 4 * 24 * 60 * minute, "ru", now)).toContain(
      "дн",
    );
    expect(
      formatRelativeTime(now - 3 * 30 * 24 * 60 * minute, "ru", now),
    ).toContain("месяц");
    expect(
      formatRelativeTime(now - 2 * 365 * 24 * 60 * minute, "en", now),
    ).toContain("year");
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

describe("history rewriting IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("amends the last commit against the confirmed head", async () => {
    await amendCommit("ws-1", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_amend_commit", {
      workspaceId: "ws-1",
      expectedHead: "a".repeat(40),
      message: undefined,
    });
  });

  it("passes the reset mode and the confirmed head", async () => {
    await resetToCommit("ws-1", "b".repeat(40), "hard", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_reset_to_commit", {
      workspaceId: "ws-1",
      hash: "b".repeat(40),
      mode: "hard",
      expectedHead: "a".repeat(40),
    });
  });

  it("separates squash from fixup", async () => {
    await squashCommit("ws-1", "b".repeat(40), "fixup", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_squash_commit", {
      workspaceId: "ws-1",
      hash: "b".repeat(40),
      mode: "fixup",
      expectedHead: "a".repeat(40),
    });
  });

  it("drops a commit against the confirmed head", async () => {
    await dropCommit("ws-1", "b".repeat(40), "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_drop_commit", {
      workspaceId: "ws-1",
      hash: "b".repeat(40),
      expectedHead: "a".repeat(40),
    });
  });
});

describe("branch integration IPC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("merges a full ref against the confirmed branch and head", async () => {
    await mergeRef("ws-1", "refs/remotes/origin/dev", "main", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_merge_ref", {
      workspaceId: "ws-1",
      reference: "refs/remotes/origin/dev",
      expectedBranch: "main",
      expectedHead: "a".repeat(40),
      noFf: false,
    });
  });

  it("rebases onto a full ref", async () => {
    await rebaseOnto("ws-1", "refs/heads/main", "topic", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_rebase_onto", {
      workspaceId: "ws-1",
      reference: "refs/heads/main",
      expectedBranch: "topic",
      expectedHead: "a".repeat(40),
    });
  });

  it("publishes without forcing a remote choice", async () => {
    await publishBranch("ws-1", "feature/x", "a".repeat(40));

    expect(mocks.invoke).toHaveBeenCalledWith("git_publish_branch", {
      workspaceId: "ws-1",
      expectedBranch: "feature/x",
      expectedHead: "a".repeat(40),
      remote: undefined,
    });
  });
});
