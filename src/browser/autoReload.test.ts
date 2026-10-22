// Выключатель автообновления: где хранится и что узнаёт бэкенд.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KEYS } from "../settings/storage";
import {
  loadAutoReload,
  saveAutoReload,
  syncAutoReload,
  useAutoReload,
} from "./autoReload";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  saveAutoReload(true);
  invoke.mockClear();
});

describe("autoReload", () => {
  it("remembers the choice and tells the backend at once", () => {
    saveAutoReload(false);

    expect(loadAutoReload()).toBe(false);
    expect(localStorage.getItem(KEYS.browserAutoReload)).toBe("off");
    expect(invoke).toHaveBeenCalledWith("browser_auto_reload", {
      enabled: false,
    });
  });

  it("repeats the choice to the backend on start", async () => {
    // Бэкенд после запуска обновляет страницы, пока ему не скажут иначе.
    saveAutoReload(false);
    invoke.mockClear();

    await syncAutoReload();

    expect(invoke).toHaveBeenCalledWith("browser_auto_reload", {
      enabled: false,
    });
  });

  it("redraws whoever shows the switch", () => {
    const { result } = renderHook(() => useAutoReload());
    expect(result.current).toBe(true);

    act(() => saveAutoReload(false));

    expect(result.current).toBe(false);
  });

  it("keeps working when the backend cannot be reached", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("gone"));

    await expect(syncAutoReload()).resolves.toBeUndefined();
  });
});
