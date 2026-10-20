// Консоль страницы: опрос, «очистить» и что считать ошибкой.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_CONSOLE,
  countKinds,
  endOf,
  entriesSince,
  kindOf,
  lostSince,
  matches,
  sameConsole,
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
    expect(["error", "exception", "rejection", "resource"].map(kindOf)).toEqual(
      ["error", "error", "error", "error"],
    );
    expect(kindOf("warn")).toBe("warning");
    expect(["log", "info", "debug", "anything"].map(kindOf)).toEqual([
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

  it("says how many messages fell out before anyone saw them", () => {
    const busy = log({ dropped: 5, messages: said("x") });

    expect(lostSince(busy, null)).toBe(5);
    expect(lostSince(busy, { started: 1, next: 3 })).toBe(2);
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
  });
});
