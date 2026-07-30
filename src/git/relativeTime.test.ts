import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./relativeTime";

describe("formatRelativeTime", () => {
  it("scales units from seconds to years in both locales", () => {
    const now = Date.UTC(2026, 6, 17, 12, 0, 0);
    const minute = 60_000;
    expect(formatRelativeTime(now - 30_000, "ru", now)).toContain("секунд");
    expect(formatRelativeTime(now - 5 * minute, "ru", now)).toContain("минут");
    expect(formatRelativeTime(now - 3 * 60 * minute, "ru", now)).toContain("час");
    expect(formatRelativeTime(now - 4 * 24 * 60 * minute, "ru", now)).toContain(
      "дн",
    );
    expect(
      formatRelativeTime(now - 3 * 30 * 24 * 60 * minute, "ru", now),
    ).toContain("месяц");
    expect(
      formatRelativeTime(now - 2 * 365 * 24 * 60 * minute, "en", now),
    ).toContain("year");
  });
});
