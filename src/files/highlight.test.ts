// Подсветка: что она красит и чего не теряет.

import { describe, expect, it } from "vitest";
import {
  grammarForTag,
  grammarOf,
  languages,
  lineOffsets,
  paintLines,
  tokenize,
  type Token,
} from "./highlight";

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

describe("paintLines", () => {
  const file = [
    "const a = 1;",
    "/* большой",
    "   комментарий",
    "   на много строк */",
    'const b = "строка";',
    "const c = 3;",
  ].join("\n");
  const offsets = () => lineOffsets(file);

  it("gives back exactly the lines it was asked for", () => {
    // На этом всё и держится: слой подсветки лежит под полем ввода, и лишний
    // или потерянный символ сдвинет буквы относительно курсора.
    for (const [from, to] of [[0, 6], [1, 3], [4, 6], [5, 6], [2, 2], [0, 99]]) {
      const lines = file.split("\n").slice(from, to).join("\n");
      expect(joined(paintLines(file, "ts", offsets(), from, to)), `${from}..${to}`)
        .toBe(lines);
    }
  });

  it("knows a comment that started above the window", () => {
    const tokens = paintLines(file, "ts", offsets(), 2, 4);

    // Без оглядки назад середина комментария читалась бы как код: разбор — это
    // машина состояний, и начинать её с середины файла нельзя.
    expect(tokens.every((token) => token.kind === "comment")).toBe(true);
  });

  it("holds the line numbering of an empty file", () => {
    expect(lineOffsets("")).toEqual([0]);
    expect(lineOffsets("одна\nдве")).toEqual([0, 5]);
    expect(lineOffsets("хвост\n")).toEqual([0, 6]);
    expect(paintLines("", "ts", lineOffsets(""), 0, 1)).toEqual([]);
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

describe("the languages beyond the ones this app is written in", () => {
  /// То же свойство, что и выше, но на всех грамматиках разом. Свежий язык
  /// добавляют одной строкой в таблицу, и проверять его отдельно никто не
  /// вспомнит — а разъедется от него весь редактор целиком.
  it("never loses or invents a character, in any language it knows", () => {
    const samples = [
      'x = "строка" # хвост',
      "/* незакрытый /* вложенный",
      "'''\nтройная\n'''",
      '"""\nтройная\n"""',
      "-- [[ полуоткрытый",
      "{- } -} <# #> (* *) =begin =end",
      "1_000.5e3 0xff 42",
      "",
      "просто текст без всякого языка",
    ];
    for (const language of languages) {
      for (const sample of samples) {
        expect(
          joined(tokenize(sample, language)),
          `${language}: ${JSON.stringify(sample)}`,
        ).toBe(sample);
      }
    }
  });

  it("lets a docstring span the lines it is written across", () => {
    const tokens = tokenize('def f():\n    """что делает\n    функция"""\n', "py");

    expect(kinds(tokens)).toContainEqual([
      "string",
      '"""что делает\n    функция"""',
    ]);
    expect(kinds(tokens)).toContainEqual(["keyword", "def"]);
  });

  it("knows a SQL keyword however it was shouted", () => {
    // Один и тот же запрос пишут и строчными, и прописными — и в одном файле
    // вперемешку. Регистр здесь ничего не значит.
    for (const word of ["select", "SELECT", "Select"]) {
      expect(kinds(tokenize(`${word} 1`, "sql"))).toContainEqual([
        "keyword",
        word,
      ]);
    }
    // А там, где регистр значение имеет, слово остаётся словом.
    expect(kinds(tokenize("CONST x = 1", "ts"))).not.toContainEqual([
      "keyword",
      "CONST",
    ]);
  });

  it("opens a block comment that starts like a line comment", () => {
    // `--[[` в Lua и `#=` в Julia начинаются тем же, чем однострочный
    // комментарий: примерь его первым — и закрывающая скобка осталась бы
    // кодом, а с ней и весь остаток блока.
    const lua = tokenize("--[[ пояснение\nна две строки ]]\nlocal x = 1", "lua");
    expect(kinds(lua)).toContainEqual([
      "comment",
      "--[[ пояснение\nна две строки ]]",
    ]);
    expect(kinds(lua)).toContainEqual(["keyword", "local"]);

    const julia = tokenize("#= пояснение\nна две строки =#\nconst x = 1", "julia");
    expect(kinds(julia)).toContainEqual(["keyword", "const"]);
  });

  it("does not take a lisp quote for the start of a string", () => {
    const tokens = tokenize("(def xs '(1 2 3))\n(def ys 4)", "lisp");

    // Приняв апостроф за кавычку, разбор покрасил бы строкой весь остаток
    // файла — а апостроф в этом семействе стоит чуть ли не в каждой строке.
    expect(kinds(tokens).filter(([kind]) => kind === "string")).toHaveLength(0);
    expect(kinds(tokens).filter(([kind]) => kind === "keyword")).toHaveLength(2);
  });

  it("reads the language of a file that has no extension at all", () => {
    expect(grammarOf("Dockerfile")).toBe("docker");
    expect(grammarOf("build/Makefile")).toBeNull();
    expect(grammarOf("Makefile")).toBe("make");
    expect(grammarOf("Gemfile")).toBe("ruby");
    expect(grammarOf(".zshrc")).toBe("sh");
  });

  it("covers the languages people actually write in", () => {
    const expected: Record<string, string> = {
      "main.py": "py", "server.go": "go", "App.java": "java",
      "Main.kt": "kotlin", "build.sbt": "scala", "core.c": "c",
      "engine.cpp": "cpp", "View.mm": "objc", "Program.cs": "cs",
      "index.php": "php", "app.rb": "ruby", "App.swift": "swift",
      "main.dart": "dart", "schema.sql": "sql", "init.lua": "lua",
      "tool.pl": "perl", "plot.R": "r", "model.jl": "julia",
      "Main.hs": "haskell", "app.ex": "elixir", "node.erl": "erlang",
      "core.clj": "lisp", "main.zig": "zig", "parser.ml": "ocaml",
      "deploy.ps1": "powershell", "main.tf": "hcl", "schema.graphql": "graphql",
      "api.proto": "proto", "Token.sol": "solidity", "flake.nix": "nix",
      "setup.cfg": "ini", "Component.vue": "html",
    };
    for (const [name, language] of Object.entries(expected)) {
      expect(grammarOf(name), name).toBe(language);
    }
  });
});

describe("markdown", () => {
  it("reads the file by the start of its lines", () => {
    const doc = [
      "# Заголовок",
      "",
      "Обычный абзац.",
      "",
      "- пункт списка",
      "1. и нумерованный",
      "",
      "> цитата",
      "",
      "---",
    ].join("\n");
    const marked = kinds(tokenize(doc, "md"));

    expect(marked).toContainEqual(["heading", "# Заголовок"]);
    expect(marked).toContainEqual(["comment", "> цитата"]);
    expect(marked).toContainEqual(["punct", "-"]);
    expect(marked).toContainEqual(["punct", "1."]);
    expect(marked).toContainEqual(["punct", "---"]);
    // Абзац остаётся текстом: красить в разметке нечего.
    expect(marked.some(([, text]) => text.includes("Обычный абзац"))).toBe(false);
  });

  it("keeps everything inside a fence out of the parser's hands", () => {
    // В примере кода решётка — комментарий, а звёздочка — умножение. Разбирать
    // их как разметку значит красить чужой язык своими правилами.
    const doc = [
      "```py",
      "# это комментарий, а не заголовок",
      "x = a * b",
      "```",
      "# а вот это заголовок",
    ].join("\n");
    const marked = kinds(tokenize(doc, "md"));

    expect(marked).toContainEqual(["code", "```py"]);
    expect(marked).toContainEqual([
      "code",
      "# это комментарий, а не заголовок",
    ]);
    expect(marked).toContainEqual(["heading", "# а вот это заголовок"]);
  });

  it("leaves an unclosed fence closed to the end of the file", () => {
    // Ровно так его и прочитает любой просмотрщик разметки: ограда без пары
    // тянется до конца, и видеть это полезнее, чем догадываться.
    const marked = kinds(tokenize("```\nкод\n# не заголовок", "md"));

    expect(marked.every(([kind]) => kind === "code")).toBe(true);
  });

  it("marks what is written inside a line", () => {
    const marked = kinds(
      tokenize(
        "текст с `кодом`, **жирным**, _наклонным_ и [ссылкой](https://ya.ru)",
        "md",
      ),
    );

    expect(marked).toContainEqual(["code", "`кодом`"]);
    expect(marked).toContainEqual(["emphasis", "**жирным**"]);
    expect(marked).toContainEqual(["emphasis", "_наклонным_"]);
    expect(marked).toContainEqual(["link", "[ссылкой](https://ya.ru)"]);
  });

  it("does not take a lone asterisk for the start of a word in bold", () => {
    // Звёздочка без пары — обычный знак, и покрасить с неё половину строки
    // значит соврать про весь остаток абзаца.
    const marked = kinds(tokenize("5 * 3 = 15, и это не разметка", "md"));

    expect(marked.filter(([kind]) => kind === "emphasis")).toHaveLength(0);
  });

  it("knows a markdown file by its name", () => {
    expect(grammarOf("README.md")).toBe("md");
    expect(grammarOf("SPEC.markdown")).toBe("md");
    expect(grammarOf("page.mdx")).toBe("md");
  });

  it("reads the tag written at the fence, however it was spelled", () => {
    // У ограды пишут словом, а таблица расширений знает сокращения.
    expect(grammarForTag("typescript")).toBe("ts");
    expect(grammarForTag("Python")).toBe("py");
    expect(grammarForTag("bash")).toBe("sh");
    expect(grammarForTag("rs")).toBe("rs");
    expect(grammarForTag("")).toBeNull();
    expect(grammarForTag("нетакого")).toBeNull();
  });
});
