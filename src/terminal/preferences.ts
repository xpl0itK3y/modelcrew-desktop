import {
  KEYS,
  RETIRED_KEYS,
  readSetting,
  removeSetting,
  writeSetting,
} from "../settings/storage";

// У тех, кто когда-то переключал снятую настройку, значение так и лежит в
// хранилище. Убираем при старте, чтобы оно не всплыло при возврате функции.
export function dropRetiredPreferences(): void {
  for (const key of RETIRED_KEYS) {
    removeSetting(key);
  }
}

// Порядок обхода сетки, а не отдельные алгоритмы раскладки: форму сетки все
// режимы растят по одному правилу — наполняют строку, пока в ней есть место,
// потом заводят новую, — меняется только то, с какого конца строки встаёт
// следующий терминал и с какой стороны прибавляется строка.
export const TERMINAL_SPAWN_MODES = ["balanced", "snake", "centerOut"] as const;

export type TerminalSpawnMode = (typeof TERMINAL_SPAWN_MODES)[number];

export const DEFAULT_TERMINAL_SPAWN_MODE: TerminalSpawnMode = "balanced";

export function isTerminalSpawnMode(
  value: unknown,
): value is TerminalSpawnMode {
  return (
    typeof value === "string" &&
    TERMINAL_SPAWN_MODES.includes(value as TerminalSpawnMode)
  );
}

// Определяет только место следующего терминала. Уже сохранённые раскладки
// остаются как есть и продолжают восстанавливаться через Dockview JSON.
export function loadTerminalSpawnMode(): TerminalSpawnMode {
  try {
    const value = readSetting(KEYS.terminalSpawnMode);
    return isTerminalSpawnMode(value) ? value : DEFAULT_TERMINAL_SPAWN_MODE;
  } catch {
    return DEFAULT_TERMINAL_SPAWN_MODE;
  }
}

export function saveTerminalSpawnMode(mode: TerminalSpawnMode): void {
  try {
    writeSetting(KEYS.terminalSpawnMode, mode);
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}

// Аватарки авторов из сети (GitHub/Gravatar). Выкл — офлайн-инициалы.
// Переключение шлёт событие, чтобы аватарки перерисовались сразу.
export function loadNetworkAvatars(): boolean {
  try {
    return readSetting(KEYS.networkAvatars) !== "off";
  } catch {
    return true;
  }
}

export function saveNetworkAvatars(enabled: boolean): void {
  try {
    writeSetting(KEYS.networkAvatars, enabled ? "on" : "off");
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
  window.dispatchEvent(new Event("modelcrew:network-avatars"));
}

// Уведомления «агент закончил/ждёт ответа» для панелей вне поля зрения.
export function loadAgentAlertsEnabled(): boolean {
  try {
    return readSetting(KEYS.agentAlerts) !== "off";
  } catch {
    return true;
  }
}

export function saveAgentAlertsEnabled(enabled: boolean): void {
  try {
    writeSetting(KEYS.agentAlerts, enabled ? "on" : "off");
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}

export type AgentAlertDetailMode = "brief" | "detailed";

export function loadAgentAlertDetailMode(): AgentAlertDetailMode {
  try {
    return readSetting(KEYS.agentAlertDetail) === "detailed"
      ? "detailed"
      : "brief";
  } catch {
    return "brief";
  }
}

export function saveAgentAlertDetailMode(mode: AgentAlertDetailMode): void {
  try {
    writeSetting(KEYS.agentAlertDetail, mode);
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}

// Своя история команд у каждой панели (стрелка вверх возвращает команды
// именно этой панели и переживает перезапуск). false — общесистемная история.
export function loadTerminalHistoryIsolation(): boolean {
  try {
    return readSetting(KEYS.terminalHistoryIsolated) !== "off";
  } catch {
    return true;
  }
}

export function saveTerminalHistoryIsolation(isolated: boolean): void {
  try {
    writeSetting(KEYS.terminalHistoryIsolated, isolated ? "on" : "off");
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}

export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 24;
export const DEFAULT_TERMINAL_FONT_SIZE = 13;

export function normalizeTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
  return Math.max(
    MIN_TERMINAL_FONT_SIZE,
    Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size)),
  );
}

export function loadTerminalFontSize(): number {
  try {
    const raw = readSetting(KEYS.terminalFontSize);
    if (raw === null || raw.trim() === "") {
      return DEFAULT_TERMINAL_FONT_SIZE;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? normalizeTerminalFontSize(parsed)
      : DEFAULT_TERMINAL_FONT_SIZE;
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
}

export function saveTerminalFontSize(size: number): void {
  try {
    writeSetting(
      KEYS.terminalFontSize,
      String(normalizeTerminalFontSize(size)),
    );
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}
