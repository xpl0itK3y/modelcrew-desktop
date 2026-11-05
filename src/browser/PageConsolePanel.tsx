// Консоль под страницей проекта — как в инструментах разработчика, только
// проще: сообщения по уровням, фильтр и «очистить». Сообщение в списке —
// первой строкой; по щелчку оно раскрывается целиком, со стеком, местом,
// временем и кнопкой «скопировать».
//
// Пишет сюда чужая страница. Поэтому текст только текстом: ни разметки, ни
// ссылок, ни цветов из `%c` — их запись срезала ещё в самой странице.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n, type MessageKey } from "../i18n";
import {
  KEYS,
  readSetting,
  removeSetting,
  writeSetting,
} from "../settings/storage";
import {
  ChevronRightIcon,
  ClearIcon,
  ErrorIcon,
  WarningIcon,
} from "../ui/Icons";
import { ResizeHandle } from "../ui/ResizeHandle";
import {
  clockTime,
  entryReport,
  kindOf,
  matches,
  shortPlace,
  sourceOf,
  timesOf,
  type ConsoleEntry,
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
  csp: "browser.consoleCsp",
  trace: "browser.consoleTrace",
};

// Чьё сообщение, если не самой страницы. Ошибка виджета оплаты в рамке —
// не ошибка страницы, и человеку это видно сразу.
const SOURCES: Record<"frame" | "worker", MessageKey> = {
  frame: "browser.consoleFrame",
  worker: "browser.consoleWorker",
};

// Насколько можно не дотянуть до низа и всё ещё считаться внизу.
const BOTTOM_SLACK_PX = 16;

// Ниже строки фильтров и пары сообщений консоль уже ничего не показывает.
const MIN_HEIGHT_PX = 96;
// Сколько высоты ящика консоль оставляет странице вместе с адресной строкой
// и строкой внизу: потянули до упора — страница всё равно видна.
const PAGE_KEEPS_PX = 200;

/**
 * Высота, пока её не тянули: та же, что в стилях, — треть ящика, но не
 * меньше и не больше разумного.
 */
function usualHeight(room: number): number {
  return Math.min(360, Math.max(140, room * 0.36));
}

/** Высота в границах ящика. Ящик ещё не измерен — верхней границы нет. */
function fitHeight(wanted: number, room: number): number {
  const most = room > 0 ? room - PAGE_KEEPS_PX : Number.POSITIVE_INFINITY;
  return Math.round(Math.max(MIN_HEIGHT_PX, Math.min(wanted, most)));
}

function loadHeight(): number | null {
  const stored = Number(readSetting(KEYS.browserConsoleHeight));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

/**
 * Подпись справа, как в инспекторе: место в коде — файл и строка, — а если
 * написала рамка или поток, то сначала они и их адрес.
 */
function Source(props: { entry: ConsoleEntry }) {
  const { t } = useI18n();
  const source = sourceOf(props.entry);
  const at = props.entry.at;
  if (!source && !at) {
    return null;
  }
  // Протокол подписи ничего не даёт, а места занимает. Целиком — в подсказке.
  const who = source
    ? t(SOURCES[source.kind], {
        address: source.address.replace(/^https?:\/\//, ""),
      })
    : null;
  const full = [
    source ? t(SOURCES[source.kind], { address: source.address }) : null,
    at ?? null,
  ].filter((line) => line !== null);
  return (
    <span className="browser-console-source" title={full.join("\n")}>
      {[who, at ? shortPlace(at) : null]
        .filter((part) => part !== null)
        .join(" · ")}
    </span>
  );
}

/**
 * Какое сообщение раскрыто. Номер сообщения после перезагрузки страницы
 * начинается заново, поэтому вместе с ним — текст: иначе раскрылось бы
 * чужое сообщение с тем же номером.
 */
function openKey(entry: NumberedEntry): string {
  return `${entry.index}\n${entry.level}\n${entry.text}`;
}

/** Сколько держать «Скопировано» на кнопке. */
const COPIED_MS = 1_500;

/**
 * Раскрытое сообщение: всё, что о нём известно. Стек — кто позвал
 * console.error или console.warn; у исключения он уже в самом тексте.
 */
function Details(props: { entry: ConsoleEntry }) {
  const { t } = useI18n();
  const { entry } = props;
  const [copied, setCopied] = useState(false);
  const source = sourceOf(entry);
  const times = timesOf(entry);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entryReport(entry));
      setCopied(true);
    } catch {
      // Буфер недоступен — текст всё равно можно выделить и скопировать.
    }
  };

  return (
    <div className="browser-console-details">
      {entry.stack && (
        <>
          <span className="browser-console-details-label">
            {t("browser.consoleStack")}
          </span>
          <span className="browser-console-stack">{entry.stack}</span>
        </>
      )}
      <dl className="browser-console-facts">
        {entry.at && (
          <>
            <dt>{t("browser.consolePlace")}</dt>
            <dd>{entry.at}</dd>
          </>
        )}
        {source && (
          <>
            <dt>{t("browser.consoleOrigin")}</dt>
            <dd>{t(SOURCES[source.kind], { address: source.address })}</dd>
          </>
        )}
        {times > 1 && (
          <>
            <dt>{t("browser.consoleTimes")}</dt>
            <dd>{times}</dd>
          </>
        )}
        {entry.time !== undefined && (
          <>
            <dt>{t("browser.consoleTime")}</dt>
            <dd>
              {clockTime(entry.time)}
              {entry.until !== undefined && ` – ${clockTime(entry.until)}`}
            </dd>
          </>
        )}
      </dl>
      <button
        type="button"
        className="browser-console-copy"
        onClick={() => void copy()}
      >
        {copied ? t("browser.consoleCopied") : t("browser.consoleCopy")}
      </button>
    </div>
  );
}

/**
 * Строка сообщения. Свёрнутая — первая строка текста: ошибка со стеком в
 * тридцать кадров иначе занимала бы всю консоль. Щелчок по строке
 * раскрывает её, но не тогда, когда в ней выделяют текст.
 */
function Entry(props: {
  entry: NumberedEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const { entry, open } = props;
  const tag = TAGS[entry.level];
  const breakAt = entry.text.indexOf("\n");
  const head = breakAt === -1 ? entry.text : entry.text.slice(0, breakAt);
  return (
    <div
      className={`browser-console-entry is-${kindOf(entry.level)}${
        open ? " is-open" : ""
      }`}
    >
      <div
        className="browser-console-line"
        onClick={() => {
          if (!window.getSelection()?.toString()) {
            props.onToggle();
          }
        }}
      >
        <button
          type="button"
          className="browser-console-disclosure"
          aria-expanded={open}
          aria-label={t(
            open ? "browser.consoleHideDetails" : "browser.consoleShowDetails",
          )}
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle();
          }}
        >
          <ChevronRightIcon aria-hidden />
        </button>
        <Mark entry={entry} />
        {tag && <span className="browser-console-tag">{t(tag)}</span>}
        <span className="browser-console-text">
          {open ? entry.text : head}
          {!open && breakAt !== -1 && (
            <span className="browser-console-more" aria-hidden>
              {" …"}
            </span>
          )}
        </span>
        <Source entry={entry} />
      </div>
      {open && <Details entry={entry} />}
    </div>
  );
}

/**
 * Слева, как в инспекторе: повтор — число в кружке, а иначе значок ошибки
 * или предупреждения. У простой записи значка нет.
 */
function Mark(props: { entry: ConsoleEntry }) {
  const { t } = useI18n();
  const times = timesOf(props.entry);
  if (times > 1) {
    return (
      <span
        className="browser-console-repeat"
        title={t("browser.consoleRepeated", { count: times })}
      >
        {times}
      </span>
    );
  }
  switch (kindOf(props.entry.level)) {
    case "error":
      return <ErrorIcon className="browser-console-icon" aria-hidden />;
    case "warning":
      return <WarningIcon className="browser-console-icon" aria-hidden />;
    default:
      return null;
  }
}

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
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const sectionRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Человек внизу — новое подтягиваем. Ушёл наверх читать — не дёргаем.
  const atBottom = useRef(true);
  // Высота, которую человек вытянул сам. Пока не тянул — обычная.
  const [chosen, setChosen] = useState<number | null>(loadHeight);
  // Высота ящика: от неё обычная высота и предел, за который не тянут.
  const [room, setRoom] = useState(0);

  useEffect(() => {
    const drawer = sectionRef.current?.parentElement;
    if (!drawer || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => setRoom(drawer.clientHeight));
    observer.observe(drawer);
    return () => observer.disconnect();
  }, []);

  // Пока ящик не измерен, высоту задают стили; выбранная всё равно в силе.
  const height =
    room > 0 ? fitHeight(chosen ?? usualHeight(room), room) : chosen;

  const shown = props.entries.filter((entry) => matches(entry, filter, search));
  const last = shown.length > 0 ? shown[shown.length - 1].index : -1;

  // Консоль стала ниже — низ списка уехал из виду, а человек был внизу.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && atBottom.current) {
      list.scrollTop = list.scrollHeight;
    }
  }, [last, props.lost, props.trouble, height]);

  const empty = !props.running
    ? t("browser.consoleNotRunning")
    : props.entries.length === 0
      ? t("browser.consoleEmpty")
      : shown.length === 0
        ? t("browser.consoleNoMatch")
        : null;

  return (
    <section
      className="browser-console"
      ref={sectionRef}
      aria-label={t("browser.console")}
      style={height === null ? undefined : { height }}
    >
      {/* Край целиком внутри консоли: над ним живая страница, и всё, что
          залезет на её место, она накроет собой. */}
      <ResizeHandle
        orientation="horizontal"
        size={height ?? usualHeight(0)}
        min={MIN_HEIGHT_PX}
        max={Math.max(MIN_HEIGHT_PX, room - PAGE_KEEPS_PX)}
        label={t("browser.console")}
        onResize={(next) => setChosen(fitHeight(next, room))}
        onResizeEnd={(next) =>
          writeSetting(KEYS.browserConsoleHeight, String(fitHeight(next, room)))
        }
        onReset={() => {
          setChosen(null);
          removeSetting(KEYS.browserConsoleHeight);
        }}
      />
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
          const key = openKey(entry);
          return (
            <Entry
              key={entry.index}
              entry={entry}
              open={opened.has(key)}
              onToggle={() =>
                setOpened((current) => {
                  const next = new Set(current);
                  if (!next.delete(key)) {
                    next.add(key);
                  }
                  return next;
                })
              }
            />
          );
        })}
        {empty && <p className="browser-console-empty">{empty}</p>}
      </div>
    </section>
  );
}
