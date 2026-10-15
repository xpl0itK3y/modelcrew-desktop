// Правка клавишами: что становится с текстом и где остаётся курсор.

import { describe, expect, it } from "vitest";
import {
  breakLine,
  deleteLines,
  duplicateLines,
  indent,
  indentUnitOf,
  moveLines,
  outdent,
  toggleComment,
  type Edit,
} from "./editing";
import { commentMarks } from "./highlight";

/// Фикстура с курсором: `|` отмечает выделение, один знак или два.
function marked(source: string): [string, number, number] {
  const from = source.indexOf("|");
  const rest = source.replace("|", "");
  const second = rest.indexOf("|");
  return [rest.replace("|", ""), from, second === -1 ? from : second];
}

/// Обратно: текст с выделением, отмеченным теми же знаками.
function show(edit: Edit): string {
  const { text, from, to } = edit;
  return from === to
    ? text.slice(0, from) + "|" + text.slice(from)
    : text.slice(0, from) + "|" + text.slice(from, to) + "|" + text.slice(to);
}

describe("indentUnitOf", () => {
  it("takes the indent the file is already written with", () => {
    expect(indentUnitOf("fn main() {\n    let a = 1;\n}")).toBe("    ");
    expect(indentUnitOf("const a = {\n  b: 1,\n};")).toBe("  ");
    expect(indentUnitOf("if a:\n\tprint(1)")).toBe("\t");
  });

  it("falls back to two spaces where the file says nothing", () => {
    expect(indentUnitOf("одна строка")).toBe("  ");
    expect(indentUnitOf("")).toBe("  ");
  });
});

describe("indent", () => {
  it("puts an indent under the cursor instead of losing the field", () => {
    const [text, from, to] = marked("const a =|1;");

    expect(show(indent(text, from, to, "  "))).toBe("const a =  |1;");
  });

  it("shifts every line the selection touches", () => {
    const [text, from, to] = marked("a\n|b\nc|\nd");

    expect(show(indent(text, from, to, "  "))).toBe("a\n  |b\n  c|\nd");
  });

  it("takes the indent back again", () => {
    const [text, from, to] = marked("a\n|  b\n  c|\nd");

    expect(show(outdent(text, from, to, "  "))).toBe("a\n|b\nc|\nd");
  });

  it("takes back no more than there is", () => {
    const [text, from, to] = marked("| b|");

    expect(show(outdent(text, from, to, "    "))).toBe("|b|");
  });
});

describe("breakLine", () => {
  it("starts the new line under the one it came from", () => {
    const [text, from, to] = marked("    let a = 1;|");

    expect(show(breakLine(text, from, to, "  "))).toBe("    let a = 1;\n    |");
  });

  it("steps in after an opening bracket", () => {
    const [text, from, to] = marked("  fn main() {|");

    expect(show(breakLine(text, from, to, "  "))).toBe("  fn main() {\n    |");
  });

  it("puts the closing bracket on its own line", () => {
    const [text, from, to] = marked("fn main() {|}");

    expect(show(breakLine(text, from, to, "  "))).toBe("fn main() {\n  |\n}");
  });
});

describe("toggleComment", () => {
  const ts = commentMarks("ts");

  it("comments every line the selection touches", () => {
    const [text, from, to] = marked("|const a = 1;\nconst b = 2;|");

    expect(toggleComment(text, from, to, ts)?.text).toBe(
      "// const a = 1;\n// const b = 2;",
    );
  });

  it("uncomments what it commented", () => {
    const [text, from, to] = marked("|// const a = 1;\n// const b = 2;|");

    expect(toggleComment(text, from, to, ts)?.text).toBe(
      "const a = 1;\nconst b = 2;",
    );
  });

  it("keeps the indent where it was", () => {
    const [text, from, to] = marked("  |const a = 1;|");

    expect(toggleComment(text, from, to, ts)?.text).toBe("  // const a = 1;");
  });

  it("comments the rest when one line among them already is", () => {
    // Иначе одна закомментированная строка посреди выделения раскомментировала
    // бы весь кусок, а просили обратного.
    const [text, from, to] = marked("|// a\nb|");

    expect(toggleComment(text, from, to, ts)?.text).toBe("// // a\n// b");
  });

  it("wraps a language that has no line comment", () => {
    const [text, from, to] = marked("|<div />|");
    const html = commentMarks("html");

    const commented = toggleComment(text, from, to, html);
    expect(commented?.text).toBe("<!-- <div /> -->");
    const back = toggleComment(commented!.text, commented!.from, commented!.to, html);
    expect(back?.text).toBe("<div />");
  });

  it("says no when the format has no comments at all", () => {
    expect(toggleComment("a\nb", 0, 1, commentMarks("diff"))).toBeNull();
  });
});

describe("lines", () => {
  it("doubles the line and moves on to the copy", () => {
    const [text, from, to] = marked("a\nb|\nc");

    expect(show(duplicateLines(text, from, to))).toBe("a\nb\nb|\nc");
  });

  it("moves a line up and down again", () => {
    const [text, from, to] = marked("a\nb|\nc");
    const up = moveLines(text, from, to, -1);

    expect(show(up)).toBe("b|\na\nc");
    expect(show(moveLines(up.text, up.from, up.to, 1))).toBe("a\nb|\nc");
  });

  it("has nowhere to move the first line up", () => {
    const [text, from, to] = marked("a|\nb");

    expect(moveLines(text, from, to, -1).text).toBe("a\nb");
  });

  it("carries a whole selection at once", () => {
    const [text, from, to] = marked("a\n|b\nc|\nd");

    expect(show(moveLines(text, from, to, 1))).toBe("a\nd\n|b\nc|");
  });

  it("deletes the line together with its break", () => {
    const [text, from, to] = marked("a\nb|\nc");

    expect(show(deleteLines(text, from, to))).toBe("a\n|c");
  });

  it("deletes the last line without leaving an empty one", () => {
    const [text, from, to] = marked("a\nb|");

    expect(show(deleteLines(text, from, to))).toBe("a|");
  });
});
