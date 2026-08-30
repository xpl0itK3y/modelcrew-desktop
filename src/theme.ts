import type { ITheme } from "@xterm/xterm";
import { KEYS, readSetting, writeSetting } from "./settings/storage";
import { isTauri } from "./platform";

export type AccentColor = {
  id:
    | "pink"
    | "rose"
    | "red"
    | "orange"
    | "amber"
    | "yellow"
    | "lime"
    | "green"
    | "emerald"
    | "teal"
    | "sky"
    | "blue"
    | "indigo"
    | "violet"
    | "purple"
    | "fuchsia"
    | "white"
    | "gray";
  value: string;
};

export const ACCENT_COLORS: AccentColor[] = [
  { id: "pink", value: "#f471b5" },
  { id: "rose", value: "#fb7185" },
  { id: "red", value: "#ef4444" },
  { id: "orange", value: "#fb923c" },
  { id: "amber", value: "#fbbf24" },
  { id: "yellow", value: "#facc15" },
  { id: "lime", value: "#a3e635" },
  { id: "green", value: "#4ade80" },
  { id: "emerald", value: "#34d399" },
  { id: "teal", value: "#2dd4bf" },
  { id: "sky", value: "#38bdf8" },
  { id: "blue", value: "#60a5fa" },
  { id: "indigo", value: "#818cf8" },
  { id: "violet", value: "#a78bfa" },
  { id: "purple", value: "#c084fc" },
  { id: "fuchsia", value: "#e879f9" },
  { id: "white", value: "#e8ebf2" },
  { id: "gray", value: "#9ca3af" },
];

export type ThemeId =
  | "midnight"
  | "graphite"
  | "obsidian"
  | "ocean"
  | "forest"
  | "aubergine"
  | "sepia"
  | "porcelain"
  | "parchment";

type ThemeColors = {
  bg: string;
  panel: string;
  panelHeader: string;
  sidebar: string;
  border: string;
  panelBorder: string;
  text: string;
  textBright: string;
  textMuted: string;
  textFaint: string;
  green: string;
  surfaceActive: string;
  surfaceRaised: string;
  button: string;
  buttonHover: string;
  hover: string;
  hoverSubtle: string;
  hoverStrong: string;
  scrollbar: string;
  backdrop: string;
  shadow: string;
  danger: string;
  dangerSoft: string;
  dangerHover: string;
  dangerBorder: string;
  selectionRing: string;
  terminalBg: string;
};

export type AppTheme = {
  id: ThemeId;
  scheme: "dark" | "light";
  colors: ThemeColors;
  terminal: ITheme;
};

function darkTerminal(
  background: string,
  foreground: string,
  cursor: string,
  selectionBackground: string,
): ITheme {
  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground,
    black: "#20242c",
    red: "#ff7285",
    green: "#4ade80",
    yellow: "#f5c451",
    blue: "#6cabf5",
    magenta: "#c792ea",
    cyan: "#38d1e0",
    white: "#ccd2dd",
    brightBlack: "#657083",
    brightRed: "#ff8fa3",
    brightGreen: "#71f0ac",
    brightYellow: "#ffd77a",
    brightBlue: "#8fc2ff",
    brightMagenta: "#dcb0ff",
    brightCyan: "#6fe3f0",
    brightWhite: "#f4f7fb",
  };
}

const lightTerminal: ITheme = {
  background: "#f7f8fa",
  foreground: "#303744",
  cursor: "#18202b",
  cursorAccent: "#f7f8fa",
  selectionBackground: "rgba(63, 111, 190, 0.22)",
  black: "#242a33",
  red: "#c53d55",
  green: "#17875a",
  yellow: "#956800",
  blue: "#286fc2",
  magenta: "#7d4fbd",
  cyan: "#0c7f91",
  white: "#dfe3e9",
  brightBlack: "#6e7785",
  brightRed: "#df5068",
  brightGreen: "#209b68",
  brightYellow: "#aa7900",
  brightBlue: "#3f83d4",
  brightMagenta: "#9567d0",
  brightCyan: "#1693a5",
  brightWhite: "#ffffff",
};

// Тёплый вариант светлого терминала: кремовый фон и слегка потеплевшие ANSI,
// чтобы «Пергамент» не выглядел как «Фарфор» с другим фоном.
const warmLightTerminal: ITheme = {
  background: "#faf6ec",
  foreground: "#4a4030",
  cursor: "#2b2416",
  cursorAccent: "#faf6ec",
  selectionBackground: "rgba(150, 110, 40, 0.20)",
  black: "#312a1e",
  red: "#b83f3f",
  green: "#4f7d2f",
  yellow: "#976b00",
  blue: "#3a6ea8",
  magenta: "#8a4fa8",
  cyan: "#2c7f80",
  white: "#e2dac9",
  brightBlack: "#7a6e58",
  brightRed: "#c85a4a",
  brightGreen: "#5c9137",
  brightYellow: "#a97d00",
  brightBlue: "#4a80bc",
  brightMagenta: "#9c66b8",
  brightCyan: "#3a9192",
  brightWhite: "#fffaf0",
};

export const APP_THEMES: readonly AppTheme[] = [
  {
    id: "midnight",
    scheme: "dark",
    colors: {
      bg: "#101216",
      panel: "#16181d",
      panelHeader: "#1b1e25",
      sidebar: "#1c1e24",
      border: "#232833",
      panelBorder: "#1f242d",
      text: "#c9ced8",
      textBright: "#e8ebf2",
      textMuted: "#8b93a3",
      textFaint: "#5c6472",
      green: "#4ade80",
      surfaceActive: "#1c2028",
      surfaceRaised: "#1a1d24",
      button: "#232833",
      buttonHover: "#2a3040",
      hover: "rgba(255, 255, 255, 0.07)",
      hoverSubtle: "rgba(255, 255, 255, 0.04)",
      hoverStrong: "rgba(255, 255, 255, 0.10)",
      scrollbar: "rgba(148, 163, 184, 0.25)",
      backdrop: "rgba(6, 8, 10, 0.55)",
      shadow: "rgba(0, 0, 0, 0.50)",
      danger: "#ff8fa3",
      dangerSoft: "rgba(255, 114, 133, 0.14)",
      dangerHover: "rgba(255, 114, 133, 0.22)",
      dangerBorder: "rgba(255, 114, 133, 0.50)",
      selectionRing: "#ffffff",
      terminalBg: "#16181d",
    },
    terminal: darkTerminal(
      "#16181d",
      "#c9ced8",
      "#e8eaf0",
      "rgba(148, 163, 184, 0.28)",
    ),
  },
  {
    id: "graphite",
    scheme: "dark",
    colors: {
      bg: "#151516",
      panel: "#1c1c1e",
      panelHeader: "#232326",
      sidebar: "#222225",
      border: "#303035",
      panelBorder: "#29292d",
      text: "#d0d0d4",
      textBright: "#f4f4f5",
      textMuted: "#9898a1",
      textFaint: "#686872",
      green: "#55d98b",
      surfaceActive: "#252529",
      surfaceRaised: "#202024",
      button: "#2c2c31",
      buttonHover: "#36363c",
      hover: "rgba(255, 255, 255, 0.08)",
      hoverSubtle: "rgba(255, 255, 255, 0.045)",
      hoverStrong: "rgba(255, 255, 255, 0.11)",
      scrollbar: "rgba(170, 170, 180, 0.24)",
      backdrop: "rgba(8, 8, 9, 0.58)",
      shadow: "rgba(0, 0, 0, 0.52)",
      danger: "#ff91a2",
      dangerSoft: "rgba(255, 113, 133, 0.14)",
      dangerHover: "rgba(255, 113, 133, 0.22)",
      dangerBorder: "rgba(255, 113, 133, 0.48)",
      selectionRing: "#ffffff",
      terminalBg: "#1c1c1e",
    },
    terminal: darkTerminal(
      "#1c1c1e",
      "#d0d0d4",
      "#f4f4f5",
      "rgba(170, 170, 180, 0.25)",
    ),
  },
  {
    id: "obsidian",
    scheme: "dark",
    colors: {
      bg: "#08090a",
      panel: "#101113",
      panelHeader: "#16171a",
      sidebar: "#161719",
      border: "#24262b",
      panelBorder: "#1c1e22",
      text: "#c7cace",
      textBright: "#f0f1f3",
      textMuted: "#8a8d94",
      textFaint: "#595c64",
      green: "#4ade80",
      surfaceActive: "#191b1e",
      surfaceRaised: "#141517",
      button: "#212327",
      buttonHover: "#2a2c31",
      hover: "rgba(255, 255, 255, 0.06)",
      hoverSubtle: "rgba(255, 255, 255, 0.035)",
      hoverStrong: "rgba(255, 255, 255, 0.10)",
      scrollbar: "rgba(150, 155, 165, 0.24)",
      backdrop: "rgba(0, 0, 0, 0.64)",
      shadow: "rgba(0, 0, 0, 0.62)",
      danger: "#ff8fa3",
      dangerSoft: "rgba(255, 114, 133, 0.14)",
      dangerHover: "rgba(255, 114, 133, 0.22)",
      dangerBorder: "rgba(255, 114, 133, 0.50)",
      selectionRing: "#ffffff",
      terminalBg: "#101113",
    },
    terminal: darkTerminal(
      "#101113",
      "#c7cace",
      "#f0f1f3",
      "rgba(150, 160, 175, 0.28)",
    ),
  },
  {
    id: "ocean",
    scheme: "dark",
    colors: {
      bg: "#0b111a",
      panel: "#101925",
      panelHeader: "#152131",
      sidebar: "#151f2c",
      border: "#203149",
      panelBorder: "#1b2a3e",
      text: "#c5d2e2",
      textBright: "#edf5ff",
      textMuted: "#8295ad",
      textFaint: "#53677f",
      green: "#48d597",
      surfaceActive: "#17263a",
      surfaceRaised: "#121e2c",
      button: "#1d2c40",
      buttonHover: "#263850",
      hover: "rgba(195, 220, 255, 0.08)",
      hoverSubtle: "rgba(195, 220, 255, 0.045)",
      hoverStrong: "rgba(195, 220, 255, 0.12)",
      scrollbar: "rgba(120, 155, 195, 0.28)",
      backdrop: "rgba(3, 8, 15, 0.60)",
      shadow: "rgba(0, 0, 0, 0.56)",
      danger: "#ff93a6",
      dangerSoft: "rgba(255, 105, 135, 0.13)",
      dangerHover: "rgba(255, 105, 135, 0.21)",
      dangerBorder: "rgba(255, 105, 135, 0.46)",
      selectionRing: "#f4f9ff",
      terminalBg: "#101925",
    },
    terminal: darkTerminal(
      "#101925",
      "#c5d2e2",
      "#edf5ff",
      "rgba(103, 145, 196, 0.30)",
    ),
  },
  {
    id: "forest",
    scheme: "dark",
    colors: {
      bg: "#0c1412",
      panel: "#111d1a",
      panelHeader: "#172521",
      sidebar: "#162320",
      border: "#263a33",
      panelBorder: "#20322c",
      text: "#c6d5cf",
      textBright: "#eef8f4",
      textMuted: "#82978f",
      textFaint: "#536b62",
      green: "#4cdb8e",
      surfaceActive: "#1a2b26",
      surfaceRaised: "#15231f",
      button: "#21342e",
      buttonHover: "#2b423a",
      hover: "rgba(205, 245, 228, 0.075)",
      hoverSubtle: "rgba(205, 245, 228, 0.04)",
      hoverStrong: "rgba(205, 245, 228, 0.11)",
      scrollbar: "rgba(113, 160, 141, 0.28)",
      backdrop: "rgba(3, 10, 8, 0.60)",
      shadow: "rgba(0, 0, 0, 0.55)",
      danger: "#ff93a4",
      dangerSoft: "rgba(255, 107, 129, 0.13)",
      dangerHover: "rgba(255, 107, 129, 0.21)",
      dangerBorder: "rgba(255, 107, 129, 0.46)",
      selectionRing: "#f2fff9",
      terminalBg: "#111d1a",
    },
    terminal: darkTerminal(
      "#111d1a",
      "#c6d5cf",
      "#eef8f4",
      "rgba(89, 155, 126, 0.30)",
    ),
  },
  {
    id: "aubergine",
    scheme: "dark",
    colors: {
      bg: "#141018",
      panel: "#1c1622",
      panelHeader: "#251d2c",
      sidebar: "#221b29",
      border: "#382b42",
      panelBorder: "#302438",
      text: "#d3c8d9",
      textBright: "#f7effb",
      textMuted: "#9b8aa5",
      textFaint: "#6b5a76",
      green: "#55d990",
      surfaceActive: "#2a2032",
      surfaceRaised: "#211a28",
      button: "#33263d",
      buttonHover: "#402f4c",
      hover: "rgba(243, 220, 255, 0.08)",
      hoverSubtle: "rgba(243, 220, 255, 0.045)",
      hoverStrong: "rgba(243, 220, 255, 0.12)",
      scrollbar: "rgba(169, 135, 186, 0.28)",
      backdrop: "rgba(10, 5, 13, 0.61)",
      shadow: "rgba(0, 0, 0, 0.56)",
      danger: "#ff96aa",
      dangerSoft: "rgba(255, 108, 139, 0.14)",
      dangerHover: "rgba(255, 108, 139, 0.22)",
      dangerBorder: "rgba(255, 108, 139, 0.48)",
      selectionRing: "#fff6ff",
      terminalBg: "#1c1622",
    },
    terminal: darkTerminal(
      "#1c1622",
      "#d3c8d9",
      "#f7effb",
      "rgba(159, 117, 180, 0.30)",
    ),
  },
  {
    id: "sepia",
    scheme: "dark",
    colors: {
      bg: "#13110d",
      panel: "#1c1813",
      panelHeader: "#24201a",
      sidebar: "#231e17",
      border: "#392f24",
      panelBorder: "#31281d",
      text: "#d9cdbc",
      textBright: "#f8f1e6",
      textMuted: "#a2917b",
      textFaint: "#6f5f49",
      green: "#5cc487",
      surfaceActive: "#2a2419",
      surfaceRaised: "#201b14",
      button: "#322818",
      buttonHover: "#3f331f",
      hover: "rgba(255, 234, 205, 0.07)",
      hoverSubtle: "rgba(255, 234, 205, 0.04)",
      hoverStrong: "rgba(255, 234, 205, 0.11)",
      scrollbar: "rgba(190, 162, 120, 0.28)",
      backdrop: "rgba(12, 8, 4, 0.62)",
      shadow: "rgba(0, 0, 0, 0.56)",
      danger: "#ff9e86",
      dangerSoft: "rgba(255, 130, 100, 0.14)",
      dangerHover: "rgba(255, 130, 100, 0.22)",
      dangerBorder: "rgba(255, 130, 100, 0.48)",
      selectionRing: "#fff4e2",
      terminalBg: "#1c1813",
    },
    terminal: darkTerminal(
      "#1c1813",
      "#d9cdbc",
      "#f8f1e6",
      "rgba(190, 150, 95, 0.30)",
    ),
  },
  {
    id: "porcelain",
    scheme: "light",
    colors: {
      bg: "#e6e9ef",
      panel: "#f7f8fa",
      panelHeader: "#eef1f5",
      sidebar: "#eff1f4",
      border: "#cbd2dc",
      panelBorder: "#d4d9e2",
      text: "#46505f",
      textBright: "#171c25",
      textMuted: "#667284",
      textFaint: "#929cab",
      green: "#18875a",
      surfaceActive: "#dce2ea",
      surfaceRaised: "#f9fafb",
      button: "#e3e7ed",
      buttonHover: "#d7dde6",
      hover: "rgba(31, 41, 55, 0.08)",
      hoverSubtle: "rgba(31, 41, 55, 0.045)",
      hoverStrong: "rgba(31, 41, 55, 0.12)",
      scrollbar: "rgba(71, 85, 105, 0.26)",
      backdrop: "rgba(38, 45, 56, 0.24)",
      shadow: "rgba(31, 41, 55, 0.22)",
      danger: "#b4233f",
      dangerSoft: "rgba(210, 45, 76, 0.10)",
      dangerHover: "rgba(210, 45, 76, 0.17)",
      dangerBorder: "rgba(180, 35, 63, 0.36)",
      selectionRing: "#18202b",
      terminalBg: "#f7f8fa",
    },
    terminal: lightTerminal,
  },
  {
    id: "parchment",
    scheme: "light",
    colors: {
      bg: "#e9e2d2",
      panel: "#faf6ec",
      panelHeader: "#f2ebdd",
      sidebar: "#f4efe4",
      border: "#d7cbb4",
      panelBorder: "#e0d5c0",
      text: "#544a39",
      textBright: "#2b2416",
      textMuted: "#7b6f5c",
      textFaint: "#a99d85",
      green: "#2f7d43",
      surfaceActive: "#e2d9c6",
      surfaceRaised: "#fcf9f1",
      button: "#ebe3d3",
      buttonHover: "#ddd3bf",
      hover: "rgba(70, 55, 25, 0.07)",
      hoverSubtle: "rgba(70, 55, 25, 0.04)",
      hoverStrong: "rgba(70, 55, 25, 0.11)",
      scrollbar: "rgba(130, 108, 70, 0.26)",
      backdrop: "rgba(60, 48, 28, 0.24)",
      shadow: "rgba(80, 62, 32, 0.20)",
      danger: "#b4233f",
      dangerSoft: "rgba(210, 45, 76, 0.10)",
      dangerHover: "rgba(210, 45, 76, 0.17)",
      dangerBorder: "rgba(180, 35, 63, 0.36)",
      selectionRing: "#2b2416",
      terminalBg: "#faf6ec",
    },
    terminal: warmLightTerminal,
  },
] as const;

const DEFAULT_ACCENT = ACCENT_COLORS[0].value;
export const DEFAULT_THEME_ID: ThemeId = "midnight";

export function getAppTheme(id: ThemeId): AppTheme {
  return APP_THEMES.find((theme) => theme.id === id) ?? APP_THEMES[0];
}

export function loadTheme(): ThemeId {
  try {
    const stored = readSetting(KEYS.theme);
    return APP_THEMES.some((theme) => theme.id === stored)
      ? (stored as ThemeId)
      : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function applyTheme(id: ThemeId): void {
  const theme = getAppTheme(id);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.scheme;
  for (const [name, value] of Object.entries(theme.colors)) {
    const cssName = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    root.style.setProperty(`--mc-${cssName}`, value);
  }

  if (isTauri) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        const currentWindow = getCurrentWindow();
        return Promise.allSettled([
          currentWindow.setTheme(theme.scheme),
          currentWindow.setBackgroundColor(theme.colors.bg),
        ]);
      })
      .catch(() => {});
  }
}

export function saveTheme(id: ThemeId): void {
  try {
    writeSetting(KEYS.theme, id);
  } catch {
    // Без localStorage тема применяется только до закрытия приложения.
  }
  applyTheme(id);
}

export function loadAccent(): string {
  try {
    return readSetting(KEYS.accent) ?? DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function applyAccent(color: string): void {
  document.documentElement.style.setProperty("--mc-accent", color);
}

export function saveAccent(color: string): void {
  try {
    writeSetting(KEYS.accent, color);
  } catch {
    // Без localStorage цвет применяется только до закрытия приложения.
  }
  applyAccent(color);
}
