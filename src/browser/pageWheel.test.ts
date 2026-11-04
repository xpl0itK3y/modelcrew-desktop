// Колесо над кадром страницы: в каких точках кадра и как его копим.

import { describe, expect, it, vi } from "vitest";
import {
  createWheelRelay,
  wheelOnFrame,
  type FrameImage,
  type WheelTurn,
} from "./pageWheel";

// Кадр 1280×800, ужатый в ящике вдвое.
const HALF: FrameImage = {
  rect: { left: 100, top: 50, width: 640, height: 400 },
  naturalWidth: 1280,
  naturalHeight: 800,
};

function turn(over: Partial<WheelTurn> = {}): WheelTurn {
  return {
    clientX: 420,
    clientY: 250,
    deltaX: 0,
    deltaY: 60,
    deltaMode: 0,
    shiftKey: false,
    ...over,
  };
}

describe("wheelOnFrame", () => {
  it("speaks in pixels of the frame, not of the drawer", () => {
    // Агент и страница меряют кадр, а не ящик: ужатая вдвое картинка —
    // вдвое больше пикселей кадра на каждый пиксель ящика.
    expect(wheelOnFrame(turn(), HALF)).toEqual({
      at: { x: 640, y: 400 },
      by: { x: 0, y: 120 },
    });
  });

  it("ignores the wheel beside the picture", () => {
    // Картинка ниже ящика кончается раньше него: под ней страницы нет.
    expect(wheelOnFrame(turn({ clientY: 460 }), HALF)).toBeNull();
    expect(wheelOnFrame(turn({ clientX: 99 }), HALF)).toBeNull();
  });

  it("counts lines and pages in pixels", () => {
    expect(wheelOnFrame(turn({ deltaY: 3, deltaMode: 1 }), HALF)?.by).toEqual(
      { x: 0, y: 240 },
    );
    expect(wheelOnFrame(turn({ deltaY: 1, deltaMode: 2 }), HALF)?.by).toEqual(
      { x: 0, y: 800 },
    );
  });

  it("turns sideways with Shift held", () => {
    expect(wheelOnFrame(turn({ shiftKey: true }), HALF)?.by).toEqual({
      x: 120,
      y: 0,
    });
    // Колесо вбок само по себе — уже вбок, Shift его не трогает.
    expect(
      wheelOnFrame(turn({ shiftKey: true, deltaX: 30, deltaY: 0 }), HALF)?.by,
    ).toEqual({ x: 60, y: 0 });
  });

  it("does nothing without a shift or before the picture loads", () => {
    expect(wheelOnFrame(turn({ deltaY: 0 }), HALF)).toBeNull();
    expect(
      wheelOnFrame(turn(), { ...HALF, naturalWidth: 0, naturalHeight: 0 }),
    ).toBeNull();
  });
});

describe("createWheelRelay", () => {
  it("sends one shift at a time and gathers the rest meanwhile", async () => {
    // Колесо даёт десятки событий в секунду. По запросу на каждое страница
    // отставала бы от руки, а очередь росла.
    const releases: Array<() => void> = [];
    const send = vi.fn(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    const sent = vi.fn();
    const relay = createWheelRelay(send, sent);

    relay({ x: 1, y: 1 }, { x: 0, y: 10 });
    relay({ x: 2, y: 2 }, { x: 0, y: 20 });
    relay({ x: 3, y: 3 }, { x: 5, y: 30 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ x: 1, y: 1 }, { x: 0, y: 10 });

    releases[0]();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    // Накопленное — одним сдвигом, в последней точке под мышью.
    expect(send).toHaveBeenLastCalledWith({ x: 3, y: 3 }, { x: 5, y: 50 });
    expect(sent).toHaveBeenCalledTimes(1);

    releases[1]();
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps going after a shift the page did not take", async () => {
    // Страница как раз грузилась — колесо от этого не должно замереть.
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("загружается"))
      .mockResolvedValue(undefined);
    const sent = vi.fn();
    const relay = createWheelRelay(send, sent);

    relay({ x: 1, y: 1 }, { x: 0, y: 10 });
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    relay({ x: 1, y: 1 }, { x: 0, y: 10 });
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2));

    expect(send).toHaveBeenCalledTimes(2);
  });
});
