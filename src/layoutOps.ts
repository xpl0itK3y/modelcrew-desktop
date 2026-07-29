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
import type { TerminalSpawnMode } from "./terminal/preferences";

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

type PanelDirection = "left" | "right" | "above" | "below";

export type TerminalGridGroup = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type TerminalPlacementPlan = {
  referenceGroupId?: string;
  direction: PanelDirection;
};

type AddTerminalAutoGridOptions = {
  mode?: TerminalSpawnMode;
  onBlocked?: (reason: "limit" | "space") => void;
};

// Разброс по вертикали, в пределах которого группы считаются одной строкой.
const ROW_TOLERANCE = 30;

// Строки восстанавливаются из пикселей, а не из дерева dockview: после свапов
// и ручных переносов сетка всё равно читается как строки.
function splitRows(
  groups: readonly TerminalGridGroup[],
): TerminalGridGroup[][] {
  const sorted = [...groups].sort((a, b) => {
    if (Math.abs(a.top - b.top) > ROW_TOLERANCE) {
      return a.top - b.top;
    }
    return a.left - b.left;
  });
  const rows: TerminalGridGroup[][] = [];
  let currentTop = Number.NEGATIVE_INFINITY;
  for (const group of sorted) {
    if (Math.abs(group.top - currentTop) > ROW_TOLERANCE) {
      rows.push([]);
      currentTop = group.top;
    }
    rows[rows.length - 1].push(group);
  }
  return rows;
}

type GridShapePlan = { kind: "widen"; rowIndex: number } | { kind: "newRow" };

function rowFitsAnotherCell(row: readonly TerminalGridGroup[]): boolean {
  const width = row.reduce((total, group) => total + group.width, 0);
  return width / (row.length + 1) >= PANEL_MIN_WIDTH;
}

// Форма сетки: расширить строку или завести новую. Размеры считает dockview
// (Sizing.Distribute — равные строки и равные ячейки внутри строки), поэтому
// формулы «влезет ли» одни на все режимы, и предел ёмкости у них общий.
function planGridShape(
  rows: readonly TerminalGridGroup[][],
  mode: TerminalSpawnMode,
): GridShapePlan | null {
  const total = rows.reduce((count, row) => count + row.length, 0);
  const targetColumns = Math.ceil(Math.sqrt(total + 1));
  const gridHeight = rows.reduce((height, row) => height + row[0].height, 0);
  const newRowFits = gridHeight / (rows.length + 1) >= PANEL_MIN_HEIGHT;

  // Змейка идёт строками подряд: пока нижняя строка не добрала колонок,
  // следующий терминал остаётся в ней — рядом с предыдущим.
  const bottom = rows.length - 1;
  if (
    mode === "snake" &&
    rows[bottom].length < targetColumns &&
    rowFitsAnotherCell(rows[bottom])
  ) {
    return { kind: "widen", rowIndex: bottom };
  }

  let shortest = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].length < rows[shortest].length) {
      shortest = index;
    }
  }
  if (
    rowFitsAnotherCell(rows[shortest]) &&
    (rows[shortest].length < targetColumns || !newRowFits)
  ) {
    return { kind: "widen", rowIndex: shortest };
  }
  return newRowFits ? { kind: "newRow" } : null;
}

// Строку уже выбрала форма сетки — режим решает только, с какого конца
// встать. Это и есть вся разница между режимами: terminal index → колонка.
function planRowEntry(
  row: readonly TerminalGridGroup[],
  rowIndex: number,
  mode: TerminalSpawnMode,
): TerminalPlacementPlan {
  const toLeft: TerminalPlacementPlan = {
    referenceGroupId: row[0].id,
    direction: "left",
  };
  const toRight: TerminalPlacementPlan = {
    referenceGroupId: row[row.length - 1].id,
    direction: "right",
  };
  if (mode === "snake") {
    // Чётные строки слева направо, нечётные — справа налево.
    return rowIndex % 2 === 0 ? toRight : toLeft;
  }
  if (mode === "centerOut") {
    // Стороны чередуются, поэтому первый терминал строки остаётся в середине.
    return row.length % 2 === 1 ? toLeft : toRight;
  }
  return toRight;
}

function planNewRow(
  rowCount: number,
  mode: TerminalSpawnMode,
): TerminalPlacementPlan {
  // centerOut растит сетку в обе стороны, чтобы первые терминалы остались по
  // центру; остальные режимы всегда добавляют строку снизу.
  return mode === "centerOut" && rowCount % 2 === 1
    ? { direction: "above" }
    : { direction: "below" };
}

export function planTerminalPlacement(
  groups: readonly TerminalGridGroup[],
  mode: TerminalSpawnMode,
): TerminalPlacementPlan | null {
  if (groups.length === 0) {
    return null;
  }
  const rows = splitRows(groups);
  const shape = planGridShape(rows, mode);
  if (!shape) {
    return null;
  }
  return shape.kind === "newRow"
    ? planNewRow(rows.length, mode)
    : planRowEntry(rows[shape.rowIndex], shape.rowIndex, mode);
}

// Вкладок нет — один терминал = одна панель. Режим влияет только на новую
// панель; существующие и восстановленные раскладки не перестраиваются.
export function addTerminalAutoGrid(
  api: DockviewApi,
  workspaceId: string,
  sessionId: string,
  options: AddTerminalAutoGridOptions = {},
) {
  // Жёсткий предел раньше пространственного: 12 терминалов на сессию.
  if (api.panels.length >= MAX_TERMINALS) {
    options.onBlocked?.("limit");
    return;
  }
  const groups = api.groups;
  if (groups.length === 0) {
    addPanel(api, workspaceId, sessionId);
    return;
  }

  const geometry = groups.map((group) => {
    const rect = group.element.getBoundingClientRect();
    return {
      id: group.id,
      left: rect.left,
      top: rect.top,
      width: group.width,
      height: group.height,
    };
  });
  const plan = planTerminalPlacement(geometry, options.mode ?? "balanced");
  if (!plan) {
    options.onBlocked?.("space");
    return;
  }
  const referenceGroup = plan.referenceGroupId
    ? groups.find((group) => group.id === plan.referenceGroupId)
    : undefined;
  if (plan.referenceGroupId && !referenceGroup) {
    options.onBlocked?.("space");
    return;
  }

  // Соседи ужимаются мгновенно, а плавность дорисовывает FLIP поверх.
  const before = snapshotGroupRects(api);
  addPanel(api, workspaceId, sessionId, {
    ...(referenceGroup ? { group: referenceGroup } : {}),
    direction: plan.direction,
  });
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
