// Когда сигналить и о чём именно. Только решения: тип события, его важность,
// окно тишины, смотрит ли пользователь на панель, сколько текста агента
// показывать. Ни звука, ни баннеров, ни переводов — их берёт на себя
// alertDelivery, поэтому здешние правила проверяются без единого мока.

import type { AgentAlertDetailMode } from "./preferences";
import {
  cleanNotificationText,
  type TerminalAttentionNotification,
} from "./attentionScanner";

export type PreciseAgentAlertKind =
  | "permission"
  | "question"
  | "completed"
  | "error"
  | "waiting";

export type AgentAlertKind = PreciseAgentAlertKind | "bell" | "idle";

// Контекст панели в момент сигнала: видимость, ввод и владелец-проект.
export type AgentAlertContext = {
  // Панель на экране: не в скрытой сессии и не спрятана развёрнутым соседом.
  visible: boolean;
  // Ввод сейчас в этой панели — то есть пользователь работает именно в ней.
  focused: boolean;
  workspaceId: string | null;
};

// Насколько сигнал требователен к пользователю. По этому же порядку из пачки
// уведомлений одного чанка выбирается главное и решается, стоит ли тревожить
// повторно: «закончил» после «нужно разрешение» — это тот же разговор, а вот
// «нужно разрешение» после «закончил» означает, что работа встала. Догадки
// стоят там же, где точные сигналы, которые они заменяют: звонок — это
// «ждёт», тишина — «закончил».
const ALERT_PRIORITY: Record<AgentAlertKind, number> = {
  error: 5,
  permission: 4,
  question: 3,
  waiting: 2,
  bell: 2,
  completed: 1,
  idle: 1,
};

export function alertPriority(kind: AgentAlertKind): number {
  return ALERT_PRIORITY[kind];
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

// Из пачки уведомлений одного чанка беспокоить стоит самым требовательным.
export function selectMostImportantNotification(
  notifications: TerminalAttentionNotification[],
): {
  kind: PreciseAgentAlertKind;
  notification: TerminalAttentionNotification;
} {
  return notifications
    .map((notification) => ({
      kind: classifyTerminalNotification(notification),
      notification,
    }))
    .reduce((selected, candidate) =>
      ALERT_PRIORITY[candidate.kind] > ALERT_PRIORITY[selected.kind]
        ? candidate
        : selected,
    );
}

// Пользователь прямо в этой панели: она на экране, ввод у неё, окно активно.
// Единственный случай, когда звать некуда — он уже здесь.
//
// Все три условия обязательны. «Панель видно» само по себе ничего не значит:
// на экране их дюжина, а работают в одной, и молчать из-за того, что соседняя
// панель попала в поле зрения, — это терять закончившего агента. «Ввод в
// панели» без видимости тоже не считается: придавленная развёрнутым соседом
// панель держит каретку, но её не видно. А неактивное окно снимает вопрос
// целиком — пользователя нет ни в одной панели.
export function isPanelInUse(
  context: AgentAlertContext,
  windowFocused: boolean,
): boolean {
  return context.visible && context.focused && windowFocused;
}

// ---------- Окно тишины ----------

// Повторные сигналы одной панели не чаще, чем раз в этот интервал.
export const MIN_ALERT_GAP_MS = 15_000;

type DeliveredAlert = { at: number; priority: number };

const lastAlert = new Map<string, DeliveredAlert>();

// Внутри окна тишины пропускаем только то, что требовательнее уже показанного:
// иначе запрос разрешения, пришедший через секунду после «закончил», пропал бы
// молча, и пользователь ушёл бы от вставшего агента.
export function shouldThrottleAlert(
  terminalId: string,
  kind: AgentAlertKind,
  now: number,
): boolean {
  const previous = lastAlert.get(terminalId);
  if (!previous || now - previous.at >= MIN_ALERT_GAP_MS) {
    return false;
  }
  return ALERT_PRIORITY[kind] <= previous.priority;
}

// Окно занимает только дошедший до пользователя сигнал: смолчавший — из-за
// выключенных уведомлений или потому что панель на виду — не должен запирать
// следующий на пятнадцать секунд.
export function recordDeliveredAlert(
  terminalId: string,
  kind: AgentAlertKind,
  now: number,
): void {
  lastAlert.set(terminalId, { at: now, priority: ALERT_PRIORITY[kind] });
}

export function resetAlertThrottle(): void {
  lastAlert.clear();
}

// ---------- Текст агента в баннере ----------

const MAX_AGENT_ALERT_DETAIL_CHARS = 200;

export function formatAgentAlertDetail(
  notification: TerminalAttentionNotification,
): string {
  return formatAlertDetailText(notification.body || notification.title);
}

export function formatAlertDetailText(value: string): string {
  const normalized = cleanNotificationText(value).replace(/\s+/g, " ");
  const characters = Array.from(normalized);
  if (characters.length <= MAX_AGENT_ALERT_DETAIL_CHARS) {
    return normalized;
  }
  return `${characters.slice(0, MAX_AGENT_ALERT_DETAIL_CHARS - 3).join("")}...`;
}

// Что попадёт в тело баннера под именем проекта. В кратком режиме — ничего.
// В подробном берём текст самого агента, а для догадок (звонок, тишина) — его
// же последние строки панели: сырой вывод терминала в баннер не уходит никогда,
// только уже очищенный и урезанный текст.
//
// Хвост панели передаётся функцией, а не готовой строкой: собрать его — значит
// пройти сорок строк буфера xterm и разобрать переносы, и делать это на каждый
// сигнал, чтобы затем выбросить, незачем.
export function selectAlertDetail(
  mode: AgentAlertDetailMode,
  notification: TerminalAttentionNotification | undefined,
  getPanelTail: () => string | null,
): string {
  if (mode !== "detailed") {
    return "";
  }
  return notification
    ? formatAgentAlertDetail(notification)
    : formatAlertDetailText(getPanelTail() ?? "");
}
