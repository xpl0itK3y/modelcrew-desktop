// Обновлять ли страницу проекта, когда меняются его файлы.
//
// Следит за файлами бэкенд (`browser_auto_reload.rs`): страница живёт и при
// закрытом ящике, а агент правит код и тогда, когда на неё никто не смотрит.
// Здесь только выключатель. Он хранится с прочими настройками интерфейса и
// уходит в бэкенд при старте и при каждой перемене.

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauri } from "../platform";
import { KEYS, readSetting, writeSetting } from "../settings/storage";

const listeners = new Set<() => void>();

// Без хранилища выбор живёт здесь до закрытия приложения — иначе
// выключатель отскакивал бы назад сразу после нажатия.
let current: boolean | null = null;

export function loadAutoReload(): boolean {
  current ??= readSetting(KEYS.browserAutoReload) !== "off";
  return current;
}

export function saveAutoReload(enabled: boolean): void {
  current = enabled;
  writeSetting(KEYS.browserAutoReload, enabled ? "on" : "off");
  for (const listener of listeners) {
    listener();
  }
  void tellBackend(enabled);
}

/** Сказать бэкенду, что выбрал человек. Зовётся один раз при старте. */
export function syncAutoReload(): Promise<void> {
  return tellBackend(loadAutoReload());
}

export function useAutoReload(): boolean {
  return useSyncExternalStore(subscribe, loadAutoReload, loadAutoReload);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tellBackend(enabled: boolean): Promise<void> {
  if (!isTauri) {
    return Promise.resolve();
  }
  // Не дошло — страница будет вести себя по-старому, а сломать тут нечего.
  return invoke<void>("browser_auto_reload", { enabled }).catch((error) => {
    console.error("Could not switch page auto-reload", error);
  });
}
