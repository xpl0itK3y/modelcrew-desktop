// Откуда стор занятости берёт данные: опрос реестра активного проекта.
//
// Опрос, а не событие, по той же причине, по которой опрашивается каталог
// событий хуков: заявка живёт секунды, её ставит шелл-скрипт, и городить
// ради этого канал событий с бэкенда — больше работы, чем пользы. Раз в
// секунду хватает: подпись в шапке читает человек, а не машина.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";
import { clearPanelClaims, setPanelClaims, type PanelClaims } from "./claimStore";

const POLL_INTERVAL_MS = 1_000;

type CrewClaim = {
  path: string;
  panelId: string;
  task?: string;
  sinceMs: number;
  waiting: string[];
};

// Плоский список заявок разворачивается в состояние по панелям: держатель
// узнаёт, что его ждут, а ждущий — какого файла он ждёт.
export function claimsByPanel(claims: readonly CrewClaim[]): Map<string, PanelClaims> {
  const byPanel = new Map<string, PanelClaims>();
  const ensure = (panelId: string): PanelClaims => {
    const existing = byPanel.get(panelId);
    if (existing) {
      return existing;
    }
    const fresh: PanelClaims = { held: [], waitingFor: null, awaited: false };
    byPanel.set(panelId, fresh);
    return fresh;
  };
  for (const claim of claims) {
    const holder = ensure(claim.panelId);
    holder.held.push(claim.path);
    if (claim.waiting.length > 0) {
      holder.awaited = true;
    }
    for (const waiting of claim.waiting) {
      // Ждущих файлов может быть несколько; показываем первый, за которым
      // панель встала — он же тот, на котором она споткнулась раньше всех.
      const panel = ensure(waiting);
      panel.waitingFor ??= claim.path;
    }
  }
  return byPanel;
}

// Следит за реестром активного проекта. Смена проекта — новый вызов; null
// означает «проекта нет», и подписи гаснут.
export function watchPanelClaims(workspaceId: string | null): () => void {
  if (!isTauri || !workspaceId) {
    clearPanelClaims();
    return () => {};
  }
  let stopped = false;
  const poll = async () => {
    try {
      const claims = await invoke<CrewClaim[]>("crew_claims", { workspaceId });
      if (!stopped) {
        setPanelClaims(claimsByPanel(claims));
      }
    } catch {
      // Реестр — подсказка, а не работа: его отказ не должен всплывать
      // ошибкой поверх терминалов.
    }
  };
  void poll();
  const timer = window.setInterval(poll, POLL_INTERVAL_MS);
  return () => {
    stopped = true;
    window.clearInterval(timer);
    clearPanelClaims();
  };
}
