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
  /** Панель агента, который открыл страницу. */
  panelId: string;
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

/** Что делать с открытой страницей. */
export type PageNews = {
  /** Прибавить её к непросмотренным на глобусе. */
  count: boolean;
  /** Показать плашку под глобусом. */
  notice: boolean;
  /** Послать баннер системы. */
  banner: boolean;
};

/**
 * О каком агенте человеку уже сказали.
 *
 * Агент открывает страницы сериями: открыл, поправил, открыл снова. Плашка и
 * баннер на каждую — десяток уведомлений подряд о том, что человек понял с
 * первого. Поэтому о каждом агенте говорим один раз за работу приложения, а
 * его следующие страницы только прибавляются к числу на глобусе и к «и ещё N»
 * на плашке. Агент другой панели — другая новость.
 *
 * Возвращает решение для каждой следующей страницы.
 */
export function createPageNews() {
  const told = new Set<string>();
  return (
    page: OpenedPage,
    where: {
      /** Корень проекта, чей ящик браузера сейчас открыт. */
      watchedRoot: string | null;
      /** Окно впереди. */
      focused: boolean;
    },
  ): PageNews => {
    // Ящик этого проекта открыт — страница уже перед глазами, стоит только
    // вернуться в окно. Об агенте человек так тоже узнал.
    const count = page.root !== where.watchedRoot;
    const first = !told.has(page.panelId);
    told.add(page.panelId);
    return {
      count,
      notice: first && count,
      // Пока окно впереди, баннер повторил бы плашку, а macOS его и не
      // покажет.
      banner: first && !where.focused,
    };
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
