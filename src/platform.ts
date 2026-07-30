// Единственное место, которое знает, где мы запущены. До этого проверка
// `"__TAURI_INTERNALS__" in window` была скопирована в семнадцать файлов, а
// определение мака — в два, и каждая копия жила своей жизнью.
//
// Сторож на копии — в platform.test.ts.

export type Platform = "mac" | "windows" | "linux";

/**
 * Приложение внутри Tauri, а не страница в браузере. Функция, а не константа:
 * в тестах признак ставится после импорта модуля, и снимок был бы ложным.
 */
export function hasTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * Снимок на момент загрузки — для модулей, которые решают один раз при старте
 * (подписки, побочные эффекты). Если признак может появиться позже, нужен
 * `hasTauri()`.
 */
export const isTauri = hasTauri();

export function detectPlatform(userAgent: string): Platform {
  if (/Mac|iPhone|iPad/i.test(userAgent)) {
    return "mac";
  }
  return /Win/i.test(userAgent) ? "windows" : "linux";
}

// Какая клавиатура перед пользователем: от этого зависят подписи сочетаний.
export const platform = detectPlatform(navigator.userAgent);
export const isMac = platform === "mac";
