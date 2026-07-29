// Событие от хука агента → сигнал панели. Бэкенд уже привёл полезную
// нагрузку к паре «тип события, текст»; здесь остаётся понять, что это было.

import {
  classifyTerminalNotification,
  type PreciseAgentAlertKind,
  type TerminalAttentionNotification,
} from "./agentAlerts";

export type AgentHookEvent = {
  panelId: string;
  agent: string;
  event: string;
  message: string;
};

// Имена событий у агентов свои, смысл общий. Ключи в нижнем регистре без
// разделителей: «agent-turn-complete», «Stop» и «session.idle» приходят
// каждый в своём написании.
const EVENT_KINDS: Record<string, PreciseAgentAlertKind> = {
  agentturncomplete: "completed", // codex
  approvalrequested: "permission", // codex
  stop: "completed", // claude code и совместимые
  subagentstop: "completed",
  sessionidle: "completed", // opencode
  permissionasked: "permission", // opencode
  permissionprompt: "permission", // copilot
  notification: "waiting",
};

function eventKey(event: string): string {
  return event.toLowerCase().replace(/[^a-z]/g, "");
}

export function agentHookAlert(event: AgentHookEvent): {
  kind: PreciseAgentAlertKind;
  notification: TerminalAttentionNotification;
} | null {
  if (!event.panelId) {
    return null;
  }
  const notification: TerminalAttentionNotification = {
    protocol: "hook",
    title: "",
    body: event.message,
    // Имя события участвует в разборе текста наравне с сообщением: у codex
    // «approval-requested» само по себе говорит, что просят разрешение.
    types: event.event ? [event.event] : [],
  };
  const mapped = EVENT_KINDS[eventKey(event.event)];
  if (mapped === "permission") {
    return { kind: "permission", notification };
  }
  // Текст сообщения точнее имени события: хук «Notification» у Claude Code
  // приходит и на вопрос, и на запрос разрешения.
  const classified = classifyTerminalNotification(notification);
  return {
    kind: classified !== "waiting" ? classified : (mapped ?? "waiting"),
    notification,
  };
}
