import { describe, expect, it } from "vitest";
import { lineEndingOf, toLf, withEnding } from "./lineEndings";

describe("line endings of an open file", () => {
  it("tells a Windows file from a Unix one", () => {
    expect(lineEndingOf("a\r\nb\r\n")).toBe("\r\n");
    expect(lineEndingOf("a\nb\n")).toBe("\n");
    // Без единого перевода строки — как принято в проекте по умолчанию.
    expect(lineEndingOf("одна строка")).toBe("\n");
  });

  it("goes with the majority in a mixed file", () => {
    expect(lineEndingOf("a\r\nb\r\nc\nd")).toBe("\r\n");
    expect(lineEndingOf("a\r\nb\nc\nd")).toBe("\n");
  });

  it("hands the field the text the way the field keeps it", () => {
    expect(toLf("a\r\nb\rc\n")).toBe("a\nb\nc\n");
    const plain = "a\nb";
    expect(toLf(plain)).toBe(plain);
  });

  it("writes the file back with its own breaks", () => {
    expect(withEnding("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(withEnding("a\nb\n", "\n")).toBe("a\nb\n");
  });
});
