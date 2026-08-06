// Подсветка: что она красит и чего не теряет.

import { describe, expect, it } from "vitest";
import { grammarOf, tokenize, type Token } from "./highlight";

function kinds(tokens: Token[]): [string, string][] {
  return tokens
    .filter((token) => token.kind !== "plain")
    .map((token) => [token.kind, token.text]);
}

function joined(tokens: Token[]): string {
  return tokens.map((token) => token.text).join("");
}

describe("tokenize", () => {
  /// Свойство, на котором держится всё остальное: поле ввода лежит поверх
  /// подсветки, и потерянный или добавленный символ сдвинет одно относительно
  /// другого — курсор окажется не там, где буква.
  it("never loses or invents a character", () => {
    const samples = [
      'const x = "строка"; // хвост',
      "/* незакрытый комментарий",
      '"незакрытая строка\nследующая строка',
      "fn main() { let x = 1_000.5e3; }",
      "",
      "просто текст без всякого языка",
      '{"ключ": [1, 2, null]}',
      "печальный \\\\ обратный слэш",
    ];
    for (const language of ["ts", "rs", "json", "sh", null]) {
      for (const sample of samples) {
        expect(joined(tokenize(sample, language)), `${language}: ${sample}`).toBe(
          sample,
        );
      }
    }
  });

  it("marks a comment to the end of its line and no further", () => {
    const tokens = tokenize("код(); // пояснение\nещё();", "ts");

    expect(kinds(tokens)).toContainEqual(["comment", "// пояснение"]);
    // Перевод строки в комментарий не входит: иначе следующая строка тоже
    // покрасилась бы серым.
    expect(joined(tokens)).toContain("\nещё");
  });

  it("keeps an escaped quote inside the string", () => {
    const tokens = tokenize('let s = "он сказал \\"да\\"";', "ts");

    expect(kinds(tokens)).toContainEqual(["string", '"он сказал \\"да\\""']);
  });

  it("does not let an unclosed quote swallow the file", () => {
    const tokens = tokenize('const a = "забыл закрыть\nconst b = 2;', "ts");

    // Иначе одна опечатка красит весь остаток файла строкой, и читать его
    // невозможно.
    expect(kinds(tokens)).toContainEqual(["keyword", "const"]);
    expect(kinds(tokens).filter(([kind]) => kind === "keyword")).toHaveLength(2);
  });

  it("lets a backtick string span lines, because it may", () => {
    const tokens = tokenize("const a = `первая\nвторая`;", "ts");

    expect(kinds(tokens)).toContainEqual(["string", "`первая\nвторая`"]);
  });

  it("tells a keyword from a word that merely contains one", () => {
    const tokens = tokenize("constanta = iffy;", "ts");

    // `constanta` — не `const`: подсветка по вхождению красила бы половину
    // имён в проекте.
    expect(kinds(tokens).filter(([kind]) => kind === "keyword")).toHaveLength(0);
  });

  it("keeps numbers out of settings files", () => {
    // В `.toml` и `.yaml` число — обычное значение, и рябить ими незачем.
    expect(kinds(tokenize("port = 8080", "toml"))).not.toContainEqual([
      "number",
      "8080",
    ]);
    expect(kinds(tokenize("const port = 8080", "ts"))).toContainEqual([
      "number",
      "8080",
    ]);
  });

  it("marks the words json actually has", () => {
    const tokens = tokenize('{"ok": true, "нет": null}', "json");

    expect(kinds(tokens)).toContainEqual(["keyword", "true"]);
    expect(kinds(tokens)).toContainEqual(["keyword", "null"]);
    expect(kinds(tokens)).toContainEqual(["string", '"ok"']);
  });

  it("leaves an unknown language completely alone", () => {
    const tokens = tokenize("# заголовок\nтекст", null);

    // Выдуманная разметка мешает сильнее, чем её отсутствие.
    expect(tokens).toEqual([{ text: "# заголовок\nтекст", kind: "plain" }]);
  });
});

describe("grammarOf", () => {
  it("reads the family, not the last letters", () => {
    expect(grammarOf("App.tsx")).toBe("ts");
    expect(grammarOf("main.rs")).toBe("rs");
    expect(grammarOf("style.scss")).toBe("css");
    expect(grammarOf("deploy.YAML")).toBe("yaml");
  });

  it("admits when it does not know the language", () => {
    expect(grammarOf("LICENSE")).toBeNull();
    expect(grammarOf("icon.png")).toBeNull();
    expect(grammarOf(".gitignore")).toBeNull();
  });
});
