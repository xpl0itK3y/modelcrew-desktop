// Живая страница в панели браузера.
//
// Страница — отдельный webview, и встроить её в нашу вёрстку нельзя:
// `frame-src` в CSP стоит в `none`. Поэтому панель держит под неё пустое
// место, а бэкенд ставит туда саму страницу — поверх нашего webview, в те же
// точки. Щёлкает, печатает и прокручивает человек уже прямо в ней.
//
// Поверх родного webview наш HTML не рисуется. Поэтому, стоит месту уйти под
// что-то своё — диалог, меню, другую панель, — или панели начать закрываться,
// страница уходит обратно в своё окно, а на её месте снова показывают кадр.

import { invoke } from "@tauri-apps/api/core";

/** Место под страницу: точки от левого верхнего угла окна. */
export type Place = { x: number; y: number; width: number; height: number };

/**
 * Точки, по которым проверяем, не легло ли что-то поверх места: углы с
 * отступом и середина. Перекрывают место целыми прямоугольниками — диалог,
 * меню, соседняя панель, — и мимо такой сетки они не проходят.
 */
const PROBES = [0.02, 0.5, 0.98];

/**
 * Где сейчас показывать страницу. `null` — нигде: окно не видно, панель
 * закрывается, у места нет размера или его что-то закрыло.
 */
export function placeOf(element: HTMLElement): Place | null {
  if (document.hidden) {
    return null;
  }
  // Закрываясь, панель уезжает анимацией, а родной webview за ней не уедет:
  // он висел бы на месте уже пустой панели.
  if (element.closest(".is-closing")) {
    return null;
  }
  const box = element.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) {
    return null;
  }
  for (const across of PROBES) {
    for (const down of PROBES) {
      const hit = document.elementFromPoint(
        box.left + box.width * across,
        box.top + box.height * down,
      );
      if (!hit || !element.contains(hit)) {
        return null;
      }
    }
  }
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

function samePlace(left: Place | null, right: Place | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

/** Сколько ждать, прежде чем снова просить бэкенд после отказа. */
const RETRY_MS = 1_000;

export type PageDock = {
  /** Остановить слежение. Страница уходит обратно в своё окно. */
  stop: () => void;
  /**
   * Бэкенд сказал, что страница не в панели, — например, её открыли заново
   * или окно прятали. Тогда место надо прислать ещё раз, даже если оно не
   * сдвинулось.
   */
  forget: () => void;
};

/**
 * Держать страницу проекта на месте `element`, пока это место видно.
 *
 * Место меряем каждый кадр отрисовки: панель выезжает анимацией, её тянут
 * за край, окно разворачивают, и страница обязана идти следом, а не догонять
 * раз в секунду. Бэкенд спрашиваем, только когда место и правда сдвинулось.
 *
 * `onDocked` узнаёт, стоит ли страница в панели: пока стоит, кадр не нужен.
 */
export function keepPageDocked(
  workspaceId: string,
  element: HTMLElement,
  onDocked: (docked: boolean) => void,
  onTrouble: (error: unknown) => void = () => {},
): PageDock {
  let stopped = false;
  let frame = 0;
  // Где страница стоит по последнему ответу бэкенда. `null` — в своём окне.
  let placed: Place | null = null;
  // Пока бэкенд не ответил, новых просьб не шлём: команды он выполняет
  // вперемешку, и страница встала бы на прошлое место.
  let inFlight: Promise<void> | null = null;
  let retryAt = 0;

  const settle = () => {
    if (stopped || inFlight || Date.now() < retryAt) {
      return;
    }
    const place = placeOf(element);
    if (samePlace(place, placed)) {
      return;
    }
    const call = place
      ? invoke<void>("browser_dock", { workspaceId, ...place })
      : invoke<void>("browser_undock", { workspaceId });
    inFlight = call
      .then(() => {
        placed = place;
        if (!stopped) {
          onDocked(place !== null);
        }
      })
      .catch((error) => {
        // Где страница теперь, неизвестно. Считаем, что дома: тогда покажут
        // кадр, а место пришлём снова, когда пройдёт пауза.
        placed = null;
        retryAt = Date.now() + RETRY_MS;
        if (!stopped) {
          onDocked(false);
          onTrouble(error);
        }
      })
      .finally(() => {
        inFlight = null;
      });
  };

  const loop = () => {
    settle();
    if (!stopped) {
      frame = window.requestAnimationFrame(loop);
    }
  };

  // Спрятанному окну кадры отрисовки не приходят, и цикл встаёт. Уйти
  // страница должна сразу: свёрнутое окно система не рисует, и агенту
  // достался бы пустой снимок.
  const onVisibility = () => settle();
  document.addEventListener("visibilitychange", onVisibility);
  loop();

  return {
    stop: () => {
      stopped = true;
      window.cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
      // Уходим, даже если по нашим сведениям страница дома, — но после
      // просьбы, что ещё в пути: иначе она поставила бы страницу в панель
      // уже после нашей остановки.
      void (inFlight ?? Promise.resolve())
        .then(() => invoke("browser_undock", { workspaceId }))
        .catch(() => {});
    },
    forget: () => {
      placed = null;
    },
  };
}
