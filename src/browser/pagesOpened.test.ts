// Подпись страницы, которую открыл агент.

import { describe, expect, it } from "vitest";
import { createPageNews, pageLabel, type OpenedPage } from "./pagesOpened";

const page = (over: Partial<OpenedPage> = {}): OpenedPage => ({
  root: "/w/project",
  panelId: "panel-a",
  url: "https://example.com/",
  title: "Example Domain",
  ...over,
});

const away = { watchedRoot: null, focused: false };
const here = { watchedRoot: null, focused: true };

describe("createPageNews", () => {
  it("tells about an agent once, however many pages it opens", () => {
    // Агент открывает страницы сериями; плашка и баннер на каждую — это спам.
    const news = createPageNews();

    expect(news(page(), away)).toEqual({
      count: true,
      notice: true,
      banner: true,
    });
    for (const url of ["https://example.com/a", "https://example.com/b"]) {
      // Страницы считаются на глобусе, но молча.
      expect(news(page({ url }), away)).toEqual({
        count: true,
        notice: false,
        banner: false,
      });
    }
  });

  it("keeps quiet about the agent after the person comes back", () => {
    // Раньше возвращение в окно открывало дорогу новому баннеру, и агент,
    // открывавший страницы, пока человек отходил, звонил снова.
    const news = createPageNews();
    news(page(), here);

    expect(news(page({ url: "https://example.com/a" }), away).banner).toBe(
      false,
    );
    expect(news(page({ url: "https://example.com/b" }), here).notice).toBe(
      false,
    );
  });

  it("tells about each agent of its own", () => {
    const news = createPageNews();
    news(page(), away);

    // Другой агент того же проекта — другая новость.
    expect(news(page({ panelId: "panel-b" }), away)).toEqual({
      count: true,
      notice: true,
      banner: true,
    });
    expect(news(page({ panelId: "panel-c", root: "/w/blog" }), here)).toEqual({
      count: true,
      notice: true,
      banner: false,
    });
  });

  it("does not ring about a page already in front of the person", () => {
    const news = createPageNews();
    const watching = { watchedRoot: "/w/project", focused: true };

    // Ящик этого проекта открыт: страница перед глазами, а с ней и агент.
    expect(news(page(), watching)).toEqual({
      count: false,
      notice: false,
      banner: false,
    });
    expect(news(page({ url: "https://example.com/a" }), here)).toEqual({
      count: true,
      notice: false,
      banner: false,
    });
  });

  it("calls the person back when the open drawer is in a window behind", () => {
    const news = createPageNews();

    expect(news(page(), { watchedRoot: "/w/project", focused: false })).toEqual(
      { count: false, notice: false, banner: true },
    );
  });
});

describe("pageLabel", () => {
  it("calls the page by its title", () => {
    expect(pageLabel(page())).toBe("Example Domain");
  });

  it("falls back to the address when the page has no title", () => {
    // Пустой баннер хуже адреса: по адресу человек хотя бы узнаёт стенд.
    expect(pageLabel(page({ title: "" }))).toBe("https://example.com/");
    expect(pageLabel(page({ title: "   " }))).toBe("https://example.com/");
  });

  it("does not let the page decide how big the banner is", () => {
    // Заголовок пишет сама страница, и написать она может что угодно.
    const long = pageLabel(page({ title: "я".repeat(500) }), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });
});
