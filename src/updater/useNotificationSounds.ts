import { useEffect, useState } from "react";
import {
  playNotificationSound,
  selectUnseenNotificationSoundIds,
} from "../sound";
import { loadReadNotificationIds } from "./readNotifications";
import type { NotificationItem } from "./types";

// Plays the notification sound once per newly arrived attention-worthy item.
// Read notifications stay quiet after restart, while an unread update can
// still announce itself the next time the app discovers it.
export function useNotificationSounds(items: readonly NotificationItem[]) {
  const [handledIds] = useState(() => new Set(loadReadNotificationIds()));

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
  }, [handledIds, items]);
}
