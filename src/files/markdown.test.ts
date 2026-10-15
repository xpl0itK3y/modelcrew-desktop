// Разбор разметки: что из неё получается и чего в ней не бывает.

import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type Block, type Inline } from "./markdown";

/// Плоский текст блока — то, что читатель увидит буквами.
function textOf(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "text":
        case "code":
          return node.text;
        case "image":
          return node.alt;
        default:
          return textOf(node.children);
      }
    })
    .join("");
}

function kinds(blocks: Block[]): string[] {
  return blocks.map((block) => block.kind);
}

describe("parseMarkdown", () => {
  it("reads a document the way it is written", () => {
    const blocks = parseMarkdown(
      [
        "# Заголовок",
        "",
        "Абзац из двух",
        "строк подряд.",
        "",
        "## Второй уровень",
        "",
        "---",
      ].join("\n"),
    );

    expect(kinds(blocks)).toEqual(["heading", "paragraph", "heading", "rule"]);
    const heading = blocks[0];
    expect(heading.kind === "heading" && heading.level).toBe(1);
    const text = blocks[1];
    // Две строки подряд — один абзац: перевод строки в разметке абзац не рвёт.
    expect(text.kind === "paragraph" && textOf(text.children)).toBe(
      "Абзац из двух\nстрок подряд.",
    );
  });

  it("keeps a fenced block exactly as it was written", () => {
    // Внутри ограды разметки нет: там чужой язык, и трогать в нём нельзя ни
    // отступ, ни звёздочку, ни решётку.
    const blocks = parseMarkdown(
      ["```ts", "const a = 1; // # не заголовок", "  отступ", "```"].join("\n"),
    );

    expect(blocks).toEqual([
      {
        kind: "code",
        language: "ts",
        text: "const a = 1; // # не заголовок\n  отступ",
      },
    ]);
  });

  it("closes an unclosed fence at the end of the file", () => {
    const blocks = parseMarkdown("```\nкод без конца");

    expect(blocks).toEqual([
      { kind: "code", language: null, text: "код без конца" },
    ]);
  });

  it("gathers a list and everything that belongs to its items", () => {
    const blocks = parseMarkdown(
      [
        "- первый",
        "- второй",
        "  - вложенный",
        "  - ещё вложенный",
        "- третий",
      ].join("\n"),
    );

    expect(kinds(blocks)).toEqual(["list"]);
    const list = blocks[0];
    if (list.kind !== "list") {
      throw new Error("не список");
    }
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(3);
    // Вложенное разбирается тем же разбором: список внутри пункта — это просто
    // ещё один блок в нём.
    expect(kinds(list.items[1])).toEqual(["paragraph", "list"]);
  });

  it("does not run a numbered list into a bulleted one", () => {
    const blocks = parseMarkdown(["1. раз", "2. два", "- и другое"].join("\n"));

    expect(kinds(blocks)).toEqual(["list", "list"]);
    const first = blocks[0];
    expect(first.kind === "list" && first.ordered).toBe(true);
    // Нумерация начинается там, где её начал автор, а не с единицы.
    const numbered = parseMarkdown("5. пятый\n6. шестой")[0];
    expect(numbered.kind === "list" && numbered.start).toBe(5);
  });

  it("tells a horizontal rule from a list of one dash", () => {
    expect(kinds(parseMarkdown("---"))).toEqual(["rule"]);
    expect(kinds(parseMarkdown("- пункт"))).toEqual(["list"]);
  });

  it("reads a quote, and the lines that continue it", () => {
    const blocks = parseMarkdown("> первая\n> вторая\n\nобычный");

    expect(kinds(blocks)).toEqual(["quote", "paragraph"]);
    const quote = blocks[0];
    expect(quote.kind === "quote" && kinds(quote.blocks)).toEqual(["paragraph"]);
  });

  it("reads a table with or without the outer pipes", () => {
    const blocks = parseMarkdown(
      ["| имя | что |", "| --- | --- |", "| a | раз |", "b | два"].join("\n"),
    );

    expect(kinds(blocks)).toEqual(["table"]);
    const table = blocks[0];
    if (table.kind !== "table") {
      throw new Error("не таблица");
    }
    expect(table.head.map(textOf)).toEqual(["имя", "что"]);
    expect(table.rows.map((row) => row.map(textOf))).toEqual([
      ["a", "раз"],
      ["b", "два"],
    ]);
  });

  it("leaves a lone pipe alone", () => {
    // Без строки-разделителя это не таблица, а обычный текст с палкой.
    expect(kinds(parseMarkdown("a | b\nc | d"))).toEqual(["paragraph"]);
  });
});

describe("parseInline", () => {
  it("reads what is written inside a line", () => {
    const parts = parseInline(
      "текст **жирный** *наклон* `код` ~~вычерк~~ [сюда](https://ya.ru)",
    );

    expect(parts.map((part) => part.kind)).toEqual([
      "text",
      "strong",
      "text",
      "em",
      "text",
      "code",
      "text",
      "strike",
      "text",
      "link",
    ]);
    const link = parts[parts.length - 1];
    expect(link.kind === "link" && link.href).toBe("https://ya.ru");
  });

  it("does not let a lone asterisk swallow the rest of the line", () => {
    const parts = parseInline("5 * 3 = 15 и всё");

    expect(parts).toEqual([{ kind: "text", text: "5 * 3 = 15 и всё" }]);
  });

  it("takes an escaped mark for the mark itself", () => {
    expect(parseInline("\\*не выделение\\*")).toEqual([
      { kind: "text", text: "*не выделение*" },
    ]);
  });

  it("keeps markup written inside a code span out of the parser", () => {
    const parts = parseInline("вот `**не жирное**` и всё");

    expect(parts[1]).toEqual({ kind: "code", text: "**не жирное**" });
  });

  it("tells an image from a link", () => {
    expect(parseInline("![кот](cat.png)")).toEqual([
      { kind: "image", src: "cat.png", alt: "кот" },
    ]);
  });

  it("reads a bare address in angle brackets", () => {
    const parts = parseInline("пишите <mailto:a@b.c>");

    expect(parts[1]).toEqual({
      kind: "link",
      href: "mailto:a@b.c",
      children: [{ kind: "text", text: "mailto:a@b.c" }],
    });
  });

  it("never loses a character of plain prose", () => {
    // Разбор — это показ, а не правка: текст, в котором разметки нет, обязан
    // дойти до читателя ровно таким, каким его написали.
    const samples = [
      "просто текст",
      "звёздочка * одна",
      "подчёрк _ один",
      "скобка ] и [ вразнобой",
      "обратный слэш \\ в конце",
      "",
    ];
    for (const sample of samples) {
      expect(textOf(parseInline(sample)), sample).toBe(sample);
    }
  });
});
