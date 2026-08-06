// Меню строки дерева: куда оно встаёт у краёв окна.

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { FileTreeMenu } from "./FileTreeMenu";

const MENU = { width: 180, height: 160 };

/// jsdom не считает размеров: подставляем те, что меню имело бы на экране.
function measureAs(width: number, height: number) {
  Element.prototype.getBoundingClientRect = vi.fn(
    () =>
      ({
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

function open(x: number, y: number) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  render(
    <FileTreeMenu
      target={{ path: "src/a.txt", name: "a.txt", isDir: false, x, y }}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  return { menu: screen.getByRole("menu"), onPick, onClose };
}

beforeEach(() => {
  setLocale("ru");
  measureAs(MENU.width, MENU.height);
  window.innerWidth = 1200;
  window.innerHeight = 800;
});

describe("FileTreeMenu", () => {
  it("opens down and to the right while there is room", () => {
    const { menu } = open(300, 200);

    expect(menu.style.top).toBe("200px");
    expect(menu.style.left).toBe("300px");
    expect(menu.style.visibility).toBe("visible");
  });

  it("flips up for a row near the bottom", () => {
    // Это и есть та строка, из-за которой удаление казалось несуществующим:
    // меню уходило под край окна целиком.
    const { menu } = open(300, 780);

    expect(menu.style.top).toBe(`${780 - MENU.height}px`);
    // И растёт снизу вверх, иначе появление выглядит как прыжок.
    expect(menu.style.transformOrigin).toBe("bottom left");
  });

  it("flips left at the right edge of the window", () => {
    const { menu } = open(1150, 200);

    expect(menu.style.left).toBe(`${1150 - MENU.width}px`);
  });

  it("presses itself against the edge when it fits nowhere", () => {
    window.innerHeight = 200;

    const { menu } = open(300, 150);

    // Обрезанное меню лучше невидимого: в нём хотя бы видны первые пункты.
    expect(Number.parseInt(menu.style.top, 10)).toBeLessThanOrEqual(150);
    expect(Number.parseInt(menu.style.top, 10)).toBeGreaterThanOrEqual(0);
    expect(menu.style.visibility).toBe("visible");
  });

  it("closes on a click somewhere else", () => {
    const { onClose } = open(300, 200);

    fireEvent.mouseDown(document.body);

    // Висящее меню перехватывает следующий щелчок, и человек нажимает дважды
    // там, где хватило бы раза.
    expect(onClose).toHaveBeenCalled();
  });

  it("hands over exactly the item that was chosen", () => {
    const { onPick } = open(300, 200);

    fireEvent.click(screen.getByRole("menuitem", { name: "Удалить" }));

    expect(onPick).toHaveBeenCalledWith("delete");
  });

  it("walks its items with the arrow keys", () => {
    const { menu } = open(300, 200);
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    // По кругу: в коротком меню это быстрее, чем упираться в край.
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("closes on Escape", () => {
    const { menu, onClose } = open(300, 200);

    fireEvent.keyDown(menu, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });
});
