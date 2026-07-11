import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

// Инстансы xterm живут вне React: панель при монтировании подключает
// готовый container-div к своему DOM-узлу. Перенос/своп панелей тогда
// не трогает ни буфер терминала, ни PTY-сессию.

const RESIZE_DEBOUNCE_MS = 100;

export const TERMINAL_BACKGROUND = "#16181d";

const terminalTheme: ITheme = {
  background: TERMINAL_BACKGROUND,
  foreground: "#c9ced8",
  cursor: "#e8eaf0",
  cursorAccent: TERMINAL_BACKGROUND,
  selectionBackground: "rgba(148, 163, 184, 0.28)",
  black: "#20242c",
  red: "#ff7285",
  green: "#4ade80",
  yellow: "#f5c451",
  blue: "#6cabf5",
  magenta: "#c792ea",
  cyan: "#38d1e0",
  white: "#ccd2dd",
  brightBlack: "#59606e",
  brightRed: "#ff8fa3",
  brightGreen: "#71f0ac",
  brightYellow: "#ffd77a",
  brightBlue: "#8fc2ff",
  brightMagenta: "#dcb0ff",
  brightCyan: "#6fe3f0",
  brightWhite: "#eef1f6",
};

export type TerminalEntry = {
  id: string;
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  spawned: boolean;
  exited: boolean;
  resizeTimer: number | undefined;
};

const registry = new Map<string, TerminalEntry>();

// Статус терминала для UI (точка в табе): running → exited.
export type TerminalStatus = "running" | "exited";

type StatusListener = (id: string, status: TerminalStatus) => void;

const statusListeners = new Set<StatusListener>();

export function onTerminalStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function getTerminalStatus(id: string): TerminalStatus {
  return registry.get(id)?.exited ? "exited" : "running";
}

function markExited(entry: TerminalEntry): void {
  entry.exited = true;
  for (const listener of statusListeners) {
    listener(entry.id, "exited");
  }
}

export function getOrCreateTerminal(id: string): TerminalEntry {
  const existing = registry.get(id);
  if (existing) {
    return existing;
  }

  const container = document.createElement("div");
  container.className = "terminal-host";

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily:
      '"SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
    lineHeight: 1.25,
    scrollback: 5000,
    theme: terminalTheme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);

  try {
    const webgl = new WebglAddon();
    // При потере GL-контекста аддон снимается — xterm откатывается на canvas.
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // WebGL недоступен — молча остаёмся на canvas-рендерере.
  }

  const entry: TerminalEntry = {
    id,
    term,
    fit,
    container,
    spawned: false,
    exited: false,
    resizeTimer: undefined,
  };
  registry.set(id, entry);
  return entry;
}

export async function ensureSpawned(entry: TerminalEntry): Promise<void> {
  if (entry.spawned) {
    return;
  }
  entry.spawned = true;

  const output = new Channel<ArrayBuffer | string>();
  output.onmessage = (data) => {
    entry.term.write(
      typeof data === "string" ? data : new Uint8Array(data),
    );
  };

  entry.term.onData((data) => {
    if (!entry.exited) {
      void invoke("pty_write", { id: entry.id, data }).catch(() => {});
    }
  });
  entry.term.onResize(({ cols, rows }) => {
    // fit() дёргается на каждый ресайз контейнера, а PTY получает
    // новый размер один раз по окончании (иначе шторм SIGWINCH).
    if (entry.resizeTimer !== undefined) {
      window.clearTimeout(entry.resizeTimer);
    }
    entry.resizeTimer = window.setTimeout(() => {
      entry.resizeTimer = undefined;
      if (!entry.exited) {
        void invoke("pty_resize", { id: entry.id, cols, rows }).catch(() => {});
      }
    }, RESIZE_DEBOUNCE_MS);
  });

  try {
    await invoke("pty_create", {
      id: entry.id,
      shell: null,
      cwd: null,
      cols: entry.term.cols,
      rows: entry.term.rows,
      onOutput: output,
    });
  } catch (error) {
    markExited(entry);
    entry.term.write(`\x1b[31mНе удалось запустить шелл: ${String(error)}\x1b[0m\r\n`);
  }
}

export async function destroyTerminal(id: string): Promise<void> {
  const entry = registry.get(id);
  if (!entry) {
    return;
  }
  registry.delete(id);
  if (entry.resizeTimer !== undefined) {
    window.clearTimeout(entry.resizeTimer);
  }
  entry.term.dispose();
  entry.container.remove();
  try {
    await invoke("pty_kill", { id });
  } catch {
    // Процесс уже завершился сам — сессии на бэкенде нет.
  }
}

void listen<{ id: string; code: number | null }>("pty-exit", (event) => {
  const entry = registry.get(event.payload.id);
  if (entry && !entry.exited) {
    markExited(entry);
    const code = event.payload.code;
    entry.term.write(
      `\r\n\x1b[2m[процесс завершён${code !== null ? ` · код ${code}` : ""}]\x1b[0m\r\n`,
    );
  }
}).catch(() => {
  // Вне Tauri (обычный браузер) события недоступны — терминалы там и не работают.
});
