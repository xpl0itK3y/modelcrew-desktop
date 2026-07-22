import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import type {
  NotificationCenterState,
  UpdateNotification,
  UpdateNotificationPhase,
} from "./types";
import { UpdatePopover } from "./UpdatePopover";

function notification(
  phase: UpdateNotificationPhase,
  overrides: Partial<UpdateNotification> = {},
): UpdateNotification {
  return {
    id: "update:0.0.2",
    kind: "update",
    installKind: "selfUpdate",
    phase,
    version: "0.0.2",
    title: "Тихие обновления",
    summary: "Обновления теперь загружаются в фоне.",
    highlights: ["Без красных технических ошибок", "Спокойный пустой экран"],
    releaseUrl:
      "https://github.com/xpl0itK3y/modelcrew-desktop/releases/tag/v0.0.2",
    ...overrides,
  };
}

function renderPopover(center: NotificationCenterState) {
  const callbacks = {
    onInstall: vi.fn(),
    onOpenRelease: vi.fn(),
    onDismiss: vi.fn(),
    onClose: vi.fn(),
  };
  render(<UpdatePopover center={center} {...callbacks} />);
  return callbacks;
}

afterEach(() => setLocale("ru"));

describe("UpdatePopover", () => {
  it("shows a quiet initial loader and then a buttonless empty state", () => {
    const callbacks = {
      onInstall: vi.fn(),
      onOpenRelease: vi.fn(),
      onDismiss: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(
      <UpdatePopover
        center={{ sync: "initial", items: [] }}
        {...callbacks}
      />,
    );

    expect(screen.getByText("Обновляем уведомления…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /провер/i })).not.toBeInTheDocument();

    rerender(
      <UpdatePopover
        center={{ sync: "settled", items: [] }}
        {...callbacks}
      />,
    );
    expect(screen.getByText("Пока нет уведомлений")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /провер/i })).not.toBeInTheDocument();
  });

  it("renders accessible download progress without interrupting work", () => {
    renderPopover({
      sync: "settled",
      items: [
        notification("downloading", {
          downloaded: 25,
          total: 100,
        }),
      ],
    });

    const progress = screen.getByRole("progressbar", {
      name: "Прогресс загрузки обновления",
    });
    expect(progress).toHaveAttribute("aria-valuemin", "0");
    expect(progress).toHaveAttribute("aria-valuemax", "100");
    expect(progress).toHaveAttribute("aria-valuenow", "25");
    expect(
      screen.getByText("Можно продолжать работать — терминалы не будут закрыты."),
    ).toBeInTheDocument();
  });

  it("requires a separate confirmation before installing a ready update", () => {
    const callbacks = renderPopover({
      sync: "settled",
      items: [notification("ready")],
    });

    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Перезапустить и обновить" }),
    );
    expect(callbacks.onInstall).not.toHaveBeenCalled();
    expect(screen.getByText("Перезапустить ModelCrew?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Перезапустить" }));
    expect(callbacks.onInstall).toHaveBeenCalledTimes(1);
  });

  it("disables install actions during a background refresh", () => {
    renderPopover({
      sync: "checking",
      items: [notification("ready")],
    });

    expect(
      screen.getByRole("button", { name: "Перезапустить и обновить" }),
    ).toBeDisabled();
  });

  it("explains native Linux authorization before a package install", () => {
    const callbacks = renderPopover({
      sync: "settled",
      items: [notification("ready", { installKind: "nativePackage" })],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Перезапустить и обновить" }),
    );
    expect(
      screen.getByText(/Linux запросит системную авторизацию/),
    ).toBeInTheDocument();
    expect(callbacks.onInstall).not.toHaveBeenCalled();
  });

  it("shows the real install command instead of an invented path", () => {
    renderPopover({
      sync: "settled",
      items: [
        notification("installFailed", {
          installKind: "nativePackage",
          manualCommand:
            "sudo pacman -U /home/user/.cache/modelcrew/ModelCrew-0.0.2.pkg.tar.zst",
        }),
      ],
    });

    expect(
      screen.getByText(
        "sudo pacman -U /home/user/.cache/modelcrew/ModelCrew-0.0.2.pkg.tar.zst",
      ),
    ).toBeInTheDocument();
  });

  it("omits the command when the backend did not report a package path", () => {
    renderPopover({
      sync: "settled",
      items: [notification("installFailed", { installKind: "nativePackage" })],
    });

    expect(
      document.querySelector(".update-manual-command"),
    ).not.toBeInTheDocument();
    // Совет про polkit-агент остаётся полезным и без команды.
    expect(screen.getByText(/polkit/)).toBeInTheDocument();
  });

  it.each([
    ["authorizationCancelled", "Повторить установку"],
    ["installFailed", "Повторить установку"],
    ["restartFailed", "Повторить перезапуск"],
  ] as const)(
    "requires fresh restart confirmation when retrying %s",
    (phase, action) => {
      const callbacks = renderPopover({
        sync: "settled",
        items: [notification(phase, { installKind: "nativePackage" })],
      });

      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(callbacks.onInstall).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Перезапустить" }));
      expect(callbacks.onInstall).toHaveBeenCalledTimes(1);
    },
  );

  it("does not promise another Linux authorization when only relaunch failed", () => {
    renderPopover({
      sync: "settled",
      items: [
        notification("restartFailed", { installKind: "nativePackage" }),
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Повторить перезапуск" }),
    );
    expect(
      screen.queryByText(/Linux запросит системную авторизацию/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Терминалы и запущенные процессы будут закрыты/),
    ).toBeInTheDocument();
  });

  it.each([
    ["verifying", "Проверяем загруженное обновление"],
    ["downloadRetry", "Загрузка не завершилась. Повторим автоматически."],
    ["authorizing", "Ожидаем системное подтверждение"],
    ["installing", "Устанавливаем ModelCrew 0.0.2"],
    ["restarting", "Перезапускаем ModelCrew 0.0.2"],
    ["authorizationCancelled", "Установка не подтверждена"],
    ["installFailed", "Не удалось установить обновление"],
    [
      "restartFailed",
      "Обновление установлено, но ModelCrew не перезапустился",
    ],
  ] as const)("renders the %s phase with localized copy", (phase, copy) => {
    renderPopover({ sync: "retrying", items: [notification(phase)] });
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(
      screen.queryByText(/Could not fetch|signature mismatch/i),
    ).not.toBeInTheDocument();
  });

  it("opens the release page only for manual installations", () => {
    const callbacks = renderPopover({
      sync: "settled",
      items: [notification("manual", { installKind: "manual" })],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Открыть страницу загрузки" }),
    );
    expect(callbacks.onOpenRelease).toHaveBeenCalledTimes(1);
  });

  it("renders a future announcement item without updater-specific fields", () => {
    renderPopover({
      sync: "settled",
      items: [
        {
          id: "announcement:welcome",
          kind: "announcement",
          title: "Новые возможности ModelCrew",
          summary: "Информационная карточка не зависит от Tauri updater.",
          highlights: ["Лента объявлений готова к подключению"],
        },
      ],
    });

    expect(
      screen.getByRole("heading", { name: "Новые возможности ModelCrew" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Лента объявлений готова к подключению"),
    ).toBeInTheDocument();
  });

  it("dismisses announcements but never update cards", () => {
    const callbacks = renderPopover({
      sync: "settled",
      items: [
        notification("ready"),
        {
          id: "announcement:welcome",
          kind: "announcement",
          title: "Новые возможности ModelCrew",
          summary: "Информационная карточка.",
          highlights: [],
        },
      ],
    });

    // Крестик скрытия есть только у анонса; карточка обновления защищена.
    const dismissButtons = screen.getAllByRole("button", {
      name: "Скрыть уведомление",
    });
    expect(dismissButtons).toHaveLength(1);

    fireEvent.click(dismissButtons[0]);
    expect(callbacks.onDismiss).toHaveBeenCalledWith("announcement:welcome");
    expect(callbacks.onDismiss).not.toHaveBeenCalledWith("update:0.0.2");
  });

  it("clears all announcements at once from the header", () => {
    const callbacks = renderPopover({
      sync: "settled",
      items: [
        notification("ready"),
        {
          id: "announcement:one",
          kind: "announcement",
          title: "Один",
          summary: "",
          highlights: [],
        },
        {
          id: "announcement:two",
          kind: "announcement",
          title: "Два",
          summary: "",
          highlights: [],
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Очистить" }));
    expect(callbacks.onDismiss).toHaveBeenCalledTimes(2);
    expect(callbacks.onDismiss).toHaveBeenCalledWith("announcement:one");
    expect(callbacks.onDismiss).toHaveBeenCalledWith("announcement:two");
  });

  it("collapses the card visually before reporting the dismissal", () => {
    vi.useFakeTimers();
    try {
      const callbacks = renderPopover({
        sync: "settled",
        items: [
          {
            id: "announcement:animated",
            kind: "announcement",
            title: "Анимация",
            summary: "",
            highlights: [],
          },
        ],
      });
      const card = document.querySelector<HTMLElement>(
        '[data-notification-id="announcement:animated"]',
      )!;
      // jsdom не считает раскладку — даём карточке «реальную» высоту,
      // чтобы сработал анимированный путь скрытия.
      Object.defineProperty(card, "offsetHeight", { value: 120 });

      fireEvent.click(
        screen.getByRole("button", { name: "Скрыть уведомление" }),
      );
      expect(card.classList.contains("is-dismissing")).toBe(true);
      expect(card.style.height).toBe("0px");
      expect(callbacks.onDismiss).not.toHaveBeenCalled();

      vi.advanceTimersByTime(250);
      expect(callbacks.onDismiss).toHaveBeenCalledWith(
        "announcement:animated",
      );
      // Повторный клик по уже схлопывающейся карточке не дублирует скрытие.
      expect(callbacks.onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the clear button when only an update card is present", () => {
    renderPopover({ sync: "settled", items: [notification("ready")] });
    expect(
      screen.queryByRole("button", { name: "Очистить" }),
    ).not.toBeInTheDocument();
  });

  it("uses the English catalog", () => {
    setLocale("en");
    renderPopover({
      sync: "settled",
      items: [notification("authorizing", { installKind: "nativePackage" })],
    });
    expect(
      screen.getByRole("heading", { name: "Notifications" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for system authorization"),
    ).toBeInTheDocument();
  });
});
