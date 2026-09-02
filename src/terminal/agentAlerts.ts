// Уведомления «агент ждёт вас»: панель закончила работу или просит ответа, а
// пользователь смотрит не туда (окно не в фокусе или панель в скрытой сессии).
//
// Здесь только учёт вывода панели и связка решения с отправкой. Разбор потока
// живёт в attentionScanner, правила — в alertPolicy, звук и баннер — в
// alertDelivery, множество ждущих панелей — в attentionStore.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAgentRecord } from "../agents";
import { loadAgentAlertsEnabled } from "./preferences";
import {
  createAttentionScanState,
  scanTerminalAttention,
  type AttentionScanState,
  type TerminalAttentionNotification,
} from "./attentionScanner";
import {
  forgetAlertThrottle,
  isPanelInUse,
  recordDeliveredAlert,
  selectMostImportantNotification,
  shouldThrottleAlert,
  type AgentAlertContext,
  type AgentAlertKind,
} from "./alertPolicy";
import { announceAgentAlert } from "./alertDelivery";
import {
  clearAgentAttention,
  isAgentPanelWaiting,
  markAgentPanelWaiting,
} from "./attentionStore";
import { hasHookChannel, hasPromptHookChannel } from "./hookChannel";

// ---------- Учёт вывода панели ----------

// Минимум «живого» вывода, после которого тишина считается сигналом.
export const AGENT_IDLE_MIN_BYTES = 1_200;
// Тишина после активности, означающая «закончил или ждёт».
export const AGENT_IDLE_QUIET_MS = 6_000;
// Сколько догадка по тишине ждёт хук, когда он у агента есть.
//
// Отменять её совсем нельзя: хук установлен — не значит сработал. Его могли
// отключить в отдельном проекте, CLI мог оказаться форком, читающим другой
// конфиг, — и панель замолчала бы навсегда. Поэтому догадка не отменяется, а
// отступает: успел хук за это время (ему хватает долей секунды) — окно тишины
// погасит её как менее важную, не успел — она позовёт сама.
export const AGENT_HOOK_IDLE_GRACE_MS = 30_000;
// Первые секунды после запуска панели не сигналят: восстановленный TUI
// агента штатно рисует экран и замолкает.
export const SPAWN_ALERT_MUTE_MS = 25_000;
// Столько ждём перерисовку после того, как сами сменили размер панели.
export const AGENT_REDRAW_MUTE_MS = 2_500;

export type AgentAlertTracker = {
  scanState: AttentionScanState;
  activityBytes: number;
  quietTimer: number | undefined;
  // Отсрочка догадки в пользу хука. Отдельно от quietTimer: тот сбрасывается
  // любым выводом, а отступаем мы как раз от панели, которая продолжает
  // подрисовывать строку состояния. В общем слоте отсрочка не доживала до
  // своего срока — её убивал первый же чанк, и панель не звала вовсе.
  hookGraceTimer: number | undefined;
  muteUntil: number;
  // До какого момента ждём перерисовку на наш же ресайз.
  redrawUntil: number;
  // Пользователь что-то печатал в панель в этой сессии. Без этого агент
  // «ждёт» по определению (восстановлен и простаивает) — не событие.
  engaged: boolean;
};

export function createAgentAlertTracker(): AgentAlertTracker {
  return {
    scanState: createAttentionScanState(),
    activityBytes: 0,
    quietTimer: undefined,
    hookGraceTimer: undefined,
    muteUntil: 0,
    redrawUntil: 0,
    engaged: false,
  };
}

export function muteAlertsAfterSpawn(tracker: AgentAlertTracker): void {
  tracker.muteUntil = Date.now() + SPAWN_ALERT_MUTE_MS;
}

/// Панели меняют размер: открыли дерево, открыли файл, потянули разделитель.
///
/// Каждый TUI на это перерисовывает весь экран — тысячи байт разом, и по нашей
/// же вине. Отличить эту перерисовку от ответа агента по самому выводу нельзя,
/// поэтому и не пробуем: мы знаем, что сами её вызвали. Иначе одно движение
/// разделителя звало пользователя из всех панелей сразу — от всех агентов,
/// которым он ничего не писал.
export function muteAlertsWhileRedrawing(tracker: AgentAlertTracker): void {
  tracker.redrawUntil = Date.now() + AGENT_REDRAW_MUTE_MS;
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
      const selected = selectMostImportantNotification(scan.notifications);
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
  if (tracker.quietTimer !== undefined) {
    window.clearTimeout(tracker.quietTimer);
    tracker.quietTimer = undefined;
  }
  // Перерисовка на наш собственный ресайз — не работа агента, и считать её
  // выводом нельзя: звонок и OSC выше по-прежнему проходят, гадаем мы только
  // по объёму.
  if (Date.now() < tracker.redrawUntil) {
    tracker.activityBytes = 0;
    return;
  }
  tracker.activityBytes +=
    typeof data === "string" ? data.length : data.byteLength;
  if (muted) {
    return;
  }
  // Отсчёт тишины ведём после любого вывода, а не только после достаточного.
  // Иначе накопленное не обнулялось никогда: строка состояния агента — проценты
  // контекста, часы квоты — подрисовывает по сотне байт, за минуту простоя их
  // набирается на «ответ», и следующая пауза выглядит как законченная работа.
  tracker.quietTimer = window.setTimeout(() => {
    tracker.quietTimer = undefined;
    const worked = tracker.activityBytes >= AGENT_IDLE_MIN_BYTES;
    tracker.activityBytes = 0;
    if (!worked) {
      return;
    }
    // Панель молчащего агента — это чаще всего долгий инструмент, а не
    // законченная работа. У кого есть хук, тот сейчас и скажет, что произошло
    // на самом деле; отступаем и даём ему сказать первым.
    if (panelHasHookChannel(terminalId)) {
      clearHookGrace(tracker);
      tracker.hookGraceTimer = window.setTimeout(() => {
        tracker.hookGraceTimer = undefined;
        // Пока мы отступали, агент мог снова взяться за работу — тогда звать
        // не о чем, следующая пауза позовёт сама. Подрисовка строки состояния
        // работой не считается: ради неё отсрочка и живёт отдельно.
        if (tracker.activityBytes >= AGENT_IDLE_MIN_BYTES) {
          return;
        }
        void raiseAgentAlert(terminalId, "idle", getContext());
      }, AGENT_HOOK_IDLE_GRACE_MS);
      return;
    }
    void raiseAgentAlert(terminalId, "idle", getContext());
  }, AGENT_IDLE_QUIET_MS);
}

// Рассказывает ли агент этой панели о себе сам. Спрашиваем в момент сигнала, а
// не на каждый чанк вывода: за записью панели стоит чтение хранилища.
function panelHasHookChannel(terminalId: string): boolean {
  const agentId = getAgentRecord(terminalId)?.agentId;
  return agentId !== undefined && hasHookChannel(agentId);
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

// Разговор с панелью окончен. Отметка «ждёт» и окно тишины живут в разных
// модулях, но означают одно, и снимать их порознь нельзя: пока панель числится
// ждущей, окно тишины не истекает вовсе — снял одну отметку без другой, и
// панель замолчала до конца запуска. Поэтому у пары одно имя на всё
// приложение, и мест, где её можно разделить, не осталось.
export function forgetAgentPanel(terminalId: string): void {
  clearAgentAttention(terminalId);
  forgetAlertThrottle(terminalId);
}

function clearHookGrace(tracker: AgentAlertTracker): void {
  if (tracker.hookGraceTimer !== undefined) {
    window.clearTimeout(tracker.hookGraceTimer);
    tracker.hookGraceTimer = undefined;
  }
}

// Пользователь ответил панели: сигнал снят, накопление и таймеры — заново.
export function acknowledgeAgentPanel(
  tracker: AgentAlertTracker,
  terminalId: string,
): void {
  // Разговор закончен: следующий сигнал этой панели должен звучать, даже если
  // он спокойнее предыдущего.
  forgetAgentPanel(terminalId);
  tracker.activityBytes = 0;
  if (tracker.quietTimer !== undefined) {
    window.clearTimeout(tracker.quietTimer);
    tracker.quietTimer = undefined;
  }
  // И отложенную догадку тоже: пользователь уже здесь, а она сработала бы
  // через полминуты после того, как он с панелью разобрался.
  clearHookGrace(tracker);
}

export function disposeAgentAlertTracker(tracker: AgentAlertTracker): void {
  if (tracker.quietTimer !== undefined) {
    window.clearTimeout(tracker.quietTimer);
    tracker.quietTimer = undefined;
  }
  clearHookGrace(tracker);
}

// ---------- От сигнала к уведомлению ----------

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
  // Звонок у агента, чей хук говорит и о запросах, не добавляет ничего: хук
  // назовёт то же событие и назовёт точно. А звучал звонок первым — и следом
  // хук законно пробивал окно тишины как более важный, отчего на одно событие
  // приходило два баннера. Молчащий хук эту панель не потеряет: догадка по
  // тишине не отменена, она лишь отступает на AGENT_HOOK_IDLE_GRACE_MS.
  //
  // Спрашиваем именно про покрытие запросов, а не про сам факт хука. У copilot
  // и opencode хук сообщает только конец хода — заглушив им звонок, мы забрали
  // бы единственный сигнал о вставшем запросе разрешения, и он не дошёл бы
  // никак: ни баннером, ни точкой в шапке, ни счётчиком на колокольчике.
  if (kind === "bell" && hasPromptHookChannel(record.agentId)) {
    return;
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
  let windowFocused = false;
  try {
    windowFocused = await getCurrentWindow().isFocused();
  } catch {
    // Веб-превью: фокус неизвестен, уведомление не шлём.
    return;
  }

  // Молчим ровно в одном случае — пользователь работает прямо в этой панели.
  // Всё остальное зовёт: и панель в скрытой сессии, и соседняя на том же
  // экране. Она может быть видна краем глаза, но смотрят не на неё.
  if (isPanelInUse(context, windowFocused)) {
    return;
  }

  // Ждала ли панель до этого сигнала. Спрашиваем раньше пометки: окно тишины
  // держится именно на неотвеченном сигнале, а пометку мы сейчас поставим сами
  // и ответ на свой же вопрос получили бы всегда утвердительный.
  //
  // Отсюда и параметр у shouldThrottleAlert: сам он это прочитать не может —
  // к моменту проверки отметка уже стоит. Перенести чтение внутрь значит
  // получить там всегда true и заглушить панель навсегда.
  const wasWaiting = isAgentPanelWaiting(terminalId);

  // Отметку ставим до окна тишины: мигающая точка в шапке и счётчик на
  // колокольчике не мешают работе и гаснут не по таймеру, а когда панель
  // выберут. Окно тишины — только про баннеры.
  markAgentPanelWaiting(terminalId);

  // Проверяем окно тишины и сразу занимаем его, не разрывая это ожиданием:
  // пока мы спрашивали про фокус, сигнал той же панели мог дойти до конца, и
  // на одно событие пришло бы два баннера.
  const now = Date.now();
  if (shouldThrottleAlert(terminalId, kind, now, wasWaiting)) {
    return;
  }
  recordDeliveredAlert(terminalId, kind, now);
  announceAgentAlert({ terminalId, agentId, kind, context, notification });
}
