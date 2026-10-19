// Где стоит живая страница и когда она уходит из панели.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepPageDocked, placeOf } from "./pageDock";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// jsdom не раскладывает вёрстку: размер места и то, что лежит в точке,
// задаём сами.
let box = { left: 10.4, top: 20.6, width: 600.2, height: 399.7 };
let cover: (x: number, y: number) => Element | null = () => null;

let place: HTMLDivElement;
let inside: HTMLSpanElement;
let overlay: HTMLDivElement;

// Кадры отрисовки идут, только когда тест их прокручивает.
let frames: FrameRequestCallback[] = [];
const nextFrame = () => {
  const due = frames;
  frames = [];
  due.forEach((callback) => callback(0));
};
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  box = { left: 10.4, top: 20.6, width: 600.2, height: 399.7 };
  place = document.createElement("div");
  inside = document.createElement("span");
  place.append(inside);
  overlay = document.createElement("div");
  document.body.append(place, overlay);
  cover = () => inside;
  vi.spyOn(place, "getBoundingClientRect").mockImplementation(
    () => box as DOMRect,
  );
  document.elementFromPoint = (x: number, y: number) => cover(x, y);
  frames = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
    frames = [];
  });
});

afterEach(() => {
  document.body.replaceChildren();
  // @ts-expect-error — в jsdom этого метода нет, его ставит тест.
  delete document.elementFromPoint;
});

describe("placeOf", () => {
  it("gives the place in whole points", () => {
    // Бэкенд ставит страницу в логические точки окна: дробные половинки
    // каждый кадр дёргали бы её туда-сюда на пиксель.
    expect(placeOf(place)).toEqual({ x: 10, y: 21, width: 600, height: 400 });
  });

  it("gives nothing while the window is hidden", () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    expect(placeOf(place)).toBeNull();
  });

  it("gives nothing while the drawer is closing", () => {
    // Панель уезжает анимацией, а родной webview за ней не поедет.
    const drawer = document.createElement("aside");
    drawer.className = "drawer is-closing";
    drawer.append(place);
    document.body.append(drawer);

    expect(placeOf(place)).toBeNull();
  });

  it("gives nothing while the place has no size", () => {
    box = { ...box, width: 0 };

    expect(placeOf(place)).toBeNull();
  });

  it("gives nothing when something of ours lies over a corner", () => {
    // Наш HTML поверх родного webview не рисуется: меню, легшее на угол,
    // ушло бы под страницу.
    cover = (x, y) => (x > 500 && y > 300 ? overlay : inside);

    expect(placeOf(place)).toBeNull();
  });

  it("gives nothing when the point falls outside the window", () => {
    cover = () => null;

    expect(placeOf(place)).toBeNull();
  });
});

describe("keepPageDocked", () => {
  it("puts the page in its place once and leaves it there", async () => {
    const docked: boolean[] = [];

    const dock = keepPageDocked("workspace-1", place, (next) =>
      docked.push(next),
    );
    await settled();
    nextFrame();
    nextFrame();
    await settled();

    // Место не сдвинулось — бэкенд не дёргаем: каждый кадр отрисовки
    // переставлял бы родной webview впустую.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("browser_dock", {
      workspaceId: "workspace-1",
      x: 10,
      y: 21,
      width: 600,
      height: 400,
    });
    expect(docked).toEqual([true]);
    dock.stop();
  });

  it("follows the place when it moves", async () => {
    const dock = keepPageDocked("workspace-1", place, () => {});
    await settled();

    box = { ...box, width: 420 };
    nextFrame();
    await settled();

    expect(invoke).toHaveBeenLastCalledWith("browser_dock", {
      workspaceId: "workspace-1",
      x: 10,
      y: 21,
      width: 420,
      height: 400,
    });
    dock.stop();
  });

  it("sends the page home when the place gets covered", async () => {
    const docked: boolean[] = [];
    const dock = keepPageDocked("workspace-1", place, (next) =>
      docked.push(next),
    );
    await settled();

    cover = () => overlay;
    nextFrame();
    await settled();

    expect(invoke).toHaveBeenLastCalledWith("browser_undock", {
      workspaceId: "workspace-1",
    });
    // Ушла страница — панель снова показывает кадр.
    expect(docked).toEqual([true, false]);
    dock.stop();
  });

  it("asks for nothing until the backend has answered", async () => {
    // Команды бэкенд выполняет вперемешку: вторая просьба, обогнав первую,
    // оставила бы страницу на прошлом месте.
    let release = () => {};
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const dock = keepPageDocked("workspace-1", place, () => {});
    box = { ...box, width: 420 };
    nextFrame();
    nextFrame();
    expect(invoke).toHaveBeenCalledTimes(1);

    release();
    await settled();
    nextFrame();
    await settled();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith(
      "browser_dock",
      expect.objectContaining({ width: 420 }),
    );
    dock.stop();
  });

  it("shows the picture and waits a moment after a refusal", async () => {
    invoke.mockRejectedValueOnce({ code: "browser_command_failed" });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const docked: boolean[] = [];
    const trouble: unknown[] = [];

    const dock = keepPageDocked(
      "workspace-1",
      place,
      (next) => docked.push(next),
      (error) => trouble.push(error),
    );
    await settled();
    expect(docked).toEqual([false]);
    expect(trouble).toEqual([{ code: "browser_command_failed" }]);

    // Сразу не повторяем: отказ каждый кадр забил бы бэкенд просьбами.
    nextFrame();
    await settled();
    expect(invoke).toHaveBeenCalledTimes(1);

    now.mockReturnValue(2_000);
    nextFrame();
    await settled();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(docked).toEqual([false, true]);
    dock.stop();
  });

  it("sends the place again once told the page left it", async () => {
    const dock = keepPageDocked("workspace-1", place, () => {});
    await settled();

    // Страницу открыли заново, и она снова в своём окне, хоть место то же.
    dock.forget();
    nextFrame();
    await settled();

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith(
      "browser_dock",
      expect.objectContaining({ workspaceId: "workspace-1" }),
    );
    dock.stop();
  });

  it("sends the page home at once when the window hides", async () => {
    const dock = keepPageDocked("workspace-1", place, () => {});
    await settled();

    // Спрятанному окну кадры отрисовки не приходят: ждать следующего нельзя.
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await settled();

    expect(invoke).toHaveBeenLastCalledWith("browser_undock", {
      workspaceId: "workspace-1",
    });
    dock.stop();
  });

  it("sends the page home after the request still on its way", async () => {
    let release = () => {};
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const dock = keepPageDocked("workspace-1", place, () => {});
    dock.stop();
    await settled();
    // Уйди страница раньше — опоздавшая просьба поставила бы её обратно в
    // панель, которой уже нет.
    expect(invoke).toHaveBeenCalledTimes(1);

    release();
    await settled();
    expect(invoke).toHaveBeenLastCalledWith("browser_undock", {
      workspaceId: "workspace-1",
    });

    nextFrame();
    await settled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
