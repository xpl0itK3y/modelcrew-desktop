// Консоль страницы: опрос, «очистить» и что считать ошибкой.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_CONSOLE,
  clockTime,
  countKinds,
  endOf,
  entriesSince,
  entryReport,
  kindOf,
  lostSince,
  matches,
  sameConsole,
  shortPlace,
  sourceOf,
  watchPageConsole,
  type PageConsole,
} from "./pageConsole";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

function log(over: Partial<PageConsole> = {}): PageConsole {
  return { running: true, started: 1, dropped: 0, messages: [], ...over };
}

const said = (...texts: string[]) =>
  texts.map((text) => ({ level: "log", text }));

describe("watchPageConsole", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing until a project is chosen", () => {
    const seen: unknown[] = [];
    const stop = watchPageConsole(
      null,
      (next) => seen.push(next),
      () => {},
      true,
    );

    expect(seen).toEqual([NO_CONSOLE]);
    expect(invoke).not.toHaveBeenCalled();
    stop();
  });

  it("reads the open console every second and a closed one less often", async () => {
    invoke.mockResolvedValue(log());

    const open = watchPageConsole(
      "w1",
      () => {},
      () => {},
      true,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("browser_console", {
      workspaceId: "w1",
    });
    open();

    invoke.mockClear();
    const closed = watchPageConsole(
      "w1",
      () => {},
      () => {},
      false,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    closed();
  });

  it("passes trouble up instead of pretending the console is empty", async () => {
    invoke.mockRejectedValue({ code: "browser_command_failed" });
    const seen: unknown[] = [];
    const trouble: unknown[] = [];

    const stop = watchPageConsole(
      "w1",
      (next) => seen.push(next),
      (error) => trouble.push(error),
      true,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([]);
    expect(trouble).toEqual([{ code: "browser_command_failed" }]);
    stop();
  });
});

describe("console entries", () => {
  it("counts what the page did not write itself as errors", () => {
    expect(
      ["error", "exception", "rejection", "resource", "csp"].map(kindOf),
    ).toEqual(["error", "error", "error", "error", "error"]);
    expect(kindOf("warn")).toBe("warning");
    expect(["log", "info", "debug", "trace", "anything"].map(kindOf)).toEqual([
      "log",
      "log",
      "log",
      "log",
      "log",
    ]);
  });

  it("shows only what came after clearing", () => {
    const before = log({ messages: said("a", "b") });
    const mark = endOf(before);
    const after = log({ messages: said("a", "b", "c") });

    expect(entriesSince(after, mark)).toEqual([
      { level: "log", text: "c", index: 2 },
    ]);
  });

  it("keeps its place while old messages are pushed out", () => {
    // Запись держит последние двести: номера сдвигаются вместе с
    // вытесненными, и «очистить» не должно вернуть уже очищенное.
    const mark = endOf(log({ messages: said("a", "b", "c") }));
    const later = log({ dropped: 2, messages: said("c", "d") });

    expect(entriesSince(later, mark).map((entry) => entry.text)).toEqual(["d"]);
    expect(lostSince(later, mark)).toBe(0);
  });

  it("starts over when the page is loaded anew", () => {
    const mark = endOf(log({ messages: said("a", "b") }));
    const reloaded = log({ started: 2, messages: said("fresh") });

    expect(entriesSince(reloaded, mark).map((entry) => entry.text)).toEqual([
      "fresh",
    ]);
  });

  it("brings a cleared message back when the page repeats it", () => {
    // Повтор подряд — та же запись с большим счётом. После «очистить» человек
    // должен увидеть, что ошибка случилась снова, — и сколько раз.
    const times = (count: number) =>
      log({ messages: [{ level: "error", text: "x", count }] });
    const mark = endOf(times(2));

    expect(entriesSince(times(5), mark)).toEqual([
      { level: "error", text: "x", count: 3, index: 0 },
    ]);
    expect(entriesSince(times(2), mark)).toEqual([]);
  });

  it("says how many messages fell out before anyone saw them", () => {
    const busy = log({ dropped: 5, messages: said("x") });

    expect(lostSince(busy, null)).toBe(5);
    expect(lostSince(busy, { started: 1, next: 3, seen: 1 })).toBe(2);
  });

  it("counts errors and warnings for the button", () => {
    expect(
      countKinds([
        { level: "error", text: "" },
        { level: "resource", text: "" },
        { level: "warn", text: "" },
        { level: "log", text: "" },
      ]),
    ).toEqual({ errors: 2, warnings: 1 });
    // Повторы — тоже ошибки, как на счётчике инспектора.
    expect(countKinds([{ level: "exception", text: "", count: 4 }])).toEqual({
      errors: 4,
      warnings: 0,
    });
  });

  it("filters by kind and by text, ignoring case", () => {
    const entry = { level: "warn", text: "Deprecated API" };

    expect(matches(entry, "all", "")).toBe(true);
    expect(matches(entry, "warning", "deprecated")).toBe(true);
    expect(matches(entry, "error", "")).toBe(false);
    expect(matches(entry, "all", "missing")).toBe(false);
  });

  it("finds a frame's and a worker's messages by their address", () => {
    const fromFrame = {
      level: "error",
      text: "declined",
      frame: "https://pay.test/widget",
    };
    const fromWorker = {
      level: "exception",
      text: "boom",
      worker: "https://app.test/w.js",
    };

    expect(matches(fromFrame, "all", "pay.test")).toBe(true);
    expect(matches(fromWorker, "error", "w.js")).toBe(true);
    expect(matches(fromFrame, "all", "w.js")).toBe(false);
    expect(
      matches(
        { level: "log", text: "hi", at: "http://app.test/main.js:1:2" },
        "all",
        "main.js",
      ),
    ).toBe(true);
  });

  it("names a place by its file and line, like an inspector", () => {
    expect(shortPlace("http://127.0.0.1:4321/assets/main.js:12:7")).toBe(
      "main.js:12",
    );
    expect(shortPlace("https://app.test/a.js?v=1#x:3:4")).toBe("a.js:3");
    // Скрипт прямо в странице, у которой в адресе нет файла.
    expect(shortPlace("http://127.0.0.1:4321/:5:9")).toBe("127.0.0.1:4321/:5");
    // То, что не загрузилось, — без строки.
    expect(shortPlace("http://localhost:4321/pic.png")).toBe("pic.png");
  });

  it("names who wrote a message unless it was the page itself", () => {
    expect(sourceOf({ level: "log", text: "hi" })).toBeNull();
    expect(
      sourceOf({ level: "log", text: "hi", frame: "https://pay.test/" }),
    ).toEqual({
      kind: "frame",
      address: "https://pay.test/",
    });
    // Поток в рамке — прежде всего поток: упал он, а не рамка.
    expect(
      sourceOf({
        level: "exception",
        text: "boom",
        frame: "https://pay.test/",
        worker: "https://pay.test/w.js",
      }),
    ).toEqual({ kind: "worker", address: "https://pay.test/w.js" });
  });

  it("notices when nothing new was written", () => {
    const first = log({ messages: said("a") });

    expect(sameConsole(first, log({ messages: said("a") }))).toBe(true);
    expect(sameConsole(first, log({ messages: said("a", "b") }))).toBe(false);
    expect(sameConsole(first, log({ started: 2, messages: said("a") }))).toBe(
      false,
    );
    // Повтор последнего — тоже новое.
    const repeated = log({ messages: [{ level: "log", text: "a", count: 2 }] });
    expect(sameConsole(first, repeated)).toBe(false);
  });
});

describe("a console message in full", () => {
  // Часы человека: время записи показываем по ним, а не по UTC.
  const at = (hours: number, minutes: number, seconds: number, ms: number) =>
    new Date(2026, 10, 5, hours, minutes, seconds, ms).getTime();

  it("tells the time to the millisecond, like an inspector", () => {
    expect(clockTime(at(9, 5, 7, 42))).toBe("09:05:07.042");
  });

  it("finds a message by a frame of the stack that called it", () => {
    const entry = {
      level: "error",
      text: "Could not save",
      stack: "save@http://localhost:1420/src/store.ts:40:9",
    };

    expect(matches(entry, "all", "store.ts")).toBe(true);
  });

  it("puts everything known about a message into one text to copy", () => {
    expect(
      entryReport({
        level: "error",
        text: "Unstructured backend error",
        at: "http://localhost:1420/src/i18n/index.ts:170:13",
        stack: [
          "describeBackendError@http://localhost:1420/src/i18n/index.ts:170:13",
          "App@http://localhost:1420/src/App.tsx:229:7",
        ].join("\n"),
        frame: "https://pay.test/widget",
        count: 3,
        time: at(10, 15, 4, 120),
        until: at(10, 15, 6, 5),
      }),
    ).toBe(
      [
        "[error] Unstructured backend error",
        "    describeBackendError@http://localhost:1420/src/i18n/index.ts:170:13",
        "    App@http://localhost:1420/src/App.tsx:229:7",
        "at http://localhost:1420/src/i18n/index.ts:170:13",
        "frame https://pay.test/widget",
        "repeated 3 times",
        "time 10:15:04.120 – 10:15:06.005",
      ].join("\n"),
    );
  });

  it("keeps a plain message plain", () => {
    expect(entryReport({ level: "log", text: "[vite] connected." })).toBe(
      "[log] [vite] connected.",
    );
  });
});
