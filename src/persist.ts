import { SerializedDockview } from "dockview";

// Раскладка и воркспейсы переживают перезапуск: на изменения layout
// пишем снапшот в localStorage, на старте восстанавливаем. Шеллы при
// этом поднимаются свежие (сессии, естественно, не переживают выход).

export type FolderRef = {
  // Путь, каким его видел пользователь при выборе.
  selectedPath: string;
  // Нормализованный путь из бэкенда (WorkspaceRoots — источник истины):
  // по нему сравниваются воркспейсы и запускаются PTY.
  canonicalPath: string;
  // Задел v0.2: идентичность папки (dev+inode) для детекта перемещений.
  identityKey: string | null;
};

export type NameMode = "folder" | "custom";

export type Workspace = {
  id: string;
  displayName: string;
  // "folder" — имя следует за папкой (обновляется при перепривязке),
  // "custom" — переименован руками, автообновление не трогает.
  nameMode: NameMode;
  // null — воркспейс не привязан; терминалы для него не запускаются.
  folder: FolderRef | null;
  layout: SerializedDockview | null;
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
  // null — воркспейсов нет (первый запуск / все удалены).
  activeId: string | null;
};

type PersistedStateV2 = WorkspacesState & { version: 2 };

type WorkspaceV1 = {
  id: string;
  name: string;
  folder: string | null;
  layout: SerializedDockview | null;
  count?: number;
};

type PersistedStateV1 = {
  version: 1;
  list: WorkspaceV1[];
  activeId: string | null;
};

const STORAGE_KEY = "modelcrew.workspaces";

export function folderBaseName(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || "workspace";
}

export function bindLayoutToWorkspace(
  layout: SerializedDockview | null,
  workspaceId: string,
): SerializedDockview | null {
  if (!layout) {
    return null;
  }
  return {
    ...layout,
    panels: Object.fromEntries(
      Object.entries(layout.panels).map(([panelId, panel]) => {
        const params = { ...(panel.params ?? {}) };
        // v1 некоторое время сохраняла raw cwd в params панели.
        delete params.cwd;
        return [panelId, { ...panel, params: { ...params, workspaceId } }];
      }),
    ),
  };
}

function migrateWorkspaceV1(workspace: WorkspaceV1, now: number): Workspace {
  return {
    id: workspace.id,
    displayName: workspace.name,
    // Совпадение имени с папкой считаем автоименем — оно продолжит
    // следовать за папкой при перепривязке.
    nameMode:
      workspace.folder && folderBaseName(workspace.folder) === workspace.name
        ? "folder"
        : "custom",
    folder: workspace.folder
      ? {
          selectedPath: workspace.folder,
          canonicalPath: workspace.folder,
          identityKey: null,
        }
      : null,
    layout: bindLayoutToWorkspace(workspace.layout ?? null, workspace.id),
    createdAt: now,
    lastOpenedAt: now,
  };
}

function normalizeWorkspaceV2(
  workspace: Workspace,
  now: number,
): Workspace | null {
  if (typeof workspace.id !== "string" || workspace.id.length === 0) {
    return null;
  }
  if (typeof workspace.displayName !== "string") {
    return null;
  }
  const folder =
    workspace.folder &&
    typeof workspace.folder.selectedPath === "string" &&
    typeof workspace.folder.canonicalPath === "string"
      ? {
          selectedPath: workspace.folder.selectedPath,
          canonicalPath: workspace.folder.canonicalPath,
          identityKey:
            typeof workspace.folder.identityKey === "string"
              ? workspace.folder.identityKey
              : null,
        }
      : null;
  return {
    id: workspace.id,
    displayName: workspace.displayName,
    nameMode: workspace.nameMode === "folder" ? "folder" : "custom",
    folder,
    layout: bindLayoutToWorkspace(workspace.layout ?? null, workspace.id),
    createdAt: typeof workspace.createdAt === "number" ? workspace.createdAt : now,
    lastOpenedAt:
      typeof workspace.lastOpenedAt === "number" ? workspace.lastOpenedAt : now,
  };
}

export function loadWorkspacesState(): WorkspacesState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedStateV1 | PersistedStateV2;
    if (!Array.isArray(parsed.list)) {
      return null;
    }
    const now = Date.now();
    let list: Workspace[];
    if (parsed.version === 2) {
      list = parsed.list
        .map((workspace) => normalizeWorkspaceV2(workspace, now))
        .filter((workspace): workspace is Workspace => workspace !== null);
    } else if (parsed.version === 1) {
      list = parsed.list
        .filter(
          (workspace) =>
            typeof workspace.id === "string" &&
            typeof workspace.name === "string",
        )
        .map((workspace) => migrateWorkspaceV1(workspace, now));
    } else {
      return null;
    }
    if (list.length === 0) {
      return { list: [], activeId: null };
    }
    // Битый activeId не должен терять воркспейсы — берём первый.
    const activeId = list.some((workspace) => workspace.id === parsed.activeId)
      ? parsed.activeId
      : list[0].id;
    return { list, activeId };
  } catch {
    return null;
  }
}

export function saveWorkspacesState(state: WorkspacesState): void {
  try {
    const normalized: WorkspacesState = {
      ...state,
      list: state.list.map((workspace) => ({
        ...workspace,
        layout: bindLayoutToWorkspace(workspace.layout, workspace.id),
      })),
    };
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, ...normalized } satisfies PersistedStateV2),
    );
  } catch {
    // Нет localStorage — раскладка просто не переживёт рестарт.
  }
}
