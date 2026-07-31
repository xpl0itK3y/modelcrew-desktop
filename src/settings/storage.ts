// Единственное место, которое знает про хранилище настроек, и единственный
// список ключей. Раньше двадцать имён были рассыпаны по одиннадцати модулям, а
// try/catch вокруг каждого обращения копировался вручную — где-то со
// значением по умолчанию, где-то молча.
//
// Ключи не меняются: настройки пользователей должны пережить этот переезд.
// Сторож против новых копий — в storage.test.ts.

/** Имена ключей. Значение читает и проверяет тот модуль, которому оно нужно. */
export const KEYS = {
  theme: "modelcrew.theme",
  accent: "modelcrew.accent",
  locale: "modelcrew.locale",
  shell: "modelcrew.shell",
  diffView: "modelcrew.diffView",
  workspaces: "modelcrew.workspaces",

  terminalFontSize: "modelcrew.terminalFontSize",
  terminalHistoryIsolated: "modelcrew.terminalHistoryIsolated",
  terminalSpawnMode: "modelcrew.terminalSpawnMode",
  networkAvatars: "modelcrew.networkAvatars",
  agentAlerts: "modelcrew.agentAlerts",
  agentAlertDetail: "modelcrew.agentAlertDetail",
  agentResumeMode: "modelcrew.agentResumeMode",
  terminalAgents: "modelcrew.terminalAgents",
  agentSessions: "modelcrew.agentSessions",

  notificationSound: "modelcrew.notificationSound",
  notificationVolume: "modelcrew.notificationVolume",
  systemNotifications: "modelcrew.systemNotifications",
  audioHealth: "modelcrew.audioHealth",
  notificationHeight: "modelcrew.notificationHeight",
  readNotifications: "modelcrew.notifications.readIds.v1",
  dismissedNotifications: "modelcrew.notifications.dismissedIds.v1",
} as const;

/**
 * Ключи снятых настроек: значение осталось у пользователей, а настройки уже
 * нет — чистим при старте, чтобы оно не всплыло при возврате функции.
 */
export const RETIRED_KEYS = ["modelcrew.eagerSessionRestore"] as const;

/**
 * Хранилище может быть недоступно (приватный режим, отключённые данные сайта).
 * Тогда настройка живёт до закрытия приложения, но приложение работает — и
 * поэтому эти три функции никогда не бросают.
 */
export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Без хранилища значение действует только до закрытия приложения.
  }
}

export function removeSetting(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Чистить нечего.
  }
}
