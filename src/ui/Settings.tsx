import { useEffect, useId, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ACCENT_COLORS,
  APP_THEMES,
  type AccentColor,
  type ThemeId,
} from "../theme";
import { type MessageKey, type Locale, useI18n } from "../i18n";
import { type ShellOption } from "../shell";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "../terminal/preferences";

const isTauri = "__TAURI_INTERNALS__" in window;

const themeMessageKeys: Record<
  ThemeId,
  { name: MessageKey; description: MessageKey }
> = {
  midnight: {
    name: "theme.midnight.name",
    description: "theme.midnight.description",
  },
  graphite: {
    name: "theme.graphite.name",
    description: "theme.graphite.description",
  },
  ocean: {
    name: "theme.ocean.name",
    description: "theme.ocean.description",
  },
  forest: {
    name: "theme.forest.name",
    description: "theme.forest.description",
  },
  aubergine: {
    name: "theme.aubergine.name",
    description: "theme.aubergine.description",
  },
  porcelain: {
    name: "theme.porcelain.name",
    description: "theme.porcelain.description",
  },
};

const accentMessageKeys: Record<AccentColor["id"], MessageKey> = {
  pink: "accent.pink",
  rose: "accent.rose",
  red: "accent.red",
  orange: "accent.orange",
  amber: "accent.amber",
  yellow: "accent.yellow",
  lime: "accent.lime",
  green: "accent.green",
  emerald: "accent.emerald",
  teal: "accent.teal",
  sky: "accent.sky",
  blue: "accent.blue",
  indigo: "accent.indigo",
  violet: "accent.violet",
  purple: "accent.purple",
  fuchsia: "accent.fuchsia",
  white: "accent.white",
  gray: "accent.gray",
};

type SettingsProps = {
  themeId: ThemeId;
  accent: string;
  shell: string | null;
  shellBusy: boolean;
  terminalFontSize: number;
  onSelectTheme: (themeId: ThemeId) => void;
  onSelectAccent: (color: string) => void;
  onSelectShell: (command: string | null, label: string) => void;
  onSelectTerminalFontSize: (size: number) => void;
  onClose: () => void;
};

export function Settings(props: SettingsProps) {
  const { locale, setLocale, t } = useI18n();
  const titleId = useId();
  const [shells, setShells] = useState<ShellOption[]>([]);
  const fontSizeProgress =
    ((props.terminalFontSize - MIN_TERMINAL_FONT_SIZE) /
      (MAX_TERMINAL_FONT_SIZE - MIN_TERMINAL_FONT_SIZE)) *
    100;

  useEffect(() => {
    if (!isTauri) {
      return;
    }
    let cancelled = false;
    void invoke<ShellOption[]>("list_shells")
      .then((list) => {
        if (!cancelled) {
          setShells(list);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [props]);

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-header">
          <span id={titleId} className="settings-title">
            {t("settings.title")}
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={props.onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            ✕
          </button>
        </div>

        <div className="settings-section">
          <div className="settings-label">{t("settings.language")}</div>
          <div
            className="language-options"
            role="group"
            aria-label={t("settings.language")}
          >
            {(["ru", "en"] as const).map((option: Locale) => {
              const label =
                option === "ru"
                  ? t("settings.languageRussian")
                  : t("settings.languageEnglish");
              return (
                <button
                  key={option}
                  type="button"
                  lang={option}
                  aria-pressed={locale === option}
                  className={`language-option ${
                    locale === option ? "is-selected" : ""
                  }`}
                  onClick={() => setLocale(option)}
                >
                  <span>{label}</span>
                  <span className="language-option-code">{option.toUpperCase()}</span>
                </button>
              );
            })}
          </div>
        </div>

        {isTauri && shells.length > 0 && (
          <div className="settings-section">
            <div className="settings-label">{t("settings.shell")}</div>
            <div
              className="shell-options"
              role="group"
              aria-label={t("settings.shell")}
              aria-busy={props.shellBusy}
            >
              <button
                type="button"
                disabled={props.shellBusy}
                aria-pressed={props.shell === null}
                className={`shell-option ${props.shell === null ? "is-selected" : ""}`}
                onClick={() =>
                  props.onSelectShell(null, t("settings.shellDefault"))
                }
              >
                {t("settings.shellDefault")}
              </button>
              {shells.map((option) => (
                <button
                  key={option.command}
                  type="button"
                  disabled={props.shellBusy}
                  title={t("settings.selectShell", { name: option.label })}
                  aria-label={t("settings.selectShell", { name: option.label })}
                  aria-pressed={props.shell === option.command}
                  className={`shell-option ${
                    props.shell === option.command ? "is-selected" : ""
                  }`}
                  onClick={() =>
                    props.onSelectShell(option.command, option.label)
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
            <p className="settings-note">
              {props.shellBusy
                ? t("settings.shellApplying")
                : t("settings.shellNote")}
            </p>
          </div>
        )}

        <div className="settings-section">
          <div className="settings-label">
            {t("settings.terminalFontSize")}
          </div>
          <div className="terminal-font-size-control">
            <input
              type="range"
              className="terminal-font-size-slider"
              min={MIN_TERMINAL_FONT_SIZE}
              max={MAX_TERMINAL_FONT_SIZE}
              step={1}
              value={props.terminalFontSize}
              aria-label={t("settings.terminalFontSize")}
              aria-valuetext={t("settings.terminalFontSizeValue", {
                size: props.terminalFontSize,
              })}
              style={
                {
                  "--terminal-font-size-progress": `${fontSizeProgress}%`,
                } as CSSProperties
              }
              onChange={(event) =>
                props.onSelectTerminalFontSize(Number(event.target.value))
              }
            />
            <output className="terminal-font-size-value" aria-live="polite">
              {t("settings.terminalFontSizeValue", {
                size: props.terminalFontSize,
              })}
            </output>
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-label">{t("settings.theme")}</div>
          <div className="theme-grid">
            {APP_THEMES.map((theme) => {
              const name = t(themeMessageKeys[theme.id].name);
              const description = t(themeMessageKeys[theme.id].description);
              return (
                <button
                  key={theme.id}
                  type="button"
                  title={t("settings.selectTheme", { name })}
                  aria-label={t("settings.selectTheme", { name })}
                  aria-pressed={props.themeId === theme.id}
                  className={`theme-card ${
                    props.themeId === theme.id ? "is-selected" : ""
                  }`}
                  onClick={() => props.onSelectTheme(theme.id)}
                >
                  <span
                    className="theme-preview"
                    style={{ backgroundColor: theme.colors.bg }}
                  >
                    <span
                      className="theme-preview-sidebar"
                      style={{ backgroundColor: theme.colors.sidebar }}
                    />
                    <span
                      className="theme-preview-panel"
                      style={{
                        backgroundColor: theme.colors.panel,
                        borderColor: theme.colors.panelBorder,
                      }}
                    >
                      <span
                        className="theme-preview-header"
                        style={{ backgroundColor: theme.colors.panelHeader }}
                      />
                      <span
                        className="theme-preview-line"
                        style={{ backgroundColor: theme.colors.textMuted }}
                      />
                    </span>
                    <span className="theme-preview-accent" />
                  </span>
                  <span className="theme-card-copy">
                    <strong>{name}</strong>
                    <small>{description}</small>
                  </span>
                  <span className="theme-card-check" aria-hidden="true">
                    {props.themeId === theme.id ? "✓" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="settings-section settings-accent-section">
          <div className="settings-label">{t("settings.accent")}</div>
          <div className="accent-grid">
            {ACCENT_COLORS.map((color) => {
              const name = t(accentMessageKeys[color.id]);
              const label = t("settings.selectAccent", { name });
              return (
                <button
                  key={color.value}
                  type="button"
                  title={label}
                  aria-label={label}
                  aria-pressed={
                    props.accent.toLowerCase() === color.value.toLowerCase()
                  }
                  className={`accent-swatch ${
                    props.accent.toLowerCase() === color.value.toLowerCase()
                      ? "is-selected"
                      : ""
                  }`}
                  style={{ backgroundColor: color.value }}
                  onClick={() => props.onSelectAccent(color.value)}
                />
              );
            })}
          </div>
          <label className="accent-custom">
            {t("settings.customColor")}
            <input
              type="color"
              aria-label={t("settings.customColor")}
              value={props.accent}
              onChange={(event) => props.onSelectAccent(event.target.value)}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
