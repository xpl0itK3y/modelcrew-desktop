// Раскладка, проекты и логические сессии переживают перезапуск. Процессы PTY
// после полного выхода поднимаются заново, но каждая сессия сохраняет свою
// сетку панелей и их идентификаторы.

import {
  bindLayoutToSession,
  createDefaultSession,
  isRecord,
  type Workspace,
  type WorkspacesState,
} from "./model";
import {
  dedupeWorkspacesByFolder,
  migrateWorkspaceV1,
  migrateWorkspaceV2,
  normalizeWorkspaceList,
  normalizeWorkspaceV3,
} from "./normalize";

export * from "./model";

type PersistedStateV3 = WorkspacesState & { version: 3 };

const STORAGE_KEY = "modelcrew.workspaces";

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

    list = dedupeWorkspacesByFolder(list);

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
