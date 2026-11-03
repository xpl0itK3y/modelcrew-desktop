import { afterEach, describe, expect, it, vi } from "vitest";

// Настоящий WebGL в jsdom не поднимается; подменяем аддон счётчиком живых
// рендереров, чтобы видеть, кто держит контекст.
const mocks = vi.hoisted(() => ({
  live: new Set<object>(),
  lose: new Map<object, () => void>(),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    activate() {
      mocks.live.add(this);
    }
    dispose() {
      mocks.live.delete(this);
    }
    onContextLoss(handler: () => void) {
      mocks.lose.set(this, handler);
      return { dispose: () => {} };
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  Channel: class {
    onmessage: ((data: unknown) => void) | null = null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false }),
}));

import {
  destroyTerminal,
  ensureGpuRenderer,
  getOrCreateTerminal,
  requestFit,
  type TerminalEntry,
} from "./registry";

const created: string[] = [];

function show(id: string): TerminalEntry {
  const entry = getOrCreateTerminal(id);
  created.push(id);
  document.body.appendChild(entry.container);
  ensureGpuRenderer(entry);
  return entry;
}

function hide(entry: TerminalEntry): void {
  entry.container.remove();
}

afterEach(async () => {
  vi.useRealTimers();
  for (const id of created.splice(0)) {
    await destroyTerminal(id);
  }
});

describe("WebGL renderers", () => {
  it("are taken from terminals off screen, the longest gone first", () => {
    const first = show("gpu-first");
    const second = show("gpu-second");
    hide(first);
    hide(second);
    for (let i = 0; i < 11; i += 1) {
      show(`gpu-visible-${i}`);
    }

    // Двенадцать мест: тринадцатый вытеснил давно ушедшую панель.
    expect(mocks.live.size).toBe(12);
    expect(first.webgl).toBeNull();
    expect(second.webgl).not.toBeNull();
  });

  it("are never taken from terminals on screen", () => {
    const shown = Array.from({ length: 13 }, (_, i) => show(`gpu-shown-${i}`));
    // Видимым не отказываем, даже сверх лимита.
    expect(shown.every((entry) => entry.webgl !== null)).toBe(true);
  });

  it("keep a recently shown terminal's renderer when it comes back", () => {
    const entry = show("gpu-returning");
    const renderer = entry.webgl;
    hide(entry);
    document.body.appendChild(entry.container);
    ensureGpuRenderer(entry);
    expect(entry.webgl).toBe(renderer);
  });

  it("come back after the context is lost", () => {
    const entry = show("gpu-lost");
    const renderer = entry.webgl;
    mocks.lose.get(renderer!)?.();
    expect(entry.webgl).toBeNull();
    expect(mocks.live.has(renderer!)).toBe(false);

    ensureGpuRenderer(entry);
    expect(entry.webgl).not.toBeNull();
    expect(entry.webgl).not.toBe(renderer);
  });

  it("are released when the panel closes", async () => {
    const entry = show("gpu-closed");
    const renderer = entry.webgl;
    created.pop();
    await destroyTerminal("gpu-closed");
    expect(mocks.live.has(renderer!)).toBe(false);
  });
});

describe("requestFit", () => {
  it("fits at once, then at most once per interval with the latest size", () => {
    vi.useFakeTimers();
    const entry = show("fit-throttled");
    Object.defineProperty(entry.container, "clientWidth", { value: 800 });
    const fit = vi.spyOn(entry.fit, "fit").mockImplementation(() => {});

    requestFit(entry);
    expect(fit).toHaveBeenCalledTimes(1);

    // Кадры перетаскивания: копятся в один отложенный вызов.
    requestFit(entry);
    requestFit(entry);
    requestFit(entry);
    expect(fit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(fit).toHaveBeenCalledTimes(2);

    // Тишина — лишнего вызова нет.
    vi.advanceTimersByTime(500);
    expect(fit).toHaveBeenCalledTimes(2);
  });
});
