// Уведомления «агент ждёт вас»: звук + системный баннер, когда агент в
// панели закончил работу или просит ответа, а пользователь смотрит не туда
// (окно не в фокусе или панель в скрытой сессии). Точные сигналы приходят
// через terminal notification OSC; BEL и тишина остаются fallback.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { AGENTS, getAgentRecord } from "../agents";
import { sendSystemNotification } from "../notifications";
import { playNotificationSound } from "../sound";
import { translate } from "../i18n";
import {
  loadAgentAlertDetailMode,
  loadAgentAlertsEnabled,
} from "./preferences";

type AttentionScanMode = 0 | 1 | 2 | 3;

type KittyNotificationDraft = {
  title: string;
  body: string;
  types: string[];
};

// OSC может быть разорван на произвольной границе PTY-чанка. Храним только
// небольшой ограниченный payload и незавершённые части chunked OSC 99.
export type AttentionScanState = {
  mode: AttentionScanMode;
  osc: string;
  oscOverflow: boolean;
  kitty: Record<string, KittyNotificationDraft>;
  // PTY отдаёт сырые байты. Декодируем поток в UTF-8 до разбора, иначе текст
  // уведомления собирается по байту на символ и кириллица превращается в
  // «Ð°Ð½Ð°Ð»Ð¾Ð³». Декодер потоковый: многобайтовый символ переживает
  // границу чанка. Поле необязательное и создаётся лениво — состояние живёт
  // в панели дольше самого модуля (hot reload в dev), и обращение к
  // несуществующему декодеру глушило бы такой панели все сигналы разом.
  decoder?: TextDecoder;
};

export type TerminalAttentionNotification = {
  // "hook" — событие пришло от самого агента через его хук, а не из вывода.
  protocol: "osc9" | "osc99" | "osc777" | "hook";
  title: string;
  body: string;
  types: string[];
};

const MAX_OSC_CHARS = 16_384;
const MAX_KITTY_DRAFTS = 8;

export function createAttentionScanState(): AttentionScanState {
  return {
    mode: 0,
    osc: "",
    oscOverflow: false,
    kitty: {},
    decoder: new TextDecoder(),
  };
}

function cleanNotificationText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
}

function decodeBase64Utf8(value: string): string {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function parseOsc99(
  payload: string,
  state: AttentionScanState,
): TerminalAttentionNotification | null {
  const metadataEnd = payload.indexOf(";", 3);
  if (metadataEnd < 0) {
    return null;
  }
  const metadata = payload.slice(3, metadataEnd);
  const rawPayload = payload.slice(metadataEnd + 1);
  const fields = metadata.split(":").map((field) => {
    const separator = field.indexOf("=");
    return separator < 0
      ? ([field, ""] as const)
      : ([field.slice(0, separator), field.slice(separator + 1)] as const);
  });
  const valueOf = (key: string) =>
    fields.find(([fieldKey]) => fieldKey === key)?.[1];
  const encoded = valueOf("e") === "1";
  const part = valueOf("p") ?? "title";
  if (part !== "title" && part !== "body") {
    return null;
  }

  const id = valueOf("i") || "__anonymous";
  const existing = state.kitty[id] ?? { title: "", body: "", types: [] };
  const decodedPayload = cleanNotificationText(
    encoded ? decodeBase64Utf8(rawPayload) : rawPayload,
  );
  existing[part] = (existing[part] + decodedPayload).slice(0, MAX_OSC_CHARS);
  for (const [, rawType] of fields.filter(([key]) => key === "t")) {
    const decodedType = cleanNotificationText(decodeBase64Utf8(rawType));
    if (
      decodedType &&
      existing.types.length < MAX_KITTY_DRAFTS &&
      !existing.types.includes(decodedType)
    ) {
      existing.types.push(decodedType);
    }
  }
  state.kitty[id] = existing;

  const ids = Object.keys(state.kitty);
  if (ids.length > MAX_KITTY_DRAFTS) {
    delete state.kitty[ids[0]];
  }
  if (valueOf("d") === "0") {
    return null;
  }
  delete state.kitty[id];
  if (!existing.title && !existing.body) {
    return null;
  }
  return {
    protocol: "osc99",
    title: existing.title,
    body: existing.body,
    types: existing.types,
  };
}

function parseTerminalNotification(
  payload: string,
  state: AttentionScanState,
): TerminalAttentionNotification | null {
  if (payload.startsWith("9;") && !payload.startsWith("9;4;")) {
    const title = cleanNotificationText(payload.slice(2));
    return title ? { protocol: "osc9", title, body: "", types: [] } : null;
  }
  if (payload.startsWith("777;notify;")) {
    const parts = payload.slice("777;notify;".length).split(";");
    const title = cleanNotificationText(parts.shift() ?? "");
    const body = cleanNotificationText(parts.join(";"));
    return title || body
      ? { protocol: "osc777", title, body, types: [] }
      : null;
  }
  if (payload.startsWith("99;")) {
    return parseOsc99(payload, state);
  }
  return null;
}

function finishOsc(
  state: AttentionScanState,
): TerminalAttentionNotification | null {
  const notification = state.oscOverflow
    ? null
    : parseTerminalNotification(state.osc, state);
  state.mode = 0;
  state.osc = "";
  state.oscOverflow = false;
  return notification;
}

export function scanTerminalAttention(
  data: string | ArrayBuffer,
  state: AttentionScanState,
): {
  bells: number;
  notifications: TerminalAttentionNotification[];
  state: AttentionScanState;
} {
  const text =
    typeof data === "string"
      ? data
      : (state.decoder ??= new TextDecoder()).decode(new Uint8Array(data), {
          stream: true,
        });
  let bells = 0;
  const notifications: TerminalAttentionNotification[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    switch (state.mode) {
      case 0:
        if (code === 0x1b) {
          state.mode = 1;
        } else if (code === 0x07) {
          bells += 1;
        }
        break;
      case 1:
        if (code === 0x5d /* ] */) {
          state.mode = 2;
          state.osc = "";
          state.oscOverflow = false;
        } else {
          state.mode = 0;
        }
        break;
      case 2:
        if (code === 0x07) {
          const notification = finishOsc(state);
          if (notification) {
            notifications.push(notification);
          }
        } else if (code === 0x1b) {
          state.mode = 3;
        } else if (!state.oscOverflow) {
          if (state.osc.length < MAX_OSC_CHARS) {
            state.osc += String.fromCharCode(code);
          } else {
            state.oscOverflow = true;
            state.osc = "";
          }
        }
        break;
      case 3:
        if (code === 0x5c /* \\ */) {
          const notification = finishOsc(state);
          if (notification) {
            notifications.push(notification);
          }
        } else if (code === 0x5d /* ] */) {
          // Начался следующий OSC — предыдущий оборван, его текст уже не
          // склеить с новым.
          state.mode = 2;
          state.osc = "";
          state.oscOverflow = false;
        } else {
          // ESC начал другую последовательность (обычно CSI): OSC оборван.
          // Оставаться внутри него нельзя — тогда сканер съест следующий BEL
          // как терминатор, и звонок агента потеряется.
          state.mode = 0;
          state.osc = "";
          state.oscOverflow = false;
        }
        break;
    }
  }
  return { bells, notifications, state };
}

// ---------- Панели, ждущие внимания (для бейджа на иконке) ----------

const attention = new Set<string>();
const listeners = new Set<(count: number) => void>();

function emitAttention(): void {
  for (const listener of listeners) {
    listener(attention.size);
  }
}

export function getAgentAttentionCount(): number {
  return attention.size;
}

export function subscribeAgentAttention(
  listener: (count: number) => void,
): () => void {
  listeners.add(listener);
  listener(attention.size);
  return () => {
    listeners.delete(listener);
  };
}

// Пользователь отреагировал (напечатал в панель, открыл её) — сигнал снят.
export function clearAgentAttention(id: string): void {
  if (attention.delete(id)) {
    emitAttention();
  }
}

// ---------- Учёт вывода панели ----------

// Минимум «живого» вывода, после которого тишина считается сигналом.
export const AGENT_IDLE_MIN_BYTES = 1_200;
// Тишина после активности, означающая «закончил или ждёт».
export const AGENT_IDLE_QUIET_MS = 6_000;
// Первые секунды после запуска панели не сигналят: восстановленный TUI
// агента штатно рисует экран и замолкает.
export const SPAWN_ALERT_MUTE_MS = 25_000;

export type AgentAlertTracker = {
  scanState: AttentionScanState;
  activityBytes: number;
  quietTimer: number | undefined;
  muteUntil: number;
  // Пользователь что-то печатал в панель в этой сессии. Без этого агент
  // «ждёт» по определению (восстановлен и простаивает) — не событие.
  engaged: boolean;
};

export function createAgentAlertTracker(): AgentAlertTracker {
  return {
    scanState: createAttentionScanState(),
    activityBytes: 0,
    quietTimer: undefined,
    muteUntil: 0,
    engaged: false,
  };
}

export function muteAlertsAfterSpawn(tracker: AgentAlertTracker): void {
  tracker.muteUntil = Date.now() + SPAWN_ALERT_MUTE_MS;
}

// Контекст панели в момент сигнала: видимость и владелец-проект.
export type AgentAlertContext = {
  visible: boolean;
  workspaceId: string | null;
};

export type PreciseAgentAlertKind =
  "permission" | "question" | "completed" | "error" | "waiting";

const MAX_AGENT_ALERT_DETAIL_CHARS = 200;

export function formatAgentAlertDetail(
  notification: TerminalAttentionNotification,
): string {
  return formatAlertDetailText(notification.body || notification.title);
}

function formatAlertDetailText(value: string): string {
  const normalized = cleanNotificationText(value).replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  if (characters.length <= MAX_AGENT_ALERT_DETAIL_CHARS) {
    return normalized;
  }
  return `${characters.slice(0, MAX_AGENT_ALERT_DETAIL_CHARS - 3).join("")}...`;
}

export function classifyTerminalNotification(
  notification: TerminalAttentionNotification,
): PreciseAgentAlertKind {
  const text = [...notification.types, notification.title, notification.body]
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (
    /\b(error|failed|failure|quota|rate limit|unauthorized|authentication)\b/.test(
      text,
    )
  ) {
    return "error";
  }
  if (/\b(permission|approval|approve|confirmation|confirm)\b/.test(text)) {
    return "permission";
  }
  if (
    /\b(question|answer|input|elicitation|plan mode prompt|idle prompt)\b/.test(
      text,
    )
  ) {
    return "question";
  }
  if (
    /\b(complete|completed|done|finished|ready|task completed|agent turn complete)\b/.test(
      text,
    )
  ) {
    return "completed";
  }
  return "waiting";
}

function mostImportantNotification(
  notifications: TerminalAttentionNotification[],
): {
  kind: PreciseAgentAlertKind;
  notification: TerminalAttentionNotification;
} {
  const priority: Record<PreciseAgentAlertKind, number> = {
    error: 5,
    permission: 4,
    question: 3,
    waiting: 2,
    completed: 1,
  };
  return notifications
    .map((notification) => ({
      kind: classifyTerminalNotification(notification),
      notification,
    }))
    .reduce((selected, candidate) =>
      priority[candidate.kind] > priority[selected.kind] ? candidate : selected,
    );
}

// Живой вывод PTY: structured OSC даёт точный тип, звонок BEL — мгновенный
// fallback, тишина после активного вывода — отложенный fallback. Контекст
// читается в момент срабатывания: панель могла смениться за время тишины.
export function trackAgentOutput(
  tracker: AgentAlertTracker,
  terminalId: string,
  data: string | ArrayBuffer,
  getContext: () => AgentAlertContext,
): void {
  // Состояние сканера OSC/BEL ведём всегда — иначе разрывы между чанками
  // сломают разбор после того, как пользователь начнёт работать.
  const scan = scanTerminalAttention(data, tracker.scanState);
  tracker.scanState = scan.state;
  const muted = Date.now() < tracker.muteUntil;
  if (scan.notifications.length > 0) {
    tracker.activityBytes = 0;
    if (tracker.quietTimer !== undefined) {
      window.clearTimeout(tracker.quietTimer);
      tracker.quietTimer = undefined;
    }
    if (!muted) {
      const selected = mostImportantNotification(scan.notifications);
      void raiseAgentAlert(
        terminalId,
        selected.kind,
        getContext(),
        selected.notification,
      );
    }
    return;
  }
  // Пока пользователь не работал с панелью, её вывод не повод сигналить:
  // восстановленный агент простаивает штатно.
  if (!tracker.engaged) {
    return;
  }
  if (scan.bells > 0 && !muted) {
    void raiseAgentAlert(terminalId, "bell", getContext());
  }
  tracker.activityBytes +=
    typeof data === "string" ? data.length : data.byteLength;
  if (tracker.quietTimer !== undefined) {
    window.clearTimeout(tracker.quietTimer);
    tracker.quietTimer = undefined;
  }
  if (tracker.activityBytes >= AGENT_IDLE_MIN_BYTES && !muted) {
    tracker.quietTimer = window.setTimeout(() => {
      tracker.quietTimer = undefined;
      tracker.activityBytes = 0;
      void raiseAgentAlert(terminalId, "idle", getContext());
    }, AGENT_IDLE_QUIET_MS);
  }
}

// Пользователь напечатал в панель: с этого момента её сигналы имеют смысл.
// Заодно сбрасываем накопление и таймер тишины — идёт живой ввод.
export function markAgentPanelEngaged(
  tracker: AgentAlertTracker,
  terminalId: string,
): void {
  tracker.engaged = true;
  acknowledgeAgentPanel(tracker, terminalId);
}

// Пользователь ответил панели: сигнал снят, накопление и таймер — заново.
export function acknowledgeAgentPanel(
  tracker: AgentAlertTracker,
  terminalId: string,
): void {
  clearAgentAttention(terminalId);
  tracker.activityBytes = 0;
  if (tracker.quietTimer !== undefined) {
    window.clearTimeout(tracker.quietTimer);
    tracker.quietTimer = undefined;
  }
}

export function disposeAgentAlertTracker(tracker: AgentAlertTracker): void {
  if (tracker.quietTimer !== undefined) {
    window.clearTimeout(tracker.quietTimer);
    tracker.quietTimer = undefined;
  }
}

// ---------- Отправка уведомления ----------

// Имя проекта по id воркспейса: список проектов живёт в React-состоянии
// App, модуль получает к нему доступ через зарегистрированный резолвер.
let workspaceNameResolver: (workspaceId: string) => string | null = () => null;

export function setWorkspaceNameResolver(
  resolver: (workspaceId: string) => string | null,
): void {
  workspaceNameResolver = resolver;
}

// Последние осмысленные строки панели: звонок и тишина своего текста не
// несут, а «Подробно» без текста ничем не отличается от «Кратко». Источник
// регистрируется снаружи — реестр терминалов сам импортирует этот модуль.
let panelTailResolver: (terminalId: string) => string | null = () => null;

export function setPanelTailResolver(
  resolver: (terminalId: string) => string | null,
): void {
  panelTailResolver = resolver;
}

// Повторные сигналы одной панели не чаще, чем раз в этот интервал.
const MIN_ALERT_GAP_MS = 15_000;
const lastAlertAt = new Map<string, number>();

export type AgentAlertKind = PreciseAgentAlertKind | "bell" | "idle";

function alertTranslationKey(kind: AgentAlertKind) {
  switch (kind) {
    case "permission":
      return "terminal.agentPermission" as const;
    case "question":
      return "terminal.agentQuestion" as const;
    case "completed":
      return "terminal.agentCompleted" as const;
    case "error":
      return "terminal.agentError" as const;
    case "waiting":
    case "bell":
      return "terminal.agentWaiting" as const;
    case "idle":
      return "terminal.agentIdle" as const;
  }
}

export async function raiseAgentAlert(
  terminalId: string,
  kind: AgentAlertKind,
  context: AgentAlertContext,
  notification?: TerminalAttentionNotification,
): Promise<void> {
  const record = getAgentRecord(terminalId);
  if (!record) {
    return; // в панели не агент — обычные команды не сигналят
  }
  return deliverAgentAlert(
    terminalId,
    record.agentId,
    kind,
    context,
    notification,
  );
}

// Сигнал пришёл от самого агента через его хук: панель заведомо агентская,
// даже если watcher ещё не успел записать имя процесса, и тип события с
// текстом точные — гадать по выводу не нужно.
export async function raiseAgentHookAlert(
  terminalId: string,
  agentId: string,
  kind: AgentAlertKind,
  context: AgentAlertContext,
  notification: TerminalAttentionNotification,
): Promise<void> {
  return deliverAgentAlert(terminalId, agentId, kind, context, notification);
}

async function deliverAgentAlert(
  terminalId: string,
  agentId: string,
  kind: AgentAlertKind,
  context: AgentAlertContext,
  notification?: TerminalAttentionNotification,
): Promise<void> {
  if (!loadAgentAlertsEnabled()) {
    return;
  }
  const now = Date.now();
  if (now - (lastAlertAt.get(terminalId) ?? 0) < MIN_ALERT_GAP_MS) {
    return;
  }
  // Пользователь и так смотрит на панель — не спамим.
  let windowFocused = false;
  try {
    windowFocused = await getCurrentWindow().isFocused();
  } catch {
    // Веб-превью: фокус неизвестен, уведомление не шлём.
    return;
  }
  if (context.visible && windowFocused) {
    return;
  }
  lastAlertAt.set(terminalId, now);
  attention.add(terminalId);
  emitAttention();

  const agent =
    AGENTS.find((entry) => entry.id === agentId)?.label ?? agentId;
  const project = context.workspaceId
    ? workspaceNameResolver(context.workspaceId)
    : null;
  const detail =
    loadAgentAlertDetailMode() !== "detailed"
      ? ""
      : notification
        ? formatAgentAlertDetail(notification)
        : formatAlertDetailText(panelTailResolver(terminalId) ?? "");
  const body = [
    project ? translate("terminal.agentProject", { project }) : "",
    detail,
  ]
    .filter(Boolean)
    .join("\n");
  playNotificationSound();
  queueAlertBanner(
    translate(alertTranslationKey(kind), { agent }),
    body,
    [agent, project].filter(Boolean).join(" · "),
  );
}

// Агенты часто заканчивают кучно: двенадцать панелей — двенадцать баннеров
// подряд, и разобрать их уже нельзя. Первый показываем сразу, остальные за
// короткое окно собираем в один общий. Звук трогать не нужно: элемент <audio>
// один на приложение и сам перематывается, поэтому пачка звучит одним щелчком.
const ALERT_BURST_MS = 1_500;
// Больше трёх строк в баннере всё равно не читают — остальные прячем за «…».

type PendingBanner = { title: string; body: string; line: string };

let burst: PendingBanner[] = [];
let burstTimer: number | undefined;

function queueAlertBanner(title: string, body: string, line: string): void {
  if (burstTimer !== undefined) {
    burst.push({ title, body, line });
    return;
  }
  burst = [];
  burstTimer = window.setTimeout(flushAlertBurst, ALERT_BURST_MS);
  void sendSystemNotification(title, body);
}

// Сбрасывает окно схлопывания вместе с накопленным: пачка привязана к
// текущему прогону, тащить её через перезапуск таймеров незачем.
export function resetAgentAlertBurst(): void {
  if (burstTimer !== undefined) {
    window.clearTimeout(burstTimer);
    burstTimer = undefined;
  }
  burst = [];
}

function flushAlertBurst(): void {
  burstTimer = undefined;
  const pending = burst;
  burst = [];
  if (pending.length === 0) {
    return;
  }
  // Один отставший — показываем его как обычно, сводка тут была бы страннее.
  if (pending.length === 1) {
    void sendSystemNotification(pending[0].title, pending[0].body);
    return;
  }
  const lines = pending.slice(0, MAX_BURST_LINES).map((item) => item.line);
  if (pending.length > lines.length) {
    lines.push("…");
  }
  void sendSystemNotification(
    translate("terminal.agentsWaitingMore", { count: pending.length }),
    lines.join("\n"),
  );
}

const MAX_BURST_LINES = 3;
