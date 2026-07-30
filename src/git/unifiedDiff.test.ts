import { describe, expect, it } from "vitest";

import type { GitChangesSummary } from "./gitChanges";
import {
  aggregateCounts,
  changedRange,
  pairDiffLines,
  parseUnifiedDiff,
} from "./unifiedDiff";

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
