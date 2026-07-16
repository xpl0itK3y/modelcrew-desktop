const TERMINAL_FONT_SIZE_STORAGE_KEY = "modelcrew.terminalFontSize";
const HISTORY_ISOLATION_STORAGE_KEY = "modelcrew.terminalHistoryIsolated";
const GRID_ORIENTATION_STORAGE_KEY = "modelcrew.gridOrientation";

// Ориентация дерева при выравнивании сеткой: columns — парные горизонтальные
// границы, rows — парные вертикальные (сквозной в дереве бывает только одна
// ось, это выбор пользователя).
export type GridOrientation = "columns" | "rows";

export function loadGridOrientation(): GridOrientation {
  try {
    return localStorage.getItem(GRID_ORIENTATION_STORAGE_KEY) === "rows"
      ? "rows"
      : "columns";
  } catch {
    return "columns";
  }
}

export function saveGridOrientation(orientation: GridOrientation): void {
  try {
    localStorage.setItem(GRID_ORIENTATION_STORAGE_KEY, orientation);
  } catch {
    // Без localStorage значение действует только до закрытия приложения.
  }
}

const EAGER_RESTORE_STORAGE_KEY = "modelcrew.eagerSessionRestore";

// Оживлять ли при старте все сессии активного проекта разом (PTY + агенты),
// или только активную, а остальные — при переключении.
export function loadEagerSessionRestore(): boolean {
  try {
    return localStorage.getItem(EAGER_RESTORE_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveEagerSessionRestore(eager: boolean): void {
  try {
    localStorage.setItem(EAGER_RESTORE_STORAGE_KEY, eager ? "on" : "off");
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
