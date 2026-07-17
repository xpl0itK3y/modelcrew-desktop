// Уведомления «агент ждёт вас»: звук + системный баннер, когда агент в
// панели закончил работу или просит ответа, а пользователь смотрит не туда
// (окно не в фокусе или панель в скрытой сессии). Сигналы: терминальный
// звонок BEL и тишина после активного вывода.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { AGENTS, getAgentRecord } from "../agents";
import { sendSystemNotification } from "../notifications";
import { playNotificationSound } from "../sound";
import { translate } from "../i18n";
import { loadAgentAlertsEnabled } from "./preferences";

// Состояние сканера между чанками вывода: 0 — обычный поток, 1 — после ESC,
// 2 — внутри OSC (его BEL-терминатор звонком не считается), 3 — ESC в OSC.
export type AttentionScanState = 0 | 1 | 2 | 3;

export function scanTerminalAttention(
  data: string | ArrayBuffer,
  state: AttentionScanState,
): { bells: number; state: AttentionScanState } {
  const bytes =
    typeof data === "string" ? null : new Uint8Array(data);
  const length = bytes ? bytes.length : (data as string).length;
  let bells = 0;
  for (let index = 0; index < length; index += 1) {
    const code = bytes
      ? bytes[index]
      : (data as string).charCodeAt(index);
    switch (state) {
      case 0:
        if (code === 0x1b) {
          state = 1;
        } else if (code === 0x07) {
          bells += 1;
        }
        break;
      case 1:
        state = code === 0x5d /* ] */ ? 2 : 0;
        break;
      case 2:
        if (code === 0x07) {
          state = 0; // BEL завершил OSC — не звонок
        } else if (code === 0x1b) {
          state = 3;
        }
        break;
      case 3:
        state = code === 0x5c /* \\ */ ? 0 : 2;
        break;
    }
  }
  return { bells, state };
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

// ---------- Отправка уведомления ----------

// Повторные сигналы одной панели не чаще, чем раз в этот интервал.
const MIN_ALERT_GAP_MS = 15_000;
const lastAlertAt = new Map<string, number>();

export type AgentAlertKind = "bell" | "idle";

export async function raiseAgentAlert(
  terminalId: string,
  kind: AgentAlertKind,
  panelVisible: boolean,
): Promise<void> {
  if (!loadAgentAlertsEnabled()) {
    return;
  }
  const record = getAgentRecord(terminalId);
  if (!record) {
    return; // в панели не агент — обычные команды не сигналят
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
  if (panelVisible && windowFocused) {
    return;
  }
  lastAlertAt.set(terminalId, now);
  attention.add(terminalId);
  emitAttention();

  const agent =
    AGENTS.find((entry) => entry.id === record.agentId)?.label ??
    record.agentId;
  playNotificationSound();
  void sendSystemNotification(
    translate(
      kind === "bell" ? "terminal.agentWaiting" : "terminal.agentIdle",
      { agent },
    ),
    "",
  );
}
