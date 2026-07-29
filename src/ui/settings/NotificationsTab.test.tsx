import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n";
import { NotificationsTab } from "./NotificationsTab";

const { sendNotificationMock, isPermissionGrantedMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
  isPermissionGrantedMock: vi.fn(async () => true),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: isPermissionGrantedMock,
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: sendNotificationMock,
}));

// Настоящий звук в jsdom не проигрывается, а превью дёргается на каждый выбор.
vi.mock("../../sound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sound")>()),
  previewNotificationSound: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  setLocale("ru");
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  sendNotificationMock.mockClear();
  isPermissionGrantedMock.mockClear();
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("system notification test button", () => {
  it("sends a real banner and says what silence would mean", async () => {
    render(<NotificationsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));

    // Отправка асинхронна: сначала спрашивается разрешение.
    await screen.findByText(/Баннер отправлен/u);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock.mock.calls[0][0]).toMatchObject({
      title: expect.stringContaining("ModelCrew"),
      body: expect.stringContaining("Проверка"),
    });
  });

  it("cannot be pressed while system notifications are off", () => {
    localStorage.setItem("modelcrew.systemNotifications", "off");
    render(<NotificationsTab />);

    // Отключённый тумблер молча проглотил бы баннер — проверять было бы нечего.
    expect(screen.getByRole("button", { name: "Проверить" })).toBeDisabled();
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("drops the stale result when the switch is flipped", async () => {
    render(<NotificationsTab />);

    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText(/Баннер отправлен/u);

    fireEvent.click(
      screen.getByRole("switch", { name: "Системные уведомления" }),
    );

    expect(screen.queryByText(/Баннер отправлен/u)).toBeNull();
  });
});
