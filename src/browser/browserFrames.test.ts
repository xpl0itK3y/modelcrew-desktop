// Разбор адреса из адресной строки и опрос кадра.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_FRAME,
  frameSource,
  normalizeAddress,
  watchBrowserFrame,
} from "./browserFrames";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("normalizeAddress", () => {
  it("dresses a bare host as http", () => {
    // Так адрес и набирают: порт стенда помнят, схему — нет.
    expect(normalizeAddress("localhost:1420")).toBe("http://localhost:1420");
    expect(normalizeAddress("example.com/path")).toBe(
      "http://example.com/path",
    );
  });

  it("leaves an address that already has a scheme alone", () => {
    expect(normalizeAddress("https://example.com")).toBe("https://example.com");
    expect(normalizeAddress("HTTP://EXAMPLE.COM")).toBe("HTTP://EXAMPLE.COM");
  });

  it("does not quietly rewrite a scheme we do not serve", () => {
    // Отказать должен бэкенд, и с причиной: подставив сюда http, мы бы
    // открыли совсем не тот адрес, который человек набрал.
    expect(normalizeAddress("file:///etc/passwd")).toBe("file:///etc/passwd");
  });

  it("treats blank input as nothing to open", () => {
    expect(normalizeAddress("   ")).toBeNull();
    expect(normalizeAddress("")).toBeNull();
  });

  it("ignores stray spaces around the address", () => {
    expect(normalizeAddress("  example.com  ")).toBe("http://example.com");
  });
});

describe("frameSource", () => {
  it("wraps a frame as a data address", () => {
    expect(frameSource("QUJD")).toBe("data:image/png;base64,QUJD");
  });

  it("stays empty when there is no frame", () => {
    // Пустой src в img браузер трактует как адрес страницы и грузит её
    // заново: показывать нечего — значит и тега быть не должно.
    expect(frameSource("")).toBe("");
  });
});

describe("watchBrowserFrame", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing until a project is chosen", () => {
    const frames: unknown[] = [];
    const stop = watchBrowserFrame(null, (frame) => frames.push(frame));

    expect(frames).toEqual([NO_FRAME]);
    expect(invoke).not.toHaveBeenCalled();
    stop();
  });

  it("asks the backend for the frame of the open project", async () => {
    const frame = {
      image: "QUJD",
      url: "http://localhost:1420/",
      title: "ModelCrew",
      running: true,
    };
    invoke.mockResolvedValue(frame);
    const seen: unknown[] = [];

    const stop = watchBrowserFrame("workspace-1", (next) => seen.push(next));
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledWith("browser_frame", {
      workspaceId: "workspace-1",
    });
    expect(seen).toEqual([frame]);
    stop();
  });

  it("tells the backend how big the place for the frame is", async () => {
    // Без этого страница снимается своим постоянным размером: по ширине ящика
    // кадр растягивают, а снизу остаётся пустая полоса.
    invoke.mockResolvedValue(NO_FRAME);

    const stop = watchBrowserFrame(
      "workspace-1",
      () => {},
      () => {},
      () => ({ width: 792, height: 560 }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledWith("browser_frame", {
      workspaceId: "workspace-1",
      width: 792,
      height: 560,
    });
    stop();
  });

  it("asks the place again before every frame", async () => {
    // Ящик тянут за край между снимками: спроси мы размер однажды, страница
    // осталась бы прежней формы до перезапуска слежения.
    invoke.mockResolvedValue(NO_FRAME);
    const sizes = [
      { width: 792, height: 560 },
      { width: 500, height: 400 },
    ];

    const stop = watchBrowserFrame(
      "workspace-1",
      () => {},
      () => {},
      () => sizes.shift() ?? null,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(invoke).toHaveBeenNthCalledWith(2, "browser_frame", {
      workspaceId: "workspace-1",
      width: 500,
      height: 400,
    });
    stop();
  });

  it("still asks for a frame while the place is unknown", async () => {
    // Пока ящик раскрывается, места ещё нет. Кадр всё равно нужен: страницу
    // просто оставят в том размере, в котором она есть.
    invoke.mockResolvedValue(NO_FRAME);

    const stop = watchBrowserFrame(
      "workspace-1",
      () => {},
      () => {},
      () => null,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(invoke).toHaveBeenCalledWith("browser_frame", {
      workspaceId: "workspace-1",
      width: undefined,
      height: undefined,
    });
    stop();
  });

  it("waits for one frame before asking for the next", async () => {
    // Снимок иногда идёт дольше секунды. С обычным интервалом запросы
    // наложились бы, и браузер снимал бы кадры вместо того, чтобы работать.
    let release = () => {};
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(NO_FRAME);
        }),
    );

    const stop = watchBrowserFrame("workspace-1", () => {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(invoke).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).toHaveBeenCalledTimes(2);
    stop();
  });

  it("tells the trouble apart from a browser that is simply not running", async () => {
    invoke.mockRejectedValue({ code: "browser_command_failed" });
    const seen: unknown[] = [];
    const trouble: unknown[] = [];

    const stop = watchBrowserFrame(
      "workspace-1",
      (next) => seen.push(next),
      (error) => trouble.push(error),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Не поднятый браузер — это удачный ответ с пустым кадром. Сюда мы
    // попадаем, когда сломалась связь с живым, и пустой кадр вместо причины
    // сказал бы человеку «браузер не запущен» про работающий.
    expect(seen).toEqual([]);
    expect(trouble).toEqual([{ code: "browser_command_failed" }]);
    stop();
  });

  it("asks for nothing while nobody is looking at the window", async () => {
    invoke.mockResolvedValue(NO_FRAME);
    const hidden = vi
      .spyOn(document, "hidden", "get")
      .mockReturnValue(true);

    const stop = watchBrowserFrame("workspace-1", () => {});
    await vi.advanceTimersByTimeAsync(3_000);

    // Снимок кадра стоит времени браузера: за свёрнутым окном он впустую.
    expect(invoke).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).toHaveBeenCalledTimes(1);

    stop();
    hidden.mockRestore();
  });

  it("stops asking once the drawer is closed", async () => {
    invoke.mockResolvedValue(NO_FRAME);

    const stop = watchBrowserFrame("workspace-1", () => {});
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
