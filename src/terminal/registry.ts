import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  discardSnapshot,
  flushSnapshot,
  loadSnapshot,
  markSnapshotDirty,
  registerSnapshotSource,
} from "./snapshots";
import { getAppTheme, loadTheme, type ThemeId } from "../theme";
import { localizeBackendError, translate } from "../i18n";
import { loadShell } from "../shell";
import {
  loadTerminalFontSize,
  normalizeTerminalFontSize,
} from "./preferences";
import "@xterm/xterm/css/xterm.css";

// Инстансы xterm живут вне React: панель при монтировании подключает
// готовый container-div к своему DOM-узлу. Перенос/своп панелей тогда
// не трогает ни буфер терминала, ни PTY-сессию.

// PTY получает новый размер один раз по окончании перетаскивания.
// Чем чаще SIGWINCH, тем больше zsh перерисовывает промпт — при
// «дёргании» разделителя дубли промпта копятся в буфере.
const RESIZE_DEBOUNCE_MS = 250;

// В обычном браузере (dev-превью UI) Tauri IPC нет — шелл не поднимаем.
const isTauri = "__TAURI_INTERNALS__" in window;

let currentTerminalTheme = getAppTheme(loadTheme()).terminal;
let currentTerminalFontSize = loadTerminalFontSize();

export type TerminalEntry = {
  id: string;
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;
  spawned: boolean;
  // Общий promise нужен при быстром remount панели: второй mount должен
  // дождаться того же pty_create, а не потерять раннее имя оболочки.
  spawnPromise: Promise<void> | null;
  exited: boolean;
  workspaceId: string | null;
  outputGeneration: number;
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

export function applyTerminalFontSize(size: number): void {
  currentTerminalFontSize = normalizeTerminalFontSize(size);
  for (const entry of registry.values()) {
    entry.term.options.fontSize = currentTerminalFontSize;
    fitTerminal(entry);
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
    fontSize: currentTerminalFontSize,
    fontFamily:
      '"SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
    lineHeight: 1.25,
    scrollback: 5000,
    theme: { ...currentTerminalTheme },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Снимки текста: сериализатор регистрируется до первого вывода PTY.
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  registerSnapshotSource(id, serialize);
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
    spawnPromise: null,
    exited: false,
    workspaceId: null,
    outputGeneration: 0,
    resizeTimer: undefined,
    manualTitle: false,
    everAttached: false,
  };
  registry.set(id, entry);
  return entry;
}

// Единая точка ресайза терминала. Пользовательский кегль фиксирован,
// здесь только пересчитываем cols/rows. Скрытый контейнер (clientWidth 0)
// пропускаем — ResizeObserver позовёт снова после монтирования.
export function fitTerminal(entry: TerminalEntry): void {
  const width = entry.container.clientWidth;
  if (width <= 0) {
    return;
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

type PtyOutput = ArrayBuffer | string;

type PtyCreateResult = {
  title: string;
};

function writePtyOutput(entry: TerminalEntry, data: PtyOutput): void {
  entry.term.write(typeof data === "string" ? data : new Uint8Array(data));
  markSnapshotDirty(entry.id);
}

function createLiveOutputChannel(
  entry: TerminalEntry,
  generation: number,
): Channel<PtyOutput> {
  const output = new Channel<PtyOutput>();
  output.onmessage = (data) => {
    if (entry.outputGeneration === generation) {
      writePtyOutput(entry, data);
    }
  };
  return output;
}

function runningEntries(): TerminalEntry[] {
  return [...registry.values()].filter(
    (entry) => entry.spawned && !entry.exited && entry.workspaceId !== null,
  );
}

export function getRunningTerminalCount(): number {
  return runningEntries().length;
}

export type RestartTerminalsResult = {
  total: number;
  restarted: number;
  failures: Array<{ id: string; error: unknown }>;
};

async function restartTerminal(
  entry: TerminalEntry,
  shell: string | null,
): Promise<void> {
  const workspaceId = entry.workspaceId;
  if (!workspaceId) {
    throw new Error("Terminal workspace is unavailable");
  }

  // Пока invoke не подтвердил успешный spawn, вывод новой оболочки держим
  // отдельно. Старый PTY остаётся активным и видимым при любой ошибке.
  const generation = entry.outputGeneration + 1;
  const pending: PtyOutput[] = [];
  let committed = false;
  const output = new Channel<PtyOutput>();
  output.onmessage = (data) => {
    if (!committed) {
      pending.push(data);
    } else if (entry.outputGeneration === generation) {
      writePtyOutput(entry, data);
    }
  };

  await invoke("pty_create", {
    id: entry.id,
    workspaceId,
    cols: entry.term.cols,
    rows: entry.term.rows,
    shell,
    onOutput: output,
  });

  // С этого момента старый канал игнорируется. reset очищает и viewport, и
  // scrollback, после чего стартовый вывод нового PTY воспроизводится по порядку.
  entry.outputGeneration = generation;
  entry.term.reset();
  committed = true;
  for (const data of pending) {
    writePtyOutput(entry, data);
  }
}

export async function restartRunningTerminals(
  shell: string | null,
): Promise<RestartTerminalsResult> {
  const entries = runningEntries();
  const settled = await Promise.allSettled(
    entries.map((entry) => restartTerminal(entry, shell)),
  );
  const failures: RestartTerminalsResult["failures"] = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      failures.push({ id: entries[index].id, error: result.reason });
    }
  });
  return {
    total: entries.length,
    restarted: entries.length - failures.length,
    failures,
  };
}

export function ensureSpawned(
  entry: TerminalEntry,
  workspaceId: string,
): Promise<void> {
  if (entry.spawnPromise) {
    return entry.spawnPromise;
  }
  if (entry.spawned) {
    return Promise.resolve();
  }
  entry.spawned = true;
  entry.workspaceId = workspaceId || null;

  const spawnPromise = spawnTerminal(entry, workspaceId);
  entry.spawnPromise = spawnPromise;
  return spawnPromise;
}

async function spawnTerminal(
  entry: TerminalEntry,
  workspaceId: string,
): Promise<void> {
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

  // Восстановление после полного перезапуска: прежний текст панели
  // подкладывается до первого вывода нового PTY.
  const snapshot = await loadSnapshot(entry.id);
  if (snapshot && registry.get(entry.id) === entry && !entry.exited) {
    entry.term.write(snapshot);
    entry.term.write(
      `\r\n\x1b[2m── ${translate("terminal.restored")} ──\x1b[0m\r\n`,
    );
  }

  const generation = entry.outputGeneration + 1;
  entry.outputGeneration = generation;
  const output = createLiveOutputChannel(entry, generation);

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
    const result = await invoke<PtyCreateResult>("pty_create", {
      id: entry.id,
      workspaceId,
      cols: entry.term.cols,
      rows: entry.term.rows,
      // null → бэкенд возьмёт оболочку по умолчанию для ОС.
      shell: loadShell(),
      onOutput: output,
    });
    const title = result.title.trim();
    // Watcher мог успеть прислать более свежее имя foreground-процесса
    // (например, codex) раньше ответа pty_create. Начальное имя оболочки
    // заполняет только пустой кэш и никогда не откатывает свежее значение.
    if (
      title &&
      registry.get(entry.id) === entry &&
      getAutoTitle(entry.id) === undefined
    ) {
      rememberAutoTitle(entry.id, title);
    }
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
  // Закрытие панели — намеренное: её история больше не восстановится.
  discardSnapshot(id);
  entry.outputGeneration += 1;
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
    // Процесс завершился (например, агент) — фиксируем историю сразу.
    void flushSnapshot(entry.id);
  }
  }).catch(() => {
    // Событие может быть недоступно при раннем старте — не критично.
  });
}
