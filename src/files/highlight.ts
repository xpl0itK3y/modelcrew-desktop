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
  | "link"
  // Разряды заплаты. Цвета у них те же, что у меток изменённых строк на полях
  // редактора: добавленное зелёное и убранное красное — это одно и то же
  // знание, показанное дважды.
  | "inserted"
  | "deleted"
  // Имя атрибута в разметке и имя свойства в стилях: одна и та же роль —
  // «как называется то, чему сейчас задают значение».
  | "attr";

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

const VIM_WORDS = [
  "function", "endfunction", "if", "elseif", "else", "endif", "for",
  "endfor", "while", "endwhile", "try", "catch", "endtry", "finally",
  "return", "let", "set", "setlocal", "call", "execute", "source", "map",
  "nmap", "imap", "vmap", "nnoremap", "inoremap", "vnoremap", "autocmd",
  "augroup", "command", "highlight", "syntax", "colorscheme", "normal",
];

const ASM_WORDS = [
  "mov", "movl", "movq", "push", "pop", "lea", "add", "sub", "mul", "imul",
  "div", "idiv", "inc", "dec", "cmp", "test", "jmp", "je", "jne", "jz",
  "jnz", "jg", "jge", "jl", "jle", "call", "ret", "leave", "nop", "int",
  "syscall", "and", "or", "xor", "not", "shl", "shr", "section", "global",
  "extern", "db", "dw", "dd", "dq", "equ", "resb", "align", "byte", "word",
  "dword", "qword", "ptr",
];

const TEX_WORDS = [
  "begin", "end", "documentclass", "usepackage", "section", "subsection",
  "subsubsection", "chapter", "part", "paragraph", "item", "label", "ref",
  "cite", "caption", "textbf", "textit", "emph", "newcommand",
  "renewcommand", "def", "input", "include", "bibliography", "title",
  "author", "date", "maketitle", "footnote", "left", "right", "frac",
];

const FORTRAN_WORDS = [
  "program", "end", "subroutine", "function", "module", "use", "implicit",
  "none", "integer", "real", "complex", "logical", "character",
  "dimension", "parameter", "allocatable", "allocate", "deallocate",
  "if", "then", "else", "elseif", "endif", "do", "enddo", "while",
  "select", "case", "call", "return", "contains", "interface", "type",
  "intent", "in", "out", "inout", "print", "write", "read", "stop",
  "true", "false",
];

const PASCAL_WORDS = [
  "program", "unit", "uses", "interface", "implementation", "begin", "end",
  "var", "const", "type", "procedure", "function", "record", "array", "of",
  "if", "then", "else", "case", "for", "to", "downto", "do", "while",
  "repeat", "until", "with", "try", "except", "finally", "raise", "class",
  "constructor", "destructor", "inherited", "nil", "true", "false", "and",
  "or", "not", "div", "mod", "in", "set", "string", "integer", "boolean",
];

const BASIC_WORDS = [
  "Dim", "As", "Set", "Let", "If", "Then", "Else", "ElseIf", "End",
  "Select", "Case", "For", "To", "Step", "Next", "Each", "While", "Wend",
  "Do", "Loop", "Until", "Function", "Sub", "Call", "Return", "Exit",
  "Public", "Private", "Const", "New", "Nothing", "True", "False", "And",
  "Or", "Not", "Option", "Explicit", "On", "Error", "Resume", "GoTo",
  "Class", "Property", "Get", "Byte", "Integer", "Long", "String",
  "Boolean", "Object", "Variant",
];

const TCL_WORDS = [
  "proc", "set", "unset", "if", "elseif", "else", "switch", "for",
  "foreach", "while", "break", "continue", "return", "expr", "puts",
  "global", "variable", "upvar", "uplevel", "namespace", "package",
  "source", "catch", "error", "array", "list", "lindex", "llength",
  "lappend", "string", "incr", "eval", "exec", "open", "close",
];

const AWK_WORDS = [
  "BEGIN", "END", "if", "else", "while", "for", "do", "break", "continue",
  "next", "exit", "return", "function", "print", "printf", "getline",
  "delete", "in", "length", "substr", "index", "split", "sub", "gsub",
  "match", "sprintf", "NR", "NF", "FS", "OFS", "RS", "ORS", "FILENAME",
];

const NGINX_WORDS = [
  "server", "location", "upstream", "http", "events", "stream", "listen",
  "server_name", "root", "index", "proxy_pass", "proxy_set_header",
  "return", "rewrite", "try_files", "include", "error_page", "access_log",
  "error_log", "worker_processes", "worker_connections", "gzip",
  "ssl_certificate", "ssl_certificate_key", "add_header", "if", "set",
  "map", "limit_req", "client_max_body_size",
];

const VERILOG_WORDS = [
  "module", "endmodule", "input", "output", "inout", "wire", "reg",
  "logic", "parameter", "localparam", "assign", "always", "always_ff",
  "always_comb", "initial", "begin", "end", "if", "else", "case",
  "endcase", "casez", "default", "for", "while", "repeat", "function",
  "endfunction", "task", "endtask", "generate", "endgenerate", "posedge",
  "negedge", "integer", "genvar", "typedef", "struct", "enum", "package",
  "import", "interface", "endinterface", "class", "endclass",
];

const VHDL_WORDS = [
  "entity", "architecture", "of", "is", "begin", "end", "port", "map",
  "signal", "variable", "constant", "process", "if", "then", "else",
  "elsif", "case", "when", "for", "loop", "while", "type", "subtype",
  "array", "record", "component", "generic", "library", "use", "package",
  "body", "function", "procedure", "return", "others", "downto", "to",
  "std_logic", "std_logic_vector", "integer", "in", "out", "inout",
];

const ADA_WORDS = [
  "package", "body", "is", "begin", "end", "procedure", "function",
  "return", "declare", "type", "subtype", "record", "array", "of",
  "constant", "with", "use", "if", "then", "else", "elsif", "case", "when",
  "loop", "for", "while", "exit", "goto", "task", "entry", "accept",
  "protected", "exception", "raise", "new", "abstract", "tagged", "access",
  "in", "out", "null", "others", "and", "or", "not", "range",
];

const NIM_WORDS = [
  "proc", "func", "method", "iterator", "template", "macro", "converter",
  "type", "object", "ref", "ptr", "var", "let", "const", "if", "elif",
  "else", "case", "of", "when", "while", "for", "in", "notin", "break",
  "continue", "return", "yield", "discard", "import", "export", "include",
  "from", "as", "try", "except", "finally", "raise", "defer", "block",
  "static", "and", "or", "not", "nil", "true", "false", "result",
];

const BATCH_WORDS = [
  "echo", "set", "if", "else", "for", "in", "do", "goto", "call", "exit",
  "setlocal", "endlocal", "shift", "pause", "start", "cd", "copy", "move",
  "del", "mkdir", "rmdir", "type", "findstr", "errorlevel", "not",
  "defined", "exist", "equ", "neq", "lss", "gtr",
];

/// Кавычки языков семейства C: двойная для строки, одинарная для символа.
const CQ = ['"', "'"];

const GRAMMARS: Record<string, Grammar> = {
  ts: grammar(["//"], ["/*", "*/"], ['"', "'", "`"], TS_WORDS),
  rs: grammar(["//"], ["/*", "*/"], ['"'], RUST_WORDS),
  json: grammar([], null, ['"'], ["true", "false", "null"]),
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
  vim: grammar(['"'], null, ["'"], VIM_WORDS, { numbers: false }),
  asm: grammar([";", "#"], null, CQ, ASM_WORDS, { fold: true }),
  tex: grammar(["%"], null, [], TEX_WORDS, { numbers: false }),
  fortran: grammar(["!"], null, CQ, FORTRAN_WORDS, { fold: true }),
  pascal: grammar(["//"], ["{", "}"], ["'"], PASCAL_WORDS, { fold: true }),
  // Апостроф здесь начинает комментарий, а не строку: `' комментарий` — самая
  // частая строка в этом семействе, и принять её за строку значит покрасить
  // ею весь файл.
  basic: grammar(["'", "REM ", "rem "], null, ['"'], BASIC_WORDS, {
    fold: true,
  }),
  tcl: grammar(["#"], null, ['"'], TCL_WORDS),
  awk: grammar(["#"], null, ['"'], AWK_WORDS),
  nginx: grammar(["#"], null, CQ, NGINX_WORDS, { numbers: false }),
  verilog: grammar(["//"], ["/*", "*/"], ['"'], VERILOG_WORDS),
  vhdl: grammar(["--"], null, ['"'], VHDL_WORDS, { fold: true }),
  ada: grammar(["--"], null, ['"'], ADA_WORDS, { fold: true }),
  nim: grammar(["#"], ["#[", "]#"], ['"""', '"'], NIM_WORDS),
  batch: grammar(["::", "REM ", "rem "], null, ['"'], BATCH_WORDS, {
    fold: true,
  }),
  // Списки исключений и владельцев: решётка комментарием, всё остальное —
  // шаблон пути. Ни строк, ни чисел здесь нет, и красить `2` в `logs/2`
  // числом значит показывать структуру, которой нет.
  ignore: grammar(["#"], null, [], [], { numbers: false }),
  // Пустая грамматика для незнакомых расширений: комментарии трёх самых частых
  // видов и двойная кавычка. Ключевых слов нет нарочно — язык неизвестен, и
  // придумывать ему костяк не из чего. Одинарная кавычка тоже не строка: в
  // английском тексте это апостроф, и от него загорелась бы половина файла.
  plain: grammar(["#", "//"], ["/*", "*/"], ['"'], []),
};

/// Markdown и заплаты в таблицу не входят: их разбирают свои сканеры ниже.
/// Здесь они всё равно нужны — правило «ничего не терять» касается и их.
const MARKDOWN = "md";
const DIFF = "diff";
const HTML = "html";
const CSS = "css";

/// Все разборы, какие есть. Список берётся из самой таблицы, а не пишется
/// рядом с ней руками: главное свойство разбора — ничего не терять — обязано
/// проверяться на каждом языке, включая тот, который добавят завтра.
export const languages: string[] = [
  ...Object.keys(GRAMMARS),
  MARKDOWN,
  DIFF,
  HTML,
  CSS,
];

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
  vim: "vim", vimrc: "vim",
  asm: "asm", s: "asm", nasm: "asm", ll: "asm",
  tex: "tex", sty: "tex", cls: "tex", bib: "tex", ltx: "tex",
  f: "fortran", f90: "fortran", f95: "fortran", f03: "fortran",
  for: "fortran", f77: "fortran",
  pas: "pascal", pp: "pascal", dpr: "pascal", lpr: "pascal",
  vb: "basic", vbs: "basic", bas: "basic", frm: "basic",
  tcl: "tcl", tk: "tcl", itcl: "tcl",
  awk: "awk", gawk: "awk",
  verilog: "verilog", sv: "verilog", svh: "verilog", vh: "verilog",
  v: "verilog",
  vhd: "vhdl", vhdl: "vhdl",
  adb: "ada", ads: "ada", ada: "ada",
  nim: "nim", nims: "nim", nimble: "nim",
  bat: "batch", cmd: "batch",
  // Списки исключений: у них расширения нет вовсе, но `.gitignore` в подпапке
  // проекта встречается и как `something.gitignore`.
  gitignore: "ignore", dockerignore: "ignore", npmignore: "ignore",
  eslintignore: "ignore", prettierignore: "ignore", hgignore: "ignore",
  gitattributes: "ignore", codeowners: "ignore",
  diff: "diff", patch: "diff", rej: "diff",
  // Родня уже известных разборов: другой язык, тот же костяк.
  hx: "java", hxml: "java", jenkinsfile: "java", nc: "java",
  gd: "py", pyz: "py", bzl: "py", star: "py", coffee: "py", sage: "py",
  cr: "ruby", ru: "ruby", podspec: "ruby", thor: "ruby",
  raku: "perl", rakumod: "perl", p6: "perl", pod: "perl", t: "perl",
  prolog: "erlang", plt: "erlang", escript: "erlang",
  vala: "cs", vapi: "cs", aidl: "java",
  d: "cpp", di: "cpp", odin: "cpp", ec: "cpp", pde: "cpp",
  move: "rs", cairo: "rs",
  bicep: "ts", res: "ts", resi: "ts", re: "ts", rei: "ts", flow: "ts",
  qml: "ts", gs: "ts", jsonl: "json", ndjson: "json", geojson: "json",
  topojson: "json", webmanifest: "json", avsc: "json", jsonnet: "hcl",
  libsonnet: "hcl", tfstate: "json", tfplan: "hcl", workflow: "hcl",
  pkl: "hcl", cue: "hcl",
  wat: "lisp", wast: "lisp", lsp: "lisp", cl: "lisp",
  scpt: "haskell", applescript: "haskell", idr: "haskell", agda: "haskell",
  cabal: "haskell",
  fnl: "lisp", janet: "lisp", scrbl: "lisp",
  sqlite: "sql", mysql: "sql", pgsql: "sql", hql: "sql", cql: "sql",
  ninja: "make", just: "make", justfile: "make", mak: "make", am: "make",
  ac: "sh", spec: "sh", pkgbuild: "sh", ebuild: "sh",
  bats: "sh", zshrc: "sh", cshrc: "sh", tcshrc: "sh", profile: "sh",
  service: "ini", socket: "ini", timer: "ini", target: "ini", mount: "ini",
  path: "ini", automount: "ini", slice: "ini", scope: "ini",
  reg: "ini", inf: "ini", editorconfig: "ini", gitconfig: "ini",
  npmrc: "ini", yarnrc: "ini", flake8: "ini", pylintrc: "ini",
  htaccess: "ini", curlrc: "ini", wgetrc: "ini", netrc: "ini",
  crontab: "ini", terraformrc: "ini", pypirc: "ini", gitmodules: "ini",
  lock: "toml",
  cnf: "ini", ovpn: "ini", repo: "ini",
  po: "ignore", pot: "ignore",
  cshtml: "html", vbhtml: "html", razor: "html", jinja: "html",
  jinja2: "html", j2: "html", twig: "html", liquid: "html",
  mustache: "html", handlebars: "html", njk: "html", tpl: "html",
  wxml: "html", ux: "html", rss: "html", atom: "html",
  xsl: "html", xslt: "html", dtd: "html", ent: "html", storyboard: "html",
  xib: "html", nuspec: "html", csproj: "html", vbproj: "html",
  fsproj: "html", vcxproj: "html", props: "html", targets: "html",
  axml: "html", resx: "html",
  postcss: "css", pcss: "css", sss: "css",
  glsl: "c", vert: "c", frag: "c", comp: "c", geom: "c", tesc: "c",
  hlsl: "c", metal: "cpp", wgsl: "rs",
  ipp: "cpp", tpp: "cpp", inl: "cpp", cppm: "cpp", ixx: "cpp",
  m4: "sh", sed: "sh", exp: "tcl",
  psc1: "powershell", pssc: "powershell", ps1xml: "html",
  proto3: "proto", capnp: "proto", fbs: "proto",
  smithy: "proto", avdl: "proto", ice: "proto",
  vy: "py", huff: "asm",
  csh: "sh", tcsh: "sh", ash: "sh",
  dash: "sh", elv: "sh", nu: "sh",
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
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  ".npmignore": "ignore",
  ".eslintignore": "ignore",
  ".prettierignore": "ignore",
  ".hgignore": "ignore",
  ".gcloudignore": "ignore",
  ".vercelignore": "ignore",
  ".helmignore": "ignore",
  ".gitattributes": "ignore",
  codeowners: "ignore",
  ".gitmodules": "ini",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
  ".npmrc": "ini",
  ".yarnrc": "ini",
  ".flake8": "ini",
  ".pylintrc": "ini",
  ".coveragerc": "ini",
  ".htaccess": "ini",
  ".curlrc": "ini",
  ".netrc": "ini",
  ".inputrc": "ini",
  "nginx.conf": "nginx",
  crontab: "ini",
  ".crontab": "ini",
  ".vimrc": "vim",
  ".gvimrc": "vim",
  ".ideavimrc": "vim",
  ".tmux.conf": "ignore",
  ".screenrc": "ignore",
  "go.mod": "ignore",
  "go.sum": "ignore",
  "go.work": "ignore",
  "requirements.txt": "ignore",
  "constraints.txt": "ignore",
  procfile: "ignore",
  ".ripgreprc": "ignore",
  ".prettierrc": "json",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".swcrc": "json",
  ".stylelintrc": "json",
  ".markdownlintrc": "json",
  ".huskyrc": "json",
  ".nvmrc": "ignore",
  ".node-version": "ignore",
  ".python-version": "ignore",
  ".ruby-version": "ignore",
  ".tool-versions": "ignore",
  "cargo.lock": "toml",
  "poetry.lock": "toml",
  "pipfile": "toml",
  "pipfile.lock": "json",
  "build": "py",
  "workspace": "py",
  "snapfile": "ruby",
  "fastfile": "ruby",
  "appfile": "ruby",
  "capfile": "ruby",
  "guardfile": "ruby",
  "berksfile": "ruby",
  "justfile": "make",
  ".justfile": "make",
  "meson.build": "py",
  "sconstruct": "py",
  "sconscript": "py",
  "build.ninja": "make",
  ".bash_aliases": "sh",
  ".bash_logout": "sh",
  ".cshrc": "sh",
  ".kshrc": "sh",
  ".xinitrc": "sh",
  ".xprofile": "sh",
};

/// Расширения, которым подсветка не нужна. Проза — потому что в ней нечего
/// показывать: строка не строка, число не число, и любой разбор здесь только
/// придумает структуру, которой нет. Двоичные — потому что до редактора они и
/// не доходят, но соврать про них тоже незачем.
const NO_GRAMMAR = new Set([
  "txt", "text", "log", "csv", "tsv", "rst", "org", "adoc", "asciidoc",
  "nfo", "srt", "vtt", "ics", "vcf", "out", "err", "man", "me", "ms",
  "png", "apng", "jpg", "jpeg", "jfif", "gif", "webp", "avif", "bmp",
  "ico", "cur", "tif", "tiff", "psd", "ai", "eps", "pdf",
  "mp3", "wav", "ogg", "flac", "m4a", "mp4", "mov", "avi", "mkv", "webm",
  "zip", "gz", "bz2", "xz", "zst", "7z", "rar", "tar", "jar", "war",
  "exe", "dll", "so", "dylib", "bin", "dat", "db", "sqlite3", "class",
  "o", "obj", "a", "lib", "pyc", "pyo", "wasm", "woff", "woff2", "ttf",
  "otf", "eot",
]);

/// Какой разбор применить к файлу. Знакомое расширение — свой разбор,
/// незнакомое — общий: комментарии, строки и числа устроены одинаково почти
/// везде, и показать хотя бы их лучше, чем оставить файл серым. Проза и
/// двоичное остаются без подсветки, и файл без расширения — тоже: `LICENSE` и
/// `AUTHORS` это текст, а не язык, которого мы не знаем.
export function grammarOf(name: string): string | null {
  const plain = name.toLowerCase();
  const named = BY_NAME[plain];
  if (named) {
    return named;
  }
  const at = plain.lastIndexOf(".");
  const extension = at <= 0 ? "" : plain.slice(at + 1);
  const known = BY_EXTENSION[extension];
  if (known) {
    return known;
  }
  return extension && !NO_GRAMMAR.has(extension) ? "plain" : null;
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


// ——— Страницы и стили ———
//
// Тоже своими сканерами. Разбор из таблицы умеет комментарии, строки, числа и
// слова из списка — а в разметке значение имеет место: `div` внутри угловых
// скобок это тег, а в тексте абзаца это просто слово. Списком ключевых слов
// такое не выражается, и html с css оставались почти серыми: красилось
// значение атрибута, и больше ничего.

/// Имя тега или атрибута.
const TAG_NAME = /[a-zA-Z_][\w:.-]*/y;
const ATTR_NAME = /[^\s=/>"'<]+/y;
/// Мнемоника: `&amp;`, `&#169;`, `&#x2014;`.
const ENTITY = /&#?[a-zA-Z0-9]{1,10};/y;

/// Склейка соседних кусков одного разряда: слой подсветки рисует по элементу
/// на кусок, и абзац текста иначе стал бы сотней пустых span-ов.
function joiner(tokens: Token[]) {
  return (value: string, kind: TokenKind) => {
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
}

function htmlTokens(text: string): Token[] {
  const tokens: Token[] = [];
  const push = joiner(tokens);

  const between = (open: string, close: string, kind: TokenKind): number => {
    const end = text.indexOf(close, at + open.length);
    // Незакрытое тянется до конца файла — ровно так его прочитает и браузер.
    const stop = end === -1 ? text.length : end + close.length;
    push(text.slice(at, stop), kind);
    return stop;
  };

  let at = 0;
  while (at < text.length) {
    if (text.startsWith("<!--", at)) {
      at = between("<!--", "-->", "comment");
      continue;
    }
    // Объявление типа документа и обработчик: `<!DOCTYPE html>`, `<?php`.
    // Внутрь не заглядываем — снаружи их и читают целиком.
    if (text.startsWith("<!", at) || text.startsWith("<?", at)) {
      at = between("<", ">", "keyword");
      continue;
    }

    if (text[at] === "<") {
      const opened = at + (text[at + 1] === "/" ? 2 : 1);
      TAG_NAME.lastIndex = opened;
      const name = TAG_NAME.exec(text)?.[0];
      if (!name) {
        // Угловая скобка не открыла тег — это знак меньше в тексте.
        push("<", "punct");
        at += 1;
        continue;
      }
      push(text.slice(at, opened), "punct");
      push(name, "keyword");
      at = opened + name.length;

      // Внутри тега: имена атрибутов, знаки равенства, значения в кавычках.
      while (at < text.length) {
        const first = text[at];
        if (first === ">") {
          push(">", "punct");
          at += 1;
          break;
        }
        if (text.startsWith("/>", at)) {
          push("/>", "punct");
          at += 2;
          break;
        }
        if (first === '"' || first === "'") {
          const end = text.indexOf(first, at + 1);
          // Кавычка внутри тега многострочна: длинный `style` переносят.
          const stop = end === -1 ? text.length : end + 1;
          push(text.slice(at, stop), "string");
          at = stop;
          continue;
        }
        if (first === "=") {
          push("=", "punct");
          at += 1;
          continue;
        }
        if (first === " " || first === "\n" || first === "\t" || first === "\r") {
          push(first, "plain");
          at += 1;
          continue;
        }
        ATTR_NAME.lastIndex = at;
        const attr = ATTR_NAME.exec(text)?.[0];
        if (!attr) {
          push(first, "punct");
          at += 1;
          continue;
        }
        push(attr, "attr");
        at += attr.length;
      }
      continue;
    }

    if (text[at] === "&") {
      ENTITY.lastIndex = at;
      const entity = ENTITY.exec(text)?.[0];
      if (entity) {
        push(entity, "number");
        at += entity.length;
        continue;
      }
    }

    push(text[at], "plain");
    at += 1;
  }
  return tokens;
}

/// Число со своей единицей и цвет: `12px`, `1.5rem`, `50%`, `#ffcc00`.
const CSS_VALUE_NUMBER = /(#[0-9a-fA-F]{3,8}\b|[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?[a-zA-Z%]*)/y;
const CSS_WORD = /[-\w]+/y;

/// Чем кончится начатое здесь предложение: блоком или объявлением. Заглядываем
/// вперёд, потому что отличить `.foo` от `color` можно только по тому, что
/// стоит дальше — и во вложенных правилах scss на месте свойства оказывается
/// селектор.
function cssStatement(text: string, from: number): "block" | "declaration" {
  let at = from;
  while (at < text.length) {
    if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      at = end === -1 ? text.length : end + 2;
      continue;
    }
    const first = text[at];
    if (first === '"' || first === "'") {
      const end = text.indexOf(first, at + 1);
      at = end === -1 ? text.length : end + 1;
      continue;
    }
    if (first === "{") {
      return "block";
    }
    if (first === ";" || first === "}") {
      return "declaration";
    }
    at += 1;
  }
  return "declaration";
}

function cssTokens(text: string): Token[] {
  const tokens: Token[] = [];
  const push = joiner(tokens);

  /// Значение свойства: до точки с запятой или до конца правила.
  const value = (at: number): number => {
    while (at < text.length) {
      const first = text[at];
      if (first === ";" || first === "}") {
        return at;
      }
      if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        const stop = end === -1 ? text.length : end + 2;
        push(text.slice(at, stop), "comment");
        at = stop;
        continue;
      }
      if (first === '"' || first === "'") {
        const end = text.indexOf(first, at + 1);
        const stop = end === -1 ? text.length : end + 1;
        push(text.slice(at, stop), "string");
        at = stop;
        continue;
      }
      if (text.startsWith("!important", at)) {
        push("!important", "keyword");
        at += "!important".length;
        continue;
      }
      if (first === "#" || first === "." || (first >= "0" && first <= "9")) {
        CSS_VALUE_NUMBER.lastIndex = at;
        const number = CSS_VALUE_NUMBER.exec(text)?.[0];
        if (number) {
          push(number, "number");
          at += number.length;
          continue;
        }
      }
      CSS_WORD.lastIndex = at;
      const word = CSS_WORD.exec(text)?.[0];
      if (word) {
        push(word, "plain");
        at += word.length;
        continue;
      }
      push(first, first === " " || first === "\n" ? "plain" : "punct");
      at += 1;
    }
    return at;
  };

  let at = 0;
  while (at < text.length) {
    const first = text[at];
    if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);
      const stop = end === -1 ? text.length : end + 2;
      push(text.slice(at, stop), "comment");
      at = stop;
      continue;
    }
    if (first === "}" || first === ";" || first === "{") {
      push(first, "punct");
      at += 1;
      continue;
    }
    if (first === " " || first === "\n" || first === "\t" || first === "\r") {
      push(first, "plain");
      at += 1;
      continue;
    }
    if (first === "@") {
      CSS_WORD.lastIndex = at + 1;
      const word = CSS_WORD.exec(text)?.[0] ?? "";
      push(text.slice(at, at + 1 + word.length), "keyword");
      at += 1 + word.length;
      continue;
    }

    if (cssStatement(text, at) === "block") {
      // Селектор: всё до открывающей скобки. Он и есть заголовок правила, и
      // читается так же — по нему находят нужное место в файле.
      let stop = at;
      while (stop < text.length && text[stop] !== "{") {
        stop += 1;
      }
      // Перевод строки в конце селектора отдаём обычным текстом: иначе пустая
      // строка перед `{` красилась бы заголовком.
      const selector = text.slice(at, stop).replace(/\s+$/, "");
      push(selector, "heading");
      at += selector.length;
      continue;
    }

    CSS_WORD.lastIndex = at;
    const property = CSS_WORD.exec(text)?.[0];
    if (!property) {
      push(first, "punct");
      at += 1;
      continue;
    }
    push(property, "attr");
    at += property.length;
    // Двоеточие и значение за ним — если объявление вообще дошло до значения.
    while (at < text.length && (text[at] === " " || text[at] === "\t")) {
      push(text[at], "plain");
      at += 1;
    }
    if (text[at] === ":") {
      push(":", "punct");
      at = value(at + 1);
    }
  }
  return tokens;
}

// ——— Заплаты ———
//
// Тоже своим сканером: у заплаты значение имеет первый знак строки, и он же
// решает всё. Плюс и минус посреди строки — это сложение и вычитание, а в
// начале — добавленная и убранная строка, и таблица разбора этой разницы не
// видит.

/// Заголовки файла в заплате: до них она рассказывает про файлы, а не про
/// строки.
const PATCH_HEAD = [
  "diff ", "index ", "--- ", "+++ ", "old mode", "new mode", "new file",
  "deleted file", "similarity index", "rename from", "rename to", "copy from",
  "copy to", "GIT binary patch", "Binary files", "\\ No newline",
];

function diffTokens(text: string): Token[] {
  const tokens: Token[] = [];
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

  let at = 0;
  for (;;) {
    const end = text.indexOf("\n", at);
    const stop = end === -1 ? text.length : end;
    const line = text.slice(at, stop);

    if (line.startsWith("@@")) {
      // Заголовок куска: единственная строка, по которой видно, где мы в файле.
      push(line, "heading");
    } else if (PATCH_HEAD.some((start) => line.startsWith(start))) {
      push(line, "comment");
    } else if (line.startsWith("+")) {
      push(line, "inserted");
    } else if (line.startsWith("-")) {
      push(line, "deleted");
    } else {
      push(line, "plain");
    }

    if (end === -1) {
      return tokens;
    }
    push("\n", "plain");
    at = end + 1;
  }
}

export function tokenize(text: string, language: string | null): Token[] {
  if (language === MARKDOWN) {
    return markdownTokens(text);
  }
  if (language === DIFF) {
    return diffTokens(text);
  }
  if (language === HTML) {
    return htmlTokens(text);
  }
  if (language === CSS) {
    return cssTokens(text);
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
