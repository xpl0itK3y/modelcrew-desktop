import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { READ_NOTIFICATIONS_STORAGE_KEY } from "../updater/readNotifications";
import type {
  AppUpdaterController,
  NotificationCenterState,
  UpdateNotification,
} from "../updater/types";
import { Titlebar } from "./Titlebar";

const readyUpdate: UpdateNotification = {
  id: "update:0.0.2",
  kind: "update",
  installKind: "selfUpdate",
  phase: "ready",
  version: "0.0.2",
  title: "Тихий центр уведомлений",
  summary: "Обновление загружено в фоне.",
  highlights: ["Без ручной проверки"],
  releaseUrl:
    "https://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v0.0.2",
};

function controller(center: NotificationCenterState): AppUpdaterController {
  return {
    enabled: false,
    center,
    ensureChecked: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    openRelease: vi.fn(async () => {}),
    dismissNotification: vi.fn(),
  };
}

function titlebar(updater: AppUpdaterController) {
  return (
    <Titlebar
      workspaceName="modelcrew"
      workspaceFolder="/Users/denis/github/modelcrew-desktop"
      sidebarVisible
      gitCounts={{ additions: 12, deletions: 3, files: 2 }}
      onToggleSidebar={vi.fn()}
      onNewTerminal={vi.fn()}
      onArrangeGrid={vi.fn()}
      onOpenSettings={vi.fn()}
      onOpenGitChanges={vi.fn()}
      updater={updater}
    />
  );
}

afterEach(() => setLocale("ru"));

describe("Titlebar notification center", () => {
  it("is always active and checks immediately when opened", () => {
    const updater = controller({ sync: "settled", items: [] });
    render(titlebar(updater));

    const bell = screen.getByRole("button", { name: "Уведомления" });
    expect(bell).toBeEnabled();
    fireEvent.click(bell);

    expect(updater.ensureChecked).toHaveBeenCalledTimes(1);
    const dialog = screen.getByRole("dialog", { name: "Уведомления" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("Пока нет уведомлений")).toBeInTheDocument();
  });

  it("marks a ready update read and preserves that state after remount", async () => {
    const updater = controller({ sync: "settled", items: [readyUpdate] });
    const first = render(titlebar(updater));
    const bell = screen.getByRole("button", {
      name: "Обновление 0.0.2 готово",
    });
    expect(document.querySelector(".notification-badge")).toBeInTheDocument();

    fireEvent.click(bell);
    await waitFor(() =>
      expect(document.querySelector(".notification-badge")).not.toBeInTheDocument(),
    );
    expect(
      JSON.parse(localStorage.getItem(READ_NOTIFICATIONS_STORAGE_KEY) ?? "[]"),
    ).toContain(readyUpdate.id);

    first.unmount();
    render(titlebar(updater));
    expect(document.querySelector(".notification-badge")).not.toBeInTheDocument();
  });

  it("marks an update read when it appears while the center is open", async () => {
    const updater = controller({ sync: "settled", items: [] });
    const view = render(titlebar(updater));
    fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));

    const withUpdate: AppUpdaterController = {
      ...updater,
      center: { sync: "settled", items: [readyUpdate] },
    };
    view.rerender(titlebar(withUpdate));

    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(READ_NOTIFICATIONS_STORAGE_KEY) ?? "[]"),
      ).toContain(readyUpdate.id),
    );
    expect(document.querySelector(".notification-badge")).not.toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the bell", async () => {
    render(titlebar(controller({ sync: "settled", items: [] })));
    const bell = screen.getByRole("button", { name: "Уведомления" });
    fireEvent.click(bell);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    // Поповер доигрывает exit-анимацию, затем размонтируется.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(bell).toHaveFocus());
  });

  it("closes on an outside pointer press", async () => {
    render(titlebar(controller({ sync: "settled", items: [] })));
    fireEvent.click(screen.getByRole("button", { name: "Уведомления" }));
    fireEvent.pointerDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("shows download progress on the bell without an unread badge", () => {
    render(
      titlebar(
        controller({
          sync: "settled",
          items: [
            {
              ...readyUpdate,
              phase: "downloading",
              downloaded: 30,
              total: 100,
            },
          ],
        }),
      ),
    );
    expect(document.querySelector(".notification-download")).toBeInTheDocument();
    expect(document.querySelector(".notification-badge")).not.toBeInTheDocument();
  });

  it("announces native authorization without exposing backend details", () => {
    render(
      titlebar(
        controller({
          sync: "settled",
          items: [
            {
              ...readyUpdate,
              installKind: "nativePackage",
              phase: "authorizing",
            },
          ],
        }),
      ),
    );

    expect(
      document.querySelector(".update-live-region"),
    ).toHaveTextContent("Ожидаем системное подтверждение");
  });
});
