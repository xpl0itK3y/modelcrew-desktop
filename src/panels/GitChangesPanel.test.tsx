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
  it("hides uncommit while HEAD is detached", async () => {
    mocks.summaries.set("project-a", {
      ...summary("main", "from-a.txt"),
      branch: undefined,
    });
    mocks.fetchLog.mockResolvedValue([
      {
        hash: "6666666666666666666666666666666666666666",
        shortHash: "6666666",
        subject: "detached commit",
        author: "Denis",
        authorEmail: "denis@example.com",
        epochMs: Date.now(),
        unpushed: true,
        localOnly: true,
        editable: false,
        isHead: true,
        parents: ["5555555555555555555555555555555555555555"],
        refs: [],
        refDetails: [],
        remoteRefs: [],
        fullMessage: "detached commit",
      },
    ]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(await screen.findByTitle("Действия над коммитом"));

    expect(
      screen.queryByRole("menuitem", {
        name: "Отменить последний локальный коммит",
      }),
    ).not.toBeInTheDocument();
  });

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

describe("sync confirmation", () => {
  it("passes the confirmed branch and HEAD to push", async () => {
    const head = "cccccccccccccccccccccccccccccccccccccccc";
    mocks.summaries.set("project-a", {
      ...summary("main", "from-a.txt"),
      headHash: head,
      ahead: 1,
      behind: 0,
    });
    render(<GitChangesView workspaceId="project-a" />);

    const push = screen.getByTitle("Отправить локальные коммиты на сервер");
    fireEvent.click(push);
    fireEvent.click(screen.getByRole("button", { name: "Запушить?" }));

    await waitFor(() =>
      expect(mocks.gitPush).toHaveBeenCalledWith("project-a", "main", head),
    );
  });
});

describe("BranchSwitcher local management", () => {
  it("ignores a branch-list response from a previous menu opening", async () => {
    let resolveOld!: (branches: GitBranchInfo[]) => void;
    let resolveNew!: (branches: GitBranchInfo[]) => void;
    mocks.fetchBranches
      .mockImplementationOnce(
        () =>
          new Promise<GitBranchInfo[]>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<GitBranchInfo[]>((resolve) => {
            resolveNew = resolve;
          }),
      );
    const branch = (name: string): GitBranchInfo => ({
      name,
      refName: `refs/heads/${name}`,
      tipHash: name === "old" ? "a".repeat(40) : "b".repeat(40),
      isCurrent: false,
      isRemote: false,
      isMerged: true,
    });

    render(<GitChangesView workspaceId="project-a" />);
    const switcher = screen.getByTitle("Переключить ветку");
    fireEvent.click(switcher);
    await waitFor(() => expect(mocks.fetchBranches).toHaveBeenCalledTimes(1));
    fireEvent.click(switcher);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Переключить ветку" }))
        .not.toBeInTheDocument(),
    );
    fireEvent.click(switcher);
    await waitFor(() => expect(mocks.fetchBranches).toHaveBeenCalledTimes(2));

    resolveNew([branch("new")]);
    expect(await screen.findByText("new")).toBeInTheDocument();
    resolveOld([branch("old")]);
    await waitFor(() =>
      expect(screen.queryByText("old")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("creates a branch from HEAD and confirms deletion of a merged branch", async () => {
    mocks.fetchBranches.mockResolvedValue([
      {
        name: "main",
        refName: "refs/heads/main",
        tipHash: "1111111111111111111111111111111111111111",
        isCurrent: true,
        isRemote: false,
        isMerged: false,
      },
      {
        name: "old-feature",
        refName: "refs/heads/old-feature",
        tipHash: "2222222222222222222222222222222222222222",
        isCurrent: false,
        isRemote: false,
        isMerged: true,
      },
    ]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByTitle("Переключить ветку"));
    await screen.findByText("Новая ветка от HEAD");
    fireEvent.click(screen.getByText("Новая ветка от HEAD"));
    fireEvent.change(screen.getByLabelText("имя ветки"), {
      target: { value: "feature/history" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() =>
      expect(mocks.createBranch).toHaveBeenCalledWith(
        "project-a",
        "feature/history",
      ),
    );

    fireEvent.click(screen.getByTitle("Переключить ветку"));
    await screen.findByLabelText("Удалить ветку «old-feature»");
    fireEvent.click(screen.getByLabelText("Удалить ветку «old-feature»"));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Ветка на сервере останется",
    );
    fireEvent.click(screen.getByRole("button", { name: "Удалить" }));

    await waitFor(() =>
      expect(mocks.deleteBranch).toHaveBeenCalledWith(
        "project-a",
        "old-feature",
        false,
        "2222222222222222222222222222222222222222",
      ),
    );
  });
});
