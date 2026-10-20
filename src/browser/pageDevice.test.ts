// Размер экрана страницы: что запоминается и кто об этом узнаёт.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEYS } from "../settings/storage";

beforeEach(() => {
  localStorage.clear();
  // Выбор держится в модуле: каждому тесту — свежий.
  vi.resetModules();
});

describe("pageDevice", () => {
  it("fills the drawer until told otherwise", async () => {
    const { loadDevice } = await import("./pageDevice");

    expect(loadDevice()).toBe("desktop");
  });

  it("ignores a stored value it does not know", async () => {
    localStorage.setItem(KEYS.browserDevice, "watch");
    const { loadDevice } = await import("./pageDevice");

    expect(loadDevice()).toBe("desktop");
  });

  it("remembers the choice between launches", async () => {
    const first = await import("./pageDevice");
    first.saveDevice("phone");
    vi.resetModules();

    const second = await import("./pageDevice");

    expect(second.loadDevice()).toBe("phone");
  });

  it("redraws whoever shows the choice", async () => {
    const { saveDevice, useDevice } = await import("./pageDevice");
    const { result } = renderHook(() => useDevice());
    expect(result.current).toBe("desktop");

    act(() => saveDevice("tablet"));

    expect(result.current).toBe("tablet");
  });
});
