// Колесо мыши над кадром страницы.
//
// Где страница стоит в ящике не живой, а картинкой, — на Linux всегда, на
// других системах, пока место чем-то закрыто, — колесо крутило бы картинку,
// и страница о нём не узнала бы. Поэтому сдвиг уходит самой странице, а
// следом просим свежий кадр: человек видит, что прокрутилось, сразу, а не
// через секунду очередного опроса.

/** Точка или сдвиг в пикселях кадра — тех, что в самой картинке. */
export type FramePoint = { x: number; y: number };

/** Где на экране картинка и каков кадр в ней на самом деле. */
export type FrameImage = {
  rect: { left: number; top: number; width: number; height: number };
  naturalWidth: number;
  naturalHeight: number;
};

export type WheelTurn = {
  clientX: number;
  clientY: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
};

// Строка колеса в пикселях — столько же, сколько у WebKit и Chromium.
const LINE_PX = 40;

/**
 * Колесо над картинкой — точкой и сдвигом в пикселях кадра. Картинку в
 * ящике ужимают по ширине, и точки ящика с точками кадра не совпадают.
 * Мимо картинки или без сдвига — `null`.
 */
export function wheelOnFrame(
  turn: WheelTurn,
  image: FrameImage,
): { at: FramePoint; by: FramePoint } | null {
  const { rect, naturalWidth, naturalHeight } = image;
  if (rect.width <= 0 || rect.height <= 0 || !naturalWidth || !naturalHeight) {
    return null;
  }
  const across = naturalWidth / rect.width;
  const down = naturalHeight / rect.height;
  const x = (turn.clientX - rect.left) * across;
  const y = (turn.clientY - rect.top) * down;
  if (x < 0 || y < 0 || x >= naturalWidth || y >= naturalHeight) {
    return null;
  }
  const unit =
    turn.deltaMode === 1 ? LINE_PX : turn.deltaMode === 2 ? rect.height : 1;
  let dx = turn.deltaX * unit;
  let dy = turn.deltaY * unit;
  // Shift с колесом листает вбок: так ходят вбок мышью без второго колеса.
  if (turn.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  if (dx === 0 && dy === 0) {
    return null;
  }
  return { at: { x, y }, by: { x: dx * across, y: dy * down } };
}

/**
 * Передача колеса странице. Колесо даёт десятки событий в секунду, а
 * страница отвечает на каждое за время: пока предыдущий сдвиг в пути,
 * следующие копятся и уходят одним. Так страница не отстаёт от руки, а
 * очередь не растёт.
 *
 * `sent` зовут после каждого дошедшего или нет сдвига — за кадром.
 */
export function createWheelRelay(
  send: (at: FramePoint, by: FramePoint) => Promise<void>,
  sent: () => void,
): (at: FramePoint, by: FramePoint) => void {
  let waiting: { at: FramePoint; by: FramePoint } | null = null;
  let busy = false;

  const flush = () => {
    if (busy || !waiting) {
      return;
    }
    const { at, by } = waiting;
    waiting = null;
    busy = true;
    send(at, by)
      // Не прокрутилось — страница как раз грузится или точка ушла за край
      // при смене размера. Колесо не повод для ошибки на весь ящик: следующий
      // кадр и так покажет, где страница.
      .catch(() => {})
      .finally(() => {
        busy = false;
        sent();
        flush();
      });
  };

  return (at, by) => {
    waiting = waiting
      ? { at, by: { x: waiting.by.x + by.x, y: waiting.by.y + by.y } }
      : { at, by };
    flush();
  };
}
