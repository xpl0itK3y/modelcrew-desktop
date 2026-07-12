import { SerializedDockview } from "dockview";

// Раскладка и воркспейсы переживают перезапуск: на изменения layout
// пишем снапшот в localStorage, на старте восстанавливаем. Шеллы при
// этом поднимаются свежие (сессии, естественно, не переживают выход).

export type Workspace = {
  id: string;
  name: string;
  // Папка проекта: единственный источник стартового cwd терминалов.
  // null — воркспейс без привязки, шеллы стартуют в домашней папке.
  folder: string | null;
  layout: SerializedDockview | null;
  count: number;
};

export type WorkspacesState = {
  list: Workspace[];
  activeId: string;
};

type PersistedState = WorkspacesState & { version: 1 };

const STORAGE_KEY = "modelcrew.workspaces";

export function loadWorkspacesState(): WorkspacesState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedState;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.list) ||
      parsed.list.length === 0 ||
      !parsed.list.some((workspace) => workspace.id === parsed.activeId)
    ) {
      return null;
    }
    return {
      // Записи старых версий не имели поля folder.
      list: parsed.list.map((workspace) => ({
        ...workspace,
        folder: workspace.folder ?? null,
      })),
      activeId: parsed.activeId,
    };
  } catch {
    return null;
  }
}

export function saveWorkspacesState(state: WorkspacesState): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, ...state } satisfies PersistedState),
    );
  } catch {
    // Нет localStorage — раскладка просто не переживёт рестарт.
  }
}
