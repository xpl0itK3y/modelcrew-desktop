// Правка текста клавишами: отступ, перенос, комментарий, работа со строками.
//
// Чистые функции над текстом и выделением, а не над полем ввода. Поле ввода —
// это браузер, у него свой курсор, своя история и своё поведение в тестах;
// здесь же остаётся только то, что можно проверить: был такой текст с таким
// выделением, стал такой.
//
// Каждая функция возвращает и текст, и выделение целиком. Считать смещение
// курсора отдельно значит держать два описания одного и того же и однажды их
// рассогласовать.

export type Edit = {
  text: string;
  /// Где оказалось выделение в новом тексте.
  from: number;
  to: number;
};

export type CommentMarks = {
  line: string | null;
  block: [string, string] | null;
};

/// Начало строки, в которой стоит `at`.
function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

/// Конец строки — перед её переводом строки; у последней строки это конец
/// текста.
function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at);
  return end === -1 ? text.length : end;
}

/// Строки, которых касается выделение, целиком.
function touched(text: string, from: number, to: number): [number, number] {
  const start = lineStart(text, from);
  // Выделение, кончающееся ровно в начале строки, эту строку не захватывает:
  // иначе тройной щелчок по одной строке трогал бы две.
  const last = to > from && text[to - 1] === "\n" ? to - 1 : to;
  return [start, lineEnd(text, last)];
}

/// Отступ, которым набран этот файл. Спрашиваем у файла, а не у настроек:
/// чужой файл правят его отступом, каким бы он ни был, — иначе одна правка
/// оставляет после себя два разных стиля в одном месте.
export function indentUnitOf(text: string): string {
  let smallest = 0;
  let at = 0;
  // Хватит и начала файла: отступ в нём везде один, а на файле в мегабайт
  // считать его целиком — работа на каждое нажатие.
  const limit = Math.min(text.length, 64 * 1024);
  while (at < limit) {
    if (text[at] === "\t") {
      return "\t";
    }
    let width = 0;
    while (text[at + width] === " ") {
      width += 1;
    }
    // Строка из одних пробелов отступа не задаёт.
    const rest = text[at + width];
    if (width > 0 && rest !== "\n" && rest !== undefined) {
      smallest = smallest === 0 ? width : Math.min(smallest, width);
    }
    const end = text.indexOf("\n", at);
    if (end === -1) {
      break;
    }
    at = end + 1;
  }
  return " ".repeat(smallest >= 2 && smallest <= 8 ? smallest : 2);
}

/// Ведущие пробелы строки.
function leading(line: string): string {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0] : "";
}

export function indent(
  text: string,
  from: number,
  to: number,
  unit: string,
): Edit {
  if (from === to) {
    // Без выделения Tab — это просто отступ под курсором.
    return {
      text: text.slice(0, from) + unit + text.slice(to),
      from: from + unit.length,
      to: from + unit.length,
    };
  }
  const [start, end] = touched(text, from, to);
  const lines = text.slice(start, end).split("\n");
  // Пустую строку не трогаем: отступ в ней — это пробелы в пустоте.
  const shifted = lines.map((line) => (line === "" ? line : unit + line));
  const body = shifted.join("\n");
  const added = body.length - (end - start);
  const first = lines[0] === "" ? 0 : unit.length;
  return {
    text: text.slice(0, start) + body + text.slice(end),
    // Выделение остаётся на тех же строках: Tab нажимают несколько раз подряд.
    from: from + first,
    to: to + added,
  };
}

export function outdent(
  text: string,
  from: number,
  to: number,
  unit: string,
): Edit {
  const [start, end] = touched(text, from, to);
  const width = unit === "\t" ? 1 : unit.length;
  const shifted: string[] = [];
  let cutBeforeFrom = 0;
  let cutBeforeTo = 0;
  let cutTotal = 0;
  let at = start;
  for (;;) {
    const stop = Math.min(lineEnd(text, at), end);
    const line = text.slice(at, stop);
    const space = leading(line);
    // Табуляция уходит целиком: она и есть один отступ, какой бы ширины ни
    // рисовалась.
    const cut = Math.min(space.startsWith("\t") ? 1 : width, space.length);
    shifted.push(line.slice(cut));
    // Курсор сдвигается ровно на то, что срезано левее него.
    cutBeforeFrom += Math.min(cut, Math.max(0, from - at));
    cutBeforeTo += Math.min(cut, Math.max(0, to - at));
    cutTotal += cut;
    if (stop >= end) {
      break;
    }
    at = stop + 1;
  }
  if (cutTotal === 0) {
    return { text, from, to };
  }
  return {
    text: text.slice(0, start) + shifted.join("\n") + text.slice(end),
    from: from - cutBeforeFrom,
    to: to - cutBeforeTo,
  };
}

/// Перевод строки с отступом предыдущей. Открывающая скобка добавляет ещё
/// один, а закрывающая сразу за курсором уезжает на свою строку — так её и
/// пишут руками, только без трёх нажатий.
export function breakLine(
  text: string,
  from: number,
  to: number,
  unit: string,
): Edit {
  const start = lineStart(text, from);
  const space = leading(text.slice(start, lineEnd(text, from)));
  const before = text.slice(start, from).trimEnd();
  const opens = /[{[(:]$/.test(before);
  const closer = text[to];
  const inside = opens ? space + unit : space;
  const head = "\n" + inside;
  const tail =
    opens && (closer === "}" || closer === "]" || closer === ")")
      ? "\n" + space
      : "";
  const at = from + head.length;
  return {
    text: text.slice(0, from) + head + tail + text.slice(to),
    from: at,
    to: at,
  };
}

export function toggleComment(
  text: string,
  from: number,
  to: number,
  marks: CommentMarks,
): Edit | null {
  if (marks.line) {
    return toggleLineComment(text, from, to, marks.line);
  }
  if (marks.block) {
    return toggleBlockComment(text, from, to, marks.block);
  }
  return null;
}

function toggleLineComment(
  text: string,
  from: number,
  to: number,
  mark: string,
): Edit {
  const [start, end] = touched(text, from, to);
  const lines = text.slice(start, end).split("\n");
  const meaningful = lines.filter((line) => line.trim() !== "");
  // Пустые строки в счёт не идут: одна пустая строка посреди выделения не
  // должна превращать снятие комментария в его постановку.
  const commented =
    meaningful.length > 0 &&
    meaningful.every((line) => line.trimStart().startsWith(mark));
  const changed = lines.map((line) => {
    if (line.trim() === "") {
      return line;
    }
    const space = leading(line);
    if (commented) {
      const rest = line.slice(space.length + mark.length);
      // Пробел после знака ставили мы — его же и убираем.
      return space + (rest.startsWith(" ") ? rest.slice(1) : rest);
    }
    return space + mark + " " + line.slice(space.length);
  });
  const body = changed.join("\n");
  return {
    text: text.slice(0, start) + body + text.slice(end),
    from: start,
    to: start + body.length,
  };
}

function toggleBlockComment(
  text: string,
  from: number,
  to: number,
  [open, close]: [string, string],
): Edit {
  // Без выделения комментируется строка целиком: это то же самое, что и со
  // знаком построчного комментария, только знаков два.
  const [at, stop] =
    from === to ? touched(text, from, to) : ([from, to] as [number, number]);
  const body = text.slice(at, stop);
  const lead = /^\s*/.exec(body)?.[0] ?? "";
  const tail = /\s*$/.exec(body.slice(lead.length))?.[0] ?? "";
  const core = body.slice(lead.length, body.length - tail.length);
  const wrapped = core.startsWith(open) && core.endsWith(close);
  const changed = wrapped
    ? lead + core.slice(open.length, core.length - close.length).trim() + tail
    : `${lead}${open} ${core} ${close}${tail}`;
  return {
    text: text.slice(0, at) + changed + text.slice(stop),
    from: at,
    to: at + changed.length,
  };
}

export function duplicateLines(text: string, from: number, to: number): Edit {
  const [start, end] = touched(text, from, to);
  const body = text.slice(start, end);
  const copy = "\n" + body;
  return {
    text: text.slice(0, end) + copy + text.slice(end),
    // Выделение переезжает на копию: следующее нажатие удвоит уже её, а не
    // оригинал, и повторять можно сколько угодно.
    from: from + copy.length,
    to: to + copy.length,
  };
}

/// Передвинуть строки выделения на одну вверх (`-1`) или вниз (`1`).
export function moveLines(
  text: string,
  from: number,
  to: number,
  step: -1 | 1,
): Edit {
  const [start, end] = touched(text, from, to);
  if (step < 0) {
    if (start === 0) {
      return { text, from, to };
    }
    const above = lineStart(text, start - 1);
    const body = text.slice(start, end);
    const previous = text.slice(above, start - 1);
    const changed = body + "\n" + previous;
    const shift = start - above;
    return {
      text: text.slice(0, above) + changed + text.slice(end),
      from: from - shift,
      to: to - shift,
    };
  }
  if (end >= text.length) {
    return { text, from, to };
  }
  const below = lineEnd(text, end + 1);
  const body = text.slice(start, end);
  const next = text.slice(end + 1, below);
  const changed = next + "\n" + body;
  const shift = below - end;
  return {
    text: text.slice(0, start) + changed + text.slice(below),
    from: from + shift,
    to: to + shift,
  };
}

export function deleteLines(text: string, from: number, to: number): Edit {
  const [start, end] = touched(text, from, to);
  // Забираем и перевод строки — иначе от удалённой строки остаётся пустая.
  const stop = end < text.length ? end + 1 : end;
  // У последней строки перевода за ней нет: тогда забираем тот, что перед ней.
  const at = stop === end && start > 0 ? start - 1 : start;
  return {
    text: text.slice(0, at) + text.slice(stop),
    from: at,
    to: at,
  };
}
