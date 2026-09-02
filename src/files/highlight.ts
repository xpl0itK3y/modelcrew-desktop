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
  | "punct"
  // Разряды разметки: у неё свои части, и звать заголовок ключевым словом, а
  // ссылку строкой значило бы красить их чужими цветами.
  | "heading"
  | "code"
  | "emphasis"
  | "link";

export type Token = { text: string; kind: TokenKind };

type Grammar = {
  /// Начала однострочных комментариев.
  line: string[];
  /// Пара для многострочного комментария.
  block: [string, string] | null;
  /// Кавычки, которыми огораживают строки. Порядок важен: примеряются по
  /// очереди, и тройная кавычка обязана стоять раньше одинарной, иначе от неё
  /// каждый раз отрезался бы первый символ.
  quotes: string[];
  keywords: Set<string>;
  /// Числа подсвечивать: в разметке и настройках они значат не то же, что в
  /// коде, и рябить ими незачем.
  numbers: boolean;
  /// Ключевые слова без оглядки на регистр. В SQL одно и то же слово пишут и
  /// `select`, и `SELECT`, и обе записи одинаково ключевые.
  fold: boolean;
};

const CLIKE_PUNCT = "{}()[];,.:<>=+-*/%!&|?~^";

function grammar(
  line: string[],
  block: [string, string] | null,
  quotes: string[],
  keywords: string[],
  options: { numbers?: boolean; fold?: boolean } = {},
): Grammar {
  const fold = options.fold ?? false;
  return {
    line,
    block,
    quotes,
    keywords: new Set(
      fold ? keywords.map((word) => word.toLowerCase()) : keywords,
    ),
    numbers: options.numbers ?? true,
    fold,
  };
}

/// Переживает ли строка, начатая такой кавычкой, перевод строки.
///
/// Признак не в таблице, а в самой кавычке, и это не экономия: тройная кавычка
/// многострочна в каждом языке, где она вообще есть, — Python, Kotlin, Scala,
/// Swift, Dart, Julia, Elixir, — а обратный апостроф многострочен и в
/// JavaScript, и в Go. Отдельное поле повторяло бы это правило по строчке на
/// язык и разошлось бы с ним на первом же новом.
function spansLines(quote: string): boolean {
  return quote.length > 1 || quote === "`";
}

// Ключевые слова. Списки нарочно неполные и без претензии на грамматику:
// подсветка помогает глазу зацепиться за костяк файла, а не разбирает язык.
// Слово, которого здесь нет, останется обычным текстом — это не ошибка.

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

const PY_WORDS = [
  "def", "class", "return", "if", "elif", "else", "for", "while", "break",
  "continue", "import", "from", "as", "pass", "raise", "try", "except",
  "finally", "with", "lambda", "yield", "global", "nonlocal", "assert", "del",
  "in", "is", "not", "and", "or", "None", "True", "False", "async", "await",
  "match", "case", "self", "cls",
];

const GO_WORDS = [
  "package", "import", "func", "return", "if", "else", "for", "range",
  "switch", "case", "default", "break", "continue", "fallthrough", "go",
  "defer", "select", "chan", "map", "struct", "interface", "type", "const",
  "var", "nil", "true", "false", "make", "new", "len", "cap", "append",
  "panic", "recover", "goto",
];

const JAVA_WORDS = [
  "package", "import", "public", "private", "protected", "class", "interface",
  "enum", "record", "extends", "implements", "new", "return", "if", "else",
  "for", "while", "do", "switch", "case", "default", "break", "continue",
  "try", "catch", "finally", "throw", "throws", "this", "super", "static",
  "final", "abstract", "synchronized", "volatile", "transient", "native",
  "void", "int", "long", "short", "byte", "char", "float", "double",
  "boolean", "true", "false", "null", "instanceof", "var", "sealed",
  "permits", "yield", "assert",
];

const KOTLIN_WORDS = [
  "package", "import", "fun", "val", "var", "class", "object", "interface",
  "data", "sealed", "enum", "companion", "init", "constructor", "return",
  "if", "else", "when", "for", "while", "do", "break", "continue", "try",
  "catch", "finally", "throw", "is", "in", "as", "by", "out", "suspend",
  "override", "open", "abstract", "private", "public", "internal",
  "protected", "lateinit", "const", "null", "true", "false", "this", "super",
  "typealias", "operator", "inline", "reified", "vararg",
];

const SCALA_WORDS = [
  "package", "import", "object", "class", "trait", "case", "def", "val",
  "var", "lazy", "given", "using", "extends", "with", "new", "if", "else",
  "match", "for", "while", "do", "yield", "return", "try", "catch", "finally",
  "throw", "type", "implicit", "override", "abstract", "final", "sealed",
  "private", "protected", "this", "super", "null", "true", "false", "enum",
  "then",
];

const C_WORDS = [
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "goto", "sizeof", "typedef", "struct", "union",
  "enum", "static", "extern", "const", "volatile", "register", "inline",
  "restrict", "void", "char", "short", "int", "long", "float", "double",
  "signed", "unsigned", "include", "define", "ifdef", "ifndef", "endif",
  "pragma", "NULL",
];

const CPP_WORDS = [
  ...C_WORDS,
  "class", "public", "private", "protected", "virtual", "override", "final",
  "template", "typename", "namespace", "using", "new", "delete", "this",
  "try", "catch", "throw", "operator", "friend", "explicit", "constexpr",
  "consteval", "noexcept", "nullptr", "true", "false", "auto", "decltype",
  "concept", "requires", "co_await", "co_return", "co_yield", "static_cast",
  "dynamic_cast", "const_cast", "reinterpret_cast",
];

const OBJC_WORDS = [
  ...C_WORDS,
  "id", "self", "super", "nil", "YES", "NO", "BOOL", "interface",
  "implementation", "protocol", "property", "synthesize", "end", "selector",
  "import", "class", "autoreleasepool", "instancetype", "nonatomic",
  "strong", "weak", "copy", "assign", "readonly", "retain",
];

const CS_WORDS = [
  "using", "namespace", "class", "struct", "interface", "enum", "record",
  "public", "private", "protected", "internal", "static", "readonly",
  "const", "sealed", "abstract", "virtual", "override", "partial", "new",
  "return", "if", "else", "for", "foreach", "in", "while", "do", "switch",
  "case", "default", "break", "continue", "try", "catch", "finally", "throw",
  "this", "base", "null", "true", "false", "var", "void", "int", "long",
  "string", "bool", "double", "float", "decimal", "object", "async", "await",
  "yield", "is", "as", "typeof", "nameof", "where", "delegate", "event",
  "lock", "params", "ref", "out",
];

const PHP_WORDS = [
  "function", "class", "interface", "trait", "extends", "implements",
  "public", "private", "protected", "static", "const", "return", "if",
  "else", "elseif", "while", "do", "for", "foreach", "as", "switch", "case",
  "default", "break", "continue", "try", "catch", "finally", "throw", "new",
  "clone", "echo", "print", "require", "require_once", "include",
  "include_once", "namespace", "use", "this", "null", "true", "false",
  "array", "fn", "match", "global", "abstract", "final", "instanceof",
  "yield", "enum",
];

const RUBY_WORDS = [
  "def", "end", "class", "module", "if", "elsif", "else", "unless", "case",
  "when", "while", "until", "for", "in", "do", "begin", "rescue", "ensure",
  "retry", "return", "yield", "break", "next", "redo", "then", "self", "nil",
  "true", "false", "and", "or", "not", "require", "require_relative",
  "attr_accessor", "attr_reader", "attr_writer", "include", "extend",
  "raise", "lambda", "proc", "puts", "new",
];

const SWIFT_WORDS = [
  "import", "func", "let", "var", "class", "struct", "enum", "protocol",
  "extension", "actor", "init", "deinit", "subscript", "return", "if",
  "else", "guard", "switch", "case", "default", "for", "in", "while",
  "repeat", "break", "continue", "fallthrough", "do", "try", "catch",
  "throw", "throws", "rethrows", "defer", "where", "as", "is", "nil", "true",
  "false", "self", "Self", "super", "static", "final", "lazy", "weak",
  "unowned", "private", "fileprivate", "internal", "public", "open",
  "mutating", "async", "await", "some", "any", "typealias",
  "associatedtype", "inout",
];

const DART_WORDS = [
  "import", "export", "library", "part", "class", "mixin", "extends",
  "implements", "with", "abstract", "enum", "typedef", "var", "final",
  "const", "late", "static", "get", "set", "new", "return", "if", "else",
  "for", "in", "while", "do", "switch", "case", "default", "break",
  "continue", "try", "catch", "finally", "throw", "rethrow", "this", "super",
  "null", "true", "false", "void", "dynamic", "async", "await", "yield",
  "factory", "required", "covariant", "operator", "extension", "sealed",
  "base",
];

const SQL_WORDS = [
  "select", "from", "where", "insert", "into", "values", "update", "set",
  "delete", "create", "alter", "drop", "table", "view", "index", "trigger",
  "function", "procedure", "database", "schema", "join", "inner", "left",
  "right", "full", "outer", "cross", "lateral", "on", "using", "group", "by",
  "order", "having", "limit", "offset", "fetch", "union", "intersect",
  "except", "all", "distinct", "as", "and", "or", "not", "in", "exists",
  "between", "like", "ilike", "is", "null", "true", "false", "case", "when",
  "then", "else", "end", "primary", "foreign", "key", "references",
  "unique", "check", "default", "constraint", "cascade", "begin", "commit",
  "rollback", "transaction", "with", "recursive", "returning", "asc",
  "desc", "count", "sum", "avg", "min", "max", "cast", "int", "integer",
  "text", "varchar", "boolean", "timestamp", "date", "numeric", "serial",
];

const LUA_WORDS = [
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
  "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return",
  "then", "true", "until", "while", "self", "require",
];

const PERL_WORDS = [
  "sub", "my", "our", "local", "use", "no", "package", "require", "return",
  "if", "elsif", "else", "unless", "while", "until", "for", "foreach", "do",
  "last", "next", "redo", "die", "warn", "print", "printf", "eval", "undef",
  "defined", "ref", "bless", "wantarray", "BEGIN", "END",
];

const R_WORDS = [
  "function", "if", "else", "for", "while", "repeat", "break", "next",
  "return", "TRUE", "FALSE", "NULL", "NA", "Inf", "NaN", "library",
  "require", "in",
];

const JULIA_WORDS = [
  "function", "end", "if", "elseif", "else", "for", "while", "break",
  "continue", "return", "struct", "mutable", "abstract", "primitive",
  "type", "module", "using", "import", "export", "begin", "let", "local",
  "global", "const", "do", "try", "catch", "finally", "macro", "quote",
  "where", "in", "isa", "true", "false", "nothing", "missing",
];

const HASKELL_WORDS = [
  "module", "import", "where", "let", "in", "case", "of", "if", "then",
  "else", "do", "data", "newtype", "type", "class", "instance", "deriving",
  "qualified", "as", "hiding", "forall", "infix", "infixl", "infixr",
  "foreign", "True", "False", "Nothing", "Just",
];

const ELIXIR_WORDS = [
  "defmodule", "def", "defp", "defmacro", "defstruct", "defprotocol",
  "defimpl", "do", "end", "fn", "if", "unless", "else", "cond", "case",
  "when", "with", "for", "receive", "after", "try", "rescue", "catch",
  "raise", "throw", "import", "alias", "require", "use", "quote",
  "unquote", "true", "false", "nil", "and", "or", "not", "in",
];

const ERLANG_WORDS = [
  "module", "export", "import", "behaviour", "record", "define", "include",
  "spec", "type", "fun", "case", "of", "if", "end", "begin", "receive",
  "after", "try", "catch", "throw", "when", "andalso", "orelse", "not",
  "true", "false", "undefined",
];

const LISP_WORDS = [
  "defn", "defn-", "def", "defmacro", "defmulti", "defmethod",
  "defprotocol", "defrecord", "deftype", "defstruct", "defun", "defvar",
  "defparameter", "let", "letfn", "fn", "lambda", "if", "when", "cond",
  "case", "condp", "do", "doseq", "dotimes", "loop", "recur", "for", "try",
  "catch", "finally", "throw", "ns", "require", "import", "use", "quote",
  "setq", "setf", "nil", "true", "false",
];

const ZIG_WORDS = [
  "const", "var", "fn", "pub", "return", "if", "else", "while", "for",
  "switch", "break", "continue", "defer", "errdefer", "try", "catch",
  "struct", "enum", "union", "error", "test", "comptime", "inline",
  "export", "extern", "packed", "align", "orelse", "unreachable", "and",
  "or", "null", "true", "false", "undefined", "usingnamespace", "anytype",
  "noreturn", "suspend", "resume", "async", "await",
];

const OCAML_WORDS = [
  "let", "rec", "in", "and", "fun", "function", "match", "with", "when",
  "if", "then", "else", "type", "of", "module", "struct", "sig", "end",
  "open", "include", "val", "mutable", "begin", "try", "raise",
  "exception", "external", "class", "object", "method", "inherit", "new",
  "while", "do", "done", "for", "to", "downto", "lazy", "true", "false",
  "assert", "ref", "as",
];

const POWERSHELL_WORDS = [
  "function", "param", "begin", "process", "end", "if", "elseif", "else",
  "switch", "foreach", "for", "while", "do", "until", "break", "continue",
  "return", "try", "catch", "finally", "throw", "filter", "class", "enum",
  "using", "in", "true", "false", "null",
];

const HCL_WORDS = [
  "resource", "data", "variable", "output", "module", "provider",
  "terraform", "locals", "provisioner", "backend", "for_each", "count",
  "depends_on", "dynamic", "lifecycle", "if", "for", "in", "true", "false",
  "null", "var", "local", "each",
];

const GRAPHQL_WORDS = [
  "query", "mutation", "subscription", "fragment", "on", "type", "input",
  "enum", "interface", "union", "scalar", "schema", "directive", "extend",
  "implements", "true", "false", "null",
];

const PROTO_WORDS = [
  "syntax", "package", "import", "option", "message", "enum", "service",
  "rpc", "returns", "repeated", "optional", "required", "oneof", "map",
  "reserved", "extend", "public", "weak", "true", "false",
];

const SOLIDITY_WORDS = [
  "pragma", "solidity", "contract", "interface", "library", "function",
  "modifier", "event", "emit", "struct", "enum", "mapping", "address",
  "uint", "uint256", "int", "bool", "string", "bytes", "memory", "storage",
  "calldata", "public", "private", "internal", "external", "view", "pure",
  "payable", "returns", "return", "if", "else", "for", "while", "do",
  "break", "continue", "new", "delete", "require", "revert", "assert",
  "constructor", "using", "is", "import", "true", "false", "this", "super",
  "immutable", "constant", "override", "virtual", "try", "catch",
  "unchecked",
];

const DOCKER_WORDS = [
  "FROM", "RUN", "CMD", "LABEL", "EXPOSE", "ENV", "ADD", "COPY",
  "ENTRYPOINT", "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD",
  "STOPSIGNAL", "HEALTHCHECK", "SHELL", "AS",
];

const MAKE_WORDS = [
  "ifeq", "ifneq", "ifdef", "ifndef", "else", "endif", "include", "define",
  "endef", "export", "unexport", "override", "vpath", "PHONY",
];

const NIX_WORDS = [
  "let", "in", "rec", "with", "inherit", "if", "then", "else", "assert",
  "or", "import", "builtins", "true", "false", "null",
];

/// Кавычки языков семейства C: двойная для строки, одинарная для символа.
const CQ = ['"', "'"];

const GRAMMARS: Record<string, Grammar> = {
  ts: grammar(["//"], ["/*", "*/"], ['"', "'", "`"], TS_WORDS),
  rs: grammar(["//"], ["/*", "*/"], ['"'], RUST_WORDS),
  json: grammar([], null, ['"'], ["true", "false", "null"]),
  css: grammar([], ["/*", "*/"], CQ, [], { numbers: false }),
  html: grammar([], ["<!--", "-->"], CQ, [], { numbers: false }),
  yaml: grammar(["#"], null, CQ, ["true", "false", "null"], { numbers: false }),
  toml: grammar(["#"], null, CQ, ["true", "false"], { numbers: false }),
  sh: grammar(["#"], null, CQ, SHELL_WORDS, { numbers: false }),
  py: grammar(["#"], null, ['"""', "'''", '"', "'"], PY_WORDS),
  go: grammar(["//"], ["/*", "*/"], ['"', "'", "`"], GO_WORDS),
  java: grammar(["//"], ["/*", "*/"], ['"""', '"', "'"], JAVA_WORDS),
  kotlin: grammar(["//"], ["/*", "*/"], ['"""', '"', "'"], KOTLIN_WORDS),
  scala: grammar(["//"], ["/*", "*/"], ['"""', '"', "'"], SCALA_WORDS),
  c: grammar(["//"], ["/*", "*/"], CQ, C_WORDS),
  cpp: grammar(["//"], ["/*", "*/"], CQ, CPP_WORDS),
  objc: grammar(["//"], ["/*", "*/"], CQ, OBJC_WORDS),
  cs: grammar(["//"], ["/*", "*/"], ['"""', '"', "'"], CS_WORDS),
  php: grammar(["//", "#"], ["/*", "*/"], CQ, PHP_WORDS),
  ruby: grammar(["#"], ["=begin", "=end"], CQ, RUBY_WORDS),
  swift: grammar(["//"], ["/*", "*/"], ['"""', '"'], SWIFT_WORDS),
  dart: grammar(["//"], ["/*", "*/"], ['"""', "'''", '"', "'"], DART_WORDS),
  sql: grammar(["--"], ["/*", "*/"], CQ, SQL_WORDS, { fold: true }),
  lua: grammar(["--"], ["--[[", "]]"], CQ, LUA_WORDS),
  perl: grammar(["#"], null, CQ, PERL_WORDS),
  r: grammar(["#"], null, CQ, R_WORDS),
  julia: grammar(["#"], ["#=", "=#"], ['"""', '"', "'"], JULIA_WORDS),
  haskell: grammar(["--"], ["{-", "-}"], ['"'], HASKELL_WORDS),
  elixir: grammar(["#"], null, ['"""', '"', "'"], ELIXIR_WORDS),
  erlang: grammar(["%"], null, CQ, ERLANG_WORDS),
  // Одинарная кавычка в этом семействе — не строка, а сокращение для `quote`:
  // приняв её за кавычку, мы покрасили бы строкой половину файла.
  lisp: grammar([";"], null, ['"'], LISP_WORDS),
  zig: grammar(["//"], null, CQ, ZIG_WORDS),
  ocaml: grammar([], ["(*", "*)"], ['"'], OCAML_WORDS),
  powershell: grammar(["#"], ["<#", "#>"], CQ, POWERSHELL_WORDS, {
    fold: true,
  }),
  hcl: grammar(["#", "//"], ["/*", "*/"], CQ, HCL_WORDS),
  graphql: grammar(["#"], null, ['"""', '"'], GRAPHQL_WORDS),
  proto: grammar(["//"], ["/*", "*/"], CQ, PROTO_WORDS),
  solidity: grammar(["//"], ["/*", "*/"], CQ, SOLIDITY_WORDS),
  docker: grammar(["#"], null, CQ, DOCKER_WORDS, { numbers: false }),
  make: grammar(["#"], null, CQ, MAKE_WORDS, { numbers: false }),
  ini: grammar(["#", ";"], null, CQ, ["true", "false"], { numbers: false }),
  nix: grammar(["#"], ["/*", "*/"], ['"'], NIX_WORDS),
};

/// Markdown в таблицу не входит: он разбирается своим сканером ниже. Здесь он
/// всё равно нужен — правило «ничего не терять» касается и его.
const MARKDOWN = "md";

/// Все разборы, какие есть. Список берётся из самой таблицы, а не пишется
/// рядом с ней руками: главное свойство разбора — ничего не терять — обязано
/// проверяться на каждом языке, включая тот, который добавят завтра.
export const languages: string[] = [...Object.keys(GRAMMARS), MARKDOWN];

/// Расширение → разбор. Родственники делят разбор: разница между `.js` и
/// `.ts` для подсветки — пара слов в списке, а не другой язык.
const BY_EXTENSION: Record<string, string> = {
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  js: "ts", jsx: "ts", mjs: "ts", cjs: "ts",
  rs: "rs",
  json: "json", jsonc: "json", json5: "json", ipynb: "json",
  css: "css", scss: "css", sass: "css", less: "css", styl: "css",
  html: "html", htm: "html", xhtml: "html", xml: "html", svg: "html",
  vue: "html", svelte: "html", astro: "html", jsp: "html", erb: "html",
  hbs: "html", ejs: "html", plist: "html", xaml: "html", xsd: "html",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  md: MARKDOWN, markdown: MARKDOWN, mdown: MARKDOWN, mkd: MARKDOWN,
  mdx: MARKDOWN, rmd: MARKDOWN,
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh", ksh: "sh", env: "sh",
  py: "py", pyi: "py", pyw: "py", pyx: "py",
  go: "go",
  java: "java", groovy: "java", gradle: "java",
  kt: "kotlin", kts: "kotlin",
  scala: "scala", sbt: "scala",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
  ino: "cpp", cu: "cpp",
  m: "objc", mm: "objc",
  cs: "cs", csx: "cs",
  php: "php", phtml: "php",
  rb: "ruby", rake: "ruby", gemspec: "ruby",
  swift: "swift",
  dart: "dart",
  sql: "sql", psql: "sql", ddl: "sql",
  lua: "lua",
  pl: "perl", pm: "perl",
  r: "r",
  jl: "julia",
  hs: "haskell", lhs: "haskell", elm: "haskell", purs: "haskell",
  ex: "elixir", exs: "elixir",
  erl: "erlang", hrl: "erlang",
  clj: "lisp", cljs: "lisp", cljc: "lisp", edn: "lisp",
  lisp: "lisp", el: "lisp", scm: "lisp", rkt: "lisp",
  zig: "zig",
  ml: "ocaml", mli: "ocaml", fs: "ocaml", fsx: "ocaml", fsi: "ocaml",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  tf: "hcl", tfvars: "hcl", hcl: "hcl", nomad: "hcl",
  graphql: "graphql", gql: "graphql",
  proto: "proto", thrift: "proto", prisma: "proto",
  sol: "solidity",
  dockerfile: "docker",
  mk: "make", cmake: "make",
  ini: "ini", cfg: "ini", conf: "ini", properties: "ini", desktop: "ini",
  nix: "nix",
};

/// Файлы, у которых имя и есть язык: расширения у них нет вовсе, а разбор
/// нужен ровно такой же, как у их собратьев с расширением.
const BY_NAME: Record<string, string> = {
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "cmakelists.txt": "make",
  rakefile: "ruby",
  gemfile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  jenkinsfile: "java",
  ".env": "sh",
  ".bashrc": "sh",
  ".zshrc": "sh",
  ".bash_profile": "sh",
  ".zprofile": "sh",
  ".profile": "sh",
};

/// Какой разбор применить к файлу. Незнакомое расширение — без подсветки:
/// выдуманная разметка мешает сильнее, чем её отсутствие.
export function grammarOf(name: string): string | null {
  const plain = name.toLowerCase();
  const named = BY_NAME[plain];
  if (named) {
    return named;
  }
  const at = plain.lastIndexOf(".");
  const extension = at <= 0 ? "" : plain.slice(at + 1);
  return BY_EXTENSION[extension] ?? null;
}

// ——— Markdown ———
//
// Своим сканером, а не строкой в таблице выше. У разметки значение имеет начало
// строки — решётка, кавычка, дефис, ограда кода, — а таблица умеет смотреть
// только на отдельный символ, где бы он ни стоял. Заголовок она покрасила бы
// как комментарий в скрипте, а список — никак.
const FENCE = /^ {0,3}(```|~~~)/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const QUOTE = /^ {0,3}>/;
// Три и больше одинаковых знака в строке — черта, а не список из одного пункта.
const RULE = /^ {0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/;
/// Схема в угловых скобках: `<https://…>`, `<mailto:…>`.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/// Разбор внутри строки: код, выделение, ссылки. Разметку красим вместе с тем,
/// что она размечает: в исходнике звёздочки — часть текста, и оставлять их
/// серыми посреди цветного значит рвать слово надвое.
function markdownInline(
  line: string,
  push: (value: string, kind: TokenKind) => void,
): void {
  let at = 0;
  while (at < line.length) {
    const first = line[at];

    if (first === "`") {
      // Сколько апострофов открыло вставку, столько её и закроет.
      let ticks = 1;
      while (line[at + ticks] === "`") {
        ticks += 1;
      }
      const mark = "`".repeat(ticks);
      const close = line.indexOf(mark, at + ticks);
      const stop = close === -1 ? line.length : close + ticks;
      push(line.slice(at, stop), "code");
      at = stop;
      continue;
    }

    if (first === "*" || first === "_") {
      const mark = line[at + 1] === first ? first + first : first;
      const close = line.indexOf(mark, at + mark.length);
      // Пустое выделение — не выделение, а два знака подряд: `**` в тексте.
      if (close > at + mark.length) {
        push(line.slice(at, close + mark.length), "emphasis");
        at = close + mark.length;
        continue;
      }
    }

    if (first === "[" || (first === "!" && line[at + 1] === "[")) {
      const opened = first === "!" ? at + 1 : at;
      const text = line.indexOf("]", opened + 1);
      if (text !== -1 && line[text + 1] === "(") {
        const url = line.indexOf(")", text + 2);
        if (url !== -1) {
          push(line.slice(at, url + 1), "link");
          at = url + 1;
          continue;
        }
      }
    }

    if (first === "<") {
      const close = line.indexOf(">", at + 1);
      if (close !== -1 && SCHEME.test(line.slice(at + 1, close))) {
        push(line.slice(at, close + 1), "link");
        at = close + 1;
        continue;
      }
    }

    push(first, "plain");
    at += 1;
  }
}

function markdownTokens(text: string): Token[] {
  const tokens: Token[] = [];
  // Соседние куски одного разряда склеиваются на месте: слой подсветки рисует
  // по элементу на кусок, и абзац прозы иначе стал бы сотней пустых span-ов.
  const push = (value: string, kind: TokenKind) => {
    if (!value) {
      return;
    }
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) {
      last.text += value;
      return;
    }
    tokens.push({ text: value, kind });
  };

  // Открытая ограда: всё до закрывающей — код, чем бы оно ни выглядело.
  let fence: string | null = null;
  let at = 0;
  for (;;) {
    const end = text.indexOf("\n", at);
    const stop = end === -1 ? text.length : end;
    const line = text.slice(at, stop);

    if (fence) {
      push(line, "code");
      if (line.trimStart().startsWith(fence)) {
        fence = null;
      }
    } else {
      const opened = FENCE.exec(line);
      if (opened) {
        fence = opened[1];
        push(line, "code");
      } else if (HEADING.test(line)) {
        push(line, "heading");
      } else if (QUOTE.test(line)) {
        // Цитата серым курсивом — тем же, чем комментарий: она и есть речь
        // рядом с текстом, а не сам текст.
        push(line, "comment");
      } else if (RULE.test(line)) {
        push(line, "punct");
      } else {
        const bullet = BULLET.exec(line);
        if (bullet) {
          push(bullet[1], "plain");
          push(bullet[2], "punct");
          push(bullet[3], "plain");
        }
        markdownInline(line.slice(bullet ? bullet[0].length : 0), push);
      }
    }

    if (end === -1) {
      return tokens;
    }
    push("\n", "plain");
    at = end + 1;
  }
}

/// Разбор по метке у ограды кода: ```ts, ```python, ```bash. Метки пишут
/// словом, а таблица расширений знает их сокращениями — здесь только то, что
/// в ней не сходится.
const BY_TAG: Record<string, string> = {
  typescript: "ts", javascript: "ts", node: "ts",
  rust: "rs",
  python: "py", python3: "py",
  shell: "sh", console: "sh", terminal: "sh", shellsession: "sh",
  golang: "go",
  "c++": "cpp", cplusplus: "cpp", cxx: "cpp",
  csharp: "cs", "c#": "cs",
  "objective-c": "objc", objectivec: "objc",
  kotlin: "kotlin", ruby: "ruby", perl: "perl", julia: "julia",
  haskell: "haskell", elixir: "elixir", erlang: "erlang", clojure: "lisp",
  scheme: "lisp", ocaml: "ocaml", fsharp: "ocaml",
  powershell: "powershell", pwsh: "powershell",
  terraform: "hcl", dockerfile: "docker", makefile: "make",
  protobuf: "proto", solidity: "solidity",
};

export function grammarForTag(tag: string): string | null {
  const key = tag.trim().toLowerCase();
  return BY_TAG[key] ?? BY_EXTENSION[key] ?? null;
}

/// Смещение начала каждой строки. По нему берут кусок текста под окно показа,
/// не разрезая файл на строки целиком: на файле в двадцать тысяч строк такой
/// разрез — двадцать тысяч отдельных строк в памяти на каждое нажатие.
export function lineOffsets(text: string): number[] {
  const offsets = [0];
  let at = text.indexOf("\n");
  while (at !== -1) {
    offsets.push(at + 1);
    at = text.indexOf("\n", at + 1);
  }
  return offsets;
}

/// Сколько строк перед окном разбираем вслепую, чтобы попасть в их разряд.
///
/// Разбор — машина состояний: строка, начатая кавычкой на прошлой строке, и
/// код внутри `/* */` выглядят кодом, если начать читать с середины. Полного
/// файла для этого не нужно — хватает оглядки, а комментарий длиннее её ещё
/// поискать.
const LOOK_BEHIND = 400;

/// Токены строк `[from, to)` — ровно их, без единого лишнего символа.
///
/// Окном, а не целым файлом: слой подсветки рисует по элементу на токен, и
/// файл на пару мегабайт — это сотни тысяч элементов, из-за которых рвётся
/// прокрутка. Видно всё равно экран.
export function paintLines(
  text: string,
  language: string | null,
  offsets: number[],
  from: number,
  to: number,
): Token[] {
  const total = offsets.length;
  const first = Math.max(0, Math.min(from, total));
  const last = Math.min(to, total);
  if (last <= first) {
    return [];
  }
  const start = offsets[Math.max(0, first - LOOK_BEHIND)];
  // Конец последней строки окна — перед её переводом строки; у последней
  // строки файла перевода нет вовсе.
  const stop = last >= total ? text.length : offsets[last] - 1;
  const skip = offsets[first] - start;
  const tokens = tokenize(text.slice(start, stop), language);
  if (skip === 0) {
    return tokens;
  }
  const shown: Token[] = [];
  let at = 0;
  for (const token of tokens) {
    const end = at + token.text.length;
    if (end > skip) {
      // Токен оглядки, дотянувшийся до окна, показываем с того места, где окно
      // началось: иначе строка, начатая выше, съехала бы вбок.
      shown.push(
        at >= skip ? token : { text: token.text.slice(skip - at), kind: token.kind },
      );
    }
    at = end;
  }
  return shown;
}

/// Липкие: примеряются с конкретного места строки, а не с её начала. Обычный
/// `exec` пришлось бы кормить хвостом текста, а хвост под регулярное выражение
/// движок разворачивает в настоящую строку.
const NUMBER = /[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?/y;
const WORD = /[A-Za-z_$][A-Za-z0-9_$]*/y;

export function tokenize(text: string, language: string | null): Token[] {
  if (language === MARKDOWN) {
    return markdownTokens(text);
  }
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

  // Идём по индексам в самом тексте, не отрезая хвост на каждом токене. Срез
  // сам по себе дёшев — движок держит его видом на ту же строку, — но каждое
  // примеривание регулярного выражения этот вид разворачивает. На полумегабайте
  // разница выходит в два с половиной раза.
  let at = 0;
  while (at < text.length) {
    // Многострочный примеряется первым: `--[[` в Lua и `#=` в Julia начинаются
    // ровно тем же, чем однострочный комментарий, и обратный порядок съедал бы
    // открытие блока строкой, а его содержимое читал бы как код.
    if (rules.block && text.startsWith(rules.block[0], at)) {
      const [open, close] = rules.block;
      const end = text.indexOf(close, at + open.length);
      // Незакрытый комментарий тянется до конца файла — ровно так его и
      // прочитает компилятор, и видеть это полезно.
      const stop = end === -1 ? text.length : end + close.length;
      push(text.slice(at, stop), "comment");
      at = stop;
      continue;
    }

    const lineStart = rules.line.find((mark) => text.startsWith(mark, at));
    if (lineStart) {
      const end = text.indexOf("\n", at);
      const stop = end === -1 ? text.length : end;
      push(text.slice(at, stop), "comment");
      at = stop;
      continue;
    }

    const quote = rules.quotes.find((mark) => text.startsWith(mark, at));
    if (quote) {
      let index = at + quote.length;
      while (index < text.length) {
        if (text[index] === "\\") {
          // Экранированная кавычка строку не закрывает.
          index += 2;
          continue;
        }
        if (text.startsWith(quote, index)) {
          index += quote.length;
          break;
        }
        // Обычная строка не переживает перевод строки: незакрытая кавычка
        // иначе покрасила бы весь остаток файла.
        if (text[index] === "\n" && !spansLines(quote)) {
          break;
        }
        index += 1;
      }
      const stop = Math.min(index, text.length);
      push(text.slice(at, stop), "string");
      at = stop;
      continue;
    }

    const first = text[at];
    if (rules.numbers && first >= "0" && first <= "9") {
      NUMBER.lastIndex = at;
      const match = NUMBER.exec(text);
      if (match) {
        push(match[0], "number");
        at += match[0].length;
        continue;
      }
    }

    WORD.lastIndex = at;
    const word = WORD.exec(text)?.[0];
    if (word) {
      if (rules.keywords.has(rules.fold ? word.toLowerCase() : word)) {
        push(word, "keyword");
      } else {
        plain += word;
      }
      at += word.length;
      continue;
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
