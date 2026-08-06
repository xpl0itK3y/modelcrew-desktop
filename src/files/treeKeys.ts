// Куда переходит выделение в дереве по нажатию клавиши.
//
// Правила отдельно от React нарочно: их семь штук, они переплетены (стрелка
// влево делает разное на раскрытой папке и на файле), и проверять их удобнее
// на списке строк, а не через отрисованное дерево.

export type KeyRow = { path: string; isDir: boolean; depth: number };

export type TreeAction =
  | { kind: "move"; path: string }
  | { kind: "expand"; path: string }
  | { kind: "collapse"; path: string }
  | { kind: "open"; path: string }
  | { kind: "delete"; path: string }
  | null;

export function treeKeyAction(
  key: string,
  rows: KeyRow[],
  focused: string | null,
  expanded: Set<string>,
): TreeAction {
  if (rows.length === 0) {
    return null;
  }
  const at = rows.findIndex((row) => row.path === focused);
  const row = at === -1 ? null : rows[at];

  switch (key) {
    case "ArrowDown":
      // Выделения ещё нет — первая же стрелка ставит его на первую строку, а
      // не проваливает нажатие впустую.
      return { kind: "move", path: rows[Math.min(at + 1, rows.length - 1)].path };
    case "ArrowUp":
      return { kind: "move", path: rows[Math.max(at - 1, 0)].path };
    case "Home":
      return { kind: "move", path: rows[0].path };
    case "End":
      return { kind: "move", path: rows[rows.length - 1].path };
    case "ArrowRight": {
      if (!row?.isDir) {
        return null;
      }
      // Закрытая папка раскрывается, раскрытая — пропускает внутрь. Так
      // одной клавишей проходят вглубь, не переключаясь на стрелку вниз.
      if (!expanded.has(row.path)) {
        return { kind: "expand", path: row.path };
      }
      const child = rows[at + 1];
      return child && child.depth > row.depth
        ? { kind: "move", path: child.path }
        : null;
    }
    case "ArrowLeft": {
      if (!row) {
        return null;
      }
      if (row.isDir && expanded.has(row.path)) {
        return { kind: "collapse", path: row.path };
      }
      // Иначе выходим к родителю: ближайшая строка выше с меньшей глубиной.
      for (let index = at - 1; index >= 0; index -= 1) {
        if (rows[index].depth < row.depth) {
          return { kind: "move", path: rows[index].path };
        }
      }
      return null;
    }
    case "Enter":
    case " ":
      return row ? { kind: "open", path: row.path } : null;
    case "Delete":
    case "Backspace":
      // Спрашивать будет тот, кто это выполняет: клавиша лишь называет цель.
      // Backspace — привычка Finder-а, Delete — всего остального.
      return row ? { kind: "delete", path: row.path } : null;
    default:
      return null;
  }
}
