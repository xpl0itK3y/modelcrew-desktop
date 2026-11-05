import {
  Orientation,
  type GroupviewPanelState,
  type SerializedDockview,
} from "dockview";
import { MAX_TERMINALS } from "../constants";
import type { Workspace, WorkspacesState } from "../persist";

// Перенос терминала в другую сессию того же проекта.
//
// В dockview живёт только активная сессия, у скрытых есть лишь сохранённая
// раскладка. Своей ли сессии принадлежит терминал, приложение узнаёт по одному
// признаку: числится ли его id в `layout.panels` этой сессии. Так считают
// счётчики в боковой панели, так колокольчик находит ждущего агента, так
// удаление сессии решает, чьи процессы завершить. Поэтому перенос — это
// перекладывание записи панели из одной раскладки в другую; процесс терминала
// при этом не трогается вовсе.
//
// Между проектами переносить нельзя: процесс запущен в папке своего проекта,
// и у проекта свой браузер. Терминал в чужом проекте работал бы не там, где
// его показывают.

// Что будет, если отпустить терминал над строкой боковой панели.
//   move    — перенесётся в эту сессию;
//   here    — это его же сессия или строка его проекта: ничего не случится;
//   foreign — сессия другого проекта: туда нельзя;
//   full    — в сессии уже предельное число терминалов.
export type TerminalDropVerdict = "move" | "here" | "foreign" | "full";

// sessionId — null, когда под курсором строка самого проекта.
export function terminalDropVerdict(
  state: WorkspacesState,
  workspaceId: string,
  sessionId: string | null,
): TerminalDropVerdict {
  // Перетащить можно только панель с экрана, а на экране — активный проект.
  if (workspaceId !== state.activeId) {
    return "foreign";
  }
  const workspace = state.list.find((item) => item.id === workspaceId);
  const session = workspace?.sessions.find((item) => item.id === sessionId);
  if (!workspace || !session || session.id === workspace.activeSessionId) {
    return "here";
  }
  return layoutTerminalCount(session.layout) >= MAX_TERMINALS
    ? "full"
    : "move";
}

export function layoutTerminalCount(layout: SerializedDockview | null): number {
  return layout
    ? Object.values(layout.panels).filter(
        (panel) => (panel.contentComponent ?? "terminal") === "terminal",
      ).length
    : 0;
}

// Записывает панель в раскладку целевой сессии. В сетку её здесь не ставим:
// где ей стоять, зависит от размеров сетки на экране, а у скрытой сессии их
// нет. Место она получит, когда сессию откроют (placeArrivingPanels).
export function withTerminalMoved(
  list: Workspace[],
  workspaceId: string,
  sessionId: string,
  panel: GroupviewPanelState,
): Workspace[] {
  return list.map((workspace) =>
    workspace.id !== workspaceId
      ? workspace
      : {
          ...workspace,
          sessions: workspace.sessions.map((session) =>
            session.id !== sessionId
              ? session
              : {
                  ...session,
                  layout: withArrivingPanel(
                    session.layout,
                    panel,
                    workspaceId,
                    sessionId,
                  ),
                },
          ),
        },
  );
}

function withArrivingPanel(
  layout: SerializedDockview | null,
  panel: GroupviewPanelState,
  workspaceId: string,
  sessionId: string,
): SerializedDockview {
  const base: SerializedDockview = layout ?? emptyLayout();
  return {
    ...base,
    panels: {
      ...base.panels,
      [panel.id]: {
        ...panel,
        // Хозяин панели теперь другая сессия: так её и сохраним.
        params: { ...panel.params, workspaceId, sessionId },
      },
    },
  };
}

// Раскладка сессии, которую ни разу не сохраняли: сетка пуста, панели
// встанут в неё при открытии. Ровно так dockview сохраняет пустую сессию.
function emptyLayout(): SerializedDockview {
  return {
    grid: {
      root: { type: "branch", data: [], size: 0 },
      width: 0,
      height: 0,
      orientation: Orientation.HORIZONTAL,
    },
    panels: {},
  };
}

// Панели, которые числятся в раскладке, но места в сетке у них нет: их
// перенесли сюда, пока сессия была скрыта. Порядок — порядок переноса.
export function arrivingPanels(
  layout: SerializedDockview | null,
): GroupviewPanelState[] {
  if (!layout) {
    return [];
  }
  const placed = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }
    const { type, data } = node as { type?: string; data?: unknown };
    if (type === "branch" && Array.isArray(data)) {
      data.forEach(visit);
    } else if (type === "leaf") {
      addViews(data);
    }
  };
  const addViews = (data: unknown) => {
    const views = (data as { views?: unknown } | undefined)?.views;
    if (Array.isArray(views)) {
      for (const id of views) {
        placed.add(String(id));
      }
    }
  };
  visit(layout.grid.root);
  // Плавающих окон больше не бывает, но в старых раскладках они остались, и
  // их панели на месте: при открытии их вернут в сетку отдельно.
  for (const group of layout.floatingGroups ?? []) {
    addViews(group.data);
  }
  for (const group of layout.popoutGroups ?? []) {
    addViews(group.data);
  }
  return Object.values(layout.panels).filter((panel) => !placed.has(panel.id));
}
