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

  it.each([
    ["downloadRetry", "Загрузка не завершилась. Повторим автоматически."],
    ["installing", "Устанавливаем ModelCrew 0.0.2"],
    ["installFailed", "Не удалось установить обновление"],
  ] as const)("renders the %s phase with localized copy", (phase, copy) => {
    renderPopover({ sync: "retrying", items: [notification(phase)] });
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(
      screen.queryByText(/Could not fetch|signature mismatch/i),
    ).not.toBeInTheDocument();
  });

  it("opens the release page for package-managed installations", () => {
    const callbacks = renderPopover({
      sync: "settled",
      items: [notification("packageManaged")],
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

  it("uses the English catalog", () => {
    setLocale("en");
    renderPopover({ sync: "settled", items: [] });
    expect(
      screen.getByRole("heading", { name: "Notifications" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
  });
});
