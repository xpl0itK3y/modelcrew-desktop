// Выбор оболочки: хранится отдельно и подставляется в pty_create для новых
// терминалов. null / пустая строка — системная оболочка по умолчанию (её
// разрешает бэкенд под конкретную ОС). Список доступных оболочек отдаёт
// backend-команда list_shells, поэтому здесь только «команда» на запуск.

const SHELL_STORAGE_KEY = "modelcrew.shell";

export type ShellOption = {
  id: string;
  label: string;
  command: string;
};

export function loadShell(): string | null {
  try {
    const value = localStorage.getItem(SHELL_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveShell(command: string | null): void {
  try {
    if (command) {
      localStorage.setItem(SHELL_STORAGE_KEY, command);
    } else {
      localStorage.removeItem(SHELL_STORAGE_KEY);
    }
  } catch {
    // Без localStorage выбор не переживёт перезапуск — не критично.
  }
}
