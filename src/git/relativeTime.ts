// «2 ч. назад» / «2h ago» — компактная подпись давности для коммитов и веток.

// «2 ч. назад» / «2h ago» — компактная подпись давности коммита.
export function formatRelativeTime(
  epochMs: number,
  locale: string,
  now = Date.now(),
): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const seconds = Math.round((epochMs - now) / 1000);
  const absolute = Math.abs(seconds);
  if (absolute < 60) {
    return formatter.format(Math.trunc(seconds / 1), "second");
  }
  if (absolute < 3600) {
    return formatter.format(Math.trunc(seconds / 60), "minute");
  }
  if (absolute < 86_400) {
    return formatter.format(Math.trunc(seconds / 3600), "hour");
  }
  if (absolute < 30 * 86_400) {
    return formatter.format(Math.trunc(seconds / 86_400), "day");
  }
  if (absolute < 365 * 86_400) {
    return formatter.format(Math.trunc(seconds / (30 * 86_400)), "month");
  }
  return formatter.format(Math.trunc(seconds / (365 * 86_400)), "year");
}
