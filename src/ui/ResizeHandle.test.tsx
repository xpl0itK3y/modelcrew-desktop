// Разделитель колонок: перетаскивание, клавиши и границы.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { ResizeHandle } from "./ResizeHandle";
import { clampWidth, widthLimits } from "./columnWidths";

beforeEach(() => {
  setLocale("ru");
  document.body.className = "";
});

function handle(props: Partial<Parameters<typeof ResizeHandle>[0]> = {}) {
  const onResize = vi.fn();
  const onResizeEnd = vi.fn();
  const onReset = vi.fn();
  render(
    <ResizeHandle
      width={240}
      min={180}
      max={480}
      label="Файлы"
      onResize={onResize}
      onResizeEnd={onResizeEnd}
      onReset={onReset}
      {...props}
    />,
  );
  const element = screen.getByRole("separator");
  // jsdom не знает о захвате указателя, а без этих заглушек обработчик падает
  // на первом же нажатии.
  element.setPointerCapture = vi.fn();
  element.releasePointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn(() => true);
  return { element, onResize, onResizeEnd, onReset };
}

describe("ResizeHandle", () => {
  it("reports the width the pointer dragged to", () => {
    const { element, onResize } = handle();

    fireEvent.pointerDown(element, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(element, { clientX: 160, pointerId: 1 });

    // Ширина считается от места захвата, а не от текущего положения курсора:
    // иначе колонка прыгает на разницу при первом же движении.
    expect(onResize).toHaveBeenLastCalledWith(300);
  });

  it("ignores movement until it has been grabbed", () => {
    const { element, onResize } = handle();

    fireEvent.pointerMove(element, { clientX: 500, pointerId: 1 });

    // Курсор проезжает над разделителем постоянно; двигать колонку он не должен.
    expect(onResize).not.toHaveBeenCalled();
  });

  it("leaves the right mouse button to the context menu", () => {
    const { element, onResize } = handle();

    fireEvent.pointerDown(element, { button: 2, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(element, { clientX: 160, pointerId: 1 });

    expect(onResize).not.toHaveBeenCalled();
  });

  it("saves only once the drag is over", () => {
    const { element, onResize, onResizeEnd } = handle();

    fireEvent.pointerDown(element, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(element, { clientX: 130, pointerId: 1 });
    fireEvent.pointerMove(element, { clientX: 160, pointerId: 1 });
    expect(onResizeEnd).not.toHaveBeenCalled();

    fireEvent.pointerUp(element, { pointerId: 1 });

    // Писать в хранилище на каждый кадр перетаскивания незачем: это десятки
    // записей за один жест.
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps the pointer from selecting text mid-drag", () => {
    const { element } = handle();

    fireEvent.pointerDown(element, { button: 0, clientX: 100, pointerId: 1 });
    expect(document.body.classList.contains("is-resizing")).toBe(true);

    fireEvent.pointerUp(element, { pointerId: 1 });
    // Метка обязана сняться: иначе окно остаётся с курсором-стрелкой и без
    // выделения текста до самой перезагрузки.
    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });

  it("lets go of the drag when the pointer is taken away", () => {
    const { element, onResizeEnd } = handle();

    fireEvent.pointerDown(element, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerCancel(element, { pointerId: 1 });

    // Системный жест или потеря окна отменяют захват: колонка не должна
    // остаться прилипшей к курсору.
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains("is-resizing")).toBe(false);
  });

  it("moves by the arrow keys too", () => {
    const { element, onResize, onResizeEnd } = handle();

    fireEvent.keyDown(element, { key: "ArrowRight" });
    fireEvent.keyDown(element, { key: "ArrowLeft" });

    expect(onResize).toHaveBeenNthCalledWith(1, 256);
    expect(onResize).toHaveBeenNthCalledWith(2, 224);
    // Клавишами ширину доводят по одному шагу, и каждый шаг — законченный
    // жест: сохранять его нужно сразу.
    expect(onResizeEnd).toHaveBeenCalledTimes(2);
  });

  it("says what it resizes and where it stands", () => {
    const { element } = handle();

    expect(element.getAttribute("aria-valuenow")).toBe("240");
    expect(element.getAttribute("aria-valuemin")).toBe("180");
    expect(element.getAttribute("aria-valuemax")).toBe("480");
    expect(element.getAttribute("aria-label")).toContain("Файлы");
  });

  it("restores the original width on a double click", () => {
    const { element, onReset } = handle();

    fireEvent.doubleClick(element);

    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe("clampWidth", () => {
  it("keeps a column from collapsing to nothing", () => {
    // Схлопнутую в ноль колонку обратно не вытянуть: за неё нечем взяться.
    for (const column of ["sidebar", "tree", "editor"] as const) {
      const { min, max } = widthLimits(column);
      expect(clampWidth(column, 0)).toBe(min);
      expect(clampWidth(column, -400)).toBe(min);
      expect(clampWidth(column, 10_000)).toBe(max);
    }
  });

  it("falls back when the stored number is nonsense", () => {
    expect(clampWidth("tree", Number.NaN)).toBe(widthLimits("tree").fallback);
  });
});
