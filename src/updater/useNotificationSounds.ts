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

// Баннер уровня ОС шлём только когда окно не в фокусе: в фокусе пользователю
// хватает бейджа и звука, дублировать системным всплытием — спам.
async function notifyInBackground(item: NotificationItem): Promise<void> {
  try {
    if (await getCurrentWindow().isFocused()) {
      return;
    }
  } catch {
    // Веб-превью или ранний старт: статус фокуса неизвестен — не шлём.
    return;
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
      void notifyInBackground(newest);
    }
  }, [handledIds, items]);
}
