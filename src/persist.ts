import { SerializedDockview } from "dockview";

// Раскладка и воркспейсы переживают перезапуск: на изменения layout
// пишем снапшот в localStorage, на старте восстанавливаем. Шеллы при
// этом поднимаются свежие (сессии, естественно, не переживают выход).

export type Workspace = {
  id: string;
  name: string;
  // Канонический путь нужен UI и восстановлению backend-связи. Сам PTY
  // никогда не доверяет этому полю и разрешает cwd только по workspaceId.
  // null — старый/непривязанный воркспейс; терминал для него не запускается.
  folder: string | null;
  layout: SerializedDockview | null;
  count: number;
};

export type WorkspacesState = {
  list: Workspace[];
  // null — воркспейсов нет (первый запуск / все удалены).
  activeId: string | null;
};

type PersistedState = WorkspacesState & { version: 1 };

const STORAGE_KEY = "modelcrew.workspaces";

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

export function loadWorkspacesState(): WorkspacesState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedState;
    const hasValidActiveWorkspace =
      Array.isArray(parsed.list) &&
      (parsed.list.length === 0
        ? parsed.activeId === null
        : typeof parsed.activeId === "string" &&
          parsed.list.some((workspace) => workspace.id === parsed.activeId));
    if (parsed.version !== 1 || !hasValidActiveWorkspace) {
      return null;
    }
    return {
      // Записи старых версий не имели поля folder.
      list: parsed.list.map((workspace) => ({
        ...workspace,
        folder: workspace.folder ?? null,
        layout: bindLayoutToWorkspace(workspace.layout ?? null, workspace.id),
      })),
      activeId: parsed.activeId,
    };
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
      JSON.stringify({ version: 1, ...normalized } satisfies PersistedState),
    );
  } catch {
    // Нет localStorage — раскладка просто не переживёт рестарт.
  }
}
