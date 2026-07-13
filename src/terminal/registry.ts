import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getAppTheme, loadTheme, type ThemeId } from "../theme";
import { localizeBackendError, translate } from "../i18n";
import { loadShell } from "../shell";
import "@xterm/xterm/css/xterm.css";

// Инстансы xterm живут вне React: панель при монтировании подключает
// готовый container-div к своему DOM-узлу. Перенос/своп панелей тогда
// не трогает ни буфер терминала, ни PTY-сессию.

// PTY получает новый размер один раз по окончании перетаскивания.
// Чем чаще SIGWINCH, тем больше zsh перерисовывает промпт — при
// «дёргании» разделителя дубли промпта копятся в буфере.
const RESIZE_DEBOUNCE_MS = 250;

// Плотная сетка → мелкий шрифт. Кегль подбираем от ширины ячейки под
// целевое число колонок и зажимаем в читаемый диапазон: длинный промпт
// перестаёт разворачиваться в лапшу на «максимально много» терминалов, а
// на паре открытых терминалов текст, наоборот, крупнее.
const MIN_FONT_PX = 12;
const MAX_FONT_PX = 14;
const TARGET_COLS = 50;
// Шаг моноширинного глифа ≈ 0.6 кегля (SF Mono / JetBrains Mono).
const CHAR_ADVANCE_RATIO = 0.6;

// В обычном браузере (dev-превью UI) Tauri IPC нет — шелл не поднимаем.
const isTauri = "__TAURI_INTERNALS__" in window;

let currentTerminalTheme = getAppTheme(loadTheme()).terminal;

export type TerminalEntry = {
  id: string;
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  spawned: boolean;
  exited: boolean;
  resizeTimer: number | undefined;
  // Панель переименована руками — автоимя от процесса больше не трогаем.
  manualTitle: boolean;
  // Анимация появления играется только при первом монтировании.
  everAttached: boolean;
};

const registry = new Map<string, TerminalEntry>();

export function applyTerminalTheme(themeId: ThemeId): void {
  currentTerminalTheme = getAppTheme(themeId).terminal;
  for (const entry of registry.values()) {
    entry.term.options.theme = { ...currentTerminalTheme };
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1));
  }
}

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
    theme: { ...currentTerminalTheme },
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
    manualTitle: false,
    everAttached: false,
  };
  registry.set(id, entry);
  return entry;
}

// Единая точка ресайза терминала: сначала подбираем кегль под текущую
// ширину ячейки, затем пересчитываем cols/rows. Скрытый контейнер
// (clientWidth 0) пропускаем — ResizeObserver позовёт снова с размерами.
export function fitTerminal(entry: TerminalEntry): void {
  const width = entry.container.clientWidth;
  if (width <= 0) {
    return;
  }
  const ideal = Math.round(width / (TARGET_COLS * CHAR_ADVANCE_RATIO));
  const fontSize = Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, ideal));
  if (entry.term.options.fontSize !== fontSize) {
    entry.term.options.fontSize = fontSize;
  }
  entry.fit.fit();
}

export function markManualTitle(id: string): void {
  const entry = registry.get(id);
  if (entry) {
    entry.manualTitle = true;
  }
}

export function isManualTitle(id: string): boolean {
  return registry.get(id)?.manualTitle ?? false;
}

// Последнее автоимя (процесс переднего плана) каждого терминала: панели
// скрытых воркспейсов не получают событий, при переключении обратно
// имя доводится из этого кэша.
const autoTitles = new Map<string, string>();

export function rememberAutoTitle(id: string, title: string): void {
  autoTitles.set(id, title);
}

export function getAutoTitle(id: string): string | undefined {
  return autoTitles.get(id);
}

export async function ensureSpawned(
  entry: TerminalEntry,
  workspaceId: string,
): Promise<void> {
  if (entry.spawned) {
    return;
  }
  entry.spawned = true;

  if (!workspaceId) {
    markExited(entry);
    entry.term.write(
      `\x1b[31m${translate("terminal.shellStartFailed", {
        error: translate("terminal.workspaceMissing"),
      })}\x1b[0m\r\n`,
    );
    return;
  }

  if (!isTauri) {
    markExited(entry);
    entry.term.write(
      `\x1b[2m[${translate("terminal.webPreview")}]\x1b[0m\r\n`,
    );
    return;
  }

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
      workspaceId,
      cols: entry.term.cols,
      rows: entry.term.rows,
      // null → бэкенд возьмёт оболочку по умолчанию для ОС.
      shell: loadShell(),
      onOutput: output,
    });
  } catch (error) {
    markExited(entry);
    entry.term.write(
      `\x1b[31m${translate("terminal.shellStartFailed", {
        error: localizeBackendError(error),
      })}\x1b[0m\r\n`,
    );
  }
}

export async function destroyTerminal(id: string): Promise<void> {
  const entry = registry.get(id);
  if (!entry) {
    return;
  }
  registry.delete(id);
  autoTitles.delete(id);
  if (entry.resizeTimer !== undefined) {
    window.clearTimeout(entry.resizeTimer);
  }
  entry.term.dispose();
  entry.container.remove();
  if (!isTauri) {
    return;
  }
  try {
    await invoke("pty_kill", { id });
  } catch {
    // Процесс уже завершился сам — сессии на бэкенде нет.
  }
}

if (isTauri) {
  void listen<{ id: string; code: number | null }>("pty-exit", (event) => {
  const entry = registry.get(event.payload.id);
  if (entry && !entry.exited) {
    markExited(entry);
    const code = event.payload.code;
    const codeLabel =
      code !== null ? ` · ${translate("terminal.exitCode", { code })}` : "";
    entry.term.write(
      `\r\n\x1b[2m[${translate("terminal.processExited")}${codeLabel}]\x1b[0m\r\n`,
    );
  }
  }).catch(() => {
    // Событие может быть недоступно при раннем старте — не критично.
  });
}
