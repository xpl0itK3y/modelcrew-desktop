// «2 ч. назад» / «2h ago» — компактная подпись давности для коммитов и веток.

// Форматтер Intl строится заметно дольше, чем форматирует: история рисует по
// подписи на каждую из сотни строк, и одни только конструкторы съедали
// несколько миллисекунд каждого кадра. Языков у приложения два — храним
// готовые.
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
const fullDateFormats = new Map<string, Intl.DateTimeFormat>();

// «2 ч. назад» / «2h ago» — компактная подпись давности коммита.
export function formatRelativeTime(
  epochMs: number,
  locale: string,
  now = Date.now(),
): string {
  let formatter = relativeFormats.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeFormats.set(locale, formatter);
  }
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

// «6 нояб. 2026 г., 14:05» — точная дата для подсказки к давности.
export function formatFullDate(epochMs: number, locale: string): string {
  let formatter = fullDateFormats.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    fullDateFormats.set(locale, formatter);
  }
  return formatter.format(new Date(epochMs));
}
