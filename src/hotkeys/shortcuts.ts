// Единый список сочетаний и их подписи под клавиатуру пользователя.
// Комбинации описаны токенами, а не готовым текстом: на маке это ⌘⌥⇧↩,
// на Windows и Linux — Ctrl, Alt, Shift, Enter, и расходиться эти подписи
// не должны ни в подсказках кнопок, ни в списке настроек.

import type { MessageKey } from "../i18n";
import type { Platform } from "../platform";


export type ShortcutToken =
  | "mod"
  | "alt"
  | "shift"
  | "enter"
  | "arrows"
  | "digits"
  | "drag"
  | string;

const MAC_KEYS: Record<string, string> = {
  mod: "⌘",
  alt: "⌥",
  shift: "⇧",
  enter: "↩",
};

const PC_KEYS: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
};

const SHARED_KEYS: Record<string, string> = {
  arrows: "←↑↓→",
  digits: "1–9",
};

/**
 * Подписи клавиш по одной: для отрисовки каждой в своём <kbd>.
 *
 * `words` — то, что пишется словом на языке интерфейса, а не символом
 * клавиши: «перетащить» у сочетания с мышью. Без перевода такой токен вышел
 * бы заглавными буквами.
 */
export function shortcutKeys(
  tokens: readonly ShortcutToken[],
  platform: Platform,
  words: Partial<Record<ShortcutToken, string>> = {},
): string[] {
  const named = platform === "mac" ? MAC_KEYS : PC_KEYS;
  return tokens.map(
    (token) =>
      words[token] ?? SHARED_KEYS[token] ?? named[token] ?? token.toUpperCase(),
  );
}

/**
 * Одной строкой — для title и aria-label. На маке модификаторы слипаются
 * (⌘⇧W), на остальных разделяются плюсом (Ctrl+Shift+W), как принято там.
 */
export function shortcutLabel(
  tokens: readonly ShortcutToken[],
  platform: Platform,
  words: Partial<Record<ShortcutToken, string>> = {},
): string {
  const keys = shortcutKeys(tokens, platform, words);
  return platform === "mac" ? keys.join("") : keys.join("+");
}

export type Shortcut = {
  id: string;
  label: MessageKey;
  // Пояснение под названием — там, где одного сочетания мало, чтобы понять,
  // что делать руками.
  description?: MessageKey;
  keys: ShortcutToken[];
};

// Порядок как в работе: сначала создание и закрытие, потом навигация,
// потом перестановка панелей.
export const SHORTCUTS: Shortcut[] = [
  { id: "newTerminal", label: "shortcut.newTerminal", keys: ["mod", "t"] },
  {
    id: "closePanel",
    label: "shortcut.closePanel",
    description: "shortcut.closePanelNote",
    keys: ["mod", "w"],
  },
  {
    id: "closeGroup",
    label: "shortcut.closeGroup",
    keys: ["mod", "shift", "w"],
  },
  { id: "maximize", label: "shortcut.maximize", keys: ["mod", "enter"] },
  {
    id: "panelNumbers",
    label: "shortcut.panelNumbers",
    keys: ["mod", "alt"],
  },
  {
    id: "focusNumber",
    label: "shortcut.focusNumber",
    keys: ["mod", "alt", "digits"],
  },
  {
    id: "focusNeighbour",
    label: "shortcut.focusNeighbour",
    keys: ["mod", "alt", "arrows"],
  },
  {
    id: "swapNumber",
    label: "shortcut.swapNumber",
    keys: ["mod", "alt", "shift", "digits"],
  },
  {
    id: "movePanel",
    label: "shortcut.movePanel",
    keys: ["mod", "shift", "arrows"],
  },
  {
    id: "moveToSession",
    label: "shortcut.moveToSession",
    description: "shortcut.moveToSessionNote",
    keys: ["mod", "drag"],
  },
];
