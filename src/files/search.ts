// Поиск по открытому файлу.
//
// Своими руками, а не регулярным выражением: то, что ищут в коде, сплошь
// состоит из знаков, которые в выражении что-то значат — `[0]`, `a.b`,
// `\n`, — и экранировать их пришлось бы на каждое нажатие в поле поиска.

/// Больше этого числа совпадений не ищем. Слой подсветки рисует по элементу на
/// совпадение, и запрос из одной буквы на большом файле — это десятки тысяч
/// элементов и остановившееся окно. Счётчик при этом честно скажет, что
/// показано не всё.
export const MAX_MATCHES = 2000;

export type Matches = {
  /// Начала совпадений, по возрастанию.
  at: number[];
  length: number;
  /// Совпадений оказалось больше, чем мы взялись показывать.
  capped: boolean;
};

export const NO_MATCHES: Matches = { at: [], length: 0, capped: false };

/// Как искать. Без оглядки на регистр и в любом месте слова — так ищут
/// обычно: на память, а помнят слово, а не то, какой буквой оно записано.
/// Строгость нужна замене: `value` → `amount` без неё заодно превращает
/// `setValue` в `setamount`, и код ломается там, куда не смотрели.
export type FindOptions = {
  /// Строчная и прописная — разные буквы.
  matchCase: boolean;
  /// Только отдельное слово: `value` не находится в `setValue` и `value2`.
  wholeWord: boolean;
};

export const LOOSE: FindOptions = { matchCase: false, wholeWord: false };

/// Где и что искать без оглядки на регистр.
function caseless(text: string, query: string): { haystack: string; needle: string } {
  const lowered = text.toLowerCase();
  // Есть буквы, у которых строчная форма длиннее прописной — турецкая «İ»,
  // немецкая «ẞ». От них смещения в приведённом тексте разъезжаются с
  // настоящими, и подсветка встала бы не на те буквы. В таком файле ищем как
  // написано: это реже, чем ошибка на весь файл.
  const haystack = lowered.length === text.length ? lowered : text;
  const needle = haystack === text ? query : query.toLowerCase();
  return { haystack, needle };
}

// Знак слова — буква, цифра, подчёркивание и то, что пишется поверх буквы.
// По два знака с краю, а не по одному: буква за пределами основной плоскости
// записана парой, и половинка пары буквой не считается.
const WORD_START = /^[\p{L}\p{M}\p{N}_]/u;
const WORD_END = /[\p{L}\p{M}\p{N}_]$/u;

/// Совпадение стоит отдельным словом: с каждого края либо граница текста,
/// либо не-буква — по ту сторону или в самом совпадении. Последнее нужно,
/// чтобы `.map` находился в `list.map(` при поиске целых слов: граница там
/// проходит внутри запроса, а не снаружи.
function standsAlone(text: string, at: number, end: number): boolean {
  const left =
    !WORD_START.test(text.slice(at, at + 2)) ||
    !WORD_END.test(text.slice(Math.max(0, at - 2), at));
  const right =
    !WORD_END.test(text.slice(Math.max(at, end - 2), end)) ||
    !WORD_START.test(text.slice(end, end + 2));
  return left && right;
}

/// Где и что искать при этих настройках. Считается один раз на поиск: весь
/// текст, приведённый к строчным, — не та работа, что стоит делать дважды на
/// каждую букву запроса.
function target(
  text: string,
  query: string,
  options: FindOptions,
): { haystack: string; needle: string } {
  return options.matchCase ? { haystack: text, needle: query } : caseless(text, query);
}

/// Вхождения запроса слева направо, без пересечений: поиск `aa` в `aaaa` даёт
/// два, а не три — подсветить пересекающиеся разом нельзя, а заменить и
/// подавно.
function* occurrences(
  text: string,
  { haystack, needle }: { haystack: string; needle: string },
  wholeWord: boolean,
): Generator<number, void, undefined> {
  let from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) {
      return;
    }
    if (wholeWord && !standsAlone(text, found, found + needle.length)) {
      // Внутри чужого слова — ищем дальше со следующего знака: целое слово
      // может начаться и внутри только что отвергнутого куска.
      from = found + 1;
      continue;
    }
    yield found;
    from = found + needle.length;
  }
}

export function findAll(
  text: string,
  query: string,
  options: FindOptions = LOOSE,
): Matches {
  if (query === "") {
    return NO_MATCHES;
  }
  const sought = target(text, query, options);
  const length = sought.needle.length;
  const at: number[] = [];
  for (const found of occurrences(text, sought, options.wholeWord)) {
    if (at.length >= MAX_MATCHES) {
      return { at, length, capped: true };
    }
    at.push(found);
  }
  return { at, length, capped: false };
}

/// Номер строки, в которой стоит смещение. Двоичным поиском по началам строк:
/// у файла в двадцать тысяч строк перебор — двадцать тысяч сравнений на каждое
/// нажатие.
export function lineAt(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= position) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/// Какое совпадение показать после того, как текст или запрос сменились: то,
/// что ближе всего к прежнему месту. Иначе поиск на каждую букву прыгал бы в
/// начало файла, а читают-то с того места, где стоят.
export function nearest(matches: number[], position: number): number {
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index] >= position) {
      return index;
    }
  }
  return 0;
}

/// К какому совпадению идти от курсора: вперёд — к первому, что начинается за
/// выделением, назад — к последнему, что начинается до него. От курсора, а не
/// от счётчика: ⌘G жмут в самом файле, и курсор там мог уйти от совпадения,
/// показанного последним, куда угодно.
export function stepFrom(
  matches: number[],
  from: number,
  to: number,
  delta: 1 | -1,
): number {
  if (delta > 0) {
    const ahead = matches.findIndex((start) => start >= to);
    return ahead === -1 ? 0 : ahead;
  }
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (matches[index] < from) {
      return index;
    }
  }
  return matches.length - 1;
}

export type Replaced = {
  text: string;
  /// Сколько замен сделано.
  count: number;
  /// Где стоит первая из них: туда встаёт курсор.
  first: number;
};

/// Заменить все вхождения — все, а не те, что показаны: предел на число
/// совпадений нужен слою подсветки, а замене рисовать нечего.
export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  options: FindOptions = LOOSE,
): Replaced {
  if (query === "") {
    return { text, count: 0, first: 0 };
  }
  const sought = target(text, query, options);
  const length = sought.needle.length;
  const parts: string[] = [];
  let count = 0;
  let first = 0;
  let from = 0;
  for (const found of occurrences(text, sought, options.wholeWord)) {
    if (count === 0) {
      first = found;
    }
    count += 1;
    parts.push(text.slice(from, found), replacement);
    from = found + length;
  }
  if (count === 0) {
    return { text, count: 0, first: 0 };
  }
  parts.push(text.slice(from));
  return { text: parts.join(""), count, first };
}

/// Куда ведёт «перейти к строке»: «12» — в начало двенадцатой строки, «12:5» —
/// к её пятому знаку. Номер за концом файла ведёт на последнюю строку, столбец
/// за концом строки — в её конец: номер обычно списан из сообщения об ошибке, и
/// промахнуться на единицу — не повод не идти никуда. `null` — набрано не число.
export function lineTarget(
  query: string,
  offsets: number[],
  length: number,
): number | null {
  const match = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(query);
  if (!match || offsets.length === 0) {
    return null;
  }
  const line = Math.min(Math.max(Number(match[1]), 1), offsets.length) - 1;
  const start = offsets[line];
  const end = line + 1 < offsets.length ? offsets[line + 1] - 1 : length;
  const column = match[2] === undefined ? 1 : Math.max(Number(match[2]), 1);
  return Math.min(start + column - 1, end);
}
