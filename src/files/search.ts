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

/// Все вхождения, без оглядки на регистр: ищут обычно на память, а помнят
/// слово, а не то, какой буквой оно записано.
export function findAll(text: string, query: string): Matches {
  if (query === "") {
    return NO_MATCHES;
  }
  const lowered = text.toLowerCase();
  // Есть буквы, у которых строчная форма длиннее прописной — турецкая «İ»,
  // немецкая «ẞ». От них смещения в приведённом тексте разъезжаются с
  // настоящими, и подсветка встала бы не на те буквы. В таком файле ищем как
  // написано: это реже, чем ошибка на весь файл.
  const haystack = lowered.length === text.length ? lowered : text;
  const needle = haystack === text ? query : query.toLowerCase();
  const at: number[] = [];
  let from = 0;
  for (;;) {
    const found = haystack.indexOf(needle, from);
    if (found === -1) {
      break;
    }
    if (at.length >= MAX_MATCHES) {
      return { at, length: needle.length, capped: true };
    }
    at.push(found);
    // Следующее ищем за концом найденного: иначе поиск `aa` в `aaaa` дал бы
    // три пересекающихся совпадения, а подсветить их разом нельзя.
    from = found + needle.length;
  }
  return { at, length: needle.length, capped: false };
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
