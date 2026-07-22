import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localizeBackendError, setLocale } from "../i18n";
import type {
  GitBranchInfo,
  GitChangesSummary,
  GitCommitInfo,
} from "../git/gitChanges";

const mocks = vi.hoisted(() => ({
  summaries: new Map<string, GitChangesSummary>(),
  listeners: new Map<
    string,
    Set<(summary: GitChangesSummary) => void>
  >(),
  commitAll: vi.fn(async () => {}),
  createBranch: vi.fn(async () => {}),
  renameBranch: vi.fn(async () => {}),
  deleteBranch: vi.fn(async () => {}),
  switchBranch: vi.fn(async () => {}),
  gitPull: vi.fn(async () => {}),
  gitPush: vi.fn(async () => {}),
  gitPullRebase: vi.fn(async () => {}),
  gitResetToUpstream: vi.fn(async () => {}),
  rewordCommit: vi.fn(async () => {}),
  writeClipboard: vi.fn(async () => {}),
  fetchBranches: vi.fn<() => Promise<GitBranchInfo[]>>(async () => []),
  fetchLog: vi.fn<() => Promise<GitCommitInfo[]>>(async () => []),
  refreshGitChanges: vi.fn(async () => {}),
}));

vi.mock("../git/gitChanges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../git/gitChanges")>();
  return {
    ...actual,
    getGitSummary: (workspaceId: string) =>
      mocks.summaries.get(workspaceId) ?? null,
    subscribeGitChanges: vi.fn(
      (
        workspaceId: string,
        listener: (summary: GitChangesSummary) => void,
      ) => {
        const listeners = mocks.listeners.get(workspaceId) ?? new Set();
        listeners.add(listener);
        mocks.listeners.set(workspaceId, listeners);
        return () => listeners.delete(listener);
      },
    ),
    commitAll: mocks.commitAll,
    createBranch: mocks.createBranch,
    renameBranch: mocks.renameBranch,
    deleteBranch: mocks.deleteBranch,
    switchBranch: mocks.switchBranch,
    gitPull: mocks.gitPull,
    gitPush: mocks.gitPush,
    gitPullRebase: mocks.gitPullRebase,
    gitResetToUpstream: mocks.gitResetToUpstream,
    rewordCommit: mocks.rewordCommit,
    fetchBranches: mocks.fetchBranches,
    fetchLog: mocks.fetchLog,
    refreshGitChanges: mocks.refreshGitChanges,
  };
});

vi.mock("../git/githubAvatars", () => ({
  githubAvatarForEmail: () => null,
  loadGithubCommitAvatars: vi.fn(),
  subscribeGithubAvatars: () => () => {},
}));

import { GitChangesView } from "./GitChangesPanel";

function summary(branch: string, path: string): GitChangesSummary {
  return {
    isRepo: true,
    branch,
    files: [
      {
        path,
        status: "modified",
        additions: 1,
        deletions: 0,
      },
    ],
  };
}


beforeEach(() => {
  vi.clearAllMocks();
  mocks.summaries.clear();
  mocks.listeners.clear();
  mocks.summaries.set("project-a", summary("main", "from-a.txt"));
  mocks.summaries.set("project-b", summary("dev", "from-b.txt"));
  mocks.fetchBranches.mockResolvedValue([]);
  mocks.fetchLog.mockResolvedValue([]);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeClipboard },
  });
  setLocale("ru");
});

afterEach(() => setLocale("ru"));

describe("GitChangesView workspace lifecycle", () => {
  it("switches a tag as a tag even when its display name looks like a branch", async () => {
    mocks.fetchLog.mockResolvedValue([
      {
        hash: "3333333333333333333333333333333333333333",
        shortHash: "3333333",
        subject: "release",
        author: "Denis",
        authorEmail: "denis@example.com",
        epochMs: Date.now(),
        unpushed: false,
        localOnly: false,
        editable: false,
        isHead: false,
        parents: [],
        refs: ["release", "release"],
        refDetails: [
          {
            name: "release",
            fullName: "refs/heads/release",
            kind: "local",
          },
          {
            name: "release",
            fullName: "refs/tags/release",
            kind: "tag",
          },
        ],
        remoteRefs: [],
        fullMessage: "release",
      },
    ]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    const tag = await screen.findByTitle("Перейти на тег release (HEAD отделится)");
    fireEvent.click(tag);

    await waitFor(() =>
      expect(mocks.switchBranch).toHaveBeenCalledWith(
        "project-a",
        "release",
        "tag",
      ),
    );
  });

  it("passes the exact full ref when switching a remote history badge", async () => {
    mocks.fetchLog.mockResolvedValue([
      {
        hash: "4444444444444444444444444444444444444444",
        shortHash: "4444444",
        subject: "remote tip",
        author: "Denis",
        authorEmail: "denis@example.com",
        epochMs: Date.now(),
        unpushed: false,
        localOnly: false,
        editable: false,
        isHead: false,
        parents: [],
        refs: ["origin/topic"],
        refDetails: [
          {
            name: "origin/topic",
            fullName: "refs/remotes/origin/topic",
            kind: "remote",
          },
        ],
        remoteRefs: ["origin/topic"],
        fullMessage: "remote tip",
      },
    ]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(
      await screen.findByTitle(
        "Создать локальную ветку и перейти на origin/topic",
      ),
    );

    await waitFor(() =>
      expect(mocks.switchBranch).toHaveBeenCalledWith(
        "project-a",
        "refs/remotes/origin/topic",
        "remote",
      ),
    );
  });
});

describe("Git action errors", () => {
  it("shows a specific localized reason instead of a generic Git failure", () => {
    expect(
      localizeBackendError({
        code: "git_command_failed",
        context: { reason: "branch-current", branch: "main" },
      }),
    ).toBe("Нельзя удалить текущую ветку «main»");
  });

  it("localizes an unmerged-branch refusal", () => {
    expect(
      localizeBackendError({
        code: "git_command_failed",
        context: { reason: "branch-unmerged", branch: "topic" },
      }),
    ).toBe(
      "Ветка «topic» не влита в текущую ветку. Для удаления нужно отдельное принудительное подтверждение",
    );
  });

  it("localizes an invalid upstream instead of showing a generic Git error", () => {
    expect(
      localizeBackendError({
        code: "git_command_failed",
        context: { reason: "upstream-invalid" },
      }),
    ).toBe(
      "Не удалось определить корректную серверную ветку для синхронизации",
    );
  });
});

