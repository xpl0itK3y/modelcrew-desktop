// Консоль под страницей проекта — как в инструментах разработчика, только
// проще: сообщения по уровням, фильтр и «очистить».
//
// Пишет сюда чужая страница. Поэтому текст только текстом: ни разметки, ни
// ссылок, ни цветов из `%c` — их запись срезала ещё в самой странице.

import { useLayoutEffect, useRef, useState } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { ClearIcon } from "../ui/Icons";
import {
  kindOf,
  matches,
  type ConsoleFilter,
  type NumberedEntry,
} from "./pageConsole";

const FILTERS: readonly { filter: ConsoleFilter; label: MessageKey }[] = [
  { filter: "all", label: "browser.consoleAll" },
  { filter: "error", label: "browser.consoleErrorsOnly" },
  { filter: "warning", label: "browser.consoleWarningsOnly" },
  { filter: "log", label: "browser.consoleLogsOnly" },
];

// То, чего страница сама не писала, помечено словом: иначе исключение не
// отличить от console.error с тем же текстом.
const TAGS: Partial<Record<string, MessageKey>> = {
  exception: "browser.consoleException",
  rejection: "browser.consoleRejection",
  resource: "browser.consoleResource",
};

// Насколько можно не дотянуть до низа и всё ещё считаться внизу.
const BOTTOM_SLACK_PX = 16;

export function PageConsolePanel(props: {
  entries: readonly NumberedEntry[];
  // Сколько сообщений вытеснено, не дойдя до экрана.
  lost: number;
  running: boolean;
  // Почему консоль не прочитать. Записанное раньше остаётся на месте.
  trouble: string | null;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<ConsoleFilter>("all");
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  // Человек внизу — новое подтягиваем. Ушёл наверх читать — не дёргаем.
  const atBottom = useRef(true);

  const shown = props.entries.filter((entry) => matches(entry, filter, search));
  const last = shown.length > 0 ? shown[shown.length - 1].index : -1;

  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && atBottom.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [last, props.lost, props.trouble]);

  const empty = !props.running
    ? t("browser.consoleNotRunning")
    : props.entries.length === 0
      ? t("browser.consoleEmpty")
      : shown.length === 0
        ? t("browser.consoleNoMatch")
        : null;

  return (
    <section className="browser-console" aria-label={t("browser.console")}>
      <div className="browser-console-bar">
        <div
          className="browser-console-filters"
          role="group"
          aria-label={t("browser.consoleLevels")}
        >
          {FILTERS.map((option) => (
            <button
              key={option.filter}
              type="button"
              className="browser-console-filter"
              aria-pressed={filter === option.filter}
              onClick={() => setFilter(option.filter)}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="browser-console-search"
          value={search}
          spellCheck={false}
          placeholder={t("browser.consoleSearch")}
          aria-label={t("browser.consoleSearch")}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className="icon-button"
          title={t("browser.consoleClear")}
          aria-label={t("browser.consoleClear")}
          onClick={props.onClear}
        >
          <ClearIcon />
        </button>
      </div>
      <div
        className="browser-console-list"
        ref={listRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          atBottom.current =
            list.scrollHeight - list.scrollTop - list.clientHeight <
            BOTTOM_SLACK_PX;
        }}
      >
        {props.trouble && (
          <p className="browser-console-note" role="status">
            {props.trouble}
          </p>
        )}
        {props.lost > 0 && (
          <p className="browser-console-note">
            {t("browser.consoleLost", { count: props.lost })}
          </p>
        )}
        {shown.map((entry) => {
          const tag = TAGS[entry.level];
          return (
            <div
              key={entry.index}
              className={`browser-console-entry is-${kindOf(entry.level)}`}
            >
              {tag && <span className="browser-console-tag">{t(tag)}</span>}
              <span className="browser-console-text">{entry.text}</span>
            </div>
          );
        })}
        {empty && <p className="browser-console-empty">{empty}</p>}
      </div>
    </section>
  );
}
