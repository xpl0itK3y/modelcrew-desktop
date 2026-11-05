// Поиск по файлу: что находится и что показывается.

import { describe, expect, it } from "vitest";
import {
  findAll,
  lineAt,
  lineTarget,
  MAX_MATCHES,
  nearest,
  replaceAll,
  stepFrom,
} from "./search";
import { lineOffsets } from "./highlight";

describe("findAll", () => {
  it("finds every occurrence, whatever the case", () => {
    const found = findAll("Есть Дом и дом и ДОМ", "дом");

    expect(found.at).toEqual([5, 11, 17]);
    expect(found.length).toBe(3);
  });

  it("does not let matches overlap", () => {
    // Пересекающиеся совпадения нельзя ни подсветить, ни пересчитать.
    expect(findAll("aaaa", "aa").at).toEqual([0, 2]);
  });

  it("finds what a regular expression would have taken for a rule", () => {
    expect(findAll("items[0].name", "[0].").at).toEqual([5]);
    expect(findAll("путь\\n снова", "\\n").at).toEqual([4]);
  });

  it("finds nothing in an empty query", () => {
    expect(findAll("текст", "").at).toEqual([]);
  });

  it("admits when there are more matches than it will show", () => {
    const found = findAll("а".repeat(MAX_MATCHES + 10), "а");

    expect(found.at).toHaveLength(MAX_MATCHES);
    expect(found.capped).toBe(true);
  });
});

describe("lineAt", () => {
  it("names the line a position falls on", () => {
    const offsets = lineOffsets("первая\nвторая\nтретья");

    expect(lineAt(offsets, 0)).toBe(0);
    expect(lineAt(offsets, 6)).toBe(0);
    expect(lineAt(offsets, 7)).toBe(1);
    expect(lineAt(offsets, 19)).toBe(2);
  });
});

describe("nearest", () => {
  it("stays where the eye already is", () => {
    expect(nearest([10, 40, 90], 41)).toBe(2);
    expect(nearest([10, 40, 90], 10)).toBe(0);
    // За последним совпадением поиск идёт по кругу.
    expect(nearest([10, 40, 90], 200)).toBe(0);
  });
});

describe("lineTarget", () => {
  const text = "первая\nвторая\nтретья";
  const offsets = lineOffsets(text);
  const go = (query: string) => lineTarget(query, offsets, text.length);

  it("goes to the start of the line by its number", () => {
    expect(go("2")).toBe(text.indexOf("вторая"));
    expect(go("  3 ")).toBe(text.indexOf("третья"));
  });

  it("takes a column after a colon, the way errors print it", () => {
    expect(go("2:3")).toBe(text.indexOf("вторая") + 2);
    expect(go("2, 3")).toBe(text.indexOf("вторая") + 2);
  });

  it("stops at the edge instead of going nowhere", () => {
    // За концом файла — последняя строка, за концом строки — её конец.
    expect(go("99")).toBe(text.indexOf("третья"));
    expect(go("1:99")).toBe("первая".length);
    expect(go("3:99")).toBe(text.length);
    expect(go("0")).toBe(0);
  });

  it("refuses what is not a number", () => {
    expect(go("")).toBeNull();
    expect(go("abc")).toBeNull();
    expect(go("2:")).toBeNull();
    expect(go("-1")).toBeNull();
  });
});

describe("stepFrom", () => {
  const matches = [10, 40, 90];

  it("goes forward from the end of the selection", () => {
    // Выделено само совпадение — следующее за ним, а не оно же.
    expect(stepFrom(matches, 40, 43, 1)).toBe(2);
    expect(stepFrom(matches, 41, 41, 1)).toBe(2);
    expect(stepFrom(matches, 0, 0, 1)).toBe(0);
    // За последним — первое.
    expect(stepFrom(matches, 95, 95, 1)).toBe(0);
  });

  it("goes back from the start of the selection", () => {
    expect(stepFrom(matches, 40, 43, -1)).toBe(0);
    expect(stepFrom(matches, 95, 95, -1)).toBe(2);
    // Перед первым — последнее.
    expect(stepFrom(matches, 5, 5, -1)).toBe(2);
  });
});

describe("replaceAll", () => {
  it("replaces every occurrence, whatever the case", () => {
    expect(replaceAll("Дом, дом и ДОМ", "дом", "сад")).toEqual({
      text: "сад, сад и сад",
      count: 3,
      first: 0,
    });
  });

  it("replaces past the cap the find bar stops at", () => {
    const text = "а".repeat(MAX_MATCHES + 10);
    const result = replaceAll(text, "а", "б");

    expect(result.count).toBe(MAX_MATCHES + 10);
    expect(result.text).toBe("б".repeat(MAX_MATCHES + 10));
  });

  it("does not chase a replacement that holds the query", () => {
    expect(replaceAll("a b a", "a", "aa").text).toBe("aa b aa");
  });

  it("leaves the text alone when there is nothing to replace", () => {
    const text = "текст";
    expect(replaceAll(text, "нет", "да")).toEqual({ text, count: 0, first: 0 });
    expect(replaceAll(text, "", "да").count).toBe(0);
  });

  it("says where the first replacement went", () => {
    expect(replaceAll("ab ab", "b", "c").first).toBe(1);
  });
});
