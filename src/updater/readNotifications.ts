export const READ_NOTIFICATIONS_STORAGE_KEY =
  "modelcrew.notifications.readIds.v1";

const MAX_READ_NOTIFICATION_IDS = 100;

function normalizeReadIds(ids: readonly string[]): string[] {
  const newestFirst: string[] = [];
  const seen = new Set<string>();

  for (let index = ids.length - 1; index >= 0; index -= 1) {
    const id = ids[index];
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    newestFirst.push(id);
    if (newestFirst.length === MAX_READ_NOTIFICATION_IDS) {
      break;
    }
  }

  return newestFirst.reverse();
}

export function loadReadNotificationIds(): string[] {
  try {
    const value = localStorage.getItem(READ_NOTIFICATIONS_STORAGE_KEY);
    if (!value) {
      return [];
    }
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeReadIds(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return [];
  }
}

export function markNotificationIdsRead(
  currentIds: readonly string[],
  visibleIds: readonly string[],
): string[] {
  const nextIds = normalizeReadIds([...currentIds, ...visibleIds]);
  try {
    localStorage.setItem(READ_NOTIFICATIONS_STORAGE_KEY, JSON.stringify(nextIds));
  } catch {
    // Read state remains valid for the current session when storage is unavailable.
  }
  return nextIds;
}

// Скрытые пользователем уведомления (анонсы). Хранятся так же, как read-ids:
// повторная доставка того же анонса не должна воскресить скрытую карточку.
export const DISMISSED_NOTIFICATIONS_STORAGE_KEY =
  "modelcrew.notifications.dismissedIds.v1";

export function loadDismissedNotificationIds(): string[] {
  try {
    const value = localStorage.getItem(DISMISSED_NOTIFICATIONS_STORAGE_KEY);
    if (!value) {
      return [];
    }
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeReadIds(
      parsed.filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return [];
  }
}

export function markNotificationIdsDismissed(
  currentIds: readonly string[],
  dismissedIds: readonly string[],
): string[] {
  const nextIds = normalizeReadIds([...currentIds, ...dismissedIds]);
  try {
    localStorage.setItem(
      DISMISSED_NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify(nextIds),
    );
  } catch {
    // Скрытие действует в текущей сессии, даже если хранилище недоступно.
  }
  return nextIds;
}
