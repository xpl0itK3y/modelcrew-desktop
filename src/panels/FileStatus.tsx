// Строка под файлом: где курсор, сколько выделено, чем набран файл.
//
// Курсор следит за полем сам, а не через состояние вида: стрелку нажимают
// чаще, чем букву, и перерисовывать ради номера столбца весь слой подсветки —
// тысячи элементов на каждое нажатие — незачем. Меняется только эта строка.

import { useEffect, useState, type RefObject } from "react";
import { useI18n } from "../i18n";
import { lineAt } from "../files/search";
import type { LineEnding } from "../files/lineEndings";

type Caret = {
  /// Где стоит курсор — подвижный конец выделения.
  head: number;
  /// Сколько знаков выделено.
  selected: number;
};

const START: Caret = { head: 0, selected: 0 };

export function FileStatus(props: {
  field: RefObject<HTMLTextAreaElement | null>;
  /// Начала строк текста, который сейчас в поле.
  offsets: number[];
  unit: string;
  ending: LineEnding;
  goToLabel: string;
  onGoToLine: () => void;
}) {
  const { t } = useI18n();
  const { field } = props;
  const [caret, setCaret] = useState<Caret>(START);

  useEffect(() => {
    const element = field.current;
    if (!element) {
      return;
    }
    const read = () => {
      const from = element.selectionStart;
      const to = element.selectionEnd;
      // Выделение, протянутое назад, кончается в начале: курсор стоит там.
      const head = element.selectionDirection === "backward" ? from : to;
      const selected = to - from;
      setCaret((was) =>
        was.head === head && was.selected === selected ? was : { head, selected },
      );
    };
    read();
    // `selectionchange` у документа приходит не везде и не на всё, что
    // двигает курсор в поле: события самого поля закрывают остальное.
    const own = ["select", "input", "keyup", "mouseup", "focus"] as const;
    for (const name of own) {
      element.addEventListener(name, read);
    }
    const onDocument = () => {
      if (document.activeElement === element) {
        read();
      }
    };
    document.addEventListener("selectionchange", onDocument);
    return () => {
      for (const name of own) {
        element.removeEventListener(name, read);
      }
      document.removeEventListener("selectionchange", onDocument);
    };
  }, [field]);

  const line = lineAt(props.offsets, caret.head);
  const column = caret.head - (props.offsets[line] ?? 0) + 1;

  return (
    <div className="file-view-status">
      <button
        type="button"
        className="file-view-caret"
        title={props.goToLabel}
        onClick={props.onGoToLine}
      >
        {t("files.caret", { line: String(line + 1), column: String(column) })}
        {caret.selected > 0 && (
          <span className="file-view-selected">
            {t("files.selected", { count: String(caret.selected) })}
          </span>
        )}
      </button>
      <span className="file-view-status-fact">
        {props.unit === "\t"
          ? t("files.indentTabs")
          : t("files.indentSpaces", { width: String(props.unit.length) })}
      </span>
      <span className="file-view-status-fact">
        {props.ending === "\r\n" ? "CRLF" : "LF"}
      </span>
    </div>
  );
}
