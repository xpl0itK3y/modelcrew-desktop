import { MutableRefObject, useEffect, useRef } from "react";
import { DockviewApi, DockviewGroupPanel } from "dockview";
import { isMac } from "../constants";
import { flipGroups, snapshotGroupRects } from "../animations";
import { swapPanels } from "../layoutOps";
import { translate } from "../i18n";

// ⌘-драг: зажал Mod, схватил терминал за любое место — под курсором
// призрак панели; дроп на другой терминал меняет их местами, дроп у
// края dock-области создаёт новый сплит по этому краю.

const DRAG_THRESHOLD_PX = 5;
const EDGE_BAND_PX = 36;

type Edge = "left" | "right" | "above" | "below";

type DragSession = {
  sourceGroup: DockviewGroupPanel;
  startX: number;
  startY: number;
  active: boolean;
  ghost: HTMLDivElement | null;
  edgeIndicator: HTMLDivElement | null;
  target: DockviewGroupPanel | null;
  edge: Edge | null;
};

type CmdDragOptions = {
  getApi: () => DockviewApi | null;
  suppressCleanupRef: MutableRefObject<boolean>;
};

function groupAtPoint(
  api: DockviewApi,
  x: number,
  y: number,
): DockviewGroupPanel | undefined {
  return api.groups.find((group) => {
    const rect = group.element.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  });
}

function edgeAtPoint(x: number, y: number): Edge | null {
  const dock = document.querySelector(".dock-area");
  if (!dock) {
    return null;
  }
  const rect = dock.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    return null;
  }
  if (x - rect.left < EDGE_BAND_PX) {
    return "left";
  }
  if (rect.right - x < EDGE_BAND_PX) {
    return "right";
  }
  if (y - rect.top < EDGE_BAND_PX) {
    return "above";
  }
  if (rect.bottom - y < EDGE_BAND_PX) {
    return "below";
  }
  return null;
}

function positionEdgeIndicator(indicator: HTMLDivElement, edge: Edge): void {
  const dock = document.querySelector(".dock-area");
  if (!dock) {
    return;
  }
  const rect = dock.getBoundingClientRect();
  const thickness = 4;
  const styles: Record<Edge, Partial<CSSStyleDeclaration>> = {
    left: {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${thickness}px`,
      height: `${rect.height}px`,
    },
    right: {
      left: `${rect.right - thickness}px`,
      top: `${rect.top}px`,
      width: `${thickness}px`,
      height: `${rect.height}px`,
    },
    above: {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${thickness}px`,
    },
    below: {
      left: `${rect.left}px`,
      top: `${rect.bottom - thickness}px`,
      width: `${rect.width}px`,
      height: `${thickness}px`,
    },
  };
  Object.assign(indicator.style, styles[edge]);
}

export function useCmdDrag(options: CmdDragOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let session: DragSession | null = null;

    const clearTargetHighlight = () => {
      if (session?.target) {
        session.target.element.classList.remove("cmd-drag-over");
        session.target = null;
      }
      if (session?.edgeIndicator) {
        session.edgeIndicator.remove();
        session.edgeIndicator = null;
      }
      if (session) {
        session.edge = null;
      }
    };

    const teardownVisuals = () => {
      if (!session) {
        return;
      }
      clearTargetHighlight();
      session.ghost?.remove();
      session.sourceGroup.element.classList.remove("cmd-drag-source");
      document.body.classList.remove("cmd-dragging");
    };

    const cancel = () => {
      teardownVisuals();
      session = null;
    };

    const onPointerDown = (event: PointerEvent) => {
      const mod = isMac ? event.metaKey : event.ctrlKey;
      if (!mod || event.button !== 0 || event.altKey || event.shiftKey) {
        return;
      }
      const api = optionsRef.current.getApi();
      if (!api) {
        return;
      }
      const group = groupAtPoint(api, event.clientX, event.clientY);
      if (!group) {
        return;
      }
      // Не отдаём событие xterm — иначе начнётся выделение текста.
      event.preventDefault();
      event.stopPropagation();
      session = {
        sourceGroup: group,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        ghost: null,
        edgeIndicator: null,
        target: null,
        edge: null,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!session) {
        return;
      }
      const api = optionsRef.current.getApi();
      if (!api) {
        cancel();
        return;
      }

      if (!session.active) {
        const moved = Math.hypot(
          event.clientX - session.startX,
          event.clientY - session.startY,
        );
        if (moved < DRAG_THRESHOLD_PX) {
          return;
        }
        session.active = true;
        const ghost = document.createElement("div");
        ghost.className = "cmd-drag-ghost";
        ghost.textContent =
          session.sourceGroup.activePanel?.title ?? translate("terminal.defaultTitle");
        document.body.appendChild(ghost);
        session.ghost = ghost;
        session.sourceGroup.element.classList.add("cmd-drag-source");
        document.body.classList.add("cmd-dragging");
      }

      if (session.ghost) {
        session.ghost.style.transform = `translate(${event.clientX + 14}px, ${
          event.clientY + 14
        }px)`;
      }

      const edge = edgeAtPoint(event.clientX, event.clientY);
      const target = edge
        ? null
        : groupAtPoint(api, event.clientX, event.clientY);

      const nextTarget =
        target && target !== session.sourceGroup ? target : null;
      if (session.target !== nextTarget || session.edge !== edge) {
        clearTargetHighlight();
        if (nextTarget) {
          nextTarget.element.classList.add("cmd-drag-over");
          session.target = nextTarget;
        }
        if (edge) {
          const indicator = document.createElement("div");
          indicator.className = "edge-drop-indicator";
          positionEdgeIndicator(indicator, edge);
          document.body.appendChild(indicator);
          session.edgeIndicator = indicator;
          session.edge = edge;
        }
      }
    };

    const onPointerUp = () => {
      if (!session) {
        return;
      }
      const api = optionsRef.current.getApi();
      const { sourceGroup, target, edge, active } = session;
      teardownVisuals();
      session = null;

      if (!active || !api) {
        return;
      }
      const sourcePanel = sourceGroup.activePanel;
      if (!sourcePanel) {
        return;
      }

      if (edge) {
        // Дроп у края — новый сплит по этому краю окна.
        if (api.groups.length === 1 && sourceGroup.panels.length === 1) {
          return;
        }
        const before = snapshotGroupRects(api);
        const group = api.addGroup({ direction: edge });
        sourcePanel.api.moveTo({ group });
        flipGroups(api, before, 200);
      } else if (target) {
        const targetPanel = target.activePanel;
        if (targetPanel) {
          swapPanels(
            api,
            sourcePanel,
            targetPanel,
            optionsRef.current.suppressCleanupRef,
          );
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      // Отпустил Mod посреди перетаскивания — отмена.
      if (session && (event.key === "Meta" || event.key === "Control")) {
        cancel();
      }
    };

    const onBlur = () => cancel();

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      cancel();
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
