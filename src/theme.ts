// Акцентный цвет приложения: одна CSS-переменная --mc-accent, все
// оттенки выводятся из неё через color-mix.

export type AccentColor = {
  name: string;
  value: string;
};

export const ACCENT_COLORS: AccentColor[] = [
  { name: "Розовый", value: "#f471b5" },
  { name: "Малиновый", value: "#fb7185" },
  { name: "Красный", value: "#ef4444" },
  { name: "Оранжевый", value: "#fb923c" },
  { name: "Янтарный", value: "#fbbf24" },
  { name: "Жёлтый", value: "#facc15" },
  { name: "Лаймовый", value: "#a3e635" },
  { name: "Зелёный", value: "#4ade80" },
  { name: "Изумрудный", value: "#34d399" },
  { name: "Бирюзовый", value: "#2dd4bf" },
  { name: "Голубой", value: "#38bdf8" },
  { name: "Синий", value: "#60a5fa" },
  { name: "Индиго", value: "#818cf8" },
  { name: "Фиолетовый", value: "#a78bfa" },
  { name: "Пурпурный", value: "#c084fc" },
  { name: "Фуксия", value: "#e879f9" },
  { name: "Белый", value: "#e8ebf2" },
  { name: "Серый", value: "#9ca3af" },
];

const STORAGE_KEY = "modelcrew.accent";
const DEFAULT_ACCENT = ACCENT_COLORS[0].value;

export function loadAccent(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function applyAccent(color: string): void {
  document.documentElement.style.setProperty("--mc-accent", color);
}

export function saveAccent(color: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, color);
  } catch {
    // localStorage может быть недоступен — цвет просто не переживёт рестарт.
  }
  applyAccent(color);
}
