// Консоль под страницей: высота, которую тянут за верхний край.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { KEYS, readSetting, writeSetting } from "../settings/storage";
import { PageConsolePanel } from "./PageConsolePanel";

// jsdom ничего не раскладывает: высоту ящика задаём сами.
const ROOM = 600;

// Наблюдатель отвечает сразу, как и настоящий после первой раскладки.
class InstantObserver {
  private readonly report: () => void;
  constructor(report: () => void) {
    this.report = report;
  }
  observe() {
    this.report();
  }
  disconnect() {}
}

beforeEach(() => {
  setLocale("ru");
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", InstantObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openConsole() {
  const drawer = document.createElement("div");
  Object.defineProperty(drawer, "clientHeight", { value: ROOM });
  document.body.append(drawer);
  render(
    <PageConsolePanel
      entries={[]}
      lost={0}
      running
      trouble={null}
      onClear={() => {}}
    />,
    { container: drawer },
  );
  const edge = screen.getByRole("separator");
  // jsdom не знает о захвате указателя.
  edge.setPointerCapture = vi.fn();
  edge.releasePointerCapture = vi.fn();
  edge.hasPointerCapture = vi.fn(() => true);
  return { edge, panel: screen.getByRole("region", { name: "Консоль" }) };
}

function drag(edge: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(edge, { button: 0, clientY: from, pointerId: 1 });
  fireEvent.pointerMove(edge, { clientY: to, pointerId: 1 });
  fireEvent.pointerUp(edge, { pointerId: 1 });
}

describe("PageConsolePanel height", () => {
  it("takes about a third of the drawer until pulled", () => {
    const { panel } = openConsole();

    expect(panel.style.height).toBe("216px");
  });

  it("grows when its top edge is pulled up and remembers it", () => {
    const { edge, panel } = openConsole();

    drag(edge, 400, 340);

    expect(panel.style.height).toBe("276px");
    expect(readSetting(KEYS.browserConsoleHeight)).toBe("276");
  });

  it("leaves the page in sight however far it is pulled", () => {
    const { edge, panel } = openConsole();

    drag(edge, 400, -2_000);
    // Консоль не съедает ящик: странице с её строками остаётся своё.
    expect(panel.style.height).toBe("400px");

    drag(edge, 100, 2_000);
    // И не схлопывается: за пустую полоску потом не взяться.
    expect(panel.style.height).toBe("96px");
    expect(readSetting(KEYS.browserConsoleHeight)).toBe("96");
  });

  it("comes back at the height it was left at", () => {
    writeSetting(KEYS.browserConsoleHeight, "300");

    const { panel } = openConsole();

    expect(panel.style.height).toBe("300px");
  });

  it("goes back to the usual height on a double click", () => {
    writeSetting(KEYS.browserConsoleHeight, "300");
    const { edge, panel } = openConsole();

    fireEvent.doubleClick(edge);

    expect(panel.style.height).toBe("216px");
    expect(readSetting(KEYS.browserConsoleHeight)).toBeNull();
  });
});
