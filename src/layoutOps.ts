import { MutableRefObject } from "react";
import {
  DockviewApi,
  DockviewGroupPanel,
  IDockviewPanel,
  SerializedDockview,
} from "dockview";
import { flipGroups, snapshotGroupRects, swapFlight } from "./animations";
import { translate } from "./i18n";
import {
  MAX_TERMINALS,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
} from "./constants";
import type { Workspace } from "./persist";

// Swap позиций двух панелей через сериализованный layout: меняем их id
// местами в дереве и восстанавливаем. Инстансы xterm живут вне React,
// поэтому обе сессии и буферы переживают пересоздание панелей.
export function swapPanels(
  api: DockviewApi,
  a: IDockviewPanel,
  b: IDockviewPanel,
  suppressCleanup: MutableRefObject<boolean>,
): void {
  // Позиции самих панелей до свапа: группы остаются на местах,
  // перелетают именно панели.
  const fromA = a.group.element.getBoundingClientRect();
  const fromB = b.group.element.getBoundingClientRect();
  const layout = api.toJSON();

  type GridNode = {
    type: "leaf" | "branch";
    data:
      | GridNode[]
      | { views: string[]; activeView?: string; id: string };
  };
  const visit = (node: GridNode) => {
    if (node.type === "branch") {
      for (const child of node.data as GridNode[]) {
        visit(child);
      }
      return;
    }
    const data = node.data as { views: string[]; activeView?: string };
    data.views = data.views.map((id) =>
      id === a.id ? b.id : id === b.id ? a.id : id,
    );
    if (data.activeView === a.id) {
      data.activeView = b.id;
    } else if (data.activeView === b.id) {
      data.activeView = a.id;
    }
  };
  visit(layout.grid.root as GridNode);

  suppressCleanup.current = true;
  try {
    api.fromJSON(layout);
  } finally {
    suppressCleanup.current = false;
  }
  api.getPanel(a.id)?.api.setActive();

  // Обе панели «перелетают» на места друг друга поверх мгновенного layout.
  const elementA = api.getPanel(a.id)?.group.element;
  const elementB = api.getPanel(b.id)?.group.element;
  if (elementA) {
    swapFlight(elementA, fromA);
  }
  if (elementB) {
    swapFlight(elementB, fromB);
  }
}

// ---------- Панели терминалов в сетке dockview ----------

export const defaultTerminalTitles = new Set(["терминал", "terminal"]);

export function localizeDefaultPanelTitles(
  layout: SerializedDockview | null,
): SerializedDockview | null {
  if (!layout) {
    return null;
  }
  const title = translate("terminal.defaultTitle");
  return {
    ...layout,
    panels: Object.fromEntries(
      Object.entries(layout.panels).map(([panelId, panel]) => {
        const titleKind = panel.params?.titleKind;
        const isDefaultTitle =
          titleKind === "default" ||
          (titleKind === undefined &&
            defaultTerminalTitles.has(panel.title ?? ""));
        return [panelId, isDefaultTitle ? { ...panel, title } : panel];
      }),
    ),
  };
}

// Размерность ровной сетки под count панелей: близко к квадрату,
// колонок не меньше, чем строк (мониторы шире, чем выше).
export function gridDimensions(count: number): { rows: number; cols: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { rows: Math.max(1, Math.ceil(count / cols)), cols };
}

// Перестраивает раскладку активной сессии в ровную сетку. Инстансы xterm
// живут вне dockview, поэтому пересоздание панелей с теми же id сохраняет
// PTY, буферы и заголовки; вызывающий обязан подавить cleanup на время.
export function arrangeEvenGrid(api: DockviewApi): boolean {
  const panels = api.panels.filter(
    (panel) => panel.view?.contentComponent === "terminal",
  );
  if (panels.length < 2) {
    return false;
  }
  // Порядок чтения: сверху вниз, слева направо — раскладка не «перемешивает»
  // терминалы, а только выравнивает их.
  const ordered = [...panels].sort((a, b) => {
    const rectA = a.group.element.getBoundingClientRect();
    const rectB = b.group.element.getBoundingClientRect();
    return rectA.top - rectB.top || rectA.left - rectB.left;
  });
  const meta = ordered.map((panel) => ({
    id: panel.id,
    title: panel.api.title,
    params: panel.api.getParameters<Record<string, unknown>>(),
  }));
  const { rows, cols } = gridDimensions(meta.length);

  api.closeAllGroups();

  const grid: IDockviewPanel[][] = [];
  meta.forEach((entry, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const panel = api.addPanel({
      id: entry.id,
      component: "terminal",
      tabComponent: "terminal",
      title: entry.title ?? translate("terminal.defaultTitle"),
      params: entry.params,
      minimumWidth: PANEL_MIN_WIDTH,
      minimumHeight: PANEL_MIN_HEIGHT,
      ...(row === 0 && col === 0
        ? {}
        : col === 0
          ? // Новая строка — полноширинная, у нижнего края всего грида.
            { position: { direction: "below" as const } }
          : {
              position: {
                referencePanel: grid[row][col - 1],
                direction: "right" as const,
              },
            }),
    });
    (grid[row] ??= []).push(panel);
  });

  // Сплиты делят место пополам неравномерно — приводим к равным долям.
  const rowHeight = Math.floor(api.height / rows);
  const colWidth = Math.floor(api.width / cols);
  for (const row of grid) {
    row[0].api.setSize({ height: rowHeight });
    for (const panel of row) {
      panel.api.setSize({ width: colWidth });
    }
  }
  return true;
}

export function addPanel(
  api: DockviewApi,
  workspaceId: string,
  sessionId: string,
  options: {
    group?: DockviewGroupPanel;
    direction?: "left" | "right" | "above" | "below";
  } = {},
) {
  api.addPanel({
    id: crypto.randomUUID(),
    component: "terminal",
    tabComponent: "terminal",
    // Короткий placeholder только на время запуска PTY. pty_create сразу
    // вернёт имя оболочки, дальше watcher отслеживает codex/vim/другие процессы.
    title: translate("terminal.defaultTitle"),
    // В layout сохраняется только владелец панели. cwd разрешает Rust.
    params: { workspaceId, sessionId, titleKind: "default" },
    minimumWidth: PANEL_MIN_WIDTH,
    minimumHeight: PANEL_MIN_HEIGHT,
    ...(options.group
      ? {
          position: {
            referenceGroup: options.group,
            ...(options.direction ? { direction: options.direction } : {}),
          },
        }
      : options.direction
        ? // Absolute-позиция: панель встаёт у края всего грида
          // (полноширинная строка/колонка).
          { position: { direction: options.direction } }
        : {}),
  });
}

// Новый терминал встаёт в сетку: делим самую большую группу вдоль её
// длинной стороны. Вкладок нет — один терминал = одна панель, поэтому
// при упоре в минимумы 240×160 новый терминал не создаём вовсе.
export function addTerminalAutoGrid(
  api: DockviewApi,
  workspaceId: string,
  sessionId: string,
  onBlocked?: (reason: "limit" | "space") => void,
) {
  // Жёсткий предел раньше пространственного: 12 терминалов на сессию.
  if (api.panels.length >= MAX_TERMINALS) {
    onBlocked?.("limit");
    return;
  }
  const groups = api.groups;
  if (groups.length === 0) {
    addPanel(api, workspaceId, sessionId);
    return;
  }

  // Раскладка строится СТРОКАМИ: новая панель встаёт в самую короткую
  // строку, а когда строки заполнены — полноширинной строкой снизу.
  // У строчного дерева вертикальные разделители соседних строк
  // независимы: перетаскивание границы в одной строке не двигает другую.
  const sorted = [...groups].sort((a, b) => {
    const rectA = a.element.getBoundingClientRect();
    const rectB = b.element.getBoundingClientRect();
    if (Math.abs(rectA.top - rectB.top) > 30) {
      return rectA.top - rectB.top;
    }
    return rectA.left - rectB.left;
  });
  const rows: DockviewGroupPanel[][] = [];
  let currentTop = Number.NEGATIVE_INFINITY;
  for (const group of sorted) {
    const top = group.element.getBoundingClientRect().top;
    if (Math.abs(top - currentTop) > 30) {
      rows.push([]);
      currentTop = top;
    }
    rows[rows.length - 1].push(group);
  }

  let shortest = rows[0];
  for (const row of rows) {
    if (row.length < shortest.length) {
      shortest = row;
    }
  }
  const targetColumns = Math.ceil(Math.sqrt(groups.length + 1));
  const rowWidth = shortest.reduce((width, group) => width + group.width, 0);
  const widenFits = rowWidth / (shortest.length + 1) >= PANEL_MIN_WIDTH;
  const gridHeight = rows.reduce((height, row) => height + row[0].height, 0);
  const newRowFits = gridHeight / (rows.length + 1) >= PANEL_MIN_HEIGHT;

  // Соседи ужимаются мгновенно, а плавность дорисовывает FLIP поверх.
  const before = snapshotGroupRects(api);
  if (widenFits && (shortest.length < targetColumns || !newRowFits)) {
    addPanel(api, workspaceId, sessionId, {
      group: shortest[shortest.length - 1],
      direction: "right",
    });
  } else if (newRowFits) {
    addPanel(api, workspaceId, sessionId, { direction: "below" });
  } else {
    onBlocked?.("space");
    return;
  }
  flipGroups(api, before, 200);
}

export function snapshotActiveSessionLayout(
  list: Workspace[],
  activeWorkspaceId: string | null,
  api: DockviewApi | null,
): Workspace[] {
  if (!api || !activeWorkspaceId) {
    return list;
  }
  const layout = api.toJSON();
  return list.map((workspace) =>
    workspace.id !== activeWorkspaceId
      ? workspace
      : {
          ...workspace,
          sessions: workspace.sessions.map((session) =>
            session.id === workspace.activeSessionId
              ? { ...session, layout }
              : session,
          ),
        },
  );
}
