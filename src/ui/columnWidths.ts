// Ширины колонок: боковой панели, дерева проекта и редактора.
//
// Границы держим здесь, а не в CSS. Ширину задаёт перетаскивание, то есть
// число, пришедшее от мыши; без общего зажима сохранённое значение может
// пережить и смену разрешения, и случайный рывок до нуля — а колонка,
// схлопнутая в ноль, обратно уже не тянется, за неё нечем взяться.

import { PANEL_MIN_WIDTH } from "../constants";
import { KEYS, readSetting, writeSetting } from "../settings/storage";

export type Column = "sidebar" | "tree" | "editor";

type Limits = { min: number; max: number; fallback: number };

const LIMITS: Record<Column, Limits> = {
  // Меньше — и в списке проектов обрезается имя вместе со счётчиком.
  sidebar: { min: 180, max: 480, fallback: 232 },
  // Дереву нужно место под отступы вложенности: на 180 уже третий уровень
  // упирается в многоточие.
  tree: { min: 180, max: 560, fallback: 260 },
  // Редактор — под строку кода: уже 360 строки рвутся так, что читать нечего.
  editor: { min: 360, max: 1200, fallback: 520 },
};

const STORAGE: Record<Column, string> = {
  sidebar: KEYS.sidebarWidth,
  tree: KEYS.treeWidth,
  editor: KEYS.editorWidth,
};

export function clampWidth(column: Column, width: number): number {
  const { min, max } = LIMITS[column];
  if (!Number.isFinite(width)) {
    return LIMITS[column].fallback;
  }
  return Math.min(max, Math.max(min, Math.round(width)));
}

export function loadWidth(column: Column): number {
  const stored = Number(readSetting(STORAGE[column]));
  return Number.isFinite(stored) && stored > 0
    ? clampWidth(column, stored)
    : LIMITS[column].fallback;
}

export function saveWidth(column: Column, width: number): void {
  writeSetting(STORAGE[column], String(clampWidth(column, width)));
}

export function widthLimits(column: Column): Limits {
  return LIMITS[column];
}

// Сколько места обязано остаться сетке терминалов. Границы выше — про саму
// колонку и ничего не знают об окне: 480 + 560 + 1200 это 2240 пикселей, и на
// любом ноутбуке сетка уезжает за правый край задолго до того, как хоть одна
// колонка упрётся в свой предел. Терминал при этом не сжимается, а именно
// уходит за край — вернуть его можно только обратным перетаскиванием вслепую.
//
// Число не выдумано: сама сетка не сужает панель ниже PANEL_MIN_WIDTH, а
// стоят они обычно парами. Оставить меньше — значит снова выдавить вторую
// колонку за край, только теперь изнутри сетки. Редактору этого хватает: у
// него свой минимум в 360, и до него отсюда никто не достаёт.
export const MIN_DOCK_WIDTH = 2 * PANEL_MIN_WIDTH;

/**
 * Границы колонки с оглядкой на то, сколько сейчас занимает сетка.
 *
 * Расширение колонки забирает ровно столько, сколько прибавили: попросив
 * ширину `w`, мы оставим сетке `dock - (w - current)`. Отсюда и предел —
 * `current + dock - MIN_DOCK_WIDTH`; он точен на любом шаге перетаскивания,
 * потому что считается по свежей паре «текущая ширина, текущая сетка».
 *
 * Сетку ещё не измерили (первый рендер) — отдаём прежние границы: лучше один
 * кадр без ограничения, чем схлопнутая в минимум колонка на старте.
 */
export function widthLimitsWithin(
  column: Column,
  current: number,
  dockWidth: number,
): Limits {
  const limits = LIMITS[column];
  if (!Number.isFinite(dockWidth) || dockWidth <= 0 || !Number.isFinite(current)) {
    return limits;
  }
  const room = Math.round(current + dockWidth - MIN_DOCK_WIDTH);
  return {
    ...limits,
    // Места может уже не хватать — тогда колонку остаётся только сужать.
    max: Math.max(limits.min, Math.min(limits.max, room)),
  };
}

export function clampWithin(
  column: Column,
  width: number,
  current: number,
  dockWidth: number,
): number {
  if (!Number.isFinite(width)) {
    return LIMITS[column].fallback;
  }
  const { min, max } = widthLimitsWithin(column, current, dockWidth);
  return Math.min(max, Math.max(min, Math.round(width)));
}

// Колонки в том порядке, в каком у них отбирают место: редактор шире всех и
// переживёт потерю первым, дерево следом, боковая панель последней — в ней
// список проектов, по которому переключаются.
const SHRINK_ORDER: Column[] = ["editor", "tree", "sidebar"];

/**
 * Ужимает видимые колонки так, чтобы сетке досталось не меньше положенного.
 *
 * Нужно не для перетаскивания, а для встречи с окном: сохранённые ширины
 * пришли с прошлого запуска, где экран мог быть больше, — и на новом сетка
 * оказывается за краем ещё до того, как пользователь тронет разделитель.
 * Сохранять ужатое не будем: это уступка нынешнему окну, а не новая воля
 * пользователя.
 */
export function fitColumns(
  widths: Record<Column, number>,
  visible: readonly Column[],
  dockWidth: number,
): Record<Column, number> {
  if (!Number.isFinite(dockWidth) || dockWidth >= MIN_DOCK_WIDTH) {
    return widths;
  }
  const fitted = { ...widths };
  let missing = MIN_DOCK_WIDTH - Math.round(dockWidth);
  for (const column of SHRINK_ORDER) {
    if (missing <= 0) {
      break;
    }
    if (!visible.includes(column)) {
      continue;
    }
    const { min } = LIMITS[column];
    const give = Math.min(missing, Math.max(0, fitted[column] - min));
    fitted[column] -= give;
    missing -= give;
  }
  return fitted;
}
