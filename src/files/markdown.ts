// Разбор Markdown в дерево блоков — для режима просмотра.
//
// Свой разбор, а не библиотека, по той же причине, что и подсветка: нужен не
// весь CommonMark, а то, из чего состоят документы, которые здесь читают, —
// планы, спецификации и README, написанные людьми и агентами. Тысяча строк
// чужого кода ради этого не окупается.
//
// И важнее: разбор отдаёт дерево, а не HTML. Отрисовка собирает из него узлы
// React, и в разметку файла нельзя ничего внедрить — ни скрипт, ни чужой тег.
// Просмотр читает то, что пишет агент, и путь от чужого текста к исполняемому
// коду не должен существовать вовсе.

/// Кусок строки текста.
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "image"; src: string; alt: string };

export type Block =
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "paragraph"; children: Inline[] }
  /// `language` — метка у ограды, как её написали.
  | { kind: "code"; language: string | null; text: string }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: Block[][] }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const FENCE = /^( {0,3})(```+|~~~+)\s*([^`]*)$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^( {0,3})([-*+]|(\d{1,9})[.)])(\s+|$)(.*)$/;
const TABLE_RULE = /^ *\|?(?: *:?-{1,}:? *\|)+ *:?-{1,}:? *\|? *$/;

/// Строка, за которой ничего не следует: конец блока для всех, кроме кода.
function blank(line: string): boolean {
  return line.trim().length === 0;
}

/// Ячейки строки таблицы. Крайние палки необязательны — их пишут по привычке,
/// а не по правилу.
function cells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) {
    text = text.slice(1);
  }
  if (text.endsWith("|") && !text.endsWith("\\|")) {
    text = text.slice(0, -1);
  }
  return text.split("|").map((cell) => cell.trim());
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let at = 0;

  const paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({
        kind: "paragraph",
        children: parseInline(paragraph.join("\n")),
      });
      paragraph.length = 0;
    }
  };

  while (at < lines.length) {
    const line = lines[at];

    if (blank(line)) {
      flush();
      at += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const [, indent, mark, info] = fence;
      const body: string[] = [];
      at += 1;
      while (at < lines.length) {
        const inside = lines[at];
        if (inside.trimStart().startsWith(mark[0].repeat(mark.length))) {
          at += 1;
          break;
        }
        // Отступ ограды снимается со всего блока: внутри списка код лежит
        // сдвинутым, и сохранять этот сдвиг значит показывать его читателю.
        body.push(inside.startsWith(indent) ? inside.slice(indent.length) : inside);
        at += 1;
      }
      blocks.push({
        kind: "code",
        language: info.trim() || null,
        text: body.join("\n"),
      });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        children: parseInline(heading[2] ?? ""),
      });
      at += 1;
      continue;
    }

    // Черта проверяется раньше списка: `---` подходит и под то, и под другое.
    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      at += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const inner: string[] = [];
      while (at < lines.length) {
        const quoted = QUOTE.exec(lines[at]);
        if (quoted) {
          inner.push(quoted[1]);
          at += 1;
          continue;
        }
        // Продолжение цитаты без знака: строка сразу под ней, не пустая.
        if (!blank(lines[at]) && inner.length > 0 && !HEADING.test(lines[at])) {
          inner.push(lines[at]);
          at += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(inner) });
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      flush();
      at = parseList(lines, at, blocks);
      continue;
    }

    if (at + 1 < lines.length && TABLE_RULE.test(lines[at + 1]) && line.includes("|")) {
      flush();
      const head = cells(line).map(parseInline);
      at += 2;
      const rows: Inline[][][] = [];
      while (at < lines.length && !blank(lines[at]) && lines[at].includes("|")) {
        rows.push(cells(lines[at]).map(parseInline));
        at += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    paragraph.push(line);
    at += 1;
  }

  flush();
  return blocks;
}

/// Один список целиком: пункты подряд, у каждого своё содержимое.
///
/// Содержимое пункта разбирается заново, тем же разбором: вложенный список,
/// абзац и блок кода внутри пункта — это те же блоки, и знать о них здесь
/// отдельно незачем.
function parseList(lines: string[], from: number, blocks: Block[]): number {
  const first = BULLET.exec(lines[from]);
  if (!first) {
    return from + 1;
  }
  const ordered = first[3] !== undefined;
  const start = ordered ? Number(first[3]) : 1;
  const items: Block[][] = [];
  let at = from;

  while (at < lines.length) {
    const bullet = BULLET.exec(lines[at]);
    if (!bullet) {
      break;
    }
    // Другой вид маркера — другой список; иначе перечисление и нумерация
    // слились бы в одно.
    if ((bullet[3] !== undefined) !== ordered) {
      break;
    }
    // Колонка, с которой начинается содержимое пункта: по ней узнаётся всё,
    // что к нему относится.
    const inner = bullet[1].length + bullet[2].length + bullet[4].length;
    const body = [bullet[5]];
    at += 1;
    while (at < lines.length) {
      const next = lines[at];
      if (blank(next)) {
        // Пустая строка внутри пункта — та, за которой идёт его же
        // продолжение. Иначе список кончился.
        const after = lines[at + 1];
        if (after === undefined || (!after.startsWith(" ".repeat(inner)) && !BULLET.test(after))) {
          break;
        }
        body.push("");
        at += 1;
        continue;
      }
      if (next.startsWith(" ".repeat(inner))) {
        body.push(next.slice(inner));
        at += 1;
        continue;
      }
      break;
    }
    items.push(parseBlocks(body));
  }

  blocks.push({ kind: "list", ordered, start, items });
  return at;
}

/// Знаки, которые слэш перед ними делает обычным текстом. Ровно те, что что-то
/// значат в разметке: экранировать букву или пробел незачем.
const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>";

const LINK = /^(!?)\[([^\]]*)\]\(([^\s)]*)(?:\s+"[^"]*")?\)/;
const AUTOLINK = /^<([a-z][a-z0-9+.-]*:[^>\s]+)>/i;

/// Разбор внутри строки. Порядок правил и есть их приоритет: код первым, чтобы
/// звёздочка внутри вставки осталась звёздочкой.
export function parseInline(source: string): Inline[] {
  const parts: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) {
      parts.push({ kind: "text", text });
      text = "";
    }
  };

  let at = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    const first = source[at];

    if (first === "\\" && ESCAPABLE.includes(source[at + 1] ?? "")) {
      // Экранированный знак разметкой не является — в этом весь смысл слэша
      // перед ним. Перед всем остальным слэш — обычная косая черта: в путях
      // Windows и в регулярных выражениях она стоит сплошь и рядом.
      text += source[at + 1];
      at += 2;
      continue;
    }

    if (first === "`") {
      let ticks = 1;
      while (source[at + ticks] === "`") {
        ticks += 1;
      }
      const mark = "`".repeat(ticks);
      const close = source.indexOf(mark, at + ticks);
      if (close !== -1) {
        flush();
        parts.push({ kind: "code", text: source.slice(at + ticks, close) });
        at = close + ticks;
        continue;
      }
    }

    const link = LINK.exec(rest);
    if (link) {
      flush();
      const [whole, bang, label, href] = link;
      parts.push(
        bang
          ? { kind: "image", src: href, alt: label }
          : { kind: "link", href, children: parseInline(label) },
      );
      at += whole.length;
      continue;
    }

    const auto = AUTOLINK.exec(rest);
    if (auto) {
      flush();
      parts.push({
        kind: "link",
        href: auto[1],
        children: [{ kind: "text", text: auto[1] }],
      });
      at += auto[0].length;
      continue;
    }

    const wrapped =
      paired(rest, "**", "strong") ??
      paired(rest, "__", "strong") ??
      paired(rest, "~~", "strike") ??
      paired(rest, "*", "em") ??
      paired(rest, "_", "em");
    if (wrapped) {
      flush();
      parts.push(wrapped.node);
      at += wrapped.length;
      continue;
    }

    text += first;
    at += 1;
  }

  flush();
  return parts;
}

/// Пара одинаковых знаков вокруг текста. `null`, если пары нет: одиночная
/// звёздочка — обычный знак, а не начало выделения до конца абзаца.
function paired(
  source: string,
  mark: string,
  kind: "strong" | "em" | "strike",
): { node: Inline; length: number } | null {
  if (!source.startsWith(mark)) {
    return null;
  }
  const close = source.indexOf(mark, mark.length);
  if (close <= mark.length) {
    return null;
  }
  return {
    node: {
      kind,
      children: parseInline(source.slice(mark.length, close)),
    } as Inline,
    length: close + mark.length,
  };
}
