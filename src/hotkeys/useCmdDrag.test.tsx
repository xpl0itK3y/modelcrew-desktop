import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi, DockviewGroupPanel } from "dockview";

vi.mock("../platform", () => ({ isMac: false, isTauri: false }));
vi.mock("../animations", () => ({
  flipGroups: vi.fn(),
  snapshotGroupRects: vi.fn(() => new Map()),
}));
vi.mock("../layoutOps", () => ({ swapPanels: vi.fn() }));

import { useCmdDrag } from "./useCmdDrag";

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
  const group = { element } as unknown as DockviewGroupPanel;
  return { groups: [group] } as unknown as DockviewApi;
}

function mount(api: DockviewApi = gridWithOnePanel()) {
  renderHook(() =>
    useCmdDrag({
      getApi: () => api,
      suppressCleanupRef: { current: false },
    }),
  );
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
