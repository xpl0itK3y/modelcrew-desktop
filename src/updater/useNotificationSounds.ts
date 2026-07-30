import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  loadNotificationSound,
  playNotificationSound,
  prepareNotificationSound,
  selectUnseenNotificationSoundIds,
} from "../sound";
import { sendSystemNotification } from "../notifications";
import { loadReadNotificationIds } from "./readNotifications";
import type { NotificationItem } from "./types";

// Скачанное обновление — единственное уведомление, которое показывается всегда.
// Оно означает «дистрибутив уже на диске, осталось решить: ставить сейчас или
// потом», и решение это принимают один раз. Карточка в колокольчике за
// терминалами теряется, а пропущенное «готово» оставляет пользователя на старой
// версии, хотя новая скачана и ждёт.
function announcedEvenInForeground(item: NotificationItem): boolean {
  return item.kind === "update" && item.phase === "ready";
}

// Остальным баннер уровня ОС нужен, только когда окно не в фокусе: всплытие
// поверх приложения, которое пользователь и так видит, — спам.
async function notifyUser(item: NotificationItem): Promise<void> {
  if (!announcedEvenInForeground(item)) {
    try {
      if (await getCurrentWindow().isFocused()) {
        return;
      }
    } catch {
      // Веб-превью или ранний старт: статус фокуса неизвестен — не шлём.
      return;
    }
  }
  await sendSystemNotification(item.title, item.summary ?? "");
}

// Plays the notification sound once per newly arrived attention-worthy item.
// Read notifications stay quiet after restart, while an unread update can
// still announce itself the next time the app discovers it.
export function useNotificationSounds(items: readonly NotificationItem[]) {
  const [handledIds] = useState(() => new Set(loadReadNotificationIds()));

  // Уведомление приходит внезапно, а звук ещё надо забрать — тянем его
  // заранее, чтобы первое же событие прозвучало вовремя.
  useEffect(() => {
    prepareNotificationSound(loadNotificationSound());
  }, []);

  useEffect(() => {
    // The notification center can mark items read without changing updater
    // state, so refresh persistence whenever its item list changes.
    for (const id of loadReadNotificationIds()) {
      handledIds.add(id);
    }
    const unseenIds = selectUnseenNotificationSoundIds(items, handledIds);
    if (unseenIds.length === 0) {
      return;
    }
    // Mark the whole batch before playback. Even a muted or rejected sound must
    // not be retried on a later render during the same app run.
    for (const id of unseenIds) {
      handledIds.add(id);
    }
    playNotificationSound();
    const newestId = unseenIds[unseenIds.length - 1];
    const newest = items.find((item) => item.id === newestId);
    if (newest) {
      void notifyUser(newest);
    }
  }, [handledIds, items]);
}
