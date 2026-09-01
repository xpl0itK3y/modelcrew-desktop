// Как сигналить: звук, системный баннер, схлопывание пачки и текст на языке
// интерфейса. Решение «сигналить ли вообще» здесь уже принято — им заняты
// alertPolicy и agentAlerts. Единственное место, которое знает про звук,
// уведомления ОС и переводы.

import { AGENTS } from "../agents";
import { sendSystemNotification } from "../notifications";
import { playNotificationSound } from "../sound";
import { translate } from "../i18n";
import { loadAgentAlertDetailMode } from "./preferences";
import type { TerminalAttentionNotification } from "./attentionScanner";
import {
  selectAlertDetail,
  type AgentAlertContext,
  type AgentAlertKind,
} from "./alertPolicy";

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

// Сессия панели. Двух агентов одного вида в одном проекте баннер иначе не
// различает вовсе — заголовок и тело у них совпадают до буквы, и два разных
// события читаются как одно, продублированное. Состав сессий живёт в
// React-состоянии App, поэтому источник, как и имя проекта, регистрируется
// снаружи.
let panelSessionResolver: (terminalId: string) => string | null = () => null;

export function setPanelSessionResolver(
  resolver: (terminalId: string) => string | null,
): void {
  panelSessionResolver = resolver;
}

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

// Сигнал дошёл до пользователя: щелчок и баннер с именем агента и проекта.
export function announceAgentAlert(params: {
  terminalId: string;
  agentId: string;
  kind: AgentAlertKind;
  context: AgentAlertContext;
  notification?: TerminalAttentionNotification;
}): void {
  const agent =
    AGENTS.find((entry) => entry.id === params.agentId)?.label ?? params.agentId;
  const project = params.context.workspaceId
    ? workspaceNameResolver(params.context.workspaceId)
    : null;
  const session = panelSessionResolver(params.terminalId);
  const detail = selectAlertDetail(
    loadAgentAlertDetailMode(),
    params.notification,
    () => panelTailResolver(params.terminalId),
  );
  // Имя панели сюда не идёт: искать её глазами всё равно по мигающей точке в
  // шапке, а баннер и так занят агентом, проектом и текстом самого агента.
  // Сессия — другое дело: у агентских панелей автоимя совпадает с именем
  // агента, и без неё два зовущих claude в одном проекте выглядят как один,
  // позвавший дважды.
  const where = [
    project ? translate("terminal.agentProject", { project }) : "",
    session ? translate("terminal.agentSession", { session }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const body = [where, detail].filter(Boolean).join("\n");
  playNotificationSound();
  queueAlertBanner(
    translate(alertTranslationKey(params.kind), { agent }),
    body,
    [agent, project, session].filter(Boolean).join(" · "),
  );
}

// Агенты часто заканчивают кучно: двенадцать панелей — двенадцать баннеров
// подряд, и разобрать их уже нельзя. Первый показываем сразу, остальные за
// короткое окно собираем в один общий. Звук трогать не нужно: элемент <audio>
// один на приложение и сам перематывается, поэтому пачка звучит одним щелчком.
const ALERT_BURST_MS = 1_500;
// Больше трёх строк в баннере всё равно не читают — остальные прячем за «…».
const MAX_BURST_LINES = 3;

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
