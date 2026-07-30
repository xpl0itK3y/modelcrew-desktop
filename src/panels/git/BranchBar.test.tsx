// Кнопки синхронизации: что предлагается при каждом состоянии ветки и с каким
// коммитом уходит команда.
//
// Проверяется напрямую: сюда сходятся четыре разных состояния (синхронно,
// отстали, опередили, разошлись), и каждая кнопка отправляет на сервер ровно
// тот HEAD, который подтвердил пользователь.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitPull: vi.fn(async () => {}),
  gitPush: vi.fn(async () => {}),
  gitPullRebase: vi.fn(async () => {}),
  gitResetToUpstream: vi.fn(async () => {}),
  publishBranch: vi.fn(async () => {}),
  refreshGitChanges: vi.fn(async () => {}),
  switchBranch: vi.fn(async () => {}),
}));

vi.mock("../../git/gitSync", () => ({
  gitPull: mocks.gitPull,
  gitPush: mocks.gitPush,
  gitPullRebase: mocks.gitPullRebase,
  gitResetToUpstream: mocks.gitResetToUpstream,
  publishBranch: mocks.publishBranch,
}));
vi.mock("../../git/gitChanges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../git/gitChanges")>()),
  refreshGitChanges: mocks.refreshGitChanges,
}));
vi.mock("../../git/gitBranches", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../git/gitBranches")>()),
  switchBranch: mocks.switchBranch,
}));

import { setLocale } from "../../i18n";
import { DetachedHeadBanner, SyncStatus } from "./BranchBar";

const HEAD = "a".repeat(40);

function sync(props: Partial<Parameters<typeof SyncStatus>[0]> = {}) {
  const onError = vi.fn();
  render(
    <SyncStatus
      workspaceId="ws-1"
      branch="main"
      headHash={HEAD}
      onError={onError}
      {...props}
    />,
  );
  return onError;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => setLocale("ru"));

describe("SyncStatus", () => {
  it("shows a tick and no buttons when nothing is pending", () => {
    sync({ ahead: 0, behind: 0 });

    expect(screen.getByTitle("Синхронизировано с сервером")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("offers the first push while the branch has no upstream", () => {
    // ahead/behind не пришли — сравнивать не с чем, но отправить ветку можно.
    sync({ ahead: undefined, behind: undefined, canPublish: true });

    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("stays silent without an upstream when publishing is not offered", () => {
    const { container } = render(
      <SyncStatus workspaceId="ws-1" branch="main" onError={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("counts what is pending in each direction", () => {
    sync({ ahead: 2, behind: 3 });

    expect(screen.getByRole("button", { name: "↓3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "↑2" })).toBeInTheDocument();
  });

  it("asks once before sending commits to the server", async () => {
    sync({ ahead: 2, behind: 0 });

    fireEvent.click(screen.getByRole("button", { name: "↑2" }));
    // Первый клик — только подтверждение: отправка на сервер необратима.
    expect(mocks.gitPush).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(mocks.gitPush).toHaveBeenCalledWith("ws-1", "main", HEAD),
    );
  });

  it("sends the confirmed head even after the panel moves on", async () => {
    sync({ ahead: 1, behind: 0 });

    fireEvent.click(screen.getByRole("button", { name: "↑1" }));
    fireEvent.click(screen.getByRole("button"));

    // Именно подтверждённый коммит: если терминал закоммитил между показом и
    // подтверждением, бэкенд обязан отказать, а не отправить лишнее.
    await waitFor(() =>
      expect(mocks.gitPush).toHaveBeenCalledWith("ws-1", "main", HEAD),
    );
  });

  it("opens a choice instead of a plain pull for a diverged branch", async () => {
    sync({ ahead: 2, behind: 3 });

    fireEvent.click(screen.getByRole("button", { name: "↓3" }));

    // Простой ff здесь невозможен, поэтому вместо подтверждения — меню.
    expect(mocks.gitPull).not.toHaveBeenCalled();
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);

    fireEvent.click(items[0]);
    await waitFor(() =>
      expect(mocks.gitPullRebase).toHaveBeenCalledWith("ws-1", "main", HEAD),
    );
  });

  it("asks twice before dropping local commits", async () => {
    sync({ ahead: 2, behind: 3 });
    fireEvent.click(screen.getByRole("button", { name: "↓3" }));

    const reset = () => screen.getAllByRole("menuitem")[1];
    fireEvent.click(reset());
    expect(mocks.gitResetToUpstream).not.toHaveBeenCalled();

    fireEvent.click(reset());
    await waitFor(() =>
      expect(mocks.gitResetToUpstream).toHaveBeenCalledWith(
        "ws-1",
        "main",
        HEAD,
      ),
    );
  });

  it("reports a refused sync instead of failing silently", async () => {
    mocks.gitPush.mockRejectedValueOnce(new Error("stale"));
    const onError = sync({ ahead: 1, behind: 0 });

    fireEvent.click(screen.getByRole("button", { name: "↑1" }));
    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(mocks.refreshGitChanges).not.toHaveBeenCalled();
  });
});

describe("DetachedHeadBanner", () => {
  it("offers the branch the user came from", async () => {
    render(
      <DetachedHeadBanner
        workspaceId="ws-1"
        headHash={HEAD}
        previousBranch="main"
        onError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /main/ }));

    await waitFor(() =>
      expect(mocks.switchBranch).toHaveBeenCalledWith("ws-1", "main", "local"),
    );
  });

  it("offers nothing to return to when the branch is gone", () => {
    render(
      <DetachedHeadBanner
        workspaceId="ws-1"
        headHash={HEAD}
        onError={vi.fn()}
      />,
    );

    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
