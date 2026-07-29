const TERMINAL_FONT_SIZE_STORAGE_KEY = "modelcrew.terminalFontSize";
const HISTORY_ISOLATION_STORAGE_KEY = "modelcrew.terminalHistoryIsolated";
const NETWORK_AVATARS_STORAGE_KEY = "modelcrew.networkAvatars";
const TERMINAL_SPAWN_MODE_STORAGE_KEY = "modelcrew.terminalSpawnMode";

// Порядок обхода сетки, а не отдельные алгоритмы раскладки: геометрия у всех
// режимов одна (равные строки, равные ячейки в строке), меняется только то,
// в какой конец строки встаёт следующий терминал.
export const TERMINAL_SPAWN_MODES = ["balanced", "snake", "centerOut"] as const;

export type TerminalSpawnMode = (typeof TERMINAL_SPAWN_MODES)[number];

export const DEFAULT_TERMINAL_SPAWN_MODE: TerminalSpawnMode = "balanced";

export function isTerminalSpawnMode(value: unknown): value is TerminalSpawnMode {
  return (
    typeof value === "string" &&
    TERMINAL_SPAWN_MODES.includes(value as TerminalSpawnMode)
  );
}

// Определяет только место следующего терминала. Уже сохранённые раскладки
// остаются как есть и продолжают восстанавливаться через Dockview JSON.
export function loadTerminalSpawnMode(): TerminalSpawnMode {
  try {
    const value = localStorage.getItem(TERMINAL_SPAWN_MODE_STORAGE_KEY);
    return isTerminalSpawnMode(value) ? value : DEFAULT_TERMINAL_SPAWN_MODE;
  } catch {
    return DEFAULT_TERMINAL_SPAWN_MODE;
  }
}

export function saveTerminalSpawnMode(mode: TerminalSpawnMode): void {
  try {
    localStorage.setItem(TERMINAL_SPAWN_MODE_STORAGE_KEY, mode);
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}

// Аватарки авторов из сети (GitHub/Gravatar). Выкл — офлайн-инициалы.
// Переключение шлёт событие, чтобы аватарки перерисовались сразу.
export function loadNetworkAvatars(): boolean {
  try {
    return localStorage.getItem(NETWORK_AVATARS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveNetworkAvatars(enabled: boolean): void {
  try {
    localStorage.setItem(NETWORK_AVATARS_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
  window.dispatchEvent(new Event("modelcrew:network-avatars"));
}

const AGENT_ALERTS_STORAGE_KEY = "modelcrew.agentAlerts";
const AGENT_ALERT_DETAIL_STORAGE_KEY = "modelcrew.agentAlertDetail";

// Уведомления «агент закончил/ждёт ответа» для панелей вне поля зрения.
export function loadAgentAlertsEnabled(): boolean {
  try {
    return localStorage.getItem(AGENT_ALERTS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveAgentAlertsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(AGENT_ALERTS_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}

export type AgentAlertDetailMode = "brief" | "detailed";

export function loadAgentAlertDetailMode(): AgentAlertDetailMode {
  try {
    return localStorage.getItem(AGENT_ALERT_DETAIL_STORAGE_KEY) === "detailed"
      ? "detailed"
      : "brief";
  } catch {
    return "brief";
  }
}

export function saveAgentAlertDetailMode(mode: AgentAlertDetailMode): void {
  try {
    localStorage.setItem(AGENT_ALERT_DETAIL_STORAGE_KEY, mode);
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}

// Своя история команд у каждой панели (стрелка вверх возвращает команды
// именно этой панели и переживает перезапуск). false — общесистемная история.
export function loadTerminalHistoryIsolation(): boolean {
  try {
    return localStorage.getItem(HISTORY_ISOLATION_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveTerminalHistoryIsolation(isolated: boolean): void {
  try {
    localStorage.setItem(
      HISTORY_ISOLATION_STORAGE_KEY,
      isolated ? "on" : "off",
    );
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
    const raw = localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
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
    localStorage.setItem(
      TERMINAL_FONT_SIZE_STORAGE_KEY,
      String(normalizeTerminalFontSize(size)),
    );
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}
