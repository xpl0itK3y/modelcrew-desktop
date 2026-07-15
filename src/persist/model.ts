import { SerializedDockview } from "dockview";

// Доменная модель проектов и сессий плюс конструкторы/хелперы имён.
// Хранение и миграции живут рядом: normalize.ts и index.ts.

export type FolderRef = {
  // Путь, каким его видел пользователь при выборе.
  selectedPath: string;
  // Нормализованный путь из бэкенда (WorkspaceRoots — источник истины):
  // по нему сравниваются проекты и запускаются PTY.
  canonicalPath: string;
  // Идентичность папки (dev+inode) для детекта перемещений.
  identityKey: string | null;
};

export type NameMode = "folder" | "custom";
export type SessionNameMode = "default" | "custom";

export type TerminalSession = {
  id: string;
  // Для custom — пользовательское имя. Для default строка намеренно пустая.
  displayName: string;
  nameMode: SessionNameMode;
  // Случайное имя-кодовое (amber-lynx): выдаётся при создании и живёт с
  // сессией — имя по умолчанию, пока пользователь не переименует.
  generatedName: string;
  defaultIndex: number;
  layout: SerializedDockview | null;
  createdAt: number;
  lastOpenedAt: number;
};

export type Workspace = {
  id: string;
  displayName: string;
  // "folder" — имя следует за папкой (обновляется при перепривязке),
  // "custom" — переименовано руками, автообновление его не трогает.
  nameMode: NameMode;
  // null — проект не привязан; терминалы для него не запускаются.
  folder: FolderRef | null;
  // Инвариант загруженного состояния: в каждом проекте есть хотя бы одна
  // сессия, activeSessionId всегда указывает на элемент этого массива.
  sessions: TerminalSession[];
  activeSessionId: string;
  createdAt: number;
  lastOpenedAt: number;
};

// Доступность папки — состояние времени выполнения, в persist не пишется:
// между запусками она могла измениться, при старте всё равно re-bind.
export type FolderRuntimeStatus =
  | { kind: "checking" }
  | { kind: "ready" }
  | { kind: "unbound" }
  | {
      kind: "unavailable";
      reason:
        | "missing"
        | "not_directory"
        | "permission_denied"
        | "identity_changed"
        | "unknown";
      message?: string;
    };

export type WorkspacesState = {
  list: Workspace[];
  // null — проектов нет (первый запуск / все удалены).
  activeId: string | null;
};



export const DEFAULT_SESSION_DISPLAY_NAME = "";

// Имена сессий по умолчанию — случайные кодовые (amber-lynx), а не «Сессия N».
const SESSION_NAME_ADJECTIVES = [
  "amber", "azure", "brisk", "calm", "cobalt", "crimson", "dusky", "eager",
  "fern", "gilded", "hazel", "indigo", "jolly", "keen", "lunar", "misty",
  "noble", "olive", "quiet", "russet", "swift", "teal", "umber", "vivid",
] as const;
const SESSION_NAME_NOUNS = [
  "lynx", "falcon", "otter", "cedar", "harbor", "comet", "willow", "raven",
  "quartz", "meadow", "ember", "brook", "heron", "maple", "drift", "flint",
  "cove", "birch", "sparrow", "pine", "reef", "fox", "wren", "aspen",
] as const;

export function randomSessionName(): string {
  const pick = (list: readonly string[]) =>
    list[Math.floor(Math.random() * list.length)];
  return `${pick(SESSION_NAME_ADJECTIVES)}-${pick(SESSION_NAME_NOUNS)}`;
}

export function folderBaseName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "workspace";
}

export function defaultSessionId(workspaceId: string): string {
  return `${workspaceId}-session-1`;
}

export function nextSessionDefaultIndex(workspace: Workspace): number {
  return (
    workspace.sessions.reduce(
      (maximum, session) => Math.max(maximum, session.defaultIndex),
      0,
    ) + 1
  );
}

export function sessionDisplayName(
  session: TerminalSession,
  formatDefault: (index: number) => string,
): string {
  if (session.nameMode === "custom" && session.displayName.trim().length > 0) {
    return session.displayName;
  }
  return session.generatedName.trim().length > 0
    ? session.generatedName
    : formatDefault(session.defaultIndex);
}

export function createTerminalSession(
  workspaceId: string,
  sessionId: string,
  defaultIndex: number,
  layout: SerializedDockview | null = null,
  now = Date.now(),
): TerminalSession {
  const safeIndex = normalizeDefaultIndex(defaultIndex, 1);
  return {
    id: sessionId,
    displayName: DEFAULT_SESSION_DISPLAY_NAME,
    nameMode: "default",
    generatedName: randomSessionName(),
    defaultIndex: safeIndex,
    layout: bindLayoutToSession(layout, workspaceId, sessionId),
    createdAt: now,
    lastOpenedAt: now,
  };
}

export function createDefaultSession(
  workspaceId: string,
  layout: SerializedDockview | null = null,
  now = Date.now(),
): TerminalSession {
  return createTerminalSession(
    workspaceId,
    defaultSessionId(workspaceId),
    1,
    layout,
    now,
  );
}

/**
 * Возвращает копию раскладки, привязанную одновременно к проекту и сессии.
 * Ни старый, ни повреждённый frontend state не может протащить raw cwd в PTY.
 */
export function bindLayoutToSession(
  layout: SerializedDockview | null,
  workspaceId: string,
  sessionId: string,
): SerializedDockview | null {
  if (!isSerializedDockview(layout)) {
    return null;
  }

  return {
    ...layout,
    panels: Object.fromEntries(
      Object.entries(layout.panels).map(([panelId, panel]) => {
        const params = isRecord(panel.params) ? { ...panel.params } : {};
        // v1 некоторое время сохраняла raw cwd в params панели.
        delete params.cwd;
        return [
          panelId,
          {
            ...panel,
            params: { ...params, workspaceId, sessionId },
          },
        ];
      }),
    ),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSerializedDockview(value: unknown): value is SerializedDockview {
  if (!isRecord(value) || !isRecord(value.grid) || !isRecord(value.panels)) {
    return false;
  }
  if (
    !isRecord(value.grid.root) ||
    typeof value.grid.height !== "number" ||
    !Number.isFinite(value.grid.height) ||
    typeof value.grid.width !== "number" ||
    !Number.isFinite(value.grid.width) ||
    typeof value.grid.orientation !== "string"
  ) {
    return false;
  }
  return Object.values(value.panels).every(
    (panel) => isRecord(panel) && typeof panel.id === "string",
  );
}

export function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeDefaultIndex(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 1_000_000
    ? value
    : fallback;
}
