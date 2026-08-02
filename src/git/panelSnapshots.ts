// Снимки работы панелей: что записал каждый агент после своего хода и как
// вернуть отдельный файл. Читает и пишет только бэкенд — здесь тонкая обёртка
// над его командами, как и у остального git-клиента.

import { invoke } from "@tauri-apps/api/core";

export type PanelSnapshot = {
  panelId: string;
  commit: string;
  epochMs: number;
  // Что изменил этот ход: разница с предыдущим снимком той же панели. У самого
  // первого снимка предшественника нет — там сравнение с веткой, и в список
  // попадает всё несохранённое, включая чужую работу.
  files: string[];
};

export function fetchPanelSnapshots(
  workspaceId: string,
): Promise<PanelSnapshot[]> {
  return invoke<PanelSnapshot[]>("panel_snapshots", { workspaceId });
}

// Возвращает один файл из снимка панели. Именно один: восстановить снимок
// целиком значило бы затереть работу, которая шла после него.
export function restorePanelSnapshot(
  workspaceId: string,
  panelId: string,
  path: string,
): Promise<void> {
  return invoke("panel_snapshot_restore", { workspaceId, panelId, path });
}
