// Плашка о странице, которую агент открыл, пока ящик был закрыт.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../i18n";
import { NOTICE_MS, PageOpenedNotice } from "./PageOpenedNotice";
import type { OpenedPage } from "./pagesOpened";

const page: OpenedPage = {
  root: "/w/project",
  url: "http://127.0.0.1:8501/",
  title: "Streamlit",
};

let focused = true;

beforeEach(() => {
  setLocale("ru");
  focused = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function notice(over: Partial<Parameters<typeof PageOpenedNotice>[0]> = {}) {
  const onOpen = vi.fn();
  const onDismiss = vi.fn();
  render(
    <PageOpenedNotice
      page={page}
      otherProject={null}
      more={0}
      onOpen={onOpen}
      onDismiss={onDismiss}
      {...over}
    />,
  );
  return { onOpen, onDismiss };
}

describe("PageOpenedNotice", () => {
  it("says what the agent opened and shows it on request", () => {
    const { onOpen } = notice();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Агент открыл страницу",
    );
    expect(screen.getByRole("status")).toHaveTextContent("Streamlit");
    fireEvent.click(screen.getByRole("button", { name: "Открыть браузер" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("names the project when the page belongs to another one", () => {
    notice({ otherProject: "shop" });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Агент открыл страницу — shop",
    );
  });

  it("counts the other pages the agent opened meanwhile", () => {
    notice({ more: 2 });

    // Показана последняя, а о прочих сказано числом.
    expect(screen.getByRole("status")).toHaveTextContent("Streamlit");
    expect(screen.getByRole("status")).toHaveTextContent("и ещё 2");
  });

  it("says nothing more about a single page", () => {
    notice();

    expect(screen.getByRole("status")).not.toHaveTextContent("ещё");
  });

  it("goes away by itself while the person is here", () => {
    const { onDismiss } = notice();

    act(() => vi.advanceTimersByTime(NOTICE_MS - 1));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("waits for the person to come back to the window", () => {
    // Исчезни она, пока человек в другом приложении, — он бы её не увидел.
    focused = false;
    const { onDismiss } = notice();

    act(() => vi.advanceTimersByTime(NOTICE_MS * 3));
    expect(onDismiss).not.toHaveBeenCalled();

    focused = true;
    act(() => {
      window.dispatchEvent(new FocusEvent("focus"));
    });
    act(() => vi.advanceTimersByTime(NOTICE_MS));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("stays while the pointer is on it", () => {
    const { onDismiss } = notice();
    const card = screen.getByRole("status");

    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(NOTICE_MS * 2));
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(NOTICE_MS));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("can be closed by hand", () => {
    const { onDismiss } = notice();

    fireEvent.click(screen.getByRole("button", { name: "Скрыть" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
