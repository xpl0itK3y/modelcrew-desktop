import { KEYS, readSetting, writeSetting, removeSetting } from "./settings/storage";
// Выбор оболочки: хранится отдельно и подставляется в pty_create для новых
// терминалов. null / пустая строка — системная оболочка по умолчанию (её
// разрешает бэкенд под конкретную ОС). Список доступных оболочек отдаёт
// backend-команда list_shells, поэтому здесь только «команда» на запуск.


export type ShellOption = {
  id: string;
  label: string;
  command: string;
};

export function loadShell(): string | null {
  try {
    const value = readSetting(KEYS.shell);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function saveShell(command: string | null): void {
  try {
    if (command) {
      writeSetting(KEYS.shell, command);
    } else {
      removeSetting(KEYS.shell);
    }
  } catch {
    // Без localStorage выбор не переживёт перезапуск — не критично.
  }
}
