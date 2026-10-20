// Под какой экран показывать страницу проекта.
//
// Живую страницу ставят ровно на место в ящике, и ширину ей задаёт это
// место. Поэтому «телефон» здесь — просто место телефонного размера: вёрстка
// перестраивается по-настоящему, а агент, сняв страницу, видит её той же —
// страница уносит размер с собой. Подменять user agent и касания мы не
// берёмся: страница узнаёт только ширину.

import { useSyncExternalStore } from "react";
import { KEYS, readSetting, writeSetting } from "../settings/storage";

export type PageDevice = "desktop" | "tablet" | "phone";

export const DEVICES: readonly PageDevice[] = ["desktop", "tablet", "phone"];

/**
 * Экран в точках, как его видит вёрстка. У компьютера своего размера нет:
 * страница во весь ящик.
 */
export const DEVICE_SIZES: Record<
  PageDevice,
  { width: number; height: number } | null
> = {
  desktop: null,
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
};

const listeners = new Set<() => void>();

// Без хранилища выбор живёт здесь до закрытия приложения.
let current: PageDevice | null = null;

function isDevice(value: string | null): value is PageDevice {
  return DEVICES.includes(value as PageDevice);
}

export function loadDevice(): PageDevice {
  if (current === null) {
    const stored = readSetting(KEYS.browserDevice);
    current = isDevice(stored) ? stored : "desktop";
  }
  return current;
}

export function saveDevice(device: PageDevice): void {
  current = device;
  writeSetting(KEYS.browserDevice, device);
  for (const listener of listeners) {
    listener();
  }
}

export function useDevice(): PageDevice {
  return useSyncExternalStore(subscribe, loadDevice, loadDevice);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
