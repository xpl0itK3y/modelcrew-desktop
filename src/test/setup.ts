import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

Object.defineProperty(window, "__TAURI_INTERNALS__", {
  configurable: true,
  value: {},
});

const localStorageValues = new Map<string, string>();
const testLocalStorage: Storage = {
  get length() {
    return localStorageValues.size;
  },
  clear: () => localStorageValues.clear(),
  getItem: (key) => localStorageValues.get(key) ?? null,
  key: (index) => Array.from(localStorageValues.keys())[index] ?? null,
  removeItem: (key) => localStorageValues.delete(key),
  setItem: (key, value) => localStorageValues.set(key, String(value)),
};

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: testLocalStorage,
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: testLocalStorage,
});

if (!window.matchMedia) {
  // jsdom не реализует matchMedia; animations.ts читает его при импорте.
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = (handle: number) =>
    window.clearTimeout(handle);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
