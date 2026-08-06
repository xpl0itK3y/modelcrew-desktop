// Ширины колонок: боковой панели, дерева проекта и редактора.
//
// Границы держим здесь, а не в CSS. Ширину задаёт перетаскивание, то есть
// число, пришедшее от мыши; без общего зажима сохранённое значение может
// пережить и смену разрешения, и случайный рывок до нуля — а колонка,
// схлопнутая в ноль, обратно уже не тянется, за неё нечем взяться.

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
