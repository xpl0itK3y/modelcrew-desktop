import { useRef } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useScrollWhenNeeded } from "./useScrollWhenNeeded";

// В jsdom нет ни раскладки, ни ResizeObserver: высоты задаём руками, а
// наблюдателя подменяем, чтобы самим сказать «размер изменился».
let resized: (() => void) | null = null;

class FakeResizeObserver {
  constructor(callback: () => void) {
    resized = callback;
  }
  observe() {}
  disconnect() {
    resized = null;
  }
}

function Column() {
  const column = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  useScrollWhenNeeded(column, page);
  return (
    <div data-testid="column" ref={column} style={{ paddingTop: "20px" }}>
      <div data-testid="page" ref={page} />
    </div>
  );
}

function setHeight(element: HTMLElement, key: string, value: number) {
  Object.defineProperty(element, key, { configurable: true, value });
}

describe("useScrollWhenNeeded", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resized = null;
  });

  it("keeps the bar away while the page fits above the bottom padding", () => {
    const { getByTestId } = render(<Column />);
    const column = getByTestId("column");
    const page = getByTestId("page");

    // Колонка 662px, сверху отступ 20px: странице есть 642px. Раздел в 640px
    // съедает нижний отступ, но виден целиком — прокручивать нечего.
    setHeight(column, "clientHeight", 662);
    setHeight(page, "offsetHeight", 640);
    act(() => resized?.());
    expect(column).not.toHaveAttribute("data-scrollable");

    setHeight(page, "offsetHeight", 643);
    act(() => resized?.());
    expect(column).toHaveAttribute("data-scrollable");
  });

  it("drops the bar and the leftover scroll once the page fits again", () => {
    const { getByTestId } = render(<Column />);
    const column = getByTestId("column");
    const page = getByTestId("page");
    let scrollTop = 0;
    Object.defineProperty(column, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    setHeight(column, "clientHeight", 662);
    setHeight(page, "offsetHeight", 1200);
    act(() => resized?.());
    expect(column).toHaveAttribute("data-scrollable");
    column.scrollTop = 300;

    // Окно выросло: тот же раздел теперь помещается.
    setHeight(column, "clientHeight", 1300);
    act(() => resized?.());
    expect(column).not.toHaveAttribute("data-scrollable");
    expect(scrollTop).toBe(0);
  });
});
