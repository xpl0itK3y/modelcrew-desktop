// Агенты, которые сообщают о себе сами — через свой хук.
//
// У панели такого агента догадки по выводу лишние. Хук называет и событие, и
// текст, и приходит тогда, когда событие случилось. Догадка же выводит тип из
// поведения панели, а тишина в панели чаще всего означает долгий инструмент, а
// не законченную работу. Пока оба канала работали разом, один запрос
// разрешения давал два баннера подряд: сначала ошибочное «закончил или ждёт»
// от тишины, следом точное «ждёт разрешения» от хука — и второй законно
// пробивал окно тишины, потому что был важнее.
//
// Список берётся с бэкенда по факту установленного хука, а не по списку
// поддержанных агентов: хук мог не встать — битый чужой конфиг, недоступный
// каталог, — и тогда догадки остаются единственным источником сигналов, а
// молчать им нельзя.
//
// Списка два, потому что хуки покрывают разное. Конец хода умеют сообщать все
// трое, а вот «жду разрешения» — только claude, через свой `Notification`. У
// copilot и opencode такого события нет вовсе, и единственный сигнал о встав-
// шем запросе — звонок BEL из вывода панели. Заглушить его по одному факту
// «хук есть» значило бы не позвать вообще.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";
import type { AgentAlertKind } from "./alertPolicy";

type HookChannels = { installed: string[]; prompts: string[] };

const channels = new Set<string>();
const promptChannels = new Set<string>();

export async function loadHookChannels(): Promise<void> {
  if (!isTauri) {
    return;
  }
  try {
    const answer = await invoke<HookChannels>("agent_hook_channels");
    for (const agentId of answer.installed) {
      if (agentId) {
        channels.add(agentId);
      }
    }
    for (const agentId of answer.prompts) {
      if (agentId) {
        promptChannels.add(agentId);
      }
    }
  } catch {
    // Не ответил — догадки работают как раньше. Хуже сигналить лишний раз,
    // чем не позвать вовсе.
  }
}

// Событие, которое хук сообщил сам о себе: агент чего-то ждёт, а не просто
// закончил ход. Такое приходит только от хука с покрытием запросов.
const PROMPT_KINDS: ReadonlySet<AgentAlertKind> = new Set<AgentAlertKind>([
  "permission",
  "question",
  "waiting",
  "error",
]);

// Пришедшее событие — самое надёжное доказательство канала: агент только что
// им воспользовался. Нужно там, где хук встал уже после старта приложения и в
// загруженный список попасть не успел. Что именно он умеет, событие тоже
// показывает: сказал про запрос — значит про запросы говорить умеет.
export function noteHookChannel(agentId: string, kind: AgentAlertKind): void {
  if (!agentId) {
    return;
  }
  channels.add(agentId);
  if (PROMPT_KINDS.has(kind)) {
    promptChannels.add(agentId);
  }
}

// Хук есть: догадке по тишине стоит уступить ему первое слово.
export function hasHookChannel(agentId: string): boolean {
  return channels.has(agentId);
}

// Хук расскажет и про запрос разрешения: звонок от такого агента — дубль.
export function hasPromptHookChannel(agentId: string): boolean {
  return promptChannels.has(agentId);
}

export function resetHookChannels(): void {
  channels.clear();
  promptChannels.clear();
}
