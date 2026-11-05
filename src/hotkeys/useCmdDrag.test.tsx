import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi, DockviewGroupPanel } from "dockview";

vi.mock("../platform", () => ({ isMac: false, isTauri: false }));
vi.mock("../animations", () => ({
  flipGroups: vi.fn(),
  snapshotGroupRects: vi.fn(() => new Map()),
}));
vi.mock("../layoutOps", () => ({ swapPanels: vi.fn() }));

import { useCmdDrag, type TerminalSessionDrop } from "./useCmdDrag";
import { swapPanels } from "../layoutOps";

// Панель во всё окно: ⌘-драг ищет её по координатам курсора, так что группе
// нужен только прямоугольник.
function gridWithOnePanel(): DockviewApi {
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  const group = {
    element,
    activePanel: { id: "panel-1", title: "claude" },
    panels: [{ id: "panel-1" }],
  } as unknown as DockviewGroupPanel;
  return { groups: [group] } as unknown as DockviewApi;
}

function mount(
  api: DockviewApi = gridWithOnePanel(),
  sessionDrop?: TerminalSessionDrop,
) {
  renderHook(() =>
    useCmdDrag({
      getApi: () => api,
      suppressCleanupRef: { current: false },
      sessionDrop,
    }),
  );
}

function pointer(type: "pointermove" | "pointerup", x: number, y: number) {
  window.dispatchEvent(
    new MouseEvent(type, {
      clientX: x,
      clientY: y,
      button: 0,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
}

// Строка сессии в боковой панели. elementFromPoint в jsdom нет: под курсором
// окажется то, что вернёт заглушка.
function sessionRow(workspaceId: string, sessionId: string | null) {
  const row = document.createElement("div");
  row.dataset.terminalDrop = sessionId ? "session" : "workspace";
  row.dataset.workspaceId = workspaceId;
  if (sessionId) {
    row.dataset.sessionId = sessionId;
  }
  const name = document.createElement("span");
  row.append(name);
  document.body.append(row);
  return { row, name };
}

function pointAt(element: Element | null) {
  document.elementFromPoint = () => element;
}

// PointerEvent есть не во всех окружениях, а обработчику нужны только
// координаты, кнопка и модификаторы — их несёт и MouseEvent.
function grab(x = 400, y = 300) {
  const event = new MouseEvent("pointerdown", {
    clientX: x,
    clientY: y,
    button: 0,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

function openModal(): HTMLElement {
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  return dialog;
}

afterEach(() => {
  document.body.replaceChildren();
  document.body.className = "";
  vi.mocked(swapPanels).mockClear();
  Reflect.deleteProperty(document, "elementFromPoint");
});

describe("grabbing a terminal with Mod held", () => {
  it("takes the panel under the cursor", () => {
    mount();

    const event = grab();

    expect(document.body).toHaveClass("cmd-dragging");
    expect(event.defaultPrevented).toBe(true);
  });

  it("takes nothing while a modal dialog covers the grid", () => {
    mount();
    openModal();

    const event = grab();

    // Панель ищется по координатам, и диалог для этого поиска прозрачен:
    // терминал переставлялся прямо сквозь открытые настройки.
    expect(document.body).not.toHaveClass("cmd-dragging");
    expect(event.defaultPrevented).toBe(false);
  });

  it("takes the panel again once the dialog closes", () => {
    mount();
    const dialog = openModal();
    grab();
    expect(document.body).not.toHaveClass("cmd-dragging");

    dialog.remove();
    grab();

    expect(document.body).toHaveClass("cmd-dragging");
  });
});

describe("dropping a terminal onto a session in the sidebar", () => {
  function sessions(verdicts: Record<string, ReturnType<TerminalSessionDrop["verdict"]>>) {
    const drop = vi.fn();
    const sessionDrop: TerminalSessionDrop = {
      verdict: (workspaceId, sessionId) =>
        verdicts[`${workspaceId}:${sessionId ?? ""}`] ?? "here",
      drop,
    };
    return { sessionDrop, drop };
  }

  it("carries the terminal to the session it is dropped on", () => {
    const { sessionDrop, drop } = sessions({ "w1:s2": "move" });
    mount(gridWithOnePanel(), sessionDrop);
    const { row, name } = sessionRow("w1", "s2");

    grab(400, 300);
    pointer("pointermove", 420, 320);
    pointAt(name);
    pointer("pointermove", 900, 40);

    expect(row).toHaveClass("is-terminal-drop");
    expect(document.body).not.toHaveClass("cmd-drag-refused");

    pointer("pointerup", 900, 40);

    expect(drop).toHaveBeenCalledWith("panel-1", "w1", "s2");
    expect(row).not.toHaveClass("is-terminal-drop");
    expect(swapPanels).not.toHaveBeenCalled();
  });

  it("says no over a session of another project before the terminal is let go", () => {
    const { sessionDrop, drop } = sessions({ "w2:t1": "foreign" });
    mount(gridWithOnePanel(), sessionDrop);
    const { row } = sessionRow("w2", "t1");

    grab(400, 300);
    pointer("pointermove", 420, 320);
    pointAt(row);
    pointer("pointermove", 900, 80);

    expect(row).toHaveClass("is-terminal-drop-refused");
    expect(document.body).toHaveClass("cmd-drag-refused");

    // Приложение само решит, что сказать про отказ.
    pointer("pointerup", 900, 80);
    expect(drop).toHaveBeenCalledWith("panel-1", "w2", "t1");
    expect(document.body).not.toHaveClass("cmd-drag-refused");
  });

  it("drops the highlight once the cursor leaves the row", () => {
    const { sessionDrop } = sessions({ "w1:s2": "move", "w2:": "foreign" });
    mount(gridWithOnePanel(), sessionDrop);
    const { row } = sessionRow("w1", "s2");
    const { row: other } = sessionRow("w2", null);

    grab(400, 300);
    pointer("pointermove", 420, 320);
    pointAt(row);
    pointer("pointermove", 900, 40);
    pointAt(other);
    pointer("pointermove", 900, 10);

    expect(row).not.toHaveClass("is-terminal-drop");
    expect(other).toHaveClass("is-terminal-drop-refused");

    pointAt(null);
    pointer("pointermove", 500, 300);
    expect(other).not.toHaveClass("is-terminal-drop-refused");
    expect(document.body).not.toHaveClass("cmd-drag-refused");
  });

  it("leaves its own session quietly", () => {
    const { sessionDrop } = sessions({});
    mount(gridWithOnePanel(), sessionDrop);
    const { row } = sessionRow("w1", "s1");

    grab(400, 300);
    pointer("pointermove", 420, 320);
    pointAt(row);
    pointer("pointermove", 900, 40);

    expect(row.className).toBe("");
    expect(document.body).not.toHaveClass("cmd-drag-refused");
  });
});
