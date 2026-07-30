// Панели, которые ждут ответа пользователя: множество плюс подписка на его
// размер. Отсюда берут число для бейджа на иконке приложения, точку в шапке
// панели и список «кто позвал» в колокольчике.
//
// Своё состояние без звука, баннеров и настроек — UI подписывается на него,
// не притаскивая за собой всю доставку уведомлений.

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

// Кого именно ждут — в порядке появления. Уведомление приходит одно, а дойти
// до панели надо самому: по этому списку колокольчик даёт перейти к ней.
export function getWaitingPanelIds(): string[] {
  return [...attention];
}

// Ждёт ли ответа именно эта панель. Уведомление приходит одно на всех, а
// позвать может любая — по этому признаку её шапка ставит точку. Подписка на
// изменения общая: subscribeAgentAttention зовут при любой правке множества.
export function isAgentPanelWaiting(id: string): boolean {
  return attention.has(id);
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

// Ставится только доставленным сигналом (agentAlerts) — снаружи панель в
// ожидание не переводят. Подавленный сигнал сюда не доходит: бейдж на иконке
// такое же уведомление, и молчать он должен вместе со звуком и баннером.
export function markAgentPanelWaiting(id: string): void {
  if (!attention.has(id)) {
    attention.add(id);
    emitAttention();
  }
}

// Пользователь отреагировал (напечатал в панель, открыл её) — сигнал снят.
export function clearAgentAttention(id: string): void {
  if (attention.delete(id)) {
    emitAttention();
  }
}
