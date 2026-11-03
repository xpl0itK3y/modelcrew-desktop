// Опрос реестра заявок: когда он ходит к бэкенду, а когда молчит.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  return { invoke: vi.fn(async () => []) };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { watchPanelClaims } from "./claimPolling";

let hidden = false;

function setHidden(value: boolean): void {
  hidden = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  mocks.invoke.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchPanelClaims", () => {
  it("stops asking while the window is hidden and catches up when it returns", () => {
    const stop = watchPanelClaims("workspace-1");
    expect(mocks.invoke).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);

    setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);

    // Окно снова на виду: опрос сразу, не дожидаясь тика.
    setHidden(false);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);

    stop();
    setHidden(true);
    setHidden(false);
    vi.advanceTimersByTime(5_000);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });
});
