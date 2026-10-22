// Кто узнаёт, что агент открыл страницу.
//
// У страницы проекта нет своего окна: она не выскочит и о себе не скажет.
// Поэтому о ней говорит приложение — числом на глобусе и баннером системы,
// когда человек смотрит не сюда.

import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../platform";

export type OpenedPage = {
  /** Корень проекта, чей это браузер. */
  root: string;
  url: string;
  title: string;
};

/**
 * Следить за страницами, которые открывают агенты.
 *
 * Возвращает отписку. Вне Tauri — пустышка: событий там неоткуда взяться.
 */
export function watchPagesOpened(
  onPage: (page: OpenedPage) => void,
): () => void {
  if (!isTauri) {
    return () => {};
  }
  // listen отдаёт отписку обещанием, а отписаться могут раньше, чем оно
  // исполнится: тогда снимаем слушателя сразу, как он появится.
  let stopped = false;
  let off: (() => void) | null = null;
  void listen<OpenedPage>("browser-page-opened", (event) => {
    if (!stopped) {
      onPage(event.payload);
    }
  }).then((unlisten) => {
    if (stopped) {
      unlisten();
      return;
    }
    off = unlisten;
  });
  return () => {
    stopped = true;
    off?.();
  };
}

/**
 * Кому из проектов ещё можно послать баннер системы.
 *
 * Агент открывает страницы сериями: открыл, поправил, открыл снова. Баннер
 * на каждую — десяток уведомлений подряд о том, что человек понял с первого.
 * Поэтому баннер один на проект, пока человек не вернётся в окно: сколько
 * страниц ждёт, и так видно на глобусе и плашке.
 */
export function createBannerGate() {
  const sent = new Set<string>();
  return {
    /** Послать ли баннер о странице этого проекта. Да — один раз. */
    claim(root: string): boolean {
      if (sent.has(root)) {
        return false;
      }
      sent.add(root);
      return true;
    },
    /** Человек вернулся в окно: следующая страница снова стоит баннера. */
    reset(): void {
      sent.clear();
    },
  };
}

/**
 * Подпись страницы для человека: заголовок, а если его нет — адрес.
 *
 * Заголовок пишет сама страница, и написать она может что угодно; в баннере
 * он идёт как текст и ни на что не влияет, но обрезать его надо — иначе
 * страница диктует размер уведомления.
 */
export function pageLabel(page: OpenedPage, limit = 120): string {
  const text = page.title.trim() || page.url;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
