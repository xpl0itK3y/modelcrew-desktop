// Экран страницы внизу ящика: вписанный размер, поворот и кнопки.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import {
  forgetScreen,
  loadSavedScreens,
  loadScreen,
  saveScreen,
} from "./pageDevice";
import { PageScreenControls } from "./PageScreenControls";

const DRAWER = { width: 699, height: 316 };

beforeEach(() => {
  setLocale("ru");
  localStorage.clear();
  saveScreen(null);
  for (const size of loadSavedScreens()) {
    forgetScreen(size);
  }
});

const list = () => screen.getByRole("combobox", { name: "Другие экраны" });

const width = () => screen.getByRole("textbox", { name: "Ширина страницы" });
const height = () => screen.getByRole("textbox", { name: "Высота страницы" });

function type(field: HTMLElement, value: string) {
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value } });
}

describe("PageScreenControls", () => {
  it("shows how big the page is and takes a size typed over it", () => {
    render(<PageScreenControls viewport={DRAWER} />);
    expect(width()).toHaveValue("699");
    expect(height()).toHaveValue("316");

    type(width(), "1280");
    fireEvent.keyDown(width(), { key: "Enter" });

    expect(loadScreen()).toEqual({ width: 1280, height: 316 });
    expect(width()).toHaveValue("1280");
  });

  it("waits for both sides before changing the page", () => {
    render(<PageScreenControls viewport={DRAWER} />);

    type(width(), "1024");
    fireEvent.blur(width(), { relatedTarget: height() });
    // Переход к высоте — ещё не конец ввода.
    expect(loadScreen()).toBeNull();

    type(height(), "600");
    fireEvent.blur(height());

    expect(loadScreen()).toEqual({ width: 1024, height: 600 });
  });

  it("throws the typed size away on Escape", () => {
    render(<PageScreenControls viewport={DRAWER} />);

    type(width(), "1024");
    fireEvent.keyDown(width(), { key: "Escape" });

    expect(loadScreen()).toBeNull();
    expect(width()).toHaveValue("699");
  });

  it("keeps a typed size within what the page can take", () => {
    render(<PageScreenControls viewport={DRAWER} />);

    type(width(), "100");
    fireEvent.keyDown(width(), { key: "Enter" });

    expect(loadScreen()).toEqual({ width: 200, height: 316 });
  });

  it("leaves the page alone when nothing was changed", () => {
    render(<PageScreenControls viewport={DRAWER} />);

    type(width(), "699");
    fireEvent.keyDown(width(), { key: "Enter" });

    // Во весь ящик и остаётся: размер ящика — не свой экран.
    expect(loadScreen()).toBeNull();
  });

  it("turns the screen on its side and keeps its button lit", () => {
    render(<PageScreenControls viewport={DRAWER} />);
    expect(
      screen.queryByRole("button", { name: "Повернуть экран" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Телефон/ }));

    fireEvent.click(screen.getByRole("button", { name: "Повернуть экран" }));

    expect(loadScreen()).toEqual({ width: 844, height: 390 });
    expect(screen.getByRole("button", { name: /^Телефон/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("says so when the screen is bigger than the drawer", () => {
    render(<PageScreenControls viewport={DRAWER} />);

    act(() => saveScreen({ width: 1920, height: 1080 }));

    const fields = screen.getByRole("group", { name: "Размер страницы" });
    expect(fields).toHaveClass("is-squeezed");
    expect(fields.title).toContain("699 × 316");
    expect(width()).toHaveValue("1920");
  });

  it("offers common devices to pick from", () => {
    render(<PageScreenControls viewport={DRAWER} />);
    expect(
      screen.getByRole("option", { name: "iPhone SE — 375 × 667" }),
    ).toBeInTheDocument();

    fireEvent.change(list(), { target: { value: "375x667" } });

    expect(loadScreen()).toEqual({ width: 375, height: 667 });
  });

  it("keeps a size of one's own in the list until it is forgotten", () => {
    render(<PageScreenControls viewport={DRAWER} />);
    act(() => saveScreen({ width: 1500, height: 900 }));

    fireEvent.change(list(), { target: { value: "remember" } });

    expect(loadSavedScreens()).toEqual([{ width: 1500, height: 900 }]);
    expect(
      screen.getByRole("option", { name: "1500 × 900" }),
    ).toBeInTheDocument();
    // Нынешний размер в списке — система отметит его.
    expect(list()).toHaveValue("1500x900");

    fireEvent.change(list(), { target: { value: "forget" } });

    expect(loadSavedScreens()).toEqual([]);
    expect(
      screen.queryByRole("option", { name: "1500 × 900" }),
    ).not.toBeInTheDocument();
  });
});
