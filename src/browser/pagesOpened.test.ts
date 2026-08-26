// Подпись страницы, которую открыл агент.

import { describe, expect, it } from "vitest";
import { pageLabel, type OpenedPage } from "./pagesOpened";

const page = (over: Partial<OpenedPage> = {}): OpenedPage => ({
  root: "/w/project",
  url: "https://example.com/",
  title: "Example Domain",
  ...over,
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
