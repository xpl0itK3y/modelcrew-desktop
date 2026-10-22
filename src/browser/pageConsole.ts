// Консоль страницы проекта — для человека.
//
// Пишет её запись внутри самой страницы (`browser_console.js`), и читают её
// двое: агент (`browser_console`) и ящик. Запись одна на обоих, поэтому
// «очистить» здесь ничего не стирает — агент по-прежнему увидит всё, — а
// только запоминает, с какого места показывать. Подписки у страницы нет:
// опрос, как и у кадра.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";

export type ConsoleEntry = {
  level: string;
  text: string;
  // Адрес рамки, если написала рамка, а не сама страница.
  frame?: string;
  // Адрес скрипта потока (Worker), если упал он.
  worker?: string;
  // Место в коде — `адрес:строка:столбец`, откуда сообщение, — или адрес
  // того, что не загрузилось.
  at?: string;
  // Сколько раз подряд сообщение повторилось, если больше одного.
  count?: number;
};

export type PageConsole = {
  // Открыта ли страница. Нет — и консоли нет.
  running: boolean;
  // Когда страница начала запись. Сменилось — её загрузили заново.
  started: number;
  // Сколько ранних сообщений вытеснено новыми.
  dropped: number;
  messages: ConsoleEntry[];
};

export const NO_CONSOLE: PageConsole = {
  running: false,
  started: 0,
  dropped: 0,
  messages: [],
};

// Открытую консоль читают глазами — раз в секунду, как и кадр. Закрытая
// нужна только ради счётчика на кнопке, ей хватит и реже.
const OPEN_POLL_MS = 1_000;
const CLOSED_POLL_MS = 3_000;

/**
 * Следить за консолью страницы, пока ящик открыт.
 *
 * Следующий опрос — после ответа: страница, которая ещё не загрузилась,
 * отвечает не сразу, и запросы наложились бы.
 */
export function watchPageConsole(
  workspaceId: string | null,
  onConsole: (log: PageConsole) => void,
  onTrouble: (error: unknown) => void,
  open: boolean,
): () => void {
  if (!isTauri || !workspaceId) {
    onConsole(NO_CONSOLE);
    return () => {};
  }
  let stopped = false;
  let timer = 0;

  const poll = async () => {
    if (!document.hidden) {
      try {
        const log = await invoke<PageConsole>("browser_console", {
          workspaceId,
        });
        if (!stopped) {
          onConsole(log);
        }
      } catch (error) {
        if (!stopped) {
          onTrouble(error);
        }
      }
    }
    if (!stopped) {
      timer = window.setTimeout(poll, open ? OPEN_POLL_MS : CLOSED_POLL_MS);
    }
  };

  void poll();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

/** Сколько раз записано сообщение: повтор подряд — та же запись. */
export function timesOf(entry: ConsoleEntry): number {
  return entry.count ?? 1;
}

function lastTimes(log: PageConsole): number {
  const last = log.messages[log.messages.length - 1];
  return last ? timesOf(last) : 0;
}

/**
 * Одно и то же ли записано. Запись только растёт — новым сообщением или
 * повтором последнего, — поэтому хватает счёта.
 */
export function sameConsole(left: PageConsole, right: PageConsole): boolean {
  return (
    left.running === right.running &&
    left.started === right.started &&
    left.dropped === right.dropped &&
    left.messages.length === right.messages.length &&
    lastTimes(left) === lastTimes(right)
  );
}

/** Чем сообщение выглядит: ошибкой, предупреждением или просто записью. */
export type ConsoleKind = "error" | "warning" | "log";

export function kindOf(level: string): ConsoleKind {
  switch (level) {
    case "error":
    case "exception":
    case "rejection":
    case "resource":
    case "csp":
      return "error";
    case "warn":
      return "warning";
    default:
      return "log";
  }
}

/** Сообщение со своим номером от начала записи — номер не меняется. */
export type NumberedEntry = ConsoleEntry & { index: number };

/**
 * Откуда показывать после «очистить»: номер первого сообщения, которого
 * человек ещё не видел, на той загрузке страницы, где очищали, и сколько
 * повторов последнего он уже видел.
 */
export type ConsoleMark = { started: number; next: number; seen: number };

/** Конец записанного — то, что запоминает «очистить». */
export function endOf(log: PageConsole): ConsoleMark {
  return {
    started: log.started,
    next: log.dropped + log.messages.length,
    seen: lastTimes(log),
  };
}

/** Номер, с которого показывать. Страницу загрузили заново — с начала. */
function firstShown(log: PageConsole, mark: ConsoleMark | null): number {
  return mark !== null && mark.started === log.started ? mark.next : 0;
}

/**
 * Что показывать после «очистить». Последнее очищенное сообщение, если
 * страница повторила его снова, возвращается — с числом новых повторов.
 */
export function entriesSince(
  log: PageConsole,
  mark: ConsoleMark | null,
): NumberedEntry[] {
  const from = firstShown(log, mark);
  const entries: NumberedEntry[] = [];
  log.messages.forEach((message, position) => {
    const index = log.dropped + position;
    if (index >= from) {
      entries.push({ ...message, index });
    } else if (mark && index === from - 1 && timesOf(message) > mark.seen) {
      entries.push({ ...message, index, count: timesOf(message) - mark.seen });
    }
  });
  return entries;
}

/**
 * Сколько сообщений после «очистить» вытеснено, не дойдя до экрана. Запись
 * держит последние двести, и об остальных честнее сказать, чем промолчать.
 */
export function lostSince(log: PageConsole, mark: ConsoleMark | null): number {
  return Math.max(0, log.dropped - firstShown(log, mark));
}

/** Счётчики для кнопки консоли. */
export function countKinds(entries: readonly ConsoleEntry[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  // Повторы считаются, как в инспекторе: ошибка в цикле — не одна ошибка.
  for (const entry of entries) {
    const kind = kindOf(entry.level);
    if (kind === "error") {
      errors += timesOf(entry);
    } else if (kind === "warning") {
      warnings += timesOf(entry);
    }
  }
  return { errors, warnings };
}

/** Какие сообщения показывать: все, только ошибки и так далее. */
export type ConsoleFilter = "all" | ConsoleKind;

export function matches(
  entry: ConsoleEntry,
  filter: ConsoleFilter,
  search: string,
): boolean {
  if (filter !== "all" && kindOf(entry.level) !== filter) {
    return false;
  }
  const needle = search.trim().toLowerCase();
  // Ищут и по адресу: «покажи всё, что пишет виджет оплаты», — и по месту:
  // «всё из main.js».
  return (
    needle === "" ||
    [entry.text, entry.frame ?? "", entry.worker ?? "", entry.at ?? ""].some(
      (said) => said.toLowerCase().includes(needle),
    )
  );
}

/** Чьё сообщение, если не самой страницы: рамки или потока, и откуда он. */
export function sourceOf(
  entry: ConsoleEntry,
): { kind: "frame" | "worker"; address: string } | null {
  if (entry.worker) {
    return { kind: "worker", address: entry.worker };
  }
  if (entry.frame) {
    return { kind: "frame", address: entry.frame };
  }
  return null;
}

/**
 * Место в коде коротко, как справа в инспекторе: файл и строка. Страница
 * без файла в адресе — корень сайта — названа хостом.
 */
export function shortPlace(at: string): string {
  const [, address, line] = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(at) ?? [];
  const path = (address ?? at).replace(/[?#].*$/, "");
  const name = path.slice(path.lastIndexOf("/") + 1);
  const host = /^[a-z][\w+.-]*:\/\/([^/]+)/i.exec(path)?.[1];
  const file = name || (host ? `${host}/` : path);
  return line ? `${file}:${line}` : file;
}
