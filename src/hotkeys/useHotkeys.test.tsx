import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi, DockviewGroupPanel } from "dockview";

// Хоткеи проверяем в одиночку: анимации и пересборка раскладки живут в
// dockview и в DOM, а нас интересует только то, кого обработчик слушает.
vi.mock("../platform", () => ({ isMac: false, isTauri: false }));
vi.mock("../animations", () => ({
  closePanelAnimated: vi.fn(),
  flipGroups: vi.fn(),
  snapshotGroupRects: vi.fn(() => new Map()),
  togglePanelMaximized: vi.fn(),
}));
vi.mock("../layoutOps", () => ({ swapPanels: vi.fn() }));

import { useHotkeys } from "./useHotkeys";

// Сетка в объёме, которого хватает разбору комбинации: сами перестановки
// делают замоканные помощники.
function emptyGrid(): DockviewApi {
  return {
    groups: [],
    panels: [],
    activePanel: null,
    activeGroup: null,
  } as unknown as DockviewApi;
}

function mount(api: DockviewApi = emptyGrid()) {
  const newTerminal = vi.fn();
  const requestCloseGroup = vi.fn((_group: DockviewGroupPanel) => {});
  renderHook(() =>
    useHotkeys({
      getApi: () => api,
      newTerminal,
      requestCloseGroup,
      suppressCleanupRef: { current: false },
    }),
  );
  return { newTerminal };
}

// Mod здесь Ctrl: платформа замокана как не-mac.
function press(code: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    code,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
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
});

describe("grid shortcuts while a dialog covers the grid", () => {
  it("works when the grid is what the user is looking at", () => {
    const { newTerminal } = mount();

    const event = press("KeyT");

    expect(newTerminal).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("stays out of it while a modal dialog is open", () => {
    const { newTerminal } = mount();
    openModal();

    press("KeyT");

    // Панель завелась бы за диалогом — увидеть её можно только закрыв его.
    expect(newTerminal).not.toHaveBeenCalled();
  });

  it("lets the dialog have the keystroke instead of eating it", () => {
    mount();
    openModal();

    // Обработчик висит на window в фазе перехвата и раньше отбирал комбинацию
    // у диалога: Ctrl+A в поиске настроек не выделял бы строку.
    expect(press("KeyA").defaultPrevented).toBe(false);
    expect(press("KeyW").defaultPrevented).toBe(false);
  });

  it("hears the grid again once the dialog closes", () => {
    const { newTerminal } = mount();
    const dialog = openModal();
    press("KeyT");

    dialog.remove();
    press("KeyT");

    expect(newTerminal).toHaveBeenCalledTimes(1);
  });

  it("keeps listening under a non-modal overlay", () => {
    // Всплывающее окно обновления не модальное: оно ничего не перекрывает.
    const { newTerminal } = mount();
    const popover = document.createElement("div");
    popover.setAttribute("aria-modal", "false");
    document.body.append(popover);

    press("KeyT");

    expect(newTerminal).toHaveBeenCalledTimes(1);
  });
});
