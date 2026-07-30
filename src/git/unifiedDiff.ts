// Разбор unified diff для отрисовки: построчная модель, парная раскладка по
// колонкам «было / стало» и счётчики. Чистые функции без обращений к бэкенду.

import type { GitChangesSummary } from "./gitChanges";

export type DiffLine = {
  kind: "add" | "del" | "context" | "hunk";
  oldLine?: number;
  newLine?: number;
  text: string;
};

const HUNK_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const hunk = HUNK_PATTERN.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      result.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) {
      continue; // заголовки diff --git / index / +++ / --- не рисуем
    }
    if (raw.startsWith("+")) {
      result.push({ kind: "add", newLine: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      result.push({ kind: "del", oldLine: oldLine++, text: raw.slice(1) });
    } else if (raw.startsWith(" ") || raw === "") {
      if (raw === "" && result.length === 0) {
        continue;
      }
      result.push({
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        text: raw.slice(1),
      });
    }
    // "\ No newline at end of file" и прочую служебщину пропускаем.
  }
  // Хвостовая пустая строка от split("\n") — не строка контекста.
  const lastLine = result[result.length - 1];
  if (lastLine?.kind === "context" && lastLine.text === "") {
    result.pop();
  }
  return result;
}

// ---------- Две колонки: было / стало ----------

export type DiffRow = {
  // Отсутствующая сторона — это вставка или удаление: там пусто.
  left?: DiffLine;
  right?: DiffLine;
  // Разрыв между ханками: строк нет ни слева, ни справа.
  isGap?: boolean;
};

// В unified diff изменение идёт блоком: сначала все удалённые строки, потом все
// добавленные. Для двух колонок их надо поставить друг напротив друга, а хвост
// более длинной стороны — напротив пустоты.
export function pairDiffLines(lines: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.kind === "hunk") {
      // Первый @@ — это начало файла, а не разрыв в нём.
      if (rows.length > 0) {
        rows.push({ isGap: true });
      }
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const removed: DiffLine[] = [];
    while (lines[index]?.kind === "del") {
      removed.push(lines[index]);
      index += 1;
    }
    const added: DiffLine[] = [];
    while (lines[index]?.kind === "add") {
      added.push(lines[index]);
      index += 1;
    }
    for (let step = 0; step < Math.max(removed.length, added.length); step += 1) {
      rows.push({ left: removed[step], right: added[step] });
    }
  }
  return rows;
}

// Изменившийся кусок внутри пары строк: общее начало и общий хвост остаются
// нетронутыми, подсвечивается только середина. Точного словарного сравнения
// это не заменяет, но покрывает обычную правку — переименование, другое число,
// добавленный аргумент.
export function changedRange(
  before: string,
  after: string,
): { head: number; beforeTail: number; afterTail: number } | null {
  if (before === after) {
    return null;
  }
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  return {
    head,
    beforeTail: before.length - tail,
    afterTail: after.length - tail,
  };
}

// Суммарные счётчики для бейджа в титлбаре.
export function aggregateCounts(summary: GitChangesSummary | null): {
  additions: number;
  deletions: number;
  files: number;
} {
  if (!summary) {
    return { additions: 0, deletions: 0, files: 0 };
  }
  let additions = 0;
  let deletions = 0;
  for (const file of summary.files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { additions, deletions, files: summary.files.length };
}
