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
  amendCommit: vi.fn(async () => {}),
  squashCommit: vi.fn(async () => {}),
  dropCommit: vi.fn(async () => {}),
  resetToCommit: vi.fn(async () => {}),
  createTag: vi.fn(async () => {}),
  deleteTag: vi.fn(async () => {}),
  commitPatch: vi.fn(async () => "PATCH BODY"),
  saveCommitPatch: vi.fn(async () => true),
  githubCommitUrl: vi.fn<() => Promise<string | null>>(async () => null),
  openUrl: vi.fn(async () => {}),
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
    amendCommit: mocks.amendCommit,
    squashCommit: mocks.squashCommit,
    dropCommit: mocks.dropCommit,
    resetToCommit: mocks.resetToCommit,
    createTag: mocks.createTag,
    deleteTag: mocks.deleteTag,
    commitPatch: mocks.commitPatch,
    saveCommitPatch: mocks.saveCommitPatch,
    githubCommitUrl: mocks.githubCommitUrl,
    fetchBranches: mocks.fetchBranches,
    fetchLog: mocks.fetchLog,
    refreshGitChanges: mocks.refreshGitChanges,
  };
});

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

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

function emitSummary(workspaceId: string, next: GitChangesSummary): void {
  mocks.summaries.set(workspaceId, next);
  for (const listener of mocks.listeners.get(workspaceId) ?? []) {
    listener(next);
  }
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

function taggableCommit(): GitCommitInfo {
  return {
    hash: "9999999999999999999999999999999999999999",
    shortHash: "9999999",
    subject: "tag me",
    author: "Denis",
    authorEmail: "denis@example.com",
    epochMs: Date.now(),
    unpushed: false,
    localOnly: false,
    editable: false,
    isHead: false,
    parents: ["5555555555555555555555555555555555555555"],
    refs: [],
    refDetails: [],
    remoteRefs: [],
    fullMessage: "tag me",
  };
}

describe("GitChangesView workspace lifecycle", () => {
  it("keeps a separate draft per project while preserving the selected tab", () => {
    const view = render(<GitChangesView workspaceId="project-a" />);

    expect(screen.getByText("from-a.txt")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Заголовок коммита"), {
      target: { value: "draft for A" },
    });
    fireEvent.click(screen.getByRole("tab", { name: "История" }));

    view.rerender(<GitChangesView workspaceId="project-b" />);
    expect(screen.queryByText("from-a.txt")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "История" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Изменения" }));
    expect(screen.getByText("from-b.txt")).toBeInTheDocument();
    expect(screen.getByLabelText("Заголовок коммита")).toHaveValue("");

    view.rerender(<GitChangesView workspaceId="project-a" />);
    expect(screen.queryByText("from-b.txt")).not.toBeInTheDocument();
    expect(screen.getByText("from-a.txt")).toBeInTheDocument();
    expect(screen.getByLabelText("Заголовок коммита")).toHaveValue(
      "draft for A",
    );
  });

  it("commits a subject and optional description as one Git message", async () => {
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.change(screen.getByLabelText("Заголовок коммита"), {
      target: { value: "feat: history controls" },
    });
    fireEvent.change(screen.getByLabelText("Описание (необязательно)"), {
      target: { value: "Adds local branch management." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Коммит" }));

    await waitFor(() =>
      expect(mocks.commitAll).toHaveBeenCalledWith(
        "project-a",
        "feat: history controls\n\nAdds local branch management.",
      ),
    );
  });

  it("ignores an older history response that finishes after a refresh", async () => {
    let resolveOld!: (commits: GitCommitInfo[]) => void;
    let resolveNew!: (commits: GitCommitInfo[]) => void;
    mocks.fetchLog
      .mockImplementationOnce(
        () =>
          new Promise<GitCommitInfo[]>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<GitCommitInfo[]>((resolve) => {
            resolveNew = resolve;
          }),
      );
    const makeCommit = (hash: string, subject: string): GitCommitInfo => ({
      hash: hash.repeat(40),
      shortHash: hash.repeat(7),
      subject,
      author: "Denis",
      authorEmail: "denis@example.com",
      epochMs: Date.now(),
      unpushed: true,
      localOnly: true,
      editable: true,
      isHead: true,
      parents: [],
      refs: ["main"],
      refDetails: [
        { name: "main", fullName: "refs/heads/main", kind: "local" },
      ],
      remoteRefs: [],
      fullMessage: subject,
    });

    render(<GitChangesView workspaceId="project-a" />);
    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    await waitFor(() => expect(mocks.fetchLog).toHaveBeenCalledTimes(1));

    emitSummary("project-a", summary("main", "from-a.txt"));
    await waitFor(() => expect(mocks.fetchLog).toHaveBeenCalledTimes(2));
    resolveNew([makeCommit("b", "new history")]);
    expect(await screen.findByText("new history")).toBeInTheDocument();

    resolveOld([makeCommit("a", "stale history")]);
    await waitFor(() =>
      expect(screen.queryByText("stale history")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("new history")).toBeInTheDocument();
  });

  it("keeps Co-authored-by trailers visible when editing a message", async () => {
    const fullMessage =
      "feat: shared work\n\nDetailed body.  \n\nCo-authored-by: Alex <alex@example.com>\n\n";
    mocks.fetchLog.mockResolvedValue([
      {
        hash: "1111111111111111111111111111111111111111",
        shortHash: "1111111",
        subject: "feat: shared work",
        author: "Denis",
        authorEmail: "denis@example.com",
        epochMs: Date.now(),
        unpushed: true,
        localOnly: true,
        editable: true,
        isHead: true,
        parents: ["0000000000000000000000000000000000000000"],
        refs: ["main"],
        refDetails: [
          { name: "main", fullName: "refs/heads/main", kind: "local" },
        ],
        remoteRefs: [],
        fullMessage,
        body: "Detailed body.",
        coAuthors: ["Alex <alex@example.com>"],
      },
    ]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(await screen.findByTitle("Действия над коммитом"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Изменить сообщение" }));

    const editor = screen.getByRole("dialog").querySelector("textarea");
    expect(editor).toHaveValue(fullMessage);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(mocks.rewordCommit).toHaveBeenCalledWith(
        "project-a",
        "1111111111111111111111111111111111111111",
        fullMessage,
      ),
    );
  });

  it("keeps the reword editor and edited text open after a backend failure", async () => {
    mocks.rewordCommit.mockRejectedValueOnce({
      code: "git_command_failed",
      context: { reason: "head-moved" },
    });
    mocks.fetchLog.mockResolvedValue([
      {
        hash: "5555555555555555555555555555555555555555",
        shortHash: "5555555",
        subject: "old subject",
        author: "Denis",
        authorEmail: "denis@example.com",
        epochMs: Date.now(),
        unpushed: true,
        localOnly: true,
        editable: true,
        isHead: true,
        parents: ["4444444444444444444444444444444444444444"],
        refs: ["main"],
        refDetails: [
          { name: "main", fullName: "refs/heads/main", kind: "local" },
        ],
        remoteRefs: [],
        fullMessage: "old subject\n\nold body",
      },
    ]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(await screen.findByTitle("Действия над коммитом"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Изменить сообщение" }));
    const editor = screen.getByRole("dialog").querySelector("textarea");
    expect(editor).not.toBeNull();
    fireEvent.change(editor!, { target: { value: "new subject\n\nnew body" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() =>
      expect(mocks.rewordCommit).toHaveBeenCalledWith(
        "project-a",
        "5555555555555555555555555555555555555555",
        "new subject\n\nnew body",
      ),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog").querySelector("textarea")).toHaveValue(
      "new subject\n\nnew body",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "История ветки успела измениться",
    );
  });

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

  it("rewrites history only against the head the panel showed", async () => {
    const head = "7777777777777777777777777777777777777777";
    mocks.summaries.set("project-a", {
      ...summary("main", "from-a.txt"),
      headHash: head,
    });
    mocks.fetchLog.mockResolvedValue([
      {
        hash: head,
        shortHash: "7777777",
        subject: "local tip",
        author: "Denis",
        authorEmail: "denis@example.com",
        epochMs: Date.now(),
        unpushed: true,
        localOnly: true,
        editable: true,
        isHead: true,
        parents: ["5555555555555555555555555555555555555555"],
        refs: [],
        refDetails: [],
        remoteRefs: [],
        fullMessage: "local tip",
      },
    ]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(await screen.findByTitle("Действия над коммитом"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Дополнить последний коммит" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));

    await waitFor(() =>
      expect(mocks.amendCommit).toHaveBeenCalledWith("project-a", head),
    );
  });

  it("offers no history rewriting for a commit that is already pushed", async () => {
    mocks.summaries.set("project-a", {
      ...summary("main", "from-a.txt"),
      headHash: "8888888888888888888888888888888888888888",
    });
    mocks.fetchLog.mockResolvedValue([
      {
        hash: "8888888888888888888888888888888888888888",
        shortHash: "8888888",
        subject: "pushed tip",
        author: "Denis",
        authorEmail: "denis@example.com",
        epochMs: Date.now(),
        unpushed: false,
        localOnly: false,
        editable: false,
        isHead: true,
        parents: ["5555555555555555555555555555555555555555"],
        refs: [],
        refDetails: [],
        remoteRefs: [],
        fullMessage: "pushed tip",
      },
    ]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(await screen.findByTitle("Действия над коммитом"));

    for (const name of [
      "Дополнить последний коммит",
      "Объединить с предыдущим",
      "Удалить коммит из истории",
    ]) {
      expect(screen.queryByRole("menuitem", { name })).not.toBeInTheDocument();
    }
    // Откатить чужой или уже отправленный коммит новым — по-прежнему можно.
    expect(
      screen.getByRole("menuitem", { name: "Откатить этот коммит" }),
    ).toBeInTheDocument();
  });

  it("tags the commit the menu was opened on", async () => {
    mocks.fetchLog.mockResolvedValue([taggableCommit()]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(await screen.findByTitle("Действия над коммитом"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Создать тег…" }));
    fireEvent.change(screen.getByLabelText("имя тега"), {
      target: { value: "v2.0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Создать" }));

    await waitFor(() =>
      expect(mocks.createTag).toHaveBeenCalledWith(
        "project-a",
        "v2.0",
        "9999999999999999999999999999999999999999",
      ),
    );
  });

  it("explains that a commit link needs a GitHub remote", async () => {
    mocks.fetchLog.mockResolvedValue([taggableCommit()]);
    mocks.githubCommitUrl.mockResolvedValue(null);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(await screen.findByTitle("Действия над коммитом"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Открыть на GitHub" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "нет remote на GitHub",
    );
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("opens the commit page when the repository lives on GitHub", async () => {
    mocks.fetchLog.mockResolvedValue([taggableCommit()]);
    mocks.githubCommitUrl.mockResolvedValue("https://github.com/o/r/commit/9");
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(await screen.findByTitle("Действия над коммитом"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Открыть на GitHub" }));

    await waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledWith(
        "https://github.com/o/r/commit/9",
      ),
    );
  });

  it("copies the exact full message without reordering mixed trailers", async () => {
    const fullMessage =
      "feat: exact message\n\nBody.\n\nCo-authored-by: Alex <alex@example.com>\nSigned-off-by: Sam <sam@example.com>\nCo-authored-by: Kim <kim@example.com>";
    mocks.fetchLog.mockResolvedValue([
      {
        hash: "2222222222222222222222222222222222222222",
        shortHash: "2222222",
        subject: "feat: exact message",
        author: "Denis",
        authorEmail: "denis@example.com",
        epochMs: Date.now(),
        unpushed: true,
        localOnly: true,
        editable: true,
        isHead: true,
        parents: ["1111111111111111111111111111111111111111"],
        refs: ["main"],
        refDetails: [
          { name: "main", fullName: "refs/heads/main", kind: "local" },
        ],
        remoteRefs: [],
        fullMessage,
        body: "Body.\n\nSigned-off-by: Sam <sam@example.com>",
        coAuthors: ["Alex <alex@example.com>", "Kim <kim@example.com>"],
      },
    ]);
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(screen.getByRole("tab", { name: "История" }));
    fireEvent.click(await screen.findByTitle("Действия над коммитом"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Скопировать сообщение" }),
    );

    await waitFor(() =>
      expect(mocks.writeClipboard).toHaveBeenCalledWith(fullMessage),
    );
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
  it("clears a stale reset confirmation and binds the new one", async () => {
    const confirmedHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    mocks.summaries.set("project-a", {
      ...summary("main", "from-a.txt"),
      headHash: confirmedHead,
      ahead: 2,
      behind: 1,
    });
    render(<GitChangesView workspaceId="project-a" />);

    fireEvent.click(
      screen.getByTitle("Ветка разошлась с сервером — выберите, как забрать"),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Выровнять историю по серверу",
      }),
    );

    // Имитируем параллельное переключение ветки после первого подтверждения.
    const nextHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    emitSummary("project-a", {
      ...summary("other", "from-a.txt"),
      headHash: nextHead,
      ahead: 2,
      behind: 1,
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", {
          name: "Сохранить правки и выровнять?",
        }),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByTitle("Ветка разошлась с сервером — выберите, как забрать"),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Выровнять историю по серверу",
      }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Сохранить правки и выровнять?",
      }),
    );

    await waitFor(() =>
      expect(mocks.gitResetToUpstream).toHaveBeenCalledWith(
        "project-a",
        "other",
        nextHead,
      ),
    );
  });

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
