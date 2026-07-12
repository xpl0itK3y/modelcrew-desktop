import { useSyncExternalStore } from "react";

export type Locale = "ru" | "en";

const LOCALE_STORAGE_KEY = "modelcrew.locale";
const DEFAULT_LOCALE: Locale = "ru";

const ru = {
  "common.cancel": "Отмена",
  "common.close": "Закрыть",
  "common.delete": "Удалить",

  "titlebar.toggleSidebar": "Показать или скрыть боковую панель",
  "titlebar.newTerminal": "Новый терминал в сетку",
  "titlebar.layoutsSoon": "Раскладки — скоро",
  "titlebar.notificationsSoon": "Уведомления — скоро",
  "titlebar.settings": "Настройки",

  "sidebar.title": "Проекты",
  "sidebar.newWorkspace": "Новый проект",
  "sidebar.deleteWorkspace": "Удалить проект",
  "sidebar.homeFolder": "Домашняя папка",
  "sidebar.renameWorkspace": "Переименовать проект",

  "settings.title": "Настройки",
  "settings.language": "Язык интерфейса",
  "settings.languageRussian": "Русский",
  "settings.languageEnglish": "English",
  "settings.theme": "Тема интерфейса",
  "settings.accent": "Цвет подсветки",
  "settings.customColor": "Свой цвет",
  "settings.selectTheme": "Выбрать тему «{name}»",
  "settings.selectAccent": "Выбрать цвет «{name}»",

  "theme.midnight.name": "Полночь",
  "theme.midnight.description": "Исходная тёмная",
  "theme.graphite.name": "Графит",
  "theme.graphite.description": "Спокойный монохром",
  "theme.ocean.name": "Океан",
  "theme.ocean.description": "Глубокий сине-чёрный",
  "theme.forest.name": "Лес",
  "theme.forest.description": "Тёмный хвойный",
  "theme.aubergine.name": "Аметист",
  "theme.aubergine.description": "Приглушённый фиолетовый",
  "theme.porcelain.name": "Фарфор",
  "theme.porcelain.description": "Светлая сланцевая",

  "accent.pink": "Розовый",
  "accent.rose": "Малиновый",
  "accent.red": "Красный",
  "accent.orange": "Оранжевый",
  "accent.amber": "Янтарный",
  "accent.yellow": "Жёлтый",
  "accent.lime": "Лаймовый",
  "accent.green": "Зелёный",
  "accent.emerald": "Изумрудный",
  "accent.teal": "Бирюзовый",
  "accent.sky": "Голубой",
  "accent.blue": "Синий",
  "accent.indigo": "Индиго",
  "accent.violet": "Фиолетовый",
  "accent.purple": "Пурпурный",
  "accent.fuchsia": "Фуксия",
  "accent.white": "Белый",
  "accent.gray": "Серый",

  "welcome.title": "Собери свою команду.",
  "welcome.chooseProject":
    "Выбери папку проекта — в ней будут жить терминалы рабочего пространства.",
  "welcome.terminalsTogether": "Терминалы для агентов — в одном окне.",
  "welcome.openProject": "Открыть папку проекта",
  "welcome.newTerminal": "Новый терминал",
  "welcome.openProjectShortcut": "также откроет выбор папки",
  "welcome.newTerminalShortcut": "новый терминал",
  "welcome.panelNumbersShortcut": "номера панелей",
  "welcome.zoomShortcut": "зум",

  "group.splitRight": "Разделить вправо",
  "group.maximizeRestore": "Развернуть или вернуть ({shortcut})",
  "group.close": "Закрыть группу ({shortcut})",
  "layout.noSplitSpace": "Недостаточно места для нового терминала",
  "layout.terminalLimit": "Нельзя открыть больше {max} терминалов",
  "layout.restore": "Вернуть раскладку",
  "layout.terminalExpanded": "Терминал развёрнут",
  "layout.restoreShortcut": "вернуть",

  "workspace.checking": "Проверяем папки проектов…",
  "workspace.folderChecking": "Папка проекта ещё проверяется",
  "workspace.folderPickerDesktopOnly":
    "Выбор папки доступен в приложении ModelCrew",
  "workspace.syncFailed": "Не удалось синхронизировать папки: {error}",
  "workspace.prepareFailed": "Не удалось подготовить папки: {error}",
  "workspace.rootOwnedBy": "Папка уже принадлежит проекту {workspaceId}",
  "workspace.alreadyOpen": "Папка уже открыта в «{name}»",
  "workspace.alreadyRegistered": "Папка уже открыта в другом проекте",
  "workspace.invalidBackendId":
    "Приложение получило неверный идентификатор проекта",

  "confirm.closeTerminal": "Закрытие терминала",
  "confirm.deleteWorkspace":
    "Удалить проект «{name}» и закрыть {terminals}?",

  "terminal.defaultTitle": "терминал",
  "terminal.statusRunning": "Терминал работает",
  "terminal.statusExited": "Терминал завершён",
  "terminal.rename": "Переименовать терминал",
  "terminal.shellStartFailed": "Не удалось запустить оболочку: {error}",
  "terminal.workspaceMissing": "панель не связана с проектом",
  "terminal.webPreview":
    "веб-превью: оболочка работает только в приложении",
  "terminal.processExited": "процесс завершён",
  "terminal.exitCode": "код {code}",

  "error.mainWindowOnly": "Команда доступна только в главном окне",
  "error.invalidLocale": "Выбран неподдерживаемый язык интерфейса",
  "error.appMenuUpdateFailed": "Не удалось обновить меню приложения",
  "error.workspaceInvalidId": "Некорректный идентификатор проекта",
  "error.workspaceRootConflict":
    "Проект уже связан с другой папкой",
  "error.workspaceRootNotRegistered": "Папка проекта не зарегистрирована",
  "error.workspaceRootIdentityChanged":
    "Папка проекта была заменена — выберите её заново",
  "error.workspaceRootMissing": "Папка проекта недоступна",
  "error.workspaceRootPermissionDenied": "Нет доступа к папке проекта",
  "error.workspaceRootNotDirectory": "Выбранный путь не является папкой",
  "error.workspaceRootUnavailable": "Не удалось проверить папку проекта",
  "error.workspacePathUnsupported":
    "Путь проекта содержит неподдерживаемые символы",
  "error.workspacePickerPathInvalid": "Не удалось прочитать выбранный путь",
  "error.terminalNotFound": "Терминал не найден",
  "error.terminalPtyOpenFailed": "Не удалось открыть PTY",
  "error.terminalShellNotFound": "Оболочка не найдена: {shell}",
  "error.terminalCwdUnavailable": "Рабочая папка терминала недоступна",
  "error.terminalSpawnFailed": "Не удалось запустить оболочку {shell}",
  "error.terminalOutputStreamFailed": "Не удалось открыть поток вывода",
  "error.terminalInputStreamFailed": "Не удалось открыть поток ввода",
  "error.terminalWriteFailed": "Не удалось записать данные в терминал",
  "error.terminalResizeFailed": "Не удалось изменить размер терминала",
  "error.unknown": "Произошла неизвестная ошибка",
} as const;

export type MessageKey = keyof typeof ru;

const en: Record<MessageKey, string> = {
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.delete": "Delete",

  "titlebar.toggleSidebar": "Show or hide sidebar",
  "titlebar.newTerminal": "Add terminal to grid",
  "titlebar.layoutsSoon": "Layouts — coming soon",
  "titlebar.notificationsSoon": "Notifications — coming soon",
  "titlebar.settings": "Settings",

  "sidebar.title": "Projects",
  "sidebar.newWorkspace": "New project",
  "sidebar.deleteWorkspace": "Delete project",
  "sidebar.homeFolder": "Home folder",
  "sidebar.renameWorkspace": "Rename project",

  "settings.title": "Settings",
  "settings.language": "Interface language",
  "settings.languageRussian": "Русский",
  "settings.languageEnglish": "English",
  "settings.theme": "Interface theme",
  "settings.accent": "Accent color",
  "settings.customColor": "Custom color",
  "settings.selectTheme": "Select the “{name}” theme",
  "settings.selectAccent": "Select the “{name}” color",

  "theme.midnight.name": "Midnight",
  "theme.midnight.description": "Original dark theme",
  "theme.graphite.name": "Graphite",
  "theme.graphite.description": "Calm monochrome",
  "theme.ocean.name": "Ocean",
  "theme.ocean.description": "Deep blue-black",
  "theme.forest.name": "Forest",
  "theme.forest.description": "Dark evergreen",
  "theme.aubergine.name": "Amethyst",
  "theme.aubergine.description": "Muted violet",
  "theme.porcelain.name": "Porcelain",
  "theme.porcelain.description": "Light slate",

  "accent.pink": "Pink",
  "accent.rose": "Rose",
  "accent.red": "Red",
  "accent.orange": "Orange",
  "accent.amber": "Amber",
  "accent.yellow": "Yellow",
  "accent.lime": "Lime",
  "accent.green": "Green",
  "accent.emerald": "Emerald",
  "accent.teal": "Teal",
  "accent.sky": "Sky blue",
  "accent.blue": "Blue",
  "accent.indigo": "Indigo",
  "accent.violet": "Violet",
  "accent.purple": "Purple",
  "accent.fuchsia": "Fuchsia",
  "accent.white": "White",
  "accent.gray": "Gray",

  "welcome.title": "Build your crew.",
  "welcome.chooseProject":
    "Choose a project folder — your workspace terminals will run there.",
  "welcome.terminalsTogether": "Agent terminals, together in one window.",
  "welcome.openProject": "Open project folder",
  "welcome.newTerminal": "New terminal",
  "welcome.openProjectShortcut": "also opens the folder picker",
  "welcome.newTerminalShortcut": "new terminal",
  "welcome.panelNumbersShortcut": "panel numbers",
  "welcome.zoomShortcut": "zoom",

  "group.splitRight": "Split right",
  "group.maximizeRestore": "Maximize or restore ({shortcut})",
  "group.close": "Close group ({shortcut})",
  "layout.noSplitSpace": "Not enough room for another terminal",
  "layout.terminalLimit": "Can’t open more than {max} terminals",
  "layout.restore": "Restore layout",
  "layout.terminalExpanded": "Terminal expanded",
  "layout.restoreShortcut": "restore",

  "workspace.checking": "Checking project folders…",
  "workspace.folderChecking": "The project folder is still being checked",
  "workspace.folderPickerDesktopOnly":
    "Folder selection is available in the ModelCrew app",
  "workspace.syncFailed": "Could not synchronize folders: {error}",
  "workspace.prepareFailed": "Could not prepare folders: {error}",
  "workspace.rootOwnedBy":
    "The folder already belongs to workspace {workspaceId}",
  "workspace.alreadyOpen": "The folder is already open in “{name}”",
  "workspace.alreadyRegistered":
    "The folder is already open in another workspace",
  "workspace.invalidBackendId":
    "The app received an invalid workspace identifier",

  "confirm.closeTerminal": "Close terminal?",
  "confirm.deleteWorkspace":
    "Delete workspace “{name}” and close {terminals}?",

  "terminal.defaultTitle": "terminal",
  "terminal.statusRunning": "Terminal is running",
  "terminal.statusExited": "Terminal has exited",
  "terminal.rename": "Rename terminal",
  "terminal.shellStartFailed": "Could not start shell: {error}",
  "terminal.workspaceMissing": "the panel is not linked to a workspace",
  "terminal.webPreview": "web preview: the shell only runs in the app",
  "terminal.processExited": "process exited",
  "terminal.exitCode": "code {code}",

  "error.mainWindowOnly": "This command is only available in the main window",
  "error.invalidLocale": "The selected interface language is not supported",
  "error.appMenuUpdateFailed": "Could not update the application menu",
  "error.workspaceInvalidId": "Invalid workspace identifier",
  "error.workspaceRootConflict":
    "The workspace is already linked to another folder",
  "error.workspaceRootNotRegistered":
    "The workspace folder is not registered",
  "error.workspaceRootIdentityChanged":
    "The workspace folder was replaced — select it again",
  "error.workspaceRootMissing": "The project folder is unavailable",
  "error.workspaceRootPermissionDenied":
    "Permission to the project folder was denied",
  "error.workspaceRootNotDirectory": "The selected path is not a folder",
  "error.workspaceRootUnavailable": "Could not inspect the project folder",
  "error.workspacePathUnsupported":
    "The project path contains unsupported characters",
  "error.workspacePickerPathInvalid": "Could not read the selected path",
  "error.terminalNotFound": "The terminal was not found",
  "error.terminalPtyOpenFailed": "Could not open the PTY",
  "error.terminalShellNotFound": "Shell not found: {shell}",
  "error.terminalCwdUnavailable":
    "The terminal working directory is unavailable",
  "error.terminalSpawnFailed": "Could not start shell {shell}",
  "error.terminalOutputStreamFailed": "Could not open the output stream",
  "error.terminalInputStreamFailed": "Could not open the input stream",
  "error.terminalWriteFailed": "Could not write to the terminal",
  "error.terminalResizeFailed": "Could not resize the terminal",
  "error.unknown": "An unknown error occurred",
};

const catalogs: Record<Locale, Record<MessageKey, string>> = { ru, en };

let currentLocale: Locale = loadLocale();
const listeners = new Set<() => void>();

function isLocale(value: unknown): value is Locale {
  return value === "ru" || value === "en";
}

export function loadLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function applyLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = "ltr";
}

export function initializeLocale(): Locale {
  currentLocale = loadLocale();
  applyLocale(currentLocale);
  return currentLocale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) {
    return;
  }
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Без localStorage язык применяется только до закрытия приложения.
  }
  const changed = currentLocale !== locale;
  currentLocale = locale;
  applyLocale(locale);
  if (changed) {
    for (const listener of listeners) {
      listener();
    }
  }
}

export function translate(
  key: MessageKey,
  params: Record<string, string | number> = {},
  locale: Locale = currentLocale,
): string {
  return catalogs[locale][key].replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : `{${name}}`,
  );
}

export function formatTerminalCount(
  count: number,
  locale: Locale = currentLocale,
): string {
  if (locale === "en") {
    return `${count} ${count === 1 ? "terminal" : "terminals"}`;
  }
  const mod10 = count % 10;
  const mod100 = count % 100;
  const noun =
    mod10 === 1 && mod100 !== 11
      ? "терминал"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "терминала"
        : "терминалов";
  return `${count} ${noun}`;
}

export type BackendError = {
  code: string;
  context?: Record<string, string | number>;
  debug?: string;
};

function parseBackendError(error: unknown): BackendError | null {
  let value = error;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || !("code" in value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.code !== "string") {
    return null;
  }
  const context =
    candidate.context && typeof candidate.context === "object"
      ? (candidate.context as Record<string, string | number>)
      : undefined;
  return {
    code: candidate.code,
    context,
    debug: typeof candidate.debug === "string" ? candidate.debug : undefined,
  };
}

const backendErrorKeys: Record<string, MessageKey> = {
  main_window_only: "error.mainWindowOnly",
  invalid_locale: "error.invalidLocale",
  app_menu_update_failed: "error.appMenuUpdateFailed",
  workspace_invalid_id: "error.workspaceInvalidId",
  workspace_root_conflict: "error.workspaceRootConflict",
  workspace_root_not_registered: "error.workspaceRootNotRegistered",
  workspace_root_identity_changed: "error.workspaceRootIdentityChanged",
  workspace_root_missing: "error.workspaceRootMissing",
  workspace_root_permission_denied: "error.workspaceRootPermissionDenied",
  workspace_root_not_directory: "error.workspaceRootNotDirectory",
  workspace_root_unavailable: "error.workspaceRootUnavailable",
  workspace_path_unsupported: "error.workspacePathUnsupported",
  workspace_picker_path_invalid: "error.workspacePickerPathInvalid",
  terminal_not_found: "error.terminalNotFound",
  terminal_pty_open_failed: "error.terminalPtyOpenFailed",
  terminal_shell_not_found: "error.terminalShellNotFound",
  terminal_cwd_unavailable: "error.terminalCwdUnavailable",
  terminal_spawn_failed: "error.terminalSpawnFailed",
  terminal_output_stream_failed: "error.terminalOutputStreamFailed",
  terminal_input_stream_failed: "error.terminalInputStreamFailed",
  terminal_write_failed: "error.terminalWriteFailed",
  terminal_resize_failed: "error.terminalResizeFailed",
};

export function localizeBackendError(error: unknown): string {
  const parsed = parseBackendError(error);
  if (!parsed) {
    console.error("Unstructured backend error", error);
    return translate("error.unknown");
  }
  const key = backendErrorKeys[parsed.code] ?? "error.unknown";
  if (parsed.debug) {
    console.error("Backend error", parsed);
  }
  return translate(key, parsed.context);
}

export function backendErrorReason(
  error: unknown,
): "missing" | "not_directory" | "permission_denied" | "identity_changed" | "unknown" {
  const code = parseBackendError(error)?.code;
  if (code === "workspace_root_missing") {
    return "missing";
  }
  if (code === "workspace_root_not_directory") {
    return "not_directory";
  }
  if (code === "workspace_root_permission_denied") {
    return "permission_denied";
  }
  if (code === "workspace_root_identity_changed") {
    return "identity_changed";
  }
  return "unknown";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return {
    locale,
    setLocale,
    t: (key: MessageKey, params?: Record<string, string | number>) =>
      translate(key, params, locale),
  };
}
