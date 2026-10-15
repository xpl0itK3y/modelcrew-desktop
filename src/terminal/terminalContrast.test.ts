import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // registry читает признак Tauri один раз при импорте модуля.
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  // Снятие панели уходит в бэкенд и ждёт промиса — пустая заглушка роняет
  // уборку между тестами.
  return { invoke: vi.fn(async () => undefined) };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage: ((data: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false }),
}));

import {
  applyTerminalTheme,
  destroyTerminal,
  getOrCreateTerminal,
} from "./registry";

const used: string[] = [];

function panel(id: string) {
  used.push(id);
  return getOrCreateTerminal(id);
}

afterEach(() => {
  for (const id of used.splice(0)) {
    destroyTerminal(id);
  }
  applyTerminalTheme("midnight");
});

describe("keeping agent screens readable", () => {
  it("gives a terminal born on a light theme the contrast floor", () => {
    applyTerminalTheme("porcelain");

    const entry = panel("light-born");

    expect(entry.term.options.minimumContrastRatio).toBe(4.5);
  });

  it("leaves a terminal born on a dark theme alone", () => {
    applyTerminalTheme("obsidian");

    const entry = panel("dark-born");

    expect(entry.term.options.minimumContrastRatio).toBe(1);
  });

  // Агент, запущенный до переключения темы, свои цвета не пересматривает:
  // подпирать его читаемость приходится уже открытому терминалу.
  it("raises and drops the floor under terminals that are already open", () => {
    const entry = panel("switched");

    applyTerminalTheme("parchment");
    expect(entry.term.options.minimumContrastRatio).toBe(4.5);

    applyTerminalTheme("graphite");
    expect(entry.term.options.minimumContrastRatio).toBe(1);
  });
});
