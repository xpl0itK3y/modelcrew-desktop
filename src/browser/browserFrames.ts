// Откуда ящик браузера берёт картинку: опрос кадра у бэкенда.
//
// Браузер проекта работает без своего окна, поэтому страницу показывает само
// приложение. Кадр приходит готовым PNG в base64 и вставляется как `data:`
// — `img-src` в CSP это уже разрешает, новых прав не нужно.
//
// Опрос, а не подписка: снимок кадра стоит времени, и просить его надо
// ровно тогда, когда на него кто-то смотрит.
//
// Где система умеет, панель показывает саму страницу, живой
// (`pageDock.ts`). Тогда картинка не нужна, и опрос приносит только адрес с
// заголовком — для адресной строки.

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";

export type BrowserFrame = {
  // PNG в base64. Пусто — показывать нечего.
  image: string;
  url: string;
  title: string;
  // Поднят ли браузер проекта. Пока нет — ящик говорит об этом сам, а не
  // показывает пустой прямоугольник.
  running: boolean;
  // Стоит ли страница сейчас живой в ящике — по словам бэкенда.
  docked: boolean;
  // Умеет ли система показать страницу живой. Где не умеет — только кадр.
  dockable: boolean;
};

export const NO_FRAME: BrowserFrame = {
  image: "",
  url: "",
  title: "",
  running: false,
  docked: false,
  dockable: false,
};

// Раз в секунду: страницу смотрит человек, а не машина. Чаще — впустую
// греем процессор снимками, реже — заметно отстаёт от того, что делает агент.
const POLL_INTERVAL_MS = 1_000;

/**
 * Адрес из того, что человек набрал руками.
 *
 * Схему дописываем сами: «localhost:1420» набирают чаще, чем полный адрес,
 * а бэкенд принимает только http и https. Уже написанную схему не трогаем —
 * в том числе неподходящую: отказать по ней должен бэкенд, с внятной
 * причиной, а не мы молча превратив её в другой адрес.
 */
export function normalizeAddress(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
}

/** Кадр как значение `src`. Пустая строка — картинки нет. */
export function frameSource(image: string): string {
  return image ? `data:image/png;base64,${image}` : "";
}

/**
 * Следить за кадром проекта, пока ящик открыт.
 *
 * Следующий опрос ставится после ответа, а не по расписанию: снимок кадра
 * иногда идёт дольше секунды, и с обычным интервалом запросы наложились бы
 * друг на друга, разгоняя браузер до предела вместо ровной картинки.
 */
export function watchBrowserFrame(
  workspaceId: string | null,
  onFrame: (frame: BrowserFrame) => void,
  onTrouble: (error: unknown) => void = () => {},
  // Место, где кадр покажут. Спрашиваем перед каждым снимком, а не запоминаем
  // однажды: ящик тянут за край, окно разворачивают, и страница обязана идти
  // за местом следом. Без размера бэкенд оставит страницу как есть.
  sizeOf: () => { width: number; height: number } | null = () => null,
  // Стоит ли страница в ящике живой. Тогда ни картинка, ни размер не нужны:
  // место ей задаёт сам ящик.
  live: () => boolean = () => false,
): () => void {
  if (!isTauri || !workspaceId) {
    onFrame(NO_FRAME);
    return () => {};
  }
  let stopped = false;
  let timer = 0;

  const poll = async () => {
    // Окно свёрнуто или перекрыто — смотреть некому, кадр не нужен.
    if (!document.hidden) {
      try {
        let request;
        if (live()) {
          request = { workspaceId, picture: false };
        } else {
          const size = sizeOf();
          request = { workspaceId, width: size?.width, height: size?.height };
        }
        const frame = await invoke<BrowserFrame>("browser_frame", request);
        if (!stopped) {
          onFrame(frame);
        }
      } catch (error) {
        // Не поднятый браузер — это удачный ответ с пустым кадром, а сюда мы
        // попадаем, когда что-то по-настоящему сломалось. Показав пустоту,
        // ящик соврал бы «браузер не запущен» про живой, но не отвечающий:
        // прошлый кадр остаётся на месте, а причина уходит наверх.
        if (!stopped) {
          onTrouble(error);
        }
      }
    }
    if (!stopped) {
      timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  void poll();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

/** Открыть страницу по просьбе человека. Отказ уходит наверх — его показывают. */
export function openPage(workspaceId: string, url: string): Promise<void> {
  return invoke<void>("browser_go", { workspaceId, url });
}
