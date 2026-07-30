// Показ diff-а: одна раскладка на все места, где он появляется — карточка
// файла, коммит, сравнение состояний. Раскладка (сплит или единый список)
// запоминается, поэтому выбор живёт здесь же.

import { useMemo } from "react";
import { useI18n } from "../../i18n";
import {
  changedRange,
  pairDiffLines,
  parseUnifiedDiff,
  type DiffLine,
  type GitFileDiff,
} from "../../git/gitChanges";

// ---------- Просмотр diff-а только для чтения ----------

// «Одна колонка» — привычный unified diff; «две» показывают было и стало рядом.
// Выбор общий для истории и сравнения и живёт между запусками, как остальные
// настройки.
export type DiffView = "unified" | "split";

const DIFF_VIEW_KEY = "modelcrew.diffView";

export function loadDiffView(): DiffView {
  try {
    return localStorage.getItem(DIFF_VIEW_KEY) === "unified"
      ? "unified"
      : "split";
  } catch {
    return "split";
  }
}

export function saveDiffView(view: DiffView): void {
  try {
    localStorage.setItem(DIFF_VIEW_KEY, view);
  } catch {
    // Не сохранилось — выбор просто не доедет до следующего запуска.
  }
}

export function DiffViewToggle(props: {
  view: DiffView;
  onChange: (view: DiffView) => void;
}) {
  const { t } = useI18n();
  const next: DiffView = props.view === "split" ? "unified" : "split";
  const label = t(next === "split" ? "git.diffSplit" : "git.diffUnified");
  return (
    <button
      type="button"
      className="git-diff-view-toggle"
      title={label}
      aria-label={label}
      onClick={() => props.onChange(next)}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
        <rect
          x="1.5"
          y="2.5"
          width="13"
          height="11"
          rx="2"
          fill="none"
          stroke="currentColor"
        />
        {next === "split" ? (
          <line x1="8" y1="2.5" x2="8" y2="13.5" stroke="currentColor" />
        ) : (
          <>
            <line x1="4" y1="6.5" x2="12" y2="6.5" stroke="currentColor" />
            <line x1="4" y1="9.5" x2="12" y2="9.5" stroke="currentColor" />
          </>
        )}
      </svg>
    </button>
  );
}

// Текст строки с подсветкой изменившегося куска. Общее начало и хвост остаются
// обычными — глаз сразу находит, что именно поправили.
export function DiffText(props: {
  text: string;
  pair: { before: string; after: string } | null;
  side: "left" | "right";
}) {
  const range = props.pair
    ? changedRange(props.pair.before, props.pair.after)
    : null;
  const end = range
    ? props.side === "left"
      ? range.beforeTail
      : range.afterTail
    : 0;
  // Пустая подсветка бывает у чистой вставки: на старой стороне выделять нечего.
  if (!range || end === range.head) {
    return <span className="git-diff-text">{props.text}</span>;
  }
  return (
    <span className="git-diff-text">
      {props.text.slice(0, range.head)}
      <mark className="git-diff-mark">{props.text.slice(range.head, end)}</mark>
      {props.text.slice(end)}
    </span>
  );
}

export function SplitDiff(props: { lines: readonly DiffLine[] }) {
  const rows = useMemo(() => pairDiffLines(props.lines), [props.lines]);
  return (
    <div className="git-diff is-split" role="table">
      <div className="git-diff-body">
        {rows.map((row, index) => {
          if (row.isGap) {
            return <div key={index} className="git-diff-gap" aria-hidden="true" />;
          }
          // Подсвечиваем внутренности только там, где строку правили: у пары
          // «удалено/добавлено». Вставке и удалению сравнивать не с чем.
          const pair =
            row.left?.kind === "del" && row.right?.kind === "add"
              ? { before: row.left.text, after: row.right.text }
              : null;
          return (
            <div key={index} className="git-diff-row">
              <div
                className={`git-diff-half ${
                  row.left ? `is-${row.left.kind}` : "is-empty"
                }`}
              >
                <span className="git-diff-gutter">{row.left?.oldLine ?? ""}</span>
                {row.left && (
                  <DiffText text={row.left.text} pair={pair} side="left" />
                )}
              </div>
              <div
                className={`git-diff-half ${
                  row.right ? `is-${row.right.kind}` : "is-empty"
                }`}
              >
                <span className="git-diff-gutter">
                  {row.right?.newLine ?? ""}
                </span>
                {row.right && (
                  <DiffText text={row.right.text} pair={pair} side="right" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function UnifiedDiff(props: { lines: readonly DiffLine[] }) {
  return (
    <div className="git-diff" role="table">
      <div className="git-diff-body">
        {props.lines.map((line, index) =>
          line.kind === "hunk" ? (
            index === 0 ? null : (
              <div key={index} className="git-diff-gap" aria-hidden="true" />
            )
          ) : (
            <div key={index} className={`git-diff-line is-${line.kind}`}>
              <span className="git-diff-sign" aria-hidden="true">
                {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
              </span>
              <span className="git-diff-text">{line.text}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

// Общее тело для истории и сравнения: разные источники, одна отрисовка.
export function DiffBody(props: {
  diff: GitFileDiff | null;
  failed: boolean;
  view: DiffView;
}) {
  const { t } = useI18n();
  const lines = useMemo(
    () => (props.diff ? parseUnifiedDiff(props.diff.diff) : []),
    [props.diff],
  );
  if (props.failed) {
    return <div className="git-diff-note">{t("git.diffUnavailable")}</div>;
  }
  if (!props.diff) {
    return <div className="git-diff-note">{t("git.diffLoading")}</div>;
  }
  if (props.diff.isBinary) {
    return <div className="git-diff-note">{t("git.binaryFile")}</div>;
  }
  return (
    <>
      {props.view === "split" ? (
        <SplitDiff lines={lines} />
      ) : (
        <UnifiedDiff lines={lines} />
      )}
      {props.diff.truncated && (
        <div className="git-diff-note">{t("git.diffTruncated")}</div>
      )}
    </>
  );
}
