const TERMINAL_FONT_SIZE_STORAGE_KEY = "modelcrew.terminalFontSize";

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
