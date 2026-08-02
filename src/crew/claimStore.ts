// Какие файлы держит каждая панель проекта: то, что показывается в её шапке.
//
// Своё состояние без запросов и без UI — компоненты подписываются на него, не
// притаскивая за собой ни IPC, ни таймеров. Источник наполняет стор снаружи,
// как это уже сделано для ждущих панелей (attentionStore).

export type PanelClaims = {
  // Пути, которые панель держит, в порядке появления.
  held: string[];
  // Файл, которого панель ждёт: он занят соседом, и агент ушёл в другие.
  waitingFor: string | null;
  // Кто-то ждёт файлов этой панели — держателю стоит их отпустить.
  awaited: boolean;
};

const EMPTY: PanelClaims = { held: [], waitingFor: null, awaited: false };

const byPanel = new Map<string, PanelClaims>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getPanelClaims(panelId: string): PanelClaims {
  return byPanel.get(panelId) ?? EMPTY;
}

export function subscribePanelClaims(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Полная замена состояния проекта: реестр присылает срез целиком, потому что
// заявки снимаются пачками (конец хода отпускает всё сразу), и собирать это
// из отдельных событий значило бы разъезжаться с бэкендом при первой потере.
export function setPanelClaims(next: Map<string, PanelClaims>): void {
  if (sameState(next)) {
    return;
  }
  byPanel.clear();
  for (const [panelId, claims] of next) {
    byPanel.set(panelId, claims);
  }
  emit();
}

export function clearPanelClaims(): void {
  if (byPanel.size === 0) {
    return;
  }
  byPanel.clear();
  emit();
}

// Срез приходит по таймеру, а меняется редко: сравнение экономит перерисовку
// дюжины шапок на каждом тике.
function sameState(next: Map<string, PanelClaims>): boolean {
  if (next.size !== byPanel.size) {
    return false;
  }
  for (const [panelId, claims] of next) {
    const current = byPanel.get(panelId);
    if (
      !current ||
      current.waitingFor !== claims.waitingFor ||
      current.awaited !== claims.awaited ||
      current.held.length !== claims.held.length ||
      current.held.some((path, index) => path !== claims.held[index])
    ) {
      return false;
    }
  }
  return true;
}
