import { MutableRefObject, useEffect, useRef, useState } from "react";
import { DockviewApi, DockviewGroupPanel, IDockviewPanel } from "dockview";
import { isMac } from "../constants";

// Все хоткеи приложения перехватываются одним capture-слушателем на
// window: он срабатывает раньше xterm, забирает только свои комбинации
// (preventDefault + stopPropagation), всё остальное уходит в шелл.

export type QuickBadge = {
  num: number;
  left: number;
  top: number;
  active: boolean;
};

type Direction = "left" | "right" | "up" | "down";

const ARROW_DIRECTIONS: Record<string, Direction> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

const EDGE_POSITIONS = {
  left: "left",
  right: "right",
  up: "above",
  down: "below",
} as const;

type HotkeyOptions = {
  getApi: () => DockviewApi | null;
  newTerminal: () => void;
  requestCloseGroup: (group: DockviewGroupPanel) => void;
  suppressCleanupRef: MutableRefObject<boolean>;
};

// Визуальный порядок групп: слева-направо, сверху-вниз.
function orderedGroups(api: DockviewApi): DockviewGroupPanel[] {
  return [...api.groups].sort((a, b) => {
    const rectA = a.element.getBoundingClientRect();
    const rectB = b.element.getBoundingClientRect();
    if (Math.abs(rectA.top - rectB.top) > 30) {
      return rectA.top - rectB.top;
    }
    return rectA.left - rectB.left;
  });
}

function findAdjacentGroup(
  api: DockviewApi,
  from: DockviewGroupPanel,
  direction: Direction,
): DockviewGroupPanel | undefined {
  const fromRect = from.element.getBoundingClientRect();
  const fromX = fromRect.left + fromRect.width / 2;
  const fromY = fromRect.top + fromRect.height / 2;

  let best: DockviewGroupPanel | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const group of api.groups) {
    if (group === from) {
      continue;
    }
    const rect = group.element.getBoundingClientRect();
    const dx = rect.left + rect.width / 2 - fromX;
    const dy = rect.top + rect.height / 2 - fromY;
    let forward: number;
    let sideways: number;
    switch (direction) {
      case "left":
        forward = -dx;
        sideways = Math.abs(dy);
        break;
      case "right":
        forward = dx;
        sideways = Math.abs(dy);
        break;
      case "up":
        forward = -dy;
        sideways = Math.abs(dx);
        break;
      case "down":
        forward = dy;
        sideways = Math.abs(dx);
        break;
    }
    if (forward <= 1) {
      continue;
    }
    // Ближайшая группа в конусе направления: боковой увод штрафуем вдвое.
    const score = forward + sideways * 2;
    if (score < bestScore) {
      bestScore = score;
      best = group;
    }
  }
  return best;
}

// Swap позиций двух панелей через сериализованный layout: меняем их id
// местами в дереве и восстанавливаем. Инстансы xterm живут вне React,
// поэтому обе сессии и буферы переживают пересоздание панелей.
function swapPanels(
  api: DockviewApi,
  a: IDockviewPanel,
  b: IDockviewPanel,
  suppressCleanup: MutableRefObject<boolean>,
): void {
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
}

export function useHotkeys(options: HotkeyOptions): QuickBadge[] | null {
  const [badges, setBadges] = useState<QuickBadge[] | null>(null);
  const overlayGroupsRef = useRef<DockviewGroupPanel[] | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const getApi = () => optionsRef.current.getApi();

    const showBadges = () => {
      const api = getApi();
      if (!api || api.groups.length < 2) {
        return;
      }
      const groups = orderedGroups(api);
      overlayGroupsRef.current = groups;
      setBadges(
        groups.map((group, index) => {
          const rect = group.element.getBoundingClientRect();
          return {
            num: index + 1,
            left: rect.left + rect.width / 2,
            top: rect.top + rect.height / 2,
            active: group === api.activeGroup,
          };
        }),
      );
    };

    const hideBadges = () => {
      if (overlayGroupsRef.current !== null) {
        overlayGroupsRef.current = null;
        setBadges(null);
      }
    };

    const consume = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const api = getApi();
      if (!api) {
        return;
      }
      const mod = isMac ? event.metaKey : event.ctrlKey;

      // Режим быстрой навигации: пока удерживаются Mod+Alt, поверх
      // терминалов висят номера.
      if (mod && event.altKey) {
        if (overlayGroupsRef.current === null) {
          showBadges();
        }
      } else if (overlayGroupsRef.current !== null) {
        hideBadges();
      }

      if (!mod) {
        return;
      }
      const { code } = event;

      // Mod+Alt+цифра — фокус; Mod+Alt+Shift+цифра — swap.
      const digitMatch = /^(?:Digit|Numpad)([1-9])$/.exec(code);
      if (event.altKey && digitMatch) {
        consume(event);
        const target = overlayGroupsRef.current?.[Number(digitMatch[1]) - 1];
        const targetPanel = target?.activePanel;
        if (!targetPanel) {
          return;
        }
        const activePanel = api.activePanel;
        if (event.shiftKey) {
          if (activePanel && activePanel !== targetPanel) {
            swapPanels(
              api,
              activePanel,
              targetPanel,
              optionsRef.current.suppressCleanupRef,
            );
            // Layout пересоздан — пересчитываем позиции бейджей.
            showBadges();
          }
        } else {
          targetPanel.api.setActive();
          showBadges();
        }
        return;
      }

      const arrow = ARROW_DIRECTIONS[code];

      // Mod+Alt+стрелка — фокус на соседний терминал.
      if (event.altKey && !event.shiftKey && arrow) {
        consume(event);
        const from = api.activeGroup;
        if (!from) {
          return;
        }
        const next = findAdjacentGroup(api, from, arrow);
        if (next) {
          next.activePanel?.api.setActive();
          if (overlayGroupsRef.current !== null) {
            showBadges();
          }
        }
        return;
      }

      // Mod+Shift+стрелка — перенос: меняемся местами с соседом в этом
      // направлении (вкладок нет), у края окна — новый сплит по краю.
      if (event.shiftKey && !event.altKey && arrow) {
        consume(event);
        const panel = api.activePanel;
        if (!panel) {
          return;
        }
        const from = panel.group;
        const adjacent = findAdjacentGroup(api, from, arrow);
        if (adjacent) {
          const neighbor = adjacent.activePanel;
          if (neighbor) {
            swapPanels(
              api,
              panel,
              neighbor,
              optionsRef.current.suppressCleanupRef,
            );
          }
        } else {
          // У края окна — новый сплит по этому краю.
          if (api.groups.length === 1 && from.panels.length === 1) {
            return;
          }
          const group = api.addGroup({ direction: EDGE_POSITIONS[arrow] });
          panel.api.moveTo({ group });
        }
        return;
      }

      // Mod+Alt+плюс/минус — шаговый ресайз активной панели на 5%.
      if (
        event.altKey &&
        (code === "Equal" ||
          code === "Minus" ||
          code === "NumpadAdd" ||
          code === "NumpadSubtract")
      ) {
        consume(event);
        const group = api.activeGroup;
        if (!group) {
          return;
        }
        const grow = code === "Equal" || code === "NumpadAdd";
        const factor = grow ? 1.05 : 1 / 1.05;
        group.api.setSize({
          width: group.width * factor,
          height: group.height * factor,
        });
        return;
      }

      if (event.altKey) {
        return;
      }

      // Mod+Enter — зум активного терминала / возврат раскладки.
      if (!event.shiftKey && code === "Enter") {
        consume(event);
        const panel = api.activePanel;
        if (!panel) {
          return;
        }
        if (panel.api.isMaximized()) {
          panel.api.exitMaximized();
        } else {
          panel.api.maximize();
        }
        return;
      }

      // Mod+T (и Mod+Shift+T) — новый терминал в сетку.
      if (code === "KeyT") {
        consume(event);
        optionsRef.current.newTerminal();
        return;
      }

      // Mod+W — закрыть терминал; Mod+Shift+W — группу (с подтверждением).
      if (code === "KeyW") {
        consume(event);
        if (event.shiftKey) {
          const group = api.activeGroup;
          if (group) {
            optionsRef.current.requestCloseGroup(group);
          }
        } else {
          api.activePanel?.api.close();
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const modStillHeld = isMac ? event.metaKey : event.ctrlKey;
      if (!modStillHeld || !event.altKey) {
        hideBadges();
      }
    };

    // Если окно теряет фокус с зажатыми клавишами, keyup не придёт.
    const onBlur = () => hideBadges();

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
    };
  }, []);

  return badges;
}
