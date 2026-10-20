// Под какой экран показывать страницу проекта.
//
// Живую страницу ставят ровно на место в ящике, и ширину ей задаёт это
// место. Поэтому «телефон» здесь — просто место телефонного размера: вёрстка
// перестраивается по-настоящему, а агент, сняв страницу, видит её той же —
// страница уносит размер с собой. Подменять user agent и касания мы не
// берёмся: страница узнаёт только ширину.
//
// Экран — это либо «во весь ящик», либо любой размер в точках: три кнопки
// внизу ящика лишь самые частые из них.

import { useSyncExternalStore } from "react";
import { KEYS, readSetting, writeSetting } from "../settings/storage";

export type ScreenSize = { width: number; height: number };

export type PageDevice = "desktop" | "tablet" | "phone";

export const DEVICES: readonly PageDevice[] = ["desktop", "tablet", "phone"];

/**
 * Экран в точках, как его видит вёрстка. У компьютера своего размера нет:
 * страница во весь ящик.
 */
export const DEVICE_SIZES: Record<PageDevice, ScreenSize | null> = {
  desktop: null,
  tablet: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
};

/**
 * Какие размеры можно задать. Снизу — тот же предел, что у страницы без
 * ящика (`MIN_VIEWPORT` в бэкенде): уже него страница в окне не сожмётся, и
 * агент увидел бы другую вёрстку. Сверху — с запасом на большой монитор.
 */
export const SCREEN_LIMITS = {
  min: { width: 320, height: 360 },
  max: { width: 3840, height: 3840 },
} as const;

/** Размер в пределах, целыми точками. Не число — `null`. */
export function fitScreen(width: number, height: number): ScreenSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  const { min, max } = SCREEN_LIMITS;
  return {
    width: Math.round(Math.min(max.width, Math.max(min.width, width))),
    height: Math.round(Math.min(max.height, Math.max(min.height, height))),
  };
}

export function sameScreen(
  left: ScreenSize | null,
  right: ScreenSize | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.width === right.width && left.height === right.height;
}

/** Тот же экран, повёрнутый набок. */
export function rotated(size: ScreenSize): ScreenSize {
  return { width: size.height, height: size.width };
}

/**
 * Какая из кнопок горит. Повёрнутый телефон — всё ещё телефон. Размер не из
 * кнопок — ни одна.
 */
export function deviceOf(size: ScreenSize | null): PageDevice | null {
  return (
    DEVICES.find((device) => {
      const own = DEVICE_SIZES[device];
      return own === null
        ? size === null
        : size !== null &&
            (sameScreen(own, size) || sameScreen(rotated(own), size));
    }) ?? null
  );
}

/** Как размер лежит в хранилище: `390x844`. */
export function screenKey(size: ScreenSize): string {
  return `${size.width}x${size.height}`;
}

export function parseScreen(value: string | null): ScreenSize | null {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  return match ? fitScreen(Number(match[1]), Number(match[2])) : null;
}

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Без хранилища выбор живёт здесь до закрытия приложения. `undefined` — ещё
// не читали.
let current: ScreenSize | null | undefined;

/**
 * Экран страницы; `null` — во весь ящик. Раньше в хранилище лежало имя
 * кнопки, и выбранный тогда телефон остаётся телефоном.
 */
export function loadScreen(): ScreenSize | null {
  if (current === undefined) {
    const stored = readSetting(KEYS.browserDevice);
    current =
      stored === "tablet" || stored === "phone"
        ? DEVICE_SIZES[stored]
        : parseScreen(stored);
  }
  return current;
}

export function saveScreen(size: ScreenSize | null): void {
  current = size;
  writeSetting(KEYS.browserDevice, size === null ? "desktop" : screenKey(size));
  notify();
}

export function useScreen(): ScreenSize | null {
  return useSyncExternalStore(subscribe, loadScreen, loadScreen);
}
