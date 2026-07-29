import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import {
  discardSnapshot,
  flushSnapshot,
  loadSnapshot,
  markSnapshotDirty,
  registerSnapshotSource,
} from "./snapshots";
import {
  buildAgentResume,
  discardAgentRecord,
  getAgentRecord,
  loadAgentResumeMode,
} from "../agents";
import {
  acknowledgeAgentPanel,
  clearAgentAttention,
  createAgentAlertTracker,
  disposeAgentAlertTracker,
  markAgentPanelEngaged,
  muteAlertsAfterSpawn,
  raiseAgentHookAlert,
  setPanelTailResolver,
  trackAgentOutput,
  type AgentAlertTracker,
} from "./agentAlerts";
import { agentHookAlert, type AgentHookEvent } from "./agentHookEvent";
import {
  extractPanelTail,
  joinWrappedRows,
  type PanelRow,
} from "./panelTail";
import { getAppTheme, loadTheme, type ThemeId } from "../theme";
import { localizeBackendError, translate } from "../i18n";
import { loadShell } from "../shell";
import {
  loadTerminalFontSize,
  loadTerminalHistoryIsolation,
  normalizeTerminalFontSize,
} from "./preferences";
import {
  findTerminalDropTargetAtPoint,
  pasteClipboardImage,
  pasteDroppedPaths,
} from "./fileDrop";
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
  // Ввод принимается только после успешного создания PTY.
  inputReady: boolean;
  pasteListener: (event: ClipboardEvent) => void;
  workspaceId: string | null;
  outputGeneration: number;
  resizeTimer: number | undefined;
  // Панель переименована руками — автоимя от процесса больше не трогаем.
  manualTitle: boolean;
  // Анимация появления играется только при первом монтировании.
  everAttached: boolean;
  // Отложенная resume-команда агента: вводится, когда оболочка готова
  // (пауза в выводе после старта), а не вперемешку с её инициализацией.
  pendingResume: string | null;
  resumeTimer: number | undefined;
  // Детекция «агент ждёт»: сканер BEL, накопленный вывод, таймер тишины.
  alerts: AgentAlertTracker;
};

const registry = new Map<string, TerminalEntry>();
let highlightedFileDropTarget: TerminalEntry | null = null;

function setHighlightedFileDropTarget(entry: TerminalEntry | null): void {
  if (highlightedFileDropTarget === entry) {
    return;
  }
  highlightedFileDropTarget?.container.classList.remove("is-file-drop-target");
  highlightedFileDropTarget = entry;
  highlightedFileDropTarget?.container.classList.add("is-file-drop-target");
}

function terminalAtDropPosition(
  event: Extract<DragDropEvent, { type: "enter" | "over" | "drop" }>,
): TerminalEntry | null {
  const direct = findTerminalDropTargetAtPoint(registry.values(), {
    x: event.position.x,
    y: event.position.y,
  });
  if (direct !== null || window.devicePixelRatio === 1) {
    return direct;
  }

  // На macOS WebView позиция уже совпадает с viewport; для платформ,
  // отдающих physical pixels, scaled-вариант остаётся fallback.
  const logical = event.position.toLogical(window.devicePixelRatio);
  return findTerminalDropTargetAtPoint(registry.values(), logical);
}

function handleTerminalDragDrop(event: DragDropEvent): void {
  if (event.type === "leave") {
    setHighlightedFileDropTarget(null);
    return;
  }

  const target = terminalAtDropPosition(event);
  if (event.type === "drop") {
    setHighlightedFileDropTarget(null);
    if (target !== null) {
      pasteDroppedPaths(target, event.paths);
    }
    return;
  }

  setHighlightedFileDropTarget(target);
}

if (isTauri) {
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      handleTerminalDragDrop(event.payload);
    })
    .catch(() => {
      // Drag-and-drop не должен мешать запуску терминалов, если API недоступен.
    });

  // Агент сообщил о себе сам — через свой хук. Это точный сигнал: и тип
  // события, и текст пришли от него, а не выужены из вывода.
  void listen<AgentHookEvent>("agent-event", (event) => {
    const entry = registry.get(event.payload.panelId);
    const alert = entry ? agentHookAlert(event.payload) : null;
    if (!entry || !alert) {
      return;
    }
    void raiseAgentHookAlert(
      entry.id,
      event.payload.agent,
      alert.kind,
      {
        visible: isPanelOnScreen(entry.container),
        workspaceId: entry.workspaceId,
      },
      alert.notification,
    );
  }).catch(() => {
    // Без канала событий остаётся прежний разбор вывода панели.
  });
}

// Пользователь вернулся в окно: панели на экране он теперь видит, их
// сигналы «агент ждёт» сняты. Панели скрытых сессий остаются в счётчике —
// до них взгляд ещё не дошёл.
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    for (const entry of registry.values()) {
      if (entry.container.isConnected) {
        clearAgentAttention(entry.id);
      }
    }
  });
}

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
  entry.inputReady = false;
  if (highlightedFileDropTarget === entry) {
    setHighlightedFileDropTarget(null);
  }
  // Оболочки больше нет — ждать некому.
  acknowledgeAgentPanel(entry.alerts, entry.id);
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
    inputReady: false,
    pasteListener: () => {},
    workspaceId: null,
    outputGeneration: 0,
    resizeTimer: undefined,
    manualTitle: false,
    everAttached: false,
    pendingResume: null,
    resumeTimer: undefined,
    alerts: createAgentAlertTracker(),
  };
  entry.pasteListener = (event) => {
    void pasteClipboardImage(entry, event, (bytes) =>
      invoke<string>("terminal_clipboard_image_save", bytes),
    ).catch((error) => {
      console.error("Clipboard image paste failed", error);
    });
  };
  container.addEventListener("paste", entry.pasteListener, true);
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

// Пауза в выводе после старта оболочки ≈ приглашение напечатано.
const RESUME_QUIET_MS = 350;
// Если оболочка молчит или бесконечно шумит — вводим команду принудительно.
const RESUME_FALLBACK_MS = 3_000;

// Панель, спрятанная развёрнутым соседом, из DOM не уходит: dockview лишь
// обнуляет её размер. Для уведомлений это «не на виду» — иначе агент в
// свёрнутой панели молчал бы, пока окно в фокусе.
export function isPanelOnScreen(container: HTMLElement): boolean {
  return container.isConnected && container.getBoundingClientRect().height > 0;
}

// Сколько строк с конца просматривать в поисках последнего сообщения.
const TAIL_SCAN_ROWS = 40;

// Текст для подробного уведомления, когда агент не прислал своего.
setPanelTailResolver((terminalId) => {
  const entry = registry.get(terminalId);
  if (!entry) {
    return null;
  }
  const buffer = entry.term.buffer.active;
  const rows: PanelRow[] = [];
  for (
    let y = buffer.baseY + buffer.cursorY;
    y >= 0 && rows.length < TAIL_SCAN_ROWS;
    y -= 1
  ) {
    const line = buffer.getLine(y);
    if (!line) {
      continue;
    }
    // Без обрезки хвостовых пробелов: у перенесённой строки они и есть
    // граница слова, а лишние пробелы схлопнет разбор.
    rows.push({ text: line.translateToString(false), wrapped: line.isWrapped });
  }
  return extractPanelTail(joinWrappedRows(rows.reverse()));
});

function injectPendingResume(entry: TerminalEntry): void {
  const data = entry.pendingResume;
  if (data === null) {
    return;
  }
  entry.pendingResume = null;
  if (entry.resumeTimer !== undefined) {
    window.clearTimeout(entry.resumeTimer);
    entry.resumeTimer = undefined;
  }
  if (!entry.exited) {
    void invoke("pty_write", { id: entry.id, data }).catch(() => {});
  }
}

function scheduleResumeInjection(entry: TerminalEntry, quietMs: number): void {
  if (entry.resumeTimer !== undefined) {
    window.clearTimeout(entry.resumeTimer);
  }
  entry.resumeTimer = window.setTimeout(() => {
    entry.resumeTimer = undefined;
    injectPendingResume(entry);
  }, quietMs);
}

function writePtyOutput(entry: TerminalEntry, data: PtyOutput): void {
  entry.term.write(typeof data === "string" ? data : new Uint8Array(data));
  markSnapshotDirty(entry.id);
  if (entry.pendingResume !== null) {
    scheduleResumeInjection(entry, RESUME_QUIET_MS);
  }
  // Детекция «агент ждёт»: принадлежность панели агенту проверяется в
  // момент сигнала, здесь только дешёвый учёт вывода.
  trackAgentOutput(entry.alerts, entry.id, data, () => ({
    visible: isPanelOnScreen(entry.container),
    workspaceId: entry.workspaceId,
  }));
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

// Владелец терминала — для привязки сессий агентов (панель может быть
// скрыта в другой сессии/воркспейсе и отсутствовать в dockview).
export function getTerminalWorkspaceId(id: string): string | null {
  return registry.get(id)?.workspaceId ?? null;
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
    isolatedHistory: loadTerminalHistoryIsolation(),
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
  muteAlertsAfterSpawn(entry.alerts);

  const spawnPromise = spawnTerminal(entry, workspaceId);
  entry.spawnPromise = spawnPromise;
  return spawnPromise;
}

// Один и тот же агент в одной папке: первая восстановленная панель продолжает
// последний диалог, следующие открывают список диалогов агента.
const resumedAgentKeys = new Set<string>();

// Авто-возобновление агента после полного перезапуска приложения: запись
// существует, только если агент был foreground-процессом панели на выходе.
function maybeResumeAgent(entry: TerminalEntry, workspaceId: string): void {
  const mode = loadAgentResumeMode();
  if (mode === "off") {
    return;
  }
  const record = getAgentRecord(entry.id);
  if (!record) {
    return;
  }
  const key = `${workspaceId}:${record.agentId}`;
  const picker = resumedAgentKeys.has(key);
  resumedAgentKeys.add(key);
  const line = buildAgentResume(record, picker);
  if (!line) {
    return;
  }
  // Команда вводится после паузы в выводе (оболочка напечатала приглашение),
  // иначе байты перемешиваются с инициализацией шелла.
  entry.pendingResume = mode === "auto" ? `${line}\r` : line;
  if (mode === "auto") {
    // Команду за пользователя вводим мы, через pty_write мимо xterm, поэтому
    // onData не сработает и панель осталась бы «не тронутой» — а её сигналы
    // тогда молчат до первого нажатия клавиши. Диалог в ней ведёт всё тот же
    // пользователь, и сторожить надо именно такие панели. От шума перерисовки
    // защищает mute первых секунд после спавна.
    markAgentPanelEngaged(entry.alerts, entry.id);
  }
  scheduleResumeInjection(entry, RESUME_FALLBACK_MS);
  // Запись сохраняем: у возобновлённого чата mtime файлов старый, и повторный
  // локатор его не найдёт — точный sessionId должен пережить все рестарты.
  // Если агент не поднимется, watcher сотрёт запись после серии промахов.
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
    // Снимок мог включить приватные режимы прежнего TUI (alt-screen, focus
    // reporting, bracketed paste, application keys) — сбрасываем, иначе xterm
    // начнёт слать focus-события в свежий шелл как ввод (^[[O в приглашении).
    entry.term.write(
      "\x1b[0m\x1b[?1049l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>\x1b[?25h",
    );
    entry.term.write(
      `\r\n\x1b[2m── ${translate("terminal.restored")} ──\x1b[0m\r\n`,
    );
  }

  const generation = entry.outputGeneration + 1;
  entry.outputGeneration = generation;
  const output = createLiveOutputChannel(entry, generation);

  entry.term.onData((data) => {
    // Пользователь работает с панелью: сигнал «ждёт» снят, отсчёт заново,
    // и с этого момента её сигналы вообще имеют смысл.
    markAgentPanelEngaged(entry.alerts, entry.id);
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
      isolatedHistory: loadTerminalHistoryIsolation(),
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
    if (registry.get(entry.id) === entry && !entry.exited) {
      entry.inputReady = true;
    }
    maybeResumeAgent(entry, workspaceId);
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
  if (highlightedFileDropTarget === entry) {
    setHighlightedFileDropTarget(null);
  }
  registry.delete(id);
  autoTitles.delete(id);
  // Закрытие панели — намеренное: её история больше не восстановится.
  discardSnapshot(id);
  discardAgentRecord(id);
  clearAgentAttention(id);
  entry.outputGeneration += 1;
  if (entry.resizeTimer !== undefined) {
    window.clearTimeout(entry.resizeTimer);
  }
  if (entry.resumeTimer !== undefined) {
    window.clearTimeout(entry.resumeTimer);
  }
  disposeAgentAlertTracker(entry.alerts);
  entry.container.removeEventListener("paste", entry.pasteListener, true);
  entry.pendingResume = null;
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
