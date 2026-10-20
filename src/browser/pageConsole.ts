// Консоль страницы проекта — для человека.
//
// Пишет её запись внутри самой страницы (`browser_console.js`), и читают её
// двое: агент (`browser_console`) и ящик. Запись одна на обоих, поэтому
// «очистить» здесь ничего не стирает — агент по-прежнему увидит всё, — а
// только запоминает, с какого места показывать. Подписки у страницы нет:
// опрос, как и у кадра.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";

export type ConsoleEntry = { level: string; text: string };

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

/** Одно и то же ли записано. Запись только растёт, поэтому хватает счёта. */
export function sameConsole(left: PageConsole, right: PageConsole): boolean {
  return (
    left.running === right.running &&
    left.started === right.started &&
    left.dropped === right.dropped &&
    left.messages.length === right.messages.length
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
 * человек ещё не видел, на той загрузке страницы, где очищали.
 */
export type ConsoleMark = { started: number; next: number };

/** Конец записанного — то, что запоминает «очистить». */
export function endOf(log: PageConsole): ConsoleMark {
  return { started: log.started, next: log.dropped + log.messages.length };
}

/** Номер, с которого показывать. Страницу загрузили заново — с начала. */
function firstShown(log: PageConsole, mark: ConsoleMark | null): number {
  return mark !== null && mark.started === log.started ? mark.next : 0;
}

/** Что показывать после «очистить». */
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
  for (const entry of entries) {
    const kind = kindOf(entry.level);
    if (kind === "error") {
      errors += 1;
    } else if (kind === "warning") {
      warnings += 1;
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
  return needle === "" || entry.text.toLowerCase().includes(needle);
}
