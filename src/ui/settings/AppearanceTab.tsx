import { useEffect, useState } from "react";
import {
  ACCENT_COLORS,
  APP_THEMES,
  type AccentColor,
  type ThemeId,
} from "../../theme";
import { type MessageKey, type Locale, useI18n } from "../../i18n";
import {
  loadNetworkAvatars,
  saveNetworkAvatars,
} from "../../terminal/preferences";
import { isGithubSignedIn, subscribeGithubAuth } from "../../github/authState";

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

type AppearanceTabProps = {
  themeId: ThemeId;
  accent: string;
  onSelectTheme: (themeId: ThemeId) => void;
  onSelectAccent: (color: string) => void;
};

export function AppearanceTab(props: AppearanceTabProps) {
  const { locale, setLocale, t } = useI18n();
  const [networkAvatars, setNetworkAvatars] = useState(() =>
    loadNetworkAvatars(),
  );
  // Сетевые аватарки доступны только после входа через GitHub.
  const [signedIn, setSignedIn] = useState(() => isGithubSignedIn());
  useEffect(
    () => subscribeGithubAuth(() => setSignedIn(isGithubSignedIn())),
    [],
  );
  // Настройку могли переключить извне (автовключение при входе) — подхватываем.
  useEffect(() => {
    const onChange = () => setNetworkAvatars(loadNetworkAvatars());
    window.addEventListener("modelcrew:network-avatars", onChange);
    return () =>
      window.removeEventListener("modelcrew:network-avatars", onChange);
  }, []);
  // Что реально показывается: «Из сети» действует лишь когда пользователь вошёл.
  const networkActive = signedIn && networkAvatars;

  return (
    <>
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
                <span className="language-option-code">
                  {option.toUpperCase()}
                </span>
              </button>
            );
          })}
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
                      style={{
                        backgroundColor: theme.colors.panelHeader,
                      }}
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

      <div className="settings-section">
        <div className="settings-label">{t("settings.networkAvatars")}</div>
        <div
          className="shell-options"
          role="group"
          aria-label={t("settings.networkAvatars")}
        >
          {[true, false].map((enabled) => (
            <button
              key={String(enabled)}
              type="button"
              // «Из сети» доступна только вошедшим; без входа — только «Инициалы».
              disabled={enabled && !signedIn}
              aria-pressed={networkActive === enabled}
              title={
                enabled && !signedIn
                  ? t("settings.networkAvatarsSignIn")
                  : undefined
              }
              className={`shell-option ${
                networkActive === enabled ? "is-selected" : ""
              } ${enabled && !signedIn ? "is-locked" : ""}`}
              onClick={() => {
                setNetworkAvatars(enabled);
                saveNetworkAvatars(enabled);
              }}
            >
              {t(
                enabled
                  ? "settings.networkAvatarsOn"
                  : "settings.networkAvatarsOff",
              )}
            </button>
          ))}
        </div>
        <p className="settings-note">
          {signedIn
            ? t("settings.networkAvatarsNote")
            : t("settings.networkAvatarsSignIn")}
        </p>
      </div>
    </>
  );
}
