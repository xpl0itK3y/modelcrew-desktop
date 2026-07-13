import { SerializedDockview } from "dockview";

// Раскладка, проекты и логические сессии переживают перезапуск. Процессы PTY
// после полного выхода поднимаются заново, но каждая сессия сохраняет свою
// сетку панелей и их идентификаторы.

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
  // Для custom — пользовательское имя. Для default строка намеренно пустая:
  // интерфейс локализует «Сессия N» / «Session N» по defaultIndex.
  displayName: string;
  nameMode: SessionNameMode;
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

type PersistedStateV3 = WorkspacesState & { version: 3 };

const STORAGE_KEY = "modelcrew.workspaces";

export const DEFAULT_SESSION_DISPLAY_NAME = "";

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
  return session.nameMode === "custom" && session.displayName.trim().length > 0
    ? session.displayName
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedDockview(value: unknown): value is SerializedDockview {
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

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeDefaultIndex(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 1_000_000
    ? value
    : fallback;
}

function normalizeFolder(value: unknown): FolderRef | null {
  if (
    !isRecord(value) ||
    typeof value.selectedPath !== "string" ||
    typeof value.canonicalPath !== "string"
  ) {
    return null;
  }
  return {
    selectedPath: value.selectedPath,
    canonicalPath: value.canonicalPath,
    identityKey:
      typeof value.identityKey === "string" ? value.identityKey : null,
  };
}

function normalizeSession(
  value: unknown,
  workspaceId: string,
  fallbackIndex: number,
  now: number,
): TerminalSession | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }

  const customName =
    typeof value.displayName === "string" ? value.displayName : "";
  const nameMode =
    value.nameMode === "custom" && customName.trim().length > 0
      ? "custom"
      : "default";
  const defaultIndex = normalizeDefaultIndex(value.defaultIndex, fallbackIndex);
  const layout = isSerializedDockview(value.layout)
    ? bindLayoutToSession(value.layout, workspaceId, value.id)
    : null;

  return {
    id: value.id,
    displayName: nameMode === "custom" ? customName : DEFAULT_SESSION_DISPLAY_NAME,
    nameMode,
    defaultIndex,
    layout,
    createdAt: normalizeTimestamp(value.createdAt, now),
    lastOpenedAt: normalizeTimestamp(value.lastOpenedAt, now),
  };
}

function normalizeWorkspaceV3(value: unknown, now: number): Workspace | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.displayName !== "string"
  ) {
    return null;
  }

  const workspaceId = value.id;
  const sessions: TerminalSession[] = [];
  const sessionIds = new Set<string>();
  const defaultIndices = new Set<number>();

  if (Array.isArray(value.sessions)) {
    value.sessions.forEach((candidate, index) => {
      const session = normalizeSession(candidate, workspaceId, index + 1, now);
      if (!session || sessionIds.has(session.id)) {
        return;
      }

      let uniqueDefaultIndex = session.defaultIndex;
      while (defaultIndices.has(uniqueDefaultIndex)) {
        uniqueDefaultIndex += 1;
      }
      session.defaultIndex = uniqueDefaultIndex;
      sessionIds.add(session.id);
      defaultIndices.add(uniqueDefaultIndex);
      sessions.push(session);
    });
  }

  if (sessions.length === 0) {
    sessions.push(createDefaultSession(workspaceId, null, now));
  }

  const requestedActiveSessionId =
    typeof value.activeSessionId === "string" ? value.activeSessionId : null;
  const activeSessionId = sessions.some(
    (session) => session.id === requestedActiveSessionId,
  )
    ? requestedActiveSessionId!
    : sessions[0].id;

  return {
    id: workspaceId,
    displayName: value.displayName,
    nameMode: value.nameMode === "folder" ? "folder" : "custom",
    folder: normalizeFolder(value.folder),
    sessions,
    activeSessionId,
    createdAt: normalizeTimestamp(value.createdAt, now),
    lastOpenedAt: normalizeTimestamp(value.lastOpenedAt, now),
  };
}

function migrateWorkspaceV2(value: unknown, now: number): Workspace | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.displayName !== "string"
  ) {
    return null;
  }

  const createdAt = normalizeTimestamp(value.createdAt, now);
  const lastOpenedAt = normalizeTimestamp(value.lastOpenedAt, now);
  const session = {
    ...createDefaultSession(
      value.id,
      isSerializedDockview(value.layout) ? value.layout : null,
      createdAt,
    ),
    lastOpenedAt,
  };
  return {
    id: value.id,
    displayName: value.displayName,
    nameMode: value.nameMode === "folder" ? "folder" : "custom",
    folder: normalizeFolder(value.folder),
    sessions: [session],
    activeSessionId: session.id,
    createdAt,
    lastOpenedAt,
  };
}

function migrateWorkspaceV1(value: unknown, now: number): Workspace | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string"
  ) {
    return null;
  }

  const folder = typeof value.folder === "string" ? value.folder : null;
  const session = createDefaultSession(
    value.id,
    isSerializedDockview(value.layout) ? value.layout : null,
    now,
  );
  return {
    id: value.id,
    displayName: value.name,
    nameMode:
      folder && folderBaseName(folder) === value.name ? "folder" : "custom",
    folder: folder
      ? {
          selectedPath: folder,
          canonicalPath: folder,
          identityKey: null,
        }
      : null,
    sessions: [session],
    activeSessionId: session.id,
    createdAt: now,
    lastOpenedAt: now,
  };
}

function normalizeWorkspaceList(
  values: unknown[],
  normalize: (value: unknown) => Workspace | null,
): Workspace[] {
  const workspaceIds = new Set<string>();
  const result: Workspace[] = [];
  values.forEach((value) => {
    const workspace = normalize(value);
    if (!workspace || workspaceIds.has(workspace.id)) {
      return;
    }
    workspaceIds.add(workspace.id);
    result.push(workspace);
  });
  return result;
}

export function loadWorkspacesState(): WorkspacesState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.list)) {
      return null;
    }

    const now = Date.now();
    let list: Workspace[];
    if (parsed.version === 3) {
      list = normalizeWorkspaceList(parsed.list, (workspace) =>
        normalizeWorkspaceV3(workspace, now),
      );
    } else if (parsed.version === 2) {
      list = normalizeWorkspaceList(parsed.list, (workspace) =>
        migrateWorkspaceV2(workspace, now),
      );
    } else if (parsed.version === 1) {
      list = normalizeWorkspaceList(parsed.list, (workspace) =>
        migrateWorkspaceV1(workspace, now),
      );
    } else {
      return null;
    }

    if (list.length === 0) {
      return { list: [], activeId: null };
    }

    // Битый activeId не должен терять проекты — берём первый.
    const requestedActiveId =
      typeof parsed.activeId === "string" ? parsed.activeId : null;
    const activeId = list.some(
      (workspace) => workspace.id === requestedActiveId,
    )
      ? requestedActiveId
      : list[0].id;
    return { list, activeId };
  } catch {
    return null;
  }
}

export function saveWorkspacesState(state: WorkspacesState): void {
  try {
    const normalized: WorkspacesState = {
      activeId: state.list.some((workspace) => workspace.id === state.activeId)
        ? state.activeId
        : state.list[0]?.id ?? null,
      list: state.list.map((workspace) => {
        const sessions =
          workspace.sessions.length > 0
            ? workspace.sessions.map((session) => ({
                ...session,
                layout: bindLayoutToSession(
                  session.layout,
                  workspace.id,
                  session.id,
                ),
              }))
            : [createDefaultSession(workspace.id)];
        return {
          ...workspace,
          sessions,
          activeSessionId: sessions.some(
            (session) => session.id === workspace.activeSessionId,
          )
            ? workspace.activeSessionId
            : sessions[0].id,
        };
      }),
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 3, ...normalized } satisfies PersistedStateV3),
    );
  } catch {
    // Нет localStorage — раскладки просто не переживут рестарт.
  }
}
