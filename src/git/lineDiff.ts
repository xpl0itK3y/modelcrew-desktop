// Какие строки открытого файла отличаются от закоммиченных.
//
// Считаем здесь, а не спрашиваем `git diff`, ради одного свойства: метки
// обязаны быть верны для того текста, который в поле ввода прямо сейчас. Файл
// правит агент в соседней панели и человек в самом редакторе, и обе правки
// живут до сохранения; ответ git относился бы к тому, что лежит на диске, и
// после первой же набранной строки все метки ниже сползли бы на одну.
//
// Разбор — Майерс: тот же алгоритм, которым считает сам git. Он ищет кратчайший
// путь правок, и стоит O(N·D) — где D это число самих правок. Обычная правка
// мала, а перед разбором ещё отрезается общее начало и общий конец, так что до
// самого алгоритма доходят десятки строк даже в файле на десять тысяч.

/// Что случилось со строкой в открытом файле.
///
/// `removed` стоит на последней уцелевшей строке над пропажей: самих удалённых
/// строк в файле уже нет, и повесить метку больше не на что.
export type LineMark = "added" | "changed" | "removed";

/// Дальше этого не считаем построчно. Такой разрыв — это не правка, а другой
/// файл: перепутанная кодировка, склейка веток, автоформатирование всего
/// разом. Точные метки там ничего не объясняют, а секунда на каждое нажатие
/// клавиши стоит дороже них.
const MAX_SPAN = 4_000;

/// Столько правок ещё имеет смысл искать. Дальше путь всё равно проходит через
/// весь файл, и ответ «здесь всё другое» и честнее, и в тысячу раз дешевле.
const MAX_EDITS = 600;

type Change =
  | { kind: "delete"; line: number }
  | { kind: "insert"; line: number };

/// Кратчайший список правок, превращающих `a` в `b`, или `null`, если их
/// оказалось больше, чем мы согласны искать.
function myers(a: string[], b: string[], budget: number): Change[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(budget, n + m);
  // Диагонали нумеруются от -max до max, и на шаг вперёд заглядывают на одну
  // дальше: место под обе крайние берём с запасом, иначе край массива
  // отвечал бы `undefined` вместо нуля.
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // По снимку на каждый шаг: обратный ход по ним и собирает сам список правок.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // Идём вниз или вправо — туда, откуда путь уже дальше.
      const x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let ax = x;
      let by = x - k;
      // Совпадающие строки проходятся даром: это и есть диагональ.
      while (ax < n && by < m && a[ax] === b[by]) {
        ax += 1;
        by += 1;
      }
      v[offset + k] = ax;
      if (ax >= n && by >= m) {
        return unwind(trace, a.length, b.length, offset);
      }
    }
  }
  return null;
}

/// Обратный ход по снимкам: от конца обоих текстов к началу.
function unwind(
  trace: Int32Array[],
  n: number,
  m: number,
  offset: number,
): Change[] {
  const changes: Change[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const v = trace[d];
    const k = x - y;
    const previous =
      k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? k + 1
        : k - 1;
    const px = v[offset + previous];
    const py = px - previous;
    // Сначала назад по диагонали — по строкам, которые совпали.
    while (x > px && y > py) {
      x -= 1;
      y -= 1;
    }
    if (x > px) {
      changes.push({ kind: "delete", line: x - 1 });
    } else if (y > py) {
      changes.push({ kind: "insert", line: y - 1 });
    }
    x = px;
    y = py;
  }
  changes.reverse();
  return changes;
}

/// Метки по всему куску: строки `b` целиком новые, а `deleted` строк `a` на
/// их месте пропали.
function wholeSpan(
  marks: Map<number, LineMark>,
  from: number,
  count: number,
  deleted: number,
  mark: LineMark,
): void {
  for (let line = from; line < from + count; line += 1) {
    marks.set(line, mark);
  }
  if (count === 0 && deleted > 0) {
    // Вешать метку не на что, кроме соседа сверху; в самом начале файла соседа
    // сверху нет, и её принимает первая строка.
    const line = Math.max(0, from - 1);
    if (!marks.has(line)) {
      marks.set(line, "removed");
    }
  }
}

/**
 * Разряд каждой правленой строки открытого текста; строк без правок в карте
 * нет. Номера строк с нуля.
 *
 * `committed === null` означает, что сравнивать не с чем — файла ещё нет в
 * истории. Тогда новое в нём всё.
 */
export function diffLines(
  committed: string | null,
  current: string,
): Map<number, LineMark> {
  const marks = new Map<number, LineMark>();
  if (committed === current) {
    return marks;
  }
  const b = current.split("\n");
  if (committed === null) {
    wholeSpan(marks, 0, b.length, 0, "added");
    return marks;
  }
  const a = committed.split("\n");

  // Общее начало и общий конец разбирать незачем — и не на что: правка на
  // тысячной строке оставляет после этого десяток строк с каждой стороны.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const left = a.slice(head, a.length - tail);
  const right = b.slice(head, b.length - tail);

  if (left.length === 0) {
    wholeSpan(marks, head, right.length, 0, "added");
    return marks;
  }
  if (right.length === 0) {
    wholeSpan(marks, head, 0, left.length, "changed");
    return marks;
  }
  if (left.length + right.length > MAX_SPAN) {
    wholeSpan(marks, head, right.length, left.length, "changed");
    return marks;
  }

  const changes = myers(left, right, MAX_EDITS);
  if (!changes) {
    wholeSpan(marks, head, right.length, left.length, "changed");
    return marks;
  }

  const deleted = new Set<number>();
  const inserted = new Set<number>();
  for (const change of changes) {
    (change.kind === "delete" ? deleted : inserted).add(change.line);
  }

  // Идём по обоим текстам разом. Правки, стоящие вплотную, — это один кусок:
  // строка, которую переписали, приходит парой «убрали, добавили», и показывать
  // её как две разные правки значило бы врать про то, что произошло.
  let ai = 0;
  let bi = 0;
  while (ai < left.length || bi < right.length) {
    const editing =
      (ai < left.length && deleted.has(ai)) ||
      (bi < right.length && inserted.has(bi));
    if (!editing) {
      ai += 1;
      bi += 1;
      continue;
    }
    const from = bi;
    let gone = 0;
    while (ai < left.length && deleted.has(ai)) {
      ai += 1;
      gone += 1;
    }
    while (bi < right.length && inserted.has(bi)) {
      bi += 1;
    }
    const born = bi - from;
    wholeSpan(
      marks,
      head + from,
      born,
      gone,
      gone > 0 && born > 0 ? "changed" : "added",
    );
  }
  return marks;
}
