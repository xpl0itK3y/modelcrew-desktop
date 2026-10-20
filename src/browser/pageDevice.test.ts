// Размер экрана страницы: что запоминается и кто об этом узнаёт.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEYS } from "../settings/storage";
import {
  deviceOf,
  fitScreen,
  parseScreen,
  rotated,
  screenKey,
} from "./pageDevice";

beforeEach(() => {
  localStorage.clear();
  // Выбор держится в модуле: каждому тесту — свежий.
  vi.resetModules();
});

describe("pageDevice", () => {
  it("fills the drawer until told otherwise", async () => {
    const { loadScreen } = await import("./pageDevice");

    expect(loadScreen()).toBeNull();
  });

  it("ignores a stored value it does not know", async () => {
    localStorage.setItem(KEYS.browserDevice, "watch");
    const { loadScreen } = await import("./pageDevice");

    expect(loadScreen()).toBeNull();
  });

  it("keeps a phone chosen before sizes could be typed", async () => {
    localStorage.setItem(KEYS.browserDevice, "phone");
    const { loadScreen } = await import("./pageDevice");

    expect(loadScreen()).toEqual({ width: 390, height: 844 });
  });

  it("remembers the size between launches", async () => {
    const first = await import("./pageDevice");
    first.saveScreen({ width: 1280, height: 720 });
    vi.resetModules();

    const second = await import("./pageDevice");

    expect(second.loadScreen()).toEqual({ width: 1280, height: 720 });
  });

  it("redraws whoever shows the size", async () => {
    const { saveScreen, useScreen } = await import("./pageDevice");
    const { result } = renderHook(() => useScreen());
    expect(result.current).toBeNull();

    act(() => saveScreen({ width: 768, height: 1024 }));

    expect(result.current).toEqual({ width: 768, height: 1024 });
  });
});

describe("screen sizes", () => {
  it("keeps a typed size within what the page can take", () => {
    expect(fitScreen(100, 100)).toEqual({ width: 320, height: 360 });
    expect(fitScreen(99_999, 1_000.4)).toEqual({ width: 3840, height: 1000 });
    expect(fitScreen(Number.NaN, 500)).toBeNull();
  });

  it("lights the button of the device, turned either way", () => {
    expect(deviceOf(null)).toBe("desktop");
    expect(deviceOf({ width: 390, height: 844 })).toBe("phone");
    expect(deviceOf({ width: 844, height: 390 })).toBe("phone");
    expect(deviceOf({ width: 1024, height: 768 })).toBe("tablet");
    expect(deviceOf({ width: 1280, height: 720 })).toBeNull();
  });

  it("reads back what it writes", () => {
    const size = { width: 412, height: 915 };

    expect(parseScreen(screenKey(size))).toEqual(size);
    expect(parseScreen("412×915")).toBeNull();
    expect(rotated(size)).toEqual({ width: 915, height: 412 });
  });
});
