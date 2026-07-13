import { beforeEach, describe, expect, it } from "vitest";
import {
  loadReadNotificationIds,
  markNotificationIdsRead,
  READ_NOTIFICATIONS_STORAGE_KEY,
} from "./readNotifications";

describe("read notification persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the newest one hundred unique notification IDs", () => {
    const ids = Array.from({ length: 105 }, (_, index) => `update:${index}`);
    const saved = markNotificationIdsRead([], [...ids, "update:104"]);

    expect(saved).toHaveLength(100);
    expect(saved[0]).toBe("update:5");
    expect(saved[saved.length - 1]).toBe("update:104");
    expect(loadReadNotificationIds()).toEqual(saved);
  });

  it("ignores malformed storage without breaking the notification center", () => {
    localStorage.setItem(READ_NOTIFICATIONS_STORAGE_KEY, "not-json");
    expect(loadReadNotificationIds()).toEqual([]);

    localStorage.setItem(
      READ_NOTIFICATIONS_STORAGE_KEY,
      JSON.stringify(["update:0.0.2", 42, null, "update:0.0.2"]),
    );
    expect(loadReadNotificationIds()).toEqual(["update:0.0.2"]);
  });
});
