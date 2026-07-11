import { MutableRefObject } from "react";
import { DockviewApi, IDockviewPanel } from "dockview";
import { flipGroups, snapshotGroupRects } from "./animations";

// Swap позиций двух панелей через сериализованный layout: меняем их id
// местами в дереве и восстанавливаем. Инстансы xterm живут вне React,
// поэтому обе сессии и буферы переживают пересоздание панелей.
export function swapPanels(
  api: DockviewApi,
  a: IDockviewPanel,
  b: IDockviewPanel,
  suppressCleanup: MutableRefObject<boolean>,
): void {
  const before = snapshotGroupRects(api);
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
  flipGroups(api, before, 250);
}
