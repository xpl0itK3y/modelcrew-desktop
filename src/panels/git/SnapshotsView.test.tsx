// Список снимков: что видит человек, ищущий затёртую работу, и что делает
// кнопка возврата.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchSnapshots: vi.fn(),
  restore: vi.fn(async () => {}),
  refresh: vi.fn(async () => {}),
  autoTitle: vi.fn<(id: string) => string | undefined>(() => undefined),
}));

vi.mock("../../git/panelSnapshots", () => ({
  fetchPanelSnapshots: mocks.fetchSnapshots,
  restorePanelSnapshot: mocks.restore,
}));
vi.mock("../../git/gitChanges", () => ({
  refreshGitChanges: mocks.refresh,
}));
vi.mock("../../terminal/panelTitles", () => ({
  getAutoTitle: (id: string) => mocks.autoTitle(id),
}));

import { setLocale } from "../../i18n";
import { SnapshotsView } from "./SnapshotsView";

function snapshot(
  panelId: string,
  files: string[],
  epochMs = Date.now() - 60_000,
) {
  return { panelId, commit: `commit-${panelId}`, epochMs, files };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchSnapshots.mockResolvedValue([]);
  mocks.autoTitle.mockReturnValue(undefined);
});

afterEach(() => setLocale("ru"));

describe("SnapshotsView", () => {
  it("explains the empty list instead of showing a blank panel", async () => {
    render(<SnapshotsView workspaceId="ws-1" />);

    await waitFor(() =>
      expect(screen.getByText(/Снимков пока нет/)).toBeInTheDocument(),
    );
  });

  it("names the panel the way the user knows it", async () => {
    mocks.autoTitle.mockImplementation((id) =>
      id === "panel-1" ? "claude" : undefined,
    );
    mocks.fetchSnapshots.mockResolvedValue([
      snapshot("panel-1", ["src/app.ts"]),
      snapshot("panel-2", ["src/other.ts"]),
    ]);

    render(<SnapshotsView workspaceId="ws-1" />);

    // Панель с именем показывается именем, безымянная — коротким id, а не
    // сорока символами uuid.
    await waitFor(() => expect(screen.getByText("claude")).toBeInTheDocument());
    expect(screen.getByText("Панель panel-2")).toBeInTheDocument();
  });

  it("brings a file back and refreshes what the panel shows", async () => {
    mocks.fetchSnapshots.mockResolvedValue([
      snapshot("panel-1", ["src/app.ts"]),
    ]);
    render(<SnapshotsView workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText("src/app.ts")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Вернуть" }));

    await waitFor(() =>
      expect(mocks.restore).toHaveBeenCalledWith("ws-1", "panel-1", "src/app.ts"),
    );
    // Файл вернулся в рабочее дерево — сводка изменений устарела.
    expect(mocks.refresh).toHaveBeenCalledWith("ws-1");
  });

  it("says out loud when the file could not be brought back", async () => {
    mocks.fetchSnapshots.mockResolvedValue([
      snapshot("panel-1", ["src/app.ts"]),
    ]);
    mocks.restore.mockRejectedValueOnce(new Error("нет доступа"));
    render(<SnapshotsView workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText("src/app.ts")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Вернуть" }));

    // Молчаливый отказ здесь хуже всего: человек уверен, что работа вернулась.
    await waitFor(() =>
      expect(document.querySelector(".git-error")).toBeInTheDocument(),
    );
  });

  it("marks a turn that changed nothing", async () => {
    mocks.fetchSnapshots.mockResolvedValue([snapshot("panel-1", [])]);

    render(<SnapshotsView workspaceId="ws-1" />);

    await waitFor(() =>
      expect(screen.getByText("Ход ничего не изменил")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the failure instead of an empty list when the registry is unreadable", async () => {
    mocks.fetchSnapshots.mockRejectedValue(new Error("сломалось"));

    render(<SnapshotsView workspaceId="ws-1" />);

    // Пустой список сказал бы «снимков нет» — это неправда и уводит в сторону.
    await waitFor(() =>
      expect(screen.queryByText(/Снимков пока нет/)).not.toBeInTheDocument(),
    );
  });
});
