// Значок файла в дереве.

import { describe, expect, it } from "vitest";
import { fileGlyph } from "./fileGlyph";

describe("fileGlyph", () => {
  it("marks the languages a project is actually written in", () => {
    expect(fileGlyph("App.tsx").label).toBe("TS");
    expect(fileGlyph("lib.rs").label).toBe("RS");
    expect(fileGlyph("package.json").label).toBe("{ }");
    expect(fileGlyph("README.md").label).toBe("M↓");
  });

  it("reads a family, not the last letters of the extension", () => {
    // `.tsx` — семейство TypeScript целиком, а не расширение `x`: разбор по
    // хвосту дал бы разным файлам одного языка разные значки.
    expect(fileGlyph("App.tsx").kind).toBe("ts");
    expect(fileGlyph("main.ts").kind).toBe("ts");
    expect(fileGlyph("vite.config.mts").kind).toBe("ts");
  });

  it("ignores the case a file was named in", () => {
    expect(fileGlyph("NOTES.MD").label).toBe("M↓");
    expect(fileGlyph("Cargo.TOML").label).toBe("TOML");
  });

  it("leaves a dotfile plain", () => {
    // У `.gitignore` точка начинает имя, а не отделяет расширение: пометить
    // его как файл вида `gitignore` значило бы выдумать язык.
    expect(fileGlyph(".gitignore").label).toBe("");
    expect(fileGlyph(".DS_Store").label).toBe("");
  });

  it("leaves an unknown extension plain rather than guessing", () => {
    expect(fileGlyph("LICENSE").label).toBe("");
    expect(fileGlyph("icon.png").label).toBe("");
    expect(fileGlyph("archive.tar.gz").label).toBe("");
    // Точка в конце — не расширение.
    expect(fileGlyph("странно.").label).toBe("");
  });
});
