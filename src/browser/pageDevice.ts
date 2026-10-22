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
 * Какие размеры можно задать. Меньше нижнего предела на странице уже ничего
 * не разглядеть, а сам ящик бывает и ниже телефона — свой экран не должен
 * быть строже его. Сверху — с запасом на большой монитор.
 */
export const SCREEN_LIMITS = {
  min: { width: 200, height: 200 },
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

export type ScreenPreset = ScreenSize & { name: string | null };

/**
 * Частые экраны — как список устройств в инструментах разработчика. Размеры
 * в точках, какими их видит вёрстка, а не в пикселях матрицы. У мониторов
 * имени нет: их узнают по размеру.
 */
export const SCREEN_PRESETS: Record<
  "phones" | "tablets" | "computers",
  readonly ScreenPreset[]
> = {
  phones: [
    { name: "iPhone SE", width: 375, height: 667 },
    { name: "iPhone 15", width: 393, height: 852 },
    { name: "iPhone 15 Pro Max", width: 430, height: 932 },
    { name: "Pixel 8", width: 412, height: 915 },
    { name: "Galaxy S24", width: 360, height: 780 },
  ],
  tablets: [
    { name: "iPad mini", width: 744, height: 1133 },
    { name: "iPad Air", width: 820, height: 1180 },
    { name: "iPad Pro 12.9″", width: 1024, height: 1366 },
  ],
  computers: [
    { name: null, width: 1280, height: 800 },
    { name: null, width: 1366, height: 768 },
    { name: null, width: 1440, height: 900 },
    { name: null, width: 1920, height: 1080 },
  ],
};

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

// Свои размеры: сколько держать. Список — для частых, а не для истории.
const SAVED_LIMIT = 12;

let saved: readonly ScreenSize[] | undefined;

/** Размеры, которые человек запомнил сам, — свежие первыми. */
export function loadSavedScreens(): readonly ScreenSize[] {
  if (saved === undefined) {
    let stored: unknown = [];
    try {
      stored = JSON.parse(readSetting(KEYS.browserScreens) ?? "[]");
    } catch {
      // Испорченная запись — как пустая.
    }
    saved = (Array.isArray(stored) ? stored : [])
      .map((value) => (typeof value === "string" ? parseScreen(value) : null))
      .filter((size): size is ScreenSize => size !== null)
      .slice(0, SAVED_LIMIT);
  }
  return saved;
}

function storeSaved(next: readonly ScreenSize[]) {
  saved = next;
  writeSetting(KEYS.browserScreens, JSON.stringify(next.map(screenKey)));
  notify();
}

export function rememberScreen(size: ScreenSize): void {
  const others = loadSavedScreens().filter((own) => !sameScreen(own, size));
  storeSaved([size, ...others].slice(0, SAVED_LIMIT));
}

export function forgetScreen(size: ScreenSize): void {
  storeSaved(loadSavedScreens().filter((own) => !sameScreen(own, size)));
}

export function useSavedScreens(): readonly ScreenSize[] {
  return useSyncExternalStore(subscribe, loadSavedScreens, loadSavedScreens);
}
