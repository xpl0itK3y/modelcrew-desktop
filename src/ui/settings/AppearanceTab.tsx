import {
  ACCENT_COLORS,
  APP_THEMES,
  type AccentColor,
  type ThemeId,
} from "../../theme";
import { type MessageKey, type Locale, useI18n } from "../../i18n";
import {
  SettingRow,
  SettingsPage,
  SettingsSegmented,
} from "./SettingsControls";

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
  obsidian: {
    name: "theme.obsidian.name",
    description: "theme.obsidian.description",
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
  sepia: {
    name: "theme.sepia.name",
    description: "theme.sepia.description",
  },
  porcelain: {
    name: "theme.porcelain.name",
    description: "theme.porcelain.description",
  },
  parchment: {
    name: "theme.parchment.name",
    description: "theme.parchment.description",
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

  return (
    <SettingsPage
      section="appearance"
      title={t("settings.tabAppearance")}
      intro={t("settings.appearanceIntro")}
    >
      <SettingRow
        title={t("settings.language")}
        description={t("settings.languageNote")}
        control={
          <SettingsSegmented<Locale>
            label={t("settings.language")}
            value={locale}
            options={[
              { value: "ru", label: t("settings.languageRussian"), lang: "ru" },
              { value: "en", label: t("settings.languageEnglish"), lang: "en" },
            ]}
            onChange={setLocale}
          />
        }
      />

      <SettingRow
        layout="stacked"
        title={t("settings.theme")}
        description={t("settings.themeNote")}
        keywords={APP_THEMES.map((theme) =>
          t(themeMessageKeys[theme.id].name),
        ).join(" ")}
        control={
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
        }
      />

      <SettingRow
        layout="stacked"
        title={t("settings.accent")}
        description={t("settings.accentNote")}
        keywords={ACCENT_COLORS.map((color) =>
          t(accentMessageKeys[color.id]),
        ).join(" ")}
        control={
          <>
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
          </>
        }
      />

    </SettingsPage>
  );
}
