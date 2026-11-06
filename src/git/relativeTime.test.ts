import { describe, expect, it } from "vitest";

import { formatFullDate, formatRelativeTime } from "./relativeTime";

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

describe("formatFullDate", () => {
  it("spells the exact moment in the asked locale", () => {
    const moment = new Date(2026, 10, 6, 14, 5).getTime();
    expect(formatFullDate(moment, "ru")).toContain("2026");
    expect(formatFullDate(moment, "ru")).toContain("14:05");
    expect(formatFullDate(moment, "en")).toContain("Nov");
    // Готовый форматтер одного языка не отвечает за другой.
    expect(formatFullDate(moment, "ru")).not.toContain("Nov");
  });
});
