// Подсветка текста файла.
//
// Свой разбор, а не редактор со стороны: полноценный CodeMirror тянет за собой
// пару сотен килобайт и свою модель документа, а нужен здесь один разряд
// токена на кусок текста. Разбор нарочно поверхностный — комментарии, строки,
// числа, ключевые слова. Он не понимает язык и не должен: подсветка помогает
// глазу, а не проверяет код.
//
// Главное свойство: разбор ничего не теряет и не добавляет. Куски, сложенные
// подряд, дают исходный текст байт в байт — иначе подсветка разъедется с
// полем ввода, которое лежит поверх неё.

export type TokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "punct";

export type Token = { text: string; kind: TokenKind };

type Grammar = {
  /// Начала однострочных комментариев.
  line: string[];
  /// Пара для многострочного комментария.
  block: [string, string] | null;
  /// Кавычки, которыми огораживают строки.
  quotes: string[];
  keywords: Set<string>;
  /// Числа подсвечивать: в разметке и настройках они значат не то же, что в
  /// коде, и рябить ими незачем.
  numbers: boolean;
};

const CLIKE_PUNCT = "{}()[];,.:<>=+-*/%!&|?~^";

function grammar(
  line: string[],
  block: [string, string] | null,
  quotes: string[],
  keywords: string[],
  numbers = true,
): Grammar {
  return { line, block, quotes, keywords: new Set(keywords), numbers };
}

const TS_WORDS = [
  "import", "export", "from", "as", "default", "const", "let", "var",
  "function", "return", "if", "else", "for", "while", "do", "switch", "case",
  "break", "continue", "class", "extends", "implements", "interface", "type",
  "enum", "new", "this", "super", "async", "await", "try", "catch", "finally",
  "throw", "typeof", "instanceof", "in", "of", "delete", "void", "yield",
  "true", "false", "null", "undefined", "public", "private", "protected",
  "readonly", "static", "abstract", "declare", "namespace", "satisfies",
];

const RUST_WORDS = [
  "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait",
  "for", "while", "loop", "if", "else", "match", "return", "break", "continue",
  "use", "mod", "pub", "crate", "self", "super", "as", "where", "type", "dyn",
  "ref", "move", "async", "await", "unsafe", "extern", "true", "false", "Some",
  "None", "Ok", "Err",
];

const SHELL_WORDS = [
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case",
  "esac", "function", "return", "exit", "export", "local", "readonly", "set",
  "unset", "echo", "printf", "cd", "in",
];

const GRAMMARS: Record<string, Grammar> = {
  ts: grammar(["//"], ["/*", "*/"], ['"', "'", "`"], TS_WORDS),
  rs: grammar(["//"], ["/*", "*/"], ['"'], RUST_WORDS),
  json: grammar([], null, ['"'], ["true", "false", "null"]),
  css: grammar([], ["/*", "*/"], ['"', "'"], [], false),
  html: grammar([], ["<!--", "-->"], ['"', "'"], [], false),
  yaml: grammar(["#"], null, ['"', "'"], ["true", "false", "null"], false),
  toml: grammar(["#"], null, ['"', "'"], ["true", "false"], false),
  sh: grammar(["#"], null, ['"', "'"], SHELL_WORDS, false),
};

/// Какой разбор применить к файлу. Незнакомое расширение — без подсветки:
/// выдуманная разметка мешает сильнее, чем её отсутствие.
export function grammarOf(name: string): string | null {
  const at = name.lastIndexOf(".");
  const extension = at <= 0 ? "" : name.slice(at + 1).toLowerCase();
  const family: Record<string, string> = {
    ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
    js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
    rs: "rs",
    json: "json", jsonc: "json", json5: "json",
    css: "css", scss: "css", less: "css",
    html: "html", htm: "html", xml: "html", svg: "html",
    yml: "yaml", yaml: "yaml",
    toml: "toml",
    sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
  };
  return family[extension] ?? null;
}

export function tokenize(text: string, language: string | null): Token[] {
  const rules = language ? GRAMMARS[language] : undefined;
  if (!rules || text.length === 0) {
    return text ? [{ text, kind: "plain" }] : [];
  }

  const tokens: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      tokens.push({ text: plain, kind: "plain" });
      plain = "";
    }
  };
  const push = (value: string, kind: TokenKind) => {
    flush();
    tokens.push({ text: value, kind });
  };

  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);

    const lineStart = rules.line.find((mark) => rest.startsWith(mark));
    if (lineStart) {
      const end = rest.indexOf("\n");
      const value = end === -1 ? rest : rest.slice(0, end);
      push(value, "comment");
      at += value.length;
      continue;
    }

    if (rules.block && rest.startsWith(rules.block[0])) {
      const [open, close] = rules.block;
      const end = rest.indexOf(close, open.length);
      // Незакрытый комментарий тянется до конца файла — ровно так его и
      // прочитает компилятор, и видеть это полезно.
      const value = end === -1 ? rest : rest.slice(0, end + close.length);
      push(value, "comment");
      at += value.length;
      continue;
    }

    const quote = rules.quotes.find((mark) => rest.startsWith(mark));
    if (quote) {
      let index = quote.length;
      while (index < rest.length) {
        if (rest[index] === "\\") {
          // Экранированная кавычка строку не закрывает.
          index += 2;
          continue;
        }
        if (rest.startsWith(quote, index)) {
          index += quote.length;
          break;
        }
        // Обычная строка не переживает перевод строки: незакрытая кавычка
        // иначе покрасила бы весь остаток файла.
        if (rest[index] === "\n" && quote !== "`") {
          break;
        }
        index += 1;
      }
      const value = rest.slice(0, index);
      push(value, "string");
      at += value.length;
      continue;
    }

    const first = rest[0];
    if (rules.numbers && /[0-9]/.test(first)) {
      const match = /^[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?/.exec(rest);
      if (match) {
        push(match[0], "number");
        at += match[0].length;
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(first)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
      if (match) {
        const word = match[0];
        if (rules.keywords.has(word)) {
          push(word, "keyword");
        } else {
          plain += word;
        }
        at += word.length;
        continue;
      }
    }

    if (CLIKE_PUNCT.includes(first)) {
      push(first, "punct");
      at += 1;
      continue;
    }

    plain += first;
    at += 1;
  }
  flush();
  return tokens;
}
