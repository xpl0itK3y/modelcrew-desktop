import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetMcpStatus,
  refreshMcpStatus,
  setMcpEnabled,
  useBrowserPluginEnabled,
} from "./mcp";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const STATUS = (enabled: boolean) => ({
  enabled,
  listening: enabled,
  socket: enabled ? "/tmp/mcp.sock" : null,
  tools: ["crew_ping", "browser_open", "browser_navigate"],
});

beforeEach(() => {
  invoke.mockReset();
  forgetMcpStatus();
});

describe("состояние плагина браузера", () => {
  it("до ответа бэкенда считает плагин включённым", () => {
    invoke.mockReturnValue(new Promise(() => {}));

    // Иначе глобус в титлбаре мигал бы на каждом запуске у всех, кто
    // выключателя не трогал: значение по умолчанию — «включено».
    const { result } = renderHook(() => useBrowserPluginEnabled());

    expect(result.current).toBe(true);
  });

  it("выключение доходит до титлбара сразу, без перезапуска", async () => {
    invoke.mockResolvedValueOnce(STATUS(true));
    const { result } = renderHook(() => useBrowserPluginEnabled());
    await act(async () => {
      await refreshMcpStatus();
    });
    expect(result.current).toBe(true);

    invoke.mockResolvedValueOnce(STATUS(false));
    await act(async () => {
      await setMcpEnabled(false);
    });

    expect(result.current).toBe(false);
  });

  it("возвращает плагин на место", async () => {
    invoke.mockResolvedValue(STATUS(false));
    const { result } = renderHook(() => useBrowserPluginEnabled());
    await waitFor(async () => {
      await refreshMcpStatus();
      expect(result.current).toBe(false);
    });

    invoke.mockResolvedValue(STATUS(true));
    await act(async () => {
      await setMcpEnabled(true);
    });

    expect(result.current).toBe(true);
  });
});
