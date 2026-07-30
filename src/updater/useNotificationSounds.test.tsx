// Когда уведомление доходит до системного баннера, а когда хватает звука и
// колокольчика внутри окна.

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  focused: { value: true },
  playSound: vi.fn(),
  systemNotification: vi.fn(async (_title: string, _body: string) => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => mocks.focused.value }),
}));
vi.mock("../notifications", () => ({
  sendSystemNotification: mocks.systemNotification,
}));
vi.mock("../sound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sound")>()),
  playNotificationSound: mocks.playSound,
  prepareNotificationSound: vi.fn(),
}));

import type { NotificationItem, UpdateNotificationPhase } from "./types";
import { useNotificationSounds } from "./useNotificationSounds";

function update(
  phase: UpdateNotificationPhase,
  version = "0.0.13",
): NotificationItem {
  return {
    id: `update:${version}`,
    kind: "update",
    installKind: "selfUpdate",
    phase,
    version,
    title: `Обновление ModelCrew ${version}`,
    summary: "Готово к установке",
    highlights: [],
    releaseUrl: "https://example.test/release",
  };
}

function announcement(id: string): NotificationItem {
  return {
    id: `announcement:${id}`,
    kind: "announcement",
    title: "Новость",
    summary: "Текст новости",
    highlights: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.focused.value = true;
});

describe("useNotificationSounds", () => {
  it("shows a downloaded update even while the user is in the app", async () => {
    // Дистрибутив уже на диске: решение «ставить сейчас или потом» принимают
    // один раз, и потерять его за терминалами нельзя.
    renderHook(() => useNotificationSounds([update("ready")]));

    await waitFor(() =>
      expect(mocks.systemNotification).toHaveBeenCalledWith(
        "Обновление ModelCrew 0.0.13",
        "Готово к установке",
      ),
    );
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
  });

  it("shows a downloaded update when the window is away too", async () => {
    mocks.focused.value = false;
    renderHook(() => useNotificationSounds([update("ready")]));

    await waitFor(() => expect(mocks.systemNotification).toHaveBeenCalled());
  });

  it("keeps the download itself out of the system banner", async () => {
    // Скачивание идёт своим ходом и показывается прогрессом в колокольчике:
    // баннер на каждую фазу превратил бы обновление в череду всплытий.
    renderHook(() =>
      useNotificationSounds([update("downloading"), update("verifying")]),
    );

    await waitFor(() => expect(mocks.playSound).not.toHaveBeenCalled());
    expect(mocks.systemNotification).not.toHaveBeenCalled();
  });

  it("keeps an announcement quiet while the user is in the app", async () => {
    renderHook(() => useNotificationSounds([announcement("news-1")]));

    // Звук зовёт к колокольчику, а баннер поверх открытого окна — спам.
    await waitFor(() => expect(mocks.playSound).toHaveBeenCalledTimes(1));
    expect(mocks.systemNotification).not.toHaveBeenCalled();
  });

  it("sends an announcement once the window is away", async () => {
    mocks.focused.value = false;
    renderHook(() => useNotificationSounds([announcement("news-2")]));

    await waitFor(() => expect(mocks.systemNotification).toHaveBeenCalled());
  });

  it("announces the same update only once", async () => {
    const { rerender } = renderHook(
      ({ items }: { items: NotificationItem[] }) =>
        useNotificationSounds(items),
      { initialProps: { items: [update("ready")] } },
    );
    await waitFor(() => expect(mocks.systemNotification).toHaveBeenCalledTimes(1));

    // Тот же элемент приходит с каждым обновлением состояния апдейтера.
    rerender({ items: [update("ready")] });
    rerender({ items: [update("ready")] });

    expect(mocks.systemNotification).toHaveBeenCalledTimes(1);
    expect(mocks.playSound).toHaveBeenCalledTimes(1);
  });

  it("announces a newer version after the previous one was seen", async () => {
    const { rerender } = renderHook(
      ({ items }: { items: NotificationItem[] }) =>
        useNotificationSounds(items),
      { initialProps: { items: [update("ready", "0.0.13")] } },
    );
    await waitFor(() => expect(mocks.playSound).toHaveBeenCalledTimes(1));

    rerender({ items: [update("ready", "0.0.14")] });

    await waitFor(() => expect(mocks.playSound).toHaveBeenCalledTimes(2));
    expect(mocks.systemNotification).toHaveBeenLastCalledWith(
      "Обновление ModelCrew 0.0.14",
      "Готово к установке",
    );
  });
});
